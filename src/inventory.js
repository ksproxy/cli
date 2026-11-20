import fs from 'node:fs';
import path from 'node:path';
import { validateRule } from './allowlist.js';
import { expandHome } from './paths.js';

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
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const REMOTE_RE = /^[A-Za-z0-9.-]+:\d{1,5}$/;

const SSH_KEYS = ['name', 'host', 'description', 'allow'];
const KUBE_KEYS = ['name', 'kubeconfig', 'proxyPort', 'tunnel', 'manifestRoots', 'description', 'allow'];
const LOCAL_KEYS = ['name', 'cwd', 'description', 'allow'];
const TUNNEL_KEYS = ['host', 'localPort', 'remote'];

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

export function validateInventory(raw) {
  if (!isObject(raw)) throw new InventoryError('inventory: top level must be an object');
  checkKeys(raw, ['ssh', 'kubernetes', 'local'], 'inventory');
  for (const kind of ['ssh', 'kubernetes', 'local']) {
    if (raw[kind] !== undefined && !Array.isArray(raw[kind])) {
      throw new InventoryError(`inventory: ${kind}: must be an array`);
    }
  }

  const seenPorts = new Set();
  const ssh = [];
  const seenSsh = new Set();
  (raw.ssh ?? []).forEach((entry, i) => {
    const where = checkCommon('ssh', entry, i, seenSsh);
    checkKeys(entry, SSH_KEYS, where);
    checkHost(entry.host, `${where}: host`);
    ssh.push({
      kind: 'ssh',
      name: entry.name,
      host: entry.host,
      description: entry.description ?? '',
      allow: checkAllow(entry, where),
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

    kubernetes.push({
      kind: 'kubernetes',
      name: entry.name,
      kubeconfig,
      proxyPort: entry.proxyPort,
      tunnel,
      manifestRoots,
      description: entry.description ?? '',
      allow: checkAllow(entry, where),
    });
  });

  const local = [];
  const seenLocal = new Set();
  (raw.local ?? []).forEach((entry, i) => {
    const where = checkCommon('local', entry, i, seenLocal);
    checkKeys(entry, LOCAL_KEYS, where);
    const cwd = path.resolve(absolutePath(entry.cwd, `${where}: cwd`));
    local.push({
      kind: 'local',
      name: entry.name,
      cwd,
      description: entry.description ?? '',
      allow: checkAllow(entry, where, { any: false, program: true }),
    });
  });

  return { ssh, kubernetes, local };
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
