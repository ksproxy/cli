// The kafka examples of docs/EXAMPLES.md against Kafka 4.4 in KRaft mode, one node, with the Kafka clients of the
// runner (/opt/kafka/bin) on Debian's Java 17. Each target's client file (~/secrets/kafka-read.properties and
// ~/secrets/kafka-ops.properties) logs its user in with SASL PLAIN over TLS; ksproxy never reads it. The ACLs of the
// users and the seed are in e2e/images/kafka/start.sh: orders has 3 partitions and 6 messages, payments 1 partition
// and 2, and the groups billing (on orders) and search (on payments) are at the earliest offsets. The broker logs the
// decisions of its authorizer on each request, which show which calls reached it and which user made them.
import { clip, logChecks, stdoutOf } from './lib.js';

const AUTHORIZER_LOG = '/kafkalog/authorizer.log';
const users = { 'kafka-prod': 'e2e-kafka-reader', 'kafka-ops': 'e2e-kafka-ops' };

// The rows of kafka-consumer-groups --describe for a group: { topic, partition, current, end, lag }.
function offsetRows(text, group) {
  return stdoutOf(text).split('\n').map((line) => line.trim().split(/\s+/))
    .filter((words) => words[0] === group && /^\d+$/.test(words[2] ?? ''))
    .map(([, topic, partition, current, end, lag]) => ({
      topic, partition: Number(partition), current: Number(current), end: Number(end), lag: Number(lag),
    }));
}
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
// The lines of the output, each trimmed.
const lines = (text) => stdoutOf(text).split('\n').map((line) => line.trim()).filter(Boolean);

// An entry of the authorizer log: the user of a target, Allowed or Denied (a pattern), the operation and the resource,
// for any request.
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decision = (name, target, operation, resource, outcome = 'Allowed') => ({
  name: `${name} (${target})`,
  marker: new RegExp(`Principal = User:${escape(users[target])} is ${outcome} operation = ${operation} from host = \\S+ on resource = ${escape(resource)} `),
});
const ANY = '(Allowed|Denied)';

export async function kafkaScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const run = (target, command) => agent.call('kafka_exec', { target, command });
  const allowed = async (target, command, expect, name = `allowed: ${command}`) => {
    const answer = await run(target, command);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text, 1500));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it. marker: what the call would leave in the log.
  const refused = async (target, command, why, reason, marker) => {
    const answer = await run(target, command);
    checks.check(`refused: ${command} (${why})`, answer.isError && answer.text.startsWith(`REFUSED (kafka ${target}): ${reason}`), clip(answer.text));
    if (marker !== undefined) kept.push(marker);
  };
  const group = async (target, name, check, label) => {
    const answer = await allowed(target, `groups --describe --group ${name}`, (text) => check(offsetRows(text, name)), label);
    return offsetRows(answer.text, name);
  };

  checks.begin('kafka: kafka-prod, read only (e2e-kafka-reader, may describe)');
  await allowed('kafka-prod', 'topics --list', (text) => ['orders', 'payments'].every((topic) => lines(text).includes(topic)));
  reached.push(decision('topics --list', 'kafka-prod', 'DESCRIBE', 'Topic:LITERAL:orders'));
  await allowed('kafka-prod', 'topics --describe --topic orders', (text) => /Topic: orders\s.*PartitionCount: 3\s/.test(text));
  reached.push(decision('topics --describe --topic orders', 'kafka-prod', 'DESCRIBE_CONFIGS', 'Topic:LITERAL:orders'));
  await allowed('kafka-prod', 'groups --list', (text) => ['billing', 'search'].every((name) => lines(text).includes(name)));
  reached.push(decision('groups --list', 'kafka-prod', 'DESCRIBE', 'Group:LITERAL:search'));
  await group('kafka-prod', 'billing', (rows) => rows.length === 3 && sum(rows, 'end') === 6 && sum(rows, 'lag') === 6,
    'allowed: groups --describe --group billing, which lags by the 6 seeded messages');
  reached.push(decision('groups --describe --group billing', 'kafka-prod', 'DESCRIBE', 'Group:LITERAL:billing'));
  await refused('kafka-prod', 'topics --delete --topic orders', 'writes is off, so every write flag is refused',
    '"--delete" is a write flag and writes are off for this target', decision('topics --delete --topic orders', 'kafka-prod', 'DELETE', 'Topic:LITERAL:orders', ANY));
  await refused('kafka-prod', 'topics --create --topic orders-retry --partitions 6 --replication-factor 1', 'writes is off',
    '"--create" is a write flag and writes are off for this target', decision('topics --create --topic orders-retry', 'kafka-prod', 'CREATE', 'Topic:LITERAL:orders-retry', ANY));
  await refused('kafka-prod', 'topics --list --bootstrap-server kafka:9093', 'the user fixes the server',
    '"--bootstrap-server" changes the server or the client configuration');

  checks.begin('kafka: kafka-ops, may create orders-retry and reset billing (e2e-kafka-ops)');
  await group('kafka-ops', 'billing', (rows) => sum(rows, 'lag') === 6, 'allowed: groups --describe --group billing (lag 6)');
  // The example's rule, word for word: ksproxy lets the call through, and the broker refuses three copies on one node.
  const three = await run('kafka-ops', 'topics --create --topic orders-retry --partitions 6 --replication-factor 3');
  checks.check(
    'allowed: topics --create --topic orders-retry --partitions 6 --replication-factor 3, which a broker of one node refuses',
    three.isError && three.text.startsWith('exit code: 1') && three.text.includes('InvalidReplicationFactorException'),
    clip(three.text, 1500),
  );
  await allowed('kafka-ops', 'topics --create --topic orders-retry --partitions 6 --replication-factor 1', (text) => text.includes('Created topic orders-retry.'));
  reached.push(decision('topics --create --topic orders-retry', 'kafka-ops', 'CREATE', 'Topic:LITERAL:orders-retry'));
  await allowed('kafka-ops', 'topics --describe --topic orders-retry', (text) => /Topic: orders-retry\s.*PartitionCount: 6\s/.test(text),
    'the topic orders-retry exists, with 6 partitions');
  reached.push(decision('topics --describe --topic orders-retry', 'kafka-ops', 'DESCRIBE_CONFIGS', 'Topic:LITERAL:orders-retry'));
  await allowed('kafka-ops', 'groups --reset-offsets --group billing --topic orders --to-latest --execute',
    (text) => offsetRows(text, 'billing').length === 3);
  reached.push(decision('groups --reset-offsets --group billing ... --execute', 'kafka-ops', 'READ', 'Group:LITERAL:billing'));
  await group('kafka-ops', 'billing', (rows) => sum(rows, 'lag') === 0 && sum(rows, 'current') === 6,
    'the group billing is at the newest messages of orders (lag 0)');
  await refused('kafka-ops', 'topics --delete --topic orders', 'a write flag needs a rule that names it',
    '"--delete" needs a rule that names it', decision('topics --delete --topic orders', 'kafka-ops', 'DELETE', 'Topic:LITERAL:orders', ANY));
  await refused('kafka-ops', 'topics --alter --topic orders --partitions 12', 'a write flag needs a rule that names it',
    '"--alter" needs a rule that names it', decision('topics --alter --topic orders', 'kafka-ops', 'ALTER', 'Topic:LITERAL:orders', ANY));
  await refused('kafka-ops', 'groups --reset-offsets --group billing --topic orders --to-earliest --execute', 'the rule says --to-latest',
    '"--reset-offsets" needs a rule that names it');
  await refused('kafka-ops', 'groups --reset-offsets --group search --topic payments --to-latest --execute', 'the rule names billing only',
    '"--reset-offsets" needs a rule that names it', decision('groups --reset-offsets --group search', 'kafka-ops', 'READ', 'Group:LITERAL:search', ANY));
  // The rule groups --describe --group * lets the call through; the ACLs of the user allow the group billing only.
  // kafka-consumer-groups ends with exit code 0 even then, so the reply says exit code 0 above the error.
  const search = await run('kafka-ops', 'groups --describe --group search');
  checks.check(
    'the broker refuses groups --describe --group search: the ACLs of e2e-kafka-ops name billing only',
    search.text.includes('GroupAuthorizationException') && offsetRows(search.text, 'search').length === 0,
    clip(search.text, 1500),
  );
  reached.push(decision('groups --describe --group search, denied', 'kafka-ops', 'DESCRIBE', 'Group:LITERAL:search', 'Denied'));

  checks.begin('kafka: the refused calls changed nothing');
  await allowed('kafka-prod', 'topics --describe --topic orders', (text) => /Topic: orders\s.*PartitionCount: 3\s/.test(text),
    'orders is still there, with 3 partitions');
  await group('kafka-prod', 'billing', (rows) => sum(rows, 'lag') === 0 && sum(rows, 'end') === 6,
    'billing is still at the newest messages: the refused reset to the earliest did not run');
  await group('kafka-prod', 'search', (rows) => rows.length === 1 && rows[0].lag === 2,
    'search still lags by the 2 seeded messages: the refused reset did not run');

  checks.begin('kafka: the authorizer log of the broker');
  await logChecks(checks, {
    file: AUTHORIZER_LOG, reached, kept, noun: 'call',
  });
}
