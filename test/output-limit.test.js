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
import { tempDir } from './temp.js';

// A target may raise the output limit of one stream from 256 KiB up to 4 MiB with maxOutputKiB. These tests use a
// stand-in brokered kind, and ssh with stand-in programs, each in its own temporary home folder.
const KIB = 1024;
const DEFAULT = 256 * KIB;
const RAISED = 1024 * KIB;
const LARGEST = 4096 * KIB;
const MARGIN = 8 * 4096;
const TOKEN = 'pw-Wd3K8sLq2Z7rV5nB-unmistakable';
const END = 16 * KIB;
// The cut line of a brokered stream that shows its first bytes up to the visible limit of its target.
const stopped = (at) => `\n[stdout cut at ${at}: the rest was left out]\n`;

const realKinds = [...KINDS];
const sample = sampleInventory();

const root = fs.realpathSync(tempDir('ks-wide-', os.tmpdir()));
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

function stdoutOf(text) {
  const from = text.indexOf('--- stdout ---\n') + 15;
  const end = text.indexOf('\n--- stderr ---');
  return text.slice(from, end === -1 ? text.length : end);
}

// A stream of ssh that was read to its end and was cut: its first part, then the marker, then its end part.
function withEnd(first, cut, end) {
  return `${first}\n[... ${cut} cut here ...]\n${end}`;
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
  assert.equal(realKinds.length, 13);
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

test('brokered: output over the raised limit is cut there, with no end part', async () => {
  const answer = await ask('raised', () => ({ exitCode: 0, stdout: 'x'.repeat(RAISED + 10), stderr: '' }));
  assert.equal(answer.text, `exit code: 0${stopped('1 MiB')}--- stdout ---\n${'x'.repeat(RAISED)}`);
});

test('brokered: a secret cut by the raised read limit is never shown in part', async () => {
  const answer = await ask('raised', ({ maxBytes }) => ({
    exitCode: 0, stdout: `${'x'.repeat(maxBytes - 5)}${TOKEN}`.slice(0, maxBytes), stderr: '', truncated: true,
  }));
  assertNoPiece(answer.text);
  assert.equal(stdoutOf(answer.text), 'x'.repeat(RAISED));
  assert.ok(answer.text.includes(stopped('1 MiB')));
});

test('brokered: a secret that crosses the raised visible limit is hidden whole before the cut', async () => {
  const answer = await ask('raised', () => ({ exitCode: 0, stdout: `${'x'.repeat(RAISED - 5)}${TOKEN}\n`, stderr: '' }));
  assertNoPiece(answer.text);
  // Hidden, the stream is 4 bytes longer than the raised limit: its first bytes end in a start of [hidden].
  assert.equal(answer.text, `exit code: 0${stopped('1 MiB')}--- stdout ---\n${'x'.repeat(RAISED - 5)}[hidd`);
});

test('brokered: a default target cuts at 256 KiB as before', async () => {
  const answer = await ask('plain', () => ({ exitCode: 0, stdout: 'x'.repeat(600 * KIB), stderr: '' }));
  assert.equal(answer.text, `exit code: 0${stopped('256 KiB')}--- stdout ---\n${'x'.repeat(DEFAULT)}`);
  // A whole stream that the answer must show less of is halved, with no end part.
  const control = await ask('plain', () => ({ exitCode: 0, stdout: '\u0001'.repeat(200000), stderr: '' }));
  assert.equal(control.text, `exit code: 0\n[stdout cut: showing 128 KiB of 195 KiB]\n--- stdout ---\n${'\u0001'.repeat(131072)}`);
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
    assert.equal(over.text, `exit code: 0${stopped('4 MiB')}--- stdout ---\n${'o'.repeat(LARGEST)}\n--- stderr ---\n${'"'.repeat(LARGEST)}`);
    assert.ok(Buffer.byteLength(JSON.stringify(over)) + 1 <= MAX_ANSWER_BYTES);
  } finally {
    await server.close();
  }
});

test('at the largest setting, an answer of control characters is halved as one at the default is', async () => {
  const answer = await ask('largest', () => ({ exitCode: 0, stdout: '\u0001'.repeat(LARGEST), stderr: '' }));
  assert.equal(answer.text, `exit code: 0\n[stdout cut: showing 2 MiB of 4 MiB]\n--- stdout ---\n${'\u0001'.repeat(LARGEST / 2)}`);
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


test('ssh: output between 256 KiB and the raised limit comes back whole', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${600 * KIB}));`);
  assert.deepEqual(r, { text: `exit code: 0\n--- stdout ---\n${'x'.repeat(600 * KIB)}`, isError: false });
});

test('ssh: output over the raised limit is cut there, its end part included', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED + 50000}));`);
  assert.equal(stdoutOf(r.text), withEnd('x'.repeat(RAISED - END - 64), '49 KiB', 'x'.repeat(END)));
  // The sizes of ssh count what the program wrote, so they are only ever rounded.
  assert.ok(r.text.startsWith('exit code: 0\n[stdout cut: showing 1 MiB of 1 MiB]\n'));
});

test('ssh: a path that crosses the raised visible limit is replaced whole before the cut', async () => {
  const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED - 5}) + base + '/y\\n');`);
  const stdout = stdoutOf(r.text);
  assert.ok(Buffer.byteLength(stdout) <= RAISED);
  assert.ok(stdout.endsWith(`${'x'.repeat(100)}<ksproxy>/y`));
  assert.ok(!r.text.includes(stateDir.slice(0, 5)));
});

test('ssh: a path cut by the raised read limit is never shown in part', async () => {
  // The path must be longer than the piece that fits before the read limit, on every system: a short temporary folder
  // (Linux) would otherwise fit whole, be replaced, and leave a slightly shorter but equally safe output.
  for (const into of [5, Math.min(40, stateDir.length - 1)]) {
    const r = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED + MARGIN - into}) + base + '/file' + 'y'.repeat(1000));`);
    assert.match(stdoutOf(r.text), /^x+\n\[\.\.\. \d+ KiB cut here \.\.\.\]\nx+<ksproxy>\/filey{1000}$/, `${into}`);
    assert.ok(Buffer.byteLength(stdoutOf(r.text)) <= RAISED, `${into}`);
    for (let n = 2; n <= stateDir.length; n += 1) assert.ok(!r.text.includes(`x${stateDir.slice(0, n)}`), `${into}: ${n} characters of the path are shown`);
  }
  const near = await sshCall('raised', `process.stdout.write('x'.repeat(${RAISED - 20}) + base + '/file\\n' + 'y'.repeat(${RAISED}));`);
  for (let n = 2; n <= stateDir.length; n += 1) assert.ok(!near.text.includes(`x${stateDir.slice(0, n)}`), `${n} characters of the path are shown`);
});

test('ssh: a default target, and one whose session file was given a larger limit by hand, cut at 256 KiB', async () => {
  for (const server of ['plain', 'forged']) {
    const r = await sshCall(server, `process.stdout.write('x'.repeat(${600 * KIB}));`);
    assert.equal(stdoutOf(r.text), withEnd('x'.repeat(DEFAULT - END - 64), '344 KiB', 'x'.repeat(END)), server);
    assert.ok(r.text.startsWith('exit code: 0\n[stdout cut: showing 256 KiB of 600 KiB]\n'), server);
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
  // The section on cut output names the default limit, the end part, the cut line of a brokered stream and the 1 KiB
  // that a brokered call that did not end on its own loses; no other line names a limit.
  assert.equal(text.split('KiB').length, 6);
  assert.ok(text.includes('cut at 256 KiB, or at the limit that its target names above'));
  const raisedSection = text.slice(text.indexOf('### ssh server `raised`'), text.indexOf('### ssh server `plain`'));
  assert.ok(raisedSection.includes('- Output is cut at 2048 KiB per stream for this target.\n'));
});
