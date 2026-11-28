import test from 'node:test';
import assert from 'node:assert/strict';
import { InventoryError, validateInventory } from '../src/inventory.js';

const reviewers = { groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'm-1', keyEnv: 'GROQ_API_KEY' } };
const ssh = (extra = {}) => ({ name: 'web1', host: 'web1.example.com', allow: ['uptime'], ...extra });
const fails = (raw, pattern) => assert.throws(() => validateInventory(raw), (err) => err instanceof InventoryError && pattern.test(err.message));

test('no reviewers block gives an empty reviewers object and no review on targets', () => {
  const inv = validateInventory({ ssh: [ssh()] });
  assert.deepEqual(inv.reviewers, {});
  assert.equal(Object.hasOwn(inv.ssh[0], 'review'), false);
});

test('a reviewer gets defaults and a trailing slash', () => {
  const inv = validateInventory({ reviewers: { local: { baseUrl: 'http://localhost:11434/v1', model: 'm' } } });
  assert.deepEqual(inv.reviewers.local, {
    name: 'local', baseUrl: 'http://localhost:11434/v1/', model: 'm', keyEnv: null, timeoutSeconds: 10, maxCalls: 200,
  });
});

test('explicit timeoutSeconds and maxCalls are kept', () => {
  const inv = validateInventory({ reviewers: { a: { baseUrl: 'https://x/v1/', model: 'm', timeoutSeconds: 30, maxCalls: 5 } } });
  assert.equal(inv.reviewers.a.timeoutSeconds, 30);
  assert.equal(inv.reviewers.a.maxCalls, 5);
  assert.equal(inv.reviewers.a.baseUrl, 'https://x/v1/');
});

test('a review on an ssh and a kubernetes target is kept, accept defaults to sure', () => {
  const inv = validateInventory({
    reviewers,
    ssh: [ssh({ review: { reviewer: 'groq', policy: ' read only ' } })],
    kubernetes: [{
      name: 'lab', kubeconfig: '/tmp/k.yaml', proxyPort: 8001, allow: [],
      review: { reviewer: 'groq', policy: 'read only', accept: ['sure', 'likely'] },
    }],
  });
  assert.deepEqual(inv.ssh[0].review, { reviewer: 'groq', policy: 'read only', accept: ['sure'] });
  assert.deepEqual(inv.kubernetes[0].review.accept, ['sure', 'likely']);
});

test('reviewer fields are validated', () => {
  const r = (entry) => ({ reviewers: { a: entry } });
  fails({ reviewers: [] }, /reviewers: must be an object/);
  fails({ reviewers: { 'Bad Name': {} } }, /reviewer "Bad Name": name/);
  fails(r('x'), /reviewer "a": must be an object/);
  fails(r({ baseUrl: 'https://x/v1', model: 'm', extra: 1 }), /unknown key "extra"/);
  fails(r({ model: 'm' }), /baseUrl: must be a URL/);
  fails(r({ baseUrl: 'not a url', model: 'm' }), /baseUrl: must be a URL/);
  fails(r({ baseUrl: 'ftp://localhost/v1', model: 'm' }), /baseUrl: must use http or https$/);
  fails(r({ baseUrl: 'ws://review.example.com/v1', model: 'm' }), /baseUrl: must use http or https$/);
  fails(r({ baseUrl: 'https://user:pw@x/v1', model: 'm' }), /baseUrl: must not contain/);
  fails(r({ baseUrl: 'https://x/v1?k=1', model: 'm' }), /baseUrl: must not contain/);
  fails(r({ baseUrl: 'https://x/v1' }), /model: must be/);
  fails(r({ baseUrl: 'https://x/v1', model: 'has space' }), /model: must be/);
  fails(r({ baseUrl: 'https://x/v1', model: 'm', keyEnv: 'lower' }), /keyEnv: must be/);
  fails(r({ baseUrl: 'https://x/v1', model: 'm', keyEnv: 'KSPROXY_KEY' }), /keyEnv: must be/);
  fails(r({ baseUrl: 'https://x/v1', model: 'm', timeoutSeconds: 0 }), /timeoutSeconds: must be an integer from 1 to 60/);
  fails(r({ baseUrl: 'https://x/v1', model: 'm', maxCalls: 1.5 }), /maxCalls: must be an integer from 1 to 100000/);
});

test('keyEnv may not name a variable the session needs', () => {
  const r = (keyEnv) => ({ reviewers: { a: { baseUrl: 'https://x/v1', model: 'm', keyEnv } } });
  const names = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'DISPLAY',
    'KUBECONFIG', 'LC_ALL', 'LC_', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'XDG_CONFIG_HOME',
  ];
  for (const name of names) {
    fails(r(name), /^reviewer "a": keyEnv: .*must hold only the key/);
  }
  for (const name of ['GROQ_API_KEY', 'PATHS', 'MY_HOME', 'LC', 'SSH', 'NODEKEY', 'TERM_KEY']) {
    assert.equal(validateInventory(r(name)).reviewers.a.keyEnv, name);
  }
});

test('http is accepted for any host: for the three local hosts and for another host', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'review.example.com', '192.0.2.10']) {
    const inv = validateInventory({ reviewers: { a: { baseUrl: `http://${host}:1234/v1`, model: 'm' } } });
    assert.equal(inv.reviewers.a.baseUrl, `http://${host}:1234/v1/`);
  }
});

test('review fields are validated', () => {
  const withReview = (review, extra = {}) => ({ reviewers, ssh: [ssh({ review, ...extra })] });
  fails(withReview('x'), /ssh "web1": review: must be an object/);
  fails(withReview({ reviewer: 'groq', policy: 'p', extra: 1 }), /review: unknown key "extra"/);
  fails(withReview({ reviewer: 'groq', policy: 'p' }, { allow: 'any' }), /review: has no effect with allow: "any"/);
  fails(withReview({ reviewer: 'nobody', policy: 'p' }), /review\.reviewer: must name an entry of "reviewers"/);
  fails(withReview({ reviewer: 'groq' }), /review\.policy: must be 1 to 1000 characters/);
  fails(withReview({ reviewer: 'groq', policy: '   ' }), /review\.policy/);
  fails(withReview({ reviewer: 'groq', policy: 'x'.repeat(1001) }), /review\.policy/);
  for (const accept of ['sure', [], ['unsure'], ['sure', 'sure']]) {
    fails(withReview({ reviewer: 'groq', policy: 'p', accept }), /review\.accept: must be a list of "sure" and "likely"/);
  }
});

test('a local review needs a list of programs, and only a local review may have one', () => {
  const local = (review) => ({ reviewers, local: [{ name: 'repo', cwd: '/tmp/repo', allow: ['ls'], review }] });
  const inv = validateInventory(local({ reviewer: 'groq', policy: 'p', programs: ['git', './run.sh'] }));
  assert.deepEqual(inv.local[0].review, {
    reviewer: 'groq', policy: 'p', accept: ['sure'], programs: ['git', './run.sh'],
  });
  const bad = /review\.programs: must be a list of 1 to 50 program names/;
  fails(local({ reviewer: 'groq', policy: 'p' }), bad);
  for (const programs of ['git', [], ['git', 'git'], ['-x'], ['*'], ['...'], ['a b'], [1], Array(51).fill(0).map((v, i) => `p${i}`)]) {
    fails(local({ reviewer: 'groq', policy: 'p', programs }), bad);
  }
  fails({ reviewers, ssh: [ssh({ review: { reviewer: 'groq', policy: 'p', programs: ['git'] } })] }, /review\.programs: is only for local targets/);
});
