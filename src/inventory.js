import fs from 'node:fs';
import {
  DEFAULT_OUTPUT_KIB, InventoryError, MAX_OUTPUT_KIB, NAME_RE, checkCommon, checkInteger, checkKeys, checkSecretVariable, checkServiceUrl,
  isObject,
} from './checks.js';
import { KINDS } from './kinds/index.js';

export { InventoryError };

export function sampleInventory() {
  return Object.fromEntries(KINDS.map((kind) => [kind.key, kind.sample]));
}

const REVIEWER_KEYS = ['baseUrl', 'model', 'keyEnv', 'timeoutSeconds', 'maxCalls'];
const MODEL_RE = /^[\x21-\x7e]{1,200}$/;
const LONE_STAR_ESCAPE = /(?<!\\)\\\*/;

function checkReviewers(raw) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new InventoryError('inventory: reviewers: must be an object');
  const out = {};
  for (const [name, entry] of Object.entries(raw)) {
    const where = `reviewer "${name}"`;
    if (!NAME_RE.test(name)) throw new InventoryError(`${where}: name: must match ${NAME_RE}`);
    if (!isObject(entry)) throw new InventoryError(`${where}: must be an object`);
    checkKeys(entry, REVIEWER_KEYS, where);
    const url = checkServiceUrl(entry.baseUrl, `${where}: baseUrl`);
    if (typeof entry.model !== 'string' || !MODEL_RE.test(entry.model)) {
      throw new InventoryError(`${where}: model: must be 1 to 200 printable characters without spaces`);
    }
    const { keyEnv } = entry;
    if (keyEnv !== undefined) checkSecretVariable(keyEnv, `${where}: keyEnv`, 'the key');
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

export function validateInventory(raw) {
  if (!isObject(raw)) throw new InventoryError('inventory: top level must be an object');
  checkKeys(raw, [...KINDS.map((kind) => kind.key), 'reviewers'], 'inventory');
  for (const { key } of KINDS) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      throw new InventoryError(`inventory: ${key}: must be an array`);
    }
  }

  const ctx = { reviewers: checkReviewers(raw.reviewers), seenPorts: new Set() };
  const validated = {};
  for (const kind of KINDS) {
    const seenNames = new Set();
    validated[kind.key] = (raw[kind.key] ?? []).map((entry, i) => {
      const where = checkCommon(kind.key, entry, i, seenNames);
      // maxOutputKiB is checked here, the same for every kind, and the kind checks the rest of the entry.
      const { maxOutputKiB, ...rest } = entry;
      const limit = checkInteger(maxOutputKiB, undefined, DEFAULT_OUTPUT_KIB, MAX_OUTPUT_KIB, `${where}: maxOutputKiB`);
      const target = kind.validate(rest, where, ctx);
      return limit === undefined ? target : { ...target, maxOutputKiB: limit };
    });
  }
  return { ...validated, reviewers: ctx.reviewers };
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
    const hint = LONE_STAR_ESCAPE.test(text) ? '; in the inventory file a backslash is written twice: \\\\*' : '';
    throw new InventoryError(`inventory ${file} is not valid JSON: ${err.message}${hint}`);
  }
  return validateInventory(raw);
}
