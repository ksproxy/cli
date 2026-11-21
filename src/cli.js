import fs from 'node:fs';
import path from 'node:path';
import {
  clock, formatLogLine, logOptionsFor, readAuditEntries, rotatedLogs, sanitizeForTerminal,
} from './audit.js';
import { allowWarnings } from './allowlist.js';
import { InventoryError, loadInventory, sampleInventory } from './inventory.js';
import {
  KINDS, kindByFlag, kindByKey, secretFilesOf,
} from './kinds/index.js';
import { serve, SERVER_INFO } from './mcp.js';
import {
  auditLogPath, configDir, ensureDir, inventoryPath, logDir, sessionDir as sessionDirOf, writeFileAtomic,
} from './paths.js';
import { liveSession } from './session.js';
import { start } from './start.js';
import { reviewRoute, targetState } from './tools.js';

const START_INDENT = '        ';
const USAGE_WIDTH = 78;

// The start line of the usage, from the list of kinds: the flag of each kind that is not brokered, then --all and
// --verbose, then the flags of the brokered kinds on lines of their own, wrapped at USAGE_WIDTH.
function startUsage() {
  const shown = KINDS.map((kind, i) => ({ brokered: kind.brokered === true, text: `[--${kind.flag} ${i % 2 === 0 ? 'a,b' : 'x,y'}]` }));
  const first = shown.filter((s) => !s.brokered).map((s) => s.text);
  const lines = [`  start ${[...first, '[--all]', '[-v|--verbose]'].join(' ')}`];
  let line = '';
  for (const { text } of shown.filter((s) => s.brokered)) {
    if (line !== '' && START_INDENT.length + line.length + 1 + text.length > USAGE_WIDTH) {
      lines.push(START_INDENT + line);
      line = '';
    }
    line = line === '' ? text : `${line} ${text}`;
  }
  if (line !== '') lines.push(START_INDENT + line);
  return lines.join('\n');
}

// The flags check takes, from the list of kinds: <ssh|kube|local|...>.
const checkKinds = () => `<${KINDS.map((kind) => kind.flag).join('|')}>`;

// The check lines of the usage: the flags of every kind, then the name and the command on a line of their own.
const checkUsage = () => `  check ${checkKinds()}\n${START_INDENT}<name> <command...>`;

const usage = () => `Usage: ksproxy <command>

Commands:
  init                                      write a sample inventory (never overwrites)
${startUsage()}
                                            pick targets, open them, stay in the foreground
  status                                    show the live session and each target's state
  log [-n N] [--denied] [--json]            show the last N log entries (default 50)
${checkUsage()}
                                            say whether a command would be allowed
  mcp                                       run the MCP server on stdio (started by the agent)

Options:
  -h, --help                                show this help
  --version                                 show the version
`;

function makeContext(proc) {
  return {
    proc,
    out: (text) => proc.stdout.write(`${text}\n`),
    err: (text) => proc.stderr.write(`${text}\n`),
  };
}

function usageError(ctx, message) {
  ctx.err(message);
  ctx.proc.stderr.write(usage());
  return 2;
}

function parseStartArgs(args) {
  const options = {
    ...Object.fromEntries(KINDS.map((kind) => [kind.flag, null])), all: false, verbose: false,
  };
  const flagPattern = new RegExp(`^(--(?:${KINDS.map((kind) => kind.flag).join('|')}))(?:=(.*))?$`);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    const match = flagPattern.exec(arg);
    if (!match) return { error: `unknown option for start: ${arg}` };
    let value = match[2];
    if (value === undefined) {
      i += 1;
      value = args[i];
      if (value === undefined) return { error: `${match[1]} needs a comma-separated list of names` };
    }
    const names = value.split(',').map((n) => n.trim()).filter(Boolean);
    const key = match[1].slice(2);
    options[key] = [...(options[key] ?? []), ...names];
  }
  return { options };
}

function parseLogArgs(args) {
  const options = { count: 50, denied: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--denied') {
      options.denied = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '-n') {
      i += 1;
      const value = args[i];
      if (value === undefined || !/^\d+$/.test(value)) return { error: '-n needs a number from 1 to 5000' };
      const count = Number(value);
      if (count < 1 || count > 5000) return { error: '-n needs a number from 1 to 5000' };
      options.count = count;
    } else {
      return { error: `unknown option for log: ${arg}` };
    }
  }
  return { options };
}

function isCall(entry) {
  return entry.event === undefined || entry.event === 'call';
}

function logLines(file, options, format) {
  let rows = readAuditEntries(file);
  if (options.denied) rows = rows.filter(({ entry }) => isCall(entry) && entry.decision === 'refused');
  const lines = [];
  for (const { entry, raw } of rows) {
    try {
      const line = options.json ? sanitizeForTerminal(raw) : formatLogLine(entry, format);
      if (line !== null) lines.push(line);
    } catch {
      // a row that cannot be shown is skipped
    }
  }
  return lines;
}

function showLog(options, env, { proc, out }) {
  const file = auditLogPath(env);
  const older = rotatedLogs(logDir(env));
  if (!fs.existsSync(file) && older.length === 0) {
    out('no log yet');
    return 0;
  }
  const format = { ...logOptionsFor(proc.stdout, env), verbose: true };
  let lines = logLines(file, options, format);
  for (const name of older) {
    if (lines.length >= options.count) break;
    lines = [...logLines(path.join(logDir(env), name), options, format), ...lines];
  }
  for (const line of lines.slice(-options.count)) out(line);
  return 0;
}

// The entries since the session started: the current file, and older files while none of them holds the start.
function sessionEntries(env) {
  const read = (file) => readAuditEntries(file).map(({ entry }) => entry);
  let entries = read(auditLogPath(env));
  for (const name of rotatedLogs(logDir(env))) {
    if (entries.some((entry) => entry.event === 'session_start')) break;
    entries = [...read(path.join(logDir(env), name)), ...entries];
  }
  return entries;
}

function lastCallSummary(env) {
  const entries = sessionEntries(env);
  let from = 0;
  entries.forEach((entry, i) => {
    if (entry.event === 'session_start') from = i + 1;
  });
  const calls = entries.slice(from).filter(isCall);
  if (calls.length === 0) return null;
  return `  last call ${clock(calls[calls.length - 1].ts)} \u00b7 ${calls.length} calls this session`;
}

function init(env, { out }) {
  const file = inventoryPath(env);
  if (fs.existsSync(file)) {
    out(`already exists: ${file}`);
    return 0;
  }
  ensureDir(configDir(env));
  writeFileAtomic(file, `${JSON.stringify(sampleInventory(), null, 2)}\n`);
  out(`wrote ${file} — edit it, then run: ksproxy start`);
  return 0;
}

async function status(env, { out }) {
  const session = liveSession(sessionDirOf(env));
  if (session === null || !Array.isArray(session.targets)) {
    out('no session — run: ksproxy start');
    return 1;
  }
  out(`session pid ${session.pid}, started ${session.startedAt}`);
  let allUp = true;
  for (const target of session.targets) {
    const state = await targetState(target, env);
    if (state !== 'up') allUp = false;
    const label = kindByKey(target.kind)?.label ?? '--';
    out(`  ${state.padEnd(6)}${label.padEnd(6)}${target.name}`);
  }
  const summary = lastCallSummary(env);
  if (summary !== null) out(summary);
  return allUp ? 0 : 1;
}

function check(args, env, ctx) {
  const { out, err } = ctx;
  const [kindArg, name, ...rest] = args;
  const kindOfArg = kindByFlag(kindArg);
  if (kindOfArg === undefined || name === undefined || rest.length === 0) {
    return usageError(ctx, `usage: ksproxy check ${checkKinds()} <name> <command...>`);
  }
  let inventory;
  try {
    inventory = loadInventory(inventoryPath(env));
  } catch (e) {
    if (e instanceof InventoryError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  const list = inventory[kindOfArg.key];
  const target = list.find((t) => t.name === name);
  if (!target) {
    err(`unknown ${kindArg} target "${name}"; known: ${list.map((t) => t.name).join(', ') || 'none'}`);
    return 2;
  }
  const warnings = kindOfArg.ruleWarnings === undefined ? allowWarnings(target.allow) : kindOfArg.ruleWarnings(target);
  for (const warning of warnings) err(`WARNING: ${kindOfArg.key} "${target.name}": ${warning}`);
  const prepared = kindOfArg.forCheck === undefined
    ? { target }
    : kindOfArg.forCheck(target, { env, secretFiles: secretFilesOf(inventory) });
  if (prepared.refusal !== undefined) {
    out(`REFUSED: ${prepared.refusal}`);
    return 1;
  }
  let input = kindOfArg.tool.detailIsArray ? rest : rest.join(' ');
  if (kindOfArg.checkInput !== undefined) input = kindOfArg.checkInput(rest);
  const decision = kindOfArg.decide(prepared.target, input, env);
  if (decision.allowed) {
    out(`ALLOWED by rule: ${decision.rule}`);
    if (kindOfArg.checkExtra !== undefined) {
      for (const line of kindOfArg.checkExtra(target, decision)) out(line);
    }
    return 0;
  }
  const route = reviewRoute(kindOfArg.key, decision, target.review !== undefined);
  if (route?.argv) {
    out(`NOT ON THE ALLOWLIST: a running session asks reviewer "${target.review.reviewer}"`);
    return 1;
  }
  out(`REFUSED: ${decision.reason}${route?.note ? `. ${route.note}` : ''}`);
  return 1;
}

export async function main(argv, env = process.env, host = {}) {
  const { process: proc = process } = host;
  const ctx = makeContext(proc);
  const [command, ...args] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    proc.stdout.write(usage());
    return 0;
  }
  if (command === '--version') {
    ctx.out(SERVER_INFO.version);
    return 0;
  }
  switch (command) {
    case 'init':
      return init(env, ctx);
    case 'start': {
      const parsed = parseStartArgs(args);
      if (parsed.error) return usageError(ctx, parsed.error);
      return start(parsed.options, env, host);
    }
    case 'status':
      return status(env, ctx);
    case 'log': {
      const parsed = parseLogArgs(args);
      if (parsed.error) return usageError(ctx, parsed.error);
      return showLog(parsed.options, env, ctx);
    }
    case 'check':
      return check(args, env, ctx);
    case 'mcp':
      await serve({ input: proc.stdin, output: proc.stdout, env });
      return 0;
    default:
      return usageError(ctx, `unknown command: ${command}`);
  }
}

export function runCli(argv, proc = process, mainFn = main) {
  return mainFn(argv, proc.env, { process: proc }).then(
    (code) => { proc.exitCode = code; },
    (err) => { proc.stderr.write(`ksproxy: ${err?.message ?? err}\n`); proc.exitCode = 1; },
  );
}
