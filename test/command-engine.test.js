import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimalEnv, run } from '../src/exec.js';
import { WORK_FOLDER, runClient, workRoot } from '../src/kinds/engines/command.js';
import { tempDir } from './temp.js';

const fake = fileURLToPath(new URL('./fixtures/fake-client.js', import.meta.url));
const node = process.execPath;
const SECRET = 'cmd-S3CR3T-engine-4f1e-unmistakable';

const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world() {
  const base = fs.realpathSync(tempDir('ks-cmd-'));
  dirs.push(base);
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, LANG: 'C', KSPROXY_STATE_DIR: path.join(base, 'st'), OTHER_VARIABLE: 'should-not-pass',
  };
  return { base, env, root: path.join(base, 'st', WORK_FOLDER) };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const call = (env, extra = {}) => runClient({
  program: fake, fixedArgs: ['--format', 'text'], words: ['usage', 'daily'], env, timeoutMs: 10000, maxBytes: 262144, ...extra,
});

test('runClient: the exact argument array, a small environment with the given entries, an empty private folder removed afterwards', async () => {
  const { env, root } = world();
  const result = await call(env, { childEnv: { REPORT_TOKEN: SECRET, DOC: '{"a": "$(id)"}' } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(Object.keys(result).sort(), ['exitCode', 'stderr', 'stdout', 'timedOut', 'truncated']);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.argv, ['--format', 'text', 'usage', 'daily']);
  assert.deepEqual(report.entries, []);
  assert.equal(path.dirname(report.cwd), root);
  assert.match(path.basename(report.cwd), /^cmd-/);
  assert.equal(report.env.REPORT_TOKEN, SECRET);
  assert.equal(report.env.DOC, '{"a": "$(id)"}');
  // Node itself passes NODE_V8_COVERAGE to a child while the tests measure coverage, and macOS may add
  // __CF_USER_TEXT_ENCODING; neither comes from ksproxy.
  const allowed = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'REPORT_TOKEN', 'DOC', 'NODE_V8_COVERAGE', '__CF_USER_TEXT_ENCODING']);
  assert.deepEqual(Object.keys(report.env).filter((key) => !allowed.has(key)), []);
  assert.equal(report.env.OTHER_VARIABLE, undefined);
  assert.ok(Object.keys(report.env).every((key) => !key.startsWith('KSPROXY_')));
  assert.deepEqual(fs.readdirSync(root), [], 'the working folder is gone');
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
});

test('runClient: folderPaths names entries of the environment whose value is a path inside the working folder, never created', async () => {
  const { env, root } = world();
  const result = await call(env, { childEnv: { A: 'x' }, folderPaths: { LOGIN_FILE: 'no-login.cnf' } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.env.LOGIN_FILE, path.join(report.cwd, 'no-login.cnf'));
  assert.equal(report.env.A, 'x');
  assert.deepEqual(report.entries, []);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(report.env.HOME, env.HOME, 'HOME passes through unless the kind asks');
});

test('runClient: homeInWorkFolder sets HOME of the child to its working folder, which is removed afterwards', async () => {
  const { env, root } = world();
  const report = JSON.parse((await call(env, { childEnv: { HOME: '/elsewhere' }, homeInWorkFolder: true })).stdout);
  assert.equal(report.env.HOME, report.cwd);
  assert.equal(path.dirname(report.cwd), root);
  assert.equal(fs.existsSync(report.cwd), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('runClient: the working folder has mode 0700 while the call runs, and a file left in it is removed', async () => {
  const { env, base, root } = world();
  const pidFile = path.join(base, 'pid');
  const pending = call(env, { words: ['sleep', '--pid-file', pidFile], timeoutMs: 4000 });
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
  const [folder] = fs.readdirSync(root);
  assert.equal(fs.statSync(path.join(root, folder)).mode & 0o777, 0o700);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);

  const touched = await call(env, { words: ['touch'] });
  assert.deepEqual(JSON.parse(touched.stdout).entries, []);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('runClient: a failing program, and a program that cannot be started', async () => {
  const { env, root } = world();
  const failed = await call(env, { words: ['fail'] });
  assert.deepEqual(failed, {
    exitCode: 3, stdout: '', stderr: 'it failed\n', timedOut: false, truncated: false,
  });
  const missing = await call(env, { program: path.join(root, '..', 'gone') });
  assert.equal(missing.exitCode, null);
  assert.match(missing.stderr, /^could not start the program: .*ENOENT/);
  assert.equal(missing.timedOut, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('runClient: the child is stopped the moment the output limit is reached, and the result is marked truncated', async () => {
  const { env, base, root } = world();
  const pidFile = path.join(base, 'pid');
  const started = Date.now();
  const result = await call(env, { words: ['flood', '--pid-file', pidFile], maxBytes: 100000, timeoutMs: 20000 });
  assert.ok(Date.now() - started < 5000, 'stopped long before the time limit');
  assert.equal(result.truncated, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.equal(Buffer.byteLength(result.stdout), 100000);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('runClient: an abort stops the child at once, counts as timed out, and removes the folder', async () => {
  const { env, base, root } = world();
  const pidFile = path.join(base, 'pid');
  const controller = new AbortController();
  const pending = call(env, { words: ['sleep', '--pid-file', pidFile], timeoutMs: 30000, signal: controller.signal });
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => { setTimeout(resolve, 20); });
  const started = Date.now();
  controller.abort();
  const result = await pending;
  assert.ok(Date.now() - started < 3000);
  assert.equal(result.timedOut, true);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
  assert.deepEqual(fs.readdirSync(root), []);

  const early = new AbortController();
  early.abort();
  const never = await call(env, { words: ['sleep'], timeoutMs: 30000, signal: early.signal });
  assert.equal(never.timedOut, true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('workRoot: created with mode 0700, and refused when it is a link or a file', () => {
  const { env, base, root } = world();
  assert.equal(workRoot(env), root);
  fs.chmodSync(root, 0o755);
  workRoot(env);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  fs.rmSync(root, { recursive: true });
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, root);
  assert.throws(() => workRoot(env), /the working folder root is not a folder/);
  fs.rmSync(root);
  fs.writeFileSync(root, 'x');
  assert.throws(() => workRoot(env));
});

test('run: without the new options nothing changes, with stopAtLimit the child is stopped, with a signal it is stopped', async () => {
  const env = minimalEnv(process.env);
  const plain = await run(node, ['-e', 'process.stdout.write("x".repeat(5000)); setTimeout(() => {}, 300)'], { maxBytes: 1000, env });
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.truncated, true);
  const flood = 'const c = "y".repeat(65536); const w = () => { while (process.stdout.write(c)); process.stdout.once("drain", w); }; w();';
  const stopped = await run(node, ['-e', flood], {
    maxBytes: 1000, env, stopAtLimit: true, timeoutMs: 20000,
  });
  assert.equal(stopped.truncated, true);
  assert.equal(stopped.timedOut, false);
  assert.equal(stopped.signal, 'SIGKILL');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const aborted = await run(node, ['-e', 'setTimeout(() => {}, 30000)'], { env, signal: controller.signal, timeoutMs: 20000 });
  assert.equal(aborted.signal, 'SIGKILL');
  assert.equal(aborted.timedOut, false);
  const thrown = await run(node, ['bad\0argument'], { env, signal: controller.signal });
  assert.ok(thrown.spawnError !== null);
});
