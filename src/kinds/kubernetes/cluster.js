import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ensureDir, kubectlBin, socketDir as socketDirOf, socketPath, writeFileAtomic,
} from '../../paths.js';
import { clip } from '../../text.js';
import { processStartTime, psEnv } from '../../session.js';
import { closeMaster, openMaster } from '../ssh/master.js';

export const REJECT_PATHS = '^/api/.*/pods/.*/exec,^/api/.*/pods/.*/attach,^/api/.*/pods/.*/portforward,^/api/.*/secrets,^/api/.*/serviceaccounts/.*/token';

export function kubeconfigText(targets) {
  const clusters = targets.map((t) => [
    `- name: ${t.name}`,
    '  cluster:',
    `    server: http://127.0.0.1:${t.proxyPort}`,
  ].join('\n'));
  const contexts = targets.map((t) => [
    `- name: ${t.name}`,
    '  context:',
    `    cluster: ${t.name}`,
    '    user: none',
  ].join('\n'));
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    ...clusters,
    'users:',
    '- name: none',
    '  user: {}',
    'contexts:',
    ...contexts,
    '',
  ].join('\n');
}

export function proxyArgs(kubeconfig, port) {
  return ['--kubeconfig', kubeconfig, 'proxy', '--address=127.0.0.1', `--port=${port}`, `--reject-paths=${REJECT_PATHS}`];
}

export function kubectlArgs(kubeconfigFile, name, args) {
  return ['--kubeconfig', kubeconfigFile, '--context', name, ...args];
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const SECRET = /^secrets?([./]|$)/i;
const OUTPUT_OK = /^(json|yaml|wide|name|jsonpath=.+|jsonpath-as-json=.+|custom-columns=.+)$/;
const MANIFEST_FLAGS = new Set(['-f', '--filename', '--patch-file']);

const VERBS = new Set([
  'get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version',
  'events', 'auth', 'cluster-info',
  'apply', 'create', 'delete', 'patch', 'replace', 'rollout', 'scale', 'autoscale',
  'label', 'annotate', 'set', 'expose', 'wait', 'diff',
  'cordon', 'uncordon', 'drain', 'taint',
]);

export const READ_VERBS = new Set([
  'get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version',
  'events', 'cluster-info',
]);

const FLAGS = new Set([
  // scope and selection
  '-n', '--namespace', '-A', '--all-namespaces', '-l', '--selector', '--field-selector', '--all',
  // output
  '-o', '--output', '-w', '--watch', '--watch-only', '--show-labels', '--show-kind', '--no-headers',
  '--sort-by', '--ignore-not-found', '--chunk-size', '--show-managed-fields', '--output-watch-events',
  '-L', '--label-columns', '--subresource', '--show-events',
  // manifests
  '-f', '--filename', '-R', '--recursive', '--patch-file',
  // logs
  '--follow', '--tail', '--since', '--since-time', '--timestamps', '--previous', '--all-containers',
  '-c', '--container', '--prefix', '--limit-bytes', '--max-log-requests', '--pod-running-timeout',
  '--ignore-errors', '--all-pods',
  // writes
  '--dry-run', '--server-side', '--force-conflicts', '--field-manager', '--validate', '--overwrite',
  '--wait', '--timeout', '--grace-period', '--force', '--cascade', '--now', '--replicas',
  '--current-replicas', '--resource-version', '--type', '-p', '--patch', '--revision', '--to-revision',
  '--for', '--containers', '--request-timeout', '--save-config', '--from-literal',
  '--min', '--max', '--cpu-percent', '--port', '--target-port', '--name', '--protocol', '--labels',
  '--list', '-e', '--env', '--from', '--keys',
  // node maintenance
  '--delete-emptydir-data', '--ignore-daemonsets', '--disable-eviction', '--pod-selector',
  '--skip-wait-for-delete-timeout',
  // explain, api-resources, auth, version, top
  '--api-version', '--namespaced', '--api-group', '--verbs', '--categories', '--cached', '--client',
  '--quiet', '-q', '--sum',
]);

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function manifestRefusal(flag, value, manifestRoots, statSync) {
  if (value === undefined) return { reason: `the flag ${flag} needs a path`, short: `${flag} needs a path` };
  if (/^https?:\/\//i.test(value) || value === '-') {
    return {
      reason: `${flag} only accepts a local path inside the configured manifestRoots`,
      short: `${flag}: not a local file`,
    };
  }
  if (!Array.isArray(manifestRoots) || manifestRoots.length === 0) {
    return {
      reason: `${flag} is refused because this target has no manifestRoots configured`,
      short: 'no manifestRoots',
    };
  }
  const real = realpathOrNull(path.resolve(value));
  if (real === null) return { reason: `${flag} path does not exist: ${value}`, short: `${flag}: file not found` };
  const roots = manifestRoots.map(realpathOrNull).filter((r) => r !== null);
  const inside = roots.some((root) => root === path.sep || real === root || real.startsWith(root + path.sep));
  if (!inside) {
    return { reason: `${flag} path is outside the configured manifestRoots`, short: `${flag}: outside manifestRoots` };
  }
  let regular = false;
  try {
    regular = statSync(real).isFile();
  } catch {
    regular = false;
  }
  return regular ? null : {
    reason: `${flag} must name a single file inside the configured manifestRoots, not a directory`,
    short: `${flag}: not a single file`,
  };
}

function flagName(arg) {
  const head = arg.split('=', 1)[0];
  return head.startsWith('--') ? head.replaceAll('_', '-') : head;
}

function flagValue(args, i) {
  const eq = args[i].indexOf('=');
  if (eq !== -1) return { value: args[i].slice(eq + 1), consumed: 0 };
  if (i + 1 < args.length) return { value: args[i + 1], consumed: 1 };
  return { value: undefined, consumed: 0 };
}

export function hardRefusalDetail(args, manifestRoots, { statSync = fs.statSync } = {}) {
  if (!Array.isArray(args) || args.length === 0
    || args.some((a) => typeof a !== 'string' || a === '' || Buffer.byteLength(a) > 4096 || CONTROL.test(a))) {
    return {
      reason: 'arguments must be a non-empty list of non-empty single-line strings without control characters',
      short: 'invalid arguments',
    };
  }
  const verb = args[0];
  if (verb.startsWith('-')) {
    return { reason: 'put the verb first (for example: get pods -n web); flags go after it', short: 'verb must come first' };
  }
  if (!VERBS.has(verb)) {
    return {
      reason: `the "${verb}" command is not available through this proxy`,
      short: `verb "${clip(verb, 20)}" unavailable`,
    };
  }
  if (verb === 'create' && args.includes('token')) {
    return { reason: '"create token" is never allowed: it would hand out a credential', short: 'create token' };
  }
  if (verb === 'cluster-info' && args.includes('dump')) {
    return {
      reason: '"cluster-info dump" is never allowed: it writes files and dumps cluster state',
      short: 'cluster-info dump',
    };
  }
  if (verb === 'auth' && args[1] !== 'can-i' && args[1] !== 'whoami') {
    return { reason: 'only "auth can-i" and "auth whoami" are available through this proxy', short: 'auth: only can-i, whoami' };
  }
  if (verb === 'apply' && args.includes('edit-last-applied')) {
    return { reason: '"apply edit-last-applied" is never allowed: it opens an editor', short: 'opens an editor' };
  }

  for (const arg of args) {
    const candidates = arg.includes('=') ? [arg, arg.slice(arg.indexOf('=') + 1)] : [arg];
    for (const candidate of candidates) {
      if (candidate.split(',').some((part) => SECRET.test(part.trim()))) {
        return { reason: 'secret resources are never allowed', short: 'secret resource' };
      }
    }
  }

  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    if (arg === '--') return { reason: 'a bare "--" is not allowed', short: 'bare "--"' };
    if (!arg.startsWith('--') && arg.length > 2 && arg[2] !== '=') {
      return {
        reason: 'write short flags separately (for example "-o json", not "-ojson")',
        short: 'combined short flags',
      };
    }
    const name = flagName(arg);
    if (!FLAGS.has(name)) {
      return {
        reason: `the flag ${name} is not available through this proxy`,
        short: `flag ${clip(name, 30)} unavailable`,
      };
    }

    if (name === '-o' || name === '--output') {
      const { value, consumed } = flagValue(args, i);
      if (value === undefined || !OUTPUT_OK.test(value)) {
        return {
          reason: 'output format must be one of: json, yaml, wide, name, jsonpath=..., jsonpath-as-json=..., custom-columns=...',
          short: 'output format',
        };
      }
      i += consumed;
    } else if (MANIFEST_FLAGS.has(name) && !(name === '-f' && verb === 'logs')) {
      const { value, consumed } = flagValue(args, i);
      const refusal = manifestRefusal(name, value, manifestRoots, statSync);
      if (refusal) return refusal;
      i += consumed;
    }
  }
  return null;
}

export function hardRefusal(args, manifestRoots, options) {
  return hardRefusalDetail(args, manifestRoots, options)?.reason ?? null;
}

export function portListening(port, timeoutMs = 500, connect = net.connect) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function probeVersion(port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: timeoutMs }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve('up');
      else if (res.statusCode === 401 || res.statusCode === 403) resolve('auth');
      else resolve('fail');
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('fail');
    });
    req.on('error', () => resolve('fail'));
  });
}

function waitForExit(child, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function closeCluster(handle, env = process.env, { graceMs = 2000 } = {}) {
  const { child, tunnel, pidFile } = handle ?? {};
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await waitForExit(child, graceMs);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  } catch {
    // never throws
  }
  try {
    if (tunnel) await closeMaster(tunnel, env);
  } catch {
    // never throws
  }
  try {
    if (pidFile) fs.rmSync(pidFile, { force: true });
  } catch {
    // never throws
  }
}

function pidGone(pid, kill) {
  try {
    kill(pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

export function commandLine(pid) {
  const out = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8', env: psEnv(), timeout: 2000,
  });
  return out.status === 0 ? out.stdout.trim() : null;
}

// Stop proxies left behind by a start that died without cleaning up.
// Kills a recorded pid only when it is still the same process (start time within 5 s)
// and its command line contains " proxy ". Removes every pid file it reads.
export async function reapStaleProxies(socketDir, {
  kill = (pid, signal) => process.kill(pid, signal), deadlineMs = 2000,
} = {}) {
  let names;
  try {
    names = fs.readdirSync(socketDir).filter((n) => n.endsWith('.pid'));
  } catch {
    return 0;
  }
  let signalled = 0;
  for (const name of names) {
    const file = path.join(socketDir, name);
    try {
      let record = null;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        record = null;
      }
      const pid = record?.pid;
      const recorded = record?.startedAt;
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(recorded)) continue;
      try {
        kill(pid, 0);
      } catch {
        continue;
      }
      const started = processStartTime(pid);
      if (started === null || Math.abs(started - recorded) > 5000) continue;
      const command = commandLine(pid);
      if (command === null || !command.includes(' proxy ')) continue;
      try {
        kill(pid, 'SIGTERM');
      } catch {
        continue;
      }
      signalled += 1;
      const deadline = Date.now() + deadlineMs;
      while (!pidGone(pid, kill) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pidGone(pid, kill)) {
        try {
          kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    } finally {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // best effort
      }
    }
  }
  return signalled;
}

export async function openCluster(target, { sessionDir }, env = process.env) {
  if (!fs.existsSync(target.kubeconfig)) {
    return { ok: false, error: `kubeconfig not found: ${target.kubeconfig}` };
  }
  if (await portListening(target.proxyPort)) {
    return { ok: false, error: `port ${target.proxyPort} is already in use` };
  }

  let tunnel = null;
  if (target.tunnel) {
    const socket = socketPath('tun', target.name, env);
    const opened = await openMaster({
      socket,
      host: target.tunnel.host,
      extra: ['-L', `127.0.0.1:${target.tunnel.localPort}:${target.tunnel.remote}`],
    }, env);
    if (!opened.ok) return { ok: false, error: `ssh tunnel: ${opened.error}` };
    tunnel = { host: target.tunnel.host, socket };
  }

  let child;
  let pidFile = null;
  try {
    const logName = `kube-${target.name}.log`;
    const logFd = fs.openSync(path.join(sessionDir, logName), 'a', 0o600);
    try {
      child = spawn(kubectlBin(env), proxyArgs(target.kubeconfig, target.proxyPort), {
        stdio: ['ignore', logFd, logFd],
        env,
      });
    } finally {
      fs.closeSync(logFd);
    }
    let exited = false;
    child.on('error', () => { exited = true; });
    child.on('exit', () => { exited = true; });
    if (Number.isInteger(child.pid)) {
      const dir = socketDirOf(env);
      ensureDir(dir);
      pidFile = path.join(dir, `kube-${target.name}.pid`);
      writeFileAtomic(pidFile, `${JSON.stringify({ pid: child.pid, startedAt: processStartTime(child.pid) })}\n`);
    }

    const deadline = Date.now() + 10000;
    let listening = false;
    while (!exited && Date.now() < deadline) {
      if (await portListening(target.proxyPort)) {
        listening = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!listening) {
      await closeCluster({ child, tunnel, pidFile }, env);
      return { ok: false, error: `kubectl proxy did not start; see ${logName}` };
    }

    const state = await probeVersion(target.proxyPort);
    return { ok: true, state, child, tunnel, pidFile };
  } catch (err) {
    await closeCluster({ child, tunnel, pidFile }, env);
    return { ok: false, error: err.message };
  }
}
