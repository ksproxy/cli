import { AllowError, isRegexRule, matchRule } from '../../allowlist.js';
import { clip } from '../../text.js';

// The words of a redis command: the strict reader, the fixed refusals that no rule can override, and how a rule is
// matched. The command name, and the subcommand of a command that has subcommands, are upper-cased in the command and
// in every word rule before matching; a regex(...) rule sees the command in that same form.

export const MAX_COMMAND_BYTES = 4096;
export const MAX_WORDS = 64;
const WORD_RE = /^[A-Za-z0-9_@%+=:,./\-*?[\]{}!~^$#&()<>|]+$/;
const WORD_CHAR = /^[A-Za-z0-9_@%+=:,./\-*?[\]{}!~^$#&()<>|]$/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PLAIN_WORDS = 'a redis command is plain words made of letters, digits and _ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |; '
  + 'a value with a space, a quote or a backslash cannot be sent';
const WITH_SUBCOMMANDS = ['ACL', 'CLIENT', 'CLUSTER', 'COMMAND', 'CONFIG', 'FUNCTION', 'LATENCY', 'MEMORY', 'MODULE', 'OBJECT', 'PUBSUB',
  'SCRIPT', 'SLOWLOG', 'XGROUP', 'XINFO'];

const GROUPS = {
  code: { short: 'runs server code', why: 'it runs code on the server' },
  server: { short: 'server-wide command', why: 'it changes the whole server or all of its data' },
  blocking: { short: 'blocking command', why: 'it blocks or never returns' },
  connection: { short: 'connection command', why: 'ksproxy sets up the connection itself' },
};
const NEVER = new Map(Object.entries({
  code: ['EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO', 'FCALL', 'FCALL_RO', 'FUNCTION', 'SCRIPT', 'MODULE', 'DEBUG', 'TFCALL', 'TFCALLASYNC',
    'TFUNCTION', 'PFDEBUG', 'PFSELFTEST'],
  server: ['SHUTDOWN', 'FLUSHALL', 'FLUSHDB', 'SWAPDB', 'REPLICAOF', 'SLAVEOF', 'FAILOVER', 'MIGRATE', 'RESTORE', 'RESTORE-ASKING', 'SAVE', 'BGSAVE',
    'BGREWRITEAOF', 'REPLCONF'],
  blocking: ['MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'SYNC', 'PSYNC', 'WAIT', 'WAITAOF', 'BLPOP', 'BRPOP', 'BLMOVE', 'BRPOPLPUSH',
    'BZPOPMIN', 'BZPOPMAX', 'BLMPOP', 'BZMPOP'],
  connection: ['AUTH', 'HELLO', 'RESET', 'QUIT', 'SELECT', 'MULTI', 'EXEC', 'WATCH', 'DISCARD'],
}).flatMap(([group, names]) => names.map((name) => [name, GROUPS[group]])));
// The commands allowed only with one of these subcommands.
const ONLY = {
  CLUSTER: ['INFO', 'NODES', 'SLOTS', 'SHARDS', 'MYID'],
  CONFIG: ['GET'],
  ACL: ['WHOAMI'],
  CLIENT: ['INFO', 'ID', 'GETNAME'],
};
const BLOCKING_READS = ['XREAD', 'XREADGROUP'];
// A CONFIG GET argument that is a pattern, or a name that holds one of these, can return a credential of the server
// (masterauth, masteruser, the TLS key passphrases): requirepass is the only one ksproxy hides, because it holds it.
const CONFIG_PATTERN = /[*?[\\]/;
const CONFIG_SECRET_WORDS = ['pass', 'auth', 'masteruser'];

function describeChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x21 || code > 0x7e) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `"${ch}"`;
}

// The words of the command as given, or AllowError(reason, short).
export function readCommand(command) {
  if (typeof command !== 'string') throw new AllowError('command must be a string', 'invalid command');
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) {
    throw new AllowError(`command is longer than ${MAX_COMMAND_BYTES} bytes`, 'command too long');
  }
  const words = command.split(/[ \t]+/).filter(Boolean);
  if (words.length === 0) throw new AllowError('command is empty', 'empty command');
  if (words.length > MAX_WORDS) throw new AllowError(`command has more than ${MAX_WORDS} words`, 'too many words');
  const odd = words.find((word) => !WORD_RE.test(word));
  if (odd !== undefined) {
    const ch = describeChar([...odd].find((c) => !WORD_CHAR.test(c)));
    throw new AllowError(`character ${ch} is not allowed: ${PLAIN_WORDS}`, `character ${ch} not allowed`);
  }
  if (!NAME_RE.test(words[0])) {
    throw new AllowError('the first word must be a command name made of letters, digits, "_" and "-"', 'invalid command name');
  }
  return words;
}

// The command name upper-cased, and the subcommand too when the command has subcommands. Used on the words of a
// command and on the words of a word rule alike.
export function normalizeWords(words) {
  const out = [...words];
  out[0] = out[0].toUpperCase();
  if (out.length > 1 && WITH_SUBCOMMANDS.includes(out[0])) out[1] = out[1].toUpperCase();
  return out;
}

function listOf(names) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// The first argument of CONFIG GET that is a pattern or names a credential, in lower case, or undefined.
function configSecret(args) {
  return args.map((arg) => arg.toLowerCase()).find((arg) => CONFIG_PATTERN.test(arg) || CONFIG_SECRET_WORDS.some((word) => arg.includes(word)));
}

// null, or { reason, short } when the command is one that no rule, reviewer or check may allow.
export function fixedRefusal(words) {
  const name = words[0].toUpperCase();
  const never = (what, why, short) => ({ reason: `${what} is never allowed on a redis target: ${why}`, short });
  const group = NEVER.get(name);
  if (group !== undefined) return never(name, group.why, group.short);
  const only = ONLY[name];
  if (only !== undefined) {
    const sub = words.length > 1 ? words[1].toUpperCase() : null;
    if (sub === 'GET' && name === 'CONFIG') {
      const secret = configSecret(words.slice(2));
      if (secret === undefined) return null;
      return never(`CONFIG GET ${clip(secret, 40)}`, 'a pattern or a name that holds pass, auth or masteruser can return credentials', 'config pattern or credential refused');
    }
    if (sub !== null && only.includes(sub)) return null;
    const allowed = only.map((s) => `${name} ${s}`);
    return never(sub === null ? `${name} without a subcommand` : `${name} ${sub}`, `of ${name} only ${listOf(allowed)} ${allowed.length === 1 ? 'is' : 'are'} allowed`, 'subcommand not allowed');
  }
  if (BLOCKING_READS.includes(name) && words.some((word) => word.toUpperCase() === 'BLOCK')) {
    return never(`${name} with BLOCK`, GROUPS.blocking.why, GROUPS.blocking.short);
  }
  return null;
}

// Whether one rule matches the normalised words. A word rule is normalised the same way first; a regex rule is tried
// on the normalised words joined by single spaces. The shared matcher does the rest: * one word, ... the rest,
// \* a literal star word, a star inside a word literal.
export function matchCommandRule(words, rule) {
  if (isRegexRule(rule)) return matchRule(words, rule);
  return matchRule(words, normalizeWords(rule.trim().split(/\s+/)).join(' '));
}
