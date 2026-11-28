import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Transform, pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { AllowError, isRegexRule, matchRule } from '../../allowlist.js';
import { checkServiceUrl } from '../../checks.js';
import { clip } from '../../text.js';
import { jsonBodyForms } from '../shared.js';
import { streamConnector } from './resp.js';

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
// The names ksproxy or Node set themselves: Node sets proxy-authorization and proxy-connection for a plain http request to
// a proxy of the environment, and a credential in a header of that name would not be sent. Node refuses a trailer header
// when the request ends, as the request is not sent in chunks.
const FORBIDDEN_HEADERS = [
  'host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'authorization', 'accept', 'content-type',
  'proxy-authorization', 'proxy-connection', 'trailer',
];
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
// What a secret that goes into a header as it is may hold: printable ASCII, so it cannot split or end a header.
const HEADER_VALUE_RE = /^[\x20-\x7e]+$/;
// The hint of the kinds on this engine for a call whose output was cut.
export const PAGING_HINT = "the API's own paging and filters (size, from, filter_path)";
const REACH_FAILED = 'the service could not be reached\n';
const CUT_OFF = 'the reply was cut off\n';
const REDIRECT = 'the service answered with a redirect, which is not followed\n';
const HIDDEN = '[hidden]';
const TIMED_OUT = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};
// What the request carried when it was sent with fetch, kept so that a server sees the same request: the headers fetch
// added, the encodings it asked for (brotli only over https), the ports it refused, at most 5 content encodings, and
// the statuses whose reply has no body (a 101 is refused before).
const FETCH_HEADERS = [['accept-language', '*'], ['sec-fetch-mode', 'cors'], ['user-agent', 'node']];
const ACCEPT_ENCODING = { 'http:': 'gzip, deflate', 'https:': 'br, gzip, deflate' };
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
].map(String));
const MAX_CODINGS = 5;
const NO_BODY = [204, 205, 304];
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];
const EDGE_SPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
const ZLIB_SYNC = { flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH };
const BROTLI_SYNC = { flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH };
const ZSTD_SYNC = { flush: zlib.constants.ZSTD_e_continue, finishFlush: zlib.constants.ZSTD_e_end };
// The variables of the environment that name a proxy and the hosts that go without one, as Node reads them, and each
// lower-case name with its upper-case one.
const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'];
const NO_PROXY_VARIABLES = ['NO_PROXY', 'no_proxy'];
const VARIABLE_PAIRS = [['http_proxy', 'HTTP_PROXY'], ['https_proxy', 'HTTPS_PROXY'], ['no_proxy', 'NO_PROXY']];
// How fetch split NO_PROXY, the star and dot or the dot at the start of an entry that fetch dropped, an entry with a port
// as fetch read it, and an IPv6 address in brackets with an optional port.
const NO_PROXY_SEPARATOR = /[,\s]/;
const STAR_DOT = /^\*?\./;
const WITH_PORT = /^(.+):(\d+)$/;
const BRACKETED_V6 = /^\[([^\]]*)\](|:\d+)$/;
// The shortest password of a proxy login that is hidden on its own, as start warns for a secret shorter than 8.
const SHORT_PASSWORD = 8;

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

// A header value as it goes on the wire: without the spaces, tabs and line ends at its ends, as fetch sent it.
// requestHeaders sends every value this way, and encodedForms hides a secret in this form.
const sentValue = (value) => value.replace(EDGE_SPACE, '');

// The forms of the secrets that are not a secret value as it is: the base64 credential that basic auth sends with the
// user name and the password each without the spaces at its ends (a server that decodes the header and trims them
// shows them so), or the bearer token or header value as it is sent, and each value and that form as a JSON body shows
// it (jsonBodyForms). A form without the spaces at the ends (sentValue) counts where it differs from the value and is
// not empty. The core hides them with the values. A space at the start of a token stays inside its header, so the form
// without it is a piece of what is sent: hiding it hides that.
export function encodedForms(auth, secrets) {
  const trimmed = (value) => [sentValue(value)].filter((form) => form !== '' && form !== value);
  let own = [];
  if (auth !== null && auth.basicUserEnv !== undefined) {
    own = [authHeader(auth, secrets).authorization.slice('Basic '.length),
      ...trimmed(secrets[auth.basicUserEnv]), ...trimmed(secrets[auth.basicPasswordEnv])];
  } else if (auth !== null) own = trimmed(secrets[authVariables(auth)[0]]);
  return [...own, ...jsonBodyForms([...Object.values(secrets), ...own])];
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

// Every value of one reply header, in any letter case, joined by ", " as fetch joined them, or null when there is none.
function headerOf(response, name) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === name) values.push(response.rawHeaders[i + 1]);
  }
  return values.length === 0 ? null : values.join(', ');
}

// The content type as the server sent it, without control characters. It is not shortened: the core hides the secrets
// after this, and a clip before that would show the start of one that a server put in the header.
function contentTypeOf(response) {
  const type = headerOf(response, 'content-type');
  return type === null ? '(none)' : type.replace(CONTROLS, '');
}

// The deflate decoder of fetch: a zlib stream when its first byte says so, else raw deflate. Destroying it destroys
// the inner decoder, so a reply cut at the read limit is not decoded further.
function inflater() {
  let inner = null;
  return new Transform({
    transform(chunk, encoding, done) {
      if (inner === null) {
        inner = (chunk[0] & 15) === 8 ? zlib.createInflate(ZLIB_SYNC) : zlib.createInflateRaw(ZLIB_SYNC);
        inner.on('data', (data) => this.push(data));
        inner.on('error', (err) => this.destroy(err));
      }
      inner.write(chunk, () => done());
    },
    flush(done) {
      if (inner === null) {
        done();
        return;
      }
      inner.once('end', () => done());
      inner.end();
    },
    destroy(err, done) {
      inner?.destroy();
      done(err);
    },
  });
}

const DECODERS = {
  gzip: () => zlib.createGunzip(ZLIB_SYNC),
  'x-gzip': () => zlib.createGunzip(ZLIB_SYNC),
  deflate: inflater,
  br: () => zlib.createBrotliDecompress(BROTLI_SYNC),
  zstd: () => zlib.createZstdDecompress(ZSTD_SYNC),
};

// The decoders of the content codings, in the order they run, the last coding first, as fetch chose them: none at
// all when one coding is not known, and the body is then given as it came.
function decodersOf(codings) {
  const names = codings.map((coding) => coding.trim()).reverse();
  return names.every((name) => Object.hasOwn(DECODERS, name)) ? names.map((name) => DECODERS[name]()) : [];
}

// The request headers as one object of names and values, in the order fetch sent them: host, connection close (one
// connection per request), the given headers with accept and the content type, the headers fetch added, the encodings
// it asked for, and the length of the body, 0 for a POST, PUT or PATCH without one. A header that fetch added, or
// accept-encoding, is left out when the given headers name it (their names are in lower case, see authHeader), so
// each name is sent once. Each value is sent as sentValue gives it, which is the form encodedForms hides. An object,
// not a flat list, lets Node add proxy-authorization for a plain http request that goes to a proxy.
function requestHeaders(url, method, headers, body) {
  const given = {
    ...headers, accept: ACCEPT, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const added = [...FETCH_HEADERS, ['accept-encoding', ACCEPT_ENCODING[url.protocol]]];
  let length = [];
  if (body !== undefined) length = [['content-length', String(Buffer.byteLength(body))]];
  else if (BODY_METHODS.includes(method)) length = [['content-length', '0']];
  return Object.fromEntries([
    ['host', url.host],
    ['connection', 'close'],
    ...Object.entries(given).map(([name, value]) => [name, sentValue(value)]),
    ...added.filter(([name]) => !Object.hasOwn(headers, name)),
    ...length,
  ]);
}

// A name that a shorter form of a NO_PROXY entry may be: not empty, without "*", not starting with ".", and without ":",
// which would make it an IPv6 address that fetch never matched (fetch compared an IPv6 host with its brackets).
const isPlainName = (name) => name !== '' && !/[*:]/.test(name) && !name.startsWith('.');

// The forms of one NO_PROXY entry that make Node's matching read it as fetch read it. Node splits on commas only and
// compares the host without brackets; fetch also split on white space, let "*.name" and ".name" cover the name and its
// sub-names, a bare name too, and "name:port" the name and its sub-names on that port. So: "*" stays; "*.name:port" and
// ".name:port", which cover nothing in Node, also give "name:port" (Node has no form for the sub-names on one port);
// "*.name" also gives "name", and ".name" stays; each only for a plain name (isPlainName), else the entry stays as
// written; "[v6]" and "[v6]:port" also come without the brackets, unless that form is an IPv6 address of its own (as
// "::1:8080" is), which Node would send direct on every port; an IP address and an entry with a port stay; a bare name
// also gives ".name".
function noProxyForms(entry) {
  if (entry === '*') return [entry];
  const prefix = STAR_DOT.exec(entry);
  if (prefix !== null) {
    const rest = entry.slice(prefix[0].length);
    const withPort = WITH_PORT.exec(rest);
    if (withPort !== null) return isPlainName(withPort[1]) ? [entry, rest] : [entry];
    return prefix[0] === '*.' && isPlainName(rest) ? [entry, rest] : [entry];
  }
  const bracketed = BRACKETED_V6.exec(entry);
  if (bracketed !== null) {
    const plain = `${bracketed[1]}${bracketed[2]}`;
    return net.isIPv6(bracketed[1]) && (bracketed[2] === '' || !net.isIPv6(plain)) ? [entry, plain] : [entry];
  }
  if (net.isIP(entry) !== 0 || WITH_PORT.test(entry) || entry.startsWith('[')) return [entry];
  return [entry, `.${entry}`];
}

// A NO_PROXY value as fetch read it, for Node's own matching: the entries split on commas and white space, the empty
// ones dropped, each with its forms (noProxyForms), joined by commas. A value without an entry, such as " ", stays as
// written: Node reads it as it read the original, and does not take the other variable for an empty one.
export function widenNoProxy(value) {
  const entries = value.split(NO_PROXY_SEPARATOR).filter((entry) => entry !== '');
  return entries.length === 0 ? value : entries.flatMap(noProxyForms).join(',');
}

// The environment of the proxy for the agent of one request: none stays none; else a copy in which the variables count
// as fetch chose them. Node takes the lower-case one when it is not empty, else the upper-case one; fetch took the
// lower-case one whenever it was set, also to an empty text, and for https the http proxy when no https proxy was given.
// So the upper-case one of each pair is left out of the copy when the lower-case one is set; then, when no https
// variable gives a proxy (unset or empty), the http proxy that counts, if any, is the https proxy too; and NO_PROXY and
// no_proxy, where they are set, are read as fetch read them (widenNoProxy).
function proxyEnvOf(proxyEnv) {
  if (proxyEnv === undefined) return undefined;
  const copy = { ...proxyEnv };
  for (const [lower, upper] of VARIABLE_PAIRS) {
    if (copy[lower] !== undefined) delete copy[upper];
  }
  if (!copy.https_proxy && !copy.HTTPS_PROXY) copy.https_proxy = copy.http_proxy ?? copy.HTTP_PROXY;
  for (const name of NO_PROXY_VARIABLES) {
    if (copy[name] !== undefined) copy[name] = widenNoProxy(copy[name]);
  }
  return copy;
}

// The forms of the logins of the proxies of the environment that a reply may show: for each proxy address that is a
// URL with a user name or a password, the base64 of user, colon, password that Node sends, each part percent-decoded as
// Node decodes it (as written when that fails), and the password when it has at least SHORT_PASSWORD characters. With
// an empty password the user name is the secret (a token as the user), and it is hidden when it has at least
// SHORT_PASSWORD characters. With a password the user name alone is never hidden, nor a shorter password or user name:
// a short word such as "a" would be hidden in every reply, and would break "application/json" into pieces. Every
// proxy variable is read, also one that proxyEnvOf leaves out: hiding its login too does no harm.
function proxyLoginForms(proxyEnv) {
  if (proxyEnv === undefined) return [];
  const decoded = (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  };
  return PROXY_VARIABLES.flatMap((name) => {
    const url = URL.parse(proxyEnv[name] ?? '');
    if (url === null || (url.username === '' && url.password === '')) return [];
    const user = decoded(url.username);
    const password = decoded(url.password);
    const secret = password === '' ? user : password;
    return [Buffer.from(`${user}:${password}`).toString('base64'), ...(secret.length >= SHORT_PASSWORD ? [secret] : [])];
  });
}

// The agent of node:http or node:https for one request, and destroy, which destroys every socket it made. Node's own
// destroy of an agent misses the socket to a proxy whose CONNECT was refused or never answered: Node never adds it to
// the lists of the agent. The agent uses a proxy of the environment only when Node's own global agent does
// (NODE_USE_ENV_PROXY), with NO_PROXY read as fetch read it (proxyEnvOf).
function requestAgent(transport) {
  const agent = new transport.Agent({ proxyEnv: proxyEnvOf(transport.globalAgent.options.proxyEnv) });
  const made = [];
  const create = agent.createConnection;
  agent.createConnection = (...args) => {
    const socket = create.apply(agent, args);
    made.push(socket);
    return socket;
  };
  return { agent, destroy: () => made.forEach((socket) => socket.destroy()) };
}

// Sends the request with node:http or node:https and waits for the head of the reply: { response, release }, or a
// rejection when there is none (a port fetch refused, a header that cannot be sent, no connection, no answer, a 100
// Continue that was not asked for, a 101 switch of protocol, a status below 100, the stop signal). A throw of making or
// ending the request (a header Node refuses) goes through fail too, so the sockets made are destroyed. connect, when given,
// gives the socket to send on (for https a TLS socket), and nothing else is destroyed. Without it, the agent of this one
// request connects (requestAgent): its sockets are destroyed on a rejection, and by release after a reply, so none of
// them stays, also one to a proxy that refused a CONNECT and kept the connection. release destroys the reply too. Over
// TLS, ALPN offers http/1.1 only, as fetch did.
function exchange(url, {
  method, headers, body, signal, connect,
}) {
  return new Promise((resolve, reject) => {
    if (BAD_PORTS.has(url.port)) throw new Error('a port fetch refuses');
    const transport = url.protocol === 'https:' ? https : http;
    const own = connect === undefined ? requestAgent(transport) : null;
    const way = own === null ? { createConnection: connect } : { agent: own.agent };
    // Only the first answer counts: an error that comes after the reply leaves the agent to release, as its body may be
    // read still.
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      own?.destroy();
      reject(err);
    };
    let request;
    try {
      request = transport.request(url, {
        method, headers, signal, ALPNProtocols: ['http/1.1'], ...way,
      });
    } catch (err) {
      fail(err);
      return;
    }
    // The stop ends the wait whatever the request does: a connect that gives no socket leaves Node waiting for one, and
    // then the signal of the request alone does not end it. A socket that comes later is destroyed with the request.
    const onStop = () => {
      fail(new Error('stopped'));
      request.destroy();
    };
    signal.addEventListener('abort', onStop, { once: true });
    request.on('close', () => signal.removeEventListener('abort', onStop));
    request.on('error', fail);
    request.on('continue', () => {
      fail(new Error('a 100 Continue that was not asked for'));
      request.destroy();
    });
    request.on('upgrade', (response, socket) => {
      fail(new Error('a switch of protocol that was not asked for'));
      socket.destroy();
    });
    request.on('response', (response) => {
      if (response.statusCode >= 100 && response.statusCode !== 101) {
        settled = true;
        resolve({
          response,
          release: () => {
            response.destroy();
            own?.destroy();
          },
        });
        return;
      }
      // A 101, or a status below 100 such as 000 or 099, which fetch failed on: no usable answer.
      fail(new Error('no usable answer'));
      response.destroy();
    });
    try {
      request.end(body);
    } catch (err) {
      fail(err);
      request.destroy();
    }
  });
}

// The address of a target's URL for a service tunnel: its host and port, the default port of its scheme (80 or 443)
// when it names none; an IPv6 host keeps its brackets.
export function urlAddress(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.hostname}:${url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : url.port}`;
}

// The connect of send for a target behind a tunnel (opened.tunnel). Node calls it inside request() with the options of
// the request, which come from the target's URL. The socket is one new stream of the tunnel: tunnel.connect() makes
// one ssh child, and when it throws the request fails as one that found no connection. For https the handshake runs
// over that stream with what a direct request of this engine uses: the default authorities of Node (and
// NODE_EXTRA_CA_CERTS), ALPN http/1.1, the real host as the server name unless it is an IP address, and the
// certificate checked against that host. Ending or destroying the socket ends the stream, and with it the child.
export function tunnelConnect(tunnel) {
  const open = streamConnector(tunnel);
  return (options) => {
    const host = options.hostname;
    return open({
      host, servername: net.isIP(host) === 0 ? host : undefined, ALPNProtocols: options.ALPNProtocols,
    }, options.protocol === 'https:');
  };
}

// What send gets for the opened entry of a call or a check: the connect of its tunnel, or nothing, so that a target
// without one connects as it always did. opened may be undefined.
export function connectOf(opened) {
  return opened?.tunnel === undefined ? {} : { connect: tunnelConnect(opened.tunnel) };
}

// The body as text, at most maxBytes bytes of it: { text, truncated, failed }; failed when the stream broke.
async function readLimited(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  let failed = false;
  try {
    for await (const chunk of stream) {
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
// the body stopped before its end, as truncated is when it reached maxBytes. The body is decoded as fetch decoded it,
// and maxBytes counts the decoded bytes. connect: see exchange. The reply is released at the end (the reply and the
// agent of the request destroyed), so no socket stays.
// Without connect, the login of a proxy of the environment is hidden in stdout (proxyLoginForms): a proxy may show it.
// The global agents of node:http and node:https share one proxyEnv.
export async function send({
  baseUrl, headers, method, segments, query, body, timeoutMs, maxBytes, signal, connect,
}) {
  const url = new URL(buildUrl(baseUrl, segments, query));
  const forms = connect === undefined ? proxyLoginForms(http.globalAgent.options.proxyEnv) : [];
  const shown = (text) => (forms.length === 0 ? text : hideSecrets(text, forms));
  const stop = AbortSignal.any(signal === undefined ? [AbortSignal.timeout(timeoutMs)] : [signal, AbortSignal.timeout(timeoutMs)]);
  // A stop that came before the start makes no connection, so no ssh child of a tunnel is started for nothing.
  if (stop.aborted) return { ...TIMED_OUT };
  let response;
  let release;
  try {
    ({ response, release } = await exchange(url, {
      method, headers: requestHeaders(url, method, headers, body), body, signal: stop, connect,
    }));
  } catch {
    if (stop.aborted) return { ...TIMED_OUT };
    return { exitCode: 1, stdout: '', stderr: REACH_FAILED };
  }
  const status = response.statusCode;
  const encoding = method === 'HEAD' || NO_BODY.includes(status) ? null : headerOf(response, 'content-encoding');
  const codings = encoding ? encoding.toLowerCase().split(',') : [];
  if (codings.length > MAX_CODINGS) {
    release();
    return { exitCode: 1, stdout: '', stderr: REACH_FAILED };
  }
  const head = `HTTP ${status}\ncontent-type: ${contentTypeOf(response)}\n\n`;
  if (status >= 300 && status < 400) {
    release();
    return { exitCode: 1, stdout: shown(head), stderr: REDIRECT };
  }
  const decoders = decodersOf(codings);
  const read = await readLimited(decoders.length === 0 ? response : pipeline(response, ...decoders, () => {}), maxBytes);
  release();
  const ok = status >= 200 && status < 300;
  if (read.failed && stop.aborted) {
    return {
      exitCode: null, stdout: shown(head + read.text), stderr: '', timedOut: true,
    };
  }
  return {
    exitCode: ok && !read.failed ? 0 : 1,
    stdout: shown(head + read.text),
    stderr: read.failed ? CUT_OFF : '',
    ownStderr: true,
    truncated: read.truncated,
    cutOff: read.failed,
  };
}
