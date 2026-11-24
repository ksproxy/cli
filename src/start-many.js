import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createSecureContext } from 'node:tls';
import { InventoryError, loadInventory } from './inventory.js';
import { KINDS } from './kinds/index.js';
import { liveListener, parseListen, startListener } from './listen.js';
import {
  PROJECT_DEFAULT, initCommand, inventoryPath, sessionDir, withProject,
} from './paths.js';
import { checkbox } from './select.js';
import { liveSession } from './session.js';
import {
  chooseTargets, credentialVariables, start, withoutVariables,
} from './start.js';
import {
  expiryWarning, newToken, tokenPath, tokenState,
} from './token.js';

// Several projects in one ksproxy start, and the network listener that serves them. Each project runs the start of
// src/start.js, unchanged, with a stand-in process whose output lines carry the project's name; this module checks
// everything before any of them opens, starts the listener once every session is ready, and stops them together.

const DAY_MS = 24 * 60 * 60 * 1000;
// The events of the real process that go to every session: startMany closes the listener first.
const RELAYED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection'];
const ANOTHER_STOPPED = 'another project stopped';
const NO_LISTENER = 'the listener could not start';
const LISTEN = '[listen] ';
// A new token is printed only on a terminal, never into a file or a pipe such as tee.
const NO_TERMINAL = 'a new token is shown only on a terminal';
const NO_TERMINAL_START = `${NO_TERMINAL}: run this start once with its output on a terminal`;

// One output stream of a session: each whole line goes to the real stream with the prefix in front, and a line without
// its end waits for the rest. isTTY is that of the real stream, columns that of the real stream less the width of the
// prefix. fail passes an error of the real stream on to the error listeners of the session, when it still has any.
export class LineStream extends EventEmitter {
  #real;

  #prefix;

  #partial = '';

  constructor(real, prefix) {
    super();
    this.#real = real;
    this.#prefix = prefix;
  }

  get isTTY() {
    return this.#real.isTTY;
  }

  get columns() {
    const { columns } = this.#real;
    return Number.isInteger(columns) ? columns - this.#prefix.length : columns;
  }

  write(text) {
    const lines = `${this.#partial}${text}`.split('\n');
    this.#partial = lines.pop();
    if (lines.length > 0) this.#real.write(lines.map((line) => `${this.#prefix}${line}\n`).join(''));
    return true;
  }

  // The line still waiting for its end, written with an end, once the session is over.
  flush() {
    if (this.#partial === '') return;
    const rest = this.#partial;
    this.#partial = '';
    this.#real.write(`${this.#prefix}${rest}\n`);
  }

  fail(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}

// The stand-in process of one session: its own signal and fatal events, which startMany emits, two LineStreams, and
// the real stdin, pid and execPath.
export function wrapProcess(real, prefix) {
  const proc = new EventEmitter();
  proc.stdout = new LineStream(real.stdout, prefix);
  proc.stderr = new LineStream(real.stderr, prefix);
  proc.stdin = real.stdin;
  proc.pid = real.pid;
  proc.execPath = real.execPath;
  return proc;
}

const nameOf = (project) => project ?? PROJECT_DEFAULT;

// The URL of a project that the terminal prints: /mcp for the default, /p/NAME/mcp for a project, on the first bound
// HOST:PORT that has no zone. Only a link-local IPv6 address has one, as parseListen requires; when every address is
// link-local, the first is used, its % written %25 as a URL needs it.
export function projectUrl(scheme, bound, project) {
  const address = bound.find((text) => !text.includes('%')) ?? bound[0].replace('%', '%25');
  return `${scheme}://${address}${project === null ? '/mcp' : `/p/${project}/mcp`}`;
}

// The env the listener serves each project with: the env of start less every credential variable of every listed
// project, for that project. The listener never sees a credential; the sessions hold them.
export function servedEnvs(projects, inventories, env) {
  const bare = withoutVariables(env, inventories.flatMap(credentialVariables));
  return new Map(projects.map((project) => [project, withProject(bare, project)]));
}

// Pre-checks 1 and 2: every inventory loads, then no project has a live session. Gives the inventories or { error }.
function checkProjects(projects, env, label) {
  const inventories = [];
  for (const project of projects) {
    const own = withProject(env, project);
    try {
      inventories.push(loadInventory(inventoryPath(own), initCommand(own)));
    } catch (err) {
      if (err instanceof InventoryError) return { error: err.message };
      throw err;
    }
  }
  for (const project of projects) {
    const live = liveSession(sessionDir(withProject(env, project)));
    if (live !== null) {
      return { error: `${label(project)}a session is already running (pid ${live.pid}); stop it with Ctrl-C in its terminal` };
    }
  }
  return { inventories };
}

// Pre-checks 3 to 7, with --listen only: the addresses parse, the TLS files are read into memory and make a TLS
// context together, no other listener is live, the token file can be read unless --new-token replaces it, and a new
// token is made only when stdout is a terminal. Gives the addresses and TLS, or { error }.
function checkListen(plan, env, now, terminal) {
  const addresses = [];
  for (const text of plan.listen) {
    try {
      addresses.push(parseListen(text));
    } catch (err) {
      return { error: err.message };
    }
  }
  let tls = null;
  if (plan.tls !== null) {
    tls = {};
    for (const [key, flag] of [['cert', '--tls-cert'], ['key', '--tls-key']]) {
      try {
        tls[key] = fs.readFileSync(plan.tls[key]);
      } catch {
        return { error: `${flag}: cannot read ${plan.tls[key]}` };
      }
    }
    try {
      createSecureContext({ cert: tls.cert, key: tls.key });
    } catch (err) {
      return { error: `--tls-cert and --tls-key cannot be used together: ${err.message}` };
    }
  }
  const pid = liveListener(env);
  if (pid !== null) return { error: `another ksproxy start is listening (pid ${pid})` };
  const { state } = tokenState(env, now());
  if (!plan.newToken && state === 'unreadable') {
    return { error: `cannot read ${tokenPath(env)}: start with --new-token to replace it` };
  }
  if ((plan.newToken || state !== 'ok') && !terminal) return { error: NO_TERMINAL_START };
  return { addresses, tls };
}

// Pre-check 7: the options each start gets. --all or kind flags go to every start as given. Else the picker runs here,
// once per project, one after the other, its titles with the prefix of the project, and the names picked become the
// kind flags of that project, so start never runs a picker of its own.
async function chooseAll(projects, inventories, options, proc, pick, label) {
  if (options.all || KINDS.some((kind) => options[kind.flag])) return { chosen: projects.map(() => options) };
  if (projects.length > 1 && !proc.stdin.isTTY) return { error: 'several projects need --all when not running in a terminal' };
  const chosen = [];
  for (const [i, project] of projects.entries()) {
    const ask = (request) => pick({ ...request, title: `${label(project)}${request.title}` });
    const picked = await chooseTargets(inventories[i], options, proc, ask);
    if (picked.error !== undefined) return { error: picked.error };
    const names = Object.fromEntries(KINDS.map((kind) => [kind.flag, picked.selection[kind.key].map((t) => t.name)]));
    if (Object.values(names).every((list) => list.length === 0)) return { error: `${label(project)}nothing selected` };
    chosen.push({ ...options, ...names });
  }
  return { chosen };
}

// Runs every project of plan in this process. plan: projects (names, null for the default), options (as start takes
// them), listen (the --listen values), newToken, tls (null or the two file names). env is the root env, without a
// project. host.process is the real process, and the other hooks of host go on to each start. Gives 0 only when every
// session gave 0, none ended on its own, and the listener, when asked for, started.
export async function startMany(plan, env, host) {
  const { projects, options, listen } = plan;
  const { process: proc } = host;
  const now = host.now ?? (() => new Date());
  const limits = { warnMs: DAY_MS, ...host.limits };
  const pick = host.checkbox ?? ((request) => checkbox({
    ...request, input: proc.stdin, output: proc.stderr, signals: proc,
  }));
  const label = (project) => (projects.length > 1 ? `[${nameOf(project)}] ` : '');
  // Only a stdout that is a terminal shows a new token.
  const terminal = proc.stdout.isTTY === true;
  const complain = (text) => proc.stderr.write(`${text}\n`);
  const refuse = (text) => {
    complain(text);
    return 1;
  };

  const loaded = checkProjects(projects, env, label);
  if (loaded.error !== undefined) return refuse(loaded.error);
  const listening = listen.length === 0 ? { addresses: [], tls: null } : checkListen(plan, env, now, terminal);
  if (listening.error !== undefined) return refuse(listening.error);
  const picked = await chooseAll(projects, loaded.inventories, options, proc, pick, label);
  if (picked.error !== undefined) return refuse(picked.error);

  const served = servedEnvs(projects, loaded.inventories, env);
  const secretFiles = plan.tls === null ? [] : [path.resolve(plan.tls.key)];
  const scheme = listening.tls === null ? 'http' : 'https';
  const show = (text) => proc.stdout.write(`${text}\n`);

  const wrappers = projects.map((project) => wrapProcess(proc, label(project)));
  const stoppers = [];
  let stopping = false;
  let failed = false;
  let listenerStart = Promise.resolve(null);
  let typed = null;
  let warnTimer = null;
  let readyCount = 0;
  let wake;
  const settled = new Promise((resolve) => { wake = resolve; });

  const closeListener = async () => {
    const listener = await listenerStart;
    if (listener !== null) await listener.close();
  };
  // Stops every session with one close reason, after the listener is closed; only the first call does anything.
  const stopAll = async (reason) => {
    if (stopping) return;
    stopping = true;
    await closeListener();
    for (const stop of stoppers) stop(reason);
  };
  const relay = (name) => async (...args) => {
    stopping = true;
    await closeListener();
    for (const wrapper of wrappers) wrapper.emit(name, ...args);
  };
  const handlers = RELAYED.map((name) => [name, relay(name)]);
  const streamErrors = ['stdout', 'stderr'].map((name) => [name, (err) => {
    for (const wrapper of wrappers) wrapper[name].fail(err);
  }]);

  const showNewToken = (bound) => {
    const token = newToken(env, now());
    show(`${LISTEN}a new token was made; it is shown only now`);
    for (const project of projects) {
      show(`claude mcp add --transport http ksproxy-${nameOf(project)} ${projectUrl(scheme, bound, project)} --header "Authorization: Bearer ${token}"`);
    }
  };
  const warn = () => {
    const at = now();
    const { record } = tokenState(env, at);
    const text = record === null ? null : expiryWarning(record, at);
    if (text !== null) show(`${LISTEN}${text}`);
  };
  const onLine = (bound) => (line) => {
    const word = line.trim();
    if (word === '') return;
    if (word !== 'new-token') {
      show(`${LISTEN}type new-token to replace the token`);
      return;
    }
    if (!terminal) {
      complain(`${LISTEN}${NO_TERMINAL}`);
      return;
    }
    try {
      showNewToken(bound);
    } catch (err) {
      complain(`${LISTEN}cannot make a new token: ${err.message}`);
    }
  };
  const onEvent = (event) => {
    if (event.type === 'connected') show(`${LISTEN}${event.from} ${event.client} connected`);
    else show(`${LISTEN}refused ${event.count} wrong tokens from ${event.from}`);
  };

  // The listener, its lines, the daily warning and the typed lines; null when it could not start, its line on stderr
  // said why, and the listener is closed again when it had started.
  const openListener = async () => {
    let listener = null;
    const fail = async (text) => {
      if (listener !== null) await listener.close();
      complain(`${LISTEN}${text}`);
      return null;
    };
    try {
      listener = await startListener({
        addresses: listening.addresses, tls: listening.tls, projects: served, env, onEvent, now,
      });
      const { bound } = listener;
      show(`${LISTEN}listening on ${bound.join(', ')} (${scheme})`);
      // The token is read, and a new one made, only once this listener runs: a start whose listener is refused never
      // touches the token of the one that runs. The pre-check refused a new token without a terminal; the token can
      // have been revoked or removed since, and then none is made.
      const { state, record } = tokenState(env, now());
      if (plan.newToken || state !== 'ok') {
        if (!terminal) return await fail(NO_TERMINAL);
        showNewToken(bound);
      } else {
        show(`${LISTEN}token from ${record.created.slice(0, 10)}, expires ${record.expires.slice(0, 10)}`);
        for (const project of projects) show(`${LISTEN}${nameOf(project)}: ${projectUrl(scheme, bound, project)}`);
      }
      warn();
      warnTimer = setInterval(warn, limits.warnMs);
      warnTimer.unref();
      if (proc.stdin.isTTY) {
        typed = readline.createInterface({ input: proc.stdin, terminal: false });
        typed.on('line', onLine(bound));
      }
      return listener;
    } catch (err) {
      return fail(`cannot listen: ${err.message}`);
    }
  };

  for (const [name, handler] of handlers) proc.on(name, handler);
  for (const [name, handler] of streamErrors) proc[name].on('error', handler);
  try {
    const sessions = projects.map((project, i) => {
      const stopped = new Promise((resolve) => { stoppers.push(resolve); });
      const wrapper = wrappers[i];
      const ready = () => {
        readyCount += 1;
        if (readyCount === projects.length) wake();
      };
      return start(picked.chosen[i], withProject(env, project), {
        ...host, process: wrapper, stop: stopped, secretFiles, ready,
      }).catch((err) => {
        wrapper.stderr.write(`ksproxy: ${err.message}\n`);
        return 1;
      }).then((code) => {
        wrapper.stdout.flush();
        wrapper.stderr.flush();
        // A session that ends while no stop was asked ends on its own: the run fails, and every other one is stopped.
        if (!stopping) failed = true;
        stopAll(ANOTHER_STOPPED);
        wake();
        return code;
      });
    });
    await settled;
    if (!stopping && listen.length > 0) {
      listenerStart = openListener();
      const listener = await listenerStart;
      if (listener === null) {
        failed = true;
        stopAll(NO_LISTENER);
      }
    }
    const codes = await Promise.all(sessions);
    await closeListener();
    return !failed && codes.every((code) => code === 0) ? 0 : 1;
  } finally {
    if (typed !== null) typed.close();
    clearInterval(warnTimer);
    for (const [name, handler] of handlers) proc.off(name, handler);
    for (const [name, handler] of streamErrors) proc[name].off('error', handler);
  }
}
