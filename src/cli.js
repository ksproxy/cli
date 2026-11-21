import fs from 'node:fs';
import path from 'node:path';
import {
  clock, formatLogLine, logOptionsFor, readAuditEntries, rotatedLogs, sanitizeForTerminal,
} from './audit.js';
import { InventoryError, loadInventory, SAMPLE_INVENTORY } from './inventory.js';
import { localFolderProblem } from './local.js';
import { serve, SERVER_INFO } from './mcp.js';
import {
  auditLogPath, configDir, ensureDir, inventoryPath, logDir, sessionDir as sessionDirOf, writeFileAtomic,
} from './paths.js';
import { liveSession } from './session.js';
import { start } from './start.js';
import {
  decideKube, decideLocal, decideSsh, reviewRoute, targetState,
} from './tools.js';

const USAGE = `Usage: ksproxy <command>

Commands:
  init                                      write a sample inventory (never overwrites)
  start [--ssh a,b] [--kube x,y] [--local a,b] [--all] [-v|--verbose]
                                            pick targets, open them, stay in the foreground
  status                                    show the live session and each target's state
  log [-n N] [--denied] [--json]            show the last N log entries (default 50)
  check <ssh|kube|local> <name> <command...>
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
  ctx.proc.stderr.write(USAGE);
  return 2;
}

function parseStartArgs(args) {
  const options = {
    ssh: null, kube: null, local: null, all: false, verbose: false,
  };
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
    const match = /^(--ssh|--kube|--local)(?:=(.*))?$/.exec(arg);
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
  writeFileAtomic(file, `${JSON.stringify(SAMPLE_INVENTORY, null, 2)}\n`);
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
    const label = { ssh: 'ssh', kubernetes: 'kube', local: 'loc' }[target.kind];
    out(`  ${state.padEnd(6)}${label.padEnd(6)}${target.name}`);
  }
  const summary = lastCallSummary(env);
  if (summary !== null) out(summary);
  return allUp ? 0 : 1;
}

function check(args, env, ctx) {
  const { out, err } = ctx;
  const [kindArg, name, ...rest] = args;
  if (!['ssh', 'kube', 'local'].includes(kindArg) || name === undefined || rest.length === 0) {
    return usageError(ctx, 'usage: ksproxy check <ssh|kube|local> <name> <command...>');
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
  const list = { ssh: inventory.ssh, kube: inventory.kubernetes, local: inventory.local }[kindArg];
  const target = list.find((t) => t.name === name);
  if (!target) {
    err(`unknown ${kindArg} target "${name}"; known: ${list.map((t) => t.name).join(', ') || 'none'}`);
    return 2;
  }
  let decision;
  if (kindArg === 'ssh') decision = decideSsh(target, rest.join(' '));
  else if (kindArg === 'kube') decision = decideKube(target, rest);
  else {
    const kubeconfigs = inventory.kubernetes.map((k) => k.kubeconfig);
    const problem = localFolderProblem(target.cwd, env, kubeconfigs);
    if (problem !== null) {
      out(`REFUSED: ${problem}`);
      return 1;
    }
    decision = decideLocal({
      ...target,
      protected: kubeconfigs,
      ...(target.review ? { review: true, programs: target.review.programs } : {}),
    }, rest.join(' '), env);
  }
  if (decision.allowed) {
    out(`ALLOWED by rule: ${decision.rule}`);
    if (decision.prefix !== undefined) out(`sent to ${target.host}: ${decision.prefix} ${decision.command}`);
    return 0;
  }
  const kind = { ssh: 'ssh', kube: 'kubernetes', local: 'local' }[kindArg];
  const route = reviewRoute(kind, decision, target.review !== undefined);
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
    proc.stdout.write(USAGE);
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
