import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateInventory } from '../src/inventory.js';
import { tempDir } from './temp.js';

const bin = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));

function tempEnv() {
  const base = fs.realpathSync(tempDir('ks-cli-'));
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'config'),
    KSPROXY_STATE_DIR: path.join(base, 'state'),
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
  };
  return { base, env };
}

function writeInventory(env, inventory) {
  fs.mkdirSync(env.KSPROXY_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify(inventory));
}

async function cli(args, env) {
  const child = spawn(process.execPath, [bin, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  let watchdog;
  try {
    const code = await Promise.race([
      new Promise((resolve) => child.on('close', resolve)),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`ksproxy ${args.join(' ')} did not exit`)), 15000);
      }),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(watchdog);
    child.kill('SIGKILL');
  }
}

const INVENTORY = {
  ssh: [{ name: 'web1', host: 'web1.example.com', allow: ['systemctl status *', 'df -h'] }],
  kubernetes: [{
    name: 'lab', kubeconfig: '/tmp/none.yaml', proxyPort: 18001, allow: ['get ...'],
  }],
};

test('--version prints the version', async () => {
  const { env } = tempEnv();
  const r = await cli(['--version'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), '0.4.0');
});

test('--help and no arguments print the usage', async () => {
  const { env } = tempEnv();
  for (const args of [['--help'], ['-h'], []]) {
    const r = await cli(args, env);
    assert.equal(r.code, 0, args.join(' '));
    for (const word of ['start', 'status', 'check', 'init', 'mcp']) assert.ok(r.stdout.includes(word), word);
  }
});

test('init writes a valid inventory once and never overwrites it', async () => {
  const { env } = tempEnv();
  const file = path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const first = await cli(['init'], env);
  assert.equal(first.code, 0);
  assert.ok(first.stdout.includes(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(env.KSPROXY_CONFIG_DIR).mode & 0o777, 0o700);
  const inv = validateInventory(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(inv.ssh.length, 1);

  fs.writeFileSync(file, '{"ssh":[]}');
  const second = await cli(['init'], env);
  assert.equal(second.code, 0);
  assert.ok(second.stdout.includes('already exists'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"ssh":[]}');
});

test('an unknown command and an unknown start flag return 2', async () => {
  const { env } = tempEnv();
  const a = await cli(['nope'], env);
  assert.equal(a.code, 2);
  assert.ok(a.stderr.includes('unknown command: nope'));
  const b = await cli(['start', '--bogus'], env);
  assert.equal(b.code, 2);
  const c = await cli(['start', '--ssh'], env);
  assert.equal(c.code, 2);
});

test('status with no session returns 1', async () => {
  const { env } = tempEnv();
  const r = await cli(['status'], env);
  assert.equal(r.code, 1);
  assert.ok(r.stdout.includes('no session'));
});

test('status lists each target and is 0 only when all are up', async () => {
  const { env } = tempEnv();
  const sessionDir = path.join(env.KSPROXY_STATE_DIR, 'session');
  fs.mkdirSync(path.join(env.KSPROXY_STATE_DIR, 's'), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const socket = path.join(env.KSPROXY_STATE_DIR, 's', 'ssh-web1');
  fs.writeFileSync(socket, '');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [{
      kind: 'ssh', name: 'web1', description: '', allow: [], host: 'web1.example.com', socket, state: 'up',
    }],
  }));
  const up = await cli(['status'], env);
  assert.equal(up.code, 0);
  assert.ok(up.stdout.includes('  up    ssh   web1'));

  fs.rmSync(socket);
  const down = await cli(['status'], env);
  assert.equal(down.code, 1);
  assert.ok(down.stdout.includes('  down  ssh   web1'));
});

function hms(ts) {
  return new Date(ts).toTimeString().slice(0, 8);
}

function writeAudit(env, lines) {
  const dir = path.join(env.KSPROXY_STATE_DIR, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'audit.log'),
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n',
  );
}

const LOG_ENTRIES = [
  {
    ts: '2026-11-20T12:19:19.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', rule: 'uptime', exitCode: 0, timedOut: false, spawnError: null, durationMs: 100, stdoutBytes: 7, stderrBytes: 0,
  },
  {
    ts: '2026-11-20T12:19:20.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'cat /etc/shadow', decision: 'refused', reason: 'long text', short: 'not on allowlist',
  },
  { ts: '2026-11-20T12:19:25.000Z', event: 'list' },
  {
    ts: '2026-11-20T12:19:26.000Z', event: 'call', tool: 'kubectl', kind: 'kube', target: 'lab', args: ['get', 'secrets', '-A'], decision: 'refused', reason: 'long text', short: 'secret resource',
  },
  { ts: '2026-11-20T12:40:02.000Z', event: 'target_down', kind: 'ssh', target: 'web2', message: 'connection lost' },
];

test('log prints the last entries formatted, in order, with the verbose detail', async () => {
  const { env } = tempEnv();
  writeAudit(env, LOG_ENTRIES);
  const all = await cli(['log'], env);
  assert.equal(all.code, 0);
  assert.deepEqual(all.stdout.trimEnd().split('\n'), [
    `${hms(LOG_ENTRIES[0].ts)} ssh  web1       ok       0.1s   uptime  (rule: uptime, out 7B, err 0B)`,
    `${hms(LOG_ENTRIES[1].ts)} ssh  web1       DENIED          cat /etc/shadow  [not on allowlist]`,
    `${hms(LOG_ENTRIES[2].ts)} --   agent      LIST            list_targets`,
    `${hms(LOG_ENTRIES[3].ts)} kube lab        DENIED          get secrets -A  [secret resource]`,
    `${hms(LOG_ENTRIES[4].ts)} ssh  web2       DOWN            connection lost`,
  ]);
  const two = await cli(['log', '-n', '2'], env);
  assert.deepEqual(two.stdout.trimEnd().split('\n').map((l) => l.slice(9, 25)), ['kube lab        ', 'ssh  web2       ']);
  const one = await cli(['log', '-n', '1'], env);
  assert.equal(one.stdout.trimEnd().split('\n').length, 1);
});

test('log --denied keeps only refused calls and --json prints raw lines', async () => {
  const { env } = tempEnv();
  writeAudit(env, LOG_ENTRIES);
  const denied = await cli(['log', '--denied'], env);
  assert.equal(denied.code, 0);
  const lines = denied.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.includes('DENIED')));

  const json = await cli(['log', '--json', '-n', '3'], env);
  assert.equal(json.code, 0);
  const parsed = json.stdout.trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(parsed, LOG_ENTRIES.slice(2));

  const both = await cli(['log', '--json', '--denied'], env);
  assert.deepEqual(both.stdout.trimEnd().split('\n').map((l) => JSON.parse(l)), [LOG_ENTRIES[1], LOG_ENTRIES[3]]);
});

test('log skips unparseable lines and never prints raw control or bidi characters', async () => {
  const { env } = tempEnv();
  writeAudit(env, [
    'this is not json',
    {
      ts: '2026-11-20T12:19:20.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'a\u001bb', command: 'ls \u202e x\u0007', decision: 'refused', reason: 'r', short: 's\u200f',
    },
    '{"broken":',
  ]);
  const text = await cli(['log'], env);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trimEnd().split('\n').length, 1);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200f\u202e]/.test(text.stdout));
  const json = await cli(['log', '--json'], env);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200f\u202e]/.test(json.stdout));
  const entry = JSON.parse(json.stdout.trimEnd());
  assert.equal(entry.command, 'ls \u202e x\u0007');
  assert.equal(entry.short, 's\u200f');
});

test('log with no file says so and exits 0', async () => {
  const { env } = tempEnv();
  const r = await cli(['log'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'no log yet');
});

test('log rejects a bad -n or an unknown option with exit 2', async () => {
  const { env } = tempEnv();
  writeAudit(env, LOG_ENTRIES);
  for (const args of [['-n', '0'], ['-n', 'abc'], ['-n', '5001'], ['-n', '-3'], ['-n', '1.5'], ['-n'], ['--bogus'], ['extra']]) {
    const r = await cli(['log', ...args], env);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.stderr.includes('Usage'), args.join(' '));
  }
  const edge = await cli(['log', '-n', '5000'], env);
  assert.equal(edge.code, 0);
});

test('the usage text lists log and start --verbose', async () => {
  const { env } = tempEnv();
  const r = await cli(['--help'], env);
  assert.ok(r.stdout.includes('log [-n N] [--denied] [--json]'));
  assert.ok(r.stdout.includes('-v'));
  assert.ok(r.stdout.includes('--verbose'));
});

test('start accepts -v and --verbose as options', async () => {
  const { env } = tempEnv();
  writeInventory(env, INVENTORY);
  for (const flag of ['-v', '--verbose']) {
    const r = await cli(['start', flag, '--ssh', 'nope'], env);
    assert.equal(r.code, 1, flag);
    assert.ok(r.stderr.includes('unknown ssh target "nope"'), r.stderr);
  }
});

test('status shows the last call and the calls counted since the session started', async () => {
  const { env } = tempEnv();
  const sessionDir = path.join(env.KSPROXY_STATE_DIR, 'session');
  fs.mkdirSync(path.join(env.KSPROXY_STATE_DIR, 's'), { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const socket = path.join(env.KSPROXY_STATE_DIR, 's', 'ssh-web1');
  fs.writeFileSync(socket, '');
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [{
      kind: 'ssh', name: 'web1', description: '', allow: [], host: 'web1.example.com', socket, state: 'up',
    }],
  }));
  const none = await cli(['status'], env);
  assert.ok(!none.stdout.includes('last call'));

  const call = (ts) => ({
    ts, event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command: 'uptime', decision: 'allowed', exitCode: 0,
  });
  writeAudit(env, [
    call('2026-11-19T10:00:00.000Z'),
    call('2026-11-19T10:00:01.000Z'),
    { ts: '2026-11-20T09:00:00.000Z', event: 'session_start', message: 'x' },
    call('2026-11-20T09:01:00.000Z'),
    { ts: '2026-11-20T09:02:00.000Z', event: 'list' },
    { ts: '2026-11-20T09:03:00.000Z', event: 'target_down', kind: 'ssh', target: 'web1', message: 'm' },
    {
      ...call('2026-11-20T09:04:00.000Z'), decision: 'refused', short: 'x', reason: 'y',
    },
    'not json',
  ]);
  const r = await cli(['status'], env);
  assert.equal(r.code, 0);
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines[lines.length - 1], `  last call ${hms('2026-11-20T09:04:00.000Z')} · 2 calls this session`);
  assert.ok(r.stdout.includes('  up    ssh   web1'));
});

test('check reports allowed and refused commands without opening anything', async () => {
  const { env } = tempEnv();
  writeInventory(env, INVENTORY);

  const ok = await cli(['check', 'ssh', 'web1', 'systemctl', 'status', 'nginx'], env);
  assert.equal(ok.code, 0);
  assert.ok(ok.stdout.includes('ALLOWED'));
  assert.ok(ok.stdout.includes('systemctl status *'));

  const no = await cli(['check', 'ssh', 'web1', 'rm', '-rf', '/'], env);
  assert.equal(no.code, 1);
  assert.ok(no.stdout.includes('REFUSED'));

  const shell = await cli(['check', 'ssh', 'web1', 'df -h; id'], env);
  assert.equal(shell.code, 1);
  assert.ok(shell.stdout.includes('REFUSED'));

  const kubeOk = await cli(['check', 'kube', 'lab', 'get', 'pods', '-A'], env);
  assert.equal(kubeOk.code, 0);

  const secrets = await cli(['check', 'kube', 'lab', 'get', 'secrets'], env);
  assert.equal(secrets.code, 1);
  assert.ok(secrets.stdout.includes('REFUSED'));

  const unknown = await cli(['check', 'ssh', 'nope', 'uptime'], env);
  assert.equal(unknown.code, 2);
  const badKind = await cli(['check', 'ftp', 'web1', 'uptime'], env);
  assert.equal(badKind.code, 2);
  const missing = await cli(['check', 'ssh', 'web1'], env);
  assert.equal(missing.code, 2);
});
