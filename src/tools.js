import fs from 'node:fs';
import { run } from './exec.js';
import { appendAudit } from './audit.js';
import { liveSession } from './session.js';
import { readSessionTools } from './session-tools.js';
import { KINDS, kindByKey, kindByTool } from './kinds/index.js';
import { hideSecrets } from './kinds/engines/http.js';
import { askReview } from './review.js';
import {
  CALL_FAILED, MAX_ANSWER_BYTES, answerBytes, askCall, callRefusal, callSocketOpen,
} from './broker.js';
import { clip, sizeText } from './text.js';
import {
  DEFAULT_OUTPUT_KIB, END_PART_KIB, MAX_OUTPUT_KIB, outputKiB,
} from './checks.js';
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
// byte or more, a label of at most 9 bytes for a path of 2 bytes or more). A secret needs no room in it: a brokered
// stream that did not end on its own leaves out its end, cutRoom bytes of it.
const LONGEST_PATH = 4096;
const GROWTH = 8;
const OUTPUT_MARGIN = GROWTH * LONGEST_PATH;

// The end part of a cut stream that was read to its end: at most END_BYTES of its end. For ssh, kubernetes and local,
// run keeps the last END_RING bytes of each stream for it: END_BYTES, OUTPUT_MARGIN for a path that the start of the
// kept bytes cut, and END_SLACK, how much the scrub may shrink them before no end part can be shown.
const END_BYTES = END_PART_KIB * KIB;
const END_SLACK = 4 * KIB;
const END_RING = END_BYTES + OUTPUT_MARGIN + END_SLACK;
// The room kept in a stream for the line [... N cut here ...] between its two parts.
const MARKER_ROOM = 64;
// The words of the cut line of a brokered stream: one that shows its first bytes up to the visible limit, and one that
// did not end on its own and is shorter than that once its end is left out.
const LEFT_OUT = 'the rest was left out';
const END_LEFT_OUT = 'the stream did not end on its own, so its end was left out';

// The bytes of one stream that a call on this target shows, from outputKiB: 262144 unless the inventory raised it.
// The read limit is readLimit of it.
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
// A tool with listed false (mcp_call) is never listed, though it answers when called. direct: the tools of the live
// session from directTools, listed after those in their own order; none by default.
export function toolDefinitions(inventory = {}, direct = []) {
  const listed = (kind) => kind.tool.listed !== false
    && (kind.brokered !== true || inventory === null || (inventory[kind.key] ?? []).length > 0);
  return [LIST_TARGETS, ...KINDS.filter(listed).map((kind) => kind.tool.definition), ...direct.map((item) => item.definition)];
}

// The fixed tool that a tool of the session is routed to: the unlisted tool of the mcp kind.
const ROUTED_TOOL = 'mcp_call';

// The live session of env with the tools its MCP servers give the agent directly: { session, dir, tools }, the tools
// from readSessionTools in the order of mcp-tools.json, less any whose name is that of a fixed tool (list_targets or
// the tool of a kind, listed or not) or comes more than once. No live session, or anything that goes wrong, gives no
// tools: it never throws.
function sessionTools(env) {
  try {
    const dir = sessionDirOf(env);
    const session = liveSession(dir);
    if (session === null || !Array.isArray(session.targets)) return { tools: [] };
    const read = readSessionTools(dir, session);
    const fixed = new Set([LIST_TARGETS.name, ...KINDS.map((kind) => kind.tool.name)]);
    const count = new Map();
    for (const { definition } of read) count.set(definition.name, (count.get(definition.name) ?? 0) + 1);
    return { session, dir, tools: read.filter(({ definition }) => !fixed.has(definition.name) && count.get(definition.name) === 1) };
  } catch {
    return { tools: [] };
  }
}

// The tools that the live session of env gives the agent directly, as tools/list adds them after the fixed tools.
export function directTools(env = process.env) {
  return sessionTools(env).tools;
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

// The folders that scrubOutput replaces, as [spelling, label], the longest first: the root state folder, and the
// folders that the kinds' scrubDirs give for their own session targets, each as written and by its real path from
// realOrNull, each of those also without a leading /System/Volumes/Data on darwin, leaving out one-character spellings.
function scrubFolders(session, env, platform) {
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
  hide(rootStateDir(env), '<ksproxy>');
  for (const kind of KINDS) {
    if (kind.scrubDirs === undefined) continue;
    for (const { dir, label } of kind.scrubDirs(targets.filter((t) => t.kind === kind.key))) hide(dir, label);
  }
  return hidden.sort((a, b) => b[0].length - a[0].length);
}

export function scrubOutput(text, session, env = process.env, insensitive = isCaseInsensitive(), platform = process.platform) {
  const hidden = scrubFolders(session, env, platform);
  const targets = session.targets ?? [];
  let out = text;
  if (hidden.length > 0) {
    const pattern = hidden.map(([dir]) => `(${escapeRegExp(dir)})`).join('|');
    const labelOf = (groups) => hidden[groups.findIndex((g) => g !== undefined)][1];
    out = out.replace(
      new RegExp(`(?:${pattern})(?![A-Za-z0-9_])`, insensitive ? 'gi' : 'g'),
      (...args) => labelOf(args.slice(1, hidden.length + 1)),
    );
  }
  for (const kind of KINDS) {
    if (kind.scrubText !== undefined) out = kind.scrubText(out, targets.filter((t) => t.kind === kind.key));
  }
  return out;
}

// The text as a regular expression with the i flag and without u compares it: each code unit as its upper case when
// that is one code unit, unless that would make a character from 128 up into one below 128.
function caseFolded(text) {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    const unit = text[at];
    const upper = unit.toUpperCase();
    out += upper.length === 1 && !(unit.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128) ? upper : unit;
  }
  return out;
}

// The text without its last piece when that piece is a proper start of a folder that scrubOutput replaces, compared
// as scrubOutput compares (ignoring case on darwin and win32, as its regular expression does): what is left of a path
// that the end of a stream cut, which the scrub cannot know. A last piece such as "/" goes too, whether it was cut or
// not. Used on a stream that did not end on its own.
export function dropCutFolder(text, session, env = process.env, insensitive = isCaseInsensitive(), platform = process.platform) {
  const folders = scrubFolders(session, env, platform).map(([dir]) => dir);
  return dropCutStart(text, folders, insensitive ? caseFolded : (piece) => piece);
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

// The text without its last piece when that piece is a proper start, of one character or more, of one of the values:
// what is left of a value that the end of the text cut. The longest such piece is dropped. Only the last characters,
// one fewer than the longest value, are compared, each value and piece as fold gives it. Replacement characters at the
// very end, left by a character cut in two, are looked past. It reads the text to decide, so it is used only for the
// folders of the scrub (dropCutFolder), never for a hidden text: there it would tell whether a guess at the end of a
// stream starts a secret.
function dropCutStart(text, values, fold) {
  const longest = values.reduce((most, value) => Math.max(most, value.length), 0);
  const folded = values.map(fold);
  let end = text.length;
  while (end > 0 && text[end - 1] === '\ufffd') end -= 1;
  for (let at = Math.max(0, end - longest + 1); at < end; at += 1) {
    const piece = fold(text.slice(at, end));
    if (folded.some((value) => value.length > piece.length && value.startsWith(piece))) return text.slice(0, at);
  }
  return text;
}

// One stream of ssh, kubernetes or local as the agent gets it, from a text read with the read limit, visible plus
// OUTPUT_MARGIN. These kinds hide no secret. A stream that did not end on its own loses a last piece that starts a
// folder of the scrub (cutFolder); the paths are scrubbed in the whole text; a stream that reached the read limit loses
// its last OUTPUT_MARGIN bytes, as they can hold a path or a proxy address the read limit cut; then the text is cut at
// visible bytes. cut says whether anything was left out.
function fitCounted(text, {
  scrub, visible, ended, cutFolder,
}) {
  const reached = Buffer.byteLength(text) >= visible + OUTPUT_MARGIN;
  const scrubbed = scrub(ended ? text : cutFolder(text));
  const capped = capBytes(reached ? dropLast(scrubbed, OUTPUT_MARGIN) : scrubbed, visible);
  return { text: capped.text, cut: reached || capped.cut };
}

// How many bytes of the end of a brokered stream that did not end on its own are never shown: 1 KiB while the longest
// hidden text has at most SHORT_SECRET characters, else GROWTH KiB for each 1024 characters of it, begun ones counted.
// It is GROWTH bytes or more for each character: a hidden text that the end of the stream cut has fewer characters
// than the whole one, and hiding the shorter texts inside the piece makes a character at most GROWTH bytes, so the
// piece lies in those bytes. The size tells of the longest hidden text only whether it is longer than SHORT_SECRET
// characters, and then its length in steps of 1024.
const SHORT_SECRET = KIB / GROWTH;
function cutRoom(values) {
  const longest = values.reduce((most, value) => Math.max(most, value.length), 0);
  return longest <= SHORT_SECRET ? KIB : GROWTH * KIB * Math.ceil(longest / KIB);
}

// The read limit of a stream: the visible limit, OUTPUT_MARGIN, and what cutRoom of the hidden texts is over 1 KiB
// (nothing for ssh, kubernetes and local, and for hidden texts of at most SHORT_SECRET characters: 288 KiB by default).
// A brokered stream that reached it still has the visible limit, LONGEST_PATH and cutRoom once hidden while hiding took
// at most 27 KiB out of it, so it shows its first bytes as a shorter stream that ended does: the limit tells nothing.
function readLimit(visible, values) {
  return visible + OUTPUT_MARGIN + cutRoom(values) - KIB;
}

// The start of a hidden text of more than visible bytes, as the agent gets it: its first visible bytes, scrubbed. A
// path of the scrub that crosses that place must not be shown in part, and looking for a start of one there would
// tell whether a guess starts a folder: so the first visible bytes are scrubbed, and so are the first visible and
// LONGEST_PATH bytes, in which such a path is whole, and what the two have in common from their start is shown. A
// character that the cut split goes the same way. Where the cut falls is counted before the scrub, so how much the
// scrub takes out decides nothing.
function firstBytes(bytes, scrub, visible) {
  const short = scrub(bytes.subarray(0, visible).toString());
  const long = scrub(bytes.subarray(0, visible + LONGEST_PATH).toString());
  let same = 0;
  while (same < short.length && short[same] === long[same]) same += 1;
  return capBytes(short.slice(0, same), visible).text;
}

// One stream of a brokered call as the agent gets it: { text, cut, reason, cleaned }. Every hidden text is replaced
// first, in the whole text, and every count after it is in bytes of that text, before the scrub: no count tells the
// length of a secret, or how much the scrub took out. Nothing here reads what the end of the stream is.
// - A stream that ended on its own (ended, and shorter than the read limit) drops nothing at its end: a start of a
//   hidden text there is what the program wrote, and is shown as anywhere else. Of at most visible bytes, it is
//   scrubbed and shown (cut at visible bytes if the scrub made it longer); of more, its firstBytes are shown.
// - A stream that did not (the time limit, a broken body, a reader that stopped, the read limit, stopped) can end in a
//   piece of a hidden text, or of a path. Its last cutRoom bytes are left out, by count. When the rest is visible and
//   LONGEST_PATH bytes or more, its firstBytes are shown, and the place of that cut is past them. Else it is cut
//   after its last newline before those bytes, so that it ends with a whole line: a hidden text or a path of one line
//   is then not shown in part even if the count were wrong.
// A stream that shows its firstBytes says LEFT_OUT with the visible limit, whether or not the read limit stopped it:
// with one hidden text in it, the answer is the same for every length of that text up to 27 KiB. A shorter one that
// lost its end says END_LEFT_OUT, unless it was empty and no reader stopped it. cleaned is the size of a whole stream.
function fitBrokered(text, {
  values, scrub, visible, ended,
}, stopped) {
  const bytes = Buffer.from(hideSecrets(text, values));
  const atLimit = `cut at ${sizeText(visible)}: ${LEFT_OUT}`;
  if (ended && Buffer.byteLength(text) < readLimit(visible, values)) {
    if (bytes.length > visible) return { text: firstBytes(bytes, scrub, visible), cut: true, reason: atLimit };
    const whole = scrub(bytes.toString());
    const capped = capBytes(whole, visible);
    return {
      text: capped.text, cut: capped.cut, reason: atLimit, cleaned: Buffer.byteLength(whole),
    };
  }
  const keep = Math.max(0, bytes.length - cutRoom(values));
  if (keep >= visible + LONGEST_PATH) return { text: firstBytes(bytes, scrub, visible), cut: true, reason: atLimit };
  const line = keep === 0 ? 0 : bytes.lastIndexOf(0x0a, keep - 1) + 1;
  return {
    text: capBytes(scrub(bytes.subarray(0, line).toString()), visible).text,
    cut: stopped || bytes.length > 0,
    reason: `cut: ${END_LEFT_OUT}`,
  };
}

// The end of a text longer than bytes, in at most bytes bytes, without its trailing white space: from the start of a
// line when a newline follows the cut, else from the first whole character after it. The cut is counted from the end
// of the whole text, its trailing white space included, and a newline in that white space starts no line.
function lastLines(text, bytes) {
  const buffer = Buffer.from(text);
  const cut = buffer.length - bytes;
  const end = Buffer.byteLength(text.trimEnd());
  const newline = buffer.subarray(0, end).indexOf(0x0a, cut - 1);
  let from = newline === -1 ? cut : newline + 1;
  while ((buffer[from] & 0xc0) === 0x80) from += 1;
  return buffer.subarray(from, end).toString();
}

// The end part of a stream of ssh, kubernetes or local from tail, the last bytes that run kept (END_RING of them, or
// fewer), or '' when none can be shown. These kinds hide no secret: the tail is scrubbed whole, after step 0 when the
// stream did not end on its own, so that a path that the end of the stream cut is dropped whole. The start of tail can
// cut a path, whose rest the scrub would not know; once scrubbed, such a piece lies in the first OUTPUT_MARGIN bytes. The
// end part is the last END_BYTES of the scrubbed tail (lastLines), and only when the scrubbed tail, its trailing white
// space included, is longer than OUTPUT_MARGIN and END_BYTES, so that it never reaches into that margin; the agent
// chooses how much white space its output ends with, so a check after trimming it would let it move the threshold.
function fitEnd(tail, { scrub, ended, cutFolder }) {
  const text = tail.toString();
  const whole = scrub(ended ? text : cutFolder(text));
  if (Buffer.byteLength(whole) <= OUTPUT_MARGIN + END_BYTES) return '';
  return lastLines(whole, END_BYTES);
}

// The fit of a call: its hidden texts, the scrub of its session, its visible limit, ended (false when the streams did
// not end on their own: a time limit, a stop, a broken body, a program stopped at the read limit, a stream run had to
// close), counted (true for ssh, kubernetes and local, whose bytes run counted) and cutFolder, dropCutFolder with the
// session.
function fitOf(values, session, env, {
  visible, ended, counted,
}) {
  return {
    values,
    scrub: (text) => scrubOutput(text, session, env),
    visible,
    ended,
    counted,
    cutFolder: (text) => dropCutFolder(text, session, env),
  };
}

// One fitted stream for shownStream. A stream of a brokered call is fitted by fitBrokered: a cut one has the words of
// its line (reason) and no end part; a whole one has its size once cleaned as total, for an answer that must show less
// of it. A stream of ssh, kubernetes or local was read to its end, which may be where its program ended, the time
// limit, or a stop: total is its size, rough (the bytes that run counted, which nothing hid or scrubbed), and end()
// makes the end part from the last bytes that run kept (fitEnd); shownStream asks for it once.
function fittedStream(result, name, fit, stopped) {
  if (!fit.counted) {
    const stream = fitBrokered(result[name], fit, stopped);
    return stream.cut ? stream : {
      text: stream.text, cut: false, total: stream.cleaned, rough: false, end: () => '',
    };
  }
  return {
    ...fitCounted(result[name], fit),
    total: result[`${name}Bytes`],
    rough: true,
    end: () => fitEnd(result[`${name}Tail`], fit),
  };
}

// Both streams of a result, fitted. A brokered result that says it was cut (truncated) while neither stream reached
// the read limit had its reader stop before that (the texts of an MCP answer cut there, a Redis reply over the limit,
// which shows nothing): stdout is the stream it stopped, and has a cut line even when it is empty. A brokered result
// with ownStderr true says that its stderr is a text the kind wrote itself, whole (why the call stopped): no secret can
// be cut in it, so it keeps its end as a stream that ended on its own does.
function fitStreams(result, fit) {
  const limit = readLimit(fit.visible, fit.values);
  const reached = (text) => Buffer.byteLength(text) >= limit;
  const stopped = !fit.counted && result.truncated === true && !reached(result.stdout) && !reached(result.stderr);
  return {
    stdout: fittedStream(result, 'stdout', fit, stopped),
    stderr: fittedStream(result, 'stderr', result.ownStderr === true ? { ...fit, ended: true } : fit, false),
  };
}

// A size for a cut line: sizeText, or "under 1 KiB" for a rough size below 1 KiB.
function sizeOf(bytes, rough) {
  return rough && bytes < 1024 ? 'under 1 KiB' : sizeText(bytes);
}

// Two sizes as "X of Y" in the short form, or in bytes when the two would look the same in it, but never for rough
// sizes: those count what the program wrote, and a path in it, in bytes.
function showingOf(shown, total, rough) {
  const [a, b] = [sizeOf(shown, rough), sizeOf(total, rough)];
  return a === b && !rough ? `${shown} B of ${total} B` : `${a} of ${b}`;
}

// One fitted stream within budget bytes: { text, line }, line null when the stream is shown whole. A cut stream of a
// brokered call shows its first bytes, and its line has its words (reason), and how much it shows when the budget cut
// it further. Any other stream shows its first bytes, then [... N cut here ...] and its end part when it has one, all
// within budget, and its line says how much of how much it shows.
function shownStream(name, stream, budget) {
  const first = capBytes(stream.text, budget);
  if (!stream.cut && !first.cut) return { text: stream.text, line: null };
  if (stream.reason !== undefined) {
    const shown = first.cut ? `; showing ${sizeText(Buffer.byteLength(first.text))}` : '';
    return { text: first.text, line: `[${name} ${stream.reason}${shown}]` };
  }
  const end = stream.end();
  if (end === '') return { text: first.text, line: `[${name} cut: showing ${showingOf(Buffer.byteLength(first.text), stream.total, stream.rough)}]` };
  const shown = capBytes(stream.text, Math.max(0, budget - Buffer.byteLength(end) - MARKER_ROOM)).text;
  const showing = Buffer.byteLength(shown) + Buffer.byteLength(end);
  return {
    text: `${shown.replace(/\n?$/, '\n')}[... ${sizeOf(Math.max(0, stream.total - showing), stream.rough)} cut here ...]\n${end}`,
    line: `[${name} cut: showing ${showingOf(showing, stream.total, stream.rough)}]`,
  };
}

// The answer text of a call that ran, with both fitted streams within budget bytes each: the first line, a cut line
// for each cut stream, then the kind's hint when one was cut, then the streams.
function streamsText(result, streams, budget, kindObject, timeoutSeconds) {
  const out = shownStream('stdout', streams.stdout, budget);
  const err = shownStream('stderr', streams.stderr, budget);
  const lines = [out.line, err.line].filter((line) => line !== null);
  if (lines.length > 0 && kindObject.cutHint !== undefined) lines.push(`narrow it: ${kindObject.cutHint}`);
  return formatResult({ ...result, stdout: out.text, stderr: err.text }, timeoutSeconds, lines);
}

const OUTPUT_FAILED = 'the output could not be shown';

function outputFailed(result, timeoutSeconds) {
  return { text: `${formatResult({ ...result, stdout: '', stderr: '' }, timeoutSeconds)}\n${OUTPUT_FAILED}`, isError: true };
}

// The first line (could not start, timed out or the exit code), the lines of notes, then each stream that is not empty.
function formatResult(result, timeoutSeconds, notes = []) {
  const parts = [];
  if (result.spawnError) parts.push(`could not start: ${result.spawnError}`);
  else if (result.timedOut) parts.push(`timed out after ${timeoutSeconds}s`);
  else parts.push(`exit code: ${result.exitCode}`);
  parts.push(...notes);
  if (result.stdout !== '') parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
  if (result.stderr !== '') parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
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

// The fields that the kind of a target adds to it in list_targets, from its listFields: none for a kind without it.
function listFieldsOf(target) {
  const listFields = kindByKey(target.kind)?.listFields;
  return listFields === undefined ? {} : listFields(target);
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
    ...listFieldsOf(t),
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
  const limits = { timeoutMs: timeoutSeconds * 1000, maxBytes: readLimit(visible, []), tailBytes: END_RING };
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
  // The hiding or the scrub can throw: the call has run and is audited by then, so the answer says what ran, and no
  // output at all.
  let text;
  try {
    const ended = !result.timedOut && !result.cutOff && signal?.aborted !== true;
    const streams = fitStreams(result, fitOf([], session, env, { visible, ended, counted: true }));
    text = streamsText(result, streams, visible, kindObject, timeoutSeconds);
  } catch {
    return outputFailed(result, timeoutSeconds);
  }
  return { text, isError: result.timedOut || result.spawnError !== null || result.exitCode !== 0 };
}

const GRACE_MS = 1000;
const LATE = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};
const STOPPED = Symbol('stopped');

// perform of the kind, with the call's time limit, the output limit, a signal that fires at the limit or when the
// session stops, and the opened entry of the target, with what its open kept. A perform that is still busy GRACE_MS
// after the limit counts as timed out; a stop ends the wait at once.
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
    env, secrets: open.secrets, timeoutMs, maxBytes, signal: controller.signal, input, opened: open.opened,
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

// The core's own state of the tunnel of each opened entry, by the entry's tunnel object: { host, down, closed, hold,
// check, close }; closed is set by close, and keeps down true whatever a later check says. It is never on the entry,
// so no kind, no record and no file can reach it. start and doctor keep it here when a tunnel opens (keepTunnel).
const TUNNELS = new WeakMap();

export function keepTunnel(tunnel, control) {
  TUNNELS.set(tunnel, control);
}

// The state of the tunnel of an opened entry, or undefined when it has none (or when there is no entry, as in a
// call built by a test).
export function tunnelControl(opened) {
  const tunnel = opened?.tunnel;
  return tunnel === undefined ? undefined : TUNNELS.get(tunnel);
}

// Holds the gate of the listener of an opened entry while a call, a probe or a doctor check runs: gives the release
// function, which does nothing for an entry without a tunnel, for a tunnel without a listener and while it is down.
export function holdTunnel(opened) {
  const control = tunnelControl(opened);
  return control === undefined ? () => {} : control.hold();
}

// The refusal of a call on a target while the check of its shared connection fails.
const TUNNEL_DOWN = 'the connection to this target is down';

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
  if (tunnelControl(open.opened)?.down === true) return refuse(callRefusal(TUNNEL_DOWN, word, name).text, 'target down', TUNNEL_DOWN);

  // A program can print its own environment: every secret value of the target, and every form of one that the kind
  // gives, is hidden before the cut, and the end of a stream that did not end on its own, where one can be cut, is
  // left out. The read limit is the same for
  // every call on a target, and comes from the target as this start opened it, never from session.json.
  const visible = visibleLimit(open.target);
  const started = Date.now();
  let values;
  let result;
  // The listener of a tunnel accepts connections only while the call runs.
  const release = holdTunnel(open.opened);
  try {
    values = hiddenTexts(kindObject, open);
    result = await performWithin(kindObject, open, decision, {
      env, timeoutMs: request.timeoutSeconds * 1000, maxBytes: readLimit(visible, values), signal, input,
    });
  } catch {
    return failed();
  } finally {
    release();
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
  // The call ran: an answer whose JSON line would pass answerLimit of the visible limit (escaping can make a byte 6)
  // keeps less of each stream, half as much each time, so that the agent is always told what ran. A throw of the hiding
  // or the scrub answers with what ran and no output.
  const ran = { exitCode: result.exitCode, timedOut, spawnError: null };
  try {
    const ended = !timedOut && result.cutOff !== true && result.truncated !== true;
    const streams = fitStreams(result, fitOf(values, session, env, { visible, ended, counted: false }));
    const answerWithin = (limit) => ({
      text: streamsText(ran, streams, limit, kindObject, request.timeoutSeconds),
      isError: timedOut || result.exitCode !== 0,
    });
    const most = answerLimit(visible);
    let limit = visible;
    let answer = answerWithin(limit);
    while (answerBytes(answer) > most) {
      limit = Math.floor(limit / 2);
      answer = answerWithin(limit);
    }
    return answer;
  } catch {
    return outputFailed(ran, request.timeoutSeconds);
  }
}

// A tool of the live session's list: mcp_call with its target and its tool, the agent's arguments whole as the
// arguments (nothing taken out or added, timeout_seconds included), and the target's timeoutSeconds as the time limit.
// The audit entry is the one of mcp_call. A name that is not in that list is an unknown tool, as any other; a name
// without __ is never one, so it is answered without reading the session.
async function callDirect(name, args, env, {
  stderr, review, origin, signal,
}) {
  const unknown = { text: `unknown tool: ${name}`, isError: true };
  if (typeof name !== 'string' || !name.includes('__')) return unknown;
  const { session, dir, tools } = sessionTools(env);
  const item = tools.find(({ definition }) => definition.name === name);
  if (item === undefined) return unknown;
  if (!isPlainObject(args)) return { text: 'invalid arguments: expected an object', isError: true };
  const routed = {
    target: item.target, tool: item.tool, arguments: args, timeout_seconds: item.timeoutSeconds,
  };
  return execTool(ROUTED_TOOL, routed, session, dir, env, stderr, review, origin, signal);
}

export async function callTool(name, args, env = process.env, {
  stderr = process.stderr, review = askReview, origin, signal,
} = {}) {
  try {
    if (name !== LIST_TARGETS.name && kindByTool(name) === undefined) {
      return await callDirect(name, args, env, {
        stderr, review, origin, signal,
      });
    }
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
