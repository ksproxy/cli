import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { minimalEnv, run } from '../src/exec.js';
import { tempDir } from './temp.js';

const node = process.execPath;
const baseEnv = minimalEnv(process.env);

function tmp() {
  return tempDir('ks-exx-');
}

function killQuietly(pid) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

const GRANDCHILD_MS = 30000;

const DETACHER = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ' + Number(process.argv[3]) + ')'], { detached: true, stdio: 'inherit' });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.stdout.write('parent says hi\\n');
grandchild.unref();
`;

function setupDetacher(dir) {
  const script = path.join(dir, 'detacher.cjs');
  fs.writeFileSync(script, DETACHER);
  return { script, pidFile: path.join(dir, 'grandchild.pid') };
}

function readPid(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('a spawn that throws synchronously is reported as a spawn error', async () => {
  const result = await run(node, ['bad\0argument'], { env: baseEnv });
  assert.equal(result.exitCode, null);
  assert.match(result.spawnError, /null bytes|NUL|must be a string without null/i);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, '');
});

test('an inherited-stdio program that cannot be started resolves once with the spawn error', async () => {
  const result = await run(path.join('/tmp', 'ks-no-such-program-xyz'), [], { inherit: true, env: baseEnv });
  assert.match(result.spawnError, /ENOENT/);
  assert.equal(result.exitCode, null);
});

test('an inherited-stdio program that runs too long is terminated and reported as timed out', async () => {
  const result = await run(node, ['-e', 'setTimeout(() => {}, 30000)'], {
    inherit: true, timeoutMs: 150, env: baseEnv,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.spawnError, null);
});

test('a program that ignores SIGTERM is killed with SIGKILL two seconds after the timeout', async () => {
  const script = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1e6)";
  const result = await run(node, ['-e', script], { timeoutMs: 4000, env: baseEnv });
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.stdout, 'ready');
  assert.ok(result.durationMs >= 5800, `took ${result.durationMs}ms`);
});

test('output is returned once the grace period ends even if a leftover process keeps the pipes open', async () => {
  const dir = tmp();
  let pid = null;
  try {
    const { script, pidFile } = setupDetacher(dir);
    const result = await run(node, [script, pidFile, String(GRANDCHILD_MS)], { timeoutMs: 60000, env: baseEnv });
    pid = readPid(pidFile);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout, 'parent says hi\n');
    assert.ok(result.durationMs >= 450, `took ${result.durationMs}ms`);
    assert.ok(result.durationMs < GRANDCHILD_MS - 5000, `took ${result.durationMs}ms, the leftover process lives ${GRANDCHILD_MS}ms`);
  } finally {
    if (pid) killQuietly(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout that fires after the process group is gone still ends the run', async () => {
  const dir = tmp();
  let pid = null;
  try {
    const { script, pidFile } = setupDetacher(dir);
    const result = await run(node, [script, pidFile, String(GRANDCHILD_MS)], { timeoutMs: 3000, graceMs: 10000, env: baseEnv });
    pid = readPid(pidFile);
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'parent says hi\n');
    assert.ok(result.durationMs >= 3000, `took ${result.durationMs}ms`);
  } finally {
    if (pid) killQuietly(pid);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
