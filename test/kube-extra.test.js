import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  closeCluster, commandLine, hardRefusal, hardRefusalDetail, openCluster, portListening, probeVersion,
  reapStaleProxies,
} from '../src/kinds/kubernetes/cluster.js';
import { processStartTime } from '../src/session.js';
import { tempDir } from './temp.js';

function tmp() {
  return fs.realpathSync(tempDir('ks-kx-'));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const spawned = new Set();

function helper(script, extra = []) {
  const child = spawn(process.execPath, ['-e', script, ...extra], { stdio: 'ignore' });
  spawned.add(child);
  return child;
}

test.after(() => {
  for (const child of spawned) child.kill('SIGKILL');
});

test('a manifest whose file type cannot be read is refused as not a single file', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.yaml');
    fs.writeFileSync(file, 'x');
    assert.equal(hardRefusalDetail(['apply', '-f', file], [dir]), null);
    const refusal = hardRefusalDetail(['apply', '-f', file], [dir], {
      statSync: () => { throw new Error('stat failed'); },
    });
    assert.equal(refusal.short, '-f: not a single file');
    assert.equal(
      hardRefusal(['apply', '-f', file], [dir], { statSync: () => { throw new Error('stat failed'); } }),
      '-f must name a single file inside the configured manifestRoots, not a directory',
    );
  } finally {
    rm(dir);
  }
});

test('portListening gives up when the connection stays silent past the timeout', async () => {
  const seen = {};
  const connect = (options) => {
    seen.options = options;
    const socket = new EventEmitter();
    socket.setTimeout = (ms, onTimeout) => {
      seen.ms = ms;
      setImmediate(onTimeout);
    };
    socket.destroy = () => { seen.destroyed = true; };
    return socket;
  };
  assert.equal(await portListening(4321, 77, connect), false);
  assert.deepEqual(seen, { options: { port: 4321, host: '127.0.0.1' }, ms: 77, destroyed: true });
});

test('probeVersion answers fail when the server never replies', async () => {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on('connection', (s) => sockets.add(s));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal(await probeVersion(server.address().port, 100), 'fail');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('closeCluster accepts a missing handle and does nothing', async () => {
  assert.equal(await closeCluster(undefined), undefined);
  assert.equal(await closeCluster(null), undefined);
  assert.equal(await closeCluster({}), undefined);
});

test('closeCluster sends SIGKILL to a proxy that ignores SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1e6)"],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  spawned.add(child);
  await new Promise((resolve) => child.stdout.once('data', resolve));
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
  await closeCluster({ child }, process.env, { graceMs: 150 });
  assert.equal(await exited, 'SIGKILL');
});

test('closeCluster signals a proxy that stays up past the grace period with SIGTERM first, then SIGKILL', async () => {
  const signals = [];
  const child = {
    exitCode: null,
    signalCode: null,
    kill: (signal) => { signals.push(signal); },
    once: () => {},
  };
  await closeCluster({ child }, process.env, { graceMs: 20 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('closeCluster does not signal a proxy that already exited', async () => {
  const signals = [];
  const child = {
    exitCode: 0,
    signalCode: null,
    kill: (signal) => { signals.push(signal); },
    once: () => {},
  };
  await closeCluster({ child }, process.env, { graceMs: 20 });
  assert.deepEqual(signals, []);
});

test('closeCluster never throws, whatever fails while closing', async () => {
  const dir = tmp();
  try {
    const failingChild = {
      exitCode: null,
      signalCode: null,
      kill: () => { throw new Error('cannot signal'); },
      once: () => {},
    };
    const failingTunnel = { host: 'h', get socket() { throw new Error('bad tunnel'); } };
    const pidFile = path.join(dir, 'kube-x.pid');
    fs.mkdirSync(path.join(pidFile, 'inner'), { recursive: true });
    await closeCluster({ child: failingChild, tunnel: failingTunnel, pidFile }, process.env, { graceMs: 20 });
    assert.equal(fs.existsSync(path.join(pidFile, 'inner')), true);
  } finally {
    rm(dir);
  }
});

test('closeCluster removes the pid file', async () => {
  const dir = tmp();
  try {
    const pidFile = path.join(dir, 'kube-x.pid');
    fs.writeFileSync(pidFile, '{}');
    await closeCluster({ pidFile });
    assert.equal(fs.existsSync(pidFile), false);
  } finally {
    rm(dir);
  }
});

test('openCluster reports a kubectl that cannot be started', async () => {
  const dir = tmp();
  try {
    const kubeconfig = path.join(dir, 'kube.yaml');
    fs.writeFileSync(kubeconfig, 'x');
    const sessionDir = path.join(dir, 'session');
    fs.mkdirSync(sessionDir);
    const env = { ...process.env, KSPROXY_STATE_DIR: path.join(dir, 'st'), KSPROXY_KUBECTL: path.join(dir, 'no-kubectl') };
    const result = await openCluster(
      { name: 'lab', kubeconfig, proxyPort: await unusedPort(), tunnel: null },
      { sessionDir },
      env,
    );
    assert.deepEqual(result, { ok: false, error: 'kubectl proxy did not start; see kube-lab.log' });
  } finally {
    rm(dir);
  }
});

test('openCluster reports the system error when its log file cannot be created', async () => {
  const dir = tmp();
  try {
    const kubeconfig = path.join(dir, 'kube.yaml');
    fs.writeFileSync(kubeconfig, 'x');
    const result = await openCluster(
      { name: 'lab', kubeconfig, proxyPort: await unusedPort(), tunnel: null },
      { sessionDir: path.join(dir, 'missing-session-dir') },
      { ...process.env, KSPROXY_STATE_DIR: path.join(dir, 'st') },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
  } finally {
    rm(dir);
  }
});

function writePidFile(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

function matchingHelper() {
  return helper('setInterval(() => {}, 1e6)', ['proxy', 'x']);
}

async function recordFor(dir, name, child) {
  await waitFor(() => processStartTime(child.pid) !== null, 10000, 'helper start time');
  return writePidFile(dir, name, JSON.stringify({ pid: child.pid, startedAt: processStartTime(child.pid) }));
}

function realKill(pid, signal) {
  process.kill(pid, signal);
}

test('reapStaleProxies leaves a proxy alone when it cannot be signalled, and still removes the record', async () => {
  const dir = tmp();
  try {
    const child = matchingHelper();
    const file = await recordFor(dir, 'kube-a.pid', child);
    const kill = (pid, signal) => {
      if (signal === 'SIGTERM') throw new Error('EPERM');
      realKill(pid, signal);
    };
    assert.equal(await reapStaleProxies(dir, { kill }), 0);
    assert.equal(alive(child.pid), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    rm(dir);
  }
});

test('reapStaleProxies escalates to SIGKILL when SIGTERM does not end the proxy in time', async () => {
  const dir = tmp();
  try {
    const child = matchingHelper();
    const file = await recordFor(dir, 'kube-a.pid', child);
    const sent = [];
    const kill = (pid, signal) => {
      sent.push(signal);
      if (signal !== 'SIGTERM') realKill(pid, signal);
    };
    assert.equal(await reapStaleProxies(dir, { kill, deadlineMs: 100 }), 1);
    assert.deepEqual(sent.filter((s) => s !== 0), ['SIGTERM', 'SIGKILL']);
    await waitFor(() => !alive(child.pid), 10000, 'the proxy to be killed');
    assert.equal(fs.existsSync(file), false);
  } finally {
    rm(dir);
  }
});

test('reapStaleProxies survives a failing SIGKILL', async () => {
  const dir = tmp();
  try {
    const child = matchingHelper();
    const file = await recordFor(dir, 'kube-a.pid', child);
    const kill = (pid, signal) => {
      if (signal === 'SIGTERM') return;
      if (signal === 'SIGKILL') throw new Error('already gone');
      realKill(pid, signal);
    };
    assert.equal(await reapStaleProxies(dir, { kill, deadlineMs: 50 }), 1);
    assert.equal(alive(child.pid), true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    rm(dir);
  }
});

test('reapStaleProxies tolerates a record it cannot read or remove', async () => {
  const dir = tmp();
  try {
    const odd = path.join(dir, 'kube-dir.pid');
    fs.mkdirSync(path.join(odd, 'inner'), { recursive: true });
    assert.equal(await reapStaleProxies(dir), 0);
    assert.equal(fs.existsSync(path.join(odd, 'inner')), true);
  } finally {
    rm(dir);
  }
});

test('commandLine returns the command of a live process and null for a missing one', () => {
  assert.ok(commandLine(process.pid).includes(process.execPath.split('/').pop()));
  assert.equal(commandLine(2 ** 22 + 54321), null);
});
