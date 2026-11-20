import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bounded, closeStaleSockets, emptyDirectory, fileSize, startFollower,
} from '../src/start.js';
import { fakeSsh, waitFor } from './start-helpers.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-su-')));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('bounded resolves when the promise settles, whichever way, and never calls the timeout handler then', async () => {
  let called = 0;
  await bounded(Promise.resolve('x'), 1000, () => { called += 1; });
  await bounded(Promise.reject(new Error('failed')), 1000, () => { called += 1; });
  assert.equal(called, 0);
});

test('bounded gives up after the limit and runs the timeout handler once', async () => {
  let called = 0;
  const started = Date.now();
  await bounded(new Promise(() => {}), 30, () => { called += 1; });
  assert.equal(called, 1);
  assert.ok(Date.now() - started >= 25);
  await bounded(new Promise(() => {}), 10);
});

test('bounded survives a timeout handler that throws', async () => {
  await bounded(new Promise(() => {}), 10, () => { throw new Error('handler failed'); });
});

test('emptyDirectory removes everything except the kept names and tolerates a missing folder', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'keep'), '1');
    fs.writeFileSync(path.join(dir, 'drop'), '2');
    fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sub', 'deep', 'f'), '3');
    emptyDirectory(dir, ['keep']);
    assert.deepEqual(fs.readdirSync(dir), ['keep']);
    emptyDirectory(dir);
    assert.deepEqual(fs.readdirSync(dir), []);
    emptyDirectory(path.join(dir, 'missing'));
  } finally {
    rm(dir);
  }
});

test('emptyDirectory removes every entry it can and goes on past one it cannot remove', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, () => {
  const dir = tmp();
  const traps = ['m-trap-1', 'm-trap-2'].map((name) => path.join(dir, name));
  try {
    for (const trap of traps) fs.mkdirSync(path.join(trap, 'inner'), { recursive: true });
    for (let i = 0; i < 10; i += 1) {
      fs.writeFileSync(path.join(dir, `a-file-${i}`), 'x');
      fs.mkdirSync(path.join(dir, `z-dir-${i}`));
    }
    for (const trap of traps) fs.chmodSync(trap, 0o000);
    emptyDirectory(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['m-trap-1', 'm-trap-2']);
  } finally {
    for (const trap of traps) {
      try {
        fs.chmodSync(trap, 0o700);
      } catch {
        // not created
      }
    }
    rm(dir);
  }
});

test('fileSize is the size of a file and 0 for a missing one', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'f'), 'abcd');
    assert.equal(fileSize(path.join(dir, 'f')), 4);
    assert.equal(fileSize(path.join(dir, 'none')), 0);
  } finally {
    rm(dir);
  }
});

test('closeStaleSockets closes every leftover socket except pid files and tolerates a missing folder', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'ssh-a'), '');
    fs.writeFileSync(path.join(dir, 'tun-b'), '');
    fs.writeFileSync(path.join(dir, 'kube-c.pid'), '{}');
    const log = path.join(dir, 'ssh.log');
    const env = { ...process.env, KSPROXY_SSH: fakeSsh, KSPROXY_FAKE_SSH_LOG: log };
    await closeStaleSockets(dir, env);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['kube-c.pid', 'ssh.log']);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(calls.map((c) => c.slice(0, 4)).sort(), [
      ['-S', path.join(dir, 'ssh-a'), '-O', 'exit'],
      ['-S', path.join(dir, 'tun-b'), '-O', 'exit'],
    ]);
    await closeStaleSockets(path.join(dir, 'missing'), env);
  } finally {
    rm(dir);
  }
});

function follow(file, from, intervalMs = 20) {
  const entries = [];
  const follower = startFollower(file, (entry) => entries.push(entry), from, intervalMs);
  return { entries, follower };
}

test('the follower delivers complete lines only, skips blank and broken ones, and joins a split line', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '{"n":0}\n');
  const { entries, follower } = follow(file, fs.statSync(file).size);
  try {
    fs.appendFileSync(file, '{"n":1}\n\nnot json\n{"n":2');
    await waitFor(() => entries.length === 1, 10000, 'the first entry');
    assert.deepEqual(entries, [{ n: 1 }]);
    fs.appendFileSync(file, '}\n{"n":3}\n');
    await waitFor(() => entries.length === 3, 10000, 'the rest');
    assert.deepEqual(entries, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('the follower waits for a file that does not exist yet and reads it from the start', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  const { entries, follower } = follow(file, 999);
  try {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(entries, []);
    fs.writeFileSync(file, '{"n":1}\n');
    await waitFor(() => entries.length === 1, 10000, 'the entry');
    assert.deepEqual(entries, [{ n: 1 }]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('the follower starts over when the file is truncated or replaced by a new one', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '{"n":"old-long-entry-1"}\n{"n":"old-long-entry-2"}\n');
  const { entries, follower } = follow(file, fs.statSync(file).size);
  try {
    fs.writeFileSync(file, '{"n":1}\n');
    await waitFor(() => entries.length === 1, 10000, 'the entry after truncation');
    fs.renameSync(file, `${file}.1`);
    fs.writeFileSync(file, '{"n":2}\n{"n":3}\n{"n":4}\n');
    await waitFor(() => entries.length === 4, 10000, 'the entries after rotation');
    assert.deepEqual(entries, [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('the follower keeps going when a read fails, and stop never throws', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '{"n":0}\n');
  const { entries, follower } = follow(file, fs.statSync(file).size);
  try {
    fs.rmSync(file);
    fs.mkdirSync(file);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(entries, []);
    fs.rmSync(file, { recursive: true });
    fs.writeFileSync(file, '{"n":1}\n');
    await waitFor(() => entries.length === 1, 10000, 'recovery');
    fs.rmSync(file);
    fs.mkdirSync(file);
    follower.stop();
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('the follower survives a file it cannot open, on a tick and on stop, and reads it once it can', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '{"n":7}\n');
  fs.chmodSync(file, 0o000);
  const { entries, follower } = follow(file, 0, 5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(entries, []);
    assert.doesNotThrow(() => follower.stop());
    assert.deepEqual(entries, []);
    fs.chmodSync(file, 0o600);
    follower.stop();
    assert.deepEqual(entries, [{ n: 7 }]);
  } finally {
    fs.chmodSync(file, 0o600);
    rm(dir);
  }
});
