import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import mongodb from '../src/kinds/mongodb/index.js';
import {
  FORBIDDEN_KEYS, FORBIDDEN_STAGES, JOIN_STAGES, NEVER_COMMANDS, PROTOCOL_KEYS, READ_COMMANDS, WRITE_COMMANDS, boundCommand, judgeCommand,
  passwordParts, readCommand,
} from '../src/kinds/mongodb/document.js';
import { CLIENT_ARGS, FIXED_SCRIPT } from '../src/kinds/mongodb/script.js';
import { KINDS, kindByFlag, kindByKey, kindByTool } from '../src/kinds/index.js';
import { mongoshBin } from '../src/paths.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import { main } from '../src/cli.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, trackDir, waitFor,
} from './start-helpers.js';

const fake = fileURLToPath(new URL('./fixtures/fake-mongosh.js', import.meta.url));
const PASSWORD = 'Pa55%2Fw0rd-UNMISTAKABLE-7f3e';
const PASSWORD_DECODED = 'Pa55/w0rd-UNMISTAKABLE-7f3e';
const URI = `mongodb://report-user:${PASSWORD}@db1.example.com:27017,db2.example.com:27017/?replicaSet=rs0&authSource=admin`;
const URI_VAR = 'MGO_TEST_ORDERS_URI';
const BAD_VAR = 'MGO_TEST_BAD_URI';
const BAD_VALUE = 'http://someone:LEAKY-NOT-A-MONGO-URI@db.example.com';
const FIXED_ARGS = ['--nodb', '--quiet', '--norc', '--eval', FIXED_SCRIPT];
const ALLOW = ['find orders', 'count *', 'aggregate orders', 'listCollections', 'regex(find (orders|customers))', 'explain find orders', 'sleep', 'flood', 'insert orders'];

const providers = [];
after(async () => {
  cleanupAll();
  for (const server of providers) {
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

// A shell script that sets the two test variables and runs the fake client: the kind gives the client a minimal
// environment, so a variable of the test cannot reach it any other way.
function fakeClient(dir) {
  const log = path.join(dir, 'mongosh.log');
  const modeFile = path.join(dir, 'mongosh.mode');
  const program = path.join(dir, 'mongosh-wrapper');
  fs.writeFileSync(program, [
    '#!/bin/sh',
    `export FAKE_MONGOSH_LOG='${log}'`,
    `export FAKE_MONGOSH_MODE_FILE='${modeFile}'`,
    `exec '${process.execPath}' '${fake}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    program,
    mode: (text) => fs.writeFileSync(modeFile, text),
    lines: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', prefix)));
  trackDir(dir);
  return dir;
}

const one = (entry) => validateInventory({ mongodb: [{ name: 'o', uriEnv: 'ORDERS_URI', database: 'shop', ...entry }] }).mongodb[0];
const fails = (entry, message) => assert.throws(() => one(entry), (err) => {
  assert.ok(err instanceof InventoryError, err.message);
  assert.equal(err.message, message);
  return true;
});

const target = (extra = {}) => ({
  kind: 'mongodb', name: 'orders', uriEnv: URI_VAR, database: 'shop', writes: false, joins: false, description: '', allow: ALLOW, ...extra,
});
const ask = (command, extra = {}) => mongodb.decide(target(extra), { command });
const refusedWith = (decision, short) => {
  assert.equal(decision.allowed, false, JSON.stringify(decision));
  assert.equal(decision.short, short, JSON.stringify(decision));
  assert.equal(decision.unmatched, undefined, 'a fixed refusal is never reviewed');
};

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('mongodb is a brokered kind appended to the list and meets the contract', () => {
  assert.equal(KINDS[10], mongodb);
  assert.equal(kindByKey('mongodb'), mongodb);
  assert.equal(kindByFlag('mongo'), mongodb);
  assert.equal(kindByTool('mongodb_command'), mongodb);
  checkKind(mongodb, KINDS);
  assert.equal(mongodb.brokered, true);
  assert.equal(mongodb.label, 'mgo');
  assert.equal(mongodb.tool.detailShape, 'object');
  assert.equal(mongodb.tool.detailKey, 'request');
  assert.deepEqual(mongodb.tool.definition.inputSchema.required, ['target', 'command']);
  assert.equal(mongodb.tool.definition.inputSchema.properties.command.type, 'object');
});

test('mongoshBin: the test override or mongosh', () => {
  assert.equal(mongoshBin({ KSPROXY_MONGOSH: '/x/fake' }), '/x/fake');
  assert.equal(mongoshBin({ KSPROXY_MONGOSH: '' }), 'mongosh');
  assert.equal(mongoshBin({}), 'mongosh');
});

test('a mongodb entry is validated into a target', () => {
  assert.deepEqual(one({ allow: ['find orders'], description: 'd', writes: true }), {
    kind: 'mongodb', name: 'o', uriEnv: 'ORDERS_URI', database: 'shop', writes: true, joins: false, description: 'd', allow: ['find orders'],
  });
  const bare = one({});
  assert.deepEqual([bare.writes, bare.joins, bare.allow, bare.description], [false, false, [], '']);
  assert.equal(one({ joins: true }).joins, true);
  assert.equal(one({ joins: false }).joins, false);
  assert.equal(one({ database: 'd'.repeat(63) }).database.length, 63);
  assert.equal(one({ database: 'données-2024_x' }).database, 'données-2024_x');
});

test('every mistake in a mongodb entry is an inventory error that names the field', () => {
  fails({ host: 'x' }, 'mongodb "o": unknown key "host"');
  const variable = 'mongodb "o": uriEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_';
  for (const value of [undefined, '', 'lower', 'KSPROXY_URI', 5]) fails({ uriEnv: value }, variable);
  fails({ uriEnv: 'PATH' }, 'mongodb "o": uriEnv: PATH is a variable the session needs; name a variable that must hold only the connection string');
  const database = 'mongodb "o": database: must be 1 to 63 characters without / \\ . " $ * < > : | ?, spaces or control characters';
  for (const value of [undefined, '', 5, 'd'.repeat(64), 'a/b', 'a\\b', 'a.b', 'a"b', 'a$b', 'a*b', 'a<b', 'a>b', 'a:b', 'a|b', 'a?b', 'a b', 'a\u0000b', 'a\nb']) {
    fails({ database: value }, database);
  }
  fails({ writes: 'yes' }, 'mongodb "o": writes: must be true or false');
  for (const value of ['yes', 1, null]) fails({ joins: value }, 'mongodb "o": joins: must be true or false');
  fails({ allow: 'any' }, 'mongodb "o": allow: "any" is not supported for mongodb targets; list the commands');
  fails({ allow: 'find' }, 'mongodb "o": allow: must be an array of rule strings');
  fails({ allow: ['find ... x'] }, 'mongodb "o": allow[0]: "..." is only allowed as the last token: find ... x');
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'mongodb "o": review.programs: is only for local targets');
});

test('the reader: one JSON object of at most 64 KiB and 20 levels, string keys without NUL, a command name first', () => {
  const read = (command, extra = {}) => readCommand({ command, ...extra });
  const throwsShort = (fn, short, message) => assert.throws(fn, (err) => {
    assert.equal(err.short, short);
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  });
  const notObject = 'command must be one JSON object in the database\'s command format, for example {"find": "orders", "filter": {"status": "open"}}';
  for (const value of [undefined, null, [], [{ find: 'orders' }], 'find orders', 5, true, Object.create(Date.prototype)]) {
    throwsShort(() => read(value), 'not an object', notObject);
  }
  throwsShort(() => read({ find: 'orders' }, { filter: {} }), 'unknown argument', 'unknown argument "filter": give target, command and timeout_seconds only');
  throwsShort(() => read({}), 'empty command', 'the command document is empty: its first key names the command');
  const big = { find: 'orders', filter: { note: 'x'.repeat(65536) } };
  throwsShort(() => read(big), 'command too large', 'the command is larger than 64 KiB');
  assert.ok(read({ find: 'orders', filter: { note: 'x'.repeat(65000) } }));
  const nest = (levels) => {
    let value = 1;
    for (let i = 1; i < levels; i += 1) value = { a: value };
    return { find: 'orders', filter: value };
  };
  assert.ok(read(nest(20)), '20 levels with the top');
  throwsShort(() => read(nest(21)), 'nested too deep', 'the command nests deeper than 20 levels');
  const arrays = { aggregate: 'orders', pipeline: JSON.parse(`${'['.repeat(19)}1${']'.repeat(19)}`) };
  assert.ok(read(arrays));
  throwsShort(() => read({ ...arrays, pipeline: [arrays.pipeline] }), 'nested too deep');
  throwsShort(() => read(JSON.parse('{"find": "orders", "filter": {"__proto__": {"x": 1}}}')), 'bad key', 'the key __proto__ is not accepted');
  throwsShort(() => read(JSON.parse('{"__proto__": "orders"}')), 'bad key');
  throwsShort(() => read({ find: 'orders', filter: { 'a\u0000b': 1 } }), 'bad key', 'a key holds a NUL character');
  for (const name of ['constructor', 'prototype']) {
    throwsShort(() => read({ [name]: 'orders' }), 'bad command name', `the command name ${name} is not accepted`);
  }
  for (const name of ['find orders', '$find', '_isSelf', '1find', 'f-ind', 'x'.repeat(65)]) {
    throwsShort(() => read({ [name]: 'orders' }), 'bad command name', 'the command name must be a letter followed by up to 63 letters, digits and _');
  }
  for (const value of [undefined, () => 1, Number.NaN, Infinity, 10n, new Date(0), Symbol('x')]) {
    throwsShort(() => read({ find: 'orders', filter: { x: value } }), 'not JSON', 'the command holds a value that is not JSON');
  }
  const plain = Object.create(null);
  plain.find = 'orders';
  assert.deepEqual(read(plain), { find: 'orders' });

  const input = { find: 'orders', filter: { status: 'open', tags: ['a', { b: null }] }, limit: 5, flag: true };
  const document = read(input);
  assert.deepEqual(document, input);
  assert.notEqual(document, input, 'a copy');
  assert.notEqual(document.filter, input.filter, 'a deep copy');
  throwsShort(() => read({ find: 'orders', 0: 'first' }), 'bad command name', 'the command name must be a letter followed by up to 63 letters, digits and _');
  const kept = read(JSON.parse('{"find": "orders", "filter": {"b": 1, "a": 2}, "sort": {"z": 1, "y": -1}}'));
  assert.equal(JSON.stringify(kept), '{"find":"orders","filter":{"b":1,"a":2},"sort":{"z":1,"y":-1}}', 'the key order is kept');
});

test('the words: the command name, then the collection when the first value is a string; explain adds its inner words', () => {
  const words = (command) => judgeCommand(readCommand({ command }), { writes: false }).words;
  assert.deepEqual(words({ find: 'orders', filter: { a: 1 } }), ['find', 'orders']);
  assert.deepEqual(words({ aggregate: 'orders', pipeline: [] }), ['aggregate', 'orders']);
  assert.deepEqual(words({ aggregate: 1, pipeline: [] }), ['aggregate']);
  assert.deepEqual(words({ listCollections: 1 }), ['listCollections']);
  assert.deepEqual(words({ ping: 1 }), ['ping']);
  assert.deepEqual(words({ dbStats: true }), ['dbStats']);
  assert.deepEqual(words({ count: 'Orders.archive-2024' }), ['count', 'Orders.archive-2024']);
  assert.deepEqual(words({ explain: { find: 'orders' }, verbosity: 'queryPlanner' }), ['explain', 'find', 'orders']);
  assert.deepEqual(words({ explain: { count: 'orders' } }), ['explain', 'count', 'orders']);
  for (const collection of ['', 'a b', 'a\tb', 'a\nb', 'x'.repeat(256)]) {
    assert.throws(() => words({ find: collection }), (err) => {
      assert.equal(err.short, 'bad collection name');
      assert.equal(err.message, 'the collection name must be 1 to 255 characters without spaces or control characters');
      return true;
    });
  }
  assert.deepEqual(words({ find: 'x'.repeat(255) }), ['find', 'x'.repeat(255)]);
});

test('rules of every form decide on the words, case-sensitively', () => {
  assert.deepEqual(ask({ find: 'orders', filter: { status: 'open' } }), { allowed: true, rule: 'find orders', argv: ['find', 'orders'] });
  assert.equal(ask({ count: 'anything' }).rule, 'count *');
  assert.equal(ask({ aggregate: 'orders', pipeline: [{ $match: {} }] }).rule, 'aggregate orders');
  assert.equal(ask({ listCollections: 1 }).rule, 'listCollections');
  assert.equal(ask({ find: 'customers' }).rule, 'regex(find (orders|customers))');
  assert.equal(ask({ explain: { find: 'orders' } }).rule, 'explain find orders');
  assert.equal(mongodb.decide(target({ allow: ['find ...'] }), { command: { find: 'x' } }).rule, 'find ...');
  assert.equal(mongodb.decide(target({ allow: ['find \\*'] }), { command: { find: '*' } }).rule, 'find \\*');
  assert.equal(mongodb.decide(target({ allow: ['find \\*'] }), { command: { find: 'x' } }).allowed, false);
  assert.equal(mongodb.decide(target({ allow: ['regex(find .*)'] }), { command: { find: 'x.y' } }).rule, 'regex(find .*)');
  const unlisted = (command, argv) => assert.deepEqual(ask(command), {
    allowed: false, reason: `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`, short: 'not on allowlist', unmatched: true, argv,
  });
  unlisted({ find: 'secrets' }, ['find', 'secrets']);
  unlisted({ listCollections: 'orders' }, ['listCollections', 'orders']);
  unlisted({ distinct: 'orders', key: 'a' }, ['distinct', 'orders']);
  unlisted({ explain: { find: 'customers' } }, ['explain', 'find', 'customers']);
  assert.equal(ask({ listcollections: 1 }).short, 'not a read command', 'the command name is compared as written');
  assert.equal(mongodb.decide(target({ allow: [] }), { command: { ping: 1 } }).short, 'allowlist is empty');
});

test('the fixed refusals hold against a rule of every form', () => {
  const everything = [['...'], ['regex(.*)'], ['find ...', 'aggregate ...', 'count ...', 'explain ...', 'insert ...', 'eval ...', 'mapReduce ...']];
  const refused = (command, short, writes = true) => {
    for (const allow of everything) refusedWith(mongodb.decide(target({ allow, writes }), { command }), short);
  };
  for (const key of FORBIDDEN_KEYS) {
    refused({ find: 'orders', filter: { [key]: 'x' } }, 'forbidden key');
    refused({ aggregate: 'orders', pipeline: [{ $match: { a: [{ b: { [key]: 1 } }] } }] }, 'forbidden key');
  }
  assert.equal(ask({ find: 'orders', filter: { $where: 'sleep(1)' } }).reason, 'the key $where is never allowed: it runs JavaScript on the server or writes to a collection');
  assert.equal(ask({ find: 'orders', filter: { $Where: 1 } }).allowed, true, 'keys are compared exactly; MongoDB has no $Where');
  for (const name of NEVER_COMMANDS) refused({ [name]: 1 }, 'command never allowed');
  for (const name of ['replSetGetStatus', 'replSetStepDown', 'MapReduce', 'EVAL', 'ShutDown', 'replsetreconfig']) refused({ [name]: 1 }, 'command never allowed');
  assert.equal(ask({ shutdown: 1 }).reason, 'the command shutdown is never allowed');
  refused({ explain: { mapReduce: 'orders' } }, 'command never allowed');
  refused({ explain: { find: 'orders', filter: { $function: {} } } }, 'forbidden key');
  for (const name of ['insert', 'update', 'delete', 'findAndModify', 'create', 'drop', 'createIndexes']) {
    refused({ [name]: 'orders' }, 'not a read command', false);
  }
  assert.equal(ask({ insert: 'orders' }).reason, 'the command insert is not a read command, and this target does not allow writes');
  refused({ explain: { update: 'orders' } }, 'not a read command', false);
  for (const stage of FORBIDDEN_STAGES) refused({ aggregate: 1, pipeline: [{ [stage]: {} }] }, 'forbidden stage');
  assert.equal(ask({ aggregate: 1, pipeline: [{ $currentOp: {} }] }).reason, 'the stage $currentOp is never allowed');
  refused({ explain: { aggregate: 'orders', pipeline: [{ $changeStream: {} }] } }, 'forbidden stage');
  refused({ aggregate: 'orders' }, 'bad pipeline');
  for (const pipeline of [null, {}, 'x']) refused({ aggregate: 'orders', pipeline }, 'bad pipeline');
  assert.equal(ask({ aggregate: 'orders' }).reason, 'aggregate needs a pipeline: a list of stages');
  for (const stage of [[], null, 'x', {}, { $match: {}, $limit: 1 }]) refused({ aggregate: 'orders', pipeline: [stage] }, 'bad pipeline');
  assert.equal(ask({ aggregate: 'orders', pipeline: [{}] }).reason, 'each stage of the pipeline must be an object with exactly one key, the stage name');
  for (const inner of [1, 'find', null, [{ find: 'orders' }]]) refused({ explain: inner }, 'bad explain');
  assert.equal(ask({ explain: 'find' }).reason, 'explain must hold one command document, for example {"explain": {"find": "orders"}}');
  refused({ explain: { explain: { find: 'orders' } } }, 'bad explain');
  assert.equal(ask({ explain: { explain: { find: 'orders' } } }).reason, 'explain may not hold another explain');
  refused({ explain: {} }, 'empty command');
  refused({ explain: { 'find orders': 1 } }, 'bad command name');
  refused({ explain: { find: 'a b' } }, 'bad collection name');
  refused({ find: 'orders', filter: JSON.parse('{"__proto__": 1}') }, 'bad key');

  for (const name of ['usersInfo', 'currentOp', 'setClusterParameter', 'killAllSessionsByPattern', 'profile', 'fsyncUnlock', 'dropConnections',
    'setDefaultRWConcern', 'setUserWriteBlockMode', 'rotateCertificates', 'renameCollection', 'dataSize', 'bulkWrite', 'findandmodify', 'Insert']) {
    refused({ [name]: 1 }, 'command not allowed');
  }
  assert.throws(() => judgeCommand({ usersInfo: 1, showCredentials: true }, { writes: true }), (err) => err.short === 'command not allowed');
  assert.equal(mongodb.decide(target({ writes: true, allow: ['...'] }), { command: { currentOp: 1, ownOps: false } }).reason,
    'the command currentOp is neither a read command nor one of the commands that change data: insert, update, delete, findAndModify, createIndexes, dropIndexes, create, drop');
  refused({ dataSize: 'admin.system.users' }, 'not a read command', false);
  refused({ explain: { renameCollection: 'shop.orders' } }, 'command not allowed');

  for (const stage of FORBIDDEN_STAGES) {
    refused({ aggregate: 'orders', pipeline: [{ $facet: { a: [{ [stage]: {} }] } }] }, 'forbidden stage');
    refused({ find: 'orders', filter: { x: [{ [stage]: 1 }] } }, 'forbidden stage');
  }
  refused({ aggregate: 'orders', pipeline: [{ $lookup: { from: 'x', pipeline: [{ $currentOp: {} }] } }] }, 'forbidden stage');
  refused({ aggregate: 'orders', pipeline: [{ $unionWith: { coll: 'x', pipeline: [{ $listLocalSessions: {} }] } }] }, 'forbidden stage');

  for (const stage of JOIN_STAGES) {
    refused({ aggregate: 'orders', pipeline: [{ [stage]: { from: 'users', coll: 'users' } }] }, 'join stage');
    refused({ aggregate: 'orders', pipeline: [{ $facet: { a: [{ [stage]: {} }] } }] }, 'join stage');
    refused({ create: 'v', viewOn: 'orders', pipeline: [{ [stage]: {} }] }, 'view refused');
  }
  assert.equal(ask({ aggregate: 'orders', pipeline: [{ $unionWith: { coll: 'users' } }] }).reason,
    'the stage $unionWith reads collections other than the one the rules see, and this target does not set "joins": true');

  for (const key of ['$db', '$readPreference', '$clusterTime', ...PROTOCOL_KEYS]) {
    refused({ find: 'orders', [key]: 'admin' }, 'protocol key');
    refused({ explain: { find: 'orders', [key]: 1 } }, 'protocol key');
  }
  assert.equal(ask({ find: 'orders', $db: 'admin' }).reason, 'the key $db is not allowed at the top of a command: the client sets the database, the session and the transaction');
  assert.equal(ask({ find: 'orders', filter: { $db: 1, lsid: 2 } }).allowed, true, 'only the top level is checked');
});

test('the read list, writes and the never-allowed list as built', () => {
  assert.deepEqual(READ_COMMANDS, [
    'find', 'aggregate', 'count', 'distinct', 'listCollections', 'listIndexes', 'listDatabases', 'collStats', 'dbStats',
    'serverStatus', 'ping', 'hello', 'isMaster', 'buildInfo', 'connectionStatus', 'hostInfo', 'whatsmyuri', 'explain',
  ]);
  assert.deepEqual(WRITE_COMMANDS, ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'create', 'drop']);
  assert.deepEqual(PROTOCOL_KEYS, ['lsid', 'txnNumber', 'autocommit', 'startTransaction']);
  assert.deepEqual(FORBIDDEN_KEYS, ['$where', '$function', '$accumulator', '$out', '$merge', '$code', '$scope']);
  assert.deepEqual(FORBIDDEN_STAGES, ['$currentOp', '$listSessions', '$listLocalSessions', '$changeStream']);
  for (const name of ['eval', 'mapReduce', 'mapreduce', 'shutdown', 'fsync', 'replSetReconfig', 'createUser', 'getCmdLineOpts', 'getMore', 'killCursors', 'saslStart']) {
    assert.ok(NEVER_COMMANDS.includes(name), name);
  }
  const read = target({ allow: ['...'] });
  for (const name of READ_COMMANDS.filter((n) => n !== 'explain')) {
    assert.equal(mongodb.decide(read, { command: { [name]: 1, pipeline: [] } }).allowed, true, name);
  }
  const writer = target({ writes: true, allow: ['insert orders'] });
  assert.deepEqual(mongodb.decide(writer, { command: { insert: 'orders', documents: [{ a: 1 }] } }), { allowed: true, rule: 'insert orders', argv: ['insert', 'orders'] });
  assert.deepEqual(mongodb.decide(writer, { command: { delete: 'orders', deletes: [] } }), {
    allowed: false,
    reason: 'not on the allowlist for this target. Allowed: insert orders',
    short: 'not on allowlist',
    unmatched: true,
    argv: ['delete', 'orders'],
    notReviewed: 'a command outside the read list runs only when a rule allows it',
  });
  assert.equal(mongodb.decide(writer, { command: { explain: { update: 'orders' } } }).notReviewed, 'a command outside the read list runs only when a rule allows it');
  assert.equal(mongodb.decide(writer, { command: { find: 'x' } }).notReviewed, undefined, 'a read command may be reviewed');
  const writeAll = target({ writes: true, allow: ['...'] });
  for (const name of WRITE_COMMANDS) assert.equal(mongodb.decide(writeAll, { command: { [name]: 'orders' } }).allowed, true, name);

  assert.deepEqual(JOIN_STAGES, ['$lookup', '$graphLookup', '$unionWith']);
  const joinText = 'it reads other collections through $lookup, $graphLookup or $unionWith, which the reviewer cannot see';
  const joins = { joins: true };
  for (const stage of JOIN_STAGES) {
    const nested = { aggregate: 'customers', pipeline: [{ $facet: { a: [{ [stage]: { from: 'secrets' } }] } }] };
    assert.equal(ask(nested, joins).notReviewed, joinText, stage);
    assert.equal(judgeCommand(readCommand({ command: nested }), { writes: false, joins: true }).joins, true);
  }
  assert.equal(ask({ aggregate: 'orders', pipeline: [{ $lookup: { from: 'customers' } }] }, joins).rule, 'aggregate orders', 'a rule still allows it');
  assert.equal(ask({ aggregate: 'orders', pipeline: [{ $lookup: { from: 'customers' } }] }, joins).notReviewed, undefined);
  assert.equal(judgeCommand(readCommand({ command: { find: 'x', filter: { lookup: 1 } } }), { writes: false }).joins, false);
  assert.equal(mongodb.decide({ ...writer, joins: true }, { command: { insert: 'customers', documents: [{ $lookup: 1 }] } }).notReviewed, 'a command outside the read list runs only when a rule allows it');
  assert.equal(mongodb.decide(writer, { command: { insert: 'customers', documents: [{ $lookup: 1 }] } }).short, 'join stage');

  const creator = target({ writes: true, allow: ['create *', 'explain create *'] });
  const viewText = (key) => `the key ${key} of create makes a view that reads another collection than the one the rules see, and this target does not set "joins": true`;
  for (const [command, key] of [
    [{ create: 'v', viewOn: 'secrets', pipeline: [] }, 'viewOn'],
    [{ create: 'v', viewOn: 'secrets' }, 'viewOn'],
    [{ create: 'v', pipeline: [{ $match: {} }] }, 'pipeline'],
    [{ explain: { create: 'v', viewOn: 'secrets' } }, 'viewOn'],
  ]) {
    const refused = mongodb.decide(creator, { command });
    refusedWith(refused, 'view refused');
    assert.equal(refused.reason, viewText(key));
  }
  assert.equal(mongodb.decide(creator, { command: { create: 'plain', capped: true, size: 4096 } }).allowed, true);
  assert.equal(mongodb.decide({ ...creator, joins: true }, { command: { create: 'v', viewOn: 'secrets', pipeline: [] } }).allowed, true);
  assert.equal(mongodb.decide(target(), { command: { find: 'orders', viewOn: 'x', pipeline: [] } }).allowed, true, 'only create makes a view');
});

test('boundCommand: find and aggregate return one bounded batch, and the timed commands get maxTimeMS', () => {
  const bound = (command, timeoutMs = 60000) => boundCommand(structuredClone(command), timeoutMs);
  assert.deepEqual(bound({ find: 'orders', filter: { a: 1 } }), {
    find: 'orders', filter: { a: 1 }, limit: 100, batchSize: 100, singleBatch: true, maxTimeMS: 59000,
  });
  assert.equal(bound({ find: 'orders', limit: 10 }).limit, 10);
  assert.equal(bound({ find: 'orders', limit: 10 }).batchSize, 10);
  assert.equal(bound({ find: 'orders', limit: 100 }).limit, 100);
  for (const limit of [0, -5, 101, 5000, 2.5, '10', null]) assert.equal(bound({ find: 'orders', limit }).limit, 100, String(limit));
  assert.equal(bound({ find: 'orders', singleBatch: false, batchSize: 5000 }).singleBatch, true);
  assert.deepEqual(Object.keys(bound({ find: 'orders', limit: 3 })), ['find', 'limit', 'batchSize', 'singleBatch', 'maxTimeMS']);
  assert.deepEqual(bound({ aggregate: 'orders', pipeline: [], cursor: { batchSize: 100000 } }), {
    aggregate: 'orders', pipeline: [], cursor: { batchSize: 100 }, maxTimeMS: 59000,
  });
  assert.deepEqual(bound({ aggregate: 1, pipeline: [] }).cursor, { batchSize: 100 });
  assert.equal(bound({ count: 'orders' }).maxTimeMS, 59000);
  assert.equal(bound({ distinct: 'orders', key: 'a' }).maxTimeMS, 59000);
  assert.equal(bound({ count: 'orders', maxTimeMS: 500 }).maxTimeMS, 500);
  for (const own of [0, -1, 59000, 90000, 1.5, '5']) assert.equal(bound({ count: 'orders', maxTimeMS: own }).maxTimeMS, 59000, String(own));
  assert.equal(bound({ count: 'orders' }, 1000).maxTimeMS, 1, 'never 0, which means no limit');
  for (const name of ['listCollections', 'collStats', 'dbStats']) assert.deepEqual(bound({ [name]: 1 }), { [name]: 1, maxTimeMS: 59000 }, name);
  for (const name of ['listIndexes', 'ping', 'serverStatus']) assert.deepEqual(bound({ [name]: 1 }), { [name]: 1 }, name);
  assert.deepEqual(bound({ explain: { find: 'orders' }, verbosity: 'executionStats' }), {
    explain: {
      find: 'orders', limit: 100, batchSize: 100, singleBatch: true, maxTimeMS: 59000,
    },
    verbosity: 'executionStats',
  });
  assert.deepEqual(bound({ explain: { aggregate: 'orders', pipeline: [{ $group: { _id: 1 } }] }, verbosity: 'executionStats' }).explain, {
    aggregate: 'orders', pipeline: [{ $group: { _id: 1 } }], cursor: { batchSize: 100 }, maxTimeMS: 59000,
  });
  assert.equal(bound({ explain: { count: 'orders', maxTimeMS: 20 } }).explain.maxTimeMS, 20);
  const document = { find: 'orders' };
  assert.equal(boundCommand(document, 5000), document, 'the judged copy is the one that is changed');
});

test('passwordParts: the password of the connection string and of every option named ...password, as written and decoded', () => {
  assert.deepEqual(passwordParts(URI), [PASSWORD, PASSWORD_DECODED]);
  assert.deepEqual(passwordParts('mongodb+srv://u:plain@cluster0.example.net/shop'), ['plain', 'plain']);
  assert.deepEqual(passwordParts('mongodb://u:pa@ss@h/db'), ['pa@ss', 'pa@ss'], 'the user information ends at the last at sign');
  assert.deepEqual(passwordParts('mongodb://u:p%40ss@h1,h2/?x=a@b'), ['p%40ss', 'p@ss'], 'an at sign after the host is not part of it');
  assert.deepEqual(passwordParts('mongodb://u:a/b@h/'), ['a/b', 'a/b'], 'a raw slash in the password: the user information ends at the last at sign before ? or #');
  assert.deepEqual(passwordParts('mongodb://u:p/ss@h1,h2/shop?x=1'), ['p/ss', 'p/ss']);
  assert.deepEqual(passwordParts('mongodb://h/shop?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:t0ken,SERVICE_NAME:mongodb'), ['t0ken', 't0ken'],
    'an authMechanismProperties entry whose name ends in TOKEN');
  assert.deepEqual(passwordParts('mongodb://h/?AUTHMECHANISMPROPERTIES=AWS_SESSION_TOKEN%3Aa%2Bb%2CX_PASSWORD%3Ap:q,service_name%3Am'), ['a%2Bb', 'a+b', 'p:q', 'p:q'],
    'encoded separators, a colon inside a value, any letter case of the option');
  assert.deepEqual(passwordParts('mongodb://h/?authMechanismProperties=x_token:a%2Fb'), ['a%2Fb', 'a/b'], 'a value as written and decoded');
  assert.deepEqual(passwordParts('mongodb://h/?authMechanismProperties=TOKEN,SERVICE_NAME:m,AWS_SESSION_TOKEN:'), [], 'no value');
  assert.deepEqual(passwordParts('mongodb://u:bad%zz@h/'), ['bad%zz', 'bad%zz']);
  assert.deepEqual(passwordParts('mongodb://u@h/'), []);
  assert.deepEqual(passwordParts('mongodb://u:@h/'), []);
  assert.deepEqual(passwordParts('mongodb://u:p@h'), ['p', 'p'], 'no path at all');
  assert.deepEqual(passwordParts('mongodb://h:27017/?appName=ab'), []);
  assert.deepEqual(passwordParts('mongodb://h:27017/?appName=a@b'), []);
  assert.deepEqual(passwordParts('mongodb://h?x=1#u:p@q'), []);
  assert.deepEqual(passwordParts('not a connection string'), []);
  assert.deepEqual(passwordParts('mongodb://h/?tls=true&tlsCertificateKeyFilePassword=s3cret'), ['s3cret', 's3cret']);
  assert.deepEqual(passwordParts('mongodb://u:pw@h/?authSource=admin&TLSCERTIFICATEKEYFILEPASSWORD=a%2Fb#f'), ['pw', 'pw', 'a%2Fb', 'a/b']);
  assert.deepEqual(passwordParts('mongodb://h/?password=x&proxyPassword=y&passwordless=z&emptyPassword='), ['x', 'x', 'y', 'y']);
});

// Runs the fixed script with stand-ins for what mongosh gives it, as data: no client and no database.
function runScript({ reply, error, doc = '{"find":"orders"}' } = {}) {
  const seen = {
    uri: [], database: [], commands: [], out: '', err: '', quit: [],
  };
  const database = {
    runCommand(command) {
      seen.commands.push(command);
      if (error !== undefined && seen.commands.length === 1) throw error;
      return seen.commands.length === 1 ? reply : { ok: 1 };
    },
  };
  vm.runInNewContext(FIXED_SCRIPT, {
    connect(uri) {
      seen.uri.push(uri);
      return { getSiblingDB(name) { seen.database.push(name); return database; } };
    },
    EJSON: { parse: (text) => ({ parsed: JSON.parse(text) }), stringify: (value, replacer, space) => JSON.stringify(value, replacer, space) },
    process: {
      env: { MGO_URI: 'mongodb://h/', MGO_DB: 'shop', MGO_DOC: doc },
      stdout: { write(text) { seen.out += text; } },
      stderr: { write(text) { seen.err += text; } },
    },
    quit(code) { seen.quit.push(code); },
  });
  return seen;
}

test('the fixed script: connects, parses, runs, closes an open cursor, prints; an error is one short line and exit 1', () => {
  const plain = runScript({ reply: { n: 3, ok: 1 }, doc: '{"count":"orders"}' });
  assert.deepEqual(plain.uri, ['mongodb://h/']);
  assert.deepEqual(plain.database, ['shop']);
  assert.deepEqual(plain.commands, [{ parsed: { count: 'orders' } }]);
  assert.equal(plain.out, `${JSON.stringify({ n: 3, ok: 1 }, null, 2)}\n`);
  assert.deepEqual([plain.err, plain.quit], ['', []]);

  const closed = runScript({ reply: { cursor: { firstBatch: [], id: 0, ns: 'shop.orders' }, ok: 1 } });
  assert.equal(closed.commands.length, 1, 'no killCursors for a closed cursor');
  assert.equal(closed.err, '');

  for (const id of [123, { toString: () => '77' }]) {
    const open = runScript({ reply: { cursor: { firstBatch: [{ a: 1 }], id, ns: 'shop.orders.archive' }, ok: 1 } });
    assert.deepEqual(Object.keys(open.commands[1]), ['killCursors', 'cursors']);
    assert.equal(open.commands[1].killCursors, 'orders.archive');
    assert.equal(open.commands[1].cursors.length, 1);
    assert.equal(open.commands[1].cursors[0], id, 'the id from the reply');
    assert.equal(JSON.parse(open.out).cursor.id, 0);
    assert.equal(open.err, 'more results exist: only the first batch is shown and the cursor was closed\n');
  }
  const listed = runScript({ reply: { cursor: { firstBatch: [], id: 9, ns: 'shop.$cmd.listCollections' }, ok: 1 } });
  assert.equal(listed.commands[1].killCursors, '$cmd.listCollections');

  const failed = runScript({ error: Object.assign(new Error('not authorized on shop'), { codeName: 'Unauthorized', stack: 'STACK' }) });
  assert.deepEqual([failed.out, failed.err, failed.quit], ['', 'error: Unauthorized: not authorized on shop\n', [1]]);
  assert.equal(runScript({ error: new TypeError('bad') }).err, 'error: TypeError: bad\n');
  assert.equal(runScript({ error: { message: 'odd' } }).err, 'error: Error: odd\n');
});

test('the fixed script is short, fixed and holds no way to run other code', () => {
  for (const word of ['eval', 'Function', 'load(', 'require', 'import', '${', '`', 'printjson', 'process.env)', 'stack', 'runProgram', 'cat(', 'fs.']) {
    assert.ok(!FIXED_SCRIPT.includes(word), word);
  }
  for (const word of ['process.env.MGO_URI', 'process.env.MGO_DB', 'EJSON.parse(process.env.MGO_DOC)', 'runCommand', 'killCursors', 'EJSON.stringify(reply, null, 2)', 'quit(1)']) {
    assert.ok(FIXED_SCRIPT.includes(word), word);
  }
  assert.ok(FIXED_SCRIPT.split('\n').length <= 20);
  assert.deepEqual(CLIENT_ARGS, FIXED_ARGS);
  assert.ok(Object.isFrozen(CLIENT_ARGS));
});

test('the session functions: hint, opening line, secrets, open with the checks of the connection string, record, notes', () => {
  const env = { KSPROXY_MONGOSH: fake, PATH: '/usr/bin', KSPROXY_STATE_DIR: '/nonexistent-ks/st', KSPROXY_CONFIG_DIR: '/nonexistent-ks/cfg' };
  assert.equal(mongodb.hint(target({ description: 'orders' })), 'database shop - orders');
  assert.equal(mongodb.hint(target()), 'database shop');
  assert.equal(mongodb.openingMessage(target()), `database shop, connection string from ${URI_VAR}, read only`);
  assert.equal(mongodb.openingMessage(target({ writes: true })), `database shop, connection string from ${URI_VAR}, writes allowed by rule`);
  assert.deepEqual(mongodb.secrets(target()), { env: [URI_VAR], files: [] });
  assert.deepEqual(mongodb.open(target(), { env, secrets: { [URI_VAR]: URI } }), { ok: true, extras: { program: fake } });
  assert.deepEqual(mongodb.open(target(), { env, secrets: { [URI_VAR]: 'mongodb+srv://c.example.net/' } }), { ok: true, extras: { program: fake } });
  const bad = `${URI_VAR} does not hold a connection string that starts with mongodb:// or mongodb+srv://`;
  for (const value of [BAD_VALUE, 'MONGODB://h/', 'mongodb:/h', `${URI}\n`, `mongodb://h/\u0000`, 'mongodb://h/\u007f']) {
    const opened = mongodb.open(target(), { env, secrets: { [URI_VAR]: value } });
    assert.deepEqual(opened, { ok: false, error: bad });
  }
  assert.deepEqual(mongodb.open(target(), { env: { ...env, KSPROXY_MONGOSH: '', PATH: '/nonexistent-ks' }, secrets: { [URI_VAR]: URI } }), {
    ok: false, error: 'program mongosh was not found on PATH',
  });
  assert.deepEqual(mongodb.record({ target: target({ description: 'd' }), program: fake }, { reviewed: true }), {
    kind: 'mongodb', name: 'orders', description: 'd', allow: ALLOW, database: 'shop', uriEnv: URI_VAR, writes: false, joins: false, program: fake, state: 'up', review: true,
  });
  assert.equal(mongodb.record({ target: target(), program: fake }, { reviewed: false }).review, undefined);
  assert.equal(mongodb.downMessage(), 'the call service is not answering');
  assert.equal(mongodb.backMessage, 'the call service is back');

  const notes = mongodb.agentSection({ ...target({ description: 'orders db' }), review: true });
  assert.match(notes, /^### mongodb target `orders` - orders db\n\n- Tool: `mongodb_command` with `target: "orders"`/);
  for (const text of [
    'database `shop`', `Allowed commands: ${ALLOW.join('; ')}`, 'Extended JSON', '`find orders`', 'Read only',
    '`$where`', '`$currentOp`', 'at most 100 documents', 'more results exist',
    '- `$lookup`, `$graphLookup` and `$unionWith` are refused on this target, because they read collections other than the one the rules see. So is `create` with `viewOn` or `pipeline`, which makes a view over another collection.',
    'a top-level key that starts with `$`, and `lsid`, `txnNumber`, `autocommit` and `startTransaction`, are refused',
    'find, aggregate, count, distinct, listCollections, collStats and dbStats stop on the server just before the call\'s time limit, and so does the command inside explain',
  ]) assert.ok(notes.includes(text), text);
  const joining = mongodb.agentSection(target({ joins: true }));
  assert.ok(joining.includes('- `$lookup`, `$graphLookup` and `$unionWith` read other collections than the one the rules see; a command that uses them is never sent to the reviewer.'));
  assert.ok(!joining.includes('are refused on this target'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes(URI_VAR), 'the variable is not in the notes');
  const writer = mongodb.agentSection(target({ writes: true }));
  assert.ok(writer.startsWith('### mongodb target `orders`\n'));
  assert.ok(writer.includes('- Writes: the commands that change data (insert, update, delete, findAndModify, createIndexes, dropIndexes, create, drop) run when a rule names them, and are never sent to the reviewer. Every other command outside the read list is refused.'));
  assert.ok(!writer.includes('reviewed before'));
});

test('the tool: the audit keeps the command name and the collection only; check reads one JSON argument', () => {
  const { auditedDetail, detailText } = mongodb.tool;
  assert.deepEqual(auditedDetail({ command: { find: 'orders', filter: { ssn: 'FILTER-VALUE' } } }), { command: 'find', collection: 'orders' });
  assert.deepEqual(auditedDetail({ command: { aggregate: 1, pipeline: [{ $match: { x: 'V' } }] } }), { command: 'aggregate', collection: null });
  assert.deepEqual(auditedDetail({ command: { explain: { find: 'orders' } } }), { command: 'explain', collection: null });
  assert.deepEqual(auditedDetail({ command: {} }), { command: null, collection: null });
  assert.deepEqual(auditedDetail({ command: 'find orders' }), { command: null, collection: null });
  assert.deepEqual(auditedDetail({ command: ['find'] }), { command: null, collection: null });
  assert.deepEqual(auditedDetail({}), { command: null, collection: null });
  assert.equal(auditedDetail({ command: { [`f${'x'.repeat(100)}`]: 'c'.repeat(300) } }).command.length, 64);
  assert.equal(auditedDetail({ command: { find: 'c'.repeat(300) } }).collection.length, 128);
  assert.equal(detailText({ command: 'find', collection: 'orders' }), 'find orders');
  assert.equal(detailText({ command: 'ping', collection: null }), 'ping');
  assert.equal(detailText({ command: null, collection: null }), '(invalid)');
  assert.equal(detailText({ command: 'find', collection: 5 }), 'find');

  assert.deepEqual(mongodb.checkInput(['{"find":', '"orders"}']), { command: { find: 'orders' } });
  assert.deepEqual(mongodb.checkInput(['find', 'orders']), { command: 'find orders' });
});

test('the tool is listed when the inventory holds a mongodb target, and AGENT.md lists it', () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ ssh: [{}] })).includes('mongodb_command'));
  assert.ok(names(toolDefinitions({ mongodb: [{}] })).includes('mongodb_command'));
  const text = agentMdText({ targets: [{ ...target(), program: fake, state: 'up' }] });
  assert.ok(text.includes(`${mongodb.toolBullet}\n`));
  assert.ok(text.includes('### mongodb target `orders`'));
});

test('perform: the argument array is byte-identical for every input, and everything else travels in the environment', async () => {
  const dir = tempDir('ks-mgo-p-');
  const client = fakeClient(dir);
  const env = {
    PATH: process.env.PATH, HOME: path.join(dir, 'home'), KSPROXY_STATE_DIR: path.join(dir, 'st'), [URI_VAR]: 'not-this-one',
  };
  const recorded = { ...target({ allow: ['...'] }), program: client.program };
  const inputs = [
    { find: 'orders', filter: { note: "'; process.exit(1); //" } },
    { find: 'orders`${process.exit()}`', filter: { a: '`rm -rf ~`', b: '${process.env.MGO_URI}', c: 'line\nbreak "quoted" \\ back' } },
    { aggregate: 'orders', pipeline: [{ $match: { js: 'function () { return require("fs") }' } }], cursor: { batchSize: 1e6 } },
    { listCollections: 1, filter: { name: { $regex: '.*' } } },
    { count: 'orders', query: { x: { $oid: '0123456789abcdef01234567' } }, maxTimeMS: 10 },
  ];
  const results = [];
  for (const command of inputs) {
    const decision = mongodb.decide(recorded, { command });
    assert.equal(decision.allowed, true, JSON.stringify(decision));
    results.push(await mongodb.perform(recorded, decision, {
      env, secrets: { [URI_VAR]: URI }, timeoutMs: 30000, maxBytes: 262144, signal: new AbortController().signal, input: { command },
    }));
  }
  const lines = client.lines();
  assert.equal(lines.length, inputs.length);
  for (const [i, line] of lines.entries()) {
    assert.deepEqual(line.argv, FIXED_ARGS, 'the same arguments for every input');
    assert.equal(line.uri, URI);
    assert.equal(line.db, 'shop');
    assert.ok(line.names.includes('MGO_DOC'));
    assert.ok(!line.names.includes(URI_VAR), 'the variable of start does not reach the client');
    assert.ok(line.names.every((name) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'MGO_URI', 'MGO_DB', 'MGO_DOC', 'FAKE_MONGOSH_LOG', 'FAKE_MONGOSH_MODE_FILE', 'PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING', 'OLDPWD', 'NODE_V8_COVERAGE'].includes(name)), line.names.join(','));
    assert.ok(!line.argv.some((arg) => arg.includes(PASSWORD)), 'no secret in the arguments');
    assert.equal(results[i].exitCode, 0);
    assert.deepEqual(JSON.parse(results[i].stdout).received, JSON.parse(line.doc), 'the document comes back unchanged from the client');
  }
  assert.equal(new Set(lines.map((line) => JSON.stringify(line.argv))).size, 1);
  assert.deepEqual(JSON.parse(lines[0].doc), {
    find: 'orders', filter: { note: "'; process.exit(1); //" }, limit: 100, batchSize: 100, singleBatch: true, maxTimeMS: 29000,
  });
  assert.equal(JSON.parse(lines[1].doc).filter.c, 'line\nbreak "quoted" \\ back');
  assert.deepEqual(JSON.parse(lines[2].doc).cursor, { batchSize: 100 });
  assert.equal(JSON.parse(lines[4].doc).maxTimeMS, 10);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'st', 'run')), [], 'the working folder is removed');
  for (const line of lines) {
    assert.equal(line.home, line.cwd, 'HOME is the working folder, so the log and the settings of mongosh stay in it');
    assert.equal(fs.existsSync(line.home), false);
  }

  client.mode('password');
  const shown = await mongodb.perform(recorded, { allowed: true, rule: 'review', argv: ['ping'] }, {
    env, secrets: { [URI_VAR]: URI }, timeoutMs: 30000, maxBytes: 262144, signal: new AbortController().signal, input: { command: { ping: 1 } },
  });
  assert.deepEqual([shown.stdout, shown.stderr], [`raw ${PASSWORD}\n`, `decoded ${PASSWORD_DECODED}\n`], 'the core hides, not perform');
  assert.deepEqual(mongodb.hiddenForms(recorded, { [URI_VAR]: URI }), passwordParts(URI));
  assert.ok(mongodb.hiddenForms(recorded, { [URI_VAR]: URI }).includes(PASSWORD_DECODED));
  await assert.rejects(mongodb.perform(recorded, { allowed: true, rule: 'review', argv: ['find', 'orders'] }, {
    env, secrets: { [URI_VAR]: URI }, timeoutMs: 30000, maxBytes: 262144, signal: new AbortController().signal, input: { command: { find: 'orders', filter: { $where: '1' } } },
  }), /the key \$where is never allowed/);
  assert.equal(client.lines().length, inputs.length + 1, 'a refused document never starts the client');
});

// HOME is a folder of the test, so that a client that ignored the kind's HOME could never write in the real one.
async function mongoWorld({ targets, reviewer } = {}) {
  const world = await makeWorld({ extraEnv: { [URI_VAR]: URI, [BAD_VAR]: BAD_VALUE, HOME: tempDir('ks-mgo-home-') } });
  world.client = fakeClient(world.base);
  world.env.KSPROXY_MONGOSH = world.client.program;
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.mongodb = targets ?? [{
    name: 'orders', uriEnv: URI_VAR, database: 'shop', description: 'orders stand-in', allow: ALLOW,
  }];
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  return world;
}

test('ksproxy check mongo takes the document as one JSON argument', async () => {
  const reviewer = await provider();
  const world = await mongoWorld({
    reviewer,
    targets: [
      { name: 'orders', uriEnv: URI_VAR, database: 'shop', allow: ['find orders'] },
      {
        name: 'rev', uriEnv: URI_VAR, database: 'shop', writes: true, allow: ['find orders'], review: { reviewer: 'r1', policy: 'reads only' },
      },
    ],
  });
  const check = (name, ...words) => cli(['check', 'mongo', name, ...words], world.env);
  assert.deepEqual(await check('orders', '{"find": "orders", "filter": {"a": 1}}'), { code: 0, stdout: 'ALLOWED by rule: find orders\n', stderr: '' });
  assert.equal((await check('orders', '{"find":', '"orders"}')).stdout, 'ALLOWED by rule: find orders\n');
  assert.equal((await check('orders', '{"find": "orders", "filter": {"$where": "1"}}')).stdout, 'REFUSED: the key $where is never allowed: it runs JavaScript on the server or writes to a collection\n');
  assert.equal((await check('orders', '{"insert": "orders"}')).stdout, 'REFUSED: the command insert is not a read command, and this target does not allow writes\n');
  assert.equal((await check('orders', 'find', 'orders')).stdout.startsWith('REFUSED: command must be one JSON object'), true);
  assert.equal((await check('rev', '{"count": "orders"}')).stdout, 'NOT ON THE ALLOWLIST: a running session asks reviewer "r1"\n');
  assert.equal((await check('rev', '{"insert": "orders"}')).stdout, 'REFUSED: not on the allowlist for this target. Allowed: find orders. It was not sent to the reviewer: a command outside the read list runs only when a rule allows it.\n');
  assert.equal(world.client.lines().length, 0, 'check never starts the client');
  assert.equal(reviewer.asked.length, 0);
});

test('a session with a mongodb target: bounded calls, fixed refusals before any run, audit without values, no secret anywhere', async () => {
  const reviewer = await provider();
  const world = await mongoWorld({
    reviewer,
    targets: [
      {
        name: 'orders', uriEnv: URI_VAR, database: 'shop', description: 'orders stand-in', allow: [...ALLOW, '...'], review: { reviewer: 'r1', policy: 'reads only' },
      },
      { name: 'loose', uriEnv: URI_VAR, database: 'shop', allow: ['regex(.*)'] },
      { name: 'badurl', uriEnv: BAD_VAR, database: 'shop', allow: ['ping'] },
      { name: 'unset', uriEnv: 'MGO_TEST_NOT_SET', database: 'shop', allow: ['ping'] },
    ],
  });
  const run = launch(world, { mongo: ['orders', 'loose', 'badurl', 'unset'] });
  await ready(run);
  const err = run.proc.stderr.text;
  assert.match(err, new RegExp(`mgo +orders +OPENING +database shop, connection string from ${URI_VAR}, read only\\n`));
  assert.match(err, /mgo +orders +UP\n/);
  assert.match(err, new RegExp(`mgo +badurl +SKIPPED +${BAD_VAR} does not hold a connection string that starts with mongodb:// or mongodb\\+srv://\\n`));
  assert.match(err, /mgo +unset +SKIPPED +MGO_TEST_NOT_SET is not set\n/);
  const agentEnv = { ...world.env };
  delete agentEnv[URI_VAR];
  delete agentEnv[BAD_VAR];
  const replies = [];
  const call = async (args) => {
    const reply = await callTool('mongodb_command', args, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const found = await call({ target: 'orders', command: { find: 'orders', filter: { ssn: 'FILTER-VALUE-9x', note: '`${process.exit(1)}`' }, limit: 7 } });
  assert.equal(found.isError, false, found.text);
  const [head, body] = found.text.split('\n--- stdout ---\n');
  assert.equal(head, 'exit code: 0');
  assert.deepEqual(JSON.parse(body).received, {
    find: 'orders', filter: { ssn: 'FILTER-VALUE-9x', note: '`${process.exit(1)}`' }, limit: 7, batchSize: 7, singleBatch: true, maxTimeMS: 59000,
  });
  let lines = world.client.lines();
  assert.deepEqual(lines[0].argv, FIXED_ARGS);
  assert.equal(lines[0].uri, URI);
  assert.match(lines[0].cwd, /\/st\/run\/cmd-/);

  world.client.mode('cursor');
  const batch = await call({ target: 'orders', command: { aggregate: 'orders', pipeline: [{ $match: {} }], cursor: { batchSize: 99999 } } });
  assert.ok(batch.text.endsWith('--- stderr ---\nmore results exist: only the first batch is shown and the cursor was closed'), batch.text);
  assert.deepEqual(JSON.parse(world.client.lines()[1].doc).cursor, { batchSize: 100 });
  world.client.mode('error');
  assert.deepEqual(await call({ target: 'orders', command: { count: 'orders' } }), {
    text: 'exit code: 1\n--- stderr ---\nerror: Unauthorized: not authorized on shop to execute command', isError: true,
  });
  world.client.mode('env');
  const printed = await call({ target: 'orders', command: { ping: 1 } });
  const childEnv = JSON.parse(printed.text.split('--- stdout ---\n')[1]);
  assert.equal(childEnv.MGO_URI, '[hidden]');
  assert.ok(Object.keys(childEnv).every((key) => !key.startsWith('KSPROXY_')));
  world.client.mode('password');
  assert.equal((await call({ target: 'orders', command: { ping: 1 } })).text, 'exit code: 0\n--- stdout ---\nraw [hidden]\n--- stderr ---\ndecoded [hidden]');
  world.client.mode('sleep');
  assert.equal((await call({ target: 'orders', command: { ping: 1 }, timeout_seconds: 1 })).text, 'timed out after 1s');
  for (const line of world.client.lines()) {
    assert.equal(line.home, line.cwd);
    assert.equal(fs.existsSync(line.home), false, 'gone after an error and a timeout too');
  }
  assert.deepEqual(fs.readdirSync(path.join(world.base, 'st', 'run')), []);
  assert.deepEqual(fs.readdirSync(world.env.HOME), [], 'nothing is written under the home folder of start');
  world.client.mode('flood');
  const flood = await call({ target: 'orders', command: { ping: 1 } });
  assert.ok(flood.text.endsWith('\n[output truncated at 262144 bytes per stream]'));
  world.client.mode('ok');
  const reviewed = await call({ target: 'orders', command: { distinct: 'customers', key: 'city' } });
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewer.asked.length, 0, 'the ... rule allowed it');

  const started = world.client.lines().length;
  const refused = [
    [{ target: 'orders', command: { find: 'orders', filter: { $where: 'sleep(100)' } } }, 'forbidden key'],
    [{ target: 'loose', command: { aggregate: 'orders', pipeline: [{ $out: 'x' }] } }, 'forbidden key'],
    [{ target: 'loose', command: { mapReduce: 'orders' } }, 'command never allowed'],
    [{ target: 'loose', command: { insert: 'orders', documents: [] } }, 'not a read command'],
    [{ target: 'loose', command: { aggregate: 1, pipeline: [{ $currentOp: {} }] } }, 'forbidden stage'],
    [{ target: 'loose', command: { explain: { explain: { find: 'x' } } } }, 'bad explain'],
    [{ target: 'loose', command: { aggregate: 'orders', pipeline: [{ $unionWith: { coll: 'users' } }] } }, 'join stage'],
    [{ target: 'loose', command: { find: 'orders', $db: 'admin' } }, 'protocol key'],
    [{ target: 'loose', command: { aggregate: 'orders', pipeline: [{ $lookup: { from: 'x', pipeline: [{ $currentOp: {} }] } }] } }, 'forbidden stage'],
    [{ target: 'loose', command: [] }, 'not an object'],
    [{ target: 'loose', command: { find: 'orders' }, extra: 1 }, 'unknown argument'],
  ];
  for (const [args] of refused) {
    const reply = await call(args);
    assert.equal(reply.isError, true);
    assert.match(reply.text, new RegExp(`^REFUSED \\(mongodb ${args.target}\\): `));
  }
  assert.equal(world.client.lines().length, started, 'no refused call starts the client');
  assert.equal((await call({ target: 'nope', command: { ping: 1 } })).text, 'unknown mongodb target "nope". Open targets: orders, loose');

  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.find((t) => t.name === 'loose'), {
    kind: 'mongodb', name: 'loose', description: '', allow: ['regex(.*)'], database: 'shop', uriEnv: URI_VAR, writes: false, joins: false, program: world.client.program, state: 'up',
  });
  assert.ok(fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8').includes('`mongodb_command {'));
  await waitFor(() => /mgo +nope +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  assert.equal(await stopWith(run), 0);

  const auditText = fs.readFileSync(world.auditLog, 'utf8');
  const calls = auditText.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.tool === 'mongodb_command');
  assert.deepEqual(calls[0].request, { command: 'find', collection: 'orders' });
  assert.equal(calls[0].rule, 'find orders');
  assert.deepEqual(calls.filter((e) => e.decision === 'refused').map((e) => e.short), [...refused.map(([, short]) => short), 'unknown target']);
  assert.ok(!auditText.includes('FILTER-VALUE-9x'), 'no value of the filter in the audit log');
  assert.match(run.proc.stdout.text, /mgo +orders +ok .*find orders\n/);

  lines = world.client.lines();
  assert.ok(lines.every((line) => JSON.stringify(line.argv) === JSON.stringify(FIXED_ARGS)));
  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, auditText];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) {
    for (const secret of [URI, PASSWORD, PASSWORD_DECODED, BAD_VALUE, 'LEAKY-NOT-A-MONGO-URI']) {
      assert.ok(!text.includes(secret), `${secret} in: ${text.slice(0, 200)}`);
    }
  }
});

test('an unlisted read command goes to the reviewer and runs when approved', async () => {
  const reviewer = await provider();
  const world = await mongoWorld({
    reviewer,
    targets: [{
      name: 'rev', uriEnv: URI_VAR, database: 'shop', writes: true, joins: true, allow: ['find orders'], review: { reviewer: 'r1', policy: 'reads only' },
    }],
  });
  const run = launch(world, { mongo: ['rev'] });
  await ready(run);
  const reviewed = await callTool('mongodb_command', { target: 'rev', command: { count: 'orders', query: { a: 'QUERY-VALUE' } } }, world.env);
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewer.asked.length, 1);
  assert.deepEqual(JSON.parse(reviewer.asked[0].messages[1].content).command, ['count', 'orders']);
  assert.deepEqual(JSON.parse(world.client.lines()[0].doc), { count: 'orders', query: { a: 'QUERY-VALUE' }, maxTimeMS: 59000 });
  const write = await callTool('mongodb_command', { target: 'rev', command: { insert: 'orders', documents: [{ a: 1 }] } }, world.env);
  assert.equal(write.text, 'REFUSED (mongodb rev): not on the allowlist for this target. Allowed: find orders. It was not sent to the reviewer: a command outside the read list runs only when a rule allows it.');
  assert.equal(reviewer.asked.length, 1);
  const joined = await callTool('mongodb_command', { target: 'rev', command: { aggregate: 'orders', pipeline: [{ $lookup: { from: 'users' } }] } }, world.env);
  assert.equal(joined.text, 'REFUSED (mongodb rev): not on the allowlist for this target. Allowed: find orders. It was not sent to the reviewer: it reads other collections through $lookup, $graphLookup or $unionWith, which the reviewer cannot see.');
  assert.equal(reviewer.asked.length, 1);
  assert.equal(world.client.lines().length, 1);
  assert.equal(await stopWith(run), 0);
});
