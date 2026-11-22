import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  adoptOldLogs, MAX_LOG_BYTES, moveToRotated, pruneRotated, ROTATED_KEEP, rotatedLogs, rotateAudit,
} from '../src/audit.js';
import { tempDir } from './temp.js';

function tmp() {
  return fs.realpathSync(tempDir('ks-rot-'));
}

const NOON = new Date('2026-11-21T12:34:56.789Z');
const ROTATED = /^audit-\d{8}-\d{6}(-\d+)?\.log$/;

test('the limits are 5 MiB and five rotated files', () => {
  assert.equal(MAX_LOG_BYTES, 5 * 1024 * 1024);
  assert.equal(ROTATED_KEEP, 5);
});

test('rotateAudit does nothing while the log is at or under the limit', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, Buffer.alloc(1024, 0x61));
    assert.equal(rotateAudit(file, 1024, NOON), null);
    assert.deepEqual(fs.readdirSync(dir), ['audit.log']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateAudit renames a log over the limit to a UTC time stamp and returns the new path', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, Buffer.alloc(1025, 0x61));
    assert.equal(rotateAudit(file, 1024, NOON), path.join(dir, 'audit-20261121-123456.log'));
    assert.deepEqual(fs.readdirSync(dir), ['audit-20261121-123456.log']);
    assert.equal(fs.statSync(path.join(dir, 'audit-20261121-123456.log')).size, 1025);
    assert.equal(rotateAudit(file, 1024, NOON), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateAudit uses the current time and the 5 MiB limit by default', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'audit.log');
    fs.writeFileSync(file, Buffer.alloc(16, 0x61));
    assert.equal(rotateAudit(file), null);
    fs.truncateSync(file, MAX_LOG_BYTES + 1);
    const target = rotateAudit(file);
    assert.match(path.basename(target), ROTATED);
    assert.equal(fs.statSync(target).size, MAX_LOG_BYTES + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second rotation in the same second gets -2, then -3', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'audit.log');
    const names = [];
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(file, Buffer.alloc(2048, 0x61));
      names.push(path.basename(rotateAudit(file, 1024, NOON)));
    }
    assert.deepEqual(names, ['audit-20261121-123456.log', 'audit-20261121-123456-2.log', 'audit-20261121-123456-3.log']);
    assert.deepEqual(rotatedLogs(dir), [...names].reverse());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only the newest five rotated files are kept', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 7; i += 1) {
      fs.writeFileSync(file, Buffer.alloc(2048, 0x61 + i));
      rotateAudit(file, 1024, new Date(Date.UTC(2026, 10, 21, 10, 0, i)));
    }
    assert.deepEqual(rotatedLogs(dir), [
      'audit-20261121-100006.log',
      'audit-20261121-100005.log',
      'audit-20261121-100004.log',
      'audit-20261121-100003.log',
      'audit-20261121-100002.log',
    ]);
    assert.equal(fs.readdirSync(dir).length, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pruning counts a -2 file as newer than the plain one of the same second', () => {
  const dir = tmp();
  try {
    const names = [
      'audit-20261121-100000.log', 'audit-20261121-100000-2.log', 'audit-20261121-100000-10.log',
      'audit-20261121-090000.log', 'audit-20261121-080000.log', 'audit-20261121-070000.log',
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), name);
    pruneRotated(dir);
    assert.deepEqual(rotatedLogs(dir), [
      'audit-20261121-100000-10.log',
      'audit-20261121-100000-2.log',
      'audit-20261121-100000.log',
      'audit-20261121-090000.log',
      'audit-20261121-080000.log',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotation and pruning never touch a file with another name', () => {
  const dir = tmp();
  try {
    const keep = ['notes.txt', 'audit-old.log', 'audit-20261121-100000.log.bak', 'audit.log.1', 'audit-2026112-100000.log', 'xaudit-20261121-100000.log'];
    for (const name of keep) fs.writeFileSync(path.join(dir, name), name);
    const file = path.join(dir, 'audit.log');
    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(file, Buffer.alloc(2048, 0x61));
      rotateAudit(file, 1024, new Date(Date.UTC(2026, 10, 21, 10, 0, i)));
    }
    assert.equal(rotatedLogs(dir).length, 5);
    for (const name of keep) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name);
    assert.equal(fs.readdirSync(dir).length, keep.length + 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rotated name that is a folder or cannot be removed does not stop the pruning', { skip: typeof process.getuid === 'function' && process.getuid() === 0 }, () => {
  const dir = tmp();
  try {
    const stuck = path.join(dir, 'audit-20261121-010000.log');
    fs.mkdirSync(stuck);
    fs.writeFileSync(path.join(stuck, 'inner'), 'x');
    fs.chmodSync(stuck, 0o500);
    for (let h = 2; h < 8; h += 1) fs.writeFileSync(path.join(dir, `audit-20261121-0${h}0000.log`), 'x');
    pruneRotated(dir);
    assert.ok(fs.existsSync(stuck));
    assert.equal(rotatedLogs(dir).length, 6);
    fs.chmodSync(stuck, 0o700);
    pruneRotated(path.join(dir, 'missing'));
  } finally {
    fs.chmodSync(path.join(dir, 'audit-20261121-010000.log'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateAudit and rotatedLogs return without throwing for a missing file or folder', () => {
  const dir = tmp();
  try {
    assert.equal(rotateAudit(path.join(dir, 'audit.log'), 1, NOON), null);
    assert.equal(rotateAudit(path.join(dir, 'nope', 'audit.log'), 1, NOON), null);
    assert.deepEqual(rotatedLogs(path.join(dir, 'nope')), []);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotateAudit returns null and leaves the file when it cannot be renamed', () => {
  const dir = tmp();
  try {
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    const file = path.join(logs, 'audit.log');
    fs.writeFileSync(file, Buffer.alloc(2048, 0x61));
    fs.writeFileSync(path.join(logs, 'audit-20261121-123456.log'), 'x');
    fs.mkdirSync(path.join(logs, 'audit-20261121-123456-2.log'));
    fs.writeFileSync(path.join(logs, 'audit-20261121-123456-3.log'), 'x');
    const target = rotateAudit(file, 1024, NOON);
    assert.equal(path.basename(target), 'audit-20261121-123456-4.log');
    fs.writeFileSync(file, Buffer.alloc(2048, 0x61));
    fs.chmodSync(logs, 0o500);
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      assert.equal(rotateAudit(file, 1024, NOON), null);
      assert.ok(fs.existsSync(file));
    }
  } finally {
    fs.chmodSync(path.join(dir, 'logs'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('moveToRotated stamps the name from the time it is given, in UTC', () => {
  const dir = tmp();
  try {
    const from = path.join(dir, 'x');
    fs.writeFileSync(from, 'x');
    const to = moveToRotated(from, dir, new Date('2026-01-02T03:04:05.000Z'));
    assert.equal(to, path.join(dir, 'audit-20260102-030405.log'));
    assert.ok(!fs.existsSync(from));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const base = tmp();
  const sessionDir = path.join(base, 'session');
  const logs = path.join(base, 'logs');
  fs.mkdirSync(sessionDir);
  fs.mkdirSync(logs);
  const put = (file, text, iso) => {
    fs.writeFileSync(file, text);
    fs.utimesSync(file, new Date(iso), new Date(iso));
  };
  return {
    base, sessionDir, logs, file: path.join(logs, 'audit.log'), put,
  };
}

test('old files: only audit.log becomes the current log when there is none', () => {
  const w = setup();
  try {
    w.put(path.join(w.sessionDir, 'audit.log'), 'old-current', '2026-11-01T10:00:00Z');
    adoptOldLogs(w.sessionDir, w.file);
    assert.equal(fs.readFileSync(w.file, 'utf8'), 'old-current');
    assert.deepEqual(fs.readdirSync(w.sessionDir), []);
    assert.deepEqual(rotatedLogs(w.logs), []);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('old files: only audit.log.1 becomes a rotated file stamped with its modification time', () => {
  const w = setup();
  try {
    w.put(path.join(w.sessionDir, 'audit.log.1'), 'old-rotated', '2026-10-30T08:09:10Z');
    adoptOldLogs(w.sessionDir, w.file);
    assert.deepEqual(fs.readdirSync(w.logs), ['audit-20261030-080910.log']);
    assert.equal(fs.readFileSync(path.join(w.logs, 'audit-20261030-080910.log'), 'utf8'), 'old-rotated');
    assert.deepEqual(fs.readdirSync(w.sessionDir), []);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('old files: both with no new log yet give a rotated file and the current log', () => {
  const w = setup();
  try {
    w.put(path.join(w.sessionDir, 'audit.log.1'), 'old-rotated', '2026-10-30T08:09:10Z');
    w.put(path.join(w.sessionDir, 'audit.log'), 'old-current', '2026-11-01T10:00:00Z');
    adoptOldLogs(w.sessionDir, w.file);
    assert.deepEqual(fs.readdirSync(w.logs).sort(), ['audit-20261030-080910.log', 'audit.log']);
    assert.equal(fs.readFileSync(w.file, 'utf8'), 'old-current');
    assert.deepEqual(fs.readdirSync(w.sessionDir), []);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('old files: both with a new log already there give two rotated files and leave the new log alone', () => {
  const w = setup();
  try {
    w.put(w.file, 'new', '2026-11-20T10:00:00Z');
    w.put(path.join(w.sessionDir, 'audit.log.1'), 'old-rotated', '2026-10-30T08:09:10Z');
    w.put(path.join(w.sessionDir, 'audit.log'), 'old-current', '2026-11-01T10:00:00Z');
    adoptOldLogs(w.sessionDir, w.file);
    assert.equal(fs.readFileSync(w.file, 'utf8'), 'new');
    assert.deepEqual(rotatedLogs(w.logs), ['audit-20261101-100000.log', 'audit-20261030-080910.log']);
    assert.equal(fs.readFileSync(path.join(w.logs, 'audit-20261101-100000.log'), 'utf8'), 'old-current');
    assert.deepEqual(fs.readdirSync(w.sessionDir), []);
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('old files modified in the same second keep their order', () => {
  const w = setup();
  try {
    w.put(w.file, 'new', '2026-11-20T10:00:00Z');
    w.put(path.join(w.sessionDir, 'audit.log.1'), 'first', '2026-11-01T10:00:00Z');
    w.put(path.join(w.sessionDir, 'audit.log'), 'second', '2026-11-01T10:00:00Z');
    adoptOldLogs(w.sessionDir, w.file);
    const [newer, older] = rotatedLogs(w.logs);
    assert.equal(fs.readFileSync(path.join(w.logs, newer), 'utf8'), 'second');
    assert.equal(fs.readFileSync(path.join(w.logs, older), 'utf8'), 'first');
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});

test('old files: a folder, a missing session folder and nothing at all are left alone, and the newest five are kept', () => {
  const w = setup();
  try {
    fs.mkdirSync(path.join(w.sessionDir, 'audit.log'));
    adoptOldLogs(w.sessionDir, w.file);
    assert.ok(fs.statSync(path.join(w.sessionDir, 'audit.log')).isDirectory());
    assert.deepEqual(fs.readdirSync(w.logs), []);
    adoptOldLogs(path.join(w.base, 'missing'), w.file);
    assert.deepEqual(fs.readdirSync(w.logs), []);
    fs.rmSync(path.join(w.sessionDir, 'audit.log'), { recursive: true });
    for (let h = 1; h <= 5; h += 1) w.put(path.join(w.logs, `audit-20261120-0${h}0000.log`), 'x', '2026-11-20T10:00:00Z');
    w.put(path.join(w.sessionDir, 'audit.log.1'), 'old-rotated', '2026-10-30T08:09:10Z');
    adoptOldLogs(w.sessionDir, w.file);
    assert.equal(rotatedLogs(w.logs).length, 5);
    assert.ok(!fs.existsSync(path.join(w.logs, 'audit-20261030-080910.log')));
  } finally {
    fs.rmSync(w.base, { recursive: true, force: true });
  }
});
