import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { listenerLines, readListener } from '../src/listen-status.js';
import { processStartTime, writeSession } from '../src/session.js';
import { newToken, revokeToken, tokenPath } from '../src/token.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

const STATE = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const LAST_CALL = new Date(2026, 10, 24, 9, 5, 7);

function world() {
  const base = fs.realpathSync(tempDir('ks-ls-'));
  const env = { ...process.env, [CONFIG]: path.join(base, 'cfg'), [STATE]: path.join(base, 'st') };
  const listen = path.join(base, 'st', 'listen');
  fs.mkdirSync(listen, { recursive: true });
  return { env, listen, file: path.join(listen, 'listen.json') };
}

function session(env, project = null) {
  const dir = project === null ? path.join(env[STATE], 'session') : path.join(env[STATE], 'p', project, 'session');
  writeSession(dir, {
    version: 1, pid: process.pid, startedAt: '2026-11-24T00:00:00.000Z', targets: [],
  });
}

const client = (extra) => ({
  from: '192.0.2.31',
  client: 'claude-code 2.1',
  firstSeen: LAST_CALL.toISOString(),
  lastCall: LAST_CALL.toISOString(),
  calls: 3,
  projects: ['shop', 'default'],
  open: 1,
  wrong: 0,
  ...extra,
});

function record(extra) {
  return {
    version: 1,
    pid: process.pid,
    addresses: ['192.0.2.20:7777', '127.0.0.1:7777'],
    tls: false,
    clients: [client(), client({
      from: '192.0.2.50', client: 'unknown', open: 0, lastCall: null, firstSeen: null, calls: 0, projects: [], wrong: 2,
    })],
    ...extra,
  };
}

const write = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));

async function status(env, args = []) {
  const proc = fakeProcess();
  const code = await main(['status', ...args], env, { process: proc });
  return { code, lines: proc.stdout.text.split('\n').filter((line) => line !== '') };
}

test('status prints the listener, the token and each client after the sessions', async () => {
  const { env, file } = world();
  session(env);
  newToken(env, new Date('2026-11-01T10:00:00.000Z'));
  write(file, record());
  const r = await status(env);
  assert.equal(r.code, 0);
  assert.equal(r.lines[0], `session pid ${process.pid}, started 2026-11-24T00:00:00.000Z`);
  assert.deepEqual(r.lines.slice(1), [
    'listening on 192.0.2.20:7777, 127.0.0.1:7777 (http)',
    'token from 2026-11-01, expires 2027-11-01',
    '  192.0.2.31  claude-code 2.1  connected  last call 2026-11-24 09:05:07  3 calls  projects shop, default',
    '  192.0.2.50  unknown  not connected  last call never  0 calls',
    '  refused 2 wrong tokens from 192.0.2.50',
  ]);
});

test('status says https when the listener uses TLS', async () => {
  const { env, file } = world();
  session(env);
  write(file, record({ tls: true, clients: [] }));
  const r = await status(env);
  assert.equal(r.lines[1], 'listening on 192.0.2.20:7777, 127.0.0.1:7777 (https)');
  assert.equal(r.lines.length, 3);
});

test('status names each state of the token', () => {
  const { env, file } = world();
  write(file, record({ clients: [] }));
  const token = () => listenerLines(env)[1];
  assert.equal(token(), 'no token');
  newToken(env, new Date('2020-01-01T00:00:00.000Z'));
  assert.equal(token(), 'token expired');
  newToken(env);
  revokeToken(env);
  assert.equal(token(), 'token revoked');
  fs.writeFileSync(tokenPath(env), 'not json');
  assert.equal(token(), 'token file cannot be read');
});

test('status --project prints the same listener lines', async () => {
  const { env, file } = world();
  session(env, 'shop');
  write(file, record());
  const all = listenerLines(env);
  const r = await status({ ...env, [['KSPROXY', 'PROJECT'].join('_')]: 'shop' }, ['--project', 'shop']);
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines.slice(-all.length), all);
  assert.equal(all.length, 5);
});

test('status prints nothing of the listener for a dead pid, a bad file or a wrong shape', async () => {
  const { env, file } = world();
  session(env);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const bad = [
    record({ pid: dead }),
    record({ processStartedAt: 0 }),
    'this is not JSON',
    '[]',
    record({ version: 2 }),
    record({ pid: 'x' }),
    record({ addresses: [] }),
    record({ addresses: [1] }),
    record({ tls: 'yes' }),
    record({ clients: {} }),
    record({ clients: [null] }),
    record({ clients: [client({ calls: -1 })] }),
    record({ clients: [client({ open: 1.5 })] }),
    record({ clients: [client({ lastCall: 'yesterday' })] }),
    record({ clients: [client({ projects: [3] })] }),
    record({ clients: [client({ from: 4 })] }),
  ];
  for (const value of bad) {
    write(file, value);
    assert.equal(readListener(env), null, JSON.stringify(value));
    const r = await status(env);
    assert.equal(r.code, 0);
    assert.equal(r.lines.length, 1);
  }
  write(file, record({ processStartedAt: processStartTime(process.pid) }));
  assert.notEqual(readListener(env), null);
  fs.rmSync(file);
  assert.deepEqual(listenerLines(env), []);
  fs.mkdirSync(file);
  assert.deepEqual(listenerLines(env), []);
});

test('status cleans every text of the file before it is printed', () => {
  const { env, file } = world();
  write(file, record({
    addresses: ['\u001b[31m192.0.2.1:1'],
    clients: [client({ from: 'a\u001bb', client: 'c\u0007', projects: ['p\nq'] })],
  }));
  const text = listenerLines(env).join('\n');
  assert.ok(!/[\u0000-\u0009\u000b-\u001f]/.test(text));
  assert.ok(text.includes('\\u001b[31m192.0.2.1:1'));
  assert.ok(text.includes('a\\u001bb  c\\u0007'));
  assert.ok(text.includes('p\\u000aq'));
});
