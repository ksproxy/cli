import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, stateDir } from './paths.js';

export function isCaseInsensitive(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}

const CASE_INSENSITIVE = isCaseInsensitive();

const PLAIN = /^[A-Za-z0-9_.][A-Za-z0-9_./-]*$/;

const DATA_VOLUME = '/System/Volumes/Data';
const MAX_FOLDER_BYTES = 400;
const MAX_VALUE_BYTES = 512;
const MAX_JOINED_BYTES = 1000;
const UNRESOLVABLE = ['ENOENT', 'ELOOP'];
const PSEUDO_ROOTS = ['/proc', '/dev', '/sys'];

export function isInside(child, parent, insensitive = CASE_INSENSITIVE) {
  const c = insensitive ? child.toLowerCase() : child;
  const p = insensitive ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// On macOS the same file can be named with or without the leading /System/Volumes/Data component.
// Only that exact leading component is dropped, and only on darwin.
export function dropDataVolume(p, platform = process.platform) {
  if (platform !== 'darwin' || !p.startsWith(DATA_VOLUME)) return p;
  const rest = p.slice(DATA_VOLUME.length);
  if (rest === '') return '/';
  return rest.startsWith('/') ? rest : p;
}

// { real } for the real path of the deepest part of `p` that exists plus the rest appended,
// or { code } with the error code when it cannot be examined.
function examine(p, lstat, platform) {
  let current = p;
  const rest = [];
  for (;;) {
    let exists = true;
    try {
      lstat(current);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return { code: err.code };
      exists = false;
    }
    if (exists) {
      try {
        return { real: dropDataVolume(path.join(fs.realpathSync.native(current), ...rest), platform) };
      } catch (err) {
        return { code: err.code };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return { real: dropDataVolume(path.join(current, ...rest), platform) };
    rest.unshift(path.basename(current));
    current = parent;
  }
}

// Real path of the deepest part of `p` that exists, plus the rest appended.
// A path that cannot be examined (dangling or looping link, permission, name too long) yields null.
export function realish(p, lstat = fs.lstatSync, platform = process.platform) {
  const found = examine(p, lstat, platform);
  return found.real ?? null;
}

function ownDirs(env, platform) {
  const dirs = [];
  for (const dir of [stateDir(env), configDir(env)]) {
    dirs.push(dir);
    const real = realish(dir, undefined, platform);
    if (real) dirs.push(real);
  }
  return dirs;
}

// What `start` records as protected: the inventory kubeconfigs and its own folders, as it sees them.
export function sessionProtected(kubeconfigs, env = process.env) {
  return [...new Set([...kubeconfigs, ...ownDirs(env, process.platform)])];
}

const DEFAULT_PATH = '/usr/bin:/bin';

// PATH for a local command: absolute entries only, none inside any local target folder.
export function cleanPath(value, folders, platform = process.platform) {
  const reals = folders.map((folder) => realish(folder, undefined, platform));
  if (reals.includes(null)) return DEFAULT_PATH;
  const kept = [];
  for (const entry of String(value ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const real = realish(entry, undefined, platform);
    if (real === null || reals.some((folder) => isInside(real, folder))) continue;
    kept.push(entry);
  }
  return kept.length > 0 ? kept.join(path.delimiter) : DEFAULT_PATH;
}

// True when resolving `p` follows a symbolic link whose target lies in a per-process or device file system.
// Such a link can resolve differently in this process and in the command that is started.
export function crossesPseudoFs(p, fsImpl = fs) {
  let pending = path.resolve(p).split(path.sep).filter(Boolean);
  let current = path.sep;
  let hops = 0;
  while (pending.length > 0) {
    const next = path.join(current, pending.shift());
    let stat;
    try { stat = fsImpl.lstatSync(next); } catch { return false; }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > 40) return true;
    let link;
    try { link = fsImpl.readlinkSync(next); } catch { return true; }
    const target = path.resolve(current, link);
    if (PSEUDO_ROOTS.some((root) => target === root || target.startsWith(root + path.sep))) return true;
    pending = [...target.split(path.sep).filter(Boolean), ...pending];
    current = path.sep;
  }
  return false;
}

export function localFolderProblem(cwd, env = process.env, protectedList = [], platform = process.platform) {
  const real = realish(cwd, undefined, platform);
  if (real === null || crossesPseudoFs(cwd)) return 'folder cannot be resolved';
  if (Buffer.byteLength(real) > MAX_FOLDER_BYTES) return 'folder path is too long';
  const home = realish(os.homedir(), undefined, platform) ?? os.homedir();
  if (real === path.parse(real).root || isInside(home, real)) {
    return `folder is too broad: pick a project folder, not ${cwd}`;
  }
  for (const dir of ownDirs(env, platform)) {
    if (isInside(dir, real) || isInside(real, dir)) return "folder overlaps ksproxy's own files";
  }
  for (const file of protectedList) {
    if (typeof file !== 'string' || file === '') continue;
    const fileReal = realish(file, undefined, platform);
    if (isInside(file, real) || (fileReal !== null && isInside(fileReal, real))) {
      return 'folder contains a kubeconfig named in the inventory';
    }
  }
  return null;
}

// The argument as a one-element list when a wildcard may match it, else null. Flags are never plain.
export function plainValues(arg) {
  return PLAIN.test(arg) ? [arg] : null;
}

export function protectedPaths(target, env = process.env, platform = process.platform) {
  const out = [];
  for (const p of [stateDir(env), configDir(env), ...(Array.isArray(target.protected) ? target.protected : [])]) {
    if (typeof p !== 'string' || p === '') continue;
    out.push(p);
    const real = realish(p, undefined, platform);
    if (real) out.push(real);
  }
  return out;
}

// What one decision needs about the target, worked out once: its real folder and its protected locations.
export function localScope(target, env = process.env, platform = process.platform) {
  return {
    platform,
    cwdReal: realish(target.cwd, undefined, platform),
    protectedList: protectedPaths(target, env, platform),
    checked: new Map(),
  };
}

// Drops empty and "." segments: a/./b and a//b mean a/b. ".." is never simplified.
function simplify(value) {
  const absolute = value.startsWith('/');
  const parts = value.split('/').filter((s) => s !== '' && s !== '.');
  return (absolute ? '/' : '') + parts.join('/');
}

const tooLong = () => ({ reason: 'the argument is too long to check', short: 'argument too long' });

// null when the value is acceptable, else { reason, short }.
export function valueProblem(value, target, env = process.env, scope = localScope(target, env)) {
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return tooLong();
  if (value.split('/').includes('..')) {
    return { reason: `the argument ${value} contains ".."`, short: 'contains ".."' };
  }
  const simple = simplify(value);
  const folder = scope.cwdReal ?? target.cwd;
  const joined = path.isAbsolute(simple) ? simple : (simple === '' ? folder : `${folder}${path.sep}${simple}`);
  if (Buffer.byteLength(joined) > MAX_JOINED_BYTES) return tooLong();
  const found = examine(joined, fs.lstatSync, scope.platform);
  const unresolvable = () => ({ reason: `the argument ${value} is a link that cannot be resolved`, short: 'unresolvable link' });
  if (found.code === 'ELOOP') return unresolvable();
  if (crossesPseudoFs(joined)) {
    return { reason: `the argument ${value} goes through a link into /proc, /dev or /sys`, short: 'system link' };
  }
  if (found.real === undefined) {
    if (UNRESOLVABLE.includes(found.code)) return unresolvable();
    return { reason: `the argument ${value} cannot be examined`, short: 'cannot be examined' };
  }
  const { real } = found;
  const resolved = path.resolve(joined);
  for (const dir of scope.protectedList) {
    if (isInside(resolved, dir) || isInside(real, dir) || isInside(dir, real)) {
      return { reason: "ksproxy's own files are off limits", short: 'ksproxy files' };
    }
  }
  if (scope.cwdReal === null || !isInside(real, scope.cwdReal)) {
    return { reason: `the argument ${value} points outside this target's folder`, short: 'outside the folder' };
  }
  return null;
}

// null when every wildcard-matched argument is acceptable, else { reason, short }.
export function wildcardProblem(detail, target, env = process.env, scope = localScope(target, env)) {
  for (const arg of [...detail.star, ...detail.rest]) {
    const values = plainValues(arg);
    if (values === null) {
      return {
        reason: `the argument ${arg} is not a plain name or path; a wildcard in a local rule only matches those. Flags and anything else must be written into the rule literally`,
        short: 'not a plain argument',
      };
    }
    for (const value of values) {
      if (!scope.checked.has(value)) scope.checked.set(value, valueProblem(value, target, env, scope));
      const problem = scope.checked.get(value);
      if (problem) return problem;
    }
  }
  return null;
}
