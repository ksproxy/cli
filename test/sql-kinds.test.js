import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import postgres, { postgresRefusal, psqlInvocation } from '../src/kinds/postgres/index.js';
import mysql, { clientFamily, mysqlInvocation, mysqlRefusal } from '../src/kinds/mysql/index.js';
import { tlsFailure, writesData } from '../src/kinds/engines/sql-service.js';
import { readStatement } from '../src/kinds/engines/sql.js';
import {
  KINDS, kindByFlag, kindByKey, kindByTool, secretFilesOf,
} from '../src/kinds/index.js';
import { mysqlBin, psqlBin } from '../src/paths.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { reviewRoute, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import { MY_FIXED, PG_FIXED, TLS_TEXT } from './sql-fixed.js';
import { tempDir } from './temp.js';

const fakePsql = fileURLToPath(new URL('./fixtures/fake-psql.js', import.meta.url));
const fakeMysql = fileURLToPath(new URL('./fixtures/fake-mysql.js', import.meta.url));

const pgEntry = (extra = {}) => ({
  name: 'shop', host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', allow: ['select ...'], ...extra,
});
const myEntry = (extra = {}) => ({
  name: 'crm', host: 'crm-db.internal', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', allow: ['select ...'], ...extra,
});
const onePg = (extra) => validateInventory({ postgres: [pgEntry(extra)] }).postgres[0];
const oneMy = (extra) => validateInventory({ mysql: [myEntry(extra)] }).mysql[0];
function fails(one, extra, message) {
  assert.throws(() => one(extra), (err) => {
    assert.ok(err instanceof InventoryError, err.message);
    assert.equal(err.message, message);
    return true;
  });
}

test('postgres and mysql are brokered kinds appended to the list and meet the contract', () => {
  assert.equal(KINDS[8], postgres);
  assert.equal(KINDS[9], mysql);
  for (const [kind, key, flag, label, tool] of [[postgres, 'postgres', 'pg', 'pg', 'postgres_query'], [mysql, 'mysql', 'mysql', 'my', 'mysql_query']]) {
    checkKind(kind, KINDS);
    assert.equal(kindByKey(key), kind);
    assert.equal(kindByFlag(flag), kind);
    assert.equal(kindByTool(tool), kind);
    assert.deepEqual([kind.brokered, kind.label, kind.word, kind.tool.detailKey, kind.tool.detailIsArray], [true, label, key, 'query', false]);
    assert.deepEqual(Object.keys(kind.tool.definition.inputSchema.properties), ['target', 'query', 'timeout_seconds']);
  }
});

test('psqlBin and mysqlBin: the override for tests, else the client name', () => {
  assert.equal(psqlBin({}), 'psql');
  assert.equal(psqlBin({ KSPROXY_PSQL: '/x/psql' }), '/x/psql');
  assert.equal(mysqlBin({}), 'mysql');
  assert.equal(mysqlBin({}, 'mariadb'), 'mariadb');
  assert.equal(mysqlBin({ KSPROXY_MYSQL: '/x/my' }, 'mariadb'), '/x/my');
  assert.equal(typeof psqlBin(), 'string');
  assert.equal(typeof mysqlBin(), 'string');
});

test('an entry is validated into a target, with read-only on, the default port and the default client', () => {
  assert.deepEqual(onePg({ description: 'd', review: undefined }), {
    kind: 'postgres', name: 'shop', host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', readOnly: true, tls: 'prefer', caFile: null, description: 'd', allow: ['select ...'],
  });
  assert.equal(onePg({ port: undefined }).port, 5432);
  assert.equal(onePg({ readOnly: false }).readOnly, false);
  assert.equal(onePg({ readOnly: true }).readOnly, true);
  assert.deepEqual(onePg({ allow: undefined }).allow, []);
  assert.deepEqual(oneMy({}), {
    kind: 'mysql', name: 'crm', host: 'crm-db.internal', port: 3306, database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', readOnly: true, tls: 'prefer', caFile: null, client: 'mysql', description: '', allow: ['select ...'],
  });
  assert.equal(oneMy({ client: 'mariadb' }).client, 'mariadb');
  assert.equal(onePg({ host: 'h'.repeat(253) }).host.length, 253);
  assert.equal(onePg({ host: '10.0.0.5' }).host, '10.0.0.5');
  assert.equal(onePg({ database: 'd'.repeat(63), user: 'u.x_y-z' }).database.length, 63);
  assert.equal(onePg({ port: 1 }).port, 1);
  assert.equal(onePg({ port: 65535 }).port, 65535);
});

test('every mistake in an entry is an inventory error; no value can become an option of the client', () => {
  for (const [one, label] of [[onePg, 'postgres "shop"'], [oneMy, 'mysql "crm"']]) {
    fails(one, { shell: 1 }, `${label}: unknown key "shell"`);
    const host = `${label}: host: must be a host name or address of letters, digits, "." and "-", at most 253 characters, not starting with "-"`;
    for (const value of [undefined, '', '-oProxyCommand=x', '--host=evil', '.x', 'a b', 'a_b', 'a:1', '::1', 'h'.repeat(254), 5, 'a\nb']) fails(one, { host: value }, host);
    for (const value of [0, 65536, '5432', 1.5, -1]) fails(one, { port: value }, `${label}: port: must be an integer from 1 to 65535`);
    for (const field of ['database', 'user']) {
      const message = `${label}: ${field}: must be 1 to 63 letters, digits, "_", "-" and ".", not starting with "-"`;
      for (const value of [undefined, '', '--host=evil', '-x', 'a b', 'a;b', 'a=b', 'd'.repeat(64), 5, 'é']) fails(one, { [field]: value }, message);
    }
    fails(one, { passwordEnv: undefined }, `${label}: passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_`);
    fails(one, { passwordEnv: 'KSPROXY_PW' }, `${label}: passwordEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_`);
    fails(one, { passwordEnv: 'HOME' }, `${label}: passwordEnv: HOME is a variable the session needs; name a variable that must hold only the password`);
    fails(one, { readOnly: 'yes' }, `${label}: readOnly: must be true or false`);
    fails(one, { allow: 'any' }, `${label}: allow: "any" is not supported for ${label.split(' ')[0]} targets; list the statements`);
    fails(one, { allow: 'select' }, `${label}: allow: must be an array of rule strings`);
    fails(one, { allow: ['select ... x'] }, `${label}: allow[0]: "..." is only allowed as the last token: select ... x`);
    fails(one, { allow: ['select 1', 'select count(...)'] }, `${label}: allow[1]: "..." is only allowed as the last word`);
    fails(one, { allow: ['select \\d'] }, `${label}: allow[0]: a backslash is not allowed outside a quoted string: the database client reads it as its own command`);
    fails(one, { allow: ['select 1 -- x'] }, `${label}: allow[0]: a comment is not allowed in a ${label.split(' ')[0]} statement`);
    fails(one, { allow: ['regex(a(b)'] }, `${label}: allow[0]: regex does not compile: ${(() => { try { RegExp('a(b'); } catch (err) { return err.message; } return ''; })()}`);
    fails(one, { review: { reviewer: 'r', policy: 'p', programs: ['ls'] } }, `${label}: review.programs: is only for local targets`);
  }
  fails(onePg, { client: 'mysql' }, 'postgres "shop": unknown key "client"');
  for (const value of ['psql', 5, '', null]) fails(oneMy, { client: value }, 'mysql "crm": client: must be "mysql" or "mariadb"');
});

function decideAll(kind, rows, readOnly) {
  const target = { allow: ['regex(.*)', 'select ...', ...rows.map(([text]) => `${text.split(/[\s(]/)[0].toLowerCase()} ...`)], readOnly };
  for (const [text, short] of rows) {
    const decision = kind.decide(target, text);
    assert.equal(decision.allowed, false, text);
    assert.equal(decision.short, short, text);
    assert.equal(decision.unmatched, undefined, `${text}: a fixed refusal is never reviewed`);
    assert.equal(typeof decision.reason, 'string');
  }
}

test('the fixed refusals win over a "regex(.*)" rule and a "word ..." rule, in read-only and read-write mode', () => {
  for (const readOnly of [true, false]) {
    decideAll(postgres, PG_FIXED, readOnly);
    decideAll(mysql, MY_FIXED, readOnly);
  }
  assert.equal(postgresRefusal(readStatement("copy orders to 'x'", 'postgres')).reason, 'COPY with a file or a program reads or writes files, or runs a program, on the database server');
  assert.equal(postgresRefusal(readStatement('do x', 'postgres')).reason, '"do" runs code or acts on the server outside one query');
  assert.equal(postgresRefusal(readStatement('drop role x', 'postgres')).reason, '"drop" of this object can run code, change rights or reach outside the database');
  assert.equal(postgresRefusal(readStatement('set role x', 'postgres')).reason, 'changing the role, the transaction or the read-only setting is not allowed');
  assert.equal(postgresRefusal(readStatement('commit', 'postgres')).reason, '"commit" controls the transaction or a cursor; each statement runs on its own');
  assert.equal(postgresRefusal(readStatement("select pg_ls_dir('.')", 'postgres')).reason, 'the function pg_ls_dir reads or writes server files, runs SQL given as text, or acts on the server');
  assert.equal(mysqlRefusal(readStatement('load data infile x', 'mysql')).reason, 'LOAD DATA and LOAD XML read a file on the database server or on this machine');
  assert.equal(mysqlRefusal(readStatement('select 1 into outfile x', 'mysql')).reason, 'INTO OUTFILE, INTO DUMPFILE and DATA or INDEX DIRECTORY write files on the database server');
  assert.equal(mysqlRefusal(readStatement('flush logs', 'mysql')).reason, '"flush" acts on the server, its rights or its replication');
  assert.equal(mysqlRefusal(readStatement('xa start x', 'mysql')).reason, '"xa" controls the transaction or runs a prepared statement; each statement runs on its own');
  assert.equal(mysqlRefusal(readStatement('set global x = 1', 'mysql')).reason, 'changing a global setting, a password, the transaction or the read-only setting is not allowed');
  assert.equal(mysqlRefusal(readStatement('create user x', 'mysql')).reason, '"create" of this object can run code, change rights or change the server');
  assert.equal(mysqlRefusal(readStatement("select load_file('x')", 'mysql')).reason, 'the function load_file reads server files or runs a program');
  assert.equal(postgresRefusal(readStatement('select cron.schedule(1)', 'postgres')).reason, 'the function cron.schedule reads or writes server files, runs SQL given as text, or acts on the server');
  assert.equal(postgresRefusal(readStatement('select pg_sleep(1)', 'postgres')).reason, 'the function pg_sleep waits or takes a lock on the server');
  assert.equal(mysqlRefusal(readStatement('select sleep(1)', 'mysql')).reason, 'the function sleep waits, repeats work or takes a lock on the server, and the time limit may not stop it there');
});

test('what the fixed refusals leave to the rules', () => {
  const pgOk = [
    'select * from orders', 'copy orders to stdout', "copy (select 'program') to stdout", 'copy t from stdin', 'vacuum t',
    "select current_setting('role')", 'create table role_log (role text)', 'create view v as select user', 'create index i on t (x)',
    'alter table t add column c int', 'drop table t', "set search_path = 'x'", 'set statement_timeout = 5', 'show role',
    'select pg_read_file from t', 'select lo_get(5)', 'explain select 1', "select 'pg_read_file(' from t", 'values (1)', 'table t',
    'select a from t where b to x',
  ];
  for (const text of pgOk) assert.equal(postgresRefusal(readStatement(text, 'postgres')), null, text);
  const myOk = [
    'select * from t', 'show tables', 'describe t', 'load index into cache t', 'set @x = 1', "set names 'utf8mb4'", 'set sql_mode = x',
    'create table t (user int)', 'create view v as select user from t', 'alter table t add column c int', 'do 1', "select 'into outfile'",
    'select x into @y from t', 'select load_file from t', 'rename table a to b', 'replace into t values (1)', 'select * from data',
  ];
  for (const text of myOk) assert.equal(mysqlRefusal(readStatement(text, 'mysql')), null, text);
});

test('read-only is on unless the target says readOnly false: the writing first words, and a with or explain that holds one', () => {
  const writes = [
    'insert into t values (1)', 'update t set a = 1', 'delete from t', 'merge into t using s on true when matched then delete', 'truncate t',
    'create table t (a int)', 'alter table t add b int', 'drop table t', 'comment on table t is \'x\'', 'refresh materialized view v',
    'reindex table t', 'cluster t', 'call p()', 'replace into t values (1)', 'rename table a to b',
    'with x as (delete from t returning *) select * from x', 'explain analyze update t set a = 1', 'grant select on t to u', 'revoke select on t from u',
    'vacuum full orders', 'analyze orders', 'reassign owned by a to b', "security label on table t is 'x'", 'select * into t from orders',
    'select * into temp t from orders', 'select 1 into', 'optimize table orders', 'repair table t', 'checksum table t', 'cache index t in k',
    'load index into cache t',
  ];
  const mysqlFirst = ['replace', 'rename', 'optimize', 'repair', 'checksum', 'cache', 'load'];
  for (const text of writes) {
    const [kind, dialect] = mysqlFirst.includes(text.split(' ')[0]) ? [mysql, 'mysql'] : [postgres, 'postgres'];
    assert.equal(writesData(readStatement(text, dialect)), true, text);
    const refused = kind.decide({ allow: ['regex(.*)'], readOnly: true }, text);
    if (refused.short !== 'server command') {
      assert.deepEqual(refused, {
        allowed: false, reason: `"${readStatement(text, dialect)[0]}" can change data or the schema, and this target is read-only`, short: 'read-only target',
      }, text);
      assert.equal(kind.decide({ allow: ['regex(.*)'], readOnly: false }, text).allowed, true, text);
      assert.equal(kind.decide({ allow: ['regex(.*)'] }, text).allowed, false, `${text}: read-only when the field is absent`);
    }
  }
  assert.equal(writesData(readStatement('select x into @y from t', 'mysql')), false, 'into a user variable writes no table');
  assert.equal(mysql.decide({ allow: ['regex(.*)'], readOnly: true }, "load data infile 'x' into table t").short, 'load data', 'the fixed refusal comes first');
  for (const text of ['select 1', 'with x as (select 1) select * from x', 'explain select * from t', 'show tables', 'select update_time from t']) {
    assert.equal(writesData(readStatement(text, 'postgres')), false, text);
    assert.equal(postgres.decide({ allow: ['regex(.*)'], readOnly: true }, text).allowed, true, text);
  }
});

test('decide: the reader first, then the rules; an unlisted statement carries its words for the reviewer', () => {
  const target = { allow: ['select \\* from orders where id = *', 'select count(\\*) from t', 'show server_version', 'select ...'], readOnly: true };
  assert.deepEqual(postgres.decide(target, 'SELECT * FROM orders WHERE id = 5;'), {
    allowed: true, rule: 'select \\* from orders where id = *', argv: ['select', '*', 'from', 'orders', 'where', 'id', '=', '5'],
  });
  assert.equal(postgres.decide(target, 'select count(*) from t').rule, 'select count(\\*) from t');
  assert.equal(postgres.decide(target, 'show server_version').rule, 'show server_version');
  for (const dialect of [postgres, mysql]) {
    const valued = { allow: ['select \\* from orders where id = *'], readOnly: true };
    assert.equal(dialect.decide(valued, 'select * from orders where id = -1').rule, 'select \\* from orders where id = *');
    assert.deepEqual(dialect.decide(valued, 'select * from orders where id = id'), {
      allowed: false,
      reason: `not on the allowlist for this target. Allowed: ${valued.allow.join('; ')}`,
      short: 'not on allowlist',
      unmatched: true,
      argv: ['select', '*', 'from', 'orders', 'where', 'id', '=', 'id'],
    }, 'a name in a value hole goes the way of every unmatched statement, to the reviewer when there is one');
    const unmatched = dialect.decide(valued, 'select * from orders where id = id');
    assert.deepEqual(reviewRoute(dialect.key, unmatched, true), { argv: ['select', '*', 'from', 'orders', 'where', 'id', '=', 'id'] });
  }
  assert.equal(postgres.decide(target, 'select id from t').rule, 'select ...');
  assert.deepEqual(postgres.decide(target, 'values (1)'), {
    allowed: false, reason: `not on the allowlist for this target. Allowed: ${target.allow.join('; ')}`, short: 'not on allowlist', unmatched: true, argv: ['values', '(', '1', ')'],
  });
  assert.deepEqual(postgres.decide(target, 'select 1; select 2'), {
    allowed: false, reason: 'only one statement is allowed: ";" may only end it', short: 'more than one statement',
  });
  assert.equal(postgres.decide(target, 42).short, 'invalid statement');
  assert.equal(mysql.decide({ allow: ['select ...'] }, 'system id').short, 'client command');
  assert.equal(mysql.decide({ allow: [] }, 'select 1').short, 'allowlist is empty');
});

test('the client is called with fixed options, the statement as one argument and the password only in its environment', () => {
  const target = {
    host: 'db.internal', port: 5433, database: 'shop', user: 'agent_ro', tls: 'prefer', caFile: null,
  };
  const statement = "select * from t where a = 'x -- y' ";
  assert.deepEqual(psqlInvocation(target, statement, { password: 'pw', timeoutMs: 30000 }), {
    fixedArgs: [
      '--no-psqlrc', '--quiet', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'FETCH_COUNT=1000', '--pset', 'footer=off', '--single-transaction',
      '--host', 'db.internal', '--port', '5433', '--dbname', 'shop', '--username', 'agent_ro', '--no-password',
      '--command', 'SET TRANSACTION READ ONLY', '--command', 'SET LOCAL statement_timeout = 30000',
      '--command', 'SET LOCAL standard_conforming_strings = on', '--command',
    ],
    words: [statement],
    childEnv: {
      PGPASSWORD: 'pw', PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'ksproxy',
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000 -c standard_conforming_strings=on',
      PGSSLMODE: 'prefer',
    },
  });
  const writable = psqlInvocation({ ...target, readOnly: false }, 's', { password: 'pw', timeoutMs: 5000 });
  assert.equal(writable.childEnv.PGOPTIONS, '-c statement_timeout=5000 -c standard_conforming_strings=on');
  assert.deepEqual(writable.fixedArgs.slice(-6), [
    '--no-password', '--command', 'SET LOCAL statement_timeout = 5000', '--command', 'SET LOCAL standard_conforming_strings = on', '--command',
  ]);
  // The agent's statement is the one word after the last --command: no fixed --command follows it.
  for (const invocation of [writable, psqlInvocation(target, 's', { password: 'pw', timeoutMs: 5000 })]) {
    const argv = [...invocation.fixedArgs, ...invocation.words];
    assert.equal(argv.lastIndexOf('--command'), argv.length - 2);
    assert.deepEqual(invocation.words, ['s']);
  }
  assert.equal(psqlInvocation({ ...target, readOnly: true }, 's', { password: 'pw', timeoutMs: 5000 }).childEnv.PGOPTIONS.startsWith('-c default_transaction_read_only=on'), true);
  assert.deepEqual(mysqlInvocation({ ...target, port: 3306, readOnly: true }, statement, { password: 'pw', timeoutMs: 1000 }), {
    fixedArgs: [
      '--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10', '--host=db.internal',
      '--port=3306', '--database=shop', '--user=agent_ro', '--init-command=SET SESSION sql_select_limit=1000; SET SESSION TRANSACTION READ ONLY',
    ],
    words: [`--execute=${statement}`],
    childEnv: { MYSQL_PWD: 'pw' },
    folderPaths: { MYSQL_TEST_LOGIN_FILE: 'no-login-file.cnf' },
  });
  assert.equal(mysqlInvocation({ ...target, readOnly: false }, 's', { password: 'pw' }).fixedArgs.at(-1), '--init-command=SET SESSION sql_select_limit=1000');
});

test('the menu, the opening line, the secrets, open, the record and the notes', async () => {
  const target = onePg({ description: 'shop db', allow: ['select ...'] });
  assert.equal(postgres.hint(target), 'agent_ro@db.internal:5432/shop - shop db');
  assert.equal(postgres.hint({ ...target, description: '' }), 'agent_ro@db.internal:5432/shop');
  assert.equal(postgres.openingMessage(target), 'agent_ro@db.internal:5432/shop, read-only, TLS prefer');
  assert.equal(postgres.openingMessage(onePg({ tls: 'verify' })), 'agent_ro@db.internal:5432/shop, read-only, TLS verify');
  assert.equal(postgres.openingMessage(onePg({ caFile: '/ca/db.pem' })), 'agent_ro@db.internal:5432/shop, read-only, TLS verify with caFile');
  assert.equal(mysql.openingMessage(oneMy({ readOnly: false })), 'agent_ro@crm-db.internal:3306/crm, read-write, TLS prefer');
  assert.equal(mysql.openingMessage(oneMy({ readOnly: false, tls: 'verify' })), 'agent_ro@crm-db.internal:3306/crm, read-write, TLS verify');
  assert.equal(mysql.openingMessage(oneMy({ host: 'localhost' })), 'agent_ro@localhost:3306/crm, read-only, TLS prefer');
  assert.equal(postgres.openingMessage(onePg({ tls: 'require' })), 'agent_ro@db.internal:5432/shop, read-only, TLS require');
  assert.deepEqual(postgres.secrets(target), { env: ['SHOP_DB_PASSWORD'], files: [] });
  assert.deepEqual(postgres.ruleWarnings({ allow: ['select * from t', 'select 1'] }), ['allow[0]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star']);
  assert.deepEqual(mysql.ruleWarnings({ allow: ['select count(*) from t'] }), ['allow[0]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star']);
  // A prefer target opens without running anything, as before: the state folder is never made.
  const env = { PATH: path.dirname(fakePsql), KSPROXY_PSQL: fakePsql, KSPROXY_STATE_DIR: '/nonexistent-ks/st', KSPROXY_CONFIG_DIR: '/nonexistent-ks/cfg' };
  const local = onePg({ host: 'localhost', description: 'shop db' });
  assert.deepEqual(await postgres.open(local, { env, secrets: {} }), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(await postgres.open(target, { env: { ...env, KSPROXY_PSQL: undefined, PATH: '/nonexistent-ks' }, secrets: {} }), { ok: false, error: 'program psql was not found on PATH' });
  assert.deepEqual(await mysql.open(oneMy({ client: 'mariadb' }), { env: { ...env, PATH: '/nonexistent-ks' }, secrets: {} }), { ok: false, error: 'program mariadb was not found on PATH' });
  const reviewed = { ...target, review: { reviewer: 'r1', policy: 'p', accept: ['sure'] } };
  assert.deepEqual(postgres.record({ target: reviewed, program: fakePsql }, { reviewed: true }), {
    kind: 'postgres', name: 'shop', host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', readOnly: true, tls: 'prefer', caFile: null, description: 'shop db', allow: ['select ...'], program: fakePsql, state: 'up', review: true,
  });
  assert.equal(postgres.record({ target, program: fakePsql }, { reviewed: false }).review, undefined);
  // The client family that open learned is kept in the record, for each call.
  assert.equal(mysql.record({ target: oneMy({}), program: '/b/mysql', family: 'mariadb' }, { reviewed: false }).family, 'mariadb');
  assert.ok(!('family' in postgres.record({ target, program: fakePsql }, { reviewed: false })));
  assert.equal(postgres.downMessage(), 'the call service is not answering');
  assert.equal(mysql.backMessage, 'the call service is back');

  const notes = postgres.agentSection({ ...target, review: true });
  assert.match(notes, /^### PostgreSQL target `shop` - shop db\n\n- Tool: `postgres_query` with `target: "shop"` and one SQL statement in `query`\./);
  for (const part of ['- Allowed statements: select ...', 'no comments, no backslash', '`\\*` is the SQL star', 'In a rule, `*` is one value: a number such as `42`, `-1` or `1.5`, or one string in single quotes; never a name', 'Read-only:', 'COPY with a file or a program', 'the real limit']) {
    assert.ok(notes.includes(part), part);
  }
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes('db.internal') && !notes.includes('SHOP_DB_PASSWORD'), 'the address and the variable are not in the notes');
  const open = mysql.agentSection({ ...oneMy({ readOnly: false }), description: '' });
  assert.ok(open.startsWith('### MySQL target `crm`\n'));
  assert.ok(open.includes('- The user allowed changes on this target.'));
  assert.ok(open.includes('At most 1000 rows per result'));
  assert.ok(open.includes('quote a name with backticks'));
  assert.ok(!open.includes('reviewed before'));
  assert.equal(postgres.toolBullet, '- `postgres_query { target, query, timeout_seconds? }` - run one allowlisted SQL statement on a PostgreSQL target.');
  assert.equal(mysql.toolBullet, '- `mysql_query { target, query, timeout_seconds? }` - run one allowlisted SQL statement on a MySQL target.');
});

test('the tools are listed when the inventory holds a target of their kind, and AGENT.md lists them for a session', () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ ssh: [{}] })).includes('postgres_query'));
  assert.deepEqual(names(toolDefinitions({ postgres: [{}], mysql: [{}] })).slice(-2), ['postgres_query', 'mysql_query']);
  assert.deepEqual(names(toolDefinitions(null)).slice(-4, -2), ['postgres_query', 'mysql_query']);
  const text = agentMdText({ targets: [{ ...onePg({}), program: fakePsql, state: 'up' }, { ...oneMy({}), program: fakeMysql, state: 'up' }] });
  assert.ok(text.includes('- `postgres_query { target, query, timeout_seconds? }`'));
  assert.ok(text.includes('### MySQL target `crm`'));
});


// ---------- TLS: the fields tls and caFile ----------

const {
  CERT, NO_TLS, OLD_PSQL, MARIADB_REQUIRE, SYSTEM_WAY, CA_WAY, NONE_WAY, OLD_WAY, MARIADB_WAY, VERSION_WAY,
} = TLS_TEXT;

test('tls: prefer by default for every host, verify when the entry names a caFile; caFile: a path that only verify uses', () => {
  for (const host of ['localhost', 'LocalHost', '127.0.0.1', '127.10.0.2', 'db.internal', 'web1.example.com', '192.0.2.10', '127.0.0.1.example.com']) {
    assert.equal(onePg({ host }).tls, 'prefer', host);
    assert.equal(oneMy({ host }).tls, 'prefer', host);
    assert.equal(onePg({ host }).caFile, null, host);
  }
  for (const host of ['localhost', '127.0.0.1', 'db.internal', 'web1.example.com']) {
    assert.equal(onePg({ host, caFile: '/ca.pem' }).tls, 'verify', host);
    assert.equal(oneMy({ host, caFile: '/ca.pem' }).tls, 'verify', host);
    assert.equal(onePg({ host, caFile: '/ca.pem' }).caFile, '/ca.pem', host);
  }
  for (const tls of ['verify', 'require', 'prefer']) {
    for (const host of ['db.internal', 'localhost']) {
      assert.equal(onePg({ host, tls }).tls, tls, `${host} ${tls}`);
      assert.equal(oneMy({ host, tls }).tls, tls, `${host} ${tls}`);
    }
  }
  assert.equal(onePg({ caFile: '/etc/ssl/../ssl//db-ca.pem' }).caFile, '/etc/ssl/db-ca.pem');
  assert.equal(oneMy({ caFile: '~/certs/db-ca.pem' }).caFile, path.join(os.homedir(), 'certs', 'db-ca.pem'));
  assert.equal(onePg({ host: 'localhost', tls: 'verify', caFile: '/ca.pem' }).caFile, '/ca.pem');
  for (const [one, label] of [[onePg, 'postgres "shop"'], [oneMy, 'mysql "crm"']]) {
    for (const tls of ['', 'VERIFY', 'disable', 'verify-full', true, 1, null]) fails(one, { tls }, `${label}: tls: must be "verify", "require" or "prefer"`);
    fails(one, { caFile: '' }, `${label}: caFile: must be a non-empty path`);
    fails(one, { caFile: 5 }, `${label}: caFile: must be a non-empty path`);
    fails(one, { caFile: 'certs/ca.pem' }, `${label}: caFile: must be an absolute path or start with "~/"`);
    fails(one, { caFile: '/ca.pem', tls: 'prefer' }, `${label}: caFile: is used only with "tls": "verify"; this target has "tls": "prefer"`);
    fails(one, { caFile: '/ca.pem', tls: 'require' }, `${label}: caFile: is used only with "tls": "verify"; this target has "tls": "require"`);
    fails(one, { caFile: '/ca.pem', tls: 'prefer', host: '127.0.0.1' }, `${label}: caFile: is used only with "tls": "verify"; this target has "tls": "prefer"`);
  }
});

test('the TLS settings of each client and mode; the statement stays the one argument the agent gives', () => {
  const base = {
    host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', readOnly: true,
  };
  const pgTls = (tls, caFile = null) => {
    const { childEnv } = psqlInvocation({ ...base, tls, caFile }, 's', { password: 'pw', timeoutMs: 1000 });
    return Object.fromEntries(Object.entries(childEnv).filter(([key]) => key.startsWith('PGSSL')));
  };
  assert.deepEqual(pgTls('verify'), { PGSSLMODE: 'verify-full', PGSSLROOTCERT: 'system' });
  assert.deepEqual(pgTls('verify', '/ca/db.pem'), { PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/ca/db.pem' });
  assert.deepEqual(pgTls('require'), { PGSSLMODE: 'require' });
  assert.deepEqual(pgTls('prefer'), { PGSSLMODE: 'prefer' });
  const myTls = (target) => {
    const { fixedArgs } = mysqlInvocation({ ...base, port: 3306, ...target }, 's', { password: 'pw' });
    assert.ok(fixedArgs.at(-1).startsWith('--init-command='));
    return fixedArgs.slice(fixedArgs.indexOf('--user=agent_ro') + 1, -1);
  };
  assert.deepEqual(myTls({ tls: 'verify', caFile: null, family: 'mysql' }), ['--ssl-mode=VERIFY_IDENTITY']);
  assert.deepEqual(myTls({ tls: 'verify', caFile: '/ca/db.pem', family: 'mysql' }), ['--ssl-mode=VERIFY_IDENTITY', '--ssl-ca=/ca/db.pem']);
  assert.deepEqual(myTls({ tls: 'require', caFile: null, family: 'mysql' }), ['--ssl-mode=REQUIRED']);
  assert.deepEqual(myTls({ tls: 'verify', caFile: null, family: 'mariadb' }), ['--ssl', '--ssl-verify-server-cert']);
  assert.deepEqual(myTls({ tls: 'verify', caFile: '/ca/db.pem', family: 'mariadb' }), ['--ssl', '--ssl-verify-server-cert', '--ssl-ca=/ca/db.pem']);
  // open never lets require reach the MariaDB client; if it did, the certificate would still be checked.
  assert.deepEqual(myTls({ tls: 'require', caFile: null, family: 'mariadb' }), ['--ssl', '--ssl-verify-server-cert']);
  // prefer gives no TLS option to either client, as before: each uses TLS when the server offers it.
  assert.deepEqual(myTls({ tls: 'prefer', caFile: null }), []);
  assert.deepEqual(myTls({ tls: 'prefer', caFile: null, family: 'mariadb' }), []);
  // A statement that looks like an option is the value of the last --command, or glued to --execute=.
  const pg = psqlInvocation({ ...base, tls: 'verify', caFile: null }, '--set=sslmode=disable', { password: 'pw', timeoutMs: 1000 });
  assert.deepEqual([pg.fixedArgs.at(-1), pg.words], ['--command', ['--set=sslmode=disable']]);
  assert.deepEqual(mysqlInvocation({ ...base, tls: 'verify', caFile: null, family: 'mysql' }, '--skip-ssl', { password: 'pw' }).words, ['--execute=--skip-ssl']);
});

test('tlsFailure: the fixed reason and way out for each TLS failure of the real clients, and null for any other', () => {
  const host = 'db.example.com';
  const verify = { host, tls: 'verify', caFile: null };
  const withCa = { host, tls: 'verify', caFile: '/ca/db.pem' };
  const required = { host, tls: 'require', caFile: null };
  // What psql 17, the MariaDB client 10.11 and the MySQL client print.
  const certificates = [
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: SSL error: certificate verify failed',
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: server certificate for "other" does not match host name "db"',
    'ERROR 2026 (HY000): TLS/SSL error: unable to get local issuer certificate',
    'ERROR 2026 (HY000): TLS/SSL error: self-signed certificate',
    'ERROR 2026 (HY000): TLS/SSL error: Validation of SSL server certificate failed',
    'ERROR 2026 (HY000): SSL connection error: error:0A000086:SSL routines::certificate verify failed',
  ];
  for (const text of certificates) {
    assert.deepEqual(tlsFailure(text, verify), { error: CERT, wayOut: SYSTEM_WAY(host) }, text);
    assert.deepEqual(tlsFailure(text, withCa), { error: CERT, wayOut: CA_WAY(host) }, text);
  }
  for (const text of [
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: server does not support SSL, but SSL was required',
    'ERROR 2026 (HY000): TLS/SSL error: SSL is required, but the server does not support it',
    "ERROR 2026 (HY000): SSL connection error: SSL is required but the server doesn't support it",
  ]) {
    assert.deepEqual(tlsFailure(text, verify), { error: NO_TLS, wayOut: NONE_WAY('verify') }, text);
    assert.deepEqual(tlsFailure(text, required), { error: NO_TLS, wayOut: NONE_WAY('require') }, text);
  }
  // With require nothing checks a certificate: a text that names one is not a TLS failure there.
  for (const text of [
    ...certificates,
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: FATAL:  connection requires a valid client certificate',
    "ERROR 1045 (28000): Access denied for user 'agent_ro'@'192.0.2.9' (using password: YES); this account requires X509 certificate",
  ]) assert.equal(tlsFailure(text, required), null, text);
  const old = 'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: root certificate file "system" does not exist\nEither provide the file or change sslmode to disable server certificate verification.';
  assert.deepEqual(tlsFailure(old, verify), { error: OLD_PSQL, wayOut: OLD_WAY });
  for (const text of [
    '',
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: FATAL:  password authentication failed for user "agent_ro"',
    "ERROR 1045 (28000): Access denied for user 'agent_ro'@'192.0.2.9' (using password: YES)",
    'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: Connection refused',
    "ERROR 2002 (HY000): Can't connect to server on 'db' (115)",
  ]) assert.equal(tlsFailure(text, verify), null, text);
});

test('tlsFailure: the names of the target are taken out of the text first, so only the client\'s own words can match', () => {
  const host = 'certificate-db.internal';
  const target = {
    host, user: 'certificate_ro', database: 'certificate.main', tls: 'verify', caFile: null,
  };
  // Another failure that only repeats the names of the target: not a TLS failure.
  assert.equal(tlsFailure(`psql: error: connection to server at "${host}" (192.0.2.4), port 5432 failed: FATAL:  password authentication failed for user "certificate_ro"`, target), null);
  assert.equal(tlsFailure('psql: error: connection to server at "CERTIFICATE-DB.INTERNAL" (192.0.2.4), port 5432 failed: FATAL:  database "Certificate.Main" does not exist', target), null);
  // A real certificate text that also names the host still gives the certificate reason.
  assert.deepEqual(tlsFailure(`psql: error: connection to server at "${host}" (192.0.2.4), port 5432 failed: server certificate for "other" does not match host name "${host}"`, target), { error: CERT, wayOut: SYSTEM_WAY(host) });
  // A name with characters that mean something in a regular expression is taken out as plain text.
  const odd = { ...target, host: 'a+b.example.com', user: '', database: undefined };
  assert.equal(tlsFailure('failed for a+b.example.com', odd), null);
  assert.deepEqual(tlsFailure('certificate verify failed for a+b.example.com', odd), { error: CERT, wayOut: SYSTEM_WAY('a+b.example.com') });
  // A short name that does not hold the word stays in the text: a real certificate failure is still named.
  const real = 'psql: error: connection to server failed: SSL error: certificate verify failed';
  for (const names of [{ user: 'a' }, { host: 'cert' }, { database: 'c' }, { user: 'ate', database: 'cert' }]) {
    assert.deepEqual(tlsFailure(real, { ...target, host: 'db.example.com', user: 'agent', database: 'main', ...names }), { error: CERT, wayOut: SYSTEM_WAY(names.host ?? 'db.example.com') }, JSON.stringify(names));
  }
  // A name that is exactly the word is not taken out: it would take the client's own word away.
  const exact = 'psql: error: connection to server at "db1.example.com", port 5432 failed: SSL error: certificate verify failed';
  for (const names of [{ host: 'certificate' }, { database: 'certificate' }, { user: 'CERTIFICATE' }]) {
    assert.deepEqual(tlsFailure(exact, { ...target, host: 'db1.example.com', user: 'agent', database: 'main', ...names }), { error: CERT, wayOut: SYSTEM_WAY(names.host ?? 'db1.example.com') }, JSON.stringify(names));
  }
  // The other tests do not change.
  assert.deepEqual(tlsFailure('server does not support SSL', { ...target, host: 'does not support SSL' }), { error: NO_TLS, wayOut: NONE_WAY('verify') });
});

// A temporary home, state folder and PATH for open: mysql and mariadb are the stand-in, and mysql-from-mariadb is a
// mysql program whose version says MariaDB, as the mysql of Debian does. said keeps what open says.
function openWorld() {
  const base = fs.realpathSync(tempDir('ks-sqltls-'));
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['mysql', 'mariadb', 'mysql-from-mariadb']) fs.symlinkSync(fakeMysql, path.join(bin, name));
  const env = {
    PATH: `${bin}:${process.env.PATH}`, HOME: base, KSPROXY_PSQL: fakePsql, KSPROXY_STATE_DIR: path.join(base, 'st'), KSPROXY_CONFIG_DIR: path.join(base, 'cfg'),
  };
  const log = path.join(base, 'sql-starts.log');
  const ca = path.join(base, 'ca.pem');
  fs.writeFileSync(ca, 'a made-up CA\n');
  const said = [];
  const secrets = { SHOP_DB_PASSWORD: 'pw-pg-made-up-0000', CRM_DB_PASSWORD: 'pw-my-made-up-0000' };
  return {
    base,
    bin,
    env,
    ca,
    said,
    secrets,
    ctx: (extra = {}, signal = new AbortController().signal) => ({
      env: { ...env, ...extra }, secrets, signal, say: (text) => said.push(text),
    }),
    starts: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0),
    script(name, body) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return file;
    },
  };
}

test('open: prefer runs nothing; verify and require learn the client family and connect once with select 1', async () => {
  const w = openWorld();
  const [mysqlProgram, mariadbProgram, fromMaria] = ['mysql', 'mariadb', 'mysql-from-mariadb'].map((name) => path.join(w.bin, name));
  assert.deepEqual(await postgres.open(onePg({ tls: 'prefer' }), w.ctx()), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(await mysql.open(oneMy({ host: '127.0.0.1' }), w.ctx()), { ok: true, extras: { program: mysqlProgram } });
  // A remote host without tls is prefer too.
  assert.deepEqual(await postgres.open(onePg(), w.ctx()), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(await mysql.open(oneMy(), w.ctx()), { ok: true, extras: { program: mysqlProgram } });
  assert.equal(w.starts(), 0, 'nothing runs for prefer');
  assert.deepEqual(await postgres.open(onePg({ tls: 'verify' }), w.ctx()), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(await postgres.open(onePg({ tls: 'require' }), w.ctx()), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(await postgres.open(onePg({ caFile: w.ca }), w.ctx()), { ok: true, extras: { program: fakePsql } });
  assert.equal(w.starts(), 3, 'one select 1 for each');
  assert.deepEqual(await mysql.open(oneMy({ tls: 'verify' }), w.ctx()), { ok: true, extras: { program: mysqlProgram, family: 'mysql' } });
  assert.deepEqual(await mysql.open(oneMy({ tls: 'require' }), w.ctx()), { ok: true, extras: { program: mysqlProgram, family: 'mysql' } });
  assert.deepEqual(await mysql.open(oneMy({ client: 'mariadb', caFile: w.ca }), w.ctx()), { ok: true, extras: { program: mariadbProgram, family: 'mariadb' } });
  // The family comes from the version, not from the name: here the program mysql is the MariaDB client.
  assert.deepEqual(await mysql.open(oneMy({ tls: 'verify' }), w.ctx({ KSPROXY_MYSQL: fromMaria })), { ok: true, extras: { program: fromMaria, family: 'mariadb' } });
  assert.equal(w.starts(), 3 + 8, '--version, then select 1, for each');
  assert.deepEqual(await clientFamily(oneMy(), mysqlProgram, w.ctx()), { family: 'mysql' });
  assert.deepEqual(w.said, [], 'nothing is said when the check passes');

  assert.deepEqual(await mysql.open(oneMy({ client: 'mariadb', tls: 'require' }), w.ctx()), { ok: false, error: MARIADB_REQUIRE });
  assert.deepEqual(await mysql.open(oneMy({ tls: 'require' }), w.ctx({ KSPROXY_MYSQL: fromMaria })), { ok: false, error: MARIADB_REQUIRE });
  const broken = w.script('mysql-broken', 'exit 1');
  assert.deepEqual(await mysql.open(oneMy({ tls: 'verify' }), w.ctx({ KSPROXY_MYSQL: broken })), { ok: false, error: `could not run ${broken} --version` });
  assert.deepEqual(w.said, [MARIADB_WAY, MARIADB_WAY, VERSION_WAY(broken)]);
});

test('open: a TLS failure skips the target with a fixed reason and says the way out; any other failure, or a stop, opens it', async () => {
  const w = openWorld();
  const mariaOne = (extra) => oneMy({ client: 'mariadb', ...extra });
  const bad = 'bad-cert.example.com';
  const none = 'no-tls.example.com';
  for (const [kind, one] of [[postgres, onePg], [mysql, oneMy], [mysql, mariaOne]]) {
    const at = `${kind.key} ${one({}).client ?? ''}`;
    w.said.length = 0;
    assert.deepEqual(await kind.open(one({ host: bad, tls: 'verify' }), w.ctx()), { ok: false, error: CERT }, at);
    assert.deepEqual(await kind.open(one({ host: bad, caFile: w.ca }), w.ctx()), { ok: false, error: CERT }, at);
    assert.deepEqual(await kind.open(one({ host: none, tls: 'verify' }), w.ctx()), { ok: false, error: NO_TLS }, at);
    assert.deepEqual(w.said, [SYSTEM_WAY(bad), CA_WAY(bad), NONE_WAY('verify')], at);
    assert.equal((await kind.open(one({ host: bad, tls: 'prefer' }), w.ctx())).ok, true, at);
    assert.equal((await kind.open(one({ host: none, tls: 'prefer' }), w.ctx())).ok, true, at);
    // Without tls and without caFile it is prefer: the same hosts open.
    assert.equal((await kind.open(one({ host: bad }), w.ctx())).ok, true, at);
    assert.equal((await kind.open(one({ host: none }), w.ctx())).ok, true, at);
  }
  w.said.length = 0;
  for (const [kind, one] of [[postgres, onePg], [mysql, oneMy]]) {
    assert.deepEqual(await kind.open(one({ host: none, tls: 'require' }), w.ctx()), { ok: false, error: NO_TLS });
    assert.equal((await kind.open(one({ host: bad, tls: 'require' }), w.ctx())).ok, true, 'require does not check the certificate');
  }
  assert.deepEqual(await postgres.open(onePg({ host: 'old-libpq.example.com', tls: 'verify' }), w.ctx()), { ok: false, error: OLD_PSQL });
  assert.equal((await postgres.open(onePg({ host: 'old-libpq.example.com', caFile: w.ca }), w.ctx())).ok, true);
  assert.deepEqual(w.said, [NONE_WAY('require'), NONE_WAY('require'), OLD_WAY]);

  // The CA file must be a file this user can read when the target opens; nothing runs before that is known.
  const before = w.starts();
  const missing = path.join(w.base, 'gone.pem');
  const folder = path.join(w.base, 'ca-folder');
  fs.mkdirSync(folder);
  for (const file of [missing, folder]) {
    assert.deepEqual(await postgres.open(onePg({ caFile: file }), w.ctx()), { ok: false, error: `caFile ${file} is not a file that can be read` });
    assert.deepEqual(await mysql.open(oneMy({ caFile: file }), w.ctx()), { ok: false, error: `caFile ${file} is not a file that can be read` });
  }
  if (process.getuid() !== 0) {
    const locked = path.join(w.base, 'locked.pem');
    fs.writeFileSync(locked, 'x', { mode: 0o000 });
    assert.deepEqual(await postgres.open(onePg({ caFile: locked }), w.ctx()), { ok: false, error: `caFile ${locked} is not a file that can be read` });
  }
  assert.equal(w.starts(), before);

  // A failure that is not about TLS (a wrong password, a server that is down) opens the target: a call shows it.
  const refused = w.script('psql-refused', 'echo \'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: FATAL:  password authentication failed\' >&2\nexit 2');
  assert.deepEqual(await postgres.open(onePg({ tls: 'verify' }), w.ctx({ KSPROXY_PSQL: refused })), { ok: true, extras: { program: refused } });
  // With require, a client that names a certificate in its error has not failed a check of one: the target opens.
  const clientCert = w.script('psql-client-cert', 'echo \'psql: error: connection to server at "db" (192.0.2.4), port 5432 failed: FATAL:  connection requires a valid client certificate\' >&2\nexit 2');
  assert.deepEqual(await postgres.open(onePg({ tls: 'require' }), w.ctx({ KSPROXY_PSQL: clientCert })), { ok: true, extras: { program: clientCert } });
  // A stop while the check runs ends it at once, and the target opens; start then closes what opened during a stop.
  const started = path.join(w.base, 'started');
  const slow = w.script('psql-slow', `echo up > '${started}'\nexec sleep 60`);
  const controller = new AbortController();
  const opening = postgres.open(onePg({ tls: 'verify' }), w.ctx({ KSPROXY_PSQL: slow }, controller.signal));
  await waitUntil(() => fs.existsSync(started));
  const began = Date.now();
  controller.abort();
  assert.deepEqual(await opening, { ok: true, extras: { program: slow } });
  assert.ok(Date.now() - began < 3000, 'the stop ends the check at once');
  // A client that printed a certificate failure before it was stopped: its text is not read, and the target opens.
  const startedCert = path.join(w.base, 'started-cert');
  const slowCert = w.script('psql-slow-cert', `echo 'SSL error: certificate verify failed' >&2\necho up > '${startedCert}'\nexec sleep 60`);
  const stopCert = new AbortController();
  const openingCert = postgres.open(onePg({ tls: 'verify' }), w.ctx({ KSPROXY_PSQL: slowCert }, stopCert.signal));
  await waitUntil(() => fs.existsSync(startedCert));
  stopCert.abort();
  assert.deepEqual(await openingCert, { ok: true, extras: { program: slowCert } });
});

test('the check at open runs select 1 with the settings of a call, and the password only in the environment', async () => {
  const w = openWorld();
  const log = path.join(w.base, 'args.log');
  const pgEcho = w.script('psql-echo', `printf '%s\\n' "$@" "PGSSLMODE=$PGSSLMODE" "PGSSLROOTCERT=$PGSSLROOTCERT" > '${log}'`);
  assert.equal((await postgres.open(onePg({ caFile: w.ca }), w.ctx({ KSPROXY_PSQL: pgEcho }))).ok, true);
  const pg = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(pg.slice(-4), ['--command', 'select 1', 'PGSSLMODE=verify-full', `PGSSLROOTCERT=${w.ca}`]);
  assert.ok(pg.includes('SET TRANSACTION READ ONLY') && pg.includes('--no-password'));
  const version = "if [ \"$1\" = --version ]; then echo 'mysql  Ver 15.1 Distrib 10.11.19-MariaDB, for debian-linux-gnu (x86_64)'; exit 0; fi";
  const myEcho = w.script('mysql-echo', `${version}\nprintf '%s\\n' "$@" > '${log}'`);
  assert.deepEqual(await mysql.open(oneMy({ caFile: w.ca }), w.ctx({ KSPROXY_MYSQL: myEcho })), { ok: true, extras: { program: myEcho, family: 'mariadb' } });
  const my = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.deepEqual(my.slice(-5), ['--ssl', '--ssl-verify-server-cert', `--ssl-ca=${w.ca}`, '--init-command=SET SESSION sql_select_limit=1000; SET SESSION TRANSACTION READ ONLY', '--execute=select 1']);
  for (const text of [...pg, ...my]) assert.ok(!Object.values(w.secrets).some((secret) => text.includes(secret)), text);
  // doctor runs select 1 the same way, with the family that open learned.
  const opened = { kind: 'mysql', target: oneMy({ caFile: w.ca }), program: myEcho, family: 'mariadb' };
  const answer = await mysql.doctor(opened, {
    env: w.env, secrets: w.secrets, timeoutMs: 10000, signal: new AbortController().signal,
  });
  assert.deepEqual(answer, { ok: true, detail: 'select 1 answered' });
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n').slice(-5, -2), ['--ssl', '--ssl-verify-server-cert', `--ssl-ca=${w.ca}`]);
});

test('secretFiles: the CA file of each target, so that no local target can reach it; raw entries of another file too', () => {
  const inventory = validateInventory({
    postgres: [pgEntry({ caFile: '/ca/pg.pem' }), pgEntry({ name: 'two' })],
    mysql: [myEntry({ caFile: '~/ca/my.pem' })],
  });
  assert.deepEqual(postgres.secretFiles(inventory.postgres), ['/ca/pg.pem']);
  assert.deepEqual(mysql.secretFiles(inventory.mysql), [path.join(os.homedir(), 'ca', 'my.pem')]);
  assert.deepEqual(secretFilesOf(inventory), ['/ca/pg.pem', path.join(os.homedir(), 'ca', 'my.pem')]);
  assert.deepEqual(postgres.secretFiles([{ caFile: '~/raw.pem' }, { caFile: 5 }, {}]), ['~/raw.pem']);
});

async function waitUntil(done, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}
