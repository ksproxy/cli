import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS } from '../src/kinds/index.js';
import { decide, tokenizeSshCommand } from '../src/allowlist.js';
import { answerCall, callTool } from '../src/tools.js';
import { MAX_ANSWER_BYTES, askCall, startCallServer } from '../src/broker.js';
import { InventoryError, sampleInventory, validateInventory } from '../src/inventory.js';
import { outputKiB } from '../src/checks.js';
import { agentMdText } from '../src/agent-md.js';
import { writeSession } from '../src/session.js';

// A target may raise the output limit of one stream from 256 KiB up to 4 MiB with maxOutputKiB. These tests use a
// stand-in brokered kind, and ssh with stand-in programs, each in its own temporary home folder.
const KIB = 1024;
const DEFAULT = 256 * KIB;
const RAISED = 1024 * KIB;
const LARGEST = 4096 * KIB;
const MARGIN = 8 * 4096;
const TOKEN = 'pw-Wd3K8sLq2Z7rV5nB-unmistakable';
const note = (bytes) => `[output truncated at ${bytes} bytes per stream]`;

const realKinds = [...KINDS];
const sample = sampleInventory();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-wide-')));
const stateDir = path.join(root, 'st');
const sessionDir = path.join(stateDir, 'session');
fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(stateDir, 's'), { recursive: true, mode: 0o700 });
fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'cfg'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: stateDir,
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

const state = { perform: null, calls: [] };

// A stand-in brokered kind: every call is decided by its words, and perform does what the test sets.
const wide = {
  key: 'wide',
  flag: 'wide',
  label: 'wid',
  word: 'wide',
  noun: 'wide target',
  countNoun: 'wide target(s)',
  brokered: true,
  decide(target, input) {
    const tokens = tokenizeSshCommand(input);
    return { ...decide(tokens, target.allow), argv: tokens };
  },
  async perform(target, decision, context) {
    state.calls.push(context);
    return state.perform(context);
  },
  tool: {
    name: 'wide_exec', nameKey: 'target', detailKey: 'command', detailIsArray: false, definition: {},
  },
};
KINDS.push(wide);

const brokered = {
  plain: { kind: 'wide', name: 'plain', allow: ['show'] },
  raised: {
    kind: 'wide', name: 'raised', allow: ['show'], maxOutputKiB: 1024,
  },
  largest: {
    kind: 'wide', name: 'largest', allow: ['show'], maxOutputKiB: 4096,
  },
};
const calls = new Map(Object.values(brokered).map((t) => [`wide:${t.name}`, { target: t, secrets: { TOK: TOKEN } }]));
const context = (signal = new AbortController().signal) => ({
  calls, session: { targets: Object.values(brokered) }, env, signal, review: async () => null, stderr: process.stderr,
});

function ask(name, perform) {
  state.perform = perform;
  state.calls = [];
  return answerCall({
    kind: 'wide', name, input: 'show', timeoutSeconds: 30,
  }, context());
}

function stdoutOf(text, limit) {
  const from = text.indexOf('--- stdout ---\n') + 15;
  const ends = [text.indexOf('\n--- stderr ---'), text.indexOf(`\n${note(limit)}`)].filter((at) => at !== -1);
  return text.slice(from, ends.length === 0 ? text.length : Math.min(...ends));
}

function assertNoPiece(text) {
  for (let n = 4; n < TOKEN.length; n += 1) assert.ok(!text.includes(TOKEN.slice(0, n)), `the first ${n} characters of the secret are shown`);
}

test('outputKiB takes an integer from 256 to 4096 and gives 256 for anything else', () => {
  assert.equal(outputKiB({}), 256);
  assert.equal(outputKiB({ maxOutputKiB: 256 }), 256);
  assert.equal(outputKiB({ maxOutputKiB: 1024 }), 1024);
  assert.equal(outputKiB({ maxOutputKiB: 4096 }), 4096);
  for (const forged of [4097, 100000, 255, 0, -1, 1024.5, '1024', null, true]) {
    assert.equal(outputKiB({ maxOutputKiB: forged }), 256, `${forged}`);
  }
});

test('every kind accepts maxOutputKiB the same way and keeps it on the target', () => {
  assert.equal(realKinds.length, 12);
  const raw = Object.fromEntries(realKinds.map((kind) => [kind.key, sample[kind.key].map((entry) => ({ ...entry, maxOutputKiB: 2048 }))]));
  const validated = validateInventory(raw);
  for (const kind of realKinds) {
    assert.ok(validated[kind.key].length > 0, kind.key);
    for (const target of validated[kind.key]) assert.equal(target.maxOutputKiB, 2048, kind.key);
  }
  const plain = validateInventory(Object.fromEntries(realKinds.map((kind) => [kind.key, sample[kind.key]])));
  for (const kind of realKinds) {
    for (const target of plain[kind.key]) assert.equal(Object.hasOwn(target, 'maxOutputKiB'), false, kind.key);
  }
});

test('the inventory refuses a maxOutputKiB that is not an integer from 256 to 4096', () => {
  const entry = (value) => ({ ssh: [{ name: 'web1', host: 'web1.example.com', maxOutputKiB: value }] });
  assert.equal(validateInventory(entry(256)).ssh[0].maxOutputKiB, 256);
  assert.equal(validateInventory(entry(4096)).ssh[0].maxOutputKiB, 4096);
  for (const value of [255, 4097, 0, 1024.5, '1024', null, true, [1024]]) {
    assert.throws(() => validateInventory(entry(value)), (err) => err instanceof InventoryError
      && err.message === 'ssh "web1": maxOutputKiB: must be an integer from 256 to 4096', `${value}`);
  }
  const http = { http: [{ ...sample.http[0], maxOutputKiB: 5000 }] };
  assert.throws(() => validateInventory(http), { message: `http "${sample.http[0].name}": maxOutputKiB: must be an integer from 256 to 4096` });
  assert.throws(() => validateInventory({ ssh: [{ name: 'web1', host: 'web1.example.com', maxOutput: 1024 }] }), {
    message: 'ssh "web1": unknown key "maxOutput"',
  });
});

test('a raised target gives perform its own read limit, and a default target the one it always had', async () => {
  await ask('raised', () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  assert.equal(state.calls[0].maxBytes, RAISED + MARGIN);
  await ask('plain', () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  assert.equal(state.calls[0].maxBytes, DEFAULT + MARGIN);
  await ask('largest', () => ({ exitCode: 0, stdout: 'ok', stderr: '' }));
  assert.equal(state.calls[0].maxBytes, LARGEST + MARGIN);
});

test('brokered: output between 256 KiB and the raised limit comes back whole', async () => {
  const text = 'x'.repeat(600 * KIB);
  const answer = await ask('raised', () => ({ exitCode: 0, stdout: text, stderr: 'e'.repeat(RAISED) }));
  assert.deepEqual(answer, { text: `exit code: 0\n--- stdout ---\n${text}\n--- stderr ---\n${'e'.repeat(RAISED)}`, isError: false });
});

test('brokered: output over the raised limit is cut there, and the note names that limit', async () => {
  const answer = await ask('raised', () => ({ exitCode: 0, stdout: 'x'.repeat(RAISED + 10), stderr: '' }));
  assert.equal(stdoutOf(answer.text, RAISED), 'x'.repeat(RAISED));
  assert.ok(answer.text.endsWith(`\n${note(RAISED)}`));
});

test('brokered: a secret cut by the raised read limit is never shown in part', async () => {
  const answer = await ask('raised', ({ maxBytes }) => ({
    exitCode: 0, stdout: `${'x'.repeat(maxBytes - 5)}${TOKEN}`.slice(0, maxBytes), stderr: '', truncated: true,
  }));
  assertNoPiece(answer.text);
  assert.equal(stdoutOf(answer.text, RAISED), 'x'.repeat(RAISED - 5));
  assert.ok(answer.text.endsWith(note(RAISED)));
});

test('brokered: a secret that crosses the raised visible limit is hidden whole before the cut', async () => {
  const answer = await ask('raised', () => ({ exitCode: 0, stdout: `${'x'.repeat(RAISED - 5)}${TOKEN}\n`, stderr: '' }));
  assertNoPiece(answer.text);
  assert.equal(stdoutOf(answer.text, RAISED), `${'x'.repeat(RAISED - 5)}[hidd`);
  assert.ok(answer.text.endsWith(note(RAISED)));
});

test('brokered: a default target cuts at 256 KiB as before', async () => {
  const answer = await ask('plain', () => ({ exitCode: 0, stdout: 'x'.repeat(600 * KIB), stderr: '' }));
  assert.equal(stdoutOf(answer.text, DEFAULT), 'x'.repeat(DEFAULT));
  assert.ok(answer.text.endsWith(`\n${note(DEFAULT)}`));
  const control = await ask('plain', () => ({ exitCode: 0, stdout: '\u0001'.repeat(200000), stderr: '' }));
  assert.ok(control.text.endsWith(`\n${note(131072)}`));
});

test('an answer at the largest setting passes the broker whole, without halving', async () => {
  const socket = path.join(root, 'call-sock');
  const server = await startCallServer({ socket, handle: (request, signal) => answerCall(request, context(signal)) });
  try {
    const out = 'o'.repeat(LARGEST);
    const err = 'e'.repeat(LARGEST);
    state.perform = () => ({ exitCode: 0, stdout: out, stderr: err });
    const whole = await askCall(socket, {
      kind: 'wide', name: 'largest', input: 'show', timeoutSeconds: 30,
    }, 30000, 'wide');
    assert.deepEqual(whole, { text: `exit code: 0\n--- stdout ---\n${out}\n--- stderr ---\n${err}`, isError: false });

    state.perform = () => ({ exitCode: 0, stdout: 'o'.repeat(LARGEST + 100), stderr: '"'.repeat(LARGEST) });
    const over = await askCall(socket, {
      kind: 'wide', name: 'largest', input: 'show', timeoutSeconds: 30,
    }, 30000, 'wide');
    assert.equal(stdoutOf(over.text, LARGEST), out);
    assert.ok(over.text.includes(`--- stderr ---\n${'"'.repeat(LARGEST)}\n`));
    assert.ok(over.text.endsWith(`\n${note(LARGEST)}`));
    assert.ok(Buffer.byteLength(JSON.stringify(over)) + 1 <= MAX_ANSWER_BYTES);
  } finally {
    await server.close();
  }
});

test('at the largest setting, an answer of control characters is halved as one at the default is', async () => {
  const answer = await ask('largest', () => ({ exitCode: 0, stdout: '\u0001'.repeat(LARGEST), stderr: '' }));
  assert.equal(stdoutOf(answer.text, LARGEST / 2), '\u0001'.repeat(LARGEST / 2));
  assert.ok(answer.text.endsWith(`\n${note(LARGEST / 2)}`));
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) + 1 <= MAX_ANSWER_BYTES);
});

// ssh: ksproxy mcp runs the command itself, with the limit it reads from session.json.
const sshTarget = (name, extra = {}) => ({
  kind: 'ssh',
  name,
  description: '',
  allow: ['big'],
  host: `${name}.example.com`,
  socket: path.join(stateDir, 's', `ssh-${name}`),
  state: 'up',
  ...extra,
});
for (const name of ['raised', 'plain', 'forged']) fs.writeFileSync(path.join(stateDir, 's', `ssh-${name}`), '');
writeSession(sessionDir, {
  version: 1,
  pid: process.pid,
  startedAt: '2026-11-22T00:00:00.000Z',
  targets: [sshTarget('raised', { maxOutputKiB: 1024 }), sshTarget('plain'), sshTarget('forged', { maxOutputKiB: 100000 })],
});

let scripts = 0;
function sshCall(server, body) {
  scripts += 1;
  const script = path.join(root, `fake-ssh-${scripts}.js`);
  fs.writeFileSync(script, `#!/usr/bin/env node\nconst base = ${JSON.stringify(stateDir)};\n${body}\n`, { mode: 0o755 });
  return callTool('ssh_exec', { server, command: 'big' }, { ...env, [['KSPROXY', 'SSH'].join('_')]: script });
}

function sshStdout(text, limit) {
  return stdoutOf(text, limit);
}

test('ssh: output between 256 KiB and the raised limit comes back whole', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${600 * KIB}));`);
  assert.deepEqual(r, { text: `exit code: 0\n--- stdout ---\n${'x'.repeat(600 * KIB)}`, isError: false });
});

test('ssh: output over the raised limit is cut there, and the note names that limit', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED + 50000}));`);
  assert.equal(sshStdout(r.text, RAISED), 'x'.repeat(RAISED));
  assert.ok(r.text.endsWith(`\n${note(RAISED)}`));
});

test('ssh: a path that crosses the raised visible limit is replaced whole before the cut', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED - 5}) + base + '/y\\n');`);
  const stdout = sshStdout(r.text, RAISED);
  assert.equal(Buffer.byteLength(stdout), RAISED);
  assert.equal(stdout.slice(RAISED - 5), '<kspr');
  assert.ok(!r.text.includes(stateDir.slice(0, 5)));
  assert.ok(r.text.endsWith(note(RAISED)));
});

test('ssh: a path cut by the raised read limit is never shown in part', async () => {
  // The path must be longer than the piece that fits before the read limit, on every system: a short temporary folder
  // (Linux) would otherwise fit whole, be replaced, and leave a slightly shorter but equally safe output.
  for (const into of [5, Math.min(40, stateDir.length - 1)]) {
    const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED + MARGIN - into}) + base + '/file' + 'y'.repeat(1000));`);
    assert.equal(sshStdout(r.text, RAISED), 'x'.repeat(RAISED), `${into}`);
    assert.ok(r.text.endsWith(`\n${note(RAISED)}`));
  }
  const near = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED - 20}) + base + '/file\\n' + 'y'.repeat(${RAISED}));`);
  for (let n = 2; n <= stateDir.length; n += 1) assert.ok(!near.text.includes(`x${stateDir.slice(0, n)}`), `${n} characters of the path are shown`);
});

test('ssh: a default target, and one whose session file was given a larger limit by hand, cut at 256 KiB', async () => {
  for (const server of ['plain', 'forged']) {
    const r = await sshCall(server, `process.stdout.write('x'.repeat(${600 * KIB}));`);
    assert.equal(sshStdout(r.text, DEFAULT), 'x'.repeat(DEFAULT), server);
    assert.ok(r.text.endsWith(`\n${note(DEFAULT)}`), server);
  }
});

test('list_targets names a raised limit in one short phrase, and nothing for the default', async () => {
  const listed = JSON.parse((await callTool('list_targets', {}, env)).text).targets;
  assert.equal(listed.find((t) => t.name === 'raised').outputLimit, '1024 KiB per stream');
  assert.equal(Object.hasOwn(listed.find((t) => t.name === 'plain'), 'outputLimit'), false);
  assert.equal(Object.hasOwn(listed.find((t) => t.name === 'forged'), 'outputLimit'), false);
});

test('AGENT.md names a raised limit under its target, and nothing for the default', () => {
  const text = agentMdText({ targets: [sshTarget('raised', { maxOutputKiB: 2048 }), sshTarget('plain')] });
  assert.equal(text.split('- Output is cut at 2048 KiB per stream for this target.').length, 2);
  assert.equal(text.split('KiB').length, 2);
  const raisedSection = text.slice(text.indexOf('### ssh server `raised`'), text.indexOf('### ssh server `plain`'));
  assert.ok(raisedSection.includes('- Output is cut at 2048 KiB per stream for this target.\n'));
});
