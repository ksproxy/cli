import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readSession, isLive, psEnv, parseLstart, processStartTime,
} from '../src/session.js';

function tmp() {
  return fs.mkdtempSync(path.join('/tmp', 'ks-sx-'));
}

test('readSession is null when the file holds JSON that is not an object', () => {
  const dir = tmp();
  try {
    for (const text of ['5', 'null', '"text"', 'true']) {
      fs.writeFileSync(path.join(dir, 'session.json'), text);
      assert.equal(readSession(dir), null, text);
    }
    fs.writeFileSync(path.join(dir, 'session.json'), '{"pid": 7}');
    assert.deepEqual(readSession(dir), { pid: 7 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('psEnv keeps the given PATH and falls back to the system directories without one', () => {
  assert.deepEqual(psEnv({ PATH: '/opt/x' }), { PATH: '/opt/x', LC_ALL: 'C' });
  assert.deepEqual(psEnv({}), { PATH: '/bin:/usr/bin', LC_ALL: 'C' });
  assert.equal(psEnv().LC_ALL, 'C');
});

test('parseLstart turns a ps start time into milliseconds and rejects garbage', () => {
  const ms = parseLstart('Fri Nov 20 10:15:30 2026\n');
  assert.equal(typeof ms, 'number');
  assert.equal(new Date(ms).getFullYear(), 2026);
  assert.equal(new Date(ms).getMinutes(), 15);
  assert.equal(parseLstart('not a date'), null);
  assert.equal(parseLstart(''), null);
});

test('a process owned by someone else is still treated as alive (EPERM from signal 0)', () => {
  assert.equal(isLive({ pid: 1 }), true);
  assert.equal(typeof processStartTime(1), 'number');
});
