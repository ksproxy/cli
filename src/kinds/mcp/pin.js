import path from 'node:path';

// The pinned-version check of a local MCP server's command. A program that downloads and runs a package at every start
// (npx, bunx, uvx, pipx, docker run, podman run) must name an exact version or an image tag other than latest. Each
// runner has a table of the options it knows; an option it does not know is refused, so nothing unpinned can slip in
// through an option ksproxy cannot read. nerdctl and finch are read as docker; go run needs an exact module version.
// npm, pnpm, pnpx, yarn, bun, uv, deno, dnx, pixi, mise and corepack are refused outright, and so are python -m pipx and
// python -m uv. Any other program is the owner's own and is not checked. A package's own dependencies are not pinned by
// any of these.

const NPM_NAME = '(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\\/)?[A-Za-z0-9][A-Za-z0-9._~-]*';
const SEMVER = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?';
const NPM_PINNED = new RegExp(`^${NPM_NAME}@${SEMVER}$`);
const PY_NAME = '[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\\[[A-Za-z0-9._,-]+\\])?';
const PY_VERSION = '\\d+(?:\\.\\d+)*(?:(?:a|b|rc)\\d+)?(?:\\.post\\d+)?(?:\\.dev\\d+)?';
const PY_EXACT = new RegExp(`^${PY_NAME}==${PY_VERSION}$`);
const PY_AT = new RegExp(`^${PY_NAME}@${PY_VERSION}$`);
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const NPM_HINT = 'write the package as name@1.2.3 or @scope/name@1.2.3';
const UVX_HINT = 'write name@1.2.3, or --from \'name==1.2.3\' and the command';
const PIPX_HINT = 'write --spec name==1.2.3 and the command, or name==1.2.3';
const IMAGE_HINT = 'write the image with a tag other than latest (name:1.2.3) or a digest (name@sha256:...)';

const pinnedNpm = (spec) => NPM_PINNED.test(spec);
const pinnedPython = (spec) => PY_EXACT.test(spec) || PY_AT.test(spec);

// The option tables. values: options that take a value, as the next word or after "=" for a long option; flags:
// options without a value; refused: options never accepted, with the reason; specs: the value options whose value is a
// package that must be pinned.
const NPX = {
  values: ['-p', '--package'],
  flags: ['-y', '--yes', '--no', '-q', '--quiet'],
  refused: { '-c': 'runs a shell command', '--call': 'runs a shell command' },
  specs: ['-p', '--package'],
};
const BUNX = {
  values: ['-p', '--package'],
  flags: ['--bun', '--silent', '--verbose', '--no-install'],
  refused: {},
  specs: ['-p', '--package'],
};
const UVX = {
  values: ['--from', '--with', '--python', '-p', '--exclude-newer'],
  flags: ['--isolated', '--no-cache', '-n', '--quiet', '-q', '--verbose', '-v', '--offline', '--refresh', '--no-progress', '--native-tls'],
  refused: {
    '--with-requirements': 'reads its packages from a file, which ksproxy cannot check',
    '--with-editable': 'runs a package from a folder, which ksproxy cannot check',
  },
  specs: ['--from', '--with'],
};
const PIPX_RUN = {
  values: ['--spec', '--python'],
  flags: ['--no-cache', '--verbose', '-v', '--quiet', '-q', '--system-site-packages'],
  refused: { '--pip-args': 'passes options to pip, which ksproxy cannot check' },
  specs: ['--spec'],
};
const CONTAINER_RUN = {
  values: [
    '-e', '--env', '--env-file', '-v', '--volume', '--mount', '--name', '--network', '--net', '-w', '--workdir', '-u', '--user',
    '--entrypoint', '--platform', '--pull', '-m', '--memory', '--cpus', '-l', '--label', '--add-host', '--cap-add',
    '--cap-drop', '--security-opt', '--tmpfs', '-h', '--hostname', '--dns', '--ulimit', '--shm-size', '--log-driver',
    '--log-opt', '--userns', '--pids-limit',
  ],
  flags: ['-i', '--interactive', '--rm', '--init', '--read-only', '-q', '--quiet', '--privileged', '--no-healthcheck'],
  refused: {
    '-t': 'gives the server a terminal, which breaks its messages',
    '--tty': 'gives the server a terminal, which breaks its messages',
    '-d': 'runs the server in the background, away from ksproxy',
    '--detach': 'runs the server in the background, away from ksproxy',
  },
  specs: [],
};

// The options of a runner, up to the first word that is not an option or after "--": { options: [[name, value]],
// positional, rest } or { problem }. A value given with "=" is taken for a long option only.
function readOptions(words, table, runner) {
  const options = [];
  let i = 0;
  for (; i < words.length; i += 1) {
    const word = words[i];
    if (word === '--') {
      i += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = eq === -1 ? word : word.slice(0, eq);
    if (Object.hasOwn(table.refused, name)) return { problem: `${runner} ${name} ${table.refused[name]}` };
    if (table.values.includes(name)) {
      const value = eq === -1 ? words[i + 1] : word.slice(eq + 1);
      if (eq === -1) i += 1;
      if (value === undefined) return { problem: `${runner} ${name} needs a value` };
      options.push([name, value]);
    } else if (table.flags.includes(name) && eq === -1) {
      options.push([name, null]);
    } else {
      return { problem: `ksproxy does not know the option ${word} of ${runner}; it reads every option so that nothing unpinned runs` };
    }
  }
  return { options, positional: words[i], rest: words.slice(i + 1) };
}

// The values of the options that name a package; refused the first one that is not pinned.
function unpinnedSpec(read, table, pinned) {
  return read.options.find(([name, value]) => table.specs.includes(name) && !pinned(value));
}

// npx and bunx: every -p or --package value is pinned; without one, the package is the first word after the options.
function npmRunner(table, runner) {
  return (words) => {
    const read = readOptions(words, table, runner);
    if (read.problem !== undefined) return read.problem;
    const bad = unpinnedSpec(read, table, pinnedNpm);
    if (bad !== undefined) return `${runner} ${bad[0]} ${bad[1]} has no exact version; ${NPM_HINT}`;
    const packaged = read.options.some(([name]) => table.specs.includes(name));
    if (read.positional === undefined) return `${runner} names nothing to run; ${NPM_HINT}`;
    if (!packaged && !pinnedNpm(read.positional)) return `${runner} runs ${read.positional} without an exact version; ${NPM_HINT}`;
    return null;
  };
}

// uvx: --from and every --with are pinned; without --from, the command word is name@version.
function uvx(words) {
  const read = readOptions(words, UVX, 'uvx');
  if (read.problem !== undefined) return read.problem;
  const bad = unpinnedSpec(read, UVX, pinnedPython);
  if (bad !== undefined) return `uvx ${bad[0]} ${bad[1]} has no exact version; ${UVX_HINT}`;
  if (read.positional === undefined) return `uvx names nothing to run; ${UVX_HINT}`;
  const from = read.options.some(([name]) => name === '--from');
  if (!from && !PY_AT.test(read.positional)) return `uvx runs ${read.positional} without an exact version; ${UVX_HINT}`;
  return null;
}

// pipx run: --spec is pinned; without it, the package word is name==version.
function pipx(words) {
  if (words[0] !== 'run') return `pipx is accepted only as pipx run; ${PIPX_HINT}`;
  const read = readOptions(words.slice(1), PIPX_RUN, 'pipx run');
  if (read.problem !== undefined) return read.problem;
  const bad = unpinnedSpec(read, PIPX_RUN, pinnedPython);
  if (bad !== undefined) return `pipx run ${bad[0]} ${bad[1]} has no exact version; ${PIPX_HINT}`;
  if (read.positional === undefined) return `pipx run names nothing to run; ${PIPX_HINT}`;
  const spec = read.options.some(([name]) => name === '--spec');
  if (!spec && !PY_EXACT.test(read.positional)) return `pipx run runs ${read.positional} without an exact version; ${PIPX_HINT}`;
  return null;
}

// The tag of an image: the part after the last "/", then after its ":"; host:5000/img has none. A digest is enough,
// and an image with "@" must have one.
function imageProblem(image, runner) {
  const problem = `${runner} runs the image ${image} without a fixed tag; ${IMAGE_HINT}`;
  if (image.includes('@')) return DIGEST.test(image) ? null : problem;
  const last = image.slice(image.lastIndexOf('/') + 1);
  const at = last.indexOf(':');
  const tag = at === -1 ? null : last.slice(at + 1);
  return tag === null || tag === 'latest' || !TAG.test(tag) ? problem : null;
}

// docker run and podman run: -i and --rm are required, the image is the first word after the options.
function containerRunner(runner) {
  return (words) => {
    if (words[0] !== 'run') return `${runner} is accepted only as ${runner} run -i --rm IMAGE:TAG`;
    const read = readOptions(words.slice(1), CONTAINER_RUN, `${runner} run`);
    if (read.problem !== undefined) return read.problem;
    const names = read.options.map(([name]) => name);
    if (!names.includes('-i') && !names.includes('--interactive')) return `${runner} run needs -i, so that the server reads its messages`;
    if (!names.includes('--rm')) return `${runner} run needs --rm, so that no container is left behind`;
    if (read.positional === undefined) return `${runner} run names no image; ${IMAGE_HINT}`;
    return imageProblem(read.positional, runner);
  };
}

// go run: every word that is a module query (a host with a dot, a path, then @) names an exact version vX.Y.Z. A word
// such as an email address is not a module query.
const MODULE_QUERY = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[^@\s]*@(.*)$/;
const GO_VERSION = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function go(words) {
  if (words[0] !== 'run') return null;
  const loose = words.slice(1).find((word) => {
    const query = MODULE_QUERY.exec(word);
    return query !== null && !GO_VERSION.test(query[1]);
  });
  return loose === undefined ? null : `go run runs ${loose} without an exact version; write the module as path@v1.2.3`;
}

const RUNNERS = {
  npx: npmRunner(NPX, 'npx'),
  bunx: npmRunner(BUNX, 'bunx'),
  uvx,
  pipx,
  docker: containerRunner('docker'),
  podman: containerRunner('podman'),
  nerdctl: containerRunner('nerdctl'),
  finch: containerRunner('finch'),
  go,
};

// Programs that can download and run a package in ways ksproxy cannot read (a subcommand anywhere among their words,
// an abbreviation, create and init, a script's own list of packages, a missing import fetched at run time), so they are
// refused whatever their words, with what to use instead.
const NPX_INSTEAD = 'npx with an exact version';
const OTHER_INSTEAD = 'npx, bunx, uvx or pipx run with an exact version, or a program you installed';
const REFUSED_PROGRAMS = {
  npm: NPX_INSTEAD,
  pnpm: NPX_INSTEAD,
  pnpx: NPX_INSTEAD,
  yarn: NPX_INSTEAD,
  bun: 'bunx with an exact version',
  uv: 'uvx with an exact version, or python for a script of your own',
  deno: 'npx with an exact version, or node for a script of your own',
  dnx: OTHER_INSTEAD,
  pixi: OTHER_INSTEAD,
  mise: OTHER_INSTEAD,
  corepack: OTHER_INSTEAD,
};

// python -m pipx and python -m uv run the same tools as pipx and uv, so they are refused too; any other module is the
// owner's own. A Python is python, python3 or python3.12, by its base name in lower case.
const PYTHON = /^python(?:\d+(?:\.\d+)?)?$/;
const PYTHON_MODULES = { pipx: 'pipx run with an exact version', uv: 'uvx with an exact version' };
// The module of python -m among the interpreter's options, which end at the first word that is not one (the script);
// -W and -X take the next word as their value.
const PYTHON_VALUES = ['-W', '-X'];
function pythonModule(words) {
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (!word.startsWith('-')) return null;
    if (word.startsWith('-m')) {
      const module = word === '-m' ? words[i + 1] : word.slice(2);
      return Object.hasOwn(PYTHON_MODULES, module) ? module : null;
    }
    if (PYTHON_VALUES.includes(word)) i += 1;
  }
  return null;
}

// null when the command may run, else why not, with how to pin it. argv[0] is compared by its base name in lower case,
// since a disk that ignores case runs npx for NPX.
export function pinProblem(argv) {
  const written = path.basename(argv[0]);
  const program = written.toLowerCase();
  if (Object.hasOwn(RUNNERS, program)) return RUNNERS[program](argv.slice(1));
  const refused = (what, use) => `${what} is not accepted: it can download and run a package that ksproxy cannot see pinned; use ${use}`;
  if (Object.hasOwn(REFUSED_PROGRAMS, program)) return refused(written, REFUSED_PROGRAMS[program]);
  const module = PYTHON.test(program) ? pythonModule(argv.slice(1)) : null;
  return module === null ? null : refused(`${written} -m ${module}`, PYTHON_MODULES[module]);
}
