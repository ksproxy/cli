import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AllowError, validateRule, matchRule, matchRuleDetail, tokenizeSshCommand, checkRawSshCommand, decide, describeAllow,
} from '../src/allowlist.js';

test('validateRule accepts good rules', () => {
  for (const rule of ['df -h', 'systemctl status *', 'journalctl -u myapp ...', '...']) {
    assert.doesNotThrow(() => validateRule(rule), rule);
  }
});

test('validateRule rejects bad rules', () => {
  for (const rule of ['', '   ', '... get', 'get ... pods', 42]) {
    assert.throws(() => validateRule(rule), Error, String(rule));
  }
});

test('matchRule table', () => {
  const rows = [
    [['df', '-h'], 'df -h', true],
    [['df'], 'df -h', false],
    [['df', '-h', '/'], 'df -h', false],
    [['systemctl', 'status', 'nginx'], 'systemctl status *', true],
    [['systemctl', 'status'], 'systemctl status *', false],
    [['systemctl', 'status', '--all'], 'systemctl status *', false],
    [['systemctl', 'status', 'a', 'b'], 'systemctl status *', false],
    [['journalctl', '-u', 'myapp'], 'journalctl -u myapp ...', true],
    [['journalctl', '-u', 'myapp', '--since', 'today', '-n', '50'], 'journalctl -u myapp ...', true],
    [['journalctl', '-u', 'other'], 'journalctl -u myapp ...', false],
    [['get', 'pods', '-A'], 'get ...', true],
    [[], '...', true],
    [['*'], '*', true],
  ];
  for (const [args, rule, expected] of rows) {
    assert.equal(matchRule(args, rule), expected, `${JSON.stringify(args)} vs ${rule}`);
  }
});

test('matchRuleDetail returns the arguments the wildcards matched, and null when the rule does not match', () => {
  const rows = [
    [['df', '-h'], 'df -h', { star: [], rest: [] }],
    [['df'], 'df -h', null],
    [['df', '-h', '/'], 'df -h', null],
    [['systemctl', 'status', 'nginx'], 'systemctl status *', { star: ['nginx'], rest: [] }],
    [['systemctl', 'status'], 'systemctl status *', null],
    [['systemctl', 'status', '--all'], 'systemctl status *', null],
    [['systemctl', 'status', 'a', 'b'], 'systemctl status *', null],
    [['journalctl', '-u', 'myapp'], 'journalctl -u myapp ...', { star: [], rest: [] }],
    [['journalctl', '-u', 'myapp', '--since', 'today', '-n', '50'], 'journalctl -u myapp ...', { star: [], rest: ['--since', 'today', '-n', '50'] }],
    [['journalctl', '-u', 'other'], 'journalctl -u myapp ...', null],
    [['get', 'pods', '-A'], 'get ...', { star: [], rest: ['pods', '-A'] }],
    [[], '...', { star: [], rest: [] }],
    [['*'], '*', { star: ['*'], rest: [] }],
    [['cp', 'a', 'b', '-x', 'y'], 'cp * * ...', { star: ['a', 'b'], rest: ['-x', 'y'] }],
    [['cp', 'a', '-b'], 'cp * *', null],
  ];
  for (const [args, rule, expected] of rows) {
    assert.deepEqual(matchRuleDetail(args, rule), expected, `${JSON.stringify(args)} vs ${rule}`);
  }
});

test('tokenizeSshCommand returns tokens', () => {
  assert.deepEqual(tokenizeSshCommand('df -h'), ['df', '-h']);
  assert.deepEqual(tokenizeSshCommand('  systemctl   status\tnginx '), ['systemctl', 'status', 'nginx']);
  assert.equal(tokenizeSshCommand('cat /var/log/app_1.log').length, 2);
  assert.equal(tokenizeSshCommand('x a=b,c:d@e%f+g').length, 2);
});

test('tokenizeSshCommand refuses unsafe input', () => {
  const cases = [
    ['', null],
    ['   ', null],
    ['-rf /', null],
    ['ls; id', ';'],
    ['ls | wc', '|'],
    ['ls && id', '&'],
    ['ls $(id)', '$'],
    ['ls `id`', '`'],
    ['echo $HOME', '$'],
    ['ls > /tmp/x', '>'],
    ['ls < /tmp/x', '<'],
    ['{ sudo id; }', '{'],
    ['(sudo id)', '('],
    ['ls *', '*'],
    ['ls ?', '?'],
    ['ls [a]', '['],
    ['ls ~', '~'],
    ['ls !x', '!'],
    ['ls #c', '#'],
    ["ls 'a b'", "'"],
    ['ls "a b"', '"'],
    ['ls a\\b', '\\'],
    ['ls\nid', 'U+000A'],
    ['ls\rid', 'U+000D'],
    ['ls\u0000', 'U+0000'],
    ['ls \u202e', 'U+202E'],
    ['ls é', 'U+00E9'],
    ['a'.repeat(4097), null],
  ];
  for (const [command, needle] of cases) {
    assert.throws(
      () => tokenizeSshCommand(command),
      (err) => err instanceof AllowError && (needle === null || err.message.includes(needle)),
      JSON.stringify(command).slice(0, 40),
    );
  }
});

test('checkRawSshCommand', () => {
  assert.equal(checkRawSshCommand('ls | wc -l'), 'ls | wc -l');
  for (const command of ['', '   ', '-x', 'ls\u0000', 'a'.repeat(4097)]) {
    assert.throws(() => checkRawSshCommand(command), AllowError, JSON.stringify(command).slice(0, 40));
  }
});

test('decide', () => {
  assert.deepEqual(decide(['df', '-h'], 'any'), { allowed: true, rule: 'any' });
  assert.deepEqual(decide(['df', '-h'], ['uptime', 'df -h']), { allowed: true, rule: 'df -h' });
  const refused = decide(['id'], ['df -h']);
  assert.equal(refused.allowed, false);
  assert.ok(refused.reason.includes('df -h'));
  const empty = decide(['id'], []);
  assert.equal(empty.allowed, false);
  assert.ok(empty.reason.includes('empty'));
});

test('describeAllow', () => {
  assert.equal(describeAllow('any'), 'any command');
  assert.equal(describeAllow([]), 'nothing (empty allowlist)');
  assert.equal(describeAllow(['a', 'b ...']), 'a; b ...');
});

test('checkRawSshCommand refuses control characters but allows a tab', () => {
  assert.throws(() => checkRawSshCommand('ls\u001b[2K'), /control character/);
  assert.throws(() => checkRawSshCommand('ls\nid'), /control character/);
  assert.throws(() => checkRawSshCommand('ls\u007f'), /control character/);
  assert.equal(checkRawSshCommand('a\tb'), 'a\tb');
});

test('every refusal carries a short reason, and the long reason is unchanged', () => {
  const short = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof AllowError);
      return err.short;
    }
    throw new Error('did not throw');
  };
  assert.equal(short(() => tokenizeSshCommand(42)), 'invalid command');
  assert.equal(short(() => checkRawSshCommand(42)), 'invalid command');
  assert.equal(short(() => tokenizeSshCommand('a'.repeat(4097))), 'command too long');
  assert.equal(short(() => checkRawSshCommand('a'.repeat(4097))), 'command too long');
  assert.equal(short(() => tokenizeSshCommand('   ')), 'empty command');
  assert.equal(short(() => checkRawSshCommand('')), 'empty command');
  assert.equal(short(() => tokenizeSshCommand('uptime; id')), 'character ";" not allowed');
  assert.equal(short(() => tokenizeSshCommand("ls 'a'")), 'character "\'" not allowed');
  assert.equal(short(() => tokenizeSshCommand('ls \u202e')), 'character U+202E not allowed');
  assert.equal(short(() => tokenizeSshCommand('ls\nid')), 'character U+000A not allowed');
  assert.equal(short(() => tokenizeSshCommand('-rf /')), 'starts with "-"');
  assert.equal(short(() => checkRawSshCommand(' -x')), 'starts with "-"');
  assert.equal(short(() => checkRawSshCommand('ls\u0000')), 'control character');
  assert.equal(short(() => checkRawSshCommand('ls\u001b[2K')), 'control character');
  assert.throws(() => tokenizeSshCommand('uptime; id'), (err) => err.message
    === 'character ";" is not allowed: this target only accepts plain commands made of letters, digits and _ @ % + = : , . / - (no quotes, pipes, redirects or shell syntax)');
  assert.equal(new AllowError('m').short, undefined);
  assert.equal(new AllowError('m', 's').short, 's');
});

test('decide returns a short reason next to the unchanged long one', () => {
  const refused = decide(['id'], ['df -h']);
  assert.equal(refused.short, 'not on allowlist');
  assert.equal(refused.reason, 'not on the allowlist for this target. Allowed: df -h');
  const empty = decide(['id'], []);
  assert.equal(empty.short, 'allowlist is empty');
  assert.equal(empty.reason, 'the allowlist for this target is empty, so every command is refused');
  assert.equal('short' in decide(['df', '-h'], ['df -h']), false);
});
