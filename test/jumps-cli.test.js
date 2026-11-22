import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { fakeProcess } from './start-helpers.js';

const base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-jc-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const env = {
  ...process.env,
  KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
  KSPROXY_STATE_DIR: path.join(base, 'st'),
};
fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify({
  ssh: [{
    name: 'app1',
    host: 'bastion1',
    jumps: ['ssh -i .ssh/app_key opsuser@192.0.2.10'],
    allow: ['uptime', 'systemctl status *'],
  }, {
    name: 'plain',
    host: 'web1.example.com',
    allow: ['uptime'],
  }],
}));

async function runCli(args, name = 'app1') {
  const proc = fakeProcess();
  const code = await main(['check', 'ssh', name, ...args], env, { process: proc });
  return { code, stdout: proc.stdout.text.trim() };
}

test('check allows a command that matches a rule and shows what would be sent', async () => {
  const { code, stdout } = await runCli(['systemctl', 'status', 'nginx']);
  assert.equal(code, 0);
  assert.equal(stdout, [
    'ALLOWED by rule: systemctl status *',
    'sent to bastion1: ssh -T -o BatchMode=yes -i .ssh/app_key -o ConnectTimeout=10 opsuser@192.0.2.10 -- systemctl status nginx',
  ].join('\n'));
});

test('check on a target without jumps prints only the rule', async () => {
  const { code, stdout } = await runCli(['uptime'], 'plain');
  assert.equal(code, 0);
  assert.equal(stdout, 'ALLOWED by rule: uptime');
});

test('check refuses a command that matches no rule', async () => {
  const { code, stdout } = await runCli(['reboot']);
  assert.equal(code, 1);
  assert.equal(stdout, 'REFUSED: not on the allowlist for this target. Allowed: uptime; systemctl status *');
});

test('check refuses a word that starts with "="', async () => {
  const { code, stdout } = await runCli(['systemctl', 'status', '=ls']);
  assert.equal(code, 1);
  assert.equal(stdout, 'REFUSED: a word may not start with "=" or contain "==" or ":=" on a target with jumps');
});
