import fs from 'node:fs';
import path from 'node:path';
import {
  clock, formatLogLine, logOptionsFor, readAuditEntries, rotatedLogs, sanitizeForTerminal,
} from './audit.js';
import { allowWarnings } from './allowlist.js';
import { InventoryError, loadInventory, sampleInventory } from './inventory.js';
import { KINDS, kindByFlag, kindByKey } from './kinds/index.js';
import { serve, SERVER_INFO } from './mcp.js';
import {
  PROJECT_RE, PROJECT_RULE, auditLogPath, ensureDir, initCommand, inventoryPath, logDir, projectOf, startCommand,
  withProject, writeFileAtomic,
} from './paths.js';
import {
  everySecretFile, liveSessions, otherInventories, usedPorts,
} from './projects.js';
import { start } from './start.js';
import { reviewRoute, targetState } from './tools.js';

const START_INDENT = '        ';
const USAGE_WIDTH = 78;
const PROJECT_USAGE = '[--project NAME]';
const DESCRIPTION_INDENT = ' '.repeat(44);

// The start line of the usage, from the list of kinds: the flag of each kind that is not brokered, then --all and
// --verbose, then the flags of the brokered kinds and --project on lines of their own, wrapped at USAGE_WIDTH.
function startUsage() {
  const shown = KINDS.map((kind, i) => ({ brokered: kind.brokered === true, text: `[--${kind.flag} ${i % 2 === 0 ? 'a,b' : 'x,y'}]` }));
  const first = shown.filter((s) => !s.brokered).map((s) => s.text);
  const lines = [`  start ${[...first, '[--all]', '[-v|--verbose]'].join(' ')}`];
  let line = '';
  for (const text of [...shown.filter((s) => s.brokered).map((s) => s.text), PROJECT_USAGE]) {
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

// The check lines of the usage: the project flag, then the flags of every kind, then the name and the command, each on a line of their own.
const checkUsage = () => `  check ${PROJECT_USAGE}\n${START_INDENT}${checkKinds()}\n${START_INDENT}<name> <command...>`;

const usage = () => `Usage: ksproxy <command>

Commands:
  init ${PROJECT_USAGE}                     write a sample inventory (never overwrites)
${startUsage()}
${DESCRIPTION_INDENT}pick targets, open them, stay in the foreground
  status ${PROJECT_USAGE}                   show every live session and each target's state
  log [-n N] [--denied] [--json] ${PROJECT_USAGE}
${DESCRIPTION_INDENT}show the last N log entries (default 50)
${checkUsage()}
${DESCRIPTION_INDENT}say whether a command would be allowed
  mcp ${PROJECT_USAGE}                      run the MCP server on stdio (started by the agent)

Options:
  -h, --help                                show this help
  --version                                 show the version
  --project NAME                            use the project NAME (projects/NAME.json)
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

// --project NAME or --project=NAME, once. With beforeKind (check) only the words before the first word that does not
// start with a dash are looked at: the words after the kind are the command being checked.
export function takeProject(args, { beforeKind = false } = {}) {
  let project = null;
  const rest = [];
  let open = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (beforeKind && !arg.startsWith('-')) open = false;
    if (!open || (arg !== '--project' && !arg.startsWith('--project='))) {
      rest.push(arg);
      continue;
    }
    if (project !== null) return { error: '--project given twice' };
    const value = arg === '--project' ? args[i + 1] : arg.slice('--project='.length);
    if (arg === '--project') i += 1;
    if (value === undefined || value === '') return { error: '--project needs a project name' };
    if (!PROJECT_RE.test(value)) return { error: PROJECT_RULE };
    project = value;
  }
  return { project, rest };
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
  // The ports of the sample are ones that no other inventory file or live session uses.
  const taken = new Set(usedPorts(env).used.keys());
  ensureDir(path.dirname(file));
  writeFileAtomic(file, `${JSON.stringify(sampleInventory(taken), null, 2)}\n`);
  out(`wrote ${file} — edit it, then run: ${startCommand(env)}`);
  return 0;
}

// The lines of one live session and whether each of its targets is up, or null when its file is malformed: a target
// whose state cannot be found, or whose state is not a text. Such a session is left out, as one that is not live.
async function sessionLines({ project, session, env }) {
  const lines = [`${project === null ? '' : `project ${project}: `}session pid ${session.pid}, started ${session.startedAt}`];
  let up = true;
  try {
    for (const target of session.targets) {
      const state = await targetState(target, env);
      if (typeof state !== 'string') return null;
      if (state !== 'up') up = false;
      const label = kindByKey(target.kind)?.label ?? '--';
      lines.push(`  ${state.padEnd(6)}${label.padEnd(6)}${target.name}`);
    }
  } catch {
    return null;
  }
  const summary = lastCallSummary(env);
  if (summary !== null) lines.push(summary);
  return { lines, up };
}

async function status(env, { out }) {
  const project = projectOf(env);
  const shown = [];
  for (const live of liveSessions(env)) {
    if (project !== null && live.project !== project) continue;
    const block = await sessionLines(live);
    if (block !== null) shown.push(block);
  }
  if (shown.length === 0) {
    out(`no session — run: ${startCommand(env)}`);
    return 1;
  }
  for (const { lines } of shown) {
    for (const line of lines) out(line);
  }
  return shown.every((block) => block.up) ? 0 : 1;
}

function check(args, env, ctx) {
  const { out, err } = ctx;
  const [kindArg, name, ...rest] = args;
  const kindOfArg = kindByFlag(kindArg);
  if (kindOfArg === undefined || name === undefined || rest.length === 0) {
    return usageError(ctx, `usage: ksproxy check ${PROJECT_USAGE} ${checkKinds()} <name> <command...>`);
  }
  // A target name never starts with a dash: the flag was written after the kind.
  if (name.startsWith('--project')) {
    return usageError(ctx, '--project must come before the kind: ksproxy check --project NAME <kind> <name> <command...>');
  }
  let inventory;
  try {
    inventory = loadInventory(inventoryPath(env), initCommand(env));
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
  // The files of every inventory file, as start protects them.
  const secret = kindOfArg.forCheck === undefined ? null : everySecretFile(inventory, otherInventories(env));
  const prepared = secret === null
    ? { target }
    : kindOfArg.forCheck(target, { env, secretFiles: secret.files, secretFilesProblem: secret.problem });
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
  const taken = takeProject(args, { beforeKind: command === 'check' });
  if (taken.error) return usageError(ctx, taken.error);
  const projectEnv = withProject(env, taken.project);
  switch (command) {
    case 'init':
      return init(projectEnv, ctx);
    case 'start': {
      const parsed = parseStartArgs(taken.rest);
      if (parsed.error) return usageError(ctx, parsed.error);
      return start(parsed.options, projectEnv, host);
    }
    case 'status':
      return status(projectEnv, ctx);
    case 'log': {
      const parsed = parseLogArgs(taken.rest);
      if (parsed.error) return usageError(ctx, parsed.error);
      return showLog(parsed.options, projectEnv, ctx);
    }
    case 'check':
      return check(taken.rest, projectEnv, ctx);
    case 'mcp':
      await serve({ input: proc.stdin, output: proc.stdout, env: projectEnv });
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
