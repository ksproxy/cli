import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { reapDoctorFolders } from '../src/doctor-folder.js';
import { portListening } from '../src/kinds/kubernetes/cluster.js';
import { processStartTime } from '../src/session.js';
import {
  alive, cleanupAll, fakeProcess, freePorts, killRecordedProxies, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

const BIN = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const SSH_LOG_KEY = ['KSPROXY', 'FAKE', 'SSH', 'LOG'].join('_');
const HOLD_KEY = ['KSPROXY', 'FAKE', 'KUBECTL', 'HOLD'].join('_');

const children = new Set();
const worlds = [];

const doctorFolders = (w) => (fs.existsSync(w.root) ? fs.readdirSync(w.root).filter((name) => name.startsWith('d-')).sort() : []);

// A proxy that a failed test left is stopped by its pid file, in whatever folder of the root state folder it is.
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const w of worlds) {
    if (!fs.existsSync(w.root)) continue;
    for (const name of fs.readdirSync(w.root)) killRecordedProxies(path.join(w.root, name, 's'));
  }
  cleanupAll();
});

// A world with ssh web1 and the cluster lab behind an ssh tunnel, in the default inventory.
async function world(kubernetes = [{ tunnel: true }]) {
  const w = await makeWorld({ kubernetes, extraEnv: { NO_COLOR: '1' } });
  w.root = w.env[STATE_KEY];
  w.sshLog = path.join(w.base, 'ssh.log');
  w.env[SSH_LOG_KEY] = w.sshLog;
  worlds.push(w);
  return w;
}

const sshCalls = (w) => (fs.existsSync(w.sshLog) ? fs.readFileSync(w.sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// How often the master at socket was closed as a leftover: ssh -S SOCKET -O exit stale.
const staleExits = (w, socket) => sshCalls(w).filter((argv) => JSON.stringify(argv) === JSON.stringify(['-S', socket, '-O', 'exit', 'stale'])).length;

const LINE = /^\d\d:\d\d:\d\d (\S+) +(\S+) +(OK|FAIL|WARN|SKIPPED) +(.*)$/;
// Each line of the output as KIND TARGET STATUS DETAIL, without the time and the padding; another line as it is.
function brief(text) {
  return text.split('\n').filter((line) => line !== '').map((line) => {
    const m = LINE.exec(line);
    return m === null ? line : `${m[1]} ${m[2]} ${m[3]} ${m[4]}`;
  });
}

// The pid of a process that has ended.
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid;
}

// Runs bin/ksproxy.js doctor --kube lab as a child process, waits until its check of lab waits on the proxy, so that the
// proxy and the ssh master of the tunnel run, and kills it with SIGKILL while it still runs. Gives what it left.
async function killedDoctor(w) {
  const held = path.join(w.base, 'held.txt');
  const child = spawn(process.execPath, [BIN, 'doctor', '--kube', 'lab'], { env: { ...w.env, [HOLD_KEY]: held }, stdio: 'ignore' });
  children.add(child);
  const exited = new Promise((resolve) => { child.once('exit', (code, signal) => resolve(signal)); });
  await waitFor(() => fs.existsSync(held), 20000, 'the doctor check to wait on the proxy');
  const [name] = doctorFolders(w);
  const folder = path.join(w.root, name);
  const owner = JSON.parse(fs.readFileSync(path.join(folder, 'owner.json'), 'utf8'));
  const proxyPid = JSON.parse(fs.readFileSync(path.join(folder, 's', 'kube-lab.pid'), 'utf8')).pid;
  const tunnel = path.join(folder, 's', 'tun-lab');
  const port = w.kube[0].proxyPort;
  assert.equal(child.exitCode, null, 'the doctor still runs');
  assert.deepEqual(owner, { pid: child.pid, processStartedAt: processStartTime(child.pid) });
  child.kill('SIGKILL');
  assert.equal(await exited, 'SIGKILL');
  children.delete(child);
  // It left its folder, the proxy on the port of lab and the master of the tunnel.
  assert.deepEqual(doctorFolders(w), [name]);
  assert.equal(alive(proxyPid), true);
  assert.equal(await portListening(port), true);
  assert.equal(fs.existsSync(tunnel), true);
  assert.equal(staleExits(w, tunnel), 0);
  return {
    name, proxyPid, tunnel, port,
  };
}

test('a doctor killed with SIGKILL leaves its short folder, its proxy and its ssh master: the next doctor stops them and removes the folder', async () => {
  const w = await world();
  const left = await killedDoctor(w);
  assert.match(left.name, /^d-[A-Za-z0-9]{6}$/, 'd- and six random characters');
  const proc = fakeProcess();
  assert.equal(await main(['doctor', '--kube', 'lab'], w.env, { process: proc }), 0, proc.stdout.text);
  assert.deepEqual(brief(proc.stdout.text), [
    `-- inventory OK loaded ${path.join(w.env[CONFIG_KEY], 'inventory.json')}`,
    '-- session OK no session is running',
    '-- leftovers OK closed 1 proxy process(es) left by an earlier run',
    'kube lab OK server v1.31.2',
    '1 of 1 targets OK',
  ]);
  assert.equal(proc.stderr.text, '');
  await waitFor(() => !alive(left.proxyPid), 10000, 'the stale proxy to be gone');
  assert.equal(staleExits(w, left.tunnel), 1, 'the master of the tunnel is closed');
  assert.deepEqual(doctorFolders(w), []);
  assert.equal(await portListening(left.port), false);
});

test('the next start stops what a killed doctor left with the line of its own clean-up, removes the folder, and opens the cluster on that port', async () => {
  const w = await world();
  const left = await killedDoctor(w);
  const run = launch(w, { all: true });
  await ready(run);
  assert.match(run.proc.stderr.text, /^closed 1 proxy process\(es\) left by an earlier run\n\d\d:\d\d:\d\d ssh +web1 +OPENING/);
  await waitFor(() => !alive(left.proxyPid), 10000, 'the stale proxy to be gone');
  assert.equal(staleExits(w, left.tunnel), 1, 'the master of the tunnel is closed');
  assert.deepEqual(doctorFolders(w), []);
  const session = JSON.parse(fs.readFileSync(path.join(w.sessionDir, 'session.json'), 'utf8'));
  assert.deepEqual(session.targets.map((t) => `${t.name} ${t.state}`), ['web1 up', 'lab up']);
  assert.equal(await stopWith(run), 0);
  assert.equal(await portListening(left.port), false);
});

test('a doctor folder is cleaned only when its owner record names a process that is gone, and a folder that resists is left', async () => {
  const w = await world([]);
  const make = (name, record) => {
    const folder = path.join(w.root, name);
    fs.mkdirSync(path.join(folder, 's'), { recursive: true });
    if (record !== undefined) fs.writeFileSync(path.join(folder, 'owner.json'), record);
    return folder;
  };
  const dead = JSON.stringify({ pid: deadPid(), processStartedAt: null });
  make('d-live01', JSON.stringify({ pid: process.pid, processStartedAt: processStartTime(process.pid) }));
  make('d-made01');
  make('d-junk01', 'not json');
  const gone = make('d-gone01', dead);
  fs.writeFileSync(path.join(gone, 's', 'ssh-web1'), '');
  make('d-reuse1', JSON.stringify({ pid: process.pid, processStartedAt: 1 }));
  make('keep01', dead);
  fs.writeFileSync(path.join(w.root, 'd-file01'), dead);
  const locked = make('d-lock01', dead);
  const stuck = make('d-stuck1', dead);
  fs.mkdirSync(path.join(stuck, 'session'));
  fs.writeFileSync(path.join(stuck, 'session', 'kube-lab.log'), '');
  // Folders without an owner record, unchanged for ten minutes: those a doctor killed before it wrote its record
  // leaves hold nothing or only a temporary file of the record.
  const old = (name, entries) => {
    const folder = path.join(w.root, name);
    fs.mkdirSync(folder);
    for (const entry of entries) {
      if (entry.endsWith('/')) fs.mkdirSync(path.join(folder, entry));
      else fs.writeFileSync(path.join(folder, entry), '');
    }
    const then = Date.now() / 1000 - 600;
    fs.utimesSync(folder, then, then);
    return folder;
  };
  old('d-old001', []);
  old('d-oldtmp', ['owner.json.123.0a1b2c.tmp']);
  old('d-oldsrv', ['s']);
  old('d-oldodd', ['owner.json.x']);
  const held = old('d-oldlck', ['owner.json.9.ab.tmp']);
  old('d-oldrec', ['owner.json/']);
  // A d- entry that is a link to a folder with the record of a process that is gone is never followed.
  const elsewhere = path.join(w.base, 'elsewhere');
  fs.mkdirSync(path.join(elsewhere, 's'), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'owner.json'), dead);
  fs.writeFileSync(path.join(elsewhere, 's', 'ssh-web1'), '');
  fs.symlinkSync(elsewhere, path.join(w.root, 'd-link01'));
  fs.chmodSync(locked, 0o500);
  fs.chmodSync(held, 0o500);
  fs.chmodSync(path.join(stuck, 'session'), 0o500);
  const left = [
    'd-file01', 'd-link01', 'd-live01', 'd-lock01', 'd-made01', 'd-oldlck', 'd-oldodd', 'd-oldrec', 'd-oldsrv', 'd-stuck1',
  ];
  try {
    const proc = fakeProcess();
    assert.equal(await main(['doctor', '--ssh', 'web1'], w.env, { process: proc }), 0, proc.stdout.text);
    assert.deepEqual(brief(proc.stdout.text).slice(1), ['-- session OK no session is running', 'ssh web1 OK connected', '1 of 1 targets OK']);
    // Left: a live owner, a folder without a record yet, a file, a link, a folder whose record cannot be replaced, one
    // that cannot be removed, which keeps the record of the run that took it over, and old folders without a record
    // that hold something else or cannot be removed. Removed: no JSON, a process that is gone, a pid that now names
    // another process, and old folders without a record that hold nothing or a temporary file of the record. A name
    // without d- is no doctor folder.
    assert.deepEqual(doctorFolders(w), left);
    assert.equal(fs.existsSync(path.join(w.root, 'keep01')), true);
    assert.equal(staleExits(w, path.join(gone, 's', 'ssh-web1')), 1, 'the master of a removed folder is closed');
    assert.equal(fs.readFileSync(path.join(locked, 'owner.json'), 'utf8'), dead);
    assert.deepEqual(fs.readdirSync(stuck).sort(), ['owner.json', 'session']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stuck, 'owner.json'), 'utf8')).pid, process.pid);
    assert.equal(fs.lstatSync(path.join(w.root, 'd-link01')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'owner.json'), 'utf8'), dead);
    assert.deepEqual(fs.readdirSync(path.join(elsewhere, 's')), ['ssh-web1']);
    assert.equal(staleExits(w, path.join(w.root, 'd-link01', 's', 'ssh-web1')), 0, 'nothing is closed through the link');
    assert.deepEqual(fs.readdirSync(held), ['owner.json.9.ab.tmp']);

    // start leaves the same folders, and prints nothing of them.
    const run = launch(w, { ssh: ['web1'] });
    await ready(run);
    assert.match(run.proc.stderr.text, /^\d\d:\d\d:\d\d ssh +web1 +OPENING/);
    assert.deepEqual(doctorFolders(w), left);
    assert.equal(await stopWith(run), 0);
  } finally {
    fs.chmodSync(locked, 0o700);
    fs.chmodSync(held, 0o700);
    fs.chmodSync(path.join(stuck, 'session'), 0o700);
  }
});

test('two clean-ups at once, as the starts of several projects run them: the first takes the folder over, the second leaves it', async () => {
  const w = await world([]);
  const folder = path.join(w.root, 'd-gone02');
  fs.mkdirSync(path.join(folder, 's'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'owner.json'), JSON.stringify({ pid: deadPid(), processStartedAt: null }));
  fs.writeFileSync(path.join(folder, 's', 'ssh-web1'), '');
  assert.deepEqual(await Promise.all([reapDoctorFolders(w.env, process.pid), reapDoctorFolders(w.env, process.pid)]), [[], []]);
  assert.equal(staleExits(w, path.join(folder, 's', 'ssh-web1')), 1, 'the master is closed once');
  assert.equal(fs.existsSync(folder), false);
  // No root state folder: nothing to clean, and none is made.
  assert.deepEqual(await reapDoctorFolders({ ...w.env, [STATE_KEY]: path.join(w.base, 'none') }, process.pid), []);
  assert.equal(fs.existsSync(path.join(w.base, 'none')), false);
});

test('a connection that arrives while doctor binds a --listen address is closed, and the check does not wait for it', async () => {
  const w = await world([]);
  const [port] = await freePorts(1);
  const original = net.createServer;
  const clients = [];
  // The server of the check closes only once a client has connected and the server has taken it in.
  net.createServer = (...args) => {
    const server = original(...args);
    const close = server.close.bind(server);
    server.close = (callback) => {
      server.once('connection', () => setImmediate(() => close(callback)));
      const client = net.connect(port, '127.0.0.1');
      client.on('error', () => {});
      clients.push(client);
      return server;
    };
    return server;
  };
  let timer;
  try {
    const proc = fakeProcess();
    proc.stdout.isTTY = true;
    const run = main(['doctor', '--ssh', 'web1', '--listen', `127.0.0.1:${port}`], w.env, { process: proc });
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), 10000); });
    assert.equal(await Promise.race([run, late]), 0, proc.stdout.text);
    assert.ok(brief(proc.stdout.text).includes(`-- listen OK 127.0.0.1:${port}`), proc.stdout.text);
    assert.equal(clients.length, 1);
  } finally {
    clearTimeout(timer);
    net.createServer = original;
    for (const client of clients) client.destroy();
  }
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  await new Promise((resolve) => { server.close(resolve); });
});
