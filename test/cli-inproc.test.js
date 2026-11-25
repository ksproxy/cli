import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main, runCli } from '../src/cli.js';
import { appendAudit } from '../src/audit.js';
import { writeSession } from '../src/session.js';
import { sampleInventory } from '../src/inventory.js';
import { fakeProcess, fakeSsh, fakeKubectl, freePorts } from './start-helpers.js';
import { tempDir } from './temp.js';

const SAMPLE_INVENTORY = sampleInventory();

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world(inventory) {
  const base = fs.realpathSync(tempDir('ks-ci-'));
  dirs.push(base);
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
  };
  if (inventory !== undefined) {
    fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
    fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify(inventory));
  }
  return { base, env, sessionDir: path.join(base, 'st', 'session'), socketDir: path.join(base, 'st', 's') };
}

async function cli(args, env, hostExtra = {}) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc, ...hostExtra });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text, proc };
}

const INVENTORY = {
  ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['systemctl status *', 'df -h'] }],
  kubernetes: [{
    name: 'lab', kubeconfig: '/tmp/none.yaml', proxyPort: 18001, allow: ['get ...'],
  }],
};

test('help, no arguments and the version print to stdout and succeed', async () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const r = await cli(args, {});
    assert.equal(r.code, 0);
    assert.ok(r.stdout.startsWith('Usage: ksproxy <command>\n'));
    assert.equal(r.stderr, '');
  }
  const v = await cli(['--version'], {});
  assert.equal(v.code, 0);
  assert.match(v.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('an unknown command is a usage error', async () => {
  const r = await cli(['frobnicate'], {});
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith('unknown command: frobnicate\nUsage: ksproxy <command>'));
  assert.equal(r.stdout, '');
});

test('init writes the sample inventory once and never overwrites it', async () => {
  const { env } = world();
  const first = await cli(['init'], env);
  const file = path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json');
  assert.equal(first.code, 0);
  assert.equal(first.stdout, `wrote ${file} — edit it, then run: ksproxy start\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), SAMPLE_INVENTORY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(env.KSPROXY_CONFIG_DIR).mode & 0o777, 0o700);
  fs.writeFileSync(file, '{"ssh":[]}');
  const second = await cli(['init'], env);
  assert.equal(second.code, 0);
  assert.equal(second.stdout, `already exists: ${file}\n`);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ssh":[]}');
});

test('start arguments are parsed: unknown options and missing values are usage errors', async () => {
  for (const [args, message] of [
    [['start', '--bogus'], 'unknown option for start: --bogus'],
    [['start', '--ssh'], '--ssh needs a comma-separated list of names'],
    [['start', '--kube'], '--kube needs a comma-separated list of names'],
  ]) {
    const r = await cli(args, {});
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.startsWith(`${message}\nUsage:`), r.stderr);
  }
});

test('start arguments are handed to start: lists are merged, trimmed and checked against the inventory', async () => {
  const { env } = world(INVENTORY);
  let r = await cli(['start', '--ssh', 'web1, nope', '--ssh=other'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'unknown ssh target "nope"; known ssh targets: web1\n');
  r = await cli(['start', '--kube=lab', '--kube', 'ghost'], env);
  assert.equal(r.stderr, 'unknown kube target "ghost"; known kube targets: lab\n');
  const empty = world({ ssh: [], kubernetes: [] });
  r = await cli(['start', '-v', '--verbose', '--all'], empty.env);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'nothing selected\n');
});

test('log arguments are validated', async () => {
  for (const [args, message] of [
    [['log', '-n'], '-n needs a number from 1 to 5000'],
    [['log', '-n', 'abc'], '-n needs a number from 1 to 5000'],
    [['log', '-n', '0'], '-n needs a number from 1 to 5000'],
    [['log', '-n', '5001'], '-n needs a number from 1 to 5000'],
    [['log', '--bogus'], 'unknown option for log: --bogus'],
  ]) {
    const r = await cli(args, {});
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.startsWith(`${message}\nUsage:`), r.stderr);
  }
});

function writeLog(dir, entries) {
  const logs = path.join(path.dirname(dir), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (const entry of entries) appendAudit(path.join(logs, 'audit.log'), entry);
}

test('log says so when there is no log, and otherwise shows the formatted entries', async () => {
  const { env, sessionDir } = world();
  let r = await cli(['log'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'no log yet\n');

  writeLog(sessionDir, [
    {
      event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', rule: 'uptime', exitCode: 0, durationMs: 120, stdoutBytes: 5, stderrBytes: 0,
    },
    {
      event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'rm x', decision: 'refused', short: 'not on allowlist',
    },
    { event: 'list' },
    { event: 'target_up', kind: 'ssh', target: 'web1' },
    { event: 'mystery' },
  ]);
  r = await cli(['log'], env);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /ssh {2}web1 +ok +0\.1s +uptime {2}\(rule: uptime, out 5B, err 0B\)$/);
  assert.match(lines[1], /DENIED +rm x {2}\[not on allowlist\]$/);
  assert.match(lines[2], /LIST +list_targets$/);
  assert.match(lines[3], /ssh {2}web1 +UP$/);

  r = await cli(['log', '-n', '2'], env);
  assert.equal(r.stdout.trim().split('\n').length, 2);

  r = await cli(['log', '--denied'], env);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.match(r.stdout, /DENIED/);

  r = await cli(['log', '--json', '-n', '1'], env);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(r.stdout).event, 'mystery');
});

test('log skips a row that cannot be shown and prints the rows around it', async () => {
  const { env, sessionDir } = world();
  fs.mkdirSync(path.join(path.dirname(sessionDir), 'logs'), { recursive: true });
  const good = (command) => JSON.stringify({
    event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command, decision: 'allowed', rule: command, exitCode: 0,
  });
  const bad = '{"event":"call","target":{"toString":1,"valueOf":1}}';
  fs.writeFileSync(path.join(path.dirname(sessionDir), 'logs', 'audit.log'), `${good('first')}\n${bad}\n${good('second')}\n`);
  let r = await cli(['log'], env);
  assert.equal(r.code, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /first/);
  assert.match(lines[1], /second/);
  r = await cli(['log', '--denied'], env);
  assert.equal(r.code, 0);
  r = await cli(['log', '--json'], env);
  assert.equal(r.stdout.trim().split('\n').length, 3);
});

test('status reports no session, then each target and the calls so far', async () => {
  const { env, sessionDir, socketDir } = world();
  let r = await cli(['status'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'no session — run: ksproxy start\n');

  fs.mkdirSync(socketDir, { recursive: true });
  fs.writeFileSync(path.join(socketDir, 'ssh-web1'), '');
  const [deadPort] = await freePorts(1);
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [
      {
        kind: 'ssh', name: 'web1', host: 'web1.example.com', socket: path.join(socketDir, 'ssh-web1'), allow: [], state: 'up',
      },
      {
        kind: 'kubernetes', name: 'lab', proxyPort: deadPort, allow: [], state: 'up',
      },
    ],
  });
  r = await cli(['status'], env);
  assert.equal(r.code, 1);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], `session pid ${process.pid}, started 2026-11-20T00:00:00.000Z`);
  assert.equal(lines[1], '  up    ssh   web1');
  assert.equal(lines[2], '  down  kube  lab');
  assert.equal(lines.length, 3);

  writeLog(sessionDir, [
    { event: 'session_start' },
    {
      event: 'call', tool: 'ssh_exec', target: 'web1', command: 'df -h', decision: 'allowed', exitCode: 0,
    },
  ]);
  r = await cli(['status'], env);
  assert.match(r.stdout, /\n {2}last call \d\d:\d\d:\d\d · 1 calls this session\n$/);
});

test('status succeeds when everything is up', async () => {
  const { env, sessionDir, socketDir } = world();
  fs.mkdirSync(socketDir, { recursive: true });
  fs.writeFileSync(path.join(socketDir, 'ssh-web1'), '');
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: 'x',
    targets: [{
      kind: 'ssh', name: 'web1', host: 'h', socket: path.join(socketDir, 'ssh-web1'), allow: [], state: 'up',
    }],
  });
  const r = await cli(['status'], env);
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes('last call'));
});

test('check needs a kind, a name and a command', async () => {
  for (const args of [['check'], ['check', 'ssh'], ['check', 'ssh', 'web1'], ['check', 'db', 'web1', 'ls']]) {
    const r = await cli(args, {});
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.startsWith('usage: ksproxy check [--project NAME] <ssh|kube|local|http|command|es|mq|redis|pg|mysql|mongo|kafka|mcp> <name> <command...>\nUsage:'));
  }
});

test('check reports an inventory problem, an unknown target, and a decision', async () => {
  const missing = world();
  let r = await cli(['check', 'ssh', 'web1', 'df'], missing.env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /inventory not found: .*; run: ksproxy init\n$/);

  const { env } = world(INVENTORY);
  r = await cli(['check', 'ssh', 'nope', 'df'], env);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'unknown ssh target "nope"; known: web1\n');
  r = await cli(['check', 'kube', 'nope', 'get', 'pods'], env);
  assert.equal(r.stderr, 'unknown kube target "nope"; known: lab\n');
  const none = world({ ssh: [], kubernetes: [] });
  r = await cli(['check', 'ssh', 'nope', 'df'], none.env);
  assert.equal(r.stderr, 'unknown ssh target "nope"; known: none\n');

  r = await cli(['check', 'ssh', 'web1', 'df', '-h'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: df -h\n');
  r = await cli(['check', 'ssh', 'web1', 'rm', '-rf', '/'], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^REFUSED: /);
  r = await cli(['check', 'kube', 'lab', 'get', 'pods'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: get ...\n');
  r = await cli(['check', 'kube', 'lab', 'get', 'secrets'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'REFUSED: secret resources are never allowed\n');
});

test('an error that is not an inventory error is not hidden by check', async () => {
  await assert.rejects(main(['check', 'ssh', 'web1', 'df'], { [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: 5 }, { process: fakeProcess() }), TypeError);
});

test('mcp serves the protocol on the given input and output', async () => {
  const { env } = world();
  const proc = fakeProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let written = '';
  stdout.on('data', (c) => { written += c; });
  proc.stdin = stdin;
  proc.stdout = stdout;
  const done = main(['mcp'], env, { process: proc });
  stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  stdin.end();
  assert.equal(await done, 0);
  assert.deepEqual(JSON.parse(written), { jsonrpc: '2.0', id: 1, result: {} });
});

test('runCli stores the exit code of main', async () => {
  const proc = fakeProcess();
  proc.env = { seen: 'yes' };
  let received;
  await runCli(['x', 'y'], proc, async (argv, env, host) => {
    received = { argv, env, host };
    return 7;
  });
  assert.equal(proc.exitCode, 7);
  assert.deepEqual(received.argv, ['x', 'y']);
  assert.deepEqual(received.env, { seen: 'yes' });
  assert.equal(received.host.process, proc);
});

test('runCli reports a failure of main on stderr and exits 1', async () => {
  const proc = fakeProcess();
  proc.env = {};
  await runCli([], proc, async () => { throw new Error('exploded'); });
  assert.equal(proc.stderr.text, 'ksproxy: exploded\n');
  assert.equal(proc.exitCode, 1);

  const other = fakeProcess();
  other.env = {};
  await runCli([], other, async () => { throw 'plain'; });
  assert.equal(other.stderr.text, 'ksproxy: plain\n');
  assert.equal(other.exitCode, 1);
});

test('runCli runs the real main with the process-like object', async () => {
  const proc = fakeProcess();
  proc.env = {};
  await runCli(['--version'], proc);
  assert.match(proc.stdout.text, /^\d+\.\d+\.\d+\n$/);
  assert.equal(proc.exitCode, 0);
});
