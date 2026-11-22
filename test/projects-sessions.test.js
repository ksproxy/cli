import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vault from './fixtures/kind-brokered.js';
import { KINDS } from '../src/kinds/index.js';
import { portListening } from '../src/kinds/kubernetes/cluster.js';
import { NODE_FLAGS, agentMdText, mcpConfig } from '../src/agent-md.js';
import { handleMessage, instructionsFor } from '../src/mcp.js';
import { PROJECT_KEY, PROJECT_RULE, withProject } from '../src/paths.js';
import { processStartTime } from '../src/session.js';
import { start } from '../src/start.js';
import { callTool, noSessionText } from '../src/tools.js';
import {
  alive, cleanupAll, fakeProcess, freePorts, killRecordedProxies, launch, listenerTotal, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

KINDS.push(vault);

const BIN = fileURLToPath(new URL('../bin/ksproxy.js', import.meta.url));
const fakeClient = fileURLToPath(new URL('./fixtures/fake-client.js', import.meta.url));
const TOKEN_VARS = { shop: 'VAULT_SHOP_TOKEN', ops: 'VAULT_OPS_TOKEN' };
const TOKENS = { shop: 'Qshop-S3CR3T-4f1c9a-unmistakable', ops: 'Qops-S3CR3T-77d0e2b5c3-unmistakable-and-longer' };
const DEFAULT_NO_SESSION = 'No active session. Ask the user to run `ksproxy start` in their terminal.';
const DEFAULT_INSTRUCTIONS = 'Run commands on the ssh servers, Kubernetes clusters, local folders and service targets (databases, queues and HTTP APIs) the user has opened. '
  + 'Call list_targets first. Every call is checked against a per-target allowlist and logged. '
  + 'If there is no active session, ask the user to run "ksproxy start".';
// No health check runs during these tests: nothing writes into a session folder or a log behind their back.
const QUIET = { KSPROXY_HEALTH_MS: '60000' };
// A proxy that ignores SIGTERM and is killed at once at the close limit: it is always running when it is killed, never
// writing its coverage file as it exits.
const KUBE_QUIET = { ...QUIET, KSPROXY_FAKE_KUBECTL_IGNORE_TERM: '1' };
const KUBE_LIMITS = { kubeCloseMs: 1 };

const worlds = [];
const helpers = new Set();
const providers = [];
after(async () => {
  for (const child of helpers) child.kill('SIGKILL');
  for (const world of worlds) {
    for (const project of ['shop', 'ops']) killRecordedProxies(path.join(stateOf(world, project), 's'));
  }
  cleanupAll();
  for (const server of providers) {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
});

// A model provider stand-in that approves every command and keeps what it was asked.
async function provider() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push(JSON.parse(JSON.parse(body).messages[1].content));
      const content = JSON.stringify({ verdict: 'allow', certainty: 'sure', reason: 'fine' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  providers.push(server);
  return { seen, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function world(extraEnv = QUIET) {
  const w = await makeWorld({ extraEnv });
  w.root = w.env.KSPROXY_STATE_DIR;
  worlds.push(w);
  return w;
}

const envOf = (w, project) => withProject(w.env, project);
const stateOf = (w, project) => (project === null ? w.root : path.join(w.root, 'p', project));
const sessionFile = (w, project, name) => path.join(stateOf(w, project), 'session', name);
const sessionOf = (w, project) => JSON.parse(fs.readFileSync(sessionFile(w, project, 'session.json'), 'utf8'));
const auditOf = (w, project) => fs.readFileSync(path.join(stateOf(w, project), 'logs', 'audit.log'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const callsOf = (w, project) => auditOf(w, project).filter((e) => e.event === 'call')
  .map((e) => `${e.tool} ${e.decision} ${e.target} ${e.command}`);
const stateList = (targets) => targets.map((t) => `${t.kind}:${t.name}:${t.state}`);
const proxyPid = (w, project) => JSON.parse(fs.readFileSync(path.join(stateOf(w, project), 's', 'kube-lab.pid'), 'utf8')).pid;

function writeInventory(w, project, inventory) {
  const config = w.env.KSPROXY_CONFIG_DIR;
  if (project === null) {
    fs.writeFileSync(path.join(config, 'inventory.json'), JSON.stringify(inventory));
    return;
  }
  fs.mkdirSync(path.join(config, 'projects'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, 'projects', `${project}.json`), JSON.stringify(inventory));
}

// An ssh server, a local folder and a command target, all named alike in every project; a vault target in shop and ops;
// and in shop and ops a review of the ssh server by the project's own model provider.
function inventoryOf(w, who, reviewer) {
  const cwd = path.join(w.base, `proj-${who}`);
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'who.txt'), `${who} files\n`);
  return {
    ssh: [{
      name: 'web1',
      host: `web1.${who}.example`,
      description: `${who} web box`,
      allow: ['uptime', 'cat *'],
      ...(reviewer === undefined ? {} : { review: { reviewer: 'r1', policy: `${who} policy` } }),
    }],
    local: [{ name: 'infra', cwd, description: `${who} repo`, allow: ['cat *'] }],
    command: [{ name: 'rep', program: fakeClient, description: `${who} reports`, allow: ['summary'] }],
    ...(TOKEN_VARS[who] === undefined ? {} : {
      vault: [{ name: 'v1', tokenEnv: TOKEN_VARS[who], description: `${who} vault`, allow: ['read *'] }],
    }),
    ...(reviewer === undefined ? {} : { reviewers: { r1: { baseUrl: reviewer.baseUrl, model: 'm' } } }),
  };
}

// Every entry under dir by its path from dir, the top-level names in skip left out: a folder with its mode, a socket,
// or a file with its text.
function tree(dir, skip = []) {
  const out = {};
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (rel === '' && skip.includes(entry.name)) continue;
      const full = path.join(at, entry.name);
      const key = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        out[key] = `folder ${(fs.statSync(full).mode & 0o777).toString(8)}`;
        walk(full, key);
      } else if (entry.isSocket()) {
        out[key] = 'socket';
      } else {
        out[key] = fs.readFileSync(full, 'utf8');
      }
    }
  };
  walk(dir, '');
  return out;
}

const mcpLine = (args) => `Claude Code: claude mcp add ksproxy -- ${[process.execPath, ...NODE_FLAGS, BIN, ...args].join(' ')}\n`;

// One world for tests 1 to 5: shop, ops and the default share one root state folder and one config folder.
let main;
const runs = {};

test('1. two projects run side by side, each with its files in its own folder, marked with its project, the folders on the way private', async () => {
  main = await world({ ...QUIET, [TOKEN_VARS.shop]: TOKENS.shop, [TOKEN_VARS.ops]: TOKENS.ops });
  main.providers = { shop: await provider(), ops: await provider() };
  writeInventory(main, null, inventoryOf(main, 'default'));
  writeInventory(main, 'shop', inventoryOf(main, 'shop', main.providers.shop));
  writeInventory(main, 'ops', inventoryOf(main, 'ops', main.providers.ops));
  // The root and its p folder exist already and are open to others: the start of a project makes both private again.
  fs.mkdirSync(path.join(main.root, 'p'), { recursive: true });
  fs.chmodSync(main.root, 0o755);
  fs.chmodSync(path.join(main.root, 'p'), 0o755);

  runs.shop = launch({ env: envOf(main, 'shop') }, { all: true });
  await ready(runs.shop);
  runs.ops = launch({ env: envOf(main, 'ops') }, { all: true });
  await ready(runs.ops);

  for (const dir of [main.root, path.join(main.root, 'p'), stateOf(main, 'shop'), stateOf(main, 'ops')]) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
  }
  for (const project of ['shop', 'ops']) {
    const dir = stateOf(main, project);
    for (const name of ['session', 's', 'logs']) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o700, name);
    const session = sessionOf(main, project);
    assert.equal(session.project, project);
    assert.deepEqual(stateList(session.targets), ['ssh:web1:up', 'local:infra:up', 'command:rep:up', 'vault:v1:up']);
    assert.equal(session.targets[0].host, `web1.${project}.example`);
    assert.equal(session.targets[0].socket, path.join(dir, 's', 'ssh-web1'));
    assert.ok(fs.statSync(path.join(dir, 's', 'review-sock')).isSocket());
    assert.ok(fs.statSync(path.join(dir, 's', 'call-sock')).isSocket());
    const agentMd = fs.readFileSync(sessionFile(main, project, 'AGENT.md'), 'utf8');
    assert.ok(agentMd.startsWith(`# ksproxy session: project ${project}\n\nThe user has opened`), agentMd.slice(0, 80));
    const config = JSON.parse(fs.readFileSync(sessionFile(main, project, 'mcp.json'), 'utf8'));
    assert.deepEqual(config, {
      mcpServers: { ksproxy: { command: process.execPath, args: [...NODE_FLAGS, BIN, 'mcp', '--project', project] } },
    });
    assert.deepEqual(config, mcpConfig(process.execPath, BIN, project));
    const out = runs[project].proc.stdout.text;
    assert.ok(out.includes(`Session folder: ${path.join(dir, 'session')}\n`), out);
    assert.ok(out.includes(mcpLine(['mcp', '--project', project])), out);
    const started = auditOf(main, project).filter((e) => e.event === 'session_start');
    assert.equal(started.length, 1);
    assert.equal(started[0].project, project);
  }
  // A project start writes nothing in the root's own folders.
  for (const name of ['session', 's', 'logs', 'run']) assert.equal(fs.existsSync(path.join(main.root, name)), false, name);
});

test('2. each project lists and reaches only its own targets, sockets, secrets, reviewer, working folder and log', async () => {
  assert.deepEqual(
    await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, envOf(main, null)),
    { text: DEFAULT_NO_SESSION, isError: true },
    'the default has no session while shop and ops run',
  );
  for (const project of ['shop', 'ops']) {
    const other = project === 'shop' ? 'ops' : 'shop';
    const dir = stateOf(main, project);
    const sshLog = path.join(main.base, `ssh-${project}.log`);
    const env = { ...envOf(main, project), KSPROXY_FAKE_SSH_LOG: sshLog };

    const listed = await callTool('list_targets', {}, env);
    assert.equal(listed.isError, false, listed.text);
    assert.deepEqual(JSON.parse(listed.text).targets.map((t) => [t.kind, t.name, t.description, t.state]), [
      ['ssh', 'web1', `${project} web box`, 'up'],
      ['local', 'infra', `${project} repo`, 'up'],
      ['command', 'rep', `${project} reports`, 'up'],
      ['vault', 'v1', `${project} vault`, 'up'],
    ]);

    const ssh = await callTool('ssh_exec', { server: 'web1', command: `cat ${project}` }, env);
    assert.equal(ssh.text, `exit code: 0\n--- stdout ---\nran web1 cat ${project}`);
    // The state check and the call both went through this project's own master socket and ssh_config.
    const sent = fs.readFileSync(sshLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const check = sent.find((argv) => argv.includes('-O'));
    assert.equal(check[check.indexOf('-S') + 1], path.join(dir, 's', 'ssh-web1'));
    const exec = sent.find((argv) => argv.includes('-F'));
    assert.equal(exec[exec.indexOf('-F') + 1], sessionFile(main, project, 'ssh_config'));
    assert.ok(fs.readFileSync(sessionFile(main, project, 'ssh_config'), 'utf8').includes(`ControlPath ${path.join(dir, 's', 'ssh-web1')}\n`));

    const local = await callTool('local_exec', { target: 'infra', command: 'cat who.txt' }, env);
    assert.equal(local.text, `exit code: 0\n--- stdout ---\n${project} files`);

    const command = await callTool('command_exec', { target: 'rep', command: 'summary' }, env);
    assert.equal(command.isError, false, command.text);
    assert.match(command.text, new RegExp(`"cwd":"<ksproxy>/p/${project}/run/cmd-[^"/]+"`));

    const read = await callTool('vault_read', { target: 'v1', command: `read ${project}` }, env);
    assert.equal(read.text, `exit code: 0\n--- stdout ---\nvault v1: read ${project} with a token of ${TOKENS[project].length} characters`);

    const otherAsked = main.providers[other].seen.length;
    const reviewed = await callTool('ssh_exec', { server: 'web1', command: 'hostname' }, env);
    assert.equal(reviewed.text, 'exit code: 0\n--- stdout ---\nran web1 hostname');
    assert.deepEqual(main.providers[project].seen, [{ policy: `${project} policy`, target: { kind: 'ssh', name: 'web1' }, command: ['hostname'] }]);
    assert.equal(main.providers[other].seen.length, otherAsked, 'the reviewer of the other project is never asked');

    for (const answer of [listed, ssh, local, command, read, reviewed]) {
      for (const token of Object.values(TOKENS)) assert.ok(!answer.text.includes(token), answer.text);
    }
    assert.deepEqual(callsOf(main, project), [
      `ssh_exec allowed web1 cat ${project}`,
      'local_exec allowed infra cat who.txt',
      'command_exec allowed rep summary',
      `vault_read allowed v1 read ${project}`,
      'ssh_exec allowed web1 hostname',
    ]);
  }
  for (const project of ['shop', 'ops']) assert.deepEqual(fs.readdirSync(path.join(stateOf(main, project), 'run')), []);
});

test('3. the default start, and the calls of the default, leave every project folder exactly as it was', async () => {
  const projectsBefore = tree(path.join(main.root, 'p'));
  runs.default = launch({ env: envOf(main, null) }, { all: true });
  await ready(runs.default);

  const session = sessionOf(main, null);
  assert.equal(Object.hasOwn(session, 'project'), false);
  assert.deepEqual(stateList(session.targets), ['ssh:web1:up', 'local:infra:up', 'command:rep:up']);
  assert.equal(session.targets[0].socket, path.join(main.root, 's', 'ssh-web1'));
  assert.ok(fs.readFileSync(sessionFile(main, null, 'AGENT.md'), 'utf8').startsWith('# ksproxy session\n\nThe user has opened'));
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile(main, null, 'mcp.json'), 'utf8')), {
    mcpServers: { ksproxy: { command: process.execPath, args: [...NODE_FLAGS, BIN, 'mcp'] } },
  });
  assert.ok(runs.default.proc.stdout.text.includes(mcpLine(['mcp'])), runs.default.proc.stdout.text);
  const [started] = auditOf(main, null).filter((e) => e.event === 'session_start');
  assert.equal(Object.hasOwn(started, 'project'), false);

  const env = envOf(main, null);
  const listed = await callTool('list_targets', {}, env);
  assert.deepEqual(JSON.parse(listed.text).targets.map((t) => [t.kind, t.name, t.description]), [
    ['ssh', 'web1', 'default web box'], ['local', 'infra', 'default repo'], ['command', 'rep', 'default reports'],
  ]);
  assert.equal((await callTool('ssh_exec', { server: 'web1', command: 'cat default' }, env)).text, 'exit code: 0\n--- stdout ---\nran web1 cat default');
  assert.equal((await callTool('local_exec', { target: 'infra', command: 'cat who.txt' }, env)).text, 'exit code: 0\n--- stdout ---\ndefault files');
  assert.match((await callTool('command_exec', { target: 'rep', command: 'summary' }, env)).text, /"cwd":"<ksproxy>\/run\/cmd-[^"/]+"/);
  assert.deepEqual(
    await callTool('vault_read', { target: 'v1', command: 'read default' }, env),
    { text: 'unknown vault target "v1". Open targets: none', isError: true },
  );
  const refused = await callTool('ssh_exec', { server: 'web1', command: 'hostname' }, env);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^REFUSED \(ssh web1\): not on the allowlist/);
  assert.deepEqual([main.providers.shop.seen.length, main.providers.ops.seen.length], [1, 1]);
  assert.deepEqual(callsOf(main, null), [
    'ssh_exec allowed web1 cat default',
    'local_exec allowed infra cat who.txt',
    'command_exec allowed rep summary',
    'vault_read refused v1 read default',
    'ssh_exec refused web1 hostname',
  ]);

  assert.deepEqual(tree(path.join(main.root, 'p')), projectsBefore);
});

test('4. a second start of a running project, or of the running default, is refused and changes nothing', async () => {
  for (const project of ['shop', null]) {
    const before = tree(stateOf(main, project));
    const again = launch({ env: envOf(main, project) }, { all: true });
    assert.equal(await again.done, 1);
    assert.equal(again.proc.stderr.text, `a session is already running (pid ${process.pid}); stop it with Ctrl-C in its terminal\n`);
    assert.equal(again.proc.stdout.text, '');
    assert.equal(listenerTotal(again.proc), 0);
    assert.deepEqual(tree(stateOf(main, project)), before);
  }
});

test('5. stopping one project leaves the other project and the default running and untouched', async () => {
  const kept = { ops: tree(stateOf(main, 'ops')), default: tree(main.root, ['p']) };
  assert.equal(await stopWith(runs.shop), 0);
  assert.match(runs.shop.proc.stderr.text, /CLOSED +5 calls: 5 ok, 0 failed, 0 denied\n/);
  const shop = stateOf(main, 'shop');
  assert.equal(fs.existsSync(path.join(shop, 'session', 'session.json')), false);
  assert.deepEqual(fs.readdirSync(path.join(shop, 's')), []);
  assert.deepEqual(fs.readdirSync(path.join(shop, 'run')), [], 'no working folder is left');
  assert.deepEqual(tree(stateOf(main, 'ops')), kept.ops);
  assert.deepEqual(tree(main.root, ['p']), kept.default);

  for (const project of ['ops', null]) {
    const env = envOf(main, project);
    assert.equal((await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, env)).text, 'exit code: 0\n--- stdout ---\nran web1 uptime');
    assert.equal((await callTool('command_exec', { target: 'rep', command: 'summary' }, env)).isError, false);
  }
  assert.equal(
    (await callTool('vault_read', { target: 'v1', command: 'read again' }, envOf(main, 'ops'))).text,
    `exit code: 0\n--- stdout ---\nvault v1: read again with a token of ${TOKENS.ops.length} characters`,
  );
  const shopText = 'No active session. Ask the user to run `ksproxy start --project shop` in their terminal.';
  assert.deepEqual(await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, envOf(main, 'shop')), { text: shopText, isError: true });
  assert.deepEqual(await callTool('list_targets', {}, envOf(main, 'shop')), { text: shopText, isError: false });

  assert.equal(await stopWith(runs.ops), 0);
  assert.match(runs.ops.proc.stderr.text, /CLOSED +8 calls: 8 ok, 0 failed, 0 denied\n/);
  assert.equal(await stopWith(runs.default), 0);
  assert.match(runs.default.proc.stderr.text, /CLOSED +7 calls: 5 ok, 0 failed, 2 denied\n/);
  for (const project of ['shop', 'ops', null]) {
    assert.equal(fs.existsSync(sessionFile(main, project, 'session.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(stateOf(main, project), 's')), []);
  }
});

test('6. with no live session of a project, every answer and the instructions name that project; the default keeps its texts', async () => {
  const w = await world();
  writeInventory(w, 'shop', { vault: [{ name: 'v1', tokenEnv: TOKEN_VARS.shop, allow: ['read *'] }] });
  const [own, shop, ops] = [null, 'shop', 'ops'].map((project) => envOf(w, project));
  const opsText = 'No active session. Ask the user to run `ksproxy start --project ops` in their terminal.';

  assert.equal(noSessionText(own), DEFAULT_NO_SESSION);
  assert.equal(noSessionText(ops), opsText);
  assert.deepEqual(await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, ops), { text: opsText, isError: true });
  assert.deepEqual(await callTool('list_targets', {}, ops), { text: opsText, isError: false });
  assert.deepEqual(await callTool('ssh_exec', { server: 'web1', command: 'uptime' }, own), { text: DEFAULT_NO_SESSION, isError: true });
  const called = await handleMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ssh_exec', arguments: { server: 'web1', command: 'uptime' } },
  }, ops);
  assert.deepEqual(called.result, { content: [{ type: 'text', text: opsText }], isError: true });

  const instructions = async (env) => (await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, env)).result.instructions;
  assert.equal(await instructions(own), DEFAULT_INSTRUCTIONS);
  assert.equal(await instructions(ops), DEFAULT_INSTRUCTIONS.replace('"ksproxy start"', '"ksproxy start --project ops"'));
  assert.equal(instructionsFor(ops), await instructions(ops));
  const broken = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { ...own, [PROJECT_KEY]: 'Shop' });
  assert.deepEqual(broken.error, { code: -32603, message: `Internal error: ${PROJECT_RULE}` });

  // The tool listing reads the inventory of the project: only shop's file holds a vault target, ops has no file.
  const tools = async (env) => (await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, env)).result.tools.map((t) => t.name);
  assert.ok((await tools(shop)).includes('vault_read'));
  assert.ok(!(await tools(ops)).includes('vault_read'));
  assert.ok(!(await tools(own)).includes('vault_read'));

  assert.deepEqual(mcpConfig('/usr/bin/node', '/x/bin/ksproxy.js', 'shop'), {
    mcpServers: { ksproxy: { command: '/usr/bin/node', args: ['--disable-sigusr1', '/x/bin/ksproxy.js', 'mcp', '--project', 'shop'] } },
  });
  assert.deepEqual(mcpConfig('/usr/bin/node', '/x/bin/ksproxy.js').mcpServers.ksproxy.args, ['--disable-sigusr1', '/x/bin/ksproxy.js', 'mcp']);
  assert.equal(agentMdText({ project: 'shop', targets: [] }).split('\n')[0], '# ksproxy session: project shop');
  assert.equal(agentMdText({ targets: [] }).split('\n')[0], '# ksproxy session');
});

test('7. the stale-proxy cleanup of a project start only looks at its own folder, never at the proxy of another running project', async () => {
  const w = await world(KUBE_QUIET);
  const ports = { shop: 0, ops: 0, default: 0 };
  [ports.shop, ports.ops, ports.default] = await freePorts(3);
  for (const who of ['shop', 'ops', 'default']) {
    writeInventory(w, who === 'default' ? null : who, {
      kubernetes: [{ name: 'lab', kubeconfig: w.kubeconfig, proxyPort: ports[who], description: `${who} cluster`, allow: ['get ...'] }],
    });
  }
  const shop = launch({ env: envOf(w, 'shop') }, { all: true }, { limits: KUBE_LIMITS });
  await ready(shop);
  const shopProxy = proxyPid(w, 'shop');

  // A proxy that a killed run of ops left behind, recorded in ops's own socket folder.
  const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'proxy', 'left'], { stdio: 'ignore' });
  helpers.add(left);
  await waitFor(() => processStartTime(left.pid) !== null, 10000, 'the leftover proxy to start');
  fs.mkdirSync(path.join(stateOf(w, 'ops'), 's'), { recursive: true });
  fs.writeFileSync(path.join(stateOf(w, 'ops'), 's', 'kube-old.pid'), JSON.stringify({ pid: left.pid, startedAt: processStartTime(left.pid) }));

  const ops = launch({ env: envOf(w, 'ops') }, { all: true }, { limits: KUBE_LIMITS });
  await ready(ops);
  assert.match(ops.proc.stderr.text, /^closed 1 proxy process\(es\) left by an earlier run\n/);
  await waitFor(() => !alive(left.pid), 10000, 'the leftover proxy to be gone');
  const own = launch({ env: envOf(w, null) }, { all: true }, { limits: KUBE_LIMITS });
  await ready(own);
  assert.ok(!own.proc.stderr.text.includes('left by an earlier run'), own.proc.stderr.text);

  assert.ok(alive(shopProxy));
  assert.equal(await portListening(ports.shop), true);
  const listed = JSON.parse((await callTool('list_targets', {}, envOf(w, 'shop'))).text).targets;
  assert.deepEqual(listed.map((t) => [t.name, t.description, t.state]), [['lab', 'shop cluster', 'up']]);
  const pids = [proxyPid(w, 'shop'), proxyPid(w, 'ops'), proxyPid(w, null)];
  assert.equal(new Set([...pids, left.pid]).size, 4);

  for (const run of [shop, ops, own]) assert.equal(await stopWith(run), 0);
  for (const pid of pids) await waitFor(() => !alive(pid), 10000, 'every proxy to be gone');
});

test('8. a project whose cluster names the port of another project\'s running proxy opens its other targets and is told which project uses it', async () => {
  const w = await world(KUBE_QUIET);
  const [port] = await freePorts(1);
  const inventory = (who) => ({
    ssh: [{ name: 'web1', host: `web1.${who}.example`, allow: ['uptime'] }],
    kubernetes: [{ name: 'lab', kubeconfig: w.kubeconfig, proxyPort: port, allow: ['get ...'] }],
  });
  writeInventory(w, 'shop', inventory('shop'));
  const shop = launch({ env: envOf(w, 'shop') }, { all: true }, { limits: KUBE_LIMITS });
  await ready(shop);
  const shopProxy = proxyPid(w, 'shop');
  // The file of ops is written once shop runs, so shop opened its cluster.
  writeInventory(w, 'ops', inventory('ops'));
  const ops = launch({ env: envOf(w, 'ops') }, { all: true }, { limits: KUBE_LIMITS });
  await ready(ops);

  // The port is refused before the cluster opens, with a message that names the port and the other project.
  const message = `port ${port} is also used by project shop; give each project its own port`;
  assert.match(ops.proc.stderr.text, new RegExp(`kube lab +SKIPPED +${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  const skipped = auditOf(w, 'ops').filter((e) => e.event === 'target_skipped');
  assert.deepEqual(skipped.map((e) => [e.kind, e.target, e.message]), [['kube', 'lab', message]]);
  assert.deepEqual(stateList(sessionOf(w, 'ops').targets), ['ssh:web1:up']);
  assert.equal(fs.existsSync(path.join(stateOf(w, 'ops'), 's', 'kube-lab.pid')), false);
  assert.deepEqual(stateList(sessionOf(w, 'shop').targets), ['ssh:web1:up', 'kubernetes:lab:up']);
  assert.ok(alive(shopProxy));
  assert.equal(await portListening(port), true);

  assert.equal(await stopWith(ops), 0);
  assert.equal(await stopWith(shop), 0);
  await waitFor(() => !alive(shopProxy), 10000, 'the proxy of shop to be gone');
});

test('9. a start given a project value that breaks the rule rejects, removes its handlers and makes no folder', async () => {
  const w = await world();
  const proc = fakeProcess();
  await assert.rejects(start({ all: true }, { ...w.env, [PROJECT_KEY]: 'Shop' }, { process: proc }), { message: PROJECT_RULE });
  assert.equal(listenerTotal(proc), 0);
  assert.equal(proc.stdout.text + proc.stderr.text, '');
  assert.equal(fs.existsSync(w.root), false);
});
