import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

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

export function inventoryPath(env = process.env) {
  return path.join(configDir(env), 'inventory.json');
}

export function stateDir(env = process.env) {
  return env.KSPROXY_STATE_DIR || path.join(os.homedir(), '.ksproxy');
}

export function sessionDir(env = process.env) {
  return path.join(stateDir(env), 'session');
}

export function socketDir(env = process.env) {
  return path.join(stateDir(env), 's');
}

export function socketPath(kind, name, env = process.env) {
  const p = path.join(socketDir(env), `${kind}-${name}`);
  if (Buffer.byteLength(p) > 100) {
    throw new Error(`socket path too long (${Buffer.byteLength(p)} bytes, limit 100): ${p}; set KSPROXY_STATE_DIR to a shorter directory`);
  }
  return p;
}

export function sshBin(env = process.env) {
  return env.KSPROXY_SSH || 'ssh';
}

export function kubectlBin(env = process.env) {
  return env.KSPROXY_KUBECTL || 'kubectl';
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
