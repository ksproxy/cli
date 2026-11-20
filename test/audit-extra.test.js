import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit, formatLogLine } from '../src/audit.js';

const TS = '2026-11-20T10:11:12.000Z';

function body(line) {
  return line.slice('HH:MM:SS '.length);
}

test('appendAudit clips long strings in args and keeps non-string arguments as they are', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ks-aux-'));
  try {
    const file = path.join(dir, 'audit.log');
    appendAudit(file, { event: 'call', args: [1, null, 'x'.repeat(600)] });
    const [entry] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entry.args[0], 1);
    assert.equal(entry.args[1], null);
    assert.equal(entry.args[2].length, 500);
    assert.ok(entry.args[2].endsWith('…'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused call with neither a short reason nor a reason shows just the command', () => {
  const line = formatLogLine({
    ts: TS, event: 'call', tool: 'ssh_exec', target: 'web1', command: 'rm x', decision: 'refused',
  });
  assert.match(body(line), /^ssh {2}web1 {7}DENIED {10}rm x$/);
});

test('a refused call with a reason but no command shows only the bracketed reason', () => {
  const line = formatLogLine({
    ts: TS, event: 'call', tool: 'ssh_exec', target: 'web1', decision: 'refused', reason: 'not on the list',
  });
  assert.match(line, /DENIED {10}\[not on the list\]$/);
});

test('a refused call with both a command and a reason shows both', () => {
  const line = formatLogLine({
    ts: TS, event: 'call', tool: 'ssh_exec', target: 'web1', command: 'rm x', decision: 'refused', short: 'nope',
  });
  assert.match(line, /DENIED {10}rm x {2}\[nope\]$/);
});

test('a call whose command or args have an unexpected type is shown as (invalid)', () => {
  assert.match(
    formatLogLine({
      ts: TS, event: 'call', tool: 'ssh_exec', target: 'a', command: 42, decision: 'allowed', exitCode: 0,
    }),
    /\(invalid\)$/,
  );
  assert.match(
    formatLogLine({
      ts: TS, event: 'call', tool: 'kubectl', target: 'a', args: { x: 1 }, decision: 'allowed', exitCode: 0,
    }),
    /\(invalid\)$/,
  );
});

test('verbose output without rule or sizes adds nothing; with them it adds a bracket', () => {
  const entry = {
    ts: TS, event: 'call', tool: 'ssh_exec', target: 'a', command: 'df', decision: 'allowed', exitCode: 0,
  };
  assert.match(formatLogLine(entry, { verbose: true }), /ok {7}\s*df$/);
  assert.match(
    formatLogLine({ ...entry, rule: 'df', stdoutBytes: 10, stderrBytes: 2 }, { verbose: true }),
    /df {2}\(rule: df, out 10B, err 2B\)$/,
  );
});

test('a call without an exit code or a target still produces a line', () => {
  const line = formatLogLine({ ts: TS, event: 'call', tool: 'ssh_exec', command: 'df', decision: 'allowed' });
  assert.match(line, /exit \?/);
});

test('lifecycle events without a kind or target use placeholders', () => {
  const line = formatLogLine({ ts: TS, event: 'target_up' });
  assert.match(body(line), /^-- {3}\s+UP$/);
  const kube = formatLogLine({ ts: TS, event: 'target_up', kind: 'kubernetes', target: 'lab' });
  assert.match(body(kube), /^kube lab\s+UP$/);
});

test('a width that is not a usable integer falls back to the default width', () => {
  const long = 'x'.repeat(400);
  const line = formatLogLine({
    ts: TS, event: 'call', tool: 'ssh_exec', target: 'a', command: long, decision: 'allowed', exitCode: 0,
  }, { width: 'wide' });
  assert.equal(line.length, 240);
  assert.ok(line.endsWith('…'));
});
