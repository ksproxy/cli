import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { agentMdText } from '../src/agent-md.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

const ENV_FILE = ['.', 'env'].join('');

const base = fs.realpathSync(tempDir('ks-pc-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const proj = path.join(base, 'proj');
fs.mkdirSync(path.join(proj, 'secrets'), { recursive: true });
fs.writeFileSync(path.join(proj, 'secrets', 'token'), 'x\n');
fs.writeFileSync(path.join(proj, 'a.txt'), 'x\n');
fs.writeFileSync(path.join(proj, ENV_FILE), 'x\n');

const env = {
  ...process.env,
  KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
  KSPROXY_STATE_DIR: path.join(base, 'st'),
};
fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify({
  local: [{
    name: 'repo', cwd: proj, allow: ['cat *'], protect: ['secrets'],
  }],
}));

async function runCli(args) {
  const proc = fakeProcess();
  const code = await main(['check', ...args], env, { process: proc });
  return { code, stdout: proc.stdout.text.trim() };
}

test('check refuses a protected path', async () => {
  const { code, stdout } = await runCli(['local', 'repo', 'cat', 'secrets/token']);
  assert.equal(code, 1);
  assert.equal(stdout, 'REFUSED: the argument secrets/token is, lies inside or contains a path this target protects');
});

test('check refuses a secret-looking name', async () => {
  const { code, stdout } = await runCli(['local', 'repo', 'cat', ENV_FILE]);
  assert.equal(code, 1);
  assert.equal(stdout, `REFUSED: the argument ${ENV_FILE} names a file or folder that usually holds secrets`);
});

test('check still allows an ordinary file', async () => {
  const { code, stdout } = await runCli(['local', 'repo', 'cat', 'a.txt']);
  assert.equal(code, 0);
  assert.equal(stdout, 'ALLOWED by rule: cat *');
});

test('AGENT.md carries the line once for each local target', () => {
  const line = '- Files that usually hold secrets (such as .env and key files) and paths the user protected are refused unless an allowed command above names the file exactly. Do not look for another way to read them.';
  const local = (name) => ({
    kind: 'local', name, description: '', allow: ['cat *'], cwd: proj, path: '/usr/bin:/bin', state: 'up',
  });
  const one = agentMdText({ targets: [local('one')] });
  assert.equal(one.split(line).length - 1, 1);
  const two = agentMdText({ targets: [local('one'), local('two')] });
  assert.equal(two.split(line).length - 1, 2);
  const ssh = agentMdText({ targets: [{ kind: 'ssh', name: 'web1', description: '', allow: ['uptime'] }] });
  assert.equal(ssh.includes(line), false);
});
