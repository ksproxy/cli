import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import elasticsearch from '../src/kinds/elasticsearch/index.js';
import rabbitmq from '../src/kinds/rabbitmq/index.js';
import redis from '../src/kinds/redis/index.js';
import postgres from '../src/kinds/postgres/index.js';
import mysql from '../src/kinds/mysql/index.js';
import mongodb from '../src/kinds/mongodb/index.js';
import kafka from '../src/kinds/kafka/index.js';
import { shown } from '../src/kinds/engines/doctor.js';
import { validateInventory } from '../src/inventory.js';
import { respServer } from './fixtures/resp-server.js';
import { waitFor } from './start-helpers.js';
import { tempDir } from './temp.js';

const fakePsql = fileURLToPath(new URL('./fixtures/fake-psql.js', import.meta.url));
const fakeMysql = fileURLToPath(new URL('./fixtures/fake-mysql.js', import.meta.url));
const fakeMongosh = fileURLToPath(new URL('./fixtures/fake-mongosh.js', import.meta.url));
const fakeKafka = fileURLToPath(new URL('./fixtures/fake-kafka.js', import.meta.url));

const SECRET = 'S3CR3T-doctor-hooks-b-unmistakable-91c4';
const USER = 'user-S3CR3T-doctor-unmistakable-17aa';
const b64 = (text) => Buffer.from(text).toString('base64');
const LEAKS = [SECRET, USER, b64(SECRET), b64(USER), b64(`${USER}:${SECRET}`), b64(`ApiKey ${SECRET}`)];
const noLeak = (answer) => {
  for (const text of LEAKS) assert.ok(!answer.detail.includes(text), `the detail leaks ${text}: ${answer.detail}`);
  assert.ok(!/\p{Cc}/u.test(answer.detail), 'a control character in the detail');
  assert.ok(answer.detail.length > 0 && answer.detail.length <= 160);
};

const servers = [];
after(async () => {
  for (const server of servers) await server.close();
});

const dir = () => fs.realpathSync(tempDir('ks-dh-b-'));
const ctxOf = (env, secrets, extra = {}) => ({
  env, secrets, timeoutMs: 10000, signal: new AbortController().signal, ...extra,
});
const stoppedCtx = () => {
  const controller = new AbortController();
  return { controller, ctx: (env, secrets) => ctxOf(env, secrets, { timeoutMs: 20000, signal: controller.signal }) };
};

// The opened object as start keeps it: the kind, the target and what open of the kind gave as extras.
function openedOf(kind, target, env, secrets) {
  const result = kind.open(target, { env, secrets });
  assert.equal(result.ok, true, result.error);
  return { kind: kind.key, target, ...result.extras };
}

// ---------- the http kinds ----------

async function httpService(handler) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const service = {
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
  servers.push(service);
  return service;
}

const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const deadUrl = async () => {
  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  return `http://127.0.0.1:${port}`;
};

const esTarget = (url, extra = {}) => validateInventory({
  elasticsearch: [{
    name: 'es-logs', url, userEnv: 'ES_USER', passwordEnv: 'ES_PASSWORD', allow: [], ...extra,
  }],
}).elasticsearch[0];
const mqTarget = (url) => validateInventory({
  rabbitmq: [{
    name: 'mq', url, userEnv: 'MQ_USER', passwordEnv: 'MQ_PASSWORD', allow: [],
  }],
}).rabbitmq[0];
const ES_SECRETS = { ES_USER: USER, ES_PASSWORD: SECRET };

test('elasticsearch: GET /_cluster/health and the status of the cluster, with the credential and nothing else', async () => {
  const service = await httpService(json(200, { cluster_name: 'x', status: 'yellow' }));
  const target = esTarget(service.url);
  const opened = openedOf(elasticsearch, target, {}, ES_SECRETS);
  const answer = await elasticsearch.doctor(opened, ctxOf({}, ES_SECRETS));
  assert.deepEqual(answer, { ok: true, detail: 'cluster yellow' });
  assert.equal(service.seen.length, 1);
  assert.deepEqual([service.seen[0].method, service.seen[0].url], ['GET', '/_cluster/health']);
  assert.equal(service.seen[0].headers.authorization, `Basic ${b64(`${USER}:${SECRET}`)}`);
});

test('elasticsearch: an API key target sends the key, and the rules of the target are not involved', async () => {
  const service = await httpService(json(200, { status: 'green' }));
  const target = validateInventory({
    elasticsearch: [{
      name: 'es-key', url: service.url, apiKeyEnv: 'ES_KEY', allow: ['GET /nothing'],
    }],
  }).elasticsearch[0];
  const secrets = { ES_KEY: SECRET };
  const answer = await elasticsearch.doctor(openedOf(elasticsearch, target, {}, secrets), ctxOf({}, secrets));
  assert.deepEqual(answer, { ok: true, detail: 'cluster green' });
  assert.equal(service.seen[0].headers.authorization, `ApiKey ${SECRET}`);
});

test('elasticsearch: a refused credential gives the status and says authentication failed, and an echo of the credential is not shown', async () => {
  const service = await httpService(json(401, { error: `bad ${USER} ${SECRET} ${b64(`${USER}:${SECRET}`)}` }));
  const opened = openedOf(elasticsearch, esTarget(service.url), {}, ES_SECRETS);
  for (const status of [401, 403]) {
    service.seen.length = 0;
    const again = await httpService(json(status, `denied ${SECRET}`));
    const answer = await elasticsearch.doctor(openedOf(elasticsearch, esTarget(again.url), {}, ES_SECRETS), ctxOf({}, ES_SECRETS));
    assert.deepEqual(answer, { ok: false, detail: `HTTP ${status} from GET /_cluster/health: authentication failed` });
  }
  const answer = await elasticsearch.doctor(opened, ctxOf({}, ES_SECRETS));
  assert.deepEqual(answer, { ok: false, detail: 'HTTP 401 from GET /_cluster/health: authentication failed' });
  noLeak(answer);
});

test('elasticsearch: another status, a redirect and an answer that is not the health report fail with the status only', async () => {
  const cases = [
    [json(503, { status: 'green' }), 'HTTP 503 from GET /_cluster/health'],
    [(req, res) => { res.writeHead(302, { location: 'http://elsewhere.example.com/' }); res.end(); }, 'HTTP 302 from GET /_cluster/health'],
    [json(200, 'not json'), 'HTTP 200 from GET /_cluster/health, but the answer was not as expected'],
    [json(200, 'null'), 'HTTP 200 from GET /_cluster/health, but the answer was not as expected'],
    [json(200, { status: SECRET }), 'HTTP 200 from GET /_cluster/health, but the answer was not as expected'],
    [json(200, {}), 'HTTP 200 from GET /_cluster/health, but the answer was not as expected'],
  ];
  for (const [handler, detail] of cases) {
    const service = await httpService(handler);
    const answer = await elasticsearch.doctor(openedOf(elasticsearch, esTarget(service.url), {}, ES_SECRETS), ctxOf({}, ES_SECRETS));
    assert.deepEqual(answer, { ok: false, detail });
    noLeak(answer);
  }
});

test('elasticsearch: a host that is down, a time-out and Ctrl-C fail with a short reason', async () => {
  const down = await elasticsearch.doctor(openedOf(elasticsearch, esTarget(await deadUrl()), {}, ES_SECRETS), ctxOf({}, ES_SECRETS));
  assert.deepEqual(down, { ok: false, detail: 'could not connect' });
  const silent = await httpService(() => {});
  const opened = openedOf(elasticsearch, esTarget(silent.url), {}, ES_SECRETS);
  const slow = await elasticsearch.doctor(opened, ctxOf({}, ES_SECRETS, { timeoutMs: 250 }));
  assert.deepEqual(slow, { ok: false, detail: 'timed out' });
  const { controller, ctx } = stoppedCtx();
  const running = elasticsearch.doctor(opened, ctx({}, ES_SECRETS));
  await waitFor(() => silent.seen.length >= 2, 5000, 'the request');
  controller.abort();
  assert.deepEqual(await running, { ok: false, detail: 'stopped' });
});

test('rabbitmq: GET /api/whoami and the user name the server reports', async () => {
  const service = await httpService(json(200, { name: 'ops-reader', tags: [] }));
  const secrets = { MQ_USER: USER, MQ_PASSWORD: SECRET };
  const answer = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(service.url), {}, secrets), ctxOf({}, secrets));
  assert.deepEqual(answer, { ok: true, detail: 'user ops-reader' });
  assert.deepEqual([service.seen[0].method, service.seen[0].url], ['GET', '/api/whoami']);
});

test('rabbitmq: a name that is a secret value or an encoded form of one is hidden, and a control character is cleaned', async () => {
  const secrets = { MQ_USER: USER, MQ_PASSWORD: SECRET };
  for (const name of [USER, SECRET, b64(`${USER}:${SECRET}`)]) {
    const service = await httpService(json(200, { name }));
    const answer = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(service.url), {}, secrets), ctxOf({}, secrets));
    assert.deepEqual(answer, { ok: true, detail: 'user [hidden]' });
    noLeak(answer);
  }
  const service = await httpService(json(200, { name: 'a\u0007b\nc   d' }));
  const answer = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(service.url), {}, secrets), ctxOf({}, secrets));
  assert.deepEqual(answer, { ok: true, detail: 'user a b c d' });
  const long = await httpService(json(200, { name: 'n'.repeat(500) }));
  const cut = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(long.url), {}, secrets), ctxOf({}, secrets));
  assert.equal(cut.detail.length, 160);
});

test('rabbitmq: a refused login, a wrong answer, a host that is down and a time-out fail clearly', async () => {
  const secrets = { MQ_USER: USER, MQ_PASSWORD: SECRET };
  const refused = await httpService(json(401, { error: 'not_authorised', reason: `Login failed for ${USER}` }));
  const answer = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(refused.url), {}, secrets), ctxOf({}, secrets));
  assert.deepEqual(answer, { ok: false, detail: 'HTTP 401 from GET /api/whoami: authentication failed' });
  noLeak(answer);
  for (const body of [{ name: '' }, { name: 7 }, {}, 'null']) {
    const service = await httpService(json(200, body));
    const odd = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(service.url), {}, secrets), ctxOf({}, secrets));
    assert.deepEqual(odd, { ok: false, detail: 'HTTP 200 from GET /api/whoami, but the answer was not as expected' });
  }
  const down = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(await deadUrl()), {}, secrets), ctxOf({}, secrets));
  assert.deepEqual(down, { ok: false, detail: 'could not connect' });
  const silent = await httpService(() => {});
  const slow = await rabbitmq.doctor(openedOf(rabbitmq, mqTarget(silent.url), {}, secrets), ctxOf({}, secrets, { timeoutMs: 250 }));
  assert.deepEqual(slow, { ok: false, detail: 'timed out' });
});

test('an http reply that is larger than the read limit is cut, so it is not the report expected', async () => {
  const big = await httpService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'green', pad: 'x'.repeat(100000) }));
  });
  const cut = await elasticsearch.doctor(openedOf(elasticsearch, esTarget(big.url), {}, ES_SECRETS), ctxOf({}, ES_SECRETS));
  assert.deepEqual(cut, { ok: false, detail: 'HTTP 200 from GET /_cluster/health, but the answer was not as expected' });
});

// ---------- redis ----------

const redisTarget = (port, extra = {}) => validateInventory({
  redis: [{
    name: 'cache', host: '127.0.0.1', port, userEnv: 'RDS_USER', passwordEnv: 'RDS_PASSWORD', allow: [], ...extra,
  }],
}).redis[0];
const RDS_SECRETS = { RDS_USER: USER, RDS_PASSWORD: SECRET };
const respAnswer = (extra = {}) => (words) => {
  const name = words[0].toUpperCase();
  if (extra[name] !== undefined) return extra[name](words);
  return name === 'PING' ? '+PONG\r\n' : '+OK\r\n';
};
async function resp(answer) {
  const server = await respServer(answer);
  servers.push(server);
  return server;
}

test('redis: PING after the login, and nothing else is sent', async () => {
  const server = await resp(respAnswer());
  const target = redisTarget(server.port);
  const answer = await redis.doctor(openedOf(redis, target, {}, RDS_SECRETS), ctxOf({}, RDS_SECRETS));
  assert.deepEqual(answer, { ok: true, detail: 'PONG' });
  assert.deepEqual(server.commands, [['AUTH', USER, SECRET], ['PING']]);
  const bare = await resp(respAnswer());
  const open = redisTarget(bare.port, { userEnv: undefined, passwordEnv: undefined, db: 3 });
  const plain = await redis.doctor(openedOf(redis, open, {}, {}), ctxOf({}, {}));
  assert.deepEqual(plain, { ok: true, detail: 'PONG' });
  assert.deepEqual(bare.commands, [['SELECT', '3'], ['PING']]);
});

test('redis: a refused login, an error answer, a wrong answer fail without the server text or the credential', async () => {
  const wrong = await resp(respAnswer({ AUTH: () => `-WRONGPASS invalid username-password pair ${USER} ${SECRET}\r\n` }));
  let answer = await redis.doctor(openedOf(redis, redisTarget(wrong.port), {}, RDS_SECRETS), ctxOf({}, RDS_SECRETS));
  assert.deepEqual(answer, { ok: false, detail: 'authentication failed' });
  noLeak(answer);
  const noauth = await resp(respAnswer({ PING: () => '-NOAUTH Authentication required.\r\n' }));
  answer = await redis.doctor(openedOf(redis, redisTarget(noauth.port, { userEnv: undefined, passwordEnv: undefined }), {}, {}), ctxOf({}, {}));
  assert.deepEqual(answer, { ok: false, detail: 'authentication failed' });
  const odd = await resp(respAnswer({ PING: () => `-ERR something about ${SECRET} went wrong\r\n` }));
  answer = await redis.doctor(openedOf(redis, redisTarget(odd.port), {}, RDS_SECRETS), ctxOf({}, RDS_SECRETS));
  assert.deepEqual(answer, { ok: false, detail: 'the server answered with an error' });
  noLeak(answer);
  const other = await resp(respAnswer({ PING: () => `+${SECRET}\r\n` }));
  answer = await redis.doctor(openedOf(redis, redisTarget(other.port), {}, RDS_SECRETS), ctxOf({}, RDS_SECRETS));
  assert.deepEqual(answer, { ok: false, detail: 'the server did not answer PONG' });
  noLeak(answer);
});

test('redis: a host that is down, a time-out and Ctrl-C fail with a short reason', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  const down = await redis.doctor(openedOf(redis, redisTarget(port), {}, RDS_SECRETS), ctxOf({}, RDS_SECRETS));
  assert.equal(down.ok, false);
  assert.ok(['connection refused', 'could not connect'].includes(down.detail), down.detail);
  const silent = await resp(() => null);
  const opened = openedOf(redis, redisTarget(silent.port), {}, RDS_SECRETS);
  assert.deepEqual(await redis.doctor(opened, ctxOf({}, RDS_SECRETS, { timeoutMs: 250 })), { ok: false, detail: 'timed out' });
  const { controller, ctx } = stoppedCtx();
  const running = redis.doctor(opened, ctx({}, RDS_SECRETS));
  await waitFor(() => silent.commands.length >= 2, 5000, 'the command');
  controller.abort();
  assert.deepEqual(await running, { ok: false, detail: 'stopped' });
});

// ---------- the client programs ----------

function world() {
  const base = dir();
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return {
    base,
    home,
    env: { PATH: process.env.PATH, HOME: home, KSPROXY_STATE_DIR: path.join(base, 'st') },
    log: path.join(base, 'args.log'),
    script(name, body) {
      const file = path.join(base, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    },
  };
}
const node = process.execPath;

// "tls": "prefer", so that open runs nothing and these tests see the doctor check alone; the TLS check that open runs
// for verify and require is tested in sql-kinds.test.js.
const pgTarget = (extra = {}) => validateInventory({
  postgres: [{
    name: 'shop', host: 'db1.example.com', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', tls: 'prefer', allow: [], ...extra,
  }],
}).postgres[0];
const myTarget = (extra = {}) => validateInventory({
  mysql: [{
    name: 'crm', host: 'db2.example.com', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', tls: 'prefer', allow: [], ...extra,
  }],
}).mysql[0];
const SQL_SECRETS = { SHOP_DB_PASSWORD: SECRET, CRM_DB_PASSWORD: SECRET };
const withProgram = (env, name, file) => ({ ...env, [['KSPROXY', name].join('_')]: file });

// The opened object of a postgres or mysql target, whose open is async.
async function sqlOpenedOf(kind, target, env, secrets) {
  const result = await kind.open(target, { env, secrets });
  assert.equal(result.ok, true, result.error);
  return { kind: kind.key, target, ...result.extras };
}

const SQL_KINDS = [
  ['psql', postgres, pgTarget, 'PSQL', fakePsql],
  ['mysql', mysql, myTarget, 'MYSQL', fakeMysql],
];

for (const [name, kind, make, variable, fake] of SQL_KINDS) {
  test(`${kind.key}: select 1 through the client, the credential only in its environment, the stand-in's echo not shown`, async () => {
    const w = world();
    const echoing = w.script(`${name}-echo`, `printf '%s\\n' "$@" > '${w.log}'\nexec '${node}' '${fake}' "$@"`);
    const env = withProgram(w.env, variable, echoing);
    const opened = await sqlOpenedOf(kind, make(), env, SQL_SECRETS);
    const answer = await kind.doctor(opened, ctxOf(env, SQL_SECRETS));
    assert.deepEqual(answer, { ok: true, detail: 'select 1 answered' });
    noLeak(answer);
    const args = fs.readFileSync(w.log, 'utf8').trim().split('\n');
    assert.ok(args.some((arg) => arg === 'select 1' || arg === '--execute=select 1'), args.join(' | '));
    assert.ok(!args.join(' ').includes(SECRET));
    assert.deepEqual(fs.readdirSync(path.join(w.base, 'st', 'run')), []);
  });

  test(`${kind.key}: a wrong password, a refused connection and another exit code fail with a short reason`, async () => {
    const w = world();
    const cases = [
      [`echo "FATAL: password authentication failed for user x ${SECRET}" >&2; echo "Access denied for user ${USER}" >&2; exit 2`, 'authentication failed'],
      [`echo "connection to server at db1 port 5432 failed: Connection refused ${SECRET}" >&2; exit 2`, 'connection refused'],
      [`echo "Can't connect to server on db2 (110) ${SECRET}" >&2; exit 1`, 'could not connect'],
      [`echo "something odd ${SECRET} ${USER}" >&2; echo "${SECRET}"; exit 3`, `${kind.word} exited with code 3`],
    ];
    for (const [body, detail] of cases) {
      const env = withProgram(w.env, variable, w.script(`${name}-fail`, body));
      const answer = await kind.doctor(await sqlOpenedOf(kind, make(), env, SQL_SECRETS), ctxOf(env, SQL_SECRETS));
      assert.deepEqual(answer, { ok: false, detail });
      noLeak(answer);
    }
  });

  test(`${kind.key}: a client that cannot be started, a time-out and Ctrl-C fail`, async () => {
    const w = world();
    const missing = withProgram(w.env, variable, '/nonexistent-folder/client');
    const opened = { kind: kind.key, target: make(), program: '/nonexistent-folder/client' };
    assert.deepEqual(await kind.doctor(opened, ctxOf(missing, SQL_SECRETS)), { ok: false, detail: `${kind.word} could not be started` });
    const started = path.join(w.base, 'started');
    const slow = w.script(`${name}-slow`, `echo up > '${started}'\nexec sleep 60`);
    const env = withProgram(w.env, variable, slow);
    const slowOpened = await sqlOpenedOf(kind, make(), env, SQL_SECRETS);
    assert.deepEqual(await kind.doctor(slowOpened, ctxOf(env, SQL_SECRETS, { timeoutMs: 400 })), { ok: false, detail: 'timed out' });
    fs.rmSync(started, { force: true });
    const { controller, ctx } = stoppedCtx();
    const running = kind.doctor(slowOpened, ctx(env, SQL_SECRETS));
    await waitFor(() => fs.existsSync(started), 5000, 'the client');
    controller.abort();
    assert.deepEqual(await running, { ok: false, detail: 'stopped' });
  });
}

test('postgres and mysql: the check is the same whether the target is read only or may write', async () => {
  const w = world();
  const program = w.script('psql-log', `printf '%s\\n' "$@" > '${w.log}'`);
  const env = withProgram(w.env, 'PSQL', program);
  const answer = await postgres.doctor(await sqlOpenedOf(postgres, pgTarget({ readOnly: false }), env, SQL_SECRETS), ctxOf(env, SQL_SECRETS));
  assert.equal(answer.ok, true);
  assert.equal(fs.readFileSync(w.log, 'utf8').trim().split('\n').at(-1), 'select 1');
});

// ---------- mongodb ----------

const MONGO_URI = `mongodb://report:${encodeURIComponent('P@ss/word')}-${SECRET}@db1.example.com:27017/?authSource=admin`;
const mgTarget = () => validateInventory({
  mongodb: [{
    name: 'orders', uriEnv: 'MGO_URI_VAR', database: 'shop', allow: ['find orders'],
  }],
}).mongodb[0];
const MGO_SECRETS = { MGO_URI_VAR: MONGO_URI };
const mongoNoLeak = (answer) => {
  noLeak(answer);
  for (const text of [MONGO_URI, SECRET, encodeURIComponent('P@ss/word'), 'P@ss/word']) assert.ok(!answer.detail.includes(text), answer.detail);
};

test('mongodb: the ping command through the fixed script, the connection string only in the environment', async () => {
  const w = world();
  const log = path.join(w.base, 'mongosh.log');
  const client = w.script('mongosh', `export FAKE_MONGOSH_LOG='${log}'\nexec '${node}' '${fakeMongosh}' "$@"`);
  const env = withProgram(w.env, 'MONGOSH', client);
  const answer = await mongodb.doctor(openedOf(mongodb, mgTarget(), env, MGO_SECRETS), ctxOf(env, MGO_SECRETS));
  assert.deepEqual(answer, { ok: true, detail: 'ping answered' });
  const line = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(line.doc, '{"ping":1}');
  assert.equal(line.db, 'shop');
  assert.equal(line.uri, MONGO_URI);
  assert.ok(!line.argv.join(' ').includes(SECRET));
});

test('mongodb: a refused login, a refused connection, another exit code and an unexpected answer fail with a short reason', async () => {
  const w = world();
  const decoded = 'P@ss/word';
  const cases = [
    [`echo "error: Unauthorized: not authorized on admin ${MONGO_URI}" >&2; exit 1`, 'authentication failed'],
    ['echo "error: MongoServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017" >&2; exit 1', 'connection refused'],
    [`echo "weird ${decoded} ${SECRET}" >&2; echo "${decoded}"; exit 4`, 'mongosh exited with code 4'],
    ['echo \'{ "ok": 0 }\'', 'mongosh gave an answer that was not as expected'],
    ['echo "not json at all"', 'mongosh gave an answer that was not as expected'],
  ];
  for (const [body, detail] of cases) {
    const env = withProgram(w.env, 'MONGOSH', w.script('mongosh-fail', body));
    const answer = await mongodb.doctor(openedOf(mongodb, mgTarget(), env, MGO_SECRETS), ctxOf(env, MGO_SECRETS));
    assert.deepEqual(answer, { ok: false, detail });
    mongoNoLeak(answer);
  }
});

test('mongodb: a client that cannot be started, a time-out and Ctrl-C fail', async () => {
  const w = world();
  const opened = { kind: 'mongodb', target: mgTarget(), program: '/nonexistent-folder/mongosh' };
  assert.deepEqual(await mongodb.doctor(opened, ctxOf(w.env, MGO_SECRETS)), { ok: false, detail: 'mongosh could not be started' });
  const started = path.join(w.base, 'started');
  const env = withProgram(w.env, 'MONGOSH', w.script('mongosh-slow', `echo up > '${started}'\nexec sleep 60`));
  const slowOpened = openedOf(mongodb, mgTarget(), env, MGO_SECRETS);
  assert.deepEqual(await mongodb.doctor(slowOpened, ctxOf(env, MGO_SECRETS, { timeoutMs: 400 })), { ok: false, detail: 'timed out' });
  fs.rmSync(started, { force: true });
  const { controller, ctx } = stoppedCtx();
  const running = mongodb.doctor(slowOpened, ctx(env, MGO_SECRETS));
  await waitFor(() => fs.existsSync(started), 5000, 'the client');
  controller.abort();
  assert.deepEqual(await running, { ok: false, detail: 'stopped' });
});

// ---------- kafka ----------

const CLIENTS = ['kafka-topics', 'kafka-consumer-groups', 'kafka-configs', 'kafka-acls', 'kafka-log-dirs', 'kafka-broker-api-versions'];
function kafkaWorld(topicsBody, { only } = {}) {
  const w = world();
  const bin = path.join(w.base, 'bin');
  fs.mkdirSync(bin);
  for (const name of only ?? CLIENTS) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${name === 'kafka-topics' ? topicsBody : 'exit 9'}\n`, { mode: 0o755 });
  }
  const target = validateInventory({
    kafka: [{
      name: 'events', bootstrap: 'kafka1.example.com:9092', binDir: bin, allow: [],
    }],
  }).kafka[0];
  return { ...w, bin, target };
}

test('kafka: the topics are counted, with the fixed arguments and the client configuration', async () => {
  const base = dir();
  const log = path.join(base, 'args.log');
  const w = kafkaWorld(`printf '%s\\n' "$@" > '${log}'\nprintf 'orders\\npayments\\n\\naudit\\n'`);
  const properties = path.join(w.base, 'client.properties');
  fs.writeFileSync(properties, `sasl.jaas.config=${SECRET}\n`);
  const target = { ...w.target, clientConfig: properties };
  const answer = await kafka.doctor(openedOf(kafka, target, w.env, {}), ctxOf(w.env, {}));
  assert.deepEqual(answer, { ok: true, detail: '3 topics' });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [
    '--bootstrap-server', 'kafka1.example.com:9092', '--command-config', properties, '--list',
  ]);
  const plain = kafkaWorld(`printf '%s\\n' "$@" > '${log}'\necho only`);
  assert.deepEqual(await kafka.doctor(openedOf(kafka, plain.target, plain.env, {}), ctxOf(plain.env, {})), { ok: true, detail: '1 topic' });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['--bootstrap-server', 'kafka1.example.com:9092', '--list']);
  const none = kafkaWorld('exit 0');
  assert.deepEqual(await kafka.doctor(openedOf(kafka, none.target, none.env, {}), ctxOf(none.env, {})), { ok: true, detail: '0 topics' });
});

test('kafka: the stand-in client of the other tests lists topics too', async () => {
  const w = kafkaWorld(`exec '${node}' '${fakeKafka}' kafka-topics "$@"`);
  const answer = await kafka.doctor(openedOf(kafka, w.target, w.env, {}), ctxOf(w.env, {}));
  assert.deepEqual(answer, { ok: true, detail: '1 topic' });
});

test('kafka: a refused login, a refused connection and another exit code fail with a short reason', async () => {
  const cases = [
    [`echo "SaslAuthenticationException: Authentication failed ${SECRET}" >&2; exit 1`, 'authentication failed'],
    ['echo "Timed out waiting for a node assignment. Connection refused" >&2; exit 1', 'connection refused'],
    [`echo "boom ${SECRET}" >&2; echo "${SECRET}"; exit 3`, 'kafka-topics exited with code 3'],
  ];
  for (const [body, detail] of cases) {
    const w = kafkaWorld(body);
    const answer = await kafka.doctor(openedOf(kafka, w.target, w.env, {}), ctxOf(w.env, {}));
    assert.deepEqual(answer, { ok: false, detail });
    noLeak(answer);
  }
});

test('kafka: kafka-topics missing, a client that cannot be started, a time-out and Ctrl-C fail', async () => {
  const absent = kafkaWorld('exit 0', { only: ['kafka-consumer-groups'] });
  const opened = openedOf(kafka, absent.target, absent.env, {});
  assert.equal(opened.programs.topics, undefined);
  assert.deepEqual(await kafka.doctor(opened, ctxOf(absent.env, {})), { ok: false, detail: 'kafka-topics was not found' });
  const w = kafkaWorld('exit 0');
  const broken = { kind: 'kafka', target: w.target, programs: { topics: '/nonexistent-folder/kafka-topics' } };
  assert.deepEqual(await kafka.doctor(broken, ctxOf(w.env, {})), { ok: false, detail: 'kafka-topics could not be started' });
  const started = path.join(w.base, 'started');
  const slow = kafkaWorld(`echo up > '${started}'\nexec sleep 60`);
  const slowOpened = openedOf(kafka, slow.target, slow.env, {});
  assert.deepEqual(await kafka.doctor(slowOpened, ctxOf(slow.env, {}, { timeoutMs: 400 })), { ok: false, detail: 'timed out' });
  fs.rmSync(started, { force: true });
  const { controller, ctx } = stoppedCtx();
  const running = kafka.doctor(slowOpened, ctx(slow.env, {}));
  await waitFor(() => fs.existsSync(started), 5000, 'the client');
  controller.abort();
  assert.deepEqual(await running, { ok: false, detail: 'stopped' });
});

// ---------- the shared text ----------

test('shown: every hidden text replaced, longest first, control characters and runs of spaces made one space, cut at 160', () => {
  assert.equal(shown(`a ${SECRET}\u0000\u001b[31m  b\tc`, [SECRET]), 'a [hidden] [31m b c');
  assert.equal(shown('xx abc abcdef', ['abc', 'abcdef']), 'xx [hidden] [hidden]');
  assert.equal(shown('left alone', ['']), 'left alone');
  assert.equal(shown(42, []), '42');
  assert.equal(shown('y'.repeat(300), []).length, 160);
});

test('every service kind has the doctor hook', () => {
  for (const kind of [elasticsearch, rabbitmq, redis, postgres, mysql, mongodb, kafka]) assert.equal(typeof kind.doctor, 'function', kind.key);
});
