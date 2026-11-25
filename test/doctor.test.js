import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vault, { control as vaultControl } from './fixtures/kind-brokered.js';
import { selfSigned } from './fixtures/self-signed.js';
import { clock, formatLogLine } from '../src/audit.js';
import { main } from '../src/cli.js';
import { KINDS, kindByKey } from '../src/kinds/index.js';
import { listenPath } from '../src/listen.js';
import {
  PROJECT_KEY, STATE_FOLDER, configDir, listenDir, logDir, rootStateDir, sessionDir, socketDir, socketPath, stateDir,
  withProject,
} from '../src/paths.js';
import { writeSession } from '../src/session.js';
import { newToken, tokenPath } from '../src/token.js';
import {
  cleanupAll, fakeProcess, freePorts, listenerTotal, makeWorld, waitFor,
} from './start-helpers.js';

const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const SSH_LOG_KEY = ['KSPROXY', 'FAKE', 'SSH', 'LOG'].join('_');
const SSH_FAIL_KEY = ['KSPROXY', 'FAKE', 'SSH', 'FAIL', 'HOST'].join('_');
const VAULT_VAR = 'VAULT_SHOP_TOKEN';
const VAULT_VALUE = 'Qshop-S3CR3T-doctor-test-value';
const NO_TERMINAL = 'a new token is shown only on a terminal: run this start once with its output on a terminal';

// What the tests steer and read back of the vault targets: a gate that holds an open, the names that wait at one, that
// were closed and checked, what each check saw, and the checks that hang.
const drill = {};
function resetDrill() {
  Object.assign(drill, {
    gates: new Map(), waiting: [], closed: [], checked: [], seen: [], hanging: [], aborted: [],
  });
  vaultControl.opened.length = 0;
}
resetDrill();

// The test-only brokered kind, with a close, the forms it hides and a doctor check that each target name steers.
KINDS.push({
  ...vault,
  async open(target, ctx) {
    const gate = drill.gates.get(target.name);
    if (gate !== undefined) {
      drill.waiting.push(target.name);
      await gate;
    }
    if (target.name === 'shut') return { ok: false, error: `denied with ${ctx.secrets[target.tokenEnv]}` };
    const opened = await vault.open(target, ctx);
    return target.name === 'noted' ? { ...opened, notes: ['a note from open'] } : opened;
  },
  closeLimit: 'vaultCloseMs',
  closeMs: 5000,
  async close(opened) {
    drill.closed.push(opened.target.name);
  },
  hiddenForms(target, secrets) {
    if (target.name === 'odd') throw new Error('no forms');
    return [`b64-${secrets[target.tokenEnv]}`];
  },
  async doctor(opened, {
    env, secrets, signal, timeoutMs,
  }) {
    const { name, tokenEnv } = opened.target;
    const token = secrets[tokenEnv];
    const { [STATE_FOLDER]: moved, ...real } = env;
    drill.checked.push(name);
    drill.seen.push({
      name,
      moved,
      state: stateDir(env),
      inside: fs.readdirSync(stateDir(env)).sort(),
      root: rootStateDir(env),
      config: configDir(env),
      realSessionThere: fs.existsSync(sessionDir(real)),
      held: Object.hasOwn(env, tokenEnv),
      signal: signal instanceof AbortSignal,
      timeoutMs,
    });
    switch (name) {
      case 'leaky':
        return { ok: false, detail: `refused ${token} as b64-${token}` };
      case 'boom':
        throw new Error(`broke with ${token}`);
      case 'thrown':
        // eslint-disable-next-line no-throw-literal
        throw 'a plain text';
      case 'nothing':
        return undefined;
      case 'shape':
        return { ok: 'yes', detail: 'not a boolean' };
      case 'long':
        return { ok: true, detail: 'y'.repeat(300) };
      case 'hang':
        drill.hanging.push(name);
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
        drill.aborted.push(name);
        return { ok: true, detail: 'too late' };
      default:
        return { ok: true, detail: `read ${Object.keys(secrets).length} secret` };
    }
  },
});

const active = new Set();
const servers = [];
after(async () => {
  for (const run of active) run.proc.emit('SIGINT');
  await Promise.allSettled([...active].map((run) => run.done));
  for (const server of servers) await new Promise((resolve) => { server.close(resolve); });
  cleanupAll();
});

function writeInventory(w, project, inventory) {
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify(inventory));
}

// An ssh server and a local folder in shop and ops, named alike, and the vault targets named in vaults.
function inventoryOf(w, who, vaults) {
  const cwd = path.join(w.base, `proj-${who}`);
  fs.mkdirSync(cwd, { recursive: true });
  return {
    ssh: [{ name: 'web1', host: `web1.${who}.example`, allow: ['uptime'] }],
    local: [{ name: 'infra', cwd, allow: ['cat *'] }],
    ...(vaults.length === 0 ? {} : { vault: vaults.map((name) => ({ name, tokenEnv: VAULT_VAR, allow: ['read *'] })) }),
  };
}

// The default inventory of makeWorld (ssh web1, then the local targets of local), and the projects shop and ops.
async function world({ vaults = ['v1'], local = [{}], kubernetes = [] } = {}) {
  resetDrill();
  const w = await makeWorld({ local, kubernetes, extraEnv: { [VAULT_VAR]: VAULT_VALUE, NO_COLOR: '1' } });
  delete w.env[PROJECT_KEY];
  w.root = w.env[STATE_KEY];
  w.sshLog = path.join(w.base, 'ssh.log');
  w.env[SSH_LOG_KEY] = w.sshLog;
  writeInventory(w, 'shop', inventoryOf(w, 'shop', vaults));
  writeInventory(w, 'ops', inventoryOf(w, 'ops', []));
  return w;
}

const projectFile = (w, project) => path.join(w.env[CONFIG_KEY], 'projects', `${project}.json`);
const stateOf = (w, project) => (project === null ? w.root : path.join(w.root, 'p', project));
const sessionFileOf = (w, project) => path.join(stateOf(w, project), 'session', 'session.json');

// A stand-in process whose stdout is a terminal.
function ttyProcess(extra = {}) {
  const proc = fakeProcess(extra);
  proc.stdout.isTTY = true;
  proc.stdout.columns = 240;
  return proc;
}

function doctorRun(args, w, host = {}) {
  const proc = host.process ?? fakeProcess();
  const run = { proc, done: main(['doctor', ...args], w.env, { ...host, process: proc }) };
  active.add(run);
  run.done.then(() => active.delete(run), () => active.delete(run));
  return run;
}

async function runDoctor(args, w, host = {}) {
  const run = doctorRun(args, w, host);
  const code = await run.done;
  return {
    code, out: run.proc.stdout.text, err: run.proc.stderr.text, proc: run.proc,
  };
}

const LINE = /^(?:\[([a-z0-9_-]+)\] )?\d\d:\d\d:\d\d (\S+) +(\S+) +(OK|FAIL|WARN|SKIPPED) +(.*)$/;

// Each line of the output as [PROJECT] KIND TARGET STATUS DETAIL, without the time and the padding; another line as it is.
function brief(text) {
  return text.split('\n').filter((line) => line !== '').map((line) => {
    const m = LINE.exec(line);
    if (m === null) return line;
    return `${m[1] === undefined ? '' : `[${m[1]}] `}${m[2]} ${m[3]} ${m[4]} ${m[5]}`;
  });
}

// The targets doctor checked, as [PROJECT] LABEL NAME, from its OK and FAIL lines of a kind.
function checkedTargets(text) {
  return text.split('\n').map((line) => LINE.exec(line)).filter((m) => m !== null && m[2] !== '--' && ['OK', 'FAIL'].includes(m[4]))
    .map((m) => `${m[1] === undefined ? '' : `[${m[1]}] `}${m[2]} ${m[3]}`);
}

const doctorFolders = (w) => (fs.existsSync(w.root) ? fs.readdirSync(w.root).filter((name) => name.startsWith('d-')) : []);
const sshCalls = (w) => (fs.existsSync(w.sshLog) ? fs.readFileSync(w.sshLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function portFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => { server.close(resolve); });
}

// Nothing of a session in the real state folder of a project: no session folder, no socket folder, no log, no
// listener file, no token, and no temporary folder left.
function assertNothingWritten(w, project = null) {
  const own = withProject(w.env, project);
  for (const dir of [sessionDir(own), socketDir(own), logDir(own)]) assert.equal(fs.existsSync(dir), false, dir);
  assert.equal(fs.existsSync(listenPath(w.env)), false, 'no listener file');
  assert.deepEqual(doctorFolders(w), []);
}

test('the state folder of a run can be moved: what is built on it follows, the root and config folders do not, no child sees it', () => {
  const env = { [STATE_KEY]: '/st', [CONFIG_KEY]: '/cfg', [PROJECT_KEY]: 'shop' };
  const moved = { ...env, [STATE_FOLDER]: '/st/doctor-x' };
  assert.equal(stateDir(env), '/st/p/shop');
  assert.equal(stateDir(moved), '/st/doctor-x');
  assert.equal(sessionDir(moved), '/st/doctor-x/session');
  assert.equal(socketDir(moved), '/st/doctor-x/s');
  assert.equal(logDir(moved), '/st/doctor-x/logs');
  assert.equal(socketPath('ssh', 'web1', moved), '/st/doctor-x/s/ssh-web1');
  assert.equal(rootStateDir(moved), '/st');
  assert.equal(configDir(moved), '/cfg');
  assert.equal(listenDir(moved), '/st/listen');
  assert.equal(withProject(moved, 'ops')[STATE_FOLDER], '/st/doctor-x', 'a copy keeps it');
  assert.deepEqual(Object.keys(moved), [STATE_KEY, CONFIG_KEY, PROJECT_KEY]);
  assert.equal(JSON.stringify(moved).includes('doctor-x'), false);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { ...moved, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(child.stdout.includes('doctor-x'), false, 'a child process never gets it');
});

test('the log format shows OK in green and FAIL in red, with two dashes for a check that is not a target', () => {
  const ts = '2026-11-24T10:00:01.000Z';
  const at = clock(ts);
  assert.equal(formatLogLine({
    ts, event: 'doctor_ok', kind: 'ssh', target: 'web1', message: 'opened',
  }), `${at} ssh  web1       OK              opened`);
  assert.equal(formatLogLine({ ts, event: 'doctor_fail', target: 'inventory', message: 'not found' }), `${at} --   inventory  FAIL            not found`);
  assert.equal(formatLogLine({ ts, event: 'doctor_ok', target: 'token', message: 'fine' }, { color: true }), `${at} --   token      \u001b[32mOK\u001b[0m              fine`);
  assert.equal(formatLogLine({ ts, event: 'doctor_fail', target: 'token', message: 'bad' }, { color: true }), `${at} --   token      \u001b[31mFAIL\u001b[0m            bad`);
});

test('doctor with no selection checks every target, each in a temporary folder that goes, and writes nothing of a session', async () => {
  const w = await world({ kubernetes: [{}] });
  const [proxyPort] = [w.kube[0].proxyPort];
  const r = await runDoctor([], w);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.err, '');
  assert.deepEqual(brief(r.out), [
    `-- inventory OK loaded ${path.join(w.env[CONFIG_KEY], 'inventory.json')}`,
    '-- session OK no session is running',
    'ssh web1 OK connected',
    'kube lab OK server v1.31.2',
    'loc infra OK folder checks passed',
    '3 of 3 targets OK',
  ]);
  assertNothingWritten(w);
  // The ssh master was made in the temporary socket folder and closed again.
  const masters = sshCalls(w).filter((argv) => argv.includes('-M'));
  assert.equal(masters.length, 1);
  const control = masters[0].find((a) => a.startsWith('ControlPath=')).slice('ControlPath='.length);
  assert.match(control, new RegExp(`^${w.root}/d-[A-Za-z0-9]{6}/s/ssh-web1$`));
  const last = sshCalls(w).filter((argv) => argv.includes(control)).at(-1);
  assert.deepEqual(last.slice(0, 4), ['-S', control, '-O', 'exit']);
  // The cluster proxy is stopped: its port is free again.
  await portFree(proxyPort);
  assert.equal(listenerTotal(r.proc), 0, 'every handler removed');
});

test('every argument form of start selects in doctor the targets that start opens', async () => {
  const w = await world();
  const forms = [
    [['--all'], [null]],
    [['--ssh', 'web1'], [null]],
    [['--project', 'shop', '--all'], ['shop']],
    [['--project=shop', '--ssh=web1', '--local', 'infra', '-v'], ['shop']],
    [['--project', 'shop', '--vault', 'v1', '--all'], ['shop']],
    [['--project', 'shop', '--local', 'infra', '--vault=v1'], ['shop']],
    [['--project', 'shop,ops', '--all'], ['shop', 'ops']],
    [['--project', 'default,ops', '--all', '--verbose'], [null, 'ops']],
  ];
  for (const [args, projects] of forms) {
    const proc = fakeProcess();
    const done = main(['start', ...args], w.env, { process: proc, limits: { followMs: 50 } });
    await waitFor(() => projects.every((p) => fs.existsSync(sessionFileOf(w, p))), 20000, `the sessions of start ${args.join(' ')}`);
    const tag = (p) => (projects.length > 1 ? `[${p ?? 'default'}] ` : '');
    const started = projects.flatMap((p) => JSON.parse(fs.readFileSync(sessionFileOf(w, p), 'utf8')).targets
      .map((t) => `${tag(p)}${kindByKey(t.kind).label} ${t.name}`));
    proc.emit('SIGINT');
    assert.equal(await done, 0, args.join(' '));
    const r = await runDoctor(args, w);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.out}`);
    assert.deepEqual(checkedTargets(r.out), started, args.join(' '));
    assert.ok(started.length > 0);
  }
  // Without a selection doctor takes every target where start would run the picker; an empty kind list selects none.
  const all = await runDoctor(['--project', 'shop'], w);
  assert.deepEqual(checkedTargets(all.out), ['ssh web1', 'loc infra', 'vlt v1']);
  const none = await runDoctor(['--project', 'shop', '--local='], w);
  assert.equal(none.code, 1);
  assert.deepEqual(brief(none.out).slice(2), ['-- targets FAIL nothing selected', '0 of 0 targets OK']);
  const unknown = await runDoctor(['--project', 'shop', '--ssh', 'nope'], w);
  assert.equal(unknown.code, 1);
  assert.deepEqual(brief(unknown.out).slice(2), ['-- targets FAIL unknown ssh target "nope"; known ssh targets: web1', '0 of 0 targets OK']);
});

test('every pre-check of start fails, one run reports them all, and the targets it can reach are still checked', async () => {
  const w = await world();
  const busy = net.createServer();
  await new Promise((resolve) => { busy.listen(0, '127.0.0.1', resolve); });
  servers.push(busy);
  const busyAt = `127.0.0.1:${busy.address().port}`;
  const opsSession = path.join(stateOf(w, 'ops'), 'session');
  writeSession(opsSession, { version: 1, pid: process.pid, targets: [] });
  const opsText = fs.readFileSync(path.join(opsSession, 'session.json'), 'utf8');
  fs.mkdirSync(listenDir(w.env), { recursive: true });
  fs.writeFileSync(listenPath(w.env), JSON.stringify({ version: 1, pid: process.ppid }));
  fs.writeFileSync(tokenPath(w.env), 'not a token file');
  const key = path.join(w.base, 'key.pem');
  fs.writeFileSync(key, 'not a key');
  const cert = path.join(w.base, 'missing-cert.pem');
  const r = await runDoctor([
    '--project', 'shop,nope,ops', '--all', '--listen', '192.0.2.10:7443', '--listen', busyAt, '--tls-cert', cert, '--tls-key', key,
  ], w);
  assert.equal(r.code, 1);
  const missing = projectFile(w, 'nope');
  assert.deepEqual(brief(r.out), [
    `[shop] -- inventory OK loaded ${projectFile(w, 'shop')}`,
    `[nope] -- inventory FAIL inventory not found: ${missing}; run: ksproxy init --project nope`,
    `[ops] -- inventory OK loaded ${projectFile(w, 'ops')}`,
    '[shop] -- session OK no session is running',
    '[nope] -- session OK no session is running',
    `[ops] -- session FAIL a session of project ops is running (pid ${process.pid}): start would stop here; see ksproxy status`,
    '-- listen FAIL --listen: 192.0.2.10 is not a loopback or private address of this machine',
    `-- listen FAIL cannot listen on ${busyAt}: listen EADDRINUSE: address already in use ${busyAt}`,
    `-- tls FAIL --tls-cert: cannot read ${cert}`,
    `-- listener FAIL another ksproxy start is listening (pid ${process.ppid})`,
    `-- token FAIL cannot read ${tokenPath(w.env)}: start with --new-token to replace it`,
    '[shop] ssh web1 OK connected',
    '[shop] loc infra OK folder checks passed',
    '[shop] vlt v1 OK read 1 secret',
    '3 of 3 targets OK',
  ]);
  // The running session, the listener and the token are left as they were, and nothing of ops was opened.
  assert.equal(fs.readFileSync(path.join(opsSession, 'session.json'), 'utf8'), opsText);
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), 'not a token file');
  assert.equal(JSON.parse(fs.readFileSync(listenPath(w.env), 'utf8')).pid, process.ppid);
  assert.equal(sshCalls(w).some((argv) => argv.includes('web1.ops.example')), false);
  assert.equal(busy.listening, true);
  assert.deepEqual(doctorFolders(w), []);
  // The TLS pair must also make a context together.
  fs.writeFileSync(cert, 'not a certificate');
  const pair = await runDoctor(['--project', 'ops', '--local', 'infra', '--listen', '192.0.2.10:7443', '--tls-cert', cert, '--tls-key', key], w);
  assert.match(pair.out, /--   tls +FAIL +--tls-cert and --tls-key cannot be used together: /);
});

test('a running session of one project: that project fails and opens nothing, the other one is checked', async () => {
  const w = await world({ vaults: [] });
  writeSession(path.join(stateOf(w, 'ops'), 'session'), { version: 1, pid: process.pid, targets: [] });
  const r = await runDoctor(['--project', 'shop,ops', '--all'], w);
  assert.equal(r.code, 1);
  assert.deepEqual(brief(r.out).slice(2), [
    '[shop] -- session OK no session is running',
    `[ops] -- session FAIL a session of project ops is running (pid ${process.pid}): start would stop here; see ksproxy status`,
    '[shop] ssh web1 OK connected',
    '[shop] loc infra OK folder checks passed',
    '2 of 2 targets OK',
  ]);
  assert.deepEqual(sshCalls(w).filter((argv) => argv.includes('-M')).map((argv) => argv.at(-1)), ['web1.shop.example']);
});

test('--listen: each address is bound for a moment and closed, the TLS pair is read, and no token or listener file is made', async () => {
  const w = await world({ vaults: [] });
  const [port] = await freePorts(1);
  const at = `127.0.0.1:${port}`;
  const pair = selfSigned('localhost');
  const cert = path.join(w.base, 'cert.pem');
  const key = path.join(w.base, 'key.pem');
  fs.writeFileSync(cert, pair.cert);
  fs.writeFileSync(key, pair.key);
  const listenLines = (r) => brief(r.out).filter((line) => /^-- (?:listen|tls|listener|token) /.test(line));
  const first = await runDoctor(['--project', 'ops', '--all', '--listen', at, '--tls-cert', cert, '--tls-key', key], w, { process: ttyProcess() });
  assert.equal(first.code, 0, first.out);
  assert.deepEqual(listenLines(first), [
    `-- listen OK ${at}`,
    '-- tls OK the certificate and the key work together',
    '-- listener OK no other listener is running',
    '-- token OK start would make a new token',
  ]);
  assert.equal(brief(first.out).at(-1), '2 of 2 targets OK');
  await portFree(port);
  assert.equal(fs.existsSync(tokenPath(w.env)), false, 'no token is made');
  assert.equal(fs.existsSync(listenPath(w.env)), false, 'no listener file is made');

  // With a token: it can be used, and --new-token is accepted and changes nothing.
  newToken(w.env);
  const tokenText = fs.readFileSync(tokenPath(w.env), 'utf8');
  const kept = await runDoctor(['--project', 'ops', '--listen', at], w);
  assert.equal(kept.code, 0, kept.out);
  assert.deepEqual(listenLines(kept), [`-- listen OK ${at}`, '-- listener OK no other listener is running', '-- token OK the token can be used']);
  const renewed = await runDoctor(['--project', 'ops', '--listen', at, '--new-token'], w, { process: ttyProcess() });
  assert.equal(renewed.code, 0);
  assert.equal(listenLines(renewed).at(-1), '-- token OK start would make a new token');
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), tokenText, 'the token is unchanged');
  // A new token while stdout is not a terminal is what start refuses.
  const piped = await runDoctor(['--project', 'ops', '--listen', at, '--new-token'], w);
  assert.equal(piped.code, 1);
  assert.equal(listenLines(piped).at(-1), `-- token FAIL ${NO_TERMINAL}`);

  // The TLS key file is protected as start protects it: a local folder that holds it is refused.
  fs.renameSync(key, path.join(w.base, 'proj-ops', 'key.pem'));
  const inside = path.join(w.base, 'proj-ops', 'key.pem');
  const guarded = await runDoctor(['--project', 'ops', '--local', 'infra', '--listen', at, '--tls-cert', cert, '--tls-key', inside], w);
  assert.equal(guarded.code, 1);
  assert.deepEqual(brief(guarded.out).slice(-3), [
    'loc infra SKIPPED folder contains a kubeconfig named in the inventory',
    'loc infra FAIL folder contains a kubeconfig named in the inventory',
    '0 of 1 targets OK',
  ]);
  assertNothingWritten(w, 'ops');
});

test('target names: one name, a name of two kinds, names with a kind flag, an unknown name, and names with several projects', async () => {
  const w = await world({ local: [{}, { name: 'web1' }] });
  const names = async (args) => checkedTargets((await runDoctor(args, w)).out);
  assert.deepEqual(await names(['infra']), ['loc infra']);
  assert.deepEqual(await names(['web1']), ['ssh web1', 'loc web1']);
  assert.deepEqual(await names(['--ssh', 'web1', 'infra']), ['ssh web1', 'loc infra']);
  assert.deepEqual(await names(['--local=infra', 'web1']), ['ssh web1', 'loc infra', 'loc web1']);
  assert.deepEqual(await names(['--all', 'infra']), ['ssh web1', 'loc infra', 'loc web1']);
  assert.deepEqual(await names(['--project', 'shop', 'v1', 'web1']), ['ssh web1', 'vlt v1']);

  const unknown = await runDoctor(['infra', 'nope'], w);
  assert.equal(unknown.code, 1);
  assert.deepEqual(brief(unknown.out).slice(2), ['-- targets FAIL unknown target "nope"; known targets: web1, infra', '0 of 0 targets OK']);
  assert.equal(sshCalls(w).filter((argv) => argv.includes('-M')).length, 5, 'nothing opened for the unknown name');
  writeInventory(w, 'empty', {});
  const empty = await runDoctor(['--project', 'empty', 'web1'], w);
  assert.deepEqual(brief(empty.out).slice(2), ['-- targets FAIL unknown target "web1"; known targets: none', '0 of 0 targets OK']);

  const several = await runDoctor(['--project', 'shop,ops', 'web1'], w);
  assert.equal(several.code, 2);
  assert.equal(several.out, '');
  assert.match(several.err, /^target names belong to one project; use them with a single --project\nUsage: ksproxy <command>/);
});

test('a target that cannot open: the SKIPPED line of start, then FAIL, and the next targets are still checked', async () => {
  const w = await world();
  w.env[SSH_FAIL_KEY] = 'web1.shop.example';
  delete w.env[VAULT_VAR];
  writeInventory(w, 'shop', {
    ...inventoryOf(w, 'shop', ['v1']),
    local: [{ name: 'infra', cwd: path.join(w.base, 'proj-shop'), allow: [] }],
  });
  const r = await runDoctor(['--project', 'shop'], w);
  assert.equal(r.code, 1);
  assert.deepEqual(brief(r.out).slice(2), [
    'ssh web1 SKIPPED ssh exited with code 255',
    'ssh web1 FAIL ssh exited with code 255',
    'loc infra WARN allowlist is empty, every command will be refused',
    'loc infra OK folder checks passed',
    `vlt v1 SKIPPED ${VAULT_VAR} is not set`,
    `vlt v1 FAIL ${VAULT_VAR} is not set`,
    '1 of 3 targets OK',
  ]);
  assertNothingWritten(w, 'shop');
});

test('the doctor check of a kind: its detail, a failure, a throw, no result, the time limit, and no secret in any line', async () => {
  const vaults = ['v1', 'leaky', 'boom', 'thrown', 'nothing', 'shape', 'hang', 'shut', 'odd', 'long'];
  const w = await world({ vaults });
  const r = await runDoctor(['--project', 'shop', '--vault', vaults.join(',')], w, { limits: { checkMs: 300 } });
  assert.equal(r.code, 1);
  assert.deepEqual(brief(r.out).slice(2), [
    'vlt v1 OK read 1 secret',
    'vlt leaky FAIL refused [hidden] as [hidden]',
    'vlt boom FAIL the check failed',
    'vlt thrown FAIL the check failed',
    'vlt nothing FAIL the check failed',
    'vlt shape FAIL the check failed',
    'vlt hang FAIL the check did not finish within 0.3 seconds',
    'vlt shut SKIPPED denied with [hidden]',
    'vlt shut FAIL denied with [hidden]',
    'vlt odd OK read 1 secret',
    `vlt long OK ${'y'.repeat(199)}…`,
    '3 of 10 targets OK',
  ]);
  assert.equal(`${r.out}${r.err}`.includes(VAULT_VALUE), false);
  assert.deepEqual(drill.closed, vaults.filter((name) => name !== 'shut'), 'each opened target is closed, after its check');
  assert.deepEqual(drill.checked, drill.closed, 'a check only for a target that opened');
  assert.deepEqual(drill.aborted, ['hang'], 'the signal fires at the time limit');
  // The check ran in the temporary state folder, with the real root and config folders, and no credential in env.
  for (const seen of drill.seen) {
    assert.match(seen.moved, new RegExp(`^${w.root}/d-[A-Za-z0-9]{6}$`));
    assert.equal(seen.state, seen.moved);
    assert.deepEqual(seen.inside, ['owner.json', 's', 'session']);
    assert.equal(seen.root, w.root);
    assert.equal(seen.config, w.env[CONFIG_KEY]);
    assert.equal(seen.realSessionThere, false);
    assert.equal(seen.held, false);
    assert.equal(seen.signal, true);
    assert.equal(seen.timeoutMs, 300);
  }
  assertNothingWritten(w, 'shop');
});

test('Ctrl-C while a check runs: that target is closed, nothing more opens, the temporary folder goes, exit 1', async () => {
  const w = await world({ vaults: ['hang', 'v2'] });
  const run = doctorRun(['--project', 'shop,ops', '--all'], w);
  await waitFor(() => drill.hanging.length > 0, 20000, 'the check to hang');
  assert.equal(doctorFolders(w).length, 1, 'the temporary folder is there while the target is open');
  run.proc.emit('SIGINT');
  run.proc.emit('SIGTERM');
  assert.equal(await run.done, 1);
  assert.deepEqual(brief(run.proc.stdout.text).slice(4), [
    '[shop] ssh web1 OK connected',
    '[shop] loc infra OK folder checks passed',
    '-- doctor FAIL stopped: Ctrl-C',
    '2 of 4 targets OK',
  ], 'the first reason is kept, and ops is not reached');
  assert.equal(sshCalls(w).some((argv) => argv.includes('web1.ops.example')), false);
  assert.deepEqual(drill.closed, ['hang']);
  await waitFor(() => drill.aborted.includes('hang'), 5000, 'the signal of the check to fire');
  assert.equal(drill.seen[0].timeoutMs, 30000, 'a check has 30 seconds');
  assert.deepEqual(vaultControl.opened.map((o) => o.name), ['hang'], 'v2 is not opened');
  assertNothingWritten(w, 'shop');
  assert.equal(listenerTotal(run.proc), 0);
});

test('Ctrl-C while a target opens: it is closed once open gives its result, and no check runs', async () => {
  const w = await world({ vaults: ['slow', 'v2'] });
  let release;
  drill.gates.set('slow', new Promise((resolve) => { release = resolve; }));
  const run = doctorRun(['--project', 'shop', '--vault', 'slow,v2'], w);
  await waitFor(() => drill.waiting.includes('slow'), 20000, 'the open to wait');
  run.proc.emit('SIGINT');
  release();
  assert.equal(await run.done, 1);
  assert.deepEqual(drill.closed, ['slow']);
  assert.deepEqual(drill.checked, []);
  assert.deepEqual(brief(run.proc.stdout.text).slice(2), ['-- doctor FAIL stopped: Ctrl-C', '0 of 2 targets OK']);
  assertNothingWritten(w, 'shop');
});

test('the other ways to stop: a signal before any target, a fatal error, a closed output', async () => {
  const w = await world({ vaults: ['hang', 'noted'] });
  const early = doctorRun(['--project', 'shop'], w);
  early.proc.emit('SIGTERM');
  assert.equal(await early.done, 1);
  // The stop comes while doctor cleans up after a killed doctor, before any project is reached: no target is counted.
  assert.deepEqual(brief(early.proc.stdout.text).slice(2), ['-- doctor FAIL stopped: terminated', '0 of 0 targets OK']);
  assert.deepEqual(sshCalls(w), [], 'nothing opened');

  for (const [name, value, text] of [
    ['SIGHUP', undefined, 'terminal closed'],
    ['uncaughtException', new Error('kaput'), 'error: kaput'],
    ['unhandledRejection', 'plain reason', 'error: plain reason'],
  ]) {
    resetDrill();
    const run = doctorRun(['--project', 'shop', '--vault', 'hang'], w);
    await waitFor(() => drill.hanging.length > 0, 20000, 'the check to hang');
    run.proc.emit(name, value);
    assert.equal(await run.done, 1, name);
    assert.equal(brief(run.proc.stdout.text).at(-2), `-- doctor FAIL stopped: ${text}`);
    assert.deepEqual(drill.closed, ['hang'], name);
    assert.equal(listenerTotal(run.proc), 0);
  }

  // An error of stdout stops the run; nothing more is written.
  resetDrill();
  const broken = doctorRun(['--project', 'shop', '--vault', 'hang'], w);
  await waitFor(() => drill.hanging.length > 0, 20000, 'the check to hang');
  const before = broken.proc.stdout.text;
  broken.proc.stdout.emit('error', new Error('EPIPE'));
  assert.equal(await broken.done, 1);
  assert.equal(broken.proc.stdout.text, before);
  assert.deepEqual(drill.closed, ['hang']);

  // A write that throws stops the run too: here on the note of an opened target, which is then closed unchecked.
  resetDrill();
  const proc = fakeProcess();
  const write = proc.stdout.write;
  proc.stdout.write = (text) => {
    if (text.includes('a note from open')) throw new Error('closed');
    return write(text);
  };
  const noted = await runDoctor(['--project', 'shop', '--vault', 'noted'], w, { process: proc });
  assert.equal(noted.code, 1);
  assert.deepEqual(drill.closed, ['noted']);
  assert.deepEqual(drill.checked, []);
  assert.equal(noted.out.includes('stopped'), false);
  assertNothingWritten(w, 'shop');
});

test('the socket paths: a path of start over its limit is reported, and one of the temporary folder stops that project', async () => {
  const w = await world({ vaults: [] });
  const project = 'abcdefghijklmnopqrstuvwx';
  writeInventory(w, project, { ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['uptime'] }] });
  // The ssh socket of start, root/p/NAME/s/ssh-web1, is over 83 bytes; the temporary one, root/d-XXXXXX/s/ssh-web1, is not.
  const rootOf = (length) => path.join(w.base, 'x'.repeat(length - w.base.length - 1));
  w.env[STATE_KEY] = rootOf(52);
  w.root = w.env[STATE_KEY];
  const real = path.join(w.root, 'p', project, 's', 'ssh-web1');
  const r = await runDoctor(['--project', project], w);
  assert.equal(r.code, 1);
  assert.deepEqual(brief(r.out).slice(2), [
    `-- sockets FAIL socket path too long (${Buffer.byteLength(real)} bytes, limit 83): ${real}; set KSPROXY_STATE_DIR to a shorter directory or use a shorter project name`,
    'ssh web1 OK connected',
    '1 of 1 targets OK',
  ]);
  // With a longer root the temporary path is over the limit too: nothing of that project opens.
  w.env[STATE_KEY] = rootOf(70);
  w.root = w.env[STATE_KEY];
  const longer = await runDoctor(['--project', project], w);
  assert.equal(longer.code, 1);
  const lines = brief(longer.out).slice(2);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^-- sockets FAIL socket path too long \(\d+ bytes, limit 83\): .*\/p\/abcdefghijklmnopqrstuvwx\/s\/ssh-web1; /);
  assert.match(lines[1], new RegExp(`^-- sockets FAIL socket path too long \\(\\d+ bytes, limit 83\\): ${w.root}/d-[^/]+/s/ssh-web1; `));
  assert.equal(lines[2], '0 of 1 targets OK');
  assert.deepEqual(doctorFolders(w), []);
  assert.deepEqual(sshCalls(w).filter((argv) => argv.includes('-M')).length, 1);
});

test('the command line: start\'s usage errors, exit 2, and the doctor line of the usage', async () => {
  const w = await world();
  for (const [args, message] of [
    [['--bogus'], 'unknown option for doctor: --bogus'],
    [['--tls-cert', 'x'], '--new-token, --tls-cert and --tls-key work only with --listen'],
    [['--listen', '127.0.0.1:1', '--tls-key', 'x'], '--tls-cert and --tls-key go together'],
    [['--project', 'shop,ops', '--ssh', 'web1'], '--ssh names targets of one project; use it with a single --project'],
    [['--project', 'shop,shop'], '--project names shop twice'],
    [['--ssh'], '--ssh needs a comma-separated list of names'],
  ]) {
    const r = await runDoctor(args, w);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.out, '');
    assert.ok(r.err.startsWith(`${message}\nUsage: ksproxy <command>`), r.err);
  }
  const start = fakeProcess();
  assert.equal(await main(['start', 'web1'], w.env, { process: start }), 2);
  assert.ok(start.stderr.text.startsWith('unknown option for start: web1\n'), 'a plain word is still refused by start');
  const help = fakeProcess();
  assert.equal(await main(['--help'], w.env, { process: help }), 0);
  assert.match(help.stdout.text, /\n {2}doctor \.\.\. \[NAME\.\.\.\] +check each target start \.\.\. would open, then close it\n/);
  assertNothingWritten(w);
});

test('a kind without a doctor check is OK once its target opens', async () => {
  // Every kind of this repository has a check; take the local kind's away for this test only.
  const local = kindByKey('local');
  const check = local.doctor;
  delete local.doctor;
  try {
    const w = await world({ vaults: [] });
    const r = await runDoctor(['infra'], w);
    assert.equal(r.code, 0, r.out + r.err);
    assert.ok(brief(r.out).includes('loc infra OK opened'), r.out);
  } finally {
    local.doctor = check;
  }
});
