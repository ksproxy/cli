import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isObject } from './checks.js';
import { handleMessage } from './mcp.js';
import {
  PROJECT_DEFAULT, ensureDir, listenDir, writeFileAtomic,
} from './paths.js';
import { isLive, processStartTime } from './session.js';
import { checkToken, noteUse } from './token.js';

// The network listener of ksproxy start: MCP over HTTP, on loopback or private addresses of this machine, behind the
// global token. Each request is checked in a fixed order before its body is read, then its one JSON-RPC message goes to
// the same handleMessage as ksproxy mcp, with the env of the project its path names. Nothing here writes the token, the
// Authorization header or a body to a log, a file, an event or an error text.

export const LISTEN_LIMITS = Object.freeze({
  maxConnections: 64,
  maxPerAddress: 16,
  maxCalls: 16,
  requestMs: 10000,
  idleMs: 60000,
  maxBody: 262144,
  wrongMax: 10,
  wrongWindowMs: 60000,
  blockMs: 60000,
  listenWriteMs: 2000,
  maxClients: 1000,
  closeWaitMs: 5000,
});

// The refused events of one tick of the report timer name at most this many addresses; one more event covers the rest.
// The first wrong tokens reported at once between two ticks count toward the same number, so the events of a window
// stay bounded however many addresses send one.
const REFUSED_PER_TICK = 10;
const CLIENT_MAX = 64;
const UNKNOWN_CLIENT = 'unknown';

const LISTEN_RE = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d+)$/;
const PORT_RE = /^[1-9]\d{0,4}$/;
const ZONE_RE = /^([^%]*)(?:%(.*))?$/;
const HOST_RE = /^(?:\[([^\]]+)\]|([^:[\]]+))(?::(\d+))?$/;
const PATH_RE = /^\/(?:p\/([^/]+)\/)?mcp$/;
const BEARER_RE = /^bearer +(\S+)$/i;

const FORM_TEXT = '--listen: write HOST:PORT, such as 192.168.1.20:7443, or [fd00::5]:7443 for IPv6';
const PORT_TEXT = '--listen: PORT must be a number from 1 to 65535';
const NAME_TEXT = '--listen: HOST must be an IP address, IPv6 in brackets; a name is not accepted';
const ZONE_TEXT = '--listen: only a link-local IPv6 address takes an interface after %, such as [fe80::1%en0]:7443';
const NEEDS_ZONE_TEXT = '--listen: a link-local IPv6 address needs its interface after %, such as [fe80::1%en0]:7443';

// What a refused token answers, with 401. Only wrong counts toward the block of the address.
const TOKEN_TEXT = {
  missing: 'the request has no token',
  wrong: 'the token is wrong',
  revoked: 'the token was revoked',
  expired: 'the token expired',
  unreadable: 'the token file cannot be read',
};

const PARSE_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };

// What a request gets, with 503, while maxCalls messages are being handled.
const BUSY_TEXT = 'too many calls at once; try again soon';
const BUSY_HEADERS = Object.freeze({ 'Retry-After': '1' });

function blockList(ranges) {
  const list = new net.BlockList();
  for (const [address, prefix, type] of ranges) list.addSubnet(address, prefix, type);
  return list;
}

const LOOPBACK = blockList([['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']]);
const PRIVATE = blockList([
  ['127.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
]);
const LINK_LOCAL6 = blockList([['fe80::', 10, 'ipv6']]);

const typeOf = (family) => (family === 6 ? 'ipv6' : 'ipv4');

// An address in one written form: IPv6 in lower case with :: for the longest run of zeros, IPv4 as given (net.isIPv4
// accepts no leading zero).
const normalAddress = (address, family) => (family === 6 ? new net.SocketAddress({ address, family: 'ipv6' }).address : address);

// The host part of HOST:PORT: an IPv6 address in brackets.
const hostText = (host, family) => (family === 6 ? `[${host}]` : host);

const withoutZone = (host) => host.replace(/%.*$/, '');

export function listenPath(env) {
  return path.join(listenDir(env), 'listen.json');
}

// Whether an interface of this machine has the address; with a zone, only the interface of that name counts.
function ownAddress(address, family, zone, interfaces) {
  const wanted = family === 6 ? 'IPv6' : 'IPv4';
  return Object.entries(interfaces).some(([name, entries]) => (zone === undefined || name === zone)
    && entries.some((entry) => entry.family === wanted && normalAddress(entry.address, family) === address));
}

// One --listen value: A.B.C.D:PORT or [IPV6]:PORT, an address literal that is loopback or private and an address of
// this machine. A link-local IPv6 address takes its interface as a zone: [fe80::1%en0]:7443.
export function parseListen(text, interfaces = os.networkInterfaces()) {
  const form = typeof text === 'string' ? LISTEN_RE.exec(text) : null;
  if (form === null) throw new Error(FORM_TEXT);
  const [, bracketed, plain, portText] = form;
  if (!PORT_RE.test(portText) || Number(portText) > 65535) throw new Error(PORT_TEXT);
  const family = bracketed === undefined ? 4 : 6;
  const [, written, zone] = ZONE_RE.exec(bracketed ?? plain);
  if (!(family === 6 ? net.isIPv6(written) : net.isIPv4(written))) throw new Error(NAME_TEXT);
  const address = normalAddress(written, family);
  const linkLocal = family === 6 && LINK_LOCAL6.check(address, 'ipv6');
  if (zone !== undefined && !linkLocal) throw new Error(ZONE_TEXT);
  if (linkLocal && zone === undefined) throw new Error(NEEDS_ZONE_TEXT);
  if (!PRIVATE.check(address, typeOf(family)) || !ownAddress(address, family, zone, interfaces)) {
    throw new Error(`--listen: ${text.slice(0, text.lastIndexOf(':'))} is not a loopback or private address of this machine`);
  }
  return { host: zone === undefined ? address : `${address}%${zone}`, port: Number(portText), family };
}

// The Host header values a request to this address and port may give, in the form hostKey makes: the address without
// its zone, IPv6 in brackets, and localhost for a loopback address.
export function allowedHosts(address, port) {
  const host = normalAddress(withoutZone(address.host), address.family);
  const loopback = LOOPBACK.check(host, typeOf(address.family));
  return [`${hostText(host, address.family)}:${port}`, `localhost:${port}`].filter((key, i) => i === 0 || loopback);
}

// A Host header value as HOST:PORT in lower case, an IPv6 address in one form and without a zone, the port of the
// scheme when none is given; null when it is not a host with an optional port.
function hostKey(value, defaultPort) {
  const match = HOST_RE.exec(String(value).toLowerCase());
  if (match === null) return null;
  const port = match[3] ?? String(defaultPort);
  if (match[1] === undefined) return `${match[2]}:${port}`;
  const address = withoutZone(match[1]);
  return net.isIPv6(address) ? `[${normalAddress(address, 6)}]:${port}` : null;
}

// The client name of an initialize: clientInfo name and version, printable ASCII only, at most 64 characters.
export function clientName(info) {
  const parts = isObject(info) ? [info.name, info.version].filter((part) => typeof part === 'string') : [];
  const text = parts.join(' ').replace(/[^\x20-\x7e]/g, '').slice(0, CLIENT_MAX).trim();
  return text === '' ? UNKNOWN_CLIENT : text;
}

// What the listener keeps per client address, in memory: the record, the wrong tokens of the last window, the block,
// the refused events, and the open connections. changed is called after every change, for listen.json.
export function clientBook({ limits, onEvent, changed }) {
  const records = new Map();
  const open = new Map();
  // The first wrong tokens reported at once since the last tick.
  let reportedNow = 0;

  // The address whose record makes room at maxClients: the one seen first that is neither blocked nor connected, else
  // the one seen first that is not connected, else the one seen first. So a block is not lost to new addresses.
  function droppedAt(ms) {
    const all = [...records.values()];
    const idle = (record) => !open.has(record.from);
    return (all.find((record) => idle(record) && record.blockedUntil <= ms) ?? all.find(idle) ?? all[0]).from;
  }

  // The record of an address, made on first need; at maxClients records, another one is dropped first.
  function recordOf(from, at) {
    let record = records.get(from);
    if (record === undefined) {
      if (records.size >= limits.maxClients) records.delete(droppedAt(at.getTime()));
      record = {
        from,
        client: UNKNOWN_CLIENT,
        firstSeen: at.toISOString(),
        lastCall: null,
        calls: 0,
        projects: [],
        wrong: 0,
        recent: [],
        blockedUntil: 0,
        // null: nothing waits for the report timer; a number: the wrong tokens it will report.
        unreported: null,
        announced: false,
      };
      records.set(from, record);
    }
    return record;
  }

  return {
    opened(from) {
      open.set(from, (open.get(from) ?? 0) + 1);
      changed();
    },
    closed(from) {
      const left = open.get(from) - 1;
      if (left === 0) open.delete(from);
      else open.set(from, left);
      changed();
    },
    openOf(from) {
      return open.get(from) ?? 0;
    },
    // The time left of the block of an address, 0 when it is not blocked.
    blockedMs(from, at) {
      const record = records.get(from);
      return record === undefined ? 0 : Math.max(0, record.blockedUntil - at.getTime());
    },
    wrong(from, at) {
      const record = recordOf(from, at);
      const ms = at.getTime();
      record.wrong += 1;
      record.recent = [...record.recent.filter((time) => ms - time < limits.wrongWindowMs), ms];
      if (record.recent.length >= limits.wrongMax) {
        record.blockedUntil = ms + limits.blockMs;
        record.recent = [];
      }
      // The first wrong token of an address that has nothing waiting is reported at once, while fewer than
      // REFUSED_PER_TICK were reported at once since the last tick; any other one waits for the timer.
      if (record.unreported === null && reportedNow < REFUSED_PER_TICK) {
        reportedNow += 1;
        record.unreported = 0;
        onEvent({ type: 'refused', from, count: 1 });
      } else {
        record.unreported = (record.unreported ?? 0) + 1;
      }
      changed();
    },
    // One tick of the report timer, which starts a new window: a refused event for each address with wrong tokens that
    // are not reported yet, at most REFUSED_PER_TICK of them, then one event for the other addresses. An address
    // reported now still waits, for the next tick; one with nothing new since the last tick has nothing waiting any more.
    report() {
      reportedNow = 0;
      const due = [];
      for (const record of records.values()) {
        if (record.unreported === 0) {
          record.unreported = null;
        } else if (record.unreported !== null) {
          due.push({ type: 'refused', from: record.from, count: record.unreported });
          record.unreported = 0;
        }
      }
      const rest = due.splice(REFUSED_PER_TICK);
      if (rest.length > 0) {
        const others = `${rest.length} other ${rest.length === 1 ? 'address' : 'addresses'}`;
        due.push({ type: 'refused', from: others, count: rest.reduce((sum, event) => sum + event.count, 0) });
      }
      for (const event of due) onEvent(event);
    },
    named(from, client, at) {
      recordOf(from, at).client = client;
      changed();
    },
    // One message handed on: counted, with its project, and the first one of an address gives the connected event.
    // Gives the client name for the origin of the call.
    called(from, project, at) {
      const record = recordOf(from, at);
      record.calls += 1;
      record.lastCall = at.toISOString();
      if (!record.projects.includes(project)) record.projects.push(project);
      if (!record.announced) {
        record.announced = true;
        onEvent({
          type: 'connected', from, client: record.client, project,
        });
      }
      changed();
      return record.client;
    },
    list() {
      return [...records.values()].map((record) => ({
        from: record.from,
        client: record.client,
        firstSeen: record.firstSeen,
        lastCall: record.lastCall,
        calls: record.calls,
        projects: [...record.projects],
        open: open.get(record.from) ?? 0,
        wrong: record.wrong,
      }));
    },
  };
}

// The pid of a live listener that listen.json names, else null: no file, one that cannot be read, a dead pid or a pid
// that now belongs to another program.
function livePid(file) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return isObject(record) && isLive({ pid: record.pid, processStartedAt: record.processStartedAt }) ? record.pid : null;
}

// The pid of the live listener of this state folder, or null.
export function liveListener(env) {
  return livePid(listenPath(env));
}

const listenText = (record) => `${JSON.stringify(record, null, 2)}\n`;

// Makes listen.json with an exclusive create, in its folder: null once it is made, else the error, such as EEXIST
// when a file is there already.
function createListen(file, text) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
    return null;
  } catch (err) {
    return err;
  }
}

const cannotWrite = (file, err) => new Error(`cannot write ${file}: ${err.message}`);
const listeningText = (pid) => `another ksproxy start is listening (pid ${pid})`;

// Throws when the file names a live listener.
function refuseLive(file) {
  const pid = livePid(file);
  if (pid !== null) throw new Error(listeningText(pid));
}

// Moves the file in the way to listen.json.PID.RANDOM.old, a name of this process alone, then removes it. ENOENT:
// another start moved it first, and nothing is left to move. When what was moved names a live listener, another start
// made its claim just before the rename: that claim is put back, and this start is refused.
function moveAside(file) {
  const old = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.old`;
  try {
    fs.renameSync(file, old);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw cannotWrite(file, err);
  }
  const pid = livePid(old);
  if (pid !== null) {
    fs.renameSync(old, file);
    throw new Error(listeningText(pid));
  }
  removeListen(old);
}

// Claims listen.json for this process before anything listens, so two starts can never both listen. A file that names
// a live listener refuses; any other file there is moved aside, then the claim is made again, once. Of two starts that
// find the same dead file, one claims and the other finds that claim at its own create, and is refused.
function claimListen(file, text) {
  let failure = createListen(file, text);
  if (failure !== null && failure.code === 'EEXIST') {
    refuseLive(file);
    moveAside(file);
    failure = createListen(file, text);
    if (failure !== null && failure.code === 'EEXIST') refuseLive(file);
  }
  if (failure !== null) throw cannotWrite(file, failure);
}

// Writes listen.json after the claim; a failure leaves the listener running, and the next change tries again.
function writeListen(file, record) {
  try {
    ensureDir(path.dirname(file));
    writeFileAtomic(file, listenText(record));
  } catch {
    // status does not see the change until a write works
  }
}

function removeListen(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // a folder that was in the place of the file: it stays under the name it was moved to
  }
}

// Removes listen.json at the close, only while it names this process: a file that another start put there stays.
function releaseListen(file) {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no file, or one that is not JSON: it is not this listener's
  }
  if (isObject(record) && record.pid === process.pid) removeListen(file);
}

// One tick of the refused events. An onEvent that throws, such as for a terminal that is gone, loses the events of this
// tick and never stops the listener.
function reportRefused(book) {
  try {
    book.report();
  } catch {
    // the next tick reports what comes after
  }
}

// The project a path names, with the env to serve it: /mcp and /p/default/mcp are the default, /p/NAME/mcp is NAME,
// only when this start runs it; else null. A query is ignored.
function servedProject(url, projects) {
  const match = PATH_RE.exec(url.split('?')[0]);
  if (match === null) return null;
  const key = match[1] === undefined || match[1] === PROJECT_DEFAULT ? null : match[1];
  return projects.has(key) ? { name: key ?? PROJECT_DEFAULT, env: projects.get(key) } : null;
}

const bearerOf = (header) => {
  const match = BEARER_RE.exec(header ?? '');
  return match === null ? '' : match[1];
};

const mediaType = (value) => String(value).split(';')[0].trim().toLowerCase();

// A refusal: plain text, and the connection is closed after it, so a body that was not read is not read later.
function refuse(res, status, text, headers = {}) {
  res.writeHead(status, {
    ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), Connection: 'close',
  });
  res.end(text);
}

// A JSON-RPC answer, or 202 with no body when there is none.
function answer(res, status, value) {
  if (value === null) {
    res.writeHead(202, { 'Content-Length': 0 });
    res.end();
    return;
  }
  const text = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// The body, or null as soon as it is over maxBody bytes; reading stops there. Rejects when the request is cut.
function readBody(req, maxBody) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// One request, checked in this order: the path and the project, the method, an Origin header, the Host header, the
// block of the address, the token, the number of running calls, the content type, the size of the body; then the
// message. continued: the request asked for 100 Continue, which is sent only once those checks passed. A message is
// counted among the running calls from the moment it is handed to handleMessage until that settles, even when its
// client has gone: the call goes on in its session, so the limit is what bounds such calls. The message gets the signal
// of the listener, which close aborts, so a call that runs a program here ends at once.
async function serve(context, req, res, continued) {
  const {
    book, limit, now, env,
  } = context;
  const from = req.socket.remoteAddress;
  const project = servedProject(req.url, context.projects);
  if (project === null) return refuse(res, 404, 'not served here');
  if (req.method !== 'POST') return refuse(res, 405, 'only POST is served here', { Allow: 'POST' });
  if (req.headers.origin !== undefined) return refuse(res, 403, 'a request with an Origin header is refused');
  if (!context.hosts.has(hostKey(req.headers.host, context.defaultPort))) {
    return refuse(res, 421, 'the Host header does not name this listener');
  }
  const at = now();
  const blocked = book.blockedMs(from, at);
  if (blocked > 0) {
    return refuse(res, 429, 'too many wrong tokens from this address; try again later', { 'Retry-After': String(Math.ceil(blocked / 1000)) });
  }
  const verdict = checkToken(env, bearerOf(req.headers.authorization), at);
  if (verdict !== 'ok') {
    if (verdict === 'wrong') book.wrong(from, at);
    return refuse(res, 401, TOKEN_TEXT[verdict], { 'WWW-Authenticate': 'Bearer' });
  }
  noteUse(env, from, at);
  if (context.running >= limit.maxCalls) return refuse(res, 503, BUSY_TEXT, BUSY_HEADERS);
  if (mediaType(req.headers['content-type']) !== 'application/json') return refuse(res, 415, 'the body must be application/json');
  const tooLarge = `the body is over ${limit.maxBody} bytes`;
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limit.maxBody) return refuse(res, 413, tooLarge);
  if (continued) res.writeContinue();
  const body = await readBody(req, limit.maxBody);
  if (body === null) return refuse(res, 413, tooLarge);
  let message;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return answer(res, 400, PARSE_ERROR);
  }
  // Other calls may have started while the body came: the limit is checked again as the message is handed on.
  if (context.running >= limit.maxCalls) return refuse(res, 503, BUSY_TEXT, BUSY_HEADERS);
  if (isObject(message) && message.method === 'initialize') book.named(from, clientName(message.params?.clientInfo), at);
  const client = book.called(from, project.name, at);
  context.running += 1;
  let reply;
  try {
    reply = await handleMessage(message, project.env, { origin: { from, client }, signal: context.signal });
  } finally {
    context.running -= 1;
    if (context.running === 0) context.idle();
  }
  if (reply === null) return answer(res, 202, null);
  return answer(res, reply.error !== undefined && reply.id === null ? 400 : 200, reply);
}

function makeServer(tls, limit, onRequest, onContinue) {
  const options = {
    requestTimeout: limit.requestMs,
    headersTimeout: limit.requestMs,
    keepAliveTimeout: limit.idleMs,
    connectionsCheckingInterval: Math.min(1000, limit.requestMs),
    requireHostHeader: false,
  };
  const server = tls
    ? https.createServer({
      ...options, cert: tls.cert, key: tls.key, handshakeTimeout: limit.requestMs,
    }, onRequest)
    : http.createServer(options, onRequest);
  server.maxConnections = limit.maxConnections;
  // With a checkContinue listener, Node does not send 100 Continue itself: serve sends it once its checks passed.
  server.on('checkContinue', onContinue);
  return server;
}

// Listens; the error listener stays, so an error after the start, such as a failed accept, is ignored and the server
// keeps listening.
function listenOn(server, address) {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen({ host: address.host, port: address.port }, resolve);
  });
}

// Resolves once no message is being handled, or after ms, whichever comes first: serve calls context.idle when the
// running count comes to 0.
function callsEnded(context, ms) {
  if (context.running === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    context.idle = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// Stops every server and cuts every connection, a call still running included: its answer is never sent.
function shutDown(servers, sockets) {
  const closed = servers.map((server) => new Promise((resolve) => { server.close(() => resolve()); }));
  for (const socket of sockets) socket.destroy();
  return Promise.all(closed);
}

// Starts the listener on every address. addresses: values of parseListen; tls: null or { cert, key }; projects: a Map
// of project name, null for the default, to the env that serves it; env: the root env, for the token and listen.json;
// onEvent: the connected and refused events. Gives { close, clients, bound }, bound being HOST:PORT as listened on.
// listen.json is claimed before anything listens; when that fails, the start fails and nothing listens. Any failure
// after the claim, such as TLS material that cannot make a server, releases it before the error is thrown.
export async function startListener({
  addresses, tls, projects, env, onEvent, now = () => new Date(), limits = {},
}) {
  const limit = { ...LISTEN_LIMITS, ...limits };
  const started = processStartTime(process.pid);
  const file = listenPath(env);
  const state = {
    closed: false, closing: null, timer: null, reporter: null,
  };
  const aborter = new AbortController();
  const sockets = new Set();
  const bound = [];
  const record = () => ({
    version: 1,
    pid: process.pid,
    ...(started === null ? {} : { processStartedAt: started }),
    addresses: bound,
    tls: Boolean(tls),
    clients: book.list(),
  });
  const write = () => {
    state.timer = null;
    writeListen(file, record());
  };
  const changed = () => {
    if (state.closed || state.timer !== null) return;
    state.timer = setTimeout(write, limit.listenWriteMs);
    state.timer.unref();
  };
  const book = clientBook({ limits: limit, onEvent, changed });
  claimListen(file, listenText(record()));

  const context = {
    book,
    limit,
    now,
    env,
    projects,
    hosts: new Set(),
    defaultPort: tls ? 443 : 80,
    running: 0,
    signal: aborter.signal,
    idle: () => {},
  };
  const handler = (continued) => (req, res) => {
    serve(context, req, res, continued).catch(() => req.socket.destroy());
  };
  // A socket that the peer has already reset has no address: it is closed before it is counted.
  // server.maxConnections counts one server; this counts every server, and the connections of one address.
  const admit = (socket) => {
    const from = socket.remoteAddress;
    if (from === undefined || sockets.size >= limit.maxConnections || book.openOf(from) >= limit.maxPerAddress) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    book.opened(from);
    socket.on('close', () => {
      sockets.delete(socket);
      book.closed(from);
    });
  };
  const servers = [];
  try {
    for (const server of addresses.map(() => makeServer(tls, limit, handler(false), handler(true)))) {
      server.on('connection', admit);
      servers.push(server);
    }
    for (const [i, server] of servers.entries()) {
      await listenOn(server, addresses[i]);
      const { port } = server.address();
      bound.push(`${hostText(addresses[i].host, addresses[i].family)}:${port}`);
      for (const key of allowedHosts(addresses[i], port)) context.hosts.add(key);
    }
  } catch (err) {
    await shutDown(servers, sockets);
    releaseListen(file);
    throw err;
  }
  write();
  state.reporter = setInterval(() => reportRefused(book), limit.wrongWindowMs);
  state.reporter.unref();

  // The close: the signal of every message is aborted first, so a program that a call runs here is killed, then the
  // close waits until no message is being handled, at most closeWaitMs, then stops the servers. A brokered call ends
  // when its session stops, after this close. Every caller gets the same close.
  async function closeOnce() {
    state.closed = true;
    clearTimeout(state.timer);
    clearInterval(state.reporter);
    aborter.abort();
    await callsEnded(context, limit.closeWaitMs);
    await shutDown(servers, sockets);
    releaseListen(file);
  }
  function close() {
    if (state.closing === null) state.closing = closeOnce();
    return state.closing;
  }

  return { close, clients: () => book.list(), bound: [...bound] };
}
