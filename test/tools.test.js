import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TOOLS, callTool, decideKube, decideSsh, scrubOutput,
} from '../src/tools.js';
import { writeSession } from '../src/session.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));

let base;
let sessionDir;
let env;
let server;
let session;

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-tools-')));
  sessionDir = path.join(base, 'session');
  fs.mkdirSync(path.join(base, 's'));
  fs.mkdirSync(path.join(base, 'logs'));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
  fs.writeFileSync(path.join(sessionDir, 'kubeconfig'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-web1'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-open1'), '');
  server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  env = {
    ...process.env,
    KSPROXY_STATE_DIR: base,
    KSPROXY_SSH: fakeSsh,
    KSPROXY_KUBECTL: fakeKubectl,
  };
  session = {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [
      {
        kind: 'ssh', name: 'web1', description: 'web box', allow: ['uptime', 'cat *', 'fail', 'slow'],
        host: 'web1.example.com', socket: path.join(base, 's', 'ssh-web1'), state: 'up',
      },
      {
        kind: 'ssh', name: 'open1', description: 'open box', allow: 'any',
        host: 'sopen1', socket: path.join(base, 's', 'ssh-open1'), state: 'up',
      },
      {
        kind: 'kubernetes', name: 'lab', description: 'lab', allow: ['get ...'],
        proxyPort: port, manifestRoots: [], tunnel: null, state: 'up',
      },
    ],
  };
  writeSession(sessionDir, session);
});

after(async () => {
  await new Promise((r) => server.close(r));
});

function allAuditLines() {
  const file = path.join(base, 'logs', 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function auditLines() {
  return allAuditLines().filter((l) => l.event === 'call');
}

test('TOOLS lists the four tools', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['list_targets', 'ssh_exec', 'kubectl', 'local_exec']);
  for (const t of TOOLS) assert.equal(t.inputSchema.type, 'object');
});

test('list_targets shows state and rules but no host, socket or port', async () => {
  const r = await callTool('list_targets', {}, env);
  assert.equal(r.isError, false);
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.startedAt, session.startedAt);
  assert.deepEqual(parsed.targets.map((t) => t.name), ['web1', 'open1', 'lab']);
  assert.equal(parsed.targets[0].state, 'up');
  assert.equal(parsed.targets[2].state, 'up');
  assert.deepEqual(parsed.targets[0].allow, session.targets[0].allow);
  assert.ok(!r.text.includes('socket'));
  assert.ok(!r.text.includes('host'));
  assert.ok(!r.text.includes('proxyPort'));
  assert.ok(!r.text.includes(String(session.targets[2].proxyPort)));
});

test('ssh_exec runs an allowed command', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, env);
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('exit code: 0'));
  assert.ok(r.text.includes('ran web1 uptime'));
});

test('ssh_exec allows a rule with a wildcard', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'cat /etc/hostname' }, env);
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('ran web1 cat /etc/hostname'));
});

test('ssh_exec refuses a command not on the list', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'id' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
  assert.ok(r.text.includes('uptime'));
});

test('ssh_exec refuses shell syntax', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'uptime; id' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
  assert.ok(r.text.includes('";"'));
});

test('ssh_exec reports a non-zero exit with stderr', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'fail' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('exit code: 3'));
  assert.ok(r.text.includes('boom'));
});

test('ssh_exec times out', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'slow', timeout_seconds: 1 }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('timed out'));
});

test('ssh_exec on an "any" target passes the raw command', async () => {
  const r = await callTool('ssh_exec', { server: 'open1', command: 'ls | wc -l' }, env);
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('ran open1 ls | wc -l'));
});

test('ssh_exec on an "any" target still refuses a leading dash', async () => {
  const r = await callTool('ssh_exec', { server: 'open1', command: '-oProxyCommand=x' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
});

test('ssh_exec with an unknown server lists the open ones', async () => {
  const r = await callTool('ssh_exec', { server: 'nope', command: 'uptime' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('unknown ssh server'));
  assert.ok(r.text.includes('web1'));
  assert.ok(!r.text.includes('lab'));
});

test('ssh_exec with a cluster name is the wrong kind', async () => {
  const r = await callTool('ssh_exec', { server: 'lab', command: 'uptime' }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('unknown ssh server'));
});

test('kubectl with a server name is the wrong kind', async () => {
  const r = await callTool('kubectl', { cluster: 'web1', args: ['get', 'pods'] }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('unknown cluster'));
  assert.ok(r.text.includes('lab'));
});

test('invalid arguments are rejected', async () => {
  for (const [name, args] of [
    ['ssh_exec', { server: 'web1', command: 5 }],
    ['ssh_exec', { server: 'web1' }],
    ['ssh_exec', { server: 'web1', command: 'uptime', timeout_seconds: 0 }],
    ['ssh_exec', { server: 'web1', command: 'uptime', timeout_seconds: 601 }],
    ['ssh_exec', { server: 'web1', command: 'uptime', timeout_seconds: 1.5 }],
    ['kubectl', { cluster: 'lab', args: 'get pods' }],
    ['kubectl', { cluster: 'lab', args: ['get', 5] }],
    ['kubectl', { cluster: 7, args: ['get'] }],
  ]) {
    const r = await callTool(name, args, env);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.ok(r.text.startsWith('invalid arguments'), `${JSON.stringify(args)} -> ${r.text}`);
  }
});

test('kubectl runs an allowed command against the session kubeconfig', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['get', 'pods'] }, env);
  assert.equal(r.isError, false);
  const expected = ['--kubeconfig', '<ksproxy>/session/kubeconfig', '--context', 'lab', 'get', 'pods'];
  assert.ok(r.text.includes(JSON.stringify(expected)), r.text);
});

test('kubectl refuses secrets', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['get', 'secrets'] }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
  assert.ok(r.text.includes('secret'));
});

test('kubectl refuses by allowlist', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['delete', 'pod', 'x'] }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
  assert.ok(r.text.includes('Allowed'));
});

test('kubectl refuses identity flags', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['get', 'pods', '--context', 'admin'] }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED'));
  assert.ok(r.text.includes('--context'));
});

test('audit.log has one line per call, including invalid and unknown-target ones', () => {
  const lines = auditLines();
  const kinds = lines.map((l) => `${l.tool}:${l.target}:${l.decision}`);
  assert.deepEqual(kinds, [
    'ssh_exec:web1:allowed',
    'ssh_exec:web1:allowed',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:allowed',
    'ssh_exec:web1:allowed',
    'ssh_exec:open1:allowed',
    'ssh_exec:open1:refused',
    'ssh_exec:nope:refused',
    'ssh_exec:lab:refused',
    'kubectl:web1:refused',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:refused',
    'ssh_exec:web1:refused',
    'kubectl:lab:refused',
    'kubectl:lab:refused',
    'kubectl:7:refused',
    'kubectl:lab:allowed',
    'kubectl:lab:refused',
    'kubectl:lab:refused',
    'kubectl:lab:refused',
  ]);
  for (const l of lines) {
    assert.ok(l.ts);
    assert.equal(l.event, 'call');
    assert.equal(l.kind, l.tool === 'kubectl' ? 'kube' : 'ssh');
    if (l.decision === 'refused') {
      assert.equal(typeof l.reason, 'string');
      assert.equal(typeof l.short, 'string');
      assert.ok(l.short.length > 0 && l.short.length <= 120);
    } else {
      assert.equal(l.spawnError, null);
      assert.ok('exitCode' in l);
      assert.ok(l.exitCode === null || typeof l.exitCode === 'number');
      assert.equal(typeof l.durationMs, 'number');
      assert.equal(typeof l.stdoutBytes, 'number');
      assert.equal(typeof l.stderrBytes, 'number');
      assert.equal(typeof l.timedOut, 'boolean');
    }
  }
  assert.equal(lines[0].command, 'uptime');
  assert.deepEqual(lines[19].args, ['get', 'pods']);
  assert.equal(lines[4].exitCode, 3);
  assert.equal(lines[5].timedOut, true);
  assert.equal(lines[8].command, 'uptime');
  assert.equal(lines[11].command, null);
  assert.equal(lines[12].command, null);
  assert.equal(lines[13].command, 'uptime');
  assert.equal(lines[16].args, null);
  assert.equal(lines[17].args, null);
  assert.deepEqual(lines[18].args, ['get']);
});

test('refusal text names the target', async () => {
  const sshResult = await callTool('ssh_exec', { server: 'web1', command: 'id' }, env);
  assert.ok(sshResult.text.startsWith('REFUSED (ssh web1): '), sshResult.text);
  const kubeResult = await callTool('kubectl', { cluster: 'lab', args: ['get', 'secrets'] }, env);
  assert.ok(kubeResult.text.startsWith('REFUSED (kube lab): '), kubeResult.text);
  const lines = auditLines();
  assert.equal(lines[lines.length - 1].target, 'lab');
  assert.equal(lines[lines.length - 1].decision, 'refused');
});

test('an overlong unknown target name is cut to 64 characters in the audit log', async () => {
  const before = auditLines().length;
  await callTool('ssh_exec', { server: 'x'.repeat(200), command: 'uptime' }, env);
  const lines = auditLines();
  assert.equal(lines.length, before + 1);
  assert.equal(lines[lines.length - 1].target.length, 64);
});

test('a 1 MB command and a 1 MB cluster name stay small in the audit log and the result', async () => {
  const huge = 'x'.repeat(1024 * 1024);
  const before = auditLines().length;
  const ssh = await callTool('ssh_exec', { server: 'web1', command: `cat ${huge}` }, env);
  const kube = await callTool('kubectl', { cluster: huge, args: ['get', 'pods'] }, env);
  const sshName = await callTool('ssh_exec', { server: huge, command: 'uptime' }, env);
  const manyArgs = await callTool('kubectl', { cluster: 'lab', args: ['get', ...Array(200).fill(huge.slice(0, 5000))] }, env);
  for (const r of [ssh, kube, sshName, manyArgs]) {
    assert.equal(r.isError, true);
    assert.ok(r.text.length < 4096, String(r.text.length));
  }
  const lines = auditLines().slice(before);
  assert.equal(lines.length, 4);
  for (const entry of lines.slice(0, 3)) assert.ok(JSON.stringify(entry).length < 4096, String(JSON.stringify(entry).length));
  assert.ok(lines[0].command.length <= 2000);
  assert.ok(lines[0].command.endsWith('…'));
  assert.equal(lines[1].target.length, 64);
  assert.ok(lines[3].args.length <= 50);
  assert.ok(lines[3].args.every((a) => a.length <= 500));
});

test('no session gives the NO_SESSION answer', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-nosess-')));
  const e = { ...env, KSPROXY_STATE_DIR: dir };
  for (const [name, args] of [
    ['ssh_exec', { server: 'web1', command: 'uptime' }],
    ['kubectl', { cluster: 'lab', args: ['get', 'pods'] }],
  ]) {
    const r = await callTool(name, args, e);
    assert.equal(r.isError, true);
    assert.ok(r.text.includes('No active session'));
    assert.ok(r.text.includes('ksproxy start'));
  }
  const l = await callTool('list_targets', {}, e);
  assert.equal(l.isError, false);
  assert.ok(l.text.includes('No active session'));
});

test('a session with a dead pid is no session', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-dead-')));
  const { spawnSync } = await import('node:child_process');
  const pid = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  writeSession(path.join(dir, 'session'), { ...session, pid });
  const r = await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, { ...env, KSPROXY_STATE_DIR: dir });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('No active session'));
});

test('an unknown tool', async () => {
  const r = await callTool('nope', {}, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('unknown tool'));
});

test('callTool never throws on malformed input', async () => {
  for (const args of [undefined, null, 'x', 5, []]) {
    const r = await callTool('ssh_exec', args, env);
    assert.equal(r.isError, true);
  }
  const r = await callTool('list_targets', null, env);
  assert.equal(typeof r.text, 'string');
});

test('ssh_exec does not pass SSH_AUTH_SOCK to the child', async () => {
  const probe = path.join(base, 'probe-ssh.js');
  fs.writeFileSync(probe, "#!/usr/bin/env node\nconsole.log('AUTH=' + (process.env.SSH_AUTH_SOCK ?? 'unset'));\n", { mode: 0o755 });
  const r = await callTool(
    'ssh_exec',
    { server: 'web1', command: 'uptime' },
    { ...env, KSPROXY_SSH: probe, SSH_AUTH_SOCK: '/tmp/agent.sock' },
  );
  assert.equal(r.isError, false);
  assert.ok(r.text.includes('AUTH=unset'), r.text);
});

test('kubectl child gets a minimal environment with KUBERC off', async () => {
  const probe = path.join(base, 'env-kubectl.js');
  fs.writeFileSync(probe, [
    '#!/usr/bin/env node',
    "console.log('KEYS=' + JSON.stringify(Object.keys(process.env)));",
    "console.log('KUBERC=' + process.env.KUBERC);",
    "console.log('KUBECTL_KUBERC=' + process.env.KUBECTL_KUBERC);",
    '',
  ].join('\n'), { mode: 0o755 });
  const r = await callTool(
    'kubectl',
    { cluster: 'lab', args: ['get', 'pods'] },
    { ...env, KSPROXY_KUBECTL: probe, SHOULD_NOT_LEAK: '1' },
  );
  assert.ok(r.text.includes('KUBERC=off'), r.text);
  assert.ok(r.text.includes('KUBECTL_KUBERC=false'), r.text);
  assert.ok(!r.text.includes('SHOULD_NOT_LEAK'), r.text);
});

test('ssh child gets a minimal environment', async () => {
  const r = await callTool(
    'ssh_exec',
    { server: 'open1', command: 'env' },
    { ...env, SHOULD_NOT_LEAK: '1', SSH_AUTH_SOCK: '/tmp/agent.sock' },
  );
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('ENV='), r.text);
  assert.ok(!r.text.includes('SHOULD_NOT_LEAK'), r.text);
  assert.ok(!r.text.includes('SSH_AUTH_SOCK'), r.text);
});

test('kubectl sets KUBECONFIG to the session kubeconfig', async () => {
  const probe = path.join(base, 'probe-kubectl.js');
  fs.writeFileSync(probe, "#!/usr/bin/env node\nconsole.log('KC=' + process.env.KUBECONFIG);\n", { mode: 0o755 });
  const r = await callTool(
    'kubectl',
    { cluster: 'lab', args: ['get', 'pods'] },
    { ...env, KSPROXY_KUBECTL: probe, KUBECONFIG: '/home/user/real' },
  );
  assert.ok(r.text.includes('KC=<ksproxy>/session/kubeconfig'), r.text);
});

test('scrubOutput hides the state dir and every proxy port', () => {
  const sess = {
    targets: [
      { kind: 'kubernetes', name: 'a', proxyPort: 8001 },
      { kind: 'kubernetes', name: 'b', proxyPort: 8002 },
      { kind: 'ssh', name: 'c', socket: '/x' },
    ],
  };
  const e = { KSPROXY_STATE_DIR: '/tmp/ks-scrub' };
  const text = 'dial 127.0.0.1:8001 and localhost:8002 and 127.0.0.1:9999 in /tmp/ks-scrub/session/kubeconfig';
  assert.equal(
    scrubOutput(text, sess, e),
    'dial <proxy> and <proxy> and 127.0.0.1:9999 in <ksproxy>/session/kubeconfig',
  );
  assert.equal(scrubOutput('127.0.0.1:80011', sess, e), '127.0.0.1:80011');
});

test('scrubOutput also hides the realpath form of the state dir', () => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'ks-scrub-'));
  const real = fs.realpathSync(dir);
  const text = `a ${real}/session/x and ${dir}/session/y`;
  assert.equal(scrubOutput(text, { targets: [] }, { KSPROXY_STATE_DIR: dir }), 'a <ksproxy>/session/x and <ksproxy>/session/y');
});

test('ssh_exec output is scrubbed of the state dir', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: `cat ${base}/x` }, env);
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes(base), r.text);
  assert.ok(r.text.includes('<ksproxy>/x'), r.text);
});

test('a refused call is logged with event, kind and a short reason, and the agent still gets the long one', async () => {
  const before = auditLines().length;
  const ssh = await callTool('ssh_exec', { server: 'web1', command: 'id' }, env);
  assert.equal(ssh.text, 'REFUSED (ssh web1): not on the allowlist for this target. Allowed: uptime; cat *; fail; slow');
  const kube = await callTool('kubectl', { cluster: 'lab', args: ['get', 'secrets', '-A'] }, env);
  assert.equal(kube.text, 'REFUSED (kube lab): secret resources are never allowed');
  const [a, b] = auditLines().slice(before);
  assert.equal(a.event, 'call');
  assert.equal(a.kind, 'ssh');
  assert.equal(a.short, 'not on allowlist');
  assert.equal(a.reason, 'not on the allowlist for this target. Allowed: uptime; cat *; fail; slow');
  assert.equal(b.event, 'call');
  assert.equal(b.kind, 'kube');
  assert.equal(b.short, 'secret resource');
  assert.equal(b.reason, 'secret resources are never allowed');
});

test('invalid arguments and unknown targets get their own short reasons', async () => {
  const before = auditLines().length;
  await callTool('ssh_exec', { server: 5, command: 'uptime' }, env);
  await callTool('ssh_exec', { server: 'web1', command: 5 }, env);
  await callTool('kubectl', { cluster: 'lab', args: [] }, env);
  await callTool('ssh_exec', { server: 'web1', command: 'uptime', timeout_seconds: 0 }, env);
  await callTool('ssh_exec', { server: 'nope', command: 'uptime' }, env);
  await callTool('kubectl', { cluster: 'nope', args: ['get', 'pods'] }, env);
  assert.deepEqual(
    auditLines().slice(before).map((l) => l.short),
    ['invalid arguments', 'invalid arguments', 'invalid arguments', 'invalid arguments', 'unknown target', 'unknown target'],
  );
});

test('decideSsh and decideKube pass the short reason through', () => {
  const web = session.targets[0];
  const open = session.targets[1];
  const kube = session.targets[2];
  assert.equal(decideSsh(web, 5).short, 'invalid command');
  assert.equal(decideSsh(web, 'a'.repeat(5000)).short, 'command too long');
  assert.equal(decideSsh(web, '  ').short, 'empty command');
  assert.equal(decideSsh(web, 'uptime; id').short, 'character ";" not allowed');
  assert.equal(decideSsh(web, 'uptime \u202e').short, 'character U+202E not allowed');
  assert.equal(decideSsh(web, '-x').short, 'starts with "-"');
  assert.equal(decideSsh(open, 'ls\u0000').short, 'control character');
  assert.equal(decideSsh(open, '-x').short, 'starts with "-"');
  assert.equal(decideSsh(web, 'id').short, 'not on allowlist');
  assert.equal(decideSsh({ ...web, allow: [] }, 'id').short, 'allowlist is empty');
  assert.equal(decideKube(kube, ['get', 'secrets']).short, 'secret resource');
  assert.equal(decideKube(kube, ['delete', 'pod', 'x']).short, 'not on allowlist');
  assert.equal(decideKube({ ...kube, allow: [] }, ['get', 'pods']).short, 'allowlist is empty');
  assert.equal(decideKube(kube, ['exec', 'x']).short, 'verb "exec" unavailable');
  assert.equal(decideSsh(web, 'uptime').allowed, true);
});

test('an allowed call is logged with spawnError null, kind and sizes', async () => {
  const before = auditLines().length;
  await callTool('kubectl', { cluster: 'lab', args: ['get', 'pods'] }, env);
  const entry = auditLines().slice(before)[0];
  assert.equal(entry.event, 'call');
  assert.equal(entry.kind, 'kube');
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.spawnError, null);
  assert.equal(entry.rule, 'get ...');
});

test('a call whose program cannot start is logged with the spawn error', async () => {
  const before = auditLines().length;
  const r = await callTool(
    'ssh_exec',
    { server: 'web1', command: 'uptime' },
    { ...env, KSPROXY_SSH: path.join(base, 'does-not-exist') },
  );
  assert.equal(r.isError, true);
  const entry = auditLines().slice(before)[0];
  assert.equal(entry.decision, 'allowed');
  assert.equal(typeof entry.spawnError, 'string');
  assert.ok(entry.spawnError.length > 0);
});

test('list_targets with a live session appends a list entry', async () => {
  const before = allAuditLines().length;
  await callTool('list_targets', {}, env);
  const added = allAuditLines().slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].event, 'list');
  assert.equal(typeof added[0].ts, 'string');
});

test('list_targets without a session writes nothing', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-nolist-')));
  await callTool('list_targets', {}, { ...env, KSPROXY_STATE_DIR: dir });
  assert.ok(!fs.existsSync(path.join(dir, 'logs')));
});
