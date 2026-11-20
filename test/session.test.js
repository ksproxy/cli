import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  writeSession, readSession, isLive, liveSession, clearSession, processStartTime,
} from '../src/session.js';

function tmp() {
  return fs.mkdtempSync(path.join('/tmp', 'ks-sess-'));
}

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

test('write then read round-trips', () => {
  const dir = path.join(tmp(), 'session');
  const session = { version: 1, pid: process.pid, startedAt: 'x', targets: [{ kind: 'ssh', name: 'a' }] };
  writeSession(dir, session);
  assert.deepEqual(readSession(dir), session);
  assert.equal(fs.statSync(path.join(dir, 'session.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('readSession is null for an empty dir and a corrupt file', () => {
  const dir = tmp();
  assert.equal(readSession(dir), null);
  fs.writeFileSync(path.join(dir, 'session.json'), '{not json');
  assert.equal(readSession(dir), null);
});

test('isLive', () => {
  assert.equal(isLive({ pid: process.pid }), true);
  assert.equal(isLive({ pid: deadPid() }), false);
  assert.equal(isLive(null), false);
  assert.equal(isLive({}), false);
  assert.equal(isLive({ pid: -1 }), false);
  assert.equal(isLive({ pid: 1.5 }), false);
});

test('liveSession', () => {
  const dir = tmp();
  assert.equal(liveSession(dir), null);
  writeSession(dir, { pid: process.pid });
  assert.equal(liveSession(dir).pid, process.pid);
  writeSession(dir, { pid: deadPid() });
  assert.equal(liveSession(dir), null);
});

test('clearSession removes the file and tolerates absence', () => {
  const dir = tmp();
  writeSession(dir, { pid: process.pid });
  clearSession(dir);
  assert.equal(fs.existsSync(path.join(dir, 'session.json')), false);
  clearSession(dir);
});

test('isLive detects a reused pid through processStartedAt', () => {
  const started = processStartTime(process.pid);
  assert.equal(typeof started, 'number');
  assert.equal(isLive({ pid: process.pid, processStartedAt: 0 }), false);
  assert.equal(isLive({ pid: process.pid, processStartedAt: started }), true);
  assert.equal(isLive({ pid: process.pid, processStartedAt: started + 4000 }), true);
  assert.equal(isLive({ pid: process.pid, processStartedAt: started - 4000 }), true);
  assert.equal(isLive({ pid: process.pid, processStartedAt: started + 6000 }), false);
  assert.equal(isLive({ pid: process.pid, processStartedAt: started - 6000 }), false);
  assert.equal(isLive({ pid: process.pid }), true);
});

test('processStartTime is close to the real start and null for a dead pid', () => {
  const real = Date.now() - process.uptime() * 1000;
  const started = processStartTime(process.pid);
  assert.equal(typeof started, 'number');
  assert.ok(Math.abs(started - real) <= 5000, `${started} vs ${real}`);
  assert.equal(processStartTime(deadPid()), null);
});
