import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decideLocal } from '../src/tools.js';

let base;
let cwd;
let env;
let target;
let savedHome;

const ALLOW = [
  'cat *', 'ls ...', 'ls -l ...', 'git log ...', 'git log --oneline -n * ...', './run.sh', 'tool ...', '/bin/cat *',
  'venv/bin/run ...', 'curl -d@payload.json *',
];

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-dl-')));
  cwd = path.join(base, 'work');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(cwd, 'sub', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(cwd, 'link'));
  fs.linkSync(path.join(base, 'outside.txt'), path.join(cwd, 'hard'));
  fs.mkdirSync(path.join(base, 'outdir'));
  fs.symlinkSync(path.join(base, 'outdir'), path.join(cwd, 'dirlink'));
  fs.symlinkSync(path.join(base, 'nothing-here'), path.join(cwd, 'dangling'));
  fs.symlinkSync(path.join(base, 'st'), path.join(cwd, 'stlink'));
  fs.symlinkSync(path.join(base, 'kube.yaml'), path.join(cwd, 'kubelink'));
  fs.mkdirSync(path.join(cwd, 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(base, 'outside-prog'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(base, 'outside-prog'), path.join(cwd, 'venv', 'bin', 'run'));
  fs.writeFileSync(path.join(base, 'kube.yaml'), 'apiVersion: v1\n');
  fs.mkdirSync(path.join(base, 'home'));
  process.env.HOME = path.join(base, 'home');
  fs.mkdirSync(path.join(base, 'st', 'session'), { recursive: true });
  fs.writeFileSync(path.join(base, 'st', 'session', 'session.json'), '{}\n');
  env = { KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
  target = {
    kind: 'local', name: 'infra', cwd, allow: ALLOW, protected: [path.join(base, 'kube.yaml')],
  };
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const FOLDER_REFUSAL = 'this target\'s folder is not acceptable; ask the user to run "ksproxy check local infra"';

const decide = (command, extra = {}) => decideLocal({ ...target, ...extra }, command, env);

function allowed(command, argv, extra) {
  const d = decide(command, extra);
  assert.equal(d.allowed, true, `${command}: ${d.reason}`);
  assert.deepEqual(d.argv, argv);
  return d;
}

function refused(command, short, extra) {
  const d = decide(command, extra);
  assert.equal(d.allowed, false, command);
  assert.equal(d.short, short, `${command}: ${d.reason}`);
  assert.equal(typeof d.reason, 'string');
  return d;
}

test('table: cat a.txt is allowed and the argv is the token array', () => {
  const d = allowed('cat a.txt', ['cat', 'a.txt']);
  assert.equal(d.rule, 'cat *');
});

test('table: cat sub/b.txt, cat ./a.txt, cat new.txt and cat . are allowed', () => {
  allowed('cat sub/b.txt', ['cat', 'sub/b.txt']);
  allowed('cat ./a.txt', ['cat', './a.txt']);
  allowed('cat new.txt', ['cat', 'new.txt']);
  allowed('cat .', ['cat', '.']);
});

test('table: ls, ls -l sub and a git log with flags and a range are allowed only by rules that write the flags', () => {
  allowed('ls', ['ls']);
  assert.equal(allowed('ls -l sub', ['ls', '-l', 'sub']).rule, 'ls -l ...');
  const d = allowed('git log --oneline -n 20 main..dev', ['git', 'log', '--oneline', '-n', '20', 'main..dev']);
  assert.equal(d.rule, 'git log --oneline -n * ...');
});

test('table: ls ... allows ls sub, and ls -l ... allows ls -l sub', () => {
  assert.equal(allowed('ls sub', ['ls', 'sub'], { allow: ['ls ...'] }).rule, 'ls ...');
  assert.equal(allowed('ls -l sub', ['ls', '-l', 'sub'], { allow: ['ls -l ...'] }).rule, 'ls -l ...');
  assert.equal(allowed('git log --oneline -n 20 main..dev', ['git', 'log', '--oneline', '-n', '20', 'main..dev'], { allow: ['git log --oneline -n * ...'] }).rule, 'git log --oneline -n * ...');
});

test('table: a wildcard never matches a flag, whether it is short, long or long with a value', () => {
  for (const command of ['ls -l sub', 'ls --color=auto', 'ls --since=2.days']) {
    refused(command, 'not a plain argument', { allow: ['ls ...'] });
  }
  for (const command of ['git log -p', 'git log -C sub x', 'git log --upload-pack=sh']) {
    refused(command, 'not a plain argument', { allow: ['git log ...'] });
  }
  for (const command of ['tool -C sub escape', 'tool --directory=sub escape']) {
    refused(command, 'not a plain argument', { allow: ['tool ...'] });
  }
  refused('cat -n a.txt', 'not on allowlist', { allow: ['cat *'] });
  refused('cat -n', 'not on allowlist', { allow: ['cat *'] });
});

test('table: cat /etc/hosts is refused as not a plain argument', () => {
  const d = refused('cat /etc/hosts', 'not a plain argument');
  assert.equal(d.reason, 'the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally');
});

test('table: a trailing slash is removed before the path is resolved', () => {
  allowed('cat sub/', ['cat', 'sub/'], { allow: ['cat *'] });
  refused('cat link/', 'outside the folder', { allow: ['cat *'] });
  refused('cat link//', 'outside the folder', { allow: ['cat *'] });
  const d = refused('cat dangling/', 'unresolvable link', { allow: ['cat *'] });
  assert.equal(d.reason, 'the argument dangling/ is a link that cannot be resolved');
  refused('cat stlink/', 'ksproxy files', { allow: ['cat *'] });
  refused('cat kubelink/', 'ksproxy files', { allow: ['cat *'] });
  refused('cp a.txt link/', 'outside the folder', { allow: ['cp * *'] });
  allowed('cp a.txt sub/', ['cp', 'a.txt', 'sub/'], { allow: ['cp * *'] });
});

test('table: a folder that contains a kubeconfig of the inventory is refused', () => {
  const d = refused('cat a.txt', 'folder not allowed', { protected: [path.join(cwd, 'sub', 'kube.yaml')] });
  assert.equal(d.reason, FOLDER_REFUSAL);
  allowed('cat a.txt', ['cat', 'a.txt'], { protected: [path.join(base, 'kube.yaml')] });
});

test('table: ".." in any position is refused as contains ".."', () => {
  const d = refused('cat ../x', 'contains ".."');
  assert.equal(d.reason, 'the argument ../x contains ".."');
  refused('cat sub/../../x', 'contains ".."');
  refused('cat dirlink/../x', 'contains ".."');
});

test('table: links that lead out are refused as outside the folder', () => {
  refused('cat link', 'outside the folder');
  refused('cat dirlink/x', 'outside the folder');
  refused('cat ./dirlink/new.txt', 'outside the folder');
  refused('cat ./link', 'outside the folder');
});

test('table: a dangling link is refused as unresolvable', () => {
  const d = refused('cat dangling', 'unresolvable link');
  assert.equal(d.reason, 'the argument dangling is a link that cannot be resolved');
  refused('cat ./dangling', 'unresolvable link');
});

test('table: a link to the state folder is ksproxy files', () => {
  const d = refused('cat stlink/session/session.json', 'ksproxy files');
  assert.equal(d.reason, 'ksproxy\'s own files are off limits');
  refused('cat ./stlink/x', 'ksproxy files');
});

test('table: shapes that are not plain are refused as not a plain argument', () => {
  const shapes = [
    'tool -I/etc', 'tool -d@/etc/hosts', 'tool +/etc/hosts', 'tool --include/etc/hosts', 'tool %2Fetc%2Fpasswd',
    'tool a=b=/etc/passwd', 'tool --include=a:/etc', 'tool -c core.pager=sh', 'tool file:///etc/passwd',
    'git log --format=%H/%s', 'git log origin/main --format=%H/%s',
  ];
  for (const command of shapes) refused(command, 'not a plain argument');
});

test('table: a literal token of the rule is exempt, so curl -d@payload.json example.org is allowed', () => {
  const d = allowed('curl -d@payload.json example.org', ['curl', '-d@payload.json', 'example.org']);
  assert.equal(d.rule, 'curl -d@payload.json *');
  refused('curl -d@/etc/hosts example.org', 'not on allowlist');
  refused('curl -d@payload.json /etc/hosts', 'not a plain argument');
});

test('table: venv/bin/run, a link to a program outside the folder, is allowed because the program token is exempt', () => {
  allowed('venv/bin/run a.txt', ['venv/bin/run', 'a.txt']);
  refused('venv/bin/run link', 'outside the folder');
});

test('table: a hard link to an outside file is allowed: it cannot be told apart by path (documented limit)', () => {
  allowed('cat hard', ['cat', 'hard']);
});

test('table: absolute paths and flag values outside the folder are never plain', () => {
  refused('tool --config=/etc/passwd', 'not a plain argument');
  refused('cat /etc/../etc/hosts', 'not a plain argument');
  refused(`cat ${path.join(base, 'st', 'session', 'session.json')}`, 'not a plain argument');
  refused(`cat ${path.join(base, 'kube.yaml')}`, 'not a plain argument');
  refused(`grep -r x ${base}`, 'not a plain argument', { allow: ['grep -r x *'] });
  refused(`ls ${cwd}/sub`, 'not a plain argument');
  refused(`tool --kubeconfig=${path.join(base, 'kube.yaml')}`, 'not a plain argument');
});

test('a session target that still carries allowOutsidePaths: true is treated like any other: the key is ignored', () => {
  const o = { allowOutsidePaths: true };
  const absolute = refused('cat /etc/hosts', 'not a plain argument', o);
  assert.equal(absolute.reason, 'the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally');
  refused('cat link', 'outside the folder', o);
  refused('cat dirlink/x', 'outside the folder', o);
  refused('cat stlink/x', 'ksproxy files', o);
  refused('cat kubelink', 'ksproxy files', o);
  refused(`cat ${path.join(base, 'st', 'x')}`, 'not a plain argument', o);
  allowed('cat a.txt', ['cat', 'a.txt'], o);
});

test('a literal rule names one outside file explicitly and allows exactly that command', () => {
  const only = { allow: ['cat /etc/hosts'] };
  allowed('cat /etc/hosts', ['cat', '/etc/hosts'], only);
  refused('cat /etc/passwd', 'not on allowlist', only);
  refused('cat /etc/hosts a.txt', 'not on allowlist', only);
  refused('cat a.txt', 'not on allowlist', only);
});

test('table: rule order, the first rule that allows wins', () => {
  const d = allowed('cat a.txt', ['cat', 'a.txt'], { allow: ['cat a.txt', 'cat *'] });
  assert.equal(d.rule, 'cat a.txt');
  const e = allowed('cat a.txt', ['cat', 'a.txt'], { allow: ['cat *', 'cat a.txt'] });
  assert.equal(e.rule, 'cat *');
});

test('table: when the first matching rule refuses its wildcard, a later literal rule still allows', () => {
  const d = allowed('cat /etc/hosts', ['cat', '/etc/hosts'], { allow: ['cat *', 'cat /etc/hosts'] });
  assert.equal(d.rule, 'cat /etc/hosts');
  const e = allowed('cat link', ['cat', 'link'], { allow: ['cat *', 'cat link'] });
  assert.equal(e.rule, 'cat link');
  const f = refused('cat link', 'outside the folder', { allow: ['cat *', 'cat other'] });
  assert.equal(f.reason, 'the argument link points outside this target\'s folder');
});

test('the first problem seen is the one reported, and a rule that does not match adds none', () => {
  refused('cat link', 'outside the folder', { allow: ['ls *', 'cat *', 'tool ...'] });
  refused('cat /etc/hosts', 'not a plain argument', { allow: ['cat *', 'cat ...'] });
  refused('cat ../x', 'contains ".."', { allow: ['rm *', 'cat ...', 'cat *'] });
});

test('table: ./run.sh is allowed, and the program token is chosen by the rule and exempt from the checks', () => {
  allowed('./run.sh', ['./run.sh']);
  allowed('/bin/cat a.txt', ['/bin/cat', 'a.txt']);
  refused('/bin/cat /etc/hosts', 'not a plain argument');
});

test('table: cat a.txt; id is refused by the tokenizer', () => {
  refused('cat a.txt; id', 'character ";" not allowed');
});

test('table: rm a.txt is refused as not on the allowlist', () => {
  const d = refused('rm a.txt', 'not on allowlist');
  assert.match(d.reason, /^not on the allowlist for this target\. Allowed: /);
});

test('table: -rf x is refused because it starts with a dash', () => {
  refused('-rf x', 'starts with "-"');
});

test('tokenizer refusals pass through: empty, too long, quotes, not a string', () => {
  refused('', 'empty command');
  refused('   ', 'empty command');
  refused('cat "a.txt"', 'character """ not allowed');
  refused('cat $HOME', 'character "$" not allowed');
  refused('cat ~/x', 'character "~" not allowed');
  refused('cat a\nb', 'character U+000A not allowed');
  refused(`cat ${'a'.repeat(5000)}`, 'command too long');
  refused(5, 'invalid command');
});

test('an empty allowlist refuses with its own short reason', () => {
  refused('ls', 'allowlist is empty', { allow: [] });
});

test('a rule without a wildcard has nothing to check: only the literal tokens count', () => {
  allowed('./run.sh', ['./run.sh'], { allow: ['./run.sh'] });
  allowed('cat /etc/hosts', ['cat', '/etc/hosts'], { allow: ['cat /etc/hosts'] });
  allowed('cat ../x', ['cat', '../x'], { allow: ['cat ../x'] });
});

test('"..", ".", and names that merely contain dots', () => {
  refused('ls ..', 'contains ".."');
  allowed('ls .', ['ls', '.']);
  refused('ls sub/../..', 'contains ".."');
  refused('ls sub/..', 'contains ".."');
  allowed('ls ..a ...', ['ls', '..a', '...']);
  allowed('ls a..', ['ls', 'a..']);
  allowed('ls sub/..b', ['ls', 'sub/..b']);
});

test('an absolute path is not plain, also one into the working folder or a sibling that shares its prefix', () => {
  refused(`ls ${cwd}2/x`, 'not a plain argument');
  refused(`ls ${cwd}/sub`, 'not a plain argument');
  refused(`cat ${cwd}/sub`, 'not a plain argument');
});

test('every wildcard-matched argument is checked, not only the first', () => {
  refused('ls a.txt sub/b.txt /etc', 'not a plain argument');
  refused('ls a.txt sub/b.txt dirlink', 'outside the folder');
  refused('ls a.txt dangling sub/b.txt', 'unresolvable link');
  refused('ls a.txt ../x', 'contains ".."');
  refused('ls a.txt link', 'outside the folder');
  allowed('ls a.txt sub/b.txt', ['ls', 'a.txt', 'sub/b.txt']);
  refused('ls --file=a.txt --other=sub/b.txt', 'not a plain argument');
});

test('assignment-shaped and glued arguments are not plain', () => {
  refused('ls out=../x', 'not a plain argument');
  refused('ls k=v', 'not a plain argument');
  refused('ls --x=', 'not a plain argument');
  refused('ls -I/etc', 'not a plain argument');
  refused('ls -ab', 'not a plain argument');
  refused('ls --', 'not a plain argument');
  refused('ls -', 'not a plain argument');
  refused('ls -a -l', 'not a plain argument');
  refused('ls --all', 'not a plain argument');
  allowed('ls -a -l', ['ls', '-a', '-l'], { allow: ['ls -a -l ...'] });
  allowed('ls --all', ['ls', '--all'], { allow: ['ls --all'] });
});

test('the first token is exempt from the folder check, with or without a slash, but the rule must name it', () => {
  refused('./../tool a.txt', 'not on allowlist');
  allowed('../tool a.txt', ['../tool', 'a.txt'], { allow: ['../tool ...'] });
  refused('../tool ../x', 'contains ".."', { allow: ['../tool ...'] });
  allowed('dirlink/x a.txt', ['dirlink/x', 'a.txt'], { allow: ['dirlink/x ...'] });
});

test('a path that does not exist is judged by where it would be', () => {
  allowed('cat ./missing.txt', ['cat', './missing.txt']);
  allowed('cat ./nodir/missing.txt', ['cat', './nodir/missing.txt']);
});

test('a symlink inside the folder that stays inside it is fine', () => {
  fs.symlinkSync(path.join(cwd, 'a.txt'), path.join(cwd, 'inner'));
  try {
    allowed('cat ./inner', ['cat', './inner']);
  } finally {
    fs.rmSync(path.join(cwd, 'inner'));
  }
});

test('a working folder that is reached through a symlink still works, and a missing folder is judged by where it would be', () => {
  const viaLink = path.join(base, 'cwd-link');
  fs.symlinkSync(cwd, viaLink);
  try {
    const t = { cwd: viaLink };
    assert.equal(decide('cat ./a.txt', t).allowed, true);
    assert.equal(decide('cat ./link', t).short, 'outside the folder');
    assert.equal(decide('cat ../x', t).short, 'contains ".."');
  } finally {
    fs.rmSync(viaLink);
  }
  const gone = { cwd: path.join(base, 'not-there') };
  assert.equal(decide('cat ./a.txt', gone).allowed, true);
});

test('the config folder is off limits too, found by its configured path', () => {
  const inventory = path.join(base, 'cfg', 'inventory.json');
  refused(`cat ${inventory}`, 'not a plain argument');
  fs.mkdirSync(path.join(base, 'cfg'), { recursive: true });
  fs.symlinkSync(path.join(base, 'cfg'), path.join(cwd, 'cfglink'));
  try {
    refused('cat cfglink/inventory.json', 'ksproxy files');
    refused('cat cfglink', 'ksproxy files');
  } finally {
    fs.rmSync(path.join(cwd, 'cfglink'));
  }
});

test('a working folder that is, contains or sits inside ksproxy\'s own folders is refused as not allowed', () => {
  for (const folder of [path.join(base, 'st'), path.join(base, 'st', 'session'), path.join(base, 'cfg'), path.join(base, 'cfg', 'x')]) {
    const d = refused('ls', 'folder not allowed', { cwd: folder });
    assert.equal(d.reason, FOLDER_REFUSAL);
  }
  const roomy = refused('cat outside.txt', 'folder not allowed', { cwd: base });
  assert.equal(roomy.reason, FOLDER_REFUSAL);
});

test('the agent-facing folder refusal never quotes a path', () => {
  for (const folder of [path.join(base, 'st'), base, path.join(base, 'home'), '/', path.join(cwd, 'dangling')]) {
    const d = refused('ls', 'folder not allowed', { cwd: folder });
    assert.equal(d.reason, FOLDER_REFUSAL);
    assert.ok(!d.reason.includes(base), d.reason);
  }
});

test('table: any command is refused when cwd is the home directory, the root, or a folder that cannot be resolved', () => {
  const home = refused('ls', 'folder not allowed', { cwd: path.join(base, 'home') });
  assert.equal(home.reason, FOLDER_REFUSAL);
  refused('ls', 'folder not allowed', { cwd: '/' });
  refused('ls', 'folder not allowed', { cwd: path.join(cwd, 'dangling') });
});

test('table: a tampered session with allow "any", or anything that is not a list, is refused', () => {
  for (const allow of ['any', undefined, null, 'ls', { 0: 'ls' }]) {
    const d = refused('ls', 'allowlist is empty', { allow });
    assert.equal(d.reason, 'this local target has no usable allowlist');
  }
});

test('a session written without a protected list still protects the state and config folders', () => {
  const t = { ...target };
  delete t.protected;
  const d = decideLocal(t, 'cat stlink/x', env);
  assert.equal(d.short, 'ksproxy files');
  assert.equal(decideLocal(t, 'cat kubelink', env).short, 'outside the folder');
  assert.equal(decideLocal(t, 'cat a.txt', env).allowed, true);
});

test('the state folder is found by its real path and by the path as configured when it is a symlink', () => {
  const real = path.join(base, 'real-state');
  const viaLink = path.join(base, 'link-state');
  fs.mkdirSync(path.join(real, 'session'), { recursive: true });
  fs.writeFileSync(path.join(real, 'session', 'session.json'), '{}\n');
  fs.symlinkSync(real, viaLink);
  const linked = { KSPROXY_STATE_DIR: viaLink, KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
  fs.symlinkSync(real, path.join(cwd, 'reallink'));
  fs.symlinkSync(viaLink, path.join(cwd, 'vialink'));
  try {
    for (const file of ['reallink/session/session.json', 'vialink/session/session.json']) {
      const d = decideLocal(target, `cat ${file}`, linked);
      assert.equal(d.allowed, false, file);
      assert.equal(d.short, 'ksproxy files', file);
    }
  } finally {
    fs.rmSync(path.join(cwd, 'reallink'));
    fs.rmSync(path.join(cwd, 'vialink'));
  }
});

test('a state folder that does not exist is still protected by its configured path', () => {
  const missing = { KSPROXY_STATE_DIR: path.join(base, 'no-state'), KSPROXY_CONFIG_DIR: path.join(base, 'no-cfg') };
  assert.equal(decideLocal(target, 'cat a.txt', missing).allowed, true);
  const inside = { KSPROXY_STATE_DIR: path.join(cwd, 'sub', 'no-state'), KSPROXY_CONFIG_DIR: path.join(base, 'no-cfg') };
  const d = decideLocal(target, 'cat a.txt', inside);
  assert.equal(d.short, 'folder not allowed');
});

test('the folder check runs before the allowlist', () => {
  refused('rm a.txt', 'folder not allowed', { cwd: path.join(base, 'st') });
});

test('the default environment is process.env', () => {
  const saved = { state: process.env.KSPROXY_STATE_DIR, config: process.env.KSPROXY_CONFIG_DIR };
  process.env.KSPROXY_STATE_DIR = env.KSPROXY_STATE_DIR;
  process.env.KSPROXY_CONFIG_DIR = env.KSPROXY_CONFIG_DIR;
  try {
    assert.equal(decideLocal(target, 'cat a.txt').allowed, true);
    assert.equal(decideLocal(target, 'cat stlink/x').short, 'ksproxy files');
  } finally {
    for (const [name, value] of [['KSPROXY_STATE_DIR', saved.state], ['KSPROXY_CONFIG_DIR', saved.config]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('failures that are not refusals are thrown', () => {
  assert.throws(() => decideLocal(null, 'ls', env), TypeError);
});

test('tampered rules are ignored: a non-string, a leading * and a leading ... never allow anything', () => {
  const d = refused('sh a', 'not on allowlist', { allow: ['* ...', 5, '...'] });
  assert.equal(d.reason, 'not on the allowlist for this target');
  refused('sh a', 'not on allowlist', { allow: ['* ...'] });
  refused('ls', 'not on allowlist', { allow: [null, {}, ['ls']] });
  refused('cat a.txt', 'not on allowlist', { allow: [7, '* *', 'rm *'] });
  allowed('cat a.txt', ['cat', 'a.txt'], { allow: ['* ...', 5, '...', 'cat *'] });
  const listed = refused('rm a.txt', 'not on allowlist', { allow: ['* ...', 5, 'ls ...'] });
  assert.equal(listed.reason, 'not on the allowlist for this target. Allowed: ls ...');
  refused('ls', 'allowlist is empty', { allow: [] });
});

test('when several rules match loosely, the most useful refusal is reported, not "not a plain argument"', () => {
  refused('ls -l dirlink', 'outside the folder', { allow: ['ls ...', 'ls -l ...'] });
  refused('ls -l dirlink', 'outside the folder', { allow: ['ls -l ...', 'ls ...'] });
  refused('ls -l --all', 'not a plain argument', { allow: ['ls ...', 'ls -l ...'] });
  refused('ls -l ../x', 'contains ".."', { allow: ['ls ...', 'ls -l ...'] });
});
