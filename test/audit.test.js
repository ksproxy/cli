import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendAudit, formatAuditLine, formatDuration, formatLogLine, logOptionsFor,
  readAuditEntries, sanitizeForTerminal,
} from '../src/audit.js';
import { clip } from '../src/text.js';
import { tempDir } from './temp.js';

const TS = '2026-11-20T12:18:40.000Z';

function hms(ts = TS) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function call(extra) {
  return { ts: TS, event: 'call', ...extra };
}

test('clip cuts to the limit and marks the cut with an ellipsis', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('abcde', 5), 'abcde');
  assert.equal(clip('abcdef', 5), 'abcd…');
  assert.equal(clip('x'.repeat(1000), 64).length, 64);
  assert.ok(clip('x'.repeat(1000), 64).endsWith('…'));
});

test('sanitizeForTerminal escapes bidi marks, zero-width characters and the BOM', () => {
  const text = '\u200e\u200f\u061c\ufeff\u200b\u2060\u2064';
  const out = sanitizeForTerminal(`a${text}b`);
  for (const ch of text) assert.ok(!out.includes(ch), `U+${ch.charCodeAt(0).toString(16)}`);
  assert.ok(out.startsWith('a\\u200e'));
  assert.ok(out.endsWith('b'));
});

test('sanitizeForTerminal escapes with lower-case four digit hex', () => {
  assert.equal(sanitizeForTerminal('a\u001bb\u202ec'), 'a\\u001bb\\u202ec');
  assert.equal(sanitizeForTerminal('plain text'), 'plain text');
});

test('appendAudit writes one JSON line per call with ts, mode 0600', () => {
  const dir = tempDir('ks-audit-');
  const file = path.join(dir, 'audit.log');
  appendAudit(file, { tool: 'ssh_exec', target: 'web1', command: 'uptime', decision: 'allowed' });
  appendAudit(file, { tool: 'kubectl', target: 'lab', args: ['get', 'pods'], decision: 'refused', reason: 'x' });
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.equal(typeof entry.ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)));
  }
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('appendAudit keeps a supplied ts', () => {
  const dir = tempDir('ks-audit-');
  const file = path.join(dir, 'audit.log');
  appendAudit(file, { ts: '2026-01-01T00:00:00.000Z', tool: 'ssh_exec' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ts, '2026-01-01T00:00:00.000Z');
});

test('appendAudit caps short and message at 120 characters and keeps the older caps', () => {
  const dir = tempDir('ks-audit-');
  const file = path.join(dir, 'audit.log');
  appendAudit(file, {
    event: 'call', target: 'x'.repeat(200), command: 'c'.repeat(5000), reason: 'r'.repeat(900),
    short: 's'.repeat(500), message: 'm'.repeat(500),
  });
  const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(entry.short.length, 120);
  assert.equal(entry.message.length, 120);
  assert.equal(entry.target.length, 64);
  assert.equal(entry.command.length, 2000);
  assert.equal(entry.reason.length, 500);
});

test('readAuditEntries skips lines that are not JSON objects', () => {
  const dir = tempDir('ks-audit-');
  const file = path.join(dir, 'audit.log');
  fs.writeFileSync(file, '{"a":1}\nnot json\n\n[1]\n"x"\n{"b":2}\n');
  assert.deepEqual(readAuditEntries(file).map((e) => e.entry), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(readAuditEntries(path.join(dir, 'missing')), []);
});

const EXAMPLE_ROWS = [
  [
    { event: 'target_opening', kind: 'ssh', target: 'web1', message: 'web1' },
    'ssh  web1       OPENING         web1',
  ],
  [
    { event: 'target_up', kind: 'ssh', target: 'web1' },
    'ssh  web1       UP',
  ],
  [
    { event: 'target_skipped', kind: 'kube', target: 'staging', message: 'port 8002 is already in use' },
    'kube staging    SKIPPED         port 8002 is already in use',
  ],
  [
    { event: 'session_start', target: 'session', message: '3 targets, pid 31973' },
    '--   session    READY           3 targets, pid 31973',
  ],
  [
    call({
      tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', exitCode: 0, durationMs: 100,
    }),
    'ssh  web1       ok       0.1s   uptime',
  ],
  [
    call({
      tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'cat /etc/shadow', decision: 'refused', reason: 'long', short: 'not on allowlist',
    }),
    'ssh  web1       DENIED          cat /etc/shadow  [not on allowlist]',
  ],
  [
    call({
      tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime; id', decision: 'refused', reason: 'long', short: 'character ";" not allowed',
    }),
    'ssh  web1       DENIED          uptime; id  [character ";" not allowed]',
  ],
  [
    call({
      tool: 'kubectl',
      kind: 'kube',
      target: 'lab',
      args: ['auth', 'can-i', 'delete', 'pods', '-n', 'web'],
      decision: 'allowed',
      exitCode: 1,
      durationMs: 300,
    }),
    'kube lab        exit 1   0.3s   auth can-i delete pods -n web',
  ],
  [
    call({
      tool: 'kubectl',
      kind: 'kube',
      target: 'lab',
      args: ['logs', '-f', 'api-1'],
      decision: 'allowed',
      exitCode: null,
      timedOut: true,
      durationMs: 59960,
    }),
    'kube lab        TIMEOUT  60.0s  logs -f api-1',
  ],
  [
    call({
      tool: 'kubectl', kind: 'kube', target: 'lab', args: ['get', 'secrets', '-A'], decision: 'refused', reason: 'long', short: 'secret resource',
    }),
    'kube lab        DENIED          get secrets -A  [secret resource]',
  ],
  [
    { event: 'list' },
    '--   agent      LIST            list_targets',
  ],
  [
    { event: 'target_down', kind: 'ssh', target: 'web2', message: 'connection lost' },
    'ssh  web2       DOWN            connection lost',
  ],
  [
    { event: 'target_recovered', kind: 'ssh', target: 'web2', message: 'connection is back' },
    'ssh  web2       UP              connection is back',
  ],
  [
    { event: 'session_closing', message: 'Ctrl-C' },
    '--   session    CLOSING         Ctrl-C',
  ],
  [
    { event: 'session_end', message: '23 calls: 17 ok, 2 failed, 4 denied' },
    '--   session    CLOSED          23 calls: 17 ok, 2 failed, 4 denied',
  ],
];

for (const [entry, body] of EXAMPLE_ROWS) {
  test(`formatLogLine row: ${body.slice(0, 60)}`, () => {
    assert.equal(formatLogLine({ ts: TS, ...entry }), `${hms()} ${body}`);
  });
}

test('formatLogLine shows ERROR when the command could not start, and WARN', () => {
  const error = formatLogLine(call({
    tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', exitCode: null, spawnError: 'ENOENT', durationMs: 5,
  }));
  assert.equal(error, `${hms()} ssh  web1       ERROR    0.0s   uptime`);
  const warn = formatLogLine({
    ts: TS, event: 'target_warn', kind: 'kube', target: 'lab', message: 'token rejected by the cluster',
  });
  assert.equal(warn, `${hms()} kube lab        WARN            token rejected by the cluster`);
});

test('formatLogLine prints (invalid) for a call whose arguments were not usable', () => {
  const ssh = formatLogLine(call({
    tool: 'ssh_exec', kind: 'ssh', target: 'x', command: null, decision: 'refused', reason: 'r', short: 'invalid arguments',
  }));
  assert.equal(ssh, `${hms()} ssh  x          DENIED          (invalid)  [invalid arguments]`);
  const kube = formatLogLine(call({
    tool: 'kubectl', kind: 'kube', target: 'x', args: null, decision: 'refused', reason: 'r', short: 'invalid arguments',
  }));
  assert.ok(kube.endsWith('(invalid)  [invalid arguments]'));
});

test('formatLogLine formats an entry without event as a call', () => {
  const line = formatLogLine({
    ts: TS, tool: 'ssh_exec', target: 'web1', command: 'systemctl status myapp', decision: 'allowed', exitCode: 0, durationMs: 400,
  });
  assert.equal(line, `${hms()} ssh  web1       ok       0.4s   systemctl status myapp`);
  const kube = formatLogLine({
    ts: TS, tool: 'kubectl', target: 'lab', args: ['get', 'pods'], decision: 'refused', reason: 'secret resources are never allowed',
  });
  assert.ok(kube.startsWith(`${hms()} kube lab        DENIED`));
});

test('formatLogLine cuts a target to 10 characters ending with an ellipsis', () => {
  const line = formatLogLine(call({
    tool: 'ssh_exec', target: 'abcdefghijklmno', command: 'uptime', decision: 'allowed', exitCode: 0, durationMs: 100,
  }));
  assert.equal(line, `${hms()} ssh  abcdefghi… ok       0.1s   uptime`);
});

test('formatLogLine cuts to exactly the width and ends with an ellipsis', () => {
  const entry = call({
    tool: 'ssh_exec', target: 'web1', command: 'x'.repeat(10000), decision: 'allowed', exitCode: 0, durationMs: 1,
  });
  for (const width of [60, 120, 240]) {
    const line = formatLogLine(entry, { width });
    assert.equal(line.length, width);
    assert.ok(line.endsWith('…'));
  }
  assert.equal(formatLogLine(entry).length, 240);
  const short = formatLogLine(call({
    tool: 'ssh_exec', target: 'web1', command: 'uptime', decision: 'allowed', exitCode: 0, durationMs: 1,
  }), { width: 60 });
  assert.ok(!short.endsWith('…'));
});

test('formatLogLine without color contains no escape character', () => {
  for (const [entry] of EXAMPLE_ROWS) {
    assert.ok(!formatLogLine({ ts: TS, ...entry }, { color: false }).includes('\u001b'));
  }
});

const COLORS = [
  ['32', { event: 'target_up', kind: 'ssh', target: 'a' }, 'UP'],
  ['32', { event: 'session_start', target: 'session', message: 'm' }, 'READY'],
  ['32', call({ tool: 'ssh_exec', target: 'a', command: 'c', decision: 'allowed', exitCode: 0, durationMs: 1 }), 'ok'],
  ['33', call({ tool: 'ssh_exec', target: 'a', command: 'c', decision: 'allowed', exitCode: 2, durationMs: 1 }), 'exit 2'],
  ['33', call({ tool: 'ssh_exec', target: 'a', command: 'c', decision: 'allowed', timedOut: true, exitCode: null, durationMs: 1 }), 'TIMEOUT'],
  ['33', call({ tool: 'ssh_exec', target: 'a', command: 'c', decision: 'allowed', spawnError: 'x', exitCode: null, durationMs: 1 }), 'ERROR'],
  ['33', { event: 'target_warn', kind: 'ssh', target: 'a', message: 'm' }, 'WARN'],
  ['33', { event: 'target_skipped', kind: 'ssh', target: 'a', message: 'm' }, 'SKIPPED'],
  ['31', call({ tool: 'ssh_exec', target: 'a', command: 'c', decision: 'refused', short: 's' }), 'DENIED'],
  ['31', { event: 'target_down', kind: 'ssh', target: 'a', message: 'm' }, 'DOWN'],
  [null, { event: 'target_opening', kind: 'ssh', target: 'a', message: 'm' }, 'OPENING'],
  [null, { event: 'session_closing', message: 'm' }, 'CLOSING'],
  [null, { event: 'session_end', message: 'm' }, 'CLOSED'],
  [null, { event: 'list' }, 'LIST'],
];

test('formatLogLine with color wraps only the status column', () => {
  for (const [code, entry, word] of COLORS) {
    const plain = formatLogLine({ ts: TS, ...entry }, { color: false });
    const colored = formatLogLine({ ts: TS, ...entry }, { color: true });
    assert.equal(colored.replace(/\u001b\[\d+m/g, ''), plain, word);
    if (code === null) {
      assert.equal(colored, plain, word);
    } else {
      const start = 8 + 1 + 4 + 1 + 10 + 1;
      assert.equal(
        colored,
        `${plain.slice(0, start)}\u001b[${code}m${word}\u001b[0m${plain.slice(start + word.length)}`,
        word,
      );
    }
  }
});

test('formatLogLine never colours a status that the width cut into', () => {
  const entry = { ts: TS, event: 'target_up', kind: 'ssh', target: 'a' };
  const line = formatLogLine(entry, { color: true, width: 26 });
  assert.equal(line.length, 26);
  assert.ok(!line.includes('\u001b'));
});

const BAD = '\u001b[31m\u0007\r\u202e\u200f';

test('formatLogLine escapes ESC, BEL, CR, U+202E and U+200F in every field', () => {
  const entries = [
    call({
      tool: 'ssh_exec', kind: 'ssh', target: `t${BAD}`, command: `c${BAD}`, decision: 'refused', reason: `r${BAD}`, short: `s${BAD}`,
    }),
    call({
      tool: 'kubectl', kind: 'kube', target: `t${BAD}`, args: [`a${BAD}`, `b${BAD}`], decision: 'refused', reason: `r${BAD}`, short: `s${BAD}`,
    }),
    call({
      tool: 'ssh_exec',
      kind: 'ssh',
      target: `t${BAD}`,
      command: `c${BAD}`,
      decision: 'allowed',
      rule: `rule${BAD}`,
      exitCode: `9${BAD}`,
      durationMs: 5,
      stdoutBytes: 1,
      stderrBytes: 2,
    }),
    { ts: TS, event: 'target_warn', kind: 'ssh', target: `t${BAD}`, message: `m${BAD}` },
    { ts: TS, event: 'session_closing', message: `m${BAD}` },
  ];
  const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
  for (const entry of entries) {
    for (const options of [{}, { color: true }, { verbose: true }, { color: true, verbose: true, width: 40 }]) {
      const line = formatLogLine(entry, options);
      const visible = line.replace(/\u001b\[\d+m/g, '');
      assert.ok(!unsafe.test(visible), JSON.stringify(line));
    }
  }
  const line = formatLogLine(entries[0]);
  assert.ok(line.includes('\\u001b'));
  assert.ok(line.includes('\\u202e'));
  assert.ok(line.includes('\\u200f'));
  assert.ok(line.includes('\\u0007'));
  assert.ok(line.includes('\\u000d'));
});

test('formatLogLine escapes before it cuts, so the width counts the escaped text', () => {
  const line = formatLogLine(call({
    tool: 'ssh_exec', target: 'a', command: '\u001b'.repeat(100), decision: 'allowed', exitCode: 0, durationMs: 1,
  }), { width: 70 });
  assert.equal(line.length, 70);
  assert.ok(!line.includes('\u001b'));
});

test('formatLogLine verbose adds the rule and the byte counts to an allowed call only', () => {
  const allowed = call({
    tool: 'ssh_exec', target: 'web1', command: 'uptime', decision: 'allowed', rule: 'uptime', exitCode: 0, durationMs: 100, stdoutBytes: 12, stderrBytes: 0,
  });
  assert.equal(
    formatLogLine(allowed, { verbose: true }),
    `${hms()} ssh  web1       ok       0.1s   uptime  (rule: uptime, out 12B, err 0B)`,
  );
  assert.ok(!formatLogLine(allowed).includes('rule'));
  const refused = call({
    tool: 'ssh_exec', target: 'web1', command: 'id', decision: 'refused', reason: 'r', short: 'not on allowlist', rule: 'x',
  });
  assert.ok(!formatLogLine(refused, { verbose: true }).includes('(rule'));
});

test('formatLogLine gives a placeholder time for a bad timestamp and null for an unknown event', () => {
  assert.ok(formatLogLine({ ts: 'nope', event: 'list' }).startsWith('--:--:-- '));
  assert.equal(formatLogLine({ ts: TS, event: 'something_new' }), null);
});

test('formatAuditLine is the same function as formatLogLine', () => {
  assert.equal(formatAuditLine, formatLogLine);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(400), '0.4s');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(59960), '60.0s');
  assert.equal(formatDuration(60000), '1m00s');
  assert.equal(formatDuration(65000), '1m05s');
  assert.equal(formatDuration(605000), '10m05s');
  assert.equal(formatDuration(undefined), '');
  assert.equal(formatDuration(null), '');
  assert.equal(formatDuration(Number.NaN), '');
});

test('logOptionsFor follows the stream and the environment', () => {
  assert.deepEqual(logOptionsFor({ isTTY: true, columns: 100 }, {}), { width: 100, color: true });
  assert.deepEqual(logOptionsFor({ isTTY: true, columns: 100 }, { NO_COLOR: '1' }), { width: 100, color: false });
  assert.deepEqual(logOptionsFor({ isTTY: true, columns: 100 }, { TERM: 'dumb' }), { width: 100, color: false });
  assert.deepEqual(logOptionsFor({ isTTY: true, columns: 100 }, { TERM: 'xterm-256color' }), { width: 100, color: true });
  assert.deepEqual(logOptionsFor({ isTTY: true }, {}), { width: 120, color: true });
  assert.deepEqual(logOptionsFor({ isTTY: false, columns: 100 }, {}), { width: 240, color: false });
  assert.deepEqual(logOptionsFor({}, {}), { width: 240, color: false });
  assert.deepEqual(logOptionsFor(undefined, {}), { width: 240, color: false });
});
