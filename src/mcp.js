import fs from 'node:fs';
import readline from 'node:readline';
import { loadInventory } from './inventory.js';
import { inventoryPath, startCommand } from './paths.js';
import { callTool, toolDefinitions } from './tools.js';

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

function validId(id) {
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

// origin is { from, client } for a message that came over the network, and is passed on to callTool for its audit
// entries; signal is the AbortSignal of the network listener, which ends a program that a call runs here. ksproxy mcp
// gives neither.
export async function handleMessage(message, env = process.env, { origin, signal } = {}) {
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
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: instructionsFor(env),
        });
      }
      case 'ping':
        return success(id, {});
      case 'tools/list':
        return success(id, { tools: toolDefinitions(inventoryForTools(env)) });
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

export async function serve({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let response;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      response = failure(null, -32700, 'Parse error');
    }
    if (response === undefined) response = await handleMessage(parsed, env);
    if (response !== null) output.write(`${JSON.stringify(response)}\n`);
  }
}
