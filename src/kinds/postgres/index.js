import { psqlBin } from '../../paths.js';
import { jsonForms } from '../shared.js';
import { sqlServiceKind } from '../engines/sql-service.js';
import { calledFunction, headWords, plainName } from '../engines/sql.js';

const OBJECT_VERBS = ['create', 'alter', 'drop'];
// Objects that run code, hold rights, reach outside the database or change the server.
const SERVER_OBJECTS = [
  'extension', 'language', 'function', 'procedure', 'routine', 'aggregate', 'role', 'user', 'group', 'database', 'tablespace',
  'server', 'subscription', 'publication', 'event', 'foreign', 'operator', 'cast', 'conversion', 'transform', 'access', 'system',
];
const SERVER_COMMANDS = ['do', 'load', 'listen', 'notify', 'unlisten', 'checkpoint', 'import'];
const SETTING_WORDS = [
  'role', 'authorization', 'session_authorization', 'default_transaction_read_only', 'transaction_read_only', 'characteristics',
  'transaction',
];
const TRANSACTION_WORDS = [
  'begin', 'start', 'commit', 'end', 'rollback', 'abort', 'savepoint', 'release', 'prepare', 'execute', 'deallocate', 'declare',
  'fetch', 'move', 'close', 'lock',
];
// Functions that read or write server files, run SQL given as text, reach other servers, or act on the server.
const SERVER_FUNCTIONS = [
  'pg_stat_file', 'lo_import', 'lo_export', 'lo_unlink', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_rotate_logfile', 'pg_execute_server_program', 'pg_logdir_ls', 'pg_promote', 'pg_switch_wal', 'pg_create_restore_point',
  'pg_backup_start', 'pg_backup_stop', 'pg_start_backup', 'pg_stop_backup', 'pg_log_backend_memory_contexts', 'set_config',
  'query_to_xml', 'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'cursor_to_xml', 'cursor_to_xmlschema', 'ts_stat',
  'ts_rewrite', 'pg_notify', 'connectby', 'xpath_table', 'schedule', 'schedule_in_database', 'unschedule', 'alter_job',
];
const FUNCTION_PREFIXES = ['pg_read_', 'pg_ls_', 'pg_file_', 'dblink', 'pg_background_', 'crosstab', 'cron.'];
// Functions that wait, or take a lock that outlives the statement.
const WAIT_FUNCTIONS = ['pg_sleep', 'pg_sleep_for', 'pg_sleep_until'];
const WAIT_PREFIXES = ['pg_advisory_', 'pg_try_advisory_'];
// The sslmode of libpq for each value of tls: verify-full checks the CA and the host name.
const SSL_MODES = { verify: 'verify-full', require: 'require', prefer: 'prefer' };

// COPY with a program, or from or to a quoted file name.
function copiesFile(words) {
  return words.includes('program') || words.some((word, i) => (word === 'from' || word === 'to') && words[i + 1]?.startsWith("'"));
}

// The refusal no rule, regex rule, reviewer or check can override, or null.
export function postgresRefusal(words) {
  const [first] = words;
  if (first === 'copy' && copiesFile(words)) {
    return { reason: 'COPY with a file or a program reads or writes files, or runs a program, on the database server', short: 'copy with a file or program' };
  }
  if (SERVER_COMMANDS.includes(first)) {
    return { reason: `"${first}" runs code or acts on the server outside one query`, short: 'server command' };
  }
  if (OBJECT_VERBS.includes(first) && headWords(words).some((word) => SERVER_OBJECTS.includes(word))) {
    return { reason: `"${first}" of this object can run code, change rights or reach outside the database`, short: 'server object' };
  }
  if ((first === 'set' || first === 'reset') && words.some((word) => SETTING_WORDS.includes(plainName(word)))) {
    return { reason: 'changing the role, the transaction or the read-only setting is not allowed', short: 'role or read-only setting' };
  }
  if (TRANSACTION_WORDS.includes(first)) {
    return { reason: `"${first}" controls the transaction or a cursor; each statement runs on its own`, short: 'transaction control' };
  }
  const called = calledFunction(words, SERVER_FUNCTIONS, FUNCTION_PREFIXES);
  if (called !== undefined) {
    return { reason: `the function ${called} reads or writes server files, runs SQL given as text, or acts on the server`, short: 'server function' };
  }
  const waiting = calledFunction(words, WAIT_FUNCTIONS, WAIT_PREFIXES);
  if (waiting !== undefined) {
    return { reason: `the function ${waiting} waits or takes a lock on the server`, short: 'waiting function' };
  }
  return null;
}

// psql with fixed options, the statement as the one argument after the last --command, the password in the
// environment. The settings ride on the startup options and are set again inside the one transaction that wraps
// every --command, because a connection pooler may drop the startup options without an error. TLS is set in the
// environment too: PGSSLMODE, and for verify PGSSLROOTCERT, the CA file or system for the CAs of this system. Through
// a tunnel the port is the tunnel's and PGHOSTADDR is its loopback address, while --host stays the real name, which
// libpq checks the certificate against.
export function psqlInvocation(target, statement, { password, timeoutMs, tunnel }) {
  const readOnly = target.readOnly !== false;
  const options = [
    ...(readOnly ? ['-c default_transaction_read_only=on'] : []),
    `-c statement_timeout=${timeoutMs}`,
    '-c standard_conforming_strings=on',
  ];
  const settings = [
    ...(readOnly ? ['SET TRANSACTION READ ONLY'] : []),
    `SET LOCAL statement_timeout = ${timeoutMs}`,
    'SET LOCAL standard_conforming_strings = on',
  ];
  return {
    fixedArgs: [
      '--no-psqlrc', '--quiet', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'FETCH_COUNT=1000', '--pset', 'footer=off',
      '--single-transaction', '--host', target.host, '--port', String(tunnel === undefined ? target.port : tunnel.port), '--dbname', target.database,
      '--username', target.user, '--no-password', ...settings.flatMap((setting) => ['--command', setting]), '--command',
    ],
    words: [statement],
    childEnv: {
      PGPASSWORD: password,
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'ksproxy',
      PGOPTIONS: options.join(' '),
      ...(tunnel === undefined ? {} : { PGHOSTADDR: tunnel.host }),
      PGSSLMODE: SSL_MODES[target.tls],
      ...(target.tls === 'verify' ? { PGSSLROOTCERT: target.caFile ?? 'system' } : {}),
    },
  };
}

export default sqlServiceKind({
  key: 'postgres',
  flag: 'pg',
  label: 'pg',
  word: 'postgres',
  noun: 'postgres target',
  countNoun: 'postgres target(s)',
  title: 'PostgreSQL',
  dialect: 'postgres',
  defaultPort: 5432,
  sample: [{
    name: 'shop-db',
    host: 'db.internal',
    port: 5432,
    database: 'shop',
    user: 'agent_ro',
    passwordEnv: 'SHOP_DB_PASSWORD',
    description: 'shop database, read-only',
    allow: ['select \\* from orders where id = *', 'select count(\\*) from orders'],
  }],
  extraKeys: [],
  extra: () => ({}),
  fixedRefusal: postgresRefusal,
  program: (target, env) => psqlBin(env),
  invocation: psqlInvocation,
  checksCertificate: true,
  // psql prints a text value as it is, but the server writes a json, jsonb or array value with a quote and a backslash
  // escaped: the password as JSON writes it covers those.
  printedForms: (password) => jsonForms([password]),
  notes: [
    '- Each statement runs inside one transaction, so a statement that cannot run in a transaction, such as VACUUM or CREATE DATABASE, fails.',
    '- Never allowed, whatever the rules: COPY with a file or a program, DO, LOAD, LISTEN and NOTIFY, extensions, functions, roles and other server objects, changing the role or the read-only setting, transaction control, functions that read server files or run SQL given as text, pg_sleep and the advisory locks.',
  ],
  tool: { name: 'postgres_query' },
});
