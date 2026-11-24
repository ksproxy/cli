import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main, takeProject } from '../src/cli.js';
import { appendAudit } from '../src/audit.js';
import { PROJECT_KEY, PROJECT_RULE } from '../src/paths.js';
import { writeSession } from '../src/session.js';
import { sampleInventory } from '../src/inventory.js';
import { fakeProcess, fakeSsh } from './start-helpers.js';
import { tempDir } from './temp.js';

const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const SSH_KEY = ['KSPROXY', 'SSH'].join('_');

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world() {
  const base = fs.realpathSync(tempDir('ks-pc-'));
  dirs.push(base);
  const env = { ...process.env, [CONFIG_KEY]: path.join(base, 'cfg'), [STATE_KEY]: path.join(base, 'st'), [SSH_KEY]: fakeSsh };
  delete env[PROJECT_KEY];
  return { base, env, cfg: env[CONFIG_KEY], st: env[STATE_KEY] };
}

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

function writeInventory(file, inventory) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(inventory));
}

const inventoryOf = (name) => ({ ssh: [{ name, host: `${name}.example.com`, allow: ['uptime'] }] });

function liveSessionOf(dir, startedAt, names) {
  const sockets = path.join(path.dirname(dir), 's');
  writeSession(dir, {
    version: 1,
    pid: process.pid,
    startedAt,
    targets: names.map((name) => ({
      kind: 'ssh', name, host: 'h', socket: path.join(sockets, `ssh-${name}`), allow: [], state: 'up',
    })),
  });
  fs.mkdirSync(sockets, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(sockets, `ssh-${name}`), '');
}

const callEntry = (command) => ({
  event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command, decision: 'allowed', rule: command, exitCode: 0,
});

function writeLog(dir, entries) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of entries) appendAudit(path.join(dir, 'audit.log'), entry);
}

test('takeProject takes the flag in both spellings, anywhere, and leaves the other words', () => {
  assert.deepEqual(takeProject([]), { project: null, rest: [] });
  assert.deepEqual(takeProject(['--all', '--project', 'shop', '-v']), { project: 'shop', rest: ['--all', '-v'] });
  assert.deepEqual(takeProject(['--project=shop', '--all']), { project: 'shop', rest: ['--all'] });
  assert.deepEqual(takeProject(['--project=a_b-1']), { project: 'a_b-1', rest: [] });
});

test('takeProject refuses a flag given twice, without a value, or with a bad name', () => {
  assert.deepEqual(takeProject(['--project', 'a', '--project=b']), { error: '--project given twice' });
  assert.deepEqual(takeProject(['--project=a', '--project', 'b']), { error: '--project given twice' });
  assert.deepEqual(takeProject(['--project']), { error: '--project needs a project name' });
  assert.deepEqual(takeProject(['--project=']), { error: '--project needs a project name' });
  assert.deepEqual(takeProject(['--project', '']), { error: '--project needs a project name' });
  for (const bad of ['Shop', '-a', 'a'.repeat(25), 'a/b', '--all']) {
    assert.deepEqual(takeProject(['--project', bad]), { error: PROJECT_RULE }, bad);
  }
});

test('takeProject for check only looks before the kind', () => {
  const beforeKind = { beforeKind: true };
  assert.deepEqual(takeProject(['--project', 'shop', 'ssh', 'web1', 'uptime'], beforeKind), { project: 'shop', rest: ['ssh', 'web1', 'uptime'] });
  assert.deepEqual(takeProject(['--project=shop', 'ssh', 'web1', 'uptime'], beforeKind), { project: 'shop', rest: ['ssh', 'web1', 'uptime'] });
  assert.deepEqual(takeProject(['ssh', 'web1', 'grep', '--project', 'x'], beforeKind), { project: null, rest: ['ssh', 'web1', 'grep', '--project', 'x'] });
  assert.deepEqual(takeProject(['ssh', 'web1', 'grep', '--project=Bad'], beforeKind), { project: null, rest: ['ssh', 'web1', 'grep', '--project=Bad'] });
  assert.deepEqual(takeProject(['--project', 'a', '--project', 'b', 'ssh'], beforeKind), { error: '--project given twice' });
});

test('init --project writes the sample into the project folder and says how to start it', async () => {
  const { env, cfg } = world();
  const file = path.join(cfg, 'projects', 'shop.json');
  const first = await cli(['init', '--project', 'shop'], env);
  assert.equal(first.code, 0);
  assert.equal(first.stdout, `wrote ${file} — edit it, then run: ksproxy start --project shop\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), sampleInventory());
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(cfg, 'projects')).mode & 0o777, 0o700);
  assert.ok(!fs.existsSync(path.join(cfg, 'inventory.json')));
  fs.writeFileSync(file, '{"ssh":[]}');
  const second = await cli(['init', '--project=shop'], env);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, `already exists: ${file}\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ssh":[]}');
});

test('init without a project still writes inventory.json', async () => {
  const { env, cfg } = world();
  const r = await cli(['init'], env);
  assert.equal(r.stdout, `wrote ${path.join(cfg, 'inventory.json')} — edit it, then run: ksproxy start\n`);
  assert.ok(!fs.existsSync(path.join(cfg, 'projects')));
});

test('a bad project flag is a usage error with the rule, for every command, before anything is read', async () => {
  const { env } = world();
  const cases = [
    [['init', '--project', 'Shop'], PROJECT_RULE],
    [['start', '--all', '--project=Shop'], PROJECT_RULE],
    [['status', '--project', 'x'.repeat(25)], PROJECT_RULE],
    [['log', '--project', 'a/b'], PROJECT_RULE],
    [['check', '--project', 'Shop', 'ssh', 'web1', 'uptime'], PROJECT_RULE],
    [['mcp', '--project', '-x'], PROJECT_RULE],
    [['status', '--project'], '--project needs a project name'],
    [['log', '--project', 'a', '--project', 'b'], '--project given twice'],
    [['check', '--project=a', '--project=b', 'ssh', 'web1', 'uptime'], '--project given twice'],
  ];
  for (const [args, message] of cases) {
    const r = await cli(args, env);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.startsWith(`${message}\nUsage: ksproxy <command>`), r.stderr);
    assert.equal(r.stdout, '');
  }
  assert.ok(!fs.existsSync(env[CONFIG_KEY]) && !fs.existsSync(env[STATE_KEY]), 'nothing was read or written');
});

test('both spellings of the flag give the same result for log', async () => {
  const { env, st } = world();
  writeLog(path.join(st, 'p', 'shop', 'logs'), [callEntry('df-shop')]);
  const a = await cli(['log', '--project', 'shop'], env);
  const b = await cli(['log', '--project=shop'], env);
  assert.equal(a.code, 0);
  assert.deepEqual(a, b);
  assert.match(a.stdout, /df-shop/);
});

test('a missing project file names the file and the init command', async () => {
  const { env, cfg } = world();
  const r = await cli(['check', '--project', 'nope', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, `inventory not found: ${path.join(cfg, 'projects', 'nope.json')}; run: ksproxy init --project nope\n`);
  const plain = await cli(['check', 'ssh', 'web1', 'uptime'], env);
  assert.equal(plain.stderr, `inventory not found: ${path.join(cfg, 'inventory.json')}; run: ksproxy init\n`);
});

test('start --project with no project file names the file and the init command of that project', async () => {
  const { env, cfg, st } = world();
  const r = await cli(['start', '--project', 'nope', '--all'], env);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(`inventory not found: ${path.join(cfg, 'projects', 'nope.json')}; run: ksproxy init --project nope`), r.stderr);
  assert.equal(fs.existsSync(path.join(st, 'p', 'nope')), false, 'nothing is made for a project that has no file');
});

test('check --project reads the project file; a flag after the kind is part of the command', async () => {
  const { env, cfg } = world();
  writeInventory(path.join(cfg, 'projects', 'shop.json'), inventoryOf('web1'));
  writeInventory(path.join(cfg, 'inventory.json'), { ssh: [{ name: 'web1', host: 'h', allow: ['grep --project x'] }] });
  let r = await cli(['check', '--project', 'shop', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: uptime\n');
  r = await cli(['check', '--project=shop', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.stdout, 'ALLOWED by rule: uptime\n');
  r = await cli(['check', 'ssh', 'web1', 'grep', '--project', 'x'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: grep --project x\n');
  r = await cli(['check', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.code, 1);
});

test('log --project reads that project\'s log folder only', async () => {
  const { env, st } = world();
  writeLog(path.join(st, 'logs'), [callEntry('df-default')]);
  writeLog(path.join(st, 'p', 'shop', 'logs'), [callEntry('df-shop')]);
  writeLog(path.join(st, 'p', 'ops', 'logs'), [callEntry('df-ops')]);
  let r = await cli(['log', '--project', 'shop'], env);
  assert.match(r.stdout, /df-shop/);
  assert.doesNotMatch(r.stdout, /df-default|df-ops/);
  r = await cli(['log'], env);
  assert.match(r.stdout, /df-default/);
  assert.doesNotMatch(r.stdout, /df-shop|df-ops/);
  r = await cli(['log', '--project', 'none'], env);
  assert.equal(r.stdout, 'no log yet\n');
});

test('status without a session says how to start, for the default and for a project', async () => {
  const { env } = world();
  let r = await cli(['status'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'no session — run: ksproxy start\n');
  r = await cli(['status', '--project', 'shop'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'no session — run: ksproxy start --project shop\n');
});

test('status lists the default first, then each live project in name order', async () => {
  const { env, st } = world();
  liveSessionOf(path.join(st, 'p', 'shop', 'session'), '2026-11-20T00:00:02.000Z', ['web2']);
  liveSessionOf(path.join(st, 'session'), '2026-11-20T00:00:00.000Z', ['web0']);
  liveSessionOf(path.join(st, 'p', 'ops', 'session'), '2026-11-20T00:00:01.000Z', ['web1', 'web3']);
  writeSession(path.join(st, 'p', 'gone', 'session'), { version: 1, pid: 2 ** 22 + 12345, startedAt: 'old', targets: [] });
  writeSession(path.join(st, 'p', 'odd', 'session'), {
    version: 1, pid: process.pid, startedAt: 'odd', targets: 'no',
  });
  fs.mkdirSync(path.join(st, 'p', 'Bad Name', 'session'), { recursive: true });
  const { pid } = process;
  const r = await cli(['status'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, [
    `session pid ${pid}, started 2026-11-20T00:00:00.000Z`,
    '  up    ssh   web0',
    `project ops: session pid ${pid}, started 2026-11-20T00:00:01.000Z`,
    '  up    ssh   web1',
    '  up    ssh   web3',
    `project shop: session pid ${pid}, started 2026-11-20T00:00:02.000Z`,
    '  up    ssh   web2',
    '',
  ].join('\n'));
});

test('status with only projects live lists them without a default block', async () => {
  const { env, st } = world();
  liveSessionOf(path.join(st, 'p', 'shop', 'session'), 's', ['web2']);
  fs.writeFileSync(path.join(st, 'p', 'file'), '');
  const r = await cli(['status'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `project shop: session pid ${process.pid}, started s\n  up    ssh   web2\n`);
});

test('status exits 1 when any listed target is not up, and shows each session\'s last call', async () => {
  const { env, st } = world();
  liveSessionOf(path.join(st, 'session'), 'd', ['web0']);
  liveSessionOf(path.join(st, 'p', 'shop', 'session'), 's', ['web2']);
  fs.rmSync(path.join(st, 'p', 'shop', 's', 'ssh-web2'));
  writeLog(path.join(st, 'p', 'shop', 'logs'), [
    { event: 'session_start' },
    {
      event: 'call', tool: 'ssh_exec', target: 'web2', command: 'uptime', decision: 'allowed', exitCode: 0,
    },
  ]);
  const r = await cli(['status'], env);
  assert.equal(r.code, 1);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], '  up    ssh   web0');
  assert.equal(lines[2], `project shop: session pid ${process.pid}, started s`);
  assert.equal(lines[3], '  down  ssh   web2');
  assert.match(lines[4], /^ {2}last call \d\d:\d\d:\d\d · 1 calls this session$/);
});

test('status never follows a link under p, and a session file that is malformed or cannot be read is left out without stopping the list', async () => {
  const { base, env, st } = world();
  // A live session outside the state folder, reached only through a planted link p/linked.
  const outside = path.join(base, 'outside');
  liveSessionOf(path.join(outside, 'session'), 'OUTSIDE-FILE', ['webx']);
  fs.mkdirSync(path.join(st, 'p'), { recursive: true });
  fs.symlinkSync(outside, path.join(st, 'p', 'linked'));
  // A target that is not an object, and a cluster whose recorded state is not a text while its port answers.
  const server = net.createServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    writeSession(path.join(st, 'p', 'aa', 'session'), { version: 1, pid: process.pid, startedAt: 'a', targets: [null] });
    writeSession(path.join(st, 'p', 'bb', 'session'), {
      version: 1, pid: process.pid, startedAt: 'b', targets: [{ kind: 'kubernetes', name: 'k', proxyPort: server.address().port, state: 5 }],
    });
    // A session file that cannot be read: a folder in its place.
    fs.mkdirSync(path.join(st, 'p', 'cc', 'session', 'session.json'), { recursive: true });
    liveSessionOf(path.join(st, 'p', 'zz', 'session'), 'z', ['web2']);
    let r = await cli(['status'], env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, `project zz: session pid ${process.pid}, started z\n  up    ssh   web2\n`);
    for (const name of ['linked', 'aa', 'bb', 'cc']) {
      r = await cli(['status', '--project', name], env);
      assert.equal(r.code, 1, name);
      assert.equal(r.stdout, `no session — run: ksproxy start --project ${name}\n`, name);
    }
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

test('status --project shows that project only, under its header line', async () => {
  const { env, st } = world();
  liveSessionOf(path.join(st, 'session'), 'd', ['web0']);
  liveSessionOf(path.join(st, 'p', 'shop', 'session'), 's', ['web2']);
  liveSessionOf(path.join(st, 'p', 'ops', 'session'), 'o', ['web1']);
  const r = await cli(['status', '--project', 'shop'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `project shop: session pid ${process.pid}, started s\n  up    ssh   web2\n`);
  const none = await cli(['status', '--project', 'other'], env);
  assert.equal(none.code, 1);
  assert.equal(none.stdout, 'no session — run: ksproxy start --project other\n');
});

async function mcpListTargets(env) {
  const proc = fakeProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdout.on('data', (c) => { written += c; });
  proc.stdin = stdin;
  proc.stdout = stdout;
  const done = main(['mcp'], env, { process: proc });
  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_targets', arguments: {} },
  })}\n`);
  stdin.end();
  assert.equal(await done, 0);
  return written;
}

test('an inherited project variable never chooses a project, for any command or path through main', async () => {
  for (const inherited of ['ops', 'Bad Name']) {
    const { env, cfg, st } = world();
    env[PROJECT_KEY] = inherited;
    writeInventory(path.join(cfg, 'inventory.json'), inventoryOf('web1'));
    writeInventory(path.join(cfg, 'projects', 'ops.json'), inventoryOf('other'));
    liveSessionOf(path.join(st, 'session'), 'd', ['web0']);
    liveSessionOf(path.join(st, 'p', 'ops', 'session'), 'o', ['webops']);
    writeLog(path.join(st, 'logs'), [callEntry('df-default')]);
    writeLog(path.join(st, 'p', 'ops', 'logs'), [callEntry('df-ops')]);

    let r = await cli(['log'], env);
    assert.match(r.stdout, /df-default/, inherited);
    assert.doesNotMatch(r.stdout, /df-ops/, inherited);

    r = await cli(['status'], env);
    assert.match(r.stdout, /^session pid \d+, started d\n {2}up {4}ssh {3}web0\n/, inherited);

    r = await cli(['check', 'ssh', 'web1', 'uptime'], env);
    assert.equal(r.stdout, 'ALLOWED by rule: uptime\n', inherited);
    r = await cli(['check', 'ssh', 'other', 'uptime'], env);
    assert.equal(r.code, 2, inherited);

    const fresh = world();
    fresh.env[PROJECT_KEY] = inherited;
    r = await cli(['init'], fresh.env);
    assert.equal(r.stdout, `wrote ${path.join(fresh.cfg, 'inventory.json')} — edit it, then run: ksproxy start\n`, inherited);

    const exits = [[['--help'], 0], [['-h'], 0], [[], 0], [['--version'], 0], [['frobnicate'], 2], [['log', '-n', '0'], 2], [['start', '--bogus'], 2]];
    for (const [args, code] of exits) {
      r = await cli(args, env);
      assert.equal(r.code, code, args.join(' '));
    }

    const written = await mcpListTargets(env);
    assert.match(written, /web0/, inherited);
    assert.doesNotMatch(written, /webops/, inherited);
  }
});

test('the flag chooses the project even when the caller already has a different one in its environment', async () => {
  const { env, cfg } = world();
  env[PROJECT_KEY] = 'ops';
  writeInventory(path.join(cfg, 'projects', 'shop.json'), inventoryOf('web1'));
  writeInventory(path.join(cfg, 'projects', 'ops.json'), inventoryOf('other'));
  const r = await cli(['check', '--project', 'shop', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.stdout, 'ALLOWED by rule: uptime\n');
});

test('an old project named default makes --project default a usage error, whichever file or folder it is', async () => {
  for (const [where, make] of [
    ['cfg', (w) => writeInventory(path.join(w.cfg, 'projects', 'default.json'), inventoryOf('old'))],
    ['st', (w) => fs.mkdirSync(path.join(w.st, 'p', 'default'), { recursive: true })],
  ]) {
    const w = world();
    make(w);
    const path1 = where === 'cfg' ? path.join(w.cfg, 'projects', 'default.json') : path.join(w.st, 'p', 'default');
    const message = `--project default now means inventory.json, but an old project named default is still here (${path1}); rename it, for example to default-old, and update its agent configs`;
    for (const args of [['status', '--project', 'default'], ['start', '--project=default,shop'], ['mcp', '--project', 'default'], ['check', '--project', 'default', 'ssh', 'web1', 'uptime']]) {
      const result = await cli(args, w.env);
      assert.equal(result.code, 2, args.join(' '));
      assert.ok(result.stderr.startsWith(`${message}\n`), result.stderr);
    }
    // Without the flag, or with another name, nothing changes.
    assert.notEqual((await cli(['status'], w.env)).code, 2);
    assert.deepEqual(takeProject(['--project', 'shop'], { env: w.env }), { project: 'shop', rest: [] });
  }
});

test('the message names the file first when both an old file and an old folder exist', () => {
  const w = world();
  writeInventory(path.join(w.cfg, 'projects', 'default.json'), inventoryOf('old'));
  fs.mkdirSync(path.join(w.st, 'p', 'default'), { recursive: true });
  const { error } = takeProject(['--project', 'default'], { env: w.env });
  assert.ok(error.includes(`(${path.join(w.cfg, 'projects', 'default.json')})`), error);
});

test('--project default still works without an old project of that name', async () => {
  const w = world();
  assert.deepEqual(takeProject(['--project', 'default'], { env: w.env }), { project: null, rest: [] });
  assert.deepEqual(takeProject(['--project', 'default,shop'], { list: true, env: w.env }), {
    project: null, projects: [null, 'shop'], rest: [],
  });
  const result = await cli(['status', '--project', 'default'], w.env);
  assert.notEqual(result.code, 2);
});
