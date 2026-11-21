import path from 'node:path';
import { validateRule } from './allowlist.js';
import { expandHome } from './paths.js';

export class InventoryError extends Error {}

export const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const REVIEW_KEYS = ['reviewer', 'policy', 'accept', 'programs'];
const PROGRAM_RE = /^[A-Za-z0-9_./][A-Za-z0-9_./-]{0,199}$/;
const ACCEPTABLE = ['sure', 'likely'];
const SECRET_VARIABLE_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const SESSION_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'DISPLAY', 'KUBECONFIG',
];
const SESSION_ENV_PREFIXES = ['LC_', 'SSH_', 'NODE_', 'NPM_', 'XDG_'];

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// The URL of a service that ksproxy sends requests to: a reviewer's baseUrl, an http target's baseUrl.
// https, or http on the loopback names only; no user name, password, query or fragment. at names the field.
export function checkServiceUrl(value, at) {
  const url = typeof value === 'string' ? parseUrl(value) : null;
  if (url === null) throw new InventoryError(`${at}: must be a URL`);
  const local = url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new InventoryError(`${at}: must use https (http is accepted for localhost only)`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new InventoryError(`${at}: must not contain a user name, a password, a query or a fragment`);
  }
  return url;
}

// The name of an environment variable that holds a secret. start reads it and removes it from the environment of
// everything it runs, so it may be neither a variable the session needs nor one of ksproxy's own.
// at names the field, for example: reviewer "r1": keyEnv; holds says what the variable holds, for the message.
export function checkSecretVariable(value, at, holds = 'the secret') {
  if (typeof value !== 'string' || !SECRET_VARIABLE_RE.test(value) || value.startsWith('KSPROXY_')) {
    throw new InventoryError(`${at}: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_`);
  }
  if (SESSION_ENV.includes(value) || SESSION_ENV_PREFIXES.some((p) => value.startsWith(p))) {
    throw new InventoryError(`${at}: ${value} is a variable the session needs; name a variable that must hold only ${holds}`);
  }
  return value;
}

export function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function checkKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new InventoryError(`${where}: unknown key "${key}"`);
  }
}

export function checkPort(value, where, seenPorts) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new InventoryError(`${where}: must be an integer between 1024 and 65535`);
  }
  if (seenPorts.has(value)) throw new InventoryError(`${where}: port ${value} is already used elsewhere in the inventory`);
  seenPorts.add(value);
}

export function checkHost(value, where) {
  if (typeof value !== 'string' || !HOST_RE.test(value)) {
    throw new InventoryError(`${where}: must match ${HOST_RE} (no leading "-")`);
  }
}

export function absolutePath(value, where) {
  if (typeof value !== 'string' || value === '') throw new InventoryError(`${where}: must be a non-empty path`);
  const expanded = expandHome(value);
  if (!path.isAbsolute(expanded)) throw new InventoryError(`${where}: must be an absolute path or start with "~/"`);
  return expanded;
}

export function checkAllow(entry, where, { any = true, program = false } = {}) {
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

export function checkCommon(kind, entry, index, seenNames) {
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

export function checkInteger(value, fallback, min, max, where) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InventoryError(`${where}: must be an integer from ${min} to ${max}`);
  }
  return value;
}

// The output limit of a target, in KiB per stream: the default, and the most maxOutputKiB may set.
export const DEFAULT_OUTPUT_KIB = 256;
export const MAX_OUTPUT_KIB = 4096;

// The output limit of a target in KiB per stream: its maxOutputKiB when that is an integer from 256 to 4096, else 256.
// The inventory refuses any other value, so only a session file edited by hand can hold one, and it gives the default.
export function outputKiB(target) {
  const kib = target.maxOutputKiB;
  return Number.isInteger(kib) && kib >= DEFAULT_OUTPUT_KIB && kib <= MAX_OUTPUT_KIB ? kib : DEFAULT_OUTPUT_KIB;
}

export function checkReview(entry, where, reviewers, allow, { programs: needsPrograms }) {
  if (entry.review === undefined) return {};
  const at = `${where}: review`;
  if (!isObject(entry.review)) throw new InventoryError(`${at}: must be an object`);
  checkKeys(entry.review, REVIEW_KEYS, at);
  if (allow === 'any') throw new InventoryError(`${at}: has no effect with allow: "any"; remove one of them`);
  const {
    reviewer, policy, accept, programs,
  } = entry.review;
  let listed = {};
  if (needsPrograms) {
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
