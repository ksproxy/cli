import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv, run } from './exec.js';
import { appendAudit, clip } from './audit.js';
import { liveSession } from './session.js';
import {
  AllowError, checkRawSshCommand, decide, matchRuleDetail, tokenizeSshCommand,
} from './allowlist.js';
import {
  checkMaster, execArgs, jumpPrefix, zshEqualsWord,
} from './ssh.js';
import {
  READ_VERBS, hardRefusalDetail, kubectlArgs, portListening,
} from './kube.js';
import { askReview } from './review.js';
import {
  cleanPath, dropDataVolume, isCaseInsensitive, localFolderProblem, localScope, reviewProblem, wildcardProblem,
} from './local.js';
import {
  auditLogPath, kubectlBin, reviewSocketPath, sessionDir as sessionDirOf, sshBin, stateDir as stateDirOf,
} from './paths.js';

export const NO_SESSION = 'No active session. Ask the user to run `ksproxy start` in their terminal.';
const MAX_OUTPUT_BYTES = 262144;

const TIMEOUT_SCHEMA = { type: 'integer', minimum: 1, maximum: 600, default: 60 };

export const TOOLS = [
  {
    name: 'list_targets',
    description: 'List the ssh servers, Kubernetes clusters and local folders the user has opened, with their state and the commands allowed on each.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ssh_exec',
    description: 'Run one command on an open ssh server. The command is checked against that server\'s allowlist.',
    inputSchema: {
      type: 'object',
      required: ['server', 'command'],
      additionalProperties: false,
      properties: {
        server: { type: 'string', description: 'Target name from list_targets' },
        command: { type: 'string', description: 'Command to run on the server' },
        timeout_seconds: TIMEOUT_SCHEMA,
      },
    },
  },
  {
    name: 'kubectl',
    description: 'Run kubectl against an open Kubernetes cluster. The arguments are checked against that cluster\'s allowlist.',
    inputSchema: {
      type: 'object',
      required: ['cluster', 'args'],
      additionalProperties: false,
      properties: {
        cluster: { type: 'string', description: 'Target name from list_targets' },
        args: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'kubectl arguments, verb first, one array element per argument, e.g. ["get","pods","-n","web"]',
        },
        timeout_seconds: TIMEOUT_SCHEMA,
      },
    },
  },
  {
    name: 'local_exec',
    description: 'Run one command on this machine in an open local target\'s folder. The command is checked against that target\'s allowlist; shell syntax is not accepted.',
    inputSchema: {
      type: 'object',
      required: ['target', 'command'],
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: 'Target name from list_targets' },
        command: { type: 'string', description: 'Command and arguments, separated by spaces' },
        timeout_seconds: TIMEOUT_SCHEMA,
      },
    },
  },
];

export async function targetState(target, env = process.env) {
  if (target.kind === 'ssh') {
    return (await checkMaster({ socket: target.socket, host: target.host }, env)) ? 'up' : 'down';
  }
  if (target.kind === 'local') {
    try {
      return fs.statSync(target.cwd).isDirectory() ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }
  if (!(await portListening(target.proxyPort))) return 'down';
  return target.state;
}

export function decideSsh(target, input) {
  const jumped = target.jumps !== undefined;
  const prefix = jumpPrefix(target.jumps);
  if (prefix === null) {
    return {
      allowed: false,
      reason: 'this target\'s jumps are not usable; ask the user to restart ksproxy start',
      short: 'jumps not usable',
    };
  }
  if (jumped && target.allow === 'any') {
    return { allowed: false, reason: 'a target with jumps needs a list of rules, not "any"', short: 'allowlist is "any"' };
  }
  try {
    if (target.allow === 'any') {
      return { allowed: true, rule: 'any', command: checkRawSshCommand(input) };
    }
    const tokens = tokenizeSshCommand(input);
    if (jumped && tokens.some(zshEqualsWord)) {
      return {
        allowed: false,
        reason: 'a word may not start with "=" or contain "==" or ":=" on a target with jumps',
        short: 'unsafe "=" word',
      };
    }
    const carried = prefix ? { prefix } : {};
    const decision = decide(tokens, target.allow);
    if (!decision.allowed) return { ...decision, argv: tokens, ...carried };
    return {
      allowed: true, rule: decision.rule, command: tokens.join(' '), ...carried,
    };
  } catch (err) {
    if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
    throw err;
  }
}

function realOrNull(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

function usableRule(rule) {
  if (typeof rule !== 'string') return false;
  const [program] = rule.trim().split(/\s+/);
  return program !== '*' && program !== '...';
}

export function decideLocal(target, input, env = process.env, platform = process.platform) {
  if (!Array.isArray(target.allow)) {
    return { allowed: false, reason: 'this local target has no usable allowlist', short: 'allowlist is empty' };
  }
  const folder = localFolderProblem(target.cwd, env, Array.isArray(target.protected) ? target.protected : [], platform);
  if (folder !== null) {
    return {
      allowed: false,
      reason: `this target's folder is not acceptable; ask the user to run "ksproxy check local ${target.name}"`,
      short: 'folder not allowed',
    };
  }
  const usable = target.allow.filter(usableRule);
  const scope = localScope(target, env, platform);
  try {
    const tokens = tokenizeSshCommand(input);
    let first = null;
    let preferred = null;
    for (const rule of usable) {
      const detail = matchRuleDetail(tokens, rule);
      if (detail === null) continue;
      const problem = wildcardProblem(detail, target, env, scope);
      if (problem === null) return { allowed: true, rule, argv: tokens };
      first ??= problem;
      if (problem.short !== 'not a plain argument') preferred ??= problem;
    }
    const shown = preferred ?? first;
    if (shown !== null) return { allowed: false, reason: shown.reason, short: shown.short };
    if (usable.length === 0 && target.allow.length > 0) {
      return { allowed: false, reason: 'not on the allowlist for this target', short: 'not on allowlist' };
    }
    const refusal = decide(tokens, usable);
    if (target.review !== true) return refusal;
    const problem = reviewProblem(tokens, target, env, scope);
    return problem === null ? { ...refusal, argv: tokens } : { ...refusal, notReviewed: problem.reason };
  } catch (err) {
    if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
    throw err;
  }
}

export function decideKube(target, args) {
  const refusal = hardRefusalDetail(args, target.manifestRoots ?? []);
  if (refusal !== null) return { allowed: false, reason: refusal.reason, short: refusal.short };
  const decision = decide(args, target.allow);
  return decision.allowed ? decision : { ...decision, argv: [...args] };
}

const MAX_REVIEW_WORDS = 64;
const MAX_REVIEW_WORD = 200;
const LOOSE_CHAR = /[\s"\u0000-\u001f\u007f-\u009f]/;

// null when the words may be shown to the reviewer as they are, else why not.
// For ssh the words reach a login shell on the server; the tokenizer already keeps out
// quotes, ~, globs and braces, so only an assignment and the words that zsh may rewrite remain.
export function reviewWordsProblem(kind, argv) {
  if (argv.length > MAX_REVIEW_WORDS) return `the command has more than ${MAX_REVIEW_WORDS} words`;
  if (argv.some((w) => w.length > MAX_REVIEW_WORD)) return `a word is longer than ${MAX_REVIEW_WORD} characters`;
  if (argv.some((w) => LOOSE_CHAR.test(w))) return 'a word contains a space, a control character or a double quote';
  if (kind !== 'ssh') return null;
  if (argv.some((w) => w.startsWith('='))) return 'a word starts with "=", which the server\'s shell may expand';
  if (argv.some((w) => w.includes('==') || w.includes(':='))) {
    return 'a word contains "==" or ":=", which the server\'s shell may rewrite';
  }
  if (argv[0].includes('=')) return 'the first word sets an environment variable on the server';
  return null;
}

// For a refusal on a target with review on: { argv } to send to the reviewer, { note } saying why it is not sent,
// or null when review does not apply.
export function reviewRoute(kind, decision, reviewOn) {
  if (!reviewOn || decision.allowed === true || decision.unmatched !== true) return null;
  const note = (why) => ({ note: `It was not sent to the reviewer: ${why}.` });
  if (typeof decision.notReviewed === 'string') return note(decision.notReviewed);
  if (!Array.isArray(decision.argv)) return null;
  const words = reviewWordsProblem(kind, decision.argv);
  if (words !== null) return note(words);
  if (kind === 'kubernetes' && !READ_VERBS.has(decision.argv[0])) {
    return note(`only read verbs are reviewed, and ${decision.argv[0]} is not one`);
  }
  return { argv: [...decision.argv] };
}

function validTimeout(value) {
  return value === undefined || (Number.isInteger(value) && value >= 1 && value <= 600);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubOutput(text, session, env = process.env, insensitive = isCaseInsensitive(), platform = process.platform) {
  const hidden = [];
  const hide = (dir, label) => {
    for (const spelling of [dir, realOrNull(dir)]) {
      if (spelling === null) continue;
      for (const form of [spelling, dropDataVolume(spelling, platform)]) {
        if (form.length > 1) hidden.push([form, label]);
      }
    }
  };
  hide(stateDirOf(env), '<ksproxy>');
  for (const target of session.targets ?? []) {
    if (target.kind !== 'local') continue;
    hide(target.cwd, '<folder>');
    hide(path.resolve(target.cwd), '<folder>');
  }
  let out = text;
  if (hidden.length > 0) {
    hidden.sort((a, b) => b[0].length - a[0].length);
    const pattern = hidden.map(([dir]) => `(${escapeRegExp(dir)})`).join('|');
    const labelOf = (groups) => hidden[groups.findIndex((g) => g !== undefined)][1];
    out = out.replace(
      new RegExp(`(?:${pattern})(?![A-Za-z0-9_])`, insensitive ? 'gi' : 'g'),
      (...args) => labelOf(args.slice(1, hidden.length + 1)),
    );
  }
  for (const target of session.targets ?? []) {
    if (target.kind !== 'kubernetes' || !Number.isInteger(target.proxyPort)) continue;
    out = out.replace(new RegExp(`(?:127\\.0\\.0\\.1|localhost):${target.proxyPort}(?!\\d)`, 'g'), '<proxy>');
  }
  return out;
}

function formatResult(result, timeoutSeconds) {
  const parts = [];
  if (result.spawnError) parts.push(`could not start: ${result.spawnError}`);
  else if (result.timedOut) parts.push(`timed out after ${timeoutSeconds}s`);
  else parts.push(`exit code: ${result.exitCode}`);
  if (result.stdout !== '') parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr !== '') parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push(`[output truncated at ${MAX_OUTPUT_BYTES} bytes per stream]`);
  return parts.join('\n');
}

function audit(env, entry, stderr) {
  try {
    appendAudit(auditLogPath(env), entry);
  } catch (err) {
    stderr.write(`ksproxy: could not write audit log: ${err.message}\n`);
  }
}

function listOpen(session, kind) {
  const names = session.targets.filter((t) => t.kind === kind).map((t) => t.name);
  return names.length > 0 ? names.join(', ') : 'none';
}

async function listTargets(session, dir, env, stderr) {
  audit(env, { event: 'list' }, stderr);
  const targets = await Promise.all(session.targets.map(async (t) => ({
    kind: t.kind,
    name: t.name,
    description: t.description,
    state: await targetState(t, env),
    allow: t.allow,
    ...(t.review === true ? { review: true } : {}),
  })));
  return { text: JSON.stringify({ startedAt: session.startedAt, targets }, null, 2), isError: false };
}

const EXEC_TOOLS = {
  ssh_exec: {
    kind: 'ssh', word: 'ssh', logKind: 'ssh', nameKey: 'server', detailKey: 'command', label: 'ssh server',
  },
  kubectl: {
    kind: 'kubernetes', word: 'kube', logKind: 'kube', nameKey: 'cluster', detailKey: 'args', label: 'cluster',
  },
  local_exec: {
    kind: 'local', word: 'local', logKind: 'loc', nameKey: 'target', detailKey: 'command', label: 'local target',
  },
};

async function execTool(tool, args, session, dir, env, stderr, review) {
  const {
    kind, word, logKind, nameKey, detailKey, label,
  } = EXEC_TOOLS[tool];
  const isArgs = detailKey === 'args';

  const name = args[nameKey];
  const detail = args[detailKey];
  const auditedTarget = (() => {
    try {
      return clip(name, 64);
    } catch {
      return '(unprintable)';
    }
  })();
  let auditedDetail = null;
  if (!isArgs && typeof detail === 'string') auditedDetail = detail;
  if (isArgs && Array.isArray(detail) && detail.every((a) => typeof a === 'string')) auditedDetail = detail;
  const entry = {
    event: 'call', tool, kind: logKind, target: auditedTarget, [detailKey]: auditedDetail,
  };
  const refuse = (text, short, reason = text) => {
    audit(env, {
      ...entry, decision: 'refused', reason, short,
    }, stderr);
    return { text, isError: true };
  };

  if (typeof name !== 'string') return refuse(`invalid arguments: ${nameKey} must be a string`, 'invalid arguments');
  if (!isArgs && typeof detail !== 'string') return refuse('invalid arguments: command must be a string', 'invalid arguments');
  if (isArgs && !(Array.isArray(detail) && detail.length > 0 && detail.every((a) => typeof a === 'string'))) {
    return refuse('invalid arguments: args must be a non-empty array of strings', 'invalid arguments');
  }
  if (!validTimeout(args.timeout_seconds)) {
    return refuse('invalid arguments: timeout_seconds must be an integer from 1 to 600', 'invalid arguments');
  }
  const timeoutSeconds = args.timeout_seconds ?? 60;

  const target = session.targets.find((t) => t.kind === kind && t.name === name);
  if (!target) {
    return refuse(`unknown ${label} "${clip(name, 64)}". Open targets: ${listOpen(session, kind)}`, 'unknown target');
  }

  let decision;
  if (kind === 'ssh') decision = decideSsh(target, detail);
  else if (kind === 'kubernetes') decision = decideKube(target, detail);
  else decision = decideLocal(target, detail, env);
  let reviewed = null;
  const route = reviewRoute(kind, decision, target.review === true);
  if (route?.argv) {
    const { argv } = route;
    try {
      reviewed = await review(reviewSocketPath(env), { kind, name, argv: [...argv] });
    } catch {
      reviewed = { allowed: false, short: 'review not available' };
    }
    if (reviewed?.allowed !== true) {
      return refuse(
        `REFUSED (${word} ${clip(name, 64)}): ${decision.reason}. The reviewer did not approve it.`,
        typeof reviewed?.short === 'string' ? reviewed.short : 'review not available',
        decision.reason,
      );
    }
    decision = {
      allowed: true, rule: 'review', argv, command: argv.join(' '), ...(decision.prefix ? { prefix: decision.prefix } : {}),
    };
  }
  if (!decision.allowed) {
    const reason = route?.note ? `${decision.reason}. ${route.note}` : decision.reason;
    return refuse(`REFUSED (${word} ${clip(name, 64)}): ${reason}`, decision.short, reason);
  }

  const limits = { timeoutMs: timeoutSeconds * 1000, maxBytes: MAX_OUTPUT_BYTES };
  let result;
  if (kind === 'ssh') {
    const command = decision.prefix === undefined ? decision.command : `${decision.prefix} ${decision.command}`;
    result = await run(sshBin(env), execArgs(path.join(dir, 'ssh_config'), name, command), {
      ...limits,
      env: minimalEnv(env),
    });
  } else if (kind === 'kubernetes') {
    result = await run(kubectlBin(env), kubectlArgs(path.join(dir, 'kubeconfig'), name, decision.argv ?? detail), {
      ...limits,
      env: minimalEnv(env, {
        KUBECONFIG: path.join(dir, 'kubeconfig'), KUBERC: 'off', KUBECTL_KUBERC: 'false',
      }),
    });
  } else {
    const folders = session.targets.filter((t) => t.kind === 'local').map((t) => t.cwd);
    result = await run(decision.argv[0], decision.argv.slice(1), {
      ...limits,
      cwd: target.cwd,
      env: minimalEnv(env, { PATH: cleanPath(target.path, folders) }, { own: false }),
    });
  }

  audit(env, {
    ...entry,
    decision: 'allowed',
    rule: decision.rule,
    ...(reviewed === null ? {} : { review: { certainty: reviewed.certainty, reason: reviewed.reason } }),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    spawnError: result.spawnError ?? null,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
  }, stderr);
  return {
    text: formatResult({
      ...result,
      stdout: scrubOutput(result.stdout, session, env),
      stderr: scrubOutput(result.stderr, session, env),
    }, timeoutSeconds),
    isError: result.timedOut || result.spawnError !== null || result.exitCode !== 0,
  };
}

export async function callTool(name, args, env = process.env, { stderr = process.stderr, review = askReview } = {}) {
  try {
    if (!TOOLS.some((t) => t.name === name)) return { text: `unknown tool: ${name}`, isError: true };
    const dir = sessionDirOf(env);
    const session = liveSession(dir);
    if (session === null || !Array.isArray(session.targets)) {
      return { text: NO_SESSION, isError: name !== 'list_targets' };
    }
    if (name === 'list_targets') return await listTargets(session, dir, env, stderr);
    if (!isPlainObject(args)) return { text: 'invalid arguments: expected an object', isError: true };
    return await execTool(name, args, session, dir, env, stderr, review);
  } catch (err) {
    return { text: `internal error: ${err?.message ?? err}`, isError: true };
  }
}
