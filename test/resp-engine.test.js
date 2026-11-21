import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {
  MAX_DEPTH, ReplyError, ReplyReader, encodeCommand, escapeText, exchange, formatReply, readReply,
} from '../src/kinds/engines/resp.js';
import { parseCommands, respServer, simpleAnswer } from './fixtures/resp-server.js';
import { selfSigned } from './fixtures/self-signed.js';

const PASSWORD = 'pw-R3D1S-9f3c-unmistakable';
const servers = [];
after(async () => {
  for (const server of servers) await server.close();
});

async function server(answer = simpleAnswer, options = {}) {
  const s = await respServer(answer, options);
  servers.push(s);
  return s;
}

const signal = () => new AbortController().signal;
const b = (text) => Buffer.from(text, 'latin1');
const read = (text, options) => readReply(b(text), options);
const value = (text, options) => read(text, options).value;
const fails = (text, message, options) => assert.throws(() => read(text, options), (err) => {
  assert.ok(err instanceof ReplyError);
  assert.equal(err.message, message);
  assert.equal(err.overflow, false);
  return true;
});
const overflows = (text, options) => assert.throws(() => read(text, options), (err) => {
  assert.ok(err instanceof ReplyError);
  assert.equal(err.overflow, true);
  assert.equal(err.message, 'the reply is larger than the output limit');
  return true;
});

test('encodeCommand writes an array of bulk strings with lengths counted in bytes', () => {
  assert.equal(encodeCommand(['GET', 'k']).toString('latin1'), '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  assert.deepEqual(encodeCommand(['SET', 'k', 'é']), Buffer.concat([b('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\n'), Buffer.from('é'), b('\r\n')]));
  const hostile = encodeCommand(['GET', 'a\r\nFLUSHALL\r\n']);
  assert.equal(hostile.toString('latin1'), '*2\r\n$3\r\nGET\r\n$13\r\na\r\nFLUSHALL\r\n\r\n');
  assert.deepEqual(parseCommands(hostile).commands, [['GET', 'a\r\nFLUSHALL\r\n']], 'a word can never start a second command');
  for (const bad of [[], 'GET k', ['GET', 5], null]) {
    assert.throws(() => encodeCommand(bad), { message: 'a command is a non-empty list of strings' });
  }
});

test('readReply reads every type of reply from hand-written bytes', () => {
  assert.deepEqual(read('+OK\r\n'), { value: { type: 'simple', data: b('OK') }, rest: b('') });
  assert.deepEqual(value('-ERR no\r\n'), { type: 'error', data: b('ERR no') });
  assert.deepEqual(value(':-42\r\n'), { type: 'integer', text: '-42' });
  assert.deepEqual(value(':+7\r\n'), { type: 'integer', text: '+7' });
  assert.deepEqual(value('$5\r\nhe\r\nl\r\n'), { type: 'bulk', data: b('he\r\nl') });
  assert.deepEqual(value('$0\r\n\r\n'), { type: 'bulk', data: b('') });
  assert.deepEqual(value('$-1\r\n'), { type: 'null' });
  assert.deepEqual(value('*-1\r\n'), { type: 'null' });
  assert.deepEqual(value('_\r\n'), { type: 'null' });
  assert.deepEqual(value('*0\r\n'), { type: 'array', items: [] });
  assert.deepEqual(value('*2\r\n:1\r\n*1\r\n$1\r\na\r\n'), {
    type: 'array', items: [{ type: 'integer', text: '1' }, { type: 'array', items: [{ type: 'bulk', data: b('a') }] }],
  });
  assert.deepEqual(value(',3.25\r\n'), { type: 'double', text: '3.25' });
  for (const text of ['inf', '-inf', 'nan', '1e10', '-2.5E-3', '10']) assert.equal(value(`,${text}\r\n`).text, text);
  assert.deepEqual(value('#t\r\n'), { type: 'boolean', value: true });
  assert.deepEqual(value('#f\r\n'), { type: 'boolean', value: false });
  assert.deepEqual(value('(123456789012345678901234567890\r\n'), { type: 'big', text: '123456789012345678901234567890' });
  assert.deepEqual(value('=8\r\ntxt:abcd\r\n'), { type: 'verbatim', format: 'txt', data: b('abcd') });
  assert.deepEqual(value('!3\r\nERR\r\n'), { type: 'error', data: b('ERR') });
  assert.deepEqual(value('%1\r\n+k\r\n:1\r\n'), { type: 'map', items: [{ type: 'simple', data: b('k') }, { type: 'integer', text: '1' }] });
  assert.deepEqual(value('~1\r\n#t\r\n'), { type: 'set', items: [{ type: 'boolean', value: true }] });
  assert.deepEqual(value('>2\r\n+message\r\n$1\r\nx\r\n'), { type: 'push', items: [{ type: 'simple', data: b('message') }, { type: 'bulk', data: b('x') }] });
  assert.deepEqual(value('%0\r\n'), { type: 'map', items: [] });
  assert.deepEqual(read('+OK\r\n:1\r\n'), { value: { type: 'simple', data: b('OK') }, rest: b(':1\r\n') });
  for (const partial of ['', '+OK', '+OK\r', '$5\r\nab', '*2\r\n:1\r\n', '$3', '%1\r\n+k\r\n']) assert.equal(read(partial), null, partial);
});

test('the reader is correct when a reply arrives split at any byte boundary', () => {
  const whole = '*6\r\n$5\r\nhe\r\nl\r\n:12\r\n*2\r\n$-1\r\n%1\r\n+k\r\n~1\r\n,1.5\r\n_\r\n=7\r\ntxt:a\r\n\r\n#f\r\n';
  const expected = value(whole);
  for (let i = 1; i < whole.length; i += 1) {
    const reader = new ReplyReader();
    reader.push(b(whole.slice(0, i)));
    assert.equal(reader.read(), null, `split at ${i}`);
    reader.push(b(whole.slice(i)));
    assert.deepEqual(reader.read(), expected, `split at ${i}`);
    assert.equal(reader.read(), null);
  }
  const reader = new ReplyReader();
  const seen = [];
  for (const byte of b(whole + whole)) {
    reader.push(Buffer.from([byte]));
    for (let v = reader.read(); v !== null; v = reader.read()) seen.push(v);
  }
  assert.deepEqual(seen, [expected, expected]);
});

test('the reader keeps its buffer small over many replies and grows it for a large one', () => {
  const reader = new ReplyReader();
  const replies = [];
  for (let i = 0; i < 2000; i += 1) {
    reader.push(b(`:${i}\r\n`));
    replies.push(reader.read().text);
  }
  assert.equal(replies[1999], '1999');
  const big = 'x'.repeat(100000);
  reader.push(b(`$${big.length}\r\n${big.slice(0, 50000)}`));
  assert.equal(reader.read(), null);
  reader.push(b(`${big.slice(50000)}\r\n`));
  assert.equal(reader.read().data.length, big.length);
});

test('the reader limits the nesting depth and the total size', () => {
  assert.equal(MAX_DEPTH, 32);
  const nested = (depth) => `${'*1\r\n'.repeat(depth)}:1\r\n`;
  assert.equal(value(nested(32)).type, 'array');
  fails(nested(33), 'the reply is nested deeper than 32 levels');
  fails('*1\r\n*1\r\n:1\r\n', 'the reply is nested deeper than 1 levels', { maxDepth: 1 });
  overflows('$10\r\n0123456789\r\n', { maxBytes: 11 });
  assert.equal(value('$10\r\n0123456789\r\n', { maxBytes: 17 }).data.length, 10);
  overflows('$11\r\n', { maxBytes: 12 });
  overflows('*5\r\n', { maxBytes: 14 });
  overflows('%3\r\n', { maxBytes: 17 });
  assert.equal(read('*4\r\n', { maxBytes: 16 }), null);
  overflows(':1\r\n:2\r\n', { maxBytes: 7 });
  const reader = new ReplyReader({ maxBytes: 8 });
  reader.push(b(':1\r\n'));
  assert.equal(reader.read().text, '1');
  assert.throws(() => reader.push(b(':22\r\n')), { overflow: true });
});

test('the reader refuses a malformed reply with a fixed text', () => {
  fails('X1\r\n', 'the reply has an unknown type byte 0x58');
  fails('|1\r\n+a\r\n+b\r\n', 'the reply has an unknown type byte 0x7c');
  fails('\u0000\r\n', 'the reply has an unknown type byte 0x00');
  fails('+a\nb\r\n', 'a simple string or an error holds a line break');
  fails('-a\rb\r\n', 'a simple string or an error holds a line break');
  fails(':abc\r\n', 'an integer is not a number');
  fails(':\r\n', 'an integer is not a number');
  fails(`:${'1'.repeat(21)}\r\n`, 'an integer is not a number');
  fails(',abc\r\n', 'a double is not a number');
  fails('#x\r\n', 'a boolean is not t or f');
  fails('(1.5\r\n', 'a big number is not a number');
  fails('_x\r\n', 'a null holds data');
  fails('$abc\r\n', 'a length is not a number');
  fails('$\r\n', 'a length is not a number');
  fails('$01\r\nx\r\n', 'a length is not a number');
  fails(`$${'9'.repeat(19)}\r\n`, 'a length is not a number');
  fails('$-2\r\n', 'a length is negative');
  fails('*-2\r\n', 'a length is negative');
  fails('%-1\r\n', 'a length is negative');
  fails('=-1\r\n', 'a length is negative');
  fails('!-1\r\n', 'a length is negative');
  fails('$1\r\nab\r\n', 'a bulk string does not end in CRLF');
  fails('=3\r\nabc\r\n', 'a verbatim string has no format');
  fails('=5\r\nabcde\r\n', 'a verbatim string has no format');
  fails(`$${'1'.repeat(30)}`, 'a length is not a number');
  fails(`*${'1'.repeat(25)}`, 'a length is not a number');
  assert.equal(read(`+${'a'.repeat(5000)}`), null, 'a long simple string may still be coming');
});

test('formatReply prints the reply as the usual client does, with every special byte escaped', () => {
  const f = (text) => formatReply(value(text));
  assert.equal(f('+OK\r\n'), 'OK\n');
  assert.equal(f('-ERR unknown command\r\n'), '(error) ERR unknown command\n');
  assert.equal(f(':42\r\n'), '(integer) 42\n');
  assert.equal(f('$-1\r\n'), '(nil)\n');
  assert.equal(f('$5\r\nab"\\c\r\n'), '"ab\\"\\\\c"\n');
  assert.equal(f('$14\r\na\nexit code: 0\r\n'), '"a\\nexit code: 0"\n');
  assert.equal(f('$7\r\n\t\r\u0007\u0008\u0000\u007f\u00ff\r\n'), '"\\t\\r\\a\\b\\x00\\x7f\\xff"\n');
  assert.equal(formatReply({ type: 'bulk', data: Buffer.from('é\u2028') }), '"\\xc3\\xa9\\xe2\\x80\\xa8"\n');
  assert.equal(f('+a\u0001b\r\n'), 'a\\x01b\n');
  assert.equal(f('*0\r\n'), '(empty array)\n');
  assert.equal(f('~0\r\n'), '(empty set)\n');
  assert.equal(f('%0\r\n'), '(empty hash)\n');
  assert.equal(f('>0\r\n'), '(empty array)\n');
  assert.equal(f('*3\r\n$1\r\na\r\n*2\r\n:1\r\n*1\r\n$1\r\nb\r\n$-1\r\n'), '1) "a"\n2) 1) (integer) 1\n   2) 1) "b"\n3) (nil)\n');
  const eleven = `*11\r\n${':1\r\n'.repeat(10)}*2\r\n:2\r\n:3\r\n`;
  assert.equal(f(eleven), `${Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2)}) (integer) 1`).join('\n')}\n11) 1) (integer) 2\n    2) (integer) 3\n`);
  assert.equal(f('%2\r\n+a\r\n:1\r\n+b\r\n*2\r\n:2\r\n:3\r\n'), '1# a => (integer) 1\n2# b => 1) (integer) 2\n        2) (integer) 3\n');
  assert.equal(f('%1\r\n*2\r\n:1\r\n:2\r\n+v\r\n'), '1# 1) (integer) 1\n   2) (integer) 2 => v\n');
  assert.equal(f('~2\r\n+a\r\n+b\r\n'), '1) a\n2) b\n');
  assert.equal(f('>1\r\n+m\r\n'), '1) m\n');
  assert.equal(f(',1.5\r\n'), '(double) 1.5\n');
  assert.equal(f('#t\r\n'), '(true)\n');
  assert.equal(f('#f\r\n'), '(false)\n');
  assert.equal(f('(12\r\n'), '(big number) 12\n');
  assert.equal(f('=7\r\ntxt:a\nb\r\n'), '"a\\nb"\n');
  assert.equal(f('_\r\n'), '(nil)\n');
  assert.equal(escapeText('a"b\\\né'), 'a\\"b\\\\\\n\\xc3\\xa9');
});

test('formatReply stops once the text passes maxBytes, and what it gives is the start of the whole text', () => {
  const ints = (n) => Array.from({ length: n }, (_, i) => ({ type: 'integer', text: String(i) }));
  let deep = { type: 'array', items: ints(3000) };
  for (let i = 0; i < 30; i += 1) deep = { type: 'array', items: [deep] };
  const whole = formatReply(deep);
  assert.ok(whole.length > 300000);
  const cut = formatReply(deep, 1000);
  assert.ok(whole.startsWith(cut));
  assert.ok(cut.length > 1000 && cut.length < 1200, String(cut.length));
  const bulk = (text) => ({ type: 'bulk', data: Buffer.from(text) });
  const map = {
    type: 'map',
    items: [bulk('k1'), { type: 'array', items: ints(50) }, { type: 'array', items: [bulk('a'), bulk('b')] }, bulk('v'),
      { type: 'array', items: ints(100) }, bulk('w')],
  };
  const wholeMap = formatReply(map);
  for (const limit of [10, 100, 400, 700, 1000, 1200]) {
    const part = formatReply(map, limit);
    assert.ok(wholeMap.startsWith(part), String(limit));
    assert.ok(part.length > limit, String(limit));
  }
  assert.equal(formatReply(map, wholeMap.length), wholeMap);
  const bigKey = { type: 'map', items: [{ type: 'array', items: ints(100) }, bulk('w'), bulk('k'), bulk('v')] };
  const wholeBigKey = formatReply(bigKey);
  const keyCut = formatReply(bigKey, 100);
  assert.ok(wholeBigKey.startsWith(keyCut));
  assert.ok(keyCut.length > 100 && !keyCut.includes('=>'), keyCut);
  assert.equal(formatReply(deep, whole.length), whole);
});

// A connect function that records the sockets it made, so that a test can check each one was destroyed.
function recording(inner = (options, useTls) => (useTls ? tls.connect(options) : net.connect(options))) {
  const made = [];
  const connect = (options, useTls) => {
    const socket = inner(options, useTls);
    made.push({ socket, options, useTls });
    return socket;
  };
  return { made, connect };
}

const base = (port, extra = {}) => ({
  host: '127.0.0.1', port, words: ['GET', 'k'], timeoutMs: 5000, maxBytes: 262144, signal: signal(), ...extra,
});

test('exchange sends the one command and returns the formatted reply, and destroys the socket', async () => {
  const s = await server();
  const { made, connect } = recording();
  const result = await exchange(base(s.port, { connect }));
  assert.deepEqual(result, { exitCode: 0, stdout: '"value-of-k"\n', stderr: '' });
  assert.equal(s.bytes().toString('latin1'), '*2\r\n$3\r\nGET\r\n$1\r\nk\r\n');
  assert.equal(made.length, 1);
  assert.equal(made[0].socket.destroyed, true);
  assert.deepEqual(made[0].options, { host: '127.0.0.1', port: s.port });
  assert.equal(made[0].useTls, false);
  const plain = await exchange(base(s.port, { words: ['GET', 'missing'] }));
  assert.deepEqual(plain, { exitCode: 0, stdout: '(nil)\n', stderr: '' });
  const error = await exchange(base(s.port, { words: ['NOPE'] }));
  assert.deepEqual(error, { exitCode: 1, stdout: '(error) ERR unknown command\n', stderr: '' });
});

test('exchange sends AUTH, then SELECT, then the command, each after the answer to the one before', async () => {
  const s = await server();
  const result = await exchange(base(s.port, {
    user: 'agent', password: PASSWORD, db: 3, words: ['TTL', 'k'],
  }));
  assert.deepEqual(result, { exitCode: 0, stdout: '(integer) 42\n', stderr: '' });
  assert.equal(
    s.bytes().toString('latin1'),
    `*3\r\n$4\r\nAUTH\r\n$5\r\nagent\r\n$${PASSWORD.length}\r\n${PASSWORD}\r\n*2\r\n$6\r\nSELECT\r\n$1\r\n3\r\n*2\r\n$3\r\nTTL\r\n$1\r\nk\r\n`,
  );
  const t = await server();
  await exchange(base(t.port, { password: PASSWORD }));
  assert.deepEqual(t.commands, [['AUTH', PASSWORD], ['GET', 'k']]);
  const u = await server();
  await exchange(base(u.port, { db: 0, user: 'ignored-without-password' }));
  assert.deepEqual(u.commands, [['GET', 'k']]);

  const silent = await server((words) => (words[0] === 'AUTH' ? null : '+OK\r\n'));
  const waited = await exchange(base(silent.port, { password: PASSWORD, db: 2, timeoutMs: 300 }));
  assert.deepEqual(waited, {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.deepEqual(silent.commands, [['AUTH', PASSWORD]], 'nothing is sent before AUTH is answered');
});

test('a refused AUTH or SELECT ends the call with a fixed text that never repeats the server or the password', async () => {
  const echo = await server((words) => (words[0] === 'AUTH' ? `-WRONGPASS invalid password ${words.at(-1)}\r\n` : '+OK\r\n'));
  const { made, connect } = recording();
  const result = await exchange(base(echo.port, {
    password: PASSWORD, db: 1, connect, user: 'agent',
  }));
  assert.deepEqual(result, { exitCode: 1, stdout: '', stderr: 'the server did not accept the credentials\n' });
  assert.ok(!JSON.stringify(result).includes(PASSWORD));
  assert.ok(!JSON.stringify(result).includes('WRONGPASS'));
  assert.deepEqual(echo.commands.map((c) => c[0]), ['AUTH']);
  assert.equal(made[0].socket.destroyed, true);

  const odd = await server((words) => (words[0] === 'AUTH' ? ':1\r\n' : '+OK\r\n'));
  assert.equal((await exchange(base(odd.port, { password: PASSWORD }))).stderr, 'the server did not accept the credentials\n');
  const bulkOk = await server((words) => (words[0] === 'AUTH' ? '$2\r\nOK\r\n' : '+OK\r\n'));
  assert.equal((await exchange(base(bulkOk.port, { password: PASSWORD }))).stderr, 'the server did not accept the credentials\n');
  const twice = await server((words) => (words[0] === 'AUTH' ? '-ERR no\r\n+OK\r\n' : '+OK\r\n'));
  assert.equal((await exchange(base(twice.port, { password: PASSWORD }))).stderr, 'the server did not accept the credentials\n');
  assert.deepEqual(twice.commands.map((c) => c[0]), ['AUTH']);

  const noDb = await server((words) => (words[0] === 'SELECT' ? `-ERR DB index is out of range ${PASSWORD}\r\n` : '+OK\r\n'));
  const selected = await exchange(base(noDb.port, { password: PASSWORD, db: 7 }));
  assert.deepEqual(selected, { exitCode: 1, stdout: '', stderr: 'the server did not select database 7\n' });
  assert.deepEqual(noDb.commands.map((c) => c[0]), ['AUTH', 'SELECT']);
});

test('the time limit ends a connect and a reply that take too long, and the call signal ends it too', async () => {
  const never = recording(() => new net.Socket());
  const started = Date.now();
  const connecting = await exchange(base(1, { connect: never.connect, timeoutMs: 200 }));
  assert.deepEqual(connecting, {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.ok(Date.now() - started < 3000);
  assert.equal(never.made[0].socket.destroyed, true);

  const quiet = await server(() => null);
  const { made, connect } = recording();
  assert.equal((await exchange(base(quiet.port, { timeoutMs: 200, connect }))).timedOut, true);
  assert.equal(made[0].socket.destroyed, true);

  const rawSockets = [];
  const raw = net.createServer((socket) => {
    socket.on('error', () => {});
    rawSockets.push(socket);
  });
  await new Promise((resolve) => { raw.listen(0, '127.0.0.1', resolve); });
  servers.push({
    close: () => new Promise((resolve) => {
      for (const socket of rawSockets) socket.destroy();
      raw.close(resolve);
    }),
  });
  const handshake = recording();
  assert.equal((await exchange(base(raw.address().port, { tls: true, timeoutMs: 300, connect: handshake.connect }))).timedOut, true);
  assert.equal(handshake.made[0].socket.destroyed, true);
  assert.equal(handshake.made[0].useTls, true);

  const controller = new AbortController();
  const pending = exchange(base(quiet.port, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  assert.equal((await pending).timedOut, true);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal((await exchange(base(quiet.port, { signal: stopped.signal }))).timedOut, true);
});

test('a server that cannot be reached, closes early or breaks the connection fails the call with a fixed text', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const closedPort = probe.address().port;
  await new Promise((resolve) => { probe.close(resolve); });
  assert.deepEqual(await exchange(base(closedPort)), { exitCode: 1, stdout: '', stderr: 'the server could not be reached\n' });
  const thrown = await exchange(base(1, { connect: () => { throw new Error('bad'); } }));
  assert.deepEqual(thrown, { exitCode: 1, stdout: '', stderr: 'the server could not be reached\n' });
  const dropped = await exchange(base(1, {
    connect: () => {
      const socket = new net.Socket();
      setImmediate(() => socket.destroy());
      return socket;
    },
  }));
  assert.deepEqual(dropped, { exitCode: 1, stdout: '', stderr: 'the server could not be reached\n' });
  const early = await server((words, socket) => {
    socket.end();
    return null;
  });
  assert.deepEqual(await exchange(base(early.port)), { exitCode: 1, stdout: '', stderr: 'the server closed the connection before it answered\n' });
  const reset = await server((words, socket) => {
    socket.write('$10\r\nabc');
    setTimeout(() => socket.resetAndDestroy(), 20);
    return null;
  });
  assert.deepEqual(await exchange(base(reset.port)), { exitCode: 1, stdout: '', stderr: 'the connection to the server failed\n' });
});

test('a reply over the output limit ends the connection and is marked truncated; a malformed one fails the call', async () => {
  const large = await server(() => `$1000\r\n${'x'.repeat(1000)}\r\n`);
  const { made, connect } = recording();
  const result = await exchange(base(large.port, { maxBytes: 100, connect }));
  assert.deepEqual(result, {
    exitCode: 1, stdout: '', stderr: 'the reply is larger than the output limit and was cut off\n', truncated: true,
  });
  assert.equal(made[0].socket.destroyed, true);
  const long = await server(() => `+${'a'.repeat(200)}\r\n`);
  assert.equal((await exchange(base(long.port, { maxBytes: 120 }))).truncated, true);
  const bad = await server(() => '?\r\n');
  assert.deepEqual(await exchange(base(bad.port)), { exitCode: 1, stdout: '', stderr: 'the reply could not be read: the reply has an unknown type byte 0x3f\n' });
  const deepWide = await server(() => `${'*1\r\n'.repeat(20)}*300\r\n${':1\r\n'.repeat(300)}`);
  const wide = await exchange(base(deepWide.port, { maxBytes: 2000 }));
  assert.equal(wide.exitCode, 0);
  assert.ok(wide.stdout.length > 2000 && wide.stdout.length < 2200, String(wide.stdout.length));
  const split = await server(() => ['*2\r\n$3\r\nab', 'c\r\n:', '5\r\n']);
  assert.deepEqual(await exchange(base(split.port)), { exitCode: 0, stdout: '1) "abc"\n2) (integer) 5\n', stderr: '' });
});

test('TLS checks the certificate against the host name, and nothing can turn that off', async () => {
  const { cert, key } = selfSigned('localhost');
  const s = await server(simpleAnswer, { tlsOptions: { cert, key } });
  const trusted = recording((options) => tls.connect({ ...options, ca: cert }));
  const ok = await exchange(base(s.port, {
    host: 'localhost', tls: true, password: PASSWORD, connect: trusted.connect,
  }));
  assert.deepEqual(ok, { exitCode: 0, stdout: '"value-of-k"\n', stderr: '' });
  assert.deepEqual(trusted.made[0].options, { host: 'localhost', port: s.port, servername: 'localhost' });
  assert.equal(trusted.made[0].useTls, true);
  assert.equal(trusted.made[0].socket.destroyed, true);
  assert.deepEqual(s.commands, [['AUTH', PASSWORD], ['GET', 'k']]);

  const before = s.commands.length;
  const failed = 'the server could not be reached over TLS, or its certificate is not trusted for this host\n';
  const wrongName = await exchange(base(s.port, { host: '127.0.0.1', tls: true, connect: trusted.connect }));
  assert.deepEqual(wrongName, { exitCode: 1, stdout: '', stderr: failed });
  assert.deepEqual(trusted.made[1].options, { host: '127.0.0.1', port: s.port });
  const untrusted = await exchange(base(s.port, { host: 'localhost', tls: true, password: PASSWORD }));
  assert.deepEqual(untrusted, { exitCode: 1, stdout: '', stderr: failed });
  assert.equal(s.commands.length, before, 'nothing, the password least of all, was sent without a trusted certificate');
});
