import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import rabbitmq from '../src/kinds/rabbitmq/index.js';
import elasticsearch from '../src/kinds/elasticsearch/index.js';
import httpKind from '../src/kinds/http/index.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool } from '../src/tools.js';
import {
  auditOf, cli, closeServer, serviceWorld, startProvider, startService,
} from './http-service-helpers.js';
import {
  cleanupAll, launch, ready, stopWith,
} from './start-helpers.js';

// The default virtual host of RabbitMQ, named "/", is the path segment %2F in the management API. Only the rabbitmq
// kind accepts it; the fixed refusals still see through it, and http and elasticsearch refuse it as before.

const TOOL = 'rabbitmq_request';
const WIDE = ['* /...', '* /... +body', 'regex(.*)'];
const VHOST_RULE = 'GET /api/queues/%2F/*';

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

// Every fixed refusal written with the default virtual host, as [method, path, body, short].
const VHOST_REFUSALS = [
  ['POST', '/api/queues/%2F/q/get', { count: 1, ackmode: 'ack_requeue_true', encoding: 'auto' }, 'queue get refused'],
  ['POST', '/api/queues/%2f/q/get', { count: 1 }, 'queue get refused'],
  ['GET', '/api/queues/%2F/q/get', undefined, 'queue get refused'],
  ['DELETE', '/api/queues/%2F/q/contents', undefined, 'queue purge refused'],
  ['DELETE', '/api/queues/%2f/q/CONTENTS', undefined, 'queue purge refused'],
  ['POST', '/api/exchanges/%2F/x/publish', { payload: 'x' }, 'publish refused'],
  ['POST', '/api/exchanges/%2F/amq.default/publish', { payload: 'x' }, 'publish refused'],
  ['PUT', '/api/users/x', { password: 'x' }, 'admin write refused'],
  ['DELETE', '/api/vhosts/%2F', undefined, 'admin write refused'],
  ['PUT', '/api/permissions/%2F/guest', { configure: '.*' }, 'admin write refused'],
  ['PUT', '/api/policies/%2F/p', { pattern: '.*' }, 'admin write refused'],
  ['POST', '/api/definitions/%2F', { queues: [] }, 'definitions write refused'],
  ['GET', '/%2F', undefined, 'not an api path'],
  ['GET', '/%2F/api/overview', undefined, 'not an api path'],
  ['GET', '/%2f/api', undefined, 'not an api path'],
];

const inputOf = (method, path, body) => (body === undefined ? { method, path } : { method, path, body });

test('the fixed refusals of rabbitmq see through a %2F segment, and are not set off by one', () => {
  for (const [method, path, body, short] of VHOST_REFUSALS) {
    for (const allow of [WIDE, 'any', ['regex(.*)'], [VHOST_RULE, '* /api/... +body']]) {
      const decision = rabbitmq.decide({ allow }, inputOf(method, path, body));
      assert.equal(decision.allowed, false, `${method} ${path}`);
      assert.equal(decision.short, short, `${method} ${path}`);
      assert.equal(decision.unmatched, undefined, 'a fixed refusal is never sent to the reviewer');
    }
  }
  const allowed = (method, path) => {
    const decision = rabbitmq.decide({ allow: WIDE }, { method, path });
    assert.equal(decision.allowed, true, `${method} ${path}: ${decision.reason}`);
    return decision;
  };
  assert.deepEqual(allowed('GET', '/api/queues/%2F').argv, ['GET', '/api', '/queues', '/%2F']);
  allowed('GET', '/api/queues/%2F/q');
  allowed('DELETE', '/api/queues/%2F/q');
  allowed('GET', '/api/queues/%2F/q/contents');
  allowed('GET', '/api/exchanges/%2F');
  allowed('GET', '/api/vhosts/%2F');
  allowed('GET', '/api/permissions/%2F/guest');
  allowed('GET', '/api/definitions/%2F');
  allowed('GET', '/api/%2F');
});

test('decide with the rule GET /api/queues/%2F/* allows the default virtual host and nothing else', () => {
  const decideOf = (path) => rabbitmq.decide({ allow: [VHOST_RULE] }, { method: 'GET', path });
  assert.deepEqual(decideOf('/api/queues/%2F/orders'), {
    allowed: true, rule: VHOST_RULE, argv: ['GET', '/api', '/queues', '/%2F', '/orders'],
  });
  assert.equal(decideOf('/api/queues/%2f/orders').rule, VHOST_RULE);
  assert.equal(decideOf('/api/queues/vh1/orders').allowed, false);
  assert.equal(decideOf('/api/queues/vh1/orders').unmatched, true);
  for (const path of ['/api/queues/a%2Fb/orders', '/api/queues/%2F%2F/orders', '/api/queues/%2Fetc/orders', '/api/queues/%5c/orders', '/api/queues/%2e/orders']) {
    assert.equal(decideOf(path).short, 'encoded separator', path);
  }
});

test('a rabbitmq rule may name %2F; an http or elasticsearch rule that names it is an inventory error, as is any rule they cannot match', () => {
  const mq = validateInventory({
    rabbitmq: [{ name: 'm', url: 'https://mq.internal.example.com:15671', allow: [VHOST_RULE, 'GET /api/exchanges/%2f/...', 'GET /%2F'] }],
  }).rabbitmq[0];
  assert.deepEqual(mq.allow, [VHOST_RULE, 'GET /api/exchanges/%2f/...', 'GET /%2F']);
  const fails = (inventory, message) => assert.throws(() => validateInventory(inventory), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  for (const rule of ['GET /%2F/_search', 'GET /%2f', 'DELETE /a/%2F/b']) {
    fails({ elasticsearch: [{ name: 'e', url: 'https://es.internal.example.com:9200', allow: ['GET /_cat/indices', rule] }] },
      'elasticsearch "e": allow[1]: a rule is a method and a path, for example GET /_cat/indices, and may end in +body to allow a JSON body');
    fails({ http: [{ name: 'h', baseUrl: 'https://grafana.example.com', allow: [rule] }] },
      'http "h": allow[0]: an http rule is a method and a path, for example GET /api/search, and may end in +body to allow a JSON body');
  }
  fails({ rabbitmq: [{ name: 'm', url: 'https://mq.internal.example.com:15671', allow: ['GET /api/queues/%2F/'] }] },
    'rabbitmq "m": allow[0]: a rule is a method and a path, for example GET /api/queues, and may end in +body to allow a JSON body');
});

test('elasticsearch and http refuse a %2F segment in the reader, as before', () => {
  for (const kind of [elasticsearch, httpKind]) {
    for (const allow of ['any', ['* /...', '* /... +body', 'regex(.*)']]) {
      for (const [method, path] of [['GET', '/%2F/_search'], ['DELETE', '/%2F'], ['GET', '/%2f/_search'], ['DELETE', '/%2f']]) {
        assert.deepEqual(kind.decide({ allow }, { method, path }), {
          allowed: false, reason: 'path may not encode "/", "\\", ".", ";", "%" or a control character', short: 'encoded separator',
        });
      }
    }
  }
});

test('the agent notes of rabbitmq say how the default virtual host is written, and elasticsearch says nothing of it', () => {
  const target = {
    kind: 'rabbitmq', name: 'm', baseUrl: 'https://mq.internal.example.com:15671/', auth: null, description: '', allow: ['GET /api/overview'],
  };
  const line = '- The default virtual host `/` is written as the one path segment `%2F`, for example `GET /api/queues/%2F/orders`; a rule names it as `%2F` too, and `*` and `...` match it. No other encoded slash is accepted.';
  assert.ok(rabbitmq.agentSection(target).includes(`\n${line}\n`));
  assert.ok(rabbitmq.agentSection({ ...target, allow: 'any' }).includes(`\n${line}\n`));
  assert.ok(!elasticsearch.agentSection({ ...target, kind: 'elasticsearch' }).includes('%2F'));
});

test('ksproxy check rabbitmq allows the default virtual host by its rule and keeps the fixed refusals', async () => {
  const world = await serviceWorld('rabbitmq', {
    targets: [{ name: 'mq1', url: service.url, allow: [VHOST_RULE, '* /api/... +body'] }],
  });
  const check = (...words) => cli(['check', 'mq', 'mq1', ...words], world.env);
  assert.deepEqual(await check('GET', '/api/queues/%2F/orders'), { code: 0, stdout: `ALLOWED by rule: ${VHOST_RULE}\n`, stderr: '' });
  assert.deepEqual(await check('GET', '/api/queues/%2f/orders'), { code: 0, stdout: `ALLOWED by rule: ${VHOST_RULE}\n`, stderr: '' });
  const other = await check('GET', '/api/queues/vh1/orders');
  assert.equal(other.code, 1);
  assert.match(other.stdout, /^REFUSED: not on the allowlist for this target/);
  const get = await check('POST', '/api/queues/%2F/q/get', '+body');
  assert.equal(get.stdout, 'REFUSED: taking messages off a queue is refused for every rabbitmq target, whatever the rules say.\n');
  assert.equal((await check('GET', '/api/queues/a%2Fb/orders')).stdout, 'REFUSED: path may not encode "/", "\\", ".", ";", "%" or a control character\n');
});

test('a session reads the default virtual host, the fixed refusals never reach the service, and the reviewer sees /%2F', async () => {
  const world = await serviceWorld('rabbitmq', {
    reviewer: provider,
    targets: [
      { name: 'mq1', url: service.url, allow: [VHOST_RULE] },
      { name: 'mq2', url: service.url, allow: WIDE },
      {
        name: 'mq3', url: service.url, allow: ['GET /api/overview'], review: { reviewer: 'r1', policy: 'read only' },
      },
    ],
  });
  const run = launch(world, { ssh: ['web1'], mq: ['mq1', 'mq2', 'mq3'] });
  await ready(run);
  const { seen } = service;
  const start = seen.length;

  const reply = await callTool(TOOL, {
    target: 'mq1', method: 'GET', path: '/api/queues/%2F/orders',
  }, world.env);
  assert.deepEqual(reply, {
    text: `exit code: 0\n--- stdout ---\nHTTP 200\ncontent-type: application/json\n\n${JSON.stringify({ method: 'GET', url: '/prefix/api/queues/%2F/orders', body: '' })}`,
    isError: false,
  });
  const lower = await callTool(TOOL, {
    target: 'mq1', method: 'GET', path: '/api/queues/%2f/orders',
  }, world.env);
  assert.equal(lower.isError, false, lower.text);
  assert.equal(seen.at(-1).url, '/prefix/api/queues/%2f/orders');
  const other = await callTool(TOOL, { target: 'mq1', method: 'GET', path: '/api/queues/vh1/orders' }, world.env);
  assert.match(other.text, /^REFUSED \(rabbitmq mq1\): not on the allowlist/);
  assert.equal(seen.length, start + 2);

  for (const [method, path, body] of VHOST_REFUSALS) {
    const refused = await callTool(TOOL, { target: 'mq2', ...inputOf(method, path, body) }, world.env);
    assert.equal(refused.isError, true, `${method} ${path}`);
    assert.match(refused.text, /^REFUSED \(rabbitmq mq2\): /);
  }
  assert.equal(seen.length, start + 2, 'no refused request reached the service');

  provider.asked.length = 0;
  const reviewed = await callTool(TOOL, { target: 'mq3', method: 'GET', path: '/api/exchanges/%2F' }, world.env);
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(provider.asked.length, 1);
  const question = JSON.parse(provider.asked[0].messages[1].content);
  assert.deepEqual(question.command, ['GET', '/api', '/exchanges', '/%2F']);
  assert.equal(seen.at(-1).url, '/prefix/api/exchanges/%2F');
  const purge = await callTool(TOOL, { target: 'mq3', method: 'DELETE', path: '/api/queues/%2F/q/contents' }, world.env);
  assert.match(purge.text, /^REFUSED \(rabbitmq mq3\): purging a queue is refused/);
  assert.equal(provider.asked.length, 1, 'a fixed refusal is never sent to the reviewer');
  assert.equal(seen.length, start + 3);
  assert.equal(await stopWith(run), 0);

  const calls = auditOf(world).filter((e) => e.event === 'call' && e.tool === TOOL);
  assert.deepEqual(calls[0].request, { method: 'GET', path: '/api/queues/%2F/orders', body: false });
  assert.equal(calls[0].rule, VHOST_RULE);
  assert.deepEqual(calls.filter((e) => e.decision === 'refused').slice(1, 1 + VHOST_REFUSALS.length).map((e) => e.short),
    VHOST_REFUSALS.map(([, , , short]) => short));
});
