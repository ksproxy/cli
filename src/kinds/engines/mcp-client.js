import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { hideSecrets } from './http.js';

// The MCP client engine: ksproxy start talks to one MCP server through it. The protocol layer (makeClient,
// listEveryTool, callOne: paging, answers, limits) knows nothing of the transport. Over stdio, createSession (ids, one
// call at a time, answers to the server's requests, dropping notifications) runs on startStdio, which runs a local
// server as a program; over HTTP, createHttpSession sends each request as one POST and reads its answer from that POST
// alone. Everything the server sends is hostile: no answer may throw, grow memory without bound, or reject a promise
// nobody waits for. hidden, the texts the caller hides (the secrets of the target and their forms), are hidden in every
// server text before the engine cleans or clips it, so a clip never cuts one in two.

const pkg = JSON.parse(fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));

export const MODERN_VERSION = '2026-07-28';
export const LEGACY_VERSION = '2025-11-25';
export const MAX_TOOLS = 2000;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// All the pages of tools/list together, as received: as much as one message may hold.
export const MAX_LIST_BYTES = MAX_MESSAGE_BYTES;
const START_LIMIT_MS = 120000;
const CONNECT_LIMIT_MS = 30000;
const NOTE_LIMIT_MS = 2000;
const MAX_ANSWERS = 8;
const HIDDEN = '[hidden]';
const HIDDEN_MIN = 8;
const ACCEPT = 'application/json, text/event-stream';
const STDERR_BYTES = 64 * 1024;
// While more than this waits to be written to a local server, an answer to its requests is dropped.
const ANSWER_BACKLOG = 1024 * 1024;
const CUT_PIECE = 4;
const STOP_STEP_MS = 2000;
const GRACE_MS = 500;
const INFO_CHARS = 64;
const ERROR_CHARS = 300;
const CLIENT_INFO = Object.freeze({ name: 'ksproxy', version: pkg.version });
const MODERN_META = Object.freeze({
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientInfo': CLIENT_INFO,
  'io.modelcontextprotocol/clientCapabilities': {},
});
const NOT_SUPPORTED = 'ksproxy does not support requests from an MCP server';
const NOT_JSON = 'the MCP server sent a line that is not JSON';
const NO_RESULT = 'the MCP server sent an answer without a result';
const CANCEL_REASON = 'ksproxy stopped waiting for the answer';
const STOPPED = 'the start of the MCP server was stopped';
const CONNECT_STOPPED = 'the connection to the MCP server was stopped';
const BAD_SESSION = 'the MCP server sent a session id that is not visible ASCII';
const END = Object.freeze({ code: null, signal: null });
const VERSION_FORM = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_FORM = /^[\x21-\x7e]+$/;
const RETRY_SECONDS = /^\d{1,9}$/;
const HEADER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
// Printable ASCII, at most 1000 characters, no space at either end: what a header carries as it is.
const HEADER_TEXT = /^(?:[\x21-\x7e](?:[\x20-\x7e]{0,998}[\x21-\x7e])?)?$/;
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])?/g;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' || typeof value === 'number';
const ignore = () => {};

// One line of the server's text without terminal escapes, control characters or direction marks; a tab is a space.
function cleanLine(text) {
  return text.replace(ESCAPES, '').replace(/\t/g, ' ').replace(CONTROLS, '');
}

// The text without the piece at one end that is a cut hidden text: at the start, a piece of CUT_PIECE characters or more
// that ends a hidden text; at the end, one that starts it. The longest such piece goes.
export function dropCut(text, hidden, atStart) {
  const longest = hidden.reduce((most, value) => Math.max(most, value.length), 0);
  for (let size = Math.min(text.length, longest - 1); size >= CUT_PIECE; size -= 1) {
    const piece = atStart ? text.slice(0, size) : text.slice(text.length - size);
    if (hidden.some((value) => value.length > size && (atStart ? value.endsWith(piece) : value.startsWith(piece)))) {
      return atStart ? text.slice(size) : text.slice(0, text.length - size);
    }
  }
  return text;
}

// A text of the server as ksproxy may show it, at most max characters. Every hidden text is hidden first, then the text
// is cleaned, and hidden again (cleaning can join the pieces of one); a piece at the end that starts a hidden text, left
// by a cut before ksproxy got the text, is dropped; only then is it clipped, and a piece at the clip edge that starts a
// hidden text is dropped too. A clip therefore never shows a piece of a hidden text, wherever the server put it.
export function shownText(text, { hidden, max, clean }) {
  const whole = dropCut(hideSecrets(clean(hideSecrets(String(text), hidden)), hidden), hidden, false);
  return whole.length <= max ? whole : `${dropCut(whole.slice(0, max - 1), hidden, false)}\u2026`;
}

const infoText = (value, hidden) => (typeof value === 'string' ? shownText(value, { hidden, max: INFO_CHARS, clean: cleanLine }) : '');

// How the server ended: a signal, an exit code, or neither when ksproxy closed the connection (HTTP).
// How the end of a server reads: a signal, an exit code, or, over HTTP, the connection that close ended.
export function endText({ code, signal }) {
  if (signal !== null) return `the MCP server stopped (signal ${signal})`;
  if (code !== null) return `the MCP server stopped (exit ${code})`;
  return 'the connection to the MCP server was closed';
}

// An HTTP status as a sentence: a redirect is never followed; Retry-After is given in seconds when there is one.
function httpText(what, { status, retryAfter }) {
  if (status < 400) return `the MCP server answered ${what} with a redirect (HTTP ${status}), which is not followed`;
  const wait = retryAfter === null ? '' : `, retry after ${retryAfter} seconds`;
  return `the MCP server answered ${what} with HTTP ${status}${wait}`;
}

// Why a request other than a call got no usable answer, as a plain sentence. session: maxMessageBytes and hidden.
function failure(what, outcome, { maxMessageBytes, hidden }) {
  if (outcome.ended !== undefined) return endText(outcome.ended);
  if (outcome.timedOut) return `the wait for ${what} was stopped`;
  if (outcome.tooLarge) return `the answer of the MCP server to ${what} is larger than ${maxMessageBytes} bytes`;
  if (outcome.notJson) return `${NOT_JSON} in answer to ${what}`;
  if (outcome.httpError !== undefined) return httpText(what, outcome.httpError);
  if (outcome.unreachable) return `the MCP server could not be reached for ${what}`;
  if (outcome.cutOff) return `the answer of the MCP server to ${what} ended early`;
  return `the MCP server refused ${what}: ${shownText(outcome.rpcError.message, { hidden, max: ERROR_CHARS, clean: cleanLine })}`;
}

// The outcome of an answer: an error object wins, then a result object, with the bytes of the message as it was
// received; anything else is an error of its own.
function answerOf({ error, result }, bytes) {
  if (isObject(error)) {
    const code = Number.isInteger(error.code) ? error.code : null;
    return { rpcError: { code, message: typeof error.message === 'string' ? error.message : '' } };
  }
  if (isObject(result)) return { result, bytes };
  return { rpcError: { code: -32603, message: NO_RESULT } };
}

// The answer to a request from the server: ping gets an empty result, anything else (sampling, elicitation, roots) is
// refused, and the call in flight goes on.
function serverAnswer({ id, method }) {
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id, error: { code: -32601, message: NOT_SUPPORTED } };
}

// A callback of onEnd that throws must not reach the process, which would stop every target.
function tell(callback, info) {
  try {
    callback(info);
  } catch {
    // the caller's own fault; the end is already recorded
  }
}

// The end of a transport: told once to every onEnd callback, and in a microtask to one that comes later.
function watchEnd() {
  const watchers = [];
  let info = null;
  return {
    end(value) {
      info = value;
      for (const callback of watchers.splice(0)) tell(callback, value);
    },
    onEnd(callback) {
      if (info === null) watchers.push(callback);
      else queueMicrotask(() => tell(callback, info));
    },
  };
}

// The protocol over one transport. send(line) writes one message; answer(line) writes an answer to a request of the
// server, which the transport may drop. The transport hands back each message it read with receive, with its size, a
// line it skipped (too large) or could not read (not JSON) with fault, and the end of the server with end, once. Queued
// requests run one at a time, so the request in flight, current, owns a line the transport could not hand back; a ping
// does not queue. The second argument holds maxMessageBytes, maxListBytes and the hidden texts.
function createSession({ send, answer }, { maxMessageBytes, maxListBytes, hidden }) {
  const pending = new Map();
  const waiting = [];
  const ends = watchEnd();
  let current = null;
  let ended = null;
  let nextId = 1;

  const pump = () => {
    if (ended !== null || current !== null || waiting.length === 0) return;
    current = waiting.shift();
    pending.set(current.id, current);
    send(current.line);
  };
  const finish = (entry, outcome) => {
    if (!pending.delete(entry.id)) waiting.splice(waiting.indexOf(entry), 1);
    if (entry === current) current = null;
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.resolve(outcome);
    pump();
  };
  // A call that was sent and is no longer waited for is cancelled, so the server can stop its work.
  const abandon = (entry, outcome) => {
    if (entry.call && pending.has(entry.id)) {
      send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: entry.id, reason: CANCEL_REASON } }));
    }
    finish(entry, outcome);
  };

  const request = (method, params, {
    signal, timeoutMs, call = false, queued = true,
  } = {}) => new Promise((resolve) => {
    if (ended !== null) {
      resolve({ ended });
      return;
    }
    if (signal?.aborted) {
      resolve({ timedOut: true });
      return;
    }
    const id = nextId;
    nextId += 1;
    const entry = {
      id, line: JSON.stringify({ jsonrpc: '2.0', id, method, params }), call, resolve, signal,
    };
    if (timeoutMs !== undefined) entry.timer = setTimeout(() => abandon(entry, { timedOut: true }), timeoutMs);
    if (signal !== undefined) {
      entry.onAbort = () => abandon(entry, { timedOut: true });
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    if (queued) {
      waiting.push(entry);
      pump();
    } else {
      pending.set(id, entry);
      send(entry.line);
    }
  });

  return {
    maxMessageBytes,
    maxListBytes,
    hidden,
    request,
    notify: (method) => send(JSON.stringify({ jsonrpc: '2.0', method })),
    receive(message, bytes) {
      if (!isObject(message)) return;
      if (typeof message.method === 'string') {
        if (isId(message.id)) answer(JSON.stringify(serverAnswer(message)));
        return;
      }
      const entry = pending.get(message.id);
      if (entry !== undefined) finish(entry, answerOf(message, bytes));
    },
    fault(outcome) {
      if (current !== null) abandon(current, outcome);
    },
    end(info) {
      ended = info;
      for (const entry of [...pending.values(), ...waiting]) finish(entry, { ended: info });
      ends.end(info);
    },
    onEnd: ends.onEnd,
    learn: ignore,
  };
}

// The protocol version a result of initialize answers, a text of the form YYYY-MM-DD; anything else throws.
function versionOf(result) {
  const version = result.protocolVersion;
  if (typeof version !== 'string' || !VERSION_FORM.test(version)) throw new Error('the MCP server answered initialize without a protocol version');
  return version;
}

// initialize first, asking 2025-11-25; only a JSON-RPC error to it leads to server/discover in the 2026-07-28 form.
// Older servers may stop on a method they do not know before initialize, so nothing else is tried first.
async function negotiate(session, signal) {
  const params = { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO };
  const init = await session.request('initialize', params, { signal });
  if (init.result !== undefined) {
    const era = versionOf(init.result);
    session.notify('notifications/initialized');
    return { era, info: init.result.serverInfo };
  }
  if (init.rpcError === undefined) throw new Error(failure('initialize', init, session));
  const found = await session.request('server/discover', { _meta: MODERN_META }, { signal });
  if (found.result === undefined) throw new Error(failure('server/discover', found, session));
  return { era: MODERN_VERSION, info: found.result.serverInfo };
}

// Every page of tools/list, at most MAX_TOOLS tools, and at most maxListBytes of pages in all, each counted as it was
// received. A page without tools, or without a text cursor, is the last.
async function listEveryTool({ session, meta }, signal) {
  const tools = [];
  let bytes = 0;
  let cursor;
  for (;;) {
    const params = cursor === undefined ? { ...meta } : { cursor, ...meta };
    const outcome = await session.request('tools/list', params, { signal });
    if (outcome.result === undefined) throw new Error(failure('tools/list', outcome, session));
    bytes += outcome.bytes;
    if (bytes > session.maxListBytes) {
      throw new Error(`the list of tools of the MCP server takes more than ${session.maxListBytes} bytes over all its pages`);
    }
    const page = outcome.result.tools;
    if (!Array.isArray(page)) throw new Error('the MCP server answered tools/list without a list of tools');
    for (const tool of page) {
      if (tools.length === MAX_TOOLS) return { tools, capped: true };
      tools.push(tool);
    }
    cursor = typeof outcome.result.nextCursor === 'string' ? outcome.result.nextCursor : undefined;
    if (cursor === undefined || page.length === 0) return { tools, capped: false };
  }
}

// The text of a content part that carries text: a text part, or an embedded resource with text; else null.
function textOf(part) {
  if (!isObject(part)) return null;
  if (part.type === 'text') return typeof part.text === 'string' ? part.text : null;
  if (part.type === 'resource' && isObject(part.resource) && typeof part.resource.text === 'string') return part.resource.text;
  return null;
}

const withText = (part, text) => (part.type === 'text' ? { ...part, text } : { ...part, resource: { ...part.resource, text } });

// The first bytes of text in UTF-8, never more, cut before a character that does not fit whole.
function cutUtf8(text, bytes) {
  const buffer = Buffer.from(text, 'utf8');
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

// The texts of a result share maxBytes, in order: the text that passes it is cut and every later part is left out, so
// the cut is always the end of the answer, where the core drops a piece of a secret it cut; the result is marked
// truncated. Parts without text before the cut, and structuredContent, stay as they are.
function cutText(result, maxBytes) {
  if (!Array.isArray(result.content)) return { result, truncated: false };
  let left = maxBytes;
  const content = [];
  for (const part of result.content) {
    const text = textOf(part);
    const bytes = text === null ? 0 : Buffer.byteLength(text);
    if (bytes > left) {
      if (left > 0) content.push(withText(part, cutUtf8(text, left)));
      return { result: { ...result, content }, truncated: true };
    }
    content.push(part);
    left -= bytes;
  }
  return { result: { ...result, content }, truncated: false };
}

async function callOne({ session, meta, modern }, name, args, { timeoutMs, maxBytes = Infinity, signal } = {}) {
  const outcome = await session.request('tools/call', { name, arguments: args, ...meta }, { timeoutMs, signal, call: true });
  if (outcome.notJson) return { rpcError: { code: -32700, message: NOT_JSON } };
  if (outcome.result === undefined) return outcome;
  if (modern && outcome.result.resultType === 'input_required') return { inputRequired: true };
  return cutText(outcome.result, maxBytes);
}

// The client both transports return; a 2026-07-28 request carries the protocol version, the client and its
// capabilities in _meta. The session learns each full tool list (the HTTP transport reads x-mcp-header marks in it).
function makeClient(session, { era, info }) {
  const modern = era === MODERN_VERSION;
  const context = { session, meta: modern ? { _meta: MODERN_META } : {}, modern };
  return {
    era,
    serverInfo: { name: infoText(info?.name, session.hidden), version: infoText(info?.version, session.hidden) },
    async listTools({ signal } = {}) {
      const listed = await listEveryTool(context, signal);
      session.learn(listed.tools);
      return listed;
    },
    callTool: (name, args, options) => callOne(context, name, args, options),
    // Any answer shows the server is there; over HTTP a 429 too, as it is only busy.
    async ping({ signal } = {}) {
      const outcome = await session.request('ping', { ...context.meta }, { signal, queued: false });
      return outcome.result !== undefined || outcome.rpcError !== undefined || outcome.httpError?.status === 429;
    },
    onEnd: session.onEnd,
  };
}

// Splits a byte stream into lines. A line never grows past limit bytes: at the limit, onSkip is told and the rest of
// the line is skipped up to its newline without being kept.
function lineReader(limit, onLine, onSkip) {
  let parts = [];
  let size = 0;
  let skipping = false;
  return (chunk) => {
    let from = 0;
    for (;;) {
      const at = chunk.indexOf(0x0a, from);
      const to = at === -1 ? chunk.length : at;
      if (!skipping) {
        size += to - from;
        if (size > limit) {
          skipping = true;
          parts = [];
          onSkip();
        } else {
          parts.push(chunk.subarray(from, to));
        }
      }
      if (at === -1) return;
      if (!skipping) onLine(Buffer.concat(parts, size));
      parts = [];
      size = 0;
      skipping = false;
      from = at + 1;
    }
  };
}

// The stdio transport: the program without a shell, in its own process group, with exactly env. JSON lines on stdin and
// stdout; stderr kept in a ring of STDERR_BYTES. The end comes once, at the child's close event.
function startStdio({ argv, env, cwd }, session) {
  const child = spawn(argv[0], argv.slice(1), {
    env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  let stderr = Buffer.alloc(0);
  let spawnError = null;
  let exit = null;
  let stopping = false;
  const timers = [];
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const group = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is already gone, or the program never started
    }
  };
  const killGroup = () => group('SIGKILL');
  const onLine = (line) => {
    const text = line.toString('utf8');
    if (text.trim() === '') return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      session.fault({ notJson: true });
      return;
    }
    session.receive(message, line.length);
  };

  child.stdout.on('data', lineReader(session.maxMessageBytes, onLine, () => session.fault({ tooLarge: true })));
  child.stderr.on('data', (chunk) => {
    const joined = Buffer.concat([stderr, chunk]);
    stderr = joined.length > STDERR_BYTES ? Buffer.from(joined.subarray(joined.length - STDERR_BYTES)) : joined;
  });
  // A broken pipe (EPIPE after the server exits or closes stdin) stops the server: it can no longer be reached.
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', killGroup);
  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.on('exit', (code, signal) => {
    exit = { code, signal };
    timers.push(setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    }, GRACE_MS));
  });
  child.on('close', () => {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    killGroup();
    const info = exit ?? { code: null, signal: null };
    session.end(info);
    resolveDone(info);
  });

  const send = (line) => {
    if (child.stdin.writable) child.stdin.write(`${line}\n`);
  };
  return {
    send,
    // A server that asks and never reads its stdin cannot make what waits for it grow: past ANSWER_BACKLOG bytes, an
    // answer is dropped. A call, a notification or a cancel ksproxy must send is still written.
    answer(line) {
      if (child.stdin.writableLength <= ANSWER_BACKLOG) send(line);
    },
    // Close stdin; SIGTERM to the group after STOP_STEP_MS, SIGKILL after as long again. Settles when the program is gone.
    close() {
      if (!stopping) {
        stopping = true;
        child.stdin.end();
        timers.push(setTimeout(() => {
          group('SIGTERM');
          timers.push(setTimeout(killGroup, STOP_STEP_MS));
        }, STOP_STEP_MS));
      }
      return done;
    },
    kill() {
      killGroup();
      return done;
    },
    stderrTail(lines) {
      const all = stderr.toString('utf8').split('\n').map((line) => cleanLine(hideSecrets(line, session.hidden))).filter((line) => line.trim() !== '');
      return all.slice(Math.max(0, all.length - lines));
    },
    spawnError: () => spawnError,
  };
}

// Starts a local MCP server and finds its era. limitMs and signal end the wait: the program is killed and the promise
// rejects with a plain sentence, an error that carries stderrTail(lines) of the program when it was started. env is the
// whole environment the program gets; hidden, the texts hidden in every server text the engine shows.
export async function connectStdio({
  argv, env, cwd, signal, limitMs = START_LIMIT_MS, maxMessageBytes = MAX_MESSAGE_BYTES, maxListBytes = MAX_LIST_BYTES, hidden = [],
}) {
  if (signal?.aborted) throw new Error(STOPPED);
  let transport;
  const session = createSession(
    { send: (line) => transport.send(line), answer: (line) => transport.answer(line) },
    { maxMessageBytes, maxListBytes, hidden },
  );
  try {
    transport = startStdio({ argv, env, cwd }, session);
  } catch (err) {
    throw new Error(`could not start the MCP server: ${err.message}`);
  }
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error(`the MCP server was not ready within ${limitMs / 1000} seconds`)), limitMs);
  const onAbort = () => stop.abort(new Error(STOPPED));
  signal?.addEventListener('abort', onAbort, { once: true });
  let found;
  try {
    found = await negotiate(session, stop.signal);
  } catch (err) {
    await transport.kill();
    let failed = stop.signal.aborted ? stop.signal.reason : err;
    if (transport.spawnError() !== null) failed = new Error(`could not start the MCP server: ${transport.spawnError()}`);
    failed.stderrTail = transport.stderrTail;
    throw failed;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return { ...makeClient(session, found), stderrTail: transport.stderrTail, close: transport.close };
}

// The outcome of a request whose answer was not read to its end: the server may still be working on it.
const unanswered = (outcome) => outcome.tooLarge === true || outcome.notJson === true || outcome.cutOff === true;

// The seconds Retry-After asks for: digits as they are, an HTTP date as the seconds until then (0 once past), and null
// without one or for anything else. No text of the server is kept.
function retryAfterOf(value) {
  if (value === null) return null;
  if (RETRY_SECONDS.test(value)) return Number(value);
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, Math.ceil((when - Date.now()) / 1000));
}

// A value as a header carries it: a text as it is, a number or a boolean as JSON writes it; null when it cannot be
// sent as it is.
function headerText(value) {
  const text = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
  return typeof text === 'string' && HEADER_TEXT.test(text) ? text : null;
}

// The arguments a tool's schema marks with x-mcp-header, as { property, header }; header is null when it is not a
// header name. A tool without an object schema or an object of properties marks none.
function headerMarks(tool) {
  const schema = isObject(tool) && isObject(tool.inputSchema) ? tool.inputSchema : {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  return Object.entries(properties)
    .filter(([, property]) => isObject(property) && property['x-mcp-header'] !== undefined)
    .map(([property, { 'x-mcp-header': header }]) => ({ property, header: typeof header === 'string' && HEADER_NAME.test(header) ? header : null }));
}

// Why a call cannot be sent: the header name the server gave is not one, or the value cannot go in a header as it is.
function headerRefusal(what, badName) {
  const why = badName
    ? 'but the header name it gives is not 1 to 64 letters, digits, _ or -'
    : 'and its value is not printable ASCII of at most 1000 characters without a space at either end';
  return `ksproxy cannot send this call: the MCP server wants ${what} in a header, ${why}`;
}

// Mcp-Name and an Mcp-Param header for each marked argument given, built from the params that are sent; the text of a
// refusal when one value cannot be sent as it is. The name of an argument is the server's text: hidden, then clipped.
function callHeaders({ name, arguments: args }, marks, hidden) {
  const values = [['mcp-name', name, 'the tool name']];
  for (const { property, header } of marks.get(name) ?? []) {
    if (isObject(args) && Object.hasOwn(args, property)) {
      values.push([header === null ? null : `mcp-param-${header}`, args[property], `the argument ${infoText(property, hidden)}`]);
    }
  }
  const out = {};
  for (const [key, value, what] of values) {
    const text = headerText(value);
    if (key === null || text === null) return headerRefusal(what, key === null);
    out[key] = text;
  }
  return out;
}

// The HTTP transport and its protocol state. Each request is one POST whose answer, a JSON body or an SSE stream, is
// read for that request's id only, so requests run at the same time. A 2025-11-25 session id is kept, sent and
// renewed; close aborts everything and ends the session with DELETE. Nothing here rejects.
function createHttpSession({
  url, headers, fetchImpl, limitMs, maxMessageBytes, maxListBytes, hidden,
}) {
  const closing = new AbortController();
  const live = new Set();
  const marks = new Map();
  const shown = new Set();
  const ends = watchEnd();
  let era = MODERN_VERSION;
  let sessionId = null;
  let renewing = null;
  let ended = null;
  let closed = null;
  let answering = 0;
  let nextId = 1;

  // Each value the caller's headers hold, and each of its words of at least HIDDEN_MIN characters (the token after
  // Bearer), is hidden in the error texts of the server.
  const remember = (value) => {
    for (const part of [value, ...value.split(' ')]) {
      if (part.length >= HIDDEN_MIN) shown.add(part);
    }
  };
  const hide = (text) => [...shown].sort((a, b) => b.length - a.length).reduce((out, value) => out.split(value).join(HIDDEN), text);

  // The caller's headers, asked for each request, then ksproxy's own, which win.
  const headersFor = (own) => {
    const out = new Headers(headers());
    for (const value of out.values()) remember(value);
    for (const [name, value] of Object.entries(own)) out.set(name, value);
    return out;
  };

  // One HTTP request that never follows a redirect: the response, or null when fetch failed (out of reach, a header
  // that cannot be sent, a stop; no text of the error is kept). done releases what was not read.
  const fetchOnce = async (init, signals) => {
    const own = new AbortController();
    let response = null;
    try {
      response = await fetchImpl(url, {
        ...init, headers: headersFor(init.headers), redirect: 'manual', signal: AbortSignal.any([...signals, own.signal]),
      });
    } catch {
      // the caller knows from null that nothing came back
    }
    return { response, done: () => own.abort() };
  };

  // ksproxy's headers of a message: initialize asks LEGACY_VERSION and carries no session; anything else the era, the
  // session when there is one, and in the 2026-07-28 era Mcp-Method.
  const ownHeaders = (message) => {
    const base = { accept: ACCEPT, 'content-type': 'application/json' };
    if (message.method === 'initialize') return { ...base, 'mcp-protocol-version': LEGACY_VERSION };
    const out = { ...base, 'mcp-protocol-version': era };
    if (sessionId !== null) out['mcp-session-id'] = sessionId;
    if (era === MODERN_VERSION && typeof message.method === 'string') out['mcp-method'] = message.method;
    return out;
  };

  // A message ksproxy sends on its own, a notification or an answer: whatever comes back is not read.
  const note = async (message, signals) => {
    const { done } = await fetchOnce({ method: 'POST', headers: ownHeaders(message), body: JSON.stringify(message) }, [closing.signal, ...signals]);
    done();
  };
  const cancel = (id) => note({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: CANCEL_REASON },
  }, [AbortSignal.timeout(NOTE_LIMIT_MS)]);

  // A request from the server inside a stream gets serverAnswer, at most MAX_ANSWERS on their way at once.
  const answerServer = (message) => {
    if (answering === MAX_ANSWERS) return;
    answering += 1;
    note(serverAnswer(message), [AbortSignal.timeout(NOTE_LIMIT_MS)]).then(() => {
      answering -= 1;
    });
  };

  // What one message is for the request id: its answer, or null to read on. bytes: its size as it was received.
  const take = (message, id, bytes) => {
    if (!isObject(message)) return null;
    if (typeof message.method === 'string') {
      if (isId(message.id)) answerServer(message);
      return null;
    }
    if (message.id !== id) return null;
    const outcome = answerOf(message, bytes);
    return outcome.rpcError === undefined ? outcome : { rpcError: { code: outcome.rpcError.code, message: hide(outcome.rpcError.message) } };
  };
  const parsed = (text, id) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return { notJson: true };
    }
    return take(message, id, Buffer.byteLength(text));
  };

  // A JSON body: at most maxMessageBytes, then one message.
  const bodyReader = (id) => {
    const chunks = [];
    let size = 0;
    return {
      push(chunk) {
        size += chunk.length;
        if (size > maxMessageBytes) return { tooLarge: true };
        chunks.push(chunk);
        return null;
      },
      end() {
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.trim() === '') return { cutOff: true };
        return parsed(text, id) ?? { cutOff: true };
      },
    };
  };

  // An SSE stream: only data lines count, joined by newlines into one message per event. Every line, and the data of
  // every event, is at most maxMessageBytes. Nothing after the outcome is read.
  const eventReader = (id) => {
    let outcome = null;
    let data = [];
    let size = 0;
    const onLine = (line) => {
      if (outcome !== null) return;
      const text = line.toString('utf8').replace(/\r$/, '');
      if (text === '') {
        const joined = data.join('\n');
        data = [];
        size = 0;
        if (joined.trim() !== '') outcome = parsed(joined, id);
      } else if (text.startsWith('data:')) {
        size += line.length;
        if (size > maxMessageBytes) outcome = { tooLarge: true };
        else data.push(text.slice(text.startsWith('data: ') ? 6 : 5));
      }
    };
    const feed = lineReader(maxMessageBytes, onLine, () => {
      if (outcome === null) outcome = { tooLarge: true };
    });
    return {
      push(chunk) {
        feed(chunk);
        return outcome;
      },
      end: () => ({ cutOff: true }),
    };
  };

  // The answer to id in a 2xx response, read chunk by chunk until there is an outcome.
  const readAnswer = async (response, id) => {
    if (response.body === null) return { cutOff: true };
    const sse = String(response.headers.get('content-type')).toLowerCase().startsWith('text/event-stream');
    const reader = sse ? eventReader(id) : bodyReader(id);
    const stream = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await stream.read();
        if (done) return reader.end();
        const outcome = reader.push(value);
        if (outcome !== null) return outcome;
      }
    } catch {
      return { cutOff: true };
    }
  };

  // One POST of a request and the reading of its answer; the stream is closed once the outcome is known. Mcp-Name and
  // the Mcp-Param headers are built from the message that is sent, and a value they cannot carry stops the call here.
  const post = async (entry, signal) => {
    const named = era === MODERN_VERSION && entry.message.method === 'tools/call' ? callHeaders(entry.message.params, marks, hidden) : {};
    if (typeof named === 'string') return { rpcError: { code: -32602, message: named } };
    const { response, done } = await fetchOnce({
      method: 'POST', headers: { ...ownHeaders(entry.message), ...named }, body: entry.body,
    }, [closing.signal, signal]);
    if (response === null) return { unreachable: true };
    entry.sessionHeader = response.headers.get('mcp-session-id');
    const outcome = response.ok
      ? await readAnswer(response, entry.id)
      : { httpError: { status: response.status, retryAfter: retryAfterOf(response.headers.get('retry-after')) } };
    done();
    return outcome;
  };

  const entryOf = (method, params) => {
    const id = nextId;
    nextId += 1;
    const message = {
      jsonrpc: '2.0', id, method, params,
    };
    return {
      id, message, body: JSON.stringify(message), sessionHeader: null,
    };
  };

  // initialize asking LEGACY_VERSION, then notifications/initialized, both within the signal. The era is the version
  // answered, the session the id given, if any. Throws a plain sentence, or the signal's reason.
  const initialize = async (signal) => {
    const entry = entryOf('initialize', { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    const init = await post(entry, signal);
    if (init.result === undefined) throw new Error(failure('initialize', init, { maxMessageBytes, hidden }));
    const version = versionOf(init.result);
    if (entry.sessionHeader !== null && !SESSION_FORM.test(entry.sessionHeader)) throw new Error(BAD_SESSION);
    era = version;
    sessionId = entry.sessionHeader;
    await note({ jsonrpc: '2.0', method: 'notifications/initialized' }, [signal]);
    signal.throwIfAborted();
    return { era: version, info: init.result.serverInfo };
  };

  // One renewal at a time, shared by every request that met the same old session; none when the session changed since
  // the request was sent. Its failure is not thrown: the request is repeated and gets its own answer.
  const renew = (sent) => {
    if (renewing === null && sessionId === sent) {
      renewing = initialize(AbortSignal.timeout(limitMs)).then(ignore, ignore).then(() => {
        renewing = null;
      });
    }
    return renewing;
  };

  // A request waits for a renewal under way; a 404 on the session it carried renews it, and the request is sent once more.
  const exchange = async (entry, signal) => {
    await renewing;
    const sent = sessionId;
    const first = await post(entry, signal);
    if (sent === null || first.httpError === undefined || first.httpError.status !== 404) return first;
    await renew(sent);
    return post(entry, signal);
  };

  const request = (method, params, { signal, timeoutMs, call = false } = {}) => new Promise((resolve) => {
    if (ended !== null) {
      resolve({ ended });
      return;
    }
    if (signal?.aborted) {
      resolve({ timedOut: true });
      return;
    }
    const entry = entryOf(method, params);
    const stop = new AbortController();
    let timer;
    const settle = (outcome) => {
      if (!live.delete(settle)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stop.abort();
      resolve(outcome);
    };
    // The answer will not be read: a call of the older era is cancelled, as closing its stream does not cancel it.
    const leave = (outcome) => {
      if (call && era !== MODERN_VERSION && live.has(settle)) cancel(entry.id);
      settle(outcome);
    };
    const onAbort = () => leave({ timedOut: true });
    live.add(settle);
    if (timeoutMs !== undefined) timer = setTimeout(onAbort, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    exchange(entry, stop.signal).then((outcome) => (unanswered(outcome) ? leave(outcome) : settle(outcome)));
  });

  const endSession = async () => {
    if (sessionId === null) return;
    const { done } = await fetchOnce({
      method: 'DELETE', headers: { 'mcp-protocol-version': era, 'mcp-session-id': sessionId },
    }, [AbortSignal.timeout(NOTE_LIMIT_MS)]);
    done();
  };

  return {
    maxMessageBytes,
    maxListBytes,
    hidden,
    request,
    initialize,
    learn(tools) {
      marks.clear();
      for (const tool of tools) {
        const list = headerMarks(tool);
        if (list.length > 0) marks.set(tool.name, list);
      }
    },
    onEnd: ends.onEnd,
    // Every request still waiting ends; the end is told; DELETE ends a session, with a limit of NOTE_LIMIT_MS.
    close() {
      if (closed === null) {
        ended = END;
        for (const settle of [...live]) settle({ ended: END });
        closing.abort();
        ends.end(END);
        closed = endSession().then(() => END);
      }
      return closed;
    },
  };
}

// server/discover first, as the specification says for HTTP; an HTTP error or a JSON-RPC error to it leads to initialize.
async function negotiateHttp(session, signal) {
  const found = await session.request('server/discover', { _meta: MODERN_META }, { signal });
  if (found.result !== undefined) return { era: MODERN_VERSION, info: found.result.serverInfo };
  if (found.httpError === undefined && found.rpcError === undefined) throw new Error(failure('server/discover', found, session));
  return session.initialize(signal);
}

// Connects to a remote MCP server and finds its era. headers() is asked before every request (for a token) and never
// shown. limitMs and signal end the wait: the promise rejects with a plain sentence. hidden: as for connectStdio.
export async function connectHttp({
  url, headers = () => ({}), fetchImpl = fetch, signal, limitMs = CONNECT_LIMIT_MS, maxMessageBytes = MAX_MESSAGE_BYTES,
  maxListBytes = MAX_LIST_BYTES, hidden = [],
}) {
  if (signal?.aborted) throw new Error(CONNECT_STOPPED);
  const session = createHttpSession({
    url, headers, fetchImpl, limitMs, maxMessageBytes, maxListBytes, hidden,
  });
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(new Error(`the MCP server did not answer within ${limitMs / 1000} seconds`)), limitMs);
  const onAbort = () => stop.abort(new Error(CONNECT_STOPPED));
  signal?.addEventListener('abort', onAbort, { once: true });
  let found;
  try {
    found = await negotiateHttp(session, stop.signal);
  } catch (err) {
    await session.close();
    throw stop.signal.aborted ? stop.signal.reason : err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  return { ...makeClient(session, found), close: session.close };
}
