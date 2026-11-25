import fs from 'node:fs';
import path from 'node:path';
import {
  clock, formatLogLine, logOptionsFor, readAuditEntries, rotatedLogs, sanitizeForTerminal,
} from './audit.js';
import { allowWarnings } from './allowlist.js';
import { doctor } from './doctor.js';
import { InventoryError, loadInventory, sampleInventory } from './inventory.js';
import { KINDS, kindByFlag, kindByKey } from './kinds/index.js';
import { listenerLines } from './listen-status.js';
import { serve, SERVER_INFO } from './mcp.js';
import {
  PROJECT_DEFAULT, PROJECT_RE, PROJECT_RULE, auditLogPath, ensureDir, initCommand, inventoryPath, logDir, projectOf,
  projectsDir, rootStateDir, startCommand, withProject, writeFileAtomic,
} from './paths.js';
import {
  everySecretFile, liveSessions, otherInventories, usedPorts,
} from './projects.js';
import { start } from './start.js';
import { startMany } from './start-many.js';
import {
  revokeToken, tokenLines, tokenPath, tokenState,
} from './token.js';
import { reviewRoute, targetState } from './tools.js';

const START_INDENT = '        ';
const USAGE_WIDTH = 78;
const PROJECT_USAGE = '[--project NAME]';
const DESCRIPTION_INDENT = ' '.repeat(44);
// The two lines of the usage that name what start can do beyond one project: several projects, and the listener.
const START_MANY_USAGE = `${'  start ... --project a,b'.padEnd(DESCRIPTION_INDENT.length)}run several projects in one start`;
const START_LISTEN_USAGE = '  start ... --listen HOST:PORT [--new-token] [--tls-cert FILE --tls-key FILE]';
// The doctor line: the arguments of start, and target names as plain words.
const DOCTOR_USAGE = `${'  doctor ... [NAME...]'.padEnd(DESCRIPTION_INDENT.length)}check each target start ... would open, then close it`;
// The commands that take the arguments of start, a list of projects among them.
const START_LIKE = ['start', 'doctor'];
const NAMES_OF_ONE = 'target names belong to one project; use them with a single --project';

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
${START_MANY_USAGE}
${START_LISTEN_USAGE}
${DESCRIPTION_INDENT}serve its projects over HTTP on the local network
${DOCTOR_USAGE}
  status ${PROJECT_USAGE}                   show every live session and each target's state
  log [-n N] [--denied] [--json] [--from ADDRESS] ${PROJECT_USAGE}
${DESCRIPTION_INDENT}show the last N log entries (default 50)
${checkUsage()}
${DESCRIPTION_INDENT}say whether a command would be allowed
  mcp ${PROJECT_USAGE}                      run the MCP server on stdio (started by the agent)
  token                                     show when the network token was made, expires and was last used
  token revoke                              revoke the network token at once

Options:
  -h, --help                                show this help
  --version                                 show the version
  --project NAME                            use the project NAME (projects/NAME.json), or default (inventory.json)
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

// The first of projects/default.json in the config folder and p/default in the root state folder that exists, or null.
function oldDefaultProject(env) {
  return [path.join(projectsDir(env), `${PROJECT_DEFAULT}.json`), path.join(rootStateDir(env), 'p', PROJECT_DEFAULT)]
    .find((file) => fs.existsSync(file)) ?? null;
}

// --project NAME or --project=NAME, once. With beforeKind (check) only the words before the first word that does not
// start with a dash are looked at: the words after the kind are the command being checked. The name default is the
// default inventory, as no flag is, for every command, unless an old project of that name is still there: with env,
// a given default is then refused. With list (start) the value may be a comma-separated list of names, none twice, and
// projects gives them in order; any other command refuses a list.
export function takeProject(args, { beforeKind = false, list = false, env = null } = {}) {
  let projects = [null];
  let given = false;
  const rest = [];
  let open = true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (beforeKind && !arg.startsWith('-')) open = false;
    if (!open || (arg !== '--project' && !arg.startsWith('--project='))) {
      rest.push(arg);
      continue;
    }
    if (given) return { error: '--project given twice' };
    const value = arg === '--project' ? args[i + 1] : arg.slice('--project='.length);
    if (arg === '--project') i += 1;
    if (value === undefined || value === '') return { error: '--project needs a project name' };
    const names = value.split(',');
    if (names.length > 1 && !list) return { error: 'a list of projects works only with start' };
    if (!names.every((name) => PROJECT_RE.test(name))) return { error: PROJECT_RULE };
    const twice = names.find((name, at) => names.indexOf(name) !== at);
    if (twice !== undefined) return { error: `--project names ${twice} twice` };
    const old = names.includes(PROJECT_DEFAULT) && env !== null ? oldDefaultProject(env) : null;
    if (old !== null) return { error: `--project default now means inventory.json, but an old project named default is still here (${old}); rename it, for example to default-old, and update its agent configs` };
    given = true;
    projects = names.map((name) => (name === PROJECT_DEFAULT ? null : name));
  }
  return list ? { project: projects[0], projects, rest } : { project: projects[0], rest };
}

// The start options that take a value: --listen, given once per address, and the two TLS files, given once each.
const VALUE_FLAG = /^(--listen|--tls-cert|--tls-key)(?:=(.*))?$/;

// The arguments of start: options, the object start takes as before, and for the listener the --listen values, whether
// --new-token was given, and the TLS files or null. count is the number of projects: a kind flag names targets of one.
// command is start or doctor: doctor takes the same arguments, and a word that does not start with a dash is a target
// name for it, kept in names; start refuses such a word as before.
function parseStartArgs(args, count, command = 'start') {
  const options = {
    ...Object.fromEntries(KINDS.map((kind) => [kind.flag, null])), all: false, verbose: false,
  };
  const listen = [];
  const plain = [];
  const files = { '--tls-cert': null, '--tls-key': null };
  let newToken = false;
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
    if (arg === '--new-token') {
      newToken = true;
      continue;
    }
    const valued = VALUE_FLAG.exec(arg);
    if (valued) {
      const [, flag] = valued;
      let value = valued[2];
      if (value === undefined) {
        i += 1;
        value = args[i];
      }
      if (value === undefined || value === '') return { error: `${flag} needs ${flag === '--listen' ? 'HOST:PORT' : 'a file'}` };
      if (flag === '--listen') {
        listen.push(value);
      } else if (files[flag] !== null) {
        return { error: `${flag} given twice` };
      } else {
        files[flag] = value;
      }
      continue;
    }
    const match = flagPattern.exec(arg);
    if (!match && command === 'doctor' && !arg.startsWith('-')) {
      plain.push(arg);
      continue;
    }
    if (!match) return { error: `unknown option for ${command}: ${arg}` };
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
  const { '--tls-cert': cert, '--tls-key': key } = files;
  if (listen.length === 0 && (newToken || cert !== null || key !== null)) {
    return { error: '--new-token, --tls-cert and --tls-key work only with --listen' };
  }
  if ((cert === null) !== (key === null)) return { error: '--tls-cert and --tls-key go together' };
  const named = count > 1 ? KINDS.find((kind) => options[kind.flag] !== null) : undefined;
  if (named !== undefined) return { error: `--${named.flag} names targets of one project; use it with a single --project` };
  if (count > 1 && plain.length > 0) return { error: NAMES_OF_ONE };
  return {
    options, listen, newToken, tls: cert === null ? null : { cert, key }, names: plain,
  };
}

function parseLogArgs(args) {
  const options = { count: 50, denied: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--denied') {
      options.denied = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--from') {
      i += 1;
      if (args[i] === undefined) return { error: '--from needs an address' };
      options.from = args[i];
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
  if (options.from !== undefined) rows = rows.filter(({ entry }) => entry.from === options.from);
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
  for (const line of listenerLines(env)) out(line);
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

const NEW_TOKEN_HINT = 'make a new one with new-token in the start terminal, or start with --new-token';

// What ksproxy token revoke prints for each result of revokeToken but unreadable.
const REVOKE_TEXTS = {
  none: 'there is no token',
  revoked: `the token is revoked; ${NEW_TOKEN_HINT}`,
  already: `the token was already revoked; ${NEW_TOKEN_HINT}`,
};

// ksproxy token and ksproxy token revoke. The token is the same for every project, so neither takes --project, and any
// other word is a usage error. The token itself is never printed: the file holds only its digest.
function token(args, env, ctx) {
  const revoke = args.length === 1 && args[0] === 'revoke';
  if (args.length > 0 && !revoke) {
    return usageError(ctx, 'usage: ksproxy token [revoke]; the token serves every project, so it takes no --project');
  }
  const { state, record } = revoke ? { state: revokeToken(env), record: null } : tokenState(env);
  if (state === 'unreadable') {
    ctx.err(`cannot read ${tokenPath(env)}: no request is let in while it cannot be read; start with --new-token to replace it`);
    return 1;
  }
  if (revoke) {
    ctx.out(REVOKE_TEXTS[state]);
  } else if (state === 'none') {
    ctx.out('no token yet: start with --listen to make one');
  } else {
    for (const line of tokenLines(record)) ctx.out(line);
  }
  return 0;
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
  if (command === 'token') return token(args, withProject(env, null), ctx);
  const taken = takeProject(args, { beforeKind: command === 'check', list: START_LIKE.includes(command), env });
  if (taken.error) return usageError(ctx, taken.error);
  const projectEnv = withProject(env, taken.project);
  switch (command) {
    case 'init':
      return init(projectEnv, ctx);
    case 'start': {
      const parsed = parseStartArgs(taken.rest, taken.projects.length);
      if (parsed.error) return usageError(ctx, parsed.error);
      // One project without --listen runs exactly as before; anything more runs through startMany.
      if (taken.projects.length === 1 && parsed.listen.length === 0) return start(parsed.options, projectEnv, host);
      return startMany({ projects: taken.projects, ...parsed }, withProject(env, null), { ...host, process: proc });
    }
    case 'doctor': {
      const parsed = parseStartArgs(taken.rest, taken.projects.length, command);
      if (parsed.error) return usageError(ctx, parsed.error);
      return doctor({ projects: taken.projects, ...parsed }, withProject(env, null), { ...host, process: proc });
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
