import { InventoryError } from '../../checks.js';
import { mysqlBin } from '../../paths.js';
import { jsonForms } from '../shared.js';
import { runClient } from '../engines/command.js';
import { sqlServiceKind } from '../engines/sql-service.js';
import {
  calledFunction, hasPair, headWords, plainName,
} from '../engines/sql.js';

const TUNNEL_VERIFY = '"tls": "verify" cannot be used through a tunnel, because the MySQL and MariaDB clients check the certificate\'s name against the address they connect to, which is 127.0.0.1 there; write "tls": "prefer" instead and leave out "caFile", which only "verify" uses';
const CLIENTS = ['mysql', 'mariadb'];
const ROW_LIMIT = 1000;
const VERSION_MS = 5000;
const VERSION_MAX_BYTES = 4096;
const OBJECT_VERBS = ['create', 'alter', 'drop', 'rename'];
// Objects that run code, hold rights or change the server.
const SERVER_OBJECTS = [
  'user', 'role', 'function', 'procedure', 'event', 'trigger', 'server', 'tablespace', 'logfile', 'instance', 'resource',
];
const SERVER_COMMANDS = [
  'handler', 'install', 'uninstall', 'shutdown', 'restart', 'reset', 'purge', 'change', 'start', 'stop', 'kill', 'flush',
  'grant', 'revoke', 'clone', 'binlog', 'import',
];
const TRANSACTION_WORDS = [
  'begin', 'commit', 'rollback', 'savepoint', 'release', 'lock', 'unlock', 'prepare', 'execute', 'deallocate', 'xa',
];
const SETTING_WORDS = ['global', 'persist', 'persist_only', 'password', 'transaction', 'transaction_read_only', 'tx_read_only'];
const SERVER_FUNCTIONS = ['load_file', 'sys_exec', 'sys_eval', 'sys_get', 'sys_set'];
// Functions that wait, repeat work or take a lock; the server may go on with them after the client is stopped.
const WAIT_FUNCTIONS = [
  'sleep', 'benchmark', 'get_lock', 'release_lock', 'release_all_locks', 'is_free_lock', 'is_used_lock', 'master_pos_wait',
  'source_pos_wait', 'wait_for_executed_gtid_set', 'wait_until_sql_thread_after_gtids',
];

// The refusal no rule, regex rule, reviewer or check can override, or null.
export function mysqlRefusal(words) {
  const [first, second] = words;
  if (first === 'load' && (second === 'data' || second === 'xml')) {
    return { reason: 'LOAD DATA and LOAD XML read a file on the database server or on this machine', short: 'load data' };
  }
  if (hasPair(words, ['into'], ['outfile', 'dumpfile']) || hasPair(words, ['data', 'index'], ['directory'])) {
    return { reason: 'INTO OUTFILE, INTO DUMPFILE and DATA or INDEX DIRECTORY write files on the database server', short: 'server file' };
  }
  if (SERVER_COMMANDS.includes(first)) {
    return { reason: `"${first}" acts on the server, its rights or its replication`, short: 'server command' };
  }
  if (TRANSACTION_WORDS.includes(first)) {
    return { reason: `"${first}" controls the transaction or runs a prepared statement; each statement runs on its own`, short: 'transaction control' };
  }
  if (first === 'set' && words.some((word) => SETTING_WORDS.includes(plainName(word)))) {
    return { reason: 'changing a global setting, a password, the transaction or the read-only setting is not allowed', short: 'server setting' };
  }
  if (OBJECT_VERBS.includes(first) && headWords(words).some((word) => SERVER_OBJECTS.includes(word))) {
    return { reason: `"${first}" of this object can run code, change rights or change the server`, short: 'server object' };
  }
  const called = calledFunction(words, SERVER_FUNCTIONS, []);
  if (called !== undefined) {
    return { reason: `the function ${called} reads server files or runs a program`, short: 'server function' };
  }
  const waiting = calledFunction(words, WAIT_FUNCTIONS, []);
  if (waiting !== undefined) {
    return {
      reason: `the function ${waiting} waits, repeats work or takes a lock on the server, and the time limit may not stop it there`,
      short: 'waiting function',
    };
  }
  return null;
}

// Both clients check the certificate's name against --host, which is the loopback address through a tunnel, so verify
// could never pass; the text names the way out.
export function mysqlTunnelProblem(target) {
  return target.tls === 'verify' ? TUNNEL_VERIFY : null;
}

function checkClient(entry, where) {
  if (entry.client === undefined) return { client: 'mysql' };
  if (!CLIENTS.includes(entry.client)) throw new InventoryError(`${where}: client: must be "mysql" or "mariadb"`);
  return { client: entry.client };
}

// Which client the program is, for its TLS options: the MariaDB client says MariaDB in its version, whatever its name
// (the mysql of Debian is the MariaDB client), and any other is the MySQL client. Gives { family }, or { error, wayOut }.
// The MariaDB client has no option that requires TLS without checking the certificate, so require is refused there.
export async function clientFamily(target, program, { env, signal }) {
  const result = await runClient({
    program, words: ['--version'], env, timeoutMs: VERSION_MS, maxBytes: VERSION_MAX_BYTES, signal,
  });
  if (result.exitCode !== 0) {
    return {
      error: `could not run ${program} --version`,
      wayOut: `ksproxy reads the version of the client to choose its TLS options; check that ${program} runs, or set "tls" to "prefer"`,
    };
  }
  const family = result.stdout.includes('MariaDB') ? 'mariadb' : 'mysql';
  if (family === 'mariadb' && target.tls === 'require') {
    return {
      error: 'the MariaDB client cannot require TLS without a check',
      wayOut: 'set "tls" to "verify" (with "caFile" when this system does not trust the CA), or to "prefer"',
    };
  }
  return { family };
}

// The TLS options of a call: none for prefer, as before: the MySQL client then uses TLS when the server offers it, and
// a MariaDB client before 11.4 does not try TLS at all. The MariaDB
// client checks the certificate and the host name with --ssl-verify-server-cert, the MySQL client with
// --ssl-mode=VERIFY_IDENTITY; both read the CA file from --ssl-ca, else the CAs of this system. open never lets require
// reach the MariaDB client.
function tlsArgs(target) {
  if (target.tls === 'prefer') return [];
  const ca = target.caFile === null ? [] : [`--ssl-ca=${target.caFile}`];
  if (target.family === 'mariadb') return ['--ssl', '--ssl-verify-server-cert', ...ca];
  return [`--ssl-mode=${target.tls === 'verify' ? 'VERIFY_IDENTITY' : 'REQUIRED'}`, ...ca];
}

// The client with fixed options, the statement glued to --execute= as one argument, the password in the environment.
// utf8mb4 keeps the client from reading a backtick as part of a multi-byte character of the machine's locale; the
// login file named inside the empty working folder does not exist, so no stored login replaces the password.
// Through a tunnel the client connects to the tunnel's loopback address and port over TCP, never a socket.
export function mysqlInvocation(target, statement, { password, tunnel }) {
  const init = [`SET SESSION sql_select_limit=${ROW_LIMIT}`, ...(target.readOnly === false ? [] : ['SET SESSION TRANSACTION READ ONLY'])];
  return {
    fixedArgs: [
      '--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10',
      ...(tunnel === undefined
        ? [`--host=${target.host}`, `--port=${target.port}`]
        : [`--host=${tunnel.host}`, `--port=${tunnel.port}`, '--protocol=TCP']),
      `--database=${target.database}`, `--user=${target.user}`,
      ...tlsArgs(target), `--init-command=${init.join('; ')}`,
    ],
    words: [`--execute=${statement}`],
    childEnv: { MYSQL_PWD: password },
    folderPaths: { MYSQL_TEST_LOGIN_FILE: 'no-login-file.cnf' },
  };
}

// A value as the client prints it in batch mode, where that is not the value itself: a backslash, a tab, a newline and
// a NUL are written as a backslash and a letter. The value is taken as it is, and as JSON writes it (jsonForms), for a
// row that holds it inside a JSON text: the server writes the JSON, then the client doubles its backslashes. A
// password in a row that a call reads is shown in one of these forms, which the core hides with the password.
const BATCH_ESCAPES = {
  '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\0': '\\0',
};
export function batchForms(value) {
  const printed = [value, ...jsonForms([value])].map((text) => text.replace(/[\\\t\n\0]/g, (char) => BATCH_ESCAPES[char]));
  return [...new Set(printed)].filter((form) => form !== value);
}

export default sqlServiceKind({
  key: 'mysql',
  flag: 'mysql',
  label: 'my',
  word: 'mysql',
  noun: 'mysql target',
  countNoun: 'mysql target(s)',
  title: 'MySQL',
  dialect: 'mysql',
  defaultPort: 3306,
  sample: [{
    name: 'crm-db',
    host: 'crm-db.internal',
    port: 3306,
    database: 'crm',
    user: 'agent_ro',
    passwordEnv: 'CRM_DB_PASSWORD',
    client: 'mysql',
    description: 'crm database, read-only',
    allow: ['show tables', 'describe customers', 'select \\* from customers where id = *'],
  }],
  extraKeys: ['client'],
  extra: checkClient,
  fixedRefusal: mysqlRefusal,
  program: (target, env) => mysqlBin(env, target.client),
  invocation: mysqlInvocation,
  printedForms: batchForms,
  clientFamily,
  tunnelProblem: mysqlTunnelProblem,
  notes: [
    '- Double quotes make a string here; quote a name with backticks. A backslash is refused inside a string too, and `#` starts a comment.',
    `- At most ${ROW_LIMIT} rows per result. Never allowed, whatever the rules: LOAD DATA, INTO OUTFILE and INTO DUMPFILE, commands of the mysql client, server commands, global settings, users and other server objects, transaction control, LOAD_FILE, and SLEEP, BENCHMARK and the lock and wait functions. The time limit stops the client; the server may go on with the statement until it ends.`,
  ],
  tool: { name: 'mysql_query' },
});
