import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleMessage, SERVER_INFO } from '../src/mcp.js';
import { mcpConfig } from '../src/agent-md.js';
import { writeSession } from '../src/session.js';

const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));
const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));
const bin = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));

function emptyEnv() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-mcp-')));
  return { ...process.env, KSPROXY_STATE_DIR: dir, KSPROXY_SSH: fakeSsh, KSPROXY_KUBECTL: fakeKubectl };
}

test('SERVER_INFO', () => {
  assert.equal(SERVER_INFO.name, 'ksproxy');
  assert.equal(SERVER_INFO.version, '0.3.0');
});

test('initialize echoes a known protocol version', async () => {
  const r = await handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' },
  }, emptyEnv());
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'ksproxy');
  assert.ok(r.result.instructions.startsWith('Run commands on the ssh servers, Kubernetes clusters, local folders and service targets (databases, queues and HTTP APIs) the user has opened. '));
});

test('initialize falls back for an unknown protocol version', async () => {
  const r = await handleMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' },
  }, emptyEnv());
  assert.equal(r.result.protocolVersion, '2025-06-18');
  const none = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize' }, emptyEnv());
  assert.equal(none.result.protocolVersion, '2025-06-18');
});

test('ping', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }, emptyEnv());
  assert.deepEqual(r.result, {});
});

test('tools/list', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, emptyEnv());
  assert.deepEqual(r.result.tools.map((t) => t.name), ['list_targets', 'ssh_exec', 'kubectl', 'local_exec']);
  for (const t of r.result.tools) assert.equal(t.inputSchema.type, 'object');
});

test('a notification gets no response', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, emptyEnv()), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'whatever' }, emptyEnv()), null);
});

test('an unknown method', async () => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'nope' }, emptyEnv());
  assert.equal(r.id, 7);
  assert.equal(r.error.code, -32601);
});

test('an invalid request', async () => {
  const r = await handleMessage({ id: 1, method: 'ping' }, emptyEnv());
  assert.equal(r.error.code, -32600);
  assert.equal(r.id, 1);
  for (const bad of [null, 5, 'x', [], { jsonrpc: '2.0', id: 3 }, { jsonrpc: '2.0', id: 3, method: 5 }]) {
    const e = await handleMessage(bad, emptyEnv());
    assert.equal(e.error.code, -32600, JSON.stringify(bad));
  }
});

test('tools/call with bad params', async () => {
  for (const params of [{}, undefined, { name: 5 }, { name: 'list_targets', arguments: 'x' }, { name: 'list_targets', arguments: null }]) {
    const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, emptyEnv());
    assert.equal(r.error.code, -32602, JSON.stringify(params));
  }
});

test('tools/call list_targets with no session is not an error', async () => {
  const r = await handleMessage({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_targets' },
  }, emptyEnv());
  assert.equal(r.result.content[0].type, 'text');
  assert.equal(r.result.isError, false);
});

function sessionEnv() {
  const env = emptyEnv();
  const base = env.KSPROXY_STATE_DIR;
  const sessionDir = path.join(base, 'session');
  fs.mkdirSync(path.join(base, 's'));
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'ssh_config'), '');
  fs.writeFileSync(path.join(base, 's', 'ssh-web1'), '');
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [{
      kind: 'ssh', name: 'web1', description: '', allow: ['uptime'], host: 'web1.example.com',
      socket: path.join(base, 's', 'ssh-web1'), state: 'up',
    }],
  });
  return env;
}

test('the stdio server answers in order and writes only JSON', async () => {
  const env = sessionEnv();
  const child = spawn(process.execPath, [bin, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const exit = new Promise((resolve) => child.on('close', resolve));
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      '{this is not json',
      JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssh_exec', arguments: { server: 'web1', command: 'uptime' } },
      }),
    ];
    child.stdin.end(`${lines.join('\n')}\n`);
    let watchdog;
    const code = await Promise.race([
      exit,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('server did not exit')), 15000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    assert.equal(code, 0);
    const out = stdout.split('\n').filter(Boolean);
    assert.equal(out.length, 4);
    const parsed = out.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((m) => m.id), [1, 2, null, 3]);
    assert.equal(parsed[2].error.code, -32700);
    assert.equal(parsed[3].result.isError, false);
    assert.ok(parsed[3].result.content[0].text.includes('ran web1 uptime'));
  } finally {
    child.kill('SIGKILL');
  }
});

test('SIGUSR1 does not open the inspector of the stdio server, and it keeps serving', async () => {
  const child = spawn(process.execPath, [bin, 'mcp'], { env: emptyEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const exit = new Promise((resolve) => child.on('close', resolve));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    for (let i = 0; i < 300 && stdout === ''; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill('SIGUSR1');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.ok(!/Debugger listening/.test(stderr), stderr);
    assert.equal(child.exitCode, null);
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    assert.equal(await exit, 0);
    assert.deepEqual(stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).id), [1, 2]);
  } finally {
    child.kill('SIGKILL');
  }
});

// Signals SIGUSR1 delay ms after spawn and says whether the inspector opened. The process may die of the signal
// when it comes before the listener is in place: that is fine, as long as no inspector opens.
async function inspectorOpens(command, args, delay) {
  const child = spawn(command, args, { env: emptyEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => { child.on('close', resolve); });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  await new Promise((resolve) => setTimeout(resolve, delay));
  child.kill('SIGUSR1');
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill('SIGKILL');
  await closed;
  return /Debugger listening/.test(stderr);
}

test('SIGUSR1 in the first milliseconds never opens the inspector, by the shebang or as the MCP config runs it', async () => {
  const config = mcpConfig(process.execPath, bin).mcpServers.ksproxy;
  for (const delay of [5, 15, 20, 25, 30, 35, 40, 50, 60]) {
    const opened = await Promise.all([
      inspectorOpens(bin, ['mcp'], delay),
      inspectorOpens(bin, ['mcp'], delay),
      inspectorOpens(config.command, config.args, delay),
      inspectorOpens(config.command, config.args, delay),
    ]);
    assert.deepEqual(opened, [false, false, false, false], `${delay} ms after spawn`);
  }
});

test('a client response gets no reply', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 1, result: {} }, emptyEnv()), null);
  assert.equal(
    await handleMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }, emptyEnv()),
    null,
  );
});

test('an id that is not a string or a finite number is an invalid request', async () => {
  for (const id of [{}, null, [], true, Number.POSITIVE_INFINITY]) {
    const r = await handleMessage({ jsonrpc: '2.0', id, method: 'ping' }, emptyEnv());
    assert.equal(r.error.code, -32600, JSON.stringify(id));
    assert.equal(r.id, null);
  }
  const ok = await handleMessage({ jsonrpc: '2.0', id: 'abc', method: 'ping' }, emptyEnv());
  assert.equal(ok.id, 'abc');
  const zero = await handleMessage({ jsonrpc: '2.0', id: 0, method: 'ping' }, emptyEnv());
  assert.deepEqual(zero.result, {});
});
