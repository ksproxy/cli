import fs from 'node:fs';
import { run } from './exec.js';
import { appendAudit } from './audit.js';
import { liveSession } from './session.js';
import { KINDS, kindByKey, kindByTool } from './kinds/index.js';
import { hideSecrets } from './kinds/engines/http.js';
import { askReview } from './review.js';
import {
  CALL_FAILED, MAX_ANSWER_BYTES, answerBytes, askCall, callRefusal, callSocketOpen,
} from './broker.js';
import { clip } from './text.js';
import { DEFAULT_OUTPUT_KIB, MAX_OUTPUT_KIB, outputKiB } from './checks.js';
import {
  auditLogPath, callSocketPath, dropDataVolume, isCaseInsensitive, reviewSocketPath, rootStateDir, sessionDir as sessionDirOf,
  startCommand,
} from './paths.js';

// The answer of every tool while the session of this project, or of the default, is not live: it names the command
// that starts that session.
export function noSessionText(env) {
  return `No active session. Ask the user to run \`${startCommand(env)}\` in their terminal.`;
}

const KIB = 1024;
// The room past the visible limit of a stream that it is read with, OUTPUT_MARGIN: a path cut by the read limit is
// less than LONGEST_PATH bytes, and hiding or scrubbing makes each of its bytes at most GROWTH bytes ([hidden] for one
// byte or more, a label of at most 9 bytes for a path of 2 bytes or more). A secret needs no room: dropCutSecret takes a
// cut one.
const LONGEST_PATH = 4096;
const GROWTH = 8;
const OUTPUT_MARGIN = GROWTH * LONGEST_PATH;

// The bytes of one stream that a call on this target shows, from outputKiB: 262144 unless the inventory raised it.
// The read limit is that plus OUTPUT_MARGIN.
function visibleLimit(target) {
  return outputKiB(target) * KIB;
}

// The longest answer line of a brokered call: the share of MAX_ANSWER_BYTES that its visible limit is of the largest,
// so 1 MiB for the default 256 KiB, as it always was, and MAX_ANSWER_BYTES, 16 MiB, for 4 MiB.
function answerLimit(visible) {
  return (MAX_ANSWER_BYTES / (MAX_OUTPUT_KIB * KIB)) * visible;
}

// How much longer than the call's own time limit the mcp side waits for start: the review and the grace after the limit.
const CALL_MARGIN_MS = 75000;

const LIST_TARGETS = {
  name: 'list_targets',
  description: 'List the ssh servers, Kubernetes clusters, local folders and service targets (databases, queues and HTTP APIs) the user has opened, with their state and the commands allowed on each.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

// The tools to list: list_targets and the tool of every kind that is not brokered, always; the tool of a brokered
// kind when the inventory holds a target of that kind, and every one when the inventory is null (it could not be read).
export function toolDefinitions(inventory = {}) {
  const listed = (kind) => kind.brokered !== true || inventory === null || (inventory[kind.key] ?? []).length > 0;
  return [LIST_TARGETS, ...KINDS.filter(listed).map((kind) => kind.tool.definition)];
}

// The call socket of the session, or null when its path cannot be used.
function callSocketOrNull(env) {
  try {
    return callSocketPath(env);
  } catch {
    return null;
  }
}

// A brokered target has no state of its own on this side: the recorded one while the call socket accepts, else down.
async function brokeredState(target, env) {
  const socket = callSocketOrNull(env);
  if (socket === null || !(await callSocketOpen(socket))) return 'down';
  return target.state;
}

export async function targetState(target, env = process.env) {
  const kind = kindByKey(target.kind);
  if (kind === undefined) return 'error';
  if (kind.brokered === true) return brokeredState(target, env);
  return kind.state(target, env);
}

function realOrNull(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return null;
  }
}

const MAX_REVIEW_WORDS = 64;
const MAX_REVIEW_WORD = 200;
const LOOSE_CHAR = /[\s"\u0000-\u001f\u007f-\u009f]/;

// null when the words may be shown to the reviewer as they are, else why not.
// The checks for every kind come first, then the kind's own wordsNotForReview when it has one.
export function reviewWordsProblem(kind, argv) {
  if (argv.length > MAX_REVIEW_WORDS) return `the command has more than ${MAX_REVIEW_WORDS} words`;
  if (argv.some((w) => w.length > MAX_REVIEW_WORD)) return `a word is longer than ${MAX_REVIEW_WORD} characters`;
  if (argv.some((w) => LOOSE_CHAR.test(w))) return 'a word contains a space, a control character or a double quote';
  const { wordsNotForReview } = kindByKey(kind);
  return wordsNotForReview === undefined ? null : wordsNotForReview(argv);
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
  const { notForReview } = kindByKey(kind);
  const why = notForReview === undefined ? null : notForReview(decision.argv);
  if (why !== null) return note(why);
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
  const targets = session.targets ?? [];
  const ofKind = (kind) => targets.filter((t) => t.kind === kind.key);
  hide(rootStateDir(env), '<ksproxy>');
  for (const kind of KINDS) {
    if (kind.scrubDirs === undefined) continue;
    for (const { dir, label } of kind.scrubDirs(ofKind(kind))) hide(dir, label);
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
  for (const kind of KINDS) {
    if (kind.scrubText !== undefined) out = kind.scrubText(out, ofKind(kind));
  }
  return out;
}

// Every text to hide in the output of a brokered call: each secret value of the target, then each form of them that
// the kind's hiddenForms gives (an encoded credential as it is sent or shown). They are used only to hide.
function hiddenTexts(kindObject, open) {
  const forms = kindObject.hiddenForms === undefined ? [] : kindObject.hiddenForms(open.target, open.secrets);
  return [...Object.values(open.secrets), ...forms];
}

// The text without its last count bytes.
function dropLast(text, count) {
  const bytes = Buffer.from(text);
  return bytes.subarray(0, Math.max(0, bytes.length - count)).toString('utf8');
}

// The text without its last piece when that piece is a proper start, of one character or more, of a hidden text: what
// is left of a secret that the end of the stream cut, whatever ended it (the read limit, the time limit, a broken
// stream). The longest such piece is dropped. Only the last characters, one fewer than the longest hidden text, are
// compared. Replacement characters at the very end, left by a character cut in two, are looked past.
function dropCutSecret(text, values) {
  const longest = values.reduce((most, value) => Math.max(most, value.length), 0);
  let end = text.length;
  while (end > 0 && text[end - 1] === '�') end -= 1;
  for (let at = Math.max(0, end - longest + 1); at < end; at += 1) {
    const piece = text.slice(at, end);
    if (values.some((value) => value.length > piece.length && value.startsWith(piece))) return text.slice(0, at);
  }
  return text;
}

// One stream as the agent gets it, from a text read with the read limit, visible plus OUTPUT_MARGIN: a cut secret at
// the end dropped, the secret values hidden, and a cut secret at the end dropped again (a shorter hidden text can
// overlap the start of a cut one); the paths scrubbed in the whole text; when the text reached the read limit, its last
// OUTPUT_MARGIN bytes dropped, as they can hold a path the read limit cut; then cut at visible bytes. cut says whether
// anything was left out.
function fitStream(text, { values, scrub, visible }) {
  const scrubbed = scrub(dropCutSecret(hideSecrets(dropCutSecret(text, values), values), values));
  const reached = Buffer.byteLength(text) >= visible + OUTPUT_MARGIN;
  const capped = capBytes(reached ? dropLast(scrubbed, OUTPUT_MARGIN) : scrubbed, visible);
  return { text: capped.text, cut: reached || capped.cut };
}

// Both streams through fitStream, or null when the hiding or the scrub throws. The call has run and is audited by
// then, so the caller answers with outputFailed: what ran, and no output at all.
function fitStreams(result, fit) {
  try {
    return { stdout: fitStream(result.stdout, fit), stderrText: fitStream(result.stderr, fit) };
  } catch {
    return null;
  }
}

const OUTPUT_FAILED = 'the output could not be shown';

function outputFailed(result, timeoutSeconds) {
  return { text: `${formatResult({
    ...result, stdout: '', stderr: '', truncated: false,
  }, timeoutSeconds)}\n${OUTPUT_FAILED}`, isError: true };
}

function formatResult(result, timeoutSeconds, limit) {
  const parts = [];
  if (result.spawnError) parts.push(`could not start: ${result.spawnError}`);
  else if (result.timedOut) parts.push(`timed out after ${timeoutSeconds}s`);
  else parts.push(`exit code: ${result.exitCode}`);
  if (result.stdout !== '') parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr !== '') parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
  if (result.truncated) parts.push(`[output truncated at ${limit} bytes per stream]`);
  return parts.join('\n');
}

// The fields that an origin adds to an audit entry: none for a local call.
function originFields(origin) {
  return origin === undefined ? {} : { from: origin.from, client: origin.client };
}

const ORIGIN_TEXT = /^[\x20-\x7e]{1,64}$/;

// The origin that a call socket request carried, as audit fields: from and client when each is a string of 1 to 64
// printable ASCII characters, else none. It never refuses the call.
function checkedOriginFields(origin) {
  if (!isPlainObject(origin)) return {};
  const { from, client } = origin;
  const fine = (text) => typeof text === 'string' && ORIGIN_TEXT.test(text);
  return fine(from) && fine(client) ? { from, client } : {};
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

async function listTargets(session, dir, env, stderr, origin) {
  audit(env, { event: 'list', ...originFields(origin) }, stderr);
  const targets = await Promise.all(session.targets.map(async (t) => ({
    kind: t.kind,
    name: t.name,
    description: t.description,
    state: await targetState(t, env),
    allow: t.allow,
    ...(t.review === true ? { review: true } : {}),
    ...(outputKiB(t) === DEFAULT_OUTPUT_KIB ? {} : { outputLimit: `${outputKiB(t)} KiB per stream` }),
  })));
  return { text: JSON.stringify({ startedAt: session.startedAt, targets }, null, 2), isError: false };
}

// The decision after the reviewer was asked when review applies: { decision, reviewed } to go on,
// or { refusal: [text, short, reason] }. ask(subject) asks the reviewer, over the socket or inside start.
async function reviewStep(kindObject, name, first, reviewOn, ask) {
  const { key: kind, word } = kindObject;
  let decision = first;
  let reviewed = null;
  const route = reviewRoute(kind, decision, reviewOn);
  if (route?.argv) {
    const { argv } = route;
    try {
      reviewed = await ask({ kind, name, argv: [...argv] });
    } catch {
      reviewed = { allowed: false, short: 'review not available' };
    }
    if (reviewed?.allowed !== true) {
      return {
        refusal: [
          `REFUSED (${word} ${clip(name, 64)}): ${decision.reason}. The reviewer did not approve it.`,
          typeof reviewed?.short === 'string' ? reviewed.short : 'review not available',
          decision.reason,
        ],
      };
    }
    decision = {
      allowed: true, rule: 'review', argv, command: argv.join(' '), ...(decision.prefix ? { prefix: decision.prefix } : {}),
    };
  }
  if (!decision.allowed) {
    const reason = route?.note ? `${decision.reason}. ${route.note}` : decision.reason;
    return { refusal: [`REFUSED (${word} ${clip(name, 64)}): ${reason}`, decision.short, reason] };
  }
  return { decision, reviewed };
}

// The call in the arguments of the tool: the one argument detailKey, or for a tool whose call is an object,
// every argument except the target name and timeout_seconds.
function detailOf(tool, args) {
  if (tool.detailShape !== 'object') return args[tool.detailKey];
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== tool.nameKey && key !== 'timeout_seconds'));
}

// The call as the audit entry records it: the string or the array of strings when it has the right type, what the
// tool's auditedDetail keeps of an object, else null.
function auditedDetailOf(tool, detail) {
  if (tool.detailShape === 'object') return isPlainObject(detail) ? tool.auditedDetail(detail) : null;
  const isArgs = tool.detailIsArray;
  if (!isArgs && typeof detail === 'string') return detail;
  if (isArgs && Array.isArray(detail) && detail.every((a) => typeof a === 'string')) return detail;
  return null;
}

// null when the call has the type the tool takes, else the text of the refusal.
function detailProblem(tool, detail) {
  if (tool.detailShape === 'object') return isPlainObject(detail) ? null : 'invalid arguments: the request must be an object';
  const isArgs = tool.detailIsArray;
  if (!isArgs && typeof detail !== 'string') return 'invalid arguments: command must be a string';
  if (isArgs && !(Array.isArray(detail) && detail.length > 0 && detail.every((a) => typeof a === 'string'))) {
    return 'invalid arguments: args must be a non-empty array of strings';
  }
  return null;
}

// signal: undefined, or the AbortSignal of the network listener: an abort kills the program of the call at once. A
// brokered call does not take it: its session ends it when it stops.
async function execTool(tool, args, session, dir, env, stderr, review, origin, signal) {
  const kindObject = kindByTool(tool);
  const {
    key: kind, word, label: logKind, noun: label,
  } = kindObject;
  const { nameKey, detailKey } = kindObject.tool;
  const brokered = kindObject.brokered === true;

  const name = args[nameKey];
  const detail = detailOf(kindObject.tool, args);
  const auditedTarget = (() => {
    try {
      return clip(name, 64);
    } catch {
      return '(unprintable)';
    }
  })();
  // The call as the audit records it is made inside a try, so that an attempt is audited even when that throws.
  let auditedDetail = null;
  let detailFailed = false;
  try {
    auditedDetail = auditedDetailOf(kindObject.tool, detail);
  } catch {
    detailFailed = true;
  }
  const entry = {
    event: 'call', tool, kind: logKind, target: auditedTarget, [detailKey]: auditedDetail, ...originFields(origin),
  };
  // Every refusal made on this side is audited here, for every kind. A brokered call that is forwarded is audited
  // by start, which decides it, and not here.
  const refuse = (text, short, reason = text) => {
    audit(env, {
      ...entry, decision: 'refused', reason, short,
    }, stderr);
    return { text, isError: true };
  };

  if (detailFailed) return refuse('invalid arguments: the call could not be written to the log', 'invalid arguments');
  if (typeof name !== 'string') return refuse(`invalid arguments: ${nameKey} must be a string`, 'invalid arguments');
  const problem = detailProblem(kindObject.tool, detail);
  if (problem !== null) return refuse(problem, 'invalid arguments');
  if (!validTimeout(args.timeout_seconds)) {
    return refuse('invalid arguments: timeout_seconds must be an integer from 1 to 600', 'invalid arguments');
  }
  const timeoutSeconds = args.timeout_seconds ?? 60;

  const target = session.targets.find((t) => t.kind === kind && t.name === name);
  if (!target) {
    return refuse(`unknown ${label} "${clip(name, 64)}". Open targets: ${listOpen(session, kind)}`, 'unknown target');
  }
  if (brokered) {
    const socket = callSocketOrNull(env);
    if (socket === null) return refuse(callRefusal(CALL_FAILED.noAnswer, word, name).text, 'session did not answer', CALL_FAILED.noAnswer);
    return askCall(socket, {
      kind, name, input: detail, timeoutSeconds, ...(origin === undefined ? {} : { origin: originFields(origin) }),
    }, timeoutSeconds * 1000 + CALL_MARGIN_MS, word);
  }

  const step = await reviewStep(
    kindObject,
    name,
    kindObject.decide(target, detail, env),
    target.review === true,
    (subject) => review(reviewSocketPath(env), subject),
  );
  if (step.refusal) return refuse(...step.refusal);
  const { decision, reviewed } = step;

  // The limit comes from the session file, which start wrote from the inventory; outputKiB never gives more than 4 MiB.
  const visible = visibleLimit(target);
  const limits = { timeoutMs: timeoutSeconds * 1000, maxBytes: visible + OUTPUT_MARGIN };
  const spec = kindObject.command(target, decision, {
    dir, env, session, input: detail,
  });
  const result = await run(spec.program, spec.args, { ...limits, ...spec.options, signal });
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
  const fitted = fitStreams(result, { values: [], scrub: (text) => scrubOutput(text, session, env), visible });
  if (fitted === null) return outputFailed(result, timeoutSeconds);
  const { stdout, stderrText } = fitted;
  return {
    text: formatResult({
      ...result,
      truncated: result.truncated || stdout.cut || stderrText.cut,
      stdout: stdout.text,
      stderr: stderrText.text,
    }, timeoutSeconds, visible),
    isError: result.timedOut || result.spawnError !== null || result.exitCode !== 0,
  };
}

const GRACE_MS = 1000;
const LATE = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};
const STOPPED = Symbol('stopped');

// perform of the kind, with the call's time limit, the output limit and a signal that fires at the limit or when the
// session stops. A perform that is still busy GRACE_MS after the limit counts as timed out; a stop ends the wait at once.
function performWithin(kindObject, open, decision, {
  env, timeoutMs, maxBytes, signal, input,
}) {
  const controller = new AbortController();
  let timer;
  let grace;
  let onStop;
  const cut = new Promise((resolve) => {
    onStop = () => {
      controller.abort();
      resolve(STOPPED);
    };
    signal.addEventListener('abort', onStop, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      grace = setTimeout(() => resolve(LATE), GRACE_MS);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(() => kindObject.perform(open.target, decision, {
    env, secrets: open.secrets, timeoutMs, maxBytes, signal: controller.signal, input,
  }));
  return Promise.race([work, cut]).finally(() => {
    clearTimeout(timer);
    clearTimeout(grace);
    signal.removeEventListener('abort', onStop);
  });
}

function validResult(result) {
  return result !== null && typeof result === 'object'
    && (Number.isInteger(result.exitCode) || result.exitCode === null)
    && typeof result.stdout === 'string' && typeof result.stderr === 'string';
}

// The text cut to maxBytes bytes, and whether it was cut.
function capBytes(text, maxBytes) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, cut: false };
  return { text: bytes.subarray(0, maxBytes).toString('utf8'), cut: true };
}

// One brokered call inside ksproxy start, as the call server hands it over: the target comes from start's own
// list of opened targets, never from session.json. Every refusal is audited here; an error is a refusal with a fixed text.
export async function answerCall(request, {
  calls, session, env, signal, review, stderr,
}) {
  const kindObject = kindByKey(request.kind);
  if (kindObject?.brokered !== true) return callRefusal(CALL_FAILED.notOpen);
  const { word, label: logKind, tool } = kindObject;
  const { name, input } = request;
  // The call as the audit records it is made inside a try, so that an attempt is audited even when that throws.
  let detail = null;
  let detailFailed = false;
  try {
    detail = auditedDetailOf(tool, input);
  } catch {
    detailFailed = true;
  }
  const entry = {
    event: 'call', tool: tool.name, kind: logKind, target: clip(name, 64), [tool.detailKey]: detail, ...checkedOriginFields(request.origin),
  };
  const refuse = (text, short, reason = text) => {
    audit(env, {
      ...entry, decision: 'refused', reason, short,
    }, stderr);
    return { text, isError: true };
  };
  const failed = () => refuse(callRefusal(CALL_FAILED.failed, word, name).text, 'call failed', CALL_FAILED.failed);
  if (detailFailed) return failed();

  const open = calls.get(`${kindObject.key}:${name}`);
  if (open === undefined) return refuse(callRefusal(CALL_FAILED.notOpen, word, name).text, 'target not open', CALL_FAILED.notOpen);
  const problem = detailProblem(tool, input);
  if (problem !== null) return refuse(problem, 'invalid arguments');

  let first;
  try {
    first = kindObject.decide(open.target, input, env);
  } catch {
    return failed();
  }
  const step = await reviewStep(kindObject, name, first, open.target.review === true, review);
  if (step.refusal) return refuse(...step.refusal);
  const { decision, reviewed } = step;
  // The session can stop while the reviewer thinks: an approval that comes after the stop does not run the call.
  if (signal.aborted) return refuse(callRefusal(CALL_FAILED.noAnswer, word, name).text, 'session stopped', 'the session stopped before the call ran');

  // A program can print its own environment: every secret value of the target, and every form of one that the kind
  // gives, is hidden before the cut, and a cut one at the end of a stream is dropped. The read limit is the same for
  // every call on a target, so nothing that reaches the agent or the log tells the length of a secret. The limit comes
  // from the target as this start opened it, never from session.json.
  const visible = visibleLimit(open.target);
  const started = Date.now();
  let values;
  let result;
  try {
    values = hiddenTexts(kindObject, open);
    result = await performWithin(kindObject, open, decision, {
      env, timeoutMs: request.timeoutSeconds * 1000, maxBytes: visible + OUTPUT_MARGIN, signal, input,
    });
  } catch {
    return failed();
  }
  if (result === STOPPED) return refuse(callRefusal(CALL_FAILED.noAnswer, word, name).text, 'session stopped', 'the session stopped during the call');
  if (!validResult(result)) return failed();
  const timedOut = result.timedOut === true;
  audit(env, {
    ...entry,
    decision: 'allowed',
    rule: decision.rule,
    ...(reviewed === null ? {} : { review: { certainty: reviewed.certainty, reason: reviewed.reason } }),
    exitCode: result.exitCode,
    timedOut,
    spawnError: null,
    durationMs: Date.now() - started,
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
  }, stderr);
  const fitted = fitStreams(result, { values, scrub: (text) => scrubOutput(text, session, env), visible });
  if (fitted === null) return outputFailed({ exitCode: result.exitCode, timedOut, spawnError: null }, request.timeoutSeconds);
  const { stdout, stderrText } = fitted;
  // The call ran: an answer whose JSON line would pass answerLimit of the visible limit (escaping can make a byte 6)
  // keeps less of each stream, half as much each time, so that the agent is always told what ran.
  const answerWithin = (limit) => {
    const out = capBytes(stdout.text, limit);
    const err = capBytes(stderrText.text, limit);
    return {
      text: formatResult({
        exitCode: result.exitCode,
        timedOut,
        spawnError: null,
        truncated: result.truncated === true || stdout.cut || stderrText.cut || out.cut || err.cut,
        stdout: out.text,
        stderr: err.text,
      }, request.timeoutSeconds, limit),
      isError: timedOut || result.exitCode !== 0,
    };
  };
  const most = answerLimit(visible);
  let limit = visible;
  let answer = answerWithin(limit);
  while (answerBytes(answer) > most) {
    limit = Math.floor(limit / 2);
    answer = answerWithin(limit);
  }
  return answer;
}

export async function callTool(name, args, env = process.env, {
  stderr = process.stderr, review = askReview, origin, signal,
} = {}) {
  try {
    if (name !== LIST_TARGETS.name && kindByTool(name) === undefined) return { text: `unknown tool: ${name}`, isError: true };
    const dir = sessionDirOf(env);
    const session = liveSession(dir);
    if (session === null || !Array.isArray(session.targets)) {
      return { text: noSessionText(env), isError: name !== 'list_targets' };
    }
    if (name === 'list_targets') return await listTargets(session, dir, env, stderr, origin);
    if (!isPlainObject(args)) return { text: 'invalid arguments: expected an object', isError: true };
    return await execTool(name, args, session, dir, env, stderr, review, origin, signal);
  } catch (err) {
    return { text: `internal error: ${err?.message ?? err}`, isError: true };
  }
}
