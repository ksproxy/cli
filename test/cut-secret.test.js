import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { answerCall } from '../src/tools.js';

// The http kind with a bearer token, against a loopback stand-in that echoes the Authorization header the way a test
// asks: cut by the call's time limit, by a broken stream, or by the read limit. No piece of the token may be shown.
const TOKEN = 'tok-0123456789-abcdefghij-SECRET-TAIL';
const VISIBLE = 262144;

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-cut-')));
fs.mkdirSync(path.join(root, 'st', 'logs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'cfg'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: path.join(root, 'st'),
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};

let server;
let port;
before(async () => {
  server = http.createServer((req, res) => {
    const value = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (req.url === '/slow') {
      res.write(`before ${value.slice(0, 30)}`);
      const timer = setTimeout(() => res.end(value.slice(30)), 5000);
      res.on('close', () => clearTimeout(timer));
    } else if (req.url === '/broken') {
      res.write(`before ${value.slice(0, 30)}`, () => setTimeout(() => res.socket.destroy(), 50));
    } else {
      res.end(TOKEN.repeat(Math.ceil((2 * VISIBLE) / TOKEN.length)));
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function call(where, timeoutSeconds) {
  const target = {
    kind: 'http', name: 'echo', description: '', allow: ['GET /slow', 'GET /broken', 'GET /many'], baseUrl: `http://127.0.0.1:${port}/`, auth: { bearerEnv: 'T' }, state: 'up',
  };
  return answerCall({
    kind: 'http', name: 'echo', input: { method: 'GET', path: where }, timeoutSeconds,
  }, {
    calls: new Map([['http:echo', { target, secrets: { T: TOKEN } }]]),
    session: { targets: [target] },
    env,
    signal: new AbortController().signal,
    review: async () => null,
    stderr: { write() {} },
  });
}

function assertNoPiece(text) {
  const shown = text.replaceAll('[hidden]', '');
  for (let n = 4; n < TOKEN.length; n += 1) assert.ok(!shown.includes(TOKEN.slice(0, n)), `the first ${n} characters of the token are shown`);
}

test('a bearer token cut by the time limit of the call shows no part', async () => {
  const answer = await call('/slow', 1);
  assert.match(answer.text, /^timed out after 1s\n/);
  assert.match(answer.text, /\nbefore Bearer$/);
  assertNoPiece(answer.text);
});

test('a bearer token cut by a broken stream shows no part', async () => {
  const answer = await call('/broken', 10);
  assert.match(answer.text, /\nbefore Bearer\n--- stderr ---\n/);
  assertNoPiece(answer.text);
});

test('a token cut by the read limit shows no part', async () => {
  const answer = await call('/many', 10);
  assert.match(answer.text, /\[output truncated at 262144 bytes per stream\]$/);
  assertNoPiece(answer.text);
});
