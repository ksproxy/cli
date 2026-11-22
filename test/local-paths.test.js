import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { callTool, scrubOutput } from '../src/tools.js';
import localKind from '../src/kinds/local/index.js';
import { run } from '../src/exec.js';
import { writeSession } from '../src/session.js';
import {
  cleanPath, localFolderProblem, realish, sessionProtected, valueProblem,
} from '../src/kinds/local/folder.js';
import { tempDir } from './temp.js';

const decideLocal = localKind.decide;

let base;
let cwd;
let state;
let cfg;
let env;
let savedHome;
let lockedDir;

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-lp-'));
  cwd = path.join(base, 'work');
  state = path.join(base, 'st');
  cfg = path.join(base, 'cfg');
  lockedDir = path.join(cwd, 'locked');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.mkdirSync(lockedDir);
  fs.mkdirSync(path.join(cwd, 'tools'));
  fs.mkdirSync(path.join(state, 'session'), { recursive: true });
  fs.mkdirSync(cfg);
  fs.mkdirSync(path.join(base, 'home'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(cwd, 'sub', 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(lockedDir, 'inner'), 'inner\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'OUTSIDE-SECRET\n');
  fs.writeFileSync(path.join(base, 'kube.yaml'), 'apiVersion: v1\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(cwd, 'link'));
  fs.symlinkSync(path.join(base, 'kube.yaml'), path.join(cwd, 'kclink'));
  fs.symlinkSync('.', path.join(cwd, 'self'));
  fs.symlinkSync('loop-b', path.join(cwd, 'loop-a'));
  fs.symlinkSync('loop-a', path.join(cwd, 'loop-b'));
  fs.symlinkSync(path.join(cwd, 'tools'), path.join(base, 'toolslink'));
  fs.symlinkSync(path.join(base, 'no-such-bin'), path.join(base, 'dangling-bin'));
  process.env.HOME = path.join(base, 'home');
  env = { ...process.env, KSPROXY_STATE_DIR: state, KSPROXY_CONFIG_DIR: cfg };
});

after(() => {
  try {
    fs.chmodSync(lockedDir, 0o700);
  } catch {
    // not created
  }
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const target = (extra = {}) => ({
  kind: 'local', name: 'infra', cwd, allow: ['cat *'], protected: [path.join(base, 'kube.yaml')], ...extra,
});

const dots = (n) => './'.repeat(n);

test('L1 precondition: the padded form really opens the outside file for a program that runs in the folder', () => {
  const r = spawnSync('cat', [`${dots(497)}link`], { cwd, encoding: 'utf8' });
  assert.equal(r.stdout, 'OUTSIDE-SECRET\n');
});

test('L1: ./ x 250 before a link to an outside file is refused as outside the folder', () => {
  const d = decideLocal(target(), `cat ${dots(250)}link`, env);
  assert.equal(d.allowed, false);
  assert.equal(d.short, 'outside the folder');
});

test('L1: ./ x 250 before a link to a protected kubeconfig is refused as ksproxy files', () => {
  const d = decideLocal(target(), `cat ${dots(250)}kclink`, env);
  assert.equal(d.allowed, false);
  assert.equal(d.short, 'ksproxy files');
});

test('L1: ./ x 497 is longer than the 512-byte cap, so the padded form is refused before anything is joined', () => {
  for (const name of ['link', 'kclink', 'a.txt']) {
    const d = decideLocal(target(), `cat ${dots(497)}${name}`, env);
    assert.equal(d.allowed, false, name);
    assert.equal(d.short, 'argument too long', name);
  }
});

test('L1: self/ x 200 then a link is never allowed', () => {
  const d = decideLocal(target(), `cat ${'self/'.repeat(200)}link`, env);
  assert.equal(d.allowed, false);
  assert.ok(['argument too long', 'outside the folder', 'unresolvable link'].includes(d.short), d.short);
  assert.equal(decideLocal(target(), `cat ${'self/'.repeat(5)}link`, env).short, 'outside the folder');
  assert.equal(decideLocal(target(), `cat ${'self/'.repeat(200)}kclink`, env).allowed, false);
});

test('L1: x/ x 600 then y is refused as argument too long', () => {
  const d = decideLocal(target(), `cat ${'x/'.repeat(600)}y`, env);
  assert.equal(d.allowed, false);
  assert.equal(d.short, 'argument too long');
  assert.equal(d.reason, 'the argument is too long to check');
  assert.equal(valueProblem(`/${'x/'.repeat(600)}y`, { cwd }, env).short, 'argument too long');
});

test('L1: an argument is capped at 512 bytes before it is joined: 512 passes, 513 is refused', () => {
  const fill = (length) => `${'nnnnnnnnn/'.repeat(Math.ceil(length / 10)).slice(0, length - 1)}n`;
  assert.equal(Buffer.byteLength(fill(512)), 512);
  assert.equal(valueProblem(fill(512), { cwd }, env), null);
  assert.deepEqual(valueProblem(fill(513), { cwd }, env), { reason: 'the argument is too long to check', short: 'argument too long' });
  assert.equal(valueProblem(`/${fill(511)}`, { cwd }, env).short, 'outside the folder');
  assert.equal(valueProblem(`/${fill(512)}`, { cwd }, env).short, 'argument too long');
  assert.equal(valueProblem('é/'.repeat(170), { cwd }, env), null);
  assert.equal(valueProblem('é/'.repeat(171), { cwd }, env).short, 'argument too long');
});

test('L1: the 1000-byte limit on the joined path stays as a backstop, with the same message', () => {
  const deep = path.join(base, ...Array(8).fill('d'.repeat(100)));
  assert.ok(Buffer.byteLength(deep) > 800);
  const fits = Buffer.byteLength(`${deep}/`);
  const value = (length) => `${'n'.repeat(length - 1)}x`;
  assert.equal(valueProblem(value(1000 - fits), { cwd: deep }, env), null);
  assert.deepEqual(valueProblem(value(1001 - fits), { cwd: deep }, env), { reason: 'the argument is too long to check', short: 'argument too long' });
});

test('L1: a folder longer than 400 bytes is refused, one of exactly 400 is not', () => {
  const folder = (bytes) => {
    const parts = [];
    let used = Buffer.byteLength(base);
    while (used + 101 <= bytes) {
      parts.push('d'.repeat(100));
      used += 101;
    }
    const last = bytes - used - 1;
    if (last > 0) parts.push('e'.repeat(last));
    return path.join(base, ...parts);
  };
  assert.equal(Buffer.byteLength(folder(400)), 400);
  assert.equal(localFolderProblem(folder(400), env), null);
  assert.equal(localFolderProblem(folder(401), env), 'folder path is too long');
  const d = decideLocal(target({ cwd: folder(401) }), 'cat a.txt', env);
  assert.equal(d.short, 'folder not allowed');
});

test('L1: a directory that cannot be searched cannot be examined', { skip: isRoot }, () => {
  fs.chmodSync(lockedDir, 0o000);
  try {
    const d = decideLocal(target(), 'cat locked/inner', env);
    assert.equal(d.allowed, false);
    assert.equal(d.short, 'cannot be examined');
    assert.equal(d.reason, 'the argument locked/inner cannot be examined');
  } finally {
    fs.chmodSync(lockedDir, 0o700);
  }
});

test('L1: a name too long for the system cannot be examined, a dangling link and a loop are unresolvable', () => {
  const long = valueProblem('n'.repeat(300), { cwd }, env);
  assert.deepEqual(long, { reason: `the argument ${'n'.repeat(300)} cannot be examined`, short: 'cannot be examined' });
  assert.equal(valueProblem('dangling-bin', { cwd: base }, env).short, 'unresolvable link');
  assert.equal(valueProblem('loop-a', { cwd }, env).short, 'unresolvable link');
  assert.equal(valueProblem('loop-a/x', { cwd }, env).short, 'unresolvable link');
});

test('L1: harmless spellings are allowed: ./a.txt, sub//b.txt, ././a.txt, ., ./', () => {
  for (const command of ['cat ./a.txt', 'cat sub//b.txt', 'cat ././a.txt', 'cat .', 'cat ./', 'cat sub/./b.txt', 'cat ./sub/', 'cat .//a.txt']) {
    const d = decideLocal(target(), command, env);
    assert.equal(d.allowed, true, `${command}: ${d.reason}`);
    assert.deepEqual(d.argv, command.split(' '));
  }
});

test('L1: simplifying does not hide a link, a missing file or a dotted name', () => {
  assert.equal(valueProblem('./././link', { cwd }, env).short, 'outside the folder');
  assert.equal(valueProblem('sub/./../x', { cwd }, env).short, 'contains ".."');
  assert.equal(valueProblem('.a/./.b', { cwd }, env), null);
  assert.equal(valueProblem('/./', { cwd }, env).short, 'ksproxy files');
  assert.equal(valueProblem('//', { cwd }, env).short, 'ksproxy files');
  assert.equal(valueProblem(`${state}//session`, { cwd }, env).short, 'ksproxy files');
  assert.equal(valueProblem(`${state}/./session/.`, { cwd }, env).short, 'ksproxy files');
});

test('L1 through callTool: the padded link is refused and the outside file is never printed', async () => {
  writeSession(path.join(state, 'session'), {
    version: 1, pid: process.pid, startedAt: 'now', targets: [target({ path: '/usr/bin:/bin' })],
  });
  const r = await callTool('local_exec', { target: 'infra', command: `cat ${dots(497)}link` }, env);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('REFUSED (local infra): '), r.text);
  assert.ok(!r.text.includes('OUTSIDE-SECRET'), r.text);
  const ok = await callTool('local_exec', { target: 'infra', command: `cat ${dots(3)}a.txt` }, env);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(ok.text.endsWith('--- stdout ---\na'), ok.text);
});

test('realish: an error other than a missing path means null, a missing path or a file in the way climbs', () => {
  for (const code of ['ENAMETOOLONG', 'EACCES', 'ELOOP', 'EPERM', 'EIO']) {
    const lstat = () => {
      throw Object.assign(new Error(code), { code });
    };
    assert.equal(realish(path.join(cwd, 'x'), lstat), null, code);
  }
  const missing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(realish('/x/y/z', missing('ENOENT')), '/x/y/z');
  assert.equal(realish('/x/y/z', missing('ENOTDIR')), '/x/y/z');
  assert.equal(realish(path.join(cwd, 'a.txt', 'x', 'y')), path.join(cwd, 'a.txt', 'x', 'y'));
  assert.equal(realish(path.join(cwd, 'new', 'deeper')), path.join(cwd, 'new', 'deeper'));
});

test('realish: a path too long for the system is null', () => {
  assert.equal(realish(path.join(cwd, 'n'.repeat(300))), null);
  assert.equal(realish(path.join(cwd, ...Array(3000).fill('x'))), null);
});

test('cleanPath: relative and empty entries and entries inside the folder are dropped', () => {
  assert.equal(cleanPath('.:/usr/bin:/bin', [cwd]), '/usr/bin:/bin');
  assert.equal(cleanPath(':/usr/bin', [cwd]), '/usr/bin');
  assert.equal(cleanPath('node_modules/.bin:/usr/bin', [cwd]), '/usr/bin');
  assert.equal(cleanPath('/usr/bin:', [cwd]), '/usr/bin');
  assert.equal(cleanPath(`${cwd}/bin:/usr/bin`, [cwd]), '/usr/bin');
  assert.equal(cleanPath(`${cwd}:/usr/bin`, [cwd]), '/usr/bin');
  assert.equal(cleanPath(`${cwd}/tools:/usr/bin`, [cwd]), '/usr/bin');
  assert.equal(cleanPath(`${path.join(base, 'toolslink')}:/usr/bin`, [cwd]), '/usr/bin');
  assert.equal(cleanPath(`${base}/nowhere/../work/bin:/usr/bin`, [cwd]), '/usr/bin');
});

test('cleanPath: safe entries stay as written and in order', () => {
  assert.equal(cleanPath(`/usr/bin:${base}/other:/bin`, [cwd]), `/usr/bin:${base}/other:/bin`);
  assert.equal(cleanPath(`${cwd}2/bin:/usr/bin`, [cwd]), `${cwd}2/bin:/usr/bin`);
});

test('cleanPath: nothing left gives the default, also for an empty, missing or odd value', () => {
  for (const value of ['', undefined, null, ':::', '.', 'bin', 5, `${cwd}/bin`, path.join(base, 'dangling-bin')]) {
    assert.equal(cleanPath(value, [cwd]), '/usr/bin:/bin', String(value));
  }
});

test('cleanPath: an entry that cannot be resolved is dropped, and so is everything when the folder cannot be resolved', () => {
  assert.equal(cleanPath(`${path.join(base, 'dangling-bin')}:/usr/bin`, [cwd]), '/usr/bin');
  assert.equal(cleanPath('/usr/bin:/bin', [path.join(base, 'dangling-bin')]), '/usr/bin:/bin');
  assert.equal(cleanPath(`${base}/other:/opt/x`, [path.join(base, 'dangling-bin')]), '/usr/bin:/bin');
});

test('L2 precondition: with a relative PATH entry the program of the same name in the folder is the one that runs', async () => {
  const planted = path.join(cwd, 'uname');
  fs.writeFileSync(planted, '#!/bin/sh\necho PLANTED\n', { mode: 0o755 });
  try {
    const r = await run('uname', [], { cwd, env: { PATH: '.' } });
    assert.equal(r.stdout, 'PLANTED\n');
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test('L2 through callTool: a program planted in the folder does not run for a PATH that points at the folder', async () => {
  const planted = path.join(cwd, 'uname');
  fs.writeFileSync(planted, '#!/bin/sh\necho PLANTED\n', { mode: 0o755 });
  try {
    for (const bad of ['.', '', cwd, `:${cwd}/tools`, `${cwd}/tools:`, 'tools', path.join(base, 'toolslink')]) {
      writeSession(path.join(state, 'session'), {
        version: 1, pid: process.pid, startedAt: 'now', targets: [target({ allow: ['uname'], path: bad })],
      });
      const r = await callTool('local_exec', { target: 'infra', command: 'uname' }, env);
      assert.ok(!r.text.includes('PLANTED'), `${JSON.stringify(bad)}: ${r.text}`);
      assert.equal(r.isError, false, `${JSON.stringify(bad)}: ${r.text}`);
      assert.match(r.text, /^exit code: 0\n--- stdout ---\n(Darwin|Linux)/);
    }
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

test('L2 through callTool: a session without a path runs with the default one', async () => {
  const noPath = target({ allow: ['uname'] });
  delete noPath.path;
  writeSession(path.join(state, 'session'), {
    version: 1, pid: process.pid, startedAt: 'now', targets: [noPath],
  });
  const r = await callTool('local_exec', { target: 'infra', command: 'uname' }, env);
  assert.equal(r.isError, false, r.text);
});

test('L3: sessionProtected lists the kubeconfigs, then both own folders as configured and real, without duplicates', () => {
  const viaLink = path.join(base, 'state-link');
  fs.symlinkSync(state, viaLink);
  const list = sessionProtected(['/k/one.yaml', '/k/one.yaml'], { ...env, KSPROXY_STATE_DIR: viaLink });
  assert.deepEqual(list, ['/k/one.yaml', viaLink, state, cfg]);
  assert.deepEqual(sessionProtected([], env), [state, cfg]);
  assert.deepEqual(sessionProtected([]).length > 0, true);
});

test('L3: folders recorded by start stay protected when the environment of the reader does not set them', () => {
  const recorded = target({ protected: sessionProtected([], env) });
  const elsewhere = { ...env };
  delete elsewhere.KSPROXY_CONFIG_DIR;
  delete elsewhere.KSPROXY_STATE_DIR;
  for (const file of [cfg, path.join(cfg, 'inventory.json'), state, path.join(state, 'session', 'session.json')]) {
    const d = valueProblem(file, recorded, elsewhere);
    assert.equal(d.short, 'ksproxy files', file);
  }
  assert.equal(valueProblem(`${cfg}/inventory.json`, target(), elsewhere).short, 'outside the folder');
});

test('L3: a link into the recorded config folder is refused as ksproxy files from another environment too', () => {
  const recorded = target({ protected: sessionProtected([], env) });
  fs.symlinkSync(cfg, path.join(cwd, 'cfglink'));
  try {
    const elsewhere = { HOME: env.HOME };
    assert.equal(decideLocal(recorded, 'cat cfglink/inventory.json', elsewhere).short, 'ksproxy files');
  } finally {
    fs.rmSync(path.join(cwd, 'cfglink'));
  }
});

const insensitiveFs = (() => {
  const probe = tempDir('ks-CaSe-');
  try {
    return fs.existsSync(probe.toLowerCase());
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

test('L5: the folder is replaced in other letter cases on a case-insensitive platform only', () => {
  const session = { targets: [{ kind: 'local', name: 'x', cwd: '/tmp/ks-case/myproj' }] };
  const text = 'a /tmp/ks-case/myproj/x b /tmp/KS-case/MyProj/y c /tmp/ks-case/myprojx';
  assert.equal(scrubOutput(text, session, env, true), 'a <folder>/x b <folder>/y c /tmp/ks-case/myprojx');
  assert.equal(scrubOutput(text, session, env, false), 'a <folder>/x b /tmp/KS-case/MyProj/y c /tmp/ks-case/myprojx');
  assert.equal(scrubOutput('/TMP/KS-CASE/MYPROJ', session, env, true), '<folder>');
});

test('L5: the folder as resolved and as the system spells it are replaced, and a cwd of // is left alone', () => {
  const real = path.join(base, 'RealName');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(base, 'alias'));
  const viaAlias = path.join(base, 'alias', '.');
  const session = { targets: [{ kind: 'local', name: 'x', cwd: viaAlias }] };
  assert.equal(scrubOutput(`in ${real}/f and ${base}/alias/f and ${base}/z`, session, env, false), `in <folder>/f and <folder>/f and ${base}/z`);
  fs.symlinkSync('/', path.join(base, 'rootlink'));
  const toRoot = { targets: [{ kind: 'local', name: 'x', cwd: path.join(base, 'rootlink') }] };
  assert.equal(scrubOutput('/usr/bin/env', toRoot, env, true), '/usr/bin/env');
  assert.equal(scrubOutput(`${base}/rootlink/usr`, toRoot, env, true), '<folder>/usr');
  const special = { targets: [{ kind: 'local', name: 'x', cwd: '/tmp/ks.case+(1)' }] };
  assert.equal(scrubOutput('/tmp/ks.case+(1)/a /tmp/ksXcase+(1)/a', special, env, true), '<folder>/a /tmp/ksXcase+(1)/a');
  assert.equal(scrubOutput('default platform', special, env), 'default platform');
});

test('L5 through callTool: a folder whose letter case differs from the configured one is not leaked by pwd', { skip: insensitiveFs ? false : 'case-sensitive file system' }, async () => {
  const onDisk = path.join(base, 'MyProj');
  fs.mkdirSync(onDisk);
  const configured = path.join(base, 'myproj');
  writeSession(path.join(state, 'session'), {
    version: 1, pid: process.pid, startedAt: 'now', targets: [target({ cwd: configured, allow: ['pwd'], path: '/usr/bin:/bin' })],
  });
  const r = await callTool('local_exec', { target: 'infra', command: 'pwd' }, env);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('<folder>'), r.text);
  assert.ok(!r.text.includes('MyProj') && !r.text.includes('myproj'), r.text);
});

const D = '/System/Volumes/Data';
const missing = () => {
  throw Object.assign(new Error('gone'), { code: 'ENOENT' });
};

test('B1 realish: on darwin only, exactly the leading /System/Volumes/Data component is dropped', () => {
  assert.equal(realish(`${D}/Users/x`, missing, 'darwin'), '/Users/x');
  assert.equal(realish(D, missing, 'darwin'), '/');
  assert.equal(realish(`${D}/`, missing, 'darwin'), '/');
  assert.equal(realish(`${D}${D}/x`, missing, 'darwin'), `${D}/x`);
  assert.equal(realish(`${D}X/Users`, missing, 'darwin'), `${D}X/Users`);
  assert.equal(realish(`${D}2`, missing, 'darwin'), `${D}2`);
  assert.equal(realish(`/Users${D}/x`, missing, 'darwin'), `/Users${D}/x`);
  assert.equal(realish('/system/volumes/data/Users', missing, 'darwin'), '/system/volumes/data/Users');
  assert.equal(realish('/System/Volumes/Preboot/x', missing, 'darwin'), '/System/Volumes/Preboot/x');
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.equal(realish(`${D}/Users/x`, missing, platform), `${D}/Users/x`, platform);
    assert.equal(realish(D, missing, platform), D, platform);
  }
  assert.equal(realish(`${D}/Users/x`, missing), process.platform === 'darwin' ? '/Users/x' : `${D}/Users/x`);
});

test('B1 realish: an existing path in the Data spelling has the same real path as the plain one on darwin, and is kept elsewhere', () => {
  const real = realish(path.join(cwd, 'a.txt'), undefined, 'darwin');
  assert.equal(real, path.join(cwd, 'a.txt'));
  assert.equal(realish(`${D}${real}`, undefined, 'darwin'), real);
  assert.equal(realish(`${D}${path.join(cwd, 'link')}`, undefined, 'darwin'), process.platform === 'darwin' ? path.join(base, 'outside.txt') : path.join(base, 'work', 'link'));
  assert.equal(realish(`${D}${real}`, undefined, 'linux'), `${D}${real}`);
});

test('B1: a folder given in the /System/Volumes/Data spelling is treated exactly like the plain spelling', () => {
  const dataCwd = `${D}${cwd}`;
  assert.equal(localFolderProblem(dataCwd, env, [], 'darwin'), null);
  assert.equal(localFolderProblem(cwd, env, [], 'darwin'), null);
  const protectedFile = path.join(cwd, 'sub', 'kube.yaml');
  assert.equal(localFolderProblem(dataCwd, env, [protectedFile], 'darwin'), 'folder contains a kubeconfig named in the inventory');
  assert.equal(localFolderProblem(cwd, env, [`${D}${protectedFile}`], 'darwin'), 'folder contains a kubeconfig named in the inventory');
  for (const command of ['cat a.txt', 'cat sub/b.txt', 'cat ./missing.txt', 'cat ../x', 'cat /etc/hosts', 'cat -n a.txt']) {
    const plain = decideLocal(target(), command, env, 'darwin');
    const viaData = decideLocal(target({ cwd: dataCwd }), command, env, 'darwin');
    assert.deepEqual(viaData, plain, command);
  }
  assert.equal(decideLocal(target({ cwd: dataCwd }), 'cat a.txt', env, 'darwin').allowed, true);
});

test('B1: links are judged the same way through the Data spelling', { skip: process.platform !== 'darwin' }, () => {
  const dataCwd = `${D}${cwd}`;
  for (const command of ['cat link', 'cat kclink', 'cat self/link', 'cat ./self/./kclink']) {
    const plain = decideLocal(target(), command, env, 'darwin');
    const viaData = decideLocal(target({ cwd: dataCwd }), command, env, 'darwin');
    assert.equal(plain.allowed, false, command);
    assert.deepEqual(viaData, plain, command);
  }
  assert.equal(decideLocal(target({ cwd: dataCwd }), 'cat kclink', env, 'darwin').short, 'ksproxy files');
});

test('B1: the home folder and ksproxy folders given in the Data spelling are refused', () => {
  const home = path.join(base, 'home');
  assert.equal(localFolderProblem(`${D}${home}`, env, [], 'darwin'), `folder is too broad: pick a project folder, not ${D}${home}`);
  assert.equal(localFolderProblem(`${D}${base}`, env, [], 'darwin'), `folder is too broad: pick a project folder, not ${D}${base}`);
  assert.equal(localFolderProblem(`${D}${state}`, env, [], 'darwin'), "folder overlaps ksproxy's own files");
  assert.equal(localFolderProblem(`${D}${cfg}/x`, env, [], 'darwin'), "folder overlaps ksproxy's own files");
  assert.equal(localFolderProblem(`${D}${home}`, env, [], 'linux'), null);
  const d = decideLocal(target({ cwd: `${D}${home}` }), 'cat a.txt', env, 'darwin');
  assert.equal(d.short, 'folder not allowed');
});

// The filesystem calls one decision makes, counted on the fs functions the local kind uses, and its result.
function counted(t, decideIt) {
  let calls = 0;
  for (const [owner, name] of [[fs, 'lstatSync'], [fs, 'statSync'], [fs.realpathSync, 'native']]) {
    const real = owner[name];
    t.mock.method(owner, name, (...args) => {
      calls += 1;
      return real(...args);
    });
  }
  try {
    const decision = decideIt();
    return { calls, decision };
  } finally {
    t.mock.restoreAll();
  }
}

// A wall-clock limit only as a last guard against a run that never ends; the counts above prove the cost, and they
// do not depend on the load of the machine.
const LAST_GUARD_MS = 15000;

test('B2: a command with 2,000 arguments and 50 protected entries checks each distinct argument once', (t) => {
  const protectedList = Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? path.join(base, `kube-${i}.yaml`) : path.join(base, 'cfg', `kube-${i}.yaml`)));
  const args = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 'a' : '.'));
  const command = `cat ${args.join(' ')}`;
  assert.ok(Buffer.byteLength(command) <= 4096);
  const decideFor = (text) => () => decideLocal(target({ allow: ['cat ...'], protected: protectedList }), text, env);
  const two = counted(t, decideFor('cat a .'));
  const started = Date.now();
  const many = counted(t, decideFor(command));
  const elapsed = Date.now() - started;
  assert.equal(many.decision.allowed, true, many.decision.reason);
  assert.equal(many.decision.argv.length, 2001);
  assert.equal(many.calls, two.calls, 'the same two distinct arguments cost the same, however often they come');
  assert.ok(elapsed < LAST_GUARD_MS, `took ${elapsed} ms`);
});

test('B2: about 1,300 distinct arguments and 50 protected entries cost the same per argument, not per protected entry', (t) => {
  const protectedList = Array.from({ length: 50 }, (_, i) => path.join(base, `kube-${i}.yaml`));
  const args = Array.from({ length: 1296 }, (_, i) => i.toString(36));
  assert.equal(new Set(args).size, 1296);
  const command = `cat ${args.join(' ')}`;
  assert.ok(Buffer.byteLength(command) <= 4096);
  const decideFor = (text, list) => () => decideLocal(target({ allow: ['cat ...'], protected: list }), text, env);
  const none = counted(t, decideFor('cat', protectedList));
  const one = counted(t, decideFor('cat zz', protectedList));
  const perArgument = one.calls - none.calls;
  const started = Date.now();
  const all = counted(t, decideFor(command, protectedList));
  const elapsed = Date.now() - started;
  assert.equal(all.decision.allowed, true, all.decision.reason);
  assert.ok(perArgument >= 1, 'an argument is checked on the filesystem');
  assert.equal(all.calls - none.calls, perArgument * 1296, 'each argument costs the same calls, whatever the protected list');
  const fewer = counted(t, decideFor(command, protectedList.slice(0, 1)));
  const fewerNone = counted(t, decideFor('cat', protectedList.slice(0, 1)));
  assert.equal(fewer.calls - fewerNone.calls, all.calls - none.calls, 'the protected entries add nothing per argument');
  assert.ok(elapsed < LAST_GUARD_MS, `took ${elapsed} ms`);
});

test('B2: rules that all match loosely do not repeat the work for the same argument', (t) => {
  const protectedList = Array.from({ length: 50 }, (_, i) => path.join(base, `kube-${i}.yaml`));
  const args = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 'a' : '.'));
  const decideWith = (rules, text) => () => decideLocal(target({ allow: rules, protected: protectedList }), text, env);
  const rules = Array.from({ length: 30 }, () => 'cat ...');
  const started = Date.now();
  const refused = counted(t, decideWith(rules, `cat ${args.join(' ')} sub/../x`));
  const allowed = counted(t, decideWith(rules, `cat ${args.join(' ')}`));
  const elapsed = Date.now() - started;
  assert.equal(refused.decision.short, 'contains ".."');
  assert.equal(allowed.decision.allowed, true);
  assert.equal(allowed.calls, counted(t, decideWith(['cat ...'], `cat ${args.join(' ')}`)).calls, '30 rules cost what one rule costs');
  assert.equal(allowed.calls, counted(t, decideWith(['cat ...'], 'cat a .')).calls, 'and 2,000 arguments what two cost');
  assert.ok(elapsed < LAST_GUARD_MS, `took ${elapsed} ms`);
});

test('B3 cleanPath: an entry inside any local target folder is dropped, entries elsewhere stay', () => {
  const other = path.join(base, 'other');
  fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
  const value = `${path.join(other, 'bin')}:/usr/bin:${path.join(cwd, 'tools')}:${path.join(base, 'elsewhere')}`;
  assert.equal(cleanPath(value, [cwd, other]), `/usr/bin:${path.join(base, 'elsewhere')}`);
  assert.equal(cleanPath(value, [cwd]), `${path.join(other, 'bin')}:/usr/bin:${path.join(base, 'elsewhere')}`);
  assert.equal(cleanPath(value, [other]), `/usr/bin:${path.join(cwd, 'tools')}:${path.join(base, 'elsewhere')}`);
  assert.equal(cleanPath(value, []), value);
  assert.equal(cleanPath(`${path.join(base, 'toolslink')}:/usr/bin`, [other, cwd]), '/usr/bin');
  assert.equal(cleanPath(value, [other, path.join(base, 'dangling-bin')]), '/usr/bin:/bin');
  assert.equal(cleanPath(`${D}${path.join(other, 'bin')}:/usr/bin`, [other], 'darwin'), '/usr/bin');
});

test('B3 through callTool: with targets A and B, a PATH entry inside B is not used when running on A', async () => {
  const other = path.join(base, 'other-b');
  fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(other, 'bin', 'uname'), '#!/bin/sh\necho PLANTED-B\n', { mode: 0o755 });
  const sessionDir = path.join(state, 'session');
  const a = target({ allow: ['uname'], path: `${path.join(other, 'bin')}:/usr/bin:/bin` });
  const b = { kind: 'local', name: 'second', cwd: other, allow: ['ls'], path: '/usr/bin:/bin', protected: [] };
  writeSession(sessionDir, { version: 1, pid: process.pid, startedAt: 'now', targets: [a] });
  const alone = await callTool('local_exec', { target: 'infra', command: 'uname' }, env);
  assert.ok(alone.text.includes('PLANTED-B'), alone.text);
  writeSession(sessionDir, { version: 1, pid: process.pid, startedAt: 'now', targets: [a, b] });
  const both = await callTool('local_exec', { target: 'infra', command: 'uname' }, env);
  assert.equal(both.isError, false, both.text);
  assert.ok(!both.text.includes('PLANTED-B'), both.text);
  assert.match(both.text, /^exit code: 0\n--- stdout ---\n(Darwin|Linux)/);
});

test('B5 scrubOutput: a path is replaced only where no path character follows it', () => {
  const session = { targets: [{ kind: 'local', name: 'x', cwd: '/tmp/ks-sb/a' }] };
  assert.equal(scrubOutput('/tmp/ks-sb/abc /tmp/ks-sb/a/b /tmp/ks-sb/a', session, env, false), '/tmp/ks-sb/abc <folder>/b <folder>');
  for (const follow of ['b', 'B', '0', '_']) {
    assert.equal(scrubOutput(`x /tmp/ks-sb/a${follow}`, session, env, false), `x /tmp/ks-sb/a${follow}`, follow);
  }
  assert.equal(scrubOutput('/tmp/ks-sb/a. /tmp/ks-sb/a-1', session, env, false), '<folder>. <folder>-1');
  for (const follow of ['/', ':', ' ', ')', '\n', ',', '"', '', '.', '-']) {
    assert.equal(scrubOutput(`x /tmp/ks-sb/a${follow}`, session, env, false), `x <folder>${follow}`, JSON.stringify(follow));
  }
  assert.equal(scrubOutput('/TMP/KS-SB/A/b /TMP/KS-SB/Ab', session, env, true), '<folder>/b /TMP/KS-SB/Ab');
});

test('B5 scrubOutput: the longer path wins where both could match, and text already replaced is never rewritten', () => {
  const session = { targets: [{ kind: 'local', name: 'x', cwd: '/tmp/ks-sb/a' }, { kind: 'local', name: 'y', cwd: '/tmp/ks-sb/a/deep' }] };
  assert.equal(scrubOutput('/tmp/ks-sb/a/deep/f /tmp/ks-sb/a/g', session, env, false), '<folder>/f <folder>/g');
  const relative = { targets: [{ kind: 'local', name: 'x', cwd: 'folder' }] };
  assert.equal(scrubOutput(`${process.cwd()}/folder/x and folder`, relative, env, false), '<folder>/x and <folder>');
  const both = { targets: [{ kind: 'local', name: 'x', cwd: 'ksproxy' }] };
  const out = scrubOutput(`${state}/s ${process.cwd()}/ksproxy/y`, both, env, false);
  assert.equal(out, '<ksproxy>/s <folder>/y');
  assert.equal(scrubOutput('nothing here', { targets: [] }, { KSPROXY_STATE_DIR: '/' }, false), 'nothing here');
});

test('B5 scrubOutput: the plain spelling of a folder given in the Data spelling is hidden on darwin only', () => {
  const session = { targets: [{ kind: 'local', name: 'x', cwd: `${D}/Users/ks-nobody/proj` }] };
  const text = `in /Users/ks-nobody/proj/f and ${D}/Users/ks-nobody/proj/g`;
  assert.equal(scrubOutput(text, session, env, false, 'darwin'), 'in <folder>/f and <folder>/g');
  assert.equal(scrubOutput(text, session, env, false, 'linux'), `in /Users/ks-nobody/proj/f and <folder>/g`);
});
