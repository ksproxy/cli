import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vault from './fixtures/kind-brokered.js';
import { selfSigned } from './fixtures/self-signed.js';
import { KINDS } from '../src/kinds/index.js';
import { main, takeProject } from '../src/cli.js';
import { listenPath } from '../src/listen.js';
import {
  PROJECT_KEY, PROJECT_RULE, listenDir, withProject,
} from '../src/paths.js';
import { writeSession } from '../src/session.js';
import {
  LineStream, projectUrl, servedEnvs, startMany, wrapProcess,
} from '../src/start-many.js';
import {
  newToken, revokeToken, tokenPath, tokenState,
} from '../src/token.js';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, fakeProcess, freePorts, listenerTotal, makeStream, makeWorld, waitFor,
} from './start-helpers.js';

KINDS.push(vault);

const BIN = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const HEALTH_KEY = ['KSPROXY', 'HEALTH', 'MS'].join('_');
const VAULT_VAR = 'VAULT_SHOP_TOKEN';
const VAULT_VALUE = 'Qshop-S3CR3T-many-test-value';
const REVIEW_VAR = 'OPS_REVIEW_KEY';
const DAY_MS = 24 * 60 * 60 * 1000;
const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent', version: '1.0' } },
};
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

const active = new Set();
const children = new Set();
const servers = [];
after(async () => {
  for (const run of active) run.proc.emit('SIGINT');
  await Promise.allSettled([...active].map((run) => run.done));
  for (const child of children) child.kill('SIGKILL');
  for (const server of servers) await new Promise((resolve) => { server.close(resolve); });
  cleanupAll();
});

function writeInventory(w, project, inventory) {
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify(inventory));
}

// An ssh server and a local folder in shop and ops, named alike, and a vault target in shop only.
function inventoryOf(w, who, withVault) {
  const cwd = path.join(w.base, `proj-${who}`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'who.txt'), `${who} files\n`);
  return {
    ssh: [{
      name: 'web1', host: `web1.${who}.example`, description: `${who} web box`, allow: ['uptime', 'cat *'],
    }],
    local: [{
      name: 'infra', cwd, description: `${who} repo`, allow: ['cat *'],
    }],
    ...(who === 'shop' && withVault ? {
      vault: [{
        name: 'v1', tokenEnv: VAULT_VAR, description: 'shop vault', allow: ['read *'],
      }],
    } : {}),
  };
}

// The world of the projects tests: the default inventory of makeWorld, and shop and ops, in one config folder.
async function world({ withVault = true } = {}) {
  // NO_COLOR: a stdout that is a terminal prints the lines of the sessions as they are printed elsewhere.
  const w = await makeWorld({ extraEnv: { [HEALTH_KEY]: '60000', [VAULT_VAR]: VAULT_VALUE, NO_COLOR: '1' } });
  delete w.env[PROJECT_KEY];
  w.root = w.env[STATE_KEY];
  for (const who of ['shop', 'ops']) writeInventory(w, who, inventoryOf(w, who, withVault));
  return w;
}

// A stand-in process whose stdout is a terminal: a new token is shown only there.
function ttyProcess(extra = {}) {
  const proc = fakeProcess(extra);
  proc.stdout.isTTY = true;
  proc.stdout.columns = 240;
  return proc;
}

const stateOf = (w, project) => (project === null ? w.root : path.join(w.root, 'p', project));
const sessionFileOf = (w, project) => path.join(stateOf(w, project), 'session', 'session.json');

// ksproxy start with the words given, in this process, through main.
function startRun(args, w, host = {}) {
  const proc = host.process ?? fakeProcess();
  const run = {
    proc,
    done: main(['start', ...args], w.env, { limits: { followMs: 50 }, ...host, process: proc }),
  };
  active.add(run);
  run.done.then(() => active.delete(run), () => active.delete(run));
  return run;
}

const tag = (name) => (name === '' ? '' : `[${name}] `);

async function allReady(run, names) {
  await waitFor(() => names.every((name) => run.proc.stdout.text.includes(`${tag(name)}Leave this running`)), 20000, 'every session to be ready');
}

async function listening(run) {
  await waitFor(() => /^\[listen\] (?:token from|a new token)/m.test(run.proc.stdout.text), 20000, 'the listener lines');
  await waitFor(() => !run.proc.stdout.text.endsWith('[listen] a new token was made; it is shown only now\n'), 5000, 'the client lines');
}

const linesOf = (text) => text.split('\n').filter((line) => line !== '');
// The lines startMany prints itself: those of no session.
const ownLines = (text) => linesOf(text).filter((line) => !/^\[(?:default|shop|ops)\] /.test(line));
const tokensIn = (text) => [...text.matchAll(/Bearer (ksp_[A-Za-z0-9_-]{43})"/g)].map((m) => m[1]);
const count = (text, part) => text.split(part).length - 1;

// One HTTP request with no connection reuse: the status and the body as text.
function send(port, {
  target = '/mcp', headers = {}, body, tls,
} = {}) {
  return new Promise((resolve, reject) => {
    const lib = tls === undefined ? http : https;
    const req = lib.request({
      host: '127.0.0.1', port, method: 'POST', path: target, headers, agent: false, ...tls,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function rpc(port, token, message, { target = '/mcp', tls } = {}) {
  return send(port, {
    target, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(message), tls,
  });
}

async function callText(port, token, project, name, args, tls) {
  const answer = await rpc(port, token, {
    jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args },
  }, { target: `/p/${project}/mcp`, tls });
  assert.equal(answer.status, 200, answer.body);
  return JSON.parse(answer.body).result.content[0].text;
}

async function portFree(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => { server.close(resolve); });
}

test('LineStream: whole lines with the prefix, a partial line waits, flush ends it, columns less the prefix, errors passed on', () => {
  const real = makeStream();
  const stream = new LineStream(real, '[shop] ');
  assert.equal(stream.write('one\ntw'), true);
  assert.equal(real.text, '[shop] one\n');
  stream.write('o');
  assert.equal(real.text, '[shop] one\n');
  stream.write('\nthree\n\n');
  assert.equal(real.text, '[shop] one\n[shop] two\n[shop] three\n[shop] \n');
  stream.flush();
  assert.equal(real.text, '[shop] one\n[shop] two\n[shop] three\n[shop] \n', 'nothing waits');
  stream.write('last');
  stream.flush();
  assert.equal(real.text.endsWith('[shop] last\n'), true);

  assert.equal(stream.isTTY, false);
  assert.equal(stream.columns, undefined);
  real.isTTY = true;
  real.columns = 100;
  assert.equal(stream.isTTY, true);
  assert.equal(stream.columns, 93);
  assert.equal(new LineStream(real, '').columns, 100);

  // An error with no listener left is dropped; a listener gets it.
  stream.fail(new Error('gone'));
  const seen = [];
  stream.on('error', (err) => seen.push(err.message));
  stream.fail(new Error('gone'));
  assert.deepEqual(seen, ['gone']);
});

test('wrapProcess: its own events, the two prefixed streams and the real stdin, pid and execPath', () => {
  const real = fakeProcess({ pid: 4242, execPath: '/usr/bin/node-x' });
  const proc = wrapProcess(real, '[ops] ');
  let signals = 0;
  proc.on('SIGINT', () => { signals += 1; });
  real.emit('SIGINT');
  assert.equal(signals, 0, 'a signal of the real process reaches it only through startMany');
  proc.emit('SIGINT');
  assert.equal(signals, 1);
  proc.stderr.write('hello\n');
  assert.equal(real.stderr.text, '[ops] hello\n');
  assert.equal(proc.stdin, real.stdin);
  assert.equal(proc.pid, 4242);
  assert.equal(proc.execPath, '/usr/bin/node-x');
});

test('projectUrl: /mcp for the default, /p/NAME/mcp for a project, on the first address without a zone, else with %25', () => {
  assert.equal(projectUrl('http', ['192.168.1.20:7443'], 'shop'), 'http://192.168.1.20:7443/p/shop/mcp');
  assert.equal(projectUrl('https', ['192.168.1.20:7443', '127.0.0.1:7443'], null), 'https://192.168.1.20:7443/mcp');
  assert.equal(projectUrl('http', ['[fe80::1%en0]:7443', '[fd00::5]:7443'], 'ops'), 'http://[fd00::5]:7443/p/ops/mcp');
  assert.equal(projectUrl('http', ['[fe80::1%en0]:7443', '[fe80::2%en1]:7443'], 'ops'), 'http://[fe80::1%25en0]:7443/p/ops/mcp');
});

test('servedEnvs: each project with the env less every credential variable of every listed project', () => {
  const env = {
    PATH: '/bin', [VAULT_VAR]: 'a', [REVIEW_VAR]: 'b', OTHER: 'kept', [PROJECT_KEY]: 'old',
  };
  const shop = { reviewers: {}, vault: [{ tokenEnv: VAULT_VAR }] };
  const ops = { reviewers: { r1: { keyEnv: REVIEW_VAR } }, vault: [] };
  for (const kind of KINDS) {
    shop[kind.key] ??= [];
    ops[kind.key] ??= [];
  }
  const served = servedEnvs(['shop', null, 'ops'], [shop, { reviewers: {}, ...Object.fromEntries(KINDS.map((k) => [k.key, []])) }, ops], env);
  assert.deepEqual([...served.keys()], ['shop', null, 'ops']);
  assert.deepEqual(served.get('shop'), { PATH: '/bin', OTHER: 'kept', [PROJECT_KEY]: 'shop' });
  assert.deepEqual(served.get(null), { PATH: '/bin', OTHER: 'kept' });
  assert.deepEqual(served.get('ops'), { PATH: '/bin', OTHER: 'kept', [PROJECT_KEY]: 'ops' });
  assert.equal(env[VAULT_VAR], 'a', 'the env of start is left as it is');
});

test('takeProject: a list only for start, default as no project, a name twice refused', () => {
  assert.deepEqual(takeProject(['--project', 'shop,default,ops', '--all'], { list: true }), {
    project: 'shop', projects: ['shop', null, 'ops'], rest: ['--all'],
  });
  assert.deepEqual(takeProject([], { list: true }), { project: null, projects: [null], rest: [] });
  assert.deepEqual(takeProject(['--project=shop'], { list: true }), { project: 'shop', projects: ['shop'], rest: [] });
  assert.deepEqual(takeProject(['--project', 'shop,ops']), { error: 'a list of projects works only with start' });
  assert.deepEqual(takeProject(['--project', 'shop,shop'], { list: true }), { error: '--project names shop twice' });
  assert.deepEqual(takeProject(['--project', 'default,ops,default'], { list: true }), { error: '--project names default twice' });
  assert.deepEqual(takeProject(['--project', 'shop,'], { list: true }), { error: PROJECT_RULE });
  assert.deepEqual(takeProject(['--project', 'shop,Ops'], { list: true }), { error: PROJECT_RULE });
});

test('the command line: lists, the listen options and the kind flags of several projects, each a usage error', async () => {
  const cases = [
    [['start', '--project', 'shop,shop'], '--project names shop twice'],
    [['start', '--project=default,default', '--all'], '--project names default twice'],
    [['start', '--project', 'shop,'], PROJECT_RULE],
    [['status', '--project', 'shop,ops'], 'a list of projects works only with start'],
    [['log', '--project=shop,ops'], 'a list of projects works only with start'],
    [['init', '--project', 'shop,ops'], 'a list of projects works only with start'],
    [['mcp', '--project', 'shop,ops'], 'a list of projects works only with start'],
    [['check', '--project', 'shop,ops', 'ssh', 'web1', 'uptime'], 'a list of projects works only with start'],
    [['start', '--project', 'shop,ops', '--ssh', 'web1'], '--ssh names targets of one project; use it with a single --project'],
    [['start', '--project', 'shop,ops', '--all', '--vault='], '--vault names targets of one project; use it with a single --project'],
    [['start', '--new-token'], '--new-token, --tls-cert and --tls-key work only with --listen'],
    [['start', '--tls-cert', 'c.pem', '--tls-key', 'k.pem'], '--new-token, --tls-cert and --tls-key work only with --listen'],
    [['start', '--listen', '127.0.0.1:7443', '--tls-cert', 'c.pem'], '--tls-cert and --tls-key go together'],
    [['start', '--listen=127.0.0.1:7443', '--tls-key=k.pem'], '--tls-cert and --tls-key go together'],
    [['start', '--listen'], '--listen needs HOST:PORT'],
    [['start', '--listen='], '--listen needs HOST:PORT'],
    [['start', '--listen', '127.0.0.1:7443', '--tls-cert'], '--tls-cert needs a file'],
    [['start', '--listen', '127.0.0.1:7443', '--tls-key='], '--tls-key needs a file'],
    [['start', '--listen', '127.0.0.1:7443', '--tls-cert', 'a', '--tls-cert=b'], '--tls-cert given twice'],
  ];
  for (const [argv, message] of cases) {
    const proc = fakeProcess();
    assert.equal(await main(argv, {}, { process: proc }), 2, argv.join(' '));
    assert.ok(proc.stderr.text.startsWith(`${message}\nUsage: ksproxy <command>`), proc.stderr.text);
    assert.equal(proc.stdout.text, '');
  }
});

test('the usage names the two forms of start with a list of projects and with the listener', async () => {
  const proc = fakeProcess();
  assert.equal(await main(['--help'], {}, { process: proc }), 0);
  assert.ok(proc.stdout.text.includes([
    'pick targets, open them, stay in the foreground',
    '  start ... --project a,b                   run several projects in one start',
    '  start ... --listen HOST:PORT [--new-token] [--tls-cert FILE --tls-key FILE]',
    `${' '.repeat(44)}serve its projects over HTTP on the local network`,
  ].join('\n')), proc.stdout.text);
});

test('three projects with --all: every line carries its project, each session reaches only its own targets, Ctrl-C stops all with 0', async () => {
  const w = await world();
  const run = startRun(['--project', 'default,shop,ops', '--all'], w);
  await allReady(run, ['default', 'shop', 'ops']);
  const expected = {
    default: ['ssh:web1:web box'],
    shop: ['ssh:web1:shop web box', 'local:infra:shop repo', 'vault:v1:shop vault'],
    ops: ['ssh:web1:ops web box', 'local:infra:ops repo'],
  };
  for (const [name, targets] of Object.entries(expected)) {
    const project = name === 'default' ? null : name;
    const listed = await callTool('list_targets', {}, withProject(w.env, project));
    assert.deepEqual(JSON.parse(listed.text).targets.map((t) => `${t.kind}:${t.name}:${t.description}`), targets);
    assert.equal(JSON.parse(fs.readFileSync(sessionFileOf(w, project), 'utf8')).pid, process.pid);
  }
  const local = await callTool('local_exec', { target: 'infra', command: 'cat who.txt' }, withProject(w.env, 'ops'));
  assert.equal(local.text, 'exit code: 0\n--- stdout ---\nops files');
  await waitFor(() => /^\[ops\] \d\d:\d\d:\d\d loc +infra .*cat who\.txt/m.test(run.proc.stdout.text), 10000, 'the call line of ops');
  for (const line of linesOf(run.proc.stdout.text + run.proc.stderr.text)) assert.match(line, /^\[(?:default|shop|ops)\] /);
  assert.equal(ownLines(run.proc.stdout.text).length, 0, 'no listener without --listen');

  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  for (const name of ['default', 'shop', 'ops']) {
    assert.match(run.proc.stderr.text, new RegExp(`^\\[${name}\\] .*CLOSING +Ctrl-C$`, 'm'));
    assert.match(run.proc.stderr.text, new RegExp(`^\\[${name}\\] .*CLOSED +`, 'm'));
    assert.equal(fs.existsSync(sessionFileOf(w, name === 'default' ? null : name)), false);
  }
  assert.equal(listenerTotal(run.proc), 0);
});

test('a session that cannot open stops the others before the listener starts: exit 1', async () => {
  const w = await world();
  writeInventory(w, 'ops', { local: [{ name: 'gone', cwd: path.join(w.base, 'missing'), allow: ['cat *'] }] });
  const [port] = await freePorts(1);
  const run = startRun(['--project', 'shop,ops', '--all', '--listen', `127.0.0.1:${port}`], w, { process: ttyProcess() });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /^\[ops\] nothing could be opened$/m);
  assert.match(run.proc.stderr.text, /^\[shop\] .*CLOSING +another project stopped$/m);
  assert.deepEqual(ownLines(run.proc.stdout.text), []);
  assert.equal(fs.existsSync(listenPath(w.env)), false);
  assert.equal(fs.existsSync(tokenPath(w.env)), false, 'no token is made');
  assert.equal(fs.existsSync(sessionFileOf(w, 'shop')), false);
  assert.equal(listenerTotal(run.proc), 0);
});

test('one token serves both projects: the lines, calls through each URL, the events, and Ctrl-C closes the listener before the sessions', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const at = `127.0.0.1:${port}`;
  const proc = ttyProcess();
  const listenFileAtClosing = [];
  proc.stderr.onWrite = (text) => {
    if (text.includes('CLOSING')) listenFileAtClosing.push(fs.existsSync(listenPath(w.env)));
  };
  const run = startRun(['--project', 'shop,ops', '--all', '--listen', at], w, { process: proc });
  await listening(run);
  const [token] = tokensIn(proc.stdout.text);
  assert.deepEqual(ownLines(proc.stdout.text), [
    `[listen] listening on ${at} (http)`,
    '[listen] a new token was made; it is shown only now',
    `claude mcp add --transport http ksproxy-shop http://${at}/p/shop/mcp --header "Authorization: Bearer ${token}"`,
    `claude mcp add --transport http ksproxy-ops http://${at}/p/ops/mcp --header "Authorization: Bearer ${token}"`,
  ]);
  assert.equal(tokenState(w.env).state, 'ok');
  assert.ok(fs.existsSync(listenPath(w.env)));

  assert.equal((await rpc(port, token, INIT, { target: '/p/shop/mcp' })).status, 200);
  await waitFor(() => proc.stdout.text.includes('[listen] 127.0.0.1 test-agent 1.0 connected\n'), 5000, 'the connected line');
  assert.equal(await callText(port, token, 'shop', 'ssh_exec', { server: 'web1', command: 'cat shop' }), 'exit code: 0\n--- stdout ---\nran web1 cat shop');
  assert.equal(await callText(port, token, 'ops', 'ssh_exec', { server: 'web1', command: 'cat ops' }), 'exit code: 0\n--- stdout ---\nran web1 cat ops');
  assert.equal(await callText(port, token, 'ops', 'local_exec', { target: 'infra', command: 'cat who.txt' }), 'exit code: 0\n--- stdout ---\nops files');
  assert.equal(
    await callText(port, token, 'shop', 'vault_read', { target: 'v1', command: 'read a' }),
    `exit code: 0\n--- stdout ---\nvault v1: read a with a token of ${VAULT_VALUE.length} characters`,
  );
  assert.equal(await callText(port, token, 'ops', 'vault_read', { target: 'v1', command: 'read a' }), 'unknown vault target "v1". Open targets: none');
  assert.equal((await rpc(port, token, PING)).status, 404, 'the default is not served by this start');
  const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await rpc(port, wrong, PING, { target: '/p/ops/mcp' })).status, 401);
  await waitFor(() => proc.stdout.text.includes('[listen] refused 1 wrong tokens from 127.0.0.1\n'), 5000, 'the refused line');
  await waitFor(() => /^\[shop\] .*vlt +v1 .*read a/m.test(proc.stdout.text), 10000, 'the brokered call line of shop');

  proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.deepEqual(listenFileAtClosing, [false, false], 'the listener is closed before any session closes');
  assert.equal(fs.existsSync(listenPath(w.env)), false);
  await portFree(port);
  assert.equal(listenerTotal(proc), 0);

  // A later start shows the dates of the same token and the URLs; with --new-token the old token stops at once.
  const later = startRun(['--project', 'shop,ops', '--all', '--listen', at], w);
  await listening(later);
  const { record } = tokenState(w.env);
  assert.deepEqual(ownLines(later.proc.stdout.text), [
    `[listen] listening on ${at} (http)`,
    `[listen] token from ${record.created.slice(0, 10)}, expires ${record.expires.slice(0, 10)}`,
    `[listen] shop: http://${at}/p/shop/mcp`,
    `[listen] ops: http://${at}/p/ops/mcp`,
  ]);
  assert.equal((await rpc(port, token, PING, { target: '/p/ops/mcp' })).status, 200);
  later.proc.emit('SIGTERM');
  assert.equal(await later.done, 0);
  assert.match(later.proc.stderr.text, /^\[ops\] .*CLOSING +terminated$/m);

  const renewed = startRun(['--project', 'shop,ops', '--all', '--listen', at, '--new-token'], w, { process: ttyProcess() });
  await listening(renewed);
  const [fresh] = tokensIn(renewed.proc.stdout.text);
  assert.notEqual(fresh, token);
  assert.equal((await rpc(port, token, PING, { target: '/p/ops/mcp' })).status, 401);
  assert.equal((await rpc(port, fresh, PING, { target: '/p/ops/mcp' })).status, 200);
  renewed.proc.emit('SIGHUP');
  assert.equal(await renewed.done, 0);
});

test('a session that stops on its own while the listener runs: the listener closes first, then the others stop', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const proc = ttyProcess();
  const listenFileAtShopClosing = [];
  proc.stdout.onWrite = (text) => {
    if (text.startsWith('[ops] ') && text.includes('cat boom')) throw new Error('the terminal is gone');
  };
  proc.stderr.onWrite = (text) => {
    if (text.startsWith('[shop] ') && text.includes('CLOSING')) listenFileAtShopClosing.push(fs.existsSync(listenPath(w.env)));
  };
  const run = startRun(['--project', 'shop,ops', '--all', '--listen', `127.0.0.1:${port}`], w, { process: proc });
  await listening(run);
  assert.ok(fs.existsSync(listenPath(w.env)));
  await callTool('ssh_exec', { server: 'web1', command: 'cat boom' }, withProject(w.env, 'ops'));
  assert.equal(await run.done, 1);
  assert.match(proc.stderr.text, /^\[ops\] .*CLOSING +output closed$/m);
  assert.match(proc.stderr.text, /^\[shop\] .*CLOSING +another project stopped$/m);
  assert.deepEqual(listenFileAtShopClosing, [false]);
  await portFree(port);
});

test('typed lines: the picker on the terminal, a hint, empty lines, new-token replaces the token, and a token that cannot be made', async () => {
  const w = await world();
  writeInventory(w, 'solo', {
    ssh: [{
      name: 'web1', host: 'web1.solo.example', description: 'solo box', allow: ['uptime'],
    }],
  });
  const [port] = await freePorts(1);
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const proc = ttyProcess({ stdin });
  const run = startRun(['--project', 'solo', '--listen', `127.0.0.1:${port}`], w, { process: proc });
  await waitFor(() => proc.stderr.text.includes('Which ssh targets?'), 10000, 'the picker');
  stdin.write('a\r');
  await listening(run);
  assert.ok(proc.stdout.text.startsWith('Session folder: '), 'one project: no prefix');
  const [first] = tokensIn(proc.stdout.text);
  assert.ok(proc.stdout.text.includes(`ksproxy-solo http://127.0.0.1:${port}/p/solo/mcp --header`));

  stdin.write('hello\n\n   \n');
  await waitFor(() => proc.stdout.text.includes('[listen] type new-token to replace the token\n'), 5000, 'the hint');
  stdin.write(' new-token \n');
  await waitFor(() => tokensIn(proc.stdout.text).length === 2, 5000, 'the new token');
  const [, second] = tokensIn(proc.stdout.text);
  assert.notEqual(second, first);
  assert.equal(count(proc.stdout.text, '[listen] type new-token to replace the token'), 1, 'empty lines print nothing');
  assert.equal(count(proc.stdout.text, '[listen] a new token was made; it is shown only now'), 2);
  assert.equal((await rpc(port, first, PING, { target: '/p/solo/mcp' })).status, 401);
  assert.equal((await rpc(port, second, PING, { target: '/p/solo/mcp' })).status, 200);

  const folder = listenDir(w.env);
  fs.renameSync(folder, `${folder}-moved`);
  fs.writeFileSync(folder, '');
  stdin.write('new-token\n');
  await waitFor(() => proc.stderr.text.includes('[listen] cannot make a new token: EEXIST'), 5000, 'the failure');
  assert.ok(!proc.stdout.text.includes('cannot make a new token'), 'the failure is on stderr only');
  assert.equal(tokensIn(proc.stdout.text).length, 2);

  proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.equal(listenerTotal(proc), 0);
  assert.equal(stdin.listenerCount('data'), 0, 'the typed lines are no longer read');
});

test('the expiry warning at start and on each tick, with an injected clock, and none once the token is gone', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const clock = Date.parse('2027-06-01T12:00:00.000Z');
  newToken(w.env, new Date(clock - 340 * DAY_MS));
  let ticks = 0;
  const now = () => {
    ticks += 1;
    return new Date(clock);
  };
  const run = startRun(['--project', 'ops', '--all', '--listen', `127.0.0.1:${port}`], w, { now, limits: { followMs: 50, warnMs: 20 } });
  const { record } = tokenState(w.env, new Date(clock));
  const expires = record.expires.slice(0, 10);
  const warning = `[listen] the token expires on ${expires}; type new-token to replace it`;
  await waitFor(() => count(run.proc.stdout.text, warning) >= 3, 10000, 'the warnings');
  assert.deepEqual(linesOf(run.proc.stdout.text).filter((line) => line.startsWith('[listen]')).slice(0, 4), [
    `[listen] listening on 127.0.0.1:${port} (http)`,
    `[listen] token from ${record.created.slice(0, 10)}, expires ${expires}`,
    `[listen] ops: http://127.0.0.1:${port}/p/ops/mcp`,
    warning,
  ]);
  fs.rmSync(tokenPath(w.env));
  const seen = count(run.proc.stdout.text, warning);
  const from = ticks;
  await waitFor(() => ticks >= from + 3, 10000, 'more ticks');
  assert.equal(count(run.proc.stdout.text, warning), seen);
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('each pre-check in order: the first failure is printed, exit 1, and nothing opens', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const at = `127.0.0.1:${port}`;
  newToken(w.env);
  const tokenText = fs.readFileSync(tokenPath(w.env), 'utf8');
  const sessionDir = path.join(stateOf(w, 'ops'), 'session');
  const cert = path.join(w.base, 'cert.pem');
  fs.writeFileSync(cert, 'not checked here');
  const check = async (args, message, host = {}) => {
    const run = startRun(args, w, host);
    assert.equal(await run.done, 1, args.join(' '));
    if (message instanceof RegExp) assert.match(run.proc.stderr.text, message);
    else assert.equal(run.proc.stderr.text, `${message}\n`);
    assert.equal(run.proc.stdout.text, '');
    // Nothing opened: no socket folder of any project, and no listener.
    for (const project of ['shop', 'ops']) assert.equal(fs.existsSync(path.join(stateOf(w, project), 's')), false, project);
    assert.equal(listenerTotal(run.proc), 0);
  };
  const missing = path.join(w.env[CONFIG_KEY], 'projects', 'nope.json');
  await check(['--project', 'shop,nope', '--all', '--listen', '192.0.2.10:7443'], `inventory not found: ${missing}; run: ksproxy init --project nope`);

  fs.mkdirSync(sessionDir, { recursive: true });
  writeSession(sessionDir, { version: 1, pid: process.pid, targets: [] });
  const running = `a session is already running (pid ${process.pid}); stop it with Ctrl-C in its terminal`;
  await check(['--project', 'shop,ops', '--all', '--listen', '192.0.2.10:7443'], `[ops] ${running}`);
  await check(['--project', 'ops', '--all', '--listen', at], running);
  fs.rmSync(path.join(sessionDir, 'session.json'));

  await check(['--project', 'shop,ops', '--all', '--listen', at, '--listen', '192.0.2.10:7443'], '--listen: 192.0.2.10 is not a loopback or private address of this machine');
  await check(['--project', 'shop', '--all', '--listen', at, '--tls-cert', `${cert}x`, '--tls-key', cert], `--tls-cert: cannot read ${cert}x`);
  await check(['--project', 'shop', '--all', '--listen', at, '--tls-cert', cert, '--tls-key', `${cert}y`], `--tls-key: cannot read ${cert}y`);
  // The two files must make a TLS context together: text that is not PEM, or a key of another certificate.
  const together = (detail) => new RegExp(`^--tls-cert and --tls-key cannot be used together: ${detail}\n$`);
  await check(['--project', 'shop', '--all', '--listen', at, '--tls-cert', cert, '--tls-key', cert], together('.*'));
  const pairCert = path.join(w.base, 'pair-cert.pem');
  const otherKey = path.join(w.base, 'other-key.pem');
  fs.writeFileSync(pairCert, selfSigned('localhost').cert);
  fs.writeFileSync(otherKey, selfSigned('localhost').key);
  await check(['--project', 'shop', '--all', '--listen', at, '--tls-cert', pairCert, '--tls-key', otherKey], together('.*key values mismatch'));

  // Another live listener: refused before anything opens, also with --new-token, so its token stays as it is.
  fs.mkdirSync(listenDir(w.env), { recursive: true });
  fs.writeFileSync(listenPath(w.env), JSON.stringify({ version: 1, pid: process.ppid }));
  for (const extra of [[], ['--new-token']]) {
    await check(['--project', 'shop,ops', '--all', '--listen', at, ...extra], `another ksproxy start is listening (pid ${process.ppid})`);
    assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), tokenText, 'the token of the running listener is unchanged');
  }
  fs.rmSync(listenPath(w.env));
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), tokenText);

  fs.writeFileSync(tokenPath(w.env), 'not a token file');
  await check(['--project', 'shop,ops', '--all', '--listen', at], `cannot read ${tokenPath(w.env)}: start with --new-token to replace it`);
  fs.writeFileSync(tokenPath(w.env), tokenText);

  // A new token would be made while stdout is not a terminal: refused before the picker, and the token stays.
  const noTerminal = 'a new token is shown only on a terminal: run this start once with its output on a terminal';
  await check(['--project', 'shop,ops', '--listen', at, '--new-token'], noTerminal);
  await check(['--project', 'ops', '--all', '--listen', at, '--new-token'], noTerminal);
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), tokenText);
  fs.writeFileSync(tokenPath(w.env), 'not a token file');
  await check(['--project', 'ops', '--all', '--listen', at, '--new-token'], noTerminal);
  newToken(w.env, new Date(Date.now() - 400 * DAY_MS));
  await check(['--project', 'ops', '--all', '--listen', at], noTerminal);
  assert.equal(revokeToken(w.env), 'revoked');
  await check(['--project', 'ops', '--all', '--listen', at], noTerminal);
  fs.rmSync(tokenPath(w.env));
  await check(['--project', 'ops', '--all', '--listen', at], noTerminal);
  assert.equal(fs.existsSync(tokenPath(w.env)), false, 'no token is made');
  fs.writeFileSync(tokenPath(w.env), tokenText);

  await check(['--project', 'shop,ops'], 'several projects need --all when not running in a terminal');
  await check(['--project', 'ops', '--listen', at], /^no targets selected: use --ssh, .* or --all when not running in a terminal\n$/);

  // The picker runs once per project, its titles with the project; a project with nothing picked stops here.
  const asked = [];
  const stdin = { isTTY: true };
  const answers = [[0], [0], null];
  await check(['--project', 'shop,ops'], '[ops] nothing selected', {
    process: fakeProcess({ stdin }),
    checkbox: async (request) => {
      asked.push(request.title);
      return answers.shift();
    },
  });
  assert.deepEqual(asked, ['[shop] Which kinds of proxy?', '[shop] Which ssh targets?', '[ops] Which kinds of proxy?']);
});

test('the picker once per project: each session opens what was picked for it, as kind flags', async () => {
  const w = await world();
  const asked = [];
  const answers = [[0], [0], [1], [0]];
  const run = startRun(['--project', 'shop,ops'], w, {
    process: fakeProcess({ stdin: { isTTY: true } }),
    checkbox: async (request) => {
      asked.push([request.title, request.items.map((item) => item.label)]);
      return answers.shift();
    },
  });
  await allReady(run, ['shop', 'ops']);
  assert.deepEqual(asked, [
    ['[shop] Which kinds of proxy?', ['ssh', 'local', 'vault']],
    ['[shop] Which ssh targets?', ['web1']],
    ['[ops] Which kinds of proxy?', ['ssh', 'local']],
    ['[ops] Which local targets?', ['infra']],
  ]);
  const names = (project) => JSON.parse(fs.readFileSync(sessionFileOf(w, project), 'utf8')).targets.map((t) => `${t.kind}:${t.name}`);
  assert.deepEqual(names('shop'), ['ssh:web1']);
  assert.deepEqual(names('ops'), ['local:infra']);
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('one project with --listen: kind flags work as before, and an unknown name stops it before the listener', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const run = startRun(['--project', 'ops', '--ssh', 'nope', '--listen', `127.0.0.1:${port}`], w, { process: ttyProcess() });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown ssh target "nope"; known ssh targets: web1\n');
  assert.equal(run.proc.stdout.text, '');
  assert.equal(fs.existsSync(tokenPath(w.env)), false);
});

test('TLS: https lines and calls, an unreadable token replaced with --new-token, and the key file refused to a local target', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const { cert, key } = selfSigned('localhost');
  const certFile = path.join(w.base, 'cert.pem');
  const keyFile = path.join(w.base, 'proj-shop', 'listen-key.pem');
  fs.writeFileSync(certFile, cert);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  fs.mkdirSync(listenDir(w.env), { recursive: true });
  fs.writeFileSync(tokenPath(w.env), 'not a token file');
  const run = startRun([
    '--project', 'shop', '--all', '--listen', `127.0.0.1:${port}`, '--tls-cert', certFile, '--tls-key', keyFile, '--new-token',
  ], w, { process: ttyProcess() });
  await listening(run);
  const [token] = tokensIn(run.proc.stdout.text);
  assert.deepEqual(ownLines(run.proc.stdout.text).filter((line) => line.startsWith('[listen]') || line.startsWith('claude mcp add --transport')), [
    `[listen] listening on 127.0.0.1:${port} (https)`,
    '[listen] a new token was made; it is shown only now',
    `claude mcp add --transport http ksproxy-shop https://127.0.0.1:${port}/p/shop/mcp --header "Authorization: Bearer ${token}"`,
  ]);
  assert.match(run.proc.stderr.text, /loc +infra +SKIPPED +folder contains a kubeconfig named in the inventory$/m);
  const tls = { ca: cert, servername: 'localhost' };
  assert.equal(await callText(port, token, 'shop', 'ssh_exec', { server: 'web1', command: 'uptime' }, tls), 'exit code: 0\n--- stdout ---\nran web1 uptime');
  const recorded = JSON.parse(fs.readFileSync(sessionFileOf(w, 'shop'), 'utf8'));
  assert.deepEqual(recorded.targets.map((t) => t.name), ['web1', 'v1']);
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('a listener that cannot start: its reason, every session stops, exit 1, and the running token stays as it is', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const blocker = net.createServer();
  await new Promise((resolve) => { blocker.listen(port, '127.0.0.1', resolve); });
  servers.push(blocker);
  newToken(w.env);
  const before = fs.readFileSync(tokenPath(w.env), 'utf8');
  const run = startRun(['--project', 'shop,ops', '--all', '--listen', `127.0.0.1:${port}`, '--new-token'], w, { process: ttyProcess() });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, new RegExp(`^\\[listen\\] cannot listen: listen EADDRINUSE: address already in use 127\\.0\\.0\\.1:${port}$`, 'm'));
  assert.ok(!run.proc.stdout.text.includes('cannot listen'), 'the failure is on stderr only');
  assert.match(run.proc.stderr.text, /^\[shop\] .*CLOSING +the listener could not start$/m);
  assert.match(run.proc.stderr.text, /^\[ops\] .*CLOSING +the listener could not start$/m);
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), before);
  assert.equal(listenerTotal(run.proc), 0);
});

test('a token that cannot be made once the listener runs: the listener is closed again, exit 1', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  // A folder where token.json goes: listen.json can still be claimed in listenDir, so the listener starts, and only
  // the token cannot be written.
  fs.mkdirSync(tokenPath(w.env), { recursive: true });
  const run = startRun(['--project', 'ops', '--all', '--listen', `127.0.0.1:${port}`, '--new-token'], w, { process: ttyProcess() });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stdout.text, /^\[listen\] listening on .*\n/m);
  assert.match(run.proc.stderr.text, /^\[listen\] cannot listen: /m);
  assert.ok(!fs.existsSync(listenPath(w.env)));
  assert.match(run.proc.stderr.text, /CLOSING +the listener could not start$/m);
  await portFree(port);
});

test('a session whose start rejects: its error with its project, the others stop, exit 1', async () => {
  const w = await world();
  fs.mkdirSync(path.join(w.root, 'p'), { recursive: true });
  fs.writeFileSync(stateOf(w, 'ops'), '');
  const run = startRun(['--project', 'shop,ops', '--all'], w);
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /^\[ops\] ksproxy: ENOTDIR/m);
  assert.match(run.proc.stderr.text, /^\[shop\] .*CLOSING +another project stopped$/m);
  assert.equal(listenerTotal(run.proc), 0);
});

test('a project name that breaks the rule rejects before anything opens', async () => {
  const w = await world();
  const proc = fakeProcess();
  await assert.rejects(startMany({
    projects: ['Shop'], options: { all: true }, listen: [], newToken: false, tls: null,
  }, w.env, { process: proc }), { message: PROJECT_RULE });
  assert.equal(listenerTotal(proc), 0);
});

test('a stop that arrives as the last session gets ready: the listener never starts', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const proc = ttyProcess();
  proc.stdout.onWrite = (text) => {
    if (/ READY /.test(text)) proc.emit('SIGINT');
  };
  const run = startRun(['--project', 'ops', '--all', '--listen', `127.0.0.1:${port}`], w, { process: proc });
  assert.equal(await run.done, 0);
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C$/m);
  assert.deepEqual(ownLines(proc.stdout.text).filter((line) => line.startsWith('[listen]')), []);
  assert.equal(fs.existsSync(tokenPath(w.env)), false);
  assert.equal(fs.existsSync(listenPath(w.env)), false);
});

test('stdout not a terminal: a token revoked while the sessions open stops the start, and a typed new-token changes nothing', async () => {
  const w = await world();
  const [port] = await freePorts(1);
  const notShown = '[listen] a new token is shown only on a terminal\n';
  newToken(w.env);
  // The token is revoked as the last session gets ready, after the pre-checks: the listener starts, needs a new token,
  // makes none, and is closed again.
  const proc = fakeProcess();
  proc.stdout.onWrite = (text) => {
    if (/ READY /.test(text)) revokeToken(w.env);
  };
  const run = startRun(['--project', 'ops', '--all', '--listen', `127.0.0.1:${port}`], w, { process: proc });
  assert.equal(await run.done, 1);
  assert.ok(proc.stderr.text.includes(notShown), proc.stderr.text);
  assert.match(proc.stderr.text, /CLOSING +the listener could not start$/m);
  assert.equal(tokenState(w.env).state, 'revoked', 'no new token was made');
  assert.ok(!proc.stdout.text.includes('Bearer') && !proc.stdout.text.includes('shown only'), proc.stdout.text);
  assert.equal(fs.existsSync(listenPath(w.env)), false);
  await portFree(port);
  assert.equal(listenerTotal(proc), 0);

  // stdin is a terminal and stdout is not: a typed new-token says so on stderr, and the token stays.
  const token = newToken(w.env);
  const before = fs.readFileSync(tokenPath(w.env), 'utf8');
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const typed = startRun(['--project', 'ops', '--all', '--listen', `127.0.0.1:${port}`], w, { process: fakeProcess({ stdin }) });
  await listening(typed);
  stdin.write('new-token\n');
  await waitFor(() => typed.proc.stderr.text.includes(notShown), 5000, 'the refusal');
  assert.equal(fs.readFileSync(tokenPath(w.env), 'utf8'), before);
  assert.ok(!typed.proc.stdout.text.includes('Bearer'));
  assert.equal((await rpc(port, token, PING, { target: '/p/ops/mcp' })).status, 200);
  typed.proc.emit('SIGINT');
  assert.equal(await typed.done, 0);
});

test('an error of the real output reaches every session, and so does a fatal error', async () => {
  const w = await world();
  const run = startRun(['--project', 'shop,ops', '--all'], w);
  await allReady(run, ['shop', 'ops']);
  run.proc.stdout.emit('error', new Error('EPIPE'));
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /^\[shop\] .*CLOSING +output closed$/m);
  assert.match(run.proc.stderr.text, /^\[ops\] .*CLOSING +output closed$/m);

  const fatal = startRun(['--project', 'shop,ops', '--all'], w);
  await allReady(fatal, ['shop', 'ops']);
  fatal.proc.emit('uncaughtException', new Error('boom'));
  assert.equal(await fatal.done, 1);
  assert.match(fatal.proc.stderr.text, /^\[shop\] .*CLOSING +error: boom$/m);
  assert.match(fatal.proc.stderr.text, /^\[ops\] .*CLOSING +error: boom$/m);
  assert.equal(listenerTotal(fatal.proc), 0);
});

test('the real program: two projects and the listener in one process, a call over HTTP, SIGINT stops all with 0', async () => {
  const w = await world({ withVault: false });
  const [port] = await freePorts(1);
  // Its output is a pipe, not a terminal: it shows no new token, so the token is made before.
  const token = newToken(w.env);
  const child = spawn(process.execPath, [BIN, 'start', '--project', 'shop,ops', '--all', '--listen', `127.0.0.1:${port}`], {
    env: w.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { out.stdout += chunk; });
  child.stderr.on('data', (chunk) => { out.stderr += chunk; });
  const exited = new Promise((resolve) => { child.on('close', (code) => resolve(code)); });
  await waitFor(() => out.stdout.includes(`[listen] ops: http://127.0.0.1:${port}/p/ops/mcp`), 20000, 'the listener lines');
  assert.equal(await callText(port, token, 'ops', 'ssh_exec', { server: 'web1', command: 'cat ops' }), 'exit code: 0\n--- stdout ---\nran web1 cat ops');
  child.kill('SIGINT');
  assert.equal(await exited, 0);
  children.delete(child);
  for (const line of linesOf(out.stderr)) assert.match(line, /^\[(?:shop|ops)\] /);
  assert.match(out.stderr, /^\[shop\] .*CLOSING +Ctrl-C$/m);
  assert.equal(fs.existsSync(listenPath(w.env)), false);
});
