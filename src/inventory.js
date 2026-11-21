import fs from 'node:fs';
import path from 'node:path';
import { tokenizeSshCommand, validateRule } from './allowlist.js';
import { expandHome } from './paths.js';
import { HOST_RE, MAX_JUMPS, parseJump } from './ssh.js';

export class InventoryError extends Error {}

export const SAMPLE_INVENTORY = {
  ssh: [
    {
      name: 'web1',
      host: 'web1.example.com',
      description: 'production web box',
      allow: ['systemctl status *', 'journalctl -u myapp ...', 'df -h'],
    },
  ],
  kubernetes: [
    {
      name: 'lab',
      kubeconfig: '~/.kube/lab-agent.yaml',
      proxyPort: 8001,
      tunnel: { host: 'bastion.example.com', localPort: 16443, remote: '127.0.0.1:6443' },
      manifestRoots: ['~/projects/lab/manifests'],
      description: 'lab cluster',
      allow: ['get ...', 'describe ...', 'logs ...', 'rollout status ...', 'apply -f *'],
    },
  ],
  local: [
    {
      name: 'infra',
      cwd: '~/projects/infra',
      description: 'terraform repo',
      allow: ['git status', 'git log --oneline -n * ...', 'terraform plan', 'ls -l ...'],
    },
  ],
};

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const REMOTE_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;

const SSH_KEYS = ['name', 'host', 'jumps', 'description', 'allow', 'review'];
const KUBE_KEYS = ['name', 'kubeconfig', 'proxyPort', 'tunnel', 'manifestRoots', 'description', 'allow', 'review'];
const LOCAL_KEYS = ['name', 'cwd', 'description', 'allow', 'review', 'protect'];
const TUNNEL_KEYS = ['host', 'localPort', 'remote'];
const REVIEWER_KEYS = ['baseUrl', 'model', 'keyEnv', 'timeoutSeconds', 'maxCalls'];
const REVIEW_KEYS = ['reviewer', 'policy', 'accept', 'programs'];
const PROGRAM_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]{0,199}$/;
const KEY_ENV_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SESSION_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'DISPLAY', 'KUBECONFIG',
];
const SESSION_ENV_PREFIXES = ['LC_', 'SSH_', 'NODE_', 'NPM_', 'XDG_'];
const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const ACCEPTABLE = ['sure', 'likely'];
const MAX_PROTECT = 50;
const MAX_PROTECT_BYTES = 512;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new InventoryError(`${where}: unknown key "${key}"`);
  }
}

function checkPort(value, where, seenPorts) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new InventoryError(`${where}: must be an integer between 1024 and 65535`);
  }
  if (seenPorts.has(value)) throw new InventoryError(`${where}: port ${value} is already used elsewhere in the inventory`);
  seenPorts.add(value);
}

function checkHost(value, where) {
  if (typeof value !== 'string' || !HOST_RE.test(value)) {
    throw new InventoryError(`${where}: must match ${HOST_RE} (no leading "-")`);
  }
}

function absolutePath(value, where) {
  if (typeof value !== 'string' || value === '') throw new InventoryError(`${where}: must be a non-empty path`);
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) throw new InventoryError(`${where}: must be an absolute path or start with "~/"`);
  return expanded;
}

function checkAllow(entry, where, { any = true, program = false } = {}) {
  if (entry.allow === undefined) return [];
  if (entry.allow === 'any') {
    if (!any) throw new InventoryError(`${where}: allow: "any" is not supported for local targets; list the commands`);
    return 'any';
  }
  if (!Array.isArray(entry.allow)) {
    throw new InventoryError(`${where}: allow: must be ${any ? '"any" or ' : ''}an array of rule strings`);
  }
  entry.allow.forEach((rule, i) => {
    try {
      validateRule(rule);
    } catch (err) {
      throw new InventoryError(`${where}: allow[${i}]: ${err.message}`);
    }
    if (program && ['*', '...'].includes(rule.trim().split(/\s+/)[0])) {
      throw new InventoryError(`${where}: allow[${i}]: a local rule must start with the program name`);
    }
  });
  return [...entry.allow];
}

function entryLabel(kind, entry, index) {
  const label = isObject(entry) && typeof entry.name === 'string' && NAME_RE.test(entry.name)
    ? `"${entry.name}"`
    : `#${index}`;
  return `${kind} ${label}`;
}

function checkCommon(kind, entry, index, seenNames) {
  const where = entryLabel(kind, entry, index);
  if (!isObject(entry)) throw new InventoryError(`${where}: must be an object`);
  if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) {
    throw new InventoryError(`${where}: name: must match ${NAME_RE}`);
  }
  if (seenNames.has(entry.name)) throw new InventoryError(`${where}: name: duplicate name`);
  seenNames.add(entry.name);
  if (entry.description !== undefined && typeof entry.description !== 'string') {
    throw new InventoryError(`${where}: description: must be a string`);
  }
  return where;
}

function checkInteger(value, fallback, min, max, where) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InventoryError(`${where}: must be an integer from ${min} to ${max}`);
  }
  return value;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function checkReviewers(raw) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new InventoryError('inventory: reviewers: must be an object');
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    const where = `reviewer "${name}"`;
    if (!NAME_RE.test(name)) throw new InventoryError(`${where}: name: must match ${NAME_RE}`);
    if (!isObject(entry)) throw new InventoryError(`${where}: must be an object`);
    checkKeys(entry, REVIEWER_KEYS, where);
    const url = typeof entry.baseUrl === 'string' ? parseUrl(entry.baseUrl) : null;
    if (url === null) throw new InventoryError(`${where}: baseUrl: must be a URL`);
    const local = url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
    if (url.protocol !== 'https:' && !local) {
      throw new InventoryError(`${where}: baseUrl: must use https (http is accepted for localhost only)`);
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      throw new InventoryError(`${where}: baseUrl: must not contain a user name, a password, a query or a fragment`);
    }
    if (typeof entry.model !== 'string' || !MODEL_RE.test(entry.model)) {
      throw new InventoryError(`${where}: model: must be 1 to 200 printable characters without spaces`);
    }
    const { keyEnv } = entry;
    if (keyEnv !== undefined && (typeof keyEnv !== 'string' || !KEY_ENV_RE.test(keyEnv) || keyEnv.startsWith('KSPROXY_'))) {
      throw new InventoryError(`${where}: keyEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_`);
    }
    if (keyEnv !== undefined && (SESSION_ENV.includes(keyEnv) || SESSION_ENV_PREFIXES.some((p) => keyEnv.startsWith(p)))) {
      throw new InventoryError(`${where}: keyEnv: ${keyEnv} is a variable the session needs; name a variable that must hold only the key`);
    }
    out[name] = {
      name,
      baseUrl: url.href.endsWith('/') ? url.href : `${url.href}/`,
      model: entry.model,
      keyEnv: keyEnv ?? null,
      timeoutSeconds: checkInteger(entry.timeoutSeconds, 10, 1, 60, `${where}: timeoutSeconds`),
      maxCalls: checkInteger(entry.maxCalls, 200, 1, 100000, `${where}: maxCalls`),
    };
  }
  return out;
}

function checkReview(entry, where, reviewers, allow, kind) {
  if (entry.review === undefined) return {};
  const at = `${where}: review`;
  if (!isObject(entry.review)) throw new InventoryError(`${at}: must be an object`);
  checkKeys(entry.review, REVIEW_KEYS, at);
  if (allow === 'any') throw new InventoryError(`${at}: has no effect with allow: "any"; remove one of them`);
  const {
    reviewer, policy, accept, programs,
  } = entry.review;
  let listed = {};
  if (kind === 'local') {
    const ok = Array.isArray(programs) && programs.length >= 1 && programs.length <= 50
      && programs.every((p) => typeof p === 'string' && PROGRAM_RE.test(p) && p !== '...')
      && new Set(programs).size === programs.length;
    if (!ok) {
      throw new InventoryError(`${at}.programs: must be a list of 1 to 50 program names or paths without repeats, for example ["git", "ls"]`);
    }
    listed = { programs: [...programs] };
  } else if (programs !== undefined) {
    throw new InventoryError(`${at}.programs: is only for local targets`);
  }
  if (typeof reviewer !== 'string' || !Object.hasOwn(reviewers, reviewer)) {
    throw new InventoryError(`${at}.reviewer: must name an entry of "reviewers"`);
  }
  if (typeof policy !== 'string' || policy.trim() === '' || policy.length > 1000) {
    throw new InventoryError(`${at}.policy: must be 1 to 1000 characters`);
  }
  let levels = ['sure'];
  if (accept !== undefined) {
    const ok = Array.isArray(accept) && accept.length > 0
      && accept.every((a) => ACCEPTABLE.includes(a)) && new Set(accept).size === accept.length;
    if (!ok) throw new InventoryError(`${at}.accept: must be a list of "sure" and "likely", for example ["sure"]`);
    levels = [...accept];
  }
  return {
    review: {
      reviewer, policy: policy.trim(), accept: levels, ...listed,
    },
  };
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

function checkJumps(entry, where, allow) {
  const list = entry.jumps;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_JUMPS) {
    throw new InventoryError(`${where}: jumps: must be a list of 1 to ${MAX_JUMPS} ssh commands`);
  }
  if (allow === 'any') throw new InventoryError(`${where}: jumps: a target with jumps needs a list of rules, not "any"`);
  const out = list.map((jump, j) => {
    if (typeof jump !== 'string' || jump.trim() === '') {
      throw new InventoryError(`${where}: jumps[${j}]: must be an ssh command, for example "ssh -i .ssh/key user@server"`);
    }
    if (jump.includes('~')) {
      throw new InventoryError(`${where}: jumps[${j}]: "~" is not allowed; a path without a leading "/" starts in the home folder of that login`);
    }
    try {
      const words = tokenizeSshCommand(jump);
      parseJump(words);
      return words.join(' ');
    } catch (err) {
      throw new InventoryError(`${where}: jumps[${j}]: ${err.message}`);
    }
  });
  return { jumps: out };
}

export function validateInventory(raw) {
  if (!isObject(raw)) throw new InventoryError('inventory: top level must be an object');
  checkKeys(raw, ['ssh', 'kubernetes', 'local', 'reviewers'], 'inventory');
  for (const kind of ['ssh', 'kubernetes', 'local']) {
    if (raw[kind] !== undefined && !Array.isArray(raw[kind])) {
      throw new InventoryError(`inventory: ${kind}: must be an array`);
    }
  }

  const reviewers = checkReviewers(raw.reviewers);
  const seenPorts = new Set();
  const ssh = [];
  const seenSsh = new Set();
  (raw.ssh ?? []).forEach((entry, i) => {
    const where = checkCommon('ssh', entry, i, seenSsh);
    checkKeys(entry, SSH_KEYS, where);
    checkHost(entry.host, `${where}: host`);
    const allow = checkAllow(entry, where);
    ssh.push({
      kind: 'ssh',
      name: entry.name,
      host: entry.host,
      ...checkJumps(entry, where, allow),
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, 'ssh'),
    });
  });

  const kubernetes = [];
  const seenKube = new Set();
  (raw.kubernetes ?? []).forEach((entry, i) => {
    const where = checkCommon('kubernetes', entry, i, seenKube);
    checkKeys(entry, KUBE_KEYS, where);
    const kubeconfig = absolutePath(entry.kubeconfig, `${where}: kubeconfig`);
    checkPort(entry.proxyPort, `${where}: proxyPort`, seenPorts);

    let tunnel = null;
    if (entry.tunnel !== undefined) {
      if (!isObject(entry.tunnel)) throw new InventoryError(`${where}: tunnel: must be an object`);
      checkKeys(entry.tunnel, TUNNEL_KEYS, `${where}: tunnel`);
      checkHost(entry.tunnel.host, `${where}: tunnel.host`);
      checkPort(entry.tunnel.localPort, `${where}: tunnel.localPort`, seenPorts);
      const remotePort = typeof entry.tunnel.remote === 'string' ? Number(entry.tunnel.remote.split(':').pop()) : NaN;
      if (typeof entry.tunnel.remote !== 'string' || !REMOTE_RE.test(entry.tunnel.remote)
        || remotePort < 1 || remotePort > 65535) {
        throw new InventoryError(`${where}: tunnel.remote: must be host:port`);
      }
      tunnel = { host: entry.tunnel.host, localPort: entry.tunnel.localPort, remote: entry.tunnel.remote };
    }

    let manifestRoots = [];
    if (entry.manifestRoots !== undefined) {
      if (!Array.isArray(entry.manifestRoots)) throw new InventoryError(`${where}: manifestRoots: must be an array`);
      manifestRoots = entry.manifestRoots.map((root, j) => absolutePath(root, `${where}: manifestRoots[${j}]`));
    }

    const allow = checkAllow(entry, where);
    kubernetes.push({
      kind: 'kubernetes',
      name: entry.name,
      kubeconfig,
      proxyPort: entry.proxyPort,
      tunnel,
      manifestRoots,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, 'kubernetes'),
    });
  });

  const local = [];
  const seenLocal = new Set();
  (raw.local ?? []).forEach((entry, i) => {
    const where = checkCommon('local', entry, i, seenLocal);
    checkKeys(entry, LOCAL_KEYS, where);
    const cwd = path.resolve(absolutePath(entry.cwd, `${where}: cwd`));
    const allow = checkAllow(entry, where, { any: false, program: true });
    local.push({
      kind: 'local',
      name: entry.name,
      cwd,
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, 'local'),
      ...checkProtect(entry, where),
    });
  });

  return {
    ssh, kubernetes, local, reviewers,
  };
}

export function loadInventory(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new InventoryError(`inventory not found: ${file}; run: ksproxy init`);
    }
    throw new InventoryError(`cannot read inventory ${file}: ${err.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new InventoryError(`inventory ${file} is not valid JSON: ${err.message}`);
  }
  return validateInventory(raw);
}
