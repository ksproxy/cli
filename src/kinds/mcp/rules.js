import {
  isRegexRule, matchRuleDetail, regexSource, ruleWarning,
} from '../../allowlist.js';
import { InventoryError, checkKeys, isObject } from '../../checks.js';
import { clip } from '../../text.js';

// The rules of an mcp target and its pinned arguments. A rule is a tool name, which allows that tool with any
// arguments, or { tool, arguments }, which also requires each named top-level argument to be present and to match: a
// JSON string, number or boolean that must be equal, "*" (present, any value), "\*" (the text *), or "regex(...)", which
// must match the whole text of the value (a string as it is, anything else as compact JSON with sorted keys). Arguments
// a rule does not name are free.

export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const ARGUMENT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'prototype'];
const MAX_NAMED = 50;
const MAX_VALUE_CHARS = 1000;
export const MAX_ARGUMENT_BYTES = 192 * 1024;
const REGEX_OPEN = 'regex(';
const LITERAL_STAR = '\\*';
const CALL_KEYS = ['tool', 'arguments'];
const MAX_ALLOWED_TEXT = 1000;

// A value as compact JSON with the keys of every object sorted, cut once it passes max characters: the text a regex
// value sees (which never matches past 1000 characters) and the audit keeps. Never throws, however deep the value.
export function sortedJson(value, max = MAX_VALUE_CHARS + 1) {
  let out = '';
  const write = (item) => {
    if (out.length > max) return;
    if (Array.isArray(item)) {
      out += '[';
      item.forEach((child, i) => {
        if (i > 0) out += ',';
        write(child);
      });
      out += ']';
    } else if (isObject(item)) {
      out += '{';
      Object.keys(item).sort().forEach((key, i) => {
        out += `${i > 0 ? ',' : ''}${JSON.stringify(key)}:`;
        write(item[key]);
      });
      out += '}';
    } else {
      out += JSON.stringify(item);
    }
  };
  write(value);
  return out.length > max ? out.slice(0, max) : out;
}

// The name of an argument in a rule or among the pinned arguments: never a name of the object prototype.
function checkArgumentName(name, at) {
  if (PROTOTYPE_KEYS.includes(name)) throw new InventoryError(`${at}: "${name}" is not an argument name ksproxy takes`);
  if (!ARGUMENT_NAME.test(name)) {
    throw new InventoryError(`${at}: ${JSON.stringify(clip(name, 64))} must be an argument name of letters, digits and _ . - (at most 64 characters)`);
  }
}

// One value of a rule: a string, a number or a boolean; a string that starts with regex( is a pattern that compiles.
function checkRuleValue(value, at) {
  if (typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value !== 'string' || value.length > MAX_VALUE_CHARS) {
    throw new InventoryError(`${at}: must be a string of at most ${MAX_VALUE_CHARS} characters, a number, true or false`);
  }
  if (!value.trim().startsWith(REGEX_OPEN)) return;
  if (!isRegexRule(value)) throw new InventoryError(`${at}: regex(...) must be the whole value`);
  const source = regexSource(value);
  if (source.trim() === '') throw new InventoryError(`${at}: the regex pattern is empty`);
  try {
    RegExp(source);
    RegExp(`^(?:${source})$`);
  } catch (err) {
    throw new InventoryError(`${at}: the regex does not compile: ${err.message}`);
  }
}

// The named arguments of a rule, or the pinned arguments of a target: at most MAX_NAMED, each name checked.
function checkNamed(value, at, checkValue) {
  if (!isObject(value) || Object.keys(value).length > MAX_NAMED) {
    throw new InventoryError(`${at}: must be an object of at most ${MAX_NAMED} arguments`);
  }
  for (const [name, item] of Object.entries(value)) {
    checkArgumentName(name, at);
    checkValue(item, `${at}.${name}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function checkRule(rule, at) {
  const toolProblem = `${at}: must be a tool name of letters, digits and _ . - (at most 128 characters), or {"tool": NAME, "arguments": {...}}`;
  if (typeof rule === 'string') {
    if (!TOOL_NAME.test(rule)) throw new InventoryError(toolProblem);
    return rule;
  }
  if (!isObject(rule)) throw new InventoryError(toolProblem);
  checkKeys(rule, CALL_KEYS, at);
  if (typeof rule.tool !== 'string' || !TOOL_NAME.test(rule.tool)) {
    throw new InventoryError(`${at}: tool: must be a tool name of letters, digits and _ . - (at most 128 characters)`);
  }
  const named = rule.arguments === undefined ? {} : checkNamed(rule.arguments, `${at}: arguments`, checkRuleValue);
  return { tool: rule.tool, arguments: named };
}

// The allow list of an inventory entry: a list of rules; "any" is refused, as for the command and SQL kinds.
export function checkMcpAllow(entry, where) {
  if (entry.allow === undefined) return [];
  if (entry.allow === 'any') throw new InventoryError(`${where}: allow: "any" is not supported for mcp targets; list the tools`);
  if (!Array.isArray(entry.allow)) {
    throw new InventoryError(`${where}: allow: must be a list of rules: a tool name, or {"tool": NAME, "arguments": {...}}`);
  }
  return entry.allow.map((rule, i) => checkRule(rule, `${where}: allow[${i}]`));
}

// The pinned arguments of a target: values that ksproxy adds to every call; a string, a number or a boolean.
export function checkPinned(value, where) {
  if (value === undefined) return {};
  return checkNamed(value, `${where}: arguments`, (item, at) => {
    if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'string' && item.length > MAX_VALUE_CHARS)) {
      throw new InventoryError(`${at}: must be a string of at most ${MAX_VALUE_CHARS} characters, a number, true or false`);
    }
  });
}

export const ruleTool = (rule) => (typeof rule === 'string' ? rule : rule.tool);
export const ruleArguments = (rule) => (typeof rule === 'string' ? {} : rule.arguments);

// A rule as one line: the tool, then its named arguments as compact JSON.
export function describeRule(rule) {
  const named = ruleArguments(rule);
  return Object.keys(named).length === 0 ? ruleTool(rule) : `${ruleTool(rule)} ${JSON.stringify(named)}`;
}

export function describeRules(allow) {
  return allow.length === 0 ? 'nothing (empty allowlist)' : clip(allow.map(describeRule).join('; '), MAX_ALLOWED_TEXT);
}

// The warnings of the regex values of the rules that can be very slow, as allowWarnings gives them for other kinds.
export function regexWarnings(allow) {
  return allow.flatMap((rule, i) => Object.entries(ruleArguments(rule)).flatMap(([name, value]) => {
    const warning = typeof value === 'string' ? ruleWarning(value) : null;
    return warning === null ? [] : [`allow[${i}].arguments.${name}: ${warning}`];
  }));
}

// Whether one value of the call matches what the rule asks of it.
function matchValue(present, actual, expected) {
  if (expected === '*') return present;
  if (!present) return false;
  if (expected === LITERAL_STAR) return actual === '*';
  if (isRegexRule(expected)) return matchRuleDetail([typeof actual === 'string' ? actual : sortedJson(actual)], expected) !== null;
  return actual === expected;
}

function matches(rule, tool, args) {
  if (ruleTool(rule) !== tool) return false;
  return Object.entries(ruleArguments(rule)).every(([name, expected]) => matchValue(Object.hasOwn(args, name), args[name], expected));
}

// The first rule that allows the tool with these arguments, or undefined. decideCall asks it with the pinned arguments
// added; perform asks it again with the arguments that are really sent.
export const allowingRule = (allow, tool, args) => allow.find((rule) => matches(rule, tool, args));

const refused = (reason, short) => ({ allowed: false, reason, short });

// The call as the tool gets it: { call: { tool, arguments } } or { refusal }. arguments may be left out.
export function readCall(input) {
  if (!isObject(input)) return { refusal: refused('the call must be an object with tool and arguments', 'invalid call') };
  const extra = Object.keys(input).find((key) => !CALL_KEYS.includes(key));
  if (extra !== undefined) {
    return { refusal: refused(`the call has the unknown field ${JSON.stringify(clip(extra, 64))}; give tool and arguments`, 'invalid call') };
  }
  if (typeof input.tool !== 'string' || !TOOL_NAME.test(input.tool)) {
    return { refusal: refused('tool must be the name of a tool of this MCP server: letters, digits and _ . -', 'invalid tool name') };
  }
  const args = input.arguments ?? {};
  if (!isObject(args)) return { refusal: refused('arguments must be a JSON object', 'invalid arguments') };
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    return { refusal: refused('the arguments cannot be written as JSON', 'invalid arguments') };
  }
  if (Buffer.byteLength(text) > MAX_ARGUMENT_BYTES) {
    return { refusal: refused(`the arguments are larger than ${MAX_ARGUMENT_BYTES} bytes of JSON`, 'arguments too large') };
  }
  return { call: { tool: input.tool, arguments: args } };
}

// The decision on one call: the call read, a pinned argument the call gives another value refused, then the first rule
// that allows the tool with the arguments, the pinned ones added. No rule: refused, and never sent to the server.
export function decideCall(target, input) {
  const read = readCall(input);
  if (read.refusal !== undefined) return read.refusal;
  const { tool, arguments: given } = read.call;
  const pinned = target.arguments ?? {};
  const differs = Object.keys(pinned).find((name) => Object.hasOwn(given, name) && given[name] !== pinned[name]);
  if (differs !== undefined) {
    return refused(`the argument ${differs} is fixed to ${JSON.stringify(pinned[differs])} for this target; leave it out`, 'fixed argument differs');
  }
  const args = { ...given, ...pinned };
  if (target.allow.length === 0) return refused('the allowlist for this target is empty, so every call is refused', 'allowlist is empty');
  const rule = allowingRule(target.allow, tool, args);
  if (rule !== undefined) return { allowed: true, rule: describeRule(rule) };
  const named = target.allow.some((r) => ruleTool(r) === tool);
  return refused(
    `no rule allows ${tool}${named ? ' with these arguments' : ''}. Allowed: ${describeRules(target.allow)}`,
    'not on allowlist',
  );
}
