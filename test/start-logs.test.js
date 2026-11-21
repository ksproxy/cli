import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { rotatedLogs } from '../src/audit.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

after(() => cleanupAll());

async function session(world, host = {}) {
  const run = launch(world, { all: true }, host);
  await ready(run);
  return run;
}

function put(file, text, iso) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, new Date(iso), new Date(iso));
}

test('start creates the logs folder with mode 0700 and writes the audit log there', async () => {
  const world = await makeWorld();
  const run = await session(world);
  try {
    assert.equal(fs.statSync(world.logDir).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(world.auditLog));
    assert.equal(fs.statSync(world.auditLog).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(path.join(world.sessionDir, 'audit.log')));
  } finally {
    await stopWith(run);
  }
});

test('start sets mode 0700 on a logs folder that already exists with a looser mode', async () => {
  const world = await makeWorld();
  fs.mkdirSync(world.logDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(world.logDir, 0o755);
  const run = await session(world);
  try {
    assert.equal(fs.statSync(world.logDir).mode & 0o777, 0o700);
  } finally {
    await stopWith(run);
  }
});

test('old layout: only audit.log in the session folder becomes the current log', async () => {
  const world = await makeWorld();
  put(path.join(world.sessionDir, 'audit.log'), '{"ts":"2026-01-01T00:00:00.000Z","event":"list"}\n', '2026-11-01T10:00:00Z');
  const run = await session(world);
  try {
    assert.ok(fs.readFileSync(world.auditLog, 'utf8').startsWith('{"ts":"2026-01-01T00:00:00.000Z"'));
    assert.deepEqual(rotatedLogs(world.logDir), []);
    assert.ok(!run.proc.stdout.text.includes('2026-01-01'));
    assert.ok(!fs.existsSync(path.join(world.sessionDir, 'audit.log')));
    assert.ok(!fs.existsSync(path.join(world.sessionDir, 'audit.log.1')));
  } finally {
    await stopWith(run);
  }
});

test('old layout: only audit.log.1 becomes a rotated file stamped with its modification time', async () => {
  const world = await makeWorld();
  put(path.join(world.sessionDir, 'audit.log.1'), 'old-rotated\n', '2026-10-30T08:09:10Z');
  const run = await session(world);
  try {
    assert.deepEqual(rotatedLogs(world.logDir), ['audit-20261030-080910.log']);
    assert.equal(fs.readFileSync(path.join(world.logDir, 'audit-20261030-080910.log'), 'utf8'), 'old-rotated\n');
    assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes('old-rotated'));
    assert.ok(!fs.existsSync(path.join(world.sessionDir, 'audit.log.1')));
  } finally {
    await stopWith(run);
  }
});

test('old layout: both and no new log yet give a rotated file and the current log', async () => {
  const world = await makeWorld();
  put(path.join(world.sessionDir, 'audit.log.1'), 'old-rotated\n', '2026-10-30T08:09:10Z');
  put(path.join(world.sessionDir, 'audit.log'), 'old-current\n', '2026-11-01T10:00:00Z');
  const run = await session(world);
  try {
    assert.deepEqual(rotatedLogs(world.logDir), ['audit-20261030-080910.log']);
    assert.ok(fs.readFileSync(world.auditLog, 'utf8').startsWith('old-current\n'));
    assert.deepEqual(fs.readdirSync(world.sessionDir).filter((n) => n.startsWith('audit')), []);
  } finally {
    await stopWith(run);
  }
});

test('old layout: both and a new log already there give two rotated files and keep the new log', async () => {
  const world = await makeWorld();
  put(world.auditLog, 'new-current\n', '2026-11-20T10:00:00Z');
  put(path.join(world.sessionDir, 'audit.log.1'), 'old-rotated\n', '2026-10-30T08:09:10Z');
  put(path.join(world.sessionDir, 'audit.log'), 'old-current\n', '2026-11-01T10:00:00Z');
  const run = await session(world);
  try {
    assert.deepEqual(rotatedLogs(world.logDir), ['audit-20261101-100000.log', 'audit-20261030-080910.log']);
    assert.equal(fs.readFileSync(path.join(world.logDir, 'audit-20261101-100000.log'), 'utf8'), 'old-current\n');
    assert.equal(fs.readFileSync(path.join(world.logDir, 'audit-20261030-080910.log'), 'utf8'), 'old-rotated\n');
    assert.ok(fs.readFileSync(world.auditLog, 'utf8').startsWith('new-current\n'));
    assert.deepEqual(fs.readdirSync(world.sessionDir).filter((n) => n.startsWith('audit')), []);
  } finally {
    await stopWith(run);
  }
});

test('the session folder is emptied of everything, so a folder named audit.log in it is removed', async () => {
  const world = await makeWorld();
  fs.mkdirSync(path.join(world.sessionDir, 'audit.log'), { recursive: true });
  fs.writeFileSync(path.join(world.sessionDir, 'audit.log', 'inner'), 'x');
  const run = await session(world);
  try {
    assert.deepEqual(fs.readdirSync(world.sessionDir).filter((n) => n.startsWith('audit')), []);
    assert.ok(fs.statSync(world.auditLog).isFile());
  } finally {
    await stopWith(run);
  }
});

test('a log over the limit at start is rotated into the logs folder', async () => {
  const world = await makeWorld();
  put(world.auditLog, `${'x'.repeat(2000)}\n`, '2026-11-20T10:00:00Z');
  const run = await session(world, { limits: { logBytes: 1000 } });
  try {
    assert.equal(rotatedLogs(world.logDir).length, 1);
    assert.ok(fs.statSync(world.auditLog).size < 1000);
  } finally {
    await stopWith(run);
  }
});

test('during a session the log is rotated, at most five old files stay, and every call is shown once and in order', async () => {
  const world = await makeWorld();
  const run = await session(world, { limits: { logBytes: 700, followMs: 20 } });
  const total = 40;
  try {
    for (let i = 0; i < total; i += 1) {
      const r = await callTool('ssh_exec', { server: 'web1', command: `cat file-${String(i).padStart(3, '0')}` }, world.env);
      assert.equal(r.isError, false);
    }
    await waitFor(
      () => (run.proc.stdout.text.match(/cat file-\d{3}/g) ?? []).length >= total,
      15000,
      'every call line',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const shown = (run.proc.stdout.text.match(/cat file-(\d{3})/g) ?? []).map((m) => Number(m.slice(-3)));
    assert.deepEqual(shown, Array.from({ length: total }, (_, i) => i));
    const rotated = rotatedLogs(world.logDir);
    assert.ok(rotated.length >= 1 && rotated.length <= 5, `rotated files: ${rotated.length}`);
    assert.ok(fs.statSync(world.auditLog).size < 1500);
    assert.equal(fs.readdirSync(world.logDir).length, rotated.length + 1);
  } finally {
    const code = await stopWith(run);
    assert.equal(code, 0);
  }
  assert.match(run.proc.stderr.text, new RegExp(`CLOSED +${total} calls: ${total} ok`));
});
