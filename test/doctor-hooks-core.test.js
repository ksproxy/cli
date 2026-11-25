import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import sshKind from '../src/kinds/ssh/index.js';
import kubeKind from '../src/kinds/kubernetes/index.js';
import localKind from '../src/kinds/local/index.js';
import commandKind from '../src/kinds/command/index.js';
import httpKind from '../src/kinds/http/index.js';
import { codeOf, hostAnswers } from '../src/kinds/http/reach.js';
import { closeMaster } from '../src/kinds/ssh/master.js';
import { closeCluster } from '../src/kinds/kubernetes/cluster.js';
import { selfSigned } from './fixtures/self-signed.js';
import { tempDir } from './temp.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fakeSsh = path.join(fixtures, 'fake-ssh.js');
const fakeKubectl = path.join(fixtures, 'fake-kubectl.js');
const fakeClient = path.join(fixtures, 'fake-client.js');
const SECRET = 'doctor-S3CR3T-77c1f0-unmistakable';
const SECRETS = { DOCTOR_TEST_VALUE: SECRET };

const servers = [];
const sockets = new Set();
after(async () => {
  for (const socket of sockets) socket.destroy();
  for (const server of servers) {
    await new Promise((resolve) => { server.close(resolve); });
  }
});

const base = fs.realpathSync(tempDir('ks-dochk-'));
const state = path.join(base, 'st');
const config = path.join(base, 'cfg');
fs.mkdirSync(state);
fs.mkdirSync(config);
const baseEnv = {
  ...process.env, KSPROXY_STATE_DIR: state, KSPROXY_CONFIG_DIR: config, KSPROXY_SSH: fakeSsh, KSPROXY_KUBECTL: fakeKubectl,
};
const ctx = (extra = {}) => ({
  env: baseEnv, secrets: SECRETS, timeoutMs: 30000, signal: undefined, ...extra,
});

// A detail is short, plain, and holds no secret.
function plain(result) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.detail, 'string');
  assert.ok(result.detail.length > 0 && result.detail.length <= 300);
  assert.equal(/[\u0000-\u001f\u007f]/.test(result.detail), false);
  assert.equal(result.detail.includes(SECRET), false);
  return result;
}

function listen(server, host = '127.0.0.1') {
  servers.push(server);
  server.on('connection', (socket) => sockets.add(socket));
  return new Promise((resolve) => { server.listen(0, host, () => resolve(server.address().port)); });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ssh

test('ssh doctor: the connection that open made is alive', async () => {
  const socket = path.join(base, 'ssh-web1');
  const target = { kind: 'ssh', name: 'web1', host: 'web1.example.com' };
  const r = await sshKind.open(target, { env: baseEnv, prepared: socket });
  assert.equal(r.ok, true);
  const opened = { kind: 'ssh', target, ...r.extras };
  try {
    assert.deepEqual(plain(await sshKind.doctor(opened, ctx())), { ok: true, detail: 'connected' });
  } finally {
    await closeMaster({ socket, host: target.host }, baseEnv);
  }
  assert.deepEqual(plain(await sshKind.doctor(opened, ctx())), { ok: false, detail: 'the connection is gone' });
});

test('ssh doctor: the ssh program is missing', async () => {
  const opened = { kind: 'ssh', target: { name: 'web1', host: 'web1.example.com' }, socket: path.join(base, 'ssh-none') };
  const r = await sshKind.doctor(opened, ctx({ env: { ...baseEnv, KSPROXY_SSH: path.join(base, 'no-such-ssh') } }));
  assert.deepEqual(plain(r), { ok: false, detail: 'the connection is gone' });
});

// kubernetes

async function proxyStub(status, body) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  const port = await listen(server);
  return { port, requests };
}
const kubeOpened = (proxyPort) => ({ kind: 'kubernetes', target: { name: 'lab', proxyPort }, handle: {} });

test('kubernetes doctor: GET /version through the proxy that open started', async () => {
  const dir = fs.realpathSync(tempDir('ks-dochk-k-'));
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const proxyPort = await freePort();
  const target = {
    kind: 'kubernetes', name: 'lab', kubeconfig, proxyPort, tunnel: null,
  };
  const r = await kubeKind.open(target, { sessionDir: dir, env: baseEnv });
  assert.equal(r.ok, true);
  try {
    // The stand-in proxy answers /version as a cluster does.
    assert.deepEqual(plain(await kubeKind.doctor({ kind: 'kubernetes', target, ...r.extras }, ctx())), {
      ok: true, detail: 'server v1.31.2',
    });
  } finally {
    await closeCluster(r.extras.handle, baseEnv);
  }
});

test('kubernetes doctor: the server version, and only a GET of /version', async () => {
  const stub = await proxyStub(200, JSON.stringify({ major: '1', gitVersion: 'v1.30.2' }));
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(stub.port), ctx())), { ok: true, detail: 'server v1.30.2' });
  assert.deepEqual(stub.requests, ['GET /version']);
});

test('kubernetes doctor: a version with control characters is cleaned and cut', async () => {
  const stub = await proxyStub(200, JSON.stringify({ gitVersion: `v1\n\u001b[31m${'x'.repeat(200)}` }));
  const r = plain(await kubeKind.doctor(kubeOpened(stub.port), ctx()));
  assert.equal(r.ok, true);
  assert.ok(r.detail.startsWith('server v1 [31mxxx'));
  assert.ok(r.detail.length <= 'server '.length + 64);
});

test('kubernetes doctor: the proxy is not answering', async () => {
  const port = await freePort();
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(port), ctx())), { ok: false, detail: 'the proxy is not answering' });
});

test('kubernetes doctor: the cluster rejects the credential, or answers another status', async () => {
  for (const status of [401, 403]) {
    const stub = await proxyStub(status, 'no');
    assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(stub.port), ctx())), {
      ok: false, detail: `the cluster rejected the credential (HTTP ${status})`,
    });
  }
  const stub = await proxyStub(502, 'bad gateway');
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(stub.port), ctx())), { ok: false, detail: 'the cluster answered HTTP 502' });
});

test('kubernetes doctor: an answer that is not JSON, has no version or is too long', async () => {
  for (const body of ['not json', '{}', '{"gitVersion":""}', '{"gitVersion":5}']) {
    const stub = await proxyStub(200, body);
    assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(stub.port), ctx())), {
      ok: false, detail: 'the cluster gave an answer that is not a version',
    });
  }
  const stub = await proxyStub(200, 'x'.repeat(70000));
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(stub.port), ctx())), {
    ok: false, detail: 'the cluster gave an answer that is too long',
  });
});

test('kubernetes doctor: time runs out while the proxy is silent or stops mid-answer, and Ctrl-C stops it', async () => {
  const silent = http.createServer(() => {});
  const silentPort = await listen(silent);
  const slow = http.createServer((req, res) => {
    res.writeHead(200);
    res.write('{"gitVersion"');
  });
  const slowPort = await listen(slow);
  const late = { ok: false, detail: 'no answer in time, or the check was stopped' };
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(silentPort), ctx({ timeoutMs: 200 }))), late);
  assert.deepEqual(plain(await kubeKind.doctor(kubeOpened(slowPort), ctx({ timeoutMs: 200 }))), late);
  const controller = new AbortController();
  const pending = kubeKind.doctor(kubeOpened(silentPort), ctx({ signal: controller.signal }));
  controller.abort();
  assert.deepEqual(plain(await pending), late);
});

// local

const localOpened = (cwd) => ({ kind: 'local', target: { kind: 'local', name: 'work', cwd, allow: [] } });

test('local doctor: the folder checks pass, and fail when the folder goes or is refused', async () => {
  const dir = path.join(base, 'work');
  fs.mkdirSync(dir);
  assert.deepEqual(plain(await localKind.doctor(localOpened(dir), ctx())), { ok: true, detail: 'folder checks passed' });
  fs.rmSync(dir, { recursive: true });
  assert.deepEqual(plain(await localKind.doctor(localOpened(dir), ctx())), { ok: false, detail: `folder not found: ${dir}` });
  const file = path.join(base, 'afile');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(plain(await localKind.doctor(localOpened(file), ctx())), { ok: false, detail: `not a directory: ${file}` });
  assert.deepEqual(plain(await localKind.doctor(localOpened(os.homedir()), ctx())), {
    ok: false, detail: `folder is too broad: pick a project folder, not ${os.homedir()}`,
  });
  assert.deepEqual(plain(await localKind.doctor(localOpened(state), ctx())), { ok: false, detail: "folder overlaps ksproxy's own files" });
});

test('local doctor: a control character in a problem is cleaned', async () => {
  const odd = path.join(base, 'gone\u001b[0m');
  const r = plain(await localKind.doctor(localOpened(odd), ctx()));
  assert.deepEqual(r, { ok: false, detail: `folder not found: ${path.join(base, 'gone [0m')}` });
});

// command

const commandOpened = (program) => ({
  kind: 'command',
  target: { kind: 'command', name: 'rep', program, args: [], env: { REPORT_VALUE: 'DOCTOR_TEST_VALUE' } },
  program,
});

test('command doctor: the program is found by name on the PATH, or by path; nothing runs', async () => {
  const env = { ...baseEnv, PATH: `${fixtures}:/usr/bin` };
  assert.deepEqual(plain(await commandKind.doctor(commandOpened('fake-client.js'), ctx({ env }))), { ok: true, detail: 'program found' });
  assert.deepEqual(plain(await commandKind.doctor(commandOpened(fakeClient), ctx({ env }))), { ok: true, detail: 'program found' });
});

test('command doctor: the program is missing, not executable or inside ksproxy folders', async () => {
  const env = { ...baseEnv, PATH: '/usr/bin' };
  assert.deepEqual(plain(await commandKind.doctor(commandOpened('no-such-program-ks'), ctx({ env }))), {
    ok: false, detail: 'program no-such-program-ks was not found on PATH',
  });
  const plainFile = path.join(base, 'plain');
  fs.writeFileSync(plainFile, 'x', { mode: 0o644 });
  assert.deepEqual(plain(await commandKind.doctor(commandOpened(plainFile), ctx({ env }))), {
    ok: false, detail: `program ${plainFile} is not an executable file`,
  });
  const own = path.join(state, 'tool');
  fs.writeFileSync(own, '#!/bin/sh\n', { mode: 0o755 });
  const r = plain(await commandKind.doctor(commandOpened(own), ctx({ env })));
  assert.deepEqual(r, { ok: false, detail: `program ${own} is inside ksproxy's own folders` });
});

// http

const httpOpened = (baseUrl) => ({ kind: 'http', target: { kind: 'http', name: 'grafana', baseUrl, auth: { bearerEnv: 'DOCTOR_TEST_VALUE' } } });

test('http doctor: a host that answers on its port, and no request is sent', async () => {
  let bytes = 0;
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => { bytes += chunk.length; });
  });
  const port = await listen(server);
  assert.deepEqual(plain(await httpKind.doctor(httpOpened(`http://127.0.0.1:${port}/api/`), ctx())), { ok: true, detail: 'host answers' });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  assert.equal(bytes, 0);
});

test('http doctor: an IPv6 host', async () => {
  const server = net.createServer();
  const port = await listen(server, '::1');
  assert.deepEqual(plain(await hostAnswers(new URL(`http://[::1]:${port}/`))), { ok: true, detail: 'host answers' });
});

test('http doctor: the host is down', async () => {
  const port = await freePort();
  assert.deepEqual(plain(await httpKind.doctor(httpOpened(`http://127.0.0.1:${port}/`), ctx())), {
    ok: false, detail: `the host did not answer on port ${port} (ECONNREFUSED)`,
  });
});

test('http doctor: a name that does not resolve has a code in its detail', async () => {
  const r = plain(await httpKind.doctor(httpOpened('http://no-such-host.invalid/'), ctx()));
  assert.equal(r.ok, false);
  assert.match(r.detail, /^the host did not answer on port 80 \([A-Z0-9_]+\)$/);
  const secure = plain(await hostAnswers(new URL('https://no-such-host.invalid/'), { timeoutMs: 20000 }));
  assert.match(secure.detail, /^the host did not answer on port 443 \([A-Z0-9_]+\)$/);
});

test('http doctor: no answer in time, and Ctrl-C', async () => {
  const noAnswer = { ok: false };
  // A listener whose backlog is full never completes the handshake; a stand-in for it is a server that takes the
  // connection and, for https, never answers the handshake.
  const quiet = net.createServer(() => {});
  const port = await listen(quiet);
  const timed = await hostAnswers(new URL(`https://127.0.0.1:${port}/`), { timeoutMs: 200 });
  assert.deepEqual(plain(timed), { ...noAnswer, detail: `no answer on port ${port} in time, or the check was stopped` });
  const controller = new AbortController();
  controller.abort();
  const stopped = await httpKind.doctor(httpOpened(`https://127.0.0.1:${port}/`), ctx({ signal: controller.signal }));
  assert.deepEqual(plain(stopped), { ...noAnswer, detail: `no answer on port ${port} in time, or the check was stopped` });
  const later = new AbortController();
  const pending = hostAnswers(new URL(`https://127.0.0.1:${port}/`), { signal: later.signal });
  later.abort();
  assert.equal((await pending).ok, false);
});

test('http doctor: https passes when the handshake works', async () => {
  const { cert, key } = selfSigned('localhost');
  const server = tls.createServer({ cert, key }, (socket) => { socket.on('error', () => {}); });
  const port = await listen(server);
  assert.deepEqual(plain(await hostAnswers(new URL(`https://localhost:${port}/`), {}, { ca: cert })), { ok: true, detail: 'host answers' });
  // An address has no server name to send.
  assert.deepEqual(plain(await hostAnswers(new URL(`https://127.0.0.1:${port}/`), {}, { ca: cert, checkServerIdentity: () => undefined })), {
    ok: true, detail: 'host answers',
  });
});

test('http doctor: the TLS handshake fails for an untrusted certificate, a wrong name and a plain-text server', async () => {
  const { cert, key } = selfSigned('localhost');
  const server = tls.createServer({ cert, key }, (socket) => { socket.on('error', () => {}); });
  const port = await listen(server);
  const untrusted = plain(await httpKind.doctor(httpOpened(`https://localhost:${port}/`), ctx()));
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, new RegExp(`^the TLS handshake with port ${port} failed \\([A-Z_]+\\)$`));
  const wrongName = plain(await hostAnswers(new URL(`https://127.0.0.1:${port}/`), {}, { ca: cert }));
  assert.equal(wrongName.ok, false);
  assert.match(wrongName.detail, /^the TLS handshake with port \d+ failed \(ERR_TLS_CERT_ALTNAME_INVALID\)$/);
  const text = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  const textPort = await listen(text);
  const plainServer = plain(await httpKind.doctor(httpOpened(`https://127.0.0.1:${textPort}/`), ctx()));
  assert.equal(plainServer.ok, false);
  assert.match(plainServer.detail, new RegExp(`^the TLS handshake with port ${textPort} failed \\(`));
});

test('codeOf shows a code of capital letters, digits and _, and else says error', () => {
  assert.equal(codeOf({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  for (const odd of [undefined, {}, { code: 5 }, { code: 'has a space' }, { code: 'lower' }, { code: `X${'A'.repeat(70)}` }]) {
    assert.equal(codeOf(odd), 'error');
  }
});
