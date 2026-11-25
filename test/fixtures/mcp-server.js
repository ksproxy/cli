#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// A stand-in MCP server for the tests. Run as a program, it speaks MCP over stdio: one JSON message per line on stdin
// and stdout. Its behaviour comes from one argument, a JSON object of options:
//   era: 'modern' (2026-07-28, the default) or 'legacy' (initialize first).
//   A modern server answers initialize as initializeError says: 'method-not-found' (the default),
//   'unsupported-version' or 'not-json'. A legacy server answers initialize with version (2025-11-25), or as
//   initialize says: 'refuse' or 'no-version'; with unknownMethod 'exit' it exits on a method it does not know.
//   tools: a number of made-up tools (3) or a list of tool definitions; pageSize: tools per page (all);
//   listAnswer: a raw answer to tools/list in place of the page, or 'endless' for a line that never ends; slowListMs;
//   fatPages: every page of tools/list is one new tool whose description has this many characters, with a nextCursor.
//   askInput: true or the method of a request to the client; pingClient: a ping request before a call is answered;
//   notify: notifications and lines a client must drop before a call is answered; image; isError; rpcError: the
//   message of an error answer to a call; callAnswer: a raw answer to a call; callLine: 'not-json' or 'endless' (until
//   the call is cancelled); bigAnswer: the length of a call's text; slowStartMs; slowCallMs; pingError;
//   floodOnPing: the length of a notification line written before a ping is answered.
//   stderrText, stderrRepeat: text written to stderr at start; exitAfter: exit once this many requests are answered;
//   exitAt: exit when this request arrives, without answering it; exitCode (3); onStdinEnd: 'exit' (the default) or
//   'stay'; onTerm: 'exit' (the default) or 'ignore'; child: start a program that sleeps in the same process group;
//   deaf: close stdin at once without reading it, write an answer to initialize, and stay.
//   record: a file that gets one JSON line for the start, each message received, each answer sent, each signal and
//   the end of stdin.
//   secretVar: in the options and in each line received, every @SECRET@ is the value of that variable of its
//   environment, so that a test makes it print a secret that is in neither its arguments nor the call; every
//   @SECRET_JSON@ is that value as JSON writes it inside a string.
//   A call steers stdin with standIn in its arguments (stdio only): askFlood (stop reading stdin, write so many requests
//   to the client, answer the call, and read stdin again once the file resume exists) and countAnswers (answer with how
//   many answers to those requests were read).
// createStandIn holds the behaviour without the transport; startHttpStandIn puts it behind a loopback HTTP server.

export const MODERN = '2026-07-28';
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const INFO = { name: 'stand-in', version: '1.0.0' };
const KNOWN = ['initialize', 'ping', 'tools/list', 'tools/call'];

export function toolList(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${i + 1}`,
    description: `Tool number ${i + 1}`,
    inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
  }));
}

// io: send(message, forId), raw(text, forId), endless(forId) (starts a line that goes on until the function it returns
// ends it), record(entry), exit(code), and for stdio askFlood(count, resume, done). forId is the request a message belongs
// to, for the HTTP mode; stdio ignores it.
export function createStandIn(options, io) {
  const era = options.era ?? 'modern';
  const tools = Array.isArray(options.tools) ? options.tools : toolList(options.tools ?? 3);
  const serverInfo = options.serverInfo ?? INFO;
  let initialized = false;
  let received = 0;
  let answered = 0;
  let floodAnswers = 0;
  let asking = null;
  let endlessFor = null;
  let endLine = () => {};
  const slowCalls = new Map();

  const answer = (id, body) => {
    io.send({ jsonrpc: '2.0', id, ...body }, id);
    io.record({ answered: id });
    answered += 1;
    if (answered === options.exitAfter) io.exit(options.exitCode ?? 3);
  };
  const result = (id, value) => answer(id, { result: era === 'modern' ? { ...value, resultType: 'complete' } : value });
  const error = (id, code, message) => answer(id, { error: { code, message } });

  const noise = (forId) => {
    io.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } }, forId);
    io.send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'working' } }, forId);
    io.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, forId);
    io.send({ jsonrpc: '2.0', id: null, method: 'notifications/odd' }, forId);
    io.send({ jsonrpc: '2.0', id: 999, result: { content: [] } }, forId);
    io.raw('42\n[1, 2]\nnull\n\n   \n', forId);
  };

  const ask = (id, mode) => {
    const method = typeof mode.askInput === 'string' ? mode.askInput : 'elicitation/create';
    const params = { message: 'Which project?', requestedSchema: { type: 'object', properties: {} } };
    if (era === 'modern') {
      answer(id, { result: { resultType: 'input_required', inputRequests: { ask: { method, params } } } });
      return;
    }
    asking = id;
    io.send({ jsonrpc: '2.0', id: 'ask-1', method, params }, id);
  };

  // A call may steer its own answer: the options in its argument standIn win over the server's.
  const call = (id, params) => {
    slowCalls.delete(id);
    const mode = { ...options, ...(params.arguments?.standIn ?? {}) };
    if (mode.notify) noise(id);
    if (mode.pingClient) io.send({ jsonrpc: '2.0', id: 'ping-1', method: 'ping' }, id);
    if (mode.rpcError !== undefined) {
      error(id, -32602, mode.rpcError);
    } else if (mode.callAnswer !== undefined) {
      answer(id, mode.callAnswer);
    } else if (mode.callLine === 'not-json') {
      io.raw(`{"jsonrpc": "2.0", "id": ${id}, "result": \n`, id);
    } else if (mode.callLine === 'endless') {
      endlessFor = id;
      endLine = io.endless(id);
    } else if (mode.askInput) {
      ask(id, mode);
    } else if (mode.askFlood) {
      io.askFlood(mode.askFlood, mode.resume, () => result(id, { content: [{ type: 'text', text: `asked ${mode.askFlood} times` }] }));
    } else if (mode.countAnswers) {
      result(id, { content: [{ type: 'text', text: `read ${floodAnswers} answers` }] });
    } else {
      const value = mode.bigAnswer ? 'x'.repeat(mode.bigAnswer) : `called ${params.name} with ${JSON.stringify(params.arguments)}`;
      const content = [{ type: 'text', text: value }];
      if (mode.image) content.push({ type: 'image', data: Buffer.from('not a picture').toString('base64'), mimeType: 'image/png' });
      result(id, { content, isError: mode.isError === true });
    }
  };

  const list = (id, params) => {
    if (options.listAnswer === 'endless') {
      io.endless(id);
    } else if (options.fatPages) {
      const page = Number(params.cursor ?? 0) + 1;
      result(id, { tools: [{ name: `fat_${page}`, description: 'f'.repeat(options.fatPages), inputSchema: { type: 'object' } }], nextCursor: String(page) });
    } else if (options.listAnswer !== undefined) {
      answer(id, options.listAnswer);
    } else {
      const start = Number(params.cursor ?? 0);
      const size = options.pageSize ?? tools.length;
      const next = start + size < tools.length ? { nextCursor: String(start + size) } : {};
      result(id, { tools: tools.slice(start, start + size), ...next });
    }
  };

  const modernInitialize = (id) => {
    if (options.initializeError === 'unsupported-version') error(id, -32602, 'Unsupported protocol version');
    else if (options.initializeError === 'not-json') io.raw('Server starting, please wait\n', id);
    else error(id, -32601, 'Method not found');
  };

  const legacyInitialize = (id) => {
    if (options.initialize === 'refuse') error(id, -32602, 'Unsupported protocol version \u001b[31mred\u001b[0m');
    else if (options.initialize === 'no-version') result(id, { capabilities: {}, serverInfo });
    else result(id, { protocolVersion: options.version ?? '2025-11-25', capabilities: { tools: {} }, serverInfo });
  };

  const ping = (id) => {
    if (options.floodOnPing) io.raw(`{"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": "${'y'.repeat(options.floodOnPing)}"}}\n`, id);
    if (options.pingError) error(id, -32603, 'ping failed');
    else result(id, {});
  };

  const request = ({ id, method, params = {} }) => {
    if (era === 'modern') {
      if (method === 'initialize') return modernInitialize(id);
      if (params._meta?.[VERSION_KEY] !== MODERN) return error(id, -32600, 'the request has no protocol version');
      if (method === 'server/discover') return result(id, { supportedVersions: [MODERN], capabilities: { tools: {} }, serverInfo });
    } else {
      if (!KNOWN.includes(method) && options.unknownMethod === 'exit') return io.exit(1);
      if (method === 'initialize') return legacyInitialize(id);
      if (!initialized) return error(id, -32002, 'Server not initialized');
    }
    if (method === 'ping') return ping(id);
    if (method === 'tools/list') {
      if (options.slowListMs) setTimeout(() => list(id, params), options.slowListMs);
      else list(id, params);
      return undefined;
    }
    if (method === 'tools/call') {
      if (options.slowCallMs) slowCalls.set(id, setTimeout(() => call(id, params), options.slowCallMs));
      else call(id, params);
      return undefined;
    }
    return error(id, -32601, 'Method not found');
  };

  const notification = ({ method, params = {} }) => {
    if (method === 'notifications/initialized') initialized = true;
    if (method === 'notifications/cancelled') {
      clearTimeout(slowCalls.get(params.requestId));
      slowCalls.delete(params.requestId);
      if (endlessFor === params.requestId) {
        endlessFor = null;
        endLine();
      }
    }
  };

  return {
    // Every slow call is dropped and an endless line ended, so that nothing keeps the process alive.
    stop() {
      for (const timer of slowCalls.values()) clearTimeout(timer);
      slowCalls.clear();
      endLine();
    },
    receive(message) {
      io.record({ got: message });
      if (typeof message.method !== 'string') {
        if (message.id === 'flood') floodAnswers += 1;
        if (message.id === 'ask-1' && asking !== null) {
          const id = asking;
          asking = null;
          result(id, { content: [{ type: 'text', text: 'answered after asking' }], isError: false });
        }
        return;
      }
      if (message.id === undefined) {
        notification(message);
        return;
      }
      received += 1;
      if (received === options.exitAt) {
        io.exit(options.exitCode ?? 3);
        return;
      }
      request(message);
    },
  };
}

// The body of every HTTP error and redirect of the HTTP mode: a client must never show it.
export const ERROR_BODY = 'the stand-in error body mcp-B0DY-9f3c-unmistakable';

// A write to an answer the client may have closed already.
function put(res, text) {
  if (!res.writableEnded && !res.destroyed) res.write(text);
}

const event = (message) => `data: ${JSON.stringify(message)}\n\n`;
const note = (n) => event({ jsonrpc: '2.0', method: 'notifications/message', params: { data: `note ${n}` } });

// The HTTP mode: createStandIn behind a server on 127.0.0.1 at a free port, path /mcp, in the test's own process. Each
// POST holds one message; what createStandIn sends for a request goes to that request's answer, a JSON body or, with
// sse, an SSE stream (in a JSON body only the answer itself is sent; raw lines go to a stream only). A notification or
// an answer from the client gets 202. The options of createStandIn apply, and:
//   sse: answer each request with an SSE stream; keepOpen: keep the stream open after the answer.
//   A legacy server (era 'legacy') gives an Mcp-Session-Id at initialize unless sessions is false, and wants it on every
//   later message; one without it gets legacyAnswer: '400-session-required' (the default), '404', '405' or
//   'method-not-found'; an unknown one gets 404. expireAt: the numbers of the requests that carry a known session (1 is
//   the first) at which that session is dropped with a 404; slowRenewMs: every initialize after the first waits so long;
//   sessionId: the id to give in place of session-1, session-2 and so on.
//   A modern server checks MCP-Protocol-Version, Mcp-Method, Mcp-Name and the Mcp-Param header of each x-mcp-header
//   property against the body, and answers 400 with -32020 when one differs.
//   deleteAnswer: the status of DELETE (200); hang: what is never answered: a method, 'DELETE', or 'answers' (the
//   client's answers to the server's requests); redirect: every request gets 307 to /elsewhere; echoAuth: a JSON-RPC
//   error that holds the request's Authorization header; html: an HTML page; status with retryAfter: that status, with
//   ERROR_BODY as the body of a 3xx or an error, and a location for a 3xx.
//   A call steers its own answer with standIn in its arguments: those options, and delayMs (before an answer of the HTTP
//   layer), wrongId (a JSON answer to another id), and in an SSE stream: closeEarly, destroyEarly, trickleMs (a
//   notification so often and never an answer), flood (so many notifications before the answer), requests (so many
//   pings from the server before the answer), bigEvent (one notification of about so many bytes in many data lines),
//   foreign (an
//   answer to every other open request first).
// log holds each HTTP request ({ request: { method, path, headers, message } }), each answer the client closed before
// its end ({ closedEarly: id }) and what createStandIn records. Nothing of it is printed. options stays live: a test may
// change it between requests.
export async function startHttpStandIn(options = {}) {
  // Loaded here only: the stdio program's deaf mode closes descriptor 0, which node:http, once loaded, does not survive.
  const { default: http } = await import('node:http');
  const legacy = options.era === 'legacy';
  const tools = Array.isArray(options.tools) ? options.tools : toolList(options.tools ?? 3);
  const log = [];
  const live = new Map();
  const known = new Set();
  let issued = 0;
  let initializes = 0;
  let carried = 0;
  let base = '';
  let server;

  const io = {
    send(message, forId) {
      const stream = live.get(forId);
      if (stream === undefined) return;
      if (stream.sse) put(stream.res, event(message));
      if (message.method !== undefined || message.id !== forId) return;
      live.delete(forId);
      if (!stream.sse) {
        stream.res.writeHead(200, { 'content-type': 'application/json', ...stream.head });
        stream.res.end(JSON.stringify(message));
      } else if (stream.keepOpen) {
        const timer = setInterval(() => put(stream.res, ': still here\n\n'), 20);
        stream.res.on('close', () => clearInterval(timer));
      } else {
        stream.res.end();
      }
    },
    raw(text, forId) {
      const stream = live.get(forId);
      if (stream?.sse) put(stream.res, text.split('\n').map((line) => `data: ${line}\n\n`).join(''));
    },
    endless(forId) {
      const stream = live.get(forId);
      if (stream === undefined) return () => {};
      const { res } = stream;
      let over = false;
      const chunk = 'x'.repeat(65536);
      const step = () => {
        if (over || res.destroyed) return;
        if (res.write(chunk)) setImmediate(step);
        else res.once('drain', step);
      };
      if (stream.sse) {
        res.write('data: {"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": "');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write(`{"jsonrpc": "2.0", "id": ${forId}, "result": {"content": [{"type": "text", "text": "`);
      }
      step();
      return () => {
        over = true;
        if (!res.destroyed) res.end(stream.sse ? '"}}\n\n' : '"}]}}');
      };
    },
    record: (entry) => log.push(entry),
    exit: () => server.closeAllConnections(),
  };
  const standIn = createStandIn(options, io);

  // What an SSE stream gets before createStandIn answers; true when the stream gets no answer at all.
  const shape = (mode, id, { res }) => {
    if (mode.foreign) {
      for (const other of live.keys()) {
        if (other !== id) put(res, event({ jsonrpc: '2.0', id: other, result: { content: [{ type: 'text', text: 'foreign' }] } }));
      }
    }
    if (mode.flood) put(res, Array.from({ length: mode.flood }, (_, n) => note(n)).join(''));
    if (mode.requests) put(res, Array.from({ length: mode.requests }, (_, n) => event({ jsonrpc: '2.0', id: `flood-${n}`, method: 'ping' })).join(''));
    if (mode.bigEvent) {
      const lines = `data: "${'x'.repeat(91)}",\n`.repeat(Math.ceil(mode.bigEvent / 101));
      put(res, `data: {"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": [\n${lines}data: 0]}}\n\n`);
    }
    if (mode.closeEarly) {
      put(res, note(0));
      res.end();
      return true;
    }
    if (mode.destroyEarly) {
      put(res, note(0));
      setTimeout(() => res.destroy(), 20);
      return true;
    }
    if (mode.trickleMs) {
      const timer = setInterval(() => put(res, note(1)), mode.trickleMs);
      res.on('close', () => clearInterval(timer));
      return true;
    }
    return false;
  };

  // A legacy server's session rule; true when it answered the request itself.
  const sessionRefusal = (req, message, plain, rpcError) => {
    if (options.sessions === false || message.method === 'initialize') return false;
    const id = req.headers['mcp-session-id'];
    if (id === undefined) {
      const answer = options.legacyAnswer ?? '400-session-required';
      if (answer === '404') plain(404, {}, ERROR_BODY);
      else if (answer === '405') plain(405, { allow: 'GET, DELETE' }, ERROR_BODY);
      else if (answer === 'method-not-found') rpcError(200, -32601, 'Method not found');
      else rpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return true;
    }
    if (!known.has(id)) {
      plain(404, {}, ERROR_BODY);
      return true;
    }
    if (message.id === undefined || typeof message.method !== 'string') return false;
    carried += 1;
    if (!(options.expireAt ?? []).includes(carried)) return false;
    known.delete(id);
    plain(404, {}, ERROR_BODY);
    return true;
  };

  // A modern server's header rule; true when it answered the request itself.
  const headerRefusal = (req, message, rpcError) => {
    if (typeof message.method !== 'string') return false;
    const mismatch = (what) => {
      rpcError(400, -32020, `HeaderMismatch: ${what}`);
      return true;
    };
    if (req.headers['mcp-protocol-version'] !== MODERN) return mismatch('MCP-Protocol-Version');
    if (req.headers['mcp-method'] !== message.method) return mismatch('Mcp-Method');
    if (message.method !== 'tools/call') return false;
    if (req.headers['mcp-name'] !== message.params.name) return mismatch('Mcp-Name');
    const tool = tools.find((item) => item?.name === message.params.name);
    for (const [property, schema] of Object.entries(tool?.inputSchema?.properties ?? {})) {
      const header = schema?.['x-mcp-header'];
      if (typeof header === 'string') {
        const value = message.params.arguments?.[property];
        const expected = value === undefined ? undefined : String(value);
        if (req.headers[`mcp-param-${header.toLowerCase()}`] !== expected) return mismatch(`Mcp-Param-${header}`);
      }
    }
    return false;
  };

  const handle = (req, res, text) => {
    let message = null;
    try {
      message = JSON.parse(text);
    } catch {
      // kept as null
    }
    log.push({
      request: {
        method: req.method, path: req.url, headers: req.headers, message,
      },
    });
    const mode = message?.method === 'tools/call' ? { ...options, ...(message.params?.arguments?.standIn ?? {}) } : options;
    const plain = (status, headers = {}, body = '') => {
      const go = () => {
        if (res.destroyed) return;
        res.writeHead(status, headers);
        res.end(body);
      };
      if (mode.delayMs) setTimeout(go, mode.delayMs);
      else go();
    };
    const rpcError = (status, code, text2) => plain(status, { 'content-type': 'application/json' }, JSON.stringify({
      jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text2 },
    }));
    const what = req.method === 'DELETE' ? 'DELETE' : (message?.method ?? 'answers');
    if (req.url !== '/mcp') return plain(404, {}, ERROR_BODY);
    if ((options.hang ?? []).includes(what)) return undefined;
    if (options.redirect) return plain(307, { location: `${base}/elsewhere` }, ERROR_BODY);
    if (req.method === 'DELETE') {
      known.delete(req.headers['mcp-session-id']);
      return plain(options.deleteAnswer ?? 200);
    }
    if (message === null || typeof message !== 'object') return plain(400, {}, ERROR_BODY);
    if (mode.status !== undefined) {
      const headers = {};
      if (mode.retryAfter !== undefined) headers['retry-after'] = mode.retryAfter;
      if (mode.status >= 300 && mode.status < 400) headers.location = `${base}/elsewhere`;
      return plain(mode.status, headers, mode.status >= 300 ? ERROR_BODY : '');
    }
    if (mode.echoAuth) return rpcError(200, -32001, `the credential ${req.headers.authorization} is refused`);
    if (mode.html) return plain(200, { 'content-type': 'text/html' }, '<html>sign in</html>');
    if (mode.wrongId) return plain(200, { 'content-type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id: 12345, result: {} }));
    if (legacy ? sessionRefusal(req, message, plain, rpcError) : headerRefusal(req, message, rpcError)) return undefined;
    const head = {};
    if (message.method === 'initialize') {
      initializes += 1;
      if (legacy && options.sessions !== false) {
        issued += 1;
        head['mcp-session-id'] = options.sessionId ?? `session-${issued}`;
        known.add(head['mcp-session-id']);
      }
    }
    if (message.id === undefined || typeof message.method !== 'string') {
      plain(202);
      standIn.receive(message);
      return undefined;
    }
    const stream = {
      res, sse: mode.sse === true, keepOpen: mode.keepOpen === true, head,
    };
    live.set(message.id, stream);
    // A modern server takes a stream the client closed before its end as the cancel of that request.
    res.on('close', () => {
      if (!res.writableEnded) {
        log.push({ closedEarly: message.id });
        if (!legacy) standIn.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: message.id } });
      }
      if (live.get(message.id) === stream) live.delete(message.id);
    });
    if (stream.sse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...head });
      res.flushHeaders();
      if (shape(mode, message.id, stream)) return undefined;
    }
    if (message.method === 'initialize' && initializes > 1 && options.slowRenewMs) setTimeout(() => standIn.receive(message), options.slowRenewMs);
    else standIn.receive(message);
    return undefined;
  };

  server = http.createServer((req, res) => {
    res.on('error', () => {});
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    base,
    log,
    options,
    requests: () => log.filter((entry) => entry.request !== undefined).map((entry) => entry.request),
    close: () => new Promise((resolve) => {
      standIn.stop();
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

function runStdio(given) {
  // Each form as it goes inside the JSON text of a line, so that the line, once parsed, holds the value, or the value as
  // JSON writes it inside a string.
  const secret = given.secretVar === undefined ? null : JSON.stringify(process.env[given.secretVar] ?? '').slice(1, -1);
  const escaped = secret === null ? null : JSON.stringify(secret).slice(1, -1);
  const fill = (text) => (secret === null ? text : text.replaceAll('@SECRET_JSON@', escaped).replaceAll('@SECRET@', secret));
  const options = JSON.parse(fill(JSON.stringify(given)));
  const record = (entry) => {
    if (options.record) fs.appendFileSync(options.record, `${JSON.stringify(entry)}\n`);
  };
  record({ event: 'start', pid: process.pid, cwd: process.cwd(), env: process.env });
  process.on('SIGTERM', () => {
    record({ event: 'signal', name: 'SIGTERM' });
    if (options.onTerm !== 'ignore') {
      process.removeAllListeners('SIGTERM');
      process.kill(process.pid, 'SIGTERM');
    }
  });
  for (let i = 0; i < (options.stderrRepeat ?? 1) && options.stderrText; i += 1) process.stderr.write(options.stderrText);
  if (options.child) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' });
    record({ event: 'child', pid: child.pid });
  }
  if (options.deaf) {
    // Node never opened stdin, so closing it here is safe; a client's next write finds no reader.
    fs.closeSync(0);
    const result = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: INFO };
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n`);
    setInterval(() => {}, 1 << 30);
    return;
  }

  const io = {
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    raw: (value) => process.stdout.write(value),
    record,
    exit: (code) => process.stdout.write('', () => process.exit(code)),
    // The line is ended at once when asked, so that nothing written later lands inside it.
    endless: () => {
      const chunk = 'x'.repeat(65536);
      let over = false;
      const step = () => {
        if (over) return;
        if (process.stdout.write(chunk)) setImmediate(step);
        else process.stdout.once('drain', step);
      };
      process.stdout.write('{"jsonrpc": "2.0", "method": "notifications/message", "params": {"data": "');
      step();
      return () => {
        over = true;
        process.stdout.write('"}}\n');
      };
    },
    // stdin is no longer read, so what the client writes waits on its side; the requests go out as fast as stdout
    // drains, then the call is answered, and stdin is read again once the file resume exists.
    askFlood: (count, resume, done) => {
      process.stdin.pause();
      const line = `${JSON.stringify({ jsonrpc: '2.0', id: 'flood', method: 'sampling/createMessage', params: {} })}\n`;
      let left = count;
      const pump = () => {
        while (left > 0) {
          const now = Math.min(left, 1000);
          left -= now;
          if (!process.stdout.write(line.repeat(now))) {
            process.stdout.once('drain', pump);
            return;
          }
        }
        done();
        const timer = setInterval(() => {
          if (!fs.existsSync(resume)) return;
          clearInterval(timer);
          process.stdin.resume();
        }, 20);
      };
      pump();
    },
  };
  const standIn = createStandIn(options, io);
  const ready = new Promise((resolve) => {
    setTimeout(resolve, options.slowStartMs ?? 0);
  });
  const handle = (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(fill(line));
    } catch {
      record({ bad: line });
      return;
    }
    standIn.receive(message);
  };

  let rest = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    rest += chunk;
    for (let at = rest.indexOf('\n'); at !== -1; at = rest.indexOf('\n')) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      ready.then(() => handle(line));
    }
  });
  process.stdin.on('end', () => {
    record({ event: 'stdin-end' });
    if (options.onStdinEnd === 'stay') setInterval(() => {}, 1 << 30);
    else ready.then(() => io.exit(0));
  });
}

// The options as one JSON argument, or @FILE for a file that holds them, for options too long for one argument.
const optionsText = (arg = '{}') => (arg.startsWith('@') ? fs.readFileSync(arg.slice(1), 'utf8') : arg);

if (process.argv[1] === fileURLToPath(import.meta.url)) runStdio(JSON.parse(optionsText(process.argv[2])));
