import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { psqlInvocation } from '../src/kinds/postgres/index.js';
import mysql, { mysqlInvocation, mysqlTunnelProblem } from '../src/kinds/mysql/index.js';
import { InventoryError, tunnelRoute, validateInventory } from '../src/inventory.js';
import { NO_CERTIFICATE_WHY } from '../src/start.js';
import { callTool } from '../src/tools.js';
import { main } from '../src/cli.js';
import { startService } from './fixtures/kind-tunnelled.js';
import {
  alive, cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, trackDir, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';
import { TLS_TEXT } from './sql-fixed.js';

// postgres and mysql through a tunnel: what the client program gets with and without one, the refusals, the doctor
// check on an entry that has nothing from open (the trial at start), a real start and a real doctor with the stand-in
// programs and the fake ssh in stream mode.

const fakePsql = fileURLToPath(new URL('./fixtures/fake-psql.js', import.meta.url));
const fakeMysql = fileURLToPath(new URL('./fixtures/fake-mysql.js', import.meta.url));
const key = (name) => ['KSPROXY', name].join('_');
const PG_SECRET = 'pg-S3CR3T-5d1a90-unmistakable';
const MY_SECRET = 'my-S3CR3T-77e0c4-unmistakable';
const PG_VAR = 'SQL_TUNNEL_PG_PASSWORD';
const MY_VAR = 'SQL_TUNNEL_MY_PASSWORD';
const TUNNEL = { host: '127.0.0.1', port: 40123 };
const MARIADB_REQUIRE = 'the MariaDB client cannot require TLS without a check';
const VERIFY_REFUSAL = '"tls": "verify" cannot be used through a tunnel, because the MySQL and MariaDB clients check the certificate\'s name against the address they connect to, which is 127.0.0.1 there; write "tls": "prefer" instead and leave out "caFile", which only "verify" uses';

const pgEntry = (extra = {}) => ({
  name: 'shop', host: 'db.internal', port: 5433, database: 'shop', user: 'agent_ro', passwordEnv: PG_VAR, allow: ['regex(.*)'], ...extra,
});
const myEntry = (extra = {}) => ({
  name: 'crm', host: 'db.internal', database: 'crm', user: 'agent_ro', passwordEnv: MY_VAR, allow: ['regex(.*)'], ...extra,
});
const onePg = (extra) => validateInventory({ postgres: [pgEntry(extra)] }).postgres[0];
const oneMy = (extra) => validateInventory({ mysql: [myEntry(extra)] }).mysql[0];

test('tunnelTo: the target\'s own host and port, the default port of the kind, an IPv6 host in brackets', () => {
  assert.equal(postgres.tunnelListener, true);
  assert.equal(mysql.tunnelListener, true);
  assert.equal(postgres.tunnelTo(onePg()), 'db.internal:5433');
  assert.equal(mysql.tunnelTo(oneMy()), 'db.internal:3306');
  assert.equal(mysql.tunnelTo(oneMy({ port: 3307, host: '10.0.0.5' })), '10.0.0.5:3307');
  // A target without a port gets the default of its kind; an inventory entry always has one, so this is a direct call.
  assert.equal(postgres.tunnelTo({ host: 'db.internal' }), 'db.internal:5432');
  assert.equal(mysql.tunnelTo({ host: 'db.internal' }), 'db.internal:3306');
  assert.equal(postgres.tunnelTo({ host: '2001:db8::5', port: 5432 }), '[2001:db8::5]:5432');
  assert.equal(mysql.tunnelTo({ host: '2001:db8::5', port: 3306 }), '[2001:db8::5]:3306');
});

test('tunnelChecksCertificate: only postgres with verify, also the verify a caFile gives; never mysql', () => {
  assert.equal(postgres.tunnelChecksCertificate(onePg({ tls: 'verify' })), true);
  assert.equal(postgres.tunnelChecksCertificate(onePg({ caFile: '/ca/pg.pem' })), true);
  assert.equal(postgres.tunnelChecksCertificate(onePg({ tls: 'require' })), false);
  assert.equal(postgres.tunnelChecksCertificate(onePg({ tls: 'prefer' })), false);
  assert.equal(postgres.tunnelChecksCertificate(onePg()), false);
  for (const extra of [{ tls: 'verify' }, { caFile: '/ca/my.pem' }, { tls: 'require' }, {}]) {
    assert.equal(mysql.tunnelChecksCertificate(oneMy(extra)), false);
  }
});

test('the inventory: a route on postgres always validates; on mysql verify is refused with a way out, also the verify of a caFile', () => {
  const route = { host: 'bastion1', jumps: ['ssh -i .ssh/app_key opsuser@192.0.2.10'] };
  for (const extra of [{}, { tls: 'verify' }, { caFile: '/ca/pg.pem' }, { tls: 'require' }]) {
    const inventory = validateInventory({ postgres: [pgEntry({ ...extra, tunnel: route })] });
    assert.deepEqual(inventory.postgres[0], onePg(extra));
    assert.deepEqual(tunnelRoute(inventory, 'postgres', 'shop'), route);
  }
  assert.equal(postgres.tunnelProblem, undefined);
  for (const extra of [{}, { tls: 'prefer' }, { tls: 'require' }]) {
    const inventory = validateInventory({ mysql: [myEntry({ ...extra, tunnel: route })] });
    assert.deepEqual(inventory.mysql[0], oneMy(extra));
    assert.equal(tunnelRoute(inventory, 'mysql', 'crm').host, 'bastion1');
    assert.equal(mysqlTunnelProblem(oneMy(extra)), null);
  }
  for (const extra of [{ tls: 'verify' }, { caFile: '/ca/my.pem' }, { tls: 'verify', caFile: '/ca/my.pem', client: 'mariadb' }]) {
    assert.throws(() => validateInventory({ mysql: [myEntry({ ...extra, tunnel: { host: 'bastion1' } })] }), (err) => {
      assert.ok(err instanceof InventoryError);
      assert.equal(err.message, `mysql "crm": tunnel: ${VERIFY_REFUSAL}`);
      return true;
    });
    // Without a route the same target is fine, as before.
    assert.equal(oneMy(extra).tls, 'verify');
  }
  assert.equal(mysqlTunnelProblem(oneMy({ tls: 'verify' })), VERIFY_REFUSAL);
});

const MY_FIXED_ARGS = (hostPort) => [
  '--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10',
  ...hostPort, '--database=crm', '--user=agent_ro',
  '--init-command=SET SESSION sql_select_limit=1000; SET SESSION TRANSACTION READ ONLY',
];

test('psqlInvocation: without a tunnel it is what it was; with one only the port and PGHOSTADDR differ, and --host stays the real name', () => {
  const settings = { password: 'pw-made-up', timeoutMs: 7000 };
  const plain = psqlInvocation(onePg(), 'select 1', settings);
  const fixed = (port) => [
    '--no-psqlrc', '--quiet', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'FETCH_COUNT=1000', '--pset', 'footer=off', '--single-transaction',
    '--host', 'db.internal', '--port', String(port), '--dbname', 'shop', '--username', 'agent_ro', '--no-password',
    '--command', 'SET TRANSACTION READ ONLY', '--command', 'SET LOCAL statement_timeout = 7000',
    '--command', 'SET LOCAL standard_conforming_strings = on', '--command',
  ];
  const env = {
    PGPASSWORD: 'pw-made-up',
    PGCONNECT_TIMEOUT: '10',
    PGAPPNAME: 'ksproxy',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=7000 -c standard_conforming_strings=on',
    PGSSLMODE: 'prefer',
  };
  assert.deepEqual(plain, {
    fixedArgs: fixed(5433), words: ['select 1'], childEnv: env,
  });
  assert.deepEqual(Object.keys(plain.childEnv), Object.keys(env));
  const through = psqlInvocation(onePg(), 'select 1', { ...settings, tunnel: TUNNEL });
  assert.deepEqual(through, {
    fixedArgs: fixed(40123), words: ['select 1'], childEnv: { ...env, PGHOSTADDR: '127.0.0.1' },
  });
  const verified = psqlInvocation(onePg({ caFile: '/ca/pg.pem' }), 'select 1', { ...settings, tunnel: TUNNEL });
  assert.equal(verified.childEnv.PGSSLMODE, 'verify-full');
  assert.equal(verified.childEnv.PGSSLROOTCERT, '/ca/pg.pem');
  assert.equal(verified.childEnv.PGHOSTADDR, '127.0.0.1');
  assert.ok(verified.fixedArgs.includes('db.internal') && !verified.fixedArgs.includes('127.0.0.1'));
});

test('mysqlInvocation: without a tunnel it is what it was; with one the client gets --host=127.0.0.1, the tunnel port and --protocol=TCP', () => {
  const plain = mysqlInvocation(oneMy(), 'select 1', { password: 'pw-made-up' });
  assert.deepEqual(plain, {
    fixedArgs: MY_FIXED_ARGS(['--host=db.internal', '--port=3306']),
    words: ['--execute=select 1'],
    childEnv: { MYSQL_PWD: 'pw-made-up' },
    folderPaths: { MYSQL_TEST_LOGIN_FILE: 'no-login-file.cnf' },
  });
  const through = mysqlInvocation(oneMy(), 'select 1', { password: 'pw-made-up', tunnel: TUNNEL });
  assert.deepEqual(through, {
    ...plain, fixedArgs: MY_FIXED_ARGS(['--host=127.0.0.1', '--port=40123', '--protocol=TCP']),
  });
  assert.ok(!through.fixedArgs.includes('--host=db.internal'));
  const required = mysqlInvocation({ ...oneMy({ tls: 'require' }), family: 'mysql' }, 'select 1', { password: 'p', tunnel: TUNNEL });
  assert.ok(required.fixedArgs.includes('--ssl-mode=REQUIRED'));
});

// A temporary home, state folder and PATH: mysql and mariadb are the stand-in; script() makes a client of a few
// lines of shell. The client programs of the tests that follow write what they got to a file.
function world() {
  const base = fs.realpathSync(tempDir('ks-sqltun-'));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['mysql', 'mariadb']) fs.symlinkSync(fakeMysql, path.join(bin, name));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: base, KSPROXY_PSQL: fakePsql, KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
  };
  const log = path.join(base, 'got.log');
  const secrets = { [PG_VAR]: 'pw-pg-made-up-0000', [MY_VAR]: 'pw-my-made-up-0000' };
  const version = "if [ \"$1\" = --version ]; then echo 'mysql  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)'; echo v >> '" + path.join(base, 'versions') + "'; exit 0; fi";
  const w = {
    base,
    env,
    log,
    secrets,
    versions: () => (fs.existsSync(path.join(base, 'versions')) ? fs.readFileSync(path.join(base, 'versions'), 'utf8').trim().split('\n').length : 0),
    script(name, body) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    },
    // A psql and a mysql that write their arguments and the variables that matter to the file; mysql also says MySQL.
    clients() {
      return {
        psql: w.script('psql-got', `printf '%s\\n' "$@" "PGHOSTADDR=\${PGHOSTADDR-unset}" "PGSSLMODE=$PGSSLMODE" > '${log}'`),
        mysql: w.script('mysql-got', `${version}\nprintf '%s\\n' "$@" > '${log}'`),
      };
    },
    got: () => fs.readFileSync(log, 'utf8').trim().split('\n'),
    ctx: (extra = {}) => ({
      env: { ...env, ...extra }, secrets, timeoutMs: 10000, signal: new AbortController().signal, say: () => {},
    }),
  };
  return w;
}

test('doctor on an entry without extras (the trial before open) finds the program and the family itself', async () => {
  const w = world();
  const { psql, mysql: my } = w.clients();
  const OK = { ok: true, detail: 'select 1 answered' };
  const trial = (kind, target, extra = {}) => ({ kind: kind.key, target, ...extra });
  // postgres: the program is the one the kind finds; the address and port are the tunnel's, --host the real name.
  assert.deepEqual(await postgres.doctor(trial(postgres, onePg()), w.ctx({ KSPROXY_PSQL: psql })), OK);
  assert.equal(w.got().at(-2), 'PGHOSTADDR=unset');
  assert.ok(w.got().includes('5433'));
  const tunnelled = { ...trial(postgres, onePg({ tls: 'require' })), tunnel: TUNNEL };
  assert.deepEqual(await postgres.doctor(tunnelled, w.ctx({ KSPROXY_PSQL: psql })), OK);
  const pg = w.got();
  assert.deepEqual(pg.slice(-2), ['PGHOSTADDR=127.0.0.1', 'PGSSLMODE=require']);
  assert.equal(pg[pg.indexOf('--port') + 1], '40123');
  assert.equal(pg[pg.indexOf('--host') + 1], 'db.internal');
  // mysql prefer: the family is not needed, so the client is not asked for its version.
  assert.deepEqual(await mysql.doctor({ ...trial(mysql, oneMy()), tunnel: TUNNEL }, w.ctx({ KSPROXY_MYSQL: my })), OK);
  assert.equal(w.versions(), 0);
  assert.deepEqual(w.got().slice(0, 3), ['--no-defaults', '--batch', '--quick'].slice(0, 3));
  assert.ok(w.got().includes('--host=127.0.0.1') && w.got().includes('--port=40123') && w.got().includes('--protocol=TCP'));
  // mysql require: the family is learned once, from the client's version, and the TLS option is the MySQL client's.
  assert.deepEqual(await mysql.doctor({ ...trial(mysql, oneMy({ tls: 'require' })), tunnel: TUNNEL }, w.ctx({ KSPROXY_MYSQL: my })), OK);
  assert.equal(w.versions(), 1);
  assert.ok(w.got().includes('--ssl-mode=REQUIRED'));
  // An entry that open made has both, and nothing is asked again.
  const made = { ...trial(mysql, oneMy({ tls: 'require' }), { program: my, family: 'mysql' }), tunnel: TUNNEL };
  assert.deepEqual(await mysql.doctor(made, w.ctx()), OK);
  assert.equal(w.versions(), 1);
  const noTunnel = trial(mysql, oneMy({ tls: 'require' }), { program: my, family: 'mysql' });
  assert.deepEqual(await mysql.doctor(noTunnel, w.ctx()), OK);
  assert.ok(w.got().includes('--host=db.internal') && !w.got().includes('--protocol=TCP'));
});

test('doctor on an entry without extras: a program that is missing, a family that cannot be learned, and the MariaDB client with require', async () => {
  const w = world();
  const trial = (target) => ({ kind: target.kind, target, tunnel: TUNNEL });
  const missing = await postgres.doctor(trial(onePg()), w.ctx({ KSPROXY_PSQL: '/nonexistent/psql' }));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /psql/);
  const broken = w.script('mysql-broken', 'exit 1');
  // A family that cannot be learned, or the MariaDB client with require, gives the way out that open says.
  assert.deepEqual(await mysql.doctor(trial(oneMy({ tls: 'require' })), w.ctx({ KSPROXY_MYSQL: broken })), { ok: false, detail: `could not run ${broken} --version`, wayOut: TLS_TEXT.VERSION_WAY(broken) });
  // Through a tunnel verify cannot be used, so the way out of the MariaDB client with require names only prefer.
  assert.deepEqual(await mysql.doctor(trial(oneMy({ tls: 'require', client: 'mariadb' })), w.ctx()), { ok: false, detail: MARIADB_REQUIRE, wayOut: TLS_TEXT.MARIADB_TUNNEL_WAY });
  const untunnelled = { kind: 'mysql', target: oneMy({ tls: 'require', client: 'mariadb' }) };
  assert.deepEqual(await mysql.doctor(untunnelled, w.ctx()), { ok: false, detail: MARIADB_REQUIRE, wayOut: TLS_TEXT.MARIADB_WAY });
  // open with a tunnel in its context says the same way out.
  const said = [];
  const opened = await mysql.open(oneMy({ tls: 'require', client: 'mariadb' }), { ...w.ctx(), say: (text) => said.push(text), tunnel: TUNNEL });
  assert.deepEqual([opened, said], [{ ok: false, error: MARIADB_REQUIRE }, [TLS_TEXT.MARIADB_TUNNEL_WAY]]);
  // A caFile that cannot be read: the trial says what open says, with no way out, and runs no client. An entry that
  // open made is not checked again.
  const { psql } = w.clients();
  const gone = path.join(w.base, 'gone.pem');
  assert.deepEqual(
    await postgres.doctor(trial(onePg({ caFile: gone })), w.ctx({ KSPROXY_PSQL: psql })),
    { ok: false, detail: `caFile ${gone} is not a file that can be read` },
  );
  assert.equal(fs.existsSync(w.log), false, 'no client ran');
  const made = { ...trial(onePg({ caFile: gone })), program: psql };
  assert.deepEqual(await postgres.doctor(made, w.ctx()), { ok: true, detail: 'select 1 answered' });
  assert.equal(fs.existsSync(w.log), true);
  // A failure of the client itself is its verdict, as before.
  const refused = w.script('psql-refused', 'echo "psql: error: connection to server at db port 5432 failed: Connection refused" >&2\nexit 2');
  const answer = await postgres.doctor(trial(onePg()), w.ctx({ KSPROXY_PSQL: refused }));
  assert.equal(answer.ok, false);
});

test('the trial through a tunnel names a TLS failure as open does: the fixed reason and the way out', async () => {
  const w = world();
  const trial = (target) => ({ kind: target.kind, target, tunnel: TUNNEL });
  const pg = (extra) => postgres.doctor(trial(onePg(extra)), w.ctx());
  // The stand-in psql fails by the real host name, which --host keeps through a tunnel.
  const bad = 'bad-cert.example.com';
  assert.deepEqual(await pg({ host: bad, tls: 'verify' }), { ok: false, detail: TLS_TEXT.CERT, wayOut: TLS_TEXT.SYSTEM_WAY(bad) });
  for (const tls of ['require', 'verify']) {
    assert.deepEqual(await pg({ host: 'no-tls.example.com', tls }), { ok: false, detail: TLS_TEXT.NO_TLS, wayOut: TLS_TEXT.NONE_WAY(tls) });
  }
  // A real psql through a tunnel names the loopback address and port in its text; the failure is still found.
  const loopback = (name, why) => w.script(name, `echo 'psql: error: connection to server at "db.internal" (127.0.0.1), port 40123 failed: ${why}' >&2\nexit 2`);
  const noTls = loopback('psql-no-tls', 'server does not support SSL, but SSL was required');
  const certFailed = loopback('psql-cert', 'SSL error: certificate verify failed');
  const down = loopback('psql-down', 'server closed the connection unexpectedly');
  const wrong = loopback('psql-wrong', 'FATAL:  password authentication failed for user "agent_ro"');
  const through = (program, extra) => postgres.doctor(trial(onePg(extra)), w.ctx({ KSPROXY_PSQL: program }));
  assert.deepEqual(await through(noTls, { tls: 'require' }), { ok: false, detail: TLS_TEXT.NO_TLS, wayOut: TLS_TEXT.NONE_WAY('require') });
  const verified = await through(certFailed, { tls: 'verify' });
  assert.deepEqual(verified, { ok: false, detail: TLS_TEXT.CERT, wayOut: TLS_TEXT.SYSTEM_WAY('db.internal') });
  // The way out names the fields and the host name of the target, never the loopback address or port of the tunnel.
  assert.ok(!verified.wayOut.includes('127.0.0.1') && !verified.wayOut.includes('40123'), verified.wayOut);
  // mysql with require against a server without TLS: the same reason and its way out.
  const version = "if [ \"$1\" = --version ]; then echo 'mysql  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)'; exit 0; fi";
  const myNoTls = w.script('mysql-no-tls', `${version}\necho "ERROR 2026 (HY000): SSL connection error: SSL is required but the server doesn't support it" >&2\nexit 1`);
  assert.deepEqual(
    await mysql.doctor(trial(oneMy({ tls: 'require' })), w.ctx({ KSPROXY_MYSQL: myNoTls })),
    { ok: false, detail: TLS_TEXT.NO_TLS, wayOut: TLS_TEXT.NONE_WAY('require') },
  );
  // prefer checks nothing: a server that is down is the client's verdict, with no way out; so is verify when the text
  // is not about TLS.
  assert.deepEqual(await through(down, { tls: 'prefer' }), { ok: false, detail: 'could not connect' });
  assert.deepEqual(await through(noTls, { tls: 'prefer' }), { ok: false, detail: 'could not connect' });
  assert.deepEqual(await through(down, { tls: 'verify' }), { ok: false, detail: 'could not connect' });
  // A wrong password on verify: the verdict of the client as before, with no way out.
  assert.deepEqual(await through(wrong, { tls: 'verify' }), { ok: false, detail: 'authentication failed' });
  // An answer on verify is the answer.
  assert.deepEqual(await pg({ tls: 'verify' }), { ok: true, detail: 'select 1 answered' });
  // With require a text that names a certificate is the client's own verdict, with no way out.
  const clientCert = loopback('psql-client-cert', 'FATAL:  connection requires a valid client certificate');
  assert.deepEqual(await through(clientCert, { tls: 'require' }), { ok: false, detail: 'could not connect' });
  // A client that printed a certificate failure and was then stopped: the usual verdict, never a TLS reason.
  const started = path.join(w.base, 'started');
  const slowCert = w.script('psql-slow-cert', `echo 'SSL error: certificate verify failed' >&2\necho up > '${started}'\nexec sleep 60`);
  const stop = new AbortController();
  const asking = postgres.doctor(trial(onePg({ tls: 'verify' })), { ...w.ctx({ KSPROXY_PSQL: slowCert }), signal: stop.signal });
  await waitFor(() => fs.existsSync(started), 5000, 'the client to start');
  stop.abort();
  assert.deepEqual(await asking, { ok: false, detail: 'stopped' });
  // The time limit: the same, timed out.
  const timed = await postgres.doctor(trial(onePg({ tls: 'verify' })), { ...w.ctx({ KSPROXY_PSQL: slowCert }), timeoutMs: 300 });
  assert.deepEqual(timed, { ok: false, detail: 'timed out' });
});

test('open and perform: the TLS check and a call get the tunnel; without one nothing changes', async () => {
  const w = world();
  const { psql, mysql: my } = w.clients();
  const ctx = (extra, tunnel) => ({ ...w.ctx(extra), ...(tunnel === undefined ? {} : { tunnel }) });
  // open runs the TLS check through the tunnel of its context.
  const pgOpen = await postgres.open(onePg({ tls: 'require' }), ctx({ KSPROXY_PSQL: psql }, TUNNEL));
  assert.deepEqual(pgOpen, { ok: true, extras: { program: psql } });
  let got = w.got();
  assert.deepEqual(got.slice(-2), ['PGHOSTADDR=127.0.0.1', 'PGSSLMODE=require']);
  assert.equal(got[got.indexOf('--port') + 1], '40123');
  await postgres.open(onePg({ tls: 'require' }), ctx({ KSPROXY_PSQL: psql }));
  assert.equal(w.got().at(-2), 'PGHOSTADDR=unset');
  assert.equal(w.got()[w.got().indexOf('--port') + 1], '5433');
  const myOpen = await mysql.open(oneMy({ tls: 'require' }), ctx({ KSPROXY_MYSQL: my }, TUNNEL));
  assert.deepEqual(myOpen, { ok: true, extras: { program: my, family: 'mysql' } });
  assert.ok(w.got().includes('--host=127.0.0.1') && w.got().includes('--port=40123') && w.got().includes('--protocol=TCP'));
  await mysql.open(oneMy({ tls: 'require' }), ctx({ KSPROXY_MYSQL: my }));
  assert.ok(w.got().includes('--host=db.internal') && !w.got().includes('--protocol=TCP'));
  // perform gets the tunnel from the opened entry, which is not the recorded target.
  const decision = (words) => ({ allowed: true, argv: words });
  const call = (kind, target, program, opened) => kind.perform({ ...target, program }, decision(['select', '1']), {
    env: w.env, secrets: w.secrets, timeoutMs: 5000, maxBytes: 100000, signal: new AbortController().signal, input: 'select 1', opened,
  });
  assert.equal((await call(postgres, onePg(), psql, { tunnel: TUNNEL })).exitCode, 0);
  got = w.got();
  assert.equal(got.at(-2) === undefined, false);
  assert.deepEqual(got.slice(-2), ['PGHOSTADDR=127.0.0.1', 'PGSSLMODE=prefer']);
  assert.equal(got[got.indexOf('--port') + 1], '40123');
  await call(postgres, onePg(), psql, {});
  assert.equal(w.got().at(-2), 'PGHOSTADDR=unset');
  await call(postgres, onePg(), psql, undefined);
  assert.equal(w.got()[w.got().indexOf('--port') + 1], '5433');
  await call(mysql, oneMy(), my, { tunnel: TUNNEL });
  assert.ok(w.got().includes('--host=127.0.0.1') && w.got().includes('--protocol=TCP') && w.got().includes('--execute=select 1'));
  await call(mysql, oneMy(), my, {});
  assert.ok(w.got().includes('--host=db.internal') && w.got().includes('--port=3306'));
});

// ---- A real start and a real doctor, through the fake ssh in stream mode ----

const PORT_KEY = key('FAKE_SSH_STREAM_PORT');
const LOG_KEY = key('FAKE_SSH_LOG');
const PID_KEY = key('FAKE_SSH_PID_LOG');
const HEALTH_KEY = key('HEALTH_MS');
const service = await startService();
after(async () => {
  cleanupAll();
  await service.close();
});

const ROUTE = { host: 'bastion1', jumps: ['ssh -i .ssh/app_key opsuser@192.0.2.10'] };
const ROUTE_PARTS = ['bastion1', 'app_key', 'opsuser', '192.0.2.10', 'tunnel'];
const pgTunnelled = (name, extra = {}) => ({
  ...pgEntry({ name, allow: ['select ...'] }), tunnel: ROUTE, ...extra,
});
const myTunnelled = (name, extra = {}) => ({
  ...myEntry({ name, allow: ['select ...'] }), tunnel: { host: 'bastion1' }, ...extra,
});

async function sqlTunnelWorld({ postgres: pgs, mysql: mys }) {
  const home = fs.realpathSync(tempDir('ks-sqlth-'));
  trackDir(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['mysql', 'mariadb']) fs.symlinkSync(fakeMysql, path.join(bin, name));
  const w = await makeWorld({
    ssh: [],
    extraEnv: {
      [PG_VAR]: PG_SECRET, [MY_VAR]: MY_SECRET, HOME: home, PATH: `${bin}:${process.env.PATH}`, KSPROXY_PSQL: fakePsql, [PORT_KEY]: String(service.port), [HEALTH_KEY]: '600000', NO_COLOR: '1',
    },
  });
  w.log = path.join(w.base, 'calls.log');
  w.env[LOG_KEY] = w.log;
  w.env[PID_KEY] = path.join(w.base, 'pids');
  const file = path.join(w.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), postgres: pgs, mysql: mys }));
  w.starts = () => {
    const starts = path.join(home, 'sql-starts.log');
    return fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split('\n').length : 0;
  };
  w.agentEnv = { ...w.env };
  delete w.agentEnv[PG_VAR];
  delete w.agentEnv[MY_VAR];
  return w;
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const reportOf = (reply) => JSON.parse(reply.text.split('\n--- stdout ---\n')[1]);
const auditOf = (w) => fs.readFileSync(w.auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const pidsOf = (w) => (fs.existsSync(w.env[PID_KEY]) ? fs.readFileSync(w.env[PID_KEY], 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);

test('a real start: postgres and mysql targets behind a tunnel open (trial, then open); a call gets the tunnel; nothing of the route or the port is shown', async () => {
  const w = await sqlTunnelWorld({
    postgres: [pgTunnelled('shop'), pgTunnelled('sec', { tls: 'require' }), pgTunnelled('ver', { tls: 'verify' })],
    mysql: [myTunnelled('crm'), myTunnelled('crm2', { tls: 'require' })],
  });
  const run = launch(w, { pg: ['shop', 'sec', 'ver'], mysql: ['crm', 'crm2'] });
  await ready(run);
  try {
    const err = run.proc.stderr.text;
    for (const name of ['shop', 'sec', 'ver']) assert.match(err, new RegExp(`pg +${name} +UP|pg +${name} +OPENING`));
    assert.match(err, /pg +shop +OPENING +agent_ro@db\.internal:5433\/shop, read-only, TLS prefer, through bastion1, then 1 jump\n/);
    assert.match(err, /my +crm +OPENING +agent_ro@db\.internal:3306\/crm, read-only, TLS prefer, through bastion1\n/);
    assert.equal(/SKIPPED/.test(err), false, err);
    // The trial runs one select 1 for each target (postgres and mysql prefer need nothing else); require and verify
    // check TLS again when they open, and mysql reads its version for each of the two runs.
    // shop 1, sec 2, ver 2, crm 1, crm2 2 + 2 versions for the trial and the open.
    assert.equal(w.starts(), 1 + 2 + 2 + 1 + 4);
    // One WARN for each target that does not check a certificate: all but ver.
    const warned = auditOf(w).filter((e) => e.event === 'target_warn' && e.message === NO_CERTIFICATE_WHY).map((e) => e.target);
    assert.deepEqual(warned, ['shop', 'sec', 'crm', 'crm2']);

    const pg = reportOf(await callTool('postgres_query', { target: 'shop', query: 'select * from orders' }, w.agentEnv));
    const port = pg.argv[pg.argv.indexOf('--port') + 1];
    assert.notEqual(port, '5433');
    assert.match(port, /^\d+$/);
    assert.equal(pg.argv[pg.argv.indexOf('--host') + 1], 'db.internal');
    assert.equal(pg.env.PGHOSTADDR, '127.0.0.1');
    assert.equal(pg.env.PGPASSWORD, '[hidden]');
    const my = reportOf(await callTool('mysql_query', { target: 'crm', query: 'select * from orders' }, w.agentEnv));
    assert.ok(my.argv.includes('--host=127.0.0.1') && my.argv.includes('--protocol=TCP'));
    const myPort = my.argv.find((arg) => arg.startsWith('--port=')).slice('--port='.length);
    assert.notEqual(port, myPort, 'each target has its own listener');
    assert.ok(!my.argv.includes('--host=db.internal'));

    // A failing call, whose answer does not show the arguments, the list of targets, and then every file and entry.
    const failed = [
      await callTool('postgres_query', { target: 'shop', query: 'select fail' }, w.agentEnv),
      await callTool('mysql_query', { target: 'crm', query: 'select fail' }, w.agentEnv),
      await callTool('list_targets', {}, w.agentEnv),
    ];
    assert.match(failed[0].text, /relation "fail" does not exist/);
    const files = fs.readdirSync(w.sessionDir, { withFileTypes: true }).filter((item) => item.isFile())
      .map((item) => fs.readFileSync(path.join(w.sessionDir, item.name), 'utf8'));
    assert.ok(files.length >= 3);
    // The lines of start in the audit log may name the first server (the owner's file); the entries of calls never do.
    const calls = auditOf(w).filter((e) => e.event === 'call' || e.event === 'list');
    assert.equal(calls.length, 5);
    const lifecycle = auditOf(w).map((e) => JSON.stringify(e));
    for (const text of [...files, ...failed.map((a) => a.text), ...calls.map((e) => JSON.stringify(e))]) {
      for (const part of ROUTE_PARTS) assert.ok(!text.includes(part), `${part} in ${text}`);
    }
    for (const text of [...files, ...failed.map((a) => a.text), ...lifecycle]) {
      for (const used of [port, myPort]) assert.ok(!new RegExp(`(^|\\D)${used}(\\D|$)`).test(text), `the port in ${text}`);
    }
    assert.ok(files.some((text) => text.includes('postgres_query')), 'the agent file names the tools');
  } finally {
    await stopWith(run);
  }
  await waitFor(() => pidsOf(w).every((pid) => !alive(pid)), 10000, 'every ssh to end');
});

test('a real doctor: tunnelled postgres and mysql targets pass, through the same open path', async () => {
  const w = await sqlTunnelWorld({
    postgres: [pgTunnelled('shop'), pgTunnelled('ver', { tls: 'verify' })],
    mysql: [myTunnelled('crm'), myTunnelled('crm2', { tls: 'require' })],
  });
  const proc = fakeProcess();
  const code = await main(['doctor', '--pg', 'shop,ver', '--mysql', 'crm,crm2'], w.env, { process: proc });
  assert.equal(code, 0, proc.stdout.text);
  for (const [label, name] of [['pg', 'shop'], ['pg', 'ver'], ['my', 'crm'], ['my', 'crm2']]) {
    assert.match(proc.stdout.text, new RegExp(`${label} +${name} +OK +select 1 answered\\n`));
  }
  assert.equal(proc.stdout.text.match(new RegExp(NO_CERTIFICATE_WHY, 'g')).length, 3);
  assert.equal(new RegExp(`pg +ver +WARN +${NO_CERTIFICATE_WHY}`).test(proc.stdout.text), false);
  assert.match(proc.stdout.text, /4 of 4 targets OK/);
  await waitFor(() => pidsOf(w).every((pid) => !alive(pid)), 10000, 'every ssh to end');
});

test('a real doctor: a TLS failure through a tunnel is named as without one, once, with its way out before SKIPPED and FAIL', async () => {
  const bad = 'bad-cert.example.com';
  const w = await sqlTunnelWorld({
    postgres: [
      pgTunnelled('tbad', { host: bad, tls: 'verify' }),
      pgEntry({ name: 'pbad', host: bad, tls: 'verify', allow: ['select ...'] }),
    ],
    mysql: [myTunnelled('maria', { tls: 'require', client: 'mariadb' })],
  });
  const proc = fakeProcess();
  const code = await main(['doctor', '--pg', 'tbad,pbad', '--mysql', 'maria'], w.env, { process: proc });
  assert.equal(code, 1, proc.stdout.text);
  const lines = proc.stdout.text.split('\n');
  for (const [label, name, reason, wayOut] of [
    ['pg', 'tbad', TLS_TEXT.CERT, TLS_TEXT.SYSTEM_WAY(bad)],
    ['pg', 'pbad', TLS_TEXT.CERT, TLS_TEXT.SYSTEM_WAY(bad)],
    ['my', 'maria', TLS_TEXT.MARIADB_REQUIRE, TLS_TEXT.MARIADB_TUNNEL_WAY],
  ]) {
    const at = (re) => lines.map((line, i) => (re.test(line) ? i : -1)).filter((i) => i !== -1);
    const ways = at(new RegExp(`^\\S+ +${label} +${name} +${escaped(wayOut)}$`));
    const skipped = at(new RegExp(`^\\S+ +${label} +${name} +SKIPPED +${escaped(reason)}$`));
    const failed = at(new RegExp(`^\\S+ +${label} +${name} +FAIL +${escaped(reason)}$`));
    assert.equal(ways.length, 1, `${name}:\n${proc.stdout.text}`);
    assert.equal(skipped.length, 1, `${name}:\n${proc.stdout.text}`);
    assert.equal(failed.length, 1, `${name}:\n${proc.stdout.text}`);
    assert.ok(ways[0] < skipped[0] && skipped[0] < failed[0], proc.stdout.text);
    // The way out names neither the route nor a loopback address or port; the word tunnel is not the route, and
    // the way out of the MariaDB client through a tunnel says why verify cannot be used there.
    for (const part of [...ROUTE_PARTS.filter((p) => p !== 'tunnel'), '127.0.0.1']) assert.ok(!lines[ways[0]].includes(part), lines[ways[0]]);
    assert.ok(!/\d{4,}/.test(lines[ways[0]].replace(/^\S+/, '')), lines[ways[0]]);
  }
  assert.equal(/did not answer through the tunnel/.test(proc.stdout.text), false, proc.stdout.text);
  assert.match(proc.stdout.text, /0 of 3 targets OK/);
  await waitFor(() => pidsOf(w).every((pid) => !alive(pid)), 10000, 'every ssh to end');
});
