import { InventoryError } from '../../checks.js';
import { mysqlBin } from '../../paths.js';
import { sqlServiceKind } from '../engines/sql-service.js';
import {
  calledFunction, hasPair, headWords, plainName,
} from '../engines/sql.js';

const CLIENTS = ['mysql', 'mariadb'];
const ROW_LIMIT = 1000;
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

function checkClient(entry, where) {
  if (entry.client === undefined) return { client: 'mysql' };
  if (!CLIENTS.includes(entry.client)) throw new InventoryError(`${where}: client: must be "mysql" or "mariadb"`);
  return { client: entry.client };
}

// The client with fixed options, the statement glued to --execute= as one argument, the password in the environment.
// utf8mb4 keeps the client from reading a backtick as part of a multi-byte character of the machine's locale; the
// login file named inside the empty working folder does not exist, so no stored login replaces the password.
export function mysqlInvocation(target, statement, { password }) {
  const init = [`SET SESSION sql_select_limit=${ROW_LIMIT}`, ...(target.readOnly === false ? [] : ['SET SESSION TRANSACTION READ ONLY'])];
  return {
    fixedArgs: [
      '--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10',
      `--host=${target.host}`, `--port=${target.port}`, `--database=${target.database}`, `--user=${target.user}`,
      `--init-command=${init.join('; ')}`,
    ],
    words: [`--execute=${statement}`],
    childEnv: { MYSQL_PWD: password },
    folderPaths: { MYSQL_TEST_LOGIN_FILE: 'no-login-file.cnf' },
  };
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
  notes: [
    '- Double quotes make a string here; quote a name with backticks. A backslash is refused inside a string too, and `#` starts a comment.',
    `- At most ${ROW_LIMIT} rows per result. Never allowed, whatever the rules: LOAD DATA, INTO OUTFILE and INTO DUMPFILE, commands of the mysql client, server commands, global settings, users and other server objects, transaction control, LOAD_FILE, and SLEEP, BENCHMARK and the lock and wait functions. The time limit stops the client; the server may go on with the statement until it ends.`,
  ],
  tool: { name: 'mysql_query' },
});
