import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isInside, localFolderProblem, plainValues, protectedPaths, realish, sessionProtected, valueProblem, wildcardProblem,
} from '../src/kinds/local/folder.js';
import { isCaseInsensitive, withProject } from '../src/paths.js';
import { tempDir } from './temp.js';

let base;
let home;
let work;
let state;
let env;
let savedHome;

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-lo-'));
  home = path.join(base, 'home');
  work = path.join(base, 'work');
  state = path.join(base, 'st');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(work, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(state, 'session'), { recursive: true });
  fs.mkdirSync(path.join(base, 'cfg'));
  fs.mkdirSync(path.join(base, 'outdir'));
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(work, 'sub', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'o\n');
  fs.writeFileSync(path.join(state, 'session', 'session.json'), '{}\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(work, 'link'));
  fs.symlinkSync(path.join(base, 'outdir'), path.join(work, 'dirlink'));
  fs.symlinkSync(path.join(base, 'nothing-here'), path.join(work, 'dangling'));
  fs.symlinkSync(state, path.join(work, 'stlink'));
  fs.symlinkSync(path.join(base, 'kube.yaml'), path.join(work, 'kubelink'));
  fs.linkSync(path.join(base, 'outside.txt'), path.join(work, 'hard'));
  fs.writeFileSync(path.join(base, 'kube.yaml'), 'apiVersion: v1\n');
  fs.symlinkSync('loop-b', path.join(work, 'loop-a'));
  fs.symlinkSync('loop-a', path.join(work, 'loop-b'));
  process.env.HOME = home;
  env = { KSPROXY_STATE_DIR: state, KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

test('the test home is the temporary one', () => {
  assert.equal(os.homedir(), home);
});

test('isCaseInsensitive: darwin and win32 only', () => {
  assert.equal(isCaseInsensitive('darwin'), true);
  assert.equal(isCaseInsensitive('win32'), true);
  assert.equal(isCaseInsensitive('linux'), false);
  assert.equal(isCaseInsensitive(), process.platform === 'darwin' || process.platform === 'win32');
});

test('isInside: equal, child, a sibling that shares a prefix, and a root parent', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/b/c/d', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(isInside('/a', '/a/b'), false);
  assert.equal(isInside('/x/y', '/'), true);
  assert.equal(isInside('/', '/'), true);
});

test('isInside: a different letter case counts as inside exactly when the platform is case-insensitive', () => {
  assert.equal(isInside('/A/B/c', '/a/b'), isCaseInsensitive(process.platform));
  assert.equal(isInside('/a/b/C', '/a/b'), true);
});

test('isInside: both platform values are honoured when given', () => {
  assert.equal(isInside('/A/B/c', '/a/b', true), true);
  assert.equal(isInside('/A/B', '/a/b', true), true);
  assert.equal(isInside('/A/Bc', '/a/b', true), false);
  assert.equal(isInside('/A/B/c', '/a/b', false), false);
  assert.equal(isInside('/a/b/c', '/a/b', false), true);
});

test('realish: an existing file, and the real path of a symlink', () => {
  assert.equal(realish(path.join(work, 'a.txt')), path.join(work, 'a.txt'));
  assert.equal(realish(path.join(work, 'link')), path.join(base, 'outside.txt'));
});

test('realish: a missing file under an existing directory appends the rest', () => {
  assert.equal(realish(path.join(work, 'new.txt')), path.join(work, 'new.txt'));
  assert.equal(realish(path.join(work, 'x', 'y', 'z.txt')), path.join(work, 'x', 'y', 'z.txt'));
});

test('realish: a symlinked directory in the middle is followed, also for a missing rest', () => {
  assert.equal(realish(path.join(work, 'dirlink', 'new.txt')), path.join(base, 'outdir', 'new.txt'));
  assert.equal(realish(path.join(work, 'stlink', 'session')), path.join(state, 'session'));
});

test('realish: a dangling symlink, a path through one, and a symlink loop are null', () => {
  assert.equal(realish(path.join(work, 'dangling')), null);
  assert.equal(realish(path.join(work, 'dangling', 'x')), null);
  assert.equal(realish(path.join(work, 'loop-a')), null);
  assert.equal(realish(path.join(work, 'loop-a', 'x')), null);
});

test('realish: nothing on the way exists, so the whole path is kept', () => {
  const nothing = () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  assert.equal(realish('/x/y/z', nothing), '/x/y/z');
  assert.equal(realish('/', nothing), '/');
});

test('localFolderProblem: a project folder is fine, a missing one too', () => {
  assert.equal(localFolderProblem(work, env), null);
  assert.equal(localFolderProblem(path.join(work, 'not-yet'), env), null);
});

test('localFolderProblem: the root, the home directory and a parent of home are too broad', () => {
  assert.equal(localFolderProblem('/', env), 'folder is too broad: pick a project folder, not /');
  assert.equal(localFolderProblem(home, env), `folder is too broad: pick a project folder, not ${home}`);
  assert.equal(localFolderProblem(base, env), `folder is too broad: pick a project folder, not ${base}`);
  assert.equal(localFolderProblem(path.dirname(base), env), `folder is too broad: pick a project folder, not ${path.dirname(base)}`);
});

test('localFolderProblem: a folder below the home directory is fine', () => {
  fs.mkdirSync(path.join(home, 'proj'));
  assert.equal(localFolderProblem(path.join(home, 'proj'), env), null);
});

test('localFolderProblem: the state folder, a folder inside it and a folder containing it overlap', () => {
  const message = "folder overlaps ksproxy's own files";
  assert.equal(localFolderProblem(state, env), message);
  assert.equal(localFolderProblem(path.join(state, 'session'), env), message);
  const roomy = fs.mkdtempSync(path.join(base, 'roomy-'));
  fs.mkdirSync(path.join(roomy, 'deep', 'st'), { recursive: true });
  assert.equal(localFolderProblem(roomy, { ...env, KSPROXY_STATE_DIR: path.join(roomy, 'deep', 'st') }), message);
});

test('localFolderProblem: the config folder overlaps too, found by its configured path', () => {
  const message = "folder overlaps ksproxy's own files";
  assert.equal(localFolderProblem(path.join(base, 'cfg'), env), message);
  assert.equal(localFolderProblem(path.join(base, 'cfg', 'x'), env), message);
});

test('localFolderProblem: a state folder reached through a symlink is found by its real path', () => {
  const viaLink = path.join(base, 'state-link');
  fs.symlinkSync(state, viaLink);
  const linked = { ...env, KSPROXY_STATE_DIR: viaLink };
  assert.equal(localFolderProblem(state, linked), "folder overlaps ksproxy's own files");
  assert.equal(localFolderProblem(viaLink, linked), "folder overlaps ksproxy's own files");
});

test('localFolderProblem: a state folder that is a dangling link is still found by its configured path', () => {
  const dangling = path.join(base, 'state-dangling');
  fs.symlinkSync(path.join(base, 'no-such-state'), dangling);
  const odd = { ...env, KSPROXY_STATE_DIR: dangling };
  assert.equal(localFolderProblem(work, odd), null);
  assert.equal(localFolderProblem(dangling, odd), 'folder cannot be resolved');
  assert.equal(localFolderProblem(path.join(dangling, 'x'), odd), 'folder cannot be resolved');
});

test('localFolderProblem: a folder that is a link to nowhere cannot be resolved', () => {
  assert.equal(localFolderProblem(path.join(work, 'dangling'), env), 'folder cannot be resolved');
  assert.equal(localFolderProblem(path.join(work, 'loop-a'), env), 'folder cannot be resolved');
});

test('localFolderProblem: a folder reached through a symlink is judged by its real path', () => {
  assert.equal(localFolderProblem(path.join(work, 'stlink'), env), "folder overlaps ksproxy's own files");
  const homeLink = path.join(base, 'home-link');
  fs.symlinkSync(home, homeLink);
  assert.equal(localFolderProblem(homeLink, env), `folder is too broad: pick a project folder, not ${homeLink}`);
});

test('localFolderProblem: a home directory that cannot be resolved falls back to its configured path', () => {
  const dangling = path.join(base, 'home-dangling');
  fs.symlinkSync(path.join(base, 'no-such-home'), dangling);
  process.env.HOME = dangling;
  try {
    assert.equal(os.homedir(), dangling);
    assert.equal(localFolderProblem(work, env), null);
    assert.equal(localFolderProblem('/', env), 'folder is too broad: pick a project folder, not /');
  } finally {
    process.env.HOME = home;
  }
});

test('localFolderProblem: the environment defaults to process.env', () => {
  const saved = { state: process.env.KSPROXY_STATE_DIR, config: process.env.KSPROXY_CONFIG_DIR };
  process.env.KSPROXY_STATE_DIR = state;
  process.env.KSPROXY_CONFIG_DIR = path.join(base, 'cfg');
  try {
    assert.equal(localFolderProblem(state), "folder overlaps ksproxy's own files");
    assert.equal(localFolderProblem(work), null);
    assert.equal(valueProblem('sub/b.txt', { cwd: work }), null);
    assert.equal(valueProblem(`${state}/x`, { cwd: work }).short, 'ksproxy files');
    assert.deepEqual(wildcardProblem({ star: ['a.txt'], rest: [] }, { cwd: work }), null);
    assert.ok(protectedPaths({}).includes(state));
  } finally {
    for (const [name, value] of [['KSPROXY_STATE_DIR', saved.state], ['KSPROXY_CONFIG_DIR', saved.config]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('plainValues: names and relative paths are plain, absolute ones never', () => {
  for (const arg of ['a.txt', 'sub/b.txt', 'main..dev', '20', '.']) {
    assert.deepEqual(plainValues(arg), [arg], arg);
  }
  assert.equal(plainValues('/etc/hosts'), null);
  assert.equal(plainValues('/'), null);
});

test('plainValues: flags are never plain, with or without a value', () => {
  for (const arg of ['-n', '--oneline', '--since=2.days', '--config=/etc/passwd', '-C', '--directory=sub']) {
    assert.equal(plainValues(arg), null, arg);
  }
});

test('plainValues: every other shape is refused', () => {
  const shapes = ['-I/etc', '-d@/etc/hosts', '@/etc/hosts', '+/etc/hosts', '%2Fetc', 'a=b', 'a:b', 'a,b', '--data=@x', '--x=a=b', '-ab', '--', '-', 'file:///etc/passwd', '--x=', '--include/etc/hosts'];
  for (const arg of shapes) {
    assert.equal(plainValues(arg), null, arg);
  }
});

const tgt = (extra = {}) => ({ cwd: work, ...extra });

test('protectedPaths: the state and config folders, configured and real, and the listed kubeconfigs', () => {
  const viaLink = path.join(base, 'state-link-2');
  fs.symlinkSync(state, viaLink);
  const list = protectedPaths({ protected: [path.join(base, 'kube.yaml'), '', 5, null] }, { ...env, KSPROXY_STATE_DIR: viaLink });
  assert.deepEqual([...new Set(list)].sort(), [viaLink, state, path.join(base, 'cfg'), path.join(base, 'kube.yaml')].sort());
  assert.deepEqual([...new Set(protectedPaths({}, env))], [state, path.join(base, 'cfg')]);
  assert.deepEqual([...new Set(protectedPaths({ protected: 'x' }, env))], [state, path.join(base, 'cfg')]);
  const missing = protectedPaths({ protected: [path.join(work, 'dangling')] }, env);
  assert.ok(missing.includes(path.join(work, 'dangling')));
  assert.ok(!missing.includes(path.join(base, 'nothing-here')));
});

test('valueProblem: values that stay inside the folder are fine, even when they do not exist', () => {
  for (const value of ['a.txt', 'sub/b.txt', './a.txt', 'new.txt', '.', 'a..', '..a', 'sub/..b', 'main..dev']) {
    assert.equal(valueProblem(value, tgt(), env), null, value);
  }
});

test('valueProblem: the reasons and short forms', () => {
  assert.deepEqual(valueProblem('../x', tgt(), env), { reason: 'the argument ../x contains ".."', short: 'contains ".."' });
  assert.deepEqual(valueProblem('dangling', tgt(), env), {
    reason: 'the argument dangling is a link that cannot be resolved', short: 'unresolvable link',
  });
  assert.deepEqual(valueProblem('stlink/x', tgt(), env), {
    reason: "ksproxy's own files are off limits", short: 'ksproxy files',
  });
  assert.deepEqual(valueProblem('link', tgt(), env), {
    reason: "the argument link points outside this target's folder", short: 'outside the folder',
  });
});

test('valueProblem: ".." anywhere as a segment is refused, also with an absolute path', () => {
  for (const value of ['..', 'sub/..', 'sub/../x', 'a/b/..']) {
    assert.equal(valueProblem(value, tgt(), env).short, 'contains ".."', value);
  }
  assert.equal(valueProblem('/etc/../etc/hosts', tgt(), env).short, 'contains ".."');
});

test('valueProblem: links that lead out, dangling links and loops are refused', () => {
  assert.equal(valueProblem('link', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem('dirlink/x', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem('./dirlink/new.txt', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem('dangling', tgt(), env).short, 'unresolvable link');
  assert.equal(valueProblem('dangling/x', tgt(), env).short, 'unresolvable link');
  assert.equal(valueProblem('loop-a', tgt(), env).short, 'unresolvable link');
});

test('valueProblem: a hard link cannot be told apart by path, so it is accepted', () => {
  assert.equal(valueProblem('hard', tgt(), env), null);
});

test('valueProblem: ksproxy files win over the folder rule', () => {
  const both = { protected: [path.join(base, 'kube.yaml')] };
  assert.equal(valueProblem('stlink/session/session.json', tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem('./stlink/x', tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem(`${state}/session/session.json`, tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem(state, tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem(path.join(base, 'cfg', 'inventory.json'), tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem(path.join(base, 'kube.yaml'), tgt(both), env).short, 'ksproxy files');
});

test('valueProblem: an absolute path into the state folder in a different letter case is refused on a case-insensitive platform', () => {
  const upper = path.join(base.toUpperCase(), 'ST', 'session', 'session.json');
  const result = valueProblem(upper, tgt(), env);
  if (isCaseInsensitive(process.platform)) assert.equal(result.short, 'ksproxy files');
  else assert.equal(result.short, 'outside the folder');
});

test('valueProblem: an absolute path outside the folder is refused, one inside it is fine', () => {
  assert.equal(valueProblem('/etc/hosts', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem(path.join(work, 'sub', 'b.txt'), tgt(), env), null);
});

test('valueProblem: a folder that cannot be resolved lets nothing through', () => {
  const dangling = { cwd: path.join(work, 'dangling') };
  assert.equal(valueProblem('a', dangling, env).short, 'unresolvable link');
  const gone = { cwd: path.join(base, 'no-such-folder') };
  assert.equal(valueProblem('a', gone, env), null);
});

test('valueProblem: a working folder reached through a symlink is compared by real path', () => {
  const viaLink = path.join(base, 'work-link');
  fs.symlinkSync(work, viaLink);
  const t = { cwd: viaLink };
  assert.equal(valueProblem('a.txt', t, env), null);
  assert.equal(valueProblem('./sub/b.txt', t, env), null);
  assert.equal(valueProblem('link', t, env).short, 'outside the folder');
  assert.equal(valueProblem(`${work}/a.txt`, t, env), null);
  assert.equal(valueProblem(`${base}/outside.txt`, t, env).short, 'outside the folder');
});

test('valueProblem: a loop as the working folder is refused as outside', () => {
  const t = { cwd: path.join(work, 'loop-a') };
  assert.equal(valueProblem('x', t, env).short, 'unresolvable link');
});

test('wildcardProblem: plain arguments pass, others are refused as not plain with the wording the agent sees', () => {
  assert.equal(wildcardProblem({ star: ['a.txt'], rest: ['sub/b.txt', '20'] }, tgt(), env), null);
  assert.deepEqual(wildcardProblem({ star: [], rest: [] }, tgt(), env), null);
  const reason = 'the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally';
  const refused = wildcardProblem({ star: ['/etc/hosts'], rest: [] }, tgt(), env);
  assert.equal(refused.short, 'not a plain argument');
  assert.equal(refused.reason, reason);
  assert.equal(wildcardProblem({ star: [], rest: ['/etc/hosts'] }, tgt(), env).reason, reason);
  assert.equal(wildcardProblem({ star: ['-n'], rest: [] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [], rest: ['-n'] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [], rest: ['--since=2.days'] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [], rest: ['--x=a=b'] }, tgt(), env).short, 'not a plain argument');
});

test('wildcardProblem: absolute arguments are never plain, and the values of relative ones are checked', () => {
  assert.equal(wildcardProblem({ star: ['/etc/hosts'], rest: [] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [], rest: ['--config=/etc/hosts'] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [state], rest: [] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: [], rest: [state] }, tgt(), env).short, 'not a plain argument');
  assert.equal(wildcardProblem({ star: ['link'], rest: [] }, tgt(), env).short, 'outside the folder');
  assert.equal(wildcardProblem({ star: ['a.txt'], rest: ['link'] }, tgt(), env).short, 'outside the folder');
});

test('valueProblem: trailing slashes are removed before the path is resolved, so a link to a file cannot hide behind one', () => {
  assert.equal(valueProblem('sub/', tgt(), env), null);
  assert.equal(valueProblem('sub//', tgt(), env), null);
  assert.equal(valueProblem('a.txt/', tgt(), env), null);
  assert.equal(valueProblem('link/', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem('link//', tgt(), env).short, 'outside the folder');
  assert.equal(valueProblem('dangling/', tgt(), env).short, 'unresolvable link');
  assert.equal(valueProblem('stlink/', tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem('kubelink/', tgt({ protected: [path.join(base, 'kube.yaml')] }), env).short, 'ksproxy files');
  assert.equal(valueProblem(`${state}/`, tgt(), env).short, 'ksproxy files');
  assert.equal(valueProblem('link/', tgt(), env).reason, "the argument link/ points outside this target's folder");
  assert.equal(valueProblem('dangling/', tgt(), env).reason, 'the argument dangling/ is a link that cannot be resolved');
});

test('localFolderProblem: a folder that contains a kubeconfig named in the inventory is refused, one elsewhere is fine', () => {
  const message = 'folder contains a kubeconfig named in the inventory';
  assert.equal(localFolderProblem(work, env, [path.join(work, 'sub', 'k.yaml')]), message);
  assert.equal(localFolderProblem(work, env, [path.join(work, 'k.yaml')]), message);
  assert.equal(localFolderProblem(work, env, [path.join(base, 'kube.yaml')]), null);
  assert.equal(localFolderProblem(work, env, []), null);
  assert.equal(localFolderProblem(work, env), null);
  assert.equal(localFolderProblem(work, env, [path.join(work, 'dirlink', 'k.yaml')]), message);
  assert.equal(localFolderProblem(work, env, [path.join(work, 'kubelink')]), message);
  assert.equal(localFolderProblem(work, env, [path.join(base, 'outdir', 'k.yaml')]), null);
  fs.symlinkSync(path.join(base, 'nowhere-at-all'), path.join(base, 'kube-dangling'));
  assert.equal(localFolderProblem(work, env, [path.join(base, 'kube-dangling')]), null);
  assert.equal(localFolderProblem(work, env, ['', 5, null, path.join(base, 'kube.yaml')]), null);
  fs.symlinkSync(work, path.join(base, 'work-in'));
  assert.equal(localFolderProblem(work, env, [path.join(base, 'work-in', 'k.yaml')]), message);
});

test('a project guards the root state folder, every project included, and the whole config folder', () => {
  const shop = withProject(env, 'shop');
  const cfg = path.join(base, 'cfg');
  fs.mkdirSync(path.join(state, 'p', 'ops', 'session'), { recursive: true });
  fs.mkdirSync(path.join(state, 'p', 'shop'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'projects'), { recursive: true });
  const overlap = "folder overlaps ksproxy's own files";
  for (const folder of [state, path.join(state, 'session'), path.join(state, 'p'), path.join(state, 'p', 'ops'),
    path.join(state, 'p', 'ops', 'session'), path.join(state, 'p', 'shop'), path.join(cfg, 'projects')]) {
    assert.equal(localFolderProblem(folder, shop), overlap, folder);
  }
  for (const value of [`${state}/p/ops/session/session.json`, `${state}/session/session.json`, `${state}/p`,
    path.join(cfg, 'projects', 'ops.json'), 'stlink/p/ops/session/session.json', 'stlink/session/session.json']) {
    assert.deepEqual(valueProblem(value, tgt(), shop), { reason: "ksproxy's own files are off limits", short: 'ksproxy files' }, value);
  }
  assert.deepEqual([...new Set(protectedPaths({}, shop))], [state, cfg]);
  assert.deepEqual(sessionProtected([], shop), [state, cfg]);
});

test('a project guards the root state folder also by its real path', () => {
  const viaLink = path.join(base, 'state-link-3');
  fs.symlinkSync(state, viaLink);
  const shop = withProject({ ...env, KSPROXY_STATE_DIR: viaLink }, 'shop');
  fs.mkdirSync(path.join(state, 'p', 'ops'), { recursive: true });
  assert.equal(localFolderProblem(path.join(state, 'p', 'ops'), shop), "folder overlaps ksproxy's own files");
  assert.equal(localFolderProblem(path.join(viaLink, 'p', 'ops'), shop), "folder overlaps ksproxy's own files");
  assert.equal(valueProblem(`${state}/p/ops/x`, tgt(), shop).short, 'ksproxy files');
  assert.equal(valueProblem(`${viaLink}/p/ops/x`, tgt(), shop).short, 'ksproxy files');
  assert.deepEqual(sessionProtected([], shop), [viaLink, state, path.join(base, 'cfg')]);
});
