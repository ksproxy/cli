import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { start } from '../src/start.js';
import { processStartTime } from '../src/session.js';
import {
  alive, cleanupAll, fakeProcess, fakeSsh, launch, listenerTotal, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

const helpers = new Set();

after(() => {
  for (const child of helpers) child.kill('SIGKILL');
  cleanupAll();
});

test('a leftover proxy from an earlier run is stopped and reported before the new session starts', async () => {
  const world = await makeWorld();
  const old = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'proxy', 'x'], { stdio: 'ignore' });
  helpers.add(old);
  await waitFor(() => processStartTime(old.pid) !== null, 10000, 'the helper to start');
  fs.mkdirSync(world.socketDir, { recursive: true });
  fs.writeFileSync(
    path.join(world.socketDir, 'kube-old.pid'),
    JSON.stringify({ pid: old.pid, startedAt: processStartTime(old.pid) }),
  );
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /^closed 1 proxy process\(es\) left by an earlier run\n/);
  await waitFor(() => !alive(old.pid), 10000, 'the old proxy to be gone');
  assert.equal(fs.existsSync(path.join(world.socketDir, 'kube-old.pid')), false);
  assert.equal(await stopWith(run), 0);
});

test('a cluster whose token is rejected is opened with a warning and its state is recorded', async () => {
  const world = await makeWorld({ ssh: [], kubernetes: [{}], extraEnv: { KSPROXY_FAKE_KUBECTL_STATUS: '401' } });
  const run = launch(world, { all: true });
  await ready(run);
  assert.match(run.proc.stderr.text, /kube lab +WARN +token rejected by the cluster/);
  const session = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
  assert.equal(session.targets[0].state, 'auth');
  assert.equal(await stopWith(run), 0);
});

test('an unexpected failure while opening a target that is not an Error is reported as it is and everything is closed', async () => {
  const world = await makeWorld();
  let armed = false;
  const env = { ...world.env };
  Object.defineProperty(env, 'KSPROXY_SSH', {
    enumerable: true,
    get() {
      if (armed) throw 'ssh program lookup failed';
      return fakeSsh;
    },
  });
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/OPENING/.test(text)) armed = true;
  };
  assert.equal(await start({ all: true }, env, { process: proc }), 1);
  assert.match(proc.stderr.text, /CLOSING +error: ssh program lookup failed/);
  assert.match(proc.stderr.text, /CLOSED/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.equal(listenerTotal(proc), 0);
});

test('the health check interval has a default and ignores a value that is not a number', async () => {
  for (const value of [undefined, 'soon']) {
    const world = await makeWorld();
    const env = { ...world.env };
    if (value === undefined) delete env.KSPROXY_HEALTH_MS;
    else env.KSPROXY_HEALTH_MS = value;
    let checks = 0;
    const proc = fakeProcess();
    const run = { proc, done: start({ all: true }, env, { process: proc, targetState: async () => { checks += 1; return 'up'; } }) };
    await waitFor(() => proc.stdout.text.includes('Leave this running'), 20000, 'the session');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(checks, 0, 'the default interval is 30 seconds');
    proc.emit('SIGINT');
    assert.equal(await run.done, 0);
  }
});

test('health checks never overlap: a slow check makes the next tick wait', async () => {
  const world = await makeWorld();
  let active = 0;
  let maxActive = 0;
  let finished = 0;
  const targetState = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 450));
    active -= 1;
    finished += 1;
    return 'up';
  };
  const run = launch(world, { all: true }, { targetState });
  await ready(run);
  await waitFor(() => finished >= 2, 10000, 'two health checks');
  assert.equal(maxActive, 1);
  assert.equal(await stopWith(run), 0);
});

test('a stop that arrives while a health check is running discards its result', async () => {
  const world = await makeWorld();
  const proc = fakeProcess();
  let calls = 0;
  const targetState = async () => {
    calls += 1;
    proc.emit('SIGINT');
    return 'down';
  };
  const run = launch(world, { all: true }, { process: proc, targetState });
  assert.equal(await run.done, 0);
  assert.ok(calls >= 1);
  assert.ok(!/DOWN/.test(proc.stderr.text));
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
});
