import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REJECT_PATHS, kubeconfigText, proxyArgs, kubectlArgs, hardRefusal, hardRefusalDetail,
  portListening, probeVersion, openCluster, closeCluster,
} from '../src/kinds/kubernetes/cluster.js';
import { tempDir } from './temp.js';

const fakeKubectl = fileURLToPath(new URL('./fixtures/fake-kubectl.js', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fixtures/fake-ssh.js', import.meta.url));

function tmp() {
  return fs.realpathSync(tempDir('ks-kube-'));
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

async function eventually(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function manifestFixture() {
  const base = tmp();
  const root = path.join(base, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'app.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(base, 'outside.yaml'), 'b: 2\n');
  fs.symlinkSync(path.join(base, 'outside.yaml'), path.join(root, 'link.yaml'));
  return { base, root };
}

test('REJECT_PATHS is the exact spec string', () => {
  assert.equal(
    REJECT_PATHS,
    '^/api/.*/pods/.*/exec,^/api/.*/pods/.*/attach,^/api/.*/pods/.*/portforward,^/api/.*/secrets,^/api/.*/serviceaccounts/.*/token',
  );
});

test('hardRefusal returns null for ordinary read commands', () => {
  const allowed = [
    ['get', 'pods', '-A'],
    ['get', 'pods', '-n', 'web', '-o', 'json'],
    ['logs', '-f', 'api-1', '-n', 'web'],
    ['logs', '--tail=-1', 'api-1'],
    ['get', 'externalsecrets', '-n', 'web'],
    ['describe', 'pod', 'secretary-1'],
    ['get', 'pods', '-l', 'app=web,tier!=db'],
    ['get', 'pods', '-o', 'jsonpath={.items[*].metadata.name}'],
    ['rollout', 'status', 'deploy/api', '-n', 'web'],
  ];
  for (const args of allowed) {
    assert.equal(hardRefusal(args, []), null, JSON.stringify(args));
  }
});

test('hardRefusal returns null for manifests inside a root', () => {
  const { root } = manifestFixture();
  const file = path.join(root, 'app.yaml');
  assert.equal(hardRefusal(['apply', '-f', file], [root]), null);
  assert.equal(hardRefusal(['apply', `--filename=${file}`], [root]), null);
});

test('hardRefusal v3 narrows the manifest surface to single regular files', () => {
  const { base, root } = manifestFixture();
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'a.yaml'), 'c: 3\n');
  fs.symlinkSync(path.join(base, 'outside.yaml'), path.join(root, 'sub', 'leak.yaml'));
  const table = [
    [['apply', '-k', root], '-k'],
    [['apply', '--kustomize', root], '--kustomize'],
    [['diff', '-k', root], '-k'],
    [['apply', '-f', root], 'single file'],
    [['get', '-f', path.join(root, 'sub')], 'single file'],
    [['apply', '-R', '-f', path.join(root, 'sub')], 'single file'],
    [['apply', '-f', path.join(root, 'sub', 'leak.yaml')], 'outside'],
    [['apply', 'edit-last-applied', 'deploy/x'], 'edit-last-applied'],
  ];
  for (const [args, substring] of table) {
    const reason = hardRefusal(args, [root]);
    assert.equal(typeof reason, 'string', `expected a refusal for ${JSON.stringify(args)}`);
    assert.ok(reason.includes(substring), `${JSON.stringify(args)} -> "${reason}" should contain "${substring}"`);
  }
  assert.equal(hardRefusal(['apply', '-f', path.join(root, 'sub', 'a.yaml')], [root]), null);
  assert.equal(hardRefusal(['apply', '-f', path.join(root, 'app.yaml')], [root]), null);
  assert.equal(hardRefusal(['apply', 'view-last-applied', 'deploy/x'], [root]), null);
});

test('hardRefusal refuses what the spec forbids', () => {
  const { base, root } = manifestFixture();
  const table = [
    [[], [], 'non-empty'],
    [['get', 'a\nb'], [], 'single-line'],
    [['-n', 'web', 'exec', 'pod'], [], 'verb first'],
    [['get', 'pods', '-ojson'], [], 'separately'],
    [['get', 'pods', '-As', 'http://x'], [], 'separately'],
    [['get', 'pods', '--kubeconfig', '/x'], [], '--kubeconfig'],
    [['get', 'pods', '--kubeconfig=/x'], [], '--kubeconfig'],
    [['get', 'pods', '--context', 'admin'], [], '--context'],
    [['get', 'pods', '-s', 'http://x'], [], '-s'],
    [['get', 'pods', '-s=http://x'], [], '-s'],
    [['get', 'pods', '--server=http://x'], [], '--server'],
    [['get', 'pods', '--token', 't'], [], '--token'],
    [['get', 'pods', '--as', 'admin'], [], '--as'],
    [['get', 'pods', '--as-group=system:masters'], [], '--as-group'],
    [['get', '--raw', '/api/v1/secrets'], [], '--raw'],
    [['exec', 'pod', '--', 'sh'], [], 'exec'],
    [['attach', 'pod'], [], 'attach'],
    [['cp', 'a', 'b'], [], 'cp'],
    [['port-forward', 'svc/x', '8080'], [], 'port-forward'],
    [['proxy'], [], 'proxy'],
    [['debug', 'pod'], [], 'debug'],
    [['config', 'view'], [], 'config'],
    [['edit', 'deploy/x'], [], 'edit'],
    [['get', 'secret'], [], 'secret'],
    [['get', 'secrets', '-A'], [], 'secret'],
    [['get', 'Secrets'], [], 'secret'],
    [['get', 'pods,secrets'], [], 'secret'],
    [['get', 'secret/db', '-o', 'yaml'], [], 'secret'],
    [['get', 'secrets.v1.', '-A'], [], 'secret'],
    [['get', '--resource=secrets'], [], 'secret'],
    [['create', 'configmap', 'x', '--from-file=/etc/hosts'], [], '--from-file'],
    [['create', 'configmap', 'x', '--from-env-file', '/x'], [], '--from-env-file'],
    [['apply', '-f', 'https://example.com/x.yaml'], [root], 'local path'],
    [['apply', '-f', '-'], [root], 'local path'],
    [['apply', '-f'], [root], 'needs a path'],
    [['apply', '-f', '/etc/hosts'], [], 'no manifestRoots'],
    [['apply', '-f', '/etc/hosts'], [root], 'outside'],
    [['apply', '-f', `${root}/../outside.yaml`], [root], 'outside'],
    [['apply', '-f', path.join(root, 'link.yaml')], [root], 'outside'],
    [['apply', '-f', path.join(root, 'missing.yaml')], [root], 'does not exist'],
    [['patch', 'deploy/x', '--patch-file', '/etc/hosts'], [root], 'outside'],
  ];
  assert.ok(fs.existsSync(path.join(base, 'outside.yaml')));
  for (const [args, roots, substring] of table) {
    const reason = hardRefusal(args, roots);
    assert.equal(typeof reason, 'string', `expected a refusal for ${JSON.stringify(args)}`);
    assert.ok(reason.includes(substring), `${JSON.stringify(args)} -> "${reason}" should contain "${substring}"`);
  }
});

test('hardRefusal v2 refuses every row of the allowlist table', () => {
  const table = [
    [['get', 'ns', 'default', '-o', 'go-template-file=/etc/hosts'], 'output format'],
    [['get', 'ns', '-o=go-template-file=/etc/hosts'], 'output format'],
    [['get', 'ns', '--output=jsonpath-file=/etc/hosts'], 'output format'],
    [['get', 'ns', '-o', 'custom-columns-file=/etc/hosts'], 'output format'],
    [['get', 'ns', '-o', 'go-template', '--template=/etc/hosts'], 'output format'],
    [['get', 'ns', '--template=/etc/hosts'], '--template'],
    [['get', 'ns', '-o'], 'output format'],
    [['create', 'configmap', 'x', '--from_file=/etc/hosts'], '--from-file'],
    [['create', 'configmap', 'x', '--from_env_file', '/x'], '--from-env-file'],
    [['patch', 'deploy/x', '--patch_file', '/etc/hosts'], 'no manifestRoots'],
    [['get', 'pods', '--profile=cpu', '--profile-output=/tmp/x'], '--profile'],
    [['get', 'pods', '--cache-dir=/tmp/x'], '--cache-dir'],
    [['get', 'pods', '--kuberc=/tmp/x'], '--kuberc'],
    [['get', 'pods', '--as_group=system:masters'], '--as-group'],
    [['get', 'pods', '-v=9'], '-v'],
    [['kustomize', '/etc'], 'kustomize'],
    [['whoami'], 'whoami'],
    [['completion', 'bash'], 'completion'],
    [['run', 'x', '--image=busybox'], 'run'],
    [['create', 'token', 'default', '-n', 'kube-system'], 'create token'],
    [['create', '-n', 'kube-system', 'token', 'default'], 'create token'],
    [['cluster-info', 'dump'], 'dump'],
    [['auth', 'reconcile', '-f', '/x'], 'auth can-i'],
    [['get', 'pods', '--', '-o', 'yaml'], 'bare'],
    [['get', 'secrets '], 'secret'],
    [['get', 'pods', '\u001b[2K'], 'control characters'],
    [['get', ''], 'non-empty'],
  ];
  for (const [args, substring] of table) {
    const reason = hardRefusal(args, []);
    assert.equal(typeof reason, 'string', `expected a refusal for ${JSON.stringify(args)}`);
    assert.ok(reason.includes(substring), `${JSON.stringify(args)} -> "${reason}" should contain "${substring}"`);
  }
});

test('hardRefusal v2 allows the listed commands', () => {
  const allowed = [
    ['get', 'pods', '-o', 'yaml'],
    ['get', 'pods', '-o=name'],
    ['get', 'pods', '--output', 'custom-columns=NAME:.metadata.name'],
    ['auth', 'can-i', 'get', 'pods'],
    ['cluster-info'],
    ['create', 'configmap', 'x', '--from-literal=a=b'],
    ['rollout', 'restart', 'deploy/api', '-n', 'web'],
    ['top', 'pods', '--containers'],
    ['logs', 'api-1', '--all_containers'],
  ];
  for (const args of allowed) {
    assert.equal(hardRefusal(args, []), null, JSON.stringify(args));
  }
});

test('hardRefusal treats a filesystem-root manifest root as containing everything', () => {
  const { root } = manifestFixture();
  assert.equal(hardRefusal(['apply', '-f', path.join(root, 'app.yaml')], ['/']), null);
});

test('kubeconfigText has the exact credential-free shape', () => {
  const expected = [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '- name: lab',
    '  cluster:',
    '    server: http://127.0.0.1:8001',
    'users:',
    '- name: none',
    '  user: {}',
    'contexts:',
    '- name: lab',
    '  context:',
    '    cluster: lab',
    '    user: none',
    '',
  ].join('\n');
  const text = kubeconfigText([{ name: 'lab', proxyPort: 8001 }]);
  assert.equal(text, expected);
  assert.ok(!/token|client-|current-context/.test(text));
});

test('kubeconfigText with two targets has a single none user', () => {
  const text = kubeconfigText([{ name: 'a', proxyPort: 8001 }, { name: 'b', proxyPort: 8002 }]);
  assert.equal(text.split('\n').filter((l) => l.startsWith('- name: ')).length, 5);
  assert.equal(text.split('\n').filter((l) => l === '- name: none').length, 1);
  assert.equal(text.split('\n').filter((l) => l.startsWith('    server: ')).length, 2);
  assert.equal(text.split('\n').filter((l) => l === '    user: none').length, 2);
});

test('proxyArgs and kubectlArgs', () => {
  assert.deepEqual(proxyArgs('/k.yaml', 8001), [
    '--kubeconfig', '/k.yaml', 'proxy', '--address=127.0.0.1', '--port=8001', `--reject-paths=${REJECT_PATHS}`,
  ]);
  assert.deepEqual(kubectlArgs('/s/kubeconfig', 'lab', ['get', 'pods']), [
    '--kubeconfig', '/s/kubeconfig', '--context', 'lab', 'get', 'pods',
  ]);
});

test('portListening', async () => {
  const port = await freePort();
  assert.equal(await portListening(port), false);
  const server = net.createServer();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    assert.equal(await portListening(port), true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('openCluster and closeCluster with the stub', async () => {
  const dir = tmp();
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const env = { ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_STATE_DIR: dir };
  const target = { kind: 'kubernetes', name: 'lab', kubeconfig, proxyPort: port, tunnel: null };
  const handle = await openCluster(target, { sessionDir: dir }, env);
  try {
    assert.equal(handle.ok, true);
    assert.equal(handle.state, 'up');
    assert.equal(handle.tunnel, null);
    assert.ok(fs.existsSync(path.join(dir, 'kube-lab.log')));
    assert.equal(await probeVersion(port), 'up');
  } finally {
    if (handle.ok) await closeCluster(handle, env);
  }
  assert.equal(await eventually(async () => !(await portListening(port))), true);
});

test('openCluster reports auth when the proxy answers 401', async () => {
  const dir = tmp();
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const env = { ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_STATE_DIR: dir, KSPROXY_FAKE_KUBECTL_STATUS: '401' };
  const handle = await openCluster({ name: 'a', kubeconfig, proxyPort: port, tunnel: null }, { sessionDir: dir }, env);
  try {
    assert.equal(handle.ok, true);
    assert.equal(handle.state, 'auth');
  } finally {
    if (handle.ok) await closeCluster(handle, env);
  }
});

test('openCluster reports fail for a 500 answer', async () => {
  const dir = tmp();
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const env = { ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_STATE_DIR: dir, KSPROXY_FAKE_KUBECTL_STATUS: '500' };
  const handle = await openCluster({ name: 'a', kubeconfig, proxyPort: port, tunnel: null }, { sessionDir: dir }, env);
  try {
    assert.equal(handle.state, 'fail');
  } finally {
    if (handle.ok) await closeCluster(handle, env);
  }
});

test('openCluster fails for a missing kubeconfig', async () => {
  const dir = tmp();
  const port = await freePort();
  const env = { ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_STATE_DIR: dir };
  const r = await openCluster(
    { name: 'a', kubeconfig: path.join(dir, 'nope.yaml'), proxyPort: port, tunnel: null },
    { sessionDir: dir },
    env,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /kubeconfig not found/);
});

test('openCluster fails when the port is already in use', async () => {
  const dir = tmp();
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const server = net.createServer();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const env = { ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_STATE_DIR: dir };
  try {
    const r = await openCluster({ name: 'a', kubeconfig, proxyPort: port, tunnel: null }, { sessionDir: dir }, env);
    assert.equal(r.ok, false);
    assert.match(r.error, /already in use/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('openCluster opens and closes a tunnel first', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 's'));
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const env = {
    ...process.env, KSPROXY_KUBECTL: fakeKubectl, KSPROXY_SSH: fakeSsh, KSPROXY_STATE_DIR: dir,
  };
  const target = {
    name: 'lab',
    kubeconfig,
    proxyPort: port,
    tunnel: { host: 'jump', localPort: 16443, remote: '127.0.0.1:6443' },
  };
  const handle = await openCluster(target, { sessionDir: dir }, env);
  try {
    assert.equal(handle.ok, true);
    assert.deepEqual(handle.tunnel, { host: 'jump', socket: path.join(dir, 's', 'tun-lab') });
    assert.ok(fs.existsSync(handle.tunnel.socket));
  } finally {
    if (handle.ok) await closeCluster(handle, env);
  }
  assert.equal(fs.existsSync(path.join(dir, 's', 'tun-lab')), false);
});

test('openCluster reports a tunnel failure', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 's'));
  const kubeconfig = path.join(dir, 'kc.yaml');
  fs.writeFileSync(kubeconfig, 'x');
  const port = await freePort();
  const env = {
    ...process.env,
    KSPROXY_KUBECTL: fakeKubectl,
    KSPROXY_SSH: fakeSsh,
    KSPROXY_STATE_DIR: dir,
    KSPROXY_FAKE_SSH_FAIL_HOST: 'jump',
  };
  const r = await openCluster({
    name: 'lab',
    kubeconfig,
    proxyPort: port,
    tunnel: { host: 'jump', localPort: 16443, remote: '127.0.0.1:6443' },
  }, { sessionDir: dir }, env);
  assert.equal(r.ok, false);
  assert.match(r.error, /^ssh tunnel: /);
});

test('hardRefusalDetail gives a short reason for every refusal row', () => {
  const { base, root } = manifestFixture();
  fs.mkdirSync(path.join(root, 'sub'));
  const table = [
    [[], [], 'invalid arguments'],
    [['get', 'a\nb'], [], 'invalid arguments'],
    [['get', ''], [], 'invalid arguments'],
    [['-n', 'web', 'get', 'pods'], [], 'verb must come first'],
    [['exec', 'pod'], [], 'verb "exec" unavailable'],
    [['x'.repeat(40)], [], `verb "${'x'.repeat(19)}…" unavailable`],
    [['create', 'token', 'sa'], [], 'create token'],
    [['cluster-info', 'dump'], [], 'cluster-info dump'],
    [['auth', 'reconcile'], [], 'auth: only can-i, whoami'],
    [['auth'], [], 'auth: only can-i, whoami'],
    [['apply', 'edit-last-applied', 'deploy/x'], [], 'opens an editor'],
    [['get', 'secrets'], [], 'secret resource'],
    [['get', 'pods', '--', 'x'], [], 'bare "--"'],
    [['get', 'pods', '-ojson'], [], 'combined short flags'],
    [['get', 'pods', '--context', 'admin'], [], 'flag --context unavailable'],
    [['get', 'pods', '--context=admin'], [], 'flag --context unavailable'],
    [['get', 'pods', '-s', 'http://x'], [], 'flag -s unavailable'],
    [['get', 'pods', `--${'y'.repeat(60)}`], [], `flag --${'y'.repeat(27)}… unavailable`],
    [['get', 'pods', '-o', 'go-template=x'], [], 'output format'],
    [['get', 'pods', '-o'], [], 'output format'],
    [['apply', '-f'], [root], '-f needs a path'],
    [['apply', '--filename'], [root], '--filename needs a path'],
    [['apply', '-f', 'https://example.com/x.yaml'], [root], '-f: not a local file'],
    [['apply', '--patch-file', '-'], [root], '--patch-file: not a local file'],
    [['apply', '-f', '/etc/hosts'], [], 'no manifestRoots'],
    [['apply', '-f', path.join(root, 'missing.yaml')], [root], '-f: file not found'],
    [['apply', '-f', '/etc/hosts'], [root], '-f: outside manifestRoots'],
    [['apply', '--filename', path.join(root, 'link.yaml')], [root], '--filename: outside manifestRoots'],
    [['apply', '-f', path.join(root, 'sub')], [root], '-f: not a single file'],
  ];
  assert.ok(fs.existsSync(path.join(base, 'outside.yaml')));
  for (const [args, roots, short] of table) {
    const detail = hardRefusalDetail(args, roots);
    assert.equal(typeof detail?.reason, 'string', JSON.stringify(args));
    assert.equal(detail.short, short, JSON.stringify(args));
    assert.equal(hardRefusal(args, roots), detail.reason);
  }
  assert.equal(hardRefusalDetail(['get', 'pods', '-A'], []), null);
  assert.equal(hardRefusal(['get', 'pods', '-A'], []), null);
});

test('hardRefusal keeps its exact long reasons', () => {
  assert.equal(hardRefusal(['get', 'secrets'], []), 'secret resources are never allowed');
  assert.equal(hardRefusal(['exec', 'pod'], []), 'the "exec" command is not available through this proxy');
  assert.equal(hardRefusal(['get', 'pods', '--context', 'x'], []), 'the flag --context is not available through this proxy');
  assert.equal(hardRefusal(['create', 'token', 'a'], []), '"create token" is never allowed: it would hand out a credential');
  assert.equal(hardRefusal(['apply', '-f'], ['/tmp']), 'the flag -f needs a path');
  assert.equal(
    hardRefusal(['apply', '-f', '-'], ['/tmp']),
    '-f only accepts a local path inside the configured manifestRoots',
  );
});
