import net from 'node:net';
import { decide, describeAllow } from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkInteger, checkKeys, checkReview, checkSecretVariable,
} from '../../checks.js';
import { REVIEWED } from '../shared.js';
import { DOCTOR_MAX_BYTES, hiddenOf, respVerdict } from '../engines/doctor.js';
import { escapeText, exchange } from '../engines/resp.js';
import {
  fixedRefusal, matchCommandRule, normalizeWords, readCommand,
} from './words.js';

const REDIS_KEYS = ['name', 'host', 'port', 'tls', 'db', 'userEnv', 'passwordEnv', 'description', 'allow', 'review'];
const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

function checkHostName(value, where) {
  if (typeof value === 'string' && (net.isIP(value) !== 0 || HOSTNAME_RE.test(value))) return value;
  throw new InventoryError(`${where}: host: must be a host name or an IP address`);
}

function checkTls(value, where) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InventoryError(`${where}: tls: must be true or false`);
  return value;
}

// The two variable names, each null when absent; a user name needs a password.
function checkCredentials(entry, where) {
  const passwordEnv = entry.passwordEnv === undefined ? null : checkSecretVariable(entry.passwordEnv, `${where}: passwordEnv`, 'the password');
  if (entry.userEnv === undefined) return { userEnv: null, passwordEnv };
  const userEnv = checkSecretVariable(entry.userEnv, `${where}: userEnv`, 'the user name');
  if (passwordEnv === null) throw new InventoryError(`${where}: userEnv: needs passwordEnv as well`);
  return { userEnv, passwordEnv };
}

function authText(target) {
  if (target.passwordEnv === null) return 'no password';
  if (target.userEnv === null) return `password from ${target.passwordEnv}`;
  return `user from ${target.userEnv} and password from ${target.passwordEnv}`;
}

// The normalised words, or the refusal of the strict reader or of the fixed list. Used by decide and by perform.
function judged(input) {
  let words;
  try {
    words = normalizeWords(readCommand(input));
  } catch (err) {
    return { refusal: { allowed: false, reason: err.message, short: err.short } };
  }
  const fixed = fixedRefusal(words);
  return fixed === null ? { words } : { refusal: { allowed: false, ...fixed } };
}

// The redis kind: ksproxy start speaks the Redis protocol itself through the resp engine and holds the password.
export default {
  key: 'redis',
  flag: 'redis',
  label: 'rds',
  word: 'redis',
  noun: 'redis target',
  countNoun: 'redis target(s)',
  brokered: true,
  sample: [{
    name: 'cache',
    host: 'cache.internal',
    port: 6379,
    passwordEnv: 'REDIS_PASSWORD',
    description: 'cache, read only',
    allow: ['GET *', 'TTL *', 'HGETALL *', 'KEYS user:*', 'INFO ...'],
  }],
  hint(target) {
    const at = `${target.host}:${target.port}`;
    return target.description ? `${at} - ${target.description}` : at;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, REDIS_KEYS, where);
    const host = checkHostName(entry.host, where);
    const port = checkInteger(entry.port, 6379, 1, 65535, `${where}: port`);
    const tls = checkTls(entry.tls, where);
    const db = checkInteger(entry.db, 0, 0, 65535, `${where}: db`);
    const credentials = checkCredentials(entry, where);
    const allow = checkAllow(entry, where);
    return {
      kind: 'redis',
      name: entry.name,
      host,
      port,
      tls,
      db,
      ...credentials,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secrets(target) {
    const users = target.userEnv === null ? {} : { users: [target.userEnv] };
    return { env: [target.userEnv, target.passwordEnv].filter((name) => name !== null), files: [], ...users };
  },
  openingMessage(target) {
    const tls = target.tls ? ' over TLS' : '';
    const db = target.db === 0 ? '' : `, database ${target.db}`;
    return `${target.host}:${target.port}${tls}${db}, ${authText(target)}`;
  },
  open() {
    return { ok: true, extras: {} };
  },
  record(opened, { reviewed }) {
    const { target } = opened;
    return {
      kind: 'redis',
      name: target.name,
      description: target.description,
      allow: target.allow,
      host: target.host,
      port: target.port,
      tls: target.tls,
      db: target.db,
      userEnv: target.userEnv,
      passwordEnv: target.passwordEnv,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'the call service is not answering';
  },
  backMessage: 'the call service is back',
  decide(target, input) {
    const { words, refusal } = judged(input);
    if (refusal !== undefined) return refusal;
    return { ...decide(words, target.allow, matchCommandRule), argv: words };
  },
  // The command is read and checked against the fixed list again, so that no path (a reviewer's approval included)
  // can send a fixed refusal; a refusal here throws, which the core turns into a refusal.
  async perform(target, decision, {
    secrets, timeoutMs, maxBytes, signal, input,
  }) {
    const words = normalizeWords(readCommand(input));
    const fixed = fixedRefusal(words);
    if (fixed !== null) throw new Error(fixed.reason);
    return exchange({
      host: target.host,
      port: target.port,
      tls: target.tls,
      db: target.db,
      user: target.userEnv === null ? undefined : secrets[target.userEnv],
      password: target.passwordEnv === null ? undefined : secrets[target.passwordEnv],
      words,
      timeoutMs,
      maxBytes,
      signal,
    });
  },
  // The user name and the password as a reply shows them inside a string, escaped; the core hides them with the values.
  hiddenForms(target, secrets) {
    return Object.values(secrets).map(escapeText);
  },
  // The doctor check: PING through the same exchange as a call, never a command of the agent.
  async doctor(opened, { secrets, timeoutMs, signal }) {
    const { target } = opened;
    const result = await exchange({
      host: target.host,
      port: target.port,
      tls: target.tls,
      db: target.db,
      user: target.userEnv === null ? undefined : secrets[target.userEnv],
      password: target.passwordEnv === null ? undefined : secrets[target.passwordEnv],
      words: ['PING'],
      timeoutMs,
      maxBytes: DOCTOR_MAX_BYTES,
      signal,
    });
    return respVerdict(result, { hidden: hiddenOf(secrets, Object.values(secrets).map(escapeText)), signal });
  },
  toolBullet: '- `redis_command { target, command, timeout_seconds? }` - run one Redis command on a redis target.',
  agentSection(target) {
    const lines = [
      `### redis target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`redis_command\` with \`target: "${target.name}"\`. Give one command as plain words, for example \`GET user:42\`. The user fixed the server, the database and the credential.`,
      `- Allowed commands: ${describeAllow(target.allow)}`,
    ];
    if (target.allow !== 'any') {
      lines.push('- The command name, and the subcommand of CONFIG, CLIENT, ACL, CLUSTER and the like, are compared without regard to letter case; every other word exactly. `*` matches one word that does not start with "-", `...` the rest, and a star inside a word is literal.');
    }
    lines.push(
      '- A word may hold letters, digits and `_ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |`; a value with a space, a quote or a backslash cannot be sent.',
      '- Never allowed, whatever the rules say: scripts and functions (EVAL, FCALL, FUNCTION, SCRIPT, TFCALL, TFUNCTION), MODULE, DEBUG, commands that change the whole server (FLUSHALL, FLUSHDB, SHUTDOWN, SAVE, RESTORE, replication), commands that block or never return (MONITOR, SUBSCRIBE, blocking pops, XREAD with BLOCK, WAIT), connection commands (AUTH, HELLO, SELECT, MULTI and the like), CONFIG, ACL, CLIENT and CLUSTER except their read-only forms, and CONFIG GET with a pattern (`*`, `?`, `[`) or with a name that holds `pass`, `auth` or `masteruser`, because those return credentials.',
      '- The reply is shown as the usual client shows it: strings in double quotes with special characters escaped, (integer) N, (nil), numbered lists.',
    );
    if (target.review) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'redis_command',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'redis_command',
      description: 'Run one Redis command on a redis target the user opened. The user fixed the server and the credential; give the command as plain words, for example "GET user:42". Each command is checked against the target\'s allowlist and logged.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'One Redis command as plain words separated by spaces, at most 4096 bytes and 64 words, without quotes or backslashes' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
