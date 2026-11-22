import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import {
  adoptOldLogs, appendAudit, formatLogLine, logOptionsFor, MAX_LOG_BYTES, rotateAudit,
} from './audit.js';
import { agentMdText, mcpConfig } from './agent-md.js';
import { allowWarnings } from './allowlist.js';
import { InventoryError, loadInventory } from './inventory.js';
import {
  auditLogPath, callSocketPath, ensureDir, initCommand, inventoryPath, logDir as logDirOf, projectOf, reviewSocketPath,
  rootStateDir, sessionDir as sessionDirOf, socketDir as socketDirOf, stateDir as stateDirOf, writeFileAtomic,
} from './paths.js';
import { startCallServer } from './broker.js';
import { KINDS, kindByKey } from './kinds/index.js';
import {
  everySecretFile, otherInventories, portProblem, usedPorts,
} from './projects.js';
import { startReviewServer } from './review.js';
import { checkbox } from './select.js';
import {
  clearSession, liveSession, processStartTime, writeSession,
} from './session.js';
import { answerCall, targetState } from './tools.js';

const BIN_PATH = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const FOLLOW_INTERVAL_MS = 500;
const RETIRE_MS = 2000;
const DEFAULT_HEALTH_MS = 30000;
const MIN_HEALTH_MS = 200;
const EMPTY_ALLOW = 'allowlist is empty, every command will be refused';
const SHORT_SECRET = 8;
const SHORT_SECRET_WHY = `holds a secret shorter than ${SHORT_SECRET} characters: hiding it in output can give it away`;
const SHORT_FORM_WHY = `holds a secret with a part shorter than ${SHORT_SECRET} characters: hiding it in output can give it away`;

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

function pickByName(label, names, list) {
  const known = list.map((t) => t.name);
  const unknown = names.find((n) => !known.includes(n));
  if (unknown !== undefined) {
    return { error: `unknown ${label} target "${unknown}"; known ${label} targets: ${known.join(', ') || 'none'}` };
  }
  return { list: list.filter((t) => names.includes(t.name)) };
}

// The selection has one list per kind, under the kind's key, in list order.
const NOTHING = () => ({ selection: Object.fromEntries(KINDS.map((kind) => [kind.key, []])) });

async function chooseTargets(inventory, options, proc, pick) {
  if (options.all) {
    return { selection: Object.fromEntries(KINDS.map((kind) => [kind.key, inventory[kind.key]])) };
  }

  if (KINDS.some((kind) => options[kind.flag])) {
    const selection = {};
    for (const kind of KINDS) {
      const named = pickByName(kind.flag, options[kind.flag] ?? [], inventory[kind.key]);
      if (named.error) return named;
      selection[kind.key] = named.list;
    }
    return { selection };
  }

  if (!proc.stdin.isTTY) {
    // The flag of every kind that is not brokered, and of each brokered kind the inventory holds a target of.
    const flags = KINDS.filter((kind) => kind.brokered !== true || inventory[kind.key].length > 0).map((kind) => `--${kind.flag}`);
    return { error: `no targets selected: use ${flags.join(', ')} or --all when not running in a terminal` };
  }

  const kinds = KINDS.filter((kind) => inventory[kind.key].length > 0);
  const items = kinds.map((kind) => ({ key: kind.key, label: kind.key, hint: `${inventory[kind.key].length} ${kind.countNoun}` }));
  let chosenKinds = kinds;
  if (kinds.length > 1) {
    const picked = await pick({ title: 'Which kinds of proxy?', items });
    if (picked === null) return NOTHING();
    chosenKinds = picked.map((i) => kinds[i]);
  }

  const selection = NOTHING().selection;
  for (const kind of chosenKinds) {
    const targets = inventory[kind.key];
    const choices = targets.map((t) => ({ label: t.name, hint: kind.hint(t) }));
    const picked = await pick({ title: `Which ${kind.key} targets?`, items: choices });
    if (picked === null) return NOTHING();
    selection[kind.key] = picked.map((i) => targets[i]);
  }
  return { selection };
}

const logKind = (key) => kindByKey(key).label;

// A target as its kind recorded it, with the maxOutputKiB of its inventory entry when it has one: the same for every
// kind, so that no kind's record has to copy it.
function withOutputLimit(recorded, target) {
  return target.maxOutputKiB === undefined ? recorded : { ...recorded, maxOutputKiB: target.maxOutputKiB };
}

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

// Every variable that holds a credential: the key of each reviewer that names one, then the variables that a kind
// with secrets names for each of its inventory entries, selected or not.
function credentialVariables(inventory) {
  const names = Object.values(inventory.reviewers).map((r) => r.keyEnv).filter((name) => name !== null);
  for (const kind of KINDS) {
    if (kind.secrets === undefined) continue;
    for (const t of inventory[kind.key]) names.push(...kind.secrets(t).env);
  }
  return names;
}

function withoutVariables(env, names) {
  if (names.length === 0) return env;
  const out = { ...env };
  for (const name of names) delete out[name];
  return out;
}

// The secrets of one target, from the values held at start and the files it names: { secrets, short, shortForms } or
// { error }. short names, for each value shorter than SHORT_SECRET characters, where it came from: the variable or the
// file. A variable the kind names in users holds only a user name and is never named. shortForms names the other
// sources of a form from hiddenForms shorter than SHORT_SECRET characters (see shortFormSources).
export function readSecrets(kind, target, held) {
  if (kind.secrets === undefined) return { secrets: {}, short: [], shortForms: [] };
  const { env: names, files, users = [] } = kind.secrets(target);
  const secrets = {};
  const short = [];
  for (const name of names) {
    const value = held.get(name);
    if (!value) return { error: `${name} is not set` };
    secrets[name] = value;
    if (isShort(value) && !users.includes(name)) short.push(name);
  }
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { error: `${file} cannot be read` };
    }
    text = text.replace(/\r?\n$/, '');
    if (text === '') return { error: `${file} is empty` };
    secrets[file] = text;
    if (isShort(text)) short.push(file);
  }
  return { secrets, short, shortForms: shortFormSources(kind, target, secrets, [...users, ...short]) };
}

const STAND_IN = '\u0001'.repeat(SHORT_SECRET);

function isShort(value) {
  return [...value].length < SHORT_SECRET;
}

// The sources whose hidden forms hold one shorter than SHORT_SECRET characters, left out the sources in skip. A form
// belongs to a source when it is gone once that source's value is replaced by STAND_IN, a value of control characters
// with no structure, so a kind finds no part in it. A kind without hiddenForms, or whose hiddenForms throws, gives none.
function shortFormSources(kind, target, secrets, skip) {
  if (kind.hiddenForms === undefined) return [];
  try {
    const short = kind.hiddenForms(target, secrets).filter((form) => form !== '' && isShort(form));
    if (short.length === 0) return [];
    return Object.keys(secrets).filter((source) => {
      if (skip.includes(source)) return false;
      const other = kind.hiddenForms(target, { ...secrets, [source]: STAND_IN });
      return short.some((form) => !other.includes(form));
    });
  } catch {
    return [];
  }
}

// The state folder of this run, mode 0700. For a project it is root/p/NAME, and the root and root/p are made private
// too, whoever made them first: ensureDir sets the mode of the last folder only.
function ensureStateDir(env, project) {
  if (project !== null) {
    ensureDir(rootStateDir(env));
    ensureDir(path.dirname(stateDirOf(env)));
  }
  ensureDir(stateDirOf(env));
}

export async function start(options, startEnv = process.env, host = {}) {
  let env = startEnv;
  const { process: proc = process } = host;
  const openReview = host.startReviewServer ?? startReviewServer;
  const openCalls = host.startCallServer ?? startCallServer;
  const pick = host.checkbox ?? ((request) => checkbox({
    ...request, input: proc.stdin, output: proc.stderr, signals: proc,
  }));
  const stateOf = host.targetState ?? targetState;
  const follow = host.startFollower ?? startFollower;
  const limits = {
    healthWaitMs: 6000, logBytes: MAX_LOG_BYTES, followMs: FOLLOW_INTERVAL_MS, ...host.limits,
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
  let callStart = null;
  // The secrets of each opened target, by kind and name; they live here and nowhere else.
  const secretsOf = new Map();
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

  // One opened target of a kind that has close, bounded by the kind's closeMs unless host.limits names the kind's closeLimit.
  const closeOne = (kind, o) => bounded(
    kind.close(o, { env }),
    limits[kind.closeLimit] ?? kind.closeMs,
    kind.onCloseTimeout === undefined ? undefined : () => kind.onCloseTimeout(o),
  );

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    requestStop();
    cleanupPromise = (async () => {
      clearInterval(healthTimer);
      healthTimer = null;
      const running = healthRun;
      if (running) await bounded(running, limits.healthWaitMs);
      if (callStart) await bounded(callStart.then((server) => server.close()), 2000);
      if (follower) {
        try {
          follower.stop();
        } catch {
          // best effort
        }
      }
      if (reviewStart) await bounded(reviewStart.then((server) => server.close()), 2000);
      await Promise.all(opened.filter((o) => kindByKey(o.kind).close !== undefined)
        .map((o) => closeOne(kindByKey(o.kind), o)));
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

  const startHealth = (sessionTargets) => {
    const parsed = Number.parseInt(env.KSPROXY_HEALTH_MS ?? '', 10);
    const every = Number.isFinite(parsed) ? Math.max(MIN_HEALTH_MS, parsed) : DEFAULT_HEALTH_MS;
    const items = opened.map((o, i) => ({
      of: kindByKey(o.kind),
      kind: logKind(o.kind),
      name: o.target.name,
      target: sessionTargets[i],
      secrets: secretsOf.get(`${o.kind}:${o.target.name}`),
      up: sessionTargets[i].state === 'up',
    }));
    // A kind with probe is asked with the target's secrets; every other target goes through targetState.
    const stateNow = (item) => (item.of.probe === undefined
      ? stateOf(item.target, env)
      : item.of.probe(item.target, { env, secrets: item.secrets }));
    const checkOnce = async () => {
      for (const item of items) {
        if (stopping) return;
        let state;
        try {
          state = await stateNow(item);
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
            message: item.of.backMessage,
          });
        } else {
          lifecycle({
            event: 'target_down', kind: item.kind, target: item.name, message: item.of.downMessage(item.target, state),
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
      if (closeFn !== undefined && r.ok && stopping) {
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
    // The project of this run, or null. A value that breaks the rule throws here, before any file is read or written:
    // the run rejects and start rejects with it.
    const project = projectOf(env);
    let inventory;
    try {
      inventory = loadInventory(inventoryPath(env), initCommand(env));
    } catch (err) {
      if (err instanceof InventoryError) {
        say(err.message);
        return 1;
      }
      throw err;
    }
    // The credentials are read once, here, and the run goes on with an environment that no longer holds them.
    const credentials = credentialVariables(inventory);
    const held = new Map(credentials.map((name) => [name, env[name]]));
    const reviewKeys = new Map();
    for (const reviewer of Object.values(inventory.reviewers)) {
      if (reviewer.keyEnv !== null) reviewKeys.set(reviewer.name, held.get(reviewer.keyEnv));
    }
    env = withoutVariables(env, credentials);

    const sessionDir = sessionDirOf(env);
    const socketDir = socketDirOf(env);
    const existing = liveSession(sessionDir);
    if (existing) {
      say(`a session is already running (pid ${existing.pid}); stop it with Ctrl-C in its terminal`);
      return 1;
    }
    owns = true;
    clearSession(sessionDir);
    // What a killed run left is cleaned in reverse list order: the cluster proxies are stopped before the sockets are closed.
    for (const kind of [...KINDS].reverse()) {
      if (kind.reapStale === undefined) continue;
      for (const line of await kind.reapStale({ socketDir, env })) say(line);
    }
    emptyDirectory(socketDir);

    const chosen = await chooseTargets(inventory, options, proc, pick);
    if (chosen.error) {
      say(chosen.error);
      return 1;
    }
    const { selection } = chosen;
    // Every other inventory file is read once, before any target opens: for the files that hold credentials in each of
    // them, and with every other live session for the ports.
    const inventories = otherInventories(env);
    const { files: secretFiles, problem: secretFilesProblem } = everySecretFile(inventory, inventories);
    const ports = usedPorts(env, inventories);
    if (KINDS.every((kind) => selection[kind.key].length === 0)) {
      say('nothing selected');
      return 1;
    }

    ensureStateDir(env, project);
    ensureDir(socketDir);
    ensureDir(sessionDir);
    ensureDir(logDirOf(env));
    auditFile = auditLogPath(env);
    adoptOldLogs(sessionDir, auditFile);
    emptyDirectory(sessionDir);
    rotateAudit(auditFile, limits.logBytes);

    // Socket paths are checked kind by kind in list order, then the review socket; the first error stops.
    const prepared = new Map();
    try {
      for (const kind of KINDS) {
        prepared.set(kind.key, kind.prepare === undefined ? new Map() : kind.prepare(selection[kind.key], { env }));
      }
      if (KINDS.some((kind) => selection[kind.key].some((t) => t.review))) reviewSocketPath(env);
      if (KINDS.some((kind) => kind.brokered === true && selection[kind.key].length > 0)) callSocketPath(env);
    } catch (err) {
      say(err.message);
      return 1;
    }

    try {
      for (const kind of KINDS) {
        for (const t of selection[kind.key]) {
          if (stopping) break;
          if (Array.isArray(t.allow) && t.allow.length === 0) {
            lifecycle({
              event: 'target_warn', kind: kind.label, target: t.name, message: EMPTY_ALLOW,
            });
          }
          for (const warning of kind.ruleWarnings === undefined ? allowWarnings(t.allow) : kind.ruleWarnings(t)) {
            lifecycle({
              event: 'target_warn', kind: kind.label, target: t.name, message: warning,
            });
          }
          lifecycle({
            event: 'target_opening', kind: kind.label, target: t.name, message: kind.openingMessage(t),
          });
          const blocked = portProblem(kind, t, ports);
          if (blocked !== null) {
            lifecycle({
              event: 'target_skipped', kind: kind.label, target: t.name, message: blocked,
            });
            continue;
          }
          const secrets = readSecrets(kind, t, held);
          if (secrets.error !== undefined) {
            lifecycle({
              event: 'target_skipped', kind: kind.label, target: t.name, message: secrets.error,
            });
            continue;
          }
          const ctx = {
            env, sessionDir, secretFiles, secretFilesProblem, prepared: prepared.get(kind.key).get(t.name), secrets: secrets.secrets,
          };
          // The result of open is always awaited. A kind with close is closed again when a stop arrived meanwhile.
          const r = await openGuarded(
            () => kind.open(t, ctx),
            kind.close === undefined ? undefined : (result) => closeOne(kind, { kind: kind.key, target: t, ...result.extras }),
          );
          if (r.late) break;
          if (r.ok) {
            opened.push({ kind: kind.key, target: t, ...r.extras });
            secretsOf.set(`${kind.key}:${t.name}`, secrets.secrets);
            if (r.warn === undefined) {
              lifecycle({ event: 'target_up', kind: kind.label, target: t.name });
            } else {
              lifecycle({
                event: 'target_warn', kind: kind.label, target: t.name, message: r.warn,
              });
            }
            for (const note of r.notes ?? []) {
              lifecycle({
                event: 'target_warn', kind: kind.label, target: t.name, message: note,
              });
            }
            for (const source of secrets.short) {
              lifecycle({
                event: 'target_warn', kind: kind.label, target: t.name, message: `${source} ${SHORT_SECRET_WHY}`,
              });
            }
            for (const source of secrets.shortForms) {
              lifecycle({
                event: 'target_warn', kind: kind.label, target: t.name, message: `${source} ${SHORT_FORM_WHY}`,
              });
            }
          } else {
            lifecycle({
              event: 'target_skipped', kind: kind.label, target: t.name, message: r.error,
            });
          }
        }
      }
      // Only the secrets of the opened targets are kept.
      held.clear();

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
            event: 'target_warn', kind: logKind(o.kind), target: o.target.name, message: `review is off: ${reviewer.keyEnv} is not set`,
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
              event: 'target_warn', kind: logKind(kind), target: name, message: 'review is off: could not start the review service',
            });
          }
          reviewed.clear();
        }
      }
      for (const { kind, name, reviewer, review } of reviewed.values()) {
        lifecycle({
          event: 'target_review', kind: logKind(kind), target: name, message: `reviewer ${reviewer.name}, accepts ${review.accept.join(' and ')}`,
        });
      }
      const sessionTargets = opened.map((o) => withOutputLimit(kindByKey(o.kind).record(o, {
        env, selected: selection[o.kind], secretFiles, reviewed: reviewed.has(`${o.kind}:${o.target.name}`),
      }), o.target));

      // The brokered targets as this run opened and recorded them: the only ones the call service acts on.
      const calls = new Map();
      opened.forEach((o, i) => {
        if (kindByKey(o.kind).brokered !== true) return;
        const key = `${o.kind}:${o.target.name}`;
        calls.set(key, { target: sessionTargets[i], secrets: secretsOf.get(key) });
      });
      if (calls.size > 0) {
        const context = {
          calls,
          session: { targets: sessionTargets },
          env,
          review: (subject) => reviewStart.then((server) => server.ask(subject)),
          stderr: { write: (text) => write('stderr', text) },
        };
        const handle = (request, signal) => answerCall(request, { ...context, signal });
        callStart = Promise.resolve().then(() => openCalls({ socket: callSocketPath(env), handle }));
        const started = await callStart.then(() => true, () => false);
        if (stopping) {
          announceClosing();
          await cleanup();
          announceClosed();
          return exitCode;
        }
        if (!started) {
          for (const { target } of calls.values()) {
            lifecycle({
              event: 'target_warn', kind: logKind(target.kind), target: target.name, message: 'calls are off: could not start the call service',
            });
          }
        }
      }
      // A project's session file and session_start entry name the project; the default's carry no project field.
      const projectField = project === null ? {} : { project };
      const session = {
        version: 1,
        ...projectField,
        pid: proc.pid,
        startedAt: new Date().toISOString(),
        targets: sessionTargets,
      };
      const ownStart = processStartTime(proc.pid);
      if (ownStart !== null) session.processStartedAt = ownStart;

      const followFrom = fileSize(auditFile);
      const ready = record({
        event: 'session_start',
        ...projectField,
        pid: proc.pid,
        targets: sessionTargets.map((t) => ({
          kind: logKind(t.kind), name: t.name, state: t.state,
        })),
        message: `${sessionTargets.length} targets, pid ${proc.pid}`,
      });

      const config = mcpConfig(proc.execPath, BIN_PATH, project);
      const configText = `${JSON.stringify(config, null, 2)}\n`;
      // Each kind's own files, in list order, written even when no target of that kind is open.
      for (const kind of KINDS) {
        if (kind.sessionFiles === undefined) continue;
        for (const file of kind.sessionFiles(opened.filter((o) => o.kind === kind.key), { env })) {
          writeFileAtomic(path.join(sessionDir, file.name), file.text);
        }
      }
      writeFileAtomic(path.join(sessionDir, 'AGENT.md'), agentMdText(session));
      writeFileAtomic(path.join(sessionDir, 'mcp.json'), configText);
      writeSession(sessionDir, session);

      out([
        `Session folder: ${sessionDir}`,
        'MCP config (add once to your agent):',
        configText.trimEnd(),
        `Claude Code: claude mcp add ksproxy -- ${[config.mcpServers.ksproxy.command, ...config.mcpServers.ksproxy.args].join(' ')}`,
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
