import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localScope, reviewProblem } from '../src/kinds/local/folder.js';
import localKind from '../src/kinds/local/index.js';
import { callTool } from '../src/tools.js';
import { writeSession } from '../src/session.js';
import { tempDir } from './temp.js';

const decideLocal = localKind.decide;

let base;
let dir;
let sessionDir;
let env;
let savedHome;

const asked = [];
const fakeReview = (reply) => async (socket, subject) => {
  asked.push({ socket, subject });
  return reply;
};
const approve = () => fakeReview({ allowed: true, certainty: 'sure', reason: '' });
const lastAudit = () => JSON.parse(fs.readFileSync(path.join(base, 'st', 'logs', 'audit.log'), 'utf8').trim().split('\n').pop());

const target = () => ({
  kind: 'local', name: 'repo', description: '', cwd: dir, allow: ['pwd'], path: '/usr/bin:/bin',
  protected: [], state: 'up', review: true, programs: ['ls', 'git'],
});

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-rl-'));
  dir = path.join(base, 'work');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  fs.symlinkSync('/etc', path.join(dir, 'out'));
  fs.mkdirSync(path.join(base, 'st', 'session'), { recursive: true });
  fs.mkdirSync(path.join(base, 'st', 'logs'));
  fs.symlinkSync(path.join(base, 'st'), path.join(dir, 'stlink'));
  fs.mkdirSync(path.join(base, 'home'));
  process.env.HOME = path.join(base, 'home');
  sessionDir = path.join(base, 'st', 'session');
  env = {
    ...process.env,
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
  };
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-21T00:00:00.000Z',
    targets: [
      target(),
      { ...target(), name: 'plain', review: undefined, programs: undefined },
      { ...target(), name: 'wild', allow: ['ls ...', 'git log *'] },
      { ...target(), name: 'overlap', cwd: path.join(base, 'st') },
      { ...target(), name: 'truthy', review: 'yes' },
      { ...target(), name: 'unusable', allow: ['* ...'] },
      { ...target(), name: 'gone', cwd: path.join(base, 'gone', 'deeper') },
    ],
  });
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

test('a listed program with simple flags and paths inside the folder may go to the reviewer', () => {
  assert.equal(reviewProblem(['ls'], target(), env), null);
  assert.equal(reviewProblem(['ls', '-la', 'sub', 'a.txt'], target(), env), null);
  assert.equal(reviewProblem(['git', 'log', '--oneline', '-n', '20'], target(), env), null);
});

test('a program the user did not list is never reviewed', () => {
  assert.equal(reviewProblem(['sh', 'a.txt'], target(), env).short, 'program not reviewable');
  assert.equal(reviewProblem(['ls'], { ...target(), programs: undefined }, env).short, 'program not reviewable');
  assert.equal(reviewProblem(['./ls'], target(), env).short, 'program not reviewable');
  assert.equal(reviewProblem(['/bin/ls'], target(), env).short, 'program not reviewable');
});

test('a flag that carries a value, and anything that is neither a flag nor a plain value, is refused', () => {
  for (const arg of ['--file=a.txt', '-C/etc', '--x.y', '-d@a.txt', '--', '-', '/etc/hosts', 'a@b', 'a:b', '---x', '-_x', 'a=b', 'a%b', 'a+b', 'a,b']) {
    assert.equal(reviewProblem(['ls', arg], target(), env).short, 'not a plain argument', arg);
  }
});

test('a value glued to a flag with letters only looks like a flag and is left to the model', () => {
  assert.equal(reviewProblem(['ls', '-Csub'], target(), env), null);
});

test('a value glued to a flag must stay in the folder when it names an entry there', () => {
  for (const arg of ['-oout', '-Cout', '-about', '--oout']) {
    assert.equal(reviewProblem(['ls', arg], target(), env).short, 'outside the folder', arg);
  }
  assert.equal(reviewProblem(['ls', '-Cstlink'], target(), env).short, 'ksproxy files');
  assert.equal(reviewProblem(['ls', '-la'], target(), env), null);
  assert.equal(reviewProblem(['ls', '-la', '-Csub', '-n', '-outx'], target(), env), null);
  const unresolved = { ...localScope(target(), env), cwdReal: null };
  assert.equal(reviewProblem(['ls', '-Csub'], target(), env, unresolved).short, 'outside the folder');
});

test('a target whose folder does not exist is never reviewed', () => {
  const gone = { ...target(), cwd: path.join(base, 'gone', 'deeper') };
  assert.deepEqual(reviewProblem(['ls'], gone, env), { reason: "this target's folder does not exist", short: 'folder missing' });
  assert.equal(reviewProblem(['ls'], { ...target(), cwd: path.join(dir, 'a.txt') }, env).short, 'folder missing');
  assert.equal(Object.hasOwn(decideLocal(gone, 'ls', env), 'argv'), false);
});

test('a plain argument must stay in the folder', () => {
  assert.equal(reviewProblem(['ls', '../x'], target(), env).short, 'contains ".."');
  assert.equal(reviewProblem(['ls', 'out/hosts'], target(), env).short, 'outside the folder');
  assert.equal(reviewProblem(['ls', 'out'], target(), env).short, 'outside the folder');
  assert.equal(reviewProblem(['ls', 'sub', 'out/hosts'], target(), env).short, 'outside the folder');
  assert.equal(reviewProblem(['ls', 'stlink'], target(), env).short, 'ksproxy files');
});

test('decideLocal carries argv only when the fixed checks pass on a reviewed target', () => {
  assert.deepEqual(decideLocal(target(), 'ls -a sub', env).argv, ['ls', '-a', 'sub']);
  assert.equal(decideLocal(target(), 'ls -a sub', env).unmatched, true);
  assert.equal(Object.hasOwn(decideLocal(target(), 'cat a.txt', env), 'argv'), false);
  assert.equal(Object.hasOwn(decideLocal({ ...target(), review: undefined }, 'ls', env), 'argv'), false);
  assert.equal(Object.hasOwn(decideLocal({ ...target(), allow: ['ls ...'] }, 'ls -la', env), 'argv'), false);
  assert.equal(Object.hasOwn(decideLocal({ ...target(), allow: ['ls ...'] }, 'ls -la', env), 'unmatched'), false);
});

test('an unlisted local command that passes the checks is reviewed and runs when approved', async () => {
  asked.length = 0;
  const r = await callTool('local_exec', { target: 'repo', command: 'ls -a sub' }, env, {
    review: fakeReview({ allowed: true, certainty: 'sure', reason: 'lists a folder' }),
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /b\.txt/);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].subject, { kind: 'local', name: 'repo', argv: ['ls', '-a', 'sub'] });
  assert.equal(asked[0].socket, path.join(base, 'st', 's', 'review-sock'));
  const entry = lastAudit();
  assert.equal(entry.rule, 'review');
  assert.deepEqual(entry.review, { certainty: 'sure', reason: 'lists a folder' });
});

test('a local command that fails a fixed check is refused without a review', async () => {
  asked.length = 0;
  const review = approve();
  const said = {
    'cat a.txt': 'the program cat is not one the reviewer may approve for this target',
    'ls --color=auto': 'the argument --color=auto is neither a simple flag nor a plain name or path',
    'ls ../x': 'the argument ../x contains ".."',
    'ls out/hosts': "the argument out/hosts points outside this target's folder",
    'ls -oout': "the argument out points outside this target's folder",
    'ls stlink': "ksproxy's own files are off limits",
    'ls /etc': 'the argument /etc is neither a simple flag nor a plain name or path',
  };
  for (const [command, why] of Object.entries(said)) {
    const r = await callTool('local_exec', { target: 'repo', command }, env, { review });
    assert.equal(r.isError, true, command);
    assert.ok(r.text.startsWith('REFUSED (local repo): not on the allowlist for this target. Allowed: pwd. '), command);
    assert.ok(r.text.endsWith(` It was not sent to the reviewer: ${why}.`), r.text);
    assert.equal(lastAudit().short, 'not on allowlist', command);
  }
  const words = {
    [`ls ${'a'.repeat(201)}`]: 'a word is longer than 200 characters',
    [`ls ${Array(64).fill('a.txt').join(' ')}`]: 'the command has more than 64 words',
  };
  for (const [command, why] of Object.entries(words)) {
    const r = await callTool('local_exec', { target: 'repo', command }, env, { review });
    assert.ok(r.text.endsWith(` It was not sent to the reviewer: ${why}.`), r.text);
  }
  const gone = await callTool('local_exec', { target: 'gone', command: 'ls' }, env, { review });
  assert.ok(gone.text.endsWith(" It was not sent to the reviewer: this target's folder does not exist."), gone.text);
  for (const command of ['ls a.txt;id', 'ls $(id)']) {
    const r = await callTool('local_exec', { target: 'repo', command }, env, { review });
    assert.equal(r.isError, true, command);
    assert.doesNotMatch(r.text, /reviewer/, command);
  }
  const others = [
    ['plain', 'ls'], ['truthy', 'ls'], ['overlap', 'ls'], ['unusable', 'ls'],
    ['wild', 'ls -la'], ['wild', 'git log out'], ['wild', 'ls out'],
  ];
  for (const [name, command] of others) {
    const r = await callTool('local_exec', { target: name, command }, env, { review });
    assert.equal(r.isError, true, `${name}: ${command}`);
    assert.doesNotMatch(r.text, /reviewer/, `${name}: ${command}`);
  }
  assert.deepEqual(asked, []);
});

test('a reviewer refusal stops a local command', async () => {
  const r = await callTool('local_exec', { target: 'repo', command: 'ls -a' }, env, {
    review: fakeReview({ allowed: false, short: 'model refused: no' }),
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /not on the allowlist.*The reviewer did not approve it\.$/);
  assert.doesNotMatch(r.text, /model refused/);
  assert.equal(lastAudit().short, 'model refused: no');
});
