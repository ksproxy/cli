import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { limits } from '../src/kinds/mcp/index.js';
import { startHttpStandIn } from './fixtures/mcp-server.js';
import { main } from '../src/cli.js';
import { clip } from '../src/text.js';
import { PROJECT_KEY, withProject } from '../src/paths.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, registerRun, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

const STAND_IN = fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url));
const SECRET = 'S3cr3t-mcp-start-value-0077';
const SECRET_VAR = 'MCP_TEST_TOKEN';
const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const saved = { ...limits };

after(() => cleanupAll());
afterEach(() => Object.assign(limits, saved));

const issueSchema = (extra = {}) => ({
  type: 'object', properties: { issue_key: { type: 'string' }, standIn: { type: 'object' }, ...extra }, required: ['issue_key'],
});
const TOOLS = [
  { name: 'get_issue', description: 'Get one issue', inputSchema: issueSchema() },
  { name: 'add_comment', description: 'Add a comment', inputSchema: issueSchema({ body: { type: 'string' } }) },
  { name: 'delete_issue', description: 'Delete an issue', inputSchema: issueSchema() },
];

const optionFiles = fs.realpathSync(tempDir('ks-mcp-start-options-'));
let optionCount = 0;
// The command of a stand-in with these options, given in a file of their own; its record file is returned too.
function standIn(options = {}) {
  optionCount += 1;
  const record = path.join(optionFiles, `${optionCount}.record`);
  const file = path.join(optionFiles, `${optionCount}.json`);
  fs.writeFileSync(file, JSON.stringify({ tools: TOOLS, record, ...options }));
  return { command: [process.execPath, STAND_IN, `@${file}`], record };
}

// The command of a stand-in as the OPENING line (max 120) and the picker (max 80) show it: the base name of the program,
// then its words, clipped. The temporary paths differ from one system to another, so the text is computed, not guessed.
const shownCommand = (server, max) => clip([path.basename(server.command[0]), ...server.command.slice(1)].join(' '), max);

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

async function mcpWorld(targets, extraEnv = {}) {
  const world = await makeWorld({ ssh: [], extraEnv: { NO_COLOR: '1', [SECRET_VAR]: SECRET, ...extraEnv } });
  const file = path.join(world.env[CONFIG_KEY], 'inventory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), mcp: targets }));
  return world;
}

const start = (world, host = {}) => launch(world, { all: true }, { limits: { followMs: 50 }, ...host });
const call = (world, target, tool, args) => callTool('mcp_call', { target, tool, ...(args === undefined ? {} : { arguments: args }) }, world.env);
const sessionFile = (world, name) => fs.readFileSync(path.join(world.sessionDir, name), 'utf8');

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [full] : [];
  });
}

test('a full call through start in each era: the tools exported, the call audited, a refused call never sent', async () => {
  const modern = standIn();
  const legacy = standIn({ era: 'legacy' });
  const world = await mcpWorld([mcpTarget('jm', modern), mcpTarget('jl', legacy, { allow: ['get_issue', 'missing'] })]);
  const run = start(world);
  await ready(run);
  const err = run.proc.stderr.text;
  const opening = err.split('\n').find((line) => /mcp +jm +OPENING /.test(line));
  assert.equal(opening.replace(/^.* OPENING +/, ''), `${shownCommand(modern, 120)}, 1 variable`);
  assert.match(err, /mcp +jm {25}3 tools listed, 2 exported\n.*mcp +jm +UP/s);
  assert.match(err, /mcp +jl +WARN +allow\[1\]: the MCP server does not list the tool missing\n/);

  assert.deepEqual(await call(world, 'jm', 'get_issue', { issue_key: 'SHOP-1' }), {
    text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"SHOP-1"}', isError: false,
  });
  assert.deepEqual(await call(world, 'jl', 'get_issue', { issue_key: 'HR-2' }), {
    text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"HR-2"}', isError: false,
  });
  const refusals = [
    ['delete_issue', { issue_key: 'SHOP-1' }, 'no rule allows delete_issue. Allowed: get_issue; add_comment {"issue_key":"regex(SHOP-[0-9]+)"}'],
    ['add_comment', { issue_key: 'HR-1', body: 'x' }, 'no rule allows add_comment with these arguments. Allowed: get_issue; add_comment {"issue_key":"regex(SHOP-[0-9]+)"}'],
  ];
  for (const [tool, args, reason] of refusals) {
    assert.deepEqual(await call(world, 'jm', tool, args), { text: `REFUSED (mcp jm): ${reason}`, isError: true });
  }
  assert.deepEqual(await call(world, 'jm', 'add_comment', { issue_key: 'SHOP-7', body: 'ok' }), {
    text: 'exit code: 0\n--- stdout ---\ncalled add_comment with {"issue_key":"SHOP-7","body":"ok"}', isError: false,
  });
  assert.deepEqual(await call(world, 'jm', 'get_issue', { issue_key: 'SHOP-1', other: 1 }), {
    text: 'exit code: 1\n--- stderr ---\nthe tool get_issue declares no argument "other"; the call was not sent', isError: true,
  });
  assert.deepEqual(await call(world, 'jm', 'get_issue', []), {
    text: 'REFUSED (mcp jm): arguments must be a JSON object', isError: true,
  });
  // No call that a rule refused, or that the schema refused, reached the server.
  assert.deepEqual(received(modern.record, 'tools/call').map((entry) => entry.got.params), [
    { name: 'get_issue', arguments: { issue_key: 'SHOP-1' }, _meta: received(modern.record, 'tools/list')[0].got.params._meta },
    { name: 'add_comment', arguments: { issue_key: 'SHOP-7', body: 'ok' }, _meta: received(modern.record, 'tools/list')[0].got.params._meta },
  ]);
  assert.deepEqual(received(legacy.record, 'tools/call').map((entry) => entry.got.params), [{ name: 'get_issue', arguments: { issue_key: 'HR-2' } }]);

  const tools = JSON.parse(sessionFile(world, 'mcp-tools.json'));
  const session = JSON.parse(sessionFile(world, 'session.json'));
  assert.equal(tools.pid, session.pid);
  assert.equal(tools.processStartedAt, session.processStartedAt);
  assert.deepEqual(tools.tools.map((t) => [t.target, t.tool, t.timeoutSeconds, t.definition.name]), [
    ['jm', 'get_issue', 60, 'jm__get_issue'], ['jm', 'add_comment', 60, 'jm__add_comment'], ['jl', 'get_issue', 60, 'jl__get_issue'],
  ]);
  assert.deepEqual(tools.tools[0].definition, { name: 'jm__get_issue', description: '[from the MCP server "jm"] Get one issue', inputSchema: issueSchema() });
  assert.deepEqual(session.targets.map((t) => [t.kind, t.name, t.tools, t.command[1]]), [['mcp', 'jm', ['get_issue', 'add_comment'], STAND_IN], ['mcp', 'jl', ['get_issue'], STAND_IN]]);
  const agent = sessionFile(world, 'AGENT.md');
  assert.ok(agent.includes('- `TARGET__TOOL` - the allowed tools of each MCP server'));
  assert.ok(agent.includes('### MCP server `jm` - jm server\n\n- Its allowed tools are in your tool list as `jm__TOOL`: `jm__get_issue`, `jm__add_comment`.'));
  assert.ok(!toolDefinitions(null).some((tool) => tool.name === 'mcp_call'));
  const listed = JSON.parse((await callTool('list_targets', {}, world.env)).text);
  assert.deepEqual(listed.targets.map((t) => [t.kind, t.name, t.state]), [['mcp', 'jm', 'up'], ['mcp', 'jl', 'up']]);

  await waitFor(() => /mcp +jm +DENIED .*delete_issue/.test(run.proc.stdout.text), 10000, 'the refused call in the log');
  assert.match(run.proc.stdout.text, /mcp +jm +ok +\S+ +get_issue \{"issue_key":"SHOP-1"\}\n/);
  const audit = fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === 'call');
  assert.deepEqual(audit[0].request, { tool: 'get_issue', arguments: { issue_key: 'SHOP-1' } });
  assert.deepEqual([audit[0].tool, audit[0].kind, audit[0].decision, audit[0].rule], ['mcp_call', 'mcp', 'allowed', 'get_issue']);
  assert.deepEqual(audit.filter((e) => e.decision === 'refused').map((e) => e.short), ['not on allowlist', 'not on allowlist', 'invalid arguments']);

  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  assert.deepEqual(fs.readdirSync(path.join(world.base, 'st', 'run')), [], 'the private folders are gone');
});

test('a remote server through start in each era: the token sent in a header only, and hidden in every answer', async () => {
  const modern = await startHttpStandIn({ tools: TOOLS });
  const legacy = await startHttpStandIn({ tools: TOOLS, era: 'legacy', sse: true });
  const remote = (name, server) => ({
    name, url: server.url, login: 'token', tokenEnv: SECRET_VAR, allow: ['get_issue'],
  });
  try {
    const world = await mcpWorld([remote('rm', modern), remote('rl', legacy)]);
    const run = start(world);
    await ready(run);
    assert.match(run.proc.stderr.text, /mcp +rm +OPENING +http:\/\/127\.0\.0\.1:\d+\/mcp, token from MCP_TEST_TOKEN\n/);
    assert.match(run.proc.stderr.text, /mcp +rl {25}3 tools listed, 1 exported\n/);
    for (const name of ['rm', 'rl']) {
      assert.deepEqual(await call(world, name, 'get_issue', { issue_key: 'SHOP-1' }), {
        text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"SHOP-1"}', isError: false,
      });
      assert.deepEqual(await call(world, name, 'delete_issue', { issue_key: 'SHOP-1' }), {
        text: `REFUSED (mcp ${name}): no rule allows delete_issue. Allowed: get_issue`, isError: true,
      });
      // The whole header value is hidden, the word Bearer with the token.
      assert.deepEqual(await call(world, name, 'get_issue', { issue_key: 'SHOP-1', standIn: { echoAuth: true } }), {
        text: 'exit code: 1\n--- stderr ---\nthe MCP server answered with an error: the credential [hidden] is refused', isError: true,
      });
      assert.deepEqual(await call(world, name, 'get_issue', { issue_key: 'SHOP-1', standIn: { status: 503, retryAfter: '7' } }), {
        text: 'exit code: 1\n--- stderr ---\nthe MCP server answered HTTP 503, retry after 7 seconds', isError: true,
      });
    }
    for (const server of [modern, legacy]) {
      const posts = server.requests().filter((request) => request.method === 'POST');
      assert.ok(posts.length > 0);
      for (const request of posts) assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
      const calls = posts.filter((request) => request.message?.method === 'tools/call').map((request) => request.message.params.name);
      assert.ok(!calls.includes('delete_issue'), 'a refused call never reaches the server');
    }
    assert.equal(legacy.requests().some((request) => request.headers['mcp-session-id'] === 'session-1'), true);

    run.proc.emit('SIGINT');
    assert.equal(await run.done, 0);
    assert.ok(legacy.requests().some((request) => request.method === 'DELETE'), 'the legacy session is ended at close');
    const shown = run.proc.stdout.text + run.proc.stderr.text;
    assert.ok(!shown.includes(SECRET), 'not in the terminal');
    assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes(SECRET), 'not in the log');
    for (const file of filesUnder(path.join(world.base, 'st'))) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), file);
  } finally {
    await modern.close();
    await legacy.close();
  }
});

test('a secret, its JSON form and the base64 of basic auth that cross a clip edge reach no answer and no description', async () => {
  // A quote and a backslash, so that JSON writes the secret otherwise.
  const quoted = 'Qu0t3d"mcp\\start-value-0123';
  const escaped = JSON.stringify(quoted).slice(1, -1);
  const user = 'someone@example.com';
  const basic = Buffer.from(`${user}:${quoted}`).toString('base64');
  const forms = [quoted, escaped, basic];
  const QUOTED_VAR = 'MCP_TEST_QUOTED';
  const USER_VAR = 'MCP_TEST_USER';
  // A clip keeps 999 characters and adds an ellipsis: `before` characters of a form fall before the cut.
  const pad = (before) => 'x'.repeat(999 - before);
  const link = (before, form) => ({ callAnswer: { result: { content: [{ type: 'resource_link', uri: `https://shop.example.com/?q=${pad(before).slice(28)}${form}` }] } } });
  const described = (form) => `${'d'.repeat(995)}${form} end`;
  const local = standIn({
    secretVar: 'TOKEN_OF_SERVER',
    tools: [
      { name: 'get_issue', description: described('@SECRET@'), inputSchema: issueSchema() },
      { name: 'add_comment', description: described('@SECRET_JSON@'), inputSchema: issueSchema({ body: { type: 'string' } }) },
    ],
  });
  const remote = await startHttpStandIn({ tools: [{ name: 'get_issue', description: described(basic), inputSchema: issueSchema() }] });
  try {
    const world = await mcpWorld([
      mcpTarget('loc', local, { env: { TOKEN_OF_SERVER: { fromEnv: QUOTED_VAR } } }),
      {
        name: 'rem', url: remote.url, login: 'basic', userEnv: USER_VAR, tokenEnv: QUOTED_VAR, allow: ['get_issue'],
      },
    ], { [QUOTED_VAR]: quoted, [USER_VAR]: user });
    const run = start(world);
    await ready(run);
    const answers = [];
    // The local server writes each form where the call asks, so the agent moves the cut along the secret.
    for (const placeholder of ['@SECRET@', '@SECRET_JSON@']) {
      for (const before of [4, 12]) {
        answers.push(await call(world, 'loc', 'get_issue', { issue_key: 'A-1', standIn: { rpcError: `${pad(before)}${placeholder} end` } }));
        answers.push(await call(world, 'loc', 'get_issue', { issue_key: 'A-1', standIn: link(before, placeholder) }));
      }
    }
    // The remote server, which the test steers itself, does the same with each of the three forms.
    for (const form of forms) {
      for (const before of [4, 12]) {
        remote.options.rpcError = `${pad(before)}${form} end`;
        answers.push(await call(world, 'rem', 'get_issue', { issue_key: 'A-1' }));
        delete remote.options.rpcError;
        Object.assign(remote.options, link(before, form));
        answers.push(await call(world, 'rem', 'get_issue', { issue_key: 'A-1' }));
        delete remote.options.callAnswer;
      }
    }
    assert.equal(answers.length, 20);
    for (const answer of answers) {
      for (const form of forms) assert.ok(!answer.text.includes(form.slice(0, 4)), answer.text.slice(-50));
      assert.ok(answer.text.includes('[hid'), answer.text.slice(-50));
    }
    const { tools } = JSON.parse(sessionFile(world, 'mcp-tools.json'));
    assert.deepEqual(tools.map((tool) => tool.definition.description), ['loc', 'loc', 'rem'].map((name) => `[from the MCP server "${name}"] ${'d'.repeat(995)}[hid…`));
    run.proc.emit('SIGINT');
    assert.equal(await run.done, 0);
    const shown = run.proc.stdout.text + run.proc.stderr.text;
    for (const form of forms) {
      assert.ok(!shown.includes(form.slice(0, 4)), 'not in the terminal');
      assert.ok(!fs.readFileSync(world.auditLog, 'utf8').includes(form.slice(0, 4)), 'not in the log');
    }
  } finally {
    await remote.close();
  }
});

test('the environment a server gets through start: no other variable of start reaches it', async () => {
  const server = standIn();
  const extraEnv = {
    XDG_CACHE_HOME: '/c/xdg', UV_CACHE_DIR: '/c/uv', npm_config_cache: '/c/npm', SOME_OTHER: 'never', GITHUB_TOKEN: 'never-either',
  };
  const world = await mcpWorld([mcpTarget('env', server, { env: { JIRA_URL: 'https://jira.example.com', JIRA_API_TOKEN: { fromEnv: SECRET_VAR } } })], extraEnv);
  const run = start(world);
  await ready(run);
  const [first] = fs.readFileSync(server.record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const system = ['__CF_USER_TEXT_ENCODING', 'NODE_V8_COVERAGE'];
  const env = Object.fromEntries(Object.entries(first.env).filter(([name]) => !system.includes(name)));
  const expected = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].filter((name) => world.env[name] !== undefined).map((name) => [name, world.env[name]]));
  assert.deepEqual(env, {
    ...expected, XDG_CACHE_HOME: '/c/xdg', UV_CACHE_DIR: '/c/uv', npm_config_cache: '/c/npm', JIRA_URL: 'https://jira.example.com', JIRA_API_TOKEN: SECRET,
  });
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('mcp-tools.json with 500 tools: at most 200 a target, the rule order, safe definitions and the warnings', async () => {
  const many = Array.from({ length: 500 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool ${i}\u202e with @SECRET@`,
    inputSchema: { type: 'object', properties: { key: { type: 'string', description: 'k\u0007' } } },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  }));
  const server = standIn({ tools: many, pageSize: 120, secretVar: 'TOKEN_OF_SERVER' });
  const allow = [...Array.from({ length: 260 }, (_, i) => `tool_${i}`), 'tool_9'];
  const world = await mcpWorld([mcpTarget('big', server, { allow })]);
  const run = start(world);
  await ready(run);
  const file = sessionFile(world, 'mcp-tools.json');
  const { tools } = JSON.parse(file);
  assert.equal(tools.length, 200);
  assert.equal(tools[0].definition.name, 'big__tool_0');
  assert.equal(tools[199].definition.name, 'big__tool_199');
  for (const { definition } of tools) {
    assert.deepEqual(Object.keys(definition), ['name', 'description', 'inputSchema']);
    assert.ok(/^\[from the MCP server "big"\] Tool \d+ with \[hidden\]$/.test(definition.description), definition.description);
    assert.equal(definition.inputSchema.properties.key.description, 'k');
  }
  assert.ok(!file.includes(SECRET));
  assert.match(run.proc.stderr.text, /mcp +big {24}500 tools listed, 200 exported\n/);
  assert.match(run.proc.stderr.text, /mcp +big +WARN +60 more tools that the rules name are not exported: a target exports at most 200\n/);
  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('a hostile server never stops start or another target, and its secret reaches no log, file, terminal or answer', async () => {
  limits.maxMessageBytes = 256 * 1024;
  const noisy = `${'noise '.repeat(2000)}\n@SECRET@\n`;
  const bad = standIn({
    secretVar: 'TOKEN_OF_SERVER', stderrText: noisy, stderrRepeat: 50, notify: true, pingClient: true, exitAt: 9, exitCode: 5,
  });
  const asking = standIn({ era: 'legacy', askInput: true });
  const good = standIn();
  const world = await mcpWorld([
    mcpTarget('bad', bad, { allow: ['get_issue', 'add_comment'] }),
    mcpTarget('ask', asking),
    mcpTarget('good', good),
  ]);
  const run = start(world);
  await ready(run);
  const fine = { text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"A-1"}', isError: false };
  // 4: a huge line; 5: an endless line; 6: a secret echoed; 7: a normal call through notifications and a ping.
  assert.deepEqual(await call(world, 'bad', 'get_issue', { issue_key: 'A-1', standIn: { bigAnswer: 300000 } }), {
    text: 'exit code: 1\n--- stderr ---\nthe answer of the MCP server was too large to read', isError: true,
  });
  assert.deepEqual(await call(world, 'bad', 'get_issue', { issue_key: 'A-1', standIn: { callLine: 'endless' } }), {
    text: 'exit code: 1\n--- stderr ---\nthe answer of the MCP server was too large to read', isError: true,
  });
  const echo = { callAnswer: { result: { content: [{ type: 'text', text: 'the token is @SECRET@' }], isError: false } } };
  assert.deepEqual(await call(world, 'bad', 'add_comment', { issue_key: 'A-1', standIn: echo }), {
    text: 'exit code: 0\n--- stdout ---\nthe token is [hidden]', isError: false,
  });
  assert.deepEqual(await call(world, 'good', 'get_issue', { issue_key: 'A-1' }), fine);
  assert.deepEqual(await call(world, 'bad', 'get_issue', { issue_key: 'A-1' }), {
    text: 'exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"A-1"}', isError: false,
  });
  // A server's request to the client is refused and the call goes on, in both eras.
  assert.deepEqual(await call(world, 'ask', 'get_issue', { issue_key: 'A-1' }), {
    text: 'exit code: 0\n--- stdout ---\nanswered after asking', isError: false,
  });
  // 8: one more call, then 9: the server exits during the call.
  await call(world, 'bad', 'get_issue', { issue_key: 'A-1' });
  assert.deepEqual(await call(world, 'bad', 'get_issue', { issue_key: 'A-1' }), {
    text: 'exit code: 1\n--- stderr ---\nthe MCP server stopped (exit 5)', isError: true,
  });
  await waitFor(() => /mcp +bad +DOWN +the MCP server stopped \(exit 5\)\n/.test(run.proc.stderr.text), 10000, 'the DOWN line');
  assert.match(run.proc.stderr.text, /mcp +bad {24}the MCP server stopped \(exit 5\); the target is down\n/);
  assert.match(run.proc.stderr.text, /mcp +bad {24}stderr: noise noise .*\n/);
  assert.match(run.proc.stderr.text, /stderr: \[hidden\]\n/);
  assert.deepEqual(await call(world, 'good', 'get_issue', { issue_key: 'A-1' }), fine);
  assert.deepEqual(await call(world, 'bad', 'get_issue', { issue_key: 'A-1' }), {
    text: 'exit code: 1\n--- stderr ---\nthe MCP server stopped (exit 5)', isError: true,
  });
  assert.ok(!run.proc.stderr.text.includes('CLOSING'));

  run.proc.emit('SIGINT');
  assert.equal(await run.done, 0);
  const shown = run.proc.stdout.text + run.proc.stderr.text;
  assert.ok(!shown.includes(SECRET), 'not in the terminal');
  const audit = fs.readFileSync(world.auditLog, 'utf8');
  assert.ok(!audit.includes(SECRET), 'not in the log');
  assert.ok(!audit.includes('noise noise'), 'stderr never reaches the log');
  for (const file of filesUnder(path.join(world.base, 'st'))) assert.ok(!fs.readFileSync(file, 'utf8').includes(SECRET), file);
});

test('several projects: the picker offers mcp targets, and each project reaches its own server', async () => {
  const world = await makeWorld({ ssh: [], extraEnv: { NO_COLOR: '1', [SECRET_VAR]: SECRET } });
  delete world.env[PROJECT_KEY];
  const servers = { shop: standIn(), ops: standIn() };
  const dir = path.join(world.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [project, server] of Object.entries(servers)) {
    fs.writeFileSync(path.join(dir, `${project}.json`), JSON.stringify({ mcp: [mcpTarget('jira', server, { description: project })] }));
  }
  const asked = [];
  const proc = fakeProcess({ stdin: { isTTY: true } });
  const run = { proc, done: main(['start', '--project', 'shop,ops'], world.env, { limits: { followMs: 50 }, process: proc, checkbox: async (request) => {
    asked.push([request.title, request.items.map((item) => `${item.label} ${item.hint}`)]);
    return [0];
  } }) };
  registerRun(run);
  await waitFor(() => ['shop', 'ops'].every((p) => proc.stdout.text.includes(`[${p}] Leave this running`)), 20000, 'both sessions');
  assert.deepEqual(asked.map(([title]) => title), ['[shop] Which mcp targets?', '[ops] Which mcp targets?']);
  assert.equal(asked[0][1][0], `jira ${shownCommand(servers.shop, 80)} - shop`);
  for (const project of ['shop', 'ops']) {
    const answer = await callTool('mcp_call', { target: 'jira', tool: 'get_issue', arguments: { issue_key: `${project}-1` } }, withProject(world.env, project));
    assert.equal(answer.text, `exit code: 0\n--- stdout ---\ncalled get_issue with {"issue_key":"${project}-1"}`);
    assert.deepEqual(received(servers[project].record, 'tools/call').map((entry) => entry.got.params.arguments.issue_key), [`${project}-1`]);
    const tools = JSON.parse(fs.readFileSync(path.join(world.base, 'st', 'p', project, 'session', 'mcp-tools.json'), 'utf8'));
    assert.deepEqual(tools.tools.map((t) => t.definition.name), ['jira__get_issue', 'jira__add_comment']);
  }
  proc.emit('SIGINT');
  assert.equal(await run.done, 0);
});

test('check: the kind word mcp, a tool and its arguments, from the rules alone', async () => {
  const server = standIn();
  const world = await mcpWorld([mcpTarget('jira', server, {
    allow: ['get_issue', { tool: 'add_comment', arguments: { issue_key: 'regex(SHOP-[0-9]+)', body: 'regex((a+)+)' } }],
    arguments: { cloudId: 'c1' },
  })]);
  const check = async (args) => {
    const proc = fakeProcess();
    const code = await main(['check', ...args], world.env, { process: proc });
    return { code, out: proc.stdout.text, err: proc.stderr.text };
  };
  const slow = 'WARNING: mcp "jira": allow[1].arguments.body: this pattern can be very slow on some inputs\n';
  assert.deepEqual(await check(['mcp', 'jira', 'get_issue']), { code: 0, out: 'ALLOWED by rule: get_issue\n', err: slow });
  assert.deepEqual(await check(['mcp', 'jira', 'add_comment', '{"issue_key":', '"SHOP-3",', '"body":', '"aa"}']), {
    code: 0, out: 'ALLOWED by rule: add_comment {"issue_key":"regex(SHOP-[0-9]+)","body":"regex((a+)+)"}\n', err: slow,
  });
  const refused = await check(['mcp', 'jira', 'delete_issue']);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^REFUSED: no rule allows delete_issue\. Allowed: /);
  assert.equal((await check(['mcp', 'jira', 'get_issue', 'not', 'json'])).out, 'REFUSED: arguments must be a JSON object\n');
  assert.equal((await check(['mcp', 'jira', 'get_issue', '{"cloudId":"c2"}'])).out, 'REFUSED: the argument cloudId is fixed to "c1" for this target; leave it out\n');
  assert.equal((await check(['mcp', 'nope', 'get_issue'])).err, 'unknown mcp target "nope"; known: jira\n');
  const usage = await check(['mcp', 'jira']);
  assert.equal(usage.code, 2);
  assert.ok(usage.err.startsWith('usage: ksproxy check [--project NAME] <ssh|kube|local|http|command|es|mq|redis|pg|mysql|mongo|kafka|mcp> <name> <command...>\n'));
  assert.equal(fs.existsSync(server.record), false, 'check starts no server');
});

test('doctor: a local server lists its tools and reports what is exported, never calling a tool', async () => {
  const server = standIn({ secretVar: 'TOKEN_OF_SERVER', stderrText: 'starting with @SECRET@\n' });
  const failing = standIn({ secretVar: 'TOKEN_OF_SERVER', stderrText: 'bad @SECRET@\n', exitAt: 1 });
  const world = await mcpWorld([mcpTarget('jira', server), mcpTarget('broken', failing)]);
  const proc = fakeProcess();
  const code = await main(['doctor', '--all'], world.env, { process: proc });
  const out = proc.stdout.text;
  assert.equal(code, 1, out);
  assert.match(out, /^\d\d:\d\d:\d\d mcp  jira {23}3 tools listed, 2 exported$/m);
  assert.match(out, /^\d\d:\d\d:\d\d mcp  jira +OK +3 tools listed, 2 exported; the credential is checked only by a call$/m);
  assert.match(out, /^\d\d:\d\d:\d\d mcp  broken {21}the MCP server failed: the MCP server stopped \(exit 3\)$/m);
  assert.match(out, /^\d\d:\d\d:\d\d mcp  broken {21}stderr: bad \[hidden\]$/m);
  assert.match(out, /^\d\d:\d\d:\d\d mcp  broken +FAIL +the MCP server failed; its last lines are in the start terminal$/m);
  assert.ok(!proc.stdout.text.includes(SECRET));
  assert.deepEqual(received(server.record, 'tools/call'), []);
});
