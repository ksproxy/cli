import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import {
  adoptOldLogs, appendAudit, formatLogLine, formatSaidLine, logOptionsFor, MAX_LOG_BYTES, rotateAudit,
} from './audit.js';
import { agentMdText, mcpConfig } from './agent-md.js';
import { allowWarnings } from './allowlist.js';
import { reapDoctorFolders } from './doctor-folder.js';
import { InventoryError, loadInventory, tunnelRoute } from './inventory.js';
import { openListener, sharedMasters } from './kinds/engines/tunnel.js';
import { clip } from './text.js';
import {
  auditLogPath, callSocketPath, ensureDir, initCommand, inventoryPath, logDir as logDirOf, projectOf, reviewSocketPath,
  rootStateDir, sessionDir as sessionDirOf, socketDir as socketDirOf, stateDir as stateDirOf, writeFileAtomic,
} from './paths.js';
import { startCallServer } from './broker.js';
import {
  KINDS, cliName, flaggedKinds, kindByKey,
} from './kinds/index.js';
import {
  everySecretFile, otherInventories, portProblem, usedPorts,
} from './projects.js';
import { startReviewServer } from './review.js';
import { checkbox } from './select.js';
import {
  clearSession, liveSession, processStartTime, writeSession,
} from './session.js';
import {
  answerCall, holdTunnel, keepTunnel, targetState, tunnelControl,
} from './tools.js';

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

// The target names given for each kind, by kind key, or null. The command line gives them under the flag of each kind
// that has one; startMany (the picks) and doctor (the target names) give them by kind key in named, which reaches a
// kind without a flag too.
export function namesByKind(options) {
  return Object.fromEntries(KINDS.map((kind) => {
    let given;
    if (options.named !== undefined) given = options.named[kind.key];
    else if (kind.flag !== undefined) given = options[kind.flag];
    return [kind.key, given ?? null];
  }));
}

export async function chooseTargets(inventory, options, proc, pick) {
  if (options.all) {
    return { selection: Object.fromEntries(KINDS.map((kind) => [kind.key, inventory[kind.key]])) };
  }

  const named = namesByKind(options);
  if (KINDS.some((kind) => named[kind.key])) {
    const selection = {};
    for (const kind of KINDS) {
      const picked = pickByName(cliName(kind), named[kind.key] ?? [], inventory[kind.key]);
      if (picked.error) return picked;
      selection[kind.key] = picked.list;
    }
    return { selection };
  }

  if (!proc.stdin.isTTY) {
    // The flag of every kind that is not brokered, and of each brokered kind the inventory holds a target of; a kind
    // without a flag is named by none.
    const flags = flaggedKinds().filter((kind) => kind.brokered !== true || inventory[kind.key].length > 0).map((kind) => `--${kind.flag}`);
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
export function credentialVariables(inventory) {
  const names = Object.values(inventory.reviewers).map((r) => r.keyEnv).filter((name) => name !== null);
  for (const kind of KINDS) {
    if (kind.secrets === undefined) continue;
    for (const t of inventory[kind.key]) names.push(...kind.secrets(t).env);
  }
  return names;
}

export function withoutVariables(env, names) {
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

// The socket paths of a selection, checked kind by kind in list order through prepare, then the review socket when a
// selected target has a review, then the call socket when a brokered target is selected. Gives what each kind
// prepared, by kind key and target name; the first path over its limit throws.
export function prepareTargets(selection, env) {
  const prepared = new Map();
  for (const kind of KINDS) {
    prepared.set(kind.key, kind.prepare === undefined ? new Map() : kind.prepare(selection[kind.key], { env }));
  }
  if (KINDS.some((kind) => selection[kind.key].some((t) => t.review))) reviewSocketPath(env);
  if (KINDS.some((kind) => kind.brokered === true && selection[kind.key].length > 0)) callSocketPath(env);
  return prepared;
}

// One opened target: close of its kind when it has one, bounded by the kind's closeMs unless limits names the kind's
// closeLimit, with the kind's onCloseTimeout past it; then its tunnel when it has one, bounded by limits.tunnelCloseMs.
export async function closeTarget(kind, o, env, limits) {
  if (kind.close !== undefined) {
    await bounded(
      kind.close(o, { env }),
      limits[kind.closeLimit] ?? kind.closeMs,
      kind.onCloseTimeout === undefined ? undefined : () => kind.onCloseTimeout(o),
    );
  }
  const control = tunnelControl(o);
  if (control !== undefined) await bounded(control.close(), limits.tunnelCloseMs ?? TUNNEL_CLOSE_MS);
}

// The service tunnels. The time limit of the trial is TUNNEL_STEP_MS for the first server and for each jump, and
// TUNNEL_STEP_MS more; host.limits.tunnelStepMs replaces it in tests.
export const TUNNEL_STEP_MS = 10000;
const TUNNEL_CLOSE_MS = 5000;
// After a failed trial, how long each of its streams is given to end, so that its reason is known.
const TRIAL_EXIT_MS = 3000;
const REASON_MAX = 300;
const ADDRESS_FAILED = 'the address of the service could not be found';
// The state a target with a tunnel has once its shared connection is gone, and the core's own DOWN text for it.
const TUNNEL_GONE = 'tunnel gone';
export function tunnelGoneText(host) {
  return `the shared connection to ${host} is gone: the target stays down until ksproxy start is run again`;
}
export const NO_CERTIFICATE_WHY = 'the servers on the route can read and change the traffic: this target does not check the certificate of the service';

// The routes of a selection, by "KIND:NAME", in the order start opens the targets: only the targets that have one.
export function routesOf(inventory, selection) {
  const routes = new Map();
  for (const kind of KINDS) {
    for (const t of selection[kind.key]) {
      const route = tunnelRoute(inventory, kind.key, t.name);
      if (route !== null) routes.set(`${kind.key}:${t.name}`, route);
    }
  }
  return routes;
}

// The socket of the shared connection of every first server of routes, before anything opens: the first path over
// its limit, or two hosts on one socket, throws.
export function checkRouteSockets(routes, masters) {
  for (const route of routes.values()) masters.socketFor(route.host);
}

// The first-server phase: each distinct first server of routes, one at a time in their order, opened once through
// masters; stopped() is asked before each. A failure is kept by masters and skips the targets behind it later.
export async function openFirstServers(routes, masters, stopped) {
  for (const host of new Set([...routes.values()].map((route) => route.host))) {
    if (stopped()) return;
    await masters.open(host);
  }
}

// What the OPENING line adds for a route: the first server, and the number of jumps when there are some.
export function routeText(route) {
  const count = route.jumps.length;
  if (count === 0) return `through ${route.host}`;
  return `through ${route.host}, then ${count} ${count === 1 ? 'jump' : 'jumps'}`;
}

// The opened entry with its tunnel, not enumerable, so that no spread or JSON of the entry carries it.
function withTunnel(entry, tunnel) {
  return Object.defineProperty(entry, 'tunnel', { value: tunnel, enumerable: false });
}

// The address of the service from tunnelTo of the kind: { address } for a text, { error } for { error: text }, the
// kind's refusal. A throw, or anything else, gives ADDRESS_FAILED: its message may hold a secret.
function addressOf(kind, t, secrets) {
  let given;
  try {
    given = kind.tunnelTo(t, secrets);
  } catch {
    return { error: ADDRESS_FAILED };
  }
  if (typeof given === 'string') return { address: given };
  if (given !== null && typeof given === 'object' && typeof given.error === 'string') return { error: given.error };
  return { error: ADDRESS_FAILED };
}

// The promise's value, or fallback once ms passed.
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// The trial: the doctor hook of the kind, run once through the tunnel with the entry without the extras of open,
// within ms and until stop fires: { ok, detail }. A kind without the hook passes. A hook that throws or gives another
// shape fails with "the check failed".
async function trialOf(kind, probe, ctx, ms, stop) {
  if (kind.doctor === undefined) return { ok: true, detail: 'no check' };
  const controller = new AbortController();
  const signal = AbortSignal.any([stop, controller.signal]);
  const failed = { ok: false, detail: 'the check failed' };
  const checked = Promise.resolve()
    .then(() => kind.doctor(probe, { ...ctx, timeoutMs: ms, signal }))
    .then(
      (r) => (r !== null && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.detail === 'string'
        ? { ok: r.ok, detail: r.detail }
        : failed),
      () => failed,
    );
  const stopped = new Promise((resolve) => {
    if (stop.aborted) resolve({ ok: false, detail: 'stopped' });
    signal.addEventListener('abort', () => resolve({ ok: false, detail: 'stopped' }), { once: true });
  });
  try {
    return await within(Promise.race([checked, stopped]), ms, { ok: false, detail: `the check did not finish within ${ms / 1000} seconds` });
  } finally {
    controller.abort();
  }
}

// Why the route of a failed trial failed, or null when it did not: the error of a connection that could not be made,
// else the reason of the first stream of the trial whose ssh ended with an error, each given TRIAL_EXIT_MS to end.
async function routeFailure(seen) {
  if (seen.errors.length > 0) return seen.errors[0];
  const reasons = await Promise.all(seen.streams.map((s) => within(s.exited.then((r) => r.reason), TRIAL_EXIT_MS, null)));
  return reasons.find((reason) => reason !== null) ?? null;
}

// What a stream kind's hold gives, and what takes the error of a stream so that it is never unhandled.
const nothing = () => {};

const oneLine = (text) => clip(text.trim().replace(/\s*\n\s*/g, '; '), REASON_MAX);

// The tunnel of one target before its kind's open: the first server, tunnelTo, the connector, the listener for a kind
// with tunnelListener, then the trial. Gives { tunnel } (kept with keepTunnel), { skipped, firstServer? }, or { late }
// when the signal fired (all closed). The tunnel is { connect } or { host, port, hold }; its streams never throw an
// unhandled error. listen opens the listener (openListener; a test gives one that fails).
export async function openTunnel(kind, t, secrets, {
  route, masters, env, signal, stepMs = TUNNEL_STEP_MS, listen = openListener,
}) {
  const first = await masters.open(route.host);
  if (!first.ok) return { skipped: first.error, firstServer: route.host };
  const to = addressOf(kind, t, secrets);
  if (to.error !== undefined) return { skipped: to.error };
  let raw;
  try {
    raw = masters.connector(route, to.address);
  } catch (err) {
    return { skipped: err.message };
  }
  const live = new Set();
  let seen = null;
  const connect = () => {
    let stream;
    try {
      stream = raw();
    } catch (err) {
      seen?.errors.push(err.message);
      throw err;
    }
    stream.on('error', nothing);
    live.add(stream);
    stream.once('close', () => live.delete(stream));
    seen?.streams.push(stream);
    return stream;
  };
  const control = {
    host: route.host, down: false, check: () => masters.check(route.host),
  };
  let listener = null;
  let tunnel;
  if (kind.tunnelListener === true) {
    try {
      listener = await listen(connect);
    } catch (err) {
      return { skipped: `the loopback port could not be opened: ${err.message}` };
    }
    const hold = () => (control.down ? () => {} : listener.hold());
    control.hold = hold;
    tunnel = Object.freeze({ host: listener.host, port: listener.port, hold });
  } else {
    control.hold = () => nothing;
    tunnel = Object.freeze({ connect });
  }
  control.close = async () => {
    control.down = true;
    if (listener !== null) await listener.close();
    await Promise.all([...live].map((s) => new Promise((resolve) => {
      s.once('close', resolve);
      s.destroy();
    })));
  };
  keepTunnel(tunnel, control);

  seen = { errors: [], streams: [] };
  const probe = withTunnel({ kind: kind.key, target: t }, tunnel);
  const release = control.hold();
  const ms = stepMs * (route.jumps.length + 1) + stepMs;
  let trial;
  try {
    trial = await trialOf(kind, probe, { env, secrets }, ms, signal);
  } finally {
    release();
  }
  const trialSeen = seen;
  seen = null;
  if (signal.aborted) {
    await control.close();
    return { late: true };
  }
  if (trial.ok) return { tunnel };
  const reason = await routeFailure(trialSeen);
  await control.close();
  if (reason !== null) return { skipped: `the route failed: ${oneLine(reason)}` };
  return { skipped: `the service did not answer through the tunnel: ${oneLine(trial.detail)}` };
}

// The signals that open gets as ctx.signal, one per target, so that no signal gathers the listeners of many targets:
// signal() gives a new one, and fire(), when a stop is asked, fires every one given so far and each one given later.
export function stopSignals() {
  const controllers = [];
  let fired = false;
  return {
    signal() {
      const controller = new AbortController();
      if (fired) controller.abort();
      controllers.push(controller);
      return controller.signal;
    },
    fire() {
      fired = true;
      for (const controller of controllers) controller.abort();
    },
  };
}

// Opens one selected target as start opens it, and prints start's lines for it through lifecycle, which gets one
// entry at a time: the warnings of its rules, OPENING, then SKIPPED for a port another file names or for a secret that
// cannot be read, else open. open(call, secrets) gets the call of the kind's open with the context and the target's
// secrets, and the secrets themselves; it gives the result of open, or { late } when it closed a target that opened
// during a stop. An opened target goes to onOpened with its secrets, then UP or the WARN of open, the notes and the
// short secrets follow; a failed open is SKIPPED with its error. Gives { opened, secrets }, { skipped } with the text
// of the SKIPPED line, or { late }.
export async function openTarget(kind, t, {
  held, ports, context, lifecycle, open, onOpened, onSecrets = () => {}, tunnel: route,
}) {
  const line = (event, message) => lifecycle({
    event, kind: kind.label, target: t.name, message,
  });
  // A local target with a programs list runs commands without a rule, so an empty allow list refuses nothing there.
  if (Array.isArray(t.allow) && t.allow.length === 0 && t.programs === undefined) line('target_warn', EMPTY_ALLOW);
  for (const warning of kind.ruleWarnings === undefined ? allowWarnings(t.allow) : kind.ruleWarnings(t)) {
    line('target_warn', warning);
  }
  line('target_opening', route === undefined ? kind.openingMessage(t) : `${kind.openingMessage(t)}, ${routeText(route.route)}`);
  if (route !== undefined && kind.tunnelChecksCertificate?.(t) !== true) line('target_warn', NO_CERTIFICATE_WHY);
  const blocked = portProblem(kind, t, ports);
  if (blocked !== null) {
    line('target_skipped', blocked);
    return { skipped: blocked };
  }
  const secrets = readSecrets(kind, t, held);
  if (secrets.error !== undefined) {
    line('target_skipped', secrets.error);
    return { skipped: secrets.error };
  }
  onSecrets(secrets.secrets);
  let tunnel;
  if (route !== undefined) {
    const made = await openTunnel(kind, t, secrets.secrets, { ...route, env: context.env, signal: context.signal });
    if (made.late) return { late: true };
    if (made.skipped !== undefined) {
      line('target_skipped', made.skipped);
      return made;
    }
    ({ tunnel } = made);
  }
  const control = tunnel === undefined ? undefined : tunnelControl({ tunnel });
  const shut = () => (control === undefined ? undefined : control.close());
  // The result of open is always awaited; the listener of a tunnel accepts connections while it runs.
  const ctx = tunnel === undefined ? { ...context, secrets: secrets.secrets } : { ...context, secrets: secrets.secrets, tunnel };
  const release = control === undefined ? () => {} : control.hold();
  let r;
  try {
    r = await open(() => kind.open(t, ctx), secrets.secrets);
  } catch (err) {
    release();
    await shut();
    throw err;
  }
  release();
  if (r.late) {
    await shut();
    return { late: true };
  }
  if (!r.ok) {
    await shut();
    line('target_skipped', r.error);
    return { skipped: r.error };
  }
  const opened = { kind: kind.key, target: t, ...r.extras };
  if (tunnel !== undefined) withTunnel(opened, tunnel);
  onOpened(opened, secrets.secrets);
  if (r.warn === undefined) {
    lifecycle({ event: 'target_up', kind: kind.label, target: t.name });
  } else {
    line('target_warn', r.warn);
  }
  for (const note of r.notes ?? []) line('target_warn', note);
  for (const source of secrets.short) line('target_warn', `${source} ${SHORT_SECRET_WHY}`);
  for (const source of secrets.shortForms) line('target_warn', `${source} ${SHORT_FORM_WHY}`);
  return { opened, secrets: secrets.secrets };
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
  // ctx.signal of each open: it fires when a stop is asked, so that an open that waits can end.
  const signals = stopSignals();
  const requestStop = (reason) => {
    if (reason !== undefined && closeReason === null) closeReason = reason;
    if (stopping) return;
    stopping = true;
    signals.fire();
    wake();
  };
  // startMany stops a session with a close reason of its own, such as another project stopped.
  if (host.stop !== undefined) host.stop.then(requestStop);
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
  // ctx.say of the open of one target: a line about it on stderr, never clipped and never in the audit log. The kind
  // may keep it and call it later.
  const sayAbout = (kind, t) => (text) => write('stderr', `${formatSaidLine({
    ts: new Date().toISOString(), kind: kind.label, target: t.name, text,
  })}\n`);

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
  // The shared connections of the service tunnels of this start, once the selection is known.
  let masters = null;
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
  const closeOne = (kind, o) => closeTarget(kind, o, env, limits);

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
      // Each target's kind, then its tunnel; then the shared connections, after their opens ended, before the
      // socket folder is emptied.
      await Promise.all(opened.filter((o) => kindByKey(o.kind).close !== undefined || o.tunnel !== undefined)
        .map((o) => closeOne(kindByKey(o.kind), o)));
      if (masters !== null) await masters.closeAll();
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
      opened: o,
      secrets: secretsOf.get(`${o.kind}:${o.target.name}`),
      up: sessionTargets[i].state === 'up',
      tunnel: tunnelControl(o),
    }));
    // A target with a tunnel asks its shared connection first: once it is gone the target stays down, its listener
    // takes no connection, and its kind is not asked again. Then a kind with probe is asked with the target's
    // secrets and its opened entry, while the listener's gate is held; every other target goes through targetState.
    const stateNow = async (item) => {
      if (item.tunnel !== undefined && (item.tunnel.down || !(await item.tunnel.check()))) {
        item.tunnel.down = true;
        return TUNNEL_GONE;
      }
      if (item.of.probe === undefined) return stateOf(item.target, env);
      const release = holdTunnel(item.opened);
      try {
        return await item.of.probe(item.target, { env, secrets: item.secrets, opened: item.opened });
      } finally {
        release();
      }
    };
    const downText = (item, state) => (state === TUNNEL_GONE
      ? tunnelGoneText(item.tunnel.host)
      : item.of.downMessage(item.target, state, item.opened));
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
            event: 'target_down', kind: item.kind, target: item.name, message: downText(item, state),
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
    // What a killed ksproxy doctor left in the root state folder goes first, with the lines of the kinds, as below.
    for (const line of await reapDoctorFolders(env, proc.pid)) say(line);
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
    const { files, problem: secretFilesProblem } = everySecretFile(inventory, inventories);
    // startMany adds the TLS key file of its listener: no local target may reach it either.
    const secretFiles = [...files, ...(host.secretFiles ?? [])];
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
    let prepared;
    try {
      prepared = prepareTargets(selection, env);
    } catch (err) {
      say(err.message);
      return 1;
    }
    // The routes of the service tunnels, and the sockets of their shared connections, checked before anything opens.
    const routes = routesOf(inventory, selection);
    masters = sharedMasters(env);
    try {
      checkRouteSockets(routes, masters);
    } catch (err) {
      say(err.message);
      return 1;
    }
    let firstServers = false;

    try {
      for (const kind of KINDS) {
        for (const t of selection[kind.key]) {
          if (stopping) break;
          const route = routes.get(`${kind.key}:${t.name}`);
          // Before the first target with a route, every first server of this start, once.
          if (route !== undefined && !firstServers) {
            firstServers = true;
            await openFirstServers(routes, masters, () => stopping);
            if (stopping) break;
          }
          // A kind with close is closed again when a stop arrived while it opened.
          const result = await openTarget(kind, t, {
            tunnel: route === undefined ? undefined : { route, masters, stepMs: limits.tunnelStepMs },
            held,
            ports,
            context: {
              env,
              sessionDir,
              secretFiles,
              secretFilesProblem,
              prepared: prepared.get(kind.key).get(t.name),
              signal: signals.signal(),
              say: sayAbout(kind, t),
            },
            lifecycle,
            open: (call) => openGuarded(
              call,
              kind.close === undefined ? undefined : (r) => closeOne(kind, { kind: kind.key, target: t, ...r.extras }),
            ),
            onOpened: (o, secrets) => {
              opened.push(o);
              secretsOf.set(`${kind.key}:${t.name}`, secrets);
            },
          });
          if (result.late) break;
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

      // The brokered targets as this run opened and recorded them: the only ones the call service acts on. perform gets
      // the opened entry too, with what open kept in its extras, which no file ever holds.
      const calls = new Map();
      opened.forEach((o, i) => {
        if (kindByKey(o.kind).brokered !== true) return;
        const key = `${o.kind}:${o.target.name}`;
        calls.set(key, { target: sessionTargets[i], secrets: secretsOf.get(key), opened: o });
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
      // startMany starts its listener once every session it runs has come this far.
      if (host.ready !== undefined) host.ready();
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
