import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import rabbitmq from '../src/kinds/rabbitmq/index.js';
import { KINDS, kindByFlag, kindByKey, kindByTool } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import {
  auditOf, cli, closeServer, everythingOf, serviceWorld, startProvider, startService,
} from './http-service-helpers.js';
import {
  cleanupAll, launch, ready, stopWith,
} from './start-helpers.js';

const USER = 'mq-user-S3CR3T-19de-unmistakable';
const PASSWORD = 'mq-pw-S3CR3T-4b60-unmistakable';
const b64 = (text) => Buffer.from(text).toString('base64');
const SECRETS = [USER, PASSWORD, b64(USER), b64(PASSWORD), b64(`${USER}:${PASSWORD}`)];
const EXAMPLE = ['GET /api/overview', 'GET /api/queues/...', 'GET /api/exchanges/...', 'GET /api/nodes'];
const WIDE = ['* /...', '* /... +body', 'regex(.*)'];
const TOOL = 'rabbitmq_request';

let service;
let provider;
before(async () => {
  service = await startService();
  provider = await startProvider();
});
after(async () => {
  cleanupAll();
  await closeServer(service.server);
  await closeServer(provider.server);
});

const decideOf = (input, allow = WIDE) => rabbitmq.decide({ allow }, input);
const WRITES = ['PUT', 'POST', 'DELETE', 'PATCH'];
const ADMIN = ['users', 'permissions', 'topic-permissions', 'user-limits', 'vhost-limits', 'parameters', 'global-parameters', 'policies', 'operator-policies', 'vhosts', 'auth', 'reset'];

// Every fixed refusal as [method, path, body, short].
const REFUSALS = [
  ['GET', '/', undefined, 'not an api path'],
  ['GET', '/overview', undefined, 'not an api path'],
  ['GET', '/apix/overview', undefined, 'not an api path'],
  ['GET', '/metrics', undefined, 'not an api path'],
  ...ADMIN.flatMap((area) => WRITES.map((method) => [method, `/api/${area}/x`, undefined, 'admin write refused'])),
  ['PUT', '/api/us%65rs/x', undefined, 'admin write refused'],
  ['PUT', '/api/USERS/x', undefined, 'admin write refused'],
  ['PUT', '/api/vhosts', undefined, 'admin write refused'],
  ...['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'].map((method) => [method, '/api/definitions', undefined, 'definitions write refused']),
  ['POST', '/api/definitions/vh1', undefined, 'definitions write refused'],
  ['POST', '/api/queues/vh1/q1/get', { count: 1 }, 'queue get refused'],
  ['GET', '/api/queues/vh1/q1/get', undefined, 'queue get refused'],
  ['GET', '/api/queues/vh1/q1/GET', undefined, 'queue get refused'],
  ['DELETE', '/api/queues/vh1/q1/contents', undefined, 'queue purge refused'],
  ['DELETE', '/api/queues/vh1/q1/CONTENTS', undefined, 'queue purge refused'],
  ['POST', '/api/exchanges/vh1/ex1/publish', { payload: 'x' }, 'publish refused'],
  ['GET', '/api/exchanges/vh1/ex1/publish', undefined, 'publish refused'],
];

test('rabbitmq is a brokered kind after elasticsearch and meets the contract', () => {
  const keys = KINDS.map((kind) => kind.key);
  assert.ok(keys.indexOf('rabbitmq') === keys.indexOf('elasticsearch') + 1);
  assert.equal(kindByKey('rabbitmq'), rabbitmq);
  assert.equal(kindByFlag('mq'), rabbitmq);
  assert.equal(kindByTool(TOOL), rabbitmq);
  checkKind(rabbitmq, KINDS);
  assert.equal(rabbitmq.brokered, true);
  assert.equal(rabbitmq.label, 'mq');
  assert.equal(rabbitmq.tool.detailShape, 'object');
});

test('a rabbitmq entry is validated into a target, and every mistake is an inventory error that names the field', () => {
  const one = (extra = {}) => validateInventory({ rabbitmq: [{ name: 'm', url: 'https://mq.internal.example.com:15671', ...extra }] }).rabbitmq[0];
  assert.deepEqual(one({ userEnv: 'MQ_USER', passwordEnv: 'MQ_PASSWORD', allow: EXAMPLE, description: 'prod' }), {
    kind: 'rabbitmq',
    name: 'm',
    baseUrl: 'https://mq.internal.example.com:15671/',
    auth: { basicUserEnv: 'MQ_USER', basicPasswordEnv: 'MQ_PASSWORD' },
    description: 'prod',
    allow: EXAMPLE,
  });
  assert.equal(one().auth, null);
  assert.equal(one({ allow: 'any' }).allow, 'any');
  assert.deepEqual(one({ allow: ['regex(GET /api /queues /.*)', '* /api/...'] }).allow, ['regex(GET /api /queues /.*)', '* /api/...']);
  const fails = (extra, message) => assert.throws(() => one(extra), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  fails({ apiKeyEnv: 'K' }, 'rabbitmq "m": unknown key "apiKeyEnv"');
  fails({ baseUrl: 'https://x.example.com' }, 'rabbitmq "m": unknown key "baseUrl"');
  fails({ url: undefined }, 'rabbitmq "m": url: must be a URL');
  fails({ url: 'http://mq.example.com:15672' }, 'rabbitmq "m": url: must use https (http is accepted for localhost only)');
  fails({ url: 'https://mq.example.com/#x' }, 'rabbitmq "m": url: must not contain a user name, a password, a query or a fragment');
  fails({ userEnv: 'U' }, 'rabbitmq "m": userEnv and passwordEnv must be given together');
  fails({ passwordEnv: 'P' }, 'rabbitmq "m": userEnv and passwordEnv must be given together');
  fails({ userEnv: 'lower', passwordEnv: 'P' }, 'rabbitmq "m": userEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ userEnv: 'PATH', passwordEnv: 'P' }, 'rabbitmq "m": userEnv: PATH is a variable the session needs; name a variable that must hold only the user name');
  fails({ userEnv: 'U', passwordEnv: 'XDG_X' }, 'rabbitmq "m": passwordEnv: XDG_X is a variable the session needs; name a variable that must hold only the password');
  fails({ userEnv: 'U', passwordEnv: '' }, 'rabbitmq "m": passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  const rule = (i) => `rabbitmq "m": allow[${i}]: a rule is a method and a path, for example GET /api/queues, and may end in +body to allow a JSON body`;
  for (const bad of ['GET', 'get /api', 'GET api', 'GET /api extra', 'GET //api', 'GET /.../x', 'uptime']) fails({ allow: ['GET /api/ok', bad] }, rule(1));
  fails({ allow: ['regex()'] }, 'rabbitmq "m": allow[0]: regex pattern is empty');
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'rabbitmq "m": review.programs: is only for local targets');
});

test('every fixed refusal is refused whatever the rules say, with its own text', () => {
  for (const [method, requestPath, body, short] of REFUSALS) {
    const input = body === undefined ? { method, path: requestPath } : { method, path: requestPath, body };
    for (const allow of [WIDE, 'any', ['regex(.*)']]) {
      const decision = decideOf(input, allow);
      assert.equal(decision.allowed, false, `${method} ${requestPath}`);
      assert.equal(decision.short, short, `${method} ${requestPath}`);
      assert.equal(decision.unmatched, undefined, 'a fixed refusal is never sent to the reviewer');
      assert.equal(decision.argv, undefined);
    }
  }
  const reasonOf = (method, requestPath) => decideOf({ method, path: requestPath }).reason;
  const sentence = (what) => `${what} is refused for every rabbitmq target, whatever the rules say.`;
  assert.equal(reasonOf('GET', '/overview'), sentence('a path that does not start with /api'));
  assert.equal(reasonOf('PUT', '/api/users/x'), sentence('PUT on /api/users'));
  assert.equal(reasonOf('POST', '/api/vhosts'), sentence('POST on /api/vhosts'));
  assert.equal(reasonOf('HEAD', '/api/definitions'), sentence('HEAD on /api/definitions'));
  assert.equal(reasonOf('POST', '/api/queues/v/q/get'), sentence('taking messages off a queue'));
  assert.equal(reasonOf('DELETE', '/api/queues/v/q/contents'), sentence('purging a queue'));
  assert.equal(reasonOf('POST', '/api/exchanges/v/e/publish'), sentence('publishing a message'));
});

test('what is near a fixed refusal but is not one is decided by the rules', () => {
  const ok = (method, requestPath) => assert.equal(decideOf({ method, path: requestPath }).allowed, true, `${method} ${requestPath}`);
  ok('GET', '/api/overview');
  ok('GET', '/api');
  ok('GET', '/api/users');
  ok('HEAD', '/api/users');
  ok('GET', '/api/definitions');
  ok('GET', '/api/queues/vh1/q1');
  ok('DELETE', '/api/queues/vh1/q1');
  ok('GET', '/api/queues/vh1/q1/bindings');
  ok('GET', '/api/queues/vh1/q1/contents');
  ok('PUT', '/api/queues/vh1/q1');
  ok('DELETE', '/api/exchanges/vh1/ex1');
  ok('GET', '/api/exchanges/vh1/get');
  ok('GET', '/api/exchanges/vh1/contents');
  ok('POST', '/api/exchanges/vh1/ex1/bindings/x');
  ok('GET', '/api/nodes');
  assert.deepEqual(decideOf({ method: 'GET', path: '/api/../x' }), {
    allowed: false, reason: 'path may not contain a "." or ".." segment', short: 'dot segment',
  });
});

test('decide: one allowed read for each rule of the example, and the rest is refused', () => {
  const call = (method, requestPath) => decideOf({ method, path: requestPath, query: { columns: 'name' } }, EXAMPLE);
  assert.deepEqual(call('GET', '/api/overview'), { allowed: true, rule: 'GET /api/overview', argv: ['GET', '/api', '/overview', '?columns=name'] });
  assert.equal(call('GET', '/api/queues').rule, 'GET /api/queues/...');
  assert.equal(call('GET', '/api/queues/vh1/q1').rule, 'GET /api/queues/...');
  assert.equal(call('GET', '/api/exchanges/vh1').rule, 'GET /api/exchanges/...');
  assert.equal(call('GET', '/api/nodes').rule, 'GET /api/nodes');
  assert.equal(call('GET', '/api/connections').allowed, false);
  assert.deepEqual(decideOf({ method: 'GET', path: '/api/x', body: {} }, EXAMPLE).short, 'body not allowed');
  assert.equal(decideOf({ method: 'POST', path: '/api/queues/v/q', body: {} }, EXAMPLE).notReviewed, 'a request with a body is not sent to the reviewer, who cannot see the body');
});

test('the session pieces and the agent notes', () => {
  const make = (extra = {}) => ({
    kind: 'rabbitmq', name: 'm', baseUrl: 'https://mq.internal.example.com:15671/', auth: null, description: 'prod', allow: ['GET /api/overview'], ...extra,
  });
  const basic = { basicUserEnv: 'U', basicPasswordEnv: 'P' };
  assert.equal(rabbitmq.hint(make()), 'mq.internal.example.com:15671 - prod');
  assert.equal(rabbitmq.hint(make({ description: '' })), 'mq.internal.example.com:15671');
  assert.equal(rabbitmq.openingMessage(make()), 'https://mq.internal.example.com:15671/, no auth');
  assert.equal(rabbitmq.openingMessage(make({ auth: basic })), 'https://mq.internal.example.com:15671/, basic auth from U and P');
  assert.deepEqual(rabbitmq.secrets(make({ auth: basic })), { env: ['U', 'P'], files: [], users: ['U'] });
  assert.deepEqual(rabbitmq.open(make({ auth: basic }), { secrets: { U: 'a', P: 'b' } }), { ok: true, extras: {} });
  assert.deepEqual(rabbitmq.open(make({ auth: basic }), { secrets: { U: 'a', P: 'b\n' } }), { ok: false, error: 'P holds a character that is not allowed' });
  assert.equal(rabbitmq.record({ target: make({ auth: basic }) }, { reviewed: true }).review, true);
  assert.equal(rabbitmq.record({ target: make() }, { reviewed: false }).review, undefined);
  const notes = rabbitmq.agentSection(make({ review: true }));
  assert.match(notes, /^### RabbitMQ target `m` - prod\n\n- Tool: `rabbitmq_request` with `target: "m"`\. The user fixed the host/);
  assert.ok(notes.includes('- Allowed requests: GET /api/overview\n'));
  assert.ok(notes.includes('A rule is the method, then one word per path segment: `GET /api/queues` is `GET`, `/api`, `/queues`.'));
  assert.ok(notes.includes('The query is not checked against the rules.'));
  assert.ok(notes.includes('Only the management HTTP API is spoken: every path must start with `/api`.'));
  assert.ok(notes.includes('any method but GET or HEAD on users, permissions, topic-permissions, user-limits, vhost-limits, parameters, global-parameters, policies, operator-policies, vhosts, auth and reset, any method but GET on definitions, taking messages off a queue (a path under queues that ends in get), purging a queue (DELETE on a path under queues that ends in contents) and publishing (a path under exchanges that ends in publish)'));
  assert.ok(notes.includes('These are refused whatever the rules say, and a reviewer cannot allow them.'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  const any = rabbitmq.agentSection(make({ description: '', allow: 'any' }));
  assert.ok(any.startsWith('### RabbitMQ target `m`\n'));
  assert.ok(!any.includes('The query is not checked'));
  assert.equal(rabbitmq.toolBullet, '- `rabbitmq_request { target, method, path, query?, body?, timeout_seconds? }` - send one request to the management API of a RabbitMQ target.');
  assert.equal(rabbitmq.tool.definition.name, TOOL);
  const session = {
    targets: [{
      kind: 'rabbitmq', name: 'm', description: '', allow: ['GET /api/nodes'], baseUrl: 'https://x.example.com/', auth: null, state: 'up',
    }],
  };
  const text = agentMdText(session);
  assert.ok(text.includes(rabbitmq.toolBullet));
  assert.ok(text.includes('### RabbitMQ target `m`'));
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ rabbitmq: [] })).includes(TOOL));
  assert.ok(names(toolDefinitions({ rabbitmq: [{}] })).includes(TOOL));
});

test('ksproxy check rabbitmq runs the fixed refusals before the rules', async () => {
  const world = await serviceWorld('rabbitmq', {
    targets: [{ name: 'mq1', url: service.url, allow: ['* /...', 'GET /api/nodes'] }],
  });
  const check = (...words) => cli(['check', 'mq', 'mq1', ...words], world.env);
  assert.deepEqual(await check('GET', '/api/nodes'), { code: 0, stdout: 'ALLOWED by rule: * /...\n', stderr: '' });
  const publish = await check('POST', '/api/exchanges/v/e/publish', '+body');
  assert.equal(publish.code, 1);
  assert.equal(publish.stdout, 'REFUSED: publishing a message is refused for every rabbitmq target, whatever the rules say.\n');
  assert.equal((await check('GET', '/metrics')).stdout, 'REFUSED: a path that does not start with /api is refused for every rabbitmq target, whatever the rules say.\n');
  assert.equal((await check('DELETE', '/api/queues/v/q/contents')).stdout, 'REFUSED: purging a queue is refused for every rabbitmq target, whatever the rules say.\n');
  const usage = await cli(['--help'], {});
  assert.ok(usage.stdout.includes('[--mq a,b]'), usage.stdout);
});

test('a session: every fixed refusal stays away from the service, basic auth and none on the wire, no secret anywhere', async () => {
  const world = await serviceWorld('rabbitmq', {
    extraEnv: { MQ_TEST_USER: USER, MQ_TEST_PASSWORD: PASSWORD },
    reviewer: provider,
    targets: [
      {
        name: 'mq1', url: service.url, userEnv: 'MQ_TEST_USER', passwordEnv: 'MQ_TEST_PASSWORD', description: 'basic', allow: [...EXAMPLE, 'GET /api/echo-headers'],
      },
      { name: 'mq2', url: `${service.url}/`, allow: [...WIDE, 'GET /api/echo-headers'] },
      {
        name: 'mq3', url: service.url, allow: ['GET /api/overview'], review: { reviewer: 'r1', policy: 'read only' },
      },
    ],
  });
  const run = launch(world, { ssh: ['web1'], mq: ['mq1', 'mq2', 'mq3'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /mq +mq1 +OPENING +http:\/\/127\.0\.0\.1:\d+\/prefix\/, basic auth from MQ_TEST_USER and MQ_TEST_PASSWORD\n/);
  assert.match(run.proc.stderr.text, /mq +mq2 +UP\n/);
  const agentEnv = { ...world.env };
  for (const name of ['MQ_TEST_USER', 'MQ_TEST_PASSWORD']) delete agentEnv[name];
  const replies = [];
  const ask = async (args) => {
    const reply = await callTool(TOOL, args, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const { seen } = service;
  const start = seen.length;
  const overview = await ask({ target: 'mq1', method: 'GET', path: '/api/overview', query: { columns: 'QUERY-VALUE-8' } });
  assert.deepEqual(overview, {
    text: `exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n${JSON.stringify({ method: 'GET', url: '/prefix/api/overview?columns=QUERY-VALUE-8', body: '' })}`,
    isError: false,
  });
  assert.equal(seen.at(-1).headers.authorization, `Basic ${b64(`${USER}:${PASSWORD}`)}`);
  for (const requestPath of ['/api/queues', '/api/queues/vh1/q1', '/api/exchanges/vh1', '/api/nodes']) {
    const reply = await ask({ target: 'mq1', method: 'GET', path: requestPath });
    assert.equal(reply.isError, false, `${requestPath}: ${reply.text}`);
  }
  assert.equal(seen.length, start + 5);

  for (const [method, requestPath, body] of REFUSALS) {
    const reply = await ask({
      target: 'mq2', method, path: requestPath, ...(body === undefined ? {} : { body }),
    });
    assert.equal(reply.isError, true, `${method} ${requestPath}`);
    assert.match(reply.text, /^REFUSED \(rabbitmq mq2\): /);
  }
  assert.equal(seen.length, start + 5, 'no refused request reached the service');

  const echoed = await ask({ target: 'mq1', method: 'GET', path: '/api/echo-headers' });
  assert.equal(echoed.isError, false, echoed.text);
  assert.ok(echoed.text.includes('[hidden]'));
  const plain = await ask({ target: 'mq2', method: 'GET', path: '/api/echo-headers' });
  assert.equal(plain.isError, false, plain.text);
  assert.equal(seen.at(-1).headers.authorization, undefined);

  const before = seen.length;
  provider.asked.length = 0;
  const purge = await ask({ target: 'mq3', method: 'DELETE', path: '/api/queues/vh1/q1/contents' });
  assert.match(purge.text, /^REFUSED \(rabbitmq mq3\): purging a queue is refused for every rabbitmq target, whatever the rules say\.$/);
  const taken = await ask({ target: 'mq3', method: 'POST', path: '/api/queues/vh1/q1/get', body: { count: 1 } });
  assert.equal(taken.isError, true);
  assert.equal(provider.asked.length, 0, 'a fixed refusal is never sent to the reviewer');
  assert.equal(seen.length, before, 'a reviewer cannot get past a fixed refusal');
  const reviewed = await ask({ target: 'mq3', method: 'GET', path: '/api/nodes' });
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(provider.asked.length, 1);
  assert.equal(seen.length, before + 1);
  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.filter((t) => t.kind === 'rabbitmq').map((t) => [t.name, t.auth]), [
    ['mq1', { basicUserEnv: 'MQ_TEST_USER', basicPasswordEnv: 'MQ_TEST_PASSWORD' }],
    ['mq2', null],
    ['mq3', null],
  ]);
  assert.equal(await stopWith(run), 0);

  const calls = auditOf(world).filter((e) => e.event === 'call' && e.tool === TOOL);
  assert.equal(calls.length, 5 + REFUSALS.length + 2 + 3);
  assert.deepEqual(calls[0].request, {
    method: 'GET', path: '/api/overview', query: 'columns=QUERY-VALUE-8', body: false,
  });
  const refused = calls.filter((e) => e.decision === 'refused').map((e) => e.short);
  assert.deepEqual(refused.slice(0, REFUSALS.length), REFUSALS.map(([, , , short]) => short));
  assert.equal(calls.at(-1).rule, 'review');
  for (const text of everythingOf(world, run, replies)) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `a secret in: ${text.slice(0, 200)}`);
  }
});

test('a user name with a colon skips the target at open', async () => {
  const world = await serviceWorld('rabbitmq', {
    extraEnv: { MQ_TEST_USER: 'a:b', MQ_TEST_PASSWORD: 'x' },
    targets: [{ name: 'bad', url: service.url, userEnv: 'MQ_TEST_USER', passwordEnv: 'MQ_TEST_PASSWORD', allow: ['GET /api/nodes'] }],
  });
  const run = launch(world, { ssh: ['web1'], mq: ['bad'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /mq +bad +SKIPPED +MQ_TEST_USER holds a character that is not allowed\n/);
  assert.equal(await stopWith(run), 0);
});
