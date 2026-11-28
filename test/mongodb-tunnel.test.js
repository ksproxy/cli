import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongodb from '../src/kinds/mongodb/index.js';
import {
  MONGO_PORT, TUNNEL_REFUSALS, passwordParts, serviceAddress, throughTunnel, uriPieces,
} from '../src/kinds/mongodb/document.js';
import { CLIENT_ARGS } from '../src/kinds/mongodb/script.js';
import { hideSecrets } from '../src/kinds/engines/http.js';
import { hiddenOf } from '../src/kinds/engines/doctor.js';
import { NO_CERTIFICATE_WHY } from '../src/start.js';
import { callTool } from '../src/tools.js';
import { main } from '../src/cli.js';
import { startService } from './fixtures/kind-tunnelled.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, trackDir,
} from './start-helpers.js';

// The mongodb kind through a service tunnel: the address tunnelTo gives and its refusals, the connection string made
// as text for mongosh, the hidden parts inside it, and a real start and doctor through the fake ssh in stream mode,
// with the stand-in mongosh connecting to the loopback port of start.

const fake = fileURLToPath(new URL('./fixtures/fake-mongosh.js', import.meta.url));
const key = (name) => ['KSPROXY', name].join('_');
const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const LOG_KEY = key('FAKE_SSH_LOG');
const CONFIG_KEY = key('CONFIG_DIR');
const PROJECT_KEY = key('PROJECT');
const MONGOSH_KEY = key('MONGOSH');
const HEALTH_KEY = key('HEALTH_MS');

const PASSWORD = 'Pa55%2Fw0rd-UNMISTAKABLE-9c1d';
const PASSWORD_DECODED = 'Pa55/w0rd-UNMISTAKABLE-9c1d';
const URI = `mongodb://report-user:${PASSWORD}@db1.example.com/shop?authSource=admin`;
const URI_VAR = 'MGO_TUNNEL_URI';
const LOOP = '127.0.0.1:50123';
const TUNNEL = Object.freeze({ host: '127.0.0.1', port: 50123, hold: () => () => {} });

const service = await startService();
after(async () => {
  cleanupAll();
  await service.close();
});
beforeEach(() => {
  service.silent = false;
  service.lines.length = 0;
});

const target = (extra = {}) => ({
  kind: 'mongodb', name: 'orders', uriEnv: URI_VAR, database: 'shop', writes: false, joins: false, description: '', allow: ['find orders', 'ping'], ...extra,
});
const to = (uri) => mongodb.tunnelTo(target(), { [URI_VAR]: uri });
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const withTunnel = (entry, tunnel) => Object.defineProperty(entry, 'tunnel', { value: tunnel, enumerable: false });

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', prefix)));
  trackDir(dir);
  return dir;
}

// A shell script that runs the stand-in mongosh with its log and its mode file, as test/mongodb-kind.test.js does.
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

test('uriPieces: the pieces joined again give the string back, and passwordParts reads the same user information', () => {
  const strings = [
    URI, 'mongodb://h', 'mongodb://u:p@h:1/db?a=1#f', 'mongodb://h?x=1', 'mongodb://h#f?x', 'mongodb://u:a/b@h/', 'mongodb://@h/',
    'mongodb://u:pa@ss@h/db', 'mongodb+srv://c.example.net/', 'mongodb://h/?', 'mongodb://h/d@x',
  ];
  for (const uri of strings) {
    const p = uriPieces(uri);
    assert.equal(`${p.scheme}${p.auth}${p.hosts}${p.path}${p.query === null ? '' : `?${p.query}`}${p.fragment}`, uri, uri);
  }
  assert.deepEqual(uriPieces('mongodb://u:p@h:1/db?a=1&b=2#f'), {
    scheme: 'mongodb://', auth: 'u:p@', hosts: 'h:1', path: '/db', query: 'a=1&b=2', fragment: '#f',
  });
  assert.deepEqual(uriPieces('mongodb://u:a/b@h'), {
    scheme: 'mongodb://', auth: 'u:a/b@', hosts: 'h', path: '', query: null, fragment: '',
  });
  assert.deepEqual(uriPieces('mongodb://h#x?y'), {
    scheme: 'mongodb://', auth: '', hosts: 'h', path: '', query: null, fragment: '#x?y',
  });
  assert.deepEqual(uriPieces('mongodb://h/?'), {
    scheme: 'mongodb://', auth: '', hosts: 'h', path: '/', query: '', fragment: '',
  });
  assert.equal(uriPieces('not a connection string'), null);
});

test('tunnelTo: the one host of the connection string, with port 27017 when it names none', () => {
  assert.equal(MONGO_PORT, 27017);
  assert.equal(to(URI), 'db1.example.com:27017');
  assert.equal(to('mongodb://db1.example.com:27018'), 'db1.example.com:27018');
  assert.equal(to('mongodb://u:a%2Fb@db1.example.com:1/?'), 'db1.example.com:1');
  assert.equal(to('mongodb://192.0.2.7/?appName=tls&replicaSet=ssl#tls=true'), '192.0.2.7:27017', 'tls as a value or in the fragment is no option');
  assert.equal(to('mongodb://u:p@[2001:db8::1]/shop'), '[2001:db8::1]:27017');
  assert.equal(to('mongodb://[2001:db8::1]:27018/?x=1'), '[2001:db8::1]:27018');
  assert.equal(to('mongodb://h/?xtls=1&notssl=2&directConnection=false'), 'h:27017');
  // What the engine checks again: a broken port or bracket is passed on, and streamArgs refuses it with its own text.
  assert.equal(to('mongodb://h:x/'), 'h:x');
  assert.equal(to('mongodb://[2001:db8::1/'), '[2001:db8::1');
});

test('tunnelTo: every refusal with its exact text, in any spelling of an option name, and no part of the string in it', () => {
  const bad = `${URI_VAR} does not hold a connection string that starts with mongodb:// or mongodb+srv://`;
  const cases = [
    ['http://u:SECRETPW@h/', bad],
    ['mongodb://h/\u0000', bad],
    ['mongodb+srv://u:SECRETPW@cluster0.example.net/shop', TUNNEL_REFUSALS.srv],
    ['mongodb://u:SECRET@PW@h/', TUNNEL_REFUSALS.at],
    ['mongodb://u:SECRETPW@h/?appName=a@b', TUNNEL_REFUSALS.at],
    ['mongodb://h/?appName=a@b', TUNNEL_REFUSALS.at],
    ['mongodb://h/db#u:SECRETPW@q', TUNNEL_REFUSALS.at],
    ['mongodb://u:SECRET/PW@h/', TUNNEL_REFUSALS.slash],
    ['mongodb://h/d@x', TUNNEL_REFUSALS.slash],
    ['mongodb://h:1/d@x', TUNNEL_REFUSALS.slash],
    ['mongodb:///shop', TUNNEL_REFUSALS.noHost],
    ['mongodb://u:SECRETPW@/shop', TUNNEL_REFUSALS.noHost],
    ['mongodb://u:SECRETPW@?x=1', TUNNEL_REFUSALS.noHost],
    ['mongodb://u:SECRETPW@db1.example.com,db2.example.com/', TUNNEL_REFUSALS.several],
    ['mongodb://db1.example.com:27017,/', TUNNEL_REFUSALS.several],
    ['mongodb://%2Ftmp%2Fmongodb-27017.sock/shop', TUNNEL_REFUSALS.socket],
    ['mongodb://u:SECRETPW@mongo.SOCK/', TUNNEL_REFUSALS.socket],
    ['mongodb://h%2D1:27017/', TUNNEL_REFUSALS.socket],
    ['mongodb://[fe80::1%25eth0]:27017/', TUNNEL_REFUSALS.socket],
  ];
  const tls = [
    'tls=true', 'tls=false', 'TLS=true', 'Tls=1', 'ssl=true', 'SSL=false', 'tlsCAFile=/x/ca.pem', 'TLSINSECURE=true',
    'tlsAllowInvalidCertificates=true', 'sslValidate=false', 'tls', '%74ls=true', 't%4Cs=true', '%54%4C%53=true',
    'authSource=admin&tlsCertificateKeyFile=/x/k.pem', 'x=1&&ssl=true',
  ];
  for (const option of tls) cases.push([`mongodb://u:SECRETPW@h/shop?${option}`, TUNNEL_REFUSALS.tls]);
  for (const option of ['loadBalanced=true', 'loadBalanced=false', 'LOADBALANCED=TRUE', 'load%42alanced=true', 'loadbalanced']) {
    cases.push([`mongodb://u:SECRETPW@h/?${option}`, TUNNEL_REFUSALS.loadBalanced]);
  }
  for (const option of ['proxyHost=192.0.2.9', 'PROXYPORT=1080', 'proxyUsername=a&proxyPassword=SECRETPW', '%70roxyHost=x']) {
    cases.push([`mongodb://h/?${option}`, TUNNEL_REFUSALS.proxy]);
  }
  // No path: the options start right after the host.
  cases.push(['mongodb://h?tls=true', TUNNEL_REFUSALS.tls]);
  for (const [uri, text] of cases) {
    assert.deepEqual(to(uri), { error: text }, uri);
    for (const part of ['SECRET', 'PW', 'report-user', 'db1.example.com', 'cluster0', 'eth0', 'mongo.SOCK', '192.0.2.9']) {
      assert.ok(!text.includes(part), `${part} in ${text}`);
    }
  }
  assert.ok(Object.isFrozen(TUNNEL_REFUSALS));
  assert.equal(serviceAddress('mongodb://h'), 'h:27017');
});

test('throughTunnel: the host list replaced as text, directConnection=true once, a / added when there is no path', () => {
  const cases = [
    [URI, `mongodb://report-user:${PASSWORD}@${LOOP}/shop?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h', `mongodb://${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h:27018', `mongodb://${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h?authSource=admin', `mongodb://${LOOP}/?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/shop', `mongodb://${LOOP}/shop?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://u:p@h:27017/?directConnection=false&authSource=admin', `mongodb://u:p@${LOOP}/?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/?DIRECTCONNECTION=false&a=1&direct%43onnection=x&directconnection&directConnection=true', `mongodb://${LOOP}/?a=1&serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/?&a=1&&', `mongodb://${LOOP}/?a=1&serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/?', `mongodb://${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/db#frag', `mongodb://${LOOP}/db?serverSelectionTimeoutMS=30000&directConnection=true#frag`],
    ['mongodb://h#frag', `mongodb://${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true#frag`],
    ['mongodb://h/?a=1#f?directConnection=false', `mongodb://${LOOP}/?a=1&serverSelectionTimeoutMS=30000&directConnection=true#f?directConnection=false`],
    ['mongodb://@h/', `mongodb://@${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://u:a/b@h/db', `mongodb://u:a/b@${LOOP}/db?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://u%3Ax:p%40ss@[2001:db8::1]:27018/', `mongodb://u%3Ax:p%40ss@${LOOP}/?serverSelectionTimeoutMS=30000&directConnection=true`],
    ['mongodb://h/?appName=a+b%20c&authMechanismProperties=AWS_SESSION_TOKEN:t%2Bk', `mongodb://${LOOP}/?appName=a+b%20c&authMechanismProperties=AWS_SESSION_TOKEN:t%2Bk&serverSelectionTimeoutMS=30000&directConnection=true`],
  ];
  for (const [uri, rewritten] of cases) assert.equal(throughTunnel(uri, LOOP), rewritten, uri);
});

test('throughTunnel: the wait for the server is the driver\'s own 30 s, unless the string names one', () => {
  assert.equal(throughTunnel('mongodb://u:p@db1.example.com/shop', '127.0.0.1:40123'),
    'mongodb://u:p@127.0.0.1:40123/shop?serverSelectionTimeoutMS=30000&directConnection=true');
  assert.equal(throughTunnel('mongodb://db1.example.com/?appName=a#f', '127.0.0.1:40123'),
    'mongodb://127.0.0.1:40123/?appName=a&serverSelectionTimeoutMS=30000&directConnection=true#f');
  for (const written of ['serverSelectionTimeoutMS=5000', 'SERVERSELECTIONTIMEOUTMS=5000', 'serverselectiontimeoutms=']) {
    assert.equal(throughTunnel(`mongodb://db1.example.com/shop?${written}`, '127.0.0.1:40123'),
      `mongodb://127.0.0.1:40123/shop?${written}&directConnection=true`);
  }
});

// Each string, its rewritten form, and the texts a hidden part could be printed in: as it is, and inside a JSON string,
// as the fixed script prints a reply and as a driver's error can quote the string.
const SAMPLES = [
  URI,
  'mongodb://db1.example.com:27017',
  'mongodb://db1.example.com/shop?appName=orders',
  'mongodb://ops:Plain-pw-77aa@db1.example.com/',
  'mongodb://ops:p%22q%5Cr%25s-x9@db1.example.com:27017/shop',
  'mongodb://ops:raw"quote\\back-k2@db1.example.com/shop?authSource=admin&tlsCertificateKeyFilePassword=f1le-pw',
  'mongodb://o%40ps:a/b-slash-m4@db1.example.com/shop?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:t0ken-z1%2Bq',
  'mongodb://ops:hash-pw-3c@db1.example.com/shop?authSource=admin#part',
  'mongodb://ops:x-7d@db1.example.com?directConnection=false&proxyPassword=pr0xy-pw',
];

test('every hidden part of the string is still in the rewritten string as written, and so hidden by the core where mongosh prints it', () => {
  for (const uri of SAMPLES) {
    const secrets = { [URI_VAR]: uri };
    const rewritten = throughTunnel(uri, LOOP);
    const parts = passwordParts(uri);
    // The parts are found the same way in the rewritten string: the rewrite neither moved nor changed one.
    for (const part of passwordParts(rewritten)) assert.ok(parts.includes(part), `${part} of ${rewritten}`);
    const core = hiddenOf(secrets, mongodb.hiddenForms(target(), secrets));
    const printed = [rewritten, JSON.stringify(rewritten).slice(1, -1), `error: MongoServerSelectionError: ${JSON.stringify({ uri: rewritten })}`];
    for (const text of printed) {
      const hidden = hideSecrets(text, core);
      for (const part of parts) {
        for (const form of [part, JSON.stringify(part).slice(1, -1)]) assert.ok(!hidden.includes(form), `${form} in ${hidden}`);
      }
      // The user name and the host list are not hidden parts, today too: only the whole string hides them. The kind
      // hides the whole rewritten string in what a call shows (see perform below).
      if (parts.length > 0) assert.ok(hidden.includes('[hidden]'), hidden);
    }
  }
  // With credentials, each password form is a hidden part.
  assert.deepEqual(passwordParts(SAMPLES[0]), [PASSWORD, PASSWORD_DECODED]);
  assert.deepEqual(passwordParts(SAMPLES[4]), ['p%22q%5Cr%25s-x9', 'p"q\\r%s-x9']);
  assert.ok(mongodb.hiddenForms(target(), { [URI_VAR]: SAMPLES[4] }).includes('p\\"q\\\\r%s-x9'));
  assert.deepEqual(passwordParts(SAMPLES[1]), []);
});

test('perform: the exact arguments and string with and without a tunnel; with one, the string and the loopback address are hidden', async () => {
  const dir = tempDir('ks-mgo-t-');
  const client = fakeClient(dir);
  const env = { PATH: process.env.PATH, HOME: path.join(dir, 'home'), [key('STATE_DIR')]: path.join(dir, 'st') };
  const recorded = { ...target(), program: client.program };
  const decision = mongodb.decide(recorded, { command: { ping: 1 } });
  const run = (secrets, opened) => mongodb.perform(recorded, decision, {
    env, secrets, timeoutMs: 30000, maxBytes: 262144, signal: new AbortController().signal, input: { command: { ping: 1 } }, opened,
  });
  const secrets = { [URI_VAR]: URI };
  const plain = await run(secrets, { kind: 'mongodb', target: recorded, program: client.program });
  const tunnelled = await run(secrets, withTunnel({ kind: 'mongodb', target: recorded, program: client.program }, TUNNEL));
  const [without, through] = client.lines();
  assert.deepEqual(without.argv, CLIENT_ARGS);
  assert.deepEqual(through.argv, CLIENT_ARGS);
  assert.equal(without.uri, URI, 'byte for byte the secret without a tunnel');
  assert.equal(through.uri, `mongodb://report-user:${PASSWORD}@${LOOP}/shop?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true`);
  assert.equal(through.db, 'shop');
  assert.deepEqual(JSON.parse(plain.stdout), JSON.parse(tunnelled.stdout));

  client.mode('address');
  const shown = await run(secrets, withTunnel({ kind: 'mongodb', target: recorded }, TUNNEL));
  assert.equal(shown.stdout, '{"uri":"[hidden]","address":"[hidden]"}\n');
  assert.equal(shown.stderr, 'error: MongoServerSelectionError: connect ECONNREFUSED [hidden]; [hidden]\n');
  assert.equal(shown.exitCode, 1);
  // A string whose JSON form differs: hidden in that form too, and a password that holds the address is hidden whole.
  const quoted = { [URI_VAR]: 'mongodb://ops:q"127.0.0.1:50123"-pw@db1.example.com/' };
  const odd = await run(quoted, withTunnel({ kind: 'mongodb', target: recorded }, TUNNEL));
  assert.equal(odd.stdout, '{"uri":"[hidden]","address":"[hidden]"}\n');
  assert.equal(odd.stderr, 'error: MongoServerSelectionError: connect ECONNREFUSED [hidden]; [hidden]\n');
  // Without a tunnel perform hides nothing: the core does.
  const bare = await run(secrets, undefined);
  assert.equal(bare.stdout, `${JSON.stringify({ uri: URI, address: 'db1.example.com' })}\n`);
});

test('doctor works on the entry of the trial, without the extras of open, through the tunnel', async () => {
  const dir = tempDir('ks-mgo-d-');
  const client = fakeClient(dir);
  client.mode('tunnel');
  const env = {
    PATH: process.env.PATH, HOME: path.join(dir, 'home'), [key('STATE_DIR')]: path.join(dir, 'st'), [MONGOSH_KEY]: client.program,
  };
  const tunnel = Object.freeze({ host: '127.0.0.1', port: service.port, hold: () => () => {} });
  const ctx = { env, secrets: { [URI_VAR]: URI }, timeoutMs: 10000, signal: new AbortController().signal };
  const answer = await mongodb.doctor(withTunnel({ kind: 'mongodb', target: target() }, tunnel), ctx);
  assert.deepEqual(answer, { ok: true, detail: 'ping answered' });
  assert.deepEqual(service.lines, ['PING']);
  const [line] = client.lines();
  assert.equal(line.uri, `mongodb://report-user:${PASSWORD}@127.0.0.1:${service.port}/shop?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true`);
  assert.deepEqual(line.argv, CLIENT_ARGS);
  // Without a program on PATH: a short reason, as open would give.
  const missing = await mongodb.doctor(withTunnel({ kind: 'mongodb', target: target() }, tunnel), {
    ...ctx, env: { ...env, [MONGOSH_KEY]: '', PATH: '/nonexistent-ks' },
  });
  assert.deepEqual(missing, { ok: false, detail: 'program mongosh was not found on PATH' });
  assert.equal(mongodb.tunnelListener, true);
  assert.equal(mongodb.tunnelChecksCertificate, undefined, 'TLS through a tunnel is refused, so start prints its WARN');
  assert.equal(mongodb.tunnelProblem, undefined);
  assert.ok(mongodb.sample.every((entry) => entry.tunnel === undefined));
});

// A world with mongodb targets behind bastion1, the stand-in mongosh in tunnel mode, and the fake ssh joining every
// stream to the test's service.
async function tunnelWorld(targets, uris) {
  const w = await makeWorld({
    ssh: [],
    extraEnv: {
      ...uris, [PORT_KEY]: String(service.port), [HEALTH_KEY]: '600000', NO_COLOR: '1', HOME: tempDir('ks-mgo-th-'),
    },
  });
  w.client = fakeClient(w.base);
  w.client.mode('tunnel');
  w.env[MONGOSH_KEY] = w.client.program;
  w.sshLog = path.join(w.base, 'ssh.log');
  w.env[LOG_KEY] = w.sshLog;
  const file = path.join(w.env[CONFIG_KEY], 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...inventory, mongodb: targets }));
  return w;
}

const JUMP = 'ssh -i .ssh/app_key opsuser@192.0.2.10';
const ROUTE_PARTS = ['bastion1', 'app_key', 'opsuser', '192.0.2.10', 'ksproxy-tunnel', 'tunnel'];
const entry = (name, uriEnv, tunnel = { host: 'bastion1' }) => ({
  name, uriEnv, database: 'shop', allow: ['find orders', 'ping'], tunnel,
});
const streamTargets = (w) => fs.readFileSync(w.sshLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((argv) => argv[0] === '-F' && argv[1] === '/dev/null')
  .map((argv) => (argv.includes('-W') ? argv[argv.indexOf('-W') + 1] : argv.at(-1).split(' ').at(-2)));

test('a real start: the trial and the open through the tunnel, calls with the rewritten string, refusals SKIPPED, nothing of the route or the port for the agent', async () => {
  const uris = {
    MGO_T_ORDERS: URI,
    MGO_T_JUMPED: 'mongodb://ops:J-pw-55@[2001:db8::5]:27017/shop',
    MGO_T_TLS: 'mongodb://ops:T-pw-66@db1.example.com/shop?TLS=true',
    MGO_T_SRV: 'mongodb+srv://ops:S-pw-77@cluster0.example.net/shop',
  };
  const w = await tunnelWorld([
    entry('orders', 'MGO_T_ORDERS'),
    entry('jumped', 'MGO_T_JUMPED', { host: 'bastion1', jumps: [JUMP] }),
    entry('tlsdb', 'MGO_T_TLS'),
    entry('srvdb', 'MGO_T_SRV'),
  ], uris);
  const run = launch(w, { all: true });
  await ready(run);
  try {
    const err = run.proc.stderr.text;
    assert.match(err, /mgo +orders +OPENING +database shop, connection string from MGO_T_ORDERS, read only, through bastion1\n/);
    assert.match(err, new RegExp(`mgo +orders +WARN +${NO_CERTIFICATE_WHY}\\n`));
    assert.match(err, /mgo +orders +UP\n/);
    assert.match(err, /mgo +jumped +SKIPPED +an IPv6 service address cannot be used with jumps\n/);
    assert.match(err, new RegExp(`mgo +tlsdb +SKIPPED +${esc(TUNNEL_REFUSALS.tls)}\\n`));
    assert.match(err, new RegExp(`mgo +srvdb +SKIPPED +${esc(TUNNEL_REFUSALS.srv)}\\n`));
    // The trial ran the doctor check through the tunnel before open: the stream went to the host of the string.
    assert.deepEqual(service.lines, ['PING']);
    assert.deepEqual(streamTargets(w), ['db1.example.com:27017']);
    const [trial] = w.client.lines();
    const match = /^mongodb:\/\/report-user:Pa55%2Fw0rd-UNMISTAKABLE-9c1d@127\.0\.0\.1:(\d+)\/shop\?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true$/.exec(trial.uri);
    assert.ok(match, trial.uri);
    const port = match[1];

    const answers = [await callTool('list_targets', {}, w.env)];
    const found = await callTool('mongodb_command', { target: 'orders', command: { find: 'orders' } }, w.env);
    answers.push(found);
    assert.equal(found.isError, false, found.text);
    assert.deepEqual(JSON.parse(found.text.split('--- stdout ---\n')[1]), { reply: 'VALUE find', ok: 1 });
    assert.equal(w.client.lines()[1].uri, trial.uri, 'the call got the same rewritten string');
    assert.deepEqual(w.client.lines()[1].argv, CLIENT_ARGS);
    w.client.mode('address');
    const failed = await callTool('mongodb_command', { target: 'orders', command: { ping: 1 } }, w.env);
    answers.push(failed);
    assert.equal(failed.text, 'exit code: 1\n--- stdout ---\n{"uri":"[hidden]","address":"[hidden]"}\n--- stderr ---\nerror: MongoServerSelectionError: connect ECONNREFUSED [hidden]; [hidden]');
    answers.push(await callTool('mongodb_command', { target: 'orders', command: { insert: 'orders' } }, w.env));
    assert.match(answers.at(-1).text, /^REFUSED/);

    const files = fs.readdirSync(w.sessionDir, { withFileTypes: true }).filter((item) => item.isFile())
      .map((item) => fs.readFileSync(path.join(w.sessionDir, item.name), 'utf8'));
    assert.ok(files.length >= 3);
    const session = JSON.parse(fs.readFileSync(path.join(w.sessionDir, 'session.json'), 'utf8'));
    assert.deepEqual(session.targets.map((t) => t.name), ['orders']);
    const audit = fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const calls = audit.filter((e) => e.event === 'call' || e.event === 'list').map((e) => JSON.stringify(e));
    assert.equal(calls.length, 4);
    const portRe = new RegExp(`(^|\\D)${port}(\\D|$)`);
    for (const text of [...files, ...answers.map((a) => a.text), ...calls]) {
      for (const part of [...ROUTE_PARTS, 'db1.example.com', '127.0.0.1', PASSWORD, PASSWORD_DECODED]) {
        assert.ok(!text.includes(part), `${part} in ${text}`);
      }
      assert.ok(!portRe.test(text), `the port in ${text}`);
    }
    // No file of the session folder or the state folder holds the port or the rewritten string.
    const everything = fs.readFileSync(w.auditLog, 'utf8');
    assert.ok(!everything.includes(trial.uri));
    assert.ok(!portRe.test(everything), 'the port in the audit log');
    // The agent's documents never reach the ssh command line: every stream, the trial's and the calls', went to the
    // host of the connection string.
    assert.ok(streamTargets(w).length >= 2);
    assert.ok(streamTargets(w).every((address) => address === 'db1.example.com:27017'), streamTargets(w).join(' '));
  } finally {
    await stopWith(run);
  }
});

test('ksproxy doctor passes on a tunnelled mongodb target, the trial and the check each with the rewritten string', async () => {
  const w = await tunnelWorld([], { MGO_T_ORDERS: URI });
  delete w.env[PROJECT_KEY];
  const dir = path.join(w.env[CONFIG_KEY], 'projects');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'shop.json'), JSON.stringify({ mongodb: [entry('orders', 'MGO_T_ORDERS')] }));
  const proc = fakeProcess();
  const code = await main(['doctor', '--project', 'shop'], w.env, { process: proc });
  assert.equal(code, 0, proc.stdout.text);
  assert.match(proc.stdout.text, /mgo +orders +OK +ping answered$/m);
  assert.match(proc.stdout.text, /1 of 1 targets OK/);
  assert.match(proc.stdout.text, new RegExp(`mgo +orders +WARN +${NO_CERTIFICATE_WHY}$`, 'm'));
  assert.deepEqual(service.lines, ['PING', 'PING']);
  const lines = w.client.lines();
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line.uri, /^mongodb:\/\/report-user:Pa55%2Fw0rd-UNMISTAKABLE-9c1d@127\.0\.0\.1:\d+\/shop\?authSource=admin&serverSelectionTimeoutMS=30000&directConnection=true$/);
  assert.ok(!/127\.0\.0\.1:\d+/.test(proc.stdout.text), 'the loopback address is not in the lines of doctor');
});
