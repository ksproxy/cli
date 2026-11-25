import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { appendAudit } from '../src/audit.js';
import { writeSession } from '../src/session.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world(local = [{ name: 'infra', allow: ['cat *', 'ls ...'] }]) {
  const base = fs.realpathSync(tempDir('ks-lc-'));
  dirs.push(base);
  const proj = path.join(base, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'a\n');
  const env = {
    ...process.env,
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
    KSPROXY_STATE_DIR: path.join(base, 'st'),
  };
  fs.mkdirSync(env.KSPROXY_CONFIG_DIR);
  const entries = local.map((l) => ({ cwd: proj, ...l }));
  fs.writeFileSync(path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json'), JSON.stringify({ local: entries }));
  return { base, proj, env, sessionDir: path.join(base, 'st', 'session') };
}

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

test('help lists --local and the flag of every kind for check', async () => {
  const r = await cli(['--help'], {});
  assert.ok(r.stdout.includes('start [--ssh a,b] [--kube x,y] [--local a,b] [--all] [-v|--verbose]'), r.stdout);
  assert.ok(r.stdout.includes('  check [--project NAME]\n        <ssh|kube|local|http|command|es|mq|redis|pg|mysql|mongo|kafka|mcp>\n        <name> <command...>\n'), r.stdout);
});

test('start --local needs a list, and the list is handed to start and checked against the inventory', async () => {
  let r = await cli(['start', '--local'], {});
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith('--local needs a comma-separated list of names\nUsage:'), r.stderr);

  const { env } = world();
  r = await cli(['start', '--local', 'infra, nope', '--local=other'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'unknown local target "nope"; known local targets: infra\n');
});

test('check local says whether a command would be allowed', async () => {
  const { env, proj } = world();
  let r = await cli(['check', 'local', 'infra', 'cat', 'a.txt'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: cat *\n');
  r = await cli(['check', 'local', 'infra', 'cat', '/etc/hosts'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'REFUSED: the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally\n');
  r = await cli(['check', 'local', 'infra', 'rm', 'a.txt'], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^REFUSED: not on the allowlist for this target\. Allowed: cat \*; ls \.\.\.\n$/);
  fs.mkdirSync(env.KSPROXY_STATE_DIR, { recursive: true });
  fs.symlinkSync(env.KSPROXY_STATE_DIR, path.join(proj, 'stlink'));
  r = await cli(['check', 'local', 'infra', 'cat', 'stlink/session/session.json'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'REFUSED: ksproxy\'s own files are off limits\n');
  r = await cli(['check', 'local', 'infra', 'ls;', 'id'], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^REFUSED: character ";" is not allowed/);
});

test('an inventory that carries allowOutsidePaths is an error naming it, for check and for start', async () => {
  const { env } = world([{ name: 'infra', allow: ['cat *'], allowOutsidePaths: true }]);
  const message = 'local "infra": unknown key "allowOutsidePaths"\n';
  const check = await cli(['check', 'local', 'infra', 'cat', '/etc/hosts'], env);
  assert.equal(check.code, 2);
  assert.equal(check.stderr, message);
  const start = await cli(['start', '--all'], env);
  assert.equal(start.code, 1);
  assert.equal(start.stderr, message);
});

test('check local allows exactly the outside file a literal rule names', async () => {
  const { env } = world([{ name: 'infra', allow: ['cat /etc/hosts'] }]);
  let r = await cli(['check', 'local', 'infra', 'cat', '/etc/hosts'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'ALLOWED by rule: cat /etc/hosts\n');
  r = await cli(['check', 'local', 'infra', 'cat', '/etc/passwd'], env);
  assert.equal(r.code, 1);
});

function addCluster(env, kubeconfig) {
  const inventoryFile = path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  inventory.kubernetes = [{ name: 'lab', kubeconfig, proxyPort: 18991, allow: ['get ...'] }];
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
}

test('check local refuses the kubeconfig of any cluster in the inventory, by absolute path and through a link', async () => {
  const { env, base, proj } = world([{ name: 'infra', allow: ['cat *'] }]);
  const kube = path.join(base, 'kube.yaml');
  fs.writeFileSync(kube, 'apiVersion: v1\n');
  addCluster(env, kube);
  let r = await cli(['check', 'local', 'infra', 'cat', kube], env);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^REFUSED: the argument .* is not a plain name or path/);
  fs.symlinkSync(kube, path.join(proj, 'kubelink'));
  r = await cli(['check', 'local', 'infra', 'cat', 'kubelink/'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "REFUSED: ksproxy's own files are off limits\n");
  r = await cli(['check', 'local', 'infra', 'cat', 'a.txt'], env);
  assert.equal(r.code, 0);
});

test('check local reports a folder that contains a kubeconfig of the inventory, as start does', async () => {
  const { env, proj } = world([{ name: 'infra', allow: ['ls ...'] }]);
  addCluster(env, path.join(proj, 'kube.yaml'));
  const r = await cli(['check', 'local', 'infra', 'ls'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, 'REFUSED: folder contains a kubeconfig named in the inventory\n');
});

test('check local reports the same folder refusals as start', async () => {
  const { env, base } = world([{ name: 'infra', allow: ['ls ...'] }]);
  const inventoryFile = path.join(env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const point = (folder) => {
    const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
    inventory.local[0].cwd = folder;
    fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
  };
  point(base);
  let r = await cli(['check', 'local', 'infra', 'ls'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "REFUSED: folder overlaps ksproxy's own files\n");
  point(env.KSPROXY_STATE_DIR);
  r = await cli(['check', 'local', 'infra', 'ls'], env);
  assert.equal(r.stdout, "REFUSED: folder overlaps ksproxy's own files\n");

  const saved = process.env.HOME;
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  process.env.HOME = home;
  try {
    point(home);
    r = await cli(['check', 'local', 'infra', 'ls'], env);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, `REFUSED: folder is too broad: pick a project folder, not ${home}\n`);
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test('check local refuses a local rule that does not start with the program name', async () => {
  const { env } = world([{ name: 'infra', allow: ['* x'] }]);
  const r = await cli(['check', 'local', 'infra', 'ls'], env);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'local "infra": allow[0]: a local rule must start with the program name\n');
});

test('check local reports an unknown target, and an inventory that has no local section', async () => {
  const { env } = world();
  let r = await cli(['check', 'local', 'nope', 'ls'], env);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, 'unknown local target "nope"; known: infra\n');
  const none = world([]);
  r = await cli(['check', 'local', 'x', 'ls'], none.env);
  assert.equal(r.stderr, 'unknown local target "x"; known: none\n');
  r = await cli(['check', 'local', 'infra'], env);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.startsWith('usage: ksproxy check [--project NAME] <ssh|kube|local|http|command|es|mq|redis|pg|mysql|mongo|kafka|mcp> <name> <command...>\nUsage:'), r.stderr);
});

test('an inventory with "any" on a local target is an error for check and for start', async () => {
  const { env } = world([{ name: 'infra', allow: 'any' }]);
  const check = await cli(['check', 'local', 'infra', 'ls'], env);
  assert.equal(check.code, 2);
  assert.equal(check.stderr, 'local "infra": allow: "any" is not supported for local targets; list the commands\n');
  const start = await cli(['start', '--all'], env);
  assert.equal(start.code, 1);
  assert.equal(start.stderr, 'local "infra": allow: "any" is not supported for local targets; list the commands\n');
});

test('status shows a loc row, up while the folder exists and down when it is gone', async () => {
  const { env, proj, sessionDir } = world();
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [{
      kind: 'local', name: 'infra', description: '', allow: [], cwd: proj, path: '/usr/bin', state: 'up',
    }],
  });
  let r = await cli(['status'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.split('\n')[1], '  up    loc   infra');
  fs.rmSync(proj, { recursive: true });
  r = await cli(['status'], env);
  assert.equal(r.code, 1);
  assert.equal(r.stdout.split('\n')[1], '  down  loc   infra');
});

test('log shows a loc call in the standard shape', async () => {
  const { env, sessionDir } = world();
  const logs = path.join(path.dirname(sessionDir), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  appendAudit(path.join(logs, 'audit.log'), {
    event: 'call', tool: 'local_exec', kind: 'loc', target: 'infra', command: 'git status', decision: 'allowed', rule: 'git status', exitCode: 0, durationMs: 120, stdoutBytes: 4, stderrBytes: 0,
  });
  appendAudit(path.join(logs, 'audit.log'), {
    event: 'call', tool: 'local_exec', kind: 'loc', target: 'infra', command: 'cat /etc/hosts', decision: 'refused', reason: 'long', short: 'outside the folder',
  });
  const r = await cli(['log'], env);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^\d\d:\d\d:\d\d loc {2}infra +ok +0\.1s +git status {2}\(rule: git status, out 4B, err 0B\)$/);
  assert.match(lines[1], /^\d\d:\d\d:\d\d loc {2}infra +DENIED +cat \/etc\/hosts {2}\[outside the folder\]$/);
  const denied = await cli(['log', '--denied'], env);
  assert.equal(denied.stdout.trim().split('\n').length, 1);
});
