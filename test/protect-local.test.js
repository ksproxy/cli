import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  guardedPaths, localScope, looksSecret, reviewProblem, valueProblem,
} from '../src/kinds/local/folder.js';
import localKind from '../src/kinds/local/index.js';

const decideLocal = localKind.decide;

let base;
let dir;
let env;
let savedHome;

const ENV_FILE = ['.', 'env'].join('');

const target = (extra = {}) => ({
  kind: 'local',
  name: 'repo',
  description: '',
  cwd: dir,
  allow: ['cat *', 'grep -r * *', 'ls ...', `cat ${ENV_FILE}.production`],
  path: '/usr/bin:/bin',
  protected: [],
  state: 'up',
  protect: ['secrets', 'deploy/key.txt', 'later.txt'],
  ...extra,
});

before(() => {
  savedHome = process.env.HOME;
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-pp-')));
  dir = path.join(base, 'work');
  for (const d of ['src', 'secrets/deep', 'deploy', '.aws', 'apps/api']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  const files = [
    'a.txt', 'src/main.js', 'secrets/deep/token', 'deploy/key.txt', 'deploy/readme.md',
    ENV_FILE, `${ENV_FILE}.example`, `${ENV_FILE}.production`, '.aws/credentials', `apps/api/${ENV_FILE}.local`,
    'server.pem', 'id_rsa', 'id_rsa.pub',
  ];
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'x\n');
  fs.symlinkSync(ENV_FILE, path.join(dir, 'notes'));
  fs.symlinkSync('secrets', path.join(dir, 'pub'));
  fs.symlinkSync(path.join(dir, 'deploy'), path.join(dir, 'd2'));
  fs.mkdirSync(path.join(base, 'home'));
  process.env.HOME = path.join(base, 'home');
  env = { ...process.env, KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg') };
});

after(() => {
  process.env.HOME = savedHome;
  fs.rmSync(base, { recursive: true, force: true });
});

const outcome = (command, extra) => {
  const d = decideLocal(target(extra), command, env);
  return d.allowed ? 'ok' : d.short;
};

test('looksSecret knows the usual names and their exceptions', () => {
  const yes = [
    ENV_FILE, `${ENV_FILE}.local`, `${ENV_FILE}.production`, '.ENVRC', '.npmrc', '.pypirc', '.netrc', '.pgpass', '.my.cnf',
    '.git-credentials', '.htpasswd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'ID_ED25519', '.ssh', '.aws', '.gnupg', '.kube',
    '.azure', 'server.pem', 'TLS.KEY', 'a.p12', 'a.pfx', 'a.jks', 'a.keystore', 'a.ppk', 'a.kdbx',
    'terraform.tfstate', 'terraform.tfstate.backup', 'prod.tfvars', 'prod.tfvars.json', '.pem',
    `prod${ENV_FILE}`, `docker${ENV_FILE}`, 'credentials', 'credentials.json', 'kubeconfig', 'prod.kubeconfig',
    'id_ecdsa_sk', 'id_ed25519_sk', '.dev.vars', '.vault-token', '.s3cfg', '.terraformrc', 'secrets.toml',
  ];
  const no = [
    `${ENV_FILE}.example`, `${ENV_FILE}.sample`, `${ENV_FILE}.template`, `${ENV_FILE}.dist`, 'id_rsa.pub', 'env', 'environment.js',
    'keys.md', 'pem', 'a.txt', 'src', 'tfvars', 'main.tf',
    '.docker', `${ENV_FILE}.local.example`, 'credentials.md', 'mykubeconfig.txt',
  ];
  for (const name of yes) assert.equal(looksSecret(name), true, name);
  for (const name of no) assert.equal(looksSecret(name), false, name);
});

test('a protected path cannot be named, entered or contained', () => {
  assert.equal(outcome('cat secrets/deep/token'), 'protected path');
  assert.equal(outcome('ls secrets'), 'protected path');
  assert.equal(outcome('ls secrets/'), 'protected path');
  assert.equal(outcome('cat deploy/key.txt'), 'protected path');
  assert.equal(outcome('ls deploy'), 'protected path');
  assert.equal(outcome('ls .'), 'protected path');
  assert.equal(outcome('ls ./'), 'protected path');
  assert.equal(outcome('grep -r x .'), 'protected path');
  assert.equal(outcome('cat later.txt'), 'protected path');
});

test('paths beside a protected one still work', () => {
  assert.equal(outcome('cat a.txt'), 'ok');
  assert.equal(outcome('cat deploy/readme.md'), 'ok');
  assert.equal(outcome('ls src'), 'ok');
  assert.equal(outcome('grep -r x src'), 'ok');
  assert.equal(outcome('ls'), 'ok');
  assert.equal(outcome('cat secretsauce.txt'), 'ok');
});

test('a link does not get around a protected path', () => {
  assert.equal(outcome('cat pub/deep/token'), 'protected path');
  assert.equal(outcome('ls pub'), 'protected path');
  assert.equal(outcome('ls d2'), 'protected path');
  assert.equal(outcome('cat d2/key.txt'), 'protected path');
});

test('the refusal names the argument and not the protect list', () => {
  const d = decideLocal(target(), 'cat secrets/deep/token', env);
  assert.equal(d.reason, 'the argument secrets/deep/token is, lies inside or contains a path this target protects');
  assert.ok(!d.reason.includes('deploy'));
});

test('a secret-looking name is refused wherever it is in the path', () => {
  assert.equal(outcome(`cat ${ENV_FILE}`), 'secret file');
  assert.equal(outcome(`cat apps/api/${ENV_FILE}.local`), 'secret file');
  assert.equal(outcome('cat server.pem'), 'secret file');
  assert.equal(outcome('cat SERVER.PEM'), 'secret file');
  assert.equal(outcome('cat id_rsa'), 'secret file');
  assert.equal(outcome('cat .aws/credentials'), 'secret file');
  assert.equal(outcome('ls .aws'), 'secret file');
  assert.equal(outcome('cat missing/server.key'), 'secret file');
  const d = decideLocal(target(), `cat ${ENV_FILE}`, env);
  assert.equal(d.reason, `the argument ${ENV_FILE} names a file or folder that usually holds secrets`);
});

test('a link to a secret-looking file is judged by where it leads', () => {
  assert.equal(outcome('cat notes'), 'secret file');
});

test('example files and public keys are not secret-looking', () => {
  assert.equal(outcome(`cat ${ENV_FILE}.example`), 'ok');
  assert.equal(outcome('cat id_rsa.pub'), 'ok');
});

test('a folder that only contains a secret-looking name below it is not refused', () => {
  assert.equal(outcome('ls apps'), 'ok');
  assert.equal(outcome('grep -r x apps'), 'ok');
});

test('a path written into a rule is the user choice and stays allowed', () => {
  assert.equal(outcome(`cat ${ENV_FILE}.production`), 'ok');
  assert.equal(outcome('cat secrets/deep/token', { allow: ['cat secrets/deep/token'] }), 'ok');
});

test('a target without protect has only the name check', () => {
  assert.equal(outcome('ls .', { protect: undefined }), 'ok');
  assert.equal(outcome('cat secrets/deep/token', { protect: undefined }), 'ok');
  assert.equal(outcome(`cat ${ENV_FILE}`, { protect: undefined }), 'secret file');
});

test('a protect list that is not usable is ignored entry by entry', () => {
  assert.deepEqual(guardedPaths({ protect: 'secrets' }, dir), []);
  assert.deepEqual(guardedPaths({}, dir), []);
  const list = guardedPaths({ protect: [7, '', 'secrets', 'pub'] }, dir);
  assert.ok(list.includes(path.join(dir, 'secrets')));
  assert.ok(list.includes(path.join(dir, 'pub')));
  assert.ok(!list.includes(dir));
  fs.symlinkSync('loop', path.join(dir, 'loop'));
  try {
    assert.deepEqual(guardedPaths({ protect: ['loop'] }, dir), [path.join(dir, 'loop')]);
  } finally {
    fs.rmSync(path.join(dir, 'loop'));
  }
});

test('a protected path is compared without regard to letter case on every system', () => {
  assert.equal(outcome('cat SECRETS/deep/token'), 'protected path');
});

test('the outside-the-folder refusal still comes first', () => {
  fs.symlinkSync('/etc', path.join(dir, 'out'));
  try {
    assert.equal(outcome('cat out/server.pem'), 'outside the folder');
  } finally {
    fs.rmSync(path.join(dir, 'out'));
  }
});

test('a reviewed command cannot name a protected or secret-looking path', () => {
  const t = target({ review: true, programs: ['ls', 'sort'] });
  const scope = () => localScope(t, env);
  assert.equal(reviewProblem(['ls', '-l', 'secrets'], t, env, scope()).short, 'protected path');
  assert.equal(reviewProblem(['ls', '.'], t, env, scope()).short, 'protected path');
  assert.equal(reviewProblem(['ls', ENV_FILE], t, env, scope()).short, 'secret file');
  assert.equal(reviewProblem(['sort', '-opub', 'a.txt'], t, env, scope()).short, 'protected path');
  assert.equal(reviewProblem(['ls', '-l', 'src'], t, env, scope()), null);
});

test('a value glued to a flag is also checked when it names a protect entry that does not exist yet', () => {
  const t = target({ review: true, programs: ['sort'], protect: ['newout'] });
  const scope = () => localScope(t, env);
  assert.equal(reviewProblem(['sort', '-onewout', 'a.txt'], t, env, scope()).short, 'protected path');
  assert.equal(reviewProblem(['sort', '-onewfile', 'a.txt'], t, env, scope()), null);
});

test('a secret-looking word is refused even as a search term', () => {
  const extra = { allow: ['grep * *'] };
  assert.equal(outcome('grep id_rsa src', extra), 'secret file');
  assert.equal(outcome('grep main..dev src', extra), 'ok');
  assert.equal(outcome('grep 42 src', extra), 'ok');
});

test('valueProblem works out its own scope when none is given', () => {
  assert.equal(valueProblem('secrets', target(), env).short, 'protected path');
  assert.equal(valueProblem('a.txt', target(), env), null);
});
