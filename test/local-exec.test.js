import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv, run } from '../src/exec.js';
import { tempDir } from './temp.js';

test('run starts the program in the cwd option, and keeps the current folder when there is none', async () => {
  const dir = fs.realpathSync(tempDir('ks-lx-'));
  try {
    const env = minimalEnv(process.env);
    const inDir = await run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir, env });
    assert.equal(inDir.stdout, dir);
    const here = await run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { env });
    assert.equal(here.stdout, fs.realpathSync(process.cwd()));
    const gone = await run(process.execPath, ['-e', '0'], { cwd: path.join(dir, 'missing'), env });
    assert.equal(typeof gone.spawnError, 'string');
    assert.equal(gone.exitCode, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a program is never run through a shell: shell syntax in an argument is passed as plain text', async () => {
  const env = minimalEnv(process.env);
  const r = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a;b&&c$HOME'], { env });
  assert.equal(r.stdout, 'a;b&&c$HOME');
});

test('minimalEnv passes KSPROXY_ variables by default and drops them with own: false', () => {
  const env = {
    PATH: '/p', HOME: '/h', LANG: 'C', LC_ALL: 'C', TMPDIR: '/t', KSPROXY_STATE_DIR: '/s', KSPROXY_X: 'y', OTHER: 'z',
  };
  assert.deepEqual(minimalEnv(env, { E: '1' }), {
    PATH: '/p', HOME: '/h', LANG: 'C', LC_ALL: 'C', TMPDIR: '/t', KSPROXY_STATE_DIR: '/s', KSPROXY_X: 'y', E: '1',
  });
  assert.deepEqual(minimalEnv(env, { E: '1' }, { own: true }), minimalEnv(env, { E: '1' }));
  assert.deepEqual(minimalEnv(env, { PATH: '/q' }, { own: false }), {
    PATH: '/q', HOME: '/h', LANG: 'C', LC_ALL: 'C', TMPDIR: '/t',
  });
  assert.deepEqual(minimalEnv(env, {}, {}), minimalEnv(env));
});
