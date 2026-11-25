import { decide, describeAllow, isRegexRule } from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkInteger, checkKeys, checkReview, checkSecretVariable,
} from '../../checks.js';
import { REVIEWED } from '../shared.js';
import { resolveProgram } from '../command/index.js';
import { runClient } from './command.js';
import { DOCTOR_MAX_BYTES, clientVerdict, hiddenOf } from './doctor.js';
import { matchStatementRule, readStatement, splitRule, sqlRuleWarnings } from './sql.js';

// What postgres and mysql share: the inventory fields, the session, the decision and running the client. A kind
// gives its names, its dialect, its fixed refusals, how its client is called and its notes.

const BASE_KEYS = ['name', 'host', 'port', 'database', 'user', 'passwordEnv', 'readOnly', 'description', 'allow', 'review'];
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MAX_HOST = 253;
const DB_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,62}$/;
// First words that change data, the schema or the server's statistics, in postgres or in mysql; refused on a
// read-only target before the rules. A word of one dialect only is not a statement in the other.
const WRITE_WORDS = [
  'insert', 'update', 'delete', 'merge', 'truncate', 'create', 'alter', 'drop', 'grant', 'revoke', 'comment', 'refresh',
  'reindex', 'cluster', 'call', 'replace', 'rename', 'vacuum', 'analyze', 'reassign', 'security', 'optimize', 'repair',
  'checksum', 'cache', 'load',
];
// A statement that starts with one of these can hold a statement that writes.
const WRAPPERS = ['with', 'explain'];
const NESTED_WRITES = ['insert', 'update', 'delete', 'merge'];

function checkDbHost(value, where) {
  if (typeof value !== 'string' || value.length > MAX_HOST || !HOST.test(value)) {
    throw new InventoryError(`${where}: host: must be a host name or address of letters, digits, "." and "-", at most ${MAX_HOST} characters, not starting with "-"`);
  }
  return value;
}

function checkDbName(value, at) {
  if (typeof value !== 'string' || !DB_NAME.test(value)) {
    throw new InventoryError(`${at}: must be 1 to 63 letters, digits, "_", "-" and ".", not starting with "-"`);
  }
  return value;
}

function checkReadOnly(value, where) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new InventoryError(`${where}: readOnly: must be true or false`);
  return value;
}

// A list of rules, never "any", each word rule split by the SQL reader.
function checkSqlAllow(entry, where, noun, dialect) {
  if (entry.allow === 'any') {
    throw new InventoryError(`${where}: allow: "any" is not supported for ${noun}s; list the statements`);
  }
  const allow = checkAllow(entry, where, { any: false });
  allow.forEach((rule, i) => {
    if (isRegexRule(rule)) return;
    try {
      splitRule(rule, dialect);
    } catch (err) {
      throw new InventoryError(`${where}: allow[${i}]: ${err.message}`);
    }
  });
  return allow;
}

// Whether a read-only target refuses the words: a first word that writes, a wrapper that holds one, or into followed
// by a name, which makes a new table (into followed by @ fills a mysql variable).
export function writesData(words) {
  if (WRITE_WORDS.includes(words[0])) return true;
  if (words.some((word, i) => word === 'into' && words[i + 1] !== '@')) return true;
  return WRAPPERS.includes(words[0]) && words.some((word) => NESTED_WRITES.includes(word));
}

function address(target) {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

// spec: key, flag, label, word, noun, countNoun, title, dialect, defaultPort, sample, extraKeys, extra(entry, where),
// fixedRefusal(words), program(target, env), invocation(target, statement, { password, timeoutMs }), notes, tool.
export function sqlServiceKind(spec) {
  const { key, dialect } = spec;
  const match = (words, rule) => matchStatementRule(words, rule, dialect);
  return {
    key,
    flag: spec.flag,
    label: spec.label,
    word: spec.word,
    noun: spec.noun,
    countNoun: spec.countNoun,
    brokered: true,
    sample: spec.sample,
    hint(target) {
      return target.description ? `${address(target)} - ${target.description}` : address(target);
    },
    validate(entry, where, { reviewers }) {
      checkKeys(entry, [...BASE_KEYS, ...spec.extraKeys], where);
      const host = checkDbHost(entry.host, where);
      const port = checkInteger(entry.port, spec.defaultPort, 1, 65535, `${where}: port`);
      const database = checkDbName(entry.database, `${where}: database`);
      const user = checkDbName(entry.user, `${where}: user`);
      const passwordEnv = checkSecretVariable(entry.passwordEnv, `${where}: passwordEnv`, 'the password');
      const readOnly = checkReadOnly(entry.readOnly, where);
      const allow = checkSqlAllow(entry, where, spec.noun, dialect);
      return {
        kind: key,
        name: entry.name,
        host,
        port,
        database,
        user,
        passwordEnv,
        readOnly,
        ...spec.extra(entry, where),
        description: entry.description ?? '',
        allow,
        ...checkReview(entry, where, reviewers, allow, { programs: false }),
      };
    },
    secrets(target) {
      return { env: [target.passwordEnv], files: [] };
    },
    ruleWarnings(target) {
      return sqlRuleWarnings(target.allow, dialect);
    },
    openingMessage(target) {
      return `${address(target)}, ${target.readOnly === false ? 'read-write' : 'read-only'}`;
    },
    open(target, { env }) {
      const resolved = resolveProgram(spec.program(target, env), env);
      return resolved.error === undefined ? { ok: true, extras: { program: resolved.program } } : { ok: false, error: resolved.error };
    },
    record(opened, { reviewed }) {
      const { review, ...target } = opened.target;
      return {
        ...target, program: opened.program, state: 'up', ...(reviewed ? { review: true } : {}),
      };
    },
    downMessage() {
      return 'the call service is not answering';
    },
    backMessage: 'the call service is back',
    // The reader, the fixed refusals and read-only come before the rules; none of their refusals is reviewed.
    decide(target, input) {
      let words;
      try {
        words = readStatement(input, dialect);
      } catch (err) {
        return { allowed: false, reason: err.message, short: err.short };
      }
      const fixed = spec.fixedRefusal(words);
      if (fixed !== null) return { allowed: false, ...fixed };
      if (target.readOnly !== false && writesData(words)) {
        return { allowed: false, reason: `"${words[0]}" can change data or the schema, and this target is read-only`, short: 'read-only target' };
      }
      return { ...decide(words, target.allow, match), argv: words };
    },
    // The statement the agent sent, as one argument; the password only in the child's environment.
    perform(target, decision, {
      env, secrets, timeoutMs, maxBytes, signal, input,
    }) {
      const {
        fixedArgs, words, childEnv, folderPaths,
      } = spec.invocation(target, input, { password: secrets[target.passwordEnv], timeoutMs });
      return runClient({
        program: target.program, fixedArgs, words, env, childEnv, folderPaths, timeoutMs, maxBytes, signal,
      });
    },
    // The doctor check: select 1 through the same client and invocation as a call, on the program open resolved.
    async doctor(opened, {
      env, secrets, timeoutMs, signal,
    }) {
      const { target } = opened;
      const {
        fixedArgs, words, childEnv, folderPaths,
      } = spec.invocation(target, 'select 1', { password: secrets[target.passwordEnv], timeoutMs });
      const result = await runClient({
        program: opened.program, fixedArgs, words, env, childEnv, folderPaths, timeoutMs, maxBytes: DOCTOR_MAX_BYTES, signal,
      });
      return clientVerdict(result, {
        name: spec.word, describe: () => 'select 1 answered', hidden: hiddenOf(secrets), signal,
      });
    },
    toolBullet: `- \`${spec.tool.name} { target, query, timeout_seconds? }\` - run one allowlisted SQL statement on a ${spec.title} target.`,
    agentSection(target) {
      const lines = [
        `### ${spec.title} target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
        '',
        `- Tool: \`${spec.tool.name}\` with \`target: "${target.name}"\` and one SQL statement in \`query\`.`,
        `- Allowed statements: ${describeAllow(target.allow)}`,
        '- One statement of plain SQL: a `;` only at the very end, no comments, no backslash, no `$`, no prefixed strings such as `E\'...\'`. Quote a string with single quotes and double a quote inside it.',
        '- In a rule, `*` is one value: a number such as `42`, `-1` or `1.5`, or one string in single quotes; never a name, a keyword such as `null`, or anything in brackets. `\\*` is the SQL star and `...` is the rest. Keywords and names are compared in lower case; a quoted string or name must match as written.',
        target.readOnly === false
          ? '- The user allowed changes on this target.'
          : '- Read-only: the statement runs in a read-only transaction, and a statement that changes data or the schema is refused.',
        ...spec.notes,
        '- The output stops at the output limit. The rights of the database user are the real limit of what a statement can do.',
      ];
      if (target.review === true) lines.push(REVIEWED);
      return lines.join('\n');
    },
    tool: {
      name: spec.tool.name,
      nameKey: 'target',
      detailKey: 'query',
      detailIsArray: false,
      definition: {
        name: spec.tool.name,
        description: `Run one SQL statement on a ${spec.title} target the user opened. The statement is checked against the target's allowlist and logged; one statement only, without comments.`,
        inputSchema: {
          type: 'object',
          required: ['target', 'query'],
          additionalProperties: false,
          properties: {
            target: { type: 'string', description: 'Target name from list_targets' },
            query: { type: 'string', description: 'One SQL statement' },
            timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
          },
        },
      },
    },
  };
}
