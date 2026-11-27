import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS } from '../src/kinds/index.js';
import { decide, tokenizeSshCommand } from '../src/allowlist.js';
import { answerCall } from '../src/tools.js';
import { tempDir } from './temp.js';

// What the end of a brokered stream and the read limit may tell about a hidden text: nothing. A stream that ended on
// its own is shown to its end; one that did not loses its end at a place that its content does not choose; and a
// stream longer than the visible limit once cleaned looks the same whether or not the read limit stopped it. These
// tests use a stand-in brokered kind and made-up secrets.
const KIB = 1024;
const VISIBLE = 256 * KIB;
const READ = VISIBLE + 8 * 4096;
const AT_LIMIT = '[stdout cut at 256 KiB: the rest was left out]';
const END_LEFT_OUT = '[stdout cut: the stream did not end on its own, so its end was left out]';
const SECRET = 'pw-Hq7L2xVm9Kd4Rs8T';

const root = fs.realpathSync(tempDir('ks-leak-', os.tmpdir()));
const stateDir = path.join(root, 'st');
for (const dir of [path.join(stateDir, 'logs'), path.join(stateDir, 's'), path.join(stateDir, 'session'), path.join(root, 'cfg'), path.join(root, 'home')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: stateDir,
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};

const state = { perform: null };
const leaky = {
  key: 'leaky',
  flag: 'leaky',
  label: 'lky',
  word: 'leaky',
  noun: 'leaky target',
  countNoun: 'leaky target(s)',
  brokered: true,
  decide(target, input) {
    const tokens = tokenizeSshCommand(input);
    return { ...decide(tokens, target.allow), argv: tokens };
  },
  async perform(target, decision, context) {
    return state.perform(context);
  },
  tool: {
    name: 'leaky_exec', nameKey: 'target', detailKey: 'command', detailIsArray: false, definition: {},
  },
  toolBullet: '- `leaky_exec` - a stand-in.',
  agentSection: (t) => `### leaky target \`${t.name}\``,
};
KINDS.push(leaky);
after(() => {
  KINDS.splice(KINDS.indexOf(leaky), 1);
  fs.rmSync(root, { recursive: true, force: true });
});
const target = { kind: 'leaky', name: 'c1', allow: ['show'] };

async function ask(perform, secrets = { TOK: SECRET }) {
  state.perform = perform;
  const answer = await answerCall({
    kind: 'leaky', name: 'c1', input: 'show', timeoutSeconds: 30,
  }, {
    calls: new Map([['leaky:c1', { target, secrets }]]),
    session: { targets: [target] },
    env,
    signal: new AbortController().signal,
    review: async () => null,
    stderr: { write() {} },
  });
  return answer.text;
}

// A stream that ended on its own, and three that did not: the time limit, a broken stream, a reader that stopped.
const ended = (stdout) => () => ({ exitCode: 0, stdout, stderr: '' });
const timedOut = (stdout) => () => ({
  exitCode: null, timedOut: true, stdout, stderr: '',
});
const broken = (stdout) => () => ({
  exitCode: 1, stdout, stderr: '', cutOff: true,
});
const truncated = (stdout) => () => ({
  exitCode: 0, stdout, stderr: '', truncated: true,
});
// A perform that reads up to the read limit, as the real kinds do.
const reading = (out) => ({ maxBytes }) => {
  const bytes = Buffer.from(out);
  if (bytes.length <= maxBytes) return { exitCode: 0, stdout: out, stderr: '' };
  return {
    exitCode: 0, stdout: bytes.subarray(0, maxBytes).toString(), stderr: '', truncated: true,
  };
};

// The stdout section of an answer, and the lines before it.
function partsOf(text) {
  const at = text.indexOf('\n--- stdout ---\n');
  return at === -1 ? { head: text.split('\n'), stdout: '' } : { head: text.slice(0, at).split('\n'), stdout: text.slice(at + 16) };
}

function assertNoPiece(text, secret, least = 4) {
  const shown = text.replaceAll('[hidden]', '');
  for (let n = least; n <= secret.length; n += 1) {
    for (let i = 0; i + n <= secret.length; i += 1) assert.ok(!shown.includes(secret.slice(i, i + n)), `${secret.slice(i, i + n)} is shown`);
  }
}

test('a stream that ended on its own keeps its end, so a guess at its end tells nothing about a secret', async () => {
  // Before, the end of every stream was dropped when it was a proper start of a hidden text: "row: pw-H" came back as
  // "row:" and "row: pw-X" whole, which spelled the secret out one character at a time.
  for (let n = 1; n < SECRET.length; n += 1) {
    for (const guess of [SECRET.slice(0, n), `${SECRET.slice(0, n - 1)}#`]) {
      assert.equal(await ask(ended(`row: |${guess}`)), `exit code: 0\n--- stdout ---\nrow: |${guess}`);
    }
  }
  assert.equal(await ask(ended(`row: ${SECRET}`)), 'exit code: 0\n--- stdout ---\nrow: [hidden]');
  // The same in a stream longer than the visible limit: its line does not tell either.
  const answers = [];
  for (const guess of ['pw-H', 'pw-X']) answers.push((await ask(ended(`${'x'.repeat(VISIBLE + 1000)}\nrow: ${guess}`))).replace(guess, ''));
  assert.equal(answers[0], answers[1]);
});

test('a whole secret at the end of a stream is hidden, also when its end is the same as its start', async () => {
  // Before, the last characters that were also the first ones were taken for a cut secret and dropped, and the rest
  // of the secret was shown.
  for (const secret of ['Tk9-wQ7z-Rm2T', 'ab-Q7zRm2pX-ab', 'sssssssssssss']) {
    assert.equal(await ask(ended(`key is ${secret}`), { TOK: secret }), 'exit code: 0\n--- stdout ---\nkey is [hidden]');
    const long = await ask(ended(`${'x'.repeat(VISIBLE - 100)}\nlast line: ${secret}`), { TOK: secret });
    assert.ok(long.endsWith('\nlast line: [hidden]'), secret);
  }
});

test('a stream that did not end on its own is cut after the last newline at least 1 KiB before its end', async () => {
  for (const cut of [timedOut, broken, truncated]) {
    const first = cut === timedOut ? 'timed out after 30s' : `exit code: ${cut === broken ? 1 : 0}`;
    // 1024 bytes after the newline: the line before it is shown. One byte fewer: it is not.
    assert.equal(await ask(cut(`one\ntwo\n${'z'.repeat(1024)}`)), `${first}\n${END_LEFT_OUT}\n--- stdout ---\none\ntwo`);
    assert.equal(await ask(cut(`one\ntwo\n${'z'.repeat(1023)}`)), `${first}\n${END_LEFT_OUT}\n--- stdout ---\none`);
    // No newline that far from the end: nothing is shown, and the line still says that there was output.
    assert.equal(await ask(cut(`one\ntwo\n${'z'.repeat(1019)}`)), `${first}\n${END_LEFT_OUT}`);
    assert.equal(await ask(cut('z'.repeat(5000))), `${first}\n${END_LEFT_OUT}`);
    assert.equal(await ask(cut('short')), `${first}\n${END_LEFT_OUT}`);
  }
  // A stream with no output has no line: nothing was left out. A reader that stopped before any output still has one.
  assert.equal(await ask(timedOut('')), 'timed out after 30s');
  assert.equal(await ask(broken('')), 'exit code: 1');
  assert.equal(await ask(truncated('')), `exit code: 0\n${END_LEFT_OUT}`);
  // The newline is found in bytes: a character of three bytes counts as three.
  assert.equal(await ask(timedOut(`one\n${'€'.repeat(342)}`)), `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\none`);
  assert.equal(await ask(timedOut(`one\n${'€'.repeat(341)}`)), `timed out after 30s\n${END_LEFT_OUT}`);
});

test('a secret that the end of a stream cut shows no piece, wherever the cut falls and whatever comes before', async () => {
  for (const cut of [timedOut, broken, truncated]) {
    for (let n = 1; n < SECRET.length; n += 1) {
      for (const lead of ['', 'row 1\n', `${'row\n'.repeat(400)}`, `${'x'.repeat(3000)}\nkey=`]) {
        const text = await ask(cut(`${lead}${SECRET.slice(0, n)}`));
        // What is shown is a start of what came before the piece, and nothing of the piece.
        assert.ok(lead.startsWith(partsOf(text).stdout), `${n} characters after ${lead.length}`);
        assertNoPiece(text, SECRET);
      }
    }
  }
  // The same in a stream that reached the read limit, cut at every place of the secret.
  for (let n = 1; n < SECRET.length; n += 1) {
    const text = await ask(reading(`${'x'.repeat(READ - n)}${SECRET}`));
    assert.equal(text, `exit code: 0\n${AT_LIMIT}\n--- stdout ---\n${'x'.repeat(VISIBLE)}`);
  }
});

test('where a stream that did not end on its own is cut does not depend on the length of a secret in it', async () => {
  // Counting the 1 KiB in the stream as it was read would tell the length: a line is shown exactly when the secret
  // and the padding after it reach 1 KiB. The bytes are counted once the secret is hidden, as 8 bytes whatever it is.
  for (const pad of [1015, 1016, 1017]) {
    const answers = [];
    for (const secret of ['short-one-12', 'a-much-longer-secret-value-0123456789', 's3cr3t-0'.repeat(16)]) {
      answers.push(await ask(timedOut(`a line\n${secret}${'z'.repeat(pad)}`), { TOK: secret }));
    }
    assert.equal(answers[0], answers[1], `${pad}`);
    assert.equal(answers[0], answers[2], `${pad}`);
    assert.equal(answers[0], `timed out after 30s\n${END_LEFT_OUT}${pad >= 1016 ? '\n--- stdout ---\na line' : ''}`, `${pad}`);
  }
});

test('what is left out is 1 KiB for hidden texts of up to 128 characters, then 8 KiB for each 1024 characters of the longest', async () => {
  // A cut piece of a hidden text has fewer characters than the text, and hiding makes a character at most 8 bytes. The
  // size tells of the longest hidden text only whether it is over 128 characters, and then its length in steps of 1024.
  for (const [length, kib] of [[1, 1], [128, 1], [129, 8], [600, 8], [1024, 8], [1025, 16], [3000, 24]]) {
    const secret = `k${'Q'.repeat(length - 1)}`;
    const shown = await ask(timedOut(`a line\n${'z'.repeat(kib * KIB)}`), { TOK: secret });
    assert.equal(shown, `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\na line`, `${length}`);
    const none = await ask(timedOut(`a line\n${'z'.repeat(kib * KIB - 1)}`), { TOK: secret });
    assert.equal(none, `timed out after 30s\n${END_LEFT_OUT}`, `${length}`);
  }
  // The forms that a kind gives count too.
  leaky.hiddenForms = () => ['f'.repeat(200)];
  try {
    assert.equal(await ask(timedOut(`a line\n${'z'.repeat(8191)}`)), `timed out after 30s\n${END_LEFT_OUT}`);
    assert.equal(await ask(timedOut(`a line\n${'z'.repeat(8192)}`)), `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\na line`);
  } finally {
    delete leaky.hiddenForms;
  }
});

test('a cut piece of a secret that holds shorter hidden texts, which hiding makes longer, is still left out whole', async () => {
  // The piece is 99 characters of a secret of 100; a hidden text of one character is in it 49 times, and each becomes
  // 8 bytes: 442 bytes once hidden, more than the piece itself, and less than the 1 KiB that is left out.
  const long = 'ab'.repeat(50);
  const text = await ask(timedOut(`a line\n${'z'.repeat(1024 - 442)}${long.slice(0, 99)}`), { LONG: long, ONE: 'b' });
  assert.equal(text, `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\na line`);
});

test('a private key that the end of a stream cut shows none of its lines', async () => {
  const KEY = [
    '-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu',
    'ictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSn', '-----END PRIVATE KEY-----',
  ].join('\n');
  // Cut after each of its lines, and in the middle of each, in a short stream and after a long one.
  for (const lead of ['log line\n', `${'log line\n'.repeat(2000)}`, `${'j'.repeat(VISIBLE + 3000)}\n`]) {
    for (let at = 1; at < KEY.length; at += 7) {
      const piece = KEY[at] === '\n' ? KEY.slice(0, at + 1) : KEY.slice(0, at);
      for (const cut of [timedOut, broken]) {
        const text = await ask(cut(`${lead}${piece}`), { KEY });
        for (const line of KEY.split('\n')) assert.ok(!text.includes(line.slice(0, 12)), `${line.slice(0, 12)} is shown, cut at ${at}`);
      }
    }
  }
  // Whole, it is hidden, in a stream that ended and in one that did not.
  assert.equal(await ask(ended(`key:\n${KEY}\n`), { KEY }), 'exit code: 0\n--- stdout ---\nkey:\n[hidden]');
  assert.equal(await ask(timedOut(`key:\n${KEY}\nmore\n${'z'.repeat(8192)}`), { KEY }), `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\nkey:\n[hidden]\nmore`);
});

test('a stream longer than the visible limit once cleaned looks the same whether or not the read limit stopped it', async () => {
  // Before, the answer said "cut at 288 KiB" exactly when the secret and the padding reached the read limit, and
  // "cut: showing" below it: halving the padding found the switch, and so the length of the secret.
  const answers = new Set();
  for (const secret of ['short-one-12', 'a-much-longer-secret-value-0123456789', 's'.repeat(300), `k${'Q'.repeat(2999)}`]) {
    const exact = READ - secret.length - 1;
    for (const pad of [VISIBLE, exact - 20000, exact - 2, exact - 1, exact, exact + 1, exact + 2, READ - 1, READ, READ + 50000]) {
      answers.add(await ask(reading(`${secret}\n${'x'.repeat(pad)}`), { TOK: secret }));
    }
  }
  assert.deepEqual([...answers], [`exit code: 0\n${AT_LIMIT}\n--- stdout ---\n[hidden]\n${'x'.repeat(VISIBLE - 9)}`]);
  // One byte over the visible limit is enough, and the visible limit itself is shown whole, with no line.
  assert.equal(await ask(ended('w'.repeat(VISIBLE + 1))), `exit code: 0\n${AT_LIMIT}\n--- stdout ---\n${'w'.repeat(VISIBLE)}`);
  assert.equal(await ask(ended('w'.repeat(VISIBLE))), `exit code: 0\n--- stdout ---\n${'w'.repeat(VISIBLE)}`);
  // No end part, and no size of the whole stream.
  const long = await ask(ended(`${'x'.repeat(VISIBLE + 9000)}\nthe last line\n`));
  assert.equal(long, `exit code: 0\n${AT_LIMIT}\n--- stdout ---\n${'x'.repeat(VISIBLE)}`);
});

test('the read limit grows with what is left out, so a long hidden text of the target does not bring the switch back', async () => {
  // With a hidden text of 4096 characters or more, what is left out is the whole margin of 32 KiB or more: at a fixed
  // read limit of 288 KiB, a stream that reached it would show less than the visible limit, and one byte fewer the
  // whole of it, which told the length of any secret in it. The read limit is 32 KiB and what is left out over 1 KiB.
  const key = `k${'Q'.repeat(4199)}`;
  const answers = new Set();
  let limit;
  for (const password of ['short-one-12ab', 'a-much-longer-password-0123456?']) {
    for (const off of [-2, -1, 0, 1, 2, 5000]) {
      answers.add(await ask(({ maxBytes }) => {
        limit = maxBytes;
        return reading(`${password}\n${'x'.repeat(maxBytes - password.length - 1 + off)}`)({ maxBytes });
      }, { KEY: key, PW: password }));
    }
  }
  assert.equal(limit, READ + 5 * 8 * KIB - KIB);
  assert.deepEqual([...answers], [`exit code: 0\n${AT_LIMIT}\n--- stdout ---\n[hidden]\n${'x'.repeat(VISIBLE - 9)}`]);
  // One copy of a long secret itself, of 5000 and of 20000 characters.
  for (const length of [5000, 20000]) {
    const long = `k${'Q'.repeat(length - 1)}`;
    const seen = new Set();
    for (const off of [-2, -1, 0, 1, 2]) {
      seen.add(await ask(({ maxBytes }) => reading(`${long}\n${'x'.repeat(maxBytes - length - 1 + off)}`)({ maxBytes }), { KEY: long }));
    }
    assert.deepEqual([...seen], [`exit code: 0\n${AT_LIMIT}\n--- stdout ---\n[hidden]\n${'x'.repeat(VISIBLE - 9)}`], `${length}`);
  }
});

test('the text of a kind about why a call stopped, marked ownStderr, is shown whole beside a stream that lost its end', async () => {
  const note = 'the reply was cut off\n';
  const marked = await ask(() => ({
    exitCode: 1, stdout: `one\n${'z'.repeat(1024)}`, stderr: note, cutOff: true, ownStderr: true,
  }));
  assert.equal(marked, `exit code: 1\n${END_LEFT_OUT}\n--- stdout ---\none\n--- stderr ---\nthe reply was cut off`);
  // Without the mark, stderr is a stream of the service as stdout is, and loses its end.
  const plain = await ask(() => ({
    exitCode: 1, stdout: `one\n${'z'.repeat(1024)}`, stderr: note, cutOff: true,
  }));
  assert.equal(plain, `exit code: 1\n${END_LEFT_OUT}\n${END_LEFT_OUT.replace('stdout', 'stderr')}\n--- stdout ---\none`);
});

test('a long stream that did not end on its own shows the visible limit, wherever its newlines and a secret lie', async () => {
  // Looking for the last newline 1 KiB before the end of a stream that the read limit stopped would tell the length
  // of a secret before that newline, which moves it. With the visible limit and 1 KiB more once cleaned, the first
  // bytes are shown as they are, and the place of the cut is past what is shown.
  const answers = new Set();
  for (const secret of ['short-one-12', 'a-much-longer-secret-value-0123456789', 's3cr3t-0'.repeat(16)]) {
    for (const near of [1020, 1024, 1030, 1100]) {
      const out = `one\n${secret}${'x'.repeat(READ - secret.length - 5 - near)}\n${'y'.repeat(READ)}`;
      answers.add(await ask(reading(out), { TOK: secret }));
    }
  }
  assert.deepEqual([...answers], [`exit code: 0\n${AT_LIMIT}\n--- stdout ---\none\n[hidden]${'x'.repeat(VISIBLE - 12)}`]);
  // The same for a stream that the time limit ended: with the visible limit, 4 KiB for a path and the 1 KiB that is
  // left out, its first bytes are shown; with one byte fewer, the newline rule.
  const flat = 'x'.repeat(VISIBLE + 4096 + 1024);
  assert.equal(await ask(timedOut(`one\n${flat.slice(4)}`)), `timed out after 30s\n${AT_LIMIT}\n--- stdout ---\none\n${'x'.repeat(VISIBLE - 4)}`);
  assert.equal(await ask(timedOut(`one\n${flat.slice(5)}`)), `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\none`);
});

test('a path of the session that crosses the visible limit is not shown in part, and a guess there is not dropped', async () => {
  const more = `/file ${'y'.repeat(6000)}`;
  for (const cut of [ended, timedOut, truncated]) {
    // The path starts 20 bytes before the visible limit: the answer stops before it.
    const lead = 'x'.repeat(VISIBLE - 20);
    assert.equal(partsOf(await ask(cut(`${lead}${stateDir}${more}`))).stdout, lead, 'no piece of the path');
    // Wholly before it, the path is scrubbed, and the 256 KiB are counted before the scrub.
    const early = 'x'.repeat(VISIBLE - 200);
    const whole = partsOf(await ask(cut(`${early}${stateDir}${more}`))).stdout;
    assert.equal(whole, `${early}<ksproxy>/file ${'y'.repeat(200 - stateDir.length - 6)}`);
    // A start of the folder that the agent wrote there itself is shown as any other text: what follows it is not the
    // folder, so nothing is scrubbed, and nothing tells whether the guess was right.
    for (const guess of [stateDir.slice(0, 20), `${stateDir.slice(0, 19)}#`]) {
      assert.equal(partsOf(await ask(cut(`${lead}${guess}${'Q'.repeat(6000)}`))).stdout, `${lead}${guess}`);
    }
    // A character of 3 bytes that the visible limit splits is left out whole.
    assert.equal(partsOf(await ask(cut(`${'x'.repeat(VISIBLE - 1)}\u20ac${'z'.repeat(6000)}`))).stdout, 'x'.repeat(VISIBLE - 1));
  }
});

test('how much the scrub takes out of a stream that the read limit stopped does not decide what is shown', async () => {
  // Before, the visible limit was looked for after the scrub: hundreds of copies of a path of the session, which the
  // scrub makes shorter, brought the stream under it, and what was shown then moved with the length of a secret.
  const answers = new Set();
  for (const secret of ['short-one-12', 'short-one-123', 'a-much-longer-secret-value-0123456789']) {
    const out = `${`${stateDir}\n`.repeat(700)}${secret}\n${'row\n'.repeat(100000)}`;
    answers.add(await ask(reading(out), { TOK: secret }));
  }
  assert.equal(answers.size, 1);
  const [answer] = answers;
  assert.equal(partsOf(answer).head[1], AT_LIMIT);
  assert.ok(partsOf(answer).stdout.startsWith(`${'<ksproxy>\n'.repeat(700)}[hidden]\nrow\n`));
});

test('a hidden text that is a piece of the word hidden does not make the text grow twice', async () => {
  // Hiding one value after another replaced the bracket of each [hidden] again: a cut piece then grew past what is
  // left out, and its first character was shown.
  const long = `x${'a'.repeat(127)}`;
  const secrets = { LONG: long, A: 'a', B: '[' };
  assert.equal(await ask(ended('a[a'), secrets), 'exit code: 0\n--- stdout ---\n[hidden][hidden][hidden]');
  // 15 bytes, the x, and 126 times [hidden]: 1 KiB, all of it left out.
  const text = await ask(timedOut(`a line\n${'z'.repeat(15)}${long.slice(0, 127)}`), secrets);
  assert.equal(text, `timed out after 30s\n${END_LEFT_OUT}\n--- stdout ---\n[hidden] line`);
});

test('a stream that the read limit stopped, from which hiding took almost all of the margin, shows no piece of a secret', async () => {
  // Thousands of copies of a secret: hiding takes more than the margin of 32 KiB less 1 KiB out, the stream is shorter
  // than the visible limit and 1 KiB once cleaned, and it is cut as any other stream that did not end on its own.
  const secret = 'sixteen-bytes-ab';
  const out = `${`${secret}\n`.repeat(8000)}${'x'.repeat(READ)}`;
  const text = await ask(reading(out), { TOK: secret });
  const { head, stdout } = partsOf(text);
  assert.equal(head[1], END_LEFT_OUT);
  assert.equal(stdout, '[hidden]\n'.repeat(8000).trimEnd());
  // A copy that the read limit cut, after copies enough: no piece of it.
  const cutCopy = await ask(reading(`${'x'.repeat(100)}\n${`${secret}\n`.repeat(20000)}`), { TOK: secret });
  assertNoPiece(cutCopy, secret);
});

test('halving an answer keeps the line of a cut stream and adds how much it shows', async () => {
  // Control characters take 6 bytes each in the JSON line of the answer, which then keeps half of each stream.
  const ctl = '\u0001';
  assert.equal(partsOf(await ask(ended(ctl.repeat(VISIBLE + 5)))).head[1], '[stdout cut at 256 KiB: the rest was left out; showing 128 KiB]');
  const short = await ask(timedOut(`${ctl.repeat(200 * KIB)}\n${'z'.repeat(1024)}`));
  assert.equal(partsOf(short).head[1], '[stdout cut: the stream did not end on its own, so its end was left out; showing 128 KiB]');
  assert.equal(partsOf(short).stdout, ctl.repeat(128 * KIB));
  // A stream that is whole within the visible limit says how much of it the smaller answer shows.
  const whole = await ask(ended(ctl.repeat(200 * KIB)));
  assert.equal(partsOf(whole).head[1], '[stdout cut: showing 128 KiB of 200 KiB]');
  assert.equal(partsOf(whole).stdout, ctl.repeat(128 * KIB));
  // A stream a little over half the limit, beside one that fills the answer: its sizes are in bytes, as they would look
  // the same in KiB.
  const two = await ask(() => ({ exitCode: 0, stdout: ctl.repeat(128 * KIB + 100), stderr: 'e'.repeat(VISIBLE) }));
  assert.deepEqual(two.split('\n').slice(1, 3), ['[stdout cut: showing 131072 B of 131172 B]', '[stderr cut: showing 128 KiB of 256 KiB]']);
});

test('both streams of a call that did not end on its own lose their end, each with its own line', async () => {
  const text = await ask(() => ({
    exitCode: null, timedOut: true, stdout: `out\n${'o'.repeat(1024)}`, stderr: `err\n${'e'.repeat(1024)}`,
  }));
  assert.equal(text, [
    'timed out after 30s', END_LEFT_OUT, END_LEFT_OUT.replace('stdout', 'stderr'), '--- stdout ---', 'out', '--- stderr ---', 'err',
  ].join('\n'));
  // The stream beside one that the read limit stopped was cut with it: its program was stopped.
  const beside = await ask(({ maxBytes }) => ({
    exitCode: 0, stdout: 'o'.repeat(maxBytes), stderr: `a warning\n${'e'.repeat(1024)}`, truncated: true,
  }));
  assert.equal(beside, `exit code: 0\n${AT_LIMIT}\n${END_LEFT_OUT.replace('stdout', 'stderr')}\n--- stdout ---\n${'o'.repeat(VISIBLE)}\n--- stderr ---\na warning`);
});

test('every place that a hidden text covers is hidden, also where two overlap, whatever their length or characters', async () => {
  const cases = [
    [['abc', 'abcdef', 'cde'], 'x abcdef abcx cde abcde', 'x [hidden] [hidden]x [hidden] [hidden]'],
    [['bcd', 'ab'], 'abcd bcd ab', '[hidden] [hidden] [hidden]'],
    [['aaa'], 'aaaaa aa', '[hidden] aa'],
    [['a', 'b'], 'ab ba', '[hidden][hidden] [hidden][hidden]'],
    [['a.c', '(x|y)*', '[z]', '\\d+$^', '-/'], 'abc a.c (x|y)* z [z] \\d+$^ 12 -/', 'abc [hidden] [hidden] z [hidden] [hidden] 12 [hidden]'],
    [['same', 'same', ''], 'the same same', 'the [hidden] [hidden]'],
    [['line one\nline two', '\u0000nul', '\ud83d\ude00', '\ude00lone'], 'a line one\nline two b \u0000nul c \ud83d\ude00 d \ude00lone', 'a [hidden] b [hidden] c [hidden] d [hidden]'],
    [[], 'nothing to hide', 'nothing to hide'],
  ];
  for (const [values, text, shown] of cases) {
    const secrets = Object.fromEntries(values.map((value, i) => [`S${i}`, value]));
    assert.equal(await ask(ended(text), secrets), `exit code: 0\n--- stdout ---\n${shown}`);
  }
  // A user name whose end is the start of the password, or whose start is its end: before, the one that was hidden
  // first left the rest of the other in clear, and the agent could write the user name less its last characters
  // before a password that the target printed.
  const login = { USER: 'admin', PW: 'nimbus-Long-Pass-42a' };
  assert.equal(await ask(ended(`row: admi${login.PW}`), login), 'exit code: 0\n--- stdout ---\nrow: [hidden]');
  assert.equal(await ask(ended(`row: ${login.PW}dmin`), login), 'exit code: 0\n--- stdout ---\nrow: [hidden]');
  assert.equal(await ask(ended(`row: adm${login.PW}`), login), 'exit code: 0\n--- stdout ---\nrow: adm[hidden]');
  // A hidden text far longer than a regular expression may be: it is still hidden, and the answer is still given.
  const huge = `h${'\u20ac'.repeat(40000)}`;
  assert.equal(await ask(ended(`before ${huge} after`), { HUGE: huge }), 'exit code: 0\n--- stdout ---\nbefore [hidden] after');
});
