import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../src/paths.js';
import { tempDir } from './temp.js';

test('writeFileAtomic reports the error and leaves no temporary file behind', () => {
  const dir = tempDir('ks-px-');
  try {
    const target = path.join(dir, 'missing', 'file.txt');
    assert.throws(() => writeFileAtomic(target, 'x'), { code: 'ENOENT' });
    assert.deepEqual(fs.readdirSync(dir), []);

    const file = path.join(dir, 'ok.txt');
    writeFileAtomic(file, 'first');
    writeFileAtomic(file, 'second');
    assert.equal(fs.readFileSync(file, 'utf8'), 'second');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['ok.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
