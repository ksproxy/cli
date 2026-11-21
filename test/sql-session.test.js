import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callTool } from '../src/tools.js';
import { main } from '../src/cli.js';
import { MY_FIXED, PG_FIXED } from './sql-fixed.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, trackDir, waitFor,
} from './start-helpers.js';

const fakePsql = fileURLToPath(new URL('./fixtures/fake-psql.js', import.meta.url));
const fakeMysql = fileURLToPath(new URL('./fixtures/fake-mysql.js', import.meta.url));
const PG_SECRET = 'pg-S3CR3T-71c3aa-unmistakable';
const MY_SECRET = 'my-S3CR3T-0d94f2-unmistakable';
const PG_VAR = 'SQL_TEST_PG_PASSWORD';
const MY_VAR = 'SQL_TEST_MY_PASSWORD';
const STAR = '"*" matches one value here (a number or a quoted string); write \\* for the SQL star';
const WIDE = 'this pattern can match more than one word: a part that can match a quote, or a space and other characters (".", "\\S", "\\W", "[\\s\\S]", "[a-z ]" or a group holding one), repeated with no upper bound ("*", "+", "{n,}"), and a "[^...]" class that does not leave out \', also match spaces and quotes, so \'.*\' can match a string and the SQL after it; write \'[^\']*\' for one quoted string';
const PSQL_FIXED = (port, database, timeoutMs, readOnly = true) => [
  '--no-psqlrc', '--quiet', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'FETCH_COUNT=1000', '--pset', 'footer=off', '--single-transaction',
  '--host', 'db.internal', '--port', String(port), '--dbname', database, '--username', 'agent_ro', '--no-password',
  ...(readOnly ? ['--command', 'SET TRANSACTION READ ONLY'] : []), '--command', `SET LOCAL statement_timeout = ${timeoutMs}`,
  '--command', 'SET LOCAL standard_conforming_strings = on', '--command',
];

const providers = [];
after(async () => {
  cleanupAll();
  for (const server of providers) {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
});

async function provider() {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const content = JSON.stringify({ verdict: 'allow', certainty: 'sure', reason: 'fine' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  providers.push(server);
  return { asked, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const pgTarget = (extra) => ({
  name: 'shop', host: 'db.internal', port: 5433, database: 'shop', user: 'agent_ro', passwordEnv: PG_VAR, description: 'shop stand-in',
  allow: ['select \\* from orders where id = *', 'select * from orders', 'regex(.*)'], ...extra,
});
const myTarget = (extra) => ({
  name: 'crm', host: 'db.internal', database: 'crm', user: 'agent_ro', passwordEnv: MY_VAR, allow: ['regex(.*)'], ...extra,
});

// A world whose PATH finds the fake mysql and mariadb, whose KSPROXY_PSQL names the fake psql, and whose HOME holds
// the log of client starts.
async function sqlWorld({ postgres, mysql, reviewer }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'ks-sqlh-')));
  trackDir(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(fakeMysql, path.join(bin, 'mysql'));
  fs.symlinkSync(fakeMysql, path.join(bin, 'mariadb'));
  const world = await makeWorld({
    extraEnv: {
      [PG_VAR]: PG_SECRET, [MY_VAR]: MY_SECRET, HOME: home, PATH: `${bin}:${process.env.PATH}`, KSPROXY_PSQL: fakePsql,
    },
  });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(inventory, { postgres, mysql });
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.starts = () => {
    const log = path.join(home, 'sql-starts.log');
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  };
  world.agentEnv = { ...world.env };
  delete world.agentEnv[PG_VAR];
  delete world.agentEnv[MY_VAR];
  return world;
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

const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const reportOf = (reply) => JSON.parse(reply.text.split('\n--- stdout ---\n')[1]);

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

test('a session with postgres and mysql targets: the exact call, every fixed refusal before any start, limits, notes, no secret anywhere', async () => {
  const world = await sqlWorld({
    postgres: [pgTarget(), pgTarget({ name: 'rw', database: 'shop2', readOnly: false, allow: ['regex(.*)'] })],
    mysql: [myTarget(), myTarget({ name: 'maria', client: 'mariadb', readOnly: false, allow: ['select ...'] })],
  });
  const run = launch(world, { pg: ['shop', 'rw'], mysql: ['crm', 'maria'] });
  await ready(run);
  const err = run.proc.stderr.text;
  assert.match(err, /pg +shop +WARN +allow\[1\]: "\*" matches one value here \(a number or a quoted string\); write \\\* for the SQL star\n/);
  assert.equal(err.match(/matches one value here/g).length, 1);
  assert.match(err, /pg +shop +OPENING +agent_ro@db\.internal:5433\/shop, read-only\n/);
  assert.match(err, /pg +rw +OPENING +agent_ro@db\.internal:5433\/shop2, read-write\n/);
  assert.match(err, /my +crm +OPENING +agent_ro@db\.internal:3306\/crm, read-only\n/);
  assert.match(err, /my +maria +UP\n/);
  const replies = [];
  const ask = async (tool, args) => {
    const reply = await callTool(tool, args, world.agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const statement = "SELECT * FROM orders WHERE id = 5;";
  const shop = await ask('postgres_query', { target: 'shop', query: statement });
  assert.equal(shop.isError, false, shop.text);
  const pgReport = reportOf(shop);
  assert.equal(pgReport.client, 'psql');
  assert.deepEqual(pgReport.argv, [...PSQL_FIXED(5433, 'shop', 60000), statement]);
  const pgKeys = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PGPASSWORD', 'PGCONNECT_TIMEOUT', 'PGAPPNAME', 'PGOPTIONS'];
  // macOS adds __CF_USER_TEXT_ENCODING to the environment of every process it starts, and the coverage run of node
  // adds NODE_V8_COVERAGE to every node process; neither comes from ksproxy.
  const childKeys = (env) => Object.keys(env).filter((key) => !['__CF_USER_TEXT_ENCODING', 'NODE_V8_COVERAGE'].includes(key));
  assert.ok(childKeys(pgReport.env).every((key) => pgKeys.includes(key)), Object.keys(pgReport.env).join(' '));
  assert.deepEqual([pgReport.env.PGPASSWORD, pgReport.env.PGCONNECT_TIMEOUT, pgReport.env.PGAPPNAME, pgReport.env.PGOPTIONS],
    ['[hidden]', '10', 'ksproxy', '-c default_transaction_read_only=on -c statement_timeout=60000 -c standard_conforming_strings=on']);
  assert.ok(Object.keys(pgReport.env).every((key) => !key.startsWith('KSPROXY_') && key !== PG_VAR && key !== MY_VAR));

  const rw = reportOf(await ask('postgres_query', { target: 'rw', query: 'delete from t', timeout_seconds: 7 }));
  assert.equal(rw.env.PGOPTIONS, '-c statement_timeout=7000 -c standard_conforming_strings=on');
  assert.deepEqual(rw.argv, [...PSQL_FIXED(5433, 'shop2', 7000, false), 'delete from t']);

  const crm = reportOf(await ask('mysql_query', { target: 'crm', query: "select `Name` from people where note = 'a -- b'" }));
  assert.equal(crm.client, 'mysql');
  assert.deepEqual(crm.argv, [
    '--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10', '--host=db.internal',
    '--port=3306', '--database=crm', '--user=agent_ro', '--init-command=SET SESSION sql_select_limit=1000; SET SESSION TRANSACTION READ ONLY',
    "--execute=select `Name` from people where note = 'a -- b'",
  ]);
  assert.equal(crm.env.MYSQL_PWD, '[hidden]');
  // The reply shows the state folder as <ksproxy>: the login file is named inside the call's working folder.
  assert.match(crm.env.MYSQL_TEST_LOGIN_FILE, /^<ksproxy>\/run\/cmd-[A-Za-z0-9]+\/no-login-file\.cnf$/);
  assert.deepEqual(fs.readdirSync(path.join(world.base, 'st', 'run')), [], 'the working folder is gone');
  assert.ok(childKeys(crm.env).every((key) => ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'MYSQL_PWD', 'MYSQL_TEST_LOGIN_FILE'].includes(key)));
  const maria = reportOf(await ask('mysql_query', { target: 'maria', query: 'select 1' }));
  assert.equal(maria.client, 'mariadb');
  assert.equal(maria.argv.at(-2), '--init-command=SET SESSION sql_select_limit=1000');
  assert.equal(world.starts().length, 4);

  for (const [query, short] of PG_FIXED) {
    const reply = await ask('postgres_query', { target: 'shop', query });
    assert.equal(reply.isError, true, query);
    assert.match(reply.text, /^REFUSED \(postgres shop\): /, query);
    assert.equal((await ask('postgres_query', { target: 'rw', query })).isError, true, `${query} ${short}`);
  }
  for (const [query] of MY_FIXED) {
    assert.match((await ask('mysql_query', { target: 'crm', query })).text, /^REFUSED \(mysql crm\): /, query);
  }
  for (const [tool, target, query, text] of [
    ['postgres_query', 'shop', 'select 1; drop table t', 'only one statement is allowed: ";" may only end it'],
    ['postgres_query', 'shop', '\\! id', 'a backslash is not allowed outside a quoted string: the database client reads it as its own command'],
    ['postgres_query', 'shop', "select E'\\x41'", "an escape string (E'...') is not allowed: write a plain quoted string"],
    ['postgres_query', 'shop', 'delete from orders', '"delete" can change data or the schema, and this target is read-only'],
    ['mysql_query', 'crm', 'system id', '"system" is a command of the mysql client, not SQL'],
    ['mysql_query', 'crm', "select 'a\\' or 1 -- '", 'a backslash inside a quoted text is not allowed: mysql reads it as an escape'],
    ['postgres_query', 'shop', "select '\\''; delete from orders; -- '", 'a backslash inside a quoted text is not allowed: postgres reads it as an escape when standard_conforming_strings is off'],
    ['mysql_query', 'maria', 'show tables', 'not on the allowlist for this target. Allowed: select ...'],
  ]) {
    assert.equal((await ask(tool, { target, query })).text, `REFUSED (${tool.split('_')[0]} ${target}): ${text}`);
  }
  assert.equal(world.starts().length, 4, 'no refused statement started a client');

  const started = Date.now();
  const flood = await ask('postgres_query', { target: 'shop', query: 'select flood from t', timeout_seconds: 60 });
  assert.ok(Date.now() - started < 30000, 'the client is stopped at the output limit, not at the time limit');
  assert.ok(flood.text.startsWith('exit code: null\n--- stdout ---\nyyyy'));
  assert.ok(flood.text.endsWith('\n[output truncated at 262144 bytes per stream]'));
  assert.equal((await ask('postgres_query', { target: 'shop', query: 'select slow from t', timeout_seconds: 1 })).text, 'timed out after 1s');
  assert.equal((await ask('mysql_query', { target: 'crm', query: 'select slow from t', timeout_seconds: 1 })).text, 'timed out after 1s');
  assert.deepEqual(await ask('postgres_query', { target: 'shop', query: 'select * from fail' }), {
    text: 'exit code: 1\n--- stderr ---\nERROR:  relation "fail" does not exist', isError: true,
  });
  assert.equal((await ask('postgres_query', { target: 'shop', query: ['select 1'] })).text, 'invalid arguments: command must be a string');

  const notes = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(notes.includes('- `postgres_query { target, query, timeout_seconds? }`'));
  assert.ok(notes.includes('### PostgreSQL target `shop` - shop stand-in'));
  assert.ok(notes.includes('### MySQL target `maria`'));
  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.find((t) => t.name === 'shop'), {
    kind: 'postgres', name: 'shop', host: 'db.internal', port: 5433, database: 'shop', user: 'agent_ro', passwordEnv: PG_VAR, readOnly: true,
    description: 'shop stand-in', allow: pgTarget().allow, program: fakePsql, state: 'up',
  });
  await waitFor(() => /my +crm +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  assert.equal(await stopWith(run), 0);

  const calls = auditOf(world).filter((e) => e.event === 'call' && (e.tool === 'postgres_query' || e.tool === 'mysql_query'));
  assert.equal(calls[0].query, statement);
  assert.equal(calls[0].rule, 'select \\* from orders where id = *');
  assert.deepEqual(calls.filter((e) => e.decision === 'refused' && e.tool === 'mysql_query' && e.target === 'crm').map((e) => e.short).slice(0, MY_FIXED.length), MY_FIXED.map(([, short]) => short));
  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) {
    for (const secret of [PG_SECRET, MY_SECRET]) assert.ok(!text.includes(secret), `the secret in: ${text.slice(0, 200)}`);
  }
});

test('an unlisted statement goes to the reviewer; a fixed refusal never does; a client that is missing skips the target', async () => {
  const reviewer = await provider();
  const world = await sqlWorld({
    reviewer,
    postgres: [
      pgTarget({ allow: ['select 1'], review: { reviewer: 'r1', policy: 'reads only' } }),
      pgTarget({ name: 'unset', passwordEnv: 'SQL_TEST_NOT_SET' }),
    ],
    mysql: [myTarget({ name: 'gone', client: 'mariadb' })],
  });
  fs.rmSync(path.join(world.env.HOME, 'bin', 'mariadb'));
  const run = launch(world, { pg: ['shop', 'unset'], mysql: ['gone'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /pg +unset +SKIPPED +SQL_TEST_NOT_SET is not set\n/);
  assert.match(run.proc.stderr.text, /my +gone +SKIPPED +program mariadb was not found on PATH\n/);
  const reviewed = await callTool('postgres_query', { target: 'shop', query: 'select 2 from t' }, world.agentEnv);
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.deepEqual(JSON.parse(reviewer.asked[0].messages[1].content).command, ['select', '2', 'from', 't']);
  assert.equal(reportOf(reviewed).argv.at(-1), 'select 2 from t');
  const spaced = await callTool('postgres_query', { target: 'shop', query: "select 'a b'" }, world.agentEnv);
  assert.equal(spaced.text, 'REFUSED (postgres shop): not on the allowlist for this target. Allowed: select 1. It was not sent to the reviewer: a word contains a space, a control character or a double quote.');
  const fixed = await callTool('postgres_query', { target: 'shop', query: "select pg_ls_dir('.')" }, world.agentEnv);
  assert.match(fixed.text, /^REFUSED \(postgres shop\): the function pg_ls_dir /);
  assert.equal(reviewer.asked.length, 1);
  assert.equal(world.starts().length, 1);
  assert.equal(await stopWith(run), 0);
  assert.equal(auditOf(world).find((e) => e.tool === 'postgres_query' && e.rule === 'review').query, 'select 2 from t');
});

test('ksproxy check: the warning for a bare star, the verdict, the fixed refusals and the reviewer note', async () => {
  const reviewer = await provider();
  const world = await sqlWorld({
    reviewer,
    postgres: [pgTarget(), pgTarget({ name: 'rev', allow: ['select count(*) from t', 'regex((a+)+)'], review: { reviewer: 'r1', policy: 'p' } })],
    mysql: [myTarget({ allow: ['select ...'] })],
  });
  const check = (...words) => cli(['check', ...words], world.env);
  assert.deepEqual(await check('pg', 'shop', 'select', '*', 'from', 'orders', 'where', 'id', '=', '5'), {
    code: 0, stdout: 'ALLOWED by rule: select \\* from orders where id = *\n', stderr: `WARNING: postgres "shop": allow[1]: ${STAR}\nWARNING: postgres "shop": allow[2]: ${WIDE}\n`,
  });
  assert.equal((await check('pg', 'shop', 'copy', 't', 'to', 'program', "'id'")).stdout, 'REFUSED: COPY with a file or a program reads or writes files, or runs a program, on the database server\n');
  assert.equal((await check('pg', 'shop', 'delete', 'from', 't')).stdout, 'REFUSED: "delete" can change data or the schema, and this target is read-only\n');
  const rev = await check('pg', 'rev', 'select', 'x');
  assert.deepEqual(rev, {
    code: 1,
    stdout: 'NOT ON THE ALLOWLIST: a running session asks reviewer "r1"\n',
    stderr: `WARNING: postgres "rev": allow[0]: ${STAR}\nWARNING: postgres "rev": allow[1]: this pattern can be very slow on some inputs\n`,
  });
  assert.deepEqual(await check('mysql', 'crm', 'system', 'id'), { code: 1, stdout: 'REFUSED: "system" is a command of the mysql client, not SQL\n', stderr: '' });
  assert.equal((await check('mysql', 'crm', 'select', '1')).stdout, 'ALLOWED by rule: select ...\n');
  assert.deepEqual(world.starts(), []);
  assert.equal(reviewer.asked.length, 0);
});
