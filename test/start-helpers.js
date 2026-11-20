import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { start } from '../src/start.js';

export const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
export const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function freePorts(count) {
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

export function makeStream() {
  const stream = new EventEmitter();
  stream.text = '';
  stream.isTTY = false;
  stream.onWrite = null;
  stream.write = (text) => {
    stream.text += text;
    if (stream.onWrite) stream.onWrite(text);
    return true;
  };
  return stream;
}

export function fakeProcess(extra = {}) {
  const proc = new EventEmitter();
  proc.stdout = makeStream();
  proc.stderr = makeStream();
  proc.stdin = { isTTY: false };
  proc.pid = process.pid;
  proc.execPath = process.execPath;
  return Object.assign(proc, extra);
}

export function listenerTotal(proc) {
  return ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']
    .reduce((n, name) => n + proc.listenerCount(name), 0)
    + proc.stdout.listenerCount('error') + proc.stderr.listenerCount('error');
}

const dirs = new Set();
const running = new Set();

export function trackDir(dir) {
  dirs.add(dir);
}

export function killRecordedProxies(socketDir) {
  let names;
  try {
    names = fs.readdirSync(socketDir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => n.startsWith('kube-') && n.endsWith('.pid'))) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(path.join(socketDir, name), 'utf8'));
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL');
    } catch {
      // gone already or unreadable
    }
  }
}

export function cleanupAll() {
  for (const run of running) run.proc.emit('SIGINT');
  for (const dir of dirs) {
    killRecordedProxies(path.join(dir, 'st', 's'));
    try {
      fs.chmodSync(path.join(dir, 'st', 's', 'trap'), 0o700);
    } catch {
      // not created
    }
    try {
      fs.chmodSync(path.join(dir, 'st', 'session'), 0o700);
    } catch {
      // not created
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function registerRun(run) {
  running.add(run);
  run.done.then(() => running.delete(run), () => running.delete(run));
}

export function launch(world, options, host = {}) {
  const proc = host.process ?? fakeProcess();
  const run = { proc, done: start(options, world.env, { ...host, process: proc }) };
  registerRun(run);
  return run;
}

export async function ready(run) {
  await waitFor(() => run.proc.stdout.text.includes('Leave this running'), 20000, 'the session to be ready');
}

export function stopWith(run, signal = 'SIGINT') {
  run.proc.emit(signal);
  return run.done;
}

export async function makeWorld({
  ssh = [{
    name: 'web1', host: 'web1.example.com', description: 'web box', allow: ['uptime', 'fail', 'cat *'],
  }],
  kubernetes = [],
  local = [],
  extraEnv = {},
} = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-sp-')));
  trackDir(base);
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'hello a\n');
  const localEntries = local.map((l) => ({
    name: 'infra', cwd: proj, description: 'a repo', allow: ['ls ...', 'cat *'], ...l,
  }));
  const kubeconfig = path.join(base, 'kube.yaml');
  fs.writeFileSync(kubeconfig, 'apiVersion: v1\n');
  const configDir = path.join(base, 'cfg');
  fs.mkdirSync(configDir);
  const kube = [];
  for (const k of kubernetes) {
    const [proxyPort, localPort] = await freePorts(2);
    kube.push({
      name: 'lab', kubeconfig, proxyPort, description: 'lab cluster', allow: ['get ...'], ...k,
      ...(k.tunnel ? { tunnel: { host: 'tunhost', localPort, remote: '127.0.0.1:6443' } } : {}),
    });
  }
  fs.writeFileSync(path.join(configDir, 'inventory.json'), JSON.stringify({ ssh, kubernetes: kube, local: localEntries }));
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: configDir,
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
    KSPROXY_HEALTH_MS: '200',
    ...extraEnv,
  };
  return {
    base,
    env,
    kubeconfig,
    proj,
    sessionDir: path.join(base, 'st', 'session'),
    socketDir: path.join(base, 'st', 's'),
    kube,
  };
}
