import fs from 'node:fs';
import path from 'node:path';
import {
  AllowError, allowWarnings, decide, describeAllow, isRegexRule, matchRuleDetail, regexSource, tokenizeSshCommand,
} from '../../allowlist.js';
import {
  InventoryError, absolutePath, checkAllow, checkKeys, checkReview,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import { checkCommand } from '../../paths.js';
import { clip } from '../../text.js';
import {
  cleanPath, localFolderProblem, localScope, looksSecret, pathsOf, reviewProblem, sessionProtected, wildcardProblem,
} from './folder.js';
import {
  BARE_PROGRAM, REFUSED_OPTIONS, actingPrograms, listedPathsProblem, programsOf, programsProblem,
} from './scope.js';

const LOCAL_KEYS = ['name', 'cwd', 'description', 'allow', 'review', 'protect', 'paths', 'programs'];
const MAX_PROTECT = 50;
const MAX_PROGRAMS = 50;
const MAX_PROTECT_BYTES = 512;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const CONTROL_RUNS = /[\u0000-\u001f\u007f]+/g;

// The parts of one protect or paths entry, empty and "." parts dropped; at names the entry in the errors.
function entryParts(item, at) {
  if (typeof item !== 'string' || item === '' || Buffer.byteLength(item) > MAX_PROTECT_BYTES || CONTROL_CHAR.test(item)) {
    throw new InventoryError(`${at}: must be a path of 1 to ${MAX_PROTECT_BYTES} bytes without control characters`);
  }
  if (item.startsWith('/') || item.startsWith('~')) {
    throw new InventoryError(`${at}: must be relative to the folder, not an absolute path or one that starts with "~"`);
  }
  const parts = item.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new InventoryError(`${at}: may not contain ".."`);
  return parts;
}

function checkProtect(entry, where) {
  const list = entry.protect;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROTECT) {
    throw new InventoryError(`${where}: protect: must be a list of 1 to ${MAX_PROTECT} paths inside the folder`);
  }
  const out = [];
  list.forEach((item, j) => {
    const at = `${where}: protect[${j}]`;
    const parts = entryParts(item, at);
    if (parts.length === 0) throw new InventoryError(`${at}: names the folder itself; list a file or folder inside it`);
    const clean = parts.join('/');
    if (out.includes(clean)) throw new InventoryError(`${at}: ${clean} is listed twice`);
    out.push(clean);
  });
  return { protect: out };
}

// The paths a local target's commands may name: cleaned like protect, "." for the whole folder, and ** only as a whole
// part.
function checkPaths(entry, where) {
  const list = entry.paths;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROTECT) {
    throw new InventoryError(`${where}: paths: must be a list of 1 to ${MAX_PROTECT} paths or patterns inside the folder`);
  }
  const out = [];
  list.forEach((item, j) => {
    const at = `${where}: paths[${j}]`;
    const parts = entryParts(item, at);
    if (parts.some((part) => part.includes('**') && part !== '**')) {
      throw new InventoryError(`${at}: "**" must be a whole part, as in docs/**/*.md`);
    }
    const clean = parts.length === 0 ? '.' : parts.join('/');
    if (out.includes(clean)) throw new InventoryError(`${at}: ${clean} is listed twice`);
    out.push(clean);
  });
  return { paths: out };
}

// The programs that may run with any arguments inside paths: bare names without repeats, and only with paths.
function checkPrograms(entry, where) {
  const list = entry.programs;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROGRAMS) {
    throw new InventoryError(`${where}: programs: must be a list of 1 to ${MAX_PROGRAMS} program names, for example ["cat", "grep"]`);
  }
  list.forEach((name, j) => {
    const at = `${where}: programs[${j}]`;
    if (typeof name !== 'string' || !BARE_PROGRAM.test(name)) {
      throw new InventoryError(`${at}: must be a bare program name: letters, digits and _ . + -, not starting with "-", and no "/"`);
    }
    if (list.indexOf(name) !== j) throw new InventoryError(`${at}: ${name} is listed twice`);
  });
  if (entry.paths === undefined) {
    throw new InventoryError(`${where}: programs: needs "paths", the files and folders its commands may name`);
  }
  return { programs: [...list] };
}

function folderProblem(cwd, env, protectedList) {
  let stat;
  try {
    stat = fs.statSync(cwd);
  } catch {
    return `folder not found: ${cwd}`;
  }
  if (!stat.isDirectory()) return `not a directory: ${cwd}`;
  return localFolderProblem(cwd, env, protectedList);
}

const MAX_NAMED = 3;

// At most MAX_NAMED of the names, then "and N more".
function named(names) {
  const more = names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : '';
  return `${names.slice(0, MAX_NAMED).join(', ')}${more}`;
}

function looseSecrets(target) {
  let names;
  try {
    names = fs.readdirSync(target.cwd);
  } catch {
    return [];
  }
  const listed = (target.protect ?? []).map((entry) => entry.toLowerCase());
  return names.filter((name) => looksSecret(name) && !listed.includes(name.toLowerCase())).sort();
}

// The options always refused for a listed program, by program, and the programs that refuse an argument with ":".
function refusedOptionsText() {
  const options = Object.entries(REFUSED_OPTIONS)
    .map(([name, rules]) => [name, [...rules.exact, ...rules.short.map((s) => `-${s}`), ...rules.long]])
    .filter(([, words]) => words.length > 0)
    .map(([name, words]) => `${name} ${words.join(', ')}`);
  const colon = Object.keys(REFUSED_OPTIONS).filter((name) => REFUSED_OPTIONS[name].colon);
  return `${options.join('; ')}. ${colon.slice(0, -1).join(', ')} and ${colon.at(-1)} refuse every argument that holds \`:\`, which they can read as a remote archive (\`HOST:FILE\`)`;
}

// The lines of AGENT.md for a target with paths: the limit on wildcards, then the programs list when it has one.
function pathsNotes(target) {
  const shown = target.paths.join(', ');
  const lines = [`- Every argument that a wildcard matches and that is a path (it contains \`/\`, starts with \`.\` or names an existing file or folder) must also lie inside one of these paths of the folder: ${shown}.`];
  const listed = programsOf(target, pathsOf(target));
  if (listed.length === 0) return lines;
  return [
    ...lines,
    `- Besides the commands above, these programs may run with any flags and arguments: ${listed.join(', ')}. Name the program exactly as listed, never as a path (\`./run.sh\`, \`/bin/cat\`). A command of these programs that a check refuses is never sent to a reviewer.`,
    `- For these programs an argument is a path when it contains \`/\`, starts with \`.\` or names an existing file or folder of the target's folder; a part after \`=\`, \`:\`, \`@\`, \`,\`, \`+\` or \`%\` counts too. Every path must be a plain relative path (letters, digits and \`_ . / -\`), pass the checks above, and lie inside one of these paths of the folder: ${shown}. A folder covers everything below it; \`*\` matches any characters inside one part of a path, names that start with a dot included, \`**\` any number of parts, and \`.\` the whole folder. Other words, such as a search word, are not checked.`,
    '- Give a path as its own word (`-o out/x`). The value after `=` of a long flag (`--output=out/x`) is checked as a path, and a value glued to a short flag (`-oout/x`) is checked whole, with every tail of the flag, so it is often refused. A word with a `/` is a path, so write a sed script with another separator (`s,a,b,`). Every word after `--` is checked whole and also as a flag would be, since `--` can be the value of the flag before it.',
    `- These options are always refused, also inside a group of short flags or shortened: ${refusedOptionsText()}. A sed script read from a file (\`-f\`, \`--file\`) is refused, and so is a sed script that uses the commands e, w, W, r or R or the s flags e or w.`,
  ];
}

const REGEX_PROGRAM = /^\^?((?:[A-Za-z0-9_/-]|\\\.)+)(?: |\$?$)/;

// The program a regex rule names at its start, with "\." read as ".", or null when it names none.
function regexProgram(rule) {
  const found = REGEX_PROGRAM.exec(regexSource(rule));
  return found === null ? null : found[1].replaceAll('\\.', '.');
}

function usableRule(rule) {
  if (typeof rule !== 'string') return false;
  if (isRegexRule(rule)) return regexProgram(rule) !== null;
  const [program] = rule.trim().split(/\s+/);
  return program !== '*' && program !== '...';
}

// A regex rule names its program; every other word is checked as if a wildcard had matched it.
function regexProblem(tokens, rule, target, env, scope) {
  const program = regexProgram(rule);
  if (tokens[0] !== program) {
    return { reason: `the command must start with ${program}, the program this rule names`, short: 'not the rule program' };
  }
  return wildcardProblem({ star: tokens.slice(1), rest: [] }, target, env, scope);
}

function checkRegexRules(allow, where) {
  allow.forEach((rule, i) => {
    if (isRegexRule(rule) && regexProgram(rule) === null) {
      throw new InventoryError(`${where}: allow[${i}]: a regex rule of a local target must start with the program name`);
    }
  });
}

// The problem of one listed rule with the tokens: undefined when it does not match, null when it allows them. With
// paths, every argument of its wildcards that is a path must also lie inside paths.
function ruleProblem(tokens, rule, target, env, scope, paths) {
  const detail = matchRuleDetail(tokens, rule);
  if (detail === null) return undefined;
  const problem = detail.regex
    ? regexProblem(tokens, rule, target, env, scope)
    : wildcardProblem(detail, target, env, scope);
  return problem ?? listedPathsProblem(detail.regex ? tokens.slice(1) : [...detail.star, ...detail.rest], paths, scope);
}

// On a target with programs, the refusal of a command that no rule allows and whose program is not listed names both.
function unlisted(refusal, program, listed, usable) {
  if (listed.length === 0 || !['allowlist is empty', 'not on allowlist'].includes(refusal.short)) return refusal;
  return {
    ...refusal,
    reason: `not on the allowlist for this target. Allowed: ${describeAllow(usable)}; the program ${program} is not one of its programs: ${listed.join(', ')}`,
    short: 'not on allowlist',
  };
}

function decideLocal(target, input, env = process.env, platform = process.platform) {
  if (!Array.isArray(target.allow)) {
    return { allowed: false, reason: 'this local target has no usable allowlist', short: 'allowlist is empty' };
  }
  const folder = localFolderProblem(target.cwd, env, Array.isArray(target.protected) ? target.protected : [], platform);
  if (folder !== null) {
    return {
      allowed: false,
      reason: `this target's folder is not acceptable; ask the user to run "${checkCommand(env)} local ${target.name}"`,
      short: 'folder not allowed',
    };
  }
  const usable = target.allow.filter(usableRule);
  const scope = localScope(target, env, platform);
  const paths = pathsOf(target);
  const listed = programsOf(target, paths);
  try {
    const tokens = tokenizeSshCommand(input);
    let first = null;
    let preferred = null;
    const remember = (problem) => {
      first ??= problem;
      if (problem.short !== 'not a plain argument') preferred ??= problem;
    };
    for (const rule of usable) {
      const problem = ruleProblem(tokens, rule, target, env, scope, paths);
      if (problem === null) return { allowed: true, rule, argv: tokens };
      if (problem !== undefined) remember(problem);
    }
    // The programs list comes after every rule, and only for a program word that it holds exactly.
    if (listed.includes(tokens[0])) {
      const problem = programsProblem(tokens, paths, target, env, scope);
      if (problem === null) return { allowed: true, rule: `programs: ${tokens[0]}`, argv: tokens };
      remember(problem);
    }
    const shown = preferred ?? first;
    if (shown !== null) return { allowed: false, reason: shown.reason, short: shown.short };
    if (usable.length === 0 && target.allow.length > 0) {
      return { allowed: false, reason: 'not on the allowlist for this target', short: 'not on allowlist' };
    }
    const refusal = unlisted(decide(tokens, usable), tokens[0], listed, usable);
    if (target.review !== true) return refusal;
    const problem = reviewProblem(tokens, target, env, scope);
    return problem === null ? { ...refusal, argv: tokens } : { ...refusal, notReviewed: problem.reason };
  } catch (err) {
    if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
    throw err;
  }
}

export default {
  key: 'local',
  flag: 'local',
  label: 'loc',
  word: 'local',
  noun: 'local target',
  countNoun: 'folder(s)',
  sample: [
    {
      name: 'infra',
      cwd: '~/projects/infra',
      description: 'terraform repo',
      allow: ['git status', 'git log --oneline -n * ...', 'terraform plan', 'ls -l ...'],
    },
  ],
  hint(target) {
    return target.description ? `${target.cwd} — ${target.description}` : target.cwd;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, LOCAL_KEYS, where);
    const cwd = path.resolve(absolutePath(entry.cwd, `${where}: cwd`));
    const allow = checkAllow(entry, where, { any: false, program: true });
    checkRegexRules(allow, where);
    return {
      kind: 'local',
      name: entry.name,
      cwd,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: true }),
      ...checkProtect(entry, where),
      ...checkPaths(entry, where),
      ...checkPrograms(entry, where),
    };
  },
  // The warnings of the rules, then one line that names the programs of the list that can act as the owner.
  ruleWarnings(target) {
    const warnings = allowWarnings(target.allow);
    const acting = actingPrograms(target.programs ?? []);
    if (acting.length === 0) return warnings;
    return [...warnings, `programs that can act as you: ${acting.join(', ')}; the agent can use them with your whole account`];
  },
  openingMessage(t) {
    return t.cwd;
  },
  // Nothing is held open, so there is no close and the check runs at once, without waiting. secretFilesProblem is set
  // when another inventory file could not be read: the files it names are not known, so no folder opens.
  open(t, { env, secretFiles, secretFilesProblem }) {
    if (secretFilesProblem) return { ok: false, error: secretFilesProblem };
    const problem = folderProblem(t.cwd, env, secretFiles);
    if (problem !== null) return { ok: false, error: problem };
    const notes = [];
    if (t.programs !== undefined) {
      notes.push(`programs ${t.programs.join(', ')} may run with any arguments inside ${t.paths.join(', ')}`);
    }
    const loose = looseSecrets(t);
    if (loose.length > 0) {
      notes.push(`holds ${named(loose)}: list them in "protect" to also refuse commands given the whole folder`);
    }
    return notes.length === 0 ? { ok: true, extras: {} } : { ok: true, extras: {}, notes };
  },
  // The check of ksproxy doctor: the folder checks of open, again. The list of other files' secrets is not known here.
  doctor(opened, { env }) {
    const problem = folderProblem(opened.target.cwd, env, []);
    return problem === null
      ? { ok: true, detail: 'folder checks passed' }
      : { ok: false, detail: clip(problem.replace(CONTROL_RUNS, ' '), 300) };
  },
  // path is cleaned over every selected local folder, the skipped ones included.
  record(o, {
    env, selected, secretFiles, reviewed,
  }) {
    return {
      kind: 'local',
      name: o.target.name,
      description: o.target.description,
      allow: o.target.allow,
      cwd: o.target.cwd,
      path: cleanPath(env.PATH, selected.map((t) => t.cwd)),
      protected: sessionProtected(secretFiles, env),
      state: 'up',
      ...(reviewed ? { review: true } : {}),
      ...(o.target.protect ? { protect: o.target.protect } : {}),
      ...(o.target.paths ? { paths: o.target.paths } : {}),
      ...(o.target.programs ? { listedPrograms: o.target.programs } : {}),
      ...(reviewed ? { programs: o.target.review.programs } : {}),
    };
  },
  downMessage() {
    return 'folder is gone';
  },
  backMessage: 'folder is back',
  decide: decideLocal,
  reviewServerCheck(entry, subject) {
    return entry.review.programs.includes(subject.argv[0]);
  },
  command(target, decision, { env, session }) {
    const folders = session.targets.filter((t) => t.kind === 'local').map((t) => t.cwd);
    return {
      program: decision.argv[0],
      args: decision.argv.slice(1),
      options: {
        cwd: target.cwd,
        env: minimalEnv(env, { PATH: cleanPath(target.path, folders) }, { own: false }),
      },
    };
  },
  async state(target) {
    try {
      return fs.statSync(target.cwd).isDirectory() ? 'up' : 'down';
    } catch {
      return 'down';
    }
  },
  scrubDirs(targets) {
    return targets.flatMap((target) => [
      { dir: target.cwd, label: '<folder>' },
      { dir: path.resolve(target.cwd), label: '<folder>' },
    ]);
  },
  forCheck(target, { env, secretFiles, secretFilesProblem }) {
    if (secretFilesProblem) return { refusal: secretFilesProblem };
    const problem = localFolderProblem(target.cwd, env, secretFiles);
    if (problem !== null) return { refusal: problem };
    // The session names the programs list listedPrograms, since its programs are those the reviewer may approve.
    const { programs, ...rest } = target;
    return {
      target: {
        ...rest,
        protected: secretFiles,
        ...(programs ? { listedPrograms: programs } : {}),
        ...(target.review ? { review: true, programs: target.review.programs } : {}),
      },
    };
  },
  toolBullet: '- `local_exec { target, command, timeout_seconds? }` - run one command on this machine in a target\'s folder.',
  cutHint: 'tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first',
  agentSection(target) {
    const lines = [
      `### Local folder \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
      '',
      `- Tool: \`local_exec\` with \`target: "${target.name}"\``,
      `- Allowed commands: ${describeAllow(target.allow)}`,
      '- Files that usually hold secrets (such as .env and key files) and paths the user protected are refused unless an allowed command above names the file exactly. Do not look for another way to read them.',
      '- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax; no shell runs it.',
      '- `*` in a rule matches exactly one plain argument and `...` any number of them: a name or relative path made of letters, digits and `_ . / -`, not starting with `-`. A wildcard never matches a flag (`-n`, `--oneline`, `--flag=value`); flags and anything else are refused unless the user wrote them into a rule literally.',
      '- Every plain argument is resolved with links followed and must stay inside the target\'s folder; `..`, links that lead out and links that cannot be resolved are refused.',
      '- The first word of a command is the program, named by the rules. ksproxy\'s own files are always refused. An argument longer than 512 bytes is refused.',
      '- A bare program name is found through the user\'s absolute PATH entries only; a file in this folder is never found by name, so a rule that runs one names it with its path (for example `./run.sh`).',
    ];
    if (target.state !== 'up') {
      lines.push(`- The folder is not available (\`${target.state}\`): calls may fail until the user fixes it.`);
    }
    if (Array.isArray(target.paths)) lines.push(...pathsNotes(target));
    if (target.review === true) {
      const inside = Array.isArray(target.paths) ? ` Every path of a reviewed command must also lie inside these paths of the folder: ${target.paths.join(', ')}.` : '';
      lines.push(`- A command that is not on this list is reviewed before it runs and may be refused. Only these programs can be reviewed: ${target.programs.join(', ')}. Flags must be simple (\`-x\`, \`--word\`), with any value as a separate argument.${inside}`);
    }
    return lines.join('\n');
  },
  tool: {
    name: 'local_exec',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'local_exec',
      description: 'Run one command on this machine in an open local target\'s folder. The command is checked against that target\'s allowlist; shell syntax is not accepted.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'Command and arguments, separated by spaces' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
