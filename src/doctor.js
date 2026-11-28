import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { formatLogLine, formatSaidLine, logOptionsFor } from './audit.js';
import { makeDoctorFolder, reapDoctorFolders } from './doctor-folder.js';
import { hideSecrets } from './kinds/engines/http.js';
import { KINDS } from './kinds/index.js';
import {
  STATE_FOLDER, ensureDir, inventoryPath, sessionDir, socketDir, withProject,
} from './paths.js';
import { everySecretFile, otherInventories, usedPorts } from './projects.js';
import {
  LineStream, listenerProblem, loadProject, nameOf, parseAddresses, readTls, runningSession, tokenProblem,
} from './start-many.js';
import { sharedMasters } from './kinds/engines/tunnel.js';
import {
  checkRouteSockets, chooseTargets, closeTarget, credentialVariables, namesByKind, openFirstServers, openTarget, prepareTargets,
  routesOf, stopSignals, withoutVariables,
} from './start.js';
import { holdTunnel } from './tools.js';
import { clip } from './text.js';
import { tokenState } from './token.js';

// ksproxy doctor: the pre-checks of start, each one reported, then every target that start would open with the same
// arguments, opened as start opens it, checked by the doctor hook of its kind when it has one, and closed again, one
// after another. It writes no session file, no agent file, no call socket and no audit entry: the targets open with a
// temporary state folder inside the root state folder, removed when the project is done, also after a stop. What a
// killed doctor left there is cleaned up first, see src/doctor-folder.js.

const CHECK_MS = 30000;
const DETAIL_MAX = 200;
// A line is not clipped to the width of the terminal: a reason that start gives can be long, and is shown whole.
const NO_CLIP = Number.MAX_SAFE_INTEGER;
// The lines of start that doctor prints while it opens a target; OPENING and UP give way to OK or FAIL.
const SHOWN = ['target_warn', 'target_skipped'];
const SIGNALS = { SIGINT: 'Ctrl-C', SIGTERM: 'terminated', SIGHUP: 'terminal closed' };
const FATAL = ['uncaughtException', 'unhandledRejection'];

const runningText = (project, pid) => `a session of project ${nameOf(project)} is running (pid ${pid}): start would stop here; see ksproxy status`;

// Binds one parsed --listen address for a moment and closes it again, serving nothing: null once that worked, else
// why it could not listen. A connection that arrives meanwhile is closed at once, so that close does not wait for it.
function bindOnce(address, text) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once('error', (err) => resolve(`cannot listen on ${text}: ${err.message}`));
    server.listen({ host: address.host, port: address.port }, () => server.close(() => resolve(null)));
  });
}

// The selection of one project as start makes it from the options, without the picker: the names of the kind flags,
// by kind key, and each plain name added to every kind that holds a target of that name, a kind without a flag too;
// with neither --all nor a name every target is chosen. Gives { selection } or { error }.
async function selectionOf(inventory, options, names, proc) {
  const named = namesByKind(options);
  for (const name of names) {
    const kinds = KINDS.filter((kind) => inventory[kind.key].some((t) => t.name === name));
    if (kinds.length === 0) {
      const known = [...new Set(KINDS.flatMap((kind) => inventory[kind.key].map((t) => t.name)))];
      return { error: `unknown target "${name}"; known targets: ${known.join(', ') || 'none'}` };
    }
    for (const kind of kinds) named[kind.key] = [...(named[kind.key] ?? []), name];
  }
  const merged = { ...options, named };
  const given = options.all || KINDS.some((kind) => named[kind.key]);
  return chooseTargets(inventory, given ? merged : { ...merged, all: true }, proc, null);
}

// The forms of a target's secrets that its kind hides, as start finds the short ones: none for a kind without
// hiddenForms, or when it throws.
function formsOf(kind, target, secrets) {
  if (kind.hiddenForms === undefined) return [];
  try {
    return kind.hiddenForms(target, secrets);
  } catch {
    return [];
  }
}

// The doctor hook of an opened target, doctor(opened, { env, secrets, timeoutMs, signal }): { ok, detail }, within ms
// and until a stop, which gives null; the signal fires at either. A kind without the hook passes once the target is
// open. A hook that throws or gives another shape than a boolean ok and a text detail fails with the check failed.
async function runCheck(kind, opened, ctx, ms, stopped) {
  if (kind.doctor === undefined) return { ok: true, detail: 'opened' };
  const controller = new AbortController();
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, detail: `the check did not finish within ${ms / 1000} seconds` }), ms);
  });
  const failed = { ok: false, detail: 'the check failed' };
  const checked = Promise.resolve()
    .then(() => kind.doctor(opened, { ...ctx, timeoutMs: ms, signal: controller.signal }))
    .then(
      (r) => (r !== null && typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.detail === 'string'
        ? { ok: r.ok, detail: r.detail }
        : failed),
      () => failed,
    );
  try {
    return await Promise.race([stopped.then(() => null), checked, late]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Runs ksproxy doctor. plan is what parseStartArgs gave, with the projects: options, listen, newToken, tls and the
// plain target names. env is the root env, without a project. host.process is the real process; host.limits may name
// checkMs and the close limits of the kinds; host.now is the clock of the token check. Gives 0 when every line is OK, else 1.
export async function doctor(plan, env, host) {
  const {
    projects, options, listen, names,
  } = plan;
  const { process: proc } = host;
  const now = host.now ?? (() => new Date());
  const limits = { checkMs: CHECK_MS, ...host.limits };
  const label = (project) => (projects.length > 1 ? `[${nameOf(project)}] ` : '');
  // startMany protects the TLS key file of its listener from every local target: so does doctor.
  const tlsKey = plan.tls === null ? [] : [path.resolve(plan.tls.key)];
  const counts = { ok: 0, total: 0, failed: 0 };
  let stopping = false;
  let reason = null;
  let wake;
  const stopped = new Promise((resolve) => { wake = resolve; });
  // ctx.signal of each open, as start gives it: it fires when a stop is asked.
  const signals = stopSignals();
  const requestStop = (why) => {
    if (stopping) return;
    stopping = true;
    reason = why;
    signals.fire();
    wake();
  };
  let alive = true;
  const write = (stream, text) => {
    if (!alive) return;
    try {
      stream.write(text);
    } catch {
      alive = false;
      requestStop('output closed');
    }
  };
  // One line in the format of the log, with every value of hide in its message replaced by [hidden].
  const show = (stream, entry, hide) => {
    const message = hideSecrets(String(entry.message), hide);
    const format = { ...logOptionsFor(stream, env), width: NO_CLIP };
    write(stream, `${formatLogLine({ ts: new Date().toISOString(), ...entry, message }, format)}\n`);
  };
  const report = (stream, ok, entry, hide) => {
    if (!ok) counts.failed += 1;
    show(stream, { event: ok ? 'doctor_ok' : 'doctor_fail', ...entry }, hide);
  };
  const precheck = (stream, check, problem, fine) => report(stream, problem === null, { target: check, message: problem ?? fine }, []);

  const handlers = [
    ...Object.entries(SIGNALS).map(([name, why]) => [name, () => requestStop(why)]),
    ...FATAL.map((name) => [name, (err) => requestStop(`error: ${err instanceof Error ? err.message : err}`)]),
  ];
  const onOutputError = () => {
    alive = false;
    requestStop('output closed');
  };

  // Pre-checks 3 to 7 of start with --listen, each reported: every address parses and can be bound, the TLS files,
  // no other listener, the token. No token is made and none is changed.
  const checkListener = async () => {
    for (const text of listen) {
      const parsed = parseAddresses([text]);
      const problem = parsed.error ?? await bindOnce(parsed.addresses[0], text);
      precheck(proc.stdout, 'listen', problem, text);
    }
    if (plan.tls !== null) precheck(proc.stdout, 'tls', readTls(plan.tls).error ?? null, 'the certificate and the key work together');
    precheck(proc.stdout, 'listener', listenerProblem(env), 'no other listener is running');
    const { state } = tokenState(env, now());
    const fine = plan.newToken || state !== 'ok' ? 'start would make a new token' : 'the token can be used';
    precheck(proc.stdout, 'token', tokenProblem(plan, env, now, proc.stdout.isTTY === true), fine);
  };

  // One target: opened as start opens it, with start's WARN and SKIPPED lines, then its check, OK or FAIL, then closed.
  // Every credential of the project, the target's own secrets and their hidden forms are hidden in each line, also in
  // a line the kind says through ctx.say, which goes with the other lines of the target, never clipped.
  const checkTarget = async (kind, t, {
    stream, held, heldValues, ports, context, tunnel,
  }) => {
    const { env: openEnv } = context;
    let hide = heldValues;
    const lifecycle = (entry) => {
      if (SHOWN.includes(entry.event)) show(stream, entry, hide);
    };
    const say = (text) => write(stream, `${formatSaidLine({
      ts: new Date().toISOString(), kind: kind.label, target: t.name, text: hideSecrets(String(text), hide),
    })}\n`);
    // The secrets are hidden from the moment they are read, before the tunnel's trial. A kind with close is closed
    // again when a stop arrived while it opened, as start does.
    const onSecrets = (secrets) => {
      hide = [...heldValues, ...Object.values(secrets), ...formsOf(kind, t, secrets)];
    };
    const open = async (call) => {
      const r = await call();
      if (!r.ok || !stopping || kind.close === undefined) return r;
      await closeTarget(kind, { kind: kind.key, target: t, ...r.extras }, openEnv, limits);
      return { ok: false, late: true };
    };
    const result = await openTarget(kind, t, {
      held, ports, context: { ...context, signal: signals.signal(), say }, lifecycle, open, onOpened: () => {}, onSecrets, tunnel,
    });
    if (result.skipped !== undefined) {
      // A failure of a first server names it: the text of ssh alone does not say which layer failed.
      const message = result.firstServer === undefined ? result.skipped : `the first server ${result.firstServer} failed: ${result.skipped}`;
      report(stream, false, { kind: kind.label, target: t.name, message }, hide);
      return;
    }
    if (result.late) return;
    // The listener of a tunnel accepts connections while the check runs.
    const release = holdTunnel(result.opened);
    let check = null;
    try {
      if (!stopping) check = await runCheck(kind, result.opened, { env: openEnv, secrets: result.secrets }, limits.checkMs, stopped);
    } finally {
      release();
    }
    if (check !== null) {
      if (check.ok) counts.ok += 1;
      const detail = clip(hideSecrets(check.detail, hide), DETAIL_MAX);
      report(stream, check.ok, { kind: kind.label, target: t.name, message: detail }, hide);
    }
    await closeTarget(kind, result.opened, openEnv, limits);
  };

  // One project with a loaded inventory and no live session: its selection, the socket paths of start, then each
  // selected target in a temporary state folder, removed at the end. credentials are the variables of every loaded
  // inventory: no target gets any of them in its env.
  const checkProject = async (project, inventory, stream, credentials) => {
    const own = withProject(env, project);
    const held = new Map(credentialVariables(inventory).map((name) => [name, env[name]]));
    const heldValues = [...held.values()].filter((value) => typeof value === 'string');
    const picked = await selectionOf(inventory, options, names, proc);
    if (picked.error !== undefined) {
      report(stream, false, { target: 'targets', message: picked.error }, heldValues);
      return;
    }
    const { selection } = picked;
    const chosen = KINDS.flatMap((kind) => selection[kind.key].map((t) => ({ kind, t })));
    if (chosen.length === 0) {
      report(stream, false, { target: 'targets', message: 'nothing selected' }, heldValues);
      return;
    }
    counts.total += chosen.length;
    const inventories = otherInventories(own);
    const { files, problem: secretFilesProblem } = everySecretFile(inventory, inventories);
    const ports = usedPorts(own, inventories);
    const bare = withoutVariables(own, credentials);
    try {
      prepareTargets(selection, bare);
    } catch (err) {
      report(stream, false, { target: 'sockets', message: err.message }, heldValues);
    }
    const folder = makeDoctorFolder(env, proc.pid);
    const openEnv = { ...bare, [STATE_FOLDER]: folder };
    const routes = routesOf(inventory, selection);
    const masters = sharedMasters(openEnv);
    try {
      ensureDir(socketDir(openEnv));
      ensureDir(sessionDir(openEnv));
      let prepared;
      try {
        prepared = prepareTargets(selection, openEnv);
        checkRouteSockets(routes, masters);
      } catch (err) {
        report(stream, false, { target: 'sockets', message: err.message }, heldValues);
        return;
      }
      let firstServers = false;
      for (const { kind, t } of chosen) {
        if (stopping) break;
        const route = routes.get(`${kind.key}:${t.name}`);
        // Before the first target with a route, every first server of this project, once, as start does.
        if (route !== undefined && !firstServers) {
          firstServers = true;
          await openFirstServers(routes, masters, () => stopping);
          if (stopping) break;
        }
        const context = {
          env: openEnv, sessionDir: sessionDir(openEnv), secretFiles: [...files, ...tlsKey], secretFilesProblem, prepared: prepared.get(kind.key).get(t.name),
        };
        await checkTarget(kind, t, {
          stream, held, heldValues, ports, context, tunnel: route === undefined ? undefined : { route, masters, stepMs: limits.tunnelStepMs },
        });
      }
    } finally {
      // The shared connections of this project live for its run: closed before its temporary folder is removed.
      await masters.closeAll();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  };

  for (const [name, handler] of handlers) proc.on(name, handler);
  proc.stdout.on('error', onOutputError);
  try {
    const streams = projects.map((project) => new LineStream(proc.stdout, label(project)));
    const inventories = projects.map((project, i) => {
      const loaded = loadProject(project, env);
      precheck(streams[i], 'inventory', loaded.error ?? null, `loaded ${inventoryPath(withProject(env, project))}`);
      return loaded.inventory ?? null;
    });
    const live = projects.map((project, i) => {
      const session = runningSession(project, env);
      precheck(streams[i], 'session', session === null ? null : runningText(project, session.pid), 'no session is running');
      return session !== null;
    });
    const credentials = inventories.filter((inventory) => inventory !== null).flatMap(credentialVariables);
    // What a killed doctor left, before anything opens: its proxies and ssh masters are stopped, its folder removed.
    for (const line of await reapDoctorFolders(withoutVariables(env, credentials), proc.pid)) precheck(proc.stdout, 'leftovers', null, line);
    if (listen.length > 0) await checkListener();
    for (const [i, project] of projects.entries()) {
      if (stopping) break;
      if (inventories[i] !== null && !live[i]) await checkProject(project, inventories[i], streams[i], credentials);
    }
    if (stopping) report(proc.stdout, false, { target: 'doctor', message: `stopped: ${reason}` }, []);
    write(proc.stdout, `${counts.ok} of ${counts.total} targets OK\n`);
    return counts.failed === 0 ? 0 : 1;
  } finally {
    for (const [name, handler] of handlers) proc.off(name, handler);
    proc.stdout.off('error', onOutputError);
  }
}
