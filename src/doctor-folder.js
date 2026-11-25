import fs from 'node:fs';
import path from 'node:path';
import { KINDS } from './kinds/index.js';
import {
  STATE_FOLDER, ensureDir, rootStateDir, socketDir, writeFileAtomic,
} from './paths.js';
import { isLive, processStartTime } from './session.js';

// The temporary state folders of ksproxy doctor, in the root state folder. Each is named d- and six random characters,
// short so that its socket paths stay close to those of start, and holds an owner record, owner.json, with the pid of
// its process and the start time of that process, as session.json does. A doctor that is killed leaves its folder, and
// in it a cluster proxy or an ssh master: the next doctor or start stops them and removes the folder.

const PREFIX = 'd-';
const OWNER = 'owner.json';
// A folder without an owner record that has not changed for this long is no live doctor's: a doctor writes its record
// as soon as it has made the folder.
const ABANDONED_MS = 5 * 60 * 1000;

// Writes the owner record of pid in folder: the start time is null when ps cannot tell, and isLive then trusts the pid.
function writeOwner(folder, pid) {
  writeFileAtomic(path.join(folder, OWNER), `${JSON.stringify({ pid, processStartedAt: processStartTime(pid) })}\n`);
}

// Makes the temporary state folder of one doctor project, mode 0700, with the owner record of pid.
export function makeDoctorFolder(env, pid) {
  ensureDir(rootStateDir(env));
  const folder = fs.mkdtempSync(path.join(rootStateDir(env), PREFIX));
  writeOwner(folder, pid);
  return folder;
}

// True for a name that writeFileAtomic gives the owner record while it writes it.
const recordTemp = (name) => name.startsWith(`${OWNER}.`) && name.endsWith('.tmp');

// Removes what a doctor killed before it wrote its owner record left: a folder without a record, unchanged for
// ABANDONED_MS, that holds nothing or only temporary files of the record. Any other folder, or a failure, leaves it.
function removeAbandoned(folder, now) {
  try {
    if (now - fs.lstatSync(folder).mtimeMs < ABANDONED_MS) return;
    if (fs.readdirSync(folder).every(recordTemp)) fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    // left for the next run
  }
}

// Takes a folder over for pid: true once a folder whose owner record names a process that is gone holds the record of
// pid instead. A folder whose record cannot be read is left, and removed when removeAbandoned finds it abandoned; a
// recent one may be a live doctor's that is being made. A folder whose owner runs, and one whose record cannot be
// written are left alone. A record that is no JSON names no live process.
function takeOver(folder, pid, now) {
  let text;
  try {
    text = fs.readFileSync(path.join(folder, OWNER), 'utf8');
  } catch {
    removeAbandoned(folder, now);
    return false;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    owner = null;
  }
  if (isLive(owner)) return false;
  try {
    writeOwner(folder, pid);
    return true;
  } catch {
    return false;
  }
}

// Removes a folder that was taken over, its owner record last: a folder that cannot be removed keeps the record, and
// the next run takes it over again.
function removeFolder(folder) {
  try {
    for (const name of fs.readdirSync(folder)) {
      if (name !== OWNER) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
    }
    fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    // left for the next run
  }
}

// Cleans up after every killed doctor: each folder of the root state folder named d- and something whose owner is not
// live is taken over for pid, then each kind's reapStale runs on its socket folder, in reverse list order as start runs
// it on its own, and the folder is removed. An entry that is not a folder, a link included, is skipped and never
// followed: the entries are read with their types, which, as lstat, do not follow a link. Every folder is taken over
// before the first await, so that another start of this process (several projects run at once) or of another one
// finds it live and leaves it. env is the env of the caller, without credentials. Gives the lines of the kinds.
export async function reapDoctorFolders(env, pid) {
  const root = rootStateDir(env);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const now = Date.now();
  const taken = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
    .map((entry) => path.join(root, entry.name))
    .filter((folder) => takeOver(folder, pid, now));
  const lines = [];
  for (const folder of taken) {
    const moved = { ...env, [STATE_FOLDER]: folder };
    for (const kind of [...KINDS].reverse()) {
      if (kind.reapStale === undefined) continue;
      lines.push(...await kind.reapStale({ socketDir: socketDir(moved), env: moved }));
    }
    removeFolder(folder);
  }
  return lines;
}
