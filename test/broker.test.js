import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  CALL_FAILED, MAX_ANSWER_BYTES, MAX_CALL_BYTES, askCall, callRefusal, callSocketOpen, sendAndClose, startCallServer,
} from '../src/broker.js';
import { tempDir } from './temp.js';

const call = (extra = {}) => ({
  kind: 'vault', name: 'v1', input: 'say hi', timeoutSeconds: 5, ...extra,
});
const refused = (why, word = 'vault', name = 'v1') => ({ text: `REFUSED (${word} ${name}): ${why}`, isError: true });
const plain = (why) => ({ text: `REFUSED: ${why}`, isError: true });

function tmp() {
  return fs.realpathSync(tempDir('ks-brk-'));
}

async function withServer(handle, body, options = {}) {
  const dir = tmp();
  const socket = path.join(dir, 'call-sock');
  const server = await startCallServer({ socket, handle, requestTimeoutMs: options.requestTimeoutMs });
  try {
    await body(socket, dir);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withRawServer(onConnection, body) {
  const dir = tmp();
  const socket = path.join(dir, 's');
  const open = new Set();
  const server = net.createServer((conn) => {
    open.add(conn);
    conn.on('close', () => open.delete(conn));
    conn.on('error', () => {});
    onConnection(conn);
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    await body(socket);
  } finally {
    for (const conn of open) conn.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function raw(socket, text, { end = false } = {}) {
  return new Promise((resolve) => {
    let got = '';
    const conn = net.connect(socket, () => {
      if (end) conn.end(text);
      else conn.write(text);
    });
    conn.setEncoding('utf8');
    conn.on('data', (c) => { got += c; });
    conn.on('close', () => resolve(got));
    conn.on('error', () => {});
  });
}

test('the fixed texts are defined once and a refusal names the target when it can', () => {
  assert.deepEqual(CALL_FAILED, {
    noAnswer: 'the session did not answer',
    timedOut: 'the session did not answer in time',
    unsendable: 'the call could not be sent',
    replyTooLarge: 'the answer is too large',
    badReply: 'the answer could not be read',
    badRequest: 'the call could not be read',
    failed: 'the call failed inside the session',
    notOpen: 'this target is not open in the session',
  });
  assert.equal(MAX_CALL_BYTES, 256 * 1024);
  assert.equal(MAX_ANSWER_BYTES, 16 * 1024 * 1024);
  assert.deepEqual(callRefusal(CALL_FAILED.failed), plain(CALL_FAILED.failed));
  assert.deepEqual(callRefusal(CALL_FAILED.failed, 'vault', 'x'.repeat(100)), {
    text: `REFUSED (vault ${'x'.repeat(63)}…): the call failed inside the session`, isError: true,
  });
});

test('a good call reaches the handler with the request and a signal, and its answer comes back; the socket is private', async () => {
  const seen = [];
  await withServer(async (request, signal) => {
    seen.push({ request, aborted: signal.aborted });
    return { text: `did ${request.input}`, isError: false };
  }, async (socket, dir) => {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    assert.ok(fs.statSync(dir).isDirectory());
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'did say hi', isError: false });
    assert.deepEqual(await askCall(socket, call({ input: ['a', 'b'] }), 2000, 'vault'), { text: 'did a,b', isError: false });
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'did say hi', isError: false });
  });
  assert.deepEqual(seen[0], { request: call(), aborted: false });
  assert.deepEqual(seen[1].request.input, ['a', 'b']);
  assert.equal(seen.length, 3);
});

test('a handler that throws, rejects or answers with a wrong shape is a refusal with the fixed text, never the error', async () => {
  const answers = [
    () => { throw new Error('/secret/path SECRET=1'); },
    async () => { throw new Error('/secret/path SECRET=1'); },
    async () => null,
    async () => ({ text: 1, isError: false }),
    async () => ({ text: 'x', isError: 'no' }),
    async () => 'just text',
  ];
  let i = 0;
  await withServer((...args) => answers[i](...args), async (socket) => {
    for (i = 0; i < answers.length; i += 1) {
      const reply = await askCall(socket, call(), 2000, 'vault');
      assert.deepEqual(reply, plain(CALL_FAILED.failed), String(i));
      assert.ok(!reply.text.includes('SECRET'));
    }
  });
});

test('a request with a wrong shape is refused by the server before the handler', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { text: 'ran', isError: false };
  }, async (socket) => {
    const bad = [
      null, [], 'text', 5,
      { name: 'v1', input: 'x', timeoutSeconds: 5 },
      call({ kind: 1 }), call({ name: null }), call({ input: undefined }),
      call({ timeoutSeconds: 0 }), call({ timeoutSeconds: 601 }), call({ timeoutSeconds: 1.5 }), call({ timeoutSeconds: '5' }),
    ];
    for (const request of bad) {
      const reply = await askCall(socket, request, 2000, 'vault');
      assert.equal(reply.isError, true, JSON.stringify(request));
      assert.match(reply.text, /: the call could not be read$/, JSON.stringify(request));
    }
    assert.deepEqual(JSON.parse(await raw(socket, '{nope\n')), plain(CALL_FAILED.badRequest));
    assert.deepEqual(await askCall(socket, call({ timeoutSeconds: 600 }), 2000, 'vault'), { text: 'ran', isError: false });
    assert.deepEqual(await askCall(socket, call({ timeoutSeconds: 1 }), 2000, 'vault'), { text: 'ran', isError: false });
  });
  assert.equal(calls, 2);
});

test('the server reads one request per connection across chunks, and ignores what follows the newline', async () => {
  const seen = [];
  await withServer(async (request) => {
    seen.push(request);
    return { text: 'ok', isError: false };
  }, async (socket) => {
    const text = `${JSON.stringify(call())}\n${JSON.stringify(call({ input: 'second' }))}\n`;
    const got = await new Promise((resolve) => {
      let out = '';
      const conn = net.connect(socket, () => {
        conn.write(text.slice(0, 10));
        setTimeout(() => conn.write(text.slice(10)), 30);
      });
      conn.setEncoding('utf8');
      conn.on('data', (c) => { out += c; });
      conn.on('close', () => resolve(out));
    });
    assert.deepEqual(JSON.parse(got), { text: 'ok', isError: false });
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, 'say hi');
});

test('an oversized request is refused by the client without sending, and dropped by the server', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { text: 'ran', isError: false };
  }, async (socket) => {
    assert.deepEqual(await askCall(socket, call({ input: 'x'.repeat(MAX_CALL_BYTES) }), 2000, 'vault'), refused(CALL_FAILED.unsendable));
    assert.deepEqual(await askCall(socket, call({ input: 10n }), 2000, 'vault'), refused(CALL_FAILED.unsendable));
    assert.equal(await raw(socket, 'x'.repeat(MAX_CALL_BYTES + 10)), '');
    const fits = call({ input: 'y'.repeat(MAX_CALL_BYTES - 200) });
    assert.deepEqual(await askCall(socket, fits, 2000, 'vault'), { text: 'ran', isError: false });
  });
  assert.equal(calls, 1);
});

test('an oversized answer is replaced by the server and refused by the client', async () => {
  await withServer(async () => ({ text: 'z'.repeat(MAX_ANSWER_BYTES), isError: false }), async (socket) => {
    assert.deepEqual(await askCall(socket, call(), 5000, 'vault'), plain(CALL_FAILED.replyTooLarge));
  });
  await withRawServer((conn) => {
    conn.resume();
    conn.end(`${JSON.stringify({ text: 'z'.repeat(MAX_ANSWER_BYTES + 10), isError: false })}\n`);
  }, async (socket) => {
    assert.deepEqual(await askCall(socket, call(), 5000, 'vault'), refused(CALL_FAILED.replyTooLarge));
  });
});

test('the client counts the bytes of the answer, not its characters, over many chunks', async () => {
  const line = (count) => `${JSON.stringify({ text: 'é'.repeat(count), isError: false })}\n`;
  const fits = (MAX_ANSWER_BYTES - Buffer.byteLength(line(0))) / 2;
  let count = fits;
  await withRawServer((conn) => {
    conn.resume();
    conn.end(line(count));
  }, async (socket) => {
    const whole = await askCall(socket, call(), 5000, 'vault');
    assert.equal(whole.text.length, fits);
    assert.equal(whole.isError, false);
    count = fits + 1;
    assert.deepEqual(await askCall(socket, call(), 5000, 'vault'), refused(CALL_FAILED.replyTooLarge));
  });
});

test('a malformed answer, an empty one and a closed connection are refusals', async () => {
  let mode;
  await withRawServer((conn) => {
    conn.resume();
    if (mode === 'garbage') conn.end('not json\n');
    if (mode === 'null') conn.end('null\n');
    if (mode === 'text') conn.end('{"text":5,"isError":false}\n');
    if (mode === 'flag') conn.end('{"text":"t","isError":"yes"}\n');
    if (mode === 'empty') conn.end();
    if (mode === 'drop') conn.destroy();
    if (mode === 'good') conn.end('{"text":"t","isError":true}\n');
  }, async (socket) => {
    for (mode of ['garbage', 'null', 'text', 'flag']) {
      assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), refused(CALL_FAILED.badReply), mode);
    }
    for (mode of ['empty', 'drop']) {
      assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), refused(CALL_FAILED.noAnswer), mode);
    }
    mode = 'good';
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 't', isError: true });
  });
});

test('no socket is a refusal', async () => {
  assert.deepEqual(await askCall('/tmp/ks-no-such-call-socket', call(), 2000, 'vault'), refused(CALL_FAILED.noAnswer));
  assert.deepEqual(await askCall('/tmp/ks-no-such-call-socket', call({ name: 'other' }), 2000, 'echo'), refused(CALL_FAILED.noAnswer, 'echo', 'other'));
});

test('the client gives up at its time limit, also on a server that trickles bytes', async () => {
  const timers = new Set();
  await withRawServer((conn) => {
    conn.resume();
    const timer = setInterval(() => conn.write(' '), 20);
    timers.add(timer);
    conn.on('close', () => clearInterval(timer));
  }, async (socket) => {
    const started = Date.now();
    assert.deepEqual(await askCall(socket, call(), 150, 'vault'), refused(CALL_FAILED.timedOut));
    assert.ok(Date.now() - started < 2000);
  });
  for (const timer of timers) clearInterval(timer);
});

test('the server drops a client that does not finish its request in time', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { text: 'ran', isError: false };
  }, async (socket) => {
    const started = Date.now();
    assert.equal(await raw(socket, '{"kind":"vault"'), '');
    assert.ok(Date.now() - started < 3000);
  }, { requestTimeoutMs: 100 });
  assert.equal(calls, 0);
});

test('the time limit covers the whole request, so a client that sends a byte now and then is dropped too', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    return { text: 'ran', isError: false };
  }, async (socket) => {
    const started = Date.now();
    const closed = await new Promise((resolve) => {
      const conn = net.connect(socket);
      conn.on('error', () => {});
      const timer = setInterval(() => conn.write(' '), 50);
      conn.on('close', () => {
        clearInterval(timer);
        resolve(Date.now() - started);
      });
    });
    assert.ok(closed < 3000, `dropped after ${closed} ms`);
  }, { requestTimeoutMs: 300 });
  assert.equal(calls, 0);
});

test('the server takes at most 64 connections at once', async () => {
  await withServer(async () => ({ text: 'ran', isError: false }), async (socket) => {
    const held = [];
    for (let i = 0; i < 64; i += 1) {
      held.push(await new Promise((resolve) => {
        const conn = net.connect(socket, () => resolve(conn));
        conn.on('error', () => {});
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await raw(socket, `${JSON.stringify(call())}\n`), '');
    held.pop().destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(JSON.parse(await raw(socket, `${JSON.stringify(call())}\n`)), { text: 'ran', isError: false });
    for (const conn of held) conn.destroy();
  });
});

// A client that sends one line and then keeps its side open for ever, reading or not.
function holdAfterLine(socket, line, { read = true } = {}) {
  return new Promise((resolve) => {
    const conn = net.connect({ path: socket, allowHalfOpen: true }, () => {
      conn.write(line);
      resolve(conn);
    });
    if (!read) conn.pause();
    conn.on('error', () => {});
  });
}

test('64 clients that send a line and never close do not stop a 65th call: the server closes each one after its answer', async () => {
  await withServer(async () => ({ text: 'ran', isError: false }), async (socket) => {
    const held = [];
    for (let i = 0; i < 64; i += 1) held.push(await holdAfterLine(socket, `${JSON.stringify(call())}\n`));
    for (let i = 0; i < 64; i += 1) held.push(await holdAfterLine(socket, '{"kind":"http","name":"x","input":{},"timeoutSeconds":5}\n'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'ran', isError: false });
    for (const conn of held) conn.destroy();
  }, { requestTimeoutMs: 60000 });
});

test('a client that does not read a large answer is dropped requestTimeoutMs after the answer, so it gives its place back', async () => {
  await withServer(async (request) => ({ text: request.input === 'big' ? 'x'.repeat(900000) : 'ran', isError: false }), async (socket) => {
    const line = `${JSON.stringify(call({ input: 'big' }))}\n`;
    const held = await Promise.all(Array.from({ length: 64 }, () => holdAfterLine(socket, line, { read: false })));
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'ran', isError: false });
    for (const conn of held) conn.destroy();
  }, { requestTimeoutMs: 2000 });
});

// Whether the system buffers a large answer is up to the system, so the drop of a client that does not read is shown
// on a stand-in connection whose write never finishes.
test('sendAndClose destroys a connection whose answer is never sent once waitMs has passed, and clears its timer on close', async () => {
  const made = () => {
    const events = { close: [] };
    const conn = {
      destroyed: 0,
      ended: null,
      on: (name, fn) => events[name].push(fn),
      end(line) { this.ended = line; },
      destroy() {
        this.destroyed += 1;
        for (const fn of events.close) fn();
      },
    };
    return conn;
  };
  const stuck = made();
  sendAndClose(stuck, 'line\n', 50);
  assert.equal(stuck.ended, 'line\n');
  assert.equal(stuck.destroyed, 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(stuck.destroyed, 1);
  const sent = made();
  sent.end = (line, done) => done();
  sendAndClose(sent, 'line\n', 50);
  assert.equal(sent.destroyed, 1);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sent.destroyed, 1, 'the timer was cleared when the connection closed');
});

test('a client that sent its line and waits for a long call keeps its place, and gets the answer', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withServer(async () => {
    await gate;
    return { text: 'late', isError: false };
  }, async (socket) => {
    const waiting = askCall(socket, call(), 5000, 'vault');
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    assert.deepEqual(await waiting, { text: 'late', isError: false });
  }, { requestTimeoutMs: 100 });
});

test('closing the server mid-call ends the call as a refusal, aborts the handler, removes the socket, and does not wait', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'call-sock');
  let signal;
  let arrived;
  const inside = new Promise((resolve) => { arrived = resolve; });
  const server = await startCallServer({
    socket,
    handle: (request, s) => {
      signal = s;
      arrived();
      return new Promise(() => {});
    },
  });
  try {
    const waiting = askCall(socket, call(), 10000, 'vault');
    await inside;
    const started = Date.now();
    await server.close();
    assert.ok(Date.now() - started < 2000);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await waiting, refused(CALL_FAILED.noAnswer));
    assert.equal(fs.existsSync(socket), false);
    assert.equal(await callSocketOpen(socket), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a handler that answers after its client left does not upset the server', async () => {
  let release;
  let arrived;
  const inside = new Promise((resolve) => { arrived = resolve; });
  let first = true;
  await withServer((request) => {
    if (!first) return { text: `again ${request.input}`, isError: false };
    first = false;
    arrived();
    return new Promise((resolve) => { release = resolve; });
  }, async (socket) => {
    const conn = net.connect(socket, () => conn.write(`${JSON.stringify(call())}\n`));
    conn.on('error', () => {});
    await inside;
    await new Promise((resolve) => { conn.on('close', resolve); conn.destroy(); });
    release({ text: 'late', isError: false });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'again say hi', isError: false });
  });
});

test('callSocketOpen says whether something accepts a connection on the socket', async () => {
  await withServer(async () => ({ text: 'x', isError: false }), async (socket) => {
    assert.equal(await callSocketOpen(socket), true);
  });
  assert.equal(await callSocketOpen('/tmp/ks-no-such-call-socket'), false);
  const dir = tmp();
  const socket = path.join(dir, 's');
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    assert.equal(await callSocketOpen(socket), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startCallServer replaces a stale socket file and fails cleanly when it cannot listen or chmod', async (t) => {
  const dir = tmp();
  try {
    const socket = path.join(dir, 'call-sock');
    fs.writeFileSync(socket, 'stale');
    const server = await startCallServer({ socket, handle: async () => ({ text: 'fresh', isError: false }) });
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), { text: 'fresh', isError: false });
    await server.close();
    await assert.rejects(startCallServer({ socket: path.join(dir, 'missing', 's'), handle: async () => null }), /listen/);
    t.mock.method(fs, 'chmodSync', () => { throw new Error('chmod failed'); });
    await assert.rejects(startCallServer({ socket, handle: async () => null }), /chmod failed/);
    t.mock.restoreAll();
    assert.deepEqual(await askCall(socket, call(), 2000, 'vault'), refused(CALL_FAILED.noAnswer));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
