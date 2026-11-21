import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { callTool } from '../src/tools.js';
import { askReview, startReviewServer } from '../src/review.js';
import {
  cleanupAll, fakeProcess, launch, listenerTotal, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

const KEY = 'k-123';
const POLICY = 'read only';
const ANSWER = JSON.stringify({
  choices: [{ message: { content: '{"verdict":"allow","certainty":"sure","reason":"fine"}' } }],
});

const providers = [];
after(async () => {
  cleanupAll();
  for (const p of providers) {
    p.server.closeAllConnections();
    await new Promise((resolve) => p.server.close(resolve));
  }
});

async function provider() {
  const seen = [];
  const state = { hold: false };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = {
        url: req.url, authorization: req.headers.authorization, body: JSON.parse(body), stopped: false,
      };
      seen.push(entry);
      if (state.hold) {
        res.on('close', () => { entry.stopped = true; });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(ANSWER);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = {
    server, seen, state, address: `127.0.0.1:${server.address().port}`,
  };
  providers.push(p);
  return p;
}

const userMessage = (entry) => JSON.parse(entry.body.messages[1].content);

async function reviewWorld({
  ssh = [
    { name: 'web1', host: 'web1.example.com', allow: ['uptime'], review: { reviewer: 'r1', policy: POLICY } },
    { name: 'web2', host: 'web2.example.com', allow: ['uptime'], review: { reviewer: 'r2', policy: POLICY } },
    { name: 'web3', host: 'web3.example.com', allow: ['uptime'] },
  ],
  kubernetes = [],
  local = [],
  extraEnv = {},
  reviewerExtra = {},
} = {}) {
  const p = await provider();
  const world = await makeWorld({
    ssh, kubernetes, local, extraEnv: { TEST_REVIEW_KEY: KEY, ...extraEnv },
  });
  delete world.env.TEST_MISSING_KEY;
  const inventoryFile = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  const baseUrl = `http://${p.address}/v1`;
  inventory.reviewers = {
    r1: {
      baseUrl, model: 'test-model', keyEnv: 'TEST_REVIEW_KEY', ...reviewerExtra,
    },
    r2: { baseUrl, model: 'test-model', keyEnv: 'TEST_MISSING_KEY' },
    r3: { baseUrl, model: 'test-model' },
  };
  fs.writeFileSync(inventoryFile, JSON.stringify(inventory));
  world.provider = p;
  world.reviewSocket = path.join(world.socketDir, 'review-sock');
  return world;
}

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function assertNowhere(files, needles) {
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of needles) assert.ok(!text.includes(needle), `${needle} found in ${file}`);
  }
}

test('1. only the reviewed target with a key carries review: true, nothing secret reaches the session folder, and the socket is private', async () => {
  const world = await reviewWorld();
  const run = launch(world, { ssh: ['web1', 'web2', 'web3'] });
  await ready(run);
  const session = sessionOf(world);
  assert.deepEqual(session.targets.map((t) => [t.name, t.review]), [['web1', true], ['web2', undefined], ['web3', undefined]]);
  assert.equal(Object.hasOwn(session.targets[1], 'review'), false);
  assert.equal(Object.hasOwn(session.targets[2], 'review'), false);
  assert.equal(Object.hasOwn(session.targets[0], 'programs'), false);
  const needles = [KEY, POLICY, world.provider.address];
  assertNowhere(filesUnder(world.sessionDir), needles);
  const stat = fs.statSync(world.reviewSocket);
  assert.ok(stat.isSocket());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(world.socketDir).mode & 0o777, 0o700);
  assert.equal(await stopWith(run), 0);
});

test('2. the log names the reviewer of web1 and says why review is off on web2', async () => {
  const world = await reviewWorld();
  const run = launch(world, { ssh: ['web1', 'web2', 'web3'] });
  await ready(run);
  const err = run.proc.stderr.text;
  assert.match(err, /ssh\s+web1\s+REVIEW\s+reviewer r1, accepts sure/);
  assert.match(err, /ssh\s+web2\s+WARN\s+review is off: TEST_MISSING_KEY is not set/);
  assert.ok(!/web3\s+(REVIEW|WARN)/.test(err), err);
  assert.equal(await stopWith(run), 0);
});

test('3. an unlisted command on web1 is approved by the model, which gets the key and only the policy, target and command', async () => {
  const world = await reviewWorld();
  const run = launch(world, { ssh: ['web1', 'web2', 'web3'] });
  await ready(run);
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, world.env);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('ran web1 df -h'), r.text);
  assert.equal(world.provider.seen.length, 1);
  const [seen] = world.provider.seen;
  assert.equal(seen.url, '/v1/chat/completions');
  assert.equal(seen.authorization, `Bearer ${KEY}`);
  assert.equal(seen.body.model, 'test-model');
  assert.deepEqual(userMessage(seen), { policy: POLICY, target: { kind: 'ssh', name: 'web1' }, command: ['df', '-h'] });
  await waitFor(() => /ssh\s+web1\s+ok .*df -h/.test(run.proc.stdout.text), 10000, 'the call line');
  assert.equal(await stopWith(run), 0);
  const everything = [run.proc.stdout.text, run.proc.stderr.text].join('\n');
  assert.ok(!everything.includes(KEY));
  assertNowhere(filesUnder(path.join(world.base, 'st')), [KEY, POLICY, world.provider.address]);
});

test('4. an unlisted command on web2, whose key is missing, is refused without asking the model', async () => {
  const world = await reviewWorld();
  const run = launch(world, { ssh: ['web1', 'web2', 'web3'] });
  await ready(run);
  const r = await callTool('ssh_exec', { server: 'web2', command: 'df -h' }, world.env);
  assert.equal(r.isError, true);
  assert.match(r.text, /^REFUSED \(ssh web2\)/);
  assert.ok(!r.text.includes('reviewer'), r.text);
  assert.equal(world.provider.seen.length, 0);
  const listed = await callTool('ssh_exec', { server: 'web2', command: 'uptime' }, world.env);
  assert.equal(listed.isError, false, listed.text);
  assert.equal(await stopWith(run), 0);
});

test('5. after the stop the socket is gone and asking it answers review not available', async () => {
  const world = await reviewWorld();
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  assert.ok(fs.existsSync(world.reviewSocket));
  assert.equal(await stopWith(run), 0);
  assert.equal(fs.existsSync(world.reviewSocket), false);
  assert.deepEqual(await askReview(world.reviewSocket, { kind: 'ssh', name: 'web1', argv: ['df'] }), {
    allowed: false, short: 'review not available',
  });
  assert.equal(listenerTotal(run.proc), 0);
});

test('6. no socket is created when no opened target has review', async () => {
  for (const names of [['web3'], ['web2', 'web3']]) {
    const world = await reviewWorld();
    const run = launch(world, { ssh: names });
    await ready(run);
    assert.deepEqual(fs.readdirSync(world.socketDir).filter((n) => n.startsWith('review')), [], names.join());
    assert.ok(!/REVIEW/.test(run.proc.stderr.text));
    assert.equal(await stopWith(run), 0);
  }
  const world = await reviewWorld({
    local: [{
      name: 'repo', cwd: '/tmp/ks-sp-no-such-folder-here', allow: ['cat *'], review: { reviewer: 'r1', policy: POLICY, programs: ['ls'] },
    }],
  });
  const run = launch(world, { ssh: ['web3'], local: ['repo'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /loc\s+repo\s+SKIPPED/);
  assert.equal(fs.existsSync(world.reviewSocket), false);
  assert.equal(await stopWith(run), 0);
});

test('7. a review service that cannot start turns review off with a warning and the session still starts', async () => {
  for (const failing of [
    async () => { throw new Error('no socket for you'); },
    () => { throw new Error('thrown at once'); },
  ]) {
    const world = await reviewWorld();
    const run = launch(world, { ssh: ['web1', 'web3'] }, { startReviewServer: failing });
    await ready(run);
    assert.match(run.proc.stderr.text, /ssh\s+web1\s+WARN\s+review is off: could not start the review service/);
    assert.ok(!/REVIEW/.test(run.proc.stderr.text));
    assert.match(run.proc.stdout.text, /READY +2 targets/);
    for (const t of sessionOf(world).targets) assert.equal(Object.hasOwn(t, 'review'), false, t.name);
    const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, world.env);
    assert.equal(r.isError, true);
    assert.equal(world.provider.seen.length, 0);
    assert.equal(await stopWith(run), 0);
  }
});

test('8. no child process of the session gets the key: not ssh, not the cluster proxy, not the command', async () => {
  const world = await reviewWorld({ kubernetes: [{ review: { reviewer: 'r1', policy: POLICY } }] });
  const sshLog = path.join(world.base, 'ssh-env.log');
  const kubeLog = path.join(world.base, 'kube-env.log');
  world.env.KSPROXY_FAKE_SSH_ENV_LOG = sshLog;
  world.env.KSPROXY_FAKE_KUBECTL_ENV_LOG = kubeLog;
  const run = launch(world, { ssh: ['web1'], kube: ['lab'] });
  await ready(run);
  assert.deepEqual(sessionOf(world).targets.map((t) => [t.kind, t.name, t.review]), [['ssh', 'web1', true], ['kubernetes', 'lab', true]]);
  assert.match(run.proc.stderr.text, /kube\s+lab\s+REVIEW\s+reviewer r1, accepts sure/);
  const r = await callTool('ssh_exec', { server: 'web1', command: 'env' }, world.env);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /ENV=\[/);
  assert.ok(!r.text.includes('TEST_REVIEW_KEY'), r.text);
  assert.equal(world.provider.seen.length, 1);
  assert.equal(await stopWith(run), 0);

  const entries = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const ssh = entries(sshLog);
  const kube = entries(kubeLog);
  assert.ok(ssh.some((e) => e.argv.includes('-M')), 'the master was started');
  assert.ok(ssh.some((e) => e.argv.includes('-O') && e.argv.includes('exit')), 'the master was closed');
  assert.ok(ssh.some((e) => e.argv.includes('-F') && e.argv.at(-1) === 'env'), 'the command ran');
  assert.ok(kube.some((e) => e.argv.includes('proxy')), 'the proxy was started');
  for (const e of [...ssh, ...kube]) {
    assert.equal(Object.hasOwn(e.env, 'TEST_REVIEW_KEY'), false, JSON.stringify(e.argv));
    assert.ok(!Object.values(e.env).includes(KEY), JSON.stringify(e.argv));
  }
  assert.ok(!fs.readFileSync(sshLog, 'utf8').includes(KEY));
  assert.ok(!fs.readFileSync(kubeLog, 'utf8').includes(KEY));
});

test('9. a reviewed local target records its programs, is reviewed as local, and its command never gets the key', async () => {
  const world = await reviewWorld({
    ssh: [],
    local: [{
      name: 'repo', allow: ['cat *'], review: { reviewer: 'r1', policy: POLICY, programs: ['ls', 'env'] },
    }],
  });
  const run = launch(world, { local: ['repo'] });
  await ready(run);
  const [t] = sessionOf(world).targets;
  assert.equal(t.review, true);
  assert.deepEqual(t.programs, ['ls', 'env']);
  assert.match(run.proc.stderr.text, /loc\s+repo\s+REVIEW\s+reviewer r1, accepts sure/);
  assertNowhere(filesUnder(world.sessionDir), [KEY, POLICY, world.provider.address]);

  const r = await callTool('local_exec', { target: 'repo', command: 'ls -a' }, world.env);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('a.txt'), r.text);
  assert.deepEqual(userMessage(world.provider.seen[0]), { policy: POLICY, target: { kind: 'local', name: 'repo' }, command: ['ls', '-a'] });

  const env = await callTool('local_exec', { target: 'repo', command: 'env' }, world.env);
  assert.equal(env.isError, false, env.text);
  assert.ok(env.text.includes('PATH='), env.text);
  assert.ok(!env.text.includes('TEST_REVIEW_KEY'), env.text);
  assert.ok(!env.text.includes(KEY), env.text);
  assert.equal(await stopWith(run), 0);
});

test('a reviewer without keyEnv is asked without an authorization header', async () => {
  const world = await reviewWorld({
    ssh: [{
      name: 'web4', host: 'web4.example.com', allow: ['uptime'], review: { reviewer: 'r3', policy: POLICY, accept: ['sure', 'likely'] },
    }],
  });
  const run = launch(world, { ssh: ['web4'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /ssh\s+web4\s+REVIEW\s+reviewer r3, accepts sure and likely/);
  const r = await callTool('ssh_exec', { server: 'web4', command: 'df -h' }, world.env);
  assert.equal(r.isError, false, r.text);
  assert.equal(world.provider.seen.length, 1);
  assert.equal(world.provider.seen[0].authorization, undefined);
  assert.equal(await stopWith(run), 0);
});

test('an empty key variable counts as not set', async () => {
  const world = await reviewWorld({ extraEnv: { TEST_REVIEW_KEY: '' } });
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /ssh\s+web1\s+WARN\s+review is off: TEST_REVIEW_KEY is not set/);
  assert.equal(fs.existsSync(world.reviewSocket), false);
  assert.equal(Object.hasOwn(sessionOf(world).targets[0], 'review'), false);
  assert.equal(await stopWith(run), 0);
});

test('every way of stopping closes the review server and removes the socket', async () => {
  const ways = [
    ['SIGINT', (run) => run.proc.emit('SIGINT')],
    ['SIGTERM', (run) => run.proc.emit('SIGTERM')],
    ['SIGHUP', (run) => run.proc.emit('SIGHUP')],
    ['fatal', (run) => run.proc.emit('uncaughtException', new Error('boom'))],
    ['output closed', (run) => run.proc.stdout.emit('error', new Error('EPIPE'))],
  ];
  for (const [label, stop] of ways) {
    const world = await reviewWorld();
    const run = launch(world, { ssh: ['web1'] });
    await ready(run);
    assert.ok(fs.statSync(world.reviewSocket).isSocket(), label);
    stop(run);
    await run.done;
    assert.equal(fs.existsSync(world.reviewSocket), false, label);
    const answer = await askReview(world.reviewSocket, { kind: 'ssh', name: 'web1', argv: ['df'] });
    assert.equal(answer.short, 'review not available', label);
    assert.equal(listenerTotal(run.proc), 0, label);
  }
});

test('a stop does not wait for a model call in flight, and that call is cut off', async () => {
  const world = await reviewWorld({ reviewerExtra: { timeoutSeconds: 60 } });
  world.provider.state.hold = true;
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  const call = callTool('ssh_exec', { server: 'web1', command: 'df -h' }, world.env);
  await waitFor(() => world.provider.seen.length === 1, 10000, 'the model call');
  const started = Date.now();
  assert.equal(await stopWith(run), 0);
  assert.ok(Date.now() - started < 30000);
  const r = await call;
  assert.equal(r.isError, true);
  assert.match(r.text, /^REFUSED \(ssh web1\): .*The reviewer did not approve it\.$/);
  await waitFor(() => world.provider.seen[0].stopped, 10000, 'the model call to be cut off');
  assert.equal(fs.existsSync(world.reviewSocket), false);
});

test('a stop that arrives while the review service starts closes it and writes no session', async () => {
  const world = await reviewWorld();
  const proc = fakeProcess();
  let made = null;
  const run = launch(world, { ssh: ['web1'] }, {
    process: proc,
    startReviewServer: (options) => {
      proc.emit('SIGINT');
      made = startReviewServer(options);
      return made;
    },
  });
  assert.equal(await run.done, 0);
  assert.ok(made !== null);
  assert.ok(!proc.stdout.text.includes('Leave this running'));
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.match(proc.stderr.text, /CLOSED/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.equal(fs.existsSync(world.reviewSocket), false);
  assert.equal((await askReview(world.reviewSocket, { kind: 'ssh', name: 'web1', argv: ['df'] })).short, 'review not available');
});

test('a stale review socket left by a killed run is not sent an ssh -O exit and does not stop the next start', async () => {
  const world = await reviewWorld();
  const sshLog = path.join(world.base, 'ssh.log');
  world.env.KSPROXY_FAKE_SSH_LOG = sshLog;
  fs.mkdirSync(world.socketDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(world.reviewSocket, 'left over');
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  assert.ok(fs.statSync(world.reviewSocket).isSocket());
  const calls = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!calls.some((argv) => argv.includes(world.reviewSocket)), JSON.stringify(calls));
  const r = await callTool('ssh_exec', { server: 'web1', command: 'df -h' }, world.env);
  assert.equal(r.isError, false, r.text);
  assert.equal(await stopWith(run), 0);
  assert.equal(fs.existsSync(world.reviewSocket), false);
});
