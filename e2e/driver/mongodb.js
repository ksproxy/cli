// The mongodb examples of docs/EXAMPLES.md against MongoDB 7, with mongosh 2 copied from the mongo image. The seed is
// in e2e/images/mongo/seed.js; the expected documents are computed here the same way. The server logs every operation
// (slowms -1), so its log shows which commands reached it: a command is found there by its first fields, in the
// compact JSON of the log.
import { clip, logChecks, stdoutOf } from './lib.js';

const SERVER_LOG = '/mongolog/mongod.log';
const STATUSES = ['open', 'paid', 'shipped', 'cancelled'];

// The seeded orders, as seed.js makes them.
function seeded() {
  const orders = [];
  for (let n = 1; n <= 60; n += 1) {
    orders.push({ _id: n, status: n === 42 ? 'open' : STATUSES[n % 4] });
  }
  return orders;
}

// The reply that mongosh printed, parsed, or undefined.
function replyOf(text) {
  try {
    return JSON.parse(stdoutOf(text));
  } catch {
    return undefined;
  }
}

// A command in the server log: its first fields as compact JSON, without the closing brace.
const call = (document, fields = 1) => ({
  name: JSON.stringify(document),
  marker: JSON.stringify(Object.fromEntries(Object.entries(document).slice(0, fields))).slice(0, -1),
});

export async function mongodbScenario({ checks, agent }) {
  const orders = seeded();
  const reached = [];
  const kept = [];
  const run = (target, command) => agent.call('mongodb_command', { target, command });
  const allowed = async (target, command, expect, { name = `allowed: ${JSON.stringify(command)}`, fields = 1 } = {}) => {
    const answer = await run(target, command);
    const reply = replyOf(answer.text);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && reply?.ok === 1 && expect(reply), clip(answer.text));
    reached.push(call(command, fields));
    return reply;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, command, why, reason) => {
    const answer = await run(target, command);
    checks.check(`refused: ${JSON.stringify(command)} (${why})`, answer.isError
      && answer.text.startsWith(`REFUSED (mongodb ${target}): ${reason}`), clip(answer.text));
    kept.push(call(command));
  };
  const ids = (reply) => reply?.cursor?.firstBatch?.map((doc) => doc._id) ?? [];
  const count = (status) => orders.filter((order) => order.status === status).length;

  checks.begin('mongodb: orders-db, read only (agent_ro)');
  const open = orders.filter((order) => order.status === 'open').map((order) => order._id);
  await allowed('orders-db', { find: 'orders', filter: { status: 'open' }, limit: 10 }, (reply) => JSON.stringify(ids(reply)) === JSON.stringify(open.slice(0, 10)), { fields: 2 });
  await allowed('orders-db', { count: 'orders', query: { status: 'open' } }, (reply) => reply.n === open.length, { fields: 2 });
  await allowed('orders-db', { aggregate: 'orders', pipeline: [{ $group: { _id: '$status', n: { $sum: 1 } } }], cursor: {} }, (reply) => {
    const got = Object.fromEntries((reply.cursor?.firstBatch ?? []).map((group) => [group._id, group.n]));
    return STATUSES.every((status) => got[status] === count(status));
  }, { fields: 2 });
  await allowed('orders-db', { listCollections: 1, nameOnly: true }, (reply) => {
    const names = (reply.cursor?.firstBatch ?? []).map((collection) => collection.name);
    return ['orders', 'customers', 'order_notes'].every((name) => names.includes(name));
  }, { fields: 2 });
  await refused('orders-db', { find: 'customers' }, 'no rule names customers', 'not on the allowlist');
  await refused('orders-db', { insert: 'orders', documents: [{ _id: 999, status: 'open' }] }, 'writes is off',
    'the command insert is not a read command, and this target does not allow writes');

  checks.begin('mongodb: orders-rw, may update orders and add notes (agent_rw)');
  await allowed('orders-rw', { insert: 'order_notes', documents: [{ order: 42, note: 'refund sent' }] }, (reply) => reply.n === 1);
  await allowed('orders-rw', { update: 'orders', updates: [{ q: { _id: 42 }, u: { $set: { status: 'refunded' } } }] }, (reply) => reply.n === 1 && reply.nModified === 1);
  await allowed('orders-rw', { find: 'orders', filter: { _id: 42 } }, (reply) => reply.cursor?.firstBatch?.[0]?.status === 'refunded', {
    name: 'the update changed order 42 to refunded', fields: 2,
  });
  await refused('orders-rw', { delete: 'orders', deletes: [{ q: { status: 'test' }, limit: 0 }] }, 'no rule allows delete', 'not on the allowlist');
  await allowed('orders-rw', { count: 'orders' }, (reply) => reply.n === orders.length, {
    name: `the refused delete changed nothing: ${orders.length} orders`,
  });

  checks.begin('mongodb: the log of the server');
  const text = await logChecks(checks, {
    file: SERVER_LOG, reached, kept, noun: 'command',
  });
  checks.check('the note reached the server', text.includes('"note":"refund sent"'), 'no "refund sent" in the log');
}
