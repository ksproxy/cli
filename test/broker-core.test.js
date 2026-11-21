import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS } from '../src/kinds/index.js';
import { decide, tokenizeSshCommand } from '../src/allowlist.js';
import { answerCall } from '../src/tools.js';
import { runClient } from '../src/kinds/engines/command.js';

const VISIBLE = 262144;
const TOKEN = 'pw-Zq9X7kLm4R2tV8nB-unmistakable';
const NOTE = '[output truncated at 262144 bytes per stream]';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-core-')));
fs.mkdirSync(path.join(root, 'st', 'logs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'cfg'), { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH, HOME: root, [['KSPROXY', 'STATE', 'DIR'].join('_')]: path.join(root, 'st'), [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};
after(() => fs.rmSync(root, { recursive: true, force: true }));

const state = { perform: null, calls: [] };

// A stand-in brokered kind: every call is decided by its words, and perform does what the test sets.
const probe = {
  key: 'probe',
  flag: 'probe',
  label: 'prb',
  word: 'probe',
  noun: 'probe target',
  countNoun: 'probe target(s)',
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
    name: 'probe_exec', nameKey: 'target', detailKey: 'command', detailIsArray: false, definition: {},
  },
};
KINDS.push(probe);

const target = { kind: 'probe', name: 'p1', allow: ['show'] };
const calls = new Map([['probe:p1', { target, secrets: { TOK: TOKEN } }]]);

beforeEach(() => {
  state.perform = null;
  state.calls = [];
});

function ask(input = 'show', { signal = new AbortController().signal, review = async () => null } = {}) {
  return answerCall({
    kind: 'probe', name: 'p1', input, timeoutSeconds: 30,
  }, {
    calls, session: { targets: [target] }, env, signal, review, stderr: process.stderr,
  });
}

function stdoutOf(text) {
  const from = text.indexOf('--- stdout ---\n') + 15;
  const ends = [text.indexOf('\n--- stderr ---'), text.indexOf(`\n${NOTE}`)].filter((at) => at !== -1);
  return text.slice(from, ends.length === 0 ? text.length : Math.min(...ends));
}

function assertNoPiece(text) {
  for (let n = 4; n < TOKEN.length; n += 1) assert.ok(!text.includes(TOKEN.slice(0, n)), `the first ${n} characters of the secret are shown`);
}

test('perform gets room past the visible limit for a path, the same whatever the secrets', async () => {
  state.perform = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  await ask();
  assert.equal(state.calls[0].maxBytes, VISIBLE + 8 * 4096);
});

test('the forms a kind gives are hidden with the values, leave the read limit as it is, and never reach the log', async () => {
  const FORM = `form-${'F'.repeat(100)}-unmistakable`;
  probe.hiddenForms = (t, secrets) => {
    assert.equal(t, target);
    assert.deepEqual(secrets, { TOK: TOKEN });
    return [FORM];
  };
  try {
    state.perform = ({ maxBytes }) => ({
      exitCode: 0, stdout: `${FORM} and ${TOKEN}\n`, stderr: `${'x'.repeat(maxBytes - 50)}${FORM}`.slice(0, maxBytes), truncated: true,
    });
    const answer = await ask();
    assert.equal(state.calls[0].maxBytes, VISIBLE + 8 * 4096);
    assert.ok(answer.text.startsWith('exit code: 0\n--- stdout ---\n[hidden] and [hidden]\n--- stderr ---\nxxx'));
    for (let n = 4; n <= FORM.length; n += 1) assert.ok(!answer.text.includes(FORM.slice(0, n)));
    assert.ok(!fs.readFileSync(path.join(root, 'st', 'logs', 'audit.log'), 'utf8').includes('form-'));
  } finally {
    delete probe.hiddenForms;
  }
});

test('a kind whose hiddenForms throws refuses the call without running it', async () => {
  probe.hiddenForms = () => {
    throw new Error('no forms');
  };
  try {
    state.perform = () => ({ exitCode: 0, stdout: 'ran', stderr: '' });
    const answer = await ask();
    assert.equal(answer.isError, true);
    assert.match(answer.text, /the call failed inside the session/);
    assert.equal(state.calls.length, 0);
  } finally {
    delete probe.hiddenForms;
  }
});

test('a secret cut by the limit of perform is never shown in part', async () => {
  state.perform = ({ maxBytes }) => ({
    exitCode: 0, stdout: `${'x'.repeat(maxBytes - 5)}${TOKEN}`.slice(0, maxBytes), stderr: '', truncated: true,
  });
  const answer = await ask();
  assertNoPiece(answer.text);
  assert.equal(stdoutOf(answer.text), 'x'.repeat(VISIBLE - 5));
  assert.ok(answer.text.endsWith(NOTE));
});

test('a secret that crosses the visible limit is hidden whole before the cut', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE - 5)}${TOKEN}\n`, stderr: '' });
  const answer = await ask();
  assertNoPiece(answer.text);
  assert.equal(stdoutOf(answer.text), `${'x'.repeat(VISIBLE - 5)}[hidd`);
  assert.ok(answer.text.endsWith(NOTE));
});

test('hiding many secrets cannot pull a cut one into view', async () => {
  state.perform = ({ maxBytes }) => ({
    exitCode: 0, stdout: `z${TOKEN.repeat(Math.ceil(maxBytes / TOKEN.length))}`.slice(0, maxBytes), stderr: '',
  });
  const answer = await ask();
  assertNoPiece(answer.text);
  assert.match(stdoutOf(answer.text).replaceAll('[hidden]', ''), /^z\[?h?i?d?d?e?n?$/);
  assert.ok(answer.text.endsWith(NOTE));
});

test('a secret wholly past the visible limit never appears, and the text is marked as cut', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE + 10)}${TOKEN}`, stderr: `${'e'.repeat(VISIBLE + 1)}` });
  const answer = await ask();
  assert.ok(!answer.text.includes(TOKEN));
  assert.ok(!answer.text.includes('[hidden]'));
  assert.equal(stdoutOf(answer.text), 'x'.repeat(VISIBLE));
  assert.ok(answer.text.endsWith(NOTE));
});

test('output within the limit is not marked, and a kind that says it cut is', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `the token ${TOKEN}\n`, stderr: '' });
  const whole = await ask();
  assert.equal(whole.text, 'exit code: 0\n--- stdout ---\nthe token [hidden]');
  state.perform = () => ({
    exitCode: 0, stdout: 'cut short', stderr: '', truncated: true,
  });
  assert.equal((await ask()).text, `exit code: 0\n--- stdout ---\ncut short\n${NOTE}`);
});

test('a secret cut by a time limit or a broken stream, not by the read limit, is never shown in part', async () => {
  state.perform = () => ({
    exitCode: null, stdout: `first line\nthe token ${TOKEN.slice(0, 20)}`, stderr: '', timedOut: true,
  });
  const late = await ask();
  assert.equal(late.text, 'timed out after 30s\n--- stdout ---\nfirst line\nthe token');
  state.perform = () => ({ exitCode: 1, stdout: `${TOKEN}\n${TOKEN.slice(0, 5)}`, stderr: 'the reply was cut off\n' });
  const broken = await ask();
  assert.equal(broken.text, 'exit code: 1\n--- stdout ---\n[hidden]\n--- stderr ---\nthe reply was cut off');
});

test('the cut piece is taken from the longest hidden text it starts, and only a proper start of one counts', async () => {
  probe.hiddenForms = () => ['ab', 'abcdef-unmistakable', 'q'];
  try {
    state.perform = () => ({ exitCode: 0, stdout: 'keep xyabcd', stderr: 'keep this q' });
    const answer = await ask();
    assert.equal(answer.text, 'exit code: 0\n--- stdout ---\nkeep xy\n--- stderr ---\nkeep this [hidden]');
    state.perform = () => ({ exitCode: 0, stdout: 'ends in a', stderr: 'ends in ab' });
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nends in\n--- stderr ---\nends in');
  } finally {
    delete probe.hiddenForms;
  }
});

test('a cut secret that a shorter hidden text overlaps, or that ends in a cut character, is never shown in part', async () => {
  probe.hiddenForms = () => ['bob', 'xbobsecret-unmistakable', 'pässwörd-unmistakable'];
  try {
    state.perform = () => ({ exitCode: 0, stdout: 'user xbobsec', stderr: 'pass pä�' });
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nuser\n--- stderr ---\npass');
    state.perform = () => ({ exitCode: 0, stdout: 'not a secret �', stderr: '' });
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nnot a secret �');
  } finally {
    delete probe.hiddenForms;
  }
});

test('a path that straddles the visible end of a stream that reached the read limit is never shown in part', async () => {
  const folder = path.join(root, 'st');
  for (const into of [5, 20, 40, 200]) {
    state.perform = ({ maxBytes }) => ({
      exitCode: 0, stdout: `${'x'.repeat(VISIBLE - into)}${folder}/file\n${'y'.repeat(VISIBLE)}`.slice(0, maxBytes), stderr: '', truncated: true,
    });
    const answer = await ask();
    assert.ok(answer.text.endsWith(NOTE), `${into}`);
    for (let n = 2; n <= folder.length; n += 1) assert.ok(!answer.text.includes(`x${folder.slice(0, n)}`), `${into}: ${n} characters of the path are shown`);
  }
});

test('a call whose output cannot be hidden or scrubbed is still audited as run, and the agent gets no output', async () => {
  probe.scrubText = () => {
    throw new Error('scrub broke');
  };
  try {
    state.perform = () => ({ exitCode: 3, stdout: `the token ${TOKEN}`, stderr: '' });
    const answer = await ask();
    assert.deepEqual(answer, { text: 'exit code: 3\nthe output could not be shown', isError: true });
  } finally {
    delete probe.scrubText;
  }
  const entry = auditEntries().at(-1);
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.exitCode, 3);
  assert.equal(entry.stdoutBytes, Buffer.byteLength(`the token ${TOKEN}`));
  assert.ok(!JSON.stringify(entry).includes(TOKEN));
});

// The real command engine with a fake program: node prints what the test asks, with the secret in its environment.
// A program that writes past the limit stays up after that write, so the engine always stops a running program: one
// that exits by itself may still be writing its coverage file when the SIGKILL lands, and leaves it empty or cut.
const STAY = '; setInterval(() => {}, 1000)';
function viaEngine(script) {
  return ({
    env: callEnv, secrets, timeoutMs, maxBytes, signal,
  }) => runClient({
    program: process.execPath,
    fixedArgs: ['-e', script],
    env: callEnv,
    childEnv: { TOK: secrets.TOK, LIMIT: String(maxBytes) },
    timeoutMs,
    maxBytes,
    signal,
  });
}

test('the command engine: a secret at the limit of perform or at the visible limit is never shown in part', async () => {
  state.perform = viaEngine(`process.stdout.write('x'.repeat(Number(process.env.LIMIT) - 5) + process.env.TOK + '\\n')${STAY}`);
  const atLimit = await ask();
  assertNoPiece(atLimit.text);
  assert.equal(stdoutOf(atLimit.text), 'x'.repeat(VISIBLE - 5));
  assert.ok(atLimit.text.endsWith(NOTE));

  state.perform = viaEngine(`process.stdout.write('x'.repeat(${VISIBLE - 15}) + process.env.TOK + '\\n')`);
  const atVisible = await ask();
  assertNoPiece(atVisible.text);
  assert.equal(stdoutOf(atVisible.text), `${'x'.repeat(VISIBLE - 15)}[hidden]`);
  assert.ok(!atVisible.text.endsWith(NOTE));

  state.perform = viaEngine(`process.stdout.write('z' + process.env.TOK.repeat(Math.ceil(Number(process.env.LIMIT) / process.env.TOK.length)))${STAY}`);
  const shifted = await ask();
  assertNoPiece(shifted.text);
  assert.ok(shifted.text.endsWith(NOTE));
});

function auditEntries() {
  const file = path.join(root, 'st', 'logs', 'audit.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
}

test('a regex rule that runs out of time refuses the call, and the agent and the log are told why', async () => {
  const slow = { kind: 'probe', name: 'p2', allow: ['regex(show .*.*.*.*.*.*.*.*.*.*.*.*x)'] };
  calls.set('probe:p2', { target: slow, secrets: {} });
  state.perform = () => ({ exitCode: 0, stdout: 'ran', stderr: '' });
  const started = Date.now();
  const answer = await answerCall({
    kind: 'probe', name: 'p2', input: `show ${'a'.repeat(400)}`, timeoutSeconds: 30,
  }, {
    calls, session: { targets: [slow] }, env, signal: new AbortController().signal, review: async () => null, stderr: process.stderr,
  });
  assert.ok(Date.now() - started < 2000);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /^REFUSED \(probe p2\): not on the allowlist .*took longer than 100 ms on this command, so it was treated as not matching$/);
  assert.equal(state.calls.length, 0);
  const entry = auditEntries().at(-1);
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'regex rule too slow');
  assert.match(entry.reason, /The rule regex\(show .*\) took longer than 100 ms/);
});

test('a call whose escaped answer would be too large is still told it ran, with less of its output', async () => {
  state.perform = () => ({ exitCode: 3, stdout: '\u0001'.repeat(200000), stderr: '"'.repeat(1000) });
  const answer = await ask();
  assert.equal(answer.isError, true);
  assert.ok(answer.text.startsWith(`exit code: 3\n--- stdout ---\n${'\u0001'.repeat(131072)}\n--- stderr ---\n${'"'.repeat(1000)}`));
  assert.ok(answer.text.endsWith('\n[output truncated at 131072 bytes per stream]'));
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) + 1 <= 1024 * 1024);
  const entry = auditEntries().at(-1);
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.exitCode, 3);
  assert.equal(entry.stdoutBytes, 200000);
});

test('a call that the reviewer approves after the session stopped is not run', async () => {
  const reviewed = { kind: 'probe', name: 'p3', allow: ['show'], review: true };
  calls.set('probe:p3', { target: reviewed, secrets: {} });
  state.perform = () => ({ exitCode: 0, stdout: 'ran', stderr: '' });
  const stopper = new AbortController();
  const answer = await answerCall({
    kind: 'probe', name: 'p3', input: 'drop all', timeoutSeconds: 30,
  }, {
    calls,
    session: { targets: [reviewed] },
    env,
    signal: stopper.signal,
    review: async () => {
      stopper.abort();
      return { allowed: true, certainty: 'sure', reason: 'fine' };
    },
    stderr: process.stderr,
  });
  assert.deepEqual(answer, { text: 'REFUSED (probe p3): the session did not answer', isError: true });
  assert.equal(state.calls.length, 0);
  const entry = auditEntries().at(-1);
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'session stopped');
  assert.equal(entry.reason, 'the session stopped before the call ran');
});

test('a call whose audited form cannot be made is refused and still audited', async () => {
  const shaped = {
    ...probe,
    key: 'oprobe',
    flag: 'oprobe',
    tool: {
      name: 'oprobe_call',
      nameKey: 'target',
      detailKey: 'request',
      detailShape: 'object',
      auditedDetail() {
        throw new Error('cannot show /secret/path');
      },
      definition: {},
    },
  };
  KINDS.push(shaped);
  const odd = { kind: 'oprobe', name: 'o1', allow: ['show'] };
  calls.set('oprobe:o1', { target: odd, secrets: {} });
  state.perform = () => ({ exitCode: 0, stdout: 'ran', stderr: '' });
  const answer = await answerCall({
    kind: 'oprobe', name: 'o1', input: { path: 'x' }, timeoutSeconds: 30,
  }, {
    calls, session: { targets: [odd] }, env, signal: new AbortController().signal, review: async () => null, stderr: process.stderr,
  });
  assert.deepEqual(answer, { text: 'REFUSED (probe o1): the call failed inside the session', isError: true });
  assert.equal(state.calls.length, 0);
  const entry = auditEntries().at(-1);
  assert.equal(entry.tool, 'oprobe_call');
  assert.equal(entry.target, 'o1');
  assert.equal(entry.request, null);
  assert.equal(entry.decision, 'refused');
  assert.equal(entry.short, 'call failed');
});
