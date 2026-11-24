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

test('writeFileAtomic asks keep just before the rename: false leaves the file as it was and no temporary file', () => {
  const dir = tempDir('ks-px-');
  try {
    const file = path.join(dir, 'ok.txt');
    assert.equal(writeFileAtomic(file, 'first'), true);
    const seen = [];
    const keep = (answer) => () => {
      seen.push(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length);
      return answer;
    };
    assert.equal(writeFileAtomic(file, 'second', keep(false)), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'first');
    assert.deepEqual(fs.readdirSync(dir), ['ok.txt']);
    assert.equal(writeFileAtomic(file, 'third', keep(true)), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'third');
    assert.deepEqual(seen, [1, 1], 'keep is asked once the temporary file is written');
    assert.throws(() => writeFileAtomic(file, 'fourth', () => { throw new Error('keep failed'); }), { message: 'keep failed' });
    assert.equal(fs.readFileSync(file, 'utf8'), 'third');
    assert.deepEqual(fs.readdirSync(dir), ['ok.txt']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
