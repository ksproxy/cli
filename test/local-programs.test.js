import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { allowWarnings } from '../src/allowlist.js';
import { agentMdText } from '../src/agent-md.js';
import { main } from '../src/cli.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { writeSession } from '../src/session.js';
import { callTool, reviewRoute } from '../src/tools.js';
import localKind from '../src/kinds/local/index.js';
import {
  covers, isPath, pathsOf, reviewProblem,
} from '../src/kinds/local/folder.js';
import {
  ACTING_PREFIXES, ACTING_PROGRAMS, REFUSED_OPTIONS, actingPrograms, argumentValues, programNames, programsOf,
  sedScriptRefused, sedScripts,
} from '../src/kinds/local/scope.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';
import { tempDir } from './temp.js';

const decideLocal = localKind.decide;
const STATE = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const PATHS = ['docs', 'README.md', 'assets/*.png'];
const PROGRAMS = [
  'cat', 'grep', 'sed', 'gsed', 'ls', 'head', 'echo', 'touch', 'find', 'gfind', 'tar', 'gtar', 'bsdtar', 'gnutar',
  'cpio', 'bsdcpio', 'pax', 'zip', 'unzip', 'sh', 'python3', 'git', 'sort', 'gsort', 'split', 'gsplit', 'install', 'ginstall',
  'sdiff', 'diff3', 'cp', 'rm',
];
const ACTING = 'the agent can use them with your whole account';

let base;
let cwd;
let env;
let target;
let savedHome;

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(tempDir('ks-lp-'));
  cwd = path.join(base, 'work');
  for (const dir of ['work/docs/sub', 'work/docs/private', 'work/docs/.hidden', 'work/assets', 'work/src', 'st/session', 'st/logs', 'cfg', 'home', 'outdir']) {
    fs.mkdirSync(path.join(base, dir), { recursive: true });
  }
  const files = {
    'work/docs/a.md': 'hello docs\n',
    'work/docs/sub/b.md': 'b\n',
    'work/docs/private/x.md': 'x\n',
    'work/docs/server.pem': 'p\n',
    'work/docs/.notes.md': 'notes\n',
    'work/docs/.hidden/c.md': 'c\n',
    'work/README.md': 'readme\n',
    'work/assets/logo.png': 'png\n',
    'work/assets/notes.txt': 'notes\n',
    'work/src/b.js': 'secret source\n',
    'work/-notes': 'dash\n',
    'outside.txt': 'outside\n',
    'kube.yaml': 'apiVersion: v1\n',
    'st/session/session.json': '{}\n',
  };
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(base, file), text);
  const links = {
    'work/docs/out': path.join(base, 'outside.txt'),
    'work/docs/outdir': path.join(base, 'outdir'),
    'work/docs/tosrc': path.join(cwd, 'src'),
    'work/srclink': path.join(cwd, 'docs'),
    'work/docs/stlink': path.join(base, 'st'),
    'work/docs/kubelink': path.join(base, 'kube.yaml'),
    'work/docs/dangling': path.join(base, 'nothing-here'),
  };
  for (const [link, to] of Object.entries(links)) fs.symlinkSync(to, path.join(base, link));
  process.env.HOME = path.join(base, 'home');
  env = { [STATE]: path.join(base, 'st'), [CONFIG]: path.join(base, 'cfg') };
  target = {
    kind: 'local',
    name: 'docs',
    cwd,
    allow: ['git status', 'git diff ...'],
    paths: PATHS,
    listedPrograms: PROGRAMS,
    protected: [path.join(base, 'kube.yaml')],
  };
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanupAll();
});

const decide = (command, extra = {}, platform = undefined) => decideLocal({ ...target, ...extra }, command, env, platform);

function allowed(command, extra, rule = `programs: ${command.split(' ')[0]}`) {
  const d = decide(command, extra);
  assert.equal(d.allowed, true, `${command}: ${d.reason}`);
  assert.equal(d.rule, rule, command);
  assert.deepEqual(d.argv, command.split(' '));
}

function refused(command, short, extra) {
  const d = decide(command, extra);
  assert.equal(d.allowed, false, command);
  assert.equal(d.short, short, `${command}: ${d.reason}`);
  assert.equal(Object.hasOwn(d, 'argv'), false, command);
  assert.equal(Object.hasOwn(d, 'unmatched'), false, command);
  return d;
}

function rejects(local, pattern) {
  assert.throws(() => validateInventory({ local: [{ name: 'docs', cwd: '/srv/docs', ...local }] }), (err) => {
    assert.ok(err instanceof InventoryError, err.message);
    assert.match(err.message, pattern);
    return true;
  });
}

const valid = (local) => validateInventory({ local: [{ name: 'docs', cwd: '/srv/docs', ...local }] }).local[0];
const reviewers = { r1: { baseUrl: 'http://localhost:11434/v1', model: 'm' } };

// The inventory.

test('programs is kept with paths, next to listed rules, and paths are cleaned like protect', () => {
  const names = ['cat', 'grep', 'python3.12', 'g++', 'x_y-z.1', 'A9'];
  const t = valid({ allow: ['git status'], programs: names, paths: ['./docs/', 'README.md', 'assets//*.png', '.', '**/*.md', 'docs/**/x'] });
  assert.deepEqual(t.allow, ['git status']);
  assert.deepEqual(t.programs, names);
  assert.deepEqual(t.paths, ['docs', 'README.md', 'assets/*.png', '.', '**/*.md', 'docs/**/x']);
  assert.deepEqual(valid({ programs: ['cat'], paths: ['./'] }), {
    kind: 'local', name: 'docs', cwd: '/srv/docs', description: '', allow: [], paths: ['.'], programs: ['cat'],
  });
  assert.equal(Object.hasOwn(valid({ allow: ['cat *'] }), 'programs'), false);
  assert.doesNotThrow(() => valid({ programs: Array.from({ length: 50 }, (_, i) => `p${i}`), paths: ['docs'] }));
});

test('review may be used with programs, and paths without programs is allowed and kept', () => {
  const reviewed = validateInventory({
    reviewers,
    local: [{
      name: 'docs', cwd: '/srv/docs', programs: ['cat'], paths: ['docs'], review: { reviewer: 'r1', policy: 'read only', programs: ['ls'] },
    }],
  }).local[0];
  assert.deepEqual(reviewed.programs, ['cat']);
  assert.deepEqual(reviewed.review.programs, ['ls']);
  const t = valid({ allow: ['cat *'], paths: ['docs'] });
  assert.deepEqual(t.paths, ['docs']);
  assert.equal(Object.hasOwn(t, 'programs'), false);
  assert.equal(Object.hasOwn(valid({ allow: ['cat *'] }), 'paths'), false);
});

test('programs without paths is an inventory error', () => {
  rejects({ programs: ['cat'] }, /^local "docs": programs: needs "paths", the files and folders its commands may name$/);
  rejects({ allow: ['git status'], programs: ['cat', 'grep'], protect: ['docs'] }, /^local "docs": programs: needs "paths"/);
});

test('a programs list that is not 1 to 50 bare names without repeats is an inventory error', () => {
  const list = /^local "docs": programs: must be a list of 1 to 50 program names, for example \["cat", "grep"\]$/;
  for (const programs of ['cat', [], {}, Array.from({ length: 51 }, (_, i) => `p${i}`)]) rejects({ programs, paths: ['docs'] }, list);
  const bare = /^local "docs": programs\[1\]: must be a bare program name: letters, digits and _ \. \+ -, not starting with "-", and no "\/"$/;
  for (const name of [5, null, '', '-x', '--', './run.sh', '/usr/bin/cat', 'docs/cat', 'a b', 'a*', 'cat;', 'ca$t', 'é', 'a:b', 'a@b']) {
    rejects({ programs: ['cat', name], paths: ['docs'] }, bare);
  }
  rejects({ programs: ['cat', 'grep', 'cat'], paths: ['docs'] }, /^local "docs": programs\[2\]: cat is listed twice$/);
  rejects({ programs: ['-x'] }, /^local "docs": programs\[0\]: must be a bare program name/);
});

test('"* ..." and every other rule that starts with * or ... is an inventory error, with or without paths and programs', () => {
  for (const rule of ['* ...', '  *   ...  ', '*', '* *', '* docs/...', '...', '* status', '* x ...']) {
    rejects({ allow: [rule] }, /^local "docs": allow\[0\]: a local rule must start with the program name$/);
    rejects({ allow: [rule], paths: ['docs'], programs: ['cat'] }, /^local "docs": allow\[0\]: a local rule must start with the program name$/);
  }
  rejects({ allow: 'any', paths: ['docs'], programs: ['cat'] }, /^local "docs": allow: "any" is not supported for local targets; list the commands$/);
});

test('bad paths entries are inventory errors, like bad protect entries, and come before the programs errors', () => {
  const list = /^local "docs": paths: must be a list of 1 to 50 paths or patterns inside the folder$/;
  for (const paths of ['docs', [], {}, Array.from({ length: 51 }, (_, i) => `d${i}`)]) rejects({ paths, programs: 5 }, list);
  const size = /^local "docs": paths\[0\]: must be a path of 1 to 512 bytes without control characters$/;
  for (const entry of [5, '', 'a'.repeat(513), 'docs\u0000x', 'docs\nx']) rejects({ paths: [entry] }, size);
  const relative = /^local "docs": paths\[0\]: must be relative to the folder, not an absolute path or one that starts with "~"$/;
  for (const entry of ['/srv/docs', '~/docs']) rejects({ paths: [entry] }, relative);
  for (const entry of ['..', 'docs/../src', '../x']) rejects({ paths: [entry] }, /^local "docs": paths\[0\]: may not contain "\.\."$/);
  rejects({ paths: ['docs', './docs/'] }, /^local "docs": paths\[1\]: docs is listed twice$/);
  rejects({ paths: ['.', './'] }, /^local "docs": paths\[1\]: \. is listed twice$/);
  for (const entry of ['docs/**.md', 'a**', '**b/x']) {
    rejects({ paths: [entry] }, /^local "docs": paths\[0\]: "\*\*" must be a whole part, as in docs\/\*\*\/\*\.md$/);
  }
  assert.doesNotThrow(() => valid({ paths: Array.from({ length: 50 }, (_, i) => `d${i}`) }));
  assert.doesNotThrow(() => valid({ paths: ['a'.repeat(512)] }));
});

test('paths and programs are for local targets only', () => {
  assert.throws(() => validateInventory({ ssh: [{ name: 'web1', host: 'web1.example.com', paths: ['docs'] }] }), /unknown key "paths"/);
  assert.throws(() => validateInventory({ ssh: [{ name: 'web1', host: 'web1.example.com', programs: ['cat'] }] }), /unknown key "programs"/);
});

test('protect keeps its own messages after sharing its entry checks with paths', () => {
  rejects({ protect: ['.'] }, /^local "docs": protect\[0\]: names the folder itself; list a file or folder inside it$/);
  rejects({ protect: ['a/../b'] }, /^local "docs": protect\[0\]: may not contain "\.\."$/);
  rejects({ protect: ['/a'] }, /^local "docs": protect\[0\]: must be relative to the folder/);
  rejects({ protect: [''] }, /^local "docs": protect\[0\]: must be a path of 1 to 512 bytes without control characters$/);
});

// Listed rules and programs in one target.

test('the rules in allow are tried first, then programs', () => {
  allowed('git status', {}, 'git status');
  allowed('git diff docs/a.md', {}, 'git diff ...');
  allowed('git log');
  allowed('git diff --stat');
  allowed('git log', { listedPrograms: ['git'], allow: ['git log', 'git status'] }, 'git log');
});

test('a rule whose path is outside paths gives that refusal; programs give the same one for the same path', () => {
  const d = refused('git diff src/b.js', 'outside paths');
  assert.equal(d.reason, 'the argument src/b.js is outside the paths this target allows: docs, README.md, assets/*.png');
  const rule = refused('git diff src/b.js', 'outside paths', { listedPrograms: ['cat'] });
  assert.equal(rule.reason, d.reason);
  refused('cat src/b.js', 'outside paths', { allow: ['cat *'] });
  refused('git diff /etc/hosts', 'not a plain path');
  refused('git diff /etc/hosts', 'not a plain argument', { listedPrograms: ['cat'] });
});

test('no program is refused for being listed: the owner chose it', () => {
  for (const name of ['sh', 'python3', 'git']) allowed(`${name} docs/a.md`);
});

test('a program that is not listed, or not written exactly as listed, is not on the allowlist, and the reason names the programs', () => {
  const list = PROGRAMS.join(', ');
  for (const name of ['wc', 'CAT', 'cat2', './cat', '/bin/cat', 'docs/cat', 'cat.']) {
    const d = decide(`${name} docs/a.md`);
    assert.equal(d.allowed, false, name);
    assert.equal(d.short, 'not on allowlist', name);
    assert.equal(d.unmatched, true, name);
    assert.equal(d.reason, `not on the allowlist for this target. Allowed: git status; git diff ...; the program ${name} is not one of its programs: ${list}`);
  }
  const empty = decide('wc docs/a.md', { allow: [], listedPrograms: ['cat'] });
  assert.equal(empty.short, 'not on allowlist');
  assert.equal(empty.reason, 'not on the allowlist for this target. Allowed: nothing (empty allowlist); the program wc is not one of its programs: cat');
});

test('a regex rule that runs out of time keeps its own refusal on a target with programs', () => {
  const d = decide(`wc ${'a'.repeat(995)}`, { allow: ['regex(wc .*.*.*.*.*.*.*.*.*.*.*.*x)'] });
  assert.equal(d.short, 'regex rule too slow');
  assert.equal(d.unmatched, true);
});

// The options of decision 7.

test('find with -exec, -execdir, -ok or -okdir is refused', () => {
  for (const option of ['-exec', '-execdir', '-ok', '-okdir']) {
    const d = refused(`find docs ${option} cat`, 'option refused');
    assert.equal(d.reason, `the option ${option} of find can run other code or reach outside the paths, so it is always refused`);
    refused(`gfind docs ${option} cat`, 'option refused');
    refused(`find docs -name x ${option}`, 'option refused');
  }
  allowed('find docs -name a.md -type f');
  allowed('find docs -exe');
});

test('tar with a refused short option is refused, in a group of short flags and in its first word without a dash', () => {
  const commands = [
    'tar -I gzip -cf docs/a.tar docs', 'tar -xIf docs/a.tar', 'tar xIf gzip docs/a.tar', 'tar -cF x -f docs/a.tar docs',
    'tar cvfF docs/a.tar x', 'tar -xPf docs/a.tar', 'tar xPf docs/a.tar', 'tar -P -xf docs/a.tar', 'tar -C docs -xf docs/a.tar',
    'tar -xf docs/a.tar -Cdocs', 'tar xCf docs docs/a.tar', 'tar -cT docs/list -f docs/a.tar', 'tar cTf docs/list docs/a.tar',
  ];
  for (const command of commands) refused(command, 'option refused');
  for (const program of ['gtar', 'bsdtar', 'gnutar']) refused(`${program} -xPf docs/a.tar`, 'option refused');
});

test('tar with a refused long option is refused, whole or shortened', () => {
  const whole = [
    '--to-command=cat', '--use-compress-program', '--use-compress-program=gzip', '--checkpoint-action=exec=x', '--info-script=x',
    '--new-volume-script=x', '--rsh-command=x', '--rmt-command=x', '--absolute-names', '--absolute-paths', '--directory=docs',
    '--directory', '--cd', '--files-from=docs/list', '--insecure',
  ];
  const short = ['--to-com=cat', '--use=gzip', '--checkpoint-a=x', '--info=x', '--new-v=x', '--rsh=x', '--rmt=x', '--abs', '--dir=docs', '--files-f=docs/list', '--insec', '--to', '--c'];
  for (const option of [...whole, ...short]) {
    const d = refused(`tar ${option} -xf docs/a.tar`, 'option refused');
    assert.equal(d.reason, `the option ${option} of tar can run other code or reach outside the paths, so it is always refused`);
  }
  refused('bsdtar --cd docs -xf docs/a.tar', 'option refused');
});

test('tar options that only share a prefix with a refused option are not refused', () => {
  for (const command of [
    'tar --checkpoint=1 -cf docs/a.tar docs', 'tar --checkpoint -cf docs/a.tar docs', 'tar --file=docs/a.tar -c docs',
    'tar --file docs/a.tar -c docs', 'tar --totals -cf docs/a.tar docs', 'tar --to-stdout -xf docs/a.tar',
  ]) allowed(command);
  for (const command of ['tar -czf docs/a.tgz docs/sub', 'tar czf docs/a.tgz docs/sub', 'tar -tf docs/a.tgz -- docs/sub']) allowed(command);
});

test('tar, cpio and pax refuse every argument that holds ":", which they can read as a remote archive', () => {
  const d = refused('tar -cf web1.example.com:docs/a.tar docs', 'remote archive');
  assert.equal(d.reason, 'the argument web1.example.com:docs/a.tar holds ":", which tar can read as a remote archive (HOST:FILE), so it is always refused');
  for (const command of [
    'tar cf web1:x docs', 'tar --file=web1:x -c docs', 'tar -cf docs/a.tar docs/x:y', 'gtar -cf web1:x docs', 'bsdtar -xf web1:x',
    'cpio -o -F web1:x', 'cpio -i --file=web1:x', 'pax -wf web1:x docs', 'pax -f web1:x',
  ]) refused(command, 'remote archive');
  refused('tar -xPf web1:x', 'option refused');
  allowed('cpio -t -F docs/a.cpio');
  allowed('pax -f docs/a.pax');
});

test('zip with -TT or --unzip-command, and unzip with -:, are refused, also in a group or shortened', () => {
  for (const command of ['zip -TT x docs/a.zip docs', 'zip -rTT x docs/a.zip docs', 'zip --unzip-command=x docs/a.zip', 'zip --unz x docs/a.zip']) {
    refused(command, 'option refused');
  }
  for (const command of ['unzip -: docs/a.zip', 'unzip -o: docs/a.zip', 'unzip -:o docs/a.zip', 'unzip docs/a.zip -:']) {
    const d = refused(command, 'option refused');
    assert.match(d.reason, /^the option -\S*:\S* of unzip can run other code or reach outside the paths, so it is always refused$/);
  }
  allowed('zip -r docs/a.zip docs/sub');
  allowed('unzip -o docs/a.zip -d docs/sub');
  allowed('unzip -l docs/a.zip');
});

test('cpio with --insecure or --rsh-command is refused, whole, shortened and with a separate value', () => {
  const commands = [
    'cpio -i --insecure -I docs/e.tar', 'cpio --insecure -i -F docs/e.tar', 'cpio -i --insec -I docs/e.tar', 'cpio -i --i -I docs/e.tar',
    'bsdcpio -i --insecure -I docs/e.tar', 'cpio -o --rsh-command=sh -F docs/x', 'cpio -o --rsh-command sh -F docs/x', 'cpio -o --rsh=sh -F docs/x',
  ];
  for (const command of commands) refused(command, 'option refused');
  const d = refused('cpio -i --insecure -I docs/e.tar', 'option refused');
  assert.equal(d.reason, 'the option --insecure of cpio can run other code or reach outside the paths, so it is always refused');
  for (const command of ['cpio -i -I docs/e.tar', 'cpio -i --rename -I docs/e.tar', 'cpio -i --to-stdout -I docs/e.tar', 'cpio -idv -I docs/e.tar']) {
    allowed(command);
  }
});

test('sort --compress-program, split --filter, install --strip-program and sdiff or diff3 --diff-program are refused, in every form', () => {
  const commands = [
    'sort --compress-program=sh -S 4K -T docs -o docs/sorted docs/run.txt', 'sort --compress-program sh docs/a.md',
    'sort --compress-prog=sh -S 1K -T docs docs/a.md', 'sort --co=sh docs/a.md', 'sort --c=sh docs/a.md', 'gsort --compress-program=sh docs/a.md',
    'split --filter=sh docs/a.md', 'split --filter sh docs/a.md docs/part', 'split --fil=sh docs/a.md', 'split --f=sh docs/a.md',
    'gsplit --filter=sh docs/a.md', 'install -s --strip-program=sh docs/a.md docs/b', 'install --strip-program sh docs/a.md docs/b',
    'install --strip-prog=sh docs/a.md docs/b', 'install --strip-=sh docs/a.md docs/b', 'install --st=sh docs/a.md docs/b',
    'ginstall --strip-program=sh docs/a.md docs/b', 'sdiff --diff-program=sh docs/a.md docs/sub/b.md', 'sdiff --diff-prog sh docs/a.md docs/sub/b.md',
    'sdiff --d=sh docs/a.md docs/sub/b.md', 'diff3 --diff-program=sh docs/a.md docs/a.md docs/a.md', 'diff3 --diff sh docs/a.md docs/a.md docs/a.md',
  ];
  for (const command of commands) refused(command, 'option refused');
  const d = refused('sort --compress-program=sh -S 4K -T docs -o docs/sorted docs/run.txt', 'option refused');
  assert.equal(d.reason, 'the option --compress-program=sh of sort can run other code or reach outside the paths, so it is always refused');
});

test('the exact options of sort, split, install, sdiff and diff3 that only share a start with a refused one are not refused', () => {
  for (const command of [
    'sort --check docs/a.md', 'sort --check=quiet docs/a.md', 'sort --ch docs/a.md', 'sort -c docs/a.md', 'sort -S 4K -T docs -o docs/sorted docs/a.md',
    'split -l 5 docs/a.md docs/part', 'split --lines=5 docs/a.md docs/part', 'install -s docs/a.md docs/b', 'install --strip docs/a.md docs/b',
    'install -m 644 docs/a.md docs/b', 'sdiff docs/a.md docs/sub/b.md', 'diff3 -m docs/a.md docs/a.md docs/a.md',
  ]) allowed(command);
});

test('REFUSED_OPTIONS lists the programs of decision 7 and those of the second review', () => {
  assert.deepEqual(Object.keys(REFUSED_OPTIONS), ['find', 'tar', 'cpio', 'pax', 'zip', 'unzip', 'sort', 'split', 'install', 'sdiff', 'diff3']);
  assert.deepEqual(REFUSED_OPTIONS.tar.short, ['I', 'F', 'P', 'C', 'T']);
  assert.deepEqual(REFUSED_OPTIONS.tar.kept, ['--checkpoint', '--file']);
  assert.deepEqual(REFUSED_OPTIONS.cpio.long, ['--insecure', '--rsh-command']);
  assert.deepEqual(REFUSED_OPTIONS.install.kept, ['--strip']);
});

test('a sed script that runs a command, or writes or reads a file of its own, is refused', () => {
  const commands = [
    'sed e docs/a.md', 'sed 1e docs/a.md', 'sed 1etouch docs/a.md', 'sed -e 1e docs/a.md', 'sed -e1e docs/a.md', 'sed -ne 1e docs/a.md',
    'sed --expression=1e docs/a.md', 'sed --expression 1e docs/a.md', 'sed --expr=1e docs/a.md', 'sed -n -e p -e 1e docs/a.md',
    'sed 1wx docs/a.md', 'sed 1Wx docs/a.md', 'sed 1rx docs/a.md', 'sed 1Rx docs/a.md', 'sed s,a,b,e docs/a.md',
    'sed s,a,b,wx docs/a.md', 'sed s:a:b:gw docs/a.md', 'sed 1,+2e docs/a.md', 'sed 0,/x/e docs/a.md', 'sed -- 1e docs/a.md',
    'gsed 1e docs/a.md', 'sed -l 5 1e docs/a.md', 'sed -i s,a,b, e', 'sed -I x 1e docs/a.md', 'sed 1e -e p docs/a.md',
  ];
  for (const command of commands) refused(command, 'sed script refused');
  const d = refused('sed 1e docs/a.md', 'sed script refused');
  assert.equal(d.reason, 'the sed script 1e runs a command, or writes or reads a file of its own, so it is always refused');
});

test('a sed script read from a file is refused', () => {
  for (const command of ['sed -f docs/a.md docs/a.md', 'sed -nf docs/a.md', 'sed --file=docs/a.md', 'sed --f docs/a.md', 'sed --file docs/a.md']) {
    const d = refused(command, 'sed script refused');
    assert.equal(d.reason, 'a sed script read from a file cannot be checked, so -f and --file are always refused');
  }
});

test('other sed scripts may run', () => {
  const commands = [
    'sed -n 1,5p docs/a.md', 'sed s,a,b,g docs/a.md', 'sed -E -e s,x,y, docs/a.md', 'sed y,ab,cd, docs/a.md', 'sed s docs/a.md',
    'sed -l5 p docs/a.md', 'sed --line-length 5 p docs/a.md', 'sed --line-length=5 p docs/a.md', 'sed -i -e s,a,b, docs/a.md',
    'sed --posix p docs/a.md', 'sed -n', 'sed -e', 'sed p -', 'sed -zn p docs/a.md', 'sed --follow-symlinks p docs/a.md',
  ];
  for (const command of commands) allowed(command);
});

test('sedScripts reads the arguments as GNU sed and as BSD sed do', () => {
  assert.deepEqual(sedScripts(['-i', 's,a,b,', 'e']), ['s,a,b,', 'e']);
  assert.deepEqual(sedScripts(['-n', '-e', 'p', 'x']), ['p', 'p']);
  assert.deepEqual(sedScripts(['1e', '-e', 'p']), ['p', '1e']);
  assert.deepEqual(sedScripts([]), [undefined, undefined]);
  assert.equal(sedScripts(['-sf', 'x']), null);
  assert.equal(sedScriptRefused(undefined), false);
  assert.equal(sedScriptRefused('/x/Ie'), true);
  assert.equal(sedScriptRefused('/x/IMp'), false);
  assert.equal(sedScriptRefused('s/a/b/w/tmp/x'), true);
  assert.equal(sedScriptRefused('s/a/b'), false);
});

// Which arguments are paths, and the checks they get.

test('argumentValues: the word, the value after = of a long flag, every tail of a short flag', () => {
  assert.deepEqual(argumentValues('docs/a.md'), ['docs/a.md']);
  assert.deepEqual(argumentValues('--output=out/x'), ['out/x']);
  assert.deepEqual(argumentValues('--output'), []);
  assert.deepEqual(argumentValues('-oout'), ['out', 'ut', 't']);
  assert.deepEqual(argumentValues('-o'), []);
  assert.deepEqual(argumentValues('-'), []);
});

test('isPath: a slash, a leading dot or an existing entry, also in a part after = : @ , + or %', () => {
  for (const word of ['docs/a.md', 'a/', '.', '.env', '..', 'docs', 'README.md', 'src', 'text:.env', 'x@src', 'a=docs', 'k%src', 'b+src', 'c,src']) {
    assert.equal(isPath(word, cwd), true, word);
  }
  for (const word of ['TODO', 'main..dev', '20', 'a=b', 'key=', 'user@example', '']) assert.equal(isPath(word, cwd), false, word);
});

test('a whole word that names an existing entry is a path, also when no part of it after = : @ , + or % names one', () => {
  const made = ['prod+creds', 'deploy@prod.pem', 'a:b'];
  for (const word of made) assert.equal(isPath(word, cwd), false, word);
  for (const name of made) fs.writeFileSync(path.join(cwd, name), 'x\n');
  try {
    for (const word of made) assert.equal(isPath(word, cwd), true, word);
    const protect = { protect: ['docs/private', 'prod+creds'] };
    for (const command of [
      'cat prod+creds', 'cat deploy@prod.pem', 'cat a:b', 'cp docs/a.md prod+creds', 'rm prod+creds', 'cat --file=prod+creds',
      'cat -fprod+creds', 'cat -- prod+creds',
    ]) {
      const d = refused(command, 'not a plain path', protect);
      assert.match(d.reason, /^the argument (prod\+creds|deploy@prod\.pem|a:b) is not a plain relative path/, command);
    }
    if (fs.existsSync(path.join(cwd, 'PROD+CREDS'))) refused('cat Prod+Creds', 'not a plain path', protect);
  } finally {
    for (const name of made) fs.rmSync(path.join(cwd, name));
  }
});

test('after "--", every word is checked whole and as a flag, since "--" may be the value of the flag before it', () => {
  const made = ['notes', 'prod+creds'];
  for (const name of made) fs.writeFileSync(path.join(cwd, name), 'x\n');
  try {
    const d = refused('sort -T -- -onotes docs/a.md', 'outside paths');
    assert.equal(d.reason, 'the argument notes is outside the paths this target allows: docs, README.md, assets/*.png');
    refused('sort -T -- -o.env docs/a.md', 'secret file');
    refused('sort -T -- -oprod+creds docs/a.md', 'not a plain path');
    refused('sort -T -- --output=notes docs/a.md', 'not a plain path');
    refused('sort -T -- -o -- -onotes docs/a.md', 'outside paths');
    refused('sort -T -- -osrc docs/a.md', 'outside paths');
    allowed('sort -T -- -r docs/a.md');
    allowed('sort -T -- -o docs/sorted docs/a.md');
    allowed('grep -- TODO docs');
    allowed('cat -- docs/a.md');
  } finally {
    for (const name of made) fs.rmSync(path.join(cwd, name));
  }
});

test('paths inside are allowed: files, folders, patterns, links that resolve inside paths', () => {
  for (const command of [
    'cat docs/a.md', 'cat docs/sub/b.md', 'ls docs', 'ls docs/', 'cat ./docs/a.md', 'cat docs//a.md', 'cat README.md',
    'cat assets/logo.png', 'cat docs/new.md', 'cat docs/nodir/new.md', 'cat srclink/a.md', 'cat docs/a.md docs/a.md',
    'cat docs/.notes.md', 'ls docs/.hidden',
  ]) allowed(command);
});

test('paths outside are refused: another folder, a pattern that does not match, the folder itself, a link out of paths', () => {
  for (const command of [
    'cat src/b.js', 'cat assets/notes.txt', 'ls assets', 'ls .', 'cat newfile/x', 'cat docs/tosrc/b.js', 'cat docs/a.md src/b.js',
  ]) refused(command, 'outside paths');
});

test('the checks of today come first: link out of the folder, "..", absolute, protect, secret name, ksproxy files', () => {
  refused('cat docs/out', 'outside the folder');
  refused('cat docs/outdir/x', 'outside the folder');
  const dots = refused('cat docs/../src/b.js', 'contains ".."');
  assert.equal(dots.reason, 'the argument docs/../src/b.js contains ".."');
  for (const command of ['cat /etc/hosts', `cat ${cwd}/docs/a.md`, 'cat file:/etc/hosts', 'cat text:.env', 'cat x@src']) {
    const d = refused(command, 'not a plain path');
    assert.match(d.reason, /^the argument \S+ is not a plain relative path: a path is made of letters, digits and _ \. \/ - and does not start with \/ or -$/);
  }
  refused('cat docs/private/x.md', 'protected path', { protect: ['docs/private'] });
  refused('ls docs', 'protected path', { protect: ['docs/private'] });
  refused('cat docs/server.pem', 'secret file');
  refused('cat .env', 'secret file');
  refused('cat docs/stlink/session/session.json', 'ksproxy files');
  refused('cat docs/kubelink', 'ksproxy files');
  refused('cat docs/dangling', 'unresolvable link');
  refused(`cat docs/${'a'.repeat(600)}`, 'argument too long');
});

test('patterns: *, **, . and a file entry, with names that start with a dot matched by * and **', () => {
  allowed('cat docs/a.md', { paths: ['docs/*.md'] });
  allowed('cat docs/.notes.md', { paths: ['docs/*.md'] });
  allowed('cat docs/.notes.md', { paths: ['docs/*'] });
  allowed('cat docs/.hidden/c.md', { paths: ['docs/*/c.md'] });
  allowed('cat docs/.hidden/c.md', { paths: ['**/*.md'] });
  refused('cat docs/sub/b.md', 'outside paths', { paths: ['docs/*.md'] });
  refused('ls docs', 'outside paths', { paths: ['docs/*'] });
  allowed('cat docs/sub/b.md', { paths: ['docs/*'] });
  allowed('cat docs/sub/b.md', { paths: ['**/*.md'] });
  allowed('cat README.md', { paths: ['**/*.md'] });
  refused('cat src/b.js', 'outside paths', { paths: ['**/*.md'] });
  allowed('ls docs', { paths: ['docs/**'] });
  allowed('cat src/b.js', { paths: ['.'] });
  allowed('ls .', { paths: ['.'] });
  allowed('cat README.md', { paths: ['README.md'] });
  refused('cat docs/a.md', 'outside paths', { paths: ['README.md'] });
});

test('covers matches a path or a folder above it, with * inside one part and ** for any number of parts', () => {
  assert.equal(covers('docs', ['docs', 'a.md'], false), true);
  assert.equal(covers('docs', [], false), false);
  assert.equal(covers('.', [], false), true);
  assert.equal(covers('**', [], false), true);
  assert.equal(covers('a*b*c', ['aXbYbZc'], false), true);
  assert.equal(covers('a*c', ['abd'], false), false);
  assert.equal(covers('abc', ['abd'], false), false);
  assert.equal(covers('a*', ['a'], false), true);
  assert.equal(covers('*', ['.hidden'], false), true);
  assert.equal(covers('**', ['.git', 'config'], false), true);
  assert.equal(covers('**/x/**/y', ['a', 'x', 'b', 'c', 'y', 'z'], false), true);
  assert.equal(covers('**/x/**/y', ['a', 'x', 'b'], false), false);
  assert.equal(covers('docs', ['DOCS', 'a.md'], true), true);
  assert.equal(covers('docs', ['DOCS', 'a.md'], false), false);
});

test('letter case of paths follows the system: decide runs the same for macOS and Linux on a path in its own case', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(decide('cat docs/a.md', {}, platform).allowed, true, platform);
    assert.equal(decide('cat src/b.js', {}, platform).short, 'outside paths', platform);
  }
});

test('flag values: after = of a long flag, every tail of a short flag, and every word after --', () => {
  refused('grep --file=src/b.js docs', 'outside paths');
  allowed('grep --file=docs/a.md docs');
  allowed('grep --color=auto TODO docs');
  refused('grep -fsrc/b.js docs', 'outside paths');
  refused('grep -fdocs/a.md docs', 'outside paths');
  refused('grep -f.env docs', 'secret file');
  refused('grep -f/etc/hosts docs', 'not a plain path');
  refused('grep -fREADME.md docs', 'outside paths');
  allowed('grep -fREADME.md docs', { paths: ['.'] });
  allowed('grep -f docs/a.md docs');
  refused('cat -- -notes', 'not a plain path');
  allowed('cat -- docs/a.md');
  allowed('cat -');
});

test('free words are not checked: a search word, a number, a range, a name that does not exist yet', () => {
  for (const command of ['grep -r TODO docs', 'grep -n main..dev docs', 'head -n 20 docs/a.md', 'grep a=b docs', 'echo hello', 'touch notes']) {
    allowed(command);
  }
  refused('grep src docs', 'outside paths');
});

// paths with listed rules only.

test('paths with listed rules only limits the wildcard arguments that are paths, and programs are absent', () => {
  const only = { allow: ['cat *', 'ls ...', 'grep -r * *', 'regex(head [a-z/.]+)'], paths: ['docs'], listedPrograms: undefined };
  allowed('cat docs/a.md', only, 'cat *');
  allowed('cat TODO', only, 'cat *');
  allowed('ls', only, 'ls ...');
  allowed('grep -r TODO docs', only, 'grep -r * *');
  allowed('head docs/a.md', only, 'regex(head [a-z/.]+)');
  const d = decide('cat src/b.js', only);
  assert.equal(d.short, 'outside paths');
  assert.equal(d.reason, 'the argument src/b.js is outside the paths this target allows: docs');
  for (const command of ['ls .', 'grep -r TODO src', 'head src/b.js', 'ls docs src']) assert.equal(decide(command, only).short, 'outside paths', command);
  assert.equal(decide('cat /etc/hosts', only).short, 'not a plain argument');
  const sh = decide('sh docs/a.md', only);
  assert.equal(sh.short, 'not on allowlist');
  assert.equal(sh.reason, 'not on the allowlist for this target. Allowed: cat *; ls ...; grep -r * *; regex(head [a-z/.]+)');
});

test('a session target edited by hand: programs need a list of paths that is not empty, and only bare names count', () => {
  for (const paths of [undefined, [], 'docs', [5]]) {
    const d = decide('cat docs/a.md', { allow: ['ls'], paths });
    assert.equal(d.short, 'not on allowlist', String(paths));
    assert.equal(d.reason, 'not on the allowlist for this target. Allowed: ls');
  }
  allowed('cat docs/a.md', { paths: [5, 'docs'] });
  for (const listed of [undefined, 'cat', {}]) {
    assert.equal(decide('cat docs/a.md', { listedPrograms: listed }).short, 'not on allowlist', String(listed));
  }
  assert.deepEqual(programsOf({ listedPrograms: ['cat', 5, '/bin/sh', './x', '-x', 'gr ep', 'ls'] }, ['docs']), ['cat', 'ls']);
  assert.deepEqual(programsOf({ listedPrograms: ['cat'] }, null), []);
  assert.deepEqual(programsOf({ listedPrograms: ['cat'] }, []), []);
  assert.equal(decide('/bin/sh docs/a.md', { listedPrograms: ['/bin/sh'] }).short, 'not on allowlist');
  assert.equal(decide('cat docs/a.md', { allow: ['* ...'], listedPrograms: undefined }).short, 'not on allowlist');
  assert.deepEqual(pathsOf({ paths: ['docs', 5] }), ['docs']);
  assert.equal(pathsOf({}), null);
});

// Review.

test('reviewProblem checks every path of a reviewed command against paths, as it checks protect', () => {
  const t = {
    kind: 'local', name: 'docs', cwd, allow: [], review: true, programs: ['ls', 'cat'], paths: ['docs'], protected: [],
  };
  const d = reviewProblem(['ls', 'src'], t, env);
  assert.deepEqual(d, { reason: 'the argument src is outside the paths this target allows: docs', short: 'outside paths' });
  assert.equal(reviewProblem(['cat', '-n', 'README.md'], t, env).short, 'outside paths');
  assert.equal(reviewProblem(['ls', '-Isrc'], t, env).short, 'outside paths');
  assert.equal(reviewProblem(['ls', 'docs', 'docs/sub/b.md'], t, env), null);
  assert.equal(reviewProblem(['ls', 'TODO', '-la', '20'], t, env), null);
  assert.equal(reviewProblem(['ls', 'src'], { ...t, paths: ['.'] }, env), null);
  assert.equal(reviewProblem(['ls', 'src'], { ...t, paths: undefined }, env), null);
  assert.equal(reviewProblem(['ls', 'src'], { ...t, paths: [] }, env).short, 'outside paths');
  assert.equal(reviewProblem(['ls', 'docs/server.pem'], t, env).short, 'secret file');
});

test('a reviewed command outside paths is never sent to the reviewer; one inside paths is', () => {
  const extra = {
    allow: [], review: true, programs: ['ls'], listedPrograms: undefined, paths: ['docs'],
  };
  const out = decide('ls src', extra);
  assert.equal(out.short, 'allowlist is empty');
  assert.equal(out.notReviewed, 'the argument src is outside the paths this target allows: docs');
  assert.deepEqual(reviewRoute('local', out, true), { note: 'It was not sent to the reviewer: the argument src is outside the paths this target allows: docs.' });
  const inside = decide('ls docs', extra);
  assert.deepEqual(reviewRoute('local', inside, true), { argv: ['ls', 'docs'] });
});

test('with review and programs, a listed program that a check refuses is never reviewed, and an unlisted one may be', () => {
  const extra = {
    allow: [], review: true, programs: ['ls', 'cat'], listedPrograms: ['cat'], paths: ['docs'],
  };
  const d = decide('cat src/b.js', extra);
  assert.equal(d.short, 'outside paths');
  assert.equal(reviewRoute('local', d, true), null);
  allowed('cat docs/a.md', extra);
  const ls = decide('ls docs', extra);
  assert.equal(ls.reason, 'not on the allowlist for this target. Allowed: nothing (empty allowlist); the program ls is not one of its programs: cat');
  assert.deepEqual(reviewRoute('local', ls, true), { argv: ['ls', 'docs'] });
});

// The warnings of decisions 6 and 10.

test('programNames: the base name in lower case and its stem without a version, each also without a leading g, gnu or bsd', () => {
  assert.deepEqual(programNames('/usr/local/bin/GNUTAR-1.35'), ['gnutar-1.35', 'nutar-1.35', 'tar-1.35', 'gnutar', 'nutar', 'tar']);
  assert.deepEqual(programNames('bsdtar'), ['bsdtar', 'tar']);
  assert.deepEqual(programNames('gm4'), ['gm4', 'm4', 'gm', 'm']);
  assert.deepEqual(programNames('python3.12'), ['python3.12', 'python']);
  assert.deepEqual(programNames('g'), ['g']);
});

test('every program of ACTING_PROGRAMS and ACTING_PREFIXES can act as you, also with a version, in capitals or with a g, gnu or bsd prefix', () => {
  for (const name of Object.values(ACTING_PROGRAMS).flat()) {
    assert.deepEqual(actingPrograms([name, 'cat']), [name], name);
    assert.deepEqual(actingPrograms([name.toUpperCase()]), [name.toUpperCase()], name);
  }
  assert.deepEqual(ACTING_PREFIXES, ['python', 'perl', 'php', 'lua', 'pip']);
  const others = ['python', 'python3', 'python3.12', 'pythonw', 'perl5.34', 'perldoc', 'php8.2', 'phpunit', 'luajit', 'pip3', 'pipenv'];
  const versions = ['node20', 'ruby3.1', 'bash5', 'gawk-5.1', 'gnumake', 'gtimeout', 'bsdgit', 'gm4', 'sqlite3', 'GH', 'gcc-13'];
  assert.deepEqual(actingPrograms([...others, ...versions]), [...others, ...versions]);
  const plain = [
    'cat', 'grep', 'sed', 'gsed', 'ls', 'head', 'wc', 'find', 'sort', 'gsort', 'split', 'install', 'sdiff', 'diff3', 'diff', 'touch', 'echo',
    'jq', 'xxd', 'base64', 'gzip', 'gunzip', 'yaml-lint', 'json-diff',
  ];
  assert.deepEqual(actingPrograms(plain), []);
});

test('the programs the second review named, the archive programs, and a hyphenated name by its part before the first "-" can act as you', () => {
  const named = [
    'taskpolicy', 'lockf', 'rbash', 'prlimit', 'shortcuts', 'automator', 'pandoc', 'latexmk', 'pdflatex', 'xelatex', 'lualatex', 'ssh-keygen',
    'groff', 'oc', 'k9s', 'stern', 'kubectx', 'kubens', 'argocd', 'flux', 'istioctl', 'docker-compose', 'aws-vault', 'sops', 'bw', 'op',
    'pg_dump', 'pg_dumpall', 'mysqldump', 'tofu', 'terraform', 'terragrunt', 'ansible', 'ansible-playbook', 'mdfind', 'screencapture',
  ];
  const all = Object.values(ACTING_PROGRAMS).flat();
  for (const name of named) assert.ok(all.includes(name), name);
  assert.deepEqual(actingPrograms(named), named);
  assert.deepEqual(ACTING_PROGRAMS.archives, ['tar', 'unzip', 'zip', 'cpio', 'pax', 'ditto']);
  const archives = ['tar', 'gtar', 'bsdtar', 'gnutar', 'unzip', 'bsdunzip', 'zip', 'cpio', 'bsdcpio', 'pax', 'ditto'];
  assert.deepEqual(actingPrograms(archives), archives);
  const hyphenated = ['docker-buildx', 'ansible-galaxy', 'aws-sso', 'kubectl-neat', 'git-lfs', 'Terraform-Docs', 'gcloud-sdk'];
  assert.deepEqual(actingPrograms(hyphenated), hyphenated);
  assert.deepEqual(actingPrograms(['g-x', 'x-', '-']), []);
  assert.deepEqual(programNames('gzip'), ['gzip']);
  assert.deepEqual(programNames('gunzip'), ['gunzip']);
});

test('ruleWarnings adds the warning of decision 6 after the warnings of the rules, naming the programs as listed', () => {
  const t = valid({ allow: ['cat *', 'regex(cat (a+)+)'], programs: ['cat', 'python3', 'ps', 'grep', 'gh'], paths: ['docs'] });
  assert.deepEqual(localKind.ruleWarnings(t), [
    'allow[1]: this pattern can be very slow on some inputs',
    `programs that can act as you: python3, ps, gh; ${ACTING}`,
  ]);
  assert.deepEqual(localKind.ruleWarnings(valid({ programs: ['cat', 'grep'], paths: ['docs'] })), []);
  const plain = valid({ allow: ['cat *', 'regex(cat (a+)+)'] });
  assert.deepEqual(localKind.ruleWarnings(plain), allowWarnings(plain.allow));
});

test('open names the programs and the paths, before the note on loose secrets', () => {
  const ctx = { env, secretFiles: [], secretFilesProblem: null };
  const open = (local) => localKind.open(valid({ cwd, ...local }), ctx);
  assert.deepEqual(open({ programs: ['cat', 'grep', 'sed'], paths: PATHS }), {
    ok: true,
    extras: {},
    notes: ['programs cat, grep, sed may run with any arguments inside docs, README.md, assets/*.png'],
  });
  assert.deepEqual(open({ allow: ['cat *'], paths: ['docs'] }), { ok: true, extras: {} });
  assert.deepEqual(open({ allow: ['cat *'] }), { ok: true, extras: {} });
  fs.writeFileSync(path.join(cwd, '.env'), 'x=1\n');
  try {
    assert.deepEqual(open({ programs: ['python3'], paths: ['docs'] }).notes, [
      'programs python3 may run with any arguments inside docs',
      'holds .env: list them in "protect" to also refuse commands given the whole folder',
    ]);
  } finally {
    fs.rmSync(path.join(cwd, '.env'));
  }
});

// The session, the agent notes and check.

test('record keeps paths and the programs in the session, and forCheck hands them to decide', () => {
  const t = valid({
    cwd, allow: ['git status'], programs: ['cat'], paths: PATHS,
  });
  const recorded = localKind.record({ target: t }, {
    env: { PATH: '/usr/bin:/bin' }, selected: [t], secretFiles: [], reviewed: false,
  });
  assert.deepEqual(Object.keys(recorded), ['kind', 'name', 'description', 'allow', 'cwd', 'path', 'protected', 'state', 'paths', 'listedPrograms']);
  assert.deepEqual(recorded.paths, PATHS);
  assert.deepEqual(recorded.listedPrograms, ['cat']);
  const checked = localKind.forCheck(t, { env, secretFiles: [] }).target;
  assert.deepEqual(checked.paths, PATHS);
  assert.deepEqual(checked.listedPrograms, ['cat']);
  assert.equal(Object.hasOwn(checked, 'programs'), false);
  const reviewed = validateInventory({
    reviewers,
    local: [{
      name: 'docs', cwd, programs: ['cat'], paths: ['docs'], review: { reviewer: 'r1', policy: 'read only', programs: ['ls'] },
    }],
  }).local[0];
  const both = localKind.record({ target: reviewed }, {
    env: { PATH: '/usr/bin:/bin' }, selected: [reviewed], secretFiles: [], reviewed: true,
  });
  assert.deepEqual([both.programs, both.listedPrograms, both.review], [['ls'], ['cat'], true]);
  const forCheck = localKind.forCheck(reviewed, { env, secretFiles: [] }).target;
  assert.deepEqual([forCheck.programs, forCheck.listedPrograms, forCheck.review], [['ls'], ['cat'], true]);
  const none = localKind.forCheck(valid({ cwd, allow: ['cat *'] }), { env, secretFiles: [] }).target;
  assert.equal(Object.hasOwn(none, 'listedPrograms'), false);
});

test('the agent notes show the programs, the paths, the flag rule and the options always refused', () => {
  const session = (extra) => ({ kind: 'local', name: 'docs', description: '', cwd, state: 'up', ...extra });
  const text = agentMdText({ targets: [session({ allow: ['git status'], paths: PATHS, listedPrograms: ['cat', 'grep', 'sed'] })] });
  assert.ok(text.includes('- Allowed commands: git status\n'));
  assert.ok(text.includes('- Besides the commands above, these programs may run with any flags and arguments: cat, grep, sed. Name the program exactly as listed, never as a path (`./run.sh`, `/bin/cat`). A command of these programs that a check refuses is never sent to a reviewer.'));
  assert.ok(text.includes('lie inside one of these paths of the folder: docs, README.md, assets/*.png. A folder covers everything below it; `*` matches any characters inside one part of a path, names that start with a dot included'));
  assert.ok(text.includes('- Give a path as its own word (`-o out/x`).'));
  assert.ok(text.includes('a value glued to a short flag (`-oout/x`) is checked whole, with every tail of the flag'));
  assert.ok(text.includes('find -exec, -execdir, -ok, -okdir; tar -I, -F, -P, -C, -T, --to-command, --use-compress-program, --checkpoint-action, --info-script, --new-volume-script, --rsh-command, --rmt-command, --absolute-names, --absolute-paths, --directory, --cd, --files-from, --insecure; cpio --insecure, --rsh-command; zip -TT, --unzip-command; unzip -:; sort --compress-program; split --filter; install --strip-program; sdiff --diff-program; diff3 --diff-program.'));
  assert.ok(text.includes('Every word after `--` is checked whole and also as a flag would be, since `--` can be the value of the flag before it.'));
  assert.ok(text.includes('tar, cpio and pax refuse every argument that holds `:`'));
  assert.ok(text.includes('the commands e, w, W, r or R or the s flags e or w'));
  assert.ok(text.includes('- Every argument that a wildcard matches and that is a path (it contains `/`, starts with `.` or names an existing file or folder) must also lie inside one of these paths of the folder: docs, README.md, assets/*.png.'));
  assert.ok(!text.includes(cwd));
  assert.ok(!text.includes('* ...'));
  const listed = agentMdText({ targets: [session({ allow: ['cat *'], paths: ['docs'] })] });
  assert.ok(listed.includes('- Every argument that a wildcard matches and that is a path (it contains `/`, starts with `.` or names an existing file or folder) must also lie inside one of these paths of the folder: docs.'));
  assert.ok(!listed.includes('these programs may run'));
  const reviewed = agentMdText({ targets: [session({ allow: ['cat *'], paths: ['docs'], review: true, programs: ['ls'] })] });
  assert.ok(reviewed.includes('Only these programs can be reviewed: ls. Flags must be simple (`-x`, `--word`), with any value as a separate argument. Every path of a reviewed command must also lie inside these paths of the folder: docs.'));
  const plain = agentMdText({ targets: [session({ allow: ['cat *'], review: true, programs: ['ls'] })] });
  assert.ok(!plain.includes('paths of the folder'));
  assert.ok(plain.includes('with any value as a separate argument.\n') || plain.endsWith('with any value as a separate argument.'));
});

test('ksproxy check local warns about programs that can act as you, and gives the same answer and reason as a call', async () => {
  const cfg = path.join(base, 'check-cfg');
  fs.mkdirSync(cfg);
  fs.writeFileSync(path.join(cfg, 'inventory.json'), JSON.stringify({
    local: [{
      name: 'docs', cwd, allow: ['git status'], programs: ['cat', 'find', 'python3', 'ps'], paths: PATHS,
    }],
  }));
  const checkEnv = { ...process.env, [CONFIG]: cfg, [STATE]: path.join(base, 'check-st') };
  const check = async (...words) => {
    const proc = fakeProcess();
    const code = await main(['check', 'local', 'docs', ...words], checkEnv, { process: proc });
    return { code, out: proc.stdout.text, err: proc.stderr.text };
  };
  const warning = `WARNING: local "docs": programs that can act as you: python3, ps; ${ACTING}\n`;
  assert.deepEqual(await check('cat', 'docs/a.md'), { code: 0, out: 'ALLOWED by rule: programs: cat\n', err: warning });
  assert.deepEqual(await check('git', 'status'), { code: 0, out: 'ALLOWED by rule: git status\n', err: warning });
  const session = {
    ...target, allow: ['git status'], listedPrograms: ['cat', 'find', 'python3', 'ps'], protected: [],
  };
  for (const words of [['git', 'log'], ['cat', 'src/b.js'], ['sh', 'x'], ['find', 'docs', '-exec', 'x'], ['cat', '/etc/hosts']]) {
    const call = decideLocal(session, words.join(' '), checkEnv);
    assert.equal(call.allowed, false, words.join(' '));
    assert.deepEqual(await check(...words), { code: 1, out: `REFUSED: ${call.reason}\n`, err: warning }, words.join(' '));
  }
});

test('a call of a listed program runs the program found on the session PATH, in the folder, and a refusal is logged', async () => {
  const sessionDir = path.join(base, 'st', 'session');
  writeSession(sessionDir, {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-25T00:00:00.000Z',
    targets: [{
      kind: 'local',
      name: 'docs',
      description: '',
      allow: [],
      cwd,
      path: '/usr/bin:/bin',
      protected: [],
      state: 'up',
      paths: PATHS,
      listedPrograms: ['cat'],
    }],
  });
  const callEnv = { ...process.env, ...env };
  const ok = await callTool('local_exec', { target: 'docs', command: 'cat docs/a.md' }, callEnv);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(ok.text.includes('hello docs'), ok.text);
  const denied = await callTool('local_exec', { target: 'docs', command: 'cat src/b.js' }, callEnv);
  assert.equal(denied.isError, true);
  assert.equal(denied.text, 'REFUSED (local docs): the argument src/b.js is outside the paths this target allows: docs, README.md, assets/*.png');
  assert.ok(!denied.text.includes('secret source'));
  const log = fs.readFileSync(path.join(base, 'st', 'logs', 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const calls = log.filter((entry) => entry.event === 'call');
  assert.equal(calls.length, 2);
  assert.ok(calls.some((entry) => JSON.stringify(entry).includes('programs: cat')), JSON.stringify(calls));
  assert.ok(calls.some((entry) => JSON.stringify(entry).includes('outside paths')), JSON.stringify(calls));
});

test('ksproxy start warns about programs that can act as you before OPENING, names the programs and paths after UP, and records them', async () => {
  const world = await makeWorld({ ssh: [], local: [{ allow: ['ls ...'], programs: ['cat', 'python3'], paths: ['.'] }] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  const lines = run.proc.stderr.text.split('\n').filter((line) => line.includes('infra'));
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));
  const acting = at(new RegExp(`loc {2}infra +WARN +programs that can act as you: python3; ${ACTING}$`));
  const opening = at(/loc {2}infra +OPENING /);
  const up = at(/loc {2}infra +UP$/);
  const reach = at(/loc {2}infra +WARN +programs cat, python3 may run with any arguments inside \.$/);
  assert.ok(acting !== -1 && acting < opening && opening < up && up < reach, lines.join('\n'));
  const session = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
  assert.deepEqual([session.targets[0].paths, session.targets[0].listedPrograms], [['.'], ['cat', 'python3']]);
  const ok = await callTool('local_exec', { target: 'infra', command: 'cat a.txt' }, world.env);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(ok.text.includes('hello a'));
  assert.equal(await stopWith(run), 0);
});

test('a target with programs and an empty allow list gets no "allowlist is empty" warning', async () => {
  const world = await makeWorld({ ssh: [], local: [{ allow: [], programs: ['cat'], paths: ['.'] }] });
  const run = launch(world, { local: ['infra'] });
  await ready(run);
  assert.ok(!run.proc.stderr.text.includes('allowlist is empty'), run.proc.stderr.text);
  const ok = await callTool('local_exec', { target: 'infra', command: 'cat a.txt' }, world.env);
  assert.equal(ok.isError, false, ok.text);
  assert.equal(await stopWith(run), 0);
});

// A target with listed rules and no paths or programs.

test('a target with listed rules and no paths or programs behaves and prints as before', () => {
  const plain = {
    kind: 'local', name: 'docs', cwd, allow: ['cat *', 'ls ...'], protected: [],
  };
  const d = decideLocal(plain, 'grep x docs', env);
  assert.deepEqual(d, {
    allowed: false, reason: 'not on the allowlist for this target. Allowed: cat *; ls ...', short: 'not on allowlist', unmatched: true,
  });
  assert.equal(decideLocal(plain, 'cat src/b.js', env).allowed, true);
  assert.equal(decideLocal({ ...plain, allow: [] }, 'cat x', env).reason, 'the allowlist for this target is empty, so every command is refused');
  const text = agentMdText({ targets: [{ ...plain, description: '', state: 'up' }] });
  assert.ok(!text.includes('paths of the folder'));
  assert.ok(!text.includes('these programs may run'));
});
