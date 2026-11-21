import vm from 'node:vm';
import { clip } from './text.js';

export class AllowError extends Error {
  constructor(message, short) {
    super(message);
    this.short = short;
  }
}

const MAX_BYTES = 4096;
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const UNSAFE_CHAR = /[^A-Za-z0-9_@%+=:,./-]/;

const REGEX_OPEN = 'regex(';
const MAX_REGEX_INPUT = 1000;
const LITERAL_STAR = '\\*';
const SLOW_PATTERN = 'this pattern can be very slow on some inputs';
const COUNTED = /^\{\d+(?:,\d*)?\}/;
const MATCH_TIME_MS = 100;
const TOO_SLOW_SHORT = 'regex rule too slow';
const REPEAT = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/;
const UNBOUNDED = /^(?:[*+]|\{\d+,\})/;
const GROUP_OPEN = /^\((?:\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>))?/;
const PROBES = [...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)), '\u00e9', '\u00a0'];

// A regex match runs in this context under a time limit, so that a slow pattern cannot hang the process that decides.
const matchContext = vm.createContext({ re: null, text: '' });
const matchScript = new vm.Script('re.test(text)');
// The regex rules that ran out of time while decide is matching, or null outside decide.
let slowRules = null;

function ruleTokens(rule) {
  return rule.trim().split(/\s+/).filter(Boolean);
}

export function isRegexRule(rule) {
  if (typeof rule !== 'string') return false;
  const trimmed = rule.trim();
  return trimmed.startsWith(REGEX_OPEN) && trimmed.endsWith(')');
}

export function regexSource(rule) {
  return rule.trim().slice(REGEX_OPEN.length, -1);
}

// The pattern must compile on its own as well, so that it cannot close the group it is wrapped in.
function compileRegexRule(rule) {
  const source = regexSource(rule);
  RegExp(source);
  return RegExp(`^(?:${source})$`);
}

export function validateRule(rule) {
  if (typeof rule !== 'string') throw new Error('rule must be a string');
  const trimmed = rule.trim();
  if (trimmed.startsWith(REGEX_OPEN) ? !trimmed.endsWith(')') : trimmed.includes(REGEX_OPEN)) {
    throw new Error('regex(...) must be the whole rule');
  }
  if (isRegexRule(trimmed)) {
    if (regexSource(trimmed).trim() === '') throw new Error('regex pattern is empty');
    try {
      compileRegexRule(trimmed);
    } catch (err) {
      throw new Error(`regex does not compile: ${err.message}`);
    }
    return;
  }
  const tokens = ruleTokens(rule);
  if (tokens.length === 0) throw new Error('rule is empty');
  const rest = tokens.indexOf('...');
  if (rest !== -1 && rest !== tokens.length - 1) {
    throw new Error(`"..." is only allowed as the last token: ${rule}`);
  }
}

function matchRegexRule(args, rule) {
  const joined = args.join(' ');
  if (joined.length > MAX_REGEX_INPUT) return null;
  let pattern;
  try {
    pattern = compileRegexRule(rule);
  } catch {
    return null;
  }
  if (!testWithin(pattern, joined, rule)) return null;
  return { star: [], rest: [], regex: true };
}

// Whether the pattern matches the text. A match that takes longer than MATCH_TIME_MS, or throws, does not match,
// and the rule is noted for the refusal of decide.
function testWithin(pattern, text, rule) {
  matchContext.re = pattern;
  matchContext.text = text;
  let matched = false;
  try {
    matched = matchScript.runInContext(matchContext, { timeout: MATCH_TIME_MS }) === true;
  } catch {
    slowRules?.push(rule);
  }
  matchContext.re = null;
  matchContext.text = '';
  return matched;
}

export function matchRuleDetail(args, rule) {
  if (isRegexRule(rule)) return matchRegexRule(args, rule);
  return matchWords(args, ruleTokens(rule));
}

// A word rule already split into its words, for a kind that splits its rules its own way (SQL).
export function matchWords(args, tokens) {
  const open = tokens[tokens.length - 1] === '...';
  const fixed = open ? tokens.slice(0, -1) : tokens;
  if (open ? args.length < fixed.length : args.length !== fixed.length) return null;
  const star = [];
  for (let i = 0; i < fixed.length; i += 1) {
    if (fixed[i] === '*') {
      if (args[i].startsWith('-')) return null;
      star.push(args[i]);
    } else if (fixed[i] === LITERAL_STAR) {
      if (args[i] !== '*') return null;
    } else if (args[i] !== fixed[i]) {
      return null;
    }
  }
  return { star, rest: open ? args.slice(fixed.length) : [] };
}

// Length of the repeat that starts at source[i], or 0 when there is none.
function repeatAt(source, i) {
  if ('*+?'.includes(source[i])) return 1;
  const counted = COUNTED.exec(source.slice(i));
  return counted === null ? 0 : counted[0].length;
}

// Scans a pattern for a backreference, or a repeat applied to a group that holds a repeat or "|".
function slowPattern(source) {
  const groups = [{ risky: false }];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const top = groups[groups.length - 1];
    if (ch === '\\') {
      const next = source[i + 1];
      if ((next >= '1' && next <= '9') || (next === 'k' && source[i + 2] === '<')) return true;
      i += 2;
    } else if (ch === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '(') {
      groups.push({ risky: false });
      i += source[i + 1] === '?' ? 2 : 1;
    } else if (ch === ')' && groups.length > 1) {
      groups.pop();
      const parent = groups[groups.length - 1];
      const repeat = repeatAt(source, i + 1);
      if (repeat > 0 && top.risky) return true;
      parent.risky ||= top.risky || repeat > 0;
      i += 1 + repeat;
    } else {
      const repeat = repeatAt(source, i);
      if (repeat > 0 || ch === '|') top.risky = true;
      i += Math.max(repeat, 1);
    }
  }
  return false;
}

// The items of a pattern in order: an atom (one character, an escape, a class or a dot) and whether a repeat without
// an upper bound follows it. A group, "|", "^", "$" or a repeat after a group is null and ends a run of items.
function patternItems(source) {
  const items = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const marker = GROUP_OPEN.exec(rest)?.[0] ?? (')|^$'.includes(source[i]) ? source[i] : REPEAT.exec(rest)?.[0]);
    if (marker !== undefined) {
      items.push(null);
      i += marker.length;
      continue;
    }
    let end = source[i] === '\\' ? i + 2 : i + 1;
    if (source[i] === '[') {
      while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
      end += 1;
    }
    const repeat = REPEAT.exec(source.slice(end))?.[0] ?? '';
    items.push({ atom: source.slice(i, end), unbounded: UNBOUNDED.test(repeat) });
    i = end + repeat.length;
  }
  return items;
}

// Whether two atoms can match the same character, tried on every ASCII character and two others.
function overlap(a, b) {
  const first = RegExp(`^${a}$`);
  const second = RegExp(`^${b}$`);
  return PROBES.some((ch) => first.test(ch) && second.test(ch));
}

// Two atoms in a row, each repeated without an upper bound, that can match the same character, such as .*.* or \S*\S*.
function adjacentRepeats(source) {
  const items = patternItems(source);
  return items.some((item, i) => i > 0 && item?.unbounded === true && items[i - 1]?.unbounded === true
    && overlap(items[i - 1].atom, item.atom));
}

function compiles(source) {
  try {
    RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export function ruleWarning(rule) {
  if (!isRegexRule(rule)) return null;
  const source = regexSource(rule);
  return slowPattern(source) || (compiles(source) && adjacentRepeats(source)) ? SLOW_PATTERN : null;
}

export function allowWarnings(allow) {
  if (!Array.isArray(allow)) return [];
  return allow.flatMap((rule, i) => {
    const warning = ruleWarning(rule);
    return warning === null ? [] : [`allow[${i}]: ${warning}`];
  });
}

export function matchRule(args, rule) {
  return matchRuleDetail(args, rule) !== null;
}

function describeChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x20 || code === 0x7f || code > 0x7e) {
    return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `"${ch}"`;
}

export function tokenizeSshCommand(command) {
  if (typeof command !== 'string') throw new AllowError('command must be a string', 'invalid command');
  if (Buffer.byteLength(command) > MAX_BYTES) {
    throw new AllowError(`command is longer than ${MAX_BYTES} bytes`, 'command too long');
  }
  const tokens = command.split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0) throw new AllowError('command is empty', 'empty command');
  for (const token of tokens) {
    if (!SAFE_TOKEN.test(token)) {
      const ch = [...token].find((c) => UNSAFE_CHAR.test(c));
      throw new AllowError(
        `character ${describeChar(ch)} is not allowed: this target only accepts plain commands ` +
        'made of letters, digits and _ @ % + = : , . / - (no quotes, pipes, redirects or shell syntax)',
        `character ${describeChar(ch)} not allowed`);
    }
  }
  if (tokens[0].startsWith('-')) throw new AllowError('command may not start with "-"', 'starts with "-"');
  return tokens;
}

export function checkRawSshCommand(command) {
  if (typeof command !== 'string') throw new AllowError('command must be a string', 'invalid command');
  if (Buffer.byteLength(command) > MAX_BYTES) {
    throw new AllowError(`command is longer than ${MAX_BYTES} bytes`, 'command too long');
  }
  if (command.trim() === '') throw new AllowError('command is empty', 'empty command');
  if (command.includes('\u0000')) throw new AllowError('command contains a NUL byte', 'control character');
  if (/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/.test(command)) {
    throw new AllowError('command contains a control character', 'control character');
  }
  if (command.trimStart().startsWith('-')) throw new AllowError('command may not start with "-"', 'starts with "-"');
  return command;
}

export function describeAllow(allow) {
  if (allow === 'any') return 'any command';
  if (allow.length === 0) return 'nothing (empty allowlist)';
  return allow.join('; ');
}

// match(args, rule) says whether one rule matches; a kind whose words need their own matching passes its own.
export function decide(args, allow, match = matchRule) {
  if (allow === 'any') return { allowed: true, rule: 'any' };
  const slow = [];
  slowRules = slow;
  let rule;
  try {
    rule = allow.find((r) => match(args, r));
  } finally {
    slowRules = null;
  }
  if (rule !== undefined) return { allowed: true, rule };
  if (slow.length > 0) {
    return {
      allowed: false,
      reason: `not on the allowlist for this target. Allowed: ${describeAllow(allow)}. The rule ${clip(slow[0], 64)} took longer than ${MATCH_TIME_MS} ms on this command, so it was treated as not matching`,
      short: TOO_SLOW_SHORT,
      unmatched: true,
    };
  }
  if (allow.length === 0) {
    return {
      allowed: false,
      reason: 'the allowlist for this target is empty, so every command is refused',
      short: 'allowlist is empty',
      unmatched: true,
    };
  }
  return {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${describeAllow(allow)}`,
    short: 'not on allowlist',
    unmatched: true,
  };
}
