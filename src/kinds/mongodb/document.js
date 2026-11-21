import { AllowError } from '../../allowlist.js';
import { clip } from '../../text.js';

// The command document of the mongodb kind: the strict reader, the fixed refusals that no rule can override, the
// words the rules see, the bounds set before a document is sent, and the password parts of a connection string.

export const MAX_DOCUMENT_BYTES = 65536;
export const MAX_DEPTH = 20;
export const RESULT_LIMIT = 100;

// The commands that only read. explain is judged by the command inside it.
export const READ_COMMANDS = [
  'find', 'aggregate', 'count', 'distinct', 'listCollections', 'listIndexes', 'listDatabases', 'collStats', 'dbStats',
  'serverStatus', 'ping', 'hello', 'isMaster', 'buildInfo', 'connectionStatus', 'hostInfo', 'whatsmyuri', 'explain',
];
// The commands that change data. They run only on a target with "writes": true, and only when a rule allows them;
// every other command is refused.
export const WRITE_COMMANDS = ['insert', 'update', 'delete', 'findAndModify', 'createIndexes', 'dropIndexes', 'create', 'drop'];

// Never allowed, compared without regard to case, and every command that starts with replSet.
export const NEVER_COMMANDS = [
  'eval', 'mapReduce', 'mapreduce', 'shutdown', 'fsync', 'replSetReconfig', 'createUser', 'updateUser', 'dropUser', 'dropAllUsersFromDatabase',
  'grantRolesToUser', 'revokeRolesFromUser', 'createRole', 'updateRole', 'dropRole', 'dropAllRolesFromDatabase',
  'grantPrivilegesToRole', 'revokePrivilegesFromRole', 'setParameter', 'getParameter', 'setFeatureCompatibilityVersion',
  'dropDatabase', 'killOp', 'killSessions', 'killAllSessions', 'killCursors', 'getMore', 'logRotate', 'compact',
  'repairDatabase', 'copydb', 'clone', 'applyOps', 'getLog', 'getCmdLineOpts', 'connPoolSync', 'authenticate', 'logout',
  'saslStart', 'saslContinue',
];
const NEVER_LOWER = NEVER_COMMANDS.map((name) => name.toLowerCase());
const REPLICA_PREFIX = 'replset';

// Keys refused at any depth, compared exactly: server-side JavaScript, writes from a pipeline, and the Extended JSON
// form of JavaScript code.
export const FORBIDDEN_KEYS = ['$where', '$function', '$accumulator', '$out', '$merge', '$code', '$scope'];
export const FORBIDDEN_STAGES = ['$currentOp', '$listSessions', '$listLocalSessions', '$changeStream'];
// Stages that read collections other than the one the rules see: refused unless the target sets "joins": true, then
// left to the rules, never to the reviewer.
export const JOIN_STAGES = ['$lookup', '$graphLookup', '$unionWith'];
// The keys of create that make a view over another collection: refused unless the target sets "joins": true.
export const VIEW_KEYS = ['viewOn', 'pipeline'];
// Top-level keys the client sets itself, with every top-level key that starts with $.
export const PROTOCOL_KEYS = ['lsid', 'txnNumber', 'autocommit', 'startTransaction'];
const TIMED_COMMANDS = ['find', 'aggregate', 'count', 'distinct', 'listCollections', 'collStats', 'dbStats'];

const COMMAND_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RESERVED_NAMES = ['constructor', 'prototype'];
const COLLECTION = /^[^\s\p{Cc}]{1,255}$/u;
const SCHEME = /^[^/]+:\/\//;
const HOST_END = /[?#]/;
const PASSWORD_OPTION = /[?&]([^=&#]*password)=([^&#]*)/gi;
const MECHANISM_OPTION = /[?&]authMechanismProperties=([^&#]*)/gi;
const SECRET_PROPERTY = /(token|password)$/i;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// A copy of a JSON value, keys in the same order, refusing what JSON cannot hold, a container deeper than MAX_DEPTH,
// a key named __proto__ and a key with a NUL.
function copyValue(value, depth) {
  if (Array.isArray(value) || isPlainObject(value)) {
    if (depth > MAX_DEPTH) throw new AllowError(`the command nests deeper than ${MAX_DEPTH} levels`, 'nested too deep');
    if (Array.isArray(value)) return value.map((item) => copyValue(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__') throw new AllowError('the key __proto__ is not accepted', 'bad key');
      if (key.includes('\u0000')) throw new AllowError('a key holds a NUL character', 'bad key');
      out[key] = copyValue(value[key], depth + 1);
    }
    return out;
  }
  const scalar = value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
  if (!scalar) throw new AllowError('the command holds a value that is not JSON', 'not JSON');
  return value;
}

// The first key of a command document: its command name.
function commandName(document) {
  const [name] = Object.keys(document);
  if (name === undefined) throw new AllowError('the command document is empty: its first key names the command', 'empty command');
  if (!COMMAND_NAME.test(name)) {
    throw new AllowError('the command name must be a letter followed by up to 63 letters, digits and _', 'bad command name');
  }
  if (RESERVED_NAMES.includes(name)) throw new AllowError(`the command name ${name} is not accepted`, 'bad command name');
  return name;
}

// The words of one command: its name, and the collection when the name's value is a string.
function wordsOf(document, name) {
  const value = document[name];
  if (typeof value !== 'string') return [name];
  if (!COLLECTION.test(value)) {
    throw new AllowError('the collection name must be 1 to 255 characters without spaces or control characters', 'bad collection name');
  }
  return [name, value];
}

// The strict reader. input is the call: { command } and nothing else. Returns a copy of the document, which is what
// is judged, bounded and sent. Throws AllowError.
export function readCommand(input) {
  const extra = Object.keys(input).find((key) => key !== 'command');
  if (extra !== undefined) {
    throw new AllowError(`unknown argument ${JSON.stringify(clip(extra, 64))}: give target, command and timeout_seconds only`, 'unknown argument');
  }
  if (!isPlainObject(input.command)) {
    throw new AllowError('command must be one JSON object in the database\'s command format, for example {"find": "orders", "filter": {"status": "open"}}', 'not an object');
  }
  const document = copyValue(input.command, 1);
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) {
    throw new AllowError('the command is larger than 64 KiB', 'command too large');
  }
  commandName(document);
  return document;
}

// The first key of the list anywhere in a value, or undefined.
function keyFrom(value, list) {
  if (Array.isArray(value)) return value.map((item) => keyFrom(item, list)).find((key) => key !== undefined);
  if (!isPlainObject(value)) return undefined;
  for (const [key, inner] of Object.entries(value)) {
    if (list.includes(key)) return key;
    const found = keyFrom(inner, list);
    if (found !== undefined) return found;
  }
  return undefined;
}

// true when the command writes (allowed by a rule only), false when it reads; throws for a command never allowed and
// for a command that is on neither list.
function writesWith(name, writes) {
  const lower = name.toLowerCase();
  if (NEVER_LOWER.includes(lower) || lower.startsWith(REPLICA_PREFIX)) {
    throw new AllowError(`the command ${name} is never allowed`, 'command never allowed');
  }
  if (READ_COMMANDS.includes(name)) return false;
  if (!writes) {
    throw new AllowError(`the command ${name} is not a read command, and this target does not allow writes`, 'not a read command');
  }
  if (!WRITE_COMMANDS.includes(name)) {
    throw new AllowError(`the command ${name} is neither a read command nor one of the commands that change data: ${WRITE_COMMANDS.join(', ')}`, 'command not allowed');
  }
  return true;
}

function checkPipeline(pipeline) {
  if (!Array.isArray(pipeline)) throw new AllowError('aggregate needs a pipeline: a list of stages', 'bad pipeline');
  for (const stage of pipeline) {
    if (!isPlainObject(stage) || Object.keys(stage).length !== 1) {
      throw new AllowError('each stage of the pipeline must be an object with exactly one key, the stage name', 'bad pipeline');
    }
  }
}

// A top-level key the client sets itself: the database, the session or the transaction of the command.
function checkProtocolKeys(document) {
  const key = Object.keys(document).find((name) => name.startsWith('$') || PROTOCOL_KEYS.includes(name));
  if (key !== undefined) {
    throw new AllowError(`the key ${key} is not allowed at the top of a command: the client sets the database, the session and the transaction`, 'protocol key');
  }
}

// A create that makes a view: a later find on the view reads the collection it is made on, which the rules of the
// create never saw. Refused unless the target sets joins.
function checkView(document, joins) {
  const key = VIEW_KEYS.find((name) => Object.hasOwn(document, name));
  if (key !== undefined && joins !== true) {
    throw new AllowError(`the key ${key} of create makes a view that reads another collection than the one the rules see, and this target does not set "joins": true`, 'view refused');
  }
}

// One command, or the command inside explain: { words, write }.
function judgeOne(document, { writes, joins }, insideExplain) {
  const name = commandName(document);
  if (name === 'explain') {
    if (insideExplain) throw new AllowError('explain may not hold another explain', 'bad explain');
    if (!isPlainObject(document.explain)) {
      throw new AllowError('explain must hold one command document, for example {"explain": {"find": "orders"}}', 'bad explain');
    }
    checkProtocolKeys(document);
    const inner = judgeOne(document.explain, { writes, joins }, true);
    return { words: ['explain', ...inner.words], write: inner.write };
  }
  checkProtocolKeys(document);
  const words = wordsOf(document, name);
  const write = writesWith(name, writes);
  if (name === 'aggregate') checkPipeline(document.pipeline);
  if (name === 'create') checkView(document, joins);
  return { words, write };
}

// The fixed refusals, before any rule: forbidden keys and stages anywhere, then the command, explain and the pipeline,
// with a view made by create unless the target sets joins, then the join stages anywhere unless the target sets joins. target: { writes, joins }. Returns { words, write,
// joins } for the rules, joins true when a stage of JOIN_STAGES appears anywhere; throws AllowError for a refusal
// that no rule, reviewer or check can lift.
export function judgeCommand(document, { writes, joins }) {
  const key = keyFrom(document, FORBIDDEN_KEYS);
  if (key !== undefined) {
    throw new AllowError(`the key ${key} is never allowed: it runs JavaScript on the server or writes to a collection`, 'forbidden key');
  }
  const stage = keyFrom(document, FORBIDDEN_STAGES);
  if (stage !== undefined) throw new AllowError(`the stage ${stage} is never allowed`, 'forbidden stage');
  const judged = judgeOne(document, { writes, joins }, false);
  const join = keyFrom(document, JOIN_STAGES);
  if (join !== undefined && joins !== true) {
    throw new AllowError(`the stage ${join} reads collections other than the one the rules see, and this target does not set "joins": true`, 'join stage');
  }
  return { ...judged, joins: join !== undefined };
}

const ownLimit = (value, most) => Number.isInteger(value) && value >= 1 && value <= most;

// The bounds, set on the judged copy after the decision: find returns one batch of at most RESULT_LIMIT documents,
// aggregate its first batch of at most RESULT_LIMIT, and the timed commands stop on the server just before the call's
// time limit. The command inside explain is bounded the same way. Returns the same document.
export function boundCommand(document, timeoutMs) {
  const [name] = Object.keys(document);
  if (name === 'explain') boundCommand(document.explain, timeoutMs);
  if (name === 'find') {
    const limit = ownLimit(document.limit, RESULT_LIMIT) ? document.limit : RESULT_LIMIT;
    Object.assign(document, { limit, batchSize: limit, singleBatch: true });
  }
  if (name === 'aggregate') document.cursor = { batchSize: RESULT_LIMIT };
  if (TIMED_COMMANDS.includes(name)) {
    const most = Math.max(1, timeoutMs - 1000);
    if (!ownLimit(document.maxTimeMS, most - 1)) document.maxTimeMS = most;
  }
  return document;
}

// A value as written and percent-decoded; twice as written when the decoding fails.
function bothForms(raw) {
  try {
    return [raw, decodeURIComponent(raw)];
  } catch {
    return [raw, raw];
  }
}

// The values of the entries of an authMechanismProperties option, NAME:VALUE separated by commas, whose name ends in
// TOKEN or PASSWORD in any case (AWS_SESSION_TOKEN). A comma or a colon may be written as %2C or %3A; a value keeps
// any later colon.
function secretProperties(raw) {
  return raw.split(/,|%2C/i).flatMap((entry) => {
    const at = entry.search(/:|%3A/i);
    if (at === -1 || !SECRET_PROPERTY.test(entry.slice(0, at))) return [];
    return [entry.slice(at + (entry[at] === ':' ? 1 : 3))];
  });
}

// The secrets of a connection string, each as written and percent-decoded: the password of the user information,
// which ends at the last @ before the first ? or #, so a raw / in the password is kept; the value of every option
// whose name ends in password, in any case; and the secret entries of authMechanismProperties. None when there is none.
export function passwordParts(uri) {
  const scheme = SCHEME.exec(uri);
  if (scheme === null) return [];
  const rest = uri.slice(scheme[0].length);
  const end = rest.search(HOST_END);
  const hostPart = end === -1 ? rest : rest.slice(0, end);
  const at = hostPart.lastIndexOf('@');
  const userInfo = at === -1 ? '' : hostPart.slice(0, at);
  const colon = userInfo.indexOf(':');
  const password = colon === -1 ? '' : userInfo.slice(colon + 1);
  const options = [...uri.matchAll(PASSWORD_OPTION)].map((match) => match[2]);
  const properties = [...uri.matchAll(MECHANISM_OPTION)].flatMap((match) => secretProperties(match[1]));
  return [password, ...options, ...properties].filter((value) => value !== '').flatMap(bothForms);
}
