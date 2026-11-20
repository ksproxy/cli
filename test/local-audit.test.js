import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLogLine } from '../src/audit.js';

const TS = '2026-11-20T12:19:19.000Z';
const fmt = (entry, opts = { width: 240 }) => formatLogLine({ ts: TS, ...entry }, opts);
const body = (line) => line.slice(9);

test('a local call is a loc row in the standard shape', () => {
  const ok = fmt({
    event: 'call', tool: 'local_exec', kind: 'loc', target: 'infra', command: 'git status', decision: 'allowed', exitCode: 0, durationMs: 120,
  });
  assert.equal(body(ok), 'loc  infra      ok       0.1s   git status');
  const denied = fmt({
    event: 'call', tool: 'local_exec', kind: 'loc', target: 'infra', command: 'cat /etc/hosts', decision: 'refused', reason: 'long', short: 'outside the folder',
  });
  assert.equal(body(denied), 'loc  infra      DENIED          cat /etc/hosts  [outside the folder]');
  const failed = fmt({
    event: 'call', tool: 'local_exec', kind: 'loc', target: 'infra', command: 'false', decision: 'allowed', exitCode: 1, durationMs: 5,
  });
  assert.match(failed, /^\d\d:\d\d:\d\d loc {2}infra {6}exit 1 {3}0\.0s {3}false$/);
});

test('a local call is recognised by its tool name alone, and an entry with kind local also reads as loc', () => {
  const byTool = fmt({
    event: 'call', tool: 'local_exec', target: 'x', command: 'ls', decision: 'allowed', exitCode: 0, durationMs: 1,
  });
  assert.match(byTool, /^\d\d:\d\d:\d\d loc /);
  const byKind = fmt({
    event: 'call', kind: 'local', target: 'x', command: 'ls', decision: 'allowed', exitCode: 0, durationMs: 1,
  });
  assert.match(byKind, /^\d\d:\d\d:\d\d loc /);
});

test('local lifecycle events use the loc kind', () => {
  assert.equal(body(fmt({ event: 'target_opening', kind: 'loc', target: 'infra', message: '/srv/infra' })), 'loc  infra      OPENING         /srv/infra');
  assert.equal(body(fmt({ event: 'target_up', kind: 'loc', target: 'infra' })), 'loc  infra      UP');
  assert.equal(body(fmt({ event: 'target_skipped', kind: 'loc', target: 'infra', message: 'folder not found: /x' })), 'loc  infra      SKIPPED         folder not found: /x');
  assert.equal(body(fmt({ event: 'target_down', kind: 'local', target: 'infra', message: 'folder is gone' })), 'loc  infra      DOWN            folder is gone');
  assert.equal(body(fmt({ event: 'target_recovered', kind: 'loc', target: 'infra', message: 'folder is back' })), 'loc  infra      UP              folder is back');
});
