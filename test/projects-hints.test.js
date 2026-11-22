import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { kindByKey } from '../src/kinds/index.js';
import { PROJECT_RULE, checkCommand, withProject } from '../src/paths.js';
import { callTool } from '../src/tools.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

after(() => cleanupAll());

const DEFAULT = withProject({}, null);
const SHOP = withProject({}, 'shop');

async function cli(args, env = DEFAULT) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, out: proc.stdout.text, err: proc.stderr.text };
}

test('checkCommand names the project when there is one', () => {
  assert.equal(checkCommand(DEFAULT), 'ksproxy check');
  assert.equal(checkCommand(SHOP), 'ksproxy check --project shop');
  assert.throws(() => checkCommand({ KSPROXY_PROJECT: 'Shop' }), { message: PROJECT_RULE });
});

test('the refusals that ask the user to run a command name the project; the default keeps its text', () => {
  const local = kindByKey('local');
  const folder = { name: 'infra', cwd: '/', allow: ['cat *'], protected: [] };
  assert.equal(local.decide(folder, 'cat a', DEFAULT).reason, 'this target\'s folder is not acceptable; ask the user to run "ksproxy check local infra"');
  assert.equal(local.decide(folder, 'cat a', SHOP).reason, 'this target\'s folder is not acceptable; ask the user to run "ksproxy check --project shop local infra"');
  const ssh = kindByKey('ssh');
  const jumped = { name: 'web1', host: 'web1.example.com', jumps: [], allow: ['uptime'] };
  assert.equal(ssh.decide(jumped, 'uptime', DEFAULT).reason, 'this target\'s jumps are not usable; ask the user to restart ksproxy start');
  assert.equal(ssh.decide(jumped, 'uptime', SHOP).reason, 'this target\'s jumps are not usable; ask the user to restart ksproxy start --project shop');
});

test('a local call through a project whose folder is no longer acceptable tells the agent the check command of that project', async () => {
  const w = await makeWorld({ ssh: [], local: [{}], extraEnv: { KSPROXY_HEALTH_MS: '60000' } });
  const cfg = w.env.KSPROXY_CONFIG_DIR;
  fs.mkdirSync(path.join(cfg, 'projects'));
  fs.copyFileSync(path.join(cfg, 'inventory.json'), path.join(cfg, 'projects', 'shop.json'));
  const runs = [null, 'shop'].map((project) => ({ project, run: launch({ env: withProject(w.env, project) }, { all: true }) }));
  for (const { run } of runs) await ready(run);
  // The folder is now a link to the filesystem root, which is too broad.
  fs.renameSync(w.proj, `${w.proj}-old`);
  fs.symlinkSync('/', w.proj);
  for (const { project, run } of runs) {
    const r = await callTool('local_exec', { target: 'infra', command: 'cat a.txt' }, withProject(w.env, project));
    assert.equal(r.isError, true);
    const command = project === null ? 'ksproxy check local infra' : 'ksproxy check --project shop local infra';
    assert.ok(r.text.startsWith(`REFUSED (local infra): this target's folder is not acceptable; ask the user to run "${command}"`), r.text);
    assert.equal(await stopWith(run), 0);
  }
});

test('check with --project after the kind says where the flag goes, in both spellings', async () => {
  const placement = '--project must come before the kind: ksproxy check --project NAME <kind> <name> <command...>';
  for (const args of [['ssh', '--project', 'shop', 'web1', 'uptime'], ['ssh', '--project=shop', 'web1', 'uptime'], ['kube', '--projectx', 'lab', 'get']]) {
    const r = await cli(['check', ...args]);
    assert.equal(r.code, 2, args.join(' '));
    assert.ok(r.err.startsWith(`${placement}\nUsage: ksproxy <command>`), r.err);
    assert.equal(r.out, '');
  }
});

test('the usage error of check shows the project flag, and the usage says status shows every live session', async () => {
  const r = await cli(['check', 'ssh', 'web1']);
  assert.equal(r.code, 2);
  assert.ok(r.err.startsWith('usage: ksproxy check [--project NAME] <ssh|kube|local|'), r.err);
  const help = await cli(['--help']);
  assert.match(help.out, /\n {2}status \[--project NAME\] +show every live session and each target's state\n/);
});
