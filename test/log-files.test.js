import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { writeSession } from '../src/session.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world() {
  const base = fs.realpathSync(tempDir('ks-lf-'));
  dirs.push(base);
  const logs = path.join(base, 'st', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  return { env: { ...process.env, KSPROXY_STATE_DIR: path.join(base, 'st') }, logs };
}

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text };
}

function callEntry(n, extra = {}) {
  return {
    ts: `2026-11-20T12:00:${String(n).padStart(2, '0')}.000Z`,
    event: 'call',
    tool: 'ssh_exec',
    kind: 'ssh',
    target: 'web1',
    command: `cmd-${n}`,
    decision: 'allowed',
    rule: 'x',
    exitCode: 0,
    ...extra,
  };
}

function put(logs, name, entries) {
  fs.writeFileSync(path.join(logs, name), entries.map((e) => `${JSON.stringify(e)}\n`).join(''));
}

function commandsOf(stdout) {
  return stdout.trim().split('\n').map((l) => /cmd-(\d+)/.exec(l)?.[1]);
}

test('log goes on into the rotated files, newest first, when -n asks for more than the current file has', async () => {
  const { env, logs } = world();
  put(logs, 'audit-20261120-100000.log', [callEntry(1), callEntry(2)]);
  put(logs, 'audit-20261120-110000.log', [callEntry(3), callEntry(4)]);
  put(logs, 'audit.log', [callEntry(5), callEntry(6)]);
  let r = await cli(['log', '-n', '3'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(commandsOf(r.stdout), ['4', '5', '6']);
  r = await cli(['log', '-n', '50'], env);
  assert.deepEqual(commandsOf(r.stdout), ['1', '2', '3', '4', '5', '6']);
  r = await cli(['log', '-n', '2'], env);
  assert.deepEqual(commandsOf(r.stdout), ['5', '6']);
  r = await cli(['log'], env);
  assert.deepEqual(commandsOf(r.stdout), ['1', '2', '3', '4', '5', '6']);
});

test('log does not read a rotated file it does not need', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
  const { env, logs } = world();
  put(logs, 'audit-20261120-100000.log', [callEntry(1)]);
  put(logs, 'audit-20261120-110000.log', [callEntry(2)]);
  put(logs, 'audit.log', [callEntry(3), callEntry(4)]);
  const oldest = path.join(logs, 'audit-20261120-100000.log');
  fs.chmodSync(oldest, 0o000);
  try {
    const r = await cli(['log', '-n', '3'], env);
    assert.deepEqual(commandsOf(r.stdout), ['2', '3', '4']);
  } finally {
    fs.chmodSync(oldest, 0o600);
  }
});

test('log --denied and --json work across files', async () => {
  const { env, logs } = world();
  const denied = (n) => callEntry(n, { decision: 'refused', short: 'nope' });
  put(logs, 'audit-20261120-100000.log', [denied(1), callEntry(2), { ts: 'x', event: 'list' }, denied(3)]);
  put(logs, 'audit-20261120-110000.log', [callEntry(4), denied(5)]);
  put(logs, 'audit.log', [callEntry(6), denied(7), callEntry(8)]);
  let r = await cli(['log', '--denied', '-n', '10'], env);
  assert.deepEqual(commandsOf(r.stdout), ['1', '3', '5', '7']);
  r = await cli(['log', '--denied', '-n', '2'], env);
  assert.deepEqual(commandsOf(r.stdout), ['5', '7']);
  r = await cli(['log', '--denied', '-n', '3'], env);
  assert.deepEqual(commandsOf(r.stdout), ['3', '5', '7']);
  r = await cli(['log', '--json', '-n', '9'], env);
  const rows = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((e) => e.command ?? e.event), ['cmd-1', 'cmd-2', 'list', 'cmd-3', 'cmd-4', 'cmd-5', 'cmd-6', 'cmd-7', 'cmd-8']);
  r = await cli(['log', '--json', '-n', '3'], env);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l).command), ['cmd-6', 'cmd-7', 'cmd-8']);
});

test('log shows rotated files when the current file is missing, and says no log yet only when there is nothing', async () => {
  const { env, logs } = world();
  let r = await cli(['log'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'no log yet\n');
  put(logs, 'audit-20261120-100000.log', [callEntry(1)]);
  r = await cli(['log'], env);
  assert.equal(r.code, 0);
  assert.deepEqual(commandsOf(r.stdout), ['1']);
});

test('log ignores a file in the logs folder with another name', async () => {
  const { env, logs } = world();
  put(logs, 'audit-old.log', [callEntry(1)]);
  put(logs, 'notes.txt', [callEntry(2)]);
  const r = await cli(['log'], env);
  assert.equal(r.stdout, 'no log yet\n');
});

test('status counts the calls of the session across a rotation', async () => {
  const { env, logs } = world();
  const sessionDir = path.join(path.dirname(logs), 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  writeSession(sessionDir, {
    version: 1, pid: process.pid, startedAt: '2026-11-20T00:00:00.000Z', targets: [],
  });
  put(logs, 'audit-20261120-090000.log', [callEntry(1)]);
  put(logs, 'audit-20261120-100000.log', [callEntry(2), { ts: '2026-11-20T12:00:02.500Z', event: 'session_start' }, callEntry(3)]);
  put(logs, 'audit-20261120-110000.log', [callEntry(4)]);
  put(logs, 'audit.log', [callEntry(5), callEntry(6)]);
  const r = await cli(['status'], env);
  assert.match(r.stdout, /\n {2}last call \d\d:\d\d:\d\d · 4 calls this session\n$/);
});
