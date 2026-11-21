import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { askReview, startReviewServer } from '../src/review.js';

const reviewer = { name: 'r', baseUrl: 'https://api.example.com/v1/', model: 'm', keyEnv: null, timeoutSeconds: 1, maxCalls: 3 };
const review = { reviewer: 'r', policy: 'read only', accept: ['sure'] };
const answerWith = (content) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
const allow = '{"verdict":"allow","certainty":"sure","reason":"fine"}';
const unavailable = { allowed: false, short: 'review not available' };

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-rev-')));
}

async function withServer(fetchImpl, body, options = {}) {
  const dir = tmp();
  const socket = path.join(dir, 'review-sock');
  const targets = options.targets ?? new Map([['ssh:web1', { reviewer: options.reviewer ?? reviewer, key: null, review }]]);
  const server = await startReviewServer({
    socket, targets, fetchImpl, requestTimeoutMs: options.requestTimeoutMs,
  });
  try {
    await body(socket);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function raw(socket, text) {
  return new Promise((resolve) => {
    let got = '';
    const conn = net.connect(socket, () => conn.write(text));
    conn.setEncoding('utf8');
    conn.on('data', (c) => { got += c; });
    conn.on('close', () => resolve(got));
    conn.on('error', () => {});
  });
}

const subject = (argv = ['uptime']) => ({ kind: 'ssh', name: 'web1', argv });

test('an approved command comes back approved, and the socket is private', async () => {
  await withServer(answerWith(allow), async (socket) => {
    assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
    assert.deepEqual(await askReview(socket, subject()), { allowed: true, certainty: 'sure', reason: 'fine' });
  });
});

test('a refusal carries the short reason', async () => {
  await withServer(answerWith('{"verdict":"refuse","certainty":"sure","reason":"restarts"}'), async (socket) => {
    assert.deepEqual(await askReview(socket, subject(['reboot'])), { allowed: false, short: 'model refused: restarts' });
  });
});

test('the same command is asked once; a failure is asked again', async () => {
  let calls = 0;
  await withServer(async () => {
    calls += 1;
    if (calls === 1) return new Response('no', { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: allow } }] }));
  }, async (socket) => {
    assert.equal((await askReview(socket, subject())).short, 'review failed: reviewer answered HTTP 500');
    assert.equal((await askReview(socket, subject())).allowed, true);
    assert.equal((await askReview(socket, subject())).allowed, true);
    assert.equal(calls, 2);
  });
});

test('the call budget of a reviewer is enforced', async () => {
  await withServer(answerWith(allow), async (socket) => {
    for (const word of ['a', 'b', 'c']) assert.equal((await askReview(socket, subject([word]))).allowed, true);
    assert.deepEqual(await askReview(socket, subject(['d'])), { allowed: false, short: 'review limit reached' });
    assert.equal((await askReview(socket, subject(['a']))).allowed, true);
  });
});

test('the answer cache keeps the newest 500 commands', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: allow } }] }));
  };
  await withServer(fetchImpl, async (socket) => {
    for (let i = 0; i <= 500; i += 1) await askReview(socket, subject(['echo', String(i)]));
    assert.equal(calls, 501);
    await askReview(socket, subject(['echo', '500']));
    assert.equal(calls, 501);
    await askReview(socket, subject(['echo', '0']));
    assert.equal(calls, 502);
  }, { reviewer: { ...reviewer, maxCalls: 1000 } });
});

test('an unknown target and a malformed request are refused', async () => {
  await withServer(answerWith(allow), async (socket) => {
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'other', argv: ['uptime'] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'local', name: 'web1', argv: ['uptime'] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'other', name: 'web1', argv: ['uptime'] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 1, argv: ['uptime'] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'web1', argv: 'uptime' }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'web1', argv: [] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'web1', argv: [1] }), unavailable);
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'web1', argv: Array(257).fill('a') }), unavailable);
    assert.deepEqual(await askReview(socket, 'not an object'), unavailable);
    assert.deepEqual(await askReview(socket, null), unavailable);
  });
});

test('a local command is reviewed only for a program the user listed, whatever the request claims', async () => {
  let calls = 0;
  const targets = new Map([['local:repo', { reviewer, key: null, review: { ...review, programs: ['git'] } }]]);
  await withServer(async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: allow } }] }));
  }, async (socket) => {
    assert.equal((await askReview(socket, { kind: 'local', name: 'repo', argv: ['git', 'status'] })).allowed, true);
    assert.deepEqual(await askReview(socket, { kind: 'local', name: 'repo', argv: ['sh', 'x'] }), unavailable);
    assert.equal(calls, 1);
  }, { targets });
});

test('a request that is not JSON, too large or never finished gets no approval', async () => {
  await withServer(answerWith(allow), async (socket) => {
    assert.deepEqual(JSON.parse(await raw(socket, '{nope\n')), unavailable);
    assert.equal(await raw(socket, 'x'.repeat(20000)), '');
    assert.equal(await raw(socket, '{"kind":"ssh"'), '');
  }, { requestTimeoutMs: 100 });
});

test('a client that leaves while the model is asked does not upset the server', async () => {
  let release;
  let asked;
  const called = new Promise((resolve) => { asked = resolve; });
  const fetchImpl = () => {
    asked();
    return new Promise((resolve) => { release = resolve; });
  };
  await withServer(fetchImpl, async (socket) => {
    const conn = net.connect(socket, () => conn.write(`${JSON.stringify(subject())}\n`));
    conn.on('error', () => {});
    await called;
    await new Promise((resolve) => { conn.on('close', resolve); conn.destroy(); });
    release(new Response(JSON.stringify({ choices: [{ message: { content: allow } }] })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await askReview(socket, subject()), { allowed: true, certainty: 'sure', reason: 'fine' });
  });
});

test('startReviewServer replaces a stale socket file and fails cleanly when it cannot listen', async () => {
  const dir = tmp();
  try {
    const socket = path.join(dir, 'review-sock');
    fs.writeFileSync(socket, 'stale');
    const server = await startReviewServer({ socket, targets: new Map(), fetchImpl: answerWith(allow) });
    assert.deepEqual(await askReview(socket, subject()), unavailable);
    await server.close();
    await assert.rejects(startReviewServer({ socket: path.join(dir, 'missing', 's'), targets: new Map() }), /listen/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('askReview never rejects: no socket, a silent server, a bad reply', async () => {
  assert.deepEqual(await askReview('/tmp/ks-no-such-socket', subject()), unavailable);
  const dir = tmp();
  const socket = path.join(dir, 's');
  let mode = 'silent';
  const trickles = new Set();
  const server = net.createServer((conn) => {
    conn.on('error', () => {});
    conn.resume();
    if (mode === 'garbage') conn.end('not json\n');
    if (mode === 'odd') conn.end('{"allowed":false}\n');
    if (mode === 'null') conn.end('null\n');
    if (mode === 'half') conn.end('{"allowed":true,"certainty":"sure"}\n');
    if (mode === 'bare') conn.end('{"allowed":true,"reason":"r"}\n');
    if (mode === 'flood') conn.end('x'.repeat(70000));
    if (mode === 'trickle') {
      const timer = setInterval(() => conn.write(' '), 20);
      trickles.add(timer);
      conn.on('close', () => clearInterval(timer));
    }
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(await askReview(socket, subject(), 100), { allowed: false, short: 'review timed out' });
    for (mode of ['garbage', 'odd', 'null', 'half', 'bare', 'flood']) {
      assert.deepEqual(await askReview(socket, subject(), 2000), unavailable, mode);
    }
    mode = 'trickle';
    const started = Date.now();
    assert.deepEqual(await askReview(socket, subject(), 150), { allowed: false, short: 'review timed out' });
    assert.ok(Date.now() - started < 2000);
  } finally {
    for (const timer of trickles) clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('close ends a review that is still waiting on the model', async () => {
  const dir = tmp();
  const socket = path.join(dir, 'review-sock');
  const targets = new Map([['ssh:web1', { reviewer: { ...reviewer, timeoutSeconds: 30 }, key: null, review }]]);
  let signal;
  let asked;
  const called = new Promise((resolve) => { asked = resolve; });
  const server = await startReviewServer({
    socket,
    targets,
    fetchImpl: (url, init) => {
      signal = init.signal;
      asked();
      return new Promise(() => {});
    },
  });
  const waiting = askReview(socket, subject(), 5000);
  await called;
  await server.close();
  assert.deepEqual(await waiting, unavailable);
  assert.equal(signal.aborted, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('identical requests at the same time share one model call, one budget unit and one reply', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    const k = calls;
    await gate;
    const content = JSON.stringify({ verdict: k % 2 ? 'allow' : 'refuse', certainty: 'sure', reason: `r${k}` });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  await withServer(fetchImpl, async (socket) => {
    const waiting = [askReview(socket, subject()), askReview(socket, subject()), askReview(socket, subject())];
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const replies = await Promise.all(waiting);
    assert.equal(calls, 1);
    for (const reply of replies) assert.deepEqual(reply, { allowed: true, certainty: 'sure', reason: 'r1' });
    assert.equal((await askReview(socket, subject(['b']))).allowed, false);
    assert.equal((await askReview(socket, subject(['c']))).allowed, true);
    assert.deepEqual(await askReview(socket, subject(['d'])), { allowed: false, short: 'review limit reached' });
    assert.equal(calls, 3);
  });
});

test('a failed call shared by requests at the same time is not kept for later ones', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return new Response('no', { status: 500 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: allow } }] }));
  };
  await withServer(fetchImpl, async (socket) => {
    const waiting = [askReview(socket, subject()), askReview(socket, subject())];
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    for (const reply of await Promise.all(waiting)) {
      assert.deepEqual(reply, { allowed: false, short: 'review failed: reviewer answered HTTP 500' });
    }
    assert.equal(calls, 1);
    assert.equal((await askReview(socket, subject())).allowed, true);
    assert.equal(calls, 2);
  });
});

test('a review that throws on the server is answered as not available and the server keeps going', async () => {
  const targets = new Map([
    ['ssh:web1', { reviewer, key: null, review: { policy: 'read only' } }],
    ['ssh:web2', { reviewer, key: null, review }],
  ]);
  await withServer(answerWith(allow), async (socket) => {
    const shared = [askReview(socket, subject()), askReview(socket, subject())];
    for (const reply of await Promise.all(shared)) assert.deepEqual(reply, unavailable);
    assert.equal((await askReview(socket, { kind: 'ssh', name: 'web2', argv: ['uptime'] })).allowed, true);
  }, { targets });
});

test('startReviewServer rejects and stops listening when the socket cannot be made private', async (t) => {
  const dir = tmp();
  const socket = path.join(dir, 'review-sock');
  t.mock.method(fs, 'chmodSync', () => { throw new Error('chmod failed'); });
  try {
    await assert.rejects(startReviewServer({ socket, targets: new Map(), fetchImpl: answerWith(allow) }), /chmod failed/);
    t.mock.restoreAll();
    assert.deepEqual(await askReview(socket, subject(), 2000), unavailable);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('askReview answers not available for a request it cannot write, without connecting', async () => {
  let connected = 0;
  const dir = tmp();
  const socket = path.join(dir, 's');
  const server = net.createServer((conn) => { connected += 1; conn.destroy(); });
  await new Promise((resolve) => server.listen(socket, resolve));
  try {
    assert.deepEqual(await askReview(socket, { kind: 'ssh', name: 'web1', argv: [1n] }), unavailable);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connected, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('askReview accepts an approval only with a real certainty and keeps texts short', async () => {
  const dir = tmp();
  const socket = path.join(dir, 's');
  let reply;
  const server = net.createServer((conn) => {
    conn.on('error', () => {});
    conn.resume();
    conn.end(`${JSON.stringify(reply)}\n`);
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  const long = `a \n\t b${'x'.repeat(5000)}`;
  try {
    for (const certainty of ['whatever', 'unsure', 'SURE', '']) {
      reply = { allowed: true, certainty, reason: 'r' };
      assert.deepEqual(await askReview(socket, subject(), 2000), unavailable, certainty);
    }
    reply = { allowed: true, certainty: 'likely', reason: long };
    const approved = await askReview(socket, subject(), 2000);
    assert.equal(approved.certainty, 'likely');
    assert.equal(approved.reason.length, 120);
    assert.ok(approved.reason.startsWith('a bx'));
    reply = { allowed: false, short: long };
    const refused = await askReview(socket, subject(), 2000);
    assert.equal(refused.short.length, 120);
    assert.ok(refused.short.startsWith('a bx'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
