import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import live, { control, resetControl } from './fixtures/kind-live.js';
import { checkKind } from './kind-contract.js';
import { formatSaidLine } from '../src/audit.js';
import { main } from '../src/cli.js';
import {
  KINDS, cliName, flaggedKinds, kindByCliName, kindByFlag, kindByKey,
} from '../src/kinds/index.js';
import { start, stopSignals } from '../src/start.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, registerRun, waitFor,
} from './start-helpers.js';

KINDS.push(live);

after(() => cleanupAll());
beforeEach(() => resetControl());

// A said line: the time, the kind column, the target column of 10, the empty status and duration columns, then the text.
const saidLine = (target, text) => new RegExp(`^\\d\\d:\\d\\d:\\d\\d live ${target} {${27 - target.length}}${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');

// The default inventory of makeWorld, ssh web1, with the live targets given.
async function liveWorld(targets, extraEnv = {}) {
  const world = await makeWorld({ extraEnv: { NO_COLOR: '1', ...extraEnv } });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.live = targets.map((t) => ({ name: 'l1', description: 'a live box', allow: ['ping'], ...t }));
  fs.writeFileSync(file, JSON.stringify(inventory));
  return world;
}

function runMain(world, argv, host = {}) {
  const proc = host.process ?? fakeProcess();
  const run = { proc, done: main(argv, world.env, { ...host, process: proc }) };
  registerRun(run);
  return run;
}

const sessionKinds = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets.map((t) => `${t.kind}:${t.name}`);

test('a kind without a flag meets the contract, and its key may not be the flag of another kind', () => {
  assert.equal(live.flag, undefined);
  assert.doesNotThrow(() => checkKind(live, KINDS));
  const others = KINDS.filter((kind) => kind !== live);
  const bad = (change) => {
    const kind = { ...live, ...change };
    checkKind(kind, [...others, kind]);
  };
  assert.doesNotThrow(() => bad({ flag: 'lv' }));
  assert.throws(() => bad({ flag: '' }), /live: flag/);
  assert.throws(() => bad({ flag: null }), /live: flag/);
  assert.throws(() => bad({ flag: 'mongo' }), /live: flag must be unique/);
  assert.throws(() => bad({ key: 'mongo' }), /mongo: mongo names another kind on the command line/);
  // The other side: a kind whose flag is the key of a kind without a flag.
  const mongo = { ...live, key: 'mongo' };
  const mongodb = kindByKey('mongodb');
  assert.throws(() => checkKind(mongodb, [...others, mongo]), /mongodb: mongo names another kind on the command line/);
});

test('the lookups: no kind without a flag is found by a flag, check finds it by its key, and only kinds with a flag are flagged', () => {
  assert.equal(kindByFlag(undefined), undefined);
  assert.equal(kindByFlag('live'), undefined);
  assert.equal(kindByFlag('nope'), undefined);
  assert.equal(kindByFlag('kube'), kindByKey('kubernetes'));
  assert.equal(cliName(live), 'live');
  assert.equal(cliName(kindByKey('kubernetes')), 'kube');
  assert.equal(kindByCliName('live'), live);
  assert.equal(kindByCliName('kube'), kindByKey('kubernetes'));
  assert.equal(kindByCliName('kubernetes'), undefined);
  assert.equal(kindByCliName(undefined), undefined);
  assert.deepEqual(flaggedKinds(), KINDS.filter((kind) => kind.flag !== undefined));
  assert.ok(!flaggedKinds().includes(live));
  assert.equal(flaggedKinds().length, KINDS.length - 2);
});

test('formatSaidLine: the columns of a log line, no status, the text cleaned and never clipped', () => {
  const ts = '2026-11-25T10:00:01.000Z';
  const text = `the server said ${'word '.repeat(60)}\u001b[31mred\u001b[0m\nnext`;
  const line = formatSaidLine({
    ts, kind: 'live', target: 'a-very-long-target-name', text,
  });
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.endsWith(`${'word '.repeat(60)}\\u001b[31mred\\u001b[0m\\u000anext`), line);
  assert.match(line, /^\d\d:\d\d:\d\d live a-very-lo… {17}the server said /);
  assert.ok(line.length > 300);
  assert.match(formatSaidLine({ ts, kind: 'loc', target: 't', text: '' }), /^\d\d:\d\d:\d\d loc +t$/);
  assert.match(formatSaidLine({ ts, kind: 'live', target: 'h1', text: 42 }), saidLine('h1', '42'));
});

test('stopSignals: fire aborts every signal given so far, and a signal given after it is aborted already', () => {
  const signals = stopSignals();
  const first = signals.signal();
  const second = signals.signal();
  assert.equal(first === second, false);
  assert.deepEqual([first.aborted, second.aborted], [false, false]);
  signals.fire();
  assert.deepEqual([first.aborted, second.aborted], [true, true]);
  assert.equal(signals.signal().aborted, true);
  signals.fire();
});

test('the usage shows no flag for a kind without one, and names it by its key for check', async () => {
  const help = async () => {
    const proc = fakeProcess();
    assert.equal(await main(['--help'], {}, { process: proc }), 0);
    return proc.stdout.text;
  };
  const withLive = await help();
  KINDS.pop();
  const without = await help();
  KINDS.push(live);
  assert.ok(!withLive.includes('undefined'), withLive);
  assert.ok(!withLive.includes('--live'), withLive);
  assert.ok(withLive.includes('|mongo|kafka|mcp|live>'), withLive);
  assert.equal(withLive.replace('|mcp|live>', '|mcp>'), without);

  const proc = fakeProcess();
  assert.equal(await main(['check'], {}, { process: proc }), 2);
  assert.ok(proc.stderr.text.startsWith('usage: ksproxy check [--project NAME] <ssh|kube|local|http|command|es|mq|redis|pg|mysql|mongo|kafka|mcp|live> <name> <command...>\n'));
});

test('no argument of start or doctor reads as the flag of a kind without one', async () => {
  const world = await liveWorld([{}]);
  for (const [argv, message] of [
    [['start', '--undefined', 'l1'], 'unknown option for start: --undefined'],
    [['start', '--undefined=l1'], 'unknown option for start: --undefined=l1'],
    [['start', '--live', 'l1'], 'unknown option for start: --live'],
    [['doctor', '--undefined', 'l1'], 'unknown option for doctor: --undefined'],
    [['doctor', '--live=l1'], 'unknown option for doctor: --live=l1'],
    [['start', '--project', 'shop,ops', '--undefined', 'l1'], 'unknown option for start: --undefined'],
  ]) {
    const run = runMain(world, argv);
    assert.equal(await run.done, 2, argv.join(' '));
    assert.ok(run.proc.stderr.text.startsWith(`${message}\nUsage: ksproxy <command>`), run.proc.stderr.text);
  }
  const several = runMain(world, ['start', '--project', 'shop,ops', '--ssh', 'web1']);
  assert.equal(await several.done, 2);
  assert.ok(several.proc.stderr.text.startsWith('--ssh names targets of one project; use it with a single --project\n'));
});

test('without a terminal, the message names the flags of the other kinds and none for a kind without a flag', async () => {
  const world = await liveWorld([{}]);
  const proc = fakeProcess();
  assert.equal(await start({}, world.env, { process: proc }), 1);
  assert.equal(proc.stderr.text, 'no targets selected: use --ssh, --kube, --local or --all when not running in a terminal\n');
});

test('ksproxy check finds a target of a kind without a flag by the key of the kind', async () => {
  const world = await liveWorld([{ allow: ['ping', 'read *'] }]);
  const check = async (args) => {
    const run = runMain(world, ['check', ...args]);
    return { code: await run.done, out: run.proc.stdout.text, err: run.proc.stderr.text };
  };
  assert.deepEqual(await check(['live', 'l1', 'ping']), { code: 0, out: 'ALLOWED by rule: ping\n', err: '' });
  assert.deepEqual(await check(['live', 'l1', 'read', 'x']), { code: 0, out: 'ALLOWED by rule: read *\n', err: '' });
  const refused = await check(['live', 'l1', 'write', 'x']);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^REFUSED: not on the allowlist for this target/);
  assert.deepEqual(await check(['live', 'nope', 'ping']), { code: 2, out: '', err: 'unknown live target "nope"; known: l1\n' });
  const byWord = await check(['live_call', 'l1', 'ping']);
  assert.equal(byWord.code, 2);
});

test('one start: --all and the picker open a target of a kind without a flag, kind flags leave it out', async () => {
  const world = await liveWorld([{}]);
  const all = launch(world, { all: true });
  await ready(all);
  assert.deepEqual(sessionKinds(world), ['ssh:web1', 'live:l1']);
  assert.match(all.proc.stderr.text, /live +l1 +OPENING +a live object\n/);
  all.proc.emit('SIGINT');
  assert.equal(await all.done, 0);
  assert.equal(control.opened.length, 1);
  assert.equal(control.opened[0].signal, true);

  const asked = [];
  const answers = [[1], [0]];
  const picked = launch(world, {}, {
    process: fakeProcess({ stdin: { isTTY: true } }),
    checkbox: async (request) => {
      asked.push([request.title, request.items.map((item) => `${item.label} ${item.hint}`)]);
      return answers.shift();
    },
  });
  await ready(picked);
  assert.deepEqual(asked, [
    ['Which kinds of proxy?', ['ssh 1 server(s)', 'live 1 live target(s)']],
    ['Which live targets?', ['l1 live - a live box']],
  ]);
  assert.deepEqual(sessionKinds(world), ['live:l1']);
  picked.proc.emit('SIGINT');
  assert.equal(await picked.done, 0);

  const flagged = launch(world, { ssh: ['web1'] });
  await ready(flagged);
  assert.deepEqual(sessionKinds(world), ['ssh:web1']);
  flagged.proc.emit('SIGINT');
  assert.equal(await flagged.done, 0);
});

test('ctx.signal ends an open that waits when Ctrl-C arrives, and ctx.say writes a whole, cleaned line on stderr only', async () => {
  const text = `the server says: ${'word '.repeat(30)}\u001b[31mred\u001b[0m end`;
  const world = await liveWorld([{ name: 'h1', hold: true, say: text }]);
  const proc = fakeProcess();
  proc.stderr.isTTY = true;
  proc.stderr.columns = 60;
  const run = launch(world, { all: true }, { process: proc });
  await waitFor(() => control.holding.includes('h1'), 20000, 'the open to wait');
  const cleaned = `the server says: ${'word '.repeat(30)}\\u001b[31mred\\u001b[0m end`;
  assert.match(proc.stderr.text, saidLine('h1', cleaned));
  assert.ok(!proc.stderr.text.includes('\u001b'), 'no control character reaches the terminal');
  assert.match(proc.stderr.text, /^\d\d:\d\d:\d\d live h1 +OPENING +a live object$/m);
  for (const line of proc.stderr.text.split('\n').filter((l) => !l.includes('the server says'))) assert.ok(line.length <= 60, line);
  proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.deepEqual(control.aborted, ['h1']);
  assert.match(proc.stderr.text, /live h1 +SKIPPED +stopped\n/);
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C\n/);
  const audit = fs.readFileSync(world.auditLog, 'utf8');
  assert.ok(!audit.includes('the server says'), 'a said line is never in the audit log');
  assert.ok(audit.includes('"event":"target_opening","kind":"live","target":"h1"'), audit);
});

test('a kind that keeps ctx.say speaks later, from a probe: on stderr, never in the audit log', async () => {
  const world = await liveWorld([{}]);
  const run = launch(world, { all: true });
  await ready(run);
  control.probeSay = 'the live object says later';
  await waitFor(() => /live l1 {25}the live object says later 1$/m.test(run.proc.stderr.text), 20000, 'a later said line');
  control.probeSay = null;
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.ok(control.probes.length > 0);
  assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes('says later'));
});
