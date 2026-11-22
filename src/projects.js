import fs from 'node:fs';
import path from 'node:path';
import { isObject } from './checks.js';
import { KINDS, secretFilesOf } from './kinds/index.js';
import {
  PROJECT_RE, expandHome, inventoryPath, projectOf, projectsDir, rootStateDir, sessionDir as sessionDirOf, withProject,
} from './paths.js';
import { liveSession } from './session.js';

// Where a port comes from, in a message: a project, or the default.
const whereOf = (project) => (project === null ? 'the default inventory' : `project ${project}`);

// The errors of a projects folder that hold no project file: it is missing, or it is a file.
const NO_FOLDER = ['ENOENT', 'ENOTDIR'];

// Every live session: the default first, then each project in name order, each with the env of its own project. A
// project is an entry of root/p that is a folder itself, by the type readdir gives as lstat would (a link is never
// followed), and whose name passes the project rule.
export function liveSessions(env) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(path.join(rootStateDir(env), 'p'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROJECT_RE.test(entry.name)).map((entry) => entry.name).sort();
  } catch {
    names = [];
  }
  for (const project of [null, ...names]) {
    const own = withProject(env, project);
    const session = liveSession(sessionDirOf(own));
    if (session !== null && Array.isArray(session.targets)) out.push({ project, session, env: own });
  }
  return out;
}

// Every inventory file but the one of this command, read as JSON and not checked: the default inventory.json, then each
// projects/NAME.json whose NAME passes the project rule, in name order. A missing file is left out. unreadable is the
// first file, or the projects folder, that exists but cannot be read or is not JSON; the files after it are not read.
export function otherInventories(env) {
  const own = projectOf(env);
  const folder = projectsDir(env);
  let names = [];
  try {
    names = fs.readdirSync(folder).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length))
      .filter((name) => PROJECT_RE.test(name)).sort();
  } catch (err) {
    if (!NO_FOLDER.includes(err.code)) return { others: [], unreadable: folder };
  }
  const others = [];
  for (const project of [null, ...names]) {
    if (project === own) continue;
    const file = inventoryPath(withProject(env, project));
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return { others, unreadable: file };
    }
    others.push({ where: whereOf(project), raw });
  }
  return { others, unreadable: null };
}

// The entries of one kind in an inventory read as JSON: the objects in its list, or none.
function entriesOf(raw, key) {
  const list = isObject(raw) ? raw[key] : undefined;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

// The ports that the other inventory files and the live sessions of the other projects, or of the default, name, by
// the ports of each kind that has them: used maps each integer port to where it is named first. unreadable is passed on.
export function usedPorts(env, inventories = otherInventories(env)) {
  const own = projectOf(env);
  const sessions = liveSessions(env).filter((live) => live.project !== own);
  const used = new Map();
  for (const kind of KINDS) {
    if (kind.ports === undefined) continue;
    const sources = [
      ...inventories.others.map(({ where, raw }) => ({ where, entries: entriesOf(raw, kind.key) })),
      ...sessions.map(({ project, session }) => ({
        where: whereOf(project), entries: session.targets.filter((t) => isObject(t) && t.kind === kind.key),
      })),
    ];
    for (const { where, entries } of sources) {
      for (const port of kind.ports(entries)) {
        if (Number.isInteger(port) && !used.has(port)) used.set(port, where);
      }
    }
  }
  return { used, unreadable: inventories.unreadable };
}

// The files that hold credentials in the other inventory files: what secretFiles of each kind gives for its entries
// there, kept when it is a text that is an absolute path once a leading ~ is expanded, and normalised.
export function otherSecretFiles(inventories) {
  return KINDS.flatMap((kind) => (kind.secretFiles === undefined ? []
    : inventories.others.flatMap(({ raw }) => kind.secretFiles(entriesOf(raw, kind.key)))))
    .filter((file) => typeof file === 'string').map(expandHome).filter((file) => path.isAbsolute(file))
    .map((file) => path.resolve(file));
}

// The files that local targets may never reach: those of this command's inventory, then those of every other inventory
// file. problem says why no local target may open, when another file could not be read, else it is null.
export function everySecretFile(inventory, inventories) {
  return {
    files: [...secretFilesOf(inventory), ...otherSecretFiles(inventories)],
    problem: inventories.unreadable === null ? null : `cannot read ${inventories.unreadable} to protect the files it names`,
  };
}

// Why a target may not open because of its ports, or null. Only a kind that has ports is checked: when another file
// could not be read every such target is refused, else one whose port another file or live session names.
export function portProblem(kind, target, ports) {
  if (kind.ports === undefined) return null;
  if (ports.unreadable !== null) return `cannot read ${ports.unreadable} to check its ports`;
  const port = kind.ports([target]).find((p) => ports.used.has(p));
  return port === undefined ? null : `port ${port} is also used by ${ports.used.get(port)}; give each project its own port`;
}
