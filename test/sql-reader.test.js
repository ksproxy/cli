import test from 'node:test';
import assert from 'node:assert/strict';
import { AllowError } from '../src/allowlist.js';
import {
  LITERAL_STAR, MAX_STATEMENT_BYTES, NAME_HOLE_WARNING, REST, STAR_WARNING, WIDE_WARNING, calledFunction, hasPair, headWords, matchStatementRule, plainName,
  readStatement, splitRule, sqlRuleWarnings, starWarning,
} from '../src/kinds/engines/sql.js';

const pg = (text) => readStatement(text, 'postgres');
const my = (text) => readStatement(text, 'mysql');

function refused(read, text, short, message) {
  assert.throws(() => read(text), (err) => {
    assert.ok(err instanceof AllowError, `${JSON.stringify(text)}: ${err}`);
    assert.equal(err.short, short, JSON.stringify(text));
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  });
}

test('the words of a statement: lower-cased words, quoted words as written, each mark its own word', () => {
  const both = [
    ['SELECT * FROM Orders WHERE id = 5', ['select', '*', 'from', 'orders', 'where', 'id', '=', '5']],
    ["select 'it''s', 'A b' from t;", ['select', "'it''s'", ',', "'A b'", 'from', 't']],
    ['select a.b, 1.5, 1e3, .5 from s.t', ['select', 'a', '.', 'b', ',', '1', '.', '5', ',', '1e3', ',', '.', '5', 'from', 's', '.', 't']],
    ['select a<>b,a>=b,c::int,x||y,a%b,!x,~x,a^b,a&b,a|b,arr[1],?,@x,{},a/b,a+b,a-b', [
      'select', 'a', '<', '>', 'b', ',', 'a', '>', '=', 'b', ',', 'c', ':', ':', 'int', ',', 'x', '|', '|', 'y', ',', 'a', '%', 'b', ',',
      '!', 'x', ',', '~', 'x', ',', 'a', '^', 'b', ',', 'a', '&', 'b', ',', 'a', '|', 'b', ',', 'arr', '[', '1', ']', ',', '?', ',', '@', 'x',
      ',', '{', '}', ',', 'a', '/', 'b', ',', 'a', '+', 'b', ',', 'a', '-', 'b']],
    ['\t select\n1\r\n ;  ', ['select', '1']],
    ["select 'line\nbreak\ttab', 'héllo ünïcode'", ['select', "'line\nbreak\ttab'", ',', "'héllo ünïcode'"]],
    ['select count(*) from t group by 1 order by 2 desc limit 10', ['select', 'count', '(', '*', ')', 'from', 't', 'group', 'by', '1', 'order', 'by', '2', 'desc', 'limit', '10']],
    ["select 'a;b', '--', '/*', '$$', '#'", ['select', "'a;b'", ',', "'--'", ',', "'/*'", ',', "'$$'", ',', "'#'"]],
    ['select 1 - -1, a * b', ['select', '1', '-', '-', '1', ',', 'a', '*', 'b']],
  ];
  for (const [text, words] of both) {
    assert.deepEqual(pg(text), words, text);
    assert.deepEqual(my(text), words, text);
  }
  assert.deepEqual(pg('select "Name""x", "a_b" from "T"'), ['select', '"Name""x"', ',', '"a_b"', 'from', '"T"']);
  assert.deepEqual(pg('select 1 # 2'), ['select', '1', '#', '2']);
  assert.deepEqual(my('select "str ""x""", `Col``x` from t'), ['select', '"str ""x"""', ',', '`Col``x`', 'from', 't']);
  assert.deepEqual(my("select \"it's\""), ['select', "\"it's\""]);
  const exact = `select '${'x'.repeat(MAX_STATEMENT_BYTES - 9)}'`;
  assert.equal(Buffer.byteLength(exact), MAX_STATEMENT_BYTES);
  assert.equal(pg(exact).length, 2);
});

test('every refusal of the reader, with its short text, in both dialects', () => {
  for (const read of [pg, my]) {
    refused(read, 5, 'invalid statement', 'the statement must be a string');
    refused(read, undefined, 'invalid statement');
    refused(read, `select '${'x'.repeat(MAX_STATEMENT_BYTES)}'`, 'statement too long', `the statement is longer than ${MAX_STATEMENT_BYTES} bytes`);
    refused(read, `select '${'é'.repeat(8200)}'`, 'statement too long');
    for (const ch of ['\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f', '\u0085', '\u009f']) {
      refused(read, `select '${ch}'`, 'control character', 'the statement contains a control character');
      refused(read, `select 1${ch}`, 'control character');
    }
    refused(read, '\\! id', 'backslash', 'a backslash is not allowed outside a quoted string: the database client reads it as its own command');
    refused(read, 'select 1 \\g', 'backslash');
    refused(read, 'select 1 \\*', 'backslash');
    refused(read, 'select 1 -- x', 'comment');
    refused(read, 'select 1--x', 'comment');
    refused(read, 'select /* x */ 1', 'comment');
    refused(read, 'select 2/*3', 'comment');
    refused(read, 'select $1', 'dollar sign', '"$" is not allowed outside a quoted string');
    refused(read, 'select a$', 'dollar sign');
    refused(read, "select 'abc", 'unterminated quote', "the quote ' is not closed");
    refused(read, "select 'abc''", 'unterminated quote');
    refused(read, 'select "abc', 'unterminated quote');
    for (const prefix of ['B', 'b', 'X', 'x', 'N', '_utf8', '1']) refused(read, `select ${prefix}'1'`, 'prefixed string');
    refused(read, 'select 1; select 2', 'more than one statement', 'only one statement is allowed: ";" may only end it');
    refused(read, 'select 1;;', 'more than one statement');
    refused(read, '; select 1', 'more than one statement');
    for (const text of ['', '   ', ';', ' \n ; ']) refused(read, text, 'empty statement', 'the statement is empty');
    refused(read, 'select é', 'character not allowed', 'character U+00E9 is not allowed outside a quoted text');
    refused(read, 'select a b', 'character not allowed');
    refused(read, 'select 1', 'character not allowed');
  }
  refused(pg, "select E'\\x41'", 'escape string', "an escape string (E'...') is not allowed: write a plain quoted string");
  refused(pg, "select e'a'", 'escape string');
  refused(pg, "select U&'d\\0061t'", 'prefixed string', "a unicode escape string (U&'...') is not allowed: write a plain quoted string");
  refused(pg, 'select u&"x"', 'prefixed string');
  refused(pg, 'select abc"x"', 'prefixed string', 'a prefixed string (abc"...) is not allowed: write a plain quoted string');
  assert.deepEqual(pg('select u & 1'), ['select', 'u', '&', '1']);
  assert.deepEqual(pg('select u&x'), ['select', 'u', '&', 'x']);
  refused(pg, 'select $$x$$', 'dollar quote', 'dollar-quoted text is not allowed: write a plain quoted string');
  refused(pg, 'select $tag$x$tag$', 'dollar quote');
  refused(pg, 'select `a`', 'character not allowed', 'character "`" is not allowed outside a quoted text');

  refused(my, "select 'a\\'b'", 'backslash', 'a backslash inside a quoted text is not allowed: mysql reads it as an escape');
  const pgBackslash = 'a backslash inside a quoted text is not allowed: postgres reads it as an escape when standard_conforming_strings is off';
  refused(pg, "select '\\''; delete from orders; -- '", 'backslash', pgBackslash);
  refused(pg, "select 'a\\b'", 'backslash', pgBackslash);
  refused(pg, 'select "a\\b"', 'backslash', pgBackslash);
  refused(my, 'select "a\\"', 'backslash');
  refused(my, 'select `a\\b`', 'backslash');
  refused(my, 'select 1 # c', 'comment', 'a comment is not allowed in a mysql statement');
  refused(my, 'select /*!50000 1*/', 'comment', 'a comment is not allowed; mysql runs the text of a /*! comment as SQL');
  refused(pg, 'select /*!50000 1*/', 'comment', 'a comment is not allowed in a postgres statement');
  refused(my, "select E'a'", 'prefixed string');
  refused(my, 'select $$x$$', 'dollar sign');
  refused(my, 'select `abc', 'unterminated quote', 'the quote ` is not closed');
  refused(my, 'select x`a`', 'prefixed string');
});

test('the words of the mysql client are refused at the start of a statement, in any case', () => {
  const words = [
    'system', 'source', 'delimiter', 'tee', 'notee', 'pager', 'nopager', 'edit', 'use', 'connect', 'charset', 'warnings',
    'nowarning', 'prompt', 'rehash', 'status', 'help', 'quit', 'exit', 'go', 'ego', 'print', 'resetconnection',
    'query_attributes', 'ssl_session_data_print', 'clear',
  ];
  for (const word of words) {
    refused(my, `${word.toUpperCase()} x`, 'client command', `"${word}" is a command of the mysql client, not SQL`);
    refused(my, `\n  ${word};`, 'client command');
  }
  refused(my, '? contents', 'client command');
  assert.deepEqual(my('select system from t'), ['select', 'system', 'from', 't']);
  assert.deepEqual(pg('status'), ['status'], 'postgres has no such client words');
});

test('the reader never throws anything but AllowError, and gives words that are non-empty strings', () => {
  let seed = 20261121;
  const random = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };
  const alphabet = [..."abcSELECT_019 \t\n\r'\"`\\$-/*#;().,=<>+%!|&^~:[]{}?@", '\u0000', '\u0007', '\u007f', '\u0085', 'é', ' ', '😀', 'Ω'];
  const pieces = ['select', 'from', ' ', "'", '"', '`', '--', '/*', '/*!', '$$', '$a$', "E'", "U&'", '...', '\\*', ';', "''", '``', '""'];
  for (let n = 0; n < 6000; n += 1) {
    let text = '';
    const length = Math.floor(random() * 40);
    for (let i = 0; i < length; i += 1) {
      text += random() < 0.3 ? pieces[Math.floor(random() * pieces.length)] : alphabet[Math.floor(random() * alphabet.length)];
    }
    for (const dialect of ['postgres', 'mysql']) {
      for (const read of [readStatement, splitRule]) {
        let words;
        try {
          words = read(text, dialect);
        } catch (err) {
          assert.ok(err instanceof AllowError, `${read.name} ${dialect} ${JSON.stringify(text)}: ${err}`);
          assert.equal(typeof err.short, 'string');
          continue;
        }
        assert.ok(Array.isArray(words) && words.length > 0, JSON.stringify(text));
        for (const word of words) {
          assert.equal(typeof word, 'string');
          assert.ok(word.length > 0);
          assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(word));
        }
        assert.ok(!words.includes(';'), JSON.stringify(text));
      }
    }
  }
});

test('a rule is split by the same reader: * one word, \\* the SQL star, ... the rest and only last', () => {
  const rule = (text, dialect = 'postgres') => splitRule(text, dialect);
  assert.deepEqual(rule('select \\* from orders where id = *'), ['select', LITERAL_STAR, 'from', 'orders', 'where', 'id', '=', '*']);
  assert.deepEqual(rule('SELECT count(\\*) FROM *'), ['select', 'count', '(', LITERAL_STAR, ')', 'from', '*']);
  assert.deepEqual(rule('select count(*) from t'), ['select', 'count', '(', '*', ')', 'from', 't']);
  assert.deepEqual(rule('select ...'), ['select', REST]);
  assert.deepEqual(rule("select * from t where name = 'A b';"), ['select', '*', 'from', 't', 'where', 'name', '=', "'A b'"]);
  assert.deepEqual(rule('show `T`', 'mysql'), ['show', '`T`']);
  assert.deepEqual(rule('status'), ['status']);
  assert.deepEqual(rule('status', 'mysql'), ['status'], 'a rule is never refused as a client word; the statement is');
  for (const text of ['select ... from t', 'select count(...)', '... x']) {
    assert.throws(() => rule(text), (err) => err instanceof AllowError && err.short === 'rest not last' && err.message === '"..." is only allowed as the last word');
  }
  assert.throws(() => rule('select \\d'), (err) => err.short === 'backslash');
  assert.throws(() => rule('select 1 -- all'), (err) => err.short === 'comment');
  assert.throws(() => rule(''), (err) => err.short === 'empty statement');
});

test('a rule matches the lower-cased words: the SQL star, one word, the rest, brackets and regex', () => {
  const allows = (rule, text, dialect = 'postgres') => matchStatementRule(readStatement(text, dialect), rule, dialect);
  assert.equal(allows('select \\* from orders where id = *', 'select * from orders where id = 5'), true);
  assert.equal(allows('select \\* from orders where id = *', 'SELECT * FROM ORDERS WHERE ID = 5'), true);
  assert.equal(allows('select \\* from orders where id = *', 'select id from orders where id = 5'), false);
  assert.equal(allows('select \\* from orders where id = *', "select * from orders where id = 'x y'"), true);
  assert.equal(allows('select \\* from orders where id = *', 'select * from orders where id = 5 or 1 = 1'), false);
  assert.equal(allows('select * from orders', 'select password from orders'), false, 'a hole takes a value, never a name');
  assert.equal(allows('select * from orders', 'select 1 from orders'), true);
  assert.equal(allows('select * from orders', 'select * from orders'), false, 'nor the SQL star');
  assert.equal(allows('select * from orders', 'select - from orders'), false, 'nor a punctuation mark');
  assert.equal(allows('select ...', 'select 1'), true);
  assert.equal(allows('select ...', 'select'), true);
  assert.equal(allows('select ...', 'show tables'), false);
  assert.equal(allows('select count(\\*) from t', 'select count(*) from t'), true);
  assert.equal(allows('select count(\\*) from t', 'select count(id) from t'), false);
  assert.equal(allows('select count(\\*) from *', 'select count(*) from t'), false, 'a hole after from can never match');
  assert.equal(allows('select count(*) from t', 'select count(id) from t'), false);
  assert.equal(allows('select count(*) from t', 'select count(1) from t'), true);
  assert.equal(allows('select count(*) from t', 'select count(*) from t'), false);
  assert.equal(allows('select count( * ) from t', 'select count(1) from t'), true);
  assert.equal(allows('select "Name" from t', 'select "Name" from t'), true);
  assert.equal(allows('select "name" from t', 'select "Name" from t'), false);
  assert.equal(allows("select * from t where a = 'Bob'", "select 'x' from t where a = 'Bob'"), true);
  assert.equal(allows("select * from t where a = 'Bob'", "select 'x' from t where a = 'bob'"), false);
  assert.equal(allows('select a.b from t', 'select a . b from t'), true);
  assert.equal(allows('select 1.5', 'select 1.5'), true);
  const regex = 'regex(select \\* from orders where id = \\d+)';
  assert.equal(allows(regex, 'SELECT * FROM orders WHERE id = 42'), true);
  assert.equal(allows(regex, 'select * from orders where id = 4.2'), false);
  assert.equal(allows(regex, 'select * from orders where id = 4 or 1=1'), false);
  assert.equal(allows("regex(select name from t where name = 'Bob')", "select name from t where name = 'Bob'"), true);
  assert.equal(allows("regex(select name from t where name = 'Bob')", "select name from t where name = 'bob'"), false);
  assert.equal(allows('regex(select .*)', 'select a.b from t'), true);
  assert.equal(allows('regex(select a . b from t)', 'select a.b from t'), true);
  assert.equal(allows('show `T`', 'SHOW `T`', 'mysql'), true);
  assert.equal(allows('show `t`', 'SHOW `T`', 'mysql'), false);
});

test('a * hole in a SQL rule matches one value: a number or one single-quoted string, never a name', () => {
  for (const dialect of ['postgres', 'mysql']) {
    const allows = (rule, text) => matchStatementRule(readStatement(text, dialect), rule, dialect);
    const byId = (value) => allows('select \\* from orders where id = *', `select * from orders where id = ${value}`);
    for (const value of ['42', '-1', '+7', '1.5', '-0.25', '0', "'a b'", "'it''s'", "''", '- 1', '1 . 5']) {
      assert.equal(byId(value), true, `${dialect}: ${value}`);
    }
    for (const value of ['id', '"id"', 'null', 'true', 'default', 'current_user', '1 or 1=1', '(select 1)', 'f(x)', '1e5', '0x1F', '1_000',
      '- - 1', '-(1)', '5 - 1', '1.', '.5', '1.5.2', '-', '(1)', '*', "'a' 'b'", '']) {
      assert.equal(byId(value), false, `${dialect}: ${value}`);
    }
    if (dialect === 'mysql') assert.equal(byId('`id`'), false, 'a backtick name');
    assert.equal(allows('select \\* from t limit *', 'select * from t limit all'), false, `${dialect}: limit all`);
    assert.equal(allows('select \\* from t limit *', 'select * from t limit 10'), true);
    assert.equal(allows('select \\* from t where id in ( * , * )', 'select * from t where id in (1, -2)'), true);
    assert.equal(allows('select \\* from t where id in ( * , * )', "select * from t where id in ('a', 2.5)"), true);
    assert.equal(allows('select \\* from t where id in ( * , * )', 'select * from t where id in (1, id)'), false);
    assert.equal(allows('select \\* from t where id in ( * , * )', 'select * from t where id in (1, 2, 3)'), false);
    assert.equal(allows('select \\* from t where id in ( * , * )', 'select * from t where id in (1)'), false);
    assert.equal(allows('select \\* from t where id = * ...', 'select * from t where id = -1 order by id'), true, 'the rest after a value');
    assert.equal(allows('select \\* from t where id = * ...', 'select * from t where id = id order by id'), false);
  }
});

test('a hole next to rule words that look like part of a number takes the longest number, so it never allows more', () => {
  const allows = (rule, text) => matchStatementRule(readStatement(text, 'postgres'), rule, 'postgres');
  assert.equal(allows('select \\* from t where a = * - 1', 'select * from t where a = 5 - 1'), true);
  assert.equal(allows('select \\* from t where a = * - 1', 'select * from t where a = 5-1'), true);
  assert.equal(allows('select \\* from t where a = * - 1', 'select * from t where a = -5 - 1'), true);
  assert.equal(allows('select \\* from t where a = * - 1', 'select * from t where a = 5 - 2'), false);
  assert.equal(allows('select \\* from t limit * . *', 'select * from t limit 1.5'), false, 'the longest number is 1.5, and the rule then wants more');
  assert.equal(allows('select \\* from t limit * . *', 'select * from t limit 1 . 5'), false, 'the same words');
  assert.equal(allows('select \\* from t where a = * . 5', 'select * from t where a = 1.5'), false);
  assert.equal(allows('select \\* from t where a = *', 'select * from t where a = 1.5'), true);
});

test('a sign belongs to a number only after a punctuation mark that is not a closing bracket, or at the start', () => {
  const allows = (rule, text) => matchStatementRule(readStatement(text, 'postgres'), rule, 'postgres');
  assert.equal(allows('select a *', 'select a - 1'), false, 'after a name, - is the minus sign');
  assert.equal(allows('select 2 *', 'select 2 - 1'), false, 'after a value too');
  assert.equal(allows("select 'x' *", "select 'x' - 1"), false, 'after a string too');
  assert.equal(allows('select ( 2 ) *', 'select (2) - 1'), false, 'after a closing bracket too');
  assert.equal(allows('select 2 \\* *', 'select 2 * -1'), true, 'after another operator it is a sign');
  assert.equal(allows('select ( *', 'select (-1'), true);
  assert.equal(allows('select , *', 'select , -1'), true);
  assert.equal(allows('*', '-1'), true, 'at the start');
  assert.equal(allows('select a - *', 'select a - 1'), true, 'the minus sign written into the rule');
});

test('the bare star warning, and the warnings of an allow list by index', () => {
  assert.equal(starWarning(['select', '*', 'from', 't']), true);
  assert.equal(starWarning(['select', 'count', '(', '*', ')']), true);
  assert.equal(starWarning(['select', LITERAL_STAR, 'from', 't']), false);
  assert.equal(starWarning(['select', 'a', 'from', 't', 'where', 'id', '=', '*']), false);
  assert.equal(starWarning(['select', 'a', ',', '*']), false);
  assert.equal(starWarning(['*']), false);
  assert.equal(STAR_WARNING, '"*" matches one value here (a number or a quoted string); write \\* for the SQL star');
  assert.deepEqual(sqlRuleWarnings([
    'select * from orders', 'select \\* from t', 'regex((a+)+)', 'select count(*) from t', 'regex(select a . b)', 'select ...',
  ], 'postgres'), [
    'allow[0]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star',
    'allow[2]: this pattern can be very slow on some inputs',
    'allow[3]: "*" matches one value here (a number or a quoted string); write \\* for the SQL star',
  ]);
  assert.deepEqual(sqlRuleWarnings([], 'mysql'), []);
});

test('a * hole where only a name can stand gets a warning, as it can never match', () => {
  assert.equal(NAME_HOLE_WARNING, '"*" after FROM, JOIN, INTO, UPDATE, TABLE or DESCRIBE matches one value, never a name, so this rule can never match; write the name, or use a regex(...) rule');
  for (const dialect of ['postgres', 'mysql']) {
    assert.deepEqual(sqlRuleWarnings([
      'select count(\\*) from *', 'select \\* from orders join * on ...', 'insert into * ...', 'update * set ...', 'truncate table *', 'describe *',
      'select \\* from orders where id = *', 'select \\* from * where id = *', 'select from_x , *',
    ], dialect), [
      `allow[0]: ${NAME_HOLE_WARNING}`,
      `allow[1]: ${NAME_HOLE_WARNING}`,
      `allow[2]: ${NAME_HOLE_WARNING}`,
      `allow[3]: ${NAME_HOLE_WARNING}`,
      `allow[4]: ${NAME_HOLE_WARNING}`,
      `allow[5]: ${NAME_HOLE_WARNING}`,
      `allow[7]: ${NAME_HOLE_WARNING}`,
    ], dialect);
  }
  assert.deepEqual(sqlRuleWarnings(['select * from *'], 'postgres'), [`allow[0]: ${STAR_WARNING}`, `allow[0]: ${NAME_HOLE_WARNING}`], 'both');
});

test('a regex rule that can match more than one word gets a warning: a wide part repeated with no upper bound, a [^...] that keeps the quote', () => {
  assert.equal(WIDE_WARNING, 'this pattern can match more than one word: a part that can match a quote, or a space and other characters (".", "\\S", "\\W", "[\\s\\S]", "[a-z ]" or a group holding one), repeated with no upper bound ("*", "+", "{n,}"), and a "[^...]" class that does not leave out \', also match spaces and quotes, so \'.*\' can match a string and the SQL after it; write \'[^\']*\' for one quoted string');
  const wide = (rule) => sqlRuleWarnings([rule], 'postgres');
  const allows = (rule, text) => matchStatementRule(readStatement(text, 'postgres'), rule, 'postgres');
  for (const rule of ["regex(select \\* from orders where name = '.*')", 'regex(select a.+)', 'regex(.*)', 'regex(select [^ ]+)', 'regex(select [^]*)',
    'regex(select \\. [^\\]x]*)', "regex(where n = '.{0,}')", "regex(where n = '.{1,}')", "regex(where n = '[\\s\\S]*')",
    "regex(where n = '[\\s\\S]+')", "regex(where n = '(.)*')", "regex(where n = '(.)+')", 'regex(a \\S+)',
    'regex(a \\W*)', 'regex(a \\D{2,})', "regex(a [a-z ]+)", "regex(a [ -~]+)", "regex(a ['a]+)", "regex(a (b(.)c)+)"]) {
    assert.deepEqual(wide(rule), [`allow[0]: ${WIDE_WARNING}`], rule);
  }
  for (const rule of ["regex(select \\* from orders where name = '[^']*')", 'regex(select \\.*)', 'regex(select [.]*)', 'regex(select a.b)', 'regex(a.?)',
    "regex(select [^\\]']+)", 'regex(select [a-z]+)', "regex(select [^x']+ .)", 'regex(select\\s+\\*\\s+from t)', 'regex(a [ ]+ b)',
    'regex(a [\\s]* b)', 'regex(a .{0,3})', 'regex(a \\w+ \\d+)', 'regex(a (.))', 'regex(a (\\w)+)', 'regex(a [a-z0-9_]{1,})', 'regex(a ) b)', 'regex(a [a-]+)', 'regex(a [!-&]+)',
    'regex(a [(-\\)]+)', 'regex(a [ -\\ ]+)', 'regex(a [\\d ]{2})']) {
    assert.deepEqual(wide(rule), [], rule);
  }
  assert.deepEqual(wide('regex((.+)+)'), ['allow[0]: this pattern can be very slow on some inputs', `allow[0]: ${WIDE_WARNING}`], 'both warnings');
  assert.deepEqual(wide('regex(a (.?)*)'), ['allow[0]: this pattern can be very slow on some inputs', `allow[0]: ${WIDE_WARNING}`], 'a group of an optional dot');
  assert.deepEqual(wide("regex(where n = '(?:.|x)+')"), ['allow[0]: this pattern can be very slow on some inputs', `allow[0]: ${WIDE_WARNING}`], 'a group');
  assert.equal(allows("regex(select \\* from orders where name = '.*')", "select * from orders where name = 'a' or name <> 'b'"), true, 'why it warns');
  assert.equal(allows("regex(select \\* from orders where name = '[^']*')", "select * from orders where name = 'a' or name <> 'b'"), false);
  assert.equal(allows("regex(select \\* from orders where name = '[^']*')", "select * from orders where name = 'a b'"), true);
});

test('the helpers of the fixed refusals: plainName, calledFunction, headWords and hasPair', () => {
  assert.equal(plainName('"Pg_Read_File"'), 'pg_read_file');
  assert.equal(plainName('"a""b"'), 'a"b');
  assert.equal(plainName('`Load``File`'), 'load`file');
  assert.equal(plainName("'x'"), "'x'");
  assert.equal(plainName('abc'), 'abc');
  const words = pg('select pg_catalog."pg_read_file" (\'/etc/passwd\'), dblink_exec(1), x(1)');
  assert.equal(calledFunction(words, ['pg_read_file'], []), 'pg_catalog.pg_read_file', 'the name with its schema');
  assert.equal(calledFunction(words, ['pg_catalog.pg_read_file'], []), 'pg_catalog.pg_read_file', 'compared with its schema');
  assert.equal(calledFunction(pg('select "Cron" . "Schedule"(1)'), [], ['cron.']), 'cron.schedule');
  assert.equal(calledFunction(pg('select schedule(1)'), ['schedule'], []), 'schedule', 'compared without a schema');
  assert.equal(calledFunction(pg('select schedule(1)'), [], ['cron.']), undefined);
  assert.equal(calledFunction(pg('. schedule(1)'), ['schedule'], []), 'schedule', 'a dot with nothing before it is no schema');
  assert.equal(calledFunction(words, ['nothing'], ['dblink']), 'dblink_exec');
  assert.equal(calledFunction(words, ['nothing'], ['zz']), undefined);
  assert.equal(calledFunction(pg('select pg_read_file from t'), ['pg_read_file'], []), undefined, 'a column of that name is no call');
  assert.deepEqual(headWords(pg('create table t (a int)')), ['create', 'table', 't']);
  assert.deepEqual(headWords(pg('create view v as select user')), ['create', 'view', 'v']);
  assert.deepEqual(headWords(pg('drop role x')), ['drop', 'role', 'x']);
  assert.equal(hasPair(my('select 1 into outfile x'), ['into'], ['outfile']), true);
  assert.equal(hasPair(my('select into'), ['into'], ['outfile']), false);
  assert.equal(hasPair(my('select outfile into'), ['into'], ['outfile']), false);
});
