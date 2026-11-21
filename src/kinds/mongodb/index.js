import { decide, describeAllow } from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable, isObject,
} from '../../checks.js';
import { mongoshBin } from '../../paths.js';
import { clip } from '../../text.js';
import { REVIEWED } from '../shared.js';
import { resolveProgram } from '../command/index.js';
import { runClient } from '../engines/command.js';
import {
  FORBIDDEN_KEYS, FORBIDDEN_STAGES, PROTOCOL_KEYS, RESULT_LIMIT, WRITE_COMMANDS, boundCommand, judgeCommand, passwordParts, readCommand,
} from './document.js';
import { CLIENT_ARGS } from './script.js';

const MONGODB_KEYS = ['name', 'uriEnv', 'database', 'writes', 'joins', 'description', 'allow', 'review'];
const DATABASE_BAD = /[/\\. "$*<>:|?\p{Cc}]/u;
const MAX_DATABASE = 63;
const URI_SCHEMES = ['mongodb://', 'mongodb+srv://'];
const CONTROL_CHAR = /\p{Cc}/u;
const WRITE_NOT_REVIEWED = 'a command outside the read list runs only when a rule allows it';
const JOIN_NOT_REVIEWED = 'it reads other collections through $lookup, $graphLookup or $unionWith, which the reviewer cannot see';
const code = (items) => items.map((item) => `\`${item}\``).join(', ');

function checkDatabase(value, where) {
  const ok = typeof value === 'string' && value.length >= 1 && [...value].length <= MAX_DATABASE && !DATABASE_BAD.test(value);
  if (!ok) {
    throw new InventoryError(`${where}: database: must be 1 to ${MAX_DATABASE} characters without / \\ . " $ * < > : | ?, spaces or control characters`);
  }
  return value;
}

// writes and joins: false when absent.
function checkFlag(value, where, key) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InventoryError(`${where}: ${key}: must be true or false`);
  return value;
}

function checkMongoAllow(entry, where) {
  if (entry.allow === 'any') {
    throw new InventoryError(`${where}: allow: "any" is not supported for mongodb targets; list the commands`);
  }
  return checkAllow(entry, where, { any: false });
}

// The connection string as start read it: a mongodb:// or mongodb+srv:// string without control characters. The
// message names the variable, never the value.
function uriProblem(target, secrets) {
  const value = secrets[target.uriEnv];
  if (URI_SCHEMES.some((scheme) => value.startsWith(scheme)) && !CONTROL_CHAR.test(value)) return null;
  return `${target.uriEnv} does not hold a connection string that starts with mongodb:// or mongodb+srv://`;
}

// Why an unmatched command is not sent to the reviewer, who sees only the words, or null.
function notReviewedWhy({ write, joins }) {
  if (write) return WRITE_NOT_REVIEWED;
  return joins ? JOIN_NOT_REVIEWED : null;
}

// The reader, then the fixed refusals, then the rules. A fixed refusal has no unmatched, so no reviewer sees it.
function decideMongo(target, input) {
  let judged;
  try {
    judged = judgeCommand(readCommand(input), target);
  } catch (err) {
    return { allowed: false, reason: err.message, short: err.short };
  }
  const decision = { ...decide(judged.words, target.allow), argv: judged.words };
  const why = notReviewedWhy(judged);
  return decision.allowed || why === null ? decision : { ...decision, notReviewed: why };
}

// Runs one allowed call. The input is read and judged again (a decision after review keeps only the words), and that
// judged copy is bounded and sent as data in the client's environment, with the fixed arguments.
async function performMongo(target, decision, {
  env, secrets, timeoutMs, maxBytes, signal, input,
}) {
  const document = readCommand(input);
  judgeCommand(document, target);
  boundCommand(document, timeoutMs);
  return runClient({
    program: target.program,
    fixedArgs: CLIENT_ARGS,
    env,
    childEnv: { MGO_URI: secrets[target.uriEnv], MGO_DB: target.database, MGO_DOC: JSON.stringify(document) },
    homeInWorkFolder: true,
    timeoutMs,
    maxBytes,
    signal,
  });
}

// The passwords inside the connection string, as written and decoded; the core hides them with the whole string.
function hiddenForms(target, secrets) {
  return passwordParts(secrets[target.uriEnv]);
}

function agentLines(target) {
  return [
    `- Tool: \`mongodb_command\` with \`target: "${target.name}"\` and \`command\`: one JSON document in MongoDB's command format, the command name as its first key, for example \`{"find": "orders", "filter": {"status": "open"}, "limit": 10}\`. It runs against the database \`${target.database}\`. Values such as ObjectId and dates are written in Extended JSON: \`{"$oid": "..."}\`, \`{"$date": "..."}\`.`,
    `- Allowed commands: ${describeAllow(target.allow)}`,
    '- A rule sees the command name and, when its value is a string, the collection: `find orders`, `aggregate orders`, `listCollections`. For `explain` it sees `explain` and the words of the command inside it.',
    target.writes
      ? `- Writes: the commands that change data (${WRITE_COMMANDS.join(', ')}) run when a rule names them, and are never sent to the reviewer. Every other command outside the read list is refused.`
      : '- Read only: only read and diagnostic commands run (find, aggregate, count, distinct, the list and stats commands, ping, hello, explain).',
    `- Never allowed, whatever the rules: the keys ${code(FORBIDDEN_KEYS)} and the stages ${code(FORBIDDEN_STAGES)} anywhere in the document; eval, mapReduce, getMore, killCursors and the user, role, replica set and server administration commands.`,
    `- The client sets the database, the session and the transaction: a top-level key that starts with \`$\`, and ${code(PROTOCOL_KEYS).replace(/, (?=[^,]*$)/, ' and ')}, are refused.`,
    `- Results are bounded: \`find\` returns at most ${RESULT_LIMIT} documents in one batch (a smaller \`limit\` is kept), \`aggregate\` returns its first batch of at most ${RESULT_LIMIT}. An open cursor is closed and a line on stderr says more results exist; narrow the filter or use \`skip\` to see more. find, aggregate, count, distinct, listCollections, collStats and dbStats stop on the server just before the call's time limit, and so does the command inside explain.`,
    target.joins
      ? '- `$lookup`, `$graphLookup` and `$unionWith` read other collections than the one the rules see; a command that uses them is never sent to the reviewer.'
      : '- `$lookup`, `$graphLookup` and `$unionWith` are refused on this target, because they read collections other than the one the rules see. So is `create` with `viewOn` or `pipeline`, which makes a view over another collection.',
  ];
}

// The mongodb kind: a database reached with mongosh inside ksproxy start, which holds the connection string. The
// agent's document is data: mongosh runs only the fixed script.
export default {
  key: 'mongodb',
  flag: 'mongo',
  label: 'mgo',
  word: 'mongodb',
  noun: 'mongodb target',
  countNoun: 'mongodb target(s)',
  brokered: true,
  sample: [{
    name: 'orders-db',
    uriEnv: 'ORDERS_MONGO_URI',
    database: 'shop',
    description: 'orders, read only',
    joins: false,
    allow: ['find orders', 'count *', 'aggregate orders', 'listCollections'],
  }],
  hint(target) {
    return target.description ? `database ${target.database} - ${target.description}` : `database ${target.database}`;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, MONGODB_KEYS, where);
    const uriEnv = checkSecretVariable(entry.uriEnv, `${where}: uriEnv`, 'the connection string');
    const database = checkDatabase(entry.database, where);
    const writes = checkFlag(entry.writes, where, 'writes');
    const joins = checkFlag(entry.joins, where, 'joins');
    const allow = checkMongoAllow(entry, where);
    return {
      kind: 'mongodb',
      name: entry.name,
      uriEnv,
      database,
      writes,
      joins,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secrets(target) {
    return { env: [target.uriEnv], files: [] };
  },
  openingMessage(target) {
    return `database ${target.database}, connection string from ${target.uriEnv}, ${target.writes ? 'writes allowed by rule' : 'read only'}`;
  },
  open(target, { env, secrets }) {
    const problem = uriProblem(target, secrets);
    if (problem !== null) return { ok: false, error: problem };
    const resolved = resolveProgram(mongoshBin(env), env);
    return resolved.error === undefined ? { ok: true, extras: { program: resolved.program } } : { ok: false, error: resolved.error };
  },
  record(opened, { reviewed }) {
    const { target } = opened;
    return {
      kind: 'mongodb',
      name: target.name,
      description: target.description,
      allow: target.allow,
      database: target.database,
      uriEnv: target.uriEnv,
      writes: target.writes,
      joins: target.joins,
      program: opened.program,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'the call service is not answering';
  },
  backMessage: 'the call service is back',
  decide: decideMongo,
  perform: performMongo,
  hiddenForms,
  // ksproxy check mongo NAME DOCUMENT: the words joined into one JSON document; text that is not JSON is passed on
  // as a string, which the reader refuses.
  checkInput(words) {
    const text = words.join(' ');
    try {
      return { command: JSON.parse(text) };
    } catch {
      return { command: text };
    }
  },
  toolBullet: '- `mongodb_command { target, command, timeout_seconds? }` - run one allowlisted command document on a mongodb target.',
  agentSection(target) {
    const lines = [`### mongodb target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`, '', ...agentLines(target)];
    if (target.review === true) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'mongodb_command',
    nameKey: 'target',
    detailKey: 'request',
    detailIsArray: false,
    detailShape: 'object',
    // The call as the audit entry records it: the command name and the collection. Never the filter, the pipeline or
    // any other value.
    auditedDetail(detail) {
      const document = isObject(detail.command) ? detail.command : {};
      const [name] = Object.keys(document);
      const value = document[name];
      return {
        command: name === undefined ? null : clip(name, 64),
        collection: typeof value === 'string' ? clip(value, 128) : null,
      };
    },
    detailText(recorded) {
      if (typeof recorded.command !== 'string') return '(invalid)';
      return typeof recorded.collection === 'string' ? `${recorded.command} ${recorded.collection}` : recorded.command;
    },
    definition: {
      name: 'mongodb_command',
      description: 'Run one command on a mongodb target the user opened. The user fixed the server, the credential and the database; give one JSON document in MongoDB\'s command format, the command name first, for example {"find": "orders", "filter": {"status": "open"}}. Each command is checked against the target\'s allowlist and logged; results are bounded.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'object', description: 'One command document, the command name as its first key, for example {"count": "orders", "query": {"status": "open"}}' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
