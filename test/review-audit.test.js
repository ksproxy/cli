import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from '../src/audit.js';

const call = {
  ts: '2026-11-21T14:02:11.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1',
  command: 'journalctl -u k3s', decision: 'allowed', rule: 'review', exitCode: 0, durationMs: 400,
  stdoutBytes: 10, stderrBytes: 0, review: { certainty: 'sure', reason: 'read-only log view' },
};

test('an approved reviewed call names the model and its reason', () => {
  assert.match(formatLogLine(call), /ok\s+0\.4s\s+journalctl -u k3s {2}\(model: read-only log view\)$/);
});

test('the verbose form lists the model reason with the rule', () => {
  assert.match(formatLogLine(call, { verbose: true }), /\(rule: review, model: read-only log view, out 10B, err 0B\)$/);
});

test('a reviewed call without a reason still names the model, and the reason is made terminal safe', () => {
  assert.match(formatLogLine({ ...call, review: { certainty: 'sure', reason: '' } }), /journalctl -u k3s {2}\(model\)$/);
  assert.match(formatLogLine({ ...call, review: { certainty: 'sure', reason: 'a\u001b[31mb' } }), /\(model: a\\u001b\[31mb\)$/);
});

test('a reviewer refusal shows in the bracket like any short reason', () => {
  const line = formatLogLine({ ...call, decision: 'refused', short: 'model refused: restarts a service', review: undefined });
  assert.match(line, /DENIED\s+journalctl -u k3s {2}\[model refused: restarts a service\]$/);
});

test('the review line of a target', () => {
  const line = formatLogLine({ ts: call.ts, event: 'target_review', kind: 'ssh', target: 'web1', message: 'reviewer groq, accepts sure' });
  assert.match(line, /ssh\s+web1\s+REVIEW\s+reviewer groq, accepts sure$/);
});
