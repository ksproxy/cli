import { hideSecrets } from '../engines/http.js';
import { shownText } from '../engines/mcp-client.js';
import { isObject } from '../../checks.js';
import { ruleArguments, ruleTool } from './rules.js';

// What an mcp target gives the agent's tool list, and the file mcp-tools.json that ksproxy mcp reads it from. Only a
// tool a rule names is exported, and only when its definition is safe for the agent's API: a name of letters, digits,
// _ and -, the whole TARGET__TOOL at most MAX_NAME characters, an input schema that is an object at the top and holds
// no oneOf, anyOf or allOf there, at most MAX_SCHEMA_BYTES and MAX_DEPTH levels, and no hidden character in a key or in
// a value the server checks. Never outputSchema or annotations. Descriptions and titles lose their hidden characters,
// and a description is clipped; pinned arguments leave the schema; every secret value of the target is hidden in every
// text, before it is cleaned or clipped. Anything else is not exported, with a warning.

export const MAX_EXPORTED = 200;
export const MAX_NAME = 50;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_DESCRIPTION = 1000;
export const SESSION_BUDGET = 1024 * 1024;
export const TOOLS_FILE = 'mcp-tools.json';
const MAX_DEPTH = 64;
const EXPORT_NAME = /^[A-Za-z0-9_-]+$/;
const TOP_COMBINERS = ['oneOf', 'anyOf', 'allOf'];
const TEXT_KEYS = ['description', 'title'];
// The hidden characters, the one set both for cleaning and for refusing: control characters but the newline and the
// tab, format characters (direction marks, Unicode tags, zero-width marks), lone surrogates, the line and paragraph
// separators, and the variation selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF.
const HIDDEN_CHARS = /(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
const HIDDEN_REASON = 'its input schema holds a hidden character (a control, format or variation selector character) in a key or in a value other than a description or a title';
const DUPLICATE = Symbol('listed twice');

const cleaned = (text) => text.replace(/\t/g, ' ').replace(HIDDEN_CHARS, '');
const holdsHidden = (text) => text.search(HIDDEN_CHARS) !== -1;

// A text of the server as the agent may see it: every secret hidden, then tabs as spaces and the hidden characters
// removed, then every secret hidden again, as removing a character can join the pieces of one.
export function cleanText(text, hidden) {
  return hideSecrets(cleaned(hideSecrets(text, hidden)), hidden);
}

// Whether a value holds more than limit levels of objects and arrays, found without recursion.
function tooDeep(value, limit) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [item, depth] = stack.pop();
    if (item !== null && typeof item === 'object') {
      if (depth > limit) return true;
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
    }
  }
  return false;
}

// Whether a schema holds a hidden character in a key, or in a text that is not the value of a description or a title,
// found without recursion. Such a character cannot be removed, as the server checks the value, so the tool stays out.
function schemaHidesText(schema) {
  const stack = [[schema, false]];
  while (stack.length > 0) {
    const [item, isText] = stack.pop();
    if (typeof item === 'string') {
      if (!isText && holdsHidden(item)) return true;
    } else if (item !== null && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (holdsHidden(key)) return true;
        stack.push([child, TEXT_KEYS.includes(key)]);
      }
    }
  }
  return false;
}

// A copy of a schema value with every key and text hidden, and description and title texts cleaned. Object.fromEntries
// makes a key such as __proto__ an ordinary key.
function copySchema(value, hidden) {
  if (Array.isArray(value)) return value.map((item) => copySchema(item, hidden));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      hideSecrets(key, hidden),
      TEXT_KEYS.includes(key) && typeof item === 'string' ? cleanText(item, hidden) : copySchema(item, hidden),
    ]));
  }
  return typeof value === 'string' ? hideSecrets(value, hidden) : value;
}

// The schema the agent sees: pinned arguments out of properties and required, then the copy of copySchema.
function agentSchema(schema, pinned) {
  const names = Object.keys(pinned);
  const out = { ...schema };
  if (isObject(schema.properties)) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !names.includes(name)));
  }
  if (Array.isArray(schema.required)) out.required = schema.required.filter((name) => !names.includes(name));
  return out;
}

// The definition of one listed tool for the agent, or { reason } why it is not exported.
function definitionOf(target, tool, hidden) {
  const full = `${target.name}__${tool.name}`;
  if (!EXPORT_NAME.test(tool.name)) return { reason: 'its name holds characters other than letters, digits, _ and -' };
  if (full.length > MAX_NAME) return { reason: `${full} is longer than ${MAX_NAME} characters` };
  const schema = tool.inputSchema;
  if (!isObject(schema) || schema.type !== 'object') return { reason: 'its input schema does not have type "object" at the top' };
  if (TOP_COMBINERS.some((key) => Object.hasOwn(schema, key))) return { reason: 'its input schema has oneOf, anyOf or allOf at the top' };
  if (tooDeep(schema, MAX_DEPTH)) return { reason: `its input schema is nested more than ${MAX_DEPTH} levels deep` };
  if (schemaHidesText(schema)) return { reason: HIDDEN_REASON };
  const inputSchema = copySchema(agentSchema(schema, target.arguments), hidden);
  if (Buffer.byteLength(JSON.stringify(inputSchema)) > MAX_SCHEMA_BYTES) return { reason: `its input schema is larger than ${MAX_SCHEMA_BYTES / 1024} KiB` };
  const description = shownText(typeof tool.description === 'string' ? tool.description : '', { hidden, max: MAX_DESCRIPTION, clean: cleaned });
  return {
    definition: {
      name: full,
      description: `[from the MCP server "${target.name}"] ${description}`.trimEnd(),
      inputSchema,
    },
  };
}

// The listed tools by name: a tool listed twice is DUPLICATE; an entry that is not an object with a text name is left
// out. Each kept tool has properties, the names of the top-level properties of its schema, or null when it has none.
export function indexTools(tools) {
  const byName = new Map();
  for (const tool of tools) {
    if (!isObject(tool) || typeof tool.name !== 'string') continue;
    const schema = tool.inputSchema;
    const properties = isObject(schema) && isObject(schema.properties) ? new Set(Object.keys(schema.properties)) : null;
    byName.set(tool.name, byName.has(tool.name) ? DUPLICATE : { tool, properties });
  }
  return byName;
}

export const isDuplicate = (entry) => entry === DUPLICATE;

// What a target exports, from its rules and the tools its server listed: { exported: [{ tool, definition }], notes }.
// The tools are taken in the order the rules first name them, at most MAX_EXPORTED. hidden: the secret texts.
export function exportTools(target, byName, hidden) {
  const notes = [];
  const exported = [];
  const seen = new Set();
  let over = 0;
  target.allow.forEach((rule, i) => {
    const name = ruleTool(rule);
    const listed = byName.get(name);
    if (listed === undefined) {
      notes.push(`allow[${i}]: the MCP server does not list the tool ${name}`);
      return;
    }
    if (listed !== DUPLICATE && listed.properties !== null) {
      for (const argument of Object.keys(ruleArguments(rule)).filter((a) => !listed.properties.has(a))) {
        notes.push(`allow[${i}]: the tool ${name} declares no argument ${argument}`);
      }
    }
    if (seen.has(name)) return;
    seen.add(name);
    if (listed === DUPLICATE) {
      notes.push(`tool ${name} is not exported: the MCP server lists it more than once`);
      return;
    }
    const made = definitionOf(target, listed.tool, hidden);
    if (made.reason !== undefined) {
      notes.push(`tool ${name} is not exported: ${made.reason}`);
    } else if (exported.length === MAX_EXPORTED) {
      over += 1;
    } else {
      exported.push({ tool: name, definition: made.definition });
    }
  });
  if (over > 0) notes.push(`${over} more tools that the rules name are not exported: a target exports at most ${MAX_EXPORTED}`);
  return { exported, notes };
}

// The text of mcp-tools.json for the opened targets, in list order: the session's pid and start time, then each
// exported tool with its target, its server name, the target's time limit and its definition, within SESSION_BUDGET
// bytes of definitions. The first definition that does not fit ends the list; each target that lost tools is told
// through cut(entry, count). Gives null when no target is open.
export function toolsFileText(entries, { pid, processStartedAt }, cut) {
  if (entries.length === 0) return null;
  const tools = [];
  let used = 0;
  let full = false;
  for (const entry of entries) {
    const { exported } = entry.live;
    let kept = 0;
    for (const item of exported) {
      used += Buffer.byteLength(JSON.stringify(item.definition));
      if (full || used > SESSION_BUDGET) {
        full = true;
        break;
      }
      tools.push({
        target: entry.target.name, tool: item.tool, timeoutSeconds: entry.target.timeoutSeconds, definition: item.definition,
      });
      kept += 1;
    }
    if (kept < exported.length) cut(entry, exported.length - kept);
  }
  return `${JSON.stringify({
    version: 1, pid, processStartedAt, tools,
  })}\n`;
}
