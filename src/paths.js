import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export function isCaseInsensitive(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

const DATA_VOLUME = '/System/Volumes/Data';

// On macOS the same file can be named with or without the leading /System/Volumes/Data component.
// Only that exact leading component is dropped, and only on darwin.
export function dropDataVolume(p, platform = process.platform) {
  if (platform !== 'darwin' || !p.startsWith(DATA_VOLUME)) return p;
  const rest = p.slice(DATA_VOLUME.length);
  if (rest === '') return '/';
  return rest.startsWith('/') ? rest : p;
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function configDir(env = process.env) {
  if (env.KSPROXY_CONFIG_DIR) return env.KSPROXY_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'ksproxy');
  return path.join(os.homedir(), '.config', 'ksproxy');
}

export const PROJECT_KEY = 'KSPROXY_PROJECT';
export const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const PROJECT_RULE = '--project: a project name is 1 to 24 characters: lower-case letters, digits, "-" and "_", starting with a letter or a digit';
// The name that means the default inventory wherever --project is taken: it is never the name of a project.
export const PROJECT_DEFAULT = 'default';

// The project of a command, or null. Only the CLI sets it, through withProject; a present value that breaks the rule
// throws, so that a mistake can never fall back to the default session. The name default is no project, so no path is
// ever built on projects/default.json or p/default.
export function projectOf(env = process.env) {
  const name = env[PROJECT_KEY];
  if (name === undefined || name === PROJECT_DEFAULT) return null;
  if (typeof name !== 'string' || !PROJECT_RE.test(name)) throw new Error(PROJECT_RULE);
  return name;
}

// A copy of env for one project, or for none: an inherited value is removed first, so only the flag chooses. The name
// default gives the copy for none.
export function withProject(env, name) {
  const out = { ...env };
  delete out[PROJECT_KEY];
  if (name !== null && name !== PROJECT_DEFAULT) out[PROJECT_KEY] = name;
  return out;
}

export function projectsDir(env = process.env) {
  return path.join(configDir(env), 'projects');
}

export function inventoryPath(env = process.env) {
  const project = projectOf(env);
  return project === null ? path.join(configDir(env), 'inventory.json') : path.join(projectsDir(env), `${project}.json`);
}

// The state folder of every project and of the default session. The guards that keep ksproxy's own files out of reach
// use it, never stateDir, so that no project can reach the files of another one.
export function rootStateDir(env = process.env) {
  return env.KSPROXY_STATE_DIR || path.join(os.homedir(), '.ksproxy');
}

// The folder of the network listener and of its token: one for every project, in the root state folder.
export function listenDir(env = process.env) {
  return path.join(rootStateDir(env), 'listen');
}

// The key of a state folder that a run is given in place of its own: ksproxy doctor opens its targets in a temporary
// folder. A symbol is no environment variable, so only code can set it, a copy of env keeps it, and no child process
// gets it. rootStateDir and configDir never follow it, so the guards keep using the real folders.
export const STATE_FOLDER = Symbol('state folder');

// Where this session keeps its files: the folder under STATE_FOLDER when env has one, else the root for no project,
// else root/p/NAME.
export function stateDir(env = process.env) {
  if (env[STATE_FOLDER] !== undefined) return env[STATE_FOLDER];
  const project = projectOf(env);
  return project === null ? rootStateDir(env) : path.join(rootStateDir(env), 'p', project);
}

// The commands a message tells the user to run, for this project or for none.
export function initCommand(env = process.env) {
  const project = projectOf(env);
  return project === null ? 'ksproxy init' : `ksproxy init --project ${project}`;
}

export function startCommand(env = process.env) {
  const project = projectOf(env);
  return project === null ? 'ksproxy start' : `ksproxy start --project ${project}`;
}

export function checkCommand(env = process.env) {
  const project = projectOf(env);
  return project === null ? 'ksproxy check' : `ksproxy check --project ${project}`;
}

export function sessionDir(env = process.env) {
  return path.join(stateDir(env), 'session');
}

export function logDir(env = process.env) {
  return path.join(stateDir(env), 'logs');
}

export function auditLogPath(env = process.env) {
  return path.join(logDir(env), 'audit.log');
}

export function socketDir(env = process.env) {
  return path.join(stateDir(env), 's');
}

const SOCKET_LIMIT = 100;
// OpenSSH binds a master socket at its control path plus a dot and 16 random characters, then renames it to the
// control path: those 17 bytes must fit as well, so an ssh master socket is at most 83 bytes.
const SSH_TEMPORARY_BYTES = 17;
// ssh: an ssh target, tun: the tunnel of a kubernetes target, tnl: a shared connection of the service tunnels.
const SSH_MASTERS = ['ssh', 'tun', 'tnl'];

export function socketPath(kind, name, env = process.env) {
  const p = path.join(socketDir(env), `${kind}-${name}`);
  const limit = SSH_MASTERS.includes(kind) ? SOCKET_LIMIT - SSH_TEMPORARY_BYTES : SOCKET_LIMIT;
  if (Buffer.byteLength(p) > limit) {
    const shorter = projectOf(env) === null ? '' : ' or use a shorter project name';
    throw new Error(`socket path too long (${Buffer.byteLength(p)} bytes, limit ${limit}): ${p}; set KSPROXY_STATE_DIR to a shorter directory${shorter}`);
  }
  return p;
}

export const REVIEW_SOCKET_NAME = 'review-sock';

export function reviewSocketPath(env = process.env) {
  return socketPath('review', 'sock', env);
}

export const CALL_SOCKET_NAME = 'call-sock';

export function callSocketPath(env = process.env) {
  return socketPath('call', 'sock', env);
}

export function sshBin(env = process.env) {
  return env.KSPROXY_SSH || 'ssh';
}

export function kubectlBin(env = process.env) {
  return env.KSPROXY_KUBECTL || 'kubectl';
}

export function mongoshBin(env = process.env) {
  return env.KSPROXY_MONGOSH || 'mongosh';
}

export function psqlBin(env = process.env) {
  return env.KSPROXY_PSQL || 'psql';
}

// client is the target's "client": mysql or mariadb.
export function mysqlBin(env = process.env, client = 'mysql') {
  return env.KSPROXY_MYSQL || client;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

// Writes the text through a temporary file and a rename, so a reader sees the old text or the new one, never a part.
// keep is asked just before the rename: when it gives false, the temporary file is removed, the file is left as it
// was, and the result is false. Gives true once the file holds the text.
export function writeFileAtomic(file, text, keep = () => true) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    if (!keep()) {
      fs.rmSync(tmp, { force: true });
      return false;
    }
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
