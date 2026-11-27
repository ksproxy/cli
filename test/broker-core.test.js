import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS } from '../src/kinds/index.js';
import { decide, tokenizeSshCommand } from '../src/allowlist.js';
import { answerCall } from '../src/tools.js';
import { runClient } from '../src/kinds/engines/command.js';
import { tempDir } from './temp.js';

const VISIBLE = 262144;
const TOKEN = 'pw-Zq9X7kLm4R2tV8nB-unmistakable';
// The cut lines of a brokered stream: one that shows its first bytes up to the visible limit, and one that did not end
// on its own and lost its end (the last 1 KiB here, back to a newline).
const AT_LIMIT = (name = 'stdout') => `[${name} cut at 256 KiB: the rest was left out]`;
const END_LEFT_OUT = (name = 'stdout') => `[${name} cut: the stream did not end on its own, so its end was left out]`;

const root = fs.realpathSync(tempDir('ks-core-', os.tmpdir()));
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
  const end = text.indexOf('\n--- stderr ---');
  return text.slice(from, end === -1 ? text.length : end);
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
    // The call was cut, so both streams lose their last 1 KiB: stdout has a line of 1 KiB after its hidden texts.
    state.perform = ({ maxBytes }) => ({
      exitCode: 0, stdout: `${FORM} and ${TOKEN}\n${'p'.repeat(1024)}`, stderr: `${'x'.repeat(maxBytes - 50)}${FORM}`.slice(0, maxBytes), truncated: true,
    });
    const answer = await ask();
    assert.equal(state.calls[0].maxBytes, VISIBLE + 8 * 4096);
    assert.equal(answer.text, [
      'exit code: 0', END_LEFT_OUT(), AT_LIMIT('stderr'), '--- stdout ---', '[hidden] and [hidden]', '--- stderr ---', 'x'.repeat(VISIBLE),
    ].join('\n'));
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
  // A stopped stream needs no margin: its last 1 KiB, where the cut secret lies, is left out, and the stream shows the
  // whole visible limit.
  assert.equal(answer.text, `exit code: 0\n${AT_LIMIT()}\n--- stdout ---\n${'x'.repeat(VISIBLE)}`);
});

test('a secret that crosses the visible limit is hidden whole before the cut, and nothing of the end is shown', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE - 5)}${TOKEN}\n`, stderr: '' });
  const answer = await ask();
  assertNoPiece(answer.text);
  // The stream is cut at the visible limit once hidden, and its line gives no size, so it tells nothing of the length
  // of the secret: what is shown is the start of [hidden].
  assert.equal(answer.text, `exit code: 0\n${AT_LIMIT()}\n--- stdout ---\n${'x'.repeat(VISIBLE - 5)}[hidd`);
});

test('hiding many secrets cannot pull a cut one into view', async () => {
  state.perform = ({ maxBytes }) => ({
    exitCode: 0, stdout: `z${TOKEN.repeat(Math.ceil(maxBytes / TOKEN.length))}`.slice(0, maxBytes), stderr: '',
  });
  const answer = await ask();
  assertNoPiece(answer.text);
  // The stream reached the read limit, so it did not end on its own; hidden, it is far shorter than the visible limit,
  // has no newline, and shows nothing.
  assert.equal(answer.text, `exit code: 0\n${END_LEFT_OUT()}`);
});

test('a secret wholly past the visible limit never appears, and nothing of the end is shown', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE + 10)}${TOKEN}`, stderr: `${'e'.repeat(VISIBLE + 1)}` });
  const answer = await ask();
  assert.ok(!answer.text.includes(TOKEN));
  assert.equal(answer.text, [
    'exit code: 0', AT_LIMIT(), AT_LIMIT('stderr'), '--- stdout ---', 'x'.repeat(VISIBLE), '--- stderr ---', 'e'.repeat(VISIBLE),
  ].join('\n'));
});

test('output within the limit is not marked, and a kind that says it cut is', async () => {
  state.perform = () => ({ exitCode: 0, stdout: `the token ${TOKEN}\n`, stderr: '' });
  const whole = await ask();
  assert.equal(whole.text, 'exit code: 0\n--- stdout ---\nthe token [hidden]');
  // A cut stream loses its last 1 KiB back to a newline: a short one shows nothing, and the line says it was cut.
  state.perform = () => ({
    exitCode: 0, stdout: 'cut short', stderr: '', truncated: true,
  });
  assert.equal((await ask()).text, `exit code: 0\n${END_LEFT_OUT()}`);
  state.perform = () => ({
    exitCode: 0, stdout: `cut short\n${'z'.repeat(1024)}`, stderr: '', truncated: true,
  });
  assert.equal((await ask()).text, `exit code: 0\n${END_LEFT_OUT()}\n--- stdout ---\ncut short`);
});

test('a secret cut by a time limit or a broken stream, not by the read limit, is never shown in part', async () => {
  // The last line, with the piece and what comes before it on that line, is left out with the last 1 KiB.
  state.perform = () => ({
    exitCode: null, stdout: `first line\n${'y'.repeat(1000)} the token ${TOKEN.slice(0, 20)}`, stderr: '', timedOut: true,
  });
  const late = await ask();
  assertNoPiece(late.text);
  assert.equal(late.text, `timed out after 30s\n${END_LEFT_OUT()}\n--- stdout ---\nfirst line`);
  // A broken stream cuts both streams of the call: stderr, shorter than 1 KiB, shows nothing.
  state.perform = () => ({
    exitCode: 1, stdout: `${TOKEN}\n${'r'.repeat(1030)}${TOKEN.slice(0, 5)}`, stderr: 'the reply was cut off\n', cutOff: true,
  });
  const broken = await ask();
  assertNoPiece(broken.text);
  assert.equal(broken.text, `exit code: 1\n${END_LEFT_OUT()}\n${END_LEFT_OUT('stderr')}\n--- stdout ---\n[hidden]`);
});

test('a stream that ended keeps its end even when it starts a hidden text, and a cut one loses its last 1 KiB', async () => {
  // Before, the end of every stream was dropped when it was a proper start of a hidden text, which told whether a
  // guess starts a secret. A stream that ended on its own now shows its end as the program wrote it.
  probe.hiddenForms = () => ['ab', 'abcdef-unmistakable', 'q'];
  try {
    state.perform = () => ({ exitCode: 0, stdout: 'keep xyabcd', stderr: 'keep this q' });
    const answer = await ask();
    assert.equal(answer.text, 'exit code: 0\n--- stdout ---\nkeep xy[hidden]cd\n--- stderr ---\nkeep this [hidden]');
    state.perform = () => ({ exitCode: 0, stdout: 'ends in a', stderr: 'ends in ab' });
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nends in a\n--- stderr ---\nends in [hidden]');
    // The same texts in a stream that timed out: the last 1 KiB, counted once hidden, goes back to a newline.
    state.perform = () => ({
      exitCode: null, stdout: 'keep xyabcd', stderr: `keep\n${'z'.repeat(1016)}ends in ab`, timedOut: true,
    });
    assert.equal((await ask()).text, `timed out after 30s\n${END_LEFT_OUT()}\n${END_LEFT_OUT('stderr')}\n--- stderr ---\nkeep`);
  } finally {
    delete probe.hiddenForms;
  }
});

test('a cut secret that a shorter hidden text overlaps, or that ends in a cut character, is never shown in part', async () => {
  probe.hiddenForms = () => ['bob', 'xbobsecret-unmistakable', 'pässwörd-unmistakable'];
  try {
    state.perform = () => ({ exitCode: 0, stdout: 'user xbobsec', stderr: 'pass pä�' });
    // Streams that ended on their own are shown as written, with each whole hidden text hidden.
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nuser x[hidden]sec\n--- stderr ---\npass pä�');
    state.perform = () => ({ exitCode: 0, stdout: 'not a secret �', stderr: '' });
    assert.equal((await ask()).text, 'exit code: 0\n--- stdout ---\nnot a secret �');
    // The same pieces at the end of streams that timed out are left out with the line they are on. Hiding bob makes
    // the cut piece 5 bytes longer, and the 1 KiB is counted after that.
    state.perform = () => ({
      exitCode: null, stdout: `user\n${'z'.repeat(1007)}user xbobsec`, stderr: `pass\n${'z'.repeat(1013)}pass pä�`, timedOut: true,
    });
    const cut = await ask();
    assert.equal(cut.text, `timed out after 30s\n${END_LEFT_OUT()}\n${END_LEFT_OUT('stderr')}\n--- stdout ---\nuser\n--- stderr ---\npass`);
    assert.ok(!cut.text.includes('xbob') && !cut.text.includes('pä'));
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
    assert.ok(answer.text.startsWith(`exit code: 0\n${AT_LIMIT()}\n--- stdout ---\n${'x'.repeat(VISIBLE - into)}`), `${into}`);
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
  assert.match(atLimit.text, /^exit code: (?:null|0)\n\[stdout cut at 256 KiB: the rest was left out\]\n--- stdout ---\nx+$/);
  assert.equal(stdoutOf(atLimit.text), 'x'.repeat(VISIBLE));

  state.perform = viaEngine(`process.stdout.write('x'.repeat(${VISIBLE - 15}) + process.env.TOK + '\\n')`);
  const atVisible = await ask();
  assertNoPiece(atVisible.text);
  assert.equal(stdoutOf(atVisible.text), `${'x'.repeat(VISIBLE - 15)}[hidden]`);
  assert.ok(!atVisible.text.includes(' cut'));

  state.perform = viaEngine(`process.stdout.write('z' + process.env.TOK.repeat(Math.ceil(Number(process.env.LIMIT) / process.env.TOK.length)))${STAY}`);
  const shifted = await ask();
  assertNoPiece(shifted.text);
  // Hidden, the stream is far shorter than the visible limit and has no newline: nothing of it is shown.
  assert.match(shifted.text, /^exit code: (?:null|0)\n\[stdout cut: the stream did not end on its own, so its end was left out\]$/);
});

test('the command engine: a path that a child of the client was writing when the grace period ended is never shown in part', async () => {
  const folder = path.join(root, 'st');
  const child = `process.stdout.write(${JSON.stringify(folder.slice(0, folder.length - 2))}); setInterval(() => {}, 1000);`;
  // done goes out first, then the child starts and writes its piece of a path, and the client exits while the child
  // still holds the stream, so the grace period ends it with that piece last, whatever the timing. The stream did not
  // end on its own, so its last 1 KiB, which holds the piece, is left out back to a newline: a line of 1 KiB after done
  // keeps done in view.
  state.perform = viaEngine(`process.stdout.write('done\\n' + 'p'.repeat(1024), () => { require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit'] }); setTimeout(() => process.exit(0), 300); });`);
  const answer = await ask();
  assert.equal(answer.text, `exit code: 0\n${END_LEFT_OUT()}\n--- stdout ---\ndone`);
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
  assert.equal(answer.text, [
    'exit code: 3',
    '[stdout cut: showing 128 KiB of 195 KiB]',
    '--- stdout ---',
    // A brokered stream has no end part: the smaller answer shows its first 128 KiB.
    '\u0001'.repeat(131072),
    '--- stderr ---',
    '"'.repeat(1000),
  ].join('\n'));
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
