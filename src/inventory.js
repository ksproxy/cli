import fs from 'node:fs';
import {
  DEFAULT_OUTPUT_KIB, InventoryError, MAX_OUTPUT_KIB, NAME_RE, checkCommon, checkInteger, checkKeys, checkSecretVariable, checkServiceUrl,
  isObject,
} from './checks.js';
import { KINDS } from './kinds/index.js';
import { checkTunnel } from './kinds/engines/tunnel.js';

export { InventoryError };

// What ksproxy init writes: the sample of each kind in list order, from freeSample of the ports in taken for a kind
// that has it.
export function sampleInventory(taken = new Set()) {
  return Object.fromEntries(KINDS.map((kind) => [kind.key, kind.freeSample === undefined ? kind.sample : kind.freeSample(taken)]));
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

// The routes of the service tunnels, per inventory that validateInventory gave: "KIND:NAME" to a frozen
// { host, jumps }. They are kept here, outside the inventory and its targets, so that no spread, JSON.stringify,
// structuredClone or inspect of either can carry a route (jump commands with key paths) into session.json, AGENT.md,
// list_targets or any other output. Neither a kind key nor a target name holds a ":".
const ROUTES = new WeakMap();

// The route of one target of an inventory that validateInventory gave: { host, jumps }, frozen, jumps a list of jump
// texts, or null when the target has no tunnel. Any other object, a copy of such an inventory included, throws: a
// lost route must never look like a target without one, which would connect straight from this machine.
export function tunnelRoute(inventory, kindKey, name) {
  const routes = ROUTES.get(inventory);
  if (routes === undefined) throw new Error('tunnelRoute: not an inventory that validateInventory gave');
  return routes.get(`${kindKey}:${name}`) ?? null;
}

// The tunnel of one entry. Only a brokered kind is concerned; ssh and local refuse it as an unknown key, and the
// kubernetes kind checks its own tunnel. A brokered kind gets the entry without tunnel; with a tunnel, a kind with
// tunnelTo gets the route that checkTunnel gives, any other brokered kind is refused.
function takeTunnel(kind, entry, where) {
  if (kind.brokered !== true) return { own: entry, route: null };
  const { tunnel, ...own } = entry;
  if (tunnel === undefined) return { own, route: null };
  if (kind.tunnelTo === undefined) throw new InventoryError(`${where}: this kind cannot use a tunnel`);
  return { own, route: checkTunnel(tunnel, where) };
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
  const routes = new Map();
  for (const kind of KINDS) {
    const seenNames = new Set();
    validated[kind.key] = (raw[kind.key] ?? []).map((entry, i) => {
      const where = checkCommon(kind.key, entry, i, seenNames);
      // maxOutputKiB and the tunnel are checked here, the same for every kind, and the kind checks the rest of the entry.
      const { maxOutputKiB, ...rest } = entry;
      const limit = checkInteger(maxOutputKiB, undefined, DEFAULT_OUTPUT_KIB, MAX_OUTPUT_KIB, `${where}: maxOutputKiB`);
      const { own, route } = takeTunnel(kind, rest, where);
      const checked = kind.validate(own, where, ctx);
      const target = limit === undefined ? checked : { ...checked, maxOutputKiB: limit };
      if (route !== null) {
        // tunnelProblem is pure and sees no secret: a text it gives refuses the route of this target.
        const problem = kind.tunnelProblem === undefined ? null : kind.tunnelProblem(target);
        if (typeof problem === 'string') throw new InventoryError(`${where}: tunnel: ${problem}`);
        routes.set(`${kind.key}:${target.name}`, Object.freeze({ host: route.host, jumps: Object.freeze([...route.jumps]) }));
      }
      return target;
    });
  }
  const inventory = { ...validated, reviewers: ctx.reviewers };
  ROUTES.set(inventory, routes);
  return inventory;
}

export function loadInventory(file, initHint = 'ksproxy init') {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new InventoryError(`inventory not found: ${file}; run: ${initHint}`);
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
