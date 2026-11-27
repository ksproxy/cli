import fs from 'node:fs';
import path from 'node:path';
import {
  decide, describeAllow, isRegexRule, matchRuleDetail, regexSource, tokenizeSshCommand,
} from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable, isObject,
} from '../../checks.js';
import { configDir, expandHome, rootStateDir, stateDir } from '../../paths.js';
import { clip } from '../../text.js';
import { REVIEWED } from '../shared.js';
import { isInside, realish } from '../local/folder.js';
import { WORK_FOLDER, runClient } from '../engines/command.js';

const COMMAND_KEYS = ['name', 'program', 'args', 'env', 'description', 'allow', 'review'];
const PROGRAM_NAME = /^[A-Za-z0-9_+][A-Za-z0-9_.+-]*$/;
const MAX_PROGRAM_BYTES = 1024;
const MAX_ARGS = 50;
const MAX_ARG_BYTES = 1024;
const MAX_ENV = 50;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
export const LOADER_PREFIXES = ['LD_', 'DYLD_'];
const HOME_PREFIX = '~/';
const LOOKAROUNDS = ['(?=', '(?!', '(?<=', '(?<!'];

// A leading ~/ is the user's home; any other text is kept as written.
const withHome = (text) => (text.startsWith(HOME_PREFIX) ? expandHome(text) : text);

// The program: a plain name, looked up on PATH when the target opens, or an absolute path, written or after ~/.
export function checkProgram(value, where) {
  const message = `${where}: program: must be an absolute path, a path that starts with "~/", or a program name of letters, digits and _ . + - that is looked up on PATH`;
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_PROGRAM_BYTES || CONTROL_CHAR.test(value)) {
    throw new InventoryError(message);
  }
  if (PROGRAM_NAME.test(value)) return value;
  const expanded = withHome(value);
  if (!path.isAbsolute(expanded)) throw new InventoryError(message);
  return path.resolve(expanded);
}

// The fixed arguments: the user's text, passed as written after a leading ~/ is expanded.
function checkArgs(value, where) {
  if (value === undefined) return [];
  const ok = Array.isArray(value) && value.length <= MAX_ARGS
    && value.every((arg) => typeof arg === 'string' && Buffer.byteLength(arg) <= MAX_ARG_BYTES && !CONTROL_CHAR.test(arg));
  if (!ok) {
    throw new InventoryError(`${where}: args: must be a list of at most ${MAX_ARGS} strings, each at most ${MAX_ARG_BYTES} bytes and without control characters`);
  }
  return value.map(withHome);
}

// The child's variables: each name maps to the variable of ksproxy start that holds its secret.
function checkEnv(value, where) {
  if (value === undefined) return {};
  if (!isObject(value) || Object.keys(value).length > MAX_ENV) {
    throw new InventoryError(`${where}: env: must be an object of at most ${MAX_ENV} variables, each {"fromEnv": NAME}`);
  }
  const out = {};
  for (const [name, source] of Object.entries(value)) {
    const at = `${where}: env[${JSON.stringify(clip(name, 64))}]`;
    checkSecretVariable(name, at);
    if (LOADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new InventoryError(`${at}: ${name} changes how programs are loaded; name another variable`);
    }
    if (!isObject(source) || Object.keys(source).length !== 1 || !Object.hasOwn(source, 'fromEnv')) {
      throw new InventoryError(`${at}: must be {"fromEnv": NAME}`);
    }
    out[name] = checkSecretVariable(source.fromEnv, `${at}.fromEnv`);
  }
  return out;
}

// Whether a pattern holds a lookaround: (?= (?! (?<= or (?<! outside an escape and outside a character class.
export function hasLookaround(source) {
  let i = 0;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
    } else if (source[i] === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
    } else {
      if (LOOKAROUNDS.some((open) => source.startsWith(open, i))) return true;
      i += 1;
    }
  }
  return false;
}

// A flag written inside a lookaround would count as written by the pattern, so such a rule is refused here.
function checkCommandAllow(entry, where) {
  if (entry.allow === 'any') {
    throw new InventoryError(`${where}: allow: "any" is not supported for command targets; list the commands`);
  }
  const allow = checkAllow(entry, where, { any: false });
  allow.forEach((rule, i) => {
    if (isRegexRule(rule) && hasLookaround(regexSource(rule))) {
      throw new InventoryError(`${where}: allow[${i}]: a regex rule of a command target may not use a lookaround, (?= (?! (?<= or (?<!, because ksproxy could not tell which options the rule allows`);
    }
  });
  return allow;
}

function isExecutableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ksproxy's state and configuration folders, as written and resolved: the root state folder, every project included.
function ownFolders(env) {
  return [rootStateDir(env), configDir(env)].flatMap((dir) => [dir, realish(dir)]).filter(Boolean);
}

// The program as it will run: { program } with an absolute path, or { error }. A plain name is looked up on the
// absolute entries of the PATH of ksproxy start. Nothing inside ksproxy's own folders runs.
export function resolveProgram(program, env) {
  let found = program;
  if (!path.isAbsolute(program)) {
    const dirs = (env.PATH ?? '').split(':').filter((dir) => path.isAbsolute(dir));
    found = dirs.map((dir) => path.join(dir, program)).find(isExecutableFile);
    if (found === undefined) return { error: `program ${program} was not found on PATH` };
  } else if (!isExecutableFile(program)) {
    return { error: `program ${program} is not an executable file` };
  }
  const spellings = [found, realish(found)].filter(Boolean);
  const own = ownFolders(env);
  if (spellings.some((p) => own.some((dir) => isInside(p, dir)))) {
    return { error: `program ${found} is inside ksproxy's own folders` };
  }
  return { program: found };
}

// A quantifier that allows zero times: "?", "*", or a brace whose least count is 0 ({0}, {0,3}, {0,}).
const ZERO_TIMES = /^(?:[?*]|\{0+(?:,\d*)?\})/;

// The spans [open, close] of the groups that a quantifier allows zero times, found outside escapes and character
// classes. The rule compiled, so every ")" here closes a group. A word inside one may be skipped by the match, so the pattern does not write it.
function skippableGroups(source) {
  const open = [];
  const spans = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
    } else {
      if (ch === '(') open.push(i);
      if (ch === ')') {
        const start = open.pop();
        if (ZERO_TIMES.test(source.slice(i + 1))) spans.push([start, i]);
      }
      i += 1;
    }
  }
  return spans;
}

// A word that starts with "-" is allowed by a regex rule only when the pattern holds it as a whole word: at the
// start or after a space, "(", "(?:", "|" or "^", and at the end or before a space, ")", "|" or "$"; and not inside a
// group that a quantifier allows zero times ("?", "*", {0}, {0,n}).
function writtenInPattern(word, source) {
  const skippable = skippableGroups(source);
  for (let at = source.indexOf(word); at !== -1; at = source.indexOf(word, at + 1)) {
    if (skippable.some(([start, end]) => start < at && at < end)) continue;
    const before = source[at - 1] ?? '';
    const after = source[at + word.length] ?? '';
    const opens = ['', ' ', '(', '|', '^'].includes(before) || source.slice(at - 3, at) === '(?:';
    if (opens && ['', ' ', ')', '|', '$'].includes(after)) return true;
  }
  return false;
}

// One rule against the words: a wildcard never matches a word that starts with "-", and a regex rule allows such a
// word only when it writes it.
export function matchCommandRule(words, rule) {
  const detail = matchRuleDetail(words, rule);
  if (detail === null) return false;
  if (detail.regex) return words.every((word) => !word.startsWith('-') || writtenInPattern(word, regexSource(rule)));
  return detail.rest.every((word) => !word.startsWith('-'));
}

function decideCommand(target, input) {
  let words;
  try {
    words = tokenizeSshCommand(input);
  } catch (err) {
    return { allowed: false, reason: err.message, short: err.short };
  }
  const repeated = words.find((word) => word.startsWith('-') && target.args.includes(word));
  if (repeated !== undefined) {
    return { allowed: false, reason: `"${repeated}" repeats an option the user fixed for this target`, short: 'repeats a fixed option' };
  }
  return { ...decide(words, target.allow, matchCommandRule), argv: words };
}

function envText(env) {
  const names = Object.entries(env).map(([child, source]) => (child === source ? child : `${child} from ${source}`));
  return names.length === 0 ? 'no secrets' : `secrets ${names.join(', ')}`;
}

// The custom command kind: one client program the user names, run by ksproxy start through the command engine
// with the secrets of its env in the child's environment and the agent's words after the fixed arguments.
export default {
  key: 'command',
  flag: 'command',
  label: 'cmd',
  word: 'command',
  noun: 'command target',
  countNoun: 'command target(s)',
  brokered: true,
  sample: [{
    name: 'disk-report',
    program: '/usr/local/bin/report',
    args: ['--format', 'text'],
    env: { REPORT_TOKEN: { fromEnv: 'REPORT_TOKEN' } },
    description: 'disk usage report',
    allow: ['usage *', 'summary'],
  }],
  hint(target) {
    return target.description ? `${target.program} - ${target.description}` : target.program;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, COMMAND_KEYS, where);
    const program = checkProgram(entry.program, where);
    const args = checkArgs(entry.args, where);
    const env = checkEnv(entry.env, where);
    const allow = checkCommandAllow(entry, where);
    return {
      kind: 'command',
      name: entry.name,
      program,
      args,
      env,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secrets(target) {
    return { env: [...new Set(Object.values(target.env))], files: [] };
  },
  // A working folder left by a killed run; start calls this only when no session is live.
  async reapStale({ env }) {
    fs.rmSync(path.join(stateDir(env), WORK_FOLDER), { recursive: true, force: true });
    return [];
  },
  openingMessage(target) {
    return `${target.program}, ${target.args.length} fixed arguments, ${envText(target.env)}`;
  },
  open(target, { env }) {
    const resolved = resolveProgram(target.program, env);
    return resolved.error === undefined ? { ok: true, extras: { program: resolved.program } } : { ok: false, error: resolved.error };
  },
  // The check of ksproxy doctor: the program is found as open finds it. Nothing runs.
  doctor(opened, { env }) {
    const resolved = resolveProgram(opened.target.program, env);
    return resolved.error === undefined
      ? { ok: true, detail: 'program found' }
      : { ok: false, detail: clip(resolved.error.replace(/[\u0000-\u001f\u007f]+/g, ' '), 300) };
  },
  record(opened, { reviewed }) {
    const { target } = opened;
    return {
      kind: 'command',
      name: target.name,
      description: target.description,
      allow: target.allow,
      program: opened.program,
      args: target.args,
      env: target.env,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'the call service is not answering';
  },
  backMessage: 'the call service is back',
  decide: decideCommand,
  perform(target, decision, {
    env, secrets, timeoutMs, maxBytes, signal,
  }) {
    const childEnv = Object.fromEntries(Object.entries(target.env).map(([child, source]) => [child, secrets[source]]));
    return runClient({
      program: target.program, fixedArgs: target.args, words: decision.argv, env, childEnv, timeoutMs, maxBytes, signal,
    });
  },
  forCheck(target, { env }) {
    const resolved = resolveProgram(target.program, env);
    return resolved.error === undefined ? { target: { ...target, program: resolved.program } } : { refusal: resolved.error };
  },
  toolBullet: '- `command_exec { target, command, timeout_seconds? }` - run one allowlisted command of a command target.',
  cutHint: 'a narrower command or option',
  agentSection(target) {
    const lines = [
      `### Command target \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`command_exec\` with \`target: "${target.name}"\`. The user fixed the program and its first arguments; give only the words that follow them.`,
      `- Allowed commands: ${describeAllow(target.allow)}`,
      '- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax; no shell runs it.',
      '- `*` in a rule matches exactly one word and `...` any number of words, never a word that starts with `-`: a flag is allowed only where the user wrote it into a rule, or when the target has a reviewer and it approves a call that no rule matches. A word that repeats one of the options the user fixed is refused.',
      '- The program runs in an empty folder of its own, removed afterwards, with a small environment. Its output stops at the output limit.',
      '- ksproxy does not know what this program does: the rules only say which words may be passed. Do not look for words that make it read files or start other programs.',
    ];
    if (target.review === true) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'command_exec',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'command_exec',
      description: 'Run one command of a command target the user opened. The user fixed the program and its first arguments; give the words that follow, separated by spaces. Each command is checked against the target\'s allowlist and logged; shell syntax is not accepted.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'The words after the fixed program and arguments, separated by spaces' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
