import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KINDS, kindByKey } from '../src/kinds/index.js';
import { toolsFileText } from '../src/kinds/mcp/export.js';
import {
  LIST_POLL_MS, handleMessage, listWatch, listedTools, serve,
} from '../src/mcp.js';
import { startListener } from '../src/listen.js';
import { PROJECT_KEY, withProject } from '../src/paths.js';
import { clearSession, processStartTime, writeSession } from '../src/session.js';
import { MAX_TOOLS_FILE_BYTES, readSessionTools, toolsStamp } from '../src/session-tools.js';
import { newToken } from '../src/token.js';
import { callTool, directTools, toolDefinitions } from '../src/tools.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

const STAND_IN = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));
const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const SECRET_VAR = 'MCP_DIRECT_TOKEN';
const SECRET = 'S3cr3t-mcp-direct-value-0091';

const listeners = [];
after(async () => {
  for (const listener of listeners) await listener.close();
  cleanupAll();
});

// The tools of the stand-in: get_issue declares an argument named timeout_seconds, which is the server's own.
const issueSchema = (extra = {}) => ({
  type: 'object', properties: { issue_key: { type: 'string' }, timeout_seconds: { type: 'integer' }, ...extra }, required: ['issue_key'],
});
const TOOLS = [
  { name: 'get_issue', description: 'Get one issue', inputSchema: issueSchema() },
  { name: 'add_comment', description: 'Add a comment', inputSchema: issueSchema({ body: { type: 'string' } }) },
  { name: 'delete_issue', description: 'Delete an issue', inputSchema: issueSchema() },
];

const optionFiles = fs.realpathSync(tempDir('ks-mcp-direct-options-'));
let optionCount = 0;
// The command of a stand-in with these options, given in a file of their own; its record file is returned too.
function standIn(options = {}) {
  optionCount += 1;
  const record = path.join(optionFiles, `${optionCount}.record`);
  const file = path.join(optionFiles, `${optionCount}.json`);
  fs.writeFileSync(file, JSON.stringify({ tools: TOOLS, record, ...options }));
  return { command: [process.execPath, STAND_IN, `@${file}`], record };
}

const received = (record, method) => fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .filter((entry) => entry.got?.method === method);

const mcpTarget = (name, server, extra = {}) => ({
  name,
  command: server.command,
  env: { TOKEN_OF_SERVER: { fromEnv: SECRET_VAR } },
  description: `${name} server`,
  allow: ['get_issue', { tool: 'add_comment', arguments: { issue_key: 'regex(SHOP-[0-9]+)' } }],
  ...extra,
});

const names = (tools) => tools.map((tool) => tool.name);
const FIXED = ['list_targets', 'ssh_exec', 'kubectl', 'local_exec'];

// A state and a config folder of their own, with this inventory, and no project.
function plainWorld(inventory = {}, base = fs.realpathSync(tempDir('ks-mcp-direct-'))) {
  const config = path.join(base, `cfg-${Object.keys(inventory).join('-')}`);
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, 'inventory.json'), JSON.stringify(inventory));
  const env = {
    ...process.env, HOME: path.join(base, 'home'), [STATE_KEY]: path.join(base, 'st'), [CONFIG_KEY]: config,
  };
  delete env[PROJECT_KEY];
  const dir = path.join(base, 'st', 'session');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(base, 'st', 'logs'), { recursive: true });
  return { base, env, dir };
}

const MCP_INVENTORY = { mcp: [{ name: 'jira', command: [process.execPath, STAND_IN], allow: ['get_issue'] }] };
const OWN_START = processStartTime(process.pid);

function writeLive(dir, { pid = process.pid, started = OWN_START, targets = [] } = {}) {
  writeSession(dir, {
    version: 1, pid, startedAt: '2026-11-25T10:00:00.000Z', ...(started === null ? {} : { processStartedAt: started }), targets,
  });
}

const definition = (target, tool) => ({
  name: `${target}__${tool}`, description: `[from the MCP server "${target}"] ${tool}`, inputSchema: { type: 'object', properties: {} },
});
const entry = (target, tool, extra = {}) => ({
  target, tool, timeoutSeconds: 60, definition: definition(target, tool), ...extra,
});
const toolsFile = (tools, { pid = process.pid, started = OWN_START, version = 1 } = {}) => `${JSON.stringify({
  version, pid, processStartedAt: started, tools,
})}\n`;
const writeTools = (dir, tools, options) => fs.writeFileSync(path.join(dir, 'mcp-tools.json'), toolsFile(tools, options));

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

test('the tools of the live session come after the fixed tools, in the order of the file, and go with it', () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const before = JSON.stringify(listedTools(env));
  assert.deepEqual(names(listedTools(env)), FIXED);
  assert.deepEqual(directTools(env), []);

  const odd = {
    ...entry('jira', 'search'),
    extra: 'dropped',
    definition: { ...definition('jira', 'search'), outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  };
  writeLive(dir);
  writeTools(dir, [entry('jira', 'get_issue'), odd, entry('wiki', 'get_page', { timeoutSeconds: 5 })]);
  assert.deepEqual(names(listedTools(env)), [...FIXED, 'jira__get_issue', 'jira__search', 'wiki__get_page']);
  assert.deepEqual(directTools(env), [
    entry('jira', 'get_issue'), entry('jira', 'search'), entry('wiki', 'get_page', { timeoutSeconds: 5 }),
  ]);
  assert.deepEqual(listedTools(env).slice(-1), [definition('wiki', 'get_page')]);
  assert.deepEqual(toolDefinitions(null, directTools(env)).slice(-3).map((tool) => tool.name), ['jira__get_issue', 'jira__search', 'wiki__get_page']);

  clearSession(dir);
  assert.equal(JSON.stringify(listedTools(env)), before, 'the list of before, byte for byte');
  assert.deepEqual(directTools(env), []);
});

test('without an mcp target in the inventory, tools/list never reads the session: no direct tools, no ps', () => {
  const { env, dir } = plainWorld({});
  writeLive(dir);
  writeTools(dir, [entry('jira', 'get_issue')]);
  assert.deepEqual(names(listedTools(env)), FIXED);
  // An inventory that cannot be read may hold one, so the session's tools are listed then, as every brokered tool is.
  fs.writeFileSync(path.join(env[CONFIG_KEY], 'inventory.json'), '{ not json');
  assert.ok(names(listedTools(env)).includes('jira__get_issue'));
});

test('a stale file is never used: another pid, another start time, a dead pid', () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const tools = [entry('jira', 'get_issue')];
  const dead = deadPid();
  writeLive(dir);
  writeTools(dir, tools, { pid: dead });
  assert.deepEqual(directTools(env), [], 'the file of another pid');
  writeTools(dir, tools, { started: (OWN_START ?? 0) + 1000 });
  assert.deepEqual(directTools(env), [], 'the file of another start time');
  writeTools(dir, tools);
  assert.deepEqual(names(directTools(env).map((item) => item.definition)), ['jira__get_issue']);

  // A session whose start time ps could not tell matches a file that has none, and no other.
  writeLive(dir, { started: null });
  assert.deepEqual(directTools(env), [], 'the file has a start time, the session none');
  writeTools(dir, tools, { started: null });
  assert.deepEqual(names(directTools(env).map((item) => item.definition)), ['jira__get_issue']);

  writeLive(dir, { pid: dead });
  writeTools(dir, tools, { pid: dead });
  assert.deepEqual(directTools(env), [], 'the session is not live');
  writeSession(dir, { version: 1, pid: process.pid });
  writeTools(dir, tools, { started: null });
  assert.deepEqual(directTools(env), [], 'a session without a list of targets');
});

test('a missing, malformed, oversized or odd file gives no tools, and nothing throws', () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const file = path.join(dir, 'mcp-tools.json');
  writeLive(dir);
  const none = () => assert.deepEqual(directTools(env), []);
  none();
  for (const text of ['not json', '[]', 'null', '5', toolsFile([entry('jira', 'a')], { version: 2 }), `${JSON.stringify({
    version: 1, pid: process.pid, processStartedAt: OWN_START, tools: {},
  })}\n`]) {
    fs.writeFileSync(file, text);
    none();
  }
  const good = entry('jira', 'get_issue');
  const bad = [
    null, 'text', { ...good, definition: null }, { ...good, target: 'Jira' }, { ...good, target: 5 }, { ...good, tool: 'a b' },
    { ...good, tool: 7 }, { ...good, timeoutSeconds: 0 }, { ...good, timeoutSeconds: 601 }, { ...good, timeoutSeconds: 1.5 },
    { ...good, definition: { ...good.definition, name: 'jira__other' } },
    { ...entry('jira', 'x'.repeat(45)) },
    { ...good, definition: { ...good.definition, description: 5 } },
    { ...good, definition: { ...good.definition, inputSchema: { type: 'string' } } },
    { ...good, definition: { ...good.definition, inputSchema: [] } },
  ];
  for (const item of bad) {
    writeTools(dir, [good, item]);
    assert.deepEqual(directTools(env), [], JSON.stringify(item));
  }

  // At most MAX_TOOLS_FILE_BYTES: a file of exactly that size is read, one byte more is not.
  const text = toolsFile([good]);
  fs.writeFileSync(file, text + ' '.repeat(MAX_TOOLS_FILE_BYTES - Buffer.byteLength(text)));
  assert.equal(directTools(env).length, 1);
  fs.appendFileSync(file, ' ');
  none();

  // Not a regular file: a folder, and a named pipe, which must not block the read.
  fs.rmSync(file);
  fs.mkdirSync(file);
  none();
  fs.rmSync(file, { recursive: true });
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
  none();
  fs.rmSync(file);

  // An env whose project breaks the rule: no tools, and a call is an unknown tool, as before.
  const broken = { ...env, [PROJECT_KEY]: 'Not A Project' };
  assert.deepEqual(directTools(broken), []);
  const watch = listWatch(broken, () => assert.fail('nothing is written'));
  assert.equal(watch.declare(), false);
  assert.equal(watch.tick(), false);
});

test('the largest mcp-tools.json that start can write is read whole', () => {
  const { dir } = plainWorld();
  const tool = (i) => ({ tool: `t${i}`, definition: null });
  // Targets of the longest name, and tools of the shortest definition: the most file around the fewest bytes of
  // definitions. The budget of definitions ends the list.
  const entries = Array.from({ length: 200 }, (_, n) => {
    const name = `${String(n).padStart(3, '0')}${'a'.repeat(28)}`;
    const exported = Array.from({ length: 200 }, (_, i) => tool(i)).map((item) => ({
      ...item, definition: { name: `${name}__${item.tool}`, description: `[from the MCP server "${name}"]`, inputSchema: { type: 'object' } },
    }));
    return { target: { name, timeoutSeconds: 600 }, live: { exported } };
  });
  let cut = 0;
  const text = toolsFileText(entries, { pid: process.pid, processStartedAt: OWN_START }, (item, count) => { cut += count; });
  assert.ok(cut > 0, 'the budget was reached');
  assert.ok(Buffer.byteLength(text) < MAX_TOOLS_FILE_BYTES, `${Buffer.byteLength(text)} bytes`);
  fs.writeFileSync(path.join(dir, 'mcp-tools.json'), text);
  const session = { pid: process.pid, ...(OWN_START === null ? {} : { processStartedAt: OWN_START }) };
  assert.equal(readSessionTools(dir, session).length, JSON.parse(text).tools.length);
});

test('a name that a fixed tool has, or that comes twice, is neither listed nor routed', async () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const fake = {
    key: 'fakeshop', brokered: true, tool: { name: 'shop__get', listed: false, definition: definition('shop', 'get') },
  };
  KINDS.push(fake);
  try {
    writeLive(dir);
    writeTools(dir, [entry('shop', 'get'), entry('jira', 'get_issue'), entry('jira', 'search'), entry('jira', 'get_issue')]);
    assert.deepEqual(names(listedTools(env)), [...FIXED, 'jira__search']);
    assert.deepEqual(await callTool('jira__get_issue', {}, env), { text: 'unknown tool: jira__get_issue', isError: true });
  } finally {
    KINDS.splice(KINDS.indexOf(fake), 1);
  }
});

test('a name that is not in the live list is an unknown tool, as any other', async () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const unknown = (name) => ({ text: `unknown tool: ${name}`, isError: true });
  assert.deepEqual(await callTool('jira__get_issue', {}, env), unknown('jira__get_issue'), 'no session');
  assert.deepEqual(await callTool(5, {}, env), unknown(5));
  assert.deepEqual(await callTool('no_such_tool', {}, env), unknown('no_such_tool'));
  assert.deepEqual(await callTool('jira__get_issue', {}, { ...env, [PROJECT_KEY]: 'Not A Project' }), unknown('jira__get_issue'));
  writeLive(dir);
  writeTools(dir, [entry('jira', 'get_issue')]);
  assert.deepEqual(await callTool('jira__search', {}, env), unknown('jira__search'), 'not exported');
  assert.deepEqual(await callTool('jira__get_issue', [], env), { text: 'invalid arguments: expected an object', isError: true });
  // Routed to mcp_call, which finds no such target in this hand-written session and audits the refusal as its own.
  assert.deepEqual(await callTool('jira__get_issue', { issue_key: 'A-1' }, env), {
    text: 'unknown MCP server "jira". Open targets: none', isError: true,
  });
  const [audited] = fs.readFileSync(path.join(env[STATE_KEY], 'logs', 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual([audited.tool, audited.kind, audited.target, audited.request, audited.short], [
    'mcp_call', 'mcp', 'jira', { tool: 'get_issue', arguments: { issue_key: 'A-1' } }, 'unknown target',
  ]);
  assert.deepEqual(await handleMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wiki__get_page' },
  }, env), { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'unknown tool: wiki__get_page' }], isError: true } });
});

test('list_targets names the exported tools of an mcp target as the tool list does', () => {
  const mcp = kindByKey('mcp');
  assert.deepEqual(mcp.listFields({ name: 'jira', tools: ['get_issue', 5, 'search'] }), { tools: ['jira__get_issue', 'jira__search'] });
  assert.deepEqual(mcp.listFields({ name: 'jira' }), { tools: [] });
  assert.equal(KINDS.filter((kind) => kind.listFields !== undefined).length, 1);
});

test('the poll: a notification only when the list really changed, and only once a list was given', async () => {
  const { env, dir } = plainWorld(MCP_INVENTORY);
  const written = [];
  const watch = listWatch(env, (text) => written.push(text));
  const notified = () => written.length;
  assert.equal(watch.declare(), true);
  writeLive(dir);
  writeTools(dir, [entry('jira', 'get_issue')]);
  assert.equal(watch.tick(), false, 'nothing was given yet');
  clearSession(dir);
  watch.gave(listedTools(env));
  assert.equal(watch.tick(), false, 'the list given is the list now');
  assert.equal(watch.tick(), false, 'nothing changed');

  writeLive(dir);
  assert.equal(watch.tick(), true, 'the session started with a tool');
  assert.deepEqual(written, ['{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n']);
  assert.equal(watch.tick(), false);
  writeTools(dir, [entry('jira', 'get_issue')]);
  writeLive(dir);
  assert.equal(watch.tick(), false, 'both files written again with the same tools');
  writeTools(dir, [entry('jira', 'get_issue'), entry('jira', 'search')]);
  assert.equal(watch.tick(), true, 'one more tool');
  clearSession(dir);
  assert.equal(watch.tick(), true, 'the session ended');
  writeLive(dir, { pid: deadPid() });
  assert.equal(watch.tick(), false, 'a session that is not live lists nothing more');
  assert.equal(notified(), 3);

  // A session whose process ends without a word: only the liveness of its pid changes.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  try {
    writeLive(dir, { pid: child.pid, started: null });
    writeTools(dir, [entry('jira', 'get_issue')], { pid: child.pid, started: null });
    assert.equal(watch.tick(), true, 'a live session');
    const stamp = toolsStamp(dir, child.pid);
    child.kill('SIGKILL');
    await once(child, 'exit');
    assert.notEqual(toolsStamp(dir, child.pid), stamp);
    assert.equal(watch.tick(), true, 'its process ended');
  } finally {
    child.kill('SIGKILL');
  }
  assert.equal(notified(), 5);

  // An inventory that cannot be read declares listChanged too; one without an mcp target does not.
  const unreadable = plainWorld();
  fs.writeFileSync(path.join(unreadable.env[CONFIG_KEY], 'inventory.json'), '{ not json');
  assert.equal(listWatch(unreadable.env, () => {}).declare(), true);
  assert.equal(listWatch(plainWorld({ ssh: [] }).env, () => {}).declare(), false);
  assert.equal(listWatch(plainWorld().env, () => {}).declare(), false);
  assert.equal(LIST_POLL_MS, 2000);
});

// A serve over PassThrough streams: send writes one line, lines gives the JSON lines written so far, end ends the input.
function stdio(env, pollMs) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const done = serve({
    input, output, env, pollMs,
  });
  return {
    send: (message) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`),
    lines: () => text.split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    end: () => {
      input.end();
      return done;
    },
  };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const isChange = (line) => line.method === 'notifications/tools/list_changed';

test('ksproxy mcp declares listChanged and notifies only when the inventory holds an mcp target', async () => {
  const base = fs.realpathSync(tempDir('ks-mcp-direct-'));
  // Both share one state folder, so one session; only the inventory differs.
  const withMcp = plainWorld(MCP_INVENTORY, base);
  const without = plainWorld({ ssh: [] }, base);
  const servers = [stdio(withMcp.env, 5), stdio(without.env, 5)];
  for (const server of servers) {
    server.send(INIT);
    server.send(INITIALIZED);
    server.send(INITIALIZED);
    server.send({ ...INITIALIZED, id: 7 });
    server.send({ jsonrpc: '2.0', method: 'tools/list' });
    server.send('null');
    server.send(LIST);
  }
  const answered = (server, id) => waitFor(() => server.lines().some((line) => line.id === id), 10000, `the answer ${id}`);
  for (const server of servers) await answered(server, 2);
  const [mcpServer, plain] = servers;
  assert.deepEqual(mcpServer.lines()[0].result.capabilities, { tools: { listChanged: true } });
  // Without an mcp target, the answer of initialize is the one of before, byte for byte.
  const old = await handleMessage(INIT, without.env);
  assert.deepEqual(plain.lines()[0], old);
  assert.equal(JSON.stringify(old.result.capabilities), '{"tools":{}}');

  writeLive(withMcp.dir);
  writeTools(withMcp.dir, [entry('jira', 'get_issue')]);
  await waitFor(() => mcpServer.lines().some(isChange), 10000, 'the notification');
  mcpServer.send({ ...LIST, id: 3 });
  await answered(mcpServer, 3);
  const listed = mcpServer.lines().find((line) => line.id === 3);
  assert.deepEqual(names(listed.result.tools), [...FIXED, 'jira__get_issue']);
  // The server of the user without an mcp target never reads the session for its list, so it lists the fixed tools
  // only, and it says nothing.
  plain.send({ ...LIST, id: 3 });
  await answered(plain, 3);
  assert.deepEqual(names(plain.lines().find((line) => line.id === 3).result.tools), FIXED);
  clearSession(withMcp.dir);
  await waitFor(() => mcpServer.lines().filter(isChange).length === 2, 10000, 'the second notification');
  await Promise.all(servers.map((server) => server.end()));
  assert.equal(plain.lines().some(isChange), false);
  assert.deepEqual(mcpServer.lines().map((line) => line.method ?? line.id), [
    1, 7, null, 2, 'notifications/tools/list_changed', 3, 'notifications/tools/list_changed',
  ]);
});

test('a session through start: the tools listed and announced, each call routed to mcp_call and audited as one', async () => {
  const jm = standIn();
  const slow = standIn({ slowCallMs: 5000 });
  const world = await makeWorld({ ssh: [], extraEnv: { NO_COLOR: '1', [SECRET_VAR]: SECRET } });
  const inventory = path.join(world.env[CONFIG_KEY], 'inventory.json');
  fs.writeFileSync(inventory, JSON.stringify({
    mcp: [mcpTarget('jm', jm), mcpTarget('slow', slow, { timeoutSeconds: 1, allow: ['get_issue'] })],
  }));
  const before = JSON.stringify(listedTools(world.env));
  assert.deepEqual(names(listedTools(world.env)), FIXED);
  const agent = stdio(world.env, 20);
  agent.send(INIT);
  agent.send(INITIALIZED);
  agent.send(LIST);
  await waitFor(() => agent.lines().some((line) => line.id === 2), 10000, 'the first list');

  const run = launch(world, { all: true }, { limits: { followMs: 50 } });
  await ready(run);
  await waitFor(() => agent.lines().some(isChange), 10000, 'the notification of the new tools');
  agent.send({ ...LIST, id: 3 });
  await waitFor(() => agent.lines().some((line) => line.id === 3), 10000, 'the second list');
  const listed = agent.lines().find((line) => line.id === 3).result.tools;
  assert.deepEqual(names(listed), [...FIXED, 'jm__get_issue', 'jm__add_comment', 'slow__get_issue']);
  assert.deepEqual(listed[FIXED.length], {
    name: 'jm__get_issue', description: '[from the MCP server "jm"] Get one issue', inputSchema: issueSchema(),
  });

  const call = async (name, args) => {
    const answer = await handleMessage({
      jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args },
    }, world.env);
    return { text: answer.result.content[0].text, isError: answer.result.isError };
  };
  // The agent's timeout_seconds is an argument of the server, sent as it is.
  assert.deepEqual(await call('jm__get_issue', { issue_key: 'SHOP-1', timeout_seconds: 600 }), {
    text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"SHOP-1","timeout_seconds":600}', isError: false,
  });
  assert.deepEqual(received(jm.record, 'tools/call').map((item) => item.got.params.arguments), [{ issue_key: 'SHOP-1', timeout_seconds: 600 }]);
  assert.deepEqual(await call('jm__add_comment', { issue_key: 'HR-1', body: 'x' }), {
    text: 'REFUSED (mcp jm): no rule allows add_comment with these arguments. Allowed: get_issue; add_comment {"issue_key":"regex(SHOP-[0-9]+)"}',
    isError: true,
  });
  assert.deepEqual(await call('jm__delete_issue', { issue_key: 'SHOP-1' }), { text: 'unknown tool: jm__delete_issue', isError: true });
  // The time limit is the target's timeoutSeconds, 1, not the 600 the agent sent to the server. A call that timed out
  // loses the last 1 KiB of each stream back to a newline, so the short stderr of the kind is left out.
  assert.deepEqual(await call('slow__get_issue', { issue_key: 'A-1', timeout_seconds: 600 }), {
    text: [
      'timed out after 1s',
      '--- stderr ---',
      'the MCP server did not answer within 1 seconds',
    ].join('\n'),
    isError: true,
  });
  assert.deepEqual(received(slow.record, 'tools/call').map((item) => item.got.params.arguments), [{ issue_key: 'A-1', timeout_seconds: 600 }]);
  assert.equal(received(jm.record, 'tools/call').length, 1, 'a refused call never reached the server');

  const targets = JSON.parse((await callTool('list_targets', {}, world.env)).text).targets.map((t) => [t.name, t.tools]);
  assert.deepEqual(targets, [['jm', ['jm__get_issue', 'jm__add_comment']], ['slow', ['slow__get_issue']]]);
  const audit = fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === 'call');
  assert.deepEqual(audit.map((e) => [e.tool, e.kind, e.target, e.request.tool, e.decision]), [
    ['mcp_call', 'mcp', 'jm', 'get_issue', 'allowed'],
    ['mcp_call', 'mcp', 'jm', 'add_comment', 'refused'],
    ['mcp_call', 'mcp', 'slow', 'get_issue', 'allowed'],
  ]);
  assert.deepEqual(audit[0].request.arguments, { issue_key: 'SHOP-1', timeout_seconds: '600' });

  assert.equal(await stopWith(run), 0);
  await waitFor(() => agent.lines().filter(isChange).length === 2, 10000, 'the notification of the end');
  agent.send({ ...LIST, id: 4 });
  await waitFor(() => agent.lines().some((line) => line.id === 4), 10000, 'the last list');
  assert.equal(JSON.stringify(agent.lines().find((line) => line.id === 4).result.tools), before);
  assert.equal(JSON.stringify(listedTools(world.env)), before);
  assert.deepEqual(await call('jm__get_issue', { issue_key: 'SHOP-1' }), { text: 'unknown tool: jm__get_issue', isError: true });
  await agent.end();
  const shown = run.proc.stdout.text + run.proc.stderr.text + fs.readFileSync(world.auditLog, 'utf8');
  assert.ok(!shown.includes(SECRET));
});

test('each project lists and routes only its own tools, through ksproxy mcp and through /p/NAME/mcp', async () => {
  const world = await makeWorld({ ssh: [], extraEnv: { NO_COLOR: '1', [SECRET_VAR]: SECRET } });
  delete world.env[PROJECT_KEY];
  const servers = { shop: standIn(), ops: standIn() };
  const projectsDir = path.join(world.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(projectsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projectsDir, 'shop.json'), JSON.stringify({ mcp: [mcpTarget('sj', servers.shop)] }));
  fs.writeFileSync(path.join(projectsDir, 'ops.json'), JSON.stringify({ mcp: [mcpTarget('oj', servers.ops)] }));
  const envs = { shop: withProject(world.env, 'shop'), ops: withProject(world.env, 'ops') };
  const runs = {
    shop: launch({ env: envs.shop }, { all: true }, { limits: { followMs: 50 } }),
    ops: launch({ env: envs.ops }, { all: true }, { limits: { followMs: 50 } }),
  };
  await ready(runs.shop);
  await ready(runs.ops);
  try {
    const args = { issue_key: 'SHOP-1' };
    const called = 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"SHOP-1"}';
    assert.deepEqual(names(listedTools(envs.shop)), [...FIXED, 'sj__get_issue', 'sj__add_comment']);
    assert.equal((await callTool('sj__get_issue', args, envs.shop)).text, called);
    assert.deepEqual(await callTool('oj__get_issue', args, envs.shop), { text: 'unknown tool: oj__get_issue', isError: true });

    const token = newToken(world.env);
    const listener = await startListener({
      addresses: [{ host: '127.0.0.1', port: 0, family: 4 }],
      tls: null,
      projects: new Map([['shop', envs.shop], ['ops', envs.ops]]),
      env: world.env,
      onEvent: () => {},
    });
    listeners.push(listener);
    const port = Number(listener.bound[0].slice(listener.bound[0].lastIndexOf(':') + 1));
    const rpc = (project, message) => new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/p/${project}/mcp`,
        agent: false,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          assert.equal(response.statusCode, 200, body);
          resolve(JSON.parse(body));
        });
      });
      request.on('error', reject);
      request.end(JSON.stringify(message));
    });
    const tools = async (project) => names((await rpc(project, LIST)).result.tools);
    const text = async (project, name) => (await rpc(project, {
      jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name, arguments: args },
    })).result.content[0].text;

    // The listener cannot push a notification: it never declares listChanged.
    assert.deepEqual((await rpc('shop', INIT)).result.capabilities, { tools: {} });
    assert.deepEqual(await tools('shop'), [...FIXED, 'sj__get_issue', 'sj__add_comment']);
    assert.deepEqual(await tools('ops'), [...FIXED, 'oj__get_issue', 'oj__add_comment']);
    assert.equal(await text('ops', 'oj__get_issue'), called);
    assert.equal(await text('ops', 'sj__get_issue'), 'unknown tool: sj__get_issue');
    assert.equal(await text('shop', 'oj__get_issue'), 'unknown tool: oj__get_issue');
    assert.equal(received(servers.shop.record, 'tools/call').length, 1);
    assert.equal(received(servers.ops.record, 'tools/call').length, 1);
    const opsAudit = fs.readFileSync(path.join(world.env[STATE_KEY], 'p', 'ops', 'logs', 'audit.log'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line)).filter((e) => e.event === 'call');
    assert.deepEqual(opsAudit.map((e) => [e.tool, e.target, e.decision, e.from, e.client]), [['mcp_call', 'oj', 'allowed', '127.0.0.1', 'unknown']]);
  } finally {
    assert.equal(await stopWith(runs.shop), 0);
    assert.equal(await stopWith(runs.ops), 0);
  }
});
