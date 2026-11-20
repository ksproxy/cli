export class AllowError extends Error {
  constructor(message, short) {
    super(message);
    this.short = short;
  }
}

const MAX_BYTES = 4096;
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const UNSAFE_CHAR = /[^A-Za-z0-9_@%+=:,./-]/;

function ruleTokens(rule) {
  return rule.trim().split(/\s+/).filter(Boolean);
}

export function validateRule(rule) {
  if (typeof rule !== 'string') throw new Error('rule must be a string');
  const tokens = ruleTokens(rule);
  if (tokens.length === 0) throw new Error('rule is empty');
  const rest = tokens.indexOf('...');
  if (rest !== -1 && rest !== tokens.length - 1) {
    throw new Error(`"..." is only allowed as the last token: ${rule}`);
  }
}

export function matchRuleDetail(args, rule) {
  const tokens = ruleTokens(rule);
  const open = tokens[tokens.length - 1] === '...';
  const fixed = open ? tokens.slice(0, -1) : tokens;
  if (open ? args.length < fixed.length : args.length !== fixed.length) return null;
  const star = [];
  for (let i = 0; i < fixed.length; i += 1) {
    if (fixed[i] === '*') {
      if (args[i].startsWith('-')) return null;
      star.push(args[i]);
    } else if (args[i] !== fixed[i]) {
      return null;
    }
  }
  return { star, rest: open ? args.slice(fixed.length) : [] };
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

export function decide(args, allow) {
  if (allow === 'any') return { allowed: true, rule: 'any' };
  const rule = allow.find((r) => matchRule(args, r));
  if (rule !== undefined) return { allowed: true, rule };
  if (allow.length === 0) {
    return {
      allowed: false,
      reason: 'the allowlist for this target is empty, so every command is refused',
      short: 'allowlist is empty',
    };
  }
  return {
    allowed: false,
    reason: `not on the allowlist for this target. Allowed: ${describeAllow(allow)}`,
    short: 'not on allowlist',
  };
}
