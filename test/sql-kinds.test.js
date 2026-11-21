import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { postgresRefusal, psqlInvocation } from '../src/kinds/postgres/index.js';
import mysql, { mysqlInvocation, mysqlRefusal } from '../src/kinds/mysql/index.js';
import { writesData } from '../src/kinds/engines/sql-service.js';
import { readStatement } from '../src/kinds/engines/sql.js';
import {
  KINDS, kindByFlag, kindByKey, kindByTool,
} from '../src/kinds/index.js';
import { mysqlBin, psqlBin } from '../src/paths.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { reviewRoute, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import { MY_FIXED, PG_FIXED } from './sql-fixed.js';

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
    kind: 'postgres', name: 'shop', host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', readOnly: true, description: 'd', allow: ['select ...'],
  });
  assert.equal(onePg({ port: undefined }).port, 5432);
  assert.equal(onePg({ readOnly: false }).readOnly, false);
  assert.equal(onePg({ readOnly: true }).readOnly, true);
  assert.deepEqual(onePg({ allow: undefined }).allow, []);
  assert.deepEqual(oneMy({}), {
    kind: 'mysql', name: 'crm', host: 'crm-db.internal', port: 3306, database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', readOnly: true, client: 'mysql', description: '', allow: ['select ...'],
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
  const target = { host: 'db.internal', port: 5433, database: 'shop', user: 'agent_ro' };
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

test('the menu, the opening line, the secrets, open, the record and the notes', () => {
  const target = onePg({ description: 'shop db', allow: ['select ...'] });
  assert.equal(postgres.hint(target), 'agent_ro@db.internal:5432/shop - shop db');
  assert.equal(postgres.hint({ ...target, description: '' }), 'agent_ro@db.internal:5432/shop');
  assert.equal(postgres.openingMessage(target), 'agent_ro@db.internal:5432/shop, read-only');
  assert.equal(mysql.openingMessage(oneMy({ readOnly: false })), 'agent_ro@crm-db.internal:3306/crm, read-write');
  assert.deepEqual(postgres.secrets(target), { env: ['SHOP_DB_PASSWORD'], files: [] });
  assert.deepEqual(postgres.ruleWarnings({ allow: ['select * from t', 'select 1'] }), ['allow[0]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star']);
  assert.deepEqual(mysql.ruleWarnings({ allow: ['select count(*) from t'] }), ['allow[0]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star']);
  const env = { PATH: path.dirname(fakePsql), KSPROXY_PSQL: fakePsql, KSPROXY_STATE_DIR: '/nonexistent-ks/st', KSPROXY_CONFIG_DIR: '/nonexistent-ks/cfg' };
  assert.deepEqual(postgres.open(target, { env, secrets: {} }), { ok: true, extras: { program: fakePsql } });
  assert.deepEqual(postgres.open(target, { env: { ...env, KSPROXY_PSQL: undefined, PATH: '/nonexistent-ks' }, secrets: {} }), { ok: false, error: 'program psql was not found on PATH' });
  assert.deepEqual(mysql.open(oneMy({ client: 'mariadb' }), { env: { ...env, PATH: '/nonexistent-ks' }, secrets: {} }), { ok: false, error: 'program mariadb was not found on PATH' });
  const reviewed = { ...target, review: { reviewer: 'r1', policy: 'p', accept: ['sure'] } };
  assert.deepEqual(postgres.record({ target: reviewed, program: fakePsql }, { reviewed: true }), {
    kind: 'postgres', name: 'shop', host: 'db.internal', port: 5432, database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', readOnly: true, description: 'shop db', allow: ['select ...'], program: fakePsql, state: 'up', review: true,
  });
  assert.equal(postgres.record({ target, program: fakePsql }, { reviewed: false }).review, undefined);
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
