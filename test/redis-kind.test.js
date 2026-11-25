import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import redisKind from '../src/kinds/redis/index.js';
import {
  MAX_COMMAND_BYTES, MAX_WORDS, fixedRefusal, matchCommandRule, normalizeWords, readCommand,
} from '../src/kinds/redis/words.js';
import { KINDS, kindByKey } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, reviewRoute, toolDefinitions } from '../src/tools.js';
import { handleMessage } from '../src/mcp.js';
import { agentMdText } from '../src/agent-md.js';
import { main } from '../src/cli.js';
import { respServer } from './fixtures/resp-server.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';

const PASSWORD = 'pw-R3D1S-k1nd-77e2-unmistakable';
const USER = 'agent-R3D1S-user-unmistakable';
const PASSWORD_VAR = 'REDIS_TEST_PASSWORD';
const USER_VAR = 'REDIS_TEST_USER';

// The fixed refusals of the spec, by group, with the short text each gets in the log.
const ONE_WORD = {
  'runs server code': ['EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'FUNCTION', 'SCRIPT', 'MODULE', 'DEBUG',
    'TFCALL', 'TFCALLASYNC', 'TFUNCTION', 'PFDEBUG', 'PFSELFTEST'],
  'server-wide command': ['SHUTDOWN', 'FLUSHALL', 'FLUSHDB', 'SWAPDB', 'REPLICAOF', 'SLAVEOF', 'FAILOVER', 'MIGRATE', 'RESTORE', 'RESTORE-ASKING',
    'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'REPLCONF'],
  'blocking command': ['MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'SYNC', 'PSYNC', 'WAIT', 'WAITAOF', 'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH', 'BZPOPMIN', 'BZPOPMAX', 'BLMPOP', 'BZMPOP'],
  'connection command': ['AUTH', 'HELLO', 'RESET', 'QUIT', 'SELECT', 'MULTI', 'EXEC', 'WATCH', 'DISCARD'],
};
const REASONS = {
  'runs server code': 'it runs code on the server',
  'server-wide command': 'it changes the whole server or all of its data',
  'blocking command': 'it blocks or never returns',
  'connection command': 'ksproxy sets up the connection itself',
};
const SUBCOMMAND_REFUSED = ['CONFIG SET maxmemory 1', 'CONFIG REWRITE', 'CONFIG RESETSTAT', 'CONFIG', 'ACL SETUSER x', 'ACL LIST', 'ACL',
  'CLIENT KILL ID 1', 'CLIENT LIST', 'CLIENT PAUSE 100', 'CLIENT', 'CLUSTER RESET', 'CLUSTER FAILOVER', 'CLUSTER'];
const BLOCKING_READS = ['XREAD BLOCK 0 STREAMS s $', 'XREAD COUNT 1 block 0 STREAMS s 0', 'XREADGROUP GROUP g c BLOCK 10 STREAMS s >'];
const CONFIG_GET_REFUSED = ['CONFIG GET *', 'CONFIG GET maxmem*', 'CONFIG GET ?', 'CONFIG GET [m]axmemory', 'CONFIG GET requirepass',
  'CONFIG GET masterauth', 'CONFIG GET masteruser', 'CONFIG GET tls-key-file-pass', 'CONFIG GET tls-client-key-file-pass', 'CONFIG GET maxmemory masterauth',
  'CONFIG GET maxmemory dir*'];
const STILL_ALLOWED = ['CONFIG GET maxmemory', 'CONFIG GET maxmemory dir', 'CONFIG GET', 'ACL WHOAMI', 'CLIENT INFO', 'CLIENT ID', 'CLIENT GETNAME', 'CLUSTER INFO', 'CLUSTER NODES',
  'CLUSTER SLOTS', 'CLUSTER SHARDS', 'CLUSTER MYID', 'XREAD COUNT 1 STREAMS s 0', 'XREADGROUP GROUP g c COUNT 1 STREAMS s >', 'GET block'];

const lower = (text) => text.toLowerCase();
const mixed = (text) => [...text].map((ch, i) => (i % 2 === 0 ? ch.toLowerCase() : ch.toUpperCase())).join('');
const CASES = [(text) => text, lower, mixed];

// The stand-in servers, each with its own log of commands.
let plain;
let secure;
let echoer;
let silent;
const answer = (words) => {
  const name = words[0].toUpperCase();
  if (name === 'AUTH') return words.at(-1) === PASSWORD && (words.length === 2 || words[1] === USER) ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n';
  if (name === 'SELECT') return '+OK\r\n';
  if (name === 'GET') return `$${`value-of-${words[1]}`.length}\r\nvalue-of-${words[1]}\r\n`;
  if (name === 'CONFIG') return `*2\r\n$11\r\nrequirepass\r\n$${PASSWORD.length}\r\n${PASSWORD}\r\n`;
  if (name === 'KEYS') return '*2\r\n$6\r\nuser:1\r\n$15\r\nuser:"x"\nforged\r\n';
  if (name === 'DBSIZE') return ':3\r\n';
  return '-ERR unknown command\r\n';
};

before(async () => {
  plain = await respServer(answer);
  secure = await respServer(answer);
  echoer = await respServer((words) => (words[0] === 'AUTH' ? `-WRONGPASS invalid password ${words.at(-1)}\r\n` : '+OK\r\n'));
  silent = await respServer(() => null);
});

const providers = [];
after(async () => {
  cleanupAll();
  for (const s of [plain, secure, echoer, silent]) await s.close();
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

async function redisWorld({ targets, reviewer } = {}) {
  const world = await makeWorld({ extraEnv: { [PASSWORD_VAR]: PASSWORD, [USER_VAR]: USER } });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.redis = targets;
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.inventoryFile = file;
  return world;
}

const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const redisCalls = (world) => auditOf(world).filter((e) => e.event === 'call' && e.tool === 'redis_command');

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

test('redis is a brokered kind at the end of the list and meets the contract', () => {
  assert.deepEqual(KINDS.map((kind) => kind.key), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka', 'mcp']);
  assert.equal(kindByKey('redis'), redisKind);
  checkKind(redisKind, KINDS);
  assert.equal(redisKind.brokered, true);
  assert.equal(redisKind.label, 'rds');
  assert.equal(redisKind.flag, 'redis');
  assert.equal(redisKind.tool.name, 'redis_command');
  assert.equal(redisKind.tool.detailKey, 'command');
  assert.equal(redisKind.tool.detailIsArray, false);
});

test('a redis entry is validated into a target, and every mistake is an inventory error that names the field', () => {
  const { redis: [target] } = validateInventory({
    redis: [{
      name: 'c', host: 'cache.internal', port: 6380, tls: true, db: 2, userEnv: 'REDIS_USER', passwordEnv: 'REDIS_PASSWORD', description: 'd', allow: ['GET *'],
    }],
  });
  assert.deepEqual(target, {
    kind: 'redis', name: 'c', host: 'cache.internal', port: 6380, tls: true, db: 2, userEnv: 'REDIS_USER', passwordEnv: 'REDIS_PASSWORD', description: 'd', allow: ['GET *'],
  });
  const one = (entry) => validateInventory({ redis: [{ name: 'c', host: 'h', ...entry }] }).redis[0];
  assert.deepEqual(one({}), {
    kind: 'redis', name: 'c', host: 'h', port: 6379, tls: false, db: 0, userEnv: null, passwordEnv: null, description: '', allow: [],
  });
  assert.equal(one({ host: '127.0.0.1' }).host, '127.0.0.1');
  assert.equal(one({ host: '::1' }).host, '::1');
  assert.equal(one({ allow: 'any' }).allow, 'any');
  assert.equal(one({ port: 1 }).port, 1);
  assert.equal(one({ db: 65535 }).db, 65535);
  const fails = (entry, message) => assert.throws(() => one(entry), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.equal(err.message, message);
    return true;
  });
  fails({ password: 'x' }, 'redis "c": unknown key "password"');
  for (const host of [undefined, '', '-x', 'a b', 'user@h', 5, 'h_x', `${'a'.repeat(254)}`]) {
    fails({ host }, 'redis "c": host: must be a host name or an IP address');
  }
  for (const port of [0, 65536, '6379', 1.5, null]) fails({ port }, 'redis "c": port: must be an integer from 1 to 65535');
  for (const tls of ['yes', 1, null]) fails({ tls }, 'redis "c": tls: must be true or false');
  for (const db of [-1, 65536, '1', 0.5]) fails({ db }, 'redis "c": db: must be an integer from 0 to 65535');
  fails({ passwordEnv: 'PATH' }, 'redis "c": passwordEnv: PATH is a variable the session needs; name a variable that must hold only the password');
  fails({ passwordEnv: 'lower' }, 'redis "c": passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ passwordEnv: 'KSPROXY_X' }, 'redis "c": passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ userEnv: 'HOME', passwordEnv: 'P' }, 'redis "c": userEnv: HOME is a variable the session needs; name a variable that must hold only the user name');
  fails({ userEnv: 'U' }, 'redis "c": userEnv: needs passwordEnv as well');
  fails({ allow: 5 }, 'redis "c": allow: must be "any" or an array of rule strings');
  fails({ allow: ['GET ... x'] }, 'redis "c": allow[0]: "..." is only allowed as the last token: GET ... x');
  fails({ allow: ['GET regex(x)'] }, 'redis "c": allow[0]: regex(...) must be the whole rule');
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'redis "c": review.programs: is only for local targets');
  fails({ review: { reviewer: 'nope', policy: 'p' } }, 'redis "c": review.reviewer: must name an entry of "reviewers"');
});

test('the words of a command: plain words split on spaces and tabs, each refusal with its short text', () => {
  assert.equal(MAX_COMMAND_BYTES, 4096);
  assert.equal(MAX_WORDS, 64);
  assert.deepEqual(readCommand('GET user:{42}'), ['GET', 'user:{42}']);
  assert.deepEqual(readCommand(' get\t k  \tv '), ['get', 'k', 'v']);
  assert.deepEqual(readCommand('SET a_@%+=:,./-*?[]{}!~^$#&()<>| 1'), ['SET', 'a_@%+=:,./-*?[]{}!~^$#&()<>|', '1']);
  assert.deepEqual(readCommand(`GET ${'k'.repeat(MAX_COMMAND_BYTES - 4)}`).length, 2);
  assert.equal(readCommand(Array.from({ length: 64 }, () => 'X').join(' ')).length, 64);
  const refused = (command, reason, short) => assert.throws(() => readCommand(command), (err) => {
    assert.equal(err.message, reason);
    assert.equal(err.short, short);
    return true;
  });
  refused(5, 'command must be a string', 'invalid command');
  refused('', 'command is empty', 'empty command');
  refused(' \t ', 'command is empty', 'empty command');
  refused(`GET ${'k'.repeat(MAX_COMMAND_BYTES - 3)}`, 'command is longer than 4096 bytes', 'command too long');
  refused(`GET ${'é'.repeat(2047)}`, 'command is longer than 4096 bytes', 'command too long');
  refused(Array.from({ length: 65 }, () => 'X').join(' '), 'command has more than 64 words', 'too many words');
  const plainWords = 'a redis command is plain words made of letters, digits and _ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |; '
    + 'a value with a space, a quote or a backslash cannot be sent';
  const bad = [['GET "a"', '"""'], ["GET 'a'", '"\'"'], ['GET a\\b', '"\\"'], ['GET a\nb', 'U+000A'], ['GET a\rb', 'U+000D'],
    ['GET a\u0000', 'U+0000'], ['GET a\u007f', 'U+007F'], ['GET é', 'U+00E9'], ['GET a`b', '"`"'], ['GET a;b', '";"'], ['GET a\u00a0b', 'U+00A0'],
    ['GET a\u2028b', 'U+2028']];
  for (const [command, ch] of bad) refused(command, `character ${ch} is not allowed: ${plainWords}`, `character ${ch} not allowed`);
  for (const command of ['* x', '1GET', '-GET', 'GE:T', 'user:1']) {
    refused(command, 'the first word must be a command name made of letters, digits, "_" and "-"', 'invalid command name');
  }
});

test('the command name, and the subcommand of a command that has them, are compared without regard to letter case', () => {
  assert.deepEqual(normalizeWords(['get', 'Key']), ['GET', 'Key']);
  assert.deepEqual(normalizeWords(['config', 'get', 'maxMemory']), ['CONFIG', 'GET', 'maxMemory']);
  assert.deepEqual(normalizeWords(['Client', 'info']), ['CLIENT', 'INFO']);
  assert.deepEqual(normalizeWords(['object', 'encoding', 'k']), ['OBJECT', 'ENCODING', 'k']);
  assert.deepEqual(normalizeWords(['config']), ['CONFIG']);
  assert.deepEqual(normalizeWords(['hget', 'key', 'field']), ['HGET', 'key', 'field']);
  assert.deepEqual(normalizeWords(['*', '...']), ['*', '...']);
  const words = (command) => normalizeWords(readCommand(command));
  assert.equal(matchCommandRule(words('get k'), 'GET *'), true);
  assert.equal(matchCommandRule(words('GET k'), 'get *'), true);
  assert.equal(matchCommandRule(words('config get maxmemory'), 'CONFIG GET *'), true);
  assert.equal(matchCommandRule(words('CONFIG GET maxmemory'), 'config get *'), true);
  assert.equal(matchCommandRule(words('GET key'), 'GET Key'), false);
  assert.equal(matchCommandRule(words('get Key'), 'GET Key'), true);
  assert.equal(matchCommandRule(words('get user:1'), 'regex(GET user:[0-9]+)'), true);
  assert.equal(matchCommandRule(words('GET user:1'), 'regex(get user:[0-9]+)'), false);
  assert.equal(matchCommandRule(words('KEYS *'), 'KEYS \\*'), true);
  assert.equal(matchCommandRule(words('KEYS x'), 'KEYS \\*'), false);
  assert.equal(matchCommandRule(words('KEYS user:*'), 'KEYS user:*'), true);
  assert.equal(matchCommandRule(words('KEYS user:1'), 'KEYS user:*'), false);
  assert.equal(matchCommandRule(words('GET -x'), 'GET *'), false);
  assert.equal(matchCommandRule(words('ZRANGE lb -inf +inf'), 'ZRANGE lb ...'), true);
});

test('every fixed refusal, in upper, lower and mixed case, is refused before any rule and never reviewed', () => {
  const reviewed = { review: true };
  const rules = ['any', ['* ...'], ['regex(.*)'], ['regex([A-Za-z]+( .*)?)']];
  const check = (command, short, reason) => {
    for (const shape of CASES) {
      for (const allow of rules) {
        const decision = redisKind.decide({ allow, ...reviewed }, shape(command));
        assert.equal(decision.allowed, false, `${shape(command)} with ${JSON.stringify(allow)}`);
        assert.equal(decision.short, short, shape(command));
        assert.equal(decision.reason, reason, shape(command));
        assert.equal(decision.unmatched, undefined);
        assert.equal(reviewRoute('redis', decision, true), null, 'a fixed refusal is never sent to the reviewer');
      }
      assert.deepEqual(fixedRefusal(normalizeWords(readCommand(shape(command)))), { reason, short });
    }
  };
  for (const [short, names] of Object.entries(ONE_WORD)) {
    for (const name of names) check(`${name} x`, short, `${name} is never allowed on a redis target: ${REASONS[short]}`);
  }
  const only = {
    CONFIG: 'of CONFIG only CONFIG GET is allowed',
    ACL: 'of ACL only ACL WHOAMI is allowed',
    CLIENT: 'of CLIENT only CLIENT INFO, CLIENT ID and CLIENT GETNAME are allowed',
    CLUSTER: 'of CLUSTER only CLUSTER INFO, CLUSTER NODES, CLUSTER SLOTS, CLUSTER SHARDS and CLUSTER MYID are allowed',
  };
  for (const command of SUBCOMMAND_REFUSED) {
    const [name, sub] = command.split(' ');
    const what = sub === undefined ? `${name} without a subcommand` : `${name} ${sub}`;
    check(command, 'subcommand not allowed', `${what} is never allowed on a redis target: ${only[name]}`);
  }
  for (const command of CONFIG_GET_REFUSED) {
    const words = command.split(' ');
    const bad = words.slice(2).find((word) => /[*?[]/.test(word) || /pass|auth|masteruser/i.test(word));
    check(command, 'config pattern or credential refused', `CONFIG GET ${bad.toLowerCase()} is never allowed on a redis target: a pattern or a name that holds pass, auth or masteruser can return credentials`);
  }
  assert.equal(fixedRefusal(['CONFIG', 'GET', `pass${'x'.repeat(100)}`]).reason.split(' ')[2].length, 40);
  for (const command of BLOCKING_READS) {
    check(command, 'blocking command', `${command.split(' ')[0]} with BLOCK is never allowed on a redis target: it blocks or never returns`);
  }
  for (const command of STILL_ALLOWED) {
    for (const shape of CASES) {
      assert.equal(fixedRefusal(normalizeWords(readCommand(shape(command)))), null, shape(command));
      assert.equal(redisKind.decide({ allow: ['* ...'] }, shape(command)).allowed, true, shape(command));
    }
  }
});

test('decide: the rules of every form, the words given to the reviewer, and the strict reader first', () => {
  const allow = ['GET *', 'TTL *', 'KEYS user:*', 'KEYS \\*', 'INFO ...', 'config get *', 'regex(HGET user:[0-9]+ [a-z]+)', 'ZRANGE lb ...'];
  const call = (command) => redisKind.decide({ allow }, command);
  assert.deepEqual(call('get user:1'), { allowed: true, rule: 'GET *', argv: ['GET', 'user:1'] });
  assert.equal(call('KEYS user:*').rule, 'KEYS user:*');
  assert.equal(call('keys *').rule, 'KEYS \\*');
  assert.equal(call('INFO').rule, 'INFO ...');
  assert.equal(call('info memory').rule, 'INFO ...');
  assert.equal(call('Config Get maxmemory').rule, 'config get *');
  assert.equal(call('hget user:7 name').rule, 'regex(HGET user:[0-9]+ [a-z]+)');
  assert.equal(call('ZRANGE lb -inf +inf').rule, 'ZRANGE lb ...');
  assert.deepEqual(call('del user:1'), {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${allow.join('; ')}`,
    short: 'not on allowlist',
    unmatched: true,
    argv: ['DEL', 'user:1'],
  });
  assert.deepEqual(reviewRoute('redis', call('del user:1'), true), { argv: ['DEL', 'user:1'] });
  for (const command of ['KEYS user:1', 'KEYS x', 'GET a b', 'GET -x', 'HGET user:x name']) {
    assert.equal(call(command).short, 'not on allowlist', command);
  }
  assert.deepEqual(call('GET "x"'), {
    allowed: false,
    reason: 'character """ is not allowed: a redis command is plain words made of letters, digits and _ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |; a value with a space, a quote or a backslash cannot be sent',
    short: 'character """ not allowed',
  });
  assert.equal(redisKind.decide({ allow: [] }, 'GET x').short, 'allowlist is empty');
  assert.equal(redisKind.decide({ allow: 'any' }, 'DEL x').rule, 'any');
});

test('the target in the menu, the opening line, the secrets, the session record and the notes', () => {
  const target = (extra = {}) => ({
    kind: 'redis', name: 'c', host: 'cache.internal', port: 6379, tls: false, db: 0, userEnv: null, passwordEnv: null, description: 'sessions', allow: ['GET *'], ...extra,
  });
  assert.equal(redisKind.hint(target()), 'cache.internal:6379 - sessions');
  assert.equal(redisKind.hint(target({ description: '' })), 'cache.internal:6379');
  assert.equal(redisKind.openingMessage(target()), 'cache.internal:6379, no password');
  assert.equal(redisKind.openingMessage(target({ tls: true, db: 3, passwordEnv: 'P' })), 'cache.internal:6379 over TLS, database 3, password from P');
  assert.equal(redisKind.openingMessage(target({ userEnv: 'U', passwordEnv: 'P' })), 'cache.internal:6379, user from U and password from P');
  assert.deepEqual(redisKind.secrets(target()), { env: [], files: [] });
  assert.deepEqual(redisKind.secrets(target({ passwordEnv: 'P' })), { env: ['P'], files: [] });
  assert.deepEqual(redisKind.secrets(target({ userEnv: 'U', passwordEnv: 'P' })), { env: ['U', 'P'], files: [], users: ['U'] });
  assert.deepEqual(redisKind.open(target(), { secrets: {} }), { ok: true, extras: {} });
  assert.deepEqual(redisKind.record({ target: target({ passwordEnv: 'P' }) }, { reviewed: true }), {
    kind: 'redis', name: 'c', description: 'sessions', allow: ['GET *'], host: 'cache.internal', port: 6379, tls: false, db: 0, userEnv: null, passwordEnv: 'P', state: 'up', review: true,
  });
  assert.equal(redisKind.record({ target: target() }, { reviewed: false }).review, undefined);
  assert.equal(redisKind.downMessage(), 'the call service is not answering');
  assert.equal(redisKind.backMessage, 'the call service is back');
  const notes = redisKind.agentSection({ ...target(), review: true });
  assert.match(notes, /^### redis target `c` - sessions\n\n- Tool: `redis_command` with `target: "c"`/);
  assert.ok(notes.includes('- Allowed commands: GET *'));
  assert.ok(notes.includes('compared without regard to letter case'));
  assert.ok(notes.includes('a value with a space, a quote or a backslash cannot be sent'));
  assert.ok(notes.includes('Never allowed, whatever the rules say'));
  assert.ok(notes.includes('scripts and functions (EVAL, FCALL, FUNCTION, SCRIPT, TFCALL, TFUNCTION)'));
  assert.ok(notes.includes('CONFIG GET with a pattern (`*`, `?`, `[`) or with a name that holds `pass`, `auth` or `masteruser`, because those return credentials'));
  assert.ok(notes.includes('(integer) N'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes('cache.internal'), 'the host is not in the notes');
  const any = redisKind.agentSection({ ...target({ description: '' }), allow: 'any' });
  assert.ok(any.startsWith('### redis target `c`\n'));
  assert.ok(!any.includes('without regard to letter case'));
  assert.ok(any.includes('Never allowed, whatever the rules say'));
  assert.ok(!any.includes('reviewed before'));
  assert.ok(redisKind.toolBullet.includes('`redis_command { target, command, timeout_seconds? }`'));
});

test('perform reads the command again, refuses a fixed refusal on any path, and leaves the hiding to the core', async () => {
  const target = {
    kind: 'redis', name: 'c', host: '127.0.0.1', port: secure.port, tls: false, db: 2, userEnv: USER_VAR, passwordEnv: PASSWORD_VAR, allow: ['GET *'],
  };
  const ctx = (input) => ({
    secrets: { [PASSWORD_VAR]: PASSWORD, [USER_VAR]: USER }, timeoutMs: 5000, maxBytes: 262144, signal: new AbortController().signal, input,
  });
  const before = secure.commands.length;
  await assert.rejects(redisKind.perform(target, { allowed: true, rule: 'review' }, ctx('flushall')), { message: 'FLUSHALL is never allowed on a redis target: it changes the whole server or all of its data' });
  await assert.rejects(redisKind.perform(target, { allowed: true, rule: 'review' }, ctx('GET "x"')), { short: 'character """ not allowed' });
  assert.equal(secure.commands.length, before);
  const result = await redisKind.perform(target, { allowed: true, rule: 'review' }, ctx('config get dir'));
  assert.deepEqual(result, { exitCode: 0, stdout: `1) "requirepass"\n2) "${PASSWORD}"\n`, stderr: '' });
  assert.deepEqual(redisKind.hiddenForms(target, { [PASSWORD_VAR]: 'a"b\u0001', [USER_VAR]: USER }), ['a\\"b\\x01', USER]);
  assert.deepEqual(redisKind.hiddenForms({ ...target, userEnv: null, passwordEnv: null }, {}), []);
  assert.deepEqual(secure.commands.slice(before), [['AUTH', USER, PASSWORD], ['SELECT', '2'], ['CONFIG', 'GET', 'dir']]);
  const open = await redisKind.perform({ ...target, userEnv: null, passwordEnv: null, db: 0 }, { allowed: true, rule: 'GET *' }, ctx('get k'));
  assert.deepEqual(open, { exitCode: 0, stdout: '"value-of-k"\n', stderr: '' });
  assert.deepEqual(secure.commands.at(-1), ['GET', 'k']);
});

test('ksproxy check redis judges the words as the tool would', async () => {
  const reviewer = await provider();
  const world = await redisWorld({
    reviewer,
    targets: [
      { name: 'cache', host: '127.0.0.1', port: plain.port, allow: ['GET *', 'KEYS \\*'] },
      {
        name: 'rev', host: '127.0.0.1', port: plain.port, allow: ['GET *'], review: { reviewer: 'r1', policy: 'read only' },
      },
    ],
  });
  const check = (...words) => cli(['check', 'redis', ...words], world.env);
  assert.deepEqual(await check('cache', 'get', 'user:1'), { code: 0, stdout: 'ALLOWED by rule: GET *\n', stderr: '' });
  assert.deepEqual(await check('cache', 'KEYS', '*'), { code: 0, stdout: 'ALLOWED by rule: KEYS \\*\n', stderr: '' });
  assert.deepEqual(await check('cache', 'flushall'), { code: 1, stdout: 'REFUSED: FLUSHALL is never allowed on a redis target: it changes the whole server or all of its data\n', stderr: '' });
  assert.equal((await check('cache', 'DEL', 'x')).stdout, 'REFUSED: not on the allowlist for this target. Allowed: GET *; KEYS \\*\n');
  assert.equal((await check('rev', 'DEL', 'x')).stdout, 'NOT ON THE ALLOWLIST: a running session asks reviewer "r1"\n');
  assert.equal((await check('rev', 'CONFIG', 'SET', 'x', '1')).stdout, 'REFUSED: CONFIG SET is never allowed on a redis target: of CONFIG only CONFIG GET is allowed\n');
  assert.equal(reviewer.asked.length, 0);
});

test('tools/list, AGENT.md and the usage name the redis kind', async () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ ssh: [{}] })).includes('redis_command'));
  assert.deepEqual(names(toolDefinitions({ redis: [{}] })).slice(-1), ['redis_command']);
  assert.ok(names(toolDefinitions(null)).includes('redis_command'));
  const world = await redisWorld({ targets: [{ name: 'cache', host: '127.0.0.1', port: plain.port }] });
  const listed = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, world.env);
  assert.ok(names(listed.result.tools).includes('redis_command'));
  const notes = agentMdText({
    targets: [{
      kind: 'redis', name: 'cache', description: '', allow: ['GET *'], host: 'h', port: 1, tls: false, db: 0, userEnv: null, passwordEnv: null, state: 'up',
    }],
  });
  assert.ok(notes.includes('- `redis_command { target, command, timeout_seconds? }` - run one Redis command on a redis target.\n'));
  assert.ok(notes.includes('### redis target `cache`'));
  const help = await cli(['--help'], {});
  assert.ok(help.stdout.includes('        [--http x,y] [--command a,b] [--es x,y] [--mq a,b] [--redis x,y]\n'), help.stdout);
  const run = launch(world, {});
  assert.equal(await run.done, 1);
  assert.equal(run.proc.stderr.text, 'no targets selected: use --ssh, --kube, --local, --redis or --all when not running in a terminal\n');
});

test('a session with redis targets: rules on the wire, refusals before the server, every audit once, no password anywhere', async () => {
  const world = await redisWorld({
    targets: [
      {
        name: 'cache', host: '127.0.0.1', port: plain.port, description: 'cache stand-in', allow: ['GET *', 'KEYS user:*', 'KEYS \\*'],
      },
      { name: 'wide', host: '127.0.0.1', port: plain.port, allow: ['* ...'] },
      {
        name: 'secure', host: '127.0.0.1', port: secure.port, db: 2, userEnv: USER_VAR, passwordEnv: PASSWORD_VAR, allow: ['CONFIG GET *', 'GET *'],
      },
      {
        name: 'echoer', host: '127.0.0.1', port: echoer.port, passwordEnv: PASSWORD_VAR, allow: ['GET *'],
      },
      { name: 'slow', host: '127.0.0.1', port: silent.port, allow: ['GET *'] },
    ],
  });
  const run = launch(world, { redis: ['cache', 'wide', 'secure', 'echoer', 'slow'] });
  await ready(run);
  assert.match(run.proc.stderr.text, new RegExp(`rds +cache +OPENING +127\\.0\\.0\\.1:${plain.port}, no password\\n`));
  assert.match(run.proc.stderr.text, new RegExp(`rds +secure +OPENING +127\\.0\\.0\\.1:${secure.port}, database 2, user from ${USER_VAR} and password from ${PASSWORD_VAR}\\n`));
  assert.match(run.proc.stderr.text, /rds +slow +UP\n/);
  const agentEnv = { ...world.env };
  delete agentEnv[PASSWORD_VAR];
  delete agentEnv[USER_VAR];
  const replies = [];
  const ask = async (target, command, extra = {}) => {
    const reply = await callTool('redis_command', { target, command, ...extra }, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const plainBefore = plain.commands.length;
  assert.deepEqual(await ask('cache', 'get user:1'), { text: 'exit code: 0\n--- stdout ---\n"value-of-user:1"', isError: false });
  assert.deepEqual(await ask('cache', 'KEYS user:*'), { text: 'exit code: 0\n--- stdout ---\n1) "user:1"\n2) "user:\\"x\\"\\nforged"', isError: false });
  assert.deepEqual(plain.commands.slice(plainBefore), [['GET', 'user:1'], ['KEYS', 'user:*']]);
  assert.deepEqual(await ask('cache', 'NOPE x'), { text: 'REFUSED (redis cache): not on the allowlist for this target. Allowed: GET *; KEYS user:*; KEYS \\*', isError: true });
  assert.deepEqual(await ask('wide', 'nope x'), { text: 'exit code: 1\n--- stdout ---\n(error) ERR unknown command', isError: true });

  const fixed = [...Object.values(ONE_WORD).flat().map((name) => `${name} x`), ...SUBCOMMAND_REFUSED, ...BLOCKING_READS, ...CONFIG_GET_REFUSED];
  const wideBefore = plain.commands.length;
  for (const command of fixed) {
    const reply = await ask('wide', mixed(command));
    assert.equal(reply.isError, true);
    assert.match(reply.text, /^REFUSED \(redis wide\): [A-Z_-]+ .*is never allowed on a redis target: /, command);
  }
  assert.equal(plain.commands.length, wideBefore, 'no fixed refusal reached the server');
  for (const command of ['GET "a b"', 'GET a\nFLUSHALL', 'get a\\x']) {
    assert.equal((await ask('wide', command)).isError, true);
  }
  assert.equal(plain.commands.length, wideBefore);

  const secureBefore = secure.commands.length;
  assert.deepEqual(await ask('secure', 'config get dir'), { text: 'exit code: 0\n--- stdout ---\n1) "requirepass"\n2) "[hidden]"', isError: false });
  assert.deepEqual(secure.commands.slice(secureBefore), [['AUTH', USER, PASSWORD], ['SELECT', '2'], ['CONFIG', 'GET', 'dir']]);
  assert.deepEqual(await ask('echoer', 'GET k'), { text: 'exit code: 1\n--- stderr ---\nthe server did not accept the credentials', isError: true });
  assert.deepEqual(echoer.commands.at(-1), ['AUTH', PASSWORD]);
  assert.deepEqual(await ask('slow', 'GET k', { timeout_seconds: 1 }), { text: 'timed out after 1s', isError: true });
  assert.equal((await ask('nope', 'GET k')).text, 'unknown redis target "nope". Open targets: cache, wide, secure, echoer, slow');
  assert.equal((await ask('cache', ['GET', 'k'])).text, 'invalid arguments: command must be a string');
  await waitFor(() => /rds +nope +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.filter((t) => t.kind === 'redis').map((t) => [t.name, t.passwordEnv]), [
    ['cache', null], ['wide', null], ['secure', PASSWORD_VAR], ['echoer', PASSWORD_VAR], ['slow', null],
  ]);
  assert.ok(fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8').includes('`redis_command {'));
  assert.equal(await stopWith(run), 0);

  const calls = redisCalls(world);
  assert.equal(calls.length, 4 + fixed.length + 3 + 5);
  assert.deepEqual(calls[0], {
    ...calls[0], kind: 'rds', target: 'cache', command: 'get user:1', decision: 'allowed', rule: 'GET *', exitCode: 0,
  });
  assert.equal(calls.filter((e) => e.decision === 'refused').length, 1 + fixed.length + 3 + 2);
  assert.match(run.proc.stdout.text, /rds +cache +ok .*get user:1\n/);
  assert.match(run.proc.stdout.text, /rds +wide +DENIED .*\[server-wide command\]/);

  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) {
    assert.ok(!text.includes(PASSWORD), `the password in: ${text.slice(0, 200)}`);
    assert.ok(!text.includes(USER), `the user name in: ${text.slice(0, 200)}`);
  }
});

test('an unlisted command goes to the reviewer and runs when approved; a fixed refusal never reaches the reviewer', async () => {
  const reviewer = await provider();
  const world = await redisWorld({
    reviewer,
    targets: [{
      name: 'rev', host: '127.0.0.1', port: plain.port, allow: ['GET *'], review: { reviewer: 'r1', policy: 'read only' },
    }],
  });
  const run = launch(world, { redis: ['rev'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /rds +rev +REVIEW +reviewer r1, accepts sure/);
  const before = plain.commands.length;
  const reviewed = await callTool('redis_command', { target: 'rev', command: 'dbsize' }, world.env);
  assert.deepEqual(reviewed, { text: 'exit code: 0\n--- stdout ---\n(integer) 3', isError: false });
  assert.equal(reviewer.asked.length, 1);
  assert.deepEqual(JSON.parse(reviewer.asked[0].messages[1].content).command, ['DBSIZE']);
  assert.deepEqual(plain.commands.slice(before), [['DBSIZE']]);
  const refused = await callTool('redis_command', { target: 'rev', command: 'flushdb' }, world.env);
  assert.equal(refused.text, 'REFUSED (redis rev): FLUSHDB is never allowed on a redis target: it changes the whole server or all of its data');
  assert.equal(reviewer.asked.length, 1);
  assert.equal(plain.commands.length, before + 1);
  assert.equal(await stopWith(run), 0);
  const [entry] = redisCalls(world).filter((e) => e.rule === 'review');
  assert.equal(entry.command, 'dbsize');
});
