import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspect } from 'node:util';
import { AllowError } from '../src/allowlist.js';
import { InventoryError } from '../src/checks.js';
import {
  BODY_WORD, MAX_BODY_BYTES, METHODS, authHeader, authProblem, authVariables, buildUrl, encodedForms, headerNameProblem, hideSecrets,
  matchRequestRule, readRequest, requestWords, reviewWords, send, splitRule, validateBaseUrl,
} from '../src/kinds/engines/http.js';

// The stand-in service: an in-process HTTP server on the loopback address that records every request it gets.
const seen = [];
let server;
let base;

function route(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const hold = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  switch (url.pathname) {
    case '/p/redirect':
      res.writeHead(Number(url.searchParams.get('status')), { location: 'http://127.0.0.2:1/steal', 'content-type': 'text/html' });
      res.end('<a>moved</a>');
      return;
    case '/p/headers':
      res.writeHead(200, {
        'content-type': 'application/json;\tcharset=utf-8', 'set-cookie': 'sid=SECRET-COOKIE', location: '/elsewhere', 'x-other': 'X-OTHER-VALUE',
      });
      res.end('{"ok":true}');
      return;
    case '/p/big':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('b'.repeat(5000));
      return;
    case '/p/slow-head':
      hold(3000).then(() => { if (!res.destroyed) res.end('late'); });
      return;
    case '/p/slow-body':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first part,');
      hold(3000).then(() => { if (!res.destroyed) res.end('second part'); });
      return;
    case '/p/reset':
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('half of it');
      setTimeout(() => res.destroy(), 50);
      return;
    case '/p/missing':
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    case '/p/plain':
      res.writeHead(200);
      res.end('no type');
      return;
    default:
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  }
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body,
      });
      route(req, res, body);
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/p/`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
});

const refusedWith = (input, short) => {
  try {
    readRequest(input);
  } catch (err) {
    assert.ok(err instanceof AllowError, String(err));
    assert.equal(err.short, short, inspect(input));
    return err.message;
  }
  return assert.fail(`not refused: ${inspect(input)}`);
};

const GOOD = { method: 'GET', path: '/api/search' };

test('readRequest gives the method, the segments, the query and the body as sent', () => {
  assert.deepEqual(readRequest(GOOD), {
    method: 'GET', segments: ['api', 'search'], query: [], body: undefined,
  });
  assert.deepEqual(readRequest({ method: 'get', path: '/' }), {
    method: 'GET', segments: [], query: [], body: undefined,
  });
  assert.deepEqual(readRequest({
    method: 'post', path: '/logs-*/_search', query: { q: 'a b', size: 5, pretty: true }, body: { query: { match_all: {} } },
  }), {
    method: 'POST',
    segments: ['logs-*', '_search'],
    query: [['q', 'a b'], ['size', '5'], ['pretty', 'true']],
    body: '{"query":{"match_all":{}}}',
  });
  assert.equal(readRequest({ method: 'PUT', path: '/x', body: [1, 2] }).body, '[1,2]');
  assert.deepEqual(readRequest({ method: 'GET', path: "/a-b_c.d~e!$&'()*+,=:/%C3%A9%20x" }).segments, ["a-b_c.d~e!$&'()*+,=:", '%C3%A9%20x']);
  assert.deepEqual(readRequest({ method: 'GET', path: '/%E6%97%A5/%F0%9F%98%80/a%3Fb' }).segments, ['%E6%97%A5', '%F0%9F%98%80', 'a%3Fb']);
  for (const method of METHODS) assert.equal(readRequest({ method: method.toLowerCase(), path: '/x' }).method, method);
});

test('readRequest refuses every hostile path with its short text', () => {
  const table = [
    [5, 'invalid path'],
    [undefined, 'invalid path'],
    [`/${'a'.repeat(2048)}`, 'path too long'],
    ['/a b', 'space or control character'],
    ['/a\tb', 'space or control character'],
    ['/a\nb', 'space or control character'],
    ['/a\u0000', 'space or control character'],
    ['/a\u0085', 'space or control character'],
    ['/a b', 'space or control character'],
    ['', 'path not absolute'],
    ['api/search', 'path not absolute'],
    ['http://evil.example.com/x', 'path not absolute'],
    ['https:/evil', 'path not absolute'],
    ['/x?token=1', 'query in path'],
    ['/x#frag', 'query in path'],
    ['/x\\y', 'backslash in path'],
    ['\\\\evil/x', 'path not absolute'],
    ['/\\evil', 'backslash in path'],
    ['/user@evil.example.com', 'at sign in path'],
    ['//evil.example.com/x', 'empty segment'],
    ['/a//b', 'empty segment'],
    ['/a/', 'empty segment'],
    ['/./a', 'dot segment'],
    ['/a/..', 'dot segment'],
    ['/a/../b', 'dot segment'],
    ['/...', 'dot segment'],
    ['/a%', 'bad percent-encoding'],
    ['/a%2', 'bad percent-encoding'],
    ['/a%zz', 'bad percent-encoding'],
    ['/a%2fb', 'encoded separator'],
    ['/a%2Fb', 'encoded separator'],
    ['/a%5cb', 'encoded separator'],
    ['/a%5Cb', 'encoded separator'],
    ['/%2e%2e/x', 'encoded separator'],
    ['/%2E', 'encoded separator'],
    ['/a%252fb', 'encoded separator'],
    ['/a%00', 'encoded separator'],
    ['/a%0a', 'encoded separator'],
    ['/a%7F', 'encoded separator'],
    ['/a/..;/b', 'semicolon in path'],
    ['/a/.;/b', 'semicolon in path'],
    ['/a/..;x=1/b', 'semicolon in path'],
    ['/a/;/b', 'semicolon in path'],
    ['/a/b;c', 'semicolon in path'],
    ['/a;', 'semicolon in path'],
    ['/a/..%3B/b', 'encoded separator'],
    ['/a/..%3b/b', 'encoded separator'],
    ['/a/%3B', 'encoded separator'],
    ['/a/%C0%AE%C0%AE', 'invalid UTF-8 encoding'],
    ['/a/%C0%AF', 'invalid UTF-8 encoding'],
    ['/a/%E0%80%AE', 'invalid UTF-8 encoding'],
    ['/a/%C3', 'invalid UTF-8 encoding'],
    ['/a/%FF', 'invalid UTF-8 encoding'],
    ['/a/%ED%A0%80', 'invalid UTF-8 encoding'],
    ['/a"b', 'character """ not allowed'],
    ['/<script>', 'character "<" not allowed'],
    ['/a|b', 'character "|" not allowed'],
    ['/{x}', 'character "{" not allowed'],
    ['/[::1]', 'character "[" not allowed'],
    ['/a^b', 'character "^" not allowed'],
    ['/a`b', 'character "`" not allowed'],
    ['/日', 'character U+65E5 not allowed'],
  ];
  for (const [path, short] of table) refusedWith({ method: 'GET', path }, short);
  assert.equal(refusedWith({ method: 'GET', path: 'http://evil.example.com/x' }, 'path not absolute'),
    'path must start with "/": give the path only, the host comes from the target');
  assert.equal(refusedWith({ method: 'GET', path: '/a%2fb' }, 'encoded separator'),
    'path may not encode "/", "\\", ".", ";", "%" or a control character');
  assert.equal(refusedWith({ method: 'GET', path: '/a/..;/b' }, 'semicolon in path'), 'path may not contain ";"');
  assert.equal(refusedWith({ method: 'GET', path: '/a/%C0%AE' }, 'invalid UTF-8 encoding'),
    'path has a percent-encoding that is not valid UTF-8');
  assert.equal(refusedWith({ method: 'GET', path: `/${'a'.repeat(2048)}` }, 'path too long'), 'path is longer than 2048 bytes');
  assert.equal(refusedWith({ method: 'GET', path: '/a/../b' }, 'dot segment'), 'path may not contain a "." or ".." segment');
  assert.equal(refusedWith({ method: 'GET', path: '/x?y' }, 'query in path'), 'path may not contain "?" or "#": give the query in query');
});

test('readRequest refuses a bad request, method, query or body with its short text', () => {
  for (const input of [null, 'GET /', ['GET', '/'], 5]) refusedWith(input, 'invalid request');
  assert.equal(refusedWith({ ...GOOD, headers: { host: 'evil' } }, 'unknown field'),
    'the request has an unknown field headers: a request has method, path, query and body only');
  refusedWith({ ...GOOD, target: 'x' }, 'unknown field');
  refusedWith({ path: '/x' }, 'invalid method');
  refusedWith({ method: 5, path: '/x' }, 'invalid method');
  for (const method of ['CONNECT', 'TRACE', 'OPTIONS', 'GET /x', 'G\nET', '']) {
    assert.match(refusedWith({ method, path: '/x' }, 'method not allowed'), /is not allowed: use GET, HEAD, POST, PUT, DELETE or PATCH$/);
  }
  const query = (q) => ({ ...GOOD, query: q });
  for (const bad of [null, 'a=1', ['a', '1'], 5]) refusedWith(query(bad), 'invalid query');
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
  assert.equal(refusedWith(query(many), 'query too large'), 'query has more than 50 names');
  assert.equal(readRequest(query(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i])))).query.length, 50);
  for (const name of ['', 'k'.repeat(257), 'a\u0000b', 'a\nb']) {
    assert.equal(refusedWith(query({ [name]: 'v' }), 'invalid query'), 'a query name must be 1 to 256 characters without control characters');
  }
  assert.equal(readRequest(query({ ['k'.repeat(256)]: 'v'.repeat(2048) })).query[0][1].length, 2048);
  for (const value of ['v'.repeat(2049), 'a\rb', 'a\u007f']) {
    assert.equal(refusedWith(query({ k: value }), 'invalid query'), 'a query value must be at most 2048 characters without control characters');
  }
  for (const value of [null, {}, [], Number.NaN, Infinity]) {
    assert.equal(refusedWith(query({ k: value }), 'invalid query'), 'the query value of k must be a string, a number, true or false');
  }
  const body = (b, method = 'POST') => ({ method, path: '/x', body: b });
  for (const bad of [null, 'not json', '{"a":1}', 5, true]) {
    assert.equal(refusedWith(body(bad), 'invalid body'), 'body must be a JSON object or array');
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(refusedWith(body(cyclic), 'invalid body'), 'body cannot be written as JSON');
  assert.equal(refusedWith(body({ big: 1n }), 'invalid body'), 'body cannot be written as JSON');
  const fits = { a: 'x'.repeat(MAX_BODY_BYTES - 8) };
  assert.equal(Buffer.byteLength(JSON.stringify(fits)), MAX_BODY_BYTES);
  assert.equal(readRequest(body(fits)).body.length, MAX_BODY_BYTES);
  assert.equal(refusedWith(body({ a: 'x'.repeat(MAX_BODY_BYTES - 7) }), 'body too large'), 'body is larger than 64 KiB');
  for (const method of ['GET', 'HEAD', 'get']) {
    assert.equal(refusedWith(body({}, method), 'body not allowed'), 'a GET or HEAD request cannot carry a body');
  }
  assert.equal(readRequest({ ...GOOD, body: undefined }).body, undefined);
});

test('requestWords: the method, one word per segment with its slash, and +body when a body is sent', () => {
  assert.deepEqual(requestWords(readRequest({ method: 'GET', path: '/_cat/indices' })), ['GET', '/_cat', '/indices']);
  assert.deepEqual(requestWords(readRequest({ method: 'GET', path: '/' })), ['GET']);
  assert.deepEqual(requestWords(readRequest({ method: 'POST', path: '/*/_search', body: {} })), ['POST', '/*', '/_search', BODY_WORD]);
  assert.deepEqual(requestWords(readRequest({ method: 'GET', path: '/x', query: { a: 'b' } })), ['GET', '/x']);
});

test('reviewWords: the words of the rules, then one word per query name with its value, encoded as on the wire', () => {
  assert.deepEqual(reviewWords(readRequest({ method: 'GET', path: '/x' })), ['GET', '/x']);
  assert.deepEqual(reviewWords(readRequest({
    method: 'POST', path: '/x', query: { q: 'a b', 'n&m': 'x=y"', size: 5 }, body: {},
  })), ['POST', '/x', BODY_WORD, '?q=a+b', '?n%26m=x%3Dy%22', '?size=5']);
});

test('readRequest refuses a query name that can change the method on the server, in any letter case', () => {
  for (const name of ['_method', '_METHOD', 'X-HTTP-Method-Override', 'x-method-override', 'X-Http-Method']) {
    assert.equal(refusedWith({ ...GOOD, query: { a: '1', [name]: 'DELETE' } }, 'method override refused'),
      `the query name ${name} is refused: a server may read it as another method`);
  }
  for (const name of ['method', '_method_x', 'x-http-methods', 'override']) {
    assert.deepEqual(readRequest({ ...GOOD, query: { [name]: 'DELETE' } }).query, [[name, 'DELETE']]);
  }
});

test('splitRule splits a rule the way a request is split, and gives null for any other form', () => {
  assert.deepEqual(splitRule('GET /api/dashboards/uid/*'), { words: ['GET', '/api', '/dashboards', '/uid', '*'], body: false });
  assert.deepEqual(splitRule('  GET   /_cat/...  '), { words: ['GET', '/_cat', '...'], body: false });
  assert.deepEqual(splitRule('POST /*/_search +body'), { words: ['POST', '*', '/_search'], body: true });
  assert.deepEqual(splitRule('GET /\\*/_search'), { words: ['GET', '/*', '/_search'], body: false });
  assert.deepEqual(splitRule('GET /logs-*/_search'), { words: ['GET', '/logs-*', '/_search'], body: false });
  assert.deepEqual(splitRule('* /'), { words: ['*'], body: false });
  for (const rule of ['GET', 'GET /x extra', 'GET /x +body extra', 'get /x', 'FETCH /x', 'GET x', 'GET //x', 'GET /x/', 'GET /.../x', '...']) {
    assert.equal(splitRule(rule), null, rule);
  }
});

test('the rules: *, ..., \\*, a literal star inside a segment, +body and regex(...)', () => {
  const words = (method, path, body) => requestWords(readRequest({ method, path, ...(body ? { body: {} } : {}) }));
  const table = [
    ['GET /api/search', words('GET', '/api/search'), true],
    ['GET /api/search', words('GET', '/api/search/x'), false],
    ['GET /api/search', words('POST', '/api/search'), false],
    ['GET /api/dashboards/uid/*', words('GET', '/api/dashboards/uid/abc'), true],
    ['GET /api/dashboards/uid/*', words('GET', '/api/dashboards/uid'), false],
    ['GET /api/dashboards/uid/*', words('GET', '/api/dashboards/uid/a/b'), false],
    ['GET /_cat/...', words('GET', '/_cat'), true],
    ['GET /_cat/...', words('GET', '/_cat/indices/x'), true],
    ['GET /_cat/...', words('GET', '/_cluster/health'), false],
    ['GET /_cat/...', ['GET', '/_cat', '/indices', BODY_WORD], false],
    ['GET /*', ['GET', BODY_WORD], false],
    ['GET /\\*/_search', words('GET', '/*/_search'), true],
    ['GET /\\*/_search', words('GET', '/logs/_search'), false],
    ['GET /*/_search', words('GET', '/logs/_search'), true],
    ['GET /*/_search', words('GET', '/*/_search'), true],
    ['GET /logs-*/_search', words('GET', '/logs-*/_search'), true],
    ['GET /logs-*/_search', words('GET', '/logs-2026/_search'), false],
    ['POST /*/_search +body', words('POST', '/logs/_search', true), true],
    ['POST /*/_search +body', words('POST', '/logs/_search'), false],
    ['POST /*/_search', words('POST', '/logs/_search', true), false],
    ['POST /...', words('POST', '/a/b', true), false],
    ['POST /... +body', words('POST', '/a/b', true), true],
    ['* /api/health', words('DELETE', '/api/health'), true],
    ['regex(GET /api /v[12] /users)', words('GET', '/api/v1/users'), true],
    ['regex(GET /api /v[12] /users)', words('GET', '/api/v3/users'), false],
    ['regex(GET /api /v[12] /users)', words('GET', '/api/v1/users/x'), false],
    ['regex(POST /logs-[a-z]+ /_search \\+body)', words('POST', '/logs-web/_search', true), true],
    ['regex(POST /logs-[a-z]+ /_search)', words('POST', '/logs-web/_search', true), false],
    ['GET /x extra', words('GET', '/x'), false],
  ];
  for (const [rule, request, expected] of table) {
    assert.equal(matchRequestRule(request, rule), expected, `${rule} on ${request.join(' ')}`);
  }
});

test('validateBaseUrl is the reviewer URL check, and the base always ends in a slash', () => {
  assert.equal(validateBaseUrl('https://grafana.example.com', 'http "g": baseUrl'), 'https://grafana.example.com/');
  assert.equal(validateBaseUrl('https://h.example.com:8443/prefix', 'x'), 'https://h.example.com:8443/prefix/');
  assert.equal(validateBaseUrl('https://h.example.com/prefix/', 'x'), 'https://h.example.com/prefix/');
  for (const local of ['http://localhost:9200', 'http://127.0.0.1:9200/', 'http://[::1]:9200']) assert.ok(validateBaseUrl(local, 'x').endsWith('/'));
  const fails = (value, message) => assert.throws(() => validateBaseUrl(value, 'http "g": baseUrl'), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, `http "g": baseUrl: ${message}`);
    return true;
  });
  for (const value of [undefined, 5, 'not a url', '']) fails(value, 'must be a URL');
  for (const value of ['http://grafana.example.com', 'http://127.0.0.2', 'ftp://h.example.com', 'file:///etc/passwd']) {
    fails(value, 'must use https (http is accepted for localhost only)');
  }
  for (const value of ['https://u@h.example.com', 'https://u:p@h.example.com', 'https://h.example.com/?a=1', 'https://h.example.com/#f']) {
    fails(value, 'must not contain a user name, a password, a query or a fragment');
  }
});

test('buildUrl keeps the host and the base path; a URL that would leave them is refused', () => {
  assert.equal(buildUrl('https://host.example.com/prefix/', ['api', 'search'], []), 'https://host.example.com/prefix/api/search');
  assert.equal(buildUrl('https://host.example.com/prefix/', [], []), 'https://host.example.com/prefix/');
  assert.equal(buildUrl('https://host.example.com/', ['x'], [['q', 'a b&c=d'], ['n', '1']]), 'https://host.example.com/x?q=a+b%26c%3Dd&n=1');
  assert.equal(buildUrl('http://[::1]:9200/', ['x'], []), 'http://[::1]:9200/x');
  const leaves = (segments) => assert.throws(() => buildUrl('https://host.example.com/prefix/', segments, []), (err) => {
    assert.ok(err instanceof AllowError);
    assert.equal(err.short, 'path leaves base');
    assert.equal(err.message, 'the path would leave the base URL of the target');
    return true;
  });
  leaves(['..', 'other']);
  leaves(['%2e%2e', 'other']);
  leaves(['x#frag']);
});

test('the auth forms, the variables they name, and the checks on header names and secret values', () => {
  const bearer = { bearerEnv: 'TOK' };
  const basic = { basicUserEnv: 'USR', basicPasswordEnv: 'PWD_X' };
  const header = { headerName: 'X-Api-Key', headerEnv: 'KEY' };
  const secrets = {
    TOK: 'tok-1', USR: 'elastic', PWD_X: 'p:w ö', KEY: 'k-1',
  };
  assert.deepEqual(authVariables(null), []);
  assert.deepEqual(authVariables(bearer), ['TOK']);
  assert.deepEqual(authVariables(basic), ['USR', 'PWD_X']);
  assert.deepEqual(authVariables(header), ['KEY']);
  assert.deepEqual(authHeader(null, secrets), {});
  assert.deepEqual(authHeader(bearer, secrets), { authorization: 'Bearer tok-1' });
  assert.deepEqual(authHeader(basic, secrets), { authorization: `Basic ${Buffer.from('elastic:p:w ö').toString('base64')}` });
  assert.deepEqual(authHeader(header, secrets), { 'x-api-key': 'k-1' });
  assert.equal(authProblem(null, {}), null);
  assert.equal(authProblem(bearer, secrets), null);
  assert.equal(authProblem(basic, secrets), null);
  assert.equal(authProblem(header, secrets), null);
  for (const value of ['a\nb', 'a\rb', 'a\u0000', 'tok\u007f', 'tök', 'a\tb']) {
    assert.equal(authProblem(bearer, { TOK: value }), 'TOK holds a character that is not allowed', JSON.stringify(value));
    assert.equal(authProblem(header, { KEY: value }), 'KEY holds a character that is not allowed', JSON.stringify(value));
  }
  for (const user of ['a:b', 'a\nb', 'a\u0085']) assert.equal(authProblem(basic, { USR: user, PWD_X: 'p' }), 'USR holds a character that is not allowed');
  assert.equal(authProblem(basic, { USR: 'u', PWD_X: 'p\r\nX-Evil: 1' }), 'PWD_X holds a character that is not allowed');
  assert.equal(headerNameProblem('X-Api-Key'), null);
  for (const name of ['Host', 'content-length', 'Transfer-Encoding', 'connection', 'Cookie', 'AUTHORIZATION', 'accept', 'Content-Type', 'X Key', 'X:Key', '', 'x'.repeat(65), 5]) {
    assert.equal(headerNameProblem(name), 'must be letters, digits and "-", and not one of host, content-length, transfer-encoding, connection, cookie, authorization, accept, content-type', String(name));
  }
});

test('encodedForms gives the base64 credential of basic auth and nothing for the other forms', () => {
  const secrets = {
    U: 'user', P: 'pass', T: 'tok', H: 'hv',
  };
  assert.deepEqual(encodedForms({ basicUserEnv: 'U', basicPasswordEnv: 'P' }, secrets), [Buffer.from('user:pass').toString('base64')]);
  assert.deepEqual(encodedForms({ bearerEnv: 'T' }, secrets), []);
  assert.deepEqual(encodedForms({ headerName: 'X-Key', headerEnv: 'H' }, secrets), []);
  assert.deepEqual(encodedForms(null, secrets), []);
});

test('hideSecrets replaces every value, longest first', () => {
  assert.equal(hideSecrets('a tok-1 and Bearer tok-1 and tok-12', ['tok-1', 'tok-12', '']), 'a [hidden] and Bearer [hidden] and [hidden]');
  assert.equal(hideSecrets('nothing', []), 'nothing');
});

const sendTo = (path, extra = {}) => {
  const request = readRequest({ method: 'GET', path, ...extra.request });
  return send({
    baseUrl: base, headers: {}, ...request, timeoutMs: 5000, maxBytes: 262144, ...extra,
  });
};

test('send: each auth form is on the wire as one header, and no header comes from the agent', async () => {
  const forms = [
    [null, {}],
    [{ bearerEnv: 'TOK' }, { authorization: 'Bearer tok-W1' }],
    [{ basicUserEnv: 'USR', basicPasswordEnv: 'PWD_X' }, { authorization: `Basic ${Buffer.from('elastic:pw-W2').toString('base64')}` }],
    [{ headerName: 'X-Api-Key', headerEnv: 'KEY' }, { 'x-api-key': 'key-W3' }],
  ];
  const secrets = {
    TOK: 'tok-W1', USR: 'elastic', PWD_X: 'pw-W2', KEY: 'key-W3',
  };
  const fetchHeaders = ['host', 'connection', 'user-agent', 'accept-language', 'sec-fetch-mode', 'accept-encoding'];
  for (const [auth, expected] of forms) {
    const before = seen.length;
    const result = await send({
      baseUrl: base,
      headers: authHeader(auth, secrets),
      ...readRequest({ method: 'POST', path: '/api/ds/query', body: { queries: [1] } }),
      timeoutMs: 5000,
      maxBytes: 262144,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(seen.length, before + 1);
    const got = seen.at(-1);
    assert.equal(got.url, '/p/api/ds/query');
    assert.equal(got.body, '{"queries":[1]}');
    assert.equal(got.headers.accept, 'application/json, */*');
    assert.equal(got.headers['content-type'], 'application/json');
    for (const [name, value] of Object.entries(expected)) assert.equal(got.headers[name], value);
    const names = Object.keys(got.headers).sort();
    const allowed = new Set([...fetchHeaders, 'accept', 'content-type', 'content-length', ...Object.keys(expected)]);
    assert.deepEqual(names.filter((n) => !allowed.has(n)), [], names.join(', '));
    if (auth === null) assert.equal(got.headers.authorization, undefined);
  }
  await sendTo('/get');
  assert.equal(seen.at(-1).headers['content-type'], undefined);
  assert.equal(seen.at(-1).headers['content-length'], undefined);
});

test('send: the reply is the status, the content type and the body; other reply headers never show', async () => {
  const ok = await sendTo('/echo', { request: { query: { q: 'a b' } } });
  assert.deepEqual(ok, {
    exitCode: 0,
    stdout: `HTTP 200\ncontent-type: application/json\n\n${JSON.stringify({ method: 'GET', url: '/p/echo?q=a+b', body: '' })}`,
    stderr: '',
    truncated: false,
  });
  const headers = await sendTo('/headers');
  assert.equal(headers.stdout, 'HTTP 200\ncontent-type: application/json;charset=utf-8\n\n{"ok":true}');
  for (const hidden of ['SECRET-COOKIE', 'set-cookie', 'elsewhere', 'X-OTHER-VALUE']) assert.ok(!headers.stdout.includes(hidden));
  assert.equal((await sendTo('/plain')).stdout, 'HTTP 200\ncontent-type: (none)\n\nno type');
  const missing = await sendTo('/missing');
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, 'HTTP 404\ncontent-type: application/json\n\n{"error":"not found"}');
  const head = await sendTo('/echo', { method: 'HEAD' });
  assert.equal(head.exitCode, 0);
  assert.equal(head.stdout, 'HTTP 200\ncontent-type: application/json\n\n');
});

test('send: a redirect is never followed and is reported as an error, without a second request', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const before = seen.length;
    const result = await send({
      baseUrl: base,
      headers: { authorization: 'Bearer tok-R' },
      ...readRequest({ method: 'GET', path: '/redirect', query: { status } }),
      timeoutMs: 5000,
      maxBytes: 262144,
    });
    assert.deepEqual(result, {
      exitCode: 1,
      stdout: `HTTP ${status}\ncontent-type: text/html\n\n`,
      stderr: 'the service answered with a redirect, which is not followed\n',
    }, String(status));
    assert.equal(seen.length, before + 1, `one request only for ${status}`);
    assert.ok(!result.stdout.includes('127.0.0.2'));
  }
  const empty = await send({
    baseUrl: 'https://service.example.com/',
    headers: {},
    ...readRequest(GOOD),
    timeoutMs: 1000,
    maxBytes: 100,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }),
  });
  assert.equal(empty.stdout, 'HTTP 302\ncontent-type: (none)\n\n');
});

test('send: a large reply is cut at the limit, a slow one ends at the time limit, a broken one is reported', async () => {
  const big = await sendTo('/big', { maxBytes: 1000 });
  assert.equal(big.truncated, true);
  assert.equal(big.exitCode, 0);
  assert.equal(big.stdout, `HTTP 200\ncontent-type: text/plain\n\n${'b'.repeat(1000)}`);
  assert.equal((await sendTo('/big', { maxBytes: 5000 })).truncated, false);

  let started = Date.now();
  assert.deepEqual(await sendTo('/slow-head', { timeoutMs: 300 }), {
    exitCode: null, stdout: '', stderr: '', timedOut: true,
  });
  assert.ok(Date.now() - started < 2500);
  started = Date.now();
  assert.deepEqual(await sendTo('/slow-body', { timeoutMs: 300 }), {
    exitCode: null, stdout: 'HTTP 200\ncontent-type: text/plain\n\nfirst part,', stderr: '', timedOut: true,
  });
  assert.ok(Date.now() - started < 2500);

  const stopper = new AbortController();
  setTimeout(() => stopper.abort(), 100);
  assert.equal((await sendTo('/slow-head', { signal: stopper.signal, timeoutMs: 5000 })).timedOut, true);

  assert.deepEqual(await sendTo('/reset'), {
    exitCode: 1, stdout: 'HTTP 200\ncontent-type: text/plain\n\nhalf of it', stderr: 'the reply was cut off\n', truncated: false,
  });
  const closed = http.createServer();
  await new Promise((resolve) => { closed.listen(0, '127.0.0.1', resolve); });
  const { port } = closed.address();
  await new Promise((resolve) => { closed.close(resolve); });
  assert.deepEqual(await send({
    baseUrl: `http://127.0.0.1:${port}/`, headers: {}, ...readRequest(GOOD), timeoutMs: 2000, maxBytes: 100,
  }), { exitCode: 1, stdout: '', stderr: 'the service could not be reached\n' });
});

test('send never reaches the service with a hostile path: the reader refuses each one first', async () => {
  const before = seen.length;
  for (const path of ['//127.0.0.2/x', '/a/../../x', '/%2e%2e/x', '/a%2fb', 'http://127.0.0.2/', '/x?y=1', '/@x', '/\\x']) {
    assert.throws(() => readRequest({ method: 'GET', path }), AllowError);
  }
  assert.equal(seen.length, before);
});
