// The rabbitmq examples of docs/EXAMPLES.md against the management API of RabbitMQ 3.10.5 over https. The broker loads
// its users, the queue orders, the exchange orders and their binding from the definitions of the run, and start.sh
// publishes three messages to orders. The access log of the API shows which requests reached it, with the user of
// each; the seed's own publish requests come from the user e2e-seed.
import {
  bodyOf, clip, logChecks, waitFor,
} from './lib.js';

const ACCESS_LOG = '/mqlog';
const SEEDED = 3;
// The user of each target, as e2e/setup/secrets.sh names them.
const users = { 'mq-prod': 'e2e-mq-reader', 'mq-ops': 'e2e-mq-ops' };

// A request in the access log: a line with the user of the target and the request line.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const call = (user, method, path) => ({
  name: `${method} ${path}`,
  marker: new RegExp(`^\\S+ - ${escape(user)} \\[[^\\]]*\\] "${method} ${escape(path)} HTTP/1\\.1"`, 'm'),
});

export async function rabbitmqScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const send = (target, method, path, body) => agent.call('rabbitmq_request', {
    target, method, path, ...(body === undefined ? {} : { body }),
  });
  const allowed = async (target, method, path, { body, expect = () => true, name = `allowed: ${method} ${path}` } = {}) => {
    const answer = await send(target, method, path, body);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(bodyOf(answer.text), answer.text), clip(answer.text));
    reached.push(call(users[target], method, path));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, method, path, body, why, reason) => {
    const answer = await send(target, method, path, body);
    checks.check(`refused: ${method} ${path} (${why})`, answer.isError
      && answer.text.startsWith(`REFUSED (rabbitmq ${target}): ${reason}`), clip(answer.text));
    kept.push(call(users[target], method, path));
  };
  // The number of messages in orders. The API counts them every few seconds, so a new broker may not show it yet.
  const messages = async (target) => {
    const read = async () => bodyOf((await send(target, 'GET', '/api/queues/%2F/orders')).text)?.messages;
    return waitFor(async () => {
      const n = await read();
      return n === undefined ? null : { n };
    }, { ms: 20000, everyMs: 1000, what: 'the message count of orders' }).then((found) => found.n, () => undefined);
  };

  checks.begin('rabbitmq: mq-prod, read only (e2e-mq-reader, tag monitoring)');
  await allowed('mq-prod', 'GET', '/api/overview', { expect: (body) => body?.rabbitmq_version === '3.10.5' });
  await allowed('mq-prod', 'GET', '/api/nodes', { expect: (body) => body?.[0]?.name === 'rabbit@mq' });
  const before = await messages('mq-prod');
  checks.check(`allowed: GET /api/queues/%2F/orders, with the ${SEEDED} seeded messages`, before === SEEDED, `messages: ${before}`);
  reached.push(call(users['mq-prod'], 'GET', '/api/queues/%2F/orders'));
  await allowed('mq-prod', 'GET', '/api/exchanges/%2F/orders', { expect: (body) => body?.name === 'orders' && body?.type === 'direct' });
  await refused('mq-prod', 'DELETE', '/api/queues/%2F/orders/contents', undefined, 'purging a queue is never allowed',
    'purging a queue is refused for every rabbitmq target');

  checks.begin('rabbitmq: mq-ops, may set up orders-retry (e2e-mq-ops, tag management)');
  await allowed('mq-ops', 'GET', '/api/overview', { expect: (body) => typeof body?.cluster_name === 'string' });
  await allowed('mq-ops', 'PUT', '/api/queues/%2F/orders-retry', {
    body: { durable: true, auto_delete: false, arguments: { 'x-message-ttl': 30000 } },
    expect: (body, text) => text.includes('--- stdout ---\nHTTP 201'),
  });
  await allowed('mq-ops', 'POST', '/api/bindings/%2F/e/orders/q/orders-retry', {
    body: { routing_key: 'orders.retry', arguments: {} },
    expect: (body, text) => text.includes('--- stdout ---\nHTTP 201'),
  });
  await allowed('mq-ops', 'GET', '/api/queues/%2F/orders-retry', {
    expect: (body) => body?.name === 'orders-retry' && body?.arguments?.['x-message-ttl'] === 30000,
    name: 'the queue orders-retry exists, with its message TTL',
  });
  await allowed('mq-ops', 'GET', '/api/queues/%2F/orders-retry/bindings', {
    expect: (body) => Array.isArray(body) && body.some((b) => b.source === 'orders' && b.routing_key === 'orders.retry'),
    name: 'orders-retry is bound to the exchange orders',
  });
  await refused('mq-ops', 'POST', '/api/exchanges/%2F/orders/publish', {
    properties: {}, routing_key: 'orders', payload: '{"order": 99}', payload_encoding: 'string',
  }, 'publishing a message is never allowed', 'publishing a message is refused for every rabbitmq target');
  const after = await messages('mq-ops');
  checks.check(`the refused purge and publish changed nothing: orders still holds ${SEEDED} messages`, after === SEEDED, `messages: ${after}`);
  reached.push(call(users['mq-ops'], 'GET', '/api/queues/%2F/orders'));

  checks.begin('rabbitmq: the access log of the management API');
  await logChecks(checks, {
    file: ACCESS_LOG, reached, kept, noun: 'request',
  });
}
