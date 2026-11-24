import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vault from './fixtures/kind-brokered.js';
import { KINDS } from '../src/kinds/index.js';
import { callTool } from '../src/tools.js';
import { formatLogLine } from '../src/audit.js';
import { askCall, startCallServer } from '../src/broker.js';
import { main } from '../src/cli.js';
import { callSocketPath } from '../src/paths.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';
import { tempDir } from './temp.js';

KINDS.push(vault);
after(() => cleanupAll());

const TOKEN_VAR = 'VAULT_TEST_TOKEN';
const ORIGIN = { from: '192.0.2.7', client: 'agent-one 1.2' };

async function world() {
  const w = await makeWorld({ extraEnv: { [TOKEN_VAR]: 'tok-for-the-origin-test' } });
  const file = path.join(w.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.vault = [{
    name: 'v1', tokenEnv: TOKEN_VAR, description: 'test vault', allow: ['read *'],
  }];
  fs.writeFileSync(file, JSON.stringify(inventory));
  return w;
}

const entriesOf = (w) => fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .filter((e) => e.event === 'call' || e.event === 'list');
const withoutTime = ({ ts, durationMs, ...rest }) => rest;

test('entries written for a call with an origin carry from and client; without one they are as before', async () => {
  const w = await world();
  const run = launch(w, { ssh: ['web1'], vault: ['v1'] });
  await ready(run);
  const ask = (name, args, origin) => callTool(name, args, w.env, { origin });
  assert.equal((await ask('list_targets', {}, ORIGIN)).isError, false);
  assert.equal((await ask('list_targets', {}, undefined)).isError, false);
  assert.equal((await ask('ssh_exec', { server: 'web1', command: 'uptime' }, ORIGIN)).isError, false);
  assert.equal((await ask('ssh_exec', { server: 'web1', command: 'uptime' }, undefined)).isError, false);
  assert.equal((await ask('ssh_exec', { server: 'web1', command: 'rm x' }, ORIGIN)).isError, true);
  assert.equal((await ask('ssh_exec', { server: 'web1', command: 'rm x' }, undefined)).isError, true);
  assert.equal((await ask('vault_read', { target: 'nope', command: 'read a' }, ORIGIN)).isError, true);
  assert.equal((await ask('vault_read', { target: 'nope', command: 'read a' }, undefined)).isError, true);
  assert.equal((await ask('vault_read', { target: 'v1', command: 'read a' }, ORIGIN)).isError, false);
  assert.equal((await ask('vault_read', { target: 'v1', command: 'read a' }, undefined)).isError, false);
  assert.equal((await ask('vault_read', { target: 'v1', command: 'write a' }, ORIGIN)).isError, true);
  assert.equal(await stopWith(run), 0);

  const entries = entriesOf(w);
  assert.equal(entries.length, 11);
  // [with origin, without] pairs: the list, the allowed run, the refused run, the refusal on the mcp side.
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7]]) {
    assert.deepEqual([entries[a].from, entries[a].client], [ORIGIN.from, ORIGIN.client]);
    assert.equal(Object.hasOwn(entries[b], 'from'), false);
    assert.equal(Object.hasOwn(entries[b], 'client'), false);
    const { from, client, ...rest } = entries[a];
    assert.deepEqual(withoutTime(rest), withoutTime(entries[b]));
  }
  // the brokered calls were audited by start, with what the call socket carried
  assert.deepEqual([entries[8].from, entries[8].client, entries[8].decision], [ORIGIN.from, ORIGIN.client, 'allowed']);
  assert.equal(Object.hasOwn(entries[9], 'from'), false);
  assert.deepEqual([entries[10].from, entries[10].client, entries[10].decision], [ORIGIN.from, ORIGIN.client, 'refused']);
});

test('start copies a valid origin into its entry and drops an invalid one, and the call still runs', async () => {
  const w = await world();
  const run = launch(w, { vault: ['v1'] });
  await ready(run);
  const socket = callSocketPath(w.env);
  const send = (origin) => askCall(socket, {
    kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 30, ...(origin === undefined ? {} : { origin }),
  }, 20000, 'vault');
  const origins = [
    undefined,
    { from: '192.0.2.8', client: 'ok' },
    { from: '192.0.2.8', client: 'c'.repeat(64) },
    { from: '192.0.2.9', client: 'c'.repeat(65) },
    { from: '192.0.2.9', client: 'café' },
    { from: '', client: 'x' },
    { from: 'x'.repeat(65), client: 'x' },
    { from: 'a\nb', client: 'x' },
    { from: '192.0.2.9', client: 5 },
    { from: '192.0.2.9' },
    ['192.0.2.9', 'x'],
    'text',
    null,
  ];
  for (const origin of origins) assert.equal((await send(origin)).isError, false);
  assert.equal(await stopWith(run), 0);
  const seen = entriesOf(w).map((e) => [e.from, e.client]);
  assert.deepEqual(seen, [
    [undefined, undefined],
    ['192.0.2.8', 'ok'],
    ['192.0.2.8', 'c'.repeat(64)],
    ...Array(origins.length - 3).fill([undefined, undefined]),
  ]);
});

test('the call socket request carries origin only when given, and a server accepts it with or without', async () => {
  const dir = tempDir('ks-orig-');
  const socket = path.join(dir, 'c.sock');
  const seen = [];
  const server = await startCallServer({
    socket,
    handle: async (request) => {
      seen.push(request);
      return { text: 'ok', isError: false };
    },
  });
  try {
    const base = {
      kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 5,
    };
    await askCall(socket, base, 5000, 'vault');
    await askCall(socket, { ...base, origin: ORIGIN }, 5000, 'vault');
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(seen, [
    { kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 5 },
    {
      kind: 'vault', name: 'v1', input: 'read a', timeoutSeconds: 5, origin: ORIGIN,
    },
  ]);
});

test('formatLogLine shows from after the target, and leaves a line without from as it was', () => {
  const entry = {
    ts: '2026-11-20T12:00:00.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', rule: 'uptime', exitCode: 0,
  };
  const plain = formatLogLine(entry);
  const shown = formatLogLine({ ...entry, from: '192.0.2.7', client: 'agent-one' });
  assert.match(shown, /ssh +web1 +ok +from 192\.0\.2\.7 {2}uptime$/);
  assert.equal(formatLogLine({ ...entry, client: 'agent-one' }), plain);
  assert.equal(formatLogLine({ ...entry, from: 7 }), plain);
  assert.match(formatLogLine({ ...entry, from: 'a\u001b[31mb'.repeat(30) }), /from a\\u001b\[31mb/);
  const clipped = /from (x+\S*) {2}uptime$/.exec(formatLogLine({ ...entry, from: 'x'.repeat(100) }, { width: 400 }));
  assert.equal(clipped[1].length, 64);
  const list = formatLogLine({ ts: entry.ts, event: 'list', from: '192.0.2.7' });
  assert.match(list, /LIST +from 192\.0\.2\.7 {2}list_targets$/);
  const lifecycle = formatLogLine({ ts: entry.ts, event: 'session_start', from: '192.0.2.7' });
  assert.match(lifecycle, /READY +from 192\.0\.2\.7$/);
});

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

test('log --from keeps only the entries of that address, with --denied, --json and -n', async () => {
  const dir = tempDir('ks-orig-');
  try {
    const logs = path.join(dir, 'logs');
    fs.mkdirSync(logs);
    const call = (n, extra) => ({
      ts: `2026-11-20T12:00:0${n}.000Z`, event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: `cmd-${n}`, decision: 'allowed', rule: 'x', exitCode: 0, ...extra,
    });
    const rows = [
      call(1),
      call(2, { from: '192.0.2.7', client: 'a' }),
      call(3, { from: '192.0.2.8', client: 'b' }),
      call(4, { from: '192.0.2.7', client: 'a', decision: 'refused', reason: 'no', short: 'no' }),
      call(5, { from: '192.0.2.7', client: 'a' }),
    ];
    fs.writeFileSync(path.join(logs, 'audit.log'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
    const env = { ...process.env, KSPROXY_STATE_DIR: dir };
    const cmds = (r) => r.stdout.trim().split('\n').map((l) => /cmd-(\d)/.exec(l)?.[1]);
    assert.deepEqual(cmds(await cli(['log', '--from', '192.0.2.7'], env)), ['2', '4', '5']);
    assert.deepEqual(cmds(await cli(['log', '--from', '192.0.2.7', '--denied'], env)), ['4']);
    assert.deepEqual(cmds(await cli(['log', '--from', '192.0.2.7', '-n', '2'], env)), ['4', '5']);
    const json = (await cli(['log', '--from', '192.0.2.8', '--json'], env)).stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(json.map((e) => e.command), ['cmd-3']);
    assert.equal((await cli(['log', '--from', '192.0.2.99'], env)).stdout, '');
    const missing = await cli(['log', '--from'], env);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--from needs an address/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
