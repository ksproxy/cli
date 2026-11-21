import fs from 'node:fs';
import path from 'node:path';
import {
  AllowError, decide, describeAllow, isRegexRule, matchRuleDetail, regexSource, tokenizeSshCommand,
} from '../../allowlist.js';
import {
  InventoryError, absolutePath, checkAllow, checkKeys, checkReview,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import {
  cleanPath, localFolderProblem, localScope, looksSecret, reviewProblem, sessionProtected, wildcardProblem,
} from './folder.js';

const LOCAL_KEYS = ['name', 'cwd', 'description', 'allow', 'review', 'protect'];
const MAX_PROTECT = 50;
const MAX_PROTECT_BYTES = 512;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function checkProtect(entry, where) {
  const list = entry.protect;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PROTECT) {
    throw new InventoryError(`${where}: protect: must be a list of 1 to ${MAX_PROTECT} paths inside the folder`);
  }
  const out = [];
  list.forEach((item, j) => {
    const at = `${where}: protect[${j}]`;
    if (typeof item !== 'string' || item === '' || Buffer.byteLength(item) > MAX_PROTECT_BYTES || CONTROL_CHAR.test(item)) {
      throw new InventoryError(`${at}: must be a path of 1 to ${MAX_PROTECT_BYTES} bytes without control characters`);
    }
    if (item.startsWith('/') || item.startsWith('~')) {
      throw new InventoryError(`${at}: must be relative to the folder, not an absolute path or one that starts with "~"`);
    }
    const parts = item.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.includes('..')) throw new InventoryError(`${at}: may not contain ".."`);
    if (parts.length === 0) throw new InventoryError(`${at}: names the folder itself; list a file or folder inside it`);
    const clean = parts.join('/');
    if (out.includes(clean)) throw new InventoryError(`${at}: ${clean} is listed twice`);
    out.push(clean);
  });
  return { protect: out };
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

function decideLocal(target, input, env = process.env, platform = process.platform) {
  if (!Array.isArray(target.allow)) {
    return { allowed: false, reason: 'this local target has no usable allowlist', short: 'allowlist is empty' };
  }
  const folder = localFolderProblem(target.cwd, env, Array.isArray(target.protected) ? target.protected : [], platform);
  if (folder !== null) {
    return {
      allowed: false,
      reason: `this target's folder is not acceptable; ask the user to run "ksproxy check local ${target.name}"`,
      short: 'folder not allowed',
    };
  }
  const usable = target.allow.filter(usableRule);
  const scope = localScope(target, env, platform);
  try {
    const tokens = tokenizeSshCommand(input);
    let first = null;
    let preferred = null;
    for (const rule of usable) {
      const detail = matchRuleDetail(tokens, rule);
      if (detail === null) continue;
      const problem = detail.regex
        ? regexProblem(tokens, rule, target, env, scope)
        : wildcardProblem(detail, target, env, scope);
      if (problem === null) return { allowed: true, rule, argv: tokens };
      first ??= problem;
      if (problem.short !== 'not a plain argument') preferred ??= problem;
    }
    const shown = preferred ?? first;
    if (shown !== null) return { allowed: false, reason: shown.reason, short: shown.short };
    if (usable.length === 0 && target.allow.length > 0) {
      return { allowed: false, reason: 'not on the allowlist for this target', short: 'not on allowlist' };
    }
    const refusal = decide(tokens, usable);
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
    };
  },
  openingMessage(t) {
    return t.cwd;
  },
  // Nothing is held open, so there is no close and the check runs at once, without waiting.
  open(t, { env, secretFiles }) {
    const problem = folderProblem(t.cwd, env, secretFiles);
    if (problem !== null) return { ok: false, error: problem };
    const loose = looseSecrets(t);
    if (loose.length === 0) return { ok: true, extras: {} };
    const more = loose.length > MAX_NAMED ? ` and ${loose.length - MAX_NAMED} more` : '';
    return {
      ok: true,
      extras: {},
      notes: [`holds ${loose.slice(0, MAX_NAMED).join(', ')}${more}: list them in "protect" to also refuse commands given the whole folder`],
    };
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
  forCheck(target, { env, secretFiles }) {
    const problem = localFolderProblem(target.cwd, env, secretFiles);
    if (problem !== null) return { refusal: problem };
    return {
      target: {
        ...target,
        protected: secretFiles,
        ...(target.review ? { review: true, programs: target.review.programs } : {}),
      },
    };
  },
  toolBullet: '- `local_exec { target, command, timeout_seconds? }` - run one command on this machine in a target\'s folder.',
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
    if (target.review === true) {
      lines.push(`- A command that is not on this list is reviewed before it runs and may be refused. Only these programs can be reviewed: ${target.programs.join(', ')}. Flags must be simple (\`-x\`, \`--word\`), with any value as a separate argument.`);
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
