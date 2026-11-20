import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  callTool, decideKube, decideSsh, scrubOutput, targetState,
} from '../src/tools.js';
import { writeSession } from '../src/session.js';

const flood = fileURLToPath(new URL('./fixtures/fake-ssh-flood.js', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));

let base;
let sessionDir;
let env;

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-tlx-')));
  sessionDir = path.join(base, 'session');
  fs.mkdirSync(path.join(base, 's'));
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-web1'), '');
  env = { ...process.env, KSPROXY_STATE_DIR: base, KSPROXY_SSH: fakeSsh };
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [{
      kind: 'ssh',
      name: 'web1',
      description: 'web box',
      allow: ['uptime', 'big'],
      host: 'web1.example.com',
      socket: path.join(base, 's', 'ssh-web1'),
      state: 'up',
    }],
  });
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function auditEntries() {
  const file = path.join(sessionDir, 'audit.log');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('targetState reports a Kubernetes target as down when its proxy port is closed', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await targetState({ kind: 'kubernetes', proxyPort: port, state: 'auth' }), 'auth');
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await targetState({ kind: 'kubernetes', proxyPort: port, state: 'up' }), 'down');
});

test('decideSsh refuses a command that is not a string, and lets other failures through', () => {
  const target = { allow: ['uptime'] };
  assert.deepEqual(decideSsh(target, 123), {
    allowed: false, reason: 'command must be a string', short: 'invalid command',
  });
  assert.throws(() => decideSsh(null, 'uptime'), TypeError);
});

test('decideKube works for a target without manifestRoots', () => {
  const decision = decideKube({ allow: ['get ...'] }, ['get', 'pods']);
  assert.equal(decision.allowed, true);
  assert.equal(decideKube({ allow: ['get ...'] }, ['apply', '-f', '/tmp/x.yaml']).allowed, false);
});

test('scrubOutput works for a session that has no target list', () => {
  const out = scrubOutput(`seen ${base}/s/ssh-web1`, {}, { KSPROXY_STATE_DIR: base });
  assert.equal(out, 'seen <ksproxy>/s/ssh-web1');
});

test('output over the size limit is cut and flagged as truncated', async () => {
  const r = await callTool('ssh_exec', { server: 'web1', command: 'big' }, { ...env, KSPROXY_SSH: flood });
  assert.equal(r.isError, false);
  assert.ok(r.text.startsWith('exit code: 0\n--- stdout ---\n'));
  assert.ok(r.text.endsWith('[output truncated at 262144 bytes per stream]'));
  const entry = auditEntries().filter((e) => e.event === 'call').at(-1);
  assert.equal(entry.stdoutBytes, 300001);
});

test('a target name that cannot be printed is refused and logged as unprintable', async () => {
  const server = { toString() { throw new Error('no string form'); } };
  const r = await callTool('ssh_exec', { server, command: 'uptime' }, env);
  assert.deepEqual(r, { text: 'invalid arguments: server must be a string', isError: true });
  const entry = auditEntries().at(-1);
  assert.equal(entry.target, '(unprintable)');
  assert.equal(entry.decision, 'refused');
});

test('an unknown cluster says that no clusters are open when there are none', async () => {
  const r = await callTool('kubectl', { cluster: 'lab', args: ['get', 'pods'] }, env);
  assert.equal(r.isError, true);
  assert.equal(r.text, 'unknown cluster "lab". Open targets: none');
});

test('an internal failure is reported as an internal error', async () => {
  const broken = await callTool('list_targets', {}, null);
  assert.equal(broken.isError, true);
  assert.match(broken.text, /^internal error: /);

  const args = { get server() { throw 'plain failure'; } };
  const thrown = await callTool('ssh_exec', args, env);
  assert.deepEqual(thrown, { text: 'internal error: plain failure', isError: true });
});

test('a log that cannot be written is reported on stderr and the call still succeeds', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-tlx2-')));
  try {
    const session = path.join(dir, 'session');
    fs.mkdirSync(session);
    fs.mkdirSync(path.join(session, 'audit.log'));
    writeSession(session, {
      version: 1, pid: process.pid, startedAt: 'x', targets: [],
    });
    const messages = [];
    const stderr = { write: (text) => { messages.push(text); } };
    const r = await callTool('list_targets', {}, { ...process.env, KSPROXY_STATE_DIR: dir }, { stderr });
    assert.equal(r.isError, false);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^ksproxy: could not write audit log: .*EISDIR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('targetState reports an ssh target as down when its control socket is gone, and up when it is there', async () => {
  const target = {
    kind: 'ssh', host: 'web1.example.com', socket: path.join(base, 's', 'ssh-web1'), state: 'up',
  };
  assert.equal(await targetState(target, env), 'up');
  assert.equal(await targetState({ ...target, socket: path.join(base, 's', 'missing') }, env), 'down');
});
