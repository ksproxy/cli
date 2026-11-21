import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowWarnings, decide, isRegexRule, matchRule, matchRuleDetail, regexSource, ruleWarning, validateRule,
} from '../src/allowlist.js';
import sshKind from '../src/kinds/ssh/index.js';
import kubeKind from '../src/kinds/kubernetes/index.js';

const SLOW = 'this pattern can be very slow on some inputs';

test('word rules match exactly as before', () => {
  const cases = [
    ['df -h', ['df', '-h'], { star: [], rest: [] }],
    ['df -h', ['df'], null],
    ['df -h', ['df', '-h', '/'], null],
    ['systemctl status *', ['systemctl', 'status', 'nginx'], { star: ['nginx'], rest: [] }],
    ['systemctl status *', ['systemctl', 'status', '--all'], null],
    ['systemctl status *', ['systemctl', 'status'], null],
    ['journalctl -u myapp ...', ['journalctl', '-u', 'myapp', '--since', 'today'], { star: [], rest: ['--since', 'today'] }],
    ['journalctl -u myapp ...', ['journalctl', '-u', 'myapp'], { star: [], rest: [] }],
    ['journalctl -u myapp ...', ['journalctl', '-u', 'other'], null],
    ['get * ...', ['get', 'pods', '-A'], { star: ['pods'], rest: ['-A'] }],
    ['get *', ['get', '*'], { star: ['*'], rest: [] }],
    ['logs-* x', ['logs-*', 'x'], { star: [], rest: [] }],
    ['logs-* x', ['logs-a', 'x'], null],
    ['  df   -h  ', ['df', '-h'], { star: [], rest: [] }],
  ];
  for (const [rule, args, expected] of cases) {
    assert.deepEqual(matchRuleDetail(args, rule), expected, `${rule} on ${args.join(' ')}`);
    assert.equal(matchRule(args, rule), expected !== null);
  }
});

test('the rule word \\* matches only a literal star', () => {
  assert.deepEqual(matchRuleDetail(['select', '*', 'from', 'orders'], 'select \\* from orders'), { star: [], rest: [] });
  assert.equal(matchRuleDetail(['select', 'password', 'from', 'orders'], 'select \\* from orders'), null);
  assert.equal(matchRuleDetail(['select', '\\*', 'from', 'orders'], 'select \\* from orders'), null);
  assert.deepEqual(matchRuleDetail(['count', '*', 'x', 'y'], 'count \\* ...'), { star: [], rest: ['x', 'y'] });
  validateRule('select \\* from orders');
});

test('validateRule keeps its old errors and adds the regex ones', () => {
  assert.throws(() => validateRule(3), { message: 'rule must be a string' });
  assert.throws(() => validateRule('   '), { message: 'rule is empty' });
  assert.throws(() => validateRule('a ... b'), { message: '"..." is only allowed as the last token: a ... b' });
  for (const rule of ['ls regex(a)', 'regex(a', 'regex(', 'ls regex( x', ' regex(a) b']) {
    assert.throws(() => validateRule(rule), { message: 'regex(...) must be the whole rule' }, rule);
  }
  for (const rule of ['regex()', 'regex(   )', '  regex() ']) {
    assert.throws(() => validateRule(rule), { message: 'regex pattern is empty' }, rule);
  }
  assert.throws(() => validateRule('regex(a[)'), (err) => err.message.startsWith('regex does not compile: Invalid regular expression'));
  assert.throws(() => validateRule('regex(a)|(b)'), (err) => err.message.startsWith('regex does not compile: '));
  assert.throws(() => validateRule('regex(a) regex(b)'), (err) => err.message.startsWith('regex does not compile: '));
  validateRule('regex(uptime)');
  validateRule('  regex(df -h)  ');
  validateRule('regex((a)(b))');
  validateRule('regex)');
});

test('isRegexRule and regexSource', () => {
  assert.equal(isRegexRule('regex(uptime)'), true);
  assert.equal(isRegexRule('  regex(uptime)  '), true);
  assert.equal(isRegexRule('regex(uptime'), false);
  assert.equal(isRegexRule('uptime'), false);
  assert.equal(isRegexRule(undefined), false);
  assert.equal(isRegexRule(['regex(a)']), false);
  assert.equal(regexSource(' regex(df -h$) '), 'df -h$');
});

test('a regex rule matches the whole joined command only', () => {
  assert.deepEqual(matchRuleDetail(['uptime'], 'regex(uptime)'), { star: [], rest: [], regex: true });
  assert.equal(matchRuleDetail(['uptime', '-a'], 'regex(uptime)'), null);
  assert.equal(matchRuleDetail(['xuptime'], 'regex(uptime)'), null);
  for (const rule of ['regex(^df -h$)', 'regex(df -h)']) {
    assert.ok(matchRule(['df', '-h'], rule), rule);
    assert.ok(!matchRule(['df', '-h', '/'], rule), rule);
    assert.ok(!matchRule(['sudo', 'df', '-h'], rule), rule);
  }
  assert.ok(matchRule(['a'], 'regex(a|b)'));
  assert.ok(!matchRule(['a', 'x'], 'regex(a|b)'));
  assert.ok(!matchRule(['x', 'b'], 'regex(a|b)'));
  assert.ok(!matchRule(['UPTIME'], 'regex(uptime)'), 'no flags, so case matters');
  assert.ok(matchRule(['systemctl', 'status', 'nginx'], 'regex(systemctl status (nginx|redis))'));
  assert.ok(!matchRule(['systemctl', 'status', 'nginx', 'x'], 'regex(systemctl status (nginx|redis))'));
});

test('a regex rule is not tried on a joined command longer than 1000 characters', () => {
  const at = ['echo', 'x'.repeat(995)];
  assert.equal(at.join(' ').length, 1000);
  assert.ok(matchRule(at, 'regex(echo x+)'));
  const over = ['echo', 'x'.repeat(996)];
  assert.equal(matchRuleDetail(over, 'regex(echo x+)'), null);
  assert.equal(matchRuleDetail(over, 'regex(.*)'), null);
});

test('a regex rule that does not compile, or breaks out of its group, never matches', () => {
  assert.equal(matchRuleDetail(['a'], 'regex(a[)'), null);
  assert.equal(matchRuleDetail(['a', 'anything'], 'regex(a)|(b)'), null);
  assert.equal(matchRuleDetail(['a', 'anything'], 'regex(a).*(b)'), null);
});

test('ruleWarning flags slow patterns and nothing else', () => {
  for (const source of ['(a+)+', '(a|b)*c', '(\\d+)*', '\\1', 'x(a)\\1', '(?<n>a)\\k<n>', '((a)*)*', '(a+){2,}', '(a*){3}',
    '(?:a+)+', '(x(a|b))+', '(a|b)?']) {
    assert.equal(ruleWarning(`regex(${source})`), SLOW, source);
  }
  for (const source of ['\\d+', '[a-z]+ [0-9]+', '(nginx|redis)', '\\(a+\\)+', '[(a+)]+', '[\\]a+]+', '(a)+', '(?:ab)*',
    'a{2,}', '(a+){', '(a+){x}', '(a+){1', '(a+){,2}','a)+', '(a+', '\\', 'a\\', '(?=a)', '[]a+', '(a)\\0', '(a)\\k']) {
    assert.equal(ruleWarning(`regex(${source})`), null, source);
  }
});

test('ruleWarning flags two unbounded repeats in a row that can match the same character', () => {
  for (const source of ['.*.*', 'get .*.*.*.*.*x', '\\S*\\S*\\S*\\S*=', '.*\\S*', '\\S+\\w+', 'a*a+', '[a-z]*\\w{2,}',
    '.*?.*', '[^-\\s]+\\S*', 'x(?:.*.*)y']) {
    assert.equal(ruleWarning(`regex(${source})`), SLOW, source);
  }
  for (const source of ['a*b*', '\\d+\\s+', '[a-z]*[0-9]+', '.*x.*', '.?.*', '.{2}.*', '.*(a).*', '[^-\\s]\\S*', 'ls -l .*',
    '.*|.*', '^.*$.*', '[a-z*]*', '(?:a)*(?:a)*']) {
    assert.equal(ruleWarning(`regex(${source})`), null, source);
  }
});

test('a regex match that runs out of time does not match, and the refusal names the rule', () => {
  const rule = 'regex(get .*.*.*.*.*.*.*.*.*.*.*.*x)';
  const started = Date.now();
  const refused = decide(['get', 'a'.repeat(995)], [rule]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(refused.allowed, false);
  assert.equal(refused.unmatched, true);
  assert.equal(refused.short, 'regex rule too slow');
  assert.ok(refused.reason.endsWith('. The rule regex(get .*.*.*.*.*.*.*.*.*.*.*.*x) took longer than 100 ms on this command, so it was treated as not matching'), refused.reason);
  assert.deepEqual(decide(['get', 'a', 'x'], [rule]), { allowed: true, rule });
  assert.equal(matchRule(['get', 'a'.repeat(995)], rule), false, 'outside decide too, a match out of time does not match');
  assert.equal(decide(['put'], [rule]).short, 'not on allowlist');
  assert.equal(ruleWarning('(a+)+'), null);
  assert.equal(ruleWarning('ls ...'), null);
  assert.equal(ruleWarning(undefined), null);
  assert.equal(ruleWarning(42), null);
});

test('ruleWarning never throws, whatever text it is given', () => {
  const pieces = ['(', ')', '[', ']', '\\', '{', '}', ',', '1', '*', '+', '?', '|', 'k', '<', '>', 'a', '^', '$'];
  let seed = 7;
  for (let n = 0; n < 3000; n += 1) {
    let source = '';
    const len = n % 12;
    for (let i = 0; i < len; i += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      source += pieces[seed % pieces.length];
    }
    const result = ruleWarning(`regex(${source})`);
    assert.ok(result === null || result === SLOW);
  }
});

test('allowWarnings names each rule that has a warning by its index', () => {
  assert.deepEqual(allowWarnings(['ls', 'regex((a+)+)', 'regex(b)', 'regex(\\1)']), [
    `allow[1]: ${SLOW}`, `allow[3]: ${SLOW}`,
  ]);
  assert.deepEqual(allowWarnings('any'), []);
  assert.deepEqual(allowWarnings([]), []);
});

test('decide picks the first matching rule of either sort', () => {
  const allow = ['regex(uptime)', 'df -h', 'regex(df -h|free -m)', 'free *'];
  assert.deepEqual(decide(['uptime'], allow), { allowed: true, rule: 'regex(uptime)' });
  assert.deepEqual(decide(['df', '-h'], allow), { allowed: true, rule: 'df -h' });
  assert.deepEqual(decide(['free', '-m'], allow), { allowed: true, rule: 'regex(df -h|free -m)' });
  assert.deepEqual(decide(['free', 'x'], allow), { allowed: true, rule: 'free *' });
  const refused = decide(['uptime', '-a'], allow);
  assert.equal(refused.allowed, false);
  assert.equal(refused.unmatched, true);
  assert.ok(refused.reason.includes('regex(uptime); df -h'));
});

const sshTarget = (allow, extra = {}) => ({
  kind: 'ssh', name: 'web1', host: 'web1.example.com', allow, ...extra,
});

test('ssh: a regex rule and a \\* word, after the strict tokenizer', () => {
  const t = sshTarget(['regex(systemctl status [a-z]+)', 'regex(uptime.*)', 'ls \\*']);
  assert.deepEqual(sshKind.decide(t, 'systemctl  status nginx'), {
    allowed: true, rule: 'regex(systemctl status [a-z]+)', command: 'systemctl status nginx',
  });
  assert.equal(sshKind.decide(t, 'systemctl status nginx2').allowed, false);
  assert.equal(sshKind.decide(t, 'uptime -p').allowed, true);
  for (const command of ['uptime; rm -rf /', 'uptime | sh', 'uptime $(id)', 'uptime\nid', 'ls *']) {
    const d = sshKind.decide(t, command);
    assert.equal(d.allowed, false, command);
    assert.match(d.short, /not allowed$/, command);
    assert.equal(d.argv, undefined);
  }
  assert.equal(sshKind.decide(t, '-x uptime').short, 'starts with "-"');
  const unmatched = sshKind.decide(t, 'whoami');
  assert.equal(unmatched.unmatched, true);
  assert.deepEqual(unmatched.argv, ['whoami']);
});

test('ssh: a regex rule on a target with jumps still meets the "=" word check', () => {
  const t = sshTarget(['regex(echo .*)'], { jumps: ['ssh -i .ssh/key user@bastion'] });
  assert.equal(sshKind.decide(t, 'echo =id').short, 'unsafe "=" word');
  assert.equal(sshKind.decide(t, 'echo ok').allowed, true);
});

test('ssh: allow "any" is unaffected', () => {
  const d = sshKind.decide(sshTarget('any'), 'regex(x) | cat');
  assert.deepEqual(d, { allowed: true, rule: 'any', command: 'regex(x) | cat' });
});

const kubeTarget = (allow) => ({
  kind: 'kubernetes', name: 'lab', allow, manifestRoots: [],
});

test('kubernetes: a regex rule runs after the fixed refusals and the verb and flag lists', () => {
  const t = kubeTarget(['regex(get .*)', 'regex(.*)']);
  assert.deepEqual(kubeKind.decide(t, ['get', 'pods', '-n', 'web']), { allowed: true, rule: 'regex(get .*)' });
  for (const args of [['get', 'secrets'], ['get', 'secret', 'x'], ['exec', 'pod', '--', 'sh'], ['get', 'pods', '--kubeconfig', '/x'],
    ['create', 'token', 'x'], ['--all', 'get']]) {
    const d = kubeKind.decide(t, args);
    assert.equal(d.allowed, false, args.join(' '));
    assert.equal(d.unmatched, undefined, args.join(' '));
  }
});

test('kubernetes: a regex rule sees the arguments joined by single spaces, and \\* matches a star argument', () => {
  const t = kubeTarget(['regex(get pods -l app=a b)', 'get pods -l \\*']);
  assert.equal(kubeKind.decide(t, ['get', 'pods', '-l', 'app=a b']).allowed, true);
  assert.equal(kubeKind.decide(t, ['get', 'pods', '-l', '*']).rule, 'get pods -l \\*');
  const refused = kubeKind.decide(t, ['get', 'pods', '-l', 'x']);
  assert.equal(refused.unmatched, true);
  assert.deepEqual(refused.argv, ['get', 'pods', '-l', 'x']);
});
