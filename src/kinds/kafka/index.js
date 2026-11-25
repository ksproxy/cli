import fs from 'node:fs';
import path from 'node:path';
import {
  decide, describeAllow, isRegexRule, regexSource, tokenizeSshCommand,
} from '../../allowlist.js';
import {
  InventoryError, absolutePath, checkAllow, checkKeys, checkReview,
} from '../../checks.js';
import { clip } from '../../text.js';
import { REVIEWED } from '../shared.js';
import { hasLookaround, matchCommandRule, resolveProgram } from '../command/index.js';
import { runClient } from '../engines/command.js';
import { DOCTOR_MAX_BYTES, clientVerdict, hiddenOf, shown } from '../engines/doctor.js';

const KAFKA_KEYS = ['name', 'bootstrap', 'clientConfig', 'binDir', 'writes', 'description', 'allow', 'review'];
const PROGRAMS = new Map([
  ['topics', 'kafka-topics'],
  ['groups', 'kafka-consumer-groups'],
  ['configs', 'kafka-configs'],
  ['acls', 'kafka-acls'],
  ['log-dirs', 'kafka-log-dirs'],
  ['broker-api-versions', 'kafka-broker-api-versions'],
]);
const FIRST_WORDS = [...PROGRAMS.keys()].join(', ');
const HOST_PORT = /^([A-Za-z0-9.][A-Za-z0-9.-]{0,252}):([1-9][0-9]{0,4})$/;
const MAX_PORT = 65535;
const FIXED_OPTIONS = [
  'bootstrap-server', 'bootstrap-controller', 'command-config', 'config-file', 'zookeeper', 'zk-tls-config-file', 'admin.config',
  'consumer.config', 'producer.config', 'consumer-property', 'producer-property', 'command-property', 'add-config-file',
  'delete-config-file', 'offsets-file', 'from-file', 'reassignment-json-file', 'path-to-json-file', 'truststore', 'keystore',
];
const FILE_LIKE = /file|config|propert/;
const WRITE_FLAGS = [
  'create', 'delete', 'alter', 'add', 'remove', 'add-config', 'delete-config', 'reset-offsets', 'delete-offsets', 'execute', 'partitions',
  'replication-factor', 'replica-assignment', 'force', 'delete-records', 'to-earliest', 'to-latest', 'to-offset', 'to-datetime',
  'to-current', 'shift-by', 'by-duration',
];
const FILE_LIKE_OK = ['entity-type', 'entity-name', 'entity-default', 'describe', 'all', ...WRITE_FLAGS];
const NAME_FLAGS = ['--topic', '--group', '--entity-name', '--principal'];
const MIN_ABBREVIATION = 2;
const PATH_START = /^[/~.]/;

// A word that starts with "-" is an option: its name is the text after the dashes up to a "=", in lower case.
const optionName = (word) => (word.startsWith('-') ? word.toLowerCase().split('=')[0].replace(/^-+/, '') : null);

const refuse = (reason, short) => ({ allowed: false, reason, short });

function checkBootstrap(value, where) {
  const entries = typeof value === 'string' ? value.split(',') : [];
  const valid = (entry) => {
    const match = HOST_PORT.exec(entry);
    return match !== null && Number(match[2]) <= MAX_PORT;
  };
  if (entries.length === 0 || !entries.every(valid)) {
    throw new InventoryError(`${where}: bootstrap: must be one or more host:port joined by commas (a host of letters, digits, dots and "-" that does not start with "-", and a port from 1 to 65535)`);
  }
  return value;
}

// An optional file or folder: absolute or after ~/, expanded and normalised; null when left out.
const optionalPath = (value, at) => (value === undefined ? null : path.resolve(absolutePath(value, at)));

function checkWrites(value, where) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new InventoryError(`${where}: writes: must be true or false`);
  return value;
}

// A regex rule is matched as on a command target: a flag written inside a lookaround would count as written by the
// pattern, so such a rule is refused here.
function checkKafkaAllow(entry, where) {
  if (entry.allow === 'any') {
    throw new InventoryError(`${where}: allow: "any" is not supported for kafka targets; list the commands`);
  }
  const allow = checkAllow(entry, where, { any: false });
  allow.forEach((rule, i) => {
    if (isRegexRule(rule) && hasLookaround(regexSource(rule))) {
      throw new InventoryError(`${where}: allow[${i}]: a regex rule of a kafka target may not use a lookaround, (?= (?! (?<= or (?<!, because ksproxy could not tell which options the rule allows`);
    }
  });
  return allow;
}

function isRegularFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The client for a name: the bare name, then the name with .sh, in the folder or on the PATH of ksproxy start.
function findClient(name, binDir, env) {
  for (const file of [name, `${name}.sh`]) {
    const resolved = resolveProgram(binDir === null ? file : path.join(binDir, file), env);
    if (resolved.program !== undefined) return resolved.program;
  }
  return undefined;
}

// What the target needs on this machine: { programs, missing } or { error }. programs maps a first word to a path.
function locate(target, env) {
  if (target.clientConfig !== null && !isRegularFile(target.clientConfig)) {
    return { error: `clientConfig ${target.clientConfig} is not a regular file that exists` };
  }
  const programs = {};
  const missing = [];
  for (const [word, name] of PROGRAMS) {
    const found = findClient(name, target.binDir, env);
    if (found === undefined) missing.push(name);
    else programs[word] = found;
  }
  if (missing.length === PROGRAMS.size) {
    return { error: `none of the Kafka client programs was found ${target.binDir === null ? 'on PATH' : `in ${target.binDir}`}` };
  }
  return { programs, missing };
}

// An option that changes the server or the client configuration or names a file, a configuration or a property.
function isFixedOption(word) {
  const name = optionName(word);
  if (name === null) return false;
  return FIXED_OPTIONS.some((fixed) => name.startsWith(fixed)) || (FILE_LIKE.test(name) && !FILE_LIKE_OK.includes(name));
}

// A write flag, or an abbreviation of one: a name of at least MIN_ABBREVIATION characters that starts a write flag.
// No option that the six clients read without writing starts a write flag, so an abbreviation can never slip past.
function isWriteFlag(word) {
  const name = optionName(word);
  return name !== null && name.length >= MIN_ABBREVIATION && WRITE_FLAGS.some((flag) => flag.startsWith(name));
}

const looksLikePath = (text) => text.includes('/') && (PATH_START.test(text) || text.split('/').includes('..'));

// A word, or the value after its "=", that points at a file on this machine. A name that follows --topic, --group,
// --entity-name or --principal (or is written after one with "=") may hold a "/".
function isPathWord(word, i, words) {
  const [flag, ...value] = word.split('=');
  const names = NAME_FLAGS.includes(flag.toLowerCase()) || NAME_FLAGS.includes((words[i - 1] ?? '').toLowerCase());
  return !names && (looksLikePath(word) || looksLikePath(value.join('=')));
}

function decideKafka(target, input) {
  let words;
  try {
    words = tokenizeSshCommand(input);
  } catch (err) {
    return refuse(err.message, err.short);
  }
  const [first] = words;
  if (!PROGRAMS.has(first)) {
    return refuse(`unknown kafka command "${clip(first, 64)}": the first word must be one of ${FIRST_WORDS}`, 'unknown kafka command');
  }
  const fixed = words.find(isFixedOption);
  if (fixed !== undefined) {
    return refuse(`"${fixed}" changes the server or the client configuration, or names a file, a configuration or a property: the user fixes those for this target`, 'fixed option refused');
  }
  const pathWord = words.find(isPathWord);
  if (pathWord !== undefined) {
    return refuse(`"${pathWord}" looks like a path on this machine: a word with a "/" that starts with "/", "~" or "." or holds a ".." part is refused`, 'path refused');
  }
  const argumentFile = words.find((word) => word.startsWith('@'));
  if (argumentFile !== undefined) {
    return refuse(`"${argumentFile}" looks like an argument file: a word that starts with "@" is refused`, 'path refused');
  }
  const write = words.find(isWriteFlag);
  if (write !== undefined && !target.writes) {
    return refuse(`"${write}" is a write flag and writes are off for this target`, 'writes are off');
  }
  if (!Object.hasOwn(target.programs, first)) {
    return refuse(`the client ${PROGRAMS.get(first)} was not found when this target opened, so ${first} cannot be used`, 'client not found');
  }
  const decision = decide(words, target.allow, matchCommandRule);
  if (decision.unmatched === true && write !== undefined) {
    return refuse(`"${write}" needs a rule that names it: a wildcard or a reviewer cannot allow a write`, 'write needs a rule');
  }
  return { ...decision, argv: words };
}

// The Kafka kind: the command-line clients the user installed, run by ksproxy start through the command engine.
// The first word picks the program from a fixed table; the server and the client configuration are the user's.
export default {
  key: 'kafka',
  flag: 'kafka',
  label: 'kfk',
  word: 'kafka',
  noun: 'kafka target',
  countNoun: 'kafka target(s)',
  brokered: true,
  sample: [{
    name: 'kafka-prod',
    bootstrap: 'kafka.internal:9093',
    clientConfig: '~/secrets/kafka-client.properties',
    binDir: '/opt/kafka/bin',
    writes: false,
    description: 'production cluster, read only',
    allow: ['topics --list', 'topics --describe --topic *', 'groups --list', 'groups --describe --group *'],
  }],
  hint(target) {
    return target.description ? `${target.bootstrap} - ${target.description}` : target.bootstrap;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, KAFKA_KEYS, where);
    const bootstrap = checkBootstrap(entry.bootstrap, where);
    const clientConfig = optionalPath(entry.clientConfig, `${where}: clientConfig`);
    const binDir = optionalPath(entry.binDir, `${where}: binDir`);
    const writes = checkWrites(entry.writes, where);
    const allow = checkKafkaAllow(entry, where);
    return {
      kind: 'kafka',
      name: entry.name,
      bootstrap,
      clientConfig,
      binDir,
      writes,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secretFiles(targets) {
    return targets.filter((target) => target.clientConfig !== null).map((target) => target.clientConfig);
  },
  openingMessage(target) {
    return `${target.bootstrap}, ${target.clientConfig === null ? 'no client configuration' : 'with a client configuration file'}, writes ${target.writes ? 'on' : 'off'}`;
  },
  open(target, { env }) {
    const found = locate(target, env);
    if (found.error !== undefined) return { ok: false, error: found.error };
    return {
      ok: true,
      extras: { programs: found.programs },
      notes: found.missing.map((name) => `${name} was not found: calls that need it are refused`),
    };
  },
  record(opened, { reviewed }) {
    const { target } = opened;
    return {
      kind: 'kafka',
      name: target.name,
      description: target.description,
      allow: target.allow,
      bootstrap: target.bootstrap,
      clientConfig: target.clientConfig,
      writes: target.writes,
      programs: opened.programs,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'the call service is not answering';
  },
  backMessage: 'the call service is back',
  decide: decideKafka,
  perform(target, decision, {
    env, timeoutMs, maxBytes, signal,
  }) {
    const [first, ...words] = decision.argv;
    const fixedArgs = ['--bootstrap-server', target.bootstrap, ...(target.clientConfig === null ? [] : ['--command-config', target.clientConfig])];
    return runClient({
      program: target.programs[first], fixedArgs, words, env, timeoutMs, maxBytes, signal,
    });
  },
  // The doctor check: kafka-topics --list through the same client and fixed arguments as a call; the detail counts the lines.
  async doctor(opened, {
    env, secrets, timeoutMs, signal,
  }) {
    const { target, programs } = opened;
    if (programs.topics === undefined) return { ok: false, detail: shown('kafka-topics was not found', hiddenOf(secrets)) };
    const result = await runClient({
      program: programs.topics,
      fixedArgs: ['--bootstrap-server', target.bootstrap, ...(target.clientConfig === null ? [] : ['--command-config', target.clientConfig])],
      words: ['--list'],
      env,
      timeoutMs,
      maxBytes: DOCTOR_MAX_BYTES,
      signal,
    });
    return clientVerdict(result, {
      name: 'kafka-topics',
      describe: (text) => {
        const count = text.split('\n').filter((line) => line.trim() !== '').length;
        return `${count} ${count === 1 ? 'topic' : 'topics'}`;
      },
      hidden: hiddenOf(secrets),
      signal,
    });
  },
  forCheck(target, { env }) {
    const found = locate(target, env);
    return found.error === undefined ? { target: { ...target, programs: found.programs } } : { refusal: found.error };
  },
  toolBullet: '- `kafka_exec { target, command, timeout_seconds? }` - run one allowlisted Kafka client command on a kafka target.',
  agentSection(target) {
    const lines = [
      `### Kafka target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`kafka_exec\` with \`target: "${target.name}"\`. The first word picks the client program: \`topics\` runs kafka-topics, \`groups\` kafka-consumer-groups, \`configs\` kafka-configs, \`acls\` kafka-acls, \`log-dirs\` kafka-log-dirs and \`broker-api-versions\` kafka-broker-api-versions. Any other first word is refused. Give the words that follow it.`,
      `- Allowed commands: ${describeAllow(target.allow)}`,
      '- The user fixed the server address and the client configuration. Options that change them (`--bootstrap-server`, `--command-config` and the like), any option whose name holds file, config or property, and a word that points at a file on this machine are refused.',
      `- Write flags (${WRITE_FLAGS.map((name) => `--${name}`).join(', ')}) are refused unless the user turned writes on for this target and a rule allows the command; writes are ${target.writes ? 'on' : 'off'} here. An abbreviation of a write flag, such as \`--del\`, counts as that flag.`,
      '- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax; no shell runs it.',
      '- `*` in a rule matches exactly one word and `...` any number of words, never a word that starts with `-`: a flag is allowed only where the user wrote it into a rule, or when the target has a reviewer and it approves a call that no rule matches (never one with a write flag).',
      '- The client runs in an empty folder of its own, removed afterwards, with a small environment. Its output stops at the output limit. Producing and consuming messages are not available.',
    ];
    if (target.review === true) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'kafka_exec',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'kafka_exec',
      description: 'Run one Kafka command-line client command on a kafka target the user opened. The first word picks the client (topics, groups, configs, acls, log-dirs or broker-api-versions); the user fixed the server and the client configuration; give the words that follow, separated by spaces. Each command is checked against the target\'s allowlist and logged; shell syntax is not accepted.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'The first word (topics, groups, configs, acls, log-dirs or broker-api-versions) and the words after it, separated by spaces' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
