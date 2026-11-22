import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { callTool, targetState } from '../src/tools.js';
import { writeSession } from '../src/session.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

const dirs = [];
const SILENT = { stderr: { write() {} } };

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world(targets) {
  const base = fs.realpathSync(tempDir('ks-uk-'));
  dirs.push(base);
  const env = { ...process.env, KSPROXY_STATE_DIR: path.join(base, 'st') };
  writeSession(path.join(base, 'st', 'session'), {
    version: 1, pid: process.pid, startedAt: '2026-11-20T00:00:00.000Z', targets,
  });
  return env;
}

const mystery = { kind: 'mystery', name: 'x', state: 'up', allow: [] };
const local = {
  kind: 'local', name: 'infra', state: 'up', allow: [], cwd: '/tmp',
};

test('a target of an unknown kind is in the state error, with or without a proxyPort', async () => {
  assert.equal(await targetState(mystery, {}), 'error');
  assert.equal(await targetState({ ...mystery, proxyPort: 8001 }, {}), 'error');
});

test('list_targets lists a target of an unknown kind with the state error', async () => {
  const env = world([mystery, local]);
  const result = await callTool('list_targets', {}, env, SILENT);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(result.text).targets.map((t) => [t.kind, t.name, t.state]), [
    ['mystery', 'x', 'error'],
    ['local', 'infra', 'up'],
  ]);
});

test('ksproxy status prints a target of an unknown kind with error and two dashes, and exits 1', async () => {
  const env = world([mystery, local]);
  const proc = fakeProcess({ env });
  await runCli(['status'], proc);
  assert.equal(proc.exitCode, 1);
  assert.equal(
    proc.stdout.text,
    `session pid ${process.pid}, started 2026-11-20T00:00:00.000Z\n  error --    x\n  up    loc   infra\n`,
  );
  assert.equal(proc.stderr.text, '');
});
