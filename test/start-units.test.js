import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    fs.writeFileSync(path.join(dir, 'review-sock'), '');
    const log = path.join(dir, 'ssh.log');
    const env = { ...process.env, KSPROXY_SSH: fakeSsh, KSPROXY_FAKE_SSH_LOG: log };
    await closeStaleSockets(dir, env);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['kube-c.pid', 'review-sock', 'ssh.log']);
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

function follow(file, from, intervalMs = 20, maxBytes = undefined) {
  const entries = [];
  const follower = startFollower(file, (entry) => entries.push(entry), from, intervalMs, maxBytes);
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

function rotatedIn(dir) {
  return fs.readdirSync(dir).filter((n) => /^audit-\d{8}-\d{6}(-\d+)?\.log$/.test(n)).sort();
}

function line(n, pad = 0) {
  return `${JSON.stringify({ n, pad: 'x'.repeat(pad) })}\n`;
}

test('the follower rotates a log over the limit after reading it, then reads the new file from its start', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 20, 300);
  try {
    fs.appendFileSync(file, line(1, 200) + line(2, 200));
    await waitFor(() => rotatedIn(dir).length === 1, 10000, 'the rotation');
    assert.ok(!fs.existsSync(file));
    fs.writeFileSync(file, line(3, 100) + line(4));
    await waitFor(() => entries.length === 4, 10000, 'the entries of the new file');
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3, 4]);
    assert.equal(rotatedIn(dir).length, 1);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('an entry appended between the last read and the rename is still delivered, once and in order', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const entries = [];
  let late = false;
  const follower = startFollower(file, (entry) => {
    entries.push(entry);
    if (entry.n === 2 && !late) {
      late = true;
      fs.appendFileSync(file, line(3) + line(4));
    }
  }, 0, 20, 300);
  try {
    fs.appendFileSync(file, line(1, 200) + line(2, 200));
    await waitFor(() => entries.length === 4, 10000, 'the late entries');
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3, 4]);
    fs.appendFileSync(file, line(5));
    await waitFor(() => entries.length === 5, 10000, 'an entry of the new file');
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3, 4, 5]);
    assert.equal(rotatedIn(dir).length, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(entries.length, 5);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('the follower still delivers the tail when the renamed file is pruned at once', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `audit-209901${i + 10}-000000.log`), 'future');
  fs.writeFileSync(file, '');
  const entries = [];
  let late = false;
  const follower = startFollower(file, (entry) => {
    entries.push(entry);
    if (entry.n === 1 && !late) {
      late = true;
      fs.appendFileSync(file, line(2));
    }
  }, 0, 20, 300);
  try {
    fs.appendFileSync(file, line(1, 400));
    await waitFor(() => entries.length === 2, 10000, 'the tail');
    await waitFor(() => !fs.existsSync(file), 10000, 'the rotation');
    assert.equal(rotatedIn(dir).length, 5);
    assert.ok(rotatedIn(dir).every((name) => name.startsWith('audit-2099')), 'the file just renamed was pruned');
    fs.writeFileSync(file, line(3));
    await waitFor(() => entries.length === 3, 10000, 'the new file');
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('a new file longer than the old offset is read from its start, whatever its inode', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 20, 300);
  try {
    fs.appendFileSync(file, line(1, 400));
    await waitFor(() => rotatedIn(dir).length === 1, 10000, 'the rotation');
    fs.writeFileSync(file, line(2, 300) + line(3, 300) + line(4, 300));
    await waitFor(() => entries.length === 4, 10000, 'the new entries');
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3, 4]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('stop reads what is left but never rotates, and a follower without a limit never rotates', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const slow = follow(file, 0, 60000, 300);
  fs.appendFileSync(file, line(1, 400));
  slow.follower.stop();
  assert.deepEqual(slow.entries.map((e) => e.n), [1]);
  assert.deepEqual(rotatedIn(dir), []);
  const unlimited = follow(file, 0, 20);
  try {
    await waitFor(() => unlimited.entries.length === 1, 10000, 'the entry');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(rotatedIn(dir), []);
  } finally {
    unlimited.follower.stop();
    rm(dir);
  }
});

test('a second process appending as fast as it can loses and repeats no entry across many rotations', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  const total = 3000;
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 2, 4000);
  const script = [
    "const fs = require('node:fs');",
    'const [file, total] = [process.argv[1], Number(process.argv[2])];',
    "for (let n = 1; n <= total; n += 1) fs.appendFileSync(file, `${JSON.stringify({ n, pad: 'x'.repeat(60) })}\\n`, { mode: 0o600 });",
  ].join('\n');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, file, String(total)], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', resolve);
    });
    await waitFor(() => entries.length >= total, 20000, 'every entry');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(entries.map((e) => e.n), Array.from({ length: total }, (_, i) => i + 1));
    assert.ok(rotatedIn(dir).length >= 1 && rotatedIn(dir).length <= 5);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('a renamed file that cannot be read again is let go, and the follower goes on with the new file', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 20, 300);
  const realFstat = fs.fstatSync;
  try {
    fs.appendFileSync(file, line(1, 400));
    await waitFor(() => rotatedIn(dir).length === 1, 10000, 'the rotation');
    fs.fstatSync = () => { throw new Error('cannot stat'); };
    await new Promise((resolve) => setTimeout(resolve, 80));
    fs.fstatSync = realFstat;
    fs.writeFileSync(file, line(2));
    await waitFor(() => entries.length === 2, 10000, 'the new file');
    assert.deepEqual(entries.map((e) => e.n), [1, 2]);
    assert.doesNotThrow(() => follower.stop());
  } finally {
    fs.fstatSync = realFstat;
    follower.stop();
    rm(dir);
  }
});

test('a renamed file is read for a while after the rename and closed when the follower stops', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 20, 300);
  try {
    fs.appendFileSync(file, line(1, 400));
    await waitFor(() => rotatedIn(dir).length === 1, 10000, 'the rotation');
    const [renamed] = rotatedIn(dir);
    fs.appendFileSync(path.join(dir, renamed), line(2));
    await waitFor(() => entries.length === 2, 10000, 'the late entry');
    assert.deepEqual(entries.map((e) => e.n), [1, 2]);
    fs.appendFileSync(path.join(dir, renamed), line(3));
    follower.stop();
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3]);
    fs.appendFileSync(path.join(dir, renamed), line(4));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(entries.map((e) => e.n), [1, 2, 3]);
  } finally {
    follower.stop();
    rm(dir);
  }
});

test('a renamed file is closed after the grace period without waiting for stop', async () => {
  const dir = tmp();
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '');
  const { entries, follower } = follow(file, 0, 20, 300);
  const realNow = Date.now;
  try {
    fs.appendFileSync(file, line(1, 400));
    await waitFor(() => rotatedIn(dir).length === 1, 10000, 'the rotation');
    const [renamed] = rotatedIn(dir);
    Date.now = () => realNow() + 10000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    Date.now = realNow;
    fs.appendFileSync(path.join(dir, renamed), line(2));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(entries.map((e) => e.n), [1]);
  } finally {
    Date.now = realNow;
    follower.stop();
    rm(dir);
  }
});
