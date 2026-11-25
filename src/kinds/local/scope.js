import path from 'node:path';
import {
  isPath, pathsProblem, plainValues, valueProblem,
} from './folder.js';

// The programs list of a local target with paths: the programs the owner lets run with any arguments, inside those
// paths. This file holds what that list adds to the checks of folder.js: the options always refused, which arguments
// are paths, and the programs that can act as the owner.

// A program of the list: a bare name of letters, digits and _ . + -, not starting with "-", never a path.
export const BARE_PROGRAM = /^[A-Za-z0-9_.+][A-Za-z0-9_.+-]*$/;

// Programs that can act as the owner: run other code or programs, reach the network, read other processes or the
// owner's data, use the owner's saved logins, or unpack an archive whose members can have absolute names or be links
// that point anywhere, which a program that follows links then reads. Listing one is allowed; start and check warn
// about it. Compared with the names of programNames, and with the part of each before its first "-".
export const ACTING_PROGRAMS = {
  shells: ['sh', 'bash', 'rbash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh', 'pwsh', 'busybox', 'toybox'],
  interpreters: [
    'node', 'nodejs', 'deno', 'bun', 'ruby', 'irb', 'erb', 'tclsh', 'wish', 'expect', 'osascript', 'awk', 'gawk', 'mawk',
    'nawk', 'r', 'rscript', 'julia', 'java', 'jshell', 'groovy', 'scala', 'kotlin', 'swift', 'dotnet', 'ghci', 'runghc',
    'erl', 'elixir', 'iex', 'guile', 'racket', 'sbcl', 'm4', 'dc', 'sqlite3', 'duckdb',
  ],
  runners: [
    'env', 'xargs', 'exec', 'command', 'nohup', 'nice', 'timeout', 'time', 'watch', 'stdbuf', 'setsid', 'script', 'parallel',
    'flock', 'taskset', 'ionice', 'chrt', 'caffeinate', 'arch', 'sandbox-exec', 'open', 'xdg-open', 'xcrun', 'tmux',
    'screen', 'entr', 'ssh-agent', 'crontab', 'at', 'batch', 'launchctl', 'systemctl', 'systemd-run', 'taskpolicy', 'lockf',
    'prlimit', 'shortcuts', 'automator',
  ],
  privileges: ['sudo', 'doas', 'su', 'pkexec', 'chroot', 'unshare', 'nsenter', 'runuser', 'setpriv', 'capsh', 'sg', 'newgrp', 'fakeroot'],
  network: [
    'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'lftp', 'telnet', 'openssl',
    'http', 'xh', 'aria2c', 'rclone', 'dig', 'nslookup', 'host', 'mail', 'mailx', 'sendmail', 'mutt', 'psql', 'mysql',
    'mongosh', 'redis-cli', 'pg_dump', 'pg_dumpall', 'mysqldump',
  ],
  editors: ['vi', 'vim', 'nvim', 'view', 'ex', 'ed', 'nano', 'pico', 'emacs', 'mg', 'micro', 'code', 'less', 'more', 'most', 'man'],
  debuggers: ['lldb', 'gdb', 'strace', 'ltrace', 'dtrace', 'dtruss', 'valgrind', 'perf'],
  builders: [
    'make', 'cmake', 'ninja', 'bazel', 'meson', 'scons', 'gradle', 'mvn', 'ant', 'rake', 'cargo', 'go', 'cc', 'gcc', 'g++',
    'c++', 'clang', 'clang++', 'javac', 'xcodebuild',
  ],
  packages: [
    'npm', 'npx', 'yarn', 'pnpm', 'corepack', 'uv', 'uvx', 'poetry', 'conda', 'mamba', 'gem', 'bundle', 'bundler',
    'composer', 'rustup', 'brew', 'port', 'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'rpm', 'apk', 'pacman', 'nix', 'nix-env',
    'nix-shell', 'snap', 'flatpak', 'asdf', 'mise',
  ],
  documents: [
    'pandoc', 'latexmk', 'tex', 'latex', 'pdftex', 'pdflatex', 'xetex', 'xelatex', 'luatex', 'lualatex', 'groff', 'troff', 'nroff',
  ],
  archives: ['tar', 'unzip', 'zip', 'cpio', 'pax', 'ditto'],
  accounts: [
    'ps', 'pgrep', 'pkill', 'kill', 'killall', 'lsof', 'top', 'htop', 'security', 'defaults', 'pbpaste', 'pbcopy', 'log',
    'dscl', 'gpg', 'ssh-add', 'op', 'vault', 'pass', 'gh', 'glab', 'aws', 'gcloud', 'gsutil', 'az', 'doctl', 'heroku',
    'flyctl', 'vercel', 'terraform', 'pulumi', 'ansible', 'helm', 'kubectl', 'docker', 'podman', 'nerdctl', 'minikube',
    'git', 'svn', 'hg', 'ksproxy', 'ssh-keygen', 'oc', 'k9s', 'stern', 'kubectx', 'kubens', 'argocd', 'flux', 'istioctl',
    'docker-compose', 'aws-vault', 'sops', 'bw', 'tofu', 'terragrunt', 'ansible-playbook', 'mdfind', 'screencapture',
  ],
};

// A program whose name starts with one of these words can act as the owner too: python3, perl5.34, php8.2, luajit, pip3.
export const ACTING_PREFIXES = ['python', 'perl', 'php', 'lua', 'pip'];

const ACTING = new Set(Object.values(ACTING_PROGRAMS).flat());

// The options that run code or reach outside paths and cwd, always refused; a best effort, as ACTING_PROGRAMS is. Among
// them are options that name a program to run: sort --compress-program, split --filter, install --strip-program and
// the --diff-program of sdiff and diff3. exact: a whole word. long: a long option, also shortened, since GNU programs
// accept any start of a long option; kept: the exact options of the same program that only share a start with one of
// them. short: letters inside a group of short flags (-xIf), and with oldStyle also in the first argument without a
// dash (tar xIf), which tar reads as flags. colon: every argument that holds ":", which the program can read as a
// remote archive (HOST:FILE).
export const REFUSED_OPTIONS = {
  find: {
    exact: ['-exec', '-execdir', '-ok', '-okdir'], long: [], kept: [], short: [], oldStyle: false, colon: false,
  },
  tar: {
    exact: [],
    long: [
      '--to-command', '--use-compress-program', '--checkpoint-action', '--info-script', '--new-volume-script',
      '--rsh-command', '--rmt-command', '--absolute-names', '--absolute-paths', '--directory', '--cd', '--files-from',
      '--insecure',
    ],
    kept: ['--checkpoint', '--file'],
    short: ['I', 'F', 'P', 'C', 'T'],
    oldStyle: true,
    colon: true,
  },
  cpio: {
    exact: [], long: ['--insecure', '--rsh-command'], kept: [], short: [], oldStyle: false, colon: true,
  },
  pax: {
    exact: [], long: [], kept: [], short: [], oldStyle: false, colon: true,
  },
  zip: {
    exact: [], long: ['--unzip-command'], kept: [], short: ['TT'], oldStyle: false, colon: false,
  },
  unzip: {
    exact: [], long: [], kept: [], short: [':'], oldStyle: false, colon: false,
  },
  sort: {
    exact: [], long: ['--compress-program'], kept: [], short: [], oldStyle: false, colon: false,
  },
  split: {
    exact: [], long: ['--filter'], kept: [], short: [], oldStyle: false, colon: false,
  },
  install: {
    exact: [], long: ['--strip-program'], kept: ['--strip'], short: [], oldStyle: false, colon: false,
  },
  sdiff: {
    exact: [], long: ['--diff-program'], kept: [], short: [], oldStyle: false, colon: false,
  },
  diff3: {
    exact: [], long: ['--diff-program'], kept: [], short: [], oldStyle: false, colon: false,
  },
};

// Programs whose leading g belongs to their name: gzip is no GNU build of zip, nor gunzip of unzip.
const OWN_G = ['gzip', 'gunzip'];

// The names a program is compared by: its base name in lower case, and its stem, the base name cut at the first dot
// without a version at its end (digits, "-" and "_"); each also without a leading g, gnu or bsd (gsed, gnutar, bsdtar),
// unless the stem is one of OWN_G.
export function programNames(program) {
  const base = path.posix.basename(program).toLowerCase();
  const stem = base.split('.')[0].replace(/[0-9_-]+$/, '');
  const prefixes = OWN_G.includes(stem) ? [] : ['g', 'gnu', 'bsd'];
  const names = [];
  for (const word of [base, stem]) {
    names.push(word);
    for (const prefix of prefixes) {
      if (word.length > prefix.length && word.startsWith(prefix)) names.push(word.slice(prefix.length));
    }
  }
  return [...new Set(names)];
}

function actingName(name) {
  return ACTING.has(name) || ACTING_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// The programs of a list that can act as the owner, as the list writes them: a program acts when one of its
// programNames, or the part of one before its first "-", does (docker-compose is docker, aws-vault is aws).
export function actingPrograms(programs) {
  const acting = (name) => actingName(name) || actingName(name.split('-')[0]);
  return programs.filter((program) => programNames(program).some(acting));
}

// The programs list of a session target, its bare names only: empty without a list of paths that is not empty.
export function programsOf(target, paths) {
  if (paths === null || paths.length === 0 || !Array.isArray(target.listedPrograms)) return [];
  return target.listedPrograms.filter((name) => typeof name === 'string' && BARE_PROGRAM.test(name));
}

// True when arg is one of the long options, or a start of one that is at least three characters long (--x), unless
// it is an exact option of the program that only shares that start (tar --checkpoint).
function longOption(arg, rules) {
  if (!arg.startsWith('--') || arg.length < 3) return false;
  const name = arg.split('=')[0];
  return !rules.kept.includes(name) && rules.long.some((option) => option.startsWith(name));
}

function optionRefused(rules, arg, index) {
  if (rules.exact.includes(arg) || longOption(arg, rules)) return true;
  const group = arg.startsWith('-') ? !arg.startsWith('--') : rules.oldStyle && index === 0;
  return group && rules.short.some((letters) => arg.includes(letters));
}

// The scripts sed would run, read once as GNU sed and once as BSD sed read their arguments, or null when a script
// comes from a file (-f or --file), which cannot be checked. A script may be undefined when sed would find none.
export function sedScripts(args) {
  const scripts = [];
  for (const bsd of [false, true]) {
    const operands = [];
    let given = false;
    let options = true;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (!options || !arg.startsWith('-') || arg === '-') {
        operands.push(arg);
        if (bsd) options = false;
      } else if (arg === '--') {
        options = false;
      } else if (arg.startsWith('--')) {
        const [name, ...value] = arg.slice(2).split('=');
        if ('file'.startsWith(name)) return null;
        if ('expression'.startsWith(name)) {
          scripts.push(value.length > 0 ? value.join('=') : args[++i]);
          given = true;
        } else if ('line-length'.startsWith(name) && value.length === 0) {
          i += 1;
        }
      } else {
        for (let k = 1; k < arg.length; k += 1) {
          const letter = arg[k];
          const rest = arg.slice(k + 1);
          if (letter === 'f') return null;
          if (letter === 'e') {
            scripts.push(rest === '' ? args[++i] : rest);
            given = true;
            break;
          }
          // A value follows: -l N for GNU, -i EXT and -I EXT for BSD; GNU reads only a glued suffix after -i.
          if (bsd ? 'iI'.includes(letter) : letter === 'l') {
            if (rest === '') i += 1;
            break;
          }
          if (letter === 'i') break;
        }
      }
    }
    if (!given) scripts.push(operands[0]);
  }
  return scripts;
}

// The address of a sed script: line numbers, commas, plus signs and /regex/ with I or M after it. A word holds no
// space, backslash, ";" or "!", so it is one command.
const SED_ADDRESS = /^(?:[0-9,+]|\/[^/]*\/[IM]*)*/;

// True when one sed script runs a command, or writes or reads a file of its own: the commands e, w, W, r and R, and an
// s command with the flag e or w.
export function sedScriptRefused(script) {
  if (typeof script !== 'string') return false;
  const command = script.slice(SED_ADDRESS.exec(script)[0].length);
  if (command[0] === 's') return /[ew]/.test(command.slice(2).split(command[1]).slice(2).join(''));
  return /^[ewWrR]/.test(command);
}

function sedProblem(args) {
  const scripts = sedScripts(args);
  if (scripts === null) {
    return {
      reason: 'a sed script read from a file cannot be checked, so -f and --file are always refused',
      short: 'sed script refused',
    };
  }
  const script = scripts.find(sedScriptRefused);
  if (script === undefined) return null;
  return {
    reason: `the sed script ${script} runs a command, or writes or reads a file of its own, so it is always refused`,
    short: 'sed script refused',
  };
}

// null when no option of the program runs code or reaches outside, else { reason, short }.
export function optionProblem(program, args) {
  const names = programNames(program);
  if (names.includes('sed')) return sedProblem(args);
  const name = Object.keys(REFUSED_OPTIONS).find((key) => names.includes(key));
  if (name === undefined) return null;
  const rules = REFUSED_OPTIONS[name];
  const refused = args.find((arg, i) => optionRefused(rules, arg, i));
  if (refused !== undefined) {
    return {
      reason: `the option ${refused} of ${program} can run other code or reach outside the paths, so it is always refused`,
      short: 'option refused',
    };
  }
  const remote = rules.colon ? args.find((arg) => arg.includes(':')) : undefined;
  if (remote === undefined) return null;
  return {
    reason: `the argument ${remote} holds ":", which ${program} can read as a remote archive (HOST:FILE), so it is always refused`,
    short: 'remote archive',
  };
}

// The words of one argument that may name a path: the argument itself; for a long flag the value after "="; for a
// short flag every tail after its first letter, since -oout may be -o out.
export function argumentValues(arg) {
  if (!arg.startsWith('-')) return [arg];
  if (arg.startsWith('--')) {
    const at = arg.indexOf('=');
    return at === -1 ? [] : [arg.slice(at + 1)];
  }
  return Array.from({ length: Math.max(arg.length - 2, 0) }, (_, k) => arg.slice(k + 2));
}

// null when every argument of a listed rule's wildcards that is a path lies inside paths, or when there are no paths.
export function listedPathsProblem(args, paths, scope) {
  if (paths === null) return null;
  for (const arg of args) {
    const problem = isPath(arg, scope.cwdReal) ? pathsProblem(arg, paths, scope) : null;
    if (problem !== null) return problem;
  }
  return null;
}

// One path of a listed program's command: a plain relative path, then the checks of a wildcard argument, then paths.
function pathProblem(value, paths, target, env, scope) {
  if (plainValues(value) === null) {
    return {
      reason: `the argument ${value} is not a plain relative path: a path is made of letters, digits and _ . / - and does not start with / or -`,
      short: 'not a plain path',
    };
  }
  if (!scope.checked.has(value)) scope.checked.set(value, valueProblem(value, target, env, scope));
  return scope.checked.get(value) ?? pathsProblem(value, paths, scope);
}

// null when a listed program may run with these tokens, else { reason, short }: its options, then every path. A word
// after "--" is checked whole and also as a flag would be, since "--" may be the value of the flag before it
// (sort -T -- -onotes). The caller has found the program word in the programs list.
export function programsProblem(tokens, paths, target, env, scope) {
  const [program, ...args] = tokens;
  const first = optionProblem(program, args);
  if (first !== null) return first;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') {
      options = false;
      continue;
    }
    for (const value of options ? argumentValues(arg) : new Set([arg, ...argumentValues(arg)])) {
      const problem = isPath(value, scope.cwdReal) ? pathProblem(value, paths, target, env, scope) : null;
      if (problem !== null) return problem;
    }
  }
  return null;
}
