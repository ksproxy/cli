import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mcp, {
  connectors, limits, serverEnv, tailLines,
} from '../src/kinds/mcp/index.js';
import { KINDS, kindByCliName, kindByKey, kindByTool } from '../src/kinds/index.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { checkKind } from './kind-contract.js';
import { startHttpStandIn } from './fixtures/mcp-server.js';
import { waitFor } from './start-helpers.js';
import { tempDir } from './temp.js';

const STAND_IN = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));
const SECRET = 'S3cr3t-mcp-token-value-0042';
const W = 'mcp "jira"';
const saved = { ...limits };
const savedConnectors = { ...connectors };

// Every entry a test opened is closed after it, also when the test fails, so that no stand-in outlives the file.
const opens = [];

afterEach(async () => {
  Object.assign(limits, saved);
  Object.assign(connectors, savedConnectors);
  for (const opened of opens.splice(0)) await mcp.close(opened);
});

const TOOLS = [
  { name: 'get_issue', description: 'Get one issue', inputSchema: { type: 'object', properties: { issue_key: { type: 'string' }, cloudId: { type: 'string' }, standIn: { type: 'object' } }, required: ['issue_key'] } },
  { name: 'free', description: 'No properties', inputSchema: { type: 'object' } },
  { name: 'twice', inputSchema: { type: 'object' } },
  { name: 'twice', inputSchema: { type: 'object' } },
];

// The command of a stand-in server with options, given in a file of their own.
const optionFiles = fs.realpathSync(tempDir('ks-mcp-options-'));
let optionCount = 0;
function standIn(options) {
  optionCount += 1;
  const file = path.join(optionFiles, `${optionCount}.json`);
  fs.writeFileSync(file, JSON.stringify({ tools: TOOLS, ...options }));
  return [process.execPath, STAND_IN, `@${file}`];
}
// What the system adds to the environment of every program it starts, whatever the parent gives: macOS adds its text
// encoding, and a run with coverage adds the coverage folder.
const SYSTEM_ADDED = ['__CF_USER_TEXT_ENCODING', 'NODE_V8_COVERAGE'];
const withoutSystem = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !SYSTEM_ADDED.includes(name)));
const readRecord = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

function validated(entry) {
  return validateInventory({ mcp: [{ name: 'jira', allow: ['get_issue'], ...entry }] }).mcp[0];
}

// A state folder and the environment of start for one open; KSPROXY_STATE_DIR keeps every folder in the test's own.
function place() {
  const base = fs.realpathSync(tempDir('ks-mcp-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return {
    base,
    env: {
      PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', TMPDIR: base, KSPROXY_STATE_DIR: path.join(base, 'st'), OTHER_VARIABLE: 'never',
    },
  };
}

async function openWith(target, { env, secrets = {}, signal = new AbortController().signal } = {}) {
  const said = [];
  const result = await mcp.open(target, {
    env: env ?? place().env, secrets, signal, say: (text) => said.push(text),
  });
  const opened = result.ok ? { kind: 'mcp', target, ...result.extras } : null;
  if (opened !== null) opens.push(opened);
  return { result, said, opened };
}

test('the kind meets the contract: no flag, the word mcp, and a tool that is never listed but answers', async () => {
  assert.equal(kindByKey('mcp'), mcp);
  assert.equal(KINDS.at(-1), mcp);
  assert.equal(mcp.flag, undefined);
  assert.deepEqual([mcp.key, mcp.label, mcp.word, mcp.noun, mcp.countNoun], ['mcp', 'mcp', 'mcp', 'MCP server', 'MCP server(s)']);
  assert.doesNotThrow(() => checkKind(mcp, KINDS));
  assert.equal(kindByCliName('mcp'), mcp);
  assert.equal(kindByTool('mcp_call'), mcp);
  const names = (inventory) => toolDefinitions(inventory).map((tool) => tool.name);
  assert.ok(!names({ mcp: [validated({ command: standIn({}) })] }).includes('mcp_call'));
  assert.ok(!names(null).includes('mcp_call'));
  assert.ok(names(null).includes('kafka_exec'));
  const { env } = place();
  assert.deepEqual(await callTool('mcp_call', { target: 'jira', tool: 'x' }, env), {
    text: 'No active session. Ask the user to run `ksproxy start` in their terminal.', isError: true,
  });
});

test('validate: a local and a remote target, with their defaults', () => {
  assert.deepEqual(validated({ command: ['uvx', 'mcp-atlassian@0.24.8'], description: 'd' }), {
    kind: 'mcp', name: 'jira', description: 'd', allow: ['get_issue'], arguments: {}, timeoutSeconds: 60, command: ['uvx', 'mcp-atlassian@0.24.8'], env: {},
  });
  assert.deepEqual(validated({
    command: ['~/bin/server', '--x'], env: { A: 'b', T: { fromEnv: 'JIRA_TOKEN' } }, arguments: { cloudId: 'c1' }, timeoutSeconds: 600,
  }), {
    kind: 'mcp',
    name: 'jira',
    description: '',
    allow: ['get_issue'],
    arguments: { cloudId: 'c1' },
    timeoutSeconds: 600,
    command: [path.join(process.env.HOME, 'bin', 'server'), '--x'],
    env: { A: 'b', T: { fromEnv: 'JIRA_TOKEN' } },
  });
  assert.deepEqual(validated({ url: 'https://api.example.com/mcp/x/issues/readonly?tools=all' }), {
    kind: 'mcp', name: 'jira', description: '', allow: ['get_issue'], arguments: {}, timeoutSeconds: 60, url: 'https://api.example.com/mcp/x/issues/readonly?tools=all', login: 'none', tokenEnv: null, userEnv: null,
  });
  assert.deepEqual(validated({ url: 'http://127.0.0.1:8080/mcp', login: 'token', tokenEnv: 'GH_TOKEN' }).tokenEnv, 'GH_TOKEN');
  const basic = validated({
    url: 'http://localhost/mcp', login: 'basic', userEnv: 'JIRA_USER', tokenEnv: 'JIRA_TOKEN',
  });
  assert.deepEqual([basic.login, basic.userEnv, basic.tokenEnv], ['basic', 'JIRA_USER', 'JIRA_TOKEN']);
  assert.equal(validated({ url: 'http://[::1]:9/mcp' }).url, 'http://[::1]:9/mcp');
  const proto = validated({ command: ['server'], env: JSON.parse('{"__proto__": "x"}') });
  assert.ok(Object.hasOwn(proto.env, '__proto__'));
});

test('validate: every inventory error', () => {
  const refused = (entry, text) => assert.throws(
    () => validateInventory({ mcp: [{ name: 'jira', ...entry }] }),
    (err) => err instanceof InventoryError && err.message === `${W}: ${text}`,
    text,
  );
  const words = 'command: must be a list of 1 to 50 words, the program and its arguments, each at most 1024 bytes and without control characters';
  refused({ command: ['x'], nope: 1 }, 'unknown key "nope"');
  refused({ command: ['x'], review: { reviewer: 'r' } }, 'review: is not supported for mcp targets in this version');
  refused({}, 'give exactly one of command (a local MCP server) and url (a remote one)');
  refused({ command: ['x'], url: 'https://example.com' }, 'give exactly one of command (a local MCP server) and url (a remote one)');
  refused({ command: ['x'], allow: 'any' }, 'allow: "any" is not supported for mcp targets; list the tools');
  refused({ command: ['x'], arguments: { 'a b': 1 } }, 'arguments: "a b" must be an argument name of letters, digits and _ . - (at most 64 characters)');
  refused({ command: ['x'], timeoutSeconds: 0 }, 'timeoutSeconds: must be an integer from 1 to 600');
  refused({ command: ['x'], timeoutSeconds: 601 }, 'timeoutSeconds: must be an integer from 1 to 600');
  for (const bad of [[], 'uvx', [1], Array(51).fill('x'), ['x', 'a\nb'], ['x', 'y'.repeat(1025)]]) refused({ command: bad }, words);
  refused({ command: ['relative/x'] }, 'command[0]: program: must be an absolute path, a path that starts with "~/", or a program name of letters, digits and _ . + - that is looked up on PATH');
  refused({ command: ['npx', 'server'] }, 'command: npx runs server without an exact version; write the package as name@1.2.3 or @scope/name@1.2.3');
  refused({ command: ['/usr/local/bin/uvx', 'mcp-atlassian'] }, 'command: uvx runs mcp-atlassian without an exact version; write name@1.2.3, or --from \'name==1.2.3\' and the command');
  for (const key of ['login', 'tokenEnv', 'userEnv']) refused({ command: ['x'], [key]: 'X' }, `${key}: is only for a remote MCP server (url)`);
  refused({ command: ['x'], env: [] }, 'env: must be an object of at most 50 variables, each a text or {"fromEnv": NAME}');
  refused({ command: ['x'], env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`V${i}`, 'x'])) }, 'env: must be an object of at most 50 variables, each a text or {"fromEnv": NAME}');
  refused({ command: ['x'], env: { '1A': 'x' } }, 'env["1A"]: must be the name of an environment variable: letters, digits and "_", not starting with a digit');
  refused({ command: ['x'], env: { 'A-B': 'x' } }, 'env["A-B"]: must be the name of an environment variable: letters, digits and "_", not starting with a digit');
  refused({ command: ['x'], env: { LD_PRELOAD: 'x' } }, 'env["LD_PRELOAD"]: LD_PRELOAD changes how programs are loaded; name another variable');
  refused({ command: ['x'], env: { DYLD_INSERT_LIBRARIES: 'x' } }, 'env["DYLD_INSERT_LIBRARIES"]: DYLD_INSERT_LIBRARIES changes how programs are loaded; name another variable');
  refused({ command: ['x'], env: { A: 'x\ny' } }, 'env["A"]: a text value is at most 4096 bytes, without control characters');
  refused({ command: ['x'], env: { A: 'x'.repeat(4097) } }, 'env["A"]: a text value is at most 4096 bytes, without control characters');
  for (const bad of [1, null, {}, { fromEnv: 'A', more: 1 }, { from: 'A' }]) refused({ command: ['x'], env: { A: bad } }, 'env["A"]: must be a text or {"fromEnv": NAME}');
  refused({ command: ['x'], env: { A: { fromEnv: 'PATH' } } }, 'env["A"].fromEnv: PATH is a variable the session needs; name a variable that must hold only the secret');
  refused({ command: ['x'], env: { A: { fromEnv: 'lower' } } }, 'env["A"].fromEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  refused({ url: 'https://example.com', env: {} }, 'env: is only for a local MCP server (command)');
  for (const bad of ['not a url', 42, '']) refused({ url: bad }, 'url: must be a URL');
  for (const bad of ['http://example.com/mcp', 'ftp://example.com', 'http://192.0.2.1/mcp']) refused({ url: bad }, 'url: must use https (http is accepted for localhost only)');
  for (const bad of ['https://u:p@example.com/mcp', 'https://u@example.com/mcp', 'https://example.com/mcp#x']) refused({ url: bad }, 'url: must not contain a user name, a password or a fragment');
  const url = 'https://api.example.com/mcp';
  refused({ url, login: 'oauth' }, 'login: must be "none", "token" or "basic"');
  refused({ url, login: 'token' }, 'login "token" needs tokenEnv');
  refused({ url, login: 'basic', userEnv: 'U_VAR' }, 'login "basic" needs tokenEnv');
  refused({ url, tokenEnv: 'GH_TOKEN' }, 'tokenEnv needs login "token" or "basic"');
  refused({ url, login: 'token', tokenEnv: 'GH_TOKEN', userEnv: 'U_VAR' }, 'userEnv goes with login "basic", and login "basic" needs it');
  refused({ url, login: 'basic', tokenEnv: 'GH_TOKEN' }, 'userEnv goes with login "basic", and login "basic" needs it');
  refused({ url, login: 'token', tokenEnv: 'HOME' }, 'tokenEnv: HOME is a variable the session needs; name a variable that must hold only the token');
  refused({ url, login: 'basic', tokenEnv: 'T_VAR', userEnv: 'KSPROXY_X' }, 'userEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
});

test('the names, the secrets, their hidden forms, the warnings and the agent notes of a target', () => {
  const local = validated({
    command: ['/usr/local/bin/uvx', 'mcp-atlassian@0.24.8'],
    env: {
      JIRA_URL: 'https://example.atlassian.net', JIRA_API_TOKEN: { fromEnv: 'JIRA_TOKEN' }, OTHER_TOKEN: { fromEnv: 'JIRA_TOKEN' }, PLAIN_KEY: 'k',
    },
    description: 'Jira',
    allow: ['get_issue', { tool: 'add', arguments: { k: 'regex((a+)+)' } }],
  });
  assert.equal(mcp.hint(local), 'uvx mcp-atlassian@0.24.8 - Jira');
  assert.equal(mcp.hint({ ...local, description: '' }), 'uvx mcp-atlassian@0.24.8');
  assert.equal(mcp.openingMessage(local), 'uvx mcp-atlassian@0.24.8, 4 variables');
  assert.equal(mcp.openingMessage({ ...local, env: { A: 'b' } }), 'uvx mcp-atlassian@0.24.8, 1 variable');
  assert.deepEqual(mcp.secrets(local), { env: ['JIRA_TOKEN'], files: [] });
  assert.deepEqual(mcp.hiddenForms(local, { JIRA_TOKEN: 'a"b\\c' }), ['a\\"b\\\\c']);
  assert.deepEqual(mcp.hiddenForms(local, { JIRA_TOKEN: 'plain-value' }), []);
  assert.deepEqual(mcp.ruleWarnings(local), [
    'allow[1].arguments.k: this pattern can be very slow on some inputs',
    'env.PLAIN_KEY: holds a plain text, but its name looks like a secret; write {"fromEnv": NAME} so that start holds it and hides it',
  ]);

  const remote = validated({
    url: 'https://api.example.com/mcp/x/issues?tools=all', login: 'basic', userEnv: 'JIRA_USER', tokenEnv: 'JIRA_TOKEN', description: 'GitHub',
  });
  assert.equal(mcp.hint(remote), 'api.example.com - GitHub');
  assert.equal(mcp.openingMessage(remote), 'https://api.example.com/mcp/x/issues, basic auth from JIRA_USER and JIRA_TOKEN');
  assert.equal(mcp.openingMessage({ ...remote, login: 'token' }), 'https://api.example.com/mcp/x/issues, token from JIRA_TOKEN');
  assert.equal(mcp.openingMessage({ ...remote, login: 'none' }), 'https://api.example.com/mcp/x/issues, no login');
  assert.deepEqual(mcp.secrets(remote), { env: ['JIRA_USER', 'JIRA_TOKEN'], files: [], users: ['JIRA_USER'] });
  assert.deepEqual(mcp.secrets({ ...remote, login: 'token', userEnv: null }), { env: ['JIRA_TOKEN'], files: [] });
  assert.deepEqual(mcp.secrets({ ...remote, login: 'none', tokenEnv: null, userEnv: null }), { env: [], files: [] });
  assert.deepEqual(mcp.hiddenForms(remote, { JIRA_USER: 'someone', JIRA_TOKEN: 'tok-123456' }), [Buffer.from('someone:tok-123456').toString('base64')]);
  assert.deepEqual(mcp.ruleWarnings(remote), []);

  const recorded = {
    ...mcp.record({ target: local, live: { toolNames: ['get_issue'] } }), arguments: { cloudId: 'c1' },
  };
  assert.deepEqual(mcp.record({ target: remote, live: { toolNames: [] } }), {
    kind: 'mcp',
    name: 'jira',
    description: 'GitHub',
    allow: ['get_issue'],
    url: 'https://api.example.com/mcp/x/issues?tools=all',
    login: 'basic',
    tokenEnv: 'JIRA_TOKEN',
    userEnv: 'JIRA_USER',
    arguments: {},
    timeoutSeconds: 60,
    tools: [],
    state: 'up',
  });
  assert.equal(mcp.agentSection(recorded), [
    '### MCP server `jira` - Jira',
    '',
    '- Its allowed tools are in your tool list as `jira__TOOL`: `jira__get_issue`. Call them as you would call the server itself.',
    '- Allowed tools: get_issue; add {"k":"regex((a+)+)"}',
    '- The user fixed these arguments, which ksproxy adds to every call: `cloudId`. Leave them out.',
    '- A rule on an argument that holds a query (JQL, CQL or a search text) does not limit what the query reads: the user\'s account limits the data.',
    '- Answers are text: an image or a binary part is named, not shown. A call stops after 60 seconds.',
  ].join('\n'));
  assert.equal(mcp.agentSection({ ...recorded, description: '', tools: [], arguments: {} }), [
    '### MCP server `jira`',
    '',
    '- No tool of this server is in your tool list.',
    '- Allowed tools: get_issue; add {"k":"regex((a+)+)"}',
    '- A rule on an argument that holds a query (JQL, CQL or a search text) does not limit what the query reads: the user\'s account limits the data.',
    '- Answers are text: an image or a binary part is named, not shown. A call stops after 60 seconds.',
  ].join('\n'));
  assert.ok(mcp.toolBullet.includes('mcp_call'));
});

test('checkInput, auditedDetail and detailText: the call of ksproxy check, and what the audit keeps', () => {
  assert.deepEqual(mcp.checkInput(['get_issue']), { tool: 'get_issue' });
  assert.deepEqual(mcp.checkInput(['get_issue', '{"issue_key":', '"SHOP-1"}']), { tool: 'get_issue', arguments: { issue_key: 'SHOP-1' } });
  assert.deepEqual(mcp.checkInput(['get_issue', 'not', 'json']), { tool: 'get_issue', arguments: 'not json' });
  const { auditedDetail, detailText } = mcp.tool;
  const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}`, i]));
  const audited = auditedDetail({ tool: 't'.repeat(200), arguments: { long: 'x'.repeat(600), [`k${'y'.repeat(70)}`]: 1, obj: { b: 1, a: [true] }, ...many } });
  assert.equal(audited.tool.length, 128);
  assert.equal(audited.arguments.long.length, 500);
  assert.equal(audited.arguments.obj, '{"a":[true],"b":1}');
  assert.equal(audited.arguments[`k${'y'.repeat(62)}…`], '1');
  assert.equal(Object.keys(audited.arguments).length, 50);
  assert.deepEqual(auditedDetail({ tool: 3, arguments: 'x' }), { tool: null, arguments: null });
  assert.equal(detailText({ tool: 'get_issue', arguments: { b: 2, a: 'x' } }), 'get_issue {"a":"x","b":2}');
  assert.equal(detailText({ tool: 'get_issue', arguments: {} }), 'get_issue');
  assert.equal(detailText({ tool: 'get_issue', arguments: null }), 'get_issue');
  assert.equal(detailText({}), '(invalid)');
});

test('open: the exact environment and the empty private folder of a local server; close removes the folder', async () => {
  const { base, env } = place();
  const record = path.join(base, 'record.jsonl');
  const target = validated({
    command: standIn({ record }),
    env: { JIRA_URL: 'https://example.atlassian.net', JIRA_API_TOKEN: { fromEnv: 'JIRA_TOKEN' }, NODE_EXTRA_CA_CERTS: '/etc/ca.pem' },
  });
  const startEnv = {
    ...env, XDG_CACHE_HOME: '/c/xdg', UV_CACHE_DIR: '/c/uv', npm_config_cache: '/c/npm', LC_ALL: 'C',
  };
  const { result, said, opened } = await openWith(target, { env: startEnv, secrets: { JIRA_TOKEN: SECRET } });
  assert.equal(result.ok, true);
  assert.deepEqual(said, ['4 tools listed, 1 exported']);
  assert.deepEqual(result.notes, []);
  const [started] = readRecord(record);
  assert.deepEqual(withoutSystem(started.env), {
    PATH: '/usr/bin:/bin',
    HOME: env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: base,
    XDG_CACHE_HOME: '/c/xdg',
    UV_CACHE_DIR: '/c/uv',
    npm_config_cache: '/c/npm',
    JIRA_URL: 'https://example.atlassian.net',
    JIRA_API_TOKEN: SECRET,
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  });
  assert.equal(path.dirname(started.cwd), path.join(base, 'st', 'run'));
  assert.match(path.basename(started.cwd), /^mcp-/);
  assert.deepEqual(fs.readdirSync(started.cwd), []);
  assert.equal(fs.statSync(started.cwd).mode & 0o777, 0o700);
  assert.deepEqual(serverEnv(target, { HOME: '/h' }, { JIRA_TOKEN: 't' }), {
    HOME: '/h', JIRA_URL: 'https://example.atlassian.net', JIRA_API_TOKEN: 't', NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
  });
  await mcp.close(opened);
  assert.equal(fs.existsSync(started.cwd), false);
  // A folder that cannot be removed is left to the next start; close never throws.
  await mcp.close({ live: { client: { close: async () => {} }, cwd: 'a\u0000b' } });
  assert.deepEqual(said, ['4 tools listed, 1 exported'], 'a server that ends at close says nothing');
  assert.equal(mcp.downMessage(target, 'down', opened), 'the MCP server stopped (exit 0)');
});

test('open: a program that cannot be found or a private folder that cannot be made skips the target', async () => {
  const { base, env } = place();
  assert.deepEqual((await openWith(validated({ command: ['no-such-mcp-server'] }), { env })).result, {
    ok: false, error: 'program no-such-mcp-server was not found on PATH',
  });
  fs.mkdirSync(env.KSPROXY_STATE_DIR);
  fs.writeFileSync(path.join(env.KSPROXY_STATE_DIR, 'run'), 'a file');
  const { result, said } = await openWith(validated({ command: standIn({}) }), { env });
  assert.deepEqual(result, { ok: false, error: 'could not make the private folder of the MCP server' });
  assert.deepEqual(said, []);
  // An open that throws skips the target and never reaches start.
  assert.deepEqual(await mcp.open(validated({ command: standIn({}) }), { env, secrets: null }), {
    ok: false, error: 'the MCP server failed; its last lines are in the start terminal',
  });
  assert.ok(base);
});

test('open: a server that fails says why and its last stderr lines, every secret hidden; the SKIPPED text is fixed', async () => {
  const { env } = place();
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i} @SECRET@`).join('\n');
  const target = validated({
    command: standIn({ secretVar: 'TOKEN_OF_TEST', stderrText: `${lines}\nlast ${'z'.repeat(700)}\n`, exitAt: 1 }),
    env: { TOKEN_OF_TEST: { fromEnv: 'JIRA_TOKEN' } },
  });
  const { result, said } = await openWith(target, { env, secrets: { JIRA_TOKEN: SECRET } });
  assert.deepEqual(result, { ok: false, error: 'the MCP server failed; its last lines are in the start terminal' });
  assert.equal(said[0], 'the MCP server failed: the MCP server stopped (exit 3)');
  assert.equal(said.length, 21);
  assert.equal(said[1], 'stderr: line 11 [hidden]');
  assert.equal(said[20], `stderr: last ${'z'.repeat(494)}…`);
  assert.ok(!said.join('\n').includes(SECRET));
  assert.equal(fs.readdirSync(path.join(env.KSPROXY_STATE_DIR, 'run')).length, 0);

  // tools/list refused with the secret in its message: hidden in the said line.
  const listing = validated({
    command: standIn({ secretVar: 'TOKEN_OF_TEST', listAnswer: { error: { code: -32000, message: 'no list for @SECRET@' } } }),
    env: { TOKEN_OF_TEST: { fromEnv: 'JIRA_TOKEN' } },
  });
  const refused = await openWith(listing, { env, secrets: { JIRA_TOKEN: SECRET } });
  assert.deepEqual(refused.result, { ok: false, error: 'the MCP server failed; its last lines are in the start terminal' });
  assert.deepEqual(refused.said, ['the MCP server failed: the MCP server refused tools/list: no list for [hidden]']);
});

test('open: the limit covers the start and tools/list, and a stop ends the wait without saying more', async () => {
  const { env } = place();
  limits.startMs = 1500;
  const slow = await openWith(validated({ command: standIn({ slowListMs: 60000 }) }), { env });
  assert.deepEqual(slow.result, { ok: false, error: 'the MCP server failed; its last lines are in the start terminal' });
  assert.deepEqual(slow.said, ['the MCP server failed: the wait for tools/list was stopped']);
  const never = await openWith(validated({ command: standIn({ slowStartMs: 60000 }) }), { env });
  assert.deepEqual(never.said, ['the MCP server failed: the MCP server was not ready within 1.5 seconds']);

  limits.startMs = 120000;
  for (const options of [{ slowStartMs: 60000 }, { slowListMs: 60000 }]) {
    const stop = new AbortController();
    const pending = openWith(validated({ command: standIn(options) }), { env, signal: stop.signal });
    setTimeout(() => stop.abort(), 300);
    const stopped = await pending;
    assert.deepEqual(stopped.result, { ok: false, error: 'the start of the MCP server was stopped' });
    assert.deepEqual(stopped.said, []);
  }
});

test('open: the notes name a rule the server does not match, and more than MAX_TOOLS tools', async () => {
  const { env } = place();
  const target = validated({
    command: standIn({ tools: 2001, pageSize: 1000 }),
    allow: ['tool_1', { tool: 'tool_2', arguments: { other: '*' } }, 'missing'],
  });
  const { result, said, opened } = await openWith(target, { env });
  assert.deepEqual(result.notes, [
    'the MCP server lists more than 2000 tools; only the first 2000 were read',
    'allow[1]: the tool tool_2 declares no argument other',
    'allow[2]: the MCP server does not list the tool missing',
  ]);
  assert.deepEqual(said, ['2000 tools listed, 2 exported']);
  await mcp.close(opened);
});

test('perform: pinned arguments the tool declares are added, an undeclared argument is refused, then the call', async () => {
  const { base, env } = place();
  const record = path.join(base, 'record.jsonl');
  const target = validated({
    command: standIn({ record }), allow: ['get_issue', 'free', 'twice', 'gone'], arguments: { cloudId: 'c1', site: 's1' }, timeoutSeconds: 2,
  });
  const { opened } = await openWith(target, { env });
  const perform = (input, timeoutMs = 60000) => mcp.perform(target, { allowed: true }, {
    timeoutMs, maxBytes: 1000, signal: new AbortController().signal, input, opened,
  });
  assert.deepEqual(await perform({ tool: 'get_issue', arguments: { issue_key: 'SHOP-1' } }), {
    exitCode: 0, stdout: 'called get_issue with {"issue_key":"SHOP-1","cloudId":"c1"}', stderr: '', truncated: false,
  });
  // A server argument named timeout_seconds is the server's own: ksproxy neither takes nor drops it.
  assert.deepEqual(await perform({ tool: 'free', arguments: { any: 1, timeout_seconds: 5 } }), {
    exitCode: 0, stdout: 'called free with {"any":1,"timeout_seconds":5,"cloudId":"c1","site":"s1"}', stderr: '', truncated: false,
  });
  assert.deepEqual(await perform({ tool: 'get_issue', arguments: { issue_key: 'SHOP-1', other: 1 } }), {
    exitCode: 1, stdout: '', stderr: 'the tool get_issue declares no argument "other"; the call was not sent',
  });
  assert.deepEqual(await perform({ tool: 'twice' }), {
    exitCode: 1, stdout: '', stderr: 'the MCP server lists the tool twice more than once; the call was not sent',
  });
  assert.deepEqual(await perform({ tool: 'gone' }), {
    exitCode: 1, stdout: '', stderr: 'the MCP server did not list the tool gone when the target opened; the call was not sent',
  });
  const calls = readRecord(record).filter((entry) => entry.got?.method === 'tools/call').map((entry) => entry.got.params.name);
  assert.deepEqual(calls, ['get_issue', 'free']);
  // The time limit is the smaller of the call's and the target's timeoutSeconds.
  const slowTarget = validated({ command: standIn({ slowCallMs: 10000 }), timeoutSeconds: 2 });
  const slow = await openWith(slowTarget, { env });
  const late = (timeoutMs) => mcp.perform(slowTarget, {}, {
    timeoutMs, maxBytes: 1000, signal: new AbortController().signal, input: { tool: 'free' }, opened: slow.opened,
  });
  assert.deepEqual(await late(60000), {
    exitCode: null, stdout: '', stderr: 'the MCP server did not answer within 2 seconds', timedOut: true,
  });
  assert.deepEqual(await late(1000), {
    exitCode: null, stdout: '', stderr: 'the MCP server did not answer within 1 seconds', timedOut: true,
  });
});

test('perform: a call is sent only when a rule allows the arguments that are sent, without the pinned ones the tool does not declare', async () => {
  const { base, env } = place();
  const record = path.join(base, 'record.jsonl');
  const tools = [
    { name: 'delete_issue', inputSchema: { type: 'object', properties: { issue_key: { type: 'string' } } } },
    { name: 'create_issue', inputSchema: { type: 'object', properties: { issue_key: { type: 'string' }, project: { type: 'string' } } } },
    { name: 'close_issue', inputSchema: { type: 'object', properties: { issue_key: { type: 'string' } } } },
  ];
  const target = validated({
    command: standIn({ tools, record }),
    arguments: { project: 'SANDBOX' },
    allow: [{ tool: 'delete_issue', arguments: { project: 'SANDBOX' } }, { tool: 'create_issue', arguments: { project: 'SANDBOX' } }, 'close_issue'],
  });
  const { result, opened } = await openWith(target, { env });
  // The warning at start stays: the rule names an argument that the tool does not declare.
  assert.deepEqual(result.notes, ['allow[0]: the tool delete_issue declares no argument project']);
  const recorded = mcp.record(opened);
  const send = (tool) => {
    const input = { tool, arguments: { issue_key: 'PROD-1' } };
    const decision = mcp.decide(recorded, input);
    assert.equal(decision.allowed, true, tool);
    return mcp.perform(recorded, decision, {
      timeoutMs: 5000, maxBytes: 1000, signal: new AbortController().signal, input, opened,
    });
  };
  assert.deepEqual(await send('delete_issue'), {
    exitCode: 1, stdout: '', stderr: 'no rule allows delete_issue without the pinned arguments it does not declare (project), which ksproxy does not send; the call was not sent',
  });
  assert.deepEqual(await send('create_issue'), {
    exitCode: 0, stdout: 'called create_issue with {"issue_key":"PROD-1","project":"SANDBOX"}', stderr: '', truncated: false,
  });
  assert.deepEqual(await send('close_issue'), {
    exitCode: 0, stdout: 'called close_issue with {"issue_key":"PROD-1"}', stderr: '', truncated: false,
  });
  const calls = readRecord(record).filter((entry) => entry.got?.method === 'tools/call').map((entry) => entry.got.params.name);
  assert.deepEqual(calls, ['create_issue', 'close_issue']);
});

test('open: a server whose pages of tools/list pass maxListBytes in all is skipped, over stdio and HTTP', async () => {
  limits.maxListBytes = 2000;
  const said = ['the MCP server failed: the list of tools of the MCP server takes more than 2000 bytes over all its pages'];
  const local = await openWith(validated({ command: standIn({ tools: 40, pageSize: 1 }) }));
  assert.deepEqual(local.result, { ok: false, error: 'the MCP server failed; its last lines are in the start terminal' });
  assert.deepEqual(local.said, said);
  const server = await startHttpStandIn({ tools: 40, pageSize: 1 });
  try {
    const remote = await openWith(validated({ url: server.url }));
    assert.deepEqual(remote.result, { ok: false, error: 'the MCP server could not be reached; the reason is in the start terminal' });
    assert.deepEqual(remote.said, said);
  } finally {
    await server.close();
  }
});

test('ruleWarnings: a url query name or a command word that seems to hold a secret, named by field and index, never the value', () => {
  const query = (i) => `url.query[${i}]: its name looks like a secret; the url is written whole to session.json, so give the secret through login "token" or "basic" with tokenEnv, which start holds and hides`;
  const remote = validated({ url: 'https://api.example.com/mcp?tools=all&api_KEY=v1&x=1&Token=v2&sig=v3&author=v4&passwd=v5&my_Secret=v6&password=v7' });
  assert.deepEqual(mcp.ruleWarnings(remote), [1, 3, 4, 5, 6, 7, 8].map(query));
  assert.deepEqual(mcp.ruleWarnings(validated({ url: 'https://api.example.com/mcp?tools=all' })), []);
  const userinfo = (i) => `command[${i}]: holds a URL with a user name and a password; the command is written whole to session.json and shown on the OPENING line, so put the secret in env with {"fromEnv": NAME}`;
  const option = (i) => `command[${i}]: looks like an option that gives a secret; the command is written whole to session.json and shown on the OPENING line, so put the secret in env with {"fromEnv": NAME}`;
  const command = [
    'server', '--jira-url', 'https://u:p@jira.example.com', '--Token', 'abc', '--api-key=xyz', '--APIKEY', '--password=pw1', '--secret',
    'git+https://user:pw2@example.com/r.git', '--jira-token', 'https://jira.example.com:443/x', 'https://user@example.com', '--read-only',
    '--url=token', 'postgres://db.example.com:5432/x', '-p', 'passwd', '--passwd',
  ];
  const warnings = mcp.ruleWarnings(validated({ command }));
  assert.deepEqual(warnings, [userinfo(2), option(3), option(5), option(6), option(7), option(8), userinfo(9), option(10), option(18)]);
  for (const value of ['abc', 'xyz', 'u:p', 'pw1', 'pw2', 'v1']) assert.ok(!warnings.join('\n').includes(value), value);
  assert.deepEqual(mcp.ruleWarnings(validated({ command: ['server', '--read-only'] })), []);
  // A variable set to a value, alone or as the value of an option, and a header that gives a secret.
  const setting = (i) => `command[${i}]: sets a variable whose name looks like a secret; the command is written whole to session.json and shown on the OPENING line, so put the secret in env with {"fromEnv": NAME}`;
  const header = (i) => `command[${i}]: looks like a header that gives a secret; the command is written whole to session.json and shown on the OPENING line, so put the secret in env with {"fromEnv": NAME}`;
  const words = [
    'my-server', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc', '-e', 'GITHUB_TOOLSETS=issues', '--env=API_KEY=abc2', '-e', 'GH_TOKEN',
    '--header', 'Authorization: Bearer abc3', '-H', 'X-Api-Key: abc4', '--header=Authorization:Basic abc5',
    'Content-Type: application/json', 'TOKEN=',
  ];
  const told = mcp.ruleWarnings(validated({ command: words }));
  assert.deepEqual(told, [setting(2), setting(5), header(9), header(11), header(12)]);
  // The likeliest mistake with a pinned runner: docker run -e with the value written in.
  const docker = ['docker', 'run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc', '-e', 'GH_TOKEN', 'img:1'];
  assert.deepEqual(mcp.ruleWarnings(validated({ command: docker })), [setting(5)]);
  for (const value of ['ghp_abc', 'abc2', 'abc3', 'abc4', 'abc5']) assert.ok(!told.join('\n').includes(value), value);
});

test('the sample of ksproxy init names a reserved host, never a site that may be real', () => {
  const [sample] = mcp.sample;
  assert.equal(sample.env.JIRA_URL, 'https://jira.example.com');
  assert.equal(sample.description, 'Jira of jira.example.com');
  assert.equal(validateInventory({ mcp: structuredClone(mcp.sample) }).mcp[0].env.JIRA_URL, 'https://jira.example.com');
});

test('onEnd: a server that stops makes the target down and says its last lines, hidden; probe and downMessage follow', async () => {
  const { env } = place();
  const target = validated({
    command: standIn({ secretVar: 'TOKEN_OF_TEST', stderrText: 'ready\n', exitAt: 4, exitCode: 7 }),
    env: { TOKEN_OF_TEST: { fromEnv: 'JIRA_TOKEN' } },
  });
  const { result, said, opened } = await openWith(target, { env, secrets: { JIRA_TOKEN: SECRET } });
  assert.equal(result.ok, true);
  assert.equal(await mcp.probe(target, { opened }), 'up');
  const answer = await mcp.perform(target, {}, {
    timeoutMs: 5000, maxBytes: 100, signal: new AbortController().signal, input: { tool: 'free' }, opened,
  });
  assert.deepEqual(answer, { exitCode: 1, stdout: '', stderr: 'the MCP server stopped (exit 7)' });
  await waitFor(() => said.length === 3, 5000, 'the said lines of the end');
  assert.deepEqual(said.slice(1), ['the MCP server stopped (exit 7); the target is down', 'stderr: ready']);
  assert.equal(await mcp.probe(target, { opened }), 'down');
  assert.equal(mcp.downMessage(target, 'down', opened), 'the MCP server stopped (exit 7)');
  assert.deepEqual(mcp.doctor(opened), { ok: true, detail: '4 tools listed, 1 exported; the credential is checked only by a call' });
  await mcp.close(opened);
  assert.equal(said.length, 3);
});

test('tailLines: secrets hidden, a cut secret dropped at the start of the first line and the end of the last', () => {
  const hidden = ['ABCDEFGHIJKL'];
  assert.deepEqual(tailLines(['GHIJKL first', 'middle ABCDEFGHIJKL and GHIJ', 'last ABCD'], hidden), [
    ' first', 'middle [hidden] and GHIJ', 'last ',
  ]);
  assert.deepEqual(tailLines(['JKL short pieces stay ABC'], hidden), ['JKL short pieces stay ABC']);
  assert.deepEqual(tailLines([], hidden), []);
  assert.deepEqual(tailLines(['x'.repeat(600)], []), [`${'x'.repeat(499)}…`]);
});

test('sessionFiles: none without an open target; the budget of a session shortens the exported list and says so', () => {
  assert.deepEqual(mcp.sessionFiles([]), []);
  const said = [];
  const big = (i) => ({ tool: `t${i}`, definition: { name: `a__t${i}`, description: 'd'.repeat(400 * 1024), inputSchema: { type: 'object' } } });
  const exported = [0, 1, 2].map(big);
  const live = { exported, toolNames: exported.map((item) => item.tool), say: (text) => said.push(text) };
  const recorded = mcp.record({ target: validated({ command: ['server'] }), live });
  const [file] = mcp.sessionFiles([{ target: { name: 'a', timeoutSeconds: 60 }, live }]);
  assert.equal(file.name, 'mcp-tools.json');
  const parsed = JSON.parse(file.text);
  assert.equal(parsed.pid, process.pid);
  assert.ok(Number.isFinite(parsed.processStartedAt));
  assert.deepEqual(parsed.tools.map((t) => t.tool), ['t0', 't1']);
  assert.deepEqual(recorded.tools, ['t0', 't1']);
  assert.deepEqual(said, ['1 more tools are not exported: the tools of a session take at most 1 MiB']);
});

// A client as connectHttp gives it, with what each test asks of it.
function fakeHttp(behaviour = {}) {
  const calls = [];
  const client = {
    era: '2026-07-28',
    serverInfo: { name: 'remote', version: '1' },
    listTools: async () => behaviour.list ?? { tools: TOOLS, capped: false },
    callTool: async (name, args, options) => {
      calls.push({ name, args, timeoutMs: options.timeoutMs });
      return behaviour.call ?? { result: { content: [{ type: 'text', text: `remote ${name}` }] }, truncated: false };
    },
    ping: async () => {
      calls.push({ ping: true });
      return behaviour.ping ?? true;
    },
    onEnd: () => {},
    close: async () => {
      calls.push({ closed: true });
      if (behaviour.closeFails) throw new Error('gone');
    },
  };
  const connect = async (options) => {
    calls.push({ connect: options });
    if (behaviour.connectFails) throw new Error(behaviour.connectFails);
    return client;
  };
  return { connect, calls, client };
}

test('url targets: the connect gets the URL, the token header and the limits; calls, HTTP errors, pings and close', async () => {
  const fake = fakeHttp();
  connectors.http = fake.connect;
  limits.pingEveryMs = 0;
  const target = validated({ url: 'https://api.example.com/mcp?tools=all', login: 'token', tokenEnv: 'GH_TOKEN' });
  const { result, said, opened } = await openWith(target, { secrets: { GH_TOKEN: SECRET } });
  assert.equal(result.ok, true);
  assert.deepEqual(said, ['4 tools listed, 1 exported']);
  const { connect } = fake.calls[0];
  // headers is a function, as connectHttp takes it: the engine asks it for each request.
  assert.deepEqual({ ...connect, signal: connect.signal instanceof AbortSignal, headers: connect.headers() }, {
    url: 'https://api.example.com/mcp?tools=all',
    headers: { authorization: `Bearer ${SECRET}` },
    signal: true,
    limitMs: 30000,
    maxMessageBytes: 16 * 1024 * 1024,
    maxListBytes: 16 * 1024 * 1024,
    hidden: [SECRET],
  });
  const perform = (outcome) => {
    fake.client.callTool = async () => outcome;
    return mcp.perform(target, {}, {
      timeoutMs: 1000, maxBytes: 100, signal: new AbortController().signal, input: { tool: 'get_issue', arguments: { issue_key: 'A-1' } }, opened,
    });
  };
  assert.deepEqual(await perform({ result: { content: [{ type: 'text', text: 'remote' }] }, truncated: false }), {
    exitCode: 0, stdout: 'remote', stderr: '', truncated: false,
  });
  // The shapes only the HTTP transport gives: each a fixed text, never a body.
  for (const [outcome, stderr] of [
    [{ httpError: { status: 503, retryAfter: 30 } }, 'the MCP server answered HTTP 503, retry after 30 seconds'],
    [{ httpError: { status: 301, retryAfter: null } }, 'the MCP server answered HTTP 301'],
    [{ unreachable: true }, 'the MCP server could not be reached'],
    [{ cutOff: true }, 'the answer of the MCP server was cut off'],
    [{ rpcError: { code: -32602, message: 'ksproxy cannot send this call: a value of Mcp-Param-Key holds a newline' } }, 'ksproxy cannot send this call: a value of Mcp-Param-Key holds a newline'],
  ]) {
    assert.deepEqual(await perform(outcome), { exitCode: 1, stdout: '', stderr });
  }
  assert.equal(await mcp.probe(target, { opened }), 'up');
  fake.client.ping = async () => false;
  assert.equal(await mcp.probe(target, { opened }), 'down');
  assert.equal(mcp.downMessage(target, 'down', opened), 'the MCP server did not answer a ping');
  limits.pingEveryMs = 300000;
  fake.client.ping = async () => assert.fail('pinged within five minutes');
  assert.equal(await mcp.probe(target, { opened }), 'down');
  assert.deepEqual(mcp.doctor(opened), { ok: true, detail: '4 tools listed, 1 exported' });
  await mcp.close(opened);
  assert.deepEqual(fake.calls.at(-1), { closed: true });

  const basic = validated({
    url: 'https://api.example.com/mcp', login: 'basic', userEnv: 'JIRA_USER', tokenEnv: 'JIRA_TOKEN',
  });
  const other = fakeHttp({ closeFails: true });
  connectors.http = other.connect;
  const opened2 = (await openWith(basic, { secrets: { JIRA_USER: 'someone@example.com', JIRA_TOKEN: SECRET } })).opened;
  assert.deepEqual(other.calls[0].connect.headers(), { authorization: `Basic ${Buffer.from(`someone@example.com:${SECRET}`).toString('base64')}` });
  await mcp.close(opened2);
  const none = fakeHttp();
  connectors.http = none.connect;
  await openWith(validated({ url: 'https://api.example.com/mcp' }));
  assert.deepEqual(none.calls[0].connect.headers(), {});
});

test('url targets: a secret that cannot go in a header, a failed connect and a failed list skip the target, hidden', async () => {
  connectors.http = fakeHttp().connect;
  const target = validated({ url: 'https://api.example.com/mcp', login: 'token', tokenEnv: 'GH_TOKEN' });
  assert.deepEqual((await openWith(target, { secrets: { GH_TOKEN: 'a\r\nb' } })).result, {
    ok: false, error: 'GH_TOKEN holds a character that is not allowed',
  });
  connectors.http = fakeHttp({ connectFails: `refused by ${SECRET}` }).connect;
  const failed = await openWith(target, { secrets: { GH_TOKEN: SECRET } });
  assert.deepEqual(failed.result, { ok: false, error: 'the MCP server could not be reached; the reason is in the start terminal' });
  assert.deepEqual(failed.said, ['the MCP server failed: refused by [hidden]']);
  const listing = fakeHttp();
  listing.client.listTools = async () => {
    throw new Error('the MCP server refused tools/list: no');
  };
  connectors.http = listing.connect;
  const unlisted = await openWith(target, { secrets: { GH_TOKEN: SECRET } });
  assert.deepEqual(unlisted.result, { ok: false, error: 'the MCP server could not be reached; the reason is in the start terminal' });
  assert.deepEqual(unlisted.said, ['the MCP server failed: the MCP server refused tools/list: no']);
  assert.deepEqual(listing.calls.at(-1), { closed: true });
  // The real HTTP transport: a server that cannot be reached skips the target, the reason in the terminal.
  connectors.http = savedConnectors.http;
  limits.connectMs = 2000;
  const unreached = await openWith(validated({ url: 'http://127.0.0.1:9/mcp', login: 'token', tokenEnv: 'GH_TOKEN' }), { secrets: { GH_TOKEN: SECRET } });
  assert.deepEqual(unreached.result, { ok: false, error: 'the MCP server could not be reached; the reason is in the start terminal' });
  assert.deepEqual(unreached.said, ['the MCP server failed: the MCP server could not be reached for server/discover']);
});
