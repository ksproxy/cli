import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vault, { control } from './fixtures/kind-brokered.js';
import { KINDS } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { askCall, startCallServer } from '../src/broker.js';
import { callTool, targetState } from '../src/tools.js';
import { main } from '../src/cli.js';
import { writeSession } from '../src/session.js';
import {
  cleanupAll, fakeProcess, launch, listenerTotal, makeWorld, ready, registerRun, stopWith, waitFor,
} from './start-helpers.js';

KINDS.push(vault);

const TOKEN = 'tok-S3CR3T-9f1e7c2a-unmistakable';
const TOKEN_VAR = 'VAULT_TEST_TOKEN';
const FILE_TOKEN = 'file-S3CR3T-4b8d-unmistakable';
const POLICY = 'read only please';
const MODEL_REASON = 'MODEL-REASON-77';
const ALLOW = ['read *', 'boom', 'odd', 'fail ...', 'hang', 'stuck', 'flood', 'ctl', 'envkeys', 'where', 'cut', 'crash'];
const NOT_LISTED = `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`;

const providers = [];
after(async () => {
  cleanupAll();
  for (const p of providers) {
    p.server.closeAllConnections();
    await new Promise((resolve) => p.server.close(resolve));
  }
});

async function provider() {
  const seen = [];
  const state = { verdict: 'allow' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
      const content = JSON.stringify({ verdict: state.verdict, certainty: 'sure', reason: MODEL_REASON });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = { server, seen, state };
  providers.push(p);
  return { ...p, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function vaultWorld({ vaults = [{}], extraEnv = {}, reviewed = false } = {}) {
  const world = await makeWorld({ extraEnv: { [TOKEN_VAR]: TOKEN, TEST_REVIEW_KEY: 'k-review', ...extraEnv } });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault = vaults.map((v) => ({
    name: 'v1', tokenEnv: TOKEN_VAR, description: 'test vault', allow: ALLOW, ...v,
  }));
  if (reviewed) {
    world.provider = await provider();
    inventory.reviewers = { r1: { baseUrl: world.provider.baseUrl, model: 'm', keyEnv: 'TEST_REVIEW_KEY' } };
  }
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.callSocket = path.join(world.socketDir, 'call-sock');
  return world;
}

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const callsOf = (world, command) => auditOf(world).filter((e) => e.event === 'call' && e.tool === 'vault_read' && (command === undefined || e.command === command));
const vaultCall = (world, command, extra = {}) => callTool('vault_read', { target: 'v1', command, ...extra }, world.env);

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function runMain(world, argv) {
  const proc = fakeProcess();
  const run = { proc, done: main(argv, world.env, { process: proc }) };
  registerRun(run);
  return run;
}

test('the fixture is a brokered kind that meets the contract', () => {
  checkKind(vault, KINDS);
  assert.equal(vault.brokered, true);
  assert.equal(vault.command, undefined);
  assert.equal(vault.state, undefined);
});

test('the secret stays in the memory of start: not in any file, log line, audit entry, reply or child environment', async () => {
  const world = await vaultWorld();
  const sshEnvLog = path.join(world.base, 'ssh-env.log');
  world.env.KSPROXY_FAKE_SSH_ENV_LOG = sshEnvLog;
  const run = launch(world, { ssh: ['web1'], vault: ['v1'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /vlt +v1 +OPENING +token from VAULT_TEST_TOKEN\n/);
  assert.match(run.proc.stderr.text, /vlt +v1 +UP\n/);
  const stat = fs.statSync(world.callSocket);
  assert.ok(stat.isSocket());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(world.socketDir).mode & 0o777, 0o700);
  assert.deepEqual(control.opened.at(-1), { name: 'v1', names: [TOKEN_VAR] });
  assert.deepEqual(sessionOf(world).targets.map((t) => [t.kind, t.name, t.state]), [['ssh', 'web1', 'up'], ['vault', 'v1', 'up']]);

  // The agent starts ksproxy mcp with its own environment, which does not hold the user's token.
  const agentEnv = { ...world.env };
  delete agentEnv[TOKEN_VAR];
  const replies = [];
  const ask = async (tool, args) => {
    const reply = await callTool(tool, args, agentEnv);
    replies.push(reply.text);
    return reply;
  };
  const read = await ask('vault_read', { target: 'v1', command: 'read alpha' });
  assert.deepEqual(read, {
    text: `exit code: 0\n--- stdout ---\nvault v1: read alpha with a token of ${TOKEN.length} characters`, isError: false,
  });
  const keys = await ask('vault_read', { target: 'v1', command: 'envkeys' });
  assert.equal(keys.isError, false, keys.text);
  assert.ok(keys.text.includes('PATH'), keys.text);
  assert.ok(!keys.text.split('\n').includes(TOKEN_VAR), keys.text);
  for (const command of ['boom', 'write x', 'crash', 'odd']) await ask('vault_read', { target: 'v1', command });
  assert.equal((await ask('ssh_exec', { server: 'web1', command: 'uptime' })).isError, false);
  await ask('list_targets', {});
  await waitFor(() => /vlt +v1 +DENIED +odd/.test(run.proc.stdout.text), 10000, 'the call lines');
  assert.equal(await stopWith(run), 0);

  const everywhere = [run.proc.stdout.text, run.proc.stderr.text, ...replies];
  for (const text of everywhere) assert.ok(!text.includes(TOKEN), text);
  for (const file of filesUnder(path.join(world.base, 'st'))) {
    assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN), file);
  }
  assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes(TOKEN));
  assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes('/secret/path'));
  const entries = fs.readFileSync(sshEnvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(entries.some((e) => e.argv.includes('-M')), 'the ssh master was started');
  assert.ok(entries.some((e) => e.argv.at(-1) === 'uptime'), 'the ssh command ran');
  for (const e of entries) {
    assert.equal(Object.hasOwn(e.env, TOKEN_VAR), false, JSON.stringify(e.argv));
    assert.ok(!Object.values(e.env).includes(TOKEN), JSON.stringify(e.argv));
  }
});

test('an allowed call runs and an unlisted one is refused, each audited once and by start, and printed live', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const refused = await vaultCall(world, 'write x');
  assert.deepEqual(refused, { text: `REFUSED (vault v1): ${NOT_LISTED}`, isError: true });
  const failed = await vaultCall(world, 'fail key9');
  assert.deepEqual(failed, { text: 'exit code: 3\n--- stderr ---\nno such key key9', isError: true });
  await vaultCall(world, 'read alpha');
  await waitFor(() => /vlt +v1 +ok .*read alpha/.test(run.proc.stdout.text), 10000, 'the call lines');
  assert.match(run.proc.stdout.text, /vlt +v1 +DENIED +write x {2}\[not on allowlist\]/);
  assert.match(run.proc.stdout.text, /vlt +v1 +exit 3 .*fail key9/);

  const [denied] = callsOf(world, 'write x');
  assert.equal(callsOf(world, 'write x').length, 1);
  assert.deepEqual(Object.keys(denied).sort(), ['command', 'decision', 'event', 'kind', 'reason', 'short', 'target', 'tool', 'ts']);
  assert.equal(denied.kind, 'vlt');
  assert.equal(denied.short, 'not on allowlist');
  const allowed = callsOf(world, 'read alpha');
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].decision, 'allowed');
  assert.equal(allowed[0].rule, 'read *');
  assert.equal(allowed[0].exitCode, 0);
  assert.equal(allowed[0].timedOut, false);
  assert.equal(allowed[0].spawnError, null);
  assert.ok(Number.isInteger(allowed[0].durationMs));
  assert.equal(allowed[0].stdoutBytes, Buffer.byteLength(`vault v1: read alpha with a token of ${TOKEN.length} characters\n`));
  assert.equal(allowed[0].stderrBytes, 0);
  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED +3 calls: 1 ok, 1 failed, 1 denied/);
});

test('an audit entry start cannot write is reported on its terminal and the answer is unchanged', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  fs.chmodSync(world.auditLog, 0o400);
  try {
    const read = await vaultCall(world, 'read a');
    assert.equal(read.isError, false, read.text);
    assert.match(run.proc.stderr.text, /ksproxy: could not write audit log: /);
  } finally {
    fs.chmodSync(world.auditLog, 0o600);
  }
  assert.equal(await stopWith(run), 0);
});

test('the mcp side checks the arguments and the target, and audits each of its own refusals once', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const before = auditOf(world).length;
  assert.deepEqual(await callTool('vault_read', { target: 'v1', command: 5 }, world.env), {
    text: 'invalid arguments: command must be a string', isError: true,
  });
  assert.deepEqual(await callTool('vault_read', { target: 7, command: 'read a' }, world.env), {
    text: 'invalid arguments: target must be a string', isError: true,
  });
  assert.equal((await vaultCall(world, 'read a', { timeout_seconds: 0 })).text, 'invalid arguments: timeout_seconds must be an integer from 1 to 600');
  assert.deepEqual(await callTool('vault_read', { target: 'nope', command: 'read a' }, world.env), {
    text: 'unknown vault target "nope". Open targets: v1', isError: true,
  });
  assert.equal(auditOf(world).length, before + 4);
  assert.equal(await stopWith(run), 0);
});

test('perform: failures are refusals with the fixed text, and the limits on time and output hold', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const failedText = { text: 'REFUSED (vault v1): the call failed inside the session', isError: true };
  for (const command of ['boom', 'odd', 'crash']) assert.deepEqual(await vaultCall(world, command), failedText, command);
  for (const command of ['boom', 'odd', 'crash']) {
    const [entry] = callsOf(world, command);
    assert.equal(entry.decision, 'refused', command);
    assert.equal(entry.short, 'call failed', command);
    assert.equal(entry.reason, 'the call failed inside the session', command);
  }

  const started = Date.now();
  const hung = await vaultCall(world, 'hang', { timeout_seconds: 1 });
  // A call that timed out loses the last 1 KiB of each stream back to a newline: the short partial line goes.
  assert.equal(hung.text, 'timed out after 1s\n[stdout cut: the stream did not end on its own, so its end was left out]');
  assert.equal(hung.isError, true);
  const stuck = await vaultCall(world, 'stuck', { timeout_seconds: 1 });
  assert.deepEqual(stuck, { text: 'timed out after 1s', isError: true });
  assert.ok(Date.now() - started < 10000);
  const [stuckEntry] = callsOf(world, 'stuck');
  assert.equal(stuckEntry.timedOut, true);
  assert.equal(stuckEntry.exitCode, null);

  const flood = await vaultCall(world, 'flood');
  assert.equal(flood.isError, false);
  assert.equal(flood.text, `exit code: 0\n[stdout cut at 256 KiB: the rest was left out]\n--- stdout ---\n${'f'.repeat(262144)}`);
  assert.ok(callsOf(world, 'flood')[0].stdoutBytes > 262144 + 100);
  // A stream that its reader stopped did not end on its own: it loses its last 1 KiB back to a newline, by count and
  // never by what it holds, so the short text goes whole, though its last character starts the token.
  assert.equal((await vaultCall(world, 'cut')).text, 'exit code: 0\n[stdout cut: the stream did not end on its own, so its end was left out]');
  const ctl = await vaultCall(world, 'ctl');
  assert.equal(ctl.isError, false);
  assert.equal(ctl.text, `exit code: 0\n[stdout cut at 256 KiB: the rest was left out; showing 128 KiB]\n--- stdout ---\n${'\u0001'.repeat(131072)}`);
  assert.equal(callsOf(world, 'ctl')[0].decision, 'allowed');
  const where = await vaultCall(world, 'where');
  assert.equal(where.text, 'exit code: 0\n--- stdout ---\nstate in <ksproxy>/x');
  assert.equal(await stopWith(run), 0);
});

test('a reviewed brokered call goes through the review service in start, with the same checks on the words', async () => {
  const world = await vaultWorld({ reviewed: true, vaults: [{ review: { reviewer: 'r1', policy: POLICY } }] });
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /vlt +v1 +REVIEW +reviewer r1, accepts sure/);
  assert.equal(sessionOf(world).targets[0].review, true);
  assert.equal(fs.existsSync(path.join(world.socketDir, 'review-sock')), true);

  const approved = await vaultCall(world, 'list keys');
  assert.deepEqual(approved, {
    text: `exit code: 0\n--- stdout ---\nvault v1: list keys with a token of ${TOKEN.length} characters`, isError: false,
  });
  assert.equal(world.provider.seen.length, 1);
  assert.equal(world.provider.seen[0].authorization, 'Bearer k-review');
  assert.deepEqual(JSON.parse(world.provider.seen[0].body.messages[1].content), {
    policy: POLICY, target: { kind: 'vault', name: 'v1' }, command: ['list', 'keys'],
  });
  const again = await vaultCall(world, 'list keys');
  assert.equal(again.isError, false);
  assert.equal(world.provider.seen.length, 1, 'the second ask is answered from the cache');
  const [entry] = callsOf(world, 'list keys');
  assert.equal(entry.rule, 'review');
  assert.deepEqual(entry.review, { certainty: 'sure', reason: MODEL_REASON });

  world.provider.state.verdict = 'refuse';
  const refused = await vaultCall(world, 'drop keys');
  assert.deepEqual(refused, {
    text: `REFUSED (vault v1): ${NOT_LISTED}. The reviewer did not approve it.`, isError: true,
  });
  assert.equal(callsOf(world, 'drop keys')[0].short, `model refused: ${MODEL_REASON}`);

  const many = Array.from({ length: 65 }, (_, i) => `w${i}`).join(' ');
  const notSent = await vaultCall(world, many);
  assert.equal(notSent.text, `REFUSED (vault v1): ${NOT_LISTED}. It was not sent to the reviewer: the command has more than 64 words.`);
  assert.equal(world.provider.seen.length, 2);
  await waitFor(() => /vlt +v1 +ok .*list keys  \(model: MODEL-REASON-77\)/.test(run.proc.stdout.text), 10000, 'the reviewed line');
  assert.equal(await stopWith(run), 0);
  for (const text of [approved.text, refused.text, notSent.text]) assert.ok(!text.includes(MODEL_REASON));
});

test('a missing or empty variable, or an unreadable or empty token file, skips the target with the stated line', async () => {
  const missing = await vaultWorld();
  delete missing.env[TOKEN_VAR];
  const run1 = launch(missing, { ssh: ['web1'], vault: ['v1'] });
  await ready(run1);
  assert.match(run1.proc.stderr.text, /vlt +v1 +OPENING +token from VAULT_TEST_TOKEN\n[^\n]*vlt +v1 +SKIPPED +VAULT_TEST_TOKEN is not set\n/);
  assert.deepEqual(sessionOf(missing).targets.map((t) => t.kind), ['ssh']);
  assert.equal(fs.existsSync(missing.callSocket), false);
  assert.equal(await stopWith(run1), 0);

  const empty = await vaultWorld({ extraEnv: { [TOKEN_VAR]: '' } });
  const run2 = launch(empty, { vault: ['v1'] });
  assert.equal(await run2.done, 1);
  assert.match(run2.proc.stderr.text, /vlt +v1 +SKIPPED +VAULT_TEST_TOKEN is not set\n/);
  assert.match(run2.proc.stderr.text, /nothing could be opened/);

  const files = await vaultWorld();
  const good = path.join(files.base, 'token-good');
  const blank = path.join(files.base, 'token-blank');
  const absent = path.join(files.base, 'token-absent');
  fs.writeFileSync(good, `${FILE_TOKEN}\n`);
  fs.writeFileSync(blank, '\n');
  const file = path.join(files.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault = [
    { name: 'v1', tokenEnv: TOKEN_VAR, tokenFile: good, allow: ['read *'] },
    { name: 'v2', tokenEnv: TOKEN_VAR, tokenFile: blank, allow: ['read *'] },
    { name: 'v3', tokenEnv: TOKEN_VAR, tokenFile: absent, allow: ['read *'] },
  ];
  fs.writeFileSync(file, JSON.stringify(inventory));
  const run3 = launch(files, { vault: ['v1', 'v2', 'v3'] });
  await ready(run3);
  assert.ok(run3.proc.stderr.text.includes(`v2         SKIPPED         ${blank} is empty\n`), run3.proc.stderr.text);
  assert.ok(run3.proc.stderr.text.includes(`v3         SKIPPED         ${absent} cannot be read\n`), run3.proc.stderr.text);
  const read = await vaultCall(files, 'read a');
  assert.equal(read.text, `exit code: 0\n--- stdout ---\nvault v1: read a with a token of ${TOKEN.length} characters and a file of ${FILE_TOKEN.length} characters`);
  assert.deepEqual(control.opened.at(-1), { name: 'v1', names: [TOKEN_VAR, good] });
  assert.equal(await stopWith(run3), 0);
  for (const f of filesUnder(path.join(files.base, 'st'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(FILE_TOKEN), f);
  assert.ok(!run3.proc.stderr.text.includes(FILE_TOKEN) && !run3.proc.stdout.text.includes(FILE_TOKEN));
});

test('a secret shorter than 8 characters gives a warning that names its variable or file, never the value or its length', async () => {
  const SHORT = 'Q%x';
  const SHORT_FILE = 'W%k~';
  const world = await vaultWorld({
    extraEnv: { VAULT_SHORT_TOKEN: SHORT, VAULT_EIGHT_TOKEN: 'exactly8' },
    vaults: [
      { name: 'v1', tokenEnv: 'VAULT_SHORT_TOKEN' },
      { name: 'v2', tokenEnv: 'VAULT_EIGHT_TOKEN' },
      { name: 'v3', tokenEnv: 'VAULT_SHORT_TOKEN' },
    ],
  });
  const shortFile = path.join(world.base, 'token-short');
  fs.writeFileSync(shortFile, `${SHORT_FILE}\n`);
  const file = path.join(world.env[['KSPROXY', 'CONFIG', 'DIR'].join('_')], 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault[1].tokenFile = shortFile;
  inventory.vault[2].tokenFile = path.join(world.base, 'token-absent');
  fs.writeFileSync(file, JSON.stringify(inventory));
  // A form of each token: its first three characters, so the form of the 8-character token is short.
  vault.hiddenForms = (t, secrets) => [secrets[t.tokenEnv].slice(0, 3)];
  const run = launch(world, { vault: ['v1', 'v2', 'v3'] });
  await ready(run);
  delete vault.hiddenForms;
  const why = 'holds a secret shorter than 8 characters: hiding it in output can give it away';
  const formWhy = 'holds a secret with a part shorter than 8 characters: hiding it in output can give it away';
  const err = run.proc.stderr.text;
  assert.match(err, new RegExp(`vlt +v1 +UP\\n[^\\n]*vlt +v1 +WARN +VAULT_SHORT_TOKEN ${why}\\n`));
  assert.ok(err.includes(`WARN            ${shortFile} ${why}\n`), err);
  assert.ok(!err.includes(`VAULT_EIGHT_TOKEN ${why}`), 'a secret of 8 characters is long enough');
  assert.ok(!/vlt +v3 +WARN/.test(err), 'a skipped target gets no warning');
  const warnings = auditOf(world).filter((e) => e.event === 'target_warn' && e.kind === 'vlt');
  assert.deepEqual(warnings.map((e) => [e.target, e.message]), [
    ['v1', `VAULT_SHORT_TOKEN ${why}`],
    ['v2', `${shortFile} ${why}`],
    ['v2', `VAULT_EIGHT_TOKEN ${formWhy}`],
  ]);
  assert.equal(await stopWith(run), 0);
  for (const text of [err, run.proc.stdout.text, fs.readFileSync(world.auditLog, 'utf8')]) {
    assert.ok(!text.includes(SHORT_FILE) && !text.includes(SHORT) && !/\b[34] characters/.test(text));
  }
  control.probes.length = 0;
});

test('start trusts only its own memory: a target added or widened in session.json gains nothing', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const file = path.join(world.sessionDir, 'session.json');
  const session = sessionOf(world);
  session.targets[0].allow = ['...'];
  session.targets.push({
    kind: 'vault', name: 'ghost', description: '', allow: ['...'], tokenEnv: TOKEN_VAR, state: 'up',
  });
  fs.writeFileSync(file, JSON.stringify(session));
  assert.deepEqual(await callTool('vault_read', { target: 'ghost', command: 'read a' }, world.env), {
    text: 'REFUSED (vault ghost): this target is not open in the session', isError: true,
  });
  assert.deepEqual(await vaultCall(world, 'write x'), { text: `REFUSED (vault v1): ${NOT_LISTED}`, isError: true });
  const [ghost] = auditOf(world).filter((e) => e.target === 'ghost');
  assert.equal(ghost.decision, 'refused');
  assert.equal(ghost.short, 'target not open');
  assert.equal(ghost.kind, 'vlt');
  assert.equal(await stopWith(run), 0);
});

test('a local process talking to the call socket directly gets only what a rule allows', async () => {
  const world = await vaultWorld();
  const run = launch(world, { ssh: ['web1'], vault: ['v1'] });
  await ready(run);
  const ask = (request) => askCall(world.callSocket, { timeoutSeconds: 5, ...request }, 10000, 'x');
  assert.deepEqual(await ask({ kind: 'vault', name: 'v1', input: ['read', 'a'] }), {
    text: 'invalid arguments: command must be a string', isError: true,
  });
  assert.deepEqual(await ask({ kind: 'vault', name: 'v1', input: 'write x' }), {
    text: `REFUSED (vault v1): ${NOT_LISTED}`, isError: true,
  });
  assert.deepEqual(await ask({ kind: 'ssh', name: 'web1', input: 'uptime' }), {
    text: 'REFUSED: this target is not open in the session', isError: true,
  });
  assert.deepEqual(await ask({ kind: 'nothing', name: 'web1', input: 'uptime' }), {
    text: 'REFUSED: this target is not open in the session', isError: true,
  });
  assert.deepEqual(await ask({ kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 0 }), {
    text: 'REFUSED: the call could not be read', isError: true,
  });
  assert.equal((await ask({ kind: 'vault', name: 'v1', input: 'read a' })).isError, false);
  const shapes = callsOf(world).map((e) => [e.command, e.decision, e.short ?? e.rule]);
  assert.deepEqual(shapes, [[null, 'refused', 'invalid arguments'], ['write x', 'refused', 'not on allowlist'], ['read a', 'allowed', 'read *']]);
  assert.equal(await stopWith(run), 0);
});

test('every way of stopping closes the call server and removes the socket', async () => {
  const ways = [
    ['SIGINT', (run) => run.proc.emit('SIGINT')],
    ['SIGTERM', (run) => run.proc.emit('SIGTERM')],
    ['SIGHUP', (run) => run.proc.emit('SIGHUP')],
    ['fatal', (run) => run.proc.emit('uncaughtException', new Error('boom'))],
    ['output closed', (run) => run.proc.stdout.emit('error', new Error('EPIPE'))],
  ];
  for (const [label, stop] of ways) {
    const world = await vaultWorld();
    const run = launch(world, { vault: ['v1'] });
    await ready(run);
    assert.ok(fs.statSync(world.callSocket).isSocket(), label);
    stop(run);
    await run.done;
    assert.equal(fs.existsSync(world.callSocket), false, label);
    assert.deepEqual(await askCall(world.callSocket, {
      kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 5,
    }, 2000, 'vault'), { text: 'REFUSED (vault v1): the session did not answer', isError: true }, label);
    assert.equal(listenerTotal(run.proc), 0, label);
  }
});

test('a call in flight ends as a refusal when the session stops, and does not hold the stop back', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const aborted = control.aborted;
  const hanging = vaultCall(world, 'hang', { timeout_seconds: 120 });
  const stuck = vaultCall(world, 'stuck', { timeout_seconds: 120 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = Date.now();
  assert.equal(await stopWith(run), 0);
  assert.ok(Date.now() - started < 5000);
  for (const reply of [await hanging, await stuck]) {
    assert.deepEqual(reply, { text: 'REFUSED (vault v1): the session did not answer', isError: true });
  }
  await waitFor(() => control.aborted === aborted + 1, 5000, 'perform to see the abort');
  assert.equal(fs.existsSync(world.callSocket), false);
});

test('list_targets and status show a brokered target down when the call socket is gone', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const listed = async () => JSON.parse((await callTool('list_targets', {}, world.env)).text).targets[0].state;
  assert.equal(await listed(), 'up');
  fs.rmSync(world.callSocket);
  assert.equal(await listed(), 'down');
  const status = runMain(world, ['status']);
  assert.equal(await status.done, 1);
  assert.match(status.proc.stdout.text, /down {2}vlt {3}v1\n/);
  assert.deepEqual(await vaultCall(world, 'read a'), { text: 'REFUSED (vault v1): the session did not answer', isError: true });
  assert.equal(await stopWith(run), 0);
});

test('the health loop asks the kind\'s probe with the secret, and reports DOWN and UP', async () => {
  const world = await vaultWorld();
  const run = launch(world, { vault: ['v1'] });
  await ready(run);
  const before = control.probes.length;
  control.probe = 'throw';
  await waitFor(() => control.probes.length >= before + 2, 10000, 'two probes');
  control.probe = 'down';
  await waitFor(() => /vlt +v1 +DOWN +vault is not answering/.test(run.proc.stderr.text), 10000, 'the DOWN line');
  control.probe = 'up';
  await waitFor(() => /vlt +v1 +UP +vault is back/.test(run.proc.stderr.text), 10000, 'the UP line');
  assert.ok(control.probes.every((p) => p.name === 'v1' && p.hasToken));
  assert.equal(await stopWith(run), 0);
});

test('a call service that cannot start leaves the brokered targets down, with a warning', async () => {
  for (const failing of [
    async () => { throw new Error('no socket for you'); },
    () => { throw new Error('thrown at once'); },
  ]) {
    const world = await vaultWorld();
    const run = launch(world, { vault: ['v1'] }, { startCallServer: failing });
    await ready(run);
    assert.match(run.proc.stderr.text, /vlt +v1 +WARN +calls are off: could not start the call service/);
    assert.match(run.proc.stdout.text, /READY +1 targets/);
    assert.equal(JSON.parse((await callTool('list_targets', {}, world.env)).text).targets[0].state, 'down');
    assert.deepEqual(await vaultCall(world, 'read a'), { text: 'REFUSED (vault v1): the session did not answer', isError: true });
    assert.equal(await stopWith(run), 0);
  }
});

test('a stop that arrives while the call service starts closes it and writes no session', async () => {
  const world = await vaultWorld();
  const proc = fakeProcess();
  let made = null;
  const run = launch(world, { vault: ['v1'] }, {
    process: proc,
    startCallServer: (options) => {
      proc.emit('SIGINT');
      made = startCallServer(options);
      return made;
    },
  });
  assert.equal(await run.done, 0);
  assert.ok(made !== null);
  assert.ok(!proc.stdout.text.includes('Leave this running'));
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.equal(fs.existsSync(world.callSocket), false);
});

test('a call socket path that is too long stops the start before anything opens', async () => {
  const world = await vaultWorld();
  world.env.KSPROXY_STATE_DIR = path.join(world.base, 'd'.repeat(90));
  const run = launch(world, { vault: ['v1'] });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /^socket path too long \(\d+ bytes, limit 100\): .*call-sock; set KSPROXY_STATE_DIR/m);
  assert.ok(!/OPENING/.test(run.proc.stderr.text));
});

test('without a usable call socket path the mcp side refuses and reports the target down', async () => {
  const world = await vaultWorld();
  const env = { ...world.env, KSPROXY_STATE_DIR: path.join(world.base, 'd'.repeat(90)) };
  const target = {
    kind: 'vault', name: 'v1', description: '', allow: ['read *'], state: 'up',
  };
  assert.equal(await targetState(target, env), 'down');
  writeSession(path.join(env.KSPROXY_STATE_DIR, 'session'), { pid: process.pid, startedAt: 'now', targets: [target] });
  assert.deepEqual(await callTool('vault_read', { target: 'v1', command: 'read a' }, env), {
    text: 'REFUSED (vault v1): the session did not answer', isError: true,
  });
  assert.equal(await targetState(target, world.env), 'down');
});

test('a stale call socket left by a killed run is not sent an ssh -O exit', async () => {
  const world = await vaultWorld();
  const sshLog = path.join(world.base, 'ssh.log');
  world.env.KSPROXY_FAKE_SSH_LOG = sshLog;
  fs.mkdirSync(world.socketDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(world.callSocket, 'left over');
  const run = launch(world, { ssh: ['web1'], vault: ['v1'] });
  await ready(run);
  assert.ok(fs.statSync(world.callSocket).isSocket());
  const calls = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!calls.some((argv) => argv.includes(world.callSocket)), JSON.stringify(calls));
  assert.equal((await vaultCall(world, 'read a')).isError, false);
  assert.equal(await stopWith(run), 0);
});
