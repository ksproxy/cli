import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import live, { control, liveKind, resetControl } from './fixtures/kind-live.js';
import { main } from '../src/cli.js';
import { KINDS } from '../src/kinds/index.js';
import { PROJECT_KEY, withProject } from '../src/paths.js';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, fakeProcess, makeWorld, registerRun, waitFor,
} from './start-helpers.js';

// Two kinds without a flag: the picks of one may never be taken for those of the other.
const twin = liveKind('twin');
KINDS.push(live, twin);

after(() => cleanupAll());
beforeEach(() => resetControl());

const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const TOKEN_VAR = 'LIVE_TEST_TOKEN';
const TOKEN = 'Qlive-S3CR3T-said-line-value';

function writeInventory(w, project, inventory) {
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify(inventory));
}

// The default inventory of makeWorld, ssh web1 with the live targets of base when given, and each project of projects.
async function world(projects, base = null) {
  const w = await makeWorld({ extraEnv: { NO_COLOR: '1', [TOKEN_VAR]: TOKEN } });
  delete w.env[PROJECT_KEY];
  for (const [project, inventory] of Object.entries(projects)) writeInventory(w, project, inventory);
  if (base !== null) {
    const file = path.join(w.env[CONFIG_KEY], 'inventory.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), live: base }));
  }
  return w;
}

const liveTarget = (who, extra = {}) => ({
  name: 'l1', description: `${who} live`, allow: ['ping'], ...extra,
});

function runMain(w, argv, host = {}) {
  const proc = host.process ?? fakeProcess();
  const run = { proc, done: main(argv, w.env, { limits: { followMs: 50 }, ...host, process: proc }) };
  registerRun(run);
  return run;
}

async function allReady(run, names) {
  await waitFor(() => names.every((name) => run.proc.stdout.text.includes(`[${name}] Leave this running`)), 20000, 'every session to be ready');
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const sessionOf = (w, project) => JSON.parse(fs.readFileSync(path.join(w.env.KSPROXY_STATE_DIR, 'p', project, 'session', 'session.json'), 'utf8'));

test('two projects in one start, each with a target of the same name: each call, probe and DOWN line reaches its own live object, which no file holds', async () => {
  const w = await world({ shop: { live: [liveTarget('shop')] }, ops: { live: [liveTarget('ops')] } });
  const run = runMain(w, ['start', '--project', 'shop,ops', '--all']);
  await allReady(run, ['shop', 'ops']);
  const own = Object.fromEntries(control.opened.map((o) => [o.description, o]));
  assert.deepEqual(Object.keys(own).sort(), ['ops live', 'shop live']);
  assert.notEqual(own['shop live'].nonce, own['ops live'].nonce);

  for (const who of ['shop', 'ops']) {
    const answer = await callTool('live_call', { target: 'l1', command: 'ping' }, withProject(w.env, who));
    assert.deepEqual(answer, { text: `exit code: 0\n--- stdout ---\nl1 reached ${own[`${who} live`].nonce}`, isError: false });
    assert.deepEqual(sessionOf(w, who).targets.map((t) => `${t.kind}:${t.name}:${t.description}`), [`live:l1:${who} live`]);
  }
  await waitFor(() => ['shop live', 'ops live'].every((d) => control.probes.some((p) => p.description === d)), 20000, 'a probe of each');
  for (const probe of control.probes) assert.equal(probe.nonce, own[probe.description].nonce, probe.description);

  // The live object stays in the memory of start: no file of either session, no log and no terminal line holds it.
  await waitFor(() => /^\[ops\] .*live +l1 +ok/m.test(run.proc.stdout.text), 10000, 'the call line of ops');
  const nonces = Object.values(own).map((o) => o.nonce);
  for (const file of filesUnder(path.join(w.base, 'st'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const nonce of nonces) assert.ok(!text.includes(nonce), file);
  }
  for (const nonce of nonces) assert.ok(!(run.proc.stdout.text + run.proc.stderr.text).includes(nonce));

  control.probe = 'down';
  for (const who of ['shop', 'ops']) {
    const line = new RegExp(`^\\[${who}\\] \\d\\d:\\d\\d:\\d\\d live l1 +DOWN +live object ${own[`${who} live`].serial} is down$`, 'm');
    await waitFor(() => line.test(run.proc.stderr.text), 20000, `the DOWN line of ${who}`);
  }
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('the picker of several projects offers the kinds without a flag, and each start opens what was picked, by kind key', async () => {
  const w = await world({
    shop: {
      ssh: [{ name: 'web1', host: 'web1.shop.example', allow: ['uptime'] }],
      live: [liveTarget('shop')],
      twin: [liveTarget('shop', { name: 't1' })],
    },
    ops: { live: [liveTarget('ops'), liveTarget('ops', { name: 'l2' })] },
  });
  const asked = [];
  const answers = [[1, 2], [0], [0], [1]];
  const run = runMain(w, ['start', '--project', 'shop,ops'], {
    process: fakeProcess({ stdin: { isTTY: true } }),
    checkbox: async (request) => {
      asked.push([request.title, request.items.map((item) => item.label)]);
      return answers.shift();
    },
  });
  await allReady(run, ['shop', 'ops']);
  assert.deepEqual(asked, [
    ['[shop] Which kinds of proxy?', ['ssh', 'live', 'twin']],
    ['[shop] Which live targets?', ['l1']],
    ['[shop] Which twin targets?', ['t1']],
    ['[ops] Which live targets?', ['l1', 'l2']],
  ]);
  assert.deepEqual(sessionOf(w, 'shop').targets.map((t) => `${t.kind}:${t.name}`), ['live:l1', 'twin:t1']);
  assert.deepEqual(sessionOf(w, 'ops').targets.map((t) => `${t.kind}:${t.name}`), ['live:l2']);
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('another project that stops ends an open that waits for ctx.signal', async () => {
  const w = await world({
    shop: { live: [liveTarget('shop', { name: 'h1', hold: true })] },
    ops: { live: [liveTarget('ops', { name: 'g1', after: 'h1' })] },
  });
  const run = runMain(w, ['start', '--project', 'shop,ops', '--all']);
  assert.equal(await run.done, 1);
  assert.deepEqual(control.holding, ['h1']);
  assert.deepEqual(control.gaveUp, ['g1']);
  assert.deepEqual(control.aborted, ['h1']);
  assert.match(run.proc.stderr.text, /^\[ops\] nothing could be opened$/m);
  assert.match(run.proc.stderr.text, /^\[shop\] .*live +h1 +SKIPPED +stopped$/m);
  assert.match(run.proc.stderr.text, /^\[shop\] .*CLOSING +another project stopped$/m);
});

// Each line of doctor as KIND TARGET STATUS DETAIL, a said line as KIND TARGET said DETAIL.
const brief = (text) => text.split('\n').filter((line) => line !== '').map((line) => line
  .replace(/^\d\d:\d\d:\d\d (\S+) +(\S+) {2,}(OK|FAIL|WARN|SKIPPED) +/, '$1 $2 $3 ')
  .replace(/^\d\d:\d\d:\d\d (\S+) +(\S+) {17,}/, '$1 $2 said '));

test('doctor: a target name finds a kind without a flag, --all takes it, and its open gets ctx.say, hidden, and ctx.signal', async () => {
  const said = `the server printed ${TOKEN} and ${'more '.repeat(50)}end`;
  const w = await world({}, [liveTarget('base', { tokenEnv: TOKEN_VAR, say: said })]);
  const doctor = async (args, host = {}) => {
    const run = runMain(w, ['doctor', ...args], host);
    return { code: await run.done, lines: brief(run.proc.stdout.text), out: run.proc.stdout.text };
  };
  const named = await doctor(['l1']);
  assert.equal(named.code, 0, named.out);
  assert.deepEqual(named.lines.slice(2), [
    `live l1 said the server printed [hidden] and ${'more '.repeat(50)}end`,
    'live l1 OK opened',
    '1 of 1 targets OK',
  ]);
  assert.ok(!named.out.includes(TOKEN));
  assert.equal(control.opened[0].signal, true);

  const all = await doctor(['--all']);
  assert.equal(all.code, 0, all.out);
  assert.deepEqual(all.lines.filter((line) => / OK /.test(line)).slice(2), ['ssh web1 OK connected', 'live l1 OK opened']);

  // Ctrl-C while the open waits for ctx.signal: the open ends, and the target fails with what open gave.
  writeInventory(w, 'shop', { live: [liveTarget('shop', { name: 'h1', hold: true, say: 'waiting' })] });
  const run = runMain(w, ['doctor', '--project', 'shop', 'h1']);
  await waitFor(() => control.holding.includes('h1'), 20000, 'the open to wait');
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 1);
  assert.deepEqual(control.aborted, ['h1']);
  assert.deepEqual(brief(run.proc.stdout.text).slice(2), [
    'live h1 said waiting',
    'live h1 SKIPPED stopped',
    'live h1 FAIL stopped',
    '-- doctor FAIL stopped: Ctrl-C',
    '0 of 1 targets OK',
  ]);
});
