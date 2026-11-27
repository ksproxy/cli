import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS } from '../src/kinds/index.js';
import { decide, tokenizeSshCommand } from '../src/allowlist.js';
import { answerCall, callTool, dropCutFolder } from '../src/tools.js';
import { run } from '../src/exec.js';
import { sizeText } from '../src/text.js';
import { agentMdText } from '../src/agent-md.js';
import { writeSession } from '../src/session.js';
import { tempDir } from './temp.js';

// When a stream of a call is cut, the answer says so right after its first line, and the kind's hint says how to
// narrow the call. On ssh the line says how much of the stream is shown, and a stream read to its end also shows its
// last 16 KiB. A brokered stream shows only its first bytes, with no end part: up to the visible limit with the line
// AT_LIMIT, or, when it did not end on its own and is shorter, up to a line end at least 1 KiB before its end with the
// line END_LEFT_OUT. These tests use ssh with stand-in programs and a stand-in brokered kind, each in its own
// temporary home folder.
const KIB = 1024;
const VISIBLE = 256 * KIB;
const READ = VISIBLE + 8 * 4096;
const END = 16 * KIB;
const AT_LIMIT = 'cut at 256 KiB: the rest was left out';
const END_LEFT_OUT = 'cut: the stream did not end on its own, so its end was left out';
// The last bytes kept for the end part: 16 KiB, the margin of 8 times 4096 for what the start of the kept end cut, and
// 4 KiB of slack.
const RING = END + 8 * 4096 + 4096;
const TOKEN = 'pw-Hq7L2xVm9Kd4Rs8T-unmistakable';
const SHELL_HINT = 'narrow it: tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first';
const realKinds = [...KINDS];

const root = fs.realpathSync(tempDir('ks-cut-', os.tmpdir()));
const stateDir = path.join(root, 'st');
const sessionDir = path.join(stateDir, 'session');
for (const dir of [path.join(stateDir, 'logs'), path.join(stateDir, 's'), sessionDir, path.join(root, 'cfg'), path.join(root, 'home')]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
fs.writeFileSync(path.join(stateDir, 's', 'ssh-web1'), '');
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: stateDir,
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};
after(() => fs.rmSync(root, { recursive: true, force: true }));
writeSession(sessionDir, {
  version: 1,
  pid: process.pid,
  startedAt: '2026-11-26T00:00:00.000Z',
  targets: [{
    kind: 'ssh', name: 'web1', description: '', allow: ['big'], host: 'web1.example.com', socket: path.join(stateDir, 's', 'ssh-web1'), state: 'up',
  }],
});

let scripts = 0;
// One ssh_exec call whose stand-in ssh runs body; base is the state folder, which the answer shows as <ksproxy>.
function sshCall(body) {
  scripts += 1;
  const script = path.join(root, `fake-ssh-${scripts}.js`);
  fs.writeFileSync(script, `#!/usr/bin/env node\nconst base = ${JSON.stringify(stateDir)};\n${body}\n`, { mode: 0o755 });
  return callTool('ssh_exec', { server: 'web1', command: 'big' }, { ...env, [['KSPROXY', 'SSH'].join('_')]: script });
}

// The parts of an answer: the lines before the first section, and the text of each section.
function partsOf(text) {
  const at = (marker) => text.indexOf(marker);
  const out = at('\n--- stdout ---\n');
  const err = at('\n--- stderr ---\n');
  const firstSection = [out, err].filter((i) => i !== -1).sort((a, b) => a - b)[0] ?? text.length;
  return {
    head: text.slice(0, firstSection).split('\n'),
    stdout: out === -1 ? '' : text.slice(out + 16, err > out ? err : text.length),
    stderr: err === -1 ? '' : text.slice(err + 16),
  };
}

// The two parts of a stream with an end part (ssh only), and the size the marker between them names.
function splitEnd(stream) {
  const match = /\n\[\.\.\. (\d+(?:\.\d)? (?:B|KiB|MiB|GiB)|under 1 KiB) cut here \.\.\.\]\n/.exec(stream);
  assert.ok(match, 'the stream has the marker');
  return { first: stream.slice(0, match.index), cut: match[1], end: stream.slice(match.index + match[0].length) };
}

// The output of the line stand-in: count lines of about 50 bytes, then the last line.
function linesText(count, last = 'the last line') {
  let out = '';
  for (let i = 0; i < count; i += 1) out += `line ${i} ${'x'.repeat(40)}\n`;
  return `${out}${last}\n`;
}
const linesScript = (count, last = 'the last line') => `let out = ''; for (let i = 0; i < ${count}; i += 1) out += 'line ' + i + ' ' + 'x'.repeat(40) + '\\n'; process.stdout.write(out + ${JSON.stringify(last)} + '\\n');`;

// No piece of at least size characters of text, with a slash in it, is shown.
function assertNoPathPiece(shown, text, size = 8) {
  for (let i = 0; i + size <= text.length; i += 1) {
    const piece = text.slice(i, i + size);
    if (piece.includes('/')) assert.ok(!shown.includes(piece), `the piece ${piece} of the path is shown`);
  }
}

function assertNoPiece(text, secret = TOKEN) {
  const shown = text.replaceAll('[hidden]', '');
  for (let n = 4; n < secret.length; n += 1) {
    for (let i = 0; i + n <= secret.length; i += 1) assert.ok(!shown.includes(secret.slice(i, i + n)) || /^[x\n]+$/.test(secret.slice(i, i + n)), `${secret.slice(i, i + n)} is shown`);
  }
}

test('sizeText gives bytes below 1 KiB, one decimal below 10 of a unit, and no decimal from 10 up', () => {
  assert.equal(sizeText(0), '0 B');
  assert.equal(sizeText(1023), '1023 B');
  assert.equal(sizeText(1024), '1 KiB');
  assert.equal(sizeText(1536), '1.5 KiB');
  assert.equal(sizeText(10 * KIB - 1), '10 KiB');
  assert.equal(sizeText(VISIBLE), '256 KiB');
  assert.equal(sizeText(READ), '288 KiB');
  assert.equal(sizeText(Math.round(9.4 * KIB * KIB)), '9.4 MiB');
  assert.equal(sizeText(3 * KIB ** 3), '3 GiB');
  assert.equal(sizeText(5 * KIB ** 4), '5120 GiB');
  assert.equal(sizeText(KIB * KIB - 10), '1 MiB');
  assert.equal(sizeText(KIB * KIB + 100 * KIB), '1.1 MiB');
});

test('run keeps the last tailBytes bytes of each stream, whatever maxBytes kept, and none without tailBytes', async () => {
  const parts = ['a'.repeat(70000), 'b'.repeat(30), 'c'.repeat(90), 'd'.repeat(250), 'e'.repeat(7)];
  const script = `const parts = ${JSON.stringify(parts)}; let i = 0; const next = () => { if (i === parts.length) { process.stderr.write('short'); return; } process.stdout.write(parts[i], () => setTimeout(next, 20)); i += 1; }; next();`;
  const r = await run(process.execPath, ['-e', script], { maxBytes: 1000, tailBytes: 100 });
  assert.equal(r.stdout, 'a'.repeat(1000));
  assert.equal(r.stdoutTail.toString(), parts.join('').slice(-100));
  assert.equal(r.stderrTail.toString(), 'short');
  assert.equal(r.stdoutBytes, parts.join('').length);
  const none = await run(process.execPath, ['-e', 'process.stdout.write("hi")']);
  assert.equal(none.stdoutTail, null);
  assert.equal(none.stderrTail, null);
});

test('ssh: a short answer is the same as before, byte for byte', async () => {
  const r = await sshCall("process.stdout.write('hello\\n'); process.stderr.write('note\\n');");
  assert.deepEqual(r, { text: 'exit code: 0\n--- stdout ---\nhello\n--- stderr ---\nnote', isError: false });
});

test('ssh: a cut stream says how much it shows of its total near the top, then shows its first part, a marker and its last lines', async () => {
  const count = 120000;
  const total = Buffer.byteLength(linesText(count));
  const r = await sshCall(`${linesScript(count)} process.stderr.write('done\\n');`);
  assert.equal(r.isError, false);
  const { head, stdout, stderr } = partsOf(r.text);
  const { first, cut, end } = splitEnd(stdout);
  const showing = Buffer.byteLength(first) + Buffer.byteLength(end);
  assert.deepEqual(head, ['exit code: 0', `[stdout cut: showing ${sizeText(showing)} of ${sizeText(total)}]`, SHELL_HINT]);
  assert.equal(sizeText(total), '6 MiB');
  assert.equal(cut, sizeText(total - showing));
  assert.ok(first.startsWith('line 0 '));
  assert.ok(end.endsWith('\nthe last line'));
  assert.match(end, /^line \d+ x{40}\n/);
  assert.ok(Buffer.byteLength(end) <= END && Buffer.byteLength(end) > END - 200, `${Buffer.byteLength(end)}`);
  assert.ok(Buffer.byteLength(stdout) <= VISIBLE);
  assert.ok(Buffer.byteLength(stdout) > VISIBLE - 200);
  assert.equal(stderr, 'done');
});

test('ssh: two cut streams give two cut lines and one hint', async () => {
  const r = await sshCall(`process.stdout.write('o'.repeat(${600 * KIB})); process.stderr.write('e'.repeat(${300 * KIB}) + '\\nlast of stderr\\n');`);
  const { head, stdout, stderr } = partsOf(r.text);
  assert.equal(head.length, 4);
  assert.match(head[1], /^\[stdout cut: showing 256 KiB of 600 KiB\]$/);
  assert.match(head[2], /^\[stderr cut: showing 256 KiB of 300 KiB\]$/);
  assert.equal(head[3], SHELL_HINT);
  assert.equal(splitEnd(stdout).end, 'o'.repeat(END));
  assert.equal(splitEnd(stderr).end, 'last of stderr');
});

test('ssh: a stream between the visible and the read limit shows its end without repeating a line of its first part', async () => {
  let count = 5000;
  while (Buffer.byteLength(linesText(count)) < VISIBLE + 3000) count += 1;
  const r = await sshCall(linesScript(count));
  const { head, stdout } = partsOf(r.text);
  const { first, end } = splitEnd(stdout);
  assert.equal(head[1], `[stdout cut: showing 256 KiB of ${sizeText(Buffer.byteLength(linesText(count)))}]`);
  assert.equal(sizeText(Buffer.byteLength(linesText(count))), '259 KiB');
  const lastFirst = Number(/line (\d+) x*$/.exec(first)[1]);
  const firstEnd = Number(/^line (\d+) /.exec(end)[1]);
  assert.ok(firstEnd > lastFirst, `${firstEnd} > ${lastFirst}`);
  assert.ok(end.endsWith('the last line'));
});

test('ssh: a program that timed out still says how much of its output it shows', async () => {
  scripts += 1;
  const script = path.join(root, `fake-ssh-${scripts}.js`);
  fs.writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write('t'.repeat(${400 * KIB}) + '\\nlast before the limit\\n'); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const r = await callTool('ssh_exec', { server: 'web1', command: 'big', timeout_seconds: 3 }, { ...env, [['KSPROXY', 'SSH'].join('_')]: script });
  const { head, stdout } = partsOf(r.text);
  assert.deepEqual(head.slice(0, 2), ['timed out after 3s', '[stdout cut: showing 256 KiB of 400 KiB]']);
  assert.equal(splitEnd(stdout).end, 'last before the limit');
});

test('ssh: a path that the start of the kept end cuts is never shown in part, with lines after it', async () => {
  const total = 2 * READ;
  // The path starts 10 bytes before the last RING bytes of the stream, so the kept end starts inside it.
  const r = await sshCall(`const lead = ${total - RING - 10}; const head = 'x'.repeat(lead) + base + '/file\\n'; let out = head; let i = 0; while (Buffer.byteLength(out) < ${total}) out += 'y' + (i++) + '\\n'; process.stdout.write(out);`);
  const { stdout } = partsOf(r.text);
  const { end } = splitEnd(stdout);
  assert.match(end, /^y\d+\n/);
  assertNoPathPiece(r.text, stateDir);
});

test('ssh: without a newline, a path cut by the start of the kept end is dropped with the margin, and the rest is shown', async () => {
  const total = 2 * READ;
  const r = await sshCall(`const lead = ${total - RING - 10}; process.stdout.write('x'.repeat(lead) + base + '/' + 'z'.repeat(${total} - lead - base.length));`);
  const { head, stdout } = partsOf(r.text);
  const { end } = splitEnd(stdout);
  assert.match(end, /^\/?z+$/);
  assert.ok(Buffer.byteLength(end) > END - stateDir.length - 20);
  assert.match(head[1], /^\[stdout cut: showing 256 KiB of 576 KiB\]$/);
  assertNoPathPiece(r.text, stateDir);
});

test('ssh: wherever a path lies in the kept end, the end part is the last 16 KiB of the scrubbed stream, with no piece of it', async () => {
  const total = 2 * READ;
  for (const lead of [total - RING - 10, total - RING + 4096 - 5, total - RING + 8 * 4096 - 7, total - END - 20, total - 900]) {
    const r = await sshCall(`process.stdout.write('x'.repeat(${lead}) + base + '/' + 'z'.repeat(${total - lead} - base.length));`);
    const scrubbed = `${'x'.repeat(lead)}<ksproxy>/${'z'.repeat(total - lead - stateDir.length)}`;
    assert.equal(splitEnd(partsOf(r.text).stdout).end, scrubbed.slice(-END), `${total - lead}`);
    assertNoPathPiece(r.text, stateDir);
  }
});

test('ssh: when the scrub takes more than 4 KiB out of the kept bytes, there is no end part', async () => {
  // ssh, kubernetes and local hide no secret; only paths can shrink the last bytes that run kept.
  const copies = Math.ceil(4097 / (stateDir.length - '<ksproxy>'.length)) + 5;
  const r = await sshCall(`process.stdout.write('x'.repeat(${VISIBLE + 100000}) + (base + '\\n').repeat(${copies}));`);
  const { head, stdout } = partsOf(r.text);
  assert.match(head[1], /^\[stdout cut: showing 256 KiB of \d+ KiB\]$/);
  assert.ok(!stdout.includes(' cut here ...]'));
  assert.equal(stdout, 'x'.repeat(VISIBLE));
});

test('ssh: the end part is the last 16 KiB once scrubbed, so what it shows does not tell the length of a path', async () => {
  const r = await sshCall(`process.stdout.write('x'.repeat(${VISIBLE + 1000}) + '|' + 'y'.repeat(20000) + base + ' ' + 'z'.repeat(999));`);
  const { end } = splitEnd(partsOf(r.text).stdout);
  assert.equal(end, `${'y'.repeat(END - 1009)}<ksproxy> ${'z'.repeat(999)}`);
});

test('ssh: without a newline, the end part starts at a whole character, wherever the cut falls in one of 2 bytes', async () => {
  for (const last of ['', 'z']) {
    const r = await sshCall(`process.stdout.write('x'.repeat(${VISIBLE + 1000}) + '\\u00e9'.repeat(20000) + '${last}');`);
    const { end } = splitEnd(partsOf(r.text).stdout);
    assert.match(end, /^\u00e9+z?$/, `${last}`);
    assert.ok(!end.startsWith('\ufffd') && end.endsWith(`\u00e9${last}`), `${last}`);
    assert.ok(Buffer.byteLength(end) <= END && Buffer.byteLength(end) >= END - 1, `${last}: ${Buffer.byteLength(end)}`);
  }
});

// A stand-in brokered kind: every call is decided by its words, and perform does what the test sets.
const state = { perform: null };
const clipped = {
  key: 'clipped',
  flag: 'clipped',
  label: 'clp',
  word: 'clipped',
  noun: 'clipped target',
  countNoun: 'clipped target(s)',
  brokered: true,
  decide(target, input) {
    const tokens = tokenizeSshCommand(input);
    return { ...decide(tokens, target.allow), argv: tokens };
  },
  async perform(target, decision, context) {
    return state.perform(context);
  },
  tool: {
    name: 'clipped_exec', nameKey: 'target', detailKey: 'command', detailIsArray: false, definition: {},
  },
  toolBullet: '- `clipped_exec` - a stand-in.',
  agentSection: (t) => `### clipped target \`${t.name}\``,
};
KINDS.push(clipped);
const brokeredTarget = { kind: 'clipped', name: 'c1', allow: ['show'] };

function ask(perform) {
  state.perform = perform;
  return answerCall({
    kind: 'clipped', name: 'c1', input: 'show', timeoutSeconds: 30,
  }, {
    calls: new Map([['clipped:c1', { target: brokeredTarget, secrets: { TOK: TOKEN } }]]),
    session: { targets: [brokeredTarget] },
    env,
    signal: new AbortController().signal,
    review: async () => null,
    stderr: process.stderr,
  });
}

test('brokered: a stream stopped at the read limit says where, with the default words and no hint, and has no end part', async () => {
  // The short stream beside it was stopped with it, so it did not end on its own either: its end is left out, and
  // it has no line end at least 1 KiB before its end, so none of it is shown.
  const answer = await ask(({ maxBytes }) => ({
    exitCode: 0, stdout: 'x'.repeat(maxBytes), stderr: 'a warning\n', truncated: true,
  }));
  assert.deepEqual(answer, {
    text: `exit code: 0\n[stdout ${AT_LIMIT}]\n[stderr ${END_LEFT_OUT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`,
    isError: false,
  });
});

test('brokered: the kind gives its hint; the other stream of the stopped program loses its end too', async () => {
  clipped.cutHint = 'a narrower command';
  try {
    const answer = await ask(({ maxBytes }) => ({
      exitCode: 0, stdout: 'o'.repeat(maxBytes), stderr: `${'e'.repeat(VISIBLE + 10)}\nlast of stderr`, truncated: true,
    }));
    // stderr is shorter than the visible limit once its last 1 KiB is left out, and its only newline lies in that
    // 1 KiB: nothing of it is shown.
    assert.equal(answer.text, [
      'exit code: 0',
      `[stdout ${AT_LIMIT}]`,
      `[stderr ${END_LEFT_OUT}]`,
      'narrow it: a narrower command',
      '--- stdout ---',
      'o'.repeat(VISIBLE),
    ].join('\n'));
  } finally {
    delete clipped.cutHint;
  }
});

test('brokered: a reader that stopped before anything could be shown still gives the line for stdout', async () => {
  // The note of the reader on stderr did not end on its own either, and is shorter than 1 KiB: it is left out.
  const answer = await ask(() => ({
    exitCode: 1, stdout: '', stderr: 'the reply is larger than the output limit and was cut off\n', truncated: true,
  }));
  assert.deepEqual(answer, {
    text: `exit code: 1\n[stdout ${END_LEFT_OUT}]\n[stderr ${END_LEFT_OUT}]`,
    isError: true,
  });
});

test('brokered: a secret in a whole stream past the visible limit is hidden, and only the first 256 KiB are shown', async () => {
  const total = VISIBLE + 3000;
  for (const into of [3, 12, 25]) {
    const lead = total - RING - into;
    let out = `${'x'.repeat(lead)}${TOKEN}\n`;
    for (let i = 0; Buffer.byteLength(out) < total; i += 1) out += `row ${i}\n`;
    const answer = await ask(() => ({ exitCode: 0, stdout: out, stderr: '' }));
    const cleaned = out.replace(TOKEN, '[hidden]');
    assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${cleaned.slice(0, VISIBLE).trimEnd()}`, `${into}`);
    assertNoPiece(answer.text);
  }
});

test('brokered: where a secret lies past the visible limit does not change the answer, so calls cannot count its length', async () => {
  // Before, the end part was left out exactly when a hidden text crossed the raw place where it started, 16384 bytes
  // before the end (and 20480 in a sketch of the fix): one call per place told the length of a secret. Now there is no
  // end part, and every such answer is the first 256 KiB.
  for (const near of [END, END + 4096]) {
    for (let q = near - 40; q < near + 3; q += 1) {
      const answer = await ask(() => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE + 2000)}${TOKEN}${'z'.repeat(q)}`, stderr: '' }));
      assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`, `${q}`);
    }
  }
  // A hidden text with a newline in it, at the line start that the end part once looked for: hidden whole.
  const SPLIT = 'split-secret-first-half\nsplit-secret-second-half';
  clipped.hiddenForms = () => [SPLIT];
  try {
    const total = VISIBLE + 3000;
    const at = total - END - 'split-secret-first-half'.length;
    const answer = await ask(() => ({ exitCode: 0, stdout: `${'x'.repeat(at)}${SPLIT}\n${'z'.repeat(total - at - SPLIT.length - 1)}`, stderr: '' }));
    const cleaned = `${'x'.repeat(at)}[hidden]\n${'z'.repeat(total - at - SPLIT.length - 1)}`;
    assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${cleaned.slice(0, VISIBLE)}`);
    assert.ok(!answer.text.includes('split-secret'));
  } finally {
    delete clipped.hiddenForms;
  }
});

test('brokered: a stream past the visible limit gives the same answer whatever the length of a secret after it', async () => {
  const answers = [];
  for (const secret of ['abc', 'a-much-longer-secret-value-0123456789', 's'.repeat(300)]) {
    const out = `${'x'.repeat(VISIBLE + 1000)}|${'y'.repeat(20000)}${secret}${'z'.repeat(1000)}`;
    answers.push((await askWith(() => ({ exitCode: 0, stdout: out, stderr: '' }), { TOK: secret })).text);
  }
  assert.equal(answers[0], answers[1]);
  assert.equal(answers[0], answers[2]);
  assert.equal(answers[0], `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`);
});

test('brokered: a stream stopped at the read limit shows the whole visible limit, whatever hiding took out of it', async () => {
  const answers = [];
  for (const secret of ['abc', 'a-much-longer-secret-value-0123456789']) {
    answers.push((await askWith(({ maxBytes }) => ({
      exitCode: 0, stdout: `${secret}${'x'.repeat(maxBytes - secret.length)}`, stderr: '', truncated: true,
    }), { TOK: secret })).text);
  }
  assert.equal(answers[0], answers[1]);
  assert.equal(partsOf(answers[0]).stdout, `[hidden]${'x'.repeat(VISIBLE - 8)}`);
});

test('brokered: a path that the read limit cut is dropped from a stopped stream, which needs no margin for it', async () => {
  const answer = await ask(({ maxBytes }) => ({
    exitCode: 0, stdout: `${'x'.repeat(VISIBLE - 100)}${stateDir}/a\n${'x'.repeat(maxBytes)}`.slice(0, maxBytes - 10) + stateDir, stderr: '', truncated: true,
  }));
  assert.ok(partsOf(answer.text).stdout.startsWith(`${'x'.repeat(VISIBLE - 100)}<ksproxy>/a\n`));
  // The first 256 KiB are counted before the scrub, which then makes the path in them shorter.
  assert.equal(Buffer.byteLength(partsOf(answer.text).stdout), VISIBLE - stateDir.length + '<ksproxy>'.length);
  assertNoPathPiece(answer.text, stateDir);
});

test('brokered: a stream that hiding makes longer than the visible limit shows its first 256 KiB once hidden', async () => {
  clipped.hiddenForms = () => ['q'];
  try {
    const total = VISIBLE + 3000;
    const lines = await ask(() => ({ exitCode: 0, stdout: `${'x'.repeat(total - RING)}${'q\n'.repeat(RING / 2)}`, stderr: '' }));
    // The cut may fall inside a [hidden] of the text: it is counted in bytes of the hidden text, and looks for no line.
    const hiddenLines = `${'x'.repeat(total - RING)}${'[hidden]\n'.repeat(RING / 2)}`;
    assert.equal(lines.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${hiddenLines.slice(0, VISIBLE).trimEnd()}`);
    // With characters of 2 bytes, the first 256 KiB are counted in bytes too, wherever the cut falls.
    for (let pad = 0; pad < 10; pad += 1) {
      const flat = await ask(() => ({ exitCode: 0, stdout: `${'x'.repeat(total - RING)}${'q\u00e9'.repeat(RING / 3)}${'z'.repeat(pad)}`, stderr: '' }));
      const hidden = `${'x'.repeat(total - RING)}${'[hidden]\u00e9'.repeat(RING / 3)}${'z'.repeat(pad)}`;
      assert.equal(flat.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${Buffer.from(hidden).subarray(0, VISIBLE).toString()}`, `${pad}`);
    }
  } finally {
    delete clipped.hiddenForms;
  }
});

// The private key of the review: a hidden text with newlines that the end of a stream cuts.
const KEY = [
  '-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7', 'VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu',
  'ictGeurT8jNbvJZHtCSuYEvuNMoSfm76oqFvAp8Gy0iz5sxjZmSn', '-----END PRIVATE KEY-----',
].join('\n');

function askWith(perform, secrets) {
  state.perform = perform;
  return answerCall({
    kind: 'clipped', name: 'c1', input: 'show', timeoutSeconds: 30,
  }, {
    calls: new Map([['clipped:c1', { target: brokeredTarget, secrets }]]),
    session: { targets: [brokeredTarget] },
    env,
    signal: new AbortController().signal,
    review: async () => null,
    stderr: process.stderr,
  });
}

test('brokered: a private key that the end of the stream cut shows no line of it, after one long line', async () => {
  const cutAt = KEY.indexOf('ictGeurT') + 20;
  const total = VISIBLE + 13000;
  const body = 'j'.repeat(total - cutAt) + KEY.slice(0, cutAt);
  const shown = `--- stdout ---\n${'j'.repeat(VISIBLE)}`;
  for (const [result, expected] of [
    // The two that did not end on their own: the key is past the visible limit once its last 8 KiB are left out.
    [{ exitCode: null, timedOut: true, stdout: body, stderr: '' }, `timed out after 30s\n[stdout ${AT_LIMIT}]\n${shown}`],
    [{ exitCode: 1, stdout: body, stderr: 'the reply was cut off\n', cutOff: true }, `exit code: 1\n[stdout ${AT_LIMIT}]\n[stderr ${END_LEFT_OUT}]\n${shown}`],
    // One that ended on its own: it keeps its end, which lies past the visible limit.
    [{ exitCode: 1, stdout: body, stderr: 'the reply was cut off\n' }, `exit code: 1\n[stdout ${AT_LIMIT}]\n${shown}\n--- stderr ---\nthe reply was cut off`],
  ]) {
    const answer = await askWith(() => result, { KEY });
    for (const line of KEY.split('\n')) assert.ok(!answer.text.includes(line.slice(0, 12)), `${line.slice(0, 12)} is shown`);
    assert.equal(answer.text, expected);
  }
});

test('brokered: a long secret that the end of the stream cut shows no piece, and what is left out grows with it', async () => {
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  };
  const LONG = Array.from({ length: 18000 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[next() % 24]).join('');
  const body = 'j'.repeat(VISIBLE + 25000 - 17000) + LONG.slice(0, 17000);
  const answer = await askWith(() => ({
    exitCode: null, timedOut: true, stdout: body, stderr: '',
  }), { LONG });
  // 8 bytes for each of its 18000 characters, 141 KiB, are left out; the rest is shorter than the visible limit and has
  // no newline, so nothing is shown.
  assert.equal(answer.text, `timed out after 30s\n[stdout ${END_LEFT_OUT}]`);
});

test('brokered: a stream past the visible limit that ends in white space shows its first 256 KiB, however much of it', async () => {
  const out = `${'x'.repeat(VISIBLE + 1000)}the last line${' '.repeat(END + 10)}`;
  const expected = `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`;
  const answer = await askWith(() => ({ exitCode: 0, stdout: out, stderr: '' }), { TOK: TOKEN });
  assert.equal(answer.text, expected);
  const one = await askWith(() => ({ exitCode: 0, stdout: out.slice(0, -11), stderr: '' }), { TOK: TOKEN });
  assert.equal(one.text, expected);
});

test('brokered: how much hiding and the scrub take out of a stream past the visible limit never changes its answer', async () => {
  // Before, the end part came from the last raw bytes and was left out when cleaning took more than 4 KiB out of them:
  // the agent could add copies of a secret, or of the state folder path, until it went, and read a secret's length.
  const secret = 'sixteen-bytes-ab';
  for (const copies of [0, 1, 60, 300]) {
    const out = `${'x'.repeat(VISIBLE + 1000)}\n${`${secret}\n`.repeat(copies)}${`${stateDir}\n`.repeat(copies)}${'z'.repeat(100)}`;
    assert.ok(Buffer.byteLength(out) < READ, 'read to its end');
    const answer = await askWith(() => ({ exitCode: 0, stdout: out, stderr: '' }), { TOK: secret });
    assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`, `${copies} copies`);
    assertNoPiece(answer.text, secret);
  }
});

test('brokered: the answer of a cut stream is the same whatever the length of a secret in it', async () => {
  const pad = VISIBLE + 100;
  const answers = [];
  for (const secret of ['abc', 'a-much-longer-secret-value-0123456789']) {
    answers.push((await askWith(() => ({ exitCode: 0, stdout: `${secret}\n${'x'.repeat(pad)}`, stderr: '' }), { TOK: secret })).text);
  }
  assert.equal(answers[0], answers[1]);
  assert.equal(answers[0], `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n[hidden]\n${'x'.repeat(VISIBLE - 9)}`);
  // The stream beside one that the read limit stopped did not end on its own. What it loses at its end is 1 KiB for
  // both secrets, the shortest and the longest that 1 KiB covers (8 bytes for each of 128 characters).
  const stopped = [];
  for (const secret of ['k', 'k'.repeat(128)]) {
    stopped.push((await askWith(({ maxBytes }) => ({
      exitCode: 0, stdout: 'o'.repeat(maxBytes), stderr: `${secret}${'e'.repeat(VISIBLE + 6000)}`, truncated: true,
    }), { TOK: secret })).text);
  }
  assert.equal(stopped[0], stopped[1]);
  assert.equal(stopped[0], [
    'exit code: 0',
    `[stdout ${AT_LIMIT}]`,
    `[stderr ${AT_LIMIT}]`,
    '--- stdout ---',
    'o'.repeat(VISIBLE),
    '--- stderr ---',
    `[hidden]${'e'.repeat(VISIBLE - 8)}`,
  ].join('\n'));
});

test('ssh: the sizes of a cut answer are rounded, so that one call does not tell the length of a path that was scrubbed', async () => {
  const r = await sshCall(`process.stdout.write(base + '\\n' + 'x'.repeat(${VISIBLE + 100}));`);
  const { head, stdout } = partsOf(r.text);
  assert.equal(head[1], '[stdout cut: showing 256 KiB of 256 KiB]');
  assert.equal(splitEnd(stdout).cut, 'under 1 KiB');
  assert.ok(stdout.startsWith('<ksproxy>\nxxx'));
});

test('brokered: after halving, a stopped stream says how much it shows, and so does the stream beside it, which lost its end', async () => {
  const alone = await ask(({ maxBytes }) => ({
    exitCode: 0, stdout: '\u0001'.repeat(maxBytes), stderr: '', truncated: true,
  }));
  assert.equal(alone.text, `exit code: 0\n[stdout ${AT_LIMIT}; showing 128 KiB]\n--- stdout ---\n${'\u0001'.repeat(VISIBLE / 2)}`);
  // stderr keeps its first 200 KiB, up to its last newline at least 1 KiB before its end, and halving cuts it to 128 KiB.
  const two = await ask(({ maxBytes }) => ({
    exitCode: 0, stdout: 'o'.repeat(maxBytes), stderr: `${'\u0001'.repeat(200 * KIB)}\n${'e'.repeat(1024)}`, truncated: true,
  }));
  assert.equal(two.text, [
    'exit code: 0',
    `[stdout ${AT_LIMIT}; showing 128 KiB]`,
    `[stderr ${END_LEFT_OUT}; showing 128 KiB]`,
    '--- stdout ---',
    'o'.repeat(VISIBLE / 2),
    '--- stderr ---',
    '\u0001'.repeat(VISIBLE / 2),
  ].join('\n'));
});

test('brokered: a stream that hiding makes longer than the visible limit is cut once hidden', async () => {
  // 100000 bytes as read, 450000 once hidden.
  const answer = await askWith(() => ({ exitCode: 0, stdout: 'q\n'.repeat(50000), stderr: '' }), { Q: 'q' });
  assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'[hidden]\n'.repeat(50000).slice(0, VISIBLE)}`);
});

test('ssh: a path that a child of the program was writing when the grace period ended is never shown in part', async () => {
  const child = `process.stdout.write(${JSON.stringify(stateDir.slice(0, stateDir.length - 3))}); setInterval(() => {}, 1000);`;
  const r = await sshCall(`require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: ['ignore', 'inherit', 'inherit'] }); process.stdout.write('done\\n', () => process.exit(0));`);
  assert.equal(r.text, 'exit code: 0\n--- stdout ---\ndone');
});

test('ssh: a path that the end of a timed-out call cut is never shown in part, in a long stream or a short one', async () => {
  const partial = stateDir.slice(0, stateDir.length - 3);
  for (const size of [400 * KIB, 100]) {
    scripts += 1;
    const script = path.join(root, `fake-ssh-${scripts}.js`);
    fs.writeFileSync(script, `#!/usr/bin/env node\nconst base = ${JSON.stringify(stateDir)};\nprocess.stdout.write('t'.repeat(${size}) + '\\n' + base.slice(0, base.length - 3)); setInterval(() => {}, 1000);\n`, { mode: 0o755 });
    const r = await callTool('ssh_exec', { server: 'web1', command: 'big', timeout_seconds: 3 }, { ...env, [['KSPROXY', 'SSH'].join('_')]: script });
    assert.ok(r.text.startsWith('timed out after 3s'), `${size}`);
    assert.ok(!r.text.includes(partial.slice(-12)), `${size}: the cut path is shown`);
    assert.ok(r.text.endsWith('t'.repeat(100)), `${size}`);
  }
});

test('brokered: a path that the end of a broken or timed-out stream cut is never shown in part; a stream that ended keeps its end', async () => {
  // A short stream that did not end on its own lies in its last 1 KiB, which is left out whole, and stderr with it.
  const partial = `ends in ${stateDir.slice(0, stateDir.length - 3)}`;
  for (const [result, expected] of [
    [{ exitCode: 1, stdout: partial, stderr: 'the reply was cut off\n', cutOff: true }, `exit code: 1\n[stdout ${END_LEFT_OUT}]\n[stderr ${END_LEFT_OUT}]`],
    [{ exitCode: null, stdout: partial, stderr: '', timedOut: true }, `timed out after 30s\n[stdout ${END_LEFT_OUT}]`],
  ]) {
    const answer = await ask(() => result);
    assert.equal(answer.text, expected);
    assertNoPathPiece(answer.text, stateDir);
  }
  const whole = await ask(() => ({ exitCode: 0, stdout: 'ends in /', stderr: '' }));
  assert.equal(whole.text, 'exit code: 0\n--- stdout ---\nends in /');
});

test('brokered: trailing spaces do not change the answer of a stream past the visible limit, so their count tells no length of a secret', async () => {
  // The review's probe: the agent ends its output with W spaces and looks for the last W that still gives an end part;
  // with the size check after trimming, that W gave the secret's length. Now there is no end part, and the answer is
  // the same for every W and every secret.
  for (const secret of ['short-one-12', 'a-much-longer-secret-value-0123456789', 's'.repeat(300)]) {
    for (const spaces of [0, 1000, 3000, 4000, 4080, 4096, 4100, 4120, 4300, 4500, 5000]) {
      const out = `${'x'.repeat(VISIBLE + 1000)}${secret}${'z'.repeat(1000)}${' '.repeat(spaces)}`;
      const answer = await askWith(() => ({ exitCode: 0, stdout: out, stderr: '' }), { TOK: secret });
      assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE)}`, `${secret.length} bytes and ${spaces} spaces`);
      assertNoPiece(answer.text, secret);
    }
  }
});

test('brokered: a hidden text with a lone surrogate is hidden before the stream goes through UTF-8', async () => {
  const FORM = '\ude00lone-surrogate-form-unmistakable';
  clipped.hiddenForms = () => [FORM];
  try {
    // A stream past the visible limit, cut in bytes.
    const long = await ask(() => ({ exitCode: 0, stdout: `${'x'.repeat(VISIBLE - 1000)}${FORM}${'y'.repeat(2000)}`, stderr: '' }));
    assert.equal(long.text, `exit code: 0\n[stdout ${AT_LIMIT}]\n--- stdout ---\n${'x'.repeat(VISIBLE - 1000)}[hidden]${'y'.repeat(992)}`);
    // A stream that did not end on its own, whose last 1 KiB is left out in bytes.
    const cut = await ask(() => ({
      exitCode: null, timedOut: true, stdout: `a line\n${FORM}\nmore\n${'z'.repeat(2048)}`, stderr: '',
    }));
    assert.equal(cut.text, `timed out after 30s\n[stdout ${END_LEFT_OUT}]\n--- stdout ---\na line\n[hidden]\nmore`);
  } finally {
    delete clipped.hiddenForms;
  }
});

test('dropCutFolder drops a last piece that starts a folder of the scrub, ignoring case where the scrub does', () => {
  const session = { targets: [] };
  const cut = stateDir.slice(0, stateDir.length - 3);
  assert.equal(dropCutFolder(`x ${cut}`, session, env, false), 'x ');
  assert.equal(dropCutFolder(`x ${cut.toUpperCase()}`, session, env, true), 'x ');
  assert.equal(dropCutFolder(`x ${cut.toUpperCase()}`, session, env, false), `x ${cut.toUpperCase()}`);
  assert.equal(dropCutFolder(`x ${stateDir}`, session, env, false), `x ${stateDir}`);
  assert.equal(dropCutFolder('x /', session, env), 'x ');
  // Replacement characters at the very end, left by a character that the end of the stream cut in two, are looked past.
  assert.equal(dropCutFolder(`x ${cut}\ufffd\ufffd`, session, env, false), 'x ');
  assert.equal(dropCutFolder('\ufffd', session, env, false), '\ufffd');
  // The case as the regular expression of the scrub folds it (its i flag, without u): a letter's capital, but not a
  // capital sharp s, a dotless i or a Kelvin sign, which do not match a letter of the folder there (lower case would).
  const odd = { targets: [{ kind: 'local', cwd: '/srv/straße-kit' }] };
  assert.equal(dropCutFolder('x /SRV/STRA', odd, env, true), 'x ');
  assert.equal(dropCutFolder('x /SRV/STRAß', odd, env, true), 'x ');
  assert.equal(dropCutFolder('x /srv/straße-KI', odd, env, true), 'x ');
  for (const kept of ['x /srv/stra\u1e9e', 'x /srv/straße-\u212a', 'x /srv/straße-k\u0131']) {
    assert.equal(dropCutFolder(kept, odd, env, true), kept);
  }
});

test('brokered: halving keeps the line of a stream past the visible limit, and keeps the stream within the smaller budget', async () => {
  const out = `${`${'\u0001'.repeat(99)}\n`.repeat(2632)}the end`;
  const answer = await ask(() => ({ exitCode: 0, stdout: out, stderr: '' }));
  assert.equal(answer.text, `exit code: 0\n[stdout ${AT_LIMIT}; showing 128 KiB]\n--- stdout ---\n${out.slice(0, VISIBLE / 2)}`);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) + 1 <= 1024 * 1024);
});

test('every kind has the hint of the design, and no kind has words of its own for a cut line', () => {
  const hints = {
    ssh: 'tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first',
    local: 'tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first',
    kubernetes: 'logs --tail=200 or --since=10m, -l to select, -o name',
    postgres: 'fewer columns, a WHERE and a LIMIT, or count(*) first',
    mysql: 'fewer columns, a WHERE and a LIMIT, or count(*) first',
    mongodb: 'a filter, a projection and a limit; page with _id greater than the last one',
    http: "the API's own paging and filters (size, from, filter_path)",
    elasticsearch: "the API's own paging and filters (size, from, filter_path)",
    rabbitmq: "the API's own paging and filters (size, from, filter_path)",
    redis: 'SCAN with COUNT, or a narrower key pattern',
    kafka: 'a narrower command or option',
    command: 'a narrower command or option',
    mcp: "the tool's own filter or paging arguments",
  };
  assert.deepEqual(Object.fromEntries(realKinds.map((kind) => [kind.key, kind.cutHint])), hints);
  // The line of a brokered stream says what was left out, the same for every kind: a kind no longer gives its words.
  assert.deepEqual(realKinds.filter((kind) => 'cutReason' in kind).map((kind) => kind.key), []);
});

test('AGENT.md says how output is cut and gives the hint of each kind of the session once, with the tools that share it', () => {
  const target = (kind, name) => ({
    kind, name, description: '', allow: [], state: 'up',
  });
  const text = agentMdText({
    targets: [
      { ...target('ssh', 'web1'), host: 'web1.example.com', socket: '/s/ssh-web1' },
      { ...target('ssh', 'web2'), host: 'web2.example.com', socket: '/s/ssh-web2' },
      { ...target('local', 'here'), cwd: '/srv/shop', protected: [], protect: [] }, target('clipped', 'c1'),
    ],
  });
  const section = text.slice(text.indexOf('## When output is cut'), text.indexOf('## Off limits'));
  assert.equal(section, [
    '## When output is cut',
    '',
    '- Each stream of a call is cut at 256 KiB, or at the limit that its target names above. The answer then says so in a line right after the exit code.',
    '- On an ssh server, a Kubernetes cluster or a local folder, the line says how much of the stream the answer shows, and the answer also shows the last 16 KiB of the stream, after a line such as `[... 9.1 MiB cut here ...]`. The sizes are close, not exact.',
    '- On every other target, the answer shows the start of the stream up to the limit, with no end part, and the line says `cut at 256 KiB: the rest was left out`.',
    '- On those other targets, a call that did not end on its own (the time limit, a reply that broke off, a program stopped at the limit) also loses the end of each stream: its last 1 KiB at least, back to the end of a line, so a short output is not shown at all. The line then says `its end was left out`. Make such a call end on its own, for example with a limit on what it reads or a shorter wait of its own.',
    '- Narrow the call rather than reading more of its output. These are hints only: the rules of each target still decide what may run.',
    `  - \`ssh_exec\`, \`local_exec\`: ${SHELL_HINT.slice('narrow it: '.length)}`,
    '',
    '',
  ].join('\n'));
  const none = agentMdText({ targets: [target('clipped', 'c1')] });
  assert.ok(none.includes('may run.\n\n## Off limits'));
});
