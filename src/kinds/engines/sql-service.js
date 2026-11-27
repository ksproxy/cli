import fs from 'node:fs';
import path from 'node:path';
import { decide, describeAllow, isRegexRule } from '../../allowlist.js';
import {
  InventoryError, absolutePath, checkAllow, checkInteger, checkKeys, checkReview, checkSecretVariable,
} from '../../checks.js';
import { REVIEWED } from '../shared.js';
import { resolveProgram } from '../command/index.js';
import { runClient } from './command.js';
import { DOCTOR_MAX_BYTES, clientVerdict, hiddenOf } from './doctor.js';
import { matchStatementRule, readStatement, splitRule, sqlRuleWarnings } from './sql.js';

// What postgres and mysql share: the inventory fields, the session, the decision and running the client. A kind
// gives its names, its dialect, its fixed refusals, how its client is called and its notes.

const BASE_KEYS = ['name', 'host', 'port', 'database', 'user', 'passwordEnv', 'readOnly', 'tls', 'caFile', 'description', 'allow', 'review'];
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const MAX_HOST = 253;
const DB_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,62}$/;
const TLS_MODES = ['verify', 'require', 'prefer'];
// A host on this machine: localhost, or an IPv4 address 127.x.x.x. The host field holds no IPv6 address and no socket.
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3})$/i;
// The time limit of the TLS check when a target opens; a check that ends at it opens the target, as before.
const TLS_CHECK_MS = 5000;
// What the clients print when TLS fails: libpq older than 16 reads PGSSLROOTCERT=system as a file name; psql, the
// MariaDB client and the MySQL client each say the server does not support TLS; every check of a certificate names it.
const OLD_LIBPQ = /root certificate file "system" does not exist/;
const NO_TLS = /does not support SSL|does not support it|doesn't support it/i;
const BAD_CERT = /certificate/i;
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

// Whether the host is this machine, where no one between ksproxy and the server can read the connection.
export const isLoopback = (host) => LOOPBACK.test(host);

// verify when left out, unless the host is this machine: then prefer, so that a local database keeps working.
function checkTls(entry, host, where) {
  if (entry.tls === undefined) return isLoopback(host) ? 'prefer' : 'verify';
  if (!TLS_MODES.includes(entry.tls)) throw new InventoryError(`${where}: tls: must be "verify", "require" or "prefer"`);
  return entry.tls;
}

// The CA file a verify target trusts: absolute or after ~/, expanded and normalised; null when left out. With require
// or prefer nothing checks the certificate, so the file would do nothing there.
function checkCaFile(entry, tls, where) {
  if (entry.caFile === undefined) return null;
  const file = path.resolve(absolutePath(entry.caFile, `${where}: caFile`));
  if (tls !== 'verify') {
    const why = entry.tls === undefined ? ', the default for a host on this machine' : '';
    throw new InventoryError(`${where}: caFile: is used only with "tls": "verify"; this target has "tls": "${tls}"${why}`);
  }
  return file;
}

function isReadableFile(file) {
  try {
    fs.accessSync(file, fs.constants.R_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Why a failed TLS check skips the target, from the client's standard error: { error, wayOut }, or null when the
// failure is not about TLS. error is the short reason of the SKIPPED line; wayOut names the fields that fix it.
export function tlsFailure(text, target) {
  if (OLD_LIBPQ.test(text)) {
    return { error: 'this psql cannot use the system\'s CAs', wayOut: 'using the system\'s CAs needs libpq 16 or later; name the CA that signed the server\'s certificate in "caFile"' };
  }
  if (NO_TLS.test(text)) {
    return { error: 'the server does not offer TLS', wayOut: `"tls" is "${target.tls}", which needs TLS; set "tls" to "prefer" to connect without it` };
  }
  if (!BAD_CERT.test(text)) return null;
  return {
    error: 'the server\'s TLS certificate did not verify',
    wayOut: target.caFile === null
      ? `the certificate was checked against the system's CAs and the host name ${target.host}; name the CA that signed it in "caFile", or set "tls" to "require" or "prefer" to skip the check`
      : `the certificate was checked against the CA in "caFile" and the host name ${target.host}; check that "caFile" names the CA that signed it, and that the certificate names this host`,
  };
}

// The TLS check when a target opens: select 1 through the client and the settings of a call. Gives what tlsFailure
// gives for a failure; any answer, any other failure, the time limit and a stop give null.
async function tlsCheck(spec, target, program, { env, secrets, signal }) {
  const {
    fixedArgs, words, childEnv, folderPaths,
  } = spec.invocation(target, 'select 1', { password: secrets[target.passwordEnv], timeoutMs: TLS_CHECK_MS });
  const result = await runClient({
    program, fixedArgs, words, env, childEnv, folderPaths, timeoutMs: TLS_CHECK_MS, maxBytes: DOCTOR_MAX_BYTES, signal,
  });
  return result.exitCode === 0 ? null : tlsFailure(result.stderr, target);
}

// What open learned about the client and every call needs: the mysql family, when there is one.
const learnedOf = (opened) => (opened.family === undefined ? {} : { family: opened.family });

const tlsText = (target) => `TLS ${target.tls}${target.caFile === null ? '' : ' with caFile'}`;

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
// fixedRefusal(words), program(target, env), invocation(target, statement, { password, timeoutMs }), notes, tool, and
// optionally clientFamily(target, program, ctx), which gives { family } or { error, wayOut } before the TLS check.
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
      const tls = checkTls(entry, host, where);
      const caFile = checkCaFile(entry, tls, where);
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
        tls,
        caFile,
        ...spec.extra(entry, where),
        description: entry.description ?? '',
        allow,
        ...checkReview(entry, where, reviewers, allow, { programs: false }),
      };
    },
    secrets(target) {
      return { env: [target.passwordEnv], files: [] };
    },
    // The password as a reply of this client can show it when that is not the password as it is, from the kind's
    // printedForms; the core hides these forms with the password.
    hiddenForms(target, secrets) {
      return spec.printedForms(secrets[target.passwordEnv]);
    },
    // The CA files, which no local target may reach, so that no agent can replace one. The entries of another
    // inventory file come here as they are written; otherSecretFiles keeps the texts that are paths.
    secretFiles(targets) {
      return targets.map((target) => target.caFile).filter((file) => typeof file === 'string');
    },
    ruleWarnings(target) {
      return sqlRuleWarnings(target.allow, dialect);
    },
    openingMessage(target) {
      return `${address(target)}, ${target.readOnly === false ? 'read-write' : 'read-only'}, ${tlsText(target)}`;
    },
    // The program; for verify and require also the CA file, what the kind learns about its client, and the TLS check.
    // A failure skips the target, and the way out is said on a line of its own, which is never cut.
    async open(target, ctx) {
      const resolved = resolveProgram(spec.program(target, ctx.env), ctx.env);
      if (resolved.error !== undefined) return { ok: false, error: resolved.error };
      const { program } = resolved;
      if (target.tls === 'prefer') return { ok: true, extras: { program } };
      if (target.caFile !== null && !isReadableFile(target.caFile)) {
        return { ok: false, error: `caFile ${target.caFile} is not a file that can be read` };
      }
      const learned = spec.clientFamily === undefined ? {} : await spec.clientFamily(target, program, ctx);
      const failure = learned.error === undefined ? await tlsCheck(spec, { ...target, ...learned }, program, ctx) : learned;
      if (failure === null) return { ok: true, extras: { program, ...learned } };
      ctx.say(failure.wayOut);
      return { ok: false, error: failure.error };
    },
    record(opened, { reviewed }) {
      const { review, ...target } = opened.target;
      return {
        ...target, program: opened.program, ...learnedOf(opened), state: 'up', ...(reviewed ? { review: true } : {}),
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
    // The doctor check: select 1 through the same client and invocation as a call, on the program open resolved, with
    // what open learned about the client.
    async doctor(opened, {
      env, secrets, timeoutMs, signal,
    }) {
      const target = { ...opened.target, ...learnedOf(opened) };
      const {
        fixedArgs, words, childEnv, folderPaths,
      } = spec.invocation(target, 'select 1', { password: secrets[target.passwordEnv], timeoutMs });
      const result = await runClient({
        program: opened.program, fixedArgs, words, env, childEnv, folderPaths, timeoutMs, maxBytes: DOCTOR_MAX_BYTES, signal,
      });
      return clientVerdict(result, {
        name: spec.word, describe: () => 'select 1 answered', hidden: hiddenOf(secrets, spec.printedForms(secrets[target.passwordEnv])), signal,
      });
    },
    toolBullet: `- \`${spec.tool.name} { target, query, timeout_seconds? }\` - run one allowlisted SQL statement on a ${spec.title} target.`,
    cutHint: 'fewer columns, a WHERE and a LIMIT, or count(*) first',
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
