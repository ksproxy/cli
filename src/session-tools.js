import fs from 'node:fs';
import path from 'node:path';
import { NAME_RE, isObject } from './checks.js';
import { MAX_NAME, SESSION_BUDGET, TOOLS_FILE } from './kinds/mcp/export.js';
import { SESSION_FILE, pidAlive } from './session.js';

// The tools that the MCP servers of a live session give the agent directly, as TARGET__TOOL. ksproxy start writes them
// to mcp-tools.json in the session folder (src/kinds/mcp/export.js); ksproxy mcp and the network listener read them
// here. The file is used only when it is whole and has the shape start writes, and its pid and start time are those of
// the live session.json: a file that a killed run left, or one of another run, is never used. Anything wrong gives no
// tools.

// The largest file that is read. start writes at most SESSION_BUDGET bytes of definitions, and less than as much again
// in the fields around them (a definition is at least 80 bytes, its fields at most 120), so a file start wrote never
// comes near four times that.
export const MAX_TOOLS_FILE_BYTES = 4 * SESSION_BUDGET;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

// The text of a regular file of at most max bytes, or null: missing, cannot be opened, not a regular file, or larger.
// The file is opened without waiting, so a named pipe never blocks, and its size is that of the file opened, so a file
// replaced meanwhile is never read past max. It is closed in every case; a read that fails once it is open throws, and
// the caller, sessionTools of src/tools.js, gives no tools then.
function readSmall(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let text = null;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.size <= max) text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return text;
}

// Whether one entry of the file has the shape start writes: a target name, a tool name of letters, digits, _ and -,
// a time limit of 1 to 600 seconds, and a definition named TARGET__TOOL, at most MAX_NAME characters, with a text
// description and an input schema that is an object of type object.
function validEntry(entry) {
  if (!isObject(entry) || !isObject(entry.definition)) return false;
  const {
    target, tool, timeoutSeconds, definition,
  } = entry;
  return typeof target === 'string' && NAME_RE.test(target)
    && typeof tool === 'string' && TOOL_NAME.test(tool)
    && Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 600
    && definition.name === `${target}__${tool}` && definition.name.length <= MAX_NAME
    && typeof definition.description === 'string'
    && isObject(definition.inputSchema) && definition.inputSchema.type === 'object';
}

// The tools of mcp-tools.json in dir for the live session read from the same folder, in the order of the file, each
// { target, tool, timeoutSeconds, definition: { name, description, inputSchema } } and nothing more. None when the file
// is missing, not a regular file, larger than MAX_TOOLS_FILE_BYTES, not JSON, not version 1, of another pid or start
// time than the session, or when any entry is not as start writes it.
export function readSessionTools(dir, session) {
  const text = readSmall(path.join(dir, TOOLS_FILE), MAX_TOOLS_FILE_BYTES);
  if (text === null) return [];
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return [];
  }
  const own = isObject(file) && file.version === 1 && file.pid === session.pid
    && file.processStartedAt === (session.processStartedAt ?? null) && Array.isArray(file.tools);
  if (!own || !file.tools.every(validEntry)) return [];
  return file.tools.map(({
    target, tool, timeoutSeconds, definition,
  }) => ({
    target,
    tool,
    timeoutSeconds,
    definition: { name: definition.name, description: definition.description, inputSchema: definition.inputSchema },
  }));
}

// A short text that changes when session.json or mcp-tools.json in dir is written, appears or goes, and when the
// process pid starts or stops being: what the poll of ksproxy mcp compares before it computes the tool list again. It
// reads no file and starts no program. It throws when a file cannot be looked at for another reason than being missing.
export function toolsStamp(dir, pid) {
  const of = (name) => {
    const stat = fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
    return stat === undefined ? null : [stat.ino, stat.size, stat.mtimeMs];
  };
  return JSON.stringify([of(SESSION_FILE), of(TOOLS_FILE), pidAlive(pid)]);
}
