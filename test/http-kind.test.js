import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import httpKind from '../src/kinds/http/index.js';
import { KINDS, kindByKey } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { handleMessage } from '../src/mcp.js';
import { agentMdText } from '../src/agent-md.js';
import { formatLogLine } from '../src/audit.js';
import { main } from '../src/cli.js';
import { askCall } from '../src/broker.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

const TOKEN = 'grafana-S3CR3T-71c0e5-unmistakable';
const TOKEN_VAR = 'GRAFANA_TEST_TOKEN';
const USER = 'svc-S3CR3T-user';
const PASSWORD = 'pw-S3CR3T-0d9a-unmistakable';
const KEY = 'key-S3CR3T-55aa-unmistakable';
const SECRETS = [TOKEN, USER, PASSWORD, KEY, Buffer.from(`${USER}:${PASSWORD}`).toString('base64')];
const ALLOW = [
  'GET /api/search', 'GET /api/dashboards/uid/*', 'GET /api/folders/...', 'POST /api/ds/query +body', 'GET /\\*/_search',
  'regex(GET /api /v[12] /users)', 'GET /echo-headers', 'GET /missing', 'GET /redirect',
];

// The stand-in service on the loopback address, with a log of every request it got.
const seen = [];
let service;
let serviceUrl;

before(async () => {
  service = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method, url: req.url, headers: req.headers, body,
      });
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/prefix/echo-headers') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=COOKIE-VALUE' });
        res.end(JSON.stringify(req.headers));
      } else if (url.pathname === '/prefix/missing') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such thing');
      } else if (url.pathname === '/prefix/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.2:1/x' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, url: req.url, body }));
      }
    });
  });
  await new Promise((resolve) => { service.listen(0, '127.0.0.1', resolve); });
  serviceUrl = `http://127.0.0.1:${service.address().port}/prefix`;
});

const providers = [];
after(async () => {
  cleanupAll();
  for (const server of [service, ...providers]) {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
});

async function provider(verdict = 'allow') {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const content = JSON.stringify({ verdict, certainty: 'sure', reason: 'fine' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  providers.push(server);
  return { asked, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

async function httpWorld({ targets, extraEnv = {}, reviewer } = {}) {
  const world = await makeWorld({
    extraEnv: {
      [TOKEN_VAR]: TOKEN, HTTP_TEST_USER: USER, HTTP_TEST_PASSWORD: PASSWORD, HTTP_TEST_KEY: KEY, ...extraEnv,
    },
  });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.http = targets ?? [{
    name: 'g1', baseUrl: serviceUrl, auth: { bearerEnv: TOKEN_VAR }, description: 'grafana stand-in', allow: ALLOW,
  }];
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.inventoryFile = file;
  return world;
}

const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const httpCalls = (world) => auditOf(world).filter((e) => e.event === 'call' && e.tool === 'http_request');

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

test('http is a brokered kind after the three original kinds and meets the contract', () => {
  assert.deepEqual(KINDS.map((kind) => kind.key), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka']);
  assert.equal(kindByKey('http'), httpKind);
  checkKind(httpKind, KINDS);
  assert.equal(httpKind.brokered, true);
  assert.equal(httpKind.label, 'http');
  assert.equal(httpKind.tool.detailShape, 'object');
});

test('an http entry is validated into a target, and every mistake is an inventory error that names the field', () => {
  const { http: [target] } = validateInventory({
    http: [{
      name: 'g', baseUrl: 'https://grafana.example.com', auth: { bearerEnv: 'GRAFANA_TOKEN' }, allow: ['GET /api/search'],
    }],
  });
  assert.deepEqual(target, {
    kind: 'http', name: 'g', baseUrl: 'https://grafana.example.com/', auth: { bearerEnv: 'GRAFANA_TOKEN' }, description: '', allow: ['GET /api/search'],
  });
  const one = (entry) => validateInventory({ http: [{ name: 'g', baseUrl: 'https://h.example.com', ...entry }] }).http[0];
  assert.equal(one({}).auth, null);
  assert.deepEqual(one({}).allow, []);
  assert.equal(one({ allow: 'any' }).allow, 'any');
  assert.deepEqual(one({ auth: { basicPasswordEnv: 'P', basicUserEnv: 'U' } }).auth, { basicUserEnv: 'U', basicPasswordEnv: 'P' });
  assert.deepEqual(one({ auth: { headerEnv: 'K', headerName: 'X-Api-Key' } }).auth, { headerName: 'X-Api-Key', headerEnv: 'K' });
  assert.deepEqual(one({ allow: ['regex(GET /x /[a-z]+)', '* /...', 'POST /x +body'] }).allow, ['regex(GET /x /[a-z]+)', '* /...', 'POST /x +body']);
  const fails = (entry, message) => assert.throws(() => one(entry), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  fails({ headers: {} }, 'http "g": unknown key "headers"');
  fails({ baseUrl: undefined }, 'http "g": baseUrl: must be a URL');
  fails({ baseUrl: 'http://grafana.example.com' }, 'http "g": baseUrl: must use https (http is accepted for localhost only)');
  fails({ baseUrl: 'https://h.example.com/?x=1' }, 'http "g": baseUrl: must not contain a user name, a password, a query or a fragment');
  const forms = 'http "g": auth: must be {"bearerEnv": NAME}, {"basicUserEnv": NAME, "basicPasswordEnv": NAME} or {"headerName": HEADER, "headerEnv": NAME}';
  for (const auth of [null, 'TOKEN', [], {}, { tokenEnv: 'T' }, { bearerEnv: 'T', headerEnv: 'K' }, { basicUserEnv: 'U' }, { headerName: 'X' }]) {
    fails({ auth }, forms);
  }
  fails({ auth: { bearerEnv: 'PATH' } }, 'http "g": auth.bearerEnv: PATH is a variable the session needs; name a variable that must hold only the token');
  fails({ auth: { bearerEnv: 'lower' } }, 'http "g": auth.bearerEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ auth: { basicUserEnv: 'HOME', basicPasswordEnv: 'P' } }, 'http "g": auth.basicUserEnv: HOME is a variable the session needs; name a variable that must hold only the user name');
  fails({ auth: { basicUserEnv: 'U', basicPasswordEnv: 'SSH_X' } }, 'http "g": auth.basicPasswordEnv: SSH_X is a variable the session needs; name a variable that must hold only the password');
  fails({ auth: { headerName: 'X-Key', headerEnv: 'NODE_X' } }, 'http "g": auth.headerEnv: NODE_X is a variable the session needs; name a variable that must hold only the header value');
  for (const headerName of ['Authorization', 'cookie', 'Host', 'X Key', 5]) {
    fails({ auth: { headerName, headerEnv: 'K' } }, 'http "g": auth.headerName: must be letters, digits and "-", and not one of host, content-length, transfer-encoding, connection, cookie, authorization, accept, content-type');
  }
  const rule = (i) => `http "g": allow[${i}]: an http rule is a method and a path, for example GET /api/search, and may end in +body to allow a JSON body`;
  for (const bad of ['GET', 'get /x', 'GET x', 'GET /x extra', 'GET //x', 'GET /.../x', '...', 'uptime']) fails({ allow: ['GET /ok', bad] }, rule(1));
  let compileError = '';
  try {
    RegExp('GET (/x');
  } catch (err) {
    compileError = err.message;
  }
  fails({ allow: ['regex(GET (/x)'] }, `http "g": allow[0]: regex does not compile: ${compileError}`);
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'http "g": review.programs: is only for local targets');
});

test('decide: the rules, a body that needs +body, and a body that is never sent to the reviewer', () => {
  const target = { allow: ALLOW };
  const call = (input) => httpKind.decide(target, input);
  assert.deepEqual(call({ method: 'get', path: '/api/search', query: { query: 'cpu' } }), {
    allowed: true, rule: 'GET /api/search', argv: ['GET', '/api', '/search', '?query=cpu'],
  });
  assert.deepEqual(call({ method: 'GET', path: '/api/health', query: { a: 'x y' } }), {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`,
    short: 'not on allowlist',
    unmatched: true,
    argv: ['GET', '/api', '/health', '?a=x+y'],
  });
  assert.equal(call({ method: 'POST', path: '/api/ds/query', query: { _method: 'DELETE' }, body: {} }).short, 'method override refused');
  assert.equal(call({ method: 'GET', path: '/api/dashboards/uid/abc' }).rule, 'GET /api/dashboards/uid/*');
  assert.equal(call({ method: 'GET', path: '/api/folders' }).rule, 'GET /api/folders/...');
  assert.equal(call({ method: 'GET', path: '/api/folders/a/b' }).rule, 'GET /api/folders/...');
  assert.equal(call({ method: 'GET', path: '/*/_search' }).rule, 'GET /\\*/_search');
  assert.equal(call({ method: 'GET', path: '/logs/_search' }).allowed, false);
  assert.equal(call({ method: 'GET', path: '/api/v2/users' }).rule, 'regex(GET /api /v[12] /users)');
  assert.equal(call({ method: 'POST', path: '/api/ds/query', body: { q: 1 } }).rule, 'POST /api/ds/query +body');
  const noBody = call({ method: 'POST', path: '/api/ds/query' });
  assert.equal(noBody.allowed, false);
  assert.equal(noBody.short, 'not on allowlist');
  assert.equal(noBody.unmatched, true);
  assert.equal(noBody.notReviewed, undefined);
  const withBody = call({ method: 'POST', path: '/api/search', body: {} });
  assert.deepEqual(withBody, {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`,
    short: 'not on allowlist',
    unmatched: true,
    argv: ['POST', '/api', '/search', '+body'],
    notReviewed: 'a request with a body is not sent to the reviewer, who cannot see the body',
  });
  assert.deepEqual(call({ method: 'GET', path: '/a/../b' }), {
    allowed: false, reason: 'path may not contain a "." or ".." segment', short: 'dot segment',
  });
  assert.deepEqual(httpKind.decide({ allow: [] }, { method: 'GET', path: '/x' }).short, 'allowlist is empty');
  assert.deepEqual(httpKind.decide({ allow: 'any' }, { method: 'DELETE', path: '/x', body: {} }).rule, 'any');
});

test('the target in the menu, the opening line, the session record, the secrets and the notes', () => {
  const target = (auth, extra = {}) => ({
    kind: 'http', name: 'g', baseUrl: 'https://grafana.example.com:8443/base/', auth, description: 'dash', allow: ['GET /x'], ...extra,
  });
  assert.equal(httpKind.hint(target(null)), 'grafana.example.com:8443 - dash');
  assert.equal(httpKind.hint(target(null, { description: '' })), 'grafana.example.com:8443');
  assert.equal(httpKind.openingMessage(target(null)), 'https://grafana.example.com:8443/base/, no auth');
  assert.equal(httpKind.openingMessage(target({ bearerEnv: 'T' })), 'https://grafana.example.com:8443/base/, bearer token from T');
  assert.equal(httpKind.openingMessage(target({ basicUserEnv: 'U', basicPasswordEnv: 'P' })), 'https://grafana.example.com:8443/base/, basic auth from U and P');
  assert.equal(httpKind.openingMessage(target({ headerName: 'X-Key', headerEnv: 'K' })), 'https://grafana.example.com:8443/base/, header X-Key from K');
  assert.deepEqual(httpKind.secrets(target({ basicUserEnv: 'U', basicPasswordEnv: 'P' })), { env: ['U', 'P'], files: [], users: ['U'] });
  assert.deepEqual(httpKind.secrets(target(null)), { env: [], files: [] });
  assert.deepEqual(httpKind.open(target({ bearerEnv: 'T' }), { secrets: { T: 'ok' } }), { ok: true, extras: {} });
  assert.deepEqual(httpKind.open(target({ bearerEnv: 'T' }), { secrets: { T: 'a\r\nb' } }), { ok: false, error: 'T holds a character that is not allowed' });
  assert.deepEqual(httpKind.record({ target: target({ bearerEnv: 'T' }) }, { reviewed: true }), {
    kind: 'http', name: 'g', description: 'dash', allow: ['GET /x'], baseUrl: 'https://grafana.example.com:8443/base/', auth: { bearerEnv: 'T' }, state: 'up', review: true,
  });
  assert.equal(httpKind.record({ target: target(null) }, { reviewed: false }).review, undefined);
  assert.equal(httpKind.downMessage(), 'the call service is not answering');
  const notes = httpKind.agentSection({ ...target(null), review: true });
  assert.match(notes, /^### http target `g` - dash\n\n- Tool: `http_request` with `target: "g"`/);
  assert.ok(notes.includes('The query is not checked against the rules.'));
  assert.ok(notes.includes('You cannot set headers'));
  assert.ok(notes.includes('The query names `_method`, `x-http-method-override`, `x-method-override` and `x-http-method` are refused in any letter case. A reviewer and the log see the query.'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  const any = httpKind.agentSection({ ...target(null, { description: '' }), allow: 'any' });
  assert.ok(any.startsWith('### http target `g`\n'));
  assert.ok(!any.includes('The query is not checked'));
  assert.ok(!any.includes('reviewed before'));
  assert.ok(any.includes('The query names `_method`'));
  assert.ok(!notes.includes('grafana.example.com'), 'the host is not in the notes');
});

test('the audit keeps the method, the path and whether a body was sent, and the log line shows them', () => {
  const { auditedDetail, detailText } = httpKind.tool;
  assert.deepEqual(auditedDetail({ method: 'GET', path: '/x', query: { k: 'QUERY VALUE', n: 5, t: true } }), {
    method: 'GET', path: '/x', query: 'k=QUERY+VALUE&n=5&t=true', body: false,
  });
  assert.deepEqual(auditedDetail({ method: 'GET', path: '/x', query: { k: { deep: 1 }, l: null } }).query, 'k=%28invalid%29&l=%28invalid%29');
  assert.equal(auditedDetail({ method: 'GET', path: '/x', query: 'a=1' }).query, '(invalid)');
  assert.equal(auditedDetail({ method: 'GET', path: '/x', query: { k: 'v'.repeat(2000) } }).query.length, 1024);
  assert.deepEqual(auditedDetail({ method: 5, path: ['x'], body: { secret: 'BODY-VALUE' } }), { method: null, path: null, body: true });
  assert.equal(auditedDetail({ method: 'G'.repeat(40), path: `/${'p'.repeat(600)}` }).path.length, 512);
  assert.equal(detailText({ method: 'POST', path: '/q', body: true }), 'POST /q +body');
  assert.equal(detailText({
    method: 'POST', path: '/q', query: 'a=1&b=2', body: true,
  }), 'POST /q?a=1&b=2 +body');
  assert.equal(detailText({ method: 'GET', path: '/q', query: 5 }), 'GET /q');
  assert.equal(detailText({ method: 'GET', path: '/q', query: '' }), 'GET /q');
  assert.equal(auditedDetail({ method: 'GET', path: '/q', query: {} }).query, '');
  assert.equal(detailText({ method: 'GET', path: '/q', body: false }), 'GET /q');
  assert.equal(detailText({ method: null, path: '/q' }), '(invalid)');
  assert.equal(detailText({ method: 'GET' }), '(invalid)');
  const line = formatLogLine({
    ts: '2026-11-21T09:00:00.000Z', event: 'call', tool: 'http_request', kind: 'http', target: 'g1', request: { method: 'POST', path: '/api/ds/query', body: true }, decision: 'refused', short: 'not on allowlist',
  });
  assert.match(line, /http +g1 +DENIED +POST \/api\/ds\/query \+body {2}\[not on allowlist\]/);
  assert.match(formatLogLine({
    ts: '2026-11-21T09:00:00.000Z', event: 'call', tool: 'http_request', kind: 'http', target: 'g1', request: null, decision: 'refused', short: 'invalid arguments',
  }), /\(invalid\) {2}\[invalid arguments\]/);
  assert.match(formatLogLine({
    ts: '2026-11-21T09:00:00.000Z', event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'w', command: { x: 1 }, decision: 'refused', short: 's',
  }), /\(invalid\) {2}\[s\]/);
});

test('ksproxy check http takes the method, the path and +body as words', async () => {
  const world = await httpWorld();
  const check = (...words) => cli(['check', 'http', 'g1', ...words], world.env);
  assert.deepEqual(await check('GET', '/api/search'), { code: 0, stdout: 'ALLOWED by rule: GET /api/search\n', stderr: '' });
  assert.deepEqual(await check('POST', '/api/ds/query', '+body'), { code: 0, stdout: 'ALLOWED by rule: POST /api/ds/query +body\n', stderr: '' });
  assert.equal((await check('POST', '/api/ds/query')).stdout, `REFUSED: not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}\n`);
  assert.equal((await check('GET', '/x', 'more')).stdout, 'REFUSED: body must be a JSON object or array\n');
  assert.equal((await check('GET', '//evil')).stdout, 'REFUSED: path may not contain an empty segment: no "//" and no "/" at the end\n');
  assert.equal((await check('GET')).stdout, 'REFUSED: path must be a string\n');
  assert.deepEqual(httpKind.checkInput(['GET', '/x']), { method: 'GET', path: '/x' });
});

test('tools/list: the three original tools always, http_request only when the inventory holds an http target or cannot be read', async () => {
  const names = (tools) => tools.map((t) => t.name);
  const original = ['list_targets', 'ssh_exec', 'kubectl', 'local_exec'];
  assert.deepEqual(names(toolDefinitions()), original);
  assert.deepEqual(names(toolDefinitions({ ssh: [{}], http: [] })), original);
  assert.deepEqual(names(toolDefinitions({ http: [{}] })), [...original, 'http_request']);
  const all = [...original, 'http_request', 'command_exec', 'elasticsearch_request', 'rabbitmq_request', 'redis_command', 'postgres_query', 'mysql_query', 'mongodb_command', 'kafka_exec'];
  assert.deepEqual(names(toolDefinitions(null)), all);

  const world = await httpWorld();
  const list = async () => names((await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, world.env)).result.tools);
  assert.deepEqual(await list(), [...original, 'http_request']);
  const inventory = JSON.parse(fs.readFileSync(world.inventoryFile, 'utf8'));
  fs.writeFileSync(world.inventoryFile, JSON.stringify({ ...inventory, http: [] }));
  assert.deepEqual(await list(), original);
  fs.writeFileSync(world.inventoryFile, '{ not json');
  assert.deepEqual(await list(), all);
  fs.writeFileSync(world.inventoryFile, JSON.stringify({ http: [{ name: 'x' }] }));
  assert.deepEqual(await list(), all);
  fs.writeFileSync(world.inventoryFile, JSON.stringify(inventory));
  fs.chmodSync(world.inventoryFile, 0o000);
  try {
    assert.deepEqual(await list(), all);
  } finally {
    fs.chmodSync(world.inventoryFile, 0o600);
  }
  fs.rmSync(world.inventoryFile);
  assert.deepEqual(await list(), original);
});

test('AGENT.md lists the original tools, and http_request only when the session holds an http target', () => {
  const ssh = {
    kind: 'ssh', name: 'w', description: '', allow: ['uptime'], host: 'w', socket: '/s', state: 'up',
  };
  const web = {
    kind: 'http', name: 'g', description: '', allow: ['GET /x'], baseUrl: 'https://g.example.com/', auth: null, state: 'up',
  };
  const without = agentMdText({ targets: [ssh] });
  assert.ok(without.includes('`local_exec {'));
  assert.ok(!without.includes('http_request'));
  const withHttp = agentMdText({ targets: [ssh, web] });
  assert.ok(withHttp.includes('- `http_request { target, method, path, query?, body?, timeout_seconds? }` - send one HTTP request to an http target.\n'));
  assert.ok(withHttp.includes('### http target `g`'));
});

test('the usage lists the flags from the list of kinds, a brokered kind on a line of its own, wrapped', async (t) => {
  const help = await cli(['--help'], {});
  assert.ok(help.stdout.includes('  start [--ssh a,b] [--kube x,y] [--local a,b] [--all] [-v|--verbose]\n        [--http x,y] [--command a,b] [--es x,y] [--mq a,b] [--redis x,y]\n        [--pg a,b] [--mysql x,y] [--mongo a,b] [--kafka x,y] [--project NAME]\n                                            pick targets'), help.stdout);
  const extra = Array.from({ length: 6 }, (_, i) => ({ flag: `brokered-kind-${i}`, brokered: true }));
  KINDS.push(...extra);
  t.after(() => KINDS.splice(KINDS.length - extra.length, extra.length));
  const lines = (await cli(['--help'], {})).stdout.split('\n');
  const from = lines.findIndex((line) => line.startsWith('  start '));
  assert.deepEqual(lines.slice(from + 1, from + 6), [
    '        [--http x,y] [--command a,b] [--es x,y] [--mq a,b] [--redis x,y]',
    '        [--pg a,b] [--mysql x,y] [--mongo a,b] [--kafka x,y]',
    '        [--brokered-kind-0 a,b] [--brokered-kind-1 x,y]',
    '        [--brokered-kind-2 a,b] [--brokered-kind-3 x,y]',
    '        [--brokered-kind-4 a,b] [--brokered-kind-5 x,y] [--project NAME]',
  ]);
  assert.ok(lines.slice(from, from + 6).every((line) => line.length <= 78));
});

test('without a terminal and without a selection start names --http only when the inventory holds an http target', async () => {
  const world = await httpWorld();
  const run = launch(world, {});
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'no targets selected: use --ssh, --kube, --local, --http or --all when not running in a terminal\n');
});

test('a session with an http target: rules on the wire, refusals before the service, every audit once, no secret anywhere', async () => {
  const world = await httpWorld({
    targets: [
      {
        name: 'g1', baseUrl: serviceUrl, auth: { bearerEnv: TOKEN_VAR }, description: 'grafana stand-in', allow: ALLOW,
      },
      {
        name: 'g2', baseUrl: `${serviceUrl}/`, auth: { basicUserEnv: 'HTTP_TEST_USER', basicPasswordEnv: 'HTTP_TEST_PASSWORD' }, allow: ['GET /echo-headers'],
      },
      {
        name: 'g3', baseUrl: serviceUrl, auth: { headerName: 'X-Api-Key', headerEnv: 'HTTP_TEST_KEY' }, allow: ['GET /echo-headers'],
      },
    ],
  });
  const run = launch(world, { ssh: ['web1'], http: ['g1', 'g2', 'g3'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /http +g1 +OPENING +http:\/\/127\.0\.0\.1:\d+\/prefix\/, bearer token from GRAFANA_TEST_TOKEN\n/);
  assert.match(run.proc.stderr.text, /http +g3 +UP\n/);
  const agentEnv = { ...world.env };
  for (const name of [TOKEN_VAR, 'HTTP_TEST_USER', 'HTTP_TEST_PASSWORD', 'HTTP_TEST_KEY']) delete agentEnv[name];
  const replies = [];
  const ask = async (args) => {
    const reply = await callTool('http_request', args, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const before = seen.length;
  const search = await ask({ target: 'g1', method: 'GET', path: '/api/search', query: { query: 'QUERY-VALUE-9', limit: 5 } });
  assert.deepEqual(search, {
    text: `exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n${JSON.stringify({ method: 'GET', url: '/prefix/api/search?query=QUERY-VALUE-9&limit=5', body: '' })}`,
    isError: false,
  });
  assert.equal(seen.at(-1).headers.authorization, `Bearer ${TOKEN}`);
  const post = await ask({ target: 'g1', method: 'POST', path: '/api/ds/query', body: { queries: [{ expr: 'BODY-VALUE-3' }] } });
  assert.equal(post.isError, false, post.text);
  assert.equal(seen.at(-1).body, '{"queries":[{"expr":"BODY-VALUE-3"}]}');
  assert.equal(seen.length, before + 2);

  const hostile = [
    ['//127.0.0.2/x', 'empty segment'], ['/api/../admin', 'dot segment'], ['/api/%2e%2e/admin', 'encoded separator'],
    ['http://127.0.0.2/x', 'path not absolute'], ['/api/search?x=1', 'query in path'], ['/api\\x', 'backslash in path'],
    ['/a@127.0.0.2', 'at sign in path'], ['/a%2fb', 'encoded separator'], ['/a b', 'space or control character'],
  ];
  for (const [badPath] of hostile) {
    const reply = await ask({ target: 'g1', method: 'GET', path: badPath });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /^REFUSED \(http g1\): /);
  }
  const extra = [
    [{ method: 'GET', path: '/api/search', headers: { host: 'evil' } }, 'unknown field'],
    [{ method: 'POST', path: '/api/search', body: {} }, 'not on allowlist'],
    [{ method: 'POST', path: '/api/ds/query' }, 'not on allowlist'],
    [{ method: 'TRACE', path: '/api/search' }, 'method not allowed'],
    [{ method: 'GET', path: '/api/admin' }, 'not on allowlist'],
  ];
  for (const [args] of extra) assert.equal((await ask({ target: 'g1', ...args })).isError, true);
  assert.equal(seen.length, before + 2, 'no refused request reached the service');

  const missing = await ask({ target: 'g1', method: 'GET', path: '/missing' });
  // The token starts with g: a last character that could be the start of a cut secret is dropped, whatever ended the text.
  assert.deepEqual(missing, { text: 'exit code: 1\n--- stdout ---\nHTTP 404\ncontent-type: text/plain\n\nno such thin', isError: true });
  const moved = await ask({ target: 'g1', method: 'GET', path: '/redirect' });
  assert.equal(moved.text, 'exit code: 1\n--- stdout ---\nHTTP 302\ncontent-type: (none)\n--- stderr ---\nthe service answered with a redirect, which is not followed');
  for (const name of ['g1', 'g2', 'g3']) {
    const echoed = await ask({ target: name, method: 'GET', path: '/echo-headers' });
    assert.equal(echoed.isError, false, echoed.text);
    assert.ok(echoed.text.includes('[hidden]'), echoed.text);
    assert.ok(!echoed.text.includes('COOKIE-VALUE'));
  }
  assert.equal(seen.at(-3).headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.at(-2).headers.authorization, `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`);
  assert.equal(seen.at(-1).headers['x-api-key'], KEY);
  assert.equal(seen.at(-1).headers.authorization, undefined);

  assert.equal((await ask({ target: 'g1', method: 'GET', path: '/x', timeout_seconds: 0 })).text, 'invalid arguments: timeout_seconds must be an integer from 1 to 600');
  assert.equal((await ask({ target: 'nope', method: 'GET', path: '/x' })).text, 'unknown http target "nope". Open targets: g1, g2, g3');
  const direct = await askCall(path.join(world.socketDir, 'call-sock'), {
    kind: 'http', name: 'g1', input: 'GET /api/search', timeoutSeconds: 5,
  }, 10000, 'http');
  assert.deepEqual(direct, { text: 'invalid arguments: the request must be an object', isError: true });
  await waitFor(() => /http +nope +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.map((t) => [t.kind, t.name, t.auth ?? null]), [
    ['ssh', 'web1', null],
    ['http', 'g1', { bearerEnv: TOKEN_VAR }],
    ['http', 'g2', { basicUserEnv: 'HTTP_TEST_USER', basicPasswordEnv: 'HTTP_TEST_PASSWORD' }],
    ['http', 'g3', { headerName: 'X-Api-Key', headerEnv: 'HTTP_TEST_KEY' }],
  ]);
  const notes = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(notes.includes('`http_request {'));
  assert.equal(await stopWith(run), 0);

  const calls = httpCalls(world);
  assert.equal(calls.length, 2 + hostile.length + extra.length + 2 + 3 + 3);
  const shorts = calls.filter((e) => e.decision === 'refused').map((e) => e.short);
  assert.deepEqual(shorts, [...hostile.map(([, short]) => short), ...extra.map(([, short]) => short), 'invalid arguments', 'unknown target', 'invalid arguments']);
  assert.deepEqual(calls[0].request, {
    method: 'GET', path: '/api/search', query: 'query=QUERY-VALUE-9&limit=5', body: false,
  });
  assert.deepEqual(calls[1].request, { method: 'POST', path: '/api/ds/query', body: true });
  assert.equal(calls.at(-1).request, null);
  assert.match(run.proc.stdout.text, /http +g1 +ok .*GET \/api\/search\?query=QUERY-VALUE-9&limit=5\n/);
  assert.match(run.proc.stdout.text, /http +g1 +ok .*POST \/api\/ds\/query \+body/);

  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `a secret in: ${text.slice(0, 200)}`);
  }
  const audit = fs.readFileSync(world.auditLog, 'utf8');
  for (const value of ['BODY-VALUE-3', 'evil']) assert.ok(!audit.includes(value), value);
});

test('a secret that could split a header skips the target at open, and an unlisted request goes to the reviewer', async () => {
  const reviewer = await provider();
  const world = await httpWorld({
    extraEnv: { HTTP_TEST_BAD: 'line one\r\nX-Injected: 1' },
    reviewer,
    targets: [
      { name: 'bad', baseUrl: serviceUrl, auth: { bearerEnv: 'HTTP_TEST_BAD' }, allow: ['GET /x'] },
      {
        name: 'rev', baseUrl: serviceUrl, allow: ['GET /api/search'], review: { reviewer: 'r1', policy: 'read only' },
      },
    ],
  });
  const run = launch(world, { http: ['bad', 'rev'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /http +bad +SKIPPED +HTTP_TEST_BAD holds a character that is not allowed\n/);
  assert.match(run.proc.stderr.text, /http +rev +REVIEW +reviewer r1, accepts sure/);
  const before = seen.length;
  const reviewed = await callTool('http_request', { target: 'rev', method: 'GET', path: '/api/health' }, world.env);
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewer.asked.length, 1);
  assert.deepEqual(JSON.parse(reviewer.asked[0].messages[1].content).command, ['GET', '/api', '/health']);
  assert.equal(seen.at(-1).url, '/prefix/api/health');
  assert.equal(seen.at(-1).headers.authorization, undefined);
  const withBody = await callTool('http_request', {
    target: 'rev', method: 'POST', path: '/api/health', body: { a: 1 },
  }, world.env);
  assert.equal(withBody.text, 'REFUSED (http rev): not on the allowlist for this target. Allowed: GET /api/search. It was not sent to the reviewer: a request with a body is not sent to the reviewer, who cannot see the body.');
  assert.equal(reviewer.asked.length, 1);
  assert.equal(seen.length, before + 1);
  const withQuery = await callTool('http_request', {
    target: 'rev', method: 'GET', path: '/api/health', query: { verbose: 'yes please' },
  }, world.env);
  assert.equal(withQuery.isError, false, withQuery.text);
  assert.equal(reviewer.asked.length, 2, 'an approval without a query does not cover a call with one');
  assert.deepEqual(JSON.parse(reviewer.asked[1].messages[1].content).command, ['GET', '/api', '/health', '?verbose=yes+please']);
  assert.equal(seen.at(-1).url, '/prefix/api/health?verbose=yes+please');
  assert.equal(await stopWith(run), 0);
  const [entry, queried] = httpCalls(world).filter((e) => e.rule === 'review');
  assert.deepEqual(entry.request, { method: 'GET', path: '/api/health', body: false });
  assert.deepEqual(queried.request, {
    method: 'GET', path: '/api/health', query: 'verbose=yes+please', body: false,
  });
});
