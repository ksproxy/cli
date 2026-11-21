import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TOOLS, callTool, scrubOutput, targetState } from '../src/tools.js';
import { writeSession } from '../src/session.js';

let base;
let cwd;
let bin;
let sessionDir;
let env;
let session;

const NODE_DIR = path.dirname(process.execPath);

function script(file, lines) {
  fs.writeFileSync(file, ['#!/usr/bin/env node', ...lines, ''].join('\n'), { mode: 0o755 });
}

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-lt-')));
  cwd = path.join(base, 'work');
  bin = path.join(base, 'bin');
  sessionDir = path.join(base, 'st', 'session');
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(path.join(base, 'st', 'logs'));
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'hello a\n');
  script(path.join(cwd, 'probe.js'), [
    "const fs = require('node:fs');",
    "console.log('CWD=' + process.cwd());",
    "console.log('BASE=' + require('node:path').basename(process.cwd()));",
    "console.log('HASA=' + fs.existsSync('a.txt'));",
    "console.log('ARGV=' + JSON.stringify(process.argv.slice(2)));",
    "console.log('KEYS=' + JSON.stringify(Object.keys(process.env).sort()));",
    "console.log('PATH=' + process.env.PATH);",
    "console.log('LEAK=' + (process.env.SHOULD_NOT_LEAK ?? 'unset'));",
  ]);
  script(path.join(cwd, 'slow.js'), ['setTimeout(() => {}, 20000);']);
  script(path.join(cwd, 'fail.js'), ["console.error('boom');", 'process.exit(4);']);
  script(path.join(bin, 'frombindir'), ["console.log('found through the session PATH');"]);
  env = {
    ...process.env,
    PATH: '/parent-only-path',
    KSPROXY_STATE_DIR: path.join(base, 'st'),
    KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
    SHOULD_NOT_LEAK: 'secret',
  };
  session = {
    version: 1,
    pid: process.pid,
    startedAt: '2026-11-20T00:00:00.000Z',
    targets: [
      {
        kind: 'ssh', name: 'web1', description: 'web box', allow: ['uptime'], host: 'h', socket: path.join(base, 'nope'), state: 'up',
      },
      {
        kind: 'local',
        name: 'infra',
        description: 'terraform repo',
        allow: ['./probe.js ...', './slow.js', './fail.js', 'frombindir', 'nosuchprogram', 'cat *', 'ls ...', 'env',
          './probe.js a%b+c=d:e,f@g.h/i-j_k x'],
        cwd,
        path: `${bin}:${NODE_DIR}:/usr/bin:/bin`,
        protected: [path.join(base, 'kube-secret.yaml')],
        state: 'up',
      },
    ],
  };
  writeSession(sessionDir, session);
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function calls() {
  const file = path.join(base, 'st', 'logs', 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.event === 'call');
}

const local = (command, extra = {}, e = env) => callTool('local_exec', { target: 'infra', command, ...extra }, e);

test('TOOLS has local_exec with target, command and timeout_seconds', () => {
  const tool = TOOLS.find((t) => t.name === 'local_exec');
  assert.deepEqual(tool.inputSchema.required, ['target', 'command']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['target', 'command', 'timeout_seconds']);
  assert.ok(tool.description.startsWith('Run one command on this machine'));
});

test('list_targets shows a local target without its folder or PATH', async () => {
  const r = await callTool('list_targets', {}, env);
  assert.equal(r.isError, false);
  const listed = JSON.parse(r.text).targets.find((t) => t.kind === 'local');
  assert.deepEqual(listed, {
    kind: 'local',
    name: 'infra',
    description: 'terraform repo',
    state: 'up',
    allow: session.targets[1].allow,
  });
  for (const secret of [cwd, base, bin, 'cwd', 'path', 'protected', 'kube-secret', 'parent-only']) {
    assert.ok(!r.text.includes(secret), secret);
  }
});

test('an allowed command runs in the target folder, and the folder is not shown in the output', async () => {
  const r = await local('./probe.js');
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^exit code: 0\n--- stdout ---\n/);
  assert.ok(r.text.includes('BASE=work'), r.text);
  assert.ok(r.text.includes('HASA=true'), r.text);
  assert.ok(r.text.includes('CWD=<folder>'), r.text);
  assert.ok(!r.text.includes(cwd), r.text);
});

test('the child gets the minimal environment and the PATH recorded in the session, nothing else', async () => {
  const listed = await local('env');
  assert.equal(listed.isError, false, listed.text);
  const keys = listed.text.split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => l.split('=')[0])
    .filter((k) => !['__CF_USER_TEXT_ENCODING', 'NODE_V8_COVERAGE'].includes(k));
  assert.ok(keys.includes('PATH'));
  assert.ok(keys.every((k) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].includes(k)), keys.join(','));
  assert.ok(env.KSPROXY_STATE_DIR && env.KSPROXY_CONFIG_DIR, 'the parent has KSPROXY_ variables set');
  assert.ok(!listed.text.includes('KSPROXY_'), listed.text);
  assert.ok(!listed.text.includes('SHOULD_NOT_LEAK'), listed.text);
  const r = await local('./probe.js');
  assert.ok(r.text.includes('LEAK=unset'), r.text);
  const probeKeys = JSON.parse(/KEYS=(.*)/.exec(r.text)[1]);
  assert.deepEqual(probeKeys.filter((k) => k.startsWith('KSPROXY_')), []);
  assert.ok(!r.text.includes('SHOULD_NOT_LEAK'), r.text);
  assert.ok(!r.text.includes('parent-only-path'), r.text);
  assert.ok(r.text.includes(`\nPATH=${session.targets[1].path}\n`), r.text);
});

test('a bare program name is found through the PATH recorded in the session, not the PATH of the MCP server', async () => {
  const r = await local('frombindir');
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('found through the session PATH'), r.text);
});

test('a session without a recorded PATH falls back to a fixed system PATH', async () => {
  const dir = path.join(base, 'st2', 'session');
  const bare = { ...session, targets: [{ ...session.targets[1], path: undefined, allow: ['ls ...'] }] };
  writeSession(dir, bare);
  const r = await local('ls', {}, { ...env, KSPROXY_STATE_DIR: path.join(base, 'st2') });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes('a.txt'), r.text);
  assert.ok(r.text.includes('probe.js'), r.text);
});

test('arguments reach the program byte for byte, with no shell in between', async () => {
  const arg = 'a%b+c=d:e,f@g.h/i-j_k';
  const r = await local(`./probe.js ${arg} x`);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`ARGV=${JSON.stringify([arg, 'x'])}`), r.text);
  const spaced = await local('./probe.js   one\ttwo');
  assert.ok(spaced.text.includes('ARGV=["one","two"]'), spaced.text);
});

test('shell syntax is refused before anything runs', async () => {
  for (const [command, shown] of [
    ['./probe.js a&&b', '"&"'],
    ['./probe.js a;b', '";"'],
    ['./probe.js a|b', '"|"'],
    ['./probe.js $HOME', '"$"'],
    ['./probe.js `id`', '"`"'],
    ['./probe.js >x', '">"'],
    ['./probe.js ~/x', '"~"'],
    ['./probe.js "a"', '"""'],
  ]) {
    const r = await local(command);
    assert.equal(r.isError, true, command);
    assert.ok(r.text.startsWith('REFUSED (local infra): '), r.text);
    assert.ok(r.text.includes(shown), `${command}: ${r.text}`);
  }
  assert.equal(fs.existsSync(path.join(cwd, 'x')), false);
});

test('a refusal names the target, gives the long reason to the agent and is audited with kind loc', async () => {
  const before = calls().length;
  const r = await local('cat /etc/hosts');
  assert.equal(r.isError, true);
  assert.equal(r.text, 'REFUSED (local infra): the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally');
  const outside = await local('rm a.txt');
  assert.ok(outside.text.startsWith('REFUSED (local infra): not on the allowlist for this target. Allowed: ./probe.js ...; ./slow.js;'), outside.text);
  const [a, b] = calls().slice(before);
  assert.equal(a.tool, 'local_exec');
  assert.equal(a.kind, 'loc');
  assert.equal(a.target, 'infra');
  assert.equal(a.command, 'cat /etc/hosts');
  assert.equal(a.decision, 'refused');
  assert.equal(a.short, 'not a plain argument');
  assert.equal(a.reason, 'the argument /etc/hosts is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally');
  assert.equal(b.short, 'not on allowlist');
});

test('ksproxy files are refused with their own reason and never run', async () => {
  const before = calls().length;
  fs.symlinkSync(path.join(base, 'st'), path.join(cwd, 'stlink'));
  try {
    const r = await local('cat stlink/session/session.json');
    assert.equal(r.isError, true);
    assert.equal(r.text, 'REFUSED (local infra): ksproxy\'s own files are off limits');
    assert.equal(calls().slice(before)[0].short, 'ksproxy files');
  } finally {
    fs.rmSync(path.join(cwd, 'stlink'));
  }
});

test('an allowed call is audited with kind loc, the command and the run details', async () => {
  const before = calls().length;
  await local('cat a.txt');
  const entry = calls().slice(before)[0];
  assert.equal(entry.tool, 'local_exec');
  assert.equal(entry.kind, 'loc');
  assert.equal(entry.target, 'infra');
  assert.equal(entry.command, 'cat a.txt');
  assert.equal(entry.decision, 'allowed');
  assert.equal(entry.rule, 'cat *');
  assert.equal(entry.exitCode, 0);
  assert.equal(entry.spawnError, null);
  assert.equal(entry.timedOut, false);
  assert.equal(typeof entry.durationMs, 'number');
  assert.equal(entry.stdoutBytes, 8);
  assert.ok(!JSON.stringify(entry).includes(cwd));
});

test('a non-zero exit is an error result with stderr', async () => {
  const r = await local('./fail.js');
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('exit code: 4'), r.text);
  assert.ok(r.text.includes('boom'), r.text);
});

test('a command that runs out of time is reported and stopped', async () => {
  const r = await local('./slow.js', { timeout_seconds: 1 });
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('timed out after 1s'), r.text);
  assert.equal(calls().at(-1).timedOut, true);
});

test('a program that cannot start is reported and audited with the spawn error', async () => {
  const r = await local('nosuchprogram');
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('could not start: '), r.text);
  assert.equal(typeof calls().at(-1).spawnError, 'string');
});

test('a working folder that is gone makes the program fail to start, and the state says down', async () => {
  const dir = path.join(base, 'st3', 'session');
  const gone = path.join(base, 'vanished');
  writeSession(dir, { ...session, targets: [{ ...session.targets[1], cwd: gone, allow: ['ls ...'] }] });
  const e = { ...env, KSPROXY_STATE_DIR: path.join(base, 'st3') };
  const r = await local('ls', {}, e);
  assert.equal(r.isError, true);
  assert.ok(r.text.startsWith('could not start: '), r.text);
  assert.ok(!r.text.includes(gone), r.text);
  const listed = JSON.parse((await callTool('list_targets', {}, e)).text);
  assert.equal(listed.targets[0].state, 'down');
});

test('unknown target, the name of another kind, and bad arguments', async () => {
  const unknown = await callTool('local_exec', { target: 'nope', command: 'ls' }, env);
  assert.equal(unknown.isError, true);
  assert.equal(unknown.text, 'unknown local target "nope". Open targets: infra');
  const wrongKind = await callTool('local_exec', { target: 'web1', command: 'ls' }, env);
  assert.equal(wrongKind.text, 'unknown local target "web1". Open targets: infra');
  const ssh = await callTool('ssh_exec', { server: 'infra', command: 'uptime' }, env);
  assert.ok(ssh.text.startsWith('unknown ssh server "infra"'), ssh.text);

  const before = calls().length;
  const cases = [
    [{ target: 5, command: 'ls' }, 'invalid arguments: target must be a string'],
    [{ target: 'infra' }, 'invalid arguments: command must be a string'],
    [{ target: 'infra', command: ['ls'] }, 'invalid arguments: command must be a string'],
    [{ target: 'infra', command: 'ls', timeout_seconds: 0 }, 'invalid arguments: timeout_seconds must be an integer from 1 to 600'],
    [{ target: 'infra', command: 'ls', timeout_seconds: 601 }, 'invalid arguments: timeout_seconds must be an integer from 1 to 600'],
    [{ target: 'infra', command: 'ls', timeout_seconds: 1.5 }, 'invalid arguments: timeout_seconds must be an integer from 1 to 600'],
  ];
  for (const [args, text] of cases) {
    const r = await callTool('local_exec', args, env);
    assert.deepEqual(r, { text, isError: true });
  }
  const logged = calls().slice(before);
  assert.equal(logged.length, cases.length);
  assert.ok(logged.every((l) => l.kind === 'loc' && l.tool === 'local_exec' && l.decision === 'refused'));
  assert.equal(logged[0].command, 'ls');
  assert.equal(logged[1].command, null);
  assert.equal(logged[2].command, null);
});

test('a local call with no live session gets the usual answer', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'empty-'));
  const r = await local('ls', {}, { ...env, KSPROXY_STATE_DIR: dir });
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('No active session'));
});

test('the folder is hidden in output by its configured and real path, but a folder of / is left alone', () => {
  const viaLink = path.join(base, 'work-link');
  fs.symlinkSync(cwd, viaLink);
  try {
    const sess = { targets: [{ kind: 'local', name: 'x', cwd: viaLink }] };
    const text = `in ${viaLink}/a and ${cwd}/b and ${base}/other`;
    assert.equal(scrubOutput(text, sess, env), `in <folder>/a and <folder>/b and ${base}/other`);
  } finally {
    fs.rmSync(viaLink);
  }
  const root = { targets: [{ kind: 'local', name: 'x', cwd: '/' }] };
  assert.equal(scrubOutput('/usr/bin/env', root, env), '/usr/bin/env');
});

test('the state folder is still hidden in local output', async () => {
  const literal = `ls ${path.join(cwd, 'a.txt')}`;
  writeSession(sessionDir, { ...session, targets: [session.targets[0], { ...session.targets[1], allow: [literal] }] });
  try {
    const r = await local(literal);
    assert.equal(r.isError, false, r.text);
    assert.ok(!r.text.includes(base), r.text);
    assert.ok(r.text.includes('<folder>/a.txt'), r.text);
  } finally {
    writeSession(sessionDir, session);
  }
});

test('targetState: up for a folder, down for a missing folder and for a file', async () => {
  assert.equal(await targetState({ kind: 'local', cwd }, env), 'up');
  assert.equal(await targetState({ kind: 'local', cwd: path.join(base, 'missing') }, env), 'down');
  assert.equal(await targetState({ kind: 'local', cwd: path.join(cwd, 'a.txt') }, env), 'down');
});
