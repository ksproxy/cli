import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/tools.js';
import { portListening, reapStaleProxies } from '../src/kube.js';
import { processStartTime } from '../src/session.js';

const bin = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));

const children = new Set();
const socketDirs = new Set();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedPids(socketDir) {
  let names;
  try {
    names = fs.readdirSync(socketDir);
  } catch {
    return [];
  }
  const pids = [];
  for (const name of names.filter((n) => n.startsWith('kube-') && n.endsWith('.pid'))) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(socketDir, name), 'utf8'));
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    } catch {
      // unreadable pid file
    }
  }
  return pids;
}

function killRecorded(socketDir) {
  for (const pid of recordedPids(socketDir)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const dir of socketDirs) killRecorded(dir);
});

async function freePorts(count) {
  const servers = [];
  const ports = [];
  for (let i = 0; i < count; i += 1) {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    ports.push(server.address().port);
    servers.push(server);
  }
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  return ports;
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function setup(extraEnv = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-st-')));
  const [proxyPort, localPort] = await freePorts(2);
  const kubeconfig = path.join(base, 'kube.yaml');
  fs.writeFileSync(kubeconfig, 'apiVersion: v1\n');
  const configDir = path.join(base, 'cfg');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'inventory.json'), JSON.stringify({
    ssh: [{ name: 'web1', host: 'web1.example.com', description: 'web box', allow: ['uptime'] }],
    kubernetes: [{
      name: 'lab',
      kubeconfig,
      proxyPort,
      tunnel: { host: 'tunhost', localPort, remote: '127.0.0.1:6443' },
      description: 'lab cluster',
      allow: ['get ...'],
    }],
  }));
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: configDir,
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
    ...extraEnv,
  };
  return {
    base,
    env,
    proxyPort,
    sessionDir: path.join(base, 'st', 'session'),
    logDir: path.join(base, 'st', 'logs'),
    auditLog: path.join(base, 'st', 'logs', 'audit.log'),
    sockets: [path.join(base, 'st', 's', 'ssh-web1'), path.join(base, 'st', 's', 'tun-lab')],
  };
}

function launch(args, env) {
  const child = spawn(process.execPath, [bin, 'start', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const socketDir = path.join(env.KSPROXY_STATE_DIR, 's');
  socketDirs.add(socketDir);
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  return { child, out, exited, socketDir };
}

async function stop(run) {
  const { child, exited } = run;
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => { timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8000); }),
    ]);
    clearTimeout(timer);
  } finally {
    killRecorded(run.socketDir);
  }
}

async function finished(run, ms = 15000) {
  let timer;
  try {
    return await Promise.race([
      run.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('start did not exit')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('start --all opens the targets, serves the session and shuts down cleanly', async () => {
  const s = await setup();
  const run = launch(['--all'], s.env);
  try {
    const sessionFile = path.join(s.sessionDir, 'session.json');
    await waitFor(() => fs.existsSync(sessionFile), 15000, 'session.json');
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 10000, 'the summary');

    assert.ok(run.out.stdout.includes('Session folder:'));
    assert.ok(run.out.stdout.includes('"ksproxy"'));
    assert.ok(run.out.stdout.includes('claude mcp add ksproxy --'));
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d ssh {2}web1 {7}UP$/m);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d kube lab {8}UP$/m);

    const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    assert.equal(session.pid, run.child.pid);
    assert.equal(session.version, 1);
    assert.deepEqual(session.targets.map((t) => `${t.kind}:${t.name}:${t.state}`), ['ssh:web1:up', 'kubernetes:lab:up']);
    assert.equal(session.targets[1].proxyPort, s.proxyPort);
    assert.equal(session.targets[1].tunnel.host, 'tunhost');

    const read = (name) => fs.readFileSync(path.join(s.sessionDir, name), 'utf8');
    assert.ok(read('ssh_config').includes('Host web1'));
    assert.ok(read('kubeconfig').includes(`http://127.0.0.1:${s.proxyPort}`));
    const mcp = JSON.parse(read('mcp.json'));
    assert.equal(mcp.mcpServers['ksproxy'].command, process.execPath);
    assert.deepEqual(mcp.mcpServers['ksproxy'].args, [bin, 'mcp']);
    assert.ok(read('AGENT.md').includes('web1'));
    assert.ok(read('AGENT.md').includes('lab'));
    for (const socket of s.sockets) assert.ok(fs.existsSync(socket), socket);
    for (const name of fs.readdirSync(s.sessionDir)) {
      assert.ok(!read(name).includes('token'), `${name} mentions a token`);
    }
    assert.equal(fs.statSync(s.sessionDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);

    const called = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, s.env);
    assert.equal(called.isError, false);
    await waitFor(() => run.out.stdout.includes('uptime'), 10000, 'the audit line');
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}ok {7}\d\.\ds {3}uptime$/m);

    const refused = await callTool('kubectl', { cluster: 'lab', args: ['get', 'secrets'] }, s.env);
    assert.equal(refused.isError, true);
    await waitFor(() => run.out.stdout.includes('DENIED'), 10000, 'the refused audit line');
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d kube lab {8}DENIED {10}get secrets {2}\[secret resource\]$/m);

    const second = launch(['--all'], s.env);
    const secondResult = await finished(second);
    assert.equal(secondResult.code, 1);
    assert.ok(second.out.stderr.includes('already running'));
    assert.ok(fs.existsSync(sessionFile), 'a refused second start must not touch the live session');

    run.child.kill('SIGINT');
    const result = await finished(run, 10000);
    assert.equal(result.code, 0);
    assert.ok(!fs.existsSync(sessionFile));
    for (const socket of s.sockets) assert.ok(!fs.existsSync(socket), socket);
    assert.equal(await portListening(s.proxyPort), false);
    assert.ok(fs.existsSync(s.auditLog));
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSING {9}Ctrl-C$/m);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSED {10}2 calls: 1 ok, 0 failed, 1 denied$/m);
  } finally {
    await stop(run);
  }
});

test('SIGTERM shuts down the same way', async () => {
  const s = await setup();
  const run = launch(['--all'], s.env);
  try {
    await waitFor(() => fs.existsSync(path.join(s.sessionDir, 'session.json')), 15000, 'session.json');
    run.child.kill('SIGTERM');
    const result = await finished(run, 10000);
    assert.equal(result.code, 0);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSING {9}terminated$/m);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSED {10}0 calls: 0 ok, 0 failed, 0 denied$/m);
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'session.json')));
    for (const socket of s.sockets) assert.ok(!fs.existsSync(socket), socket);
    assert.equal(await portListening(s.proxyPort), false);
  } finally {
    await stop(run);
  }
});

test('a stale session is cleaned up and replaced', async () => {
  const s = await setup();
  fs.mkdirSync(s.sessionDir, { recursive: true });
  fs.mkdirSync(path.dirname(s.sockets[0]), { recursive: true });
  fs.writeFileSync(path.join(s.sessionDir, 'session.json'), JSON.stringify({ version: 1, pid: 2 ** 22 + 54321, targets: [] }));
  fs.writeFileSync(path.join(s.sessionDir, 'old.log'), 'x');
  fs.mkdirSync(s.logDir, { recursive: true });
  fs.writeFileSync(s.auditLog, '{"ts":"2026-01-01T00:00:00.000Z"}\n');
  fs.writeFileSync(s.sockets[0], '');
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 15000, 'the summary');
    const session = JSON.parse(fs.readFileSync(path.join(s.sessionDir, 'session.json'), 'utf8'));
    assert.equal(session.pid, run.child.pid);
    assert.deepEqual(session.targets.map((t) => t.name), ['web1']);
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'old.log')));
    assert.ok(fs.readFileSync(s.auditLog, 'utf8').includes('2026-01-01'));
    assert.ok(!run.out.stdout.includes('2026-01-01'), 'old audit lines are not replayed');
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
  } finally {
    await stop(run);
  }
});

test('start --ssh with an unknown name fails and lists the known names', async () => {
  const s = await setup();
  const run = launch(['--ssh', 'nope'], s.env);
  try {
    const result = await finished(run);
    assert.equal(result.code, 1);
    assert.ok(run.out.stderr.includes('web1'));
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'session.json')));
  } finally {
    await stop(run);
  }
});

test('start without flags and without a terminal asks for a selection flag', async () => {
  const s = await setup();
  const run = launch([], s.env);
  try {
    const result = await finished(run);
    assert.equal(result.code, 1);
    assert.ok(run.out.stderr.includes('--all'));
  } finally {
    await stop(run);
  }
});

test('start --ssh web1 exits 1 when nothing could be opened', async () => {
  const s = await setup({ KSPROXY_FAKE_SSH_FAIL_HOST: 'web1.example.com' });
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    const result = await finished(run);
    assert.equal(result.code, 1);
    assert.ok(run.out.stderr.includes('nothing could be opened'));
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d ssh {2}web1 {7}SKIPPED {9}ssh exited with code 255$/m);
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'session.json')));
  } finally {
    await stop(run);
  }
});

test('a target that fails to open is skipped and the rest stay up', async () => {
  const s = await setup({ KSPROXY_FAKE_SSH_FAIL_HOST: 'web1.example.com' });
  const run = launch(['--all'], s.env);
  try {
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 15000, 'the summary');
    const session = JSON.parse(fs.readFileSync(path.join(s.sessionDir, 'session.json'), 'utf8'));
    assert.deepEqual(session.targets.map((t) => t.name), ['lab']);
    assert.ok(!fs.readFileSync(path.join(s.sessionDir, 'ssh_config'), 'utf8').includes('web1'));
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
    assert.equal(await portListening(s.proxyPort), false);
  } finally {
    await stop(run);
  }
});

test('a socket path that is too long is reported before anything is opened', async () => {
  const s = await setup();
  const long = path.join(s.base, 'x'.repeat(90));
  const run = launch(['--ssh', 'web1'], { ...s.env, KSPROXY_STATE_DIR: long });
  try {
    const result = await finished(run);
    assert.equal(result.code, 1);
    assert.ok(run.out.stderr.includes('too long'));
  } finally {
    await stop(run);
  }
});

test('an invalid inventory is reported and start exits 1', async () => {
  const s = await setup();
  fs.writeFileSync(path.join(s.env.KSPROXY_CONFIG_DIR, 'inventory.json'), '{"ssh":[{"name":"a","host":"-x"}]}');
  const run = launch(['--all'], s.env);
  try {
    const result = await finished(run);
    assert.equal(result.code, 1);
    assert.ok(run.out.stderr.includes('host'));
  } finally {
    await stop(run);
  }
});

test('SIGHUP shuts down the same way', async () => {
  const s = await setup();
  const run = launch(['--all'], s.env);
  try {
    await waitFor(() => fs.existsSync(path.join(s.sessionDir, 'session.json')), 15000, 'session.json');
    run.child.kill('SIGHUP');
    const result = await finished(run, 10000);
    assert.equal(result.code, 0);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSING {9}terminal closed$/m);
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'session.json')));
    for (const socket of s.sockets) assert.ok(!fs.existsSync(socket), socket);
    assert.equal(await portListening(s.proxyPort), false);
  } finally {
    await stop(run);
  }
});

test('a stale socket is closed with -O exit and removed when start begins', async () => {
  const s = await setup();
  const log = path.join(s.base, 'ssh.log');
  const stale = path.join(path.dirname(s.sockets[0]), 'ssh-leftover');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '');
  const run = launch(['--kube', 'lab'], { ...s.env, KSPROXY_FAKE_SSH_LOG: log });
  try {
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 15000, 'the summary');
    assert.ok(!fs.existsSync(stale));
    const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(
      entries.some((argv) => argv.includes('-O') && argv.includes('exit') && argv.includes(stale)),
      JSON.stringify(entries),
    );
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
  } finally {
    await stop(run);
  }
});

test('the session records when the process started', async () => {
  const s = await setup();
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 15000, 'the summary');
    const session = JSON.parse(fs.readFileSync(path.join(s.sessionDir, 'session.json'), 'utf8'));
    assert.ok(Math.abs(session.processStartedAt - Date.now()) < 60000);
    const real = processStartTime(run.child.pid);
    assert.notEqual(real, null);
    assert.ok(Math.abs(session.processStartedAt - real) <= 5000, `${session.processStartedAt} vs ${real}`);
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
  } finally {
    await stop(run);
  }
});

test('a write error on stdout shuts start down and cleans up', async () => {
  const s = await setup();
  const run = launch(['--all'], s.env);
  try {
    await waitFor(() => run.out.stdout.includes('Ctrl-C'), 15000, 'the summary');
    assert.ok(fs.existsSync(path.join(s.sessionDir, 'session.json')));
    run.child.stdout.destroy();
    const called = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, s.env);
    assert.equal(called.isError, false);
    const result = await finished(run, 10000);
    assert.equal(result.signal, null);
    assert.match(run.out.stderr, /^\d\d:\d\d:\d\d -- {3}session {4}CLOSING {9}output closed$/m);
    const logged = fs.readFileSync(s.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(logged.find((e) => e.event === 'session_closing').message, 'output closed');
    assert.equal(logged[logged.length - 1].event, 'session_end');
    assert.ok(!fs.existsSync(path.join(s.sessionDir, 'session.json')));
    for (const socket of s.sockets) assert.ok(!fs.existsSync(socket), socket);
    assert.equal(await portListening(s.proxyPort), false);
    assert.deepEqual(recordedPids(run.socketDir), []);
  } finally {
    await stop(run);
  }
});

test('after a hard kill the next start reaps the leftover proxy', async () => {
  const s = await setup();
  const first = launch(['--kube', 'lab'], s.env);
  let second = null;
  try {
    await waitFor(() => first.out.stdout.includes('Ctrl-C'), 15000, 'the first summary');
    first.child.kill('SIGKILL');
    await first.exited;
    const pids = recordedPids(first.socketDir);
    assert.equal(pids.length, 1);
    const oldPid = pids[0];
    assert.ok(alive(oldPid));
    assert.equal(await portListening(s.proxyPort), true);
    const pidFile = path.join(first.socketDir, 'kube-lab.pid');
    assert.equal(fs.statSync(pidFile).mode & 0o777, 0o600);

    second = launch(['--all'], s.env);
    await waitFor(() => second.out.stdout.includes('Ctrl-C'), 20000, 'the second summary');
    assert.ok(second.out.stderr.includes('left by an earlier run'), second.out.stderr);
    await waitFor(() => !alive(oldPid), 10000, 'the old proxy to be gone');
    const fresh = recordedPids(second.socketDir);
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0], oldPid);
    assert.equal(await portListening(s.proxyPort), true);
    const session = JSON.parse(fs.readFileSync(path.join(s.sessionDir, 'session.json'), 'utf8'));
    assert.equal(session.pid, second.child.pid);
    assert.ok(session.targets.some((t) => t.name === 'lab' && t.state === 'up'));

    second.child.kill('SIGINT');
    assert.equal((await finished(second, 10000)).code, 0);
    assert.deepEqual(recordedPids(second.socketDir), []);
    assert.equal(await portListening(s.proxyPort), false);
  } finally {
    await stop(first);
    if (second) await stop(second);
  }
});

function auditEntries(auditLog) {
  return fs.readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function setAllow(s, ssh, kube = ['get ...']) {
  const file = path.join(s.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.ssh[0].allow = ssh;
  inventory.kubernetes[0].allow = kube;
  fs.writeFileSync(file, JSON.stringify(inventory));
}

test('one session prints the standard lines, reports DOWN and UP, and closes with counts', async () => {
  const s = await setup({ KSPROXY_HEALTH_MS: '300' });
  const run = launch(['--all'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
    const ready = new RegExp(`^\\d\\d:\\d\\d:\\d\\d -- {3}session {4}READY {11}2 targets, pid ${run.child.pid}$`, 'm');
    assert.match(run.out.stdout, ready);
    assert.ok(run.out.stdout.startsWith('Session folder: '));
    assert.ok(run.out.stdout.indexOf('Leave this running') < run.out.stdout.search(ready));

    const opening = [
      /^\d\d:\d\d:\d\d ssh {2}web1 {7}OPENING {9}web1.example.com$/m,
      /^\d\d:\d\d:\d\d ssh {2}web1 {7}UP$/m,
      /^\d\d:\d\d:\d\d kube lab {8}OPENING {9}port \d+$/m,
      /^\d\d:\d\d:\d\d kube lab {8}UP$/m,
    ].map((re) => run.out.stderr.search(re));
    assert.ok(opening.every((i) => i >= 0), JSON.stringify(opening));
    assert.deepEqual([...opening].sort((a, b) => a - b), opening);
    assert.ok(!run.out.stdout.includes('OPENING'));

    const ok = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, s.env);
    assert.equal(ok.isError, false);
    const denied = await callTool('ssh_exec', { server: 'web1', command: 'id' }, s.env);
    assert.equal(denied.isError, true);
    await callTool('list_targets', {}, s.env);
    await waitFor(() => run.out.stdout.includes('LIST'), 10000, 'the list line');
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}ok {7}\d\.\ds {3}uptime$/m);
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}DENIED {10}id {2}\[not on allowlist\]$/m);
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d -- {3}agent {6}LIST {12}list_targets$/m);
    const deniedLine = run.out.stdout.split('\n').find((l) => l.includes('DENIED'));
    assert.ok(!deniedLine.includes('uptime'));
    assert.ok(!deniedLine.includes('Allowed'));
    assert.ok(!/\u001b/.test(run.out.stdout + run.out.stderr), 'no colour when not a terminal');

    fs.rmSync(s.sockets[0]);
    await waitFor(() => /ssh {2}web1 {7}DOWN {12}connection lost$/m.test(run.out.stderr), 10000, 'the DOWN line');
    fs.writeFileSync(s.sockets[0], '');
    await waitFor(() => /ssh {2}web1 {7}UP {14}connection is back$/m.test(run.out.stderr), 10000, 'the UP line');
    assert.equal((run.out.stderr.match(/DOWN/g) ?? []).length, 1, 'one DOWN only');

    run.child.kill('SIGINT');
    const result = await finished(run, 10000);
    assert.equal(result.code, 0);

    const lines = run.out.stderr.trimEnd().split('\n');
    assert.match(lines[lines.length - 2], /^\d\d:\d\d:\d\d -- {3}session {4}CLOSING {9}Ctrl-C$/);
    assert.match(lines[lines.length - 1], /^\d\d:\d\d:\d\d -- {3}session {4}CLOSED {10}2 calls: 1 ok, 0 failed, 1 denied$/);
    assert.ok(!run.out.stdout.includes('CLOSING'));

    const entries = auditEntries(s.auditLog);
    const events = entries.map((e) => e.event);
    assert.deepEqual(events.filter((e) => e !== 'call'), [
      'target_opening', 'target_up', 'target_opening', 'target_up', 'session_start',
      'list', 'target_down', 'target_recovered', 'session_closing', 'session_end',
    ]);
    const started = entries.find((e) => e.event === 'session_start');
    assert.equal(started.pid, run.child.pid);
    assert.deepEqual(started.targets, [
      { kind: 'ssh', name: 'web1', state: 'up' },
      { kind: 'kube', name: 'lab', state: 'up' },
    ]);
    assert.equal(started.message, `2 targets, pid ${run.child.pid}`);
    assert.deepEqual(entries.find((e) => e.event === 'target_down'), {
      ts: entries.find((e) => e.event === 'target_down').ts, event: 'target_down', kind: 'ssh', target: 'web1', message: 'connection lost',
    });
    assert.equal(entries.find((e) => e.event === 'target_recovered').message, 'connection is back');
    assert.equal(entries.find((e) => e.event === 'session_closing').message, 'Ctrl-C');
    const ended = entries.find((e) => e.event === 'session_end');
    assert.equal(ended.ok, 1);
    assert.equal(ended.failed, 0);
    assert.equal(ended.denied, 1);
    assert.equal(ended.message, '2 calls: 1 ok, 0 failed, 1 denied');
    assert.equal(fs.statSync(s.auditLog).mode & 0o777, 0o600);
  } finally {
    await stop(run);
  }
});

test('--verbose adds the rule and sizes, and failed calls are counted as failed', async () => {
  const s = await setup();
  setAllow(s, ['uptime', 'fail']);
  const run = launch(['-v', '--ssh', 'web1'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
    await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, s.env);
    await callTool('ssh_exec', { server: 'web1', command: 'fail' }, s.env);
    await waitFor(() => run.out.stdout.includes('exit 3'), 10000, 'the failed call');
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}ok {7}\d\.\ds {3}uptime {2}\(rule: uptime, out \d+B, err 0B\)$/m);
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}exit 3 {3}\d\.\ds {3}fail {2}\(rule: fail, out 0B, err 5B\)$/m);
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
    assert.match(run.out.stderr, /CLOSED {10}2 calls: 1 ok, 1 failed, 0 denied$/m);
  } finally {
    await stop(run);
  }
});

test('without --verbose the rule is not printed', async () => {
  const s = await setup();
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
    await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, s.env);
    await waitFor(() => run.out.stdout.includes('uptime'), 10000, 'the call line');
    assert.ok(!run.out.stdout.includes('(rule'));
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
  } finally {
    await stop(run);
  }
});

test('a timed-out call prints TIMEOUT and an unreachable program prints ERROR, both counted as failed', async () => {
  const s = await setup();
  setAllow(s, ['uptime', 'slow']);
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
    await callTool('ssh_exec', { server: 'web1', command: 'slow', timeout_seconds: 1 }, s.env);
    await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, { ...s.env, KSPROXY_SSH: path.join(s.base, 'no-such-ssh') });
    await waitFor(() => run.out.stdout.includes('ERROR'), 10000, 'the ERROR line');
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}TIMEOUT {2}1\.\ds {3}slow$/m);
    assert.match(run.out.stdout, /^\d\d:\d\d:\d\d ssh {2}web1 {7}ERROR {4}0\.\ds {3}uptime$/m);
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
    assert.match(run.out.stderr, /CLOSED {10}2 calls: 0 ok, 2 failed, 0 denied$/m);
  } finally {
    await stop(run);
  }
});

test('kube states that are not up are reported as WARN lines, an empty allowlist too', async () => {
  const expected = [
    ['401', /^\d\d:\d\d:\d\d kube lab {8}WARN {12}token rejected by the cluster$/m],
    ['500', /^\d\d:\d\d:\d\d kube lab {8}WARN {12}cluster did not answer, see kube-lab\.log$/m],
  ];
  for (const [status, pattern] of expected) {
    const s = await setup({ KSPROXY_FAKE_KUBECTL_STATUS: status });
    setAllow(s, ['uptime'], []);
    const run = launch(['--kube', 'lab'], s.env);
    try {
      await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
      assert.match(run.out.stderr, pattern);
      assert.match(run.out.stderr, /^\d\d:\d\d:\d\d kube lab {8}WARN {12}allowlist is empty, every command will be refused$/m);
      assert.ok(!/kube lab {8}UP$/m.test(run.out.stderr));
      assert.equal(auditEntries(s.auditLog).find((e) => e.event === 'session_start').targets[0].state, status === '401' ? 'auth' : 'fail');
      run.child.kill('SIGINT');
      assert.equal((await finished(run, 10000)).code, 0);
    } finally {
      await stop(run);
    }
  }
});

test('an ssh target with an empty allowlist warns before it opens', async () => {
  const s = await setup();
  setAllow(s, []);
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 15000, 'READY');
    const warn = run.out.stderr.search(/^\d\d:\d\d:\d\d ssh {2}web1 {7}WARN {12}allowlist is empty, every command will be refused$/m);
    const opening = run.out.stderr.search(/OPENING/);
    assert.ok(warn >= 0 && warn < opening);
    run.child.kill('SIGINT');
    assert.equal((await finished(run, 10000)).code, 0);
  } finally {
    await stop(run);
  }
});

test('a log larger than 5 MiB is rotated to a stamped file when start begins, and that file is kept', async () => {
  const s = await setup();
  fs.mkdirSync(s.logDir, { recursive: true });
  const rotated = () => fs.readdirSync(s.logDir).filter((n) => /^audit-\d{8}-\d{6}\.log$/.test(n));
  const big = path.join(s.logDir, 'audit.log');
  fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0x20));
  const first = launch(['--ssh', 'web1'], s.env);
  let second = null;
  try {
    await waitFor(() => /READY/.test(first.out.stdout), 15000, 'READY');
    assert.equal(rotated().length, 1);
    assert.equal(fs.statSync(path.join(s.logDir, rotated()[0])).size, 6 * 1024 * 1024);
    assert.ok(fs.statSync(big).size < 4096);
    assert.equal(auditEntries(s.auditLog)[0].event, 'target_opening');
    first.child.kill('SIGINT');
    assert.equal((await finished(first, 10000)).code, 0);

    second = launch(['--ssh', 'web1'], s.env);
    await waitFor(() => /READY/.test(second.out.stdout), 15000, 'READY again');
    assert.equal(rotated().length, 1, 'a small log does not rotate and the rotated file survives');
    assert.equal(fs.statSync(path.join(s.logDir, rotated()[0])).size, 6 * 1024 * 1024);
    second.child.kill('SIGINT');
    assert.equal((await finished(second, 10000)).code, 0);
  } finally {
    await stop(first);
    if (second) await stop(second);
  }
});

test('the health check never runs two checks at once and does not delay shutdown', async () => {
  const trace = path.join(fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-tr-'))), 'trace');
  const s = await setup({
    KSPROXY_HEALTH_MS: '200',
    KSPROXY_FAKE_SSH_CHECK_MS: '500',
    KSPROXY_FAKE_SSH_TRACE: trace,
  });
  const run = launch(['--ssh', 'web1'], s.env);
  try {
    await waitFor(() => /READY/.test(run.out.stdout), 20000, 'READY');
    const beginsAtReady = (fs.readFileSync(trace, 'utf8').match(/begin/g) ?? []).length;
    await waitFor(() => (fs.readFileSync(trace, 'utf8').match(/begin/g) ?? []).length >= beginsAtReady + 3, 15000, 'three health checks');
    run.child.kill('SIGINT');
    const started = Date.now();
    assert.equal((await finished(run, 10000)).code, 0);
    assert.ok(Date.now() - started < 6000, 'shutdown was not held up');
    const words = fs.readFileSync(trace, 'utf8').trim().split('\n');
    for (let i = 1; i < words.length; i += 1) {
      assert.ok(!(words[i] === 'begin' && words[i - 1] === 'begin'), `two checks overlapped: ${words.join(',')}`);
    }
    const lines = run.out.stderr.trimEnd().split('\n');
    assert.match(lines[lines.length - 1], /CLOSED/);
    assert.ok(!/DOWN/.test(run.out.stderr));
  } finally {
    await stop(run);
  }
});

function helperProcess(extra = []) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e6)', ...extra], { stdio: 'ignore' });
  children.add(child);
  return child;
}

function writePidFile(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, name);
}

test('reapStaleProxies only kills a live, matching proxy process', async () => {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-reap-'))), 's');

  const deadFile = writePidFile(dir, 'kube-a.pid', JSON.stringify({ pid: 2 ** 22 + 54321, startedAt: Date.now() }));
  assert.equal(await reapStaleProxies(dir), 0);
  assert.ok(!fs.existsSync(deadFile));

  const wrongTime = helperProcess(['proxy', 'x']);
  const wrongFile = writePidFile(dir, 'kube-b.pid', JSON.stringify({
    pid: wrongTime.pid, startedAt: processStartTime(wrongTime.pid) - 3600000,
  }));
  assert.equal(await reapStaleProxies(dir), 0);
  assert.ok(alive(wrongTime.pid));
  assert.ok(!fs.existsSync(wrongFile));

  const nullTime = helperProcess(['proxy', 'x']);
  const nullFile = writePidFile(dir, 'kube-c.pid', JSON.stringify({ pid: nullTime.pid, startedAt: null }));
  assert.equal(await reapStaleProxies(dir), 0);
  assert.ok(alive(nullTime.pid));
  assert.ok(!fs.existsSync(nullFile));

  const notProxy = helperProcess(['other']);
  const notProxyFile = writePidFile(dir, 'kube-d.pid', JSON.stringify({
    pid: notProxy.pid, startedAt: processStartTime(notProxy.pid),
  }));
  assert.equal(await reapStaleProxies(dir), 0);
  assert.ok(alive(notProxy.pid));
  assert.ok(!fs.existsSync(notProxyFile));

  const corrupt = writePidFile(dir, 'kube-e.pid', '{not json');
  assert.equal(await reapStaleProxies(dir), 0);
  assert.ok(!fs.existsSync(corrupt));

  const match = helperProcess(['proxy', 'x']);
  const matchFile = writePidFile(dir, 'kube-f.pid', JSON.stringify({
    pid: match.pid, startedAt: processStartTime(match.pid),
  }));
  assert.equal(await reapStaleProxies(dir), 1);
  await waitFor(() => !alive(match.pid), 10000, 'the matching helper to be gone');
  assert.ok(!fs.existsSync(matchFile));

  assert.equal(await reapStaleProxies(path.join(dir, 'missing')), 0);
});
