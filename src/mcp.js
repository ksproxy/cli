import fs from 'node:fs';
import readline from 'node:readline';
import { loadInventory } from './inventory.js';
import { inventoryPath, sessionDir, startCommand } from './paths.js';
import { readSession } from './session.js';
import { toolsStamp } from './session-tools.js';
import { callTool, directTools, toolDefinitions } from './tools.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const SERVER_INFO = { name: 'ksproxy', version: pkg.version };

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

// The instructions of initialize: the last sentence names the command that starts the session of this project, or of
// the default.
export function instructionsFor(env) {
  return 'Run commands on the ssh servers, Kubernetes clusters, local folders and service targets (databases, queues and HTTP APIs) the user has opened. '
    + 'Call list_targets first. Every call is checked against a per-target allowlist and logged. '
    + `If there is no active session, ask the user to run "${startCommand(env)}".`;
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function success(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// The inventory as the tool listing needs it. No inventory file holds no target; a file that cannot be read or is
// not a valid inventory gives null, and then every tool is listed. The inventory holds no credential, and reading
// it here reads nothing else; a failure never stops the server.
function inventoryForTools(env) {
  const file = inventoryPath(env);
  if (!fs.existsSync(file)) return {};
  try {
    return loadInventory(file);
  } catch {
    return null;
  }
}

// Whether the inventory may give the agent tools of a live session: it holds an mcp target, or it cannot be read (then
// every tool is listed, and it may hold one). Without, the session is never read for the tool list, so no ps runs.
const mayHaveMcp = (inventory) => inventory === null || (inventory.mcp ?? []).length > 0;

// The tool list of tools/list: the fixed tools for the inventory, then the tools of the live session, see directTools,
// when the inventory may have them.
export function listedTools(env) {
  const inventory = inventoryForTools(env);
  return toolDefinitions(inventory, mayHaveMcp(inventory) ? directTools(env) : []);
}

// How often, once its client is initialized, serve checks whether the tool list changed.
export const LIST_POLL_MS = 2000;
const LIST_CHANGED = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`;

// Whether serve declares tools.listChanged: when the inventory holds an mcp target, or cannot be read (then every tool
// is listed, and it may hold one). A user without an mcp target gets the initialize answer of before, and no poll runs.
function watchesTools(env) {
  try {
    return mayHaveMcp(inventoryForTools(env));
  } catch {
    return false;
  }
}

// What serve keeps to tell its client that the tool list changed. declare, at initialize, says whether listChanged is
// declared; start, at notifications/initialized, starts the poll when it was, once; gave keeps the list of each
// tools/list answer; stop ends the poll. Each tick compares toolsStamp first and computes the list again only when it
// changed; it writes notifications/tools/list_changed only when that list differs from the last one given or
// announced, and only once a list was given. A tick never throws; it says whether it wrote.
export function listWatch(env, write) {
  let declared = false;
  let timer = null;
  let given = null;
  let stamp = null;
  let pid = null;
  const tick = () => {
    try {
      const dir = sessionDir(env);
      if (toolsStamp(dir, pid) === stamp) return false;
      pid = readSession(dir)?.pid ?? null;
      stamp = toolsStamp(dir, pid);
      const now = JSON.stringify(listedTools(env));
      if (given === null || now === given) return false;
      given = now;
      write(LIST_CHANGED);
      return true;
    } catch {
      return false;
    }
  };
  return {
    declare() {
      declared = watchesTools(env);
      return declared;
    },
    start(everyMs) {
      if (!declared || timer !== null) return;
      timer = setInterval(tick, everyMs);
      timer.unref();
    },
    gave(tools) {
      given = JSON.stringify(tools);
    },
    tick,
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

// origin is { from, client } for a message that came over the network, and is passed on to callTool for its audit
// entries; signal is the AbortSignal of the network listener, which ends a program that a call runs here. ksproxy mcp
// gives neither. listChanged true declares tools.listChanged at initialize: only serve gives it, never the listener,
// which cannot push a notification.
export async function handleMessage(message, env = process.env, { origin, signal, listChanged = false } = {}) {
  const isObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  if (isObject && message.method === undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    return null;
  }
  if (!isObject || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return failure(validId(message?.id) ? message.id : null, -32600, 'Invalid Request');
  }
  if (Object.hasOwn(message, 'id') && !validId(message.id)) return failure(null, -32600, 'Invalid Request');
  if (!Object.hasOwn(message, 'id')) return null;
  const { id, method, params } = message;
  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return success(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : '2025-06-18',
          capabilities: { tools: listChanged ? { listChanged: true } : {} },
          serverInfo: SERVER_INFO,
          instructions: instructionsFor(env),
        });
      }
      case 'ping':
        return success(id, {});
      case 'tools/list':
        return success(id, { tools: listedTools(env) });
      case 'tools/call': {
        const args = params?.arguments;
        const okParams = params !== null && typeof params === 'object' && typeof params.name === 'string'
          && (args === undefined || (args !== null && typeof args === 'object' && !Array.isArray(args)));
        if (!okParams) return failure(id, -32602, 'Invalid params');
        const { text, isError } = await callTool(params.name, args ?? {}, env, { origin, signal });
        return success(id, { content: [{ type: 'text', text }], isError });
      }
      default:
        return failure(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return failure(id, -32603, `Internal error: ${err?.message ?? err}`);
  }
}

// One message on stdio: handleMessage, with tools.listChanged declared at initialize when watch.declare says so. The
// poll starts at the notification notifications/initialized, and the tools of each tools/list answer are what the
// client was given.
async function answerOnStdio(message, env, watch, pollMs) {
  const method = message?.method;
  const listChanged = method === 'initialize' && watch.declare();
  const response = await handleMessage(message, env, { listChanged });
  if (method === 'notifications/initialized' && response === null) watch.start(pollMs);
  if (method === 'tools/list' && response?.result !== undefined) watch.gave(response.result.tools);
  return response;
}

// pollMs: how often the poll runs, LIST_POLL_MS unless a test lowers it. The poll's timer does not keep the process
// alive, and it stops when the input ends.
export async function serve({
  input = process.stdin, output = process.stdout, env = process.env, pollMs = LIST_POLL_MS,
} = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const watch = listWatch(env, (text) => output.write(text));
  try {
    for await (const line of rl) {
      if (line.trim() === '') continue;
      let response;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        response = failure(null, -32700, 'Parse error');
      }
      if (response === undefined) response = await answerOnStdio(parsed, env, watch, pollMs);
      if (response !== null) output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    watch.stop();
  }
}
