import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../src/exec.js';

const node = process.execPath;

test('captures stdout and exit code', async () => {
  const r = await run(node, ['-e', 'process.stdout.write("hi")']);
  assert.equal(r.stdout, 'hi');
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.truncated, false);
  assert.equal(r.spawnError, null);
});

test('captures stderr and non-zero exit', async () => {
  const r = await run(node, ['-e', 'process.stderr.write("e"); process.exit(3)']);
  assert.equal(r.stderr, 'e');
  assert.equal(r.exitCode, 3);
});

test('truncates output at maxBytes', async () => {
  const r = await run(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { maxBytes: 1000 });
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.truncated, true);
  assert.equal(r.stdoutBytes, 5000);
});

test('times out and kills the child', async () => {
  const started = Date.now();
  const r = await run(node, ['-e', 'setTimeout(()=>{}, 30000)'], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 20000, 'the child was stopped long before it would have ended');
});

test('spawn failure is reported, not thrown', async () => {
  const r = await run('/nonexistent/bin', []);
  assert.equal(r.exitCode, null);
  assert.equal(typeof r.spawnError, 'string');
  assert.ok(r.spawnError.length > 0);
});

test('arguments are not interpreted by a shell', async () => {
  const r = await run(node, ['-e', 'console.log(process.argv[1])', '$(id); echo x']);
  assert.equal(r.stdout.trim(), '$(id); echo x');
});

async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function stubbornGrandchildScript(pidFile, stayAlive) {
  return [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)\"], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    stayAlive ? 'setTimeout(() => {}, 30000);' : 'process.exit(0);',
  ].join('\n');
}

test('a grandchild that ignores SIGTERM is killed when the child exits 0', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join('/tmp', 'ks-exec-')), 'g.pid');
  let grandchild = null;
  try {
    const r = await run(node, ['-e', stubbornGrandchildScript(pidFile, false)], { timeoutMs: 10000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(await goneWithin(grandchild, 10000), true, 'the grandchild is gone');
  } finally {
    try {
      if (grandchild) process.kill(grandchild, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

test('a grandchild that ignores SIGTERM is killed when the call times out', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join('/tmp', 'ks-exec-')), 'g.pid');
  let grandchild = null;
  try {
    const r = await run(node, ['-e', stubbornGrandchildScript(pidFile, true)], { timeoutMs: 6000 });
    assert.equal(r.timedOut, true);
    grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(await goneWithin(grandchild, 10000), true, 'the grandchild is gone');
  } finally {
    try {
      if (grandchild) process.kill(grandchild, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});

test('a timeout bounds the call even when a grandchild holds the output open', async () => {
  const pidFile = path.join(fs.mkdtempSync(path.join('/tmp', 'ks-exec-')), 'grandchild.pid');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    'setTimeout(() => {}, 30000);',
  ].join('\n');
  let grandchild = null;
  try {
    const started = Date.now();
    const r = await run(node, ['-e', script], { timeoutMs: 4000 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 20000, `took ${Date.now() - started}ms, the grandchild lives 30000ms`);
    grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 10000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(grandchild, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the grandchild was killed with the group');
  } finally {
    try {
      if (grandchild) process.kill(grandchild, 'SIGKILL');
    } catch {
      // already gone
    }
  }
});
