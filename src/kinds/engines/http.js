import { AllowError, isRegexRule, matchRule } from '../../allowlist.js';
import { checkServiceUrl } from '../../checks.js';
import { clip } from '../../text.js';
import { jsonBodyForms } from '../shared.js';

// The http engine: the strict reader of a request, its words for the rules, and the one request it sends.
// Host, port and scheme come from the target's baseUrl only; the agent gives a method, a path, a query and a body.

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'];
export const BODY_WORD = '+body';
export const MAX_PATH_BYTES = 2048;
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_QUERY_NAMES = 50;
const MAX_QUERY_NAME = 256;
const MAX_QUERY_VALUE = 2048;
const REQUEST_FIELDS = ['method', 'path', 'query', 'body'];
// Query names that many web frameworks read as the method of the request: a rule that allows a POST could send a DELETE.
const METHOD_OVERRIDES = ['_method', 'x-http-method-override', 'x-method-override', 'x-http-method'];
const SPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const SEGMENT_CHAR = /^[A-Za-z0-9\-._~!$&'()*+,=:%]$/;
const LOOSE_PERCENT = /%(?![0-9A-Fa-f]{2})/;
const ENCODED = /%([0-9A-Fa-f]{2})/g;
// Bytes that may not be given percent-encoded: a control character, "%" (a second decoding), ".", "/", ";" and "\".
const ENCODED_FORBIDDEN = (byte) => byte < 0x20 || byte === 0x7f || [0x25, 0x2e, 0x2f, 0x3b, 0x5c].includes(byte);
const DOTS_ONLY = /^\.+$/;
// The one encoded slash a kind may opt in to: a whole segment %2F or %2f, RabbitMQ's default virtual host "/".
const VHOST_SEGMENT = /^%2F$/i;
const VHOST_WORD = '/%2F';
const ACCEPT = 'application/json, */*';
const FORBIDDEN_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'authorization', 'accept', 'content-type'];
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
// What a secret that goes into a header as it is may hold: printable ASCII, so it cannot split or end a header.
const HEADER_VALUE_RE = /^[\x20-\x7e]+$/;
// The hint of the kinds on this engine for a call whose output was cut.
export const PAGING_HINT = "the API's own paging and filters (size, from, filter_path)";
const REACH_FAILED = 'the service could not be reached\n';
const CUT_OFF = 'the reply was cut off\n';
const REDIRECT = 'the service answered with a redirect, which is not followed\n';
const HIDDEN = '[hidden]';

const refuse = (reason, short) => {
  throw new AllowError(reason, short);
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describeChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x21 || code > 0x7e) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `"${ch}"`;
}

function readMethod(method) {
  if (typeof method !== 'string') refuse('method must be a string', 'invalid method');
  const upper = method.toUpperCase();
  if (!METHODS.includes(upper)) {
    refuse(`method ${clip(method, 20)} is not allowed: use GET, HEAD, POST, PUT, DELETE or PATCH`, 'method not allowed');
  }
  return upper;
}

// Whether the percent-encodings of a segment decode to valid UTF-8: an overlong form such as %C0%AE for "." does not.
function isUtf8(segment) {
  try {
    decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}

// The segments of the path, each as written (percent-encodings kept), or a refusal. The order of the checks is the
// order a caller sees the refusals in. With vhostSegment, a segment that is exactly %2F or %2f is not checked for
// encodings; every other check still applies to it.
function readPath(path, vhostSegment) {
  if (typeof path !== 'string') refuse('path must be a string', 'invalid path');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) refuse(`path is longer than ${MAX_PATH_BYTES} bytes`, 'path too long');
  if (SPACE_OR_CONTROL.test(path)) refuse('path may not contain a space or a control character', 'space or control character');
  if (!path.startsWith('/')) refuse('path must start with "/": give the path only, the host comes from the target', 'path not absolute');
  if (path.includes('?') || path.includes('#')) refuse('path may not contain "?" or "#": give the query in query', 'query in path');
  if (path.includes('\\')) refuse('path may not contain a backslash', 'backslash in path');
  if (path.includes('@')) refuse('path may not contain "@"', 'at sign in path');
  if (path.includes(';')) refuse('path may not contain ";"', 'semicolon in path');
  if (path === '/') return [];
  const segments = path.slice(1).split('/');
  if (segments.includes('')) refuse('path may not contain an empty segment: no "//" and no "/" at the end', 'empty segment');
  if (segments.some((s) => DOTS_ONLY.test(s))) refuse('path may not contain a "." or ".." segment', 'dot segment');
  if (LOOSE_PERCENT.test(path)) refuse('path has a "%" that is not followed by two hex digits', 'bad percent-encoding');
  const checked = vhostSegment ? segments.filter((s) => !VHOST_SEGMENT.test(s)) : segments;
  for (const [, hex] of checked.join('/').matchAll(ENCODED)) {
    if (ENCODED_FORBIDDEN(Number.parseInt(hex, 16))) {
      refuse('path may not encode "/", "\\", ".", ";", "%" or a control character', 'encoded separator');
    }
  }
  if (!segments.every(isUtf8)) refuse('path has a percent-encoding that is not valid UTF-8', 'invalid UTF-8 encoding');
  const odd = [...path].find((ch) => ch !== '/' && !SEGMENT_CHAR.test(ch));
  if (odd !== undefined) refuse(`path may not contain the character ${describeChar(odd)}`, `character ${describeChar(odd)} not allowed`);
  return segments;
}

function queryValue(name, value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') {
    refuse(`the query value of ${clip(name, 40)} must be a string, a number, true or false`, 'invalid query');
  }
  if (value.length > MAX_QUERY_VALUE || CONTROL.test(value)) {
    refuse(`a query value must be at most ${MAX_QUERY_VALUE} characters without control characters`, 'invalid query');
  }
  return value;
}

// The query as a list of name and value strings, in the order given. It is not matched against the rules, but a
// reviewer sees it. A name of METHOD_OVERRIDES, in any letter case, is refused.
function readQuery(query) {
  if (query === undefined) return [];
  if (!isPlainObject(query)) refuse('query must be an object of names and values', 'invalid query');
  const entries = Object.entries(query);
  if (entries.length > MAX_QUERY_NAMES) refuse(`query has more than ${MAX_QUERY_NAMES} names`, 'query too large');
  return entries.map(([name, value]) => {
    if (name === '' || name.length > MAX_QUERY_NAME || CONTROL.test(name)) {
      refuse(`a query name must be 1 to ${MAX_QUERY_NAME} characters without control characters`, 'invalid query');
    }
    if (METHOD_OVERRIDES.includes(name.toLowerCase())) {
      refuse(`the query name ${clip(name, 40)} is refused: a server may read it as another method`, 'method override refused');
    }
    return [name, queryValue(name, value)];
  });
}

// The body as the JSON text that is sent, or undefined when there is none.
function readBody(body, method) {
  if (body === undefined) return undefined;
  if (body === null || typeof body !== 'object') refuse('body must be a JSON object or array', 'invalid body');
  let text;
  try {
    text = JSON.stringify(body);
  } catch {
    refuse('body cannot be written as JSON', 'invalid body');
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) refuse('body is larger than 64 KiB', 'body too large');
  if (method === 'GET' || method === 'HEAD') refuse('a GET or HEAD request cannot carry a body', 'body not allowed');
  return text;
}

// The strict reader: every field of the request is treated as hostile. Throws AllowError(reason, short).
// vhostSegment, off by default, lets a path segment be exactly %2F or %2f; only a kind that opts in passes it.
export function readRequest(input, { vhostSegment = false } = {}) {
  if (!isPlainObject(input)) refuse('the request must be an object', 'invalid request');
  const unknown = Object.keys(input).find((key) => !REQUEST_FIELDS.includes(key));
  if (unknown !== undefined) {
    refuse(`the request has an unknown field ${clip(unknown, 40)}: a request has method, path, query and body only`, 'unknown field');
  }
  const method = readMethod(input.method);
  const segments = readPath(input.path, vhostSegment);
  const query = readQuery(input.query);
  const body = readBody(input.body, method);
  return {
    method, segments, query, body,
  };
}

// A path segment as a word: its leading slash and the segment, and /%2F for a whole %2F or %2f.
const segmentWord = (segment) => (VHOST_SEGMENT.test(segment) ? VHOST_WORD : `/${segment}`);

// The method, one word per path segment written with its leading slash, then +body when a body is sent.
export function requestWords({ method, segments, body }) {
  return [method, ...segments.map(segmentWord), ...(body === undefined ? [] : [BODY_WORD])];
}

// The words a reviewer sees: requestWords, then one word per query name, a question mark and the name and value
// encoded as they are sent. A word over the reviewer's length limit keeps the call from the reviewer, so nothing is cut.
export function reviewWords(request) {
  return [...requestWords(request), ...request.query.map((pair) => `?${new URLSearchParams([pair]).toString()}`)];
}

// A path segment of a rule as the word rules match: * one segment, ... the rest, \* a literal star segment.
function ruleWord(segment) {
  if (segment === '*' || segment === '...') return segment;
  if (segment === '\\*') return '/*';
  return segmentWord(segment);
}

// A word rule written as a request line, METHOD /path or METHOD /path +body, split as a request is:
// { words, body }, or null when the rule does not have that form. A whole %2F segment is a form only with vhostSegment.
export function splitRule(rule, { vhostSegment = false } = {}) {
  const parts = rule.trim().split(/\s+/);
  const body = parts.length === 3 && parts[2] === BODY_WORD;
  if (parts.length !== 2 && !body) return null;
  const [method, path] = parts;
  if (method !== '*' && !METHODS.includes(method)) return null;
  if (!path.startsWith('/')) return null;
  const segments = path === '/' ? [] : path.slice(1).split('/');
  if (segments.includes('')) return null;
  if (!vhostSegment && segments.some((s) => VHOST_SEGMENT.test(s))) return null;
  const rest = segments.indexOf('...');
  if (rest !== -1 && rest !== segments.length - 1) return null;
  return { words: [method, ...segments.map(ruleWord)], body };
}

// Whether a rule matches the words of a request. A regex rule sees the words joined by single spaces, +body included.
// A word rule matches the method and the path, and allows a body only when it ends in +body, and then requires one.
// options go to splitRule.
export function matchRequestRule(words, rule, options = {}) {
  if (isRegexRule(rule)) return matchRule(words, rule);
  const split = splitRule(rule, options);
  if (split === null) return false;
  const hasBody = words[words.length - 1] === BODY_WORD;
  if (split.body !== hasBody) return false;
  return matchRule(hasBody ? words.slice(0, -1) : words, split.words.join(' '));
}

// The reviewer URL check, and the base always ends in "/" so that a path is added under it.
export function validateBaseUrl(value, where) {
  const url = checkServiceUrl(value, where);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

// The environment variables that the auth of a target names, in a fixed order.
export function authVariables(auth) {
  if (auth === null) return [];
  if (auth.bearerEnv !== undefined) return [auth.bearerEnv];
  if (auth.basicUserEnv !== undefined) return [auth.basicUserEnv, auth.basicPasswordEnv];
  return [auth.headerEnv];
}

// The secrets of a target with this auth, as secrets(target) gives them: the user name of basic auth is also named in
// users, as it is not a secret.
export function authSecrets(auth) {
  const users = auth !== null && auth.basicUserEnv !== undefined ? { users: [auth.basicUserEnv] } : {};
  return { env: authVariables(auth), files: [], ...users };
}

// A header name that the header form of auth may use: letters, digits and "-", never one ksproxy sets itself.
export function headerNameProblem(name) {
  return typeof name === 'string' && HEADER_NAME_RE.test(name) && !FORBIDDEN_HEADERS.includes(name.toLowerCase())
    ? null
    : `must be letters, digits and "-", and not one of ${FORBIDDEN_HEADERS.join(', ')}`;
}

// null when the secrets can be put into the auth header, else the text that skips the target.
// No value may hold a character that could split or end a header; a basic user name may not hold ":".
export function authProblem(auth, secrets) {
  const bad = (name) => `${name} holds a character that is not allowed`;
  if (auth === null) return null;
  if (auth.basicUserEnv !== undefined) {
    const user = secrets[auth.basicUserEnv];
    if (CONTROL.test(user) || user.includes(':')) return bad(auth.basicUserEnv);
    if (CONTROL.test(secrets[auth.basicPasswordEnv])) return bad(auth.basicPasswordEnv);
    return null;
  }
  const name = authVariables(auth)[0];
  return HEADER_VALUE_RE.test(secrets[name]) ? null : bad(name);
}

// The one auth header, as a headers object; {} without auth.
export function authHeader(auth, secrets) {
  if (auth === null) return {};
  if (auth.bearerEnv !== undefined) return { authorization: `Bearer ${secrets[auth.bearerEnv]}` };
  if (auth.basicUserEnv !== undefined) {
    const pair = `${secrets[auth.basicUserEnv]}:${secrets[auth.basicPasswordEnv]}`;
    return { authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}` };
  }
  return { [auth.headerName.toLowerCase()]: secrets[auth.headerEnv] };
}

// The forms of the secrets that are not a secret value as it is: the base64 credential that basic auth sends, and each
// value and that credential as a JSON body shows it (jsonBodyForms). The core hides them with the values.
export function encodedForms(auth, secrets) {
  const basic = auth === null || auth.basicUserEnv === undefined ? [] : [authHeader(auth, secrets).authorization.slice('Basic '.length)];
  return [...basic, ...jsonBodyForms([...Object.values(secrets), ...basic])];
}

// The URL to fetch: the origin and path of the base, then the segments, then the query. The result must keep the
// base's origin and start with its path, or the request is refused.
export function buildUrl(baseUrl, segments, query) {
  const base = new URL(baseUrl);
  const url = new URL(`${base.origin}${base.pathname}${segments.join('/')}`);
  if (query.length > 0) url.search = new URLSearchParams(query).toString();
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.hash !== '') {
    refuse('the path would leave the base URL of the target', 'path leaves base');
  }
  return url.href;
}

// The content type as the server sent it, without control characters. It is not shortened: the core hides the secrets
// after this, and a clip before that would show the start of one that a server put in the header.
function contentTypeOf(response) {
  const type = response.headers.get('content-type');
  return type === null ? '(none)' : type.replace(CONTROLS, '');
}

// The body as text, at most maxBytes bytes of it: { text, truncated, failed }; failed when the stream broke.
async function readLimited(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  let failed = false;
  try {
    for await (const chunk of stream ?? []) {
      if (size + chunk.byteLength > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        truncated = true;
        break;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } catch {
    failed = true;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated, failed };
}

// Every place of a text that a value covers, hidden, in a text that goes back to the agent: every occurrence of every
// value is found in the text as it came, also where two overlap, and each run of covered characters becomes one
// [hidden]; two occurrences that only touch give two. So a value that overlaps another never leaves the rest of that
// one in clear, whichever is longer or starts first, and a [hidden] that was put in is never looked at again: a value
// that is a piece of the word hidden cannot make the text grow a second time. No regular expression is built from the
// values: one of a very long value would be refused.
export function hideSecrets(text, values) {
  const spans = [];
  for (const value of new Set(values)) {
    if (value === '') continue;
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) spans.push([at, at + value.length]);
  }
  if (spans.length === 0) return text;
  spans.sort((x, y) => x[0] - y[0]);
  let out = '';
  let shown = 0;
  let [start, end] = spans[0];
  for (const [from, to] of spans) {
    if (from < end) {
      end = Math.max(end, to);
    } else {
      out += text.slice(shown, start) + HIDDEN;
      shown = end;
      [start, end] = [from, to];
    }
  }
  return out + text.slice(shown, start) + HIDDEN + text.slice(end);
}

// Sends one request and reads the reply. Never follows a redirect. exitCode 0 for a 2xx status, 1 otherwise;
// stdout is HTTP STATUS, the content type, an empty line and the body as text, cut at maxBytes. cutOff is true when
// the body stopped before its end, as truncated is when it reached maxBytes.
export async function send({
  baseUrl, headers, method, segments, query, body, timeoutMs, maxBytes, signal, fetchImpl = fetch,
}) {
  const url = buildUrl(baseUrl, segments, query);
  const stop = AbortSignal.any(signal === undefined ? [AbortSignal.timeout(timeoutMs)] : [signal, AbortSignal.timeout(timeoutMs)]);
  const sent = {
    ...headers, accept: ACCEPT, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  let response;
  try {
    response = await fetchImpl(url, {
      method, headers: sent, body, redirect: 'manual', signal: stop,
    });
  } catch {
    if (stop.aborted) {
      return {
        exitCode: null, stdout: '', stderr: '', timedOut: true,
      };
    }
    return { exitCode: 1, stdout: '', stderr: REACH_FAILED };
  }
  const head = `HTTP ${response.status}\ncontent-type: ${contentTypeOf(response)}\n\n`;
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { exitCode: 1, stdout: head, stderr: REDIRECT };
  }
  const read = await readLimited(response.body, maxBytes);
  const ok = response.status >= 200 && response.status < 300;
  if (read.failed && stop.aborted) {
    return {
      exitCode: null, stdout: head + read.text, stderr: '', timedOut: true,
    };
  }
  return {
    exitCode: ok && !read.failed ? 0 : 1,
    stdout: head + read.text,
    stderr: read.failed ? CUT_OFF : '',
    ownStderr: true,
    truncated: read.truncated,
    cutOff: read.failed,
  };
}
