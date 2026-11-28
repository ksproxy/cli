import { decide, describeAllow } from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable, isObject,
} from '../../checks.js';
import { mongoshBin } from '../../paths.js';
import { clip } from '../../text.js';
import { REVIEWED, jsonForms } from '../shared.js';
import { resolveProgram } from '../command/index.js';
import { runClient } from '../engines/command.js';
import { DOCTOR_MAX_BYTES, clientVerdict, hiddenOf, shown } from '../engines/doctor.js';
import { hideSecrets } from '../engines/http.js';
import {
  FORBIDDEN_KEYS, FORBIDDEN_STAGES, PROTOCOL_KEYS, RESULT_LIMIT, WRITE_COMMANDS, boundCommand, judgeCommand, passwordParts, readCommand,
  serviceAddress, throughTunnel,
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

// tunnelTo: the one host of the connection string, for the tunnel's last server, or { error } with a refusal that
// holds no part of the string.
function tunnelToMongo(target, secrets) {
  const problem = uriProblem(target, secrets);
  return problem === null ? serviceAddress(secrets[target.uriEnv]) : { error: problem };
}

// The connection string mongosh gets: the secret as it is without a tunnel, else throughTunnel with the loopback
// address of the tunnel.
function clientUri(tunnel, uri) {
  return tunnel === undefined ? uri : throughTunnel(uri, `${tunnel.host}:${tunnel.port}`);
}

// What a call through a tunnel hides itself, with the core's texts: the core does not know the rewritten string or the
// loopback address, which mongosh can print in an error. The secret values and forms are hidden in the same step, so
// that taking out the address can never split one of them.
function tunnelHidden(target, secrets, uri, tunnel) {
  return [...hiddenOf(secrets, hiddenForms(target, secrets)), uri, ...jsonForms([uri]), `${tunnel.host}:${tunnel.port}`];
}

// Runs one allowed call. The input is read and judged again (a decision after review keeps only the words), and that
// judged copy is bounded and sent as data in the client's environment, with the fixed arguments. Without a tunnel the
// result is the client's as it is; with one, tunnelHidden is hidden in both streams.
async function performMongo(target, decision, {
  env, secrets, timeoutMs, maxBytes, signal, input, opened,
}) {
  const document = readCommand(input);
  judgeCommand(document, target);
  boundCommand(document, timeoutMs);
  const tunnel = opened?.tunnel;
  const uri = clientUri(tunnel, secrets[target.uriEnv]);
  const result = await runClient({
    program: target.program,
    fixedArgs: CLIENT_ARGS,
    env,
    childEnv: { MGO_URI: uri, MGO_DB: target.database, MGO_DOC: JSON.stringify(document) },
    homeInWorkFolder: true,
    timeoutMs,
    maxBytes,
    signal,
  });
  if (tunnel === undefined) return result;
  const hidden = tunnelHidden(target, secrets, uri, tunnel);
  return { ...result, stdout: hideSecrets(result.stdout, hidden), stderr: hideSecrets(result.stderr, hidden) };
}

// The passwords inside the connection string, as written and decoded, and each of them and the whole string as the
// reply shows a value: the fixed script prints extended JSON, which escapes a quote, a backslash and the control
// characters. The core hides them with the whole string.
function hiddenForms(target, secrets) {
  const parts = passwordParts(secrets[target.uriEnv]);
  return [...parts, ...jsonForms([secrets[target.uriEnv], ...parts])];
}

// The program of the check: the one open resolved, or, in the trial of a tunnel, which runs before open, the one open
// would resolve.
function programOf(opened, env) {
  return opened.program === undefined ? resolveProgram(mongoshBin(env), env) : { program: opened.program };
}

// The doctor check: the ping command through the same client and fixed script as a call, never a command of the agent,
// through the tunnel when the entry has one. Its detail is always a fixed text of clientVerdict.
async function doctorMongo(opened, {
  env, secrets, timeoutMs, signal,
}) {
  const { target } = opened;
  const hidden = hiddenOf(secrets, hiddenForms(target, secrets));
  const resolved = programOf(opened, env);
  if (resolved.error !== undefined) return { ok: false, detail: shown(resolved.error, hidden) };
  const result = await runClient({
    program: resolved.program,
    fixedArgs: CLIENT_ARGS,
    env,
    childEnv: { MGO_URI: clientUri(opened.tunnel, secrets[target.uriEnv]), MGO_DB: target.database, MGO_DOC: JSON.stringify({ ping: 1 }) },
    homeInWorkFolder: true,
    timeoutMs,
    maxBytes: DOCTOR_MAX_BYTES,
    signal,
  });
  return clientVerdict(result, {
    name: 'mongosh',
    describe: (text) => (JSON.parse(text).ok === 1 ? 'ping answered' : null),
    hidden,
    signal,
  });
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
  doctor: doctorMongo,
  hiddenForms,
  // Through a tunnel mongosh gets a loopback port of start, and the connection string with its host list replaced.
  tunnelListener: true,
  tunnelTo: tunnelToMongo,
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
  cutHint: 'a filter, a projection and a limit; page with _id greater than the last one',
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
