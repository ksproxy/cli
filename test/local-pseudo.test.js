import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { crossesPseudoFs, localFolderProblem, valueProblem } from '../src/kinds/local/folder.js';
import { tempDir } from './temp.js';

let base;
let work;
let env;
let savedHome;

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-ps-'));
  work = path.join(base, 'work');
  fs.mkdirSync(path.join(base, 'home'));
  fs.mkdirSync(path.join(base, 'st'));
  fs.mkdirSync(path.join(base, 'cfg'));
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  fs.symlinkSync('/dev/null', path.join(work, 'devnull'));
  fs.symlinkSync('/dev', path.join(base, 'devlink'));
  fs.symlinkSync(path.join(base, 'devlink'), path.join(work, 'viadev'));
  fs.symlinkSync('/proc/self/cwd/x', path.join(work, 'proclink'));
  fs.symlinkSync('/sys/x', path.join(work, 'syslink'));
  fs.symlinkSync('a.txt', path.join(work, 'inner'));
  fs.symlinkSync('/devices/x', path.join(work, 'lookalike'));
  fs.symlinkSync('/dev', path.join(base, 'devfolder'));
  for (let i = 0; i < 42; i += 1) fs.symlinkSync(`chain${i + 1}`, path.join(work, `chain${i}`));
  fs.writeFileSync(path.join(work, 'chain42'), 'end\n');
  fs.symlinkSync('chain38', path.join(work, 'short'));
  process.env.HOME = path.join(base, 'home');
  env = { KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const tgt = () => ({ cwd: work, protected: [] });

test('valueProblem: a link to a /dev file is refused as a system link', () => {
  const p = valueProblem('devnull', tgt(), env);
  assert.equal(p.short, 'system link');
  assert.equal(p.reason, 'the argument devnull goes through a link into /proc, /dev or /sys');
});

test('valueProblem: a link to a directory link that leads to /dev is refused as a system link', () => {
  assert.equal(valueProblem('viadev', tgt(), env).short, 'system link');
  assert.equal(valueProblem('viadev/null', tgt(), env).short, 'system link');
});

test('valueProblem: a link whose text is /proc/self/cwd/x or /sys/x is refused on any platform', () => {
  assert.equal(valueProblem('proclink', tgt(), env).short, 'system link');
  assert.equal(valueProblem('syslink', tgt(), env).short, 'system link');
});

test('valueProblem: ordinary links, links through /tmp and look-alike names are not flagged', () => {
  assert.equal(valueProblem('inner', tgt(), env), null);
  assert.equal(valueProblem('a.txt', { cwd: work }, env), null);
  const viaTmp = path.join(base, 'work');
  assert.equal(valueProblem('a.txt', { cwd: viaTmp }, env), null);
  assert.equal(crossesPseudoFs(path.join(work, 'inner')), false);
  assert.equal(crossesPseudoFs(path.join(work, 'lookalike')), false);
  assert.equal(crossesPseudoFs('/tmp'), false);
  assert.equal(crossesPseudoFs('/tmp/ks-ps-nonexistent/a'), false);
});

test('crossesPseudoFs: the pseudo roots themselves are not links, a link to the root is', () => {
  assert.equal(crossesPseudoFs(path.join(work, 'devnull')), true);
  assert.equal(crossesPseudoFs(path.join(base, 'devlink')), true);
  assert.equal(crossesPseudoFs(path.join(base, 'devlink', 'null')), true);
});

test('crossesPseudoFs: a readlink that throws counts as crossing', () => {
  const fsImpl = {
    lstatSync: () => ({ isSymbolicLink: () => true }),
    readlinkSync: () => { throw new Error('boom'); },
  };
  assert.equal(crossesPseudoFs('/x/y', fsImpl), true);
});

test('crossesPseudoFs: a chain of more than 40 links counts as crossing, a short chain does not', () => {
  assert.equal(crossesPseudoFs(path.join(work, 'chain0')), true);
  assert.equal(crossesPseudoFs(path.join(work, 'short')), false);
});

test('crossesPseudoFs: a path that does not exist is not flagged', () => {
  assert.equal(crossesPseudoFs(path.join(base, 'no', 'such', 'path')), false);
});

test('localFolderProblem: a folder that is itself a link into /dev cannot be resolved', () => {
  assert.equal(localFolderProblem(path.join(base, 'devfolder'), env), 'folder cannot be resolved');
  assert.equal(localFolderProblem(path.join(base, 'devfolder', 'sub'), env), 'folder cannot be resolved');
  assert.equal(localFolderProblem(work, env), null);
});

test('valueProblem: the joined path uses the real folder, so a long alias cannot make it exceed the cap', () => {
  const name = 'n'.repeat(100);
  fs.symlinkSync('.', path.join(work, name));
  const alias = path.join(work, ...Array(8).fill(name));
  assert.ok(Buffer.byteLength(alias) > 800);
  const value = 'd/'.repeat(150);
  assert.equal(valueProblem(value, { cwd: alias }, env), null);
  assert.equal(valueProblem('a.txt', { cwd: alias }, env), null);
});
