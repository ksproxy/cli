import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import {
  adoptOldLogs, appendAudit, formatLogLine, logOptionsFor, MAX_LOG_BYTES, rotateAudit,
} from './audit.js';
import { agentMdText, mcpConfig } from './agent-md.js';
import { InventoryError, loadInventory } from './inventory.js';
import {
  closeCluster, kubeconfigText, openCluster, reapStaleProxies,
} from './kube.js';
import {
  auditLogPath, ensureDir, inventoryPath, logDir as logDirOf, REVIEW_SOCKET_NAME, reviewSocketPath, sessionDir as sessionDirOf, socketDir as socketDirOf,
  socketPath, stateDir as stateDirOf, writeFileAtomic,
} from './paths.js';
import { startReviewServer } from './review.js';
import { checkbox } from './select.js';
import {
  clearSession, liveSession, processStartTime, writeSession,
} from './session.js';
import { closeMaster, openMaster, sshConfigText } from './ssh.js';
import {
  cleanPath, localFolderProblem, looksSecret, sessionProtected,
} from './local.js';
import { targetState } from './tools.js';

const BIN_PATH = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const FOLLOW_INTERVAL_MS = 500;
const RETIRE_MS = 2000;
const DEFAULT_HEALTH_MS = 30000;
const MIN_HEALTH_MS = 200;
const EMPTY_ALLOW = 'allowlist is empty, every command will be refused';

export function bounded(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (onTimeout) onTimeout();
      } catch {
        // best effort
      }
      resolve();
    }, ms);
    const settle = () => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(settle, settle);
  });
}

export function emptyDirectory(dir, keep = []) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (keep.includes(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // try the other entries
    }
  }
}

export async function closeStaleSockets(dir, env) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.pid') || name === REVIEW_SOCKET_NAME) continue;
    await closeMaster({ socket: path.join(dir, name), host: 'stale' }, env);
  }
}

function pickByName(label, names, list) {
  const known = list.map((t) => t.name);
  const unknown = names.find((n) => !known.includes(n));
  if (unknown !== undefined) {
    return { error: `unknown ${label} target "${unknown}"; known ${label} targets: ${known.join(', ') || 'none'}` };
  }
  return { list: list.filter((t) => names.includes(t.name)) };
}

function targetHint(target) {
  const where = { ssh: target.host, kubernetes: target.kubeconfig, local: target.cwd }[target.kind];
  return target.description ? `${where} — ${target.description}` : where;
}

const NOTHING = () => ({ selection: { ssh: [], kubernetes: [], local: [] } });

async function chooseTargets(inventory, options, proc, pick) {
  if (options.all) {
    return { selection: { ssh: inventory.ssh, kubernetes: inventory.kubernetes, local: inventory.local } };
  }

  if (options.ssh || options.kube || options.local) {
    const ssh = pickByName('ssh', options.ssh ?? [], inventory.ssh);
    if (ssh.error) return ssh;
    const kube = pickByName('kube', options.kube ?? [], inventory.kubernetes);
    if (kube.error) return kube;
    const local = pickByName('local', options.local ?? [], inventory.local);
    if (local.error) return local;
    return { selection: { ssh: ssh.list, kubernetes: kube.list, local: local.list } };
  }

  if (!proc.stdin.isTTY) {
    return { error: 'no targets selected: use --ssh, --kube, --local or --all when not running in a terminal' };
  }

  const kinds = [];
  if (inventory.ssh.length > 0) kinds.push({ key: 'ssh', label: 'ssh', hint: `${inventory.ssh.length} server(s)` });
  if (inventory.kubernetes.length > 0) {
    kinds.push({ key: 'kubernetes', label: 'kubernetes', hint: `${inventory.kubernetes.length} cluster(s)` });
  }
  if (inventory.local.length > 0) {
    kinds.push({ key: 'local', label: 'local', hint: `${inventory.local.length} folder(s)` });
  }
  let chosenKinds = kinds;
  if (kinds.length > 1) {
    const picked = await pick({ title: 'Which kinds of proxy?', items: kinds });
    if (picked === null) return NOTHING();
    chosenKinds = picked.map((i) => kinds[i]);
  }

  const selection = NOTHING().selection;
  for (const kind of chosenKinds) {
    const targets = inventory[kind.key];
    const items = targets.map((t) => ({ label: t.name, hint: targetHint(t) }));
    const picked = await pick({ title: `Which ${kind.label} targets?`, items });
    if (picked === null) return NOTHING();
    selection[kind.key] = picked.map((i) => targets[i]);
  }
  return { selection };
}

function folderProblem(cwd, env, protectedList) {
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return `folder not found: ${cwd}`;
  }
  if (!stat.isDirectory()) return `not a directory: ${cwd}`;
  return localFolderProblem(cwd, env, protectedList);
}

const MAX_NAMED = 3;

function looseSecrets(target) {
  let names;
  try {
    names = fs.readdirSync(target.cwd);
  } catch {
    return [];
  }
  const listed = (target.protect ?? []).map((entry) => entry.toLowerCase());
  return names.filter((name) => looksSecret(name) && !listed.includes(name.toLowerCase())).sort();
}

const LOG_KIND = { ssh: 'ssh', kubernetes: 'kube', local: 'loc' };

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function newSource(offset) {
  return { offset, pending: '', decoder: new StringDecoder('utf8') };
}

export function startFollower(auditFile, onEntry, fromOffset, intervalMs = FOLLOW_INTERVAL_MS, maxBytes = Infinity) {
  let current = newSource(fromOffset);
  let inode = null;
  try {
    inode = fs.statSync(auditFile).ino;
  } catch {
    current.offset = 0;
  }

  const feed = (source, fd, size) => {
    if (size <= source.offset) return;
    const buffer = Buffer.alloc(size - source.offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, source.offset);
    source.offset += read;
    source.pending += source.decoder.write(buffer.subarray(0, read));
    const lines = source.pending.split('\n');
    source.pending = lines.pop();
    for (const line of lines) {
      if (line.trim() === '') continue;
      try {
        onEntry(JSON.parse(line));
      } catch {
        // not an audit entry
      }
    }
  };

  // A writer that opened the file just before the rename can still write into the renamed file.
  // That file stays open for a while and is read again on each tick before it is closed.
  let retired = [];
  const drainRetired = (force) => {
    const now = Date.now();
    const items = retired;
    retired = [];
    for (const item of items) {
      const last = force || now >= item.until;
      if (!last) retired.push(item);
      try {
        feed(item.source, item.fd, fs.fstatSync(item.fd).size);
      } catch {
        // best effort
      }
      if (last) fs.closeSync(item.fd);
    }
  };

  const poll = (limit) => {
    drainRetired(false);
    let size;
    let ino;
    try {
      const st = fs.statSync(auditFile);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
      ino = st.ino;
    } catch {
      // Gone, or not a file: whatever appears here next is read from its start.
      // Inode numbers are reused on Linux, so the inode alone cannot tell.
      current = newSource(0);
      inode = null;
      return;
    }
    if (size < current.offset || (inode !== null && ino !== inode)) current = newSource(0);
    inode = ino;
    if (size === current.offset && size <= limit) return;
    const fd = fs.openSync(auditFile, 'r');
    let handedOver = false;
    try {
      feed(current, fd, size);
      if (size > limit) {
        rotateAudit(auditFile, limit, undefined, () => {
          try {
            feed(current, fd, fs.fstatSync(fd).size);
            retired.push({ fd, source: current, until: Date.now() + RETIRE_MS });
            handedOver = true;
          } finally {
            current = newSource(0);
            inode = null;
          }
        });
      }
    } finally {
      if (!handedOver) fs.closeSync(fd);
    }
  };

  const timer = setInterval(() => {
    try {
      poll(maxBytes);
    } catch {
      // a failed read is retried on the next tick
    }
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      try {
        poll(Infinity);
      } catch {
        // best effort
      }
      drainRetired(true);
    },
  };
}

function withoutKeyVariables(env, reviewers) {
  const names = Object.values(reviewers).map((r) => r.keyEnv).filter((name) => name !== null);
  if (names.length === 0) return env;
  const out = { ...env };
  for (const name of names) delete out[name];
  return out;
}

export async function start(options, startEnv = process.env, host = {}) {
  let env = startEnv;
  const { process: proc = process } = host;
  const openReview = host.startReviewServer ?? startReviewServer;
  const pick = host.checkbox ?? ((request) => checkbox({
    ...request, input: proc.stdin, output: proc.stderr, signals: proc,
  }));
  const stateOf = host.targetState ?? targetState;
  const follow = host.startFollower ?? startFollower;
  const limits = {
    healthWaitMs: 6000, sshCloseMs: 15000, kubeCloseMs: 20000, logBytes: MAX_LOG_BYTES, followMs: FOLLOW_INTERVAL_MS, ...host.limits,
  };
  const verbose = options?.verbose === true;
  const alive = { stdout: true, stderr: true };
  let stopping = false;
  let closeReason = null;
  let wake;
  const stopRequested = new Promise((resolve) => { wake = resolve; });
  const requestStop = (reason) => {
    if (reason !== undefined && closeReason === null) closeReason = reason;
    if (stopping) return;
    stopping = true;
    wake();
  };
  const write = (name, text) => {
    if (!alive[name]) return;
    try {
      proc[name].write(text);
    } catch {
      alive[name] = false;
      requestStop('output closed');
    }
  };
  const say = (text) => write('stderr', `${text}\n`);
  const out = (text) => write('stdout', text);

  const onSigint = () => requestStop('Ctrl-C');
  const onSigterm = () => requestStop('terminated');
  const onSighup = () => requestStop('terminal closed');
  const onStdoutError = () => {
    alive.stdout = false;
    requestStop('output closed');
  };
  const onStderrError = () => {
    alive.stderr = false;
    requestStop('output closed');
  };

  const opened = [];
  let follower = null;
  let reviewStart = null;
  let pending = null;
  let cleanupPromise = null;
  let exitCode = 0;
  let owns = false;
  let auditFile = null;
  let healthTimer = null;
  let healthRun = null;
  let closingShown = false;
  let closedShown = false;
  const counts = { ok: 0, failed: 0, denied: 0 };

  const record = (entry) => {
    const full = { ts: new Date().toISOString(), ...entry };
    if (owns && auditFile !== null) {
      try {
        appendAudit(auditFile, full);
      } catch {
        // the log is best effort
      }
    }
    return full;
  };
  const show = (full, stream = 'stderr') => {
    const line = formatLogLine(full, { ...logOptionsFor(proc[stream], env), verbose });
    if (line !== null) write(stream, `${line}\n`);
  };
  const lifecycle = (entry, stream = 'stderr') => show(record(entry), stream);

  const announceClosing = () => {
    if (closingShown) return;
    closingShown = true;
    lifecycle({ event: 'session_closing', message: closeReason });
  };
  const announceClosed = () => {
    if (!closingShown || closedShown) return;
    closedShown = true;
    const total = counts.ok + counts.failed + counts.denied;
    lifecycle({
      event: 'session_end',
      ok: counts.ok,
      failed: counts.failed,
      denied: counts.denied,
      message: `${total} calls: ${counts.ok} ok, ${counts.failed} failed, ${counts.denied} denied`,
    });
  };

  const onEntry = (entry) => {
    if (entry.event === 'list') {
      show(entry, 'stdout');
      return;
    }
    if (entry.event !== undefined && entry.event !== 'call') return;
    if (entry.decision === 'refused') counts.denied += 1;
    else if ((entry.spawnError ?? null) !== null || entry.timedOut === true || entry.exitCode !== 0) counts.failed += 1;
    else counts.ok += 1;
    show(entry, 'stdout');
  };

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    requestStop();
    cleanupPromise = (async () => {
      clearInterval(healthTimer);
      healthTimer = null;
      const running = healthRun;
      if (running) await bounded(running, limits.healthWaitMs);
      if (follower) {
        try {
          follower.stop();
        } catch {
          // best effort
        }
      }
      if (reviewStart) await bounded(reviewStart.then((server) => server.close()), 2000);
      await Promise.all(opened.filter((o) => o.kind !== 'local').map((o) => (o.kind === 'ssh'
        ? bounded(closeMaster({ socket: o.socket, host: o.target.host }, env), limits.sshCloseMs)
        : bounded(closeCluster(o.handle, env), limits.kubeCloseMs, () => o.handle.child?.kill('SIGKILL')))));
      if (!owns) return;
      try {
        clearSession(sessionDirOf(env));
      } catch {
        // best effort
      }
      emptyDirectory(socketDirOf(env));
    })();
    return cleanupPromise;
  };

  let fatalSeen = false;
  let fatalFlow = null;
  let signalFatal;
  const fatalArrived = new Promise((resolve) => { signalFatal = resolve; });
  const onFatal = (err) => {
    if (fatalSeen) return;
    fatalSeen = true;
    exitCode = 1;
    if (!closingShown) closeReason = `error: ${err?.message ?? err}`;
    requestStop();
    announceClosing();
    fatalFlow = (async () => {
      await cleanup();
      announceClosed();
      if (pending) await Promise.allSettled([pending]);
    })();
    signalFatal();
  };

  proc.on('SIGINT', onSigint);
  proc.on('SIGTERM', onSigterm);
  proc.on('SIGHUP', onSighup);
  proc.on('uncaughtException', onFatal);
  proc.on('unhandledRejection', onFatal);
  proc.stdout.on('error', onStdoutError);
  proc.stderr.on('error', onStderrError);

  const downMessage = (item, state) => {
    if (item.kind === 'ssh') return 'connection lost';
    if (item.kind === 'loc') return 'folder is gone';
    if (state === 'auth') return 'token rejected by the cluster';
    if (state === 'fail') return `cluster did not answer, see kube-${item.name}.log`;
    return 'proxy is not answering';
  };

  const startHealth = (sessionTargets) => {
    const parsed = Number.parseInt(env.KSPROXY_HEALTH_MS ?? '', 10);
    const every = Number.isFinite(parsed) ? Math.max(MIN_HEALTH_MS, parsed) : DEFAULT_HEALTH_MS;
    const items = opened.map((o, i) => ({
      kind: LOG_KIND[o.kind],
      name: o.target.name,
      target: sessionTargets[i],
      up: sessionTargets[i].state === 'up',
    }));
    const checkOnce = async () => {
      for (const item of items) {
        if (stopping) return;
        let state;
        try {
          state = await stateOf(item.target, env);
        } catch {
          continue;
        }
        if (stopping) return;
        const up = state === 'up';
        if (up === item.up) continue;
        item.up = up;
        if (up) {
          lifecycle({
            event: 'target_recovered',
            kind: item.kind,
            target: item.name,
            message: item.kind === 'loc' ? 'folder is back' : 'connection is back',
          });
        } else {
          lifecycle({
            event: 'target_down', kind: item.kind, target: item.name, message: downMessage(item, state),
          });
        }
      }
    };
    healthTimer = setInterval(() => {
      if (healthRun !== null || stopping) return;
      const current = checkOnce().catch(() => {}).finally(() => {
        if (healthRun === current) healthRun = null;
      });
      healthRun = current;
    }, every);
    healthTimer.unref();
  };

  const openGuarded = (openFn, closeFn) => {
    const p = (async () => {
      const r = await openFn();
      if (r.ok && stopping) {
        await closeFn(r);
        return { ok: false, late: true };
      }
      return r;
    })();
    pending = p;
    const clear = () => {
      if (pending === p) pending = null;
    };
    p.then(clear, clear);
    return p;
  };

  const run = async () => {
    let inventory;
    try {
      inventory = loadInventory(inventoryPath(env));
    } catch (err) {
      if (err instanceof InventoryError) {
        say(err.message);
        return 1;
      }
      throw err;
    }
    const reviewKeys = new Map();
    for (const reviewer of Object.values(inventory.reviewers)) {
      if (reviewer.keyEnv !== null) reviewKeys.set(reviewer.name, env[reviewer.keyEnv]);
    }
    env = withoutKeyVariables(env, inventory.reviewers);

    const sessionDir = sessionDirOf(env);
    const socketDir = socketDirOf(env);
    const existing = liveSession(sessionDir);
    if (existing) {
      say(`a session is already running (pid ${existing.pid}); stop it with Ctrl-C in its terminal`);
      return 1;
    }
    owns = true;
    clearSession(sessionDir);
    const reaped = await reapStaleProxies(socketDir);
    if (reaped > 0) say(`closed ${reaped} proxy process(es) left by an earlier run`);
    await closeStaleSockets(socketDir, env);
    emptyDirectory(socketDir);

    const chosen = await chooseTargets(inventory, options, proc, pick);
    if (chosen.error) {
      say(chosen.error);
      return 1;
    }
    const { ssh: sshTargets, kubernetes: kubeTargets, local: localTargets } = chosen.selection;
    const kubeconfigPaths = inventory.kubernetes.map((k) => k.kubeconfig);
    if (sshTargets.length + kubeTargets.length + localTargets.length === 0) {
      say('nothing selected');
      return 1;
    }

    ensureDir(stateDirOf(env));
    ensureDir(socketDir);
    ensureDir(sessionDir);
    ensureDir(logDirOf(env));
    auditFile = auditLogPath(env);
    adoptOldLogs(sessionDir, auditFile);
    emptyDirectory(sessionDir);
    rotateAudit(auditFile, limits.logBytes);

    const sockets = new Map();
    try {
      for (const t of sshTargets) sockets.set(`ssh:${t.name}`, socketPath('ssh', t.name, env));
      for (const t of kubeTargets) {
        if (t.tunnel) socketPath('tun', t.name, env);
      }
      if ([...sshTargets, ...kubeTargets, ...localTargets].some((t) => t.review)) reviewSocketPath(env);
    } catch (err) {
      say(err.message);
      return 1;
    }

    try {
      for (const t of sshTargets) {
        if (stopping) break;
        if (Array.isArray(t.allow) && t.allow.length === 0) {
          lifecycle({
            event: 'target_warn', kind: 'ssh', target: t.name, message: EMPTY_ALLOW,
          });
        }
        lifecycle({
          event: 'target_opening', kind: 'ssh', target: t.name, message: t.jumps ? `${t.host}, then ${t.jumps.length} jump${t.jumps.length === 1 ? '' : 's'}` : t.host,
        });
        const socket = sockets.get(`ssh:${t.name}`);
        const r = await openGuarded(
          () => openMaster({ socket, host: t.host }, env),
          () => bounded(closeMaster({ socket, host: t.host }, env), limits.sshCloseMs),
        );
        if (r.late) break;
        if (r.ok) {
          lifecycle({ event: 'target_up', kind: 'ssh', target: t.name });
          opened.push({ kind: 'ssh', target: t, socket });
        } else {
          lifecycle({
            event: 'target_skipped', kind: 'ssh', target: t.name, message: r.error,
          });
        }
      }
      for (const t of kubeTargets) {
        if (stopping) break;
        if (Array.isArray(t.allow) && t.allow.length === 0) {
          lifecycle({
            event: 'target_warn', kind: 'kube', target: t.name, message: EMPTY_ALLOW,
          });
        }
        lifecycle({
          event: 'target_opening', kind: 'kube', target: t.name, message: `port ${t.proxyPort}`,
        });
        const r = await openGuarded(
          () => openCluster(t, { sessionDir }, env),
          (handle) => bounded(closeCluster(handle, env), limits.kubeCloseMs, () => handle.child?.kill('SIGKILL')),
        );
        if (r.late) break;
        if (r.ok) {
          opened.push({ kind: 'kubernetes', target: t, handle: r });
          if (r.state === 'up') {
            lifecycle({ event: 'target_up', kind: 'kube', target: t.name });
          } else {
            lifecycle({
              event: 'target_warn',
              kind: 'kube',
              target: t.name,
              message: downMessage({ kind: 'kube', name: t.name }, r.state),
            });
          }
        } else {
          lifecycle({
            event: 'target_skipped', kind: 'kube', target: t.name, message: r.error,
          });
        }
      }

      for (const t of localTargets) {
        if (stopping) break;
        if (t.allow.length === 0) {
          lifecycle({
            event: 'target_warn', kind: 'loc', target: t.name, message: EMPTY_ALLOW,
          });
        }
        lifecycle({
          event: 'target_opening', kind: 'loc', target: t.name, message: t.cwd,
        });
        const problem = folderProblem(t.cwd, env, kubeconfigPaths);
        if (problem === null) {
          lifecycle({ event: 'target_up', kind: 'loc', target: t.name });
          opened.push({ kind: 'local', target: t });
          const loose = looseSecrets(t);
          if (loose.length > 0) {
            const more = loose.length > MAX_NAMED ? ` and ${loose.length - MAX_NAMED} more` : '';
            lifecycle({
              event: 'target_warn',
              kind: 'loc',
              target: t.name,
              message: `holds ${loose.slice(0, MAX_NAMED).join(', ')}${more}: list them in "protect" to also refuse commands given the whole folder`,
            });
          }
        } else {
          lifecycle({
            event: 'target_skipped', kind: 'loc', target: t.name, message: problem,
          });
        }
      }

      if (stopping) {
        announceClosing();
        await cleanup();
        announceClosed();
        return exitCode;
      }
      if (opened.length === 0) {
        say('nothing could be opened');
        return 1;
      }

      const reviewed = new Map();
      for (const o of opened) {
        const { review } = o.target;
        if (!review) continue;
        const reviewer = inventory.reviewers[review.reviewer];
        const key = reviewer.keyEnv === null ? null : reviewKeys.get(reviewer.name);
        if (reviewer.keyEnv !== null && !key) {
          lifecycle({
            event: 'target_warn', kind: LOG_KIND[o.kind], target: o.target.name, message: `review is off: ${reviewer.keyEnv} is not set`,
          });
          continue;
        }
        reviewed.set(`${o.kind}:${o.target.name}`, {
          kind: o.kind, name: o.target.name, reviewer, key, review,
        });
      }
      if (reviewed.size > 0) {
        reviewStart = Promise.resolve().then(() => openReview({ socket: reviewSocketPath(env), targets: reviewed }));
        const started = await reviewStart.then(() => true, () => false);
        if (stopping) {
          announceClosing();
          await cleanup();
          announceClosed();
          return exitCode;
        }
        if (!started) {
          for (const { kind, name } of reviewed.values()) {
            lifecycle({
              event: 'target_warn', kind: LOG_KIND[kind], target: name, message: 'review is off: could not start the review service',
            });
          }
          reviewed.clear();
        }
      }
      for (const { kind, name, reviewer, review } of reviewed.values()) {
        lifecycle({
          event: 'target_review', kind: LOG_KIND[kind], target: name, message: `reviewer ${reviewer.name}, accepts ${review.accept.join(' and ')}`,
        });
      }
      const isReviewed = (o) => reviewed.has(`${o.kind}:${o.target.name}`);
      const reviewFlag = (o) => (isReviewed(o) ? { review: true } : {});

      const recordedProtected = sessionProtected(kubeconfigPaths, env);
      const sessionTargets = opened.map((o) => {
        if (o.kind === 'ssh') {
          return {
            kind: 'ssh',
            name: o.target.name,
            description: o.target.description,
            allow: o.target.allow,
            host: o.target.host,
            ...(o.target.jumps ? { jumps: o.target.jumps } : {}),
            socket: o.socket,
            state: 'up',
            ...reviewFlag(o),
          };
        }
        if (o.kind === 'local') {
          return {
            kind: 'local',
            name: o.target.name,
            description: o.target.description,
            allow: o.target.allow,
            cwd: o.target.cwd,
            path: cleanPath(env.PATH, localTargets.map((t) => t.cwd)),
            protected: recordedProtected,
            state: 'up',
            ...reviewFlag(o),
            ...(o.target.protect ? { protect: o.target.protect } : {}),
            ...(isReviewed(o) ? { programs: o.target.review.programs } : {}),
          };
        }
        return {
          kind: 'kubernetes',
          name: o.target.name,
          description: o.target.description,
          allow: o.target.allow,
          proxyPort: o.target.proxyPort,
          manifestRoots: o.target.manifestRoots,
          tunnel: o.handle.tunnel,
          state: o.handle.state,
          ...reviewFlag(o),
        };
      });
      const session = {
        version: 1,
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        targets: sessionTargets,
      };
      const ownStart = processStartTime(proc.pid);
      if (ownStart !== null) session.processStartedAt = ownStart;

      const followFrom = fileSize(auditFile);
      const ready = record({
        event: 'session_start',
        pid: proc.pid,
        targets: sessionTargets.map((t) => ({
          kind: LOG_KIND[t.kind], name: t.name, state: t.state,
        })),
        message: `${sessionTargets.length} targets, pid ${proc.pid}`,
      });

      const config = mcpConfig(proc.execPath, BIN_PATH);
      const configText = `${JSON.stringify(config, null, 2)}\n`;
      writeFileAtomic(path.join(sessionDir, 'ssh_config'), sshConfigText(
        opened.filter((o) => o.kind === 'ssh').map((o) => ({ name: o.target.name, socket: o.socket })),
      ));
      writeFileAtomic(path.join(sessionDir, 'kubeconfig'), kubeconfigText(
        opened.filter((o) => o.kind === 'kubernetes').map((o) => ({ name: o.target.name, proxyPort: o.target.proxyPort })),
      ));
      writeFileAtomic(path.join(sessionDir, 'AGENT.md'), agentMdText(session));
      writeFileAtomic(path.join(sessionDir, 'mcp.json'), configText);
      writeSession(sessionDir, session);

      out([
        `Session folder: ${sessionDir}`,
        'MCP config (add once to your agent):',
        configText.trimEnd(),
        `Claude Code: claude mcp add ksproxy -- ${proc.execPath} ${BIN_PATH} mcp`,
        '',
        'Leave this running. Ctrl-C closes every connection.',
        '',
      ].join('\n'));

      show(ready, 'stdout');
      follower = follow(auditFile, onEntry, followFrom, limits.followMs, limits.logBytes);
      startHealth(sessionTargets);
      await stopRequested;
      announceClosing();
      await cleanup();
      announceClosed();
      return exitCode;
    } catch (err) {
      exitCode = 1;
      if (!closingShown) closeReason = `error: ${err?.message ?? err}`;
      announceClosing();
      await cleanup();
      announceClosed();
      return 1;
    }
  };

  const mainRun = run().finally(() => cleanup());
  mainRun.catch(() => {});
  try {
    return await Promise.race([
      mainRun,
      fatalArrived.then(async () => {
        await fatalFlow;
        return 1;
      }),
    ]);
  } finally {
    await cleanup();
    proc.off('SIGINT', onSigint);
    proc.off('SIGTERM', onSigterm);
    proc.off('SIGHUP', onSighup);
    proc.off('uncaughtException', onFatal);
    proc.off('unhandledRejection', onFatal);
    proc.stdout.off('error', onStdoutError);
    proc.stderr.off('error', onStderrError);
  }
}
