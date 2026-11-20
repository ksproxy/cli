import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, writeFileAtomic } from './paths.js';

const FILE = 'session.json';

export function writeSession(dir, session) {
  ensureDir(dir);
  writeFileAtomic(path.join(dir, FILE), `${JSON.stringify(session, null, 2)}\n`);
}

export function readSession(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function psEnv(env = process.env) {
  return { PATH: env.PATH ?? '/bin:/usr/bin', LC_ALL: 'C' };
}

export function parseLstart(text) {
  const ms = Date.parse(text.trim());
  return Number.isNaN(ms) ? null : ms;
}

// Start time of a pid in ms, or null when it cannot be determined.
export function processStartTime(pid) {
  const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', env: psEnv(), timeout: 2000,
  });
  if (out.status !== 0) return null;
  return parseLstart(out.stdout);
}

export function isLive(session) {
  const pid = session?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  if (!Number.isFinite(session.processStartedAt)) return true;
  const started = processStartTime(pid);
  return started === null || Math.abs(started - session.processStartedAt) <= 5000;
}

export function liveSession(dir) {
  const session = readSession(dir);
  return isLive(session) ? session : null;
}

export function clearSession(dir) {
  fs.rmSync(path.join(dir, FILE), { force: true });
}
