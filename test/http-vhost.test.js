import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { inspect } from 'node:util';
import { AllowError } from '../src/allowlist.js';
import {
  buildUrl, matchRequestRule, readRequest, requestWords, send, splitRule,
} from '../src/kinds/engines/http.js';

// The one exception a kind may opt in to: a path segment that is exactly %2F or %2f, the default virtual host of
// RabbitMQ. Every other encoded slash, backslash, dot, percent sign and control character stays refused.

const ON = { vhostSegment: true };
const OFF = [undefined, {}, { vhostSegment: false }];

const refusedWith = (input, options, short) => {
  try {
    readRequest(input, options);
  } catch (err) {
    assert.ok(err instanceof AllowError, String(err));
    assert.equal(err.short, short, `${inspect(input)} with ${inspect(options)}`);
    return err.message;
  }
  return assert.fail(`not refused: ${inspect(input)} with ${inspect(options)}`);
};

const segmentsOf = (path, options) => readRequest({ method: 'GET', path }, options).segments;

// A segment value placed at the start, in the middle, at the end, alone, and next to a whole %2F segment.
const PLACES = (value) => [`/${value}/x`, `/a/${value}/b`, `/a/${value}`, `/${value}`, `/%2F/${value}`, `/${value}/%2F`, `/%2f/${value}/%2F`];

const STILL_REFUSED = [
  'a%2Fb', 'a%2fb', '%2F%2F', '%2f%2f', '%2F%2f', '%2Fetc', '%2fetc', 'etc%2F', 'etc%2f', 'x%2Fy%2Fz',
  '%5c', '%5C', 'a%5cb', 'a%5Cb', '%5c%5c',
  '%2e', '%2E', '%2e%2e', '%2E%2E', 'a%2eb', '%2F%2e',
  '%25', 'a%25b', '%252F', '%252f', '%25%32%46',
  '%00', '%0a', '%0A', '%0d', '%0D', '%1f', '%1F', '%7f', '%7F', 'a%09b',
];

test('the reader with the option off refuses a whole %2F segment in both letter cases, wherever it is', () => {
  for (const options of OFF) {
    for (const value of ['%2F', '%2f']) {
      for (const path of [`/${value}`, `/${value}/x`, `/a/${value}/b`, `/a/${value}`, `/${value}/${value}`, `/api/queues/${value}/q`]) {
        assert.equal(refusedWith({ method: 'GET', path }, options, 'encoded separator'),
          'path may not encode "/", "\\", ".", ";", "%" or a control character');
      }
    }
  }
});

test('the reader with the option on accepts a whole %2F or %2f segment, kept as written', () => {
  assert.deepEqual(segmentsOf('/%2F', ON), ['%2F']);
  assert.deepEqual(segmentsOf('/%2f', ON), ['%2f']);
  assert.deepEqual(segmentsOf('/%2F/x', ON), ['%2F', 'x']);
  assert.deepEqual(segmentsOf('/a/%2f/b', ON), ['a', '%2f', 'b']);
  assert.deepEqual(segmentsOf('/a/%2F', ON), ['a', '%2F']);
  assert.deepEqual(segmentsOf('/%2F/%2f', ON), ['%2F', '%2f']);
  assert.deepEqual(segmentsOf('/api/queues/%2F/orders', ON), ['api', 'queues', '%2F', 'orders']);
  assert.deepEqual(segmentsOf('/api/queues/%2F/caf%C3%A9', ON), ['api', 'queues', '%2F', 'caf%C3%A9']);
  assert.deepEqual(readRequest({ method: 'post', path: '/api/bindings/%2f/e/x/q/y', body: {} }, ON), {
    method: 'POST', segments: ['api', 'bindings', '%2f', 'e', 'x', 'q', 'y'], query: [], body: '{}',
  });
});

test('every other encoded form stays refused with the option on and off, in both letter cases, at every place', () => {
  for (const options of [ON, ...OFF]) {
    for (const value of STILL_REFUSED) {
      for (const path of PLACES(value)) refusedWith({ method: 'GET', path }, options, 'encoded separator');
    }
  }
});

test('the option changes nothing else the reader refuses', () => {
  const table = [
    ['/%2F/..', 'dot segment'],
    ['/%2F/.', 'dot segment'],
    ['/../%2F', 'dot segment'],
    ['/%2F/', 'empty segment'],
    ['/%2F//x', 'empty segment'],
    ['//%2F', 'empty segment'],
    ['/%2F%', 'bad percent-encoding'],
    ['/%2F/%2', 'bad percent-encoding'],
    ['/%2', 'bad percent-encoding'],
    ['/%2F?x=1', 'query in path'],
    ['/%2F#x', 'query in path'],
    ['/%2F\\x', 'backslash in path'],
    ['/%2F/a@b', 'at sign in path'],
    ['/%2F x', 'space or control character'],
    ['/%2F\n', 'space or control character'],
    ['%2F', 'path not absolute'],
    ['%2F/x', 'path not absolute'],
    [`/%2F/${'a'.repeat(2045)}`, 'path too long'],
  ];
  for (const options of [ON, ...OFF]) {
    for (const [path, short] of table) refusedWith({ method: 'GET', path }, options, short);
  }
  for (const [path, short] of [['/%2F/a"b', 'character """ not allowed'], ['/%2F/日', 'character U+65E5 not allowed']]) {
    refusedWith({ method: 'GET', path }, ON, short);
    for (const options of OFF) refusedWith({ method: 'GET', path }, options, 'encoded separator');
  }
});

test('requestWords gives a whole %2F segment as the word /%2F, whichever case was written', () => {
  const words = (path) => requestWords(readRequest({ method: 'GET', path }, ON));
  assert.deepEqual(words('/api/queues/%2F/orders'), ['GET', '/api', '/queues', '/%2F', '/orders']);
  assert.deepEqual(words('/api/queues/%2f/orders'), ['GET', '/api', '/queues', '/%2F', '/orders']);
  assert.deepEqual(words('/%2f'), ['GET', '/%2F']);
  assert.deepEqual(words('/api/a%2Cb'), ['GET', '/api', '/a%2Cb']);
  assert.deepEqual(words('/api/%2c'), ['GET', '/api', '/%2c']);
});

test('splitRule accepts a whole %2F segment only with the option, as the word /%2F', () => {
  const expected = { words: ['GET', '/api', '/queues', '/%2F', '*'], body: false };
  assert.deepEqual(splitRule('GET /api/queues/%2F/*', ON), expected);
  assert.deepEqual(splitRule('GET /api/queues/%2f/*', ON), expected);
  assert.deepEqual(splitRule('POST /api/bindings/%2F/... +body', ON), { words: ['POST', '/api', '/bindings', '/%2F', '...'], body: true });
  assert.deepEqual(splitRule('GET /%2F', ON), { words: ['GET', '/%2F'], body: false });
  for (const options of OFF) {
    for (const rule of ['GET /api/queues/%2F/*', 'GET /api/queues/%2f/*', 'GET /%2F', 'GET /%2f/x', 'POST /api/bindings/%2F/... +body']) {
      assert.equal(splitRule(rule, options), null, `${rule} with ${inspect(options)}`);
    }
    assert.deepEqual(splitRule('GET /api/queues/*', options), { words: ['GET', '/api', '/queues', '*'], body: false });
  }
  for (const options of [ON, ...OFF]) {
    assert.deepEqual(splitRule('GET /api/a%2Fb', options), { words: ['GET', '/api', '/a%2Fb'], body: false });
    assert.deepEqual(splitRule('GET /api/%2F%2F', options), { words: ['GET', '/api', '/%2F%2F'], body: false });
    assert.equal(splitRule('GET /%2F/', options), null);
    assert.equal(splitRule('GET /%2F//x', options), null);
  }
});

test('a rule names %2F literally, a star matches it as one segment, and three dots cover it', () => {
  const words = (method, path) => requestWords(readRequest({ method, path }, ON));
  const table = [
    ['GET /api/queues/%2F/*', words('GET', '/api/queues/%2F/orders'), true],
    ['GET /api/queues/%2F/*', words('GET', '/api/queues/%2f/orders'), true],
    ['GET /api/queues/%2f/*', words('GET', '/api/queues/%2F/orders'), true],
    ['GET /api/queues/%2F/*', words('GET', '/api/queues/vh1/orders'), false],
    ['GET /api/queues/%2F/*', words('GET', '/api/queues/%2F'), false],
    ['GET /api/queues/%2F/*', words('GET', '/api/queues/%2F/a/b'), false],
    ['GET /api/queues/*/orders', words('GET', '/api/queues/%2F/orders'), true],
    ['GET /api/queues/*', words('GET', '/api/queues/%2F'), true],
    ['GET /api/queues/...', words('GET', '/api/queues/%2F/orders'), true],
    ['GET /...', words('GET', '/%2F'), true],
    ['GET /api/queues/vh1/*', words('GET', '/api/queues/%2F/orders'), false],
    ['regex(GET /api /queues /%2F /.*)', words('GET', '/api/queues/%2f/orders'), true],
  ];
  for (const [rule, request, expected] of table) {
    assert.equal(matchRequestRule(request, rule, ON), expected, `${rule} on ${request.join(' ')}`);
  }
  const request = words('GET', '/api/queues/%2F/orders');
  for (const options of OFF) {
    assert.equal(matchRequestRule(request, 'GET /api/queues/%2F/*', options), false);
    assert.equal(matchRequestRule(request, 'GET /api/queues/*/orders', options), true);
  }
  assert.equal(matchRequestRule(request, 'GET /api/queues/%2F/*'), false);
});

test('buildUrl keeps a whole %2F segment as written, not decoded and not encoded twice, under the base path', () => {
  const base = 'https://host.example.com/prefix/';
  const built = buildUrl(base, ['api', 'queues', '%2F', 'orders'], []);
  assert.equal(built, 'https://host.example.com/prefix/api/queues/%2F/orders');
  assert.ok(new URL(built).pathname.startsWith('/prefix/'));
  assert.equal(buildUrl(base, ['api', 'queues', '%2f', 'orders'], [['columns', 'name']]), 'https://host.example.com/prefix/api/queues/%2f/orders?columns=name');
  assert.equal(buildUrl(base, ['%2F'], []), 'https://host.example.com/prefix/%2F');
  assert.equal(buildUrl('http://127.0.0.1:15672/', ['%2F', '%2f'], []), 'http://127.0.0.1:15672/%2F/%2f');
  for (const url of [built, buildUrl(base, ['%2F'], [])]) {
    assert.ok(!url.includes('%252'), url);
    assert.ok(!url.includes('prefix//'), url);
  }
});

// A stand-in service that keeps the request line exactly as it came over the socket.
const lines = [];
let raw;
let rawBase;
before(async () => {
  raw = net.createServer((socket) => {
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk) => {
      text += chunk;
      if (!text.includes('\r\n\r\n')) return;
      lines.push(text.slice(0, text.indexOf('\r\n')));
      socket.end('HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    });
  });
  await new Promise((resolve) => { raw.listen(0, '127.0.0.1', resolve); });
  rawBase = `http://127.0.0.1:${raw.address().port}/prefix/`;
});
after(async () => {
  await new Promise((resolve) => { raw.close(resolve); });
});

test('the request line on the wire carries the segment exactly as the agent wrote it', async () => {
  const sendPath = async (path, query) => {
    const request = readRequest({ method: 'GET', path, ...(query ? { query } : {}) }, ON);
    const result = await send({
      baseUrl: rawBase, headers: {}, ...request, timeoutMs: 5000, maxBytes: 1000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, 'HTTP 200\ncontent-type: text/plain\n\nok');
    return lines.at(-1);
  };
  assert.equal(await sendPath('/api/queues/%2F/orders'), 'GET /prefix/api/queues/%2F/orders HTTP/1.1');
  assert.equal(await sendPath('/api/queues/%2f/orders'), 'GET /prefix/api/queues/%2f/orders HTTP/1.1');
  assert.equal(await sendPath('/api/exchanges/%2F', { columns: 'name' }), 'GET /prefix/api/exchanges/%2F?columns=name HTTP/1.1');
  assert.equal(await sendPath('/api/vhosts/%2F'), 'GET /prefix/api/vhosts/%2F HTTP/1.1');
});
