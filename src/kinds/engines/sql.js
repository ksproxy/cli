import {
  AllowError, isRegexRule, matchRuleDetail, regexSource, ruleWarning,
} from '../../allowlist.js';

// The SQL reader: one statement of plain SQL turned into words, or an AllowError for what it cannot judge.
// dialect is 'postgres' or 'mysql'; it decides the quotes, the comments and the client words.

export const MAX_STATEMENT_BYTES = 16384;
export const STAR_WARNING = '"*" matches one value here (a number or a quoted string); write \\* for the SQL star';
export const NAME_HOLE_WARNING = '"*" after FROM, JOIN, INTO, UPDATE, TABLE or DESCRIBE matches one value, never a name, so this rule can never match; write the name, or use a regex(...) rule';
// The words after which only a name can stand.
const NAME_PLACES = ['from', 'join', 'into', 'update', 'table', 'describe'];
export const WIDE_WARNING = 'this pattern can match more than one word: a part that can match a quote, or a space and other characters (".", "\\S", "\\W", "[\\s\\S]", "[a-z ]" or a group holding one), repeated with no upper bound ("*", "+", "{n,}"), and a "[^...]" class that does not leave out \', also match spaces and quotes, so \'.*\' can match a string and the SQL after it; write \'[^\']*\' for one quoted string';
export const LITERAL_STAR = '\\*';
export const REST = '...';

const WORD_CHAR = /[A-Za-z0-9_]/;
const SPACES = [' ', '\t', '\n', '\r'];
const PUNCTUATION = [...'(),.=<>+-*/%!|&^~:;[]{}?@#'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const QUOTES = { postgres: ["'", '"'], mysql: ["'", '"', '`'] };
const NAME_QUOTES = ['"', '`'];
// Words the mysql client takes as its own command when they start a statement.
const MYSQL_CLIENT_WORDS = [
  'system', 'source', 'delimiter', 'tee', 'notee', 'pager', 'nopager', 'edit', 'use', 'connect', 'charset', 'warnings',
  'nowarning', 'prompt', 'rehash', 'status', 'help', 'quit', 'exit', 'go', 'ego', 'print', 'resetconnection',
  'query_attributes', 'ssl_session_data_print', 'clear', '?',
];

function describeChar(ch) {
  const code = ch.codePointAt(0);
  if (code > 0x7e) return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return `"${ch}"`;
}

const BACKSLASH_WHY = {
  postgres: 'postgres reads it as an escape when standard_conforming_strings is off',
  mysql: 'mysql reads it as an escape',
};

// The end of the quoted text that starts at i: a doubled quote is the only escape; a backslash inside is refused.
function quotedEnd(text, i, dialect) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === quote) {
      if (text[j + 1] !== quote) return j + 1;
      j += 2;
    } else {
      if (text[j] === '\\') {
        throw new AllowError(`a backslash inside a quoted text is not allowed: ${BACKSLASH_WHY[dialect]}`, 'backslash');
      }
      j += 1;
    }
  }
  throw new AllowError(`the quote ${quote} is not closed`, 'unterminated quote');
}

// A word that touches a quote is a prefixed string: E'..', U&'..', B'..', X'..', N'..', _utf8'..'.
function checkPrefix(text, word, j, dialect) {
  const next = text[j];
  if (QUOTES[dialect].includes(next)) {
    if (dialect === 'postgres' && word === 'e' && next === "'") {
      throw new AllowError('an escape string (E\'...\') is not allowed: write a plain quoted string', 'escape string');
    }
    throw new AllowError(`a prefixed string (${word}${next}...) is not allowed: write a plain quoted string`, 'prefixed string');
  }
  if (dialect === 'postgres' && word === 'u' && next === '&' && QUOTES.postgres.includes(text[j + 1])) {
    throw new AllowError('a unicode escape string (U&\'...\') is not allowed: write a plain quoted string', 'prefixed string');
  }
}

function refuseComment(dialect, versioned) {
  if (versioned) {
    throw new AllowError('a comment is not allowed; mysql runs the text of a /*! comment as SQL', 'comment');
  }
  throw new AllowError(`a comment is not allowed in a ${dialect} statement`, 'comment');
}

// The words of text. rule is true for a rule of the allow list, where \* and ... are rule words.
function scan(text, dialect, rule) {
  const words = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (SPACES.includes(ch)) {
      i += 1;
    } else if (QUOTES[dialect].includes(ch)) {
      const end = quotedEnd(text, i, dialect);
      words.push(text.slice(i, end));
      i = end;
    } else if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < text.length && WORD_CHAR.test(text[j])) j += 1;
      const word = text.slice(i, j).toLowerCase();
      checkPrefix(text, word, j, dialect);
      words.push(word);
      i = j;
    } else if (ch === '\\') {
      if (!rule || next !== '*') {
        throw new AllowError('a backslash is not allowed outside a quoted string: the database client reads it as its own command', 'backslash');
      }
      words.push(LITERAL_STAR);
      i += 2;
    } else if (ch === '$') {
      if (dialect === 'postgres' && DOLLAR_QUOTE.test(text.slice(i))) {
        throw new AllowError('dollar-quoted text is not allowed: write a plain quoted string', 'dollar quote');
      }
      throw new AllowError('"$" is not allowed outside a quoted string', 'dollar sign');
    } else if ((ch === '-' && next === '-') || (ch === '/' && next === '*') || (ch === '#' && dialect === 'mysql')) {
      refuseComment(dialect, ch === '/' && dialect === 'mysql' && text[i + 2] === '!');
    } else if (rule && text.startsWith(REST, i)) {
      words.push(REST);
      i += REST.length;
    } else if (PUNCTUATION.includes(ch)) {
      words.push(ch);
      i += 1;
    } else {
      throw new AllowError(`character ${describeChar(ch)} is not allowed outside a quoted text`, 'character not allowed');
    }
  }
  return words;
}

// The checks on the whole text, the words, then: a ";" only as the very last word, which is dropped; not empty.
function readWords(text, dialect, rule) {
  if (typeof text !== 'string') throw new AllowError('the statement must be a string', 'invalid statement');
  if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) {
    throw new AllowError(`the statement is longer than ${MAX_STATEMENT_BYTES} bytes`, 'statement too long');
  }
  if (CONTROL.test(text)) throw new AllowError('the statement contains a control character', 'control character');
  const words = scan(text, dialect, rule);
  const semicolon = words.indexOf(';');
  if (semicolon !== -1 && semicolon !== words.length - 1) {
    throw new AllowError('only one statement is allowed: ";" may only end it', 'more than one statement');
  }
  if (semicolon !== -1) words.pop();
  if (words.length === 0) throw new AllowError('the statement is empty', 'empty statement');
  return words;
}

// The words of one statement: unquoted words lower-cased, a quoted string or name one word as written, each
// punctuation mark one word. Throws AllowError for what the reader refuses.
export function readStatement(text, dialect) {
  const words = readWords(text, dialect, false);
  if (dialect === 'mysql' && MYSQL_CLIENT_WORDS.includes(words[0])) {
    throw new AllowError(`"${words[0]}" is a command of the mysql client, not SQL`, 'client command');
  }
  return words;
}

// A word rule split by the same reader: * is one word, \* the SQL star, ... the rest, only as the last word.
export function splitRule(rule, dialect) {
  const words = readWords(rule, dialect, true);
  const rest = words.indexOf(REST);
  if (rest !== -1 && rest !== words.length - 1) {
    throw new AllowError('"..." is only allowed as the last word', 'rest not last');
  }
  return words;
}

// A bare * rule word right after select or "(" is almost always meant as \*.
export function starWarning(ruleWords) {
  return ruleWords.some((word, i) => word === '*' && (ruleWords[i - 1] === 'select' || ruleWords[i - 1] === '('));
}

const DIGITS = /^[0-9]+$/;
const SIGNS = ['-', '+'];
const CLOSERS = [')', ']', '}'];

// Whether a sign at words[at] may start a number: at the start, or after a punctuation mark that is not a closing
// bracket. After a name, a value, a string or a closing bracket it is the operator: "a - 1" is never "a" and "-1".
function signStarts(words, at) {
  const before = words[at - 1];
  return before === undefined || (PUNCTUATION.includes(before) && !CLOSERS.includes(before));
}

// How many words of the statement one value takes from at: a single-quoted string is 1; a number is an optional sign
// (see signStarts), digits, and an optional "." with digits, 1 to 4 words, the longest that fits. 0 when no value
// starts there: a name, a keyword, a quoted name, a punctuation mark, a word such as 1e5 or 0x1f.
export function valueLength(words, at) {
  const word = words[at];
  if (word === undefined) return 0;
  if (word.startsWith("'")) return 1;
  let next = at;
  if (SIGNS.includes(word)) {
    if (!signStarts(words, at)) return 0;
    next += 1;
  }
  if (!DIGITS.test(words[next] ?? '')) return 0;
  next += 1;
  if (words[next] === '.' && DIGITS.test(words[next + 1] ?? '')) next += 2;
  return next - at;
}

// A word rule against the words of a statement: each * takes one value (valueLength, the longest number, never
// tried shorter), \* the SQL star, any other rule word that word; ... at the end takes the rest, and without it
// nothing may be left over.
export function matchSqlWords(words, ruleWords) {
  const open = ruleWords[ruleWords.length - 1] === REST;
  const fixed = open ? ruleWords.slice(0, -1) : ruleWords;
  let at = 0;
  for (const ruleWord of fixed) {
    if (ruleWord === '*') {
      const size = valueLength(words, at);
      if (size === 0) return false;
      at += size;
    } else {
      if (words[at] !== (ruleWord === LITERAL_STAR ? '*' : ruleWord)) return false;
      at += 1;
    }
  }
  return open || at === words.length;
}

// One rule against the words of a statement: a regex rule on the words joined by single spaces, a word rule by
// matchSqlWords, where * is one value.
export function matchStatementRule(words, rule, dialect) {
  if (isRegexRule(rule)) return matchRuleDetail(words, rule) !== null;
  return matchSqlWords(words, splitRule(rule, dialect));
}

// The warnings of an allow list of a SQL kind, by index: a slow pattern, a pattern that can match more than one
// word, a bare star, or a hole where only a name can stand.
export function sqlRuleWarnings(allow, dialect) {
  return allow.flatMap((rule, i) => sqlRuleWarning(rule, dialect).map((warning) => `allow[${i}]: ${warning}`));
}

// Whether a * hole stands right after a word of NAME_PLACES, where only a name can stand and a value never fits.
export function nameHole(ruleWords) {
  return ruleWords.some((word, i) => word === '*' && NAME_PLACES.includes(ruleWords[i - 1]));
}

function sqlRuleWarning(rule, dialect) {
  if (!isRegexRule(rule)) {
    const words = splitRule(rule, dialect);
    return [...(starWarning(words) ? [STAR_WARNING] : []), ...(nameHole(words) ? [NAME_HOLE_WARNING] : [])];
  }
  const slow = ruleWarning(rule);
  return [...(slow === null ? [] : [slow]), ...(widePattern(regexSource(rule)) ? [WIDE_WARNING] : [])];
}

// The index of the "]" that ends the character class opened at start, or the end of the source.
function classEnd(source, start) {
  let j = start + 1;
  while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
  return j;
}

// What a character class can match: a quote, a space, and something else. An escape \\S, \\W or \\D matches all three,
// \\s a space, \\d and \\w something else; a range a-b holds what lies between a and b.
function classReach(body) {
  const reach = { quote: false, space: false, other: false };
  const add = (low, high) => {
    if (low <= "'" && "'" <= high) reach.quote = true;
    if (low <= ' ' && ' ' <= high) reach.space = true;
    if (low !== high || (low !== ' ' && low !== "'")) reach.other = true;
  };
  let j = 0;
  const next = () => {
    if (body[j] !== '\\') return body[j++];
    j += 2;
    return body[j - 1];
  };
  while (j < body.length) {
    const escaped = body[j] === '\\';
    const low = next();
    if (escaped && 'SWD'.includes(low)) Object.assign(reach, { quote: true, space: true, other: true });
    else if (escaped && low === 's') reach.space = true;
    else if (escaped && 'dw'.includes(low)) reach.other = true;
    else if (body[j] === '-' && j + 1 < body.length) {
      j += 1;
      add(low, next());
    } else add(low, low);
  }
  return reach;
}

// Whether an atom that ends at end is repeated with no upper bound: "*", "+" or "{n,}".
function unbounded(source, end) {
  return source[end] === '*' || source[end] === '+' || /^\{\d*,\}/.test(source.slice(end));
}

// Whether a pattern can match across words of a statement: a negated class "[^...]" that does not hold a single quote,
// or a wide atom repeated with no upper bound. An atom is wide when it can match a quote, or a space and something
// else: ".", "\\S", "\\W", "\\D", such a class, or a group that holds a wide atom. A lone "\\s" or "[ ]" is not wide.
export function widePattern(source) {
  const groups = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    let end = i + 1;
    let wide = ch === '.';
    if (ch === '\\') {
      wide = 'SWD'.includes(source[i + 1]);
      end = i + 2;
    } else if (ch === '[') {
      const close = classEnd(source, i);
      const body = source.slice(i + 1, close);
      if (body.startsWith('^') && !body.includes("'")) return true;
      const reach = classReach(body.startsWith('^') ? '' : body);
      wide = reach.quote || (reach.space && reach.other);
      end = close + 1;
    } else if (ch === '(') {
      groups.push(false);
    } else if (ch === ')') {
      wide = groups.pop() === true;
    }
    if (wide) {
      if (unbounded(source, end)) return true;
      groups.fill(true);
    }
    i = end;
  }
  return false;
}

// The name a word stands for: a quoted name without its quotes, a doubled quote made single, lower case.
export function plainName(word) {
  if (!NAME_QUOTES.includes(word[0])) return word;
  return word.slice(1, -1).replaceAll(word[0] + word[0], word[0]).toLowerCase();
}

// The words of a create, alter or drop up to the first "(" or "as": where the kind of object is named.
export function headWords(words) {
  const end = words.findIndex((word) => word === '(' || word === 'as');
  return end === -1 ? words : words.slice(0, end);
}

// Whether a word of firsts is directly followed by a word of seconds.
export function hasPair(words, firsts, seconds) {
  return words.some((word, i) => firsts.includes(word) && seconds.includes(words[i + 1]));
}

// The first function called (a word followed by "(") whose plain name, alone or after its schema and a dot, is one of
// names or starts with one of prefixes: that name with its schema when it has one, or undefined.
export function calledFunction(words, names, prefixes) {
  const listed = (name) => names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix));
  for (const [i, word] of words.entries()) {
    if (words[i + 1] === '(') {
      const name = plainName(word);
      const schema = words[i - 1] === '.' ? words[i - 2] : undefined;
      const qualified = schema === undefined ? name : `${plainName(schema)}.${name}`;
      if (listed(name) || listed(qualified)) return qualified;
    }
  }
  return undefined;
}
