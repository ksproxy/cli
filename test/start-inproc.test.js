import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { start, startFollower as realStartFollower } from '../src/start.js';
import { callTool } from '../src/tools.js';
import { readAuditEntries } from '../src/audit.js';
import { writeSession } from '../src/session.js';
import {
  alive, cleanupAll, fakeProcess, launch, listenerTotal, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

after(() => cleanupAll());

test('a full session: opens ssh, a tunnelled cluster and writes the session folder, counts calls, and closes cleanly', async () => {
  const world = await makeWorld({ kubernetes: [{ tunnel: true }] });
  const run = launch(world, { all: true });
  await ready(run);

  const out = run.proc.stdout.text;
  assert.ok(out.startsWith(`Session folder: ${world.sessionDir}\nMCP config (add once to your agent):\n`));
  assert.ok(out.includes(`Claude Code: claude mcp add ksproxy -- ${process.execPath} `));
  assert.match(out, /READY +2 targets, pid \d+/);
  const config = JSON.parse(out.slice(out.indexOf('{'), out.indexOf('\n}\n') + 2));
  assert.equal(config.mcpServers.ksproxy.command, process.execPath);
  assert.equal(config.mcpServers.ksproxy.args[1], 'mcp');

  const err = run.proc.stderr.text;
  assert.match(err, /ssh {2}web1 +OPENING +web1\.example\.com/);
  assert.match(err, /ssh {2}web1 +UP/);
  assert.match(err, /kube lab +OPENING +port \d+/);
  assert.match(err, /kube lab +UP/);

  for (const name of ['session.json', 'ssh_config', 'kubeconfig', 'AGENT.md', 'mcp.json', 'audit.log']) {
    assert.ok(fs.existsSync(path.join(world.sessionDir, name)), name);
  }
  assert.equal(fs.statSync(world.sessionDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(world.sessionDir, 'session.json')).mode & 0o777, 0o600);
  const session = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));
  assert.equal(session.pid, process.pid);
  assert.deepEqual(session.targets.map((t) => `${t.kind}:${t.name}:${t.state}`), ['ssh:web1:up', 'kubernetes:lab:up']);
  const proxyPid = JSON.parse(fs.readFileSync(path.join(world.socketDir, 'kube-lab.pid'), 'utf8')).pid;
  assert.ok(alive(proxyPid));

  assert.equal((await callTool('list_targets', {}, world.env)).isError, false);
  assert.equal((await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, world.env)).isError, false);
  assert.equal((await callTool('ssh_exec', { server: 'web1', command: 'fail' }, world.env)).isError, true);
  assert.equal((await callTool('ssh_exec', { server: 'web1', command: 'rm x' }, world.env)).isError, true);
  await waitFor(() => /DENIED/.test(run.proc.stdout.text) && /exit 3/.test(run.proc.stdout.text), 10000, 'the call lines');
  assert.match(run.proc.stdout.text, /LIST +list_targets/);
  assert.match(run.proc.stdout.text, /ssh {2}web1 +ok .*uptime/);

  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.match(run.proc.stderr.text, /CLOSED +3 calls: 1 ok, 1 failed, 1 denied/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.deepEqual(fs.readdirSync(world.socketDir), []);
  assert.equal(alive(proxyPid), false);
  assert.equal(listenerTotal(run.proc), 0);

  const events = readAuditEntries(path.join(world.sessionDir, 'audit.log')).map(({ entry }) => entry.event);
  assert.ok(events.includes('session_start'));
  assert.ok(events.includes('session_closing'));
  assert.equal(events.at(-1), 'session_end');
});

test('SIGTERM, SIGHUP and an output error each stop the session with their own reason', async () => {
  const cases = [
    ['SIGTERM', /CLOSING +terminated/],
    ['SIGHUP', /CLOSING +terminal closed/],
  ];
  for (const [signal, pattern] of cases) {
    const world = await makeWorld();
    const run = launch(world, { ssh: ['web1'] });
    await ready(run);
    assert.equal(await stopWith(run, signal), 0, signal);
    assert.match(run.proc.stderr.text, pattern, signal);
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  }

  for (const stream of ['stdout', 'stderr']) {
    const world = await makeWorld();
    const run = launch(world, { ssh: ['web1'] });
    await ready(run);
    run.proc[stream].emit('error', new Error('EPIPE'));
    assert.equal(await run.done, 0, stream);
    if (stream === 'stdout') assert.match(run.proc.stderr.text, /CLOSING +output closed/);
    else assert.ok(!run.proc.stdout.text.includes('CLOSING'));
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  }
});

test('a stdout that throws on write stops the session and later writes are skipped', async () => {
  const world = await makeWorld();
  const proc = fakeProcess();
  let attempts = 0;
  proc.stdout.write = () => {
    attempts += 1;
    throw new Error('stream destroyed');
  };
  const run = launch(world, { ssh: ['web1'] }, { process: proc });
  assert.equal(await run.done, 0);
  assert.equal(attempts, 1);
  assert.match(proc.stderr.text, /CLOSING +output closed/);
  assert.match(proc.stderr.text, /CLOSED/);
});

test('without a selection and without a terminal start asks for a flag', async () => {
  const world = await makeWorld();
  const run = launch(world, {});
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'no targets selected: use --ssh, --kube, --local or --all when not running in a terminal\n');
});

test('unknown names are reported with the known ones, and an empty kind says none', async () => {
  const world = await makeWorld({ kubernetes: [{}] });
  let run = launch(world, { ssh: ['nope'] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown ssh target "nope"; known ssh targets: web1\n');

  run = launch(world, { kube: ['nope'] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown kube target "nope"; known kube targets: lab\n');

  const none = await makeWorld({ ssh: [] });
  run = launch(none, { kube: ['x'] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'unknown kube target "x"; known kube targets: none\n');
});

test('an empty name list selects nothing', async () => {
  const world = await makeWorld();
  const run = launch(world, { ssh: [] });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'nothing selected\n');
});

test('on a terminal the kind and the targets are asked for, and the answers decide what opens', async () => {
  const world = await makeWorld({
    ssh: [
      {
        name: 'web1', host: 'web1.example.com', description: 'web box', allow: ['uptime'],
      },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
    kubernetes: [{}],
  });
  const asked = [];
  const answers = [[1], [0]];
  const checkbox = async (request) => {
    asked.push(request);
    return answers.shift();
  };
  const proc = fakeProcess();
  proc.stdin.isTTY = true;
  const run = launch(world, {}, { process: proc, checkbox });
  await ready(run);
  assert.deepEqual(asked.map((a) => a.title), ['Which kinds of proxy?', 'Which kubernetes targets?']);
  assert.deepEqual(asked[0].items, [
    { key: 'ssh', label: 'ssh', hint: '2 server(s)' },
    { key: 'kubernetes', label: 'kubernetes', hint: '1 cluster(s)' },
  ]);
  assert.deepEqual(asked[1].items, [{ label: 'lab', hint: `${world.kubeconfig} — lab cluster` }]);
  assert.match(proc.stderr.text, /kube lab +UP/);
  assert.ok(!/ssh {2}web/.test(proc.stderr.text));
  assert.equal(await stopWith(run), 0);
});

test('on a terminal the ssh choices show the host, with the description when there is one', async () => {
  const world = await makeWorld({
    ssh: [
      {
        name: 'web1', host: 'web1.example.com', description: 'web box', allow: ['uptime'],
      },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
  });
  const asked = [];
  const checkbox = async (request) => {
    asked.push(request);
    return [1];
  };
  const proc = fakeProcess();
  proc.stdin.isTTY = true;
  const run = launch(world, {}, { process: proc, checkbox });
  await ready(run);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'Which ssh targets?');
  assert.deepEqual(asked[0].items, [
    { label: 'web1', hint: 'web1.example.com — web box' },
    { label: 'web2', hint: 'web2.example.com' },
  ]);
  assert.match(proc.stderr.text, /ssh {2}web2 +UP/);
  assert.ok(!/ssh {2}web1 /.test(proc.stderr.text));
  assert.equal(await stopWith(run), 0);
});

test('cancelling either question, or choosing no kind, ends with nothing selected', async () => {
  const world = await makeWorld({ kubernetes: [{}] });
  for (const answers of [[null], [[0, 1], null], [[0, 1], [0], null], [[]]]) {
    const proc = fakeProcess();
    proc.stdin.isTTY = true;
    const checkbox = async () => answers.shift();
    const run = launch(world, {}, { process: proc, checkbox });
    assert.equal(await run.done, 1);
    assert.equal(proc.stderr.text, 'nothing selected\n');
  }
});

test('with the real selector on a fake terminal, keys pick the target that opens', async () => {
  const world = await makeWorld();
  const proc = fakeProcess();
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  proc.stdin = stdin;
  const run = launch(world, {}, { process: proc });
  await waitFor(() => proc.stderr.text.includes('Which ssh targets?'), 10000, 'the question');
  stdin.write(' ');
  stdin.write('\r');
  await ready(run);
  assert.match(proc.stderr.text, /ssh {2}web1 +UP/);
  assert.equal(await stopWith(run), 0);
});

test('an invalid inventory and a missing inventory are reported', async () => {
  const world = await makeWorld();
  fs.writeFileSync(path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json'), '{broken');
  let run = launch(world, { all: true });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /is not valid JSON/);

  fs.rmSync(path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json'));
  run = launch(world, { all: true });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /inventory not found: .*; run: ksproxy init/);
});

test('an error that is not an inventory error is thrown to the caller and the process listeners are removed', async () => {
  const proc = fakeProcess();
  await assert.rejects(start({ all: true }, null, { process: proc }), TypeError);
  assert.equal(listenerTotal(proc), 0);
});

test('a live session blocks a second start', async () => {
  const world = await makeWorld();
  fs.mkdirSync(world.sessionDir, { recursive: true });
  writeSession(world.sessionDir, { version: 1, pid: process.pid, targets: [] });
  const run = launch(world, { all: true });
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, `a session is already running (pid ${process.pid}); stop it with Ctrl-C in its terminal\n`);
  assert.ok(fs.existsSync(path.join(world.sessionDir, 'session.json')));
});

test('a state folder path that is too long is reported before anything opens', async () => {
  const world = await makeWorld();
  const env = { ...world.env, KSPROXY_STATE_DIR: path.join(world.base, 'x'.repeat(110)) };
  const proc = fakeProcess();
  assert.equal(await start({ all: true }, env, { process: proc }), 1);
  assert.match(proc.stderr.text, /socket path too long/);
  assert.ok(!/OPENING/.test(proc.stderr.text));
});

test('when every target fails to open nothing could be opened is reported and start exits 1', async () => {
  const world = await makeWorld({ extraEnv: { KSPROXY_FAKE_SSH_FAIL_HOST: 'web1.example.com' } });
  const run = launch(world, { all: true });
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /ssh {2}web1 +SKIPPED +ssh exited with code 255/);
  assert.match(run.proc.stderr.text, /nothing could be opened/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
});

test('a cluster that cannot be opened is skipped while the ssh target stays up', async () => {
  const world = await makeWorld({ kubernetes: [{}] });
  fs.rmSync(world.kubeconfig);
  const run = launch(world, { all: true });
  await ready(run);
  assert.match(run.proc.stderr.text, /kube lab +SKIPPED +kubeconfig not found/);
  assert.match(run.proc.stderr.text, /ssh {2}web1 +UP/);
  assert.equal(await stopWith(run), 0);
});

test('a target with an empty allowlist is announced with a warning before it opens', async () => {
  const world = await makeWorld({
    ssh: [{ name: 'web1', host: 'web1.example.com', allow: [] }],
    kubernetes: [{ allow: [] }],
  });
  const run = launch(world, { all: true });
  await ready(run);
  assert.match(run.proc.stderr.text, /ssh {2}web1 +WARN +allowlist is empty, every command will be refused/);
  assert.match(run.proc.stderr.text, /kube lab +WARN +allowlist is empty, every command will be refused/);
  assert.equal(await stopWith(run), 0);
});

test('a stop requested right after a target came up skips the targets that were still to open', async () => {
  const world = await makeWorld({
    ssh: [
      { name: 'web1', host: 'web1.example.com', allow: ['uptime'] },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
    kubernetes: [{}],
  });
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/ssh {2}web1 +UP/.test(text)) proc.emit('SIGINT');
  };
  const run = launch(world, { all: true }, { process: proc });
  assert.equal(await run.done, 0);
  assert.ok(!/web2/.test(proc.stderr.text));
  assert.ok(!/OPENING +port/.test(proc.stderr.text));
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.match(proc.stderr.text, /CLOSED +0 calls/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.deepEqual(fs.readdirSync(world.socketDir), []);
});

test('a stop requested while an ssh target is opening closes that connection again', async () => {
  const world = await makeWorld({ extraEnv: { KSPROXY_FAKE_SSH_CHECK_MS: '300' } });
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/OPENING/.test(text)) proc.emit('SIGINT');
  };
  const run = launch(world, { all: true }, { process: proc });
  assert.equal(await run.done, 0);
  assert.ok(!/ssh {2}web1 +UP/.test(proc.stderr.text));
  assert.match(proc.stderr.text, /CLOSING +Ctrl-C/);
  assert.equal(fs.existsSync(path.join(world.socketDir, 'ssh-web1')), false);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
});

test('a stop requested while a cluster is opening closes the proxy again, even when closing is slow', async () => {
  const world = await makeWorld({ ssh: [], kubernetes: [{}] });
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/OPENING/.test(text)) proc.emit('SIGINT');
  };
  const run = launch(world, { all: true }, { process: proc, limits: { kubeCloseMs: 1 } });
  assert.equal(await run.done, 0);
  assert.ok(!/kube lab +UP/.test(proc.stderr.text));
  const pidFile = path.join(world.socketDir, 'kube-lab.pid');
  await waitFor(() => !fs.existsSync(pidFile), 10000, 'the pid file to go');
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
});

test('closing a cluster that takes longer than the limit kills its proxy', async () => {
  const world = await makeWorld({ ssh: [], kubernetes: [{}] });
  const run = launch(world, { all: true }, { limits: { kubeCloseMs: 1 } });
  await ready(run);
  const pid = JSON.parse(fs.readFileSync(path.join(world.socketDir, 'kube-lab.pid'), 'utf8')).pid;
  assert.equal(await stopWith(run), 0);
  await waitFor(() => !alive(pid), 10000, 'the proxy to be killed');
});

test('an uncaught exception closes everything, reports the error, and a second one is ignored', async () => {
  const world = await makeWorld({ kubernetes: [{}] });
  const run = launch(world, { all: true });
  await ready(run);
  const pid = JSON.parse(fs.readFileSync(path.join(world.socketDir, 'kube-lab.pid'), 'utf8')).pid;
  run.proc.emit('uncaughtException', new Error('boom'));
  run.proc.emit('unhandledRejection', 'second failure');
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /CLOSING +error: boom/);
  assert.ok(!run.proc.stderr.text.includes('second failure'));
  assert.match(run.proc.stderr.text, /CLOSED/);
  assert.equal(alive(pid), false);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
  assert.equal(listenerTotal(run.proc), 0);
});

test('an unhandled rejection with a plain value is reported as it is', async () => {
  const world = await makeWorld();
  const run = launch(world, { all: true });
  await ready(run);
  run.proc.emit('unhandledRejection', 'plain value');
  assert.equal(await run.done, 1);
  assert.match(run.proc.stderr.text, /CLOSING +error: plain value/);
});

test('a fatal error while a target is still opening waits for the open to finish and then exits 1', async () => {
  const world = await makeWorld({ extraEnv: { KSPROXY_FAKE_SSH_CHECK_MS: '300' } });
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/OPENING/.test(text)) proc.emit('uncaughtException', new Error('crashed while opening'));
  };
  const run = launch(world, { all: true }, { process: proc });
  assert.equal(await run.done, 1);
  assert.match(proc.stderr.text, /CLOSING +error: crashed while opening/);
  assert.match(proc.stderr.text, /CLOSED/);
  assert.equal(fs.existsSync(path.join(world.socketDir, 'ssh-web1')), false);
});

test('a failure while writing the session folder is reported, and clean-up still tries everything', async () => {
  const world = await makeWorld();
  const proc = fakeProcess();
  proc.stderr.onWrite = (text) => {
    if (/ssh {2}web1 +UP/.test(text)) fs.chmodSync(world.sessionDir, 0o500);
  };
  const run = launch(world, { all: true }, { process: proc });
  try {
    assert.equal(await run.done, 1);
    assert.match(proc.stderr.text, /CLOSING +error: EACCES/);
    assert.match(proc.stderr.text, /CLOSED/);
    assert.deepEqual(fs.readdirSync(world.socketDir), []);
  } finally {
    fs.chmodSync(world.sessionDir, 0o700);
  }
});

test('clean-up survives a session file and a socket folder entry that cannot be removed', async () => {
  const log = path.join('/tmp', `ks-cl-${process.pid}-${Date.now()}.log`);
  const world = await makeWorld({ extraEnv: { KSPROXY_FAKE_SSH_LOG: log } });
  const proc = fakeProcess();
  proc.stdout.onWrite = (text) => {
    if (text.startsWith('Session folder')) {
      const trap = path.join(world.socketDir, 'm-trap');
      fs.mkdirSync(path.join(trap, 'inner'), { recursive: true });
      fs.chmodSync(trap, 0o000);
      for (let i = 0; i < 6; i += 1) {
        fs.writeFileSync(path.join(world.socketDir, `a-extra-${i}`), 'x');
        fs.mkdirSync(path.join(world.socketDir, `z-extra-${i}`));
      }
      fs.chmodSync(world.sessionDir, 0o500);
    }
  };
  const run = launch(world, { all: true }, { process: proc });
  try {
    await ready(run);
    assert.equal(await stopWith(run), 0);
    assert.match(proc.stderr.text, /CLOSED/);
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), true);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(calls.some((argv) => argv.includes('-O') && argv.includes('exit')), 'the master was closed');
    assert.deepEqual(fs.readdirSync(world.socketDir), ['m-trap']);
  } finally {
    fs.chmodSync(path.join(world.socketDir, 'm-trap'), 0o700);
    fs.chmodSync(world.sessionDir, 0o700);
    fs.rmSync(log, { force: true });
  }
});

test('a follower whose stop throws never stops the clean-up: every master is closed and the session file is removed', async () => {
  const log = path.join('/tmp', `ks-fs-${process.pid}-${Date.now()}.log`);
  const world = await makeWorld({
    ssh: [
      { name: 'web1', host: 'web1.example.com', allow: ['uptime'] },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
    extraEnv: { KSPROXY_FAKE_SSH_LOG: log },
  });
  let stops = 0;
  const startFollower = (...args) => {
    const real = realStartFollower(...args);
    return {
      stop() {
        stops += 1;
        real.stop();
        throw new Error('stop failed');
      },
    };
  };
  const proc = fakeProcess();
  const run = launch(world, { all: true }, { process: proc, startFollower });
  try {
    await ready(run);
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), true);
    assert.equal(await stopWith(run), 0);
    assert.equal(stops, 1);
    assert.match(proc.stderr.text, /CLOSED/);
    assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
    const sockets = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((argv) => argv.includes('-O') && argv.includes('exit'))
      .map((argv) => argv[argv.indexOf('-S') + 1]);
    assert.deepEqual([...new Set(sockets.map((s) => path.basename(s)))].sort(), ['ssh-web1', 'ssh-web2']);
    assert.deepEqual(fs.readdirSync(world.socketDir), []);
  } finally {
    fs.rmSync(log, { force: true });
  }
});

test('an audit log that cannot be written does not stop the session', async () => {
  const world = await makeWorld();
  fs.mkdirSync(path.join(world.sessionDir, 'audit.log'), { recursive: true });
  const run = launch(world, { all: true });
  await ready(run);
  assert.match(run.proc.stderr.text, /ssh {2}web1 +UP/);
  assert.ok(fs.existsSync(path.join(world.sessionDir, 'session.json')));
  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED/);
});

test('health checks report a lost and a recovered connection for ssh and for a cluster', async () => {
  const world = await makeWorld({ kubernetes: [{}] });
  const states = { web1: 'up', lab: 'up' };
  let failOnce = true;
  const targetState = async (target) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('probe crashed');
    }
    return states[target.name];
  };
  const run = launch(world, { all: true }, { targetState });
  await ready(run);
  const seen = () => run.proc.stderr.text;
  const step = async (name, state, pattern) => {
    const before = (seen().match(new RegExp(pattern.source, 'g')) ?? []).length;
    states[name] = state;
    await waitFor(
      () => (seen().match(new RegExp(pattern.source, 'g')) ?? []).length > before,
      10000,
      `${name} ${state}`,
    );
  };
  await step('web1', 'down', /ssh {2}web1 +DOWN +connection lost/);
  await step('web1', 'up', /ssh {2}web1 +UP +connection is back/);
  await step('lab', 'down', /kube lab +DOWN +proxy is not answering/);
  await step('lab', 'up', /kube lab +UP +connection is back/);
  await step('lab', 'auth', /kube lab +DOWN +token rejected by the cluster/);
  await step('lab', 'up', /kube lab +UP +connection is back/);
  await step('lab', 'fail', /kube lab +DOWN +cluster did not answer, see kube-lab\.log/);
  assert.equal(await stopWith(run), 0);
});

test('a health tick that stops the session halfway does not check the remaining targets', async () => {
  const world = await makeWorld({
    ssh: [
      { name: 'web1', host: 'web1.example.com', allow: ['uptime'] },
      { name: 'web2', host: 'web2.example.com', allow: ['uptime'] },
    ],
  });
  const states = { web1: 'up', web2: 'up' };
  const checked = [];
  const targetState = async (target) => {
    checked.push(target.name);
    return states[target.name];
  };
  const proc = fakeProcess();
  const run = launch(world, { all: true }, { process: proc, targetState });
  await ready(run);
  proc.stderr.onWrite = (text) => {
    if (/DOWN/.test(text)) proc.emit('SIGINT');
  };
  checked.length = 0;
  states.web1 = 'down';
  assert.equal(await run.done, 0);
  assert.ok(!checked.includes('web2') || checked.indexOf('web2') > checked.indexOf('web1'));
  assert.match(proc.stderr.text, /ssh {2}web1 +DOWN/);
  assert.ok(!/web2 +DOWN/.test(proc.stderr.text));
});

test('a health tick whose report fails is swallowed and later ticks still run', async () => {
  const world = await makeWorld();
  const states = { web1: 'up' };
  const targetState = async (target) => states[target.name];
  const proc = fakeProcess();
  const run = launch(world, { all: true }, { process: proc, targetState });
  await ready(run);
  let armed = true;
  Object.defineProperty(proc.stderr, 'isTTY', {
    get() {
      if (armed) {
        armed = false;
        throw new Error('stream state unavailable');
      }
      return false;
    },
  });
  states.web1 = 'down';
  await waitFor(() => !armed, 10000, 'the failing report');
  assert.ok(!/DOWN/.test(proc.stderr.text));
  states.web1 = 'up';
  await waitFor(() => /ssh {2}web1 +UP +connection is back/.test(proc.stderr.text), 10000, 'the next tick to report again');
  assert.equal(await stopWith(run), 0);
});
