import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMdText, mcpConfig } from '../src/agent-md.js';

test('mcpConfig names the node binary and the bin script', () => {
  assert.deepEqual(mcpConfig('/usr/bin/node', '/x/bin/ksproxy.js'), {
    mcpServers: { ksproxy: { command: '/usr/bin/node', args: ['/x/bin/ksproxy.js', 'mcp'] } },
  });
});

test('targets without a description get a plain heading', () => {
  const text = agentMdText({
    targets: [
      { kind: 'ssh', name: 'web1', description: '', allow: ['uptime'] },
      {
        kind: 'kubernetes', name: 'lab', description: '', allow: ['get ...'], manifestRoots: [], state: 'up',
      },
    ],
  });
  assert.match(text, /^### ssh server `web1`$/m);
  assert.match(text, /^### Kubernetes cluster `lab`$/m);
});

test('targets with a description show it in the heading', () => {
  const text = agentMdText({
    targets: [
      { kind: 'ssh', name: 'web1', description: 'web box', allow: 'any' },
      {
        kind: 'kubernetes', name: 'lab', description: 'lab cluster', allow: ['get ...'], manifestRoots: [], state: 'up',
      },
    ],
  });
  assert.match(text, /^### ssh server `web1` - web box$/m);
  assert.match(text, /^### Kubernetes cluster `lab` - lab cluster$/m);
});

test('a cluster with manifest folders lists them and does not say file flags are refused', () => {
  const text = agentMdText({
    targets: [{
      kind: 'kubernetes',
      name: 'lab',
      description: '',
      allow: ['apply -f *'],
      manifestRoots: ['/srv/manifests', '/srv/more'],
      state: 'up',
    }],
  });
  assert.ok(text.includes('each take one regular file (not a directory) inside:/srv/manifests, /srv/more'));
  assert.ok(!text.includes('File flags (`-f`, `--patch-file`) are refused'));
});

test('a cluster without manifest folders says file flags are refused, and a down state is reported', () => {
  const text = agentMdText({
    targets: [{
      kind: 'kubernetes', name: 'lab', description: '', allow: [], manifestRoots: [], state: 'auth',
    }],
  });
  assert.ok(text.includes('File flags (`-f`, `--patch-file`) are refused: this cluster has no manifest folders configured.'));
  assert.ok(text.includes('Connection state is `auth`'));
});

test('an ssh target with a rule list explains the word rules, and "any" does not', () => {
  const restricted = agentMdText({ targets: [{ kind: 'ssh', name: 'a', description: '', allow: ['df -h'] }] });
  const open = agentMdText({ targets: [{ kind: 'ssh', name: 'a', description: '', allow: 'any' }] });
  assert.ok(restricted.includes('A command is plain words only'));
  assert.ok(!open.includes('A command is plain words only'));
});

test('the kubernetes section lists every output format the code accepts', () => {
  const text = agentMdText({
    targets: [{ kind: 'kubernetes', name: 'lab', description: '', allow: ['get ...'], manifestRoots: [], state: 'up' }],
  });
  assert.ok(text.includes('Output formats are `json`, `yaml`, `wide`, `name`, `jsonpath=...`, `jsonpath-as-json=...` and `custom-columns=...`.'));
});
