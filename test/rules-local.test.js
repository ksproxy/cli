import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import localKind from '../src/kinds/local/index.js';
import { validateInventory } from '../src/inventory.js';
import { tempDir } from './temp.js';

let base;
let cwd;
let env;
let target;
let savedHome;

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-rl-'));
  cwd = path.join(base, 'work');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'X=1\n');
  fs.writeFileSync(path.join(cwd, 'keep.txt'), 'k\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(cwd, 'link'));
  fs.mkdirSync(path.join(base, 'home'));
  process.env.HOME = path.join(base, 'home');
  fs.mkdirSync(path.join(base, 'st'), { recursive: true });
  fs.symlinkSync(path.join(base, 'st'), path.join(cwd, 'stlink'));
  env = { KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
  target = {
    kind: 'local', name: 'infra', cwd, allow: ['regex(cat .*)'], protected: [], protect: ['keep.txt'],
  };
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const decide = (command, extra = {}) => localKind.decide({ ...target, ...extra }, command, env);

function refused(command, short, extra) {
  const d = decide(command, extra);
  assert.equal(d.allowed, false, command);
  assert.equal(d.short, short, `${command}: ${d.reason}`);
  assert.equal(d.argv, undefined, command);
  return d;
}

const inventoryWith = (allow) => ({ local: [{ name: 'infra', cwd: '/srv/infra', allow }] });

test('validate: a regex rule of a local target must start with the program name', () => {
  for (const rule of ['regex(git status)', 'regex(^git status$)', 'regex(uptime)', 'regex(^uptime$)', 'regex(\\./run\\.sh .*)',
    'regex(venv/bin/python-3 [a-z]+)', 'regex(git status|rm x)', 'regex(^git)']) {
    assert.doesNotThrow(() => validateInventory(inventoryWith([rule])), rule);
  }
  for (const rule of ['regex(.*)', 'regex(git|rm)', 'regex(./run.sh)', 'regex((git) status)', 'regex(^ git)', 'regex(git$ x)',
    'regex(git\\ status)', 'regex([g]it)', 'regex(^$)', 'regex(^)', 'regex(git* x)']) {
    assert.throws(() => validateInventory(inventoryWith(['ls', rule])), {
      message: 'local "infra": allow[1]: a regex rule of a local target must start with the program name',
    }, rule);
  }
  assert.throws(() => validateInventory(inventoryWith(['regex(']), {
    message: 'local "infra": allow[0]: regex(...) must be the whole rule',
  }));
  assert.throws(() => validateInventory({ ssh: [{ name: 'a', host: 'h', allow: ['ls regex(x)'] }] }), {
    message: 'ssh "a": allow[0]: regex(...) must be the whole rule',
  });
  assert.throws(() => validateInventory({ ssh: [{ name: 'a', host: 'h', allow: ['regex()'] }] }), {
    message: 'ssh "a": allow[0]: regex pattern is empty',
  });
  assert.doesNotThrow(() => validateInventory({ ssh: [{ name: 'a', host: 'h', allow: ['regex(.*)'] }] }));
});

test('decide: a matching regex rule allows plain arguments inside the folder and gives the argv', () => {
  const d = decide('cat a.txt sub');
  assert.deepEqual(d, { allowed: true, rule: 'regex(cat .*)', argv: ['cat', 'a.txt', 'sub'] });
  assert.deepEqual(decide('uptime', { allow: ['regex(^uptime$)'] }), { allowed: true, rule: 'regex(^uptime$)', argv: ['uptime'] });
});

test('decide: a regex rule on a local target never allows a flag', () => {
  refused('cat -n a.txt', 'not a plain argument');
  refused('cat --show-all a.txt', 'not a plain argument');
  refused('git log --oneline', 'not a plain argument', { allow: ['regex(git log --oneline)'] });
});

test('decide: a regex rule cannot reach outside the folder, protected paths, ksproxy files or secret files', () => {
  refused('cat /etc/hosts', 'not a plain argument');
  refused('cat ../outside.txt', 'contains ".."');
  refused('cat link', 'outside the folder');
  refused('cat keep.txt', 'protected path');
  refused('cat stlink', 'ksproxy files');
  refused('cat .env', 'secret file');
});

test('decide: a regex rule cannot allow another program than the one it names', () => {
  const allow = ['regex(cat a\\.txt|rm a\\.txt)'];
  assert.equal(decide('cat a.txt', { allow }).allowed, true);
  const d = refused('rm a.txt', 'not the rule program', { allow });
  assert.equal(d.reason, 'the command must start with cat, the program this rule names');
});

test('decide: the shell syntax refusal comes before any regex rule', () => {
  for (const command of ['cat a.txt; rm a.txt', 'cat $(id)', 'cat a.txt > b']) {
    assert.match(decide(command, { allow: ['regex(cat .*)'] }).short, /not allowed$/, command);
  }
});

test('decide: a regex rule without a usable program name, as in an edited session, is never used', () => {
  refused('rm a.txt', 'not on allowlist', { allow: ['regex(.*)'] });
  const d = decide('rm a.txt', { allow: ['regex(.*)', 'ls'] });
  assert.equal(d.allowed, false);
  assert.equal(d.unmatched, true);
});

test('decide: the first rule that matches wins, of either sort, and a refused match is reported', () => {
  const allow = ['regex(cat -n a\\.txt)', 'cat *'];
  assert.equal(decide('cat a.txt', { allow }).rule, 'cat *');
  refused('cat -n a.txt', 'not a plain argument', { allow });
  assert.equal(decide('cat a.txt', { allow: ['regex(cat a\\.txt)', 'cat *'] }).rule, 'regex(cat a\\.txt)');
});

test('decide: the reviewer still gets unmatched and argv when no rule of either sort matches', () => {
  const d = decide('cat a.txt', { allow: ['regex(ls)', 'ls *'], review: true, programs: ['cat'] });
  assert.equal(d.allowed, false);
  assert.equal(d.unmatched, true);
  assert.deepEqual(d.argv, ['cat', 'a.txt']);
});
