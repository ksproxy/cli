import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_TEXT, askModel, buildRequest, judge, parseAnswer,
} from '../src/review.js';

const reviewer = { name: 'r', baseUrl: 'https://api.example.com/v1/', model: 'm-1', keyEnv: 'K', timeoutSeconds: 1, maxCalls: 5 };
const review = { reviewer: 'r', policy: 'read only', accept: ['sure'] };
const subject = { kind: 'ssh', name: 'web1', argv: ['uptime', '-p'] };
const reply = (content, init = {}) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, ...init });
const good = '{"verdict":"allow","certainty":"sure","reason":"shows uptime"}';

test('the request holds only the model and two messages, with the command as data', () => {
  const body = buildRequest(reviewer, review, subject);
  assert.deepEqual(Object.keys(body), ['model', 'messages']);
  assert.equal(body.model, 'm-1');
  assert.deepEqual(body.messages[0], { role: 'system', content: SYSTEM_TEXT });
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    policy: 'read only', target: { kind: 'ssh', name: 'web1' }, command: ['uptime', '-p'],
  });
});

test('the instructions say that a word written as ?name=value is the query of an HTTP request', () => {
  assert.ok(SYSTEM_TEXT.includes('\n- For an HTTP request the command is the method and one word per path segment; each word that starts with ? is one name and value of the query of the request, written as ?name=value.\n'));
});

test('parseAnswer accepts the object alone or wrapped in text, and tidies the reason', () => {
  assert.deepEqual(parseAnswer(good), { verdict: 'allow', certainty: 'sure', reason: 'shows uptime' });
  assert.deepEqual(parseAnswer(`\`\`\`json\n${good}\n\`\`\``).verdict, 'allow');
  assert.equal(parseAnswer('{"verdict":"refuse","certainty":"unsure","reason":" a\\n  b "}').reason, 'a b');
  assert.equal(parseAnswer('{"verdict":"refuse","certainty":"sure"}').reason, '');
  assert.equal(parseAnswer(`{"verdict":"allow","certainty":"sure","reason":"${'x'.repeat(300)}"}`).reason.length, 120);
});

test('parseAnswer returns null for anything else', () => {
  for (const text of [undefined, 42, '', 'allow', '}{', '{not json}', '{"verdict":"yes","certainty":"sure"}', '{"verdict":"allow","certainty":"very"}']) {
    assert.equal(parseAnswer(text), null);
  }
});

test('askModel posts to chat/completions with the key and returns the answer', async () => {
  const seen = [];
  const result = await askModel(reviewer, 'secret-key', review, subject, async (url, init) => {
    seen.push({ url: String(url), init });
    return reply(good);
  });
  assert.deepEqual(result, { ok: true, answer: { verdict: 'allow', certainty: 'sure', reason: 'shows uptime' } });
  assert.equal(seen[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(seen[0].init.body), buildRequest(reviewer, review, subject));
  assert.equal(seen[0].init.signal.aborted, true);
});

test('askModel sends no authorization header without a key', async () => {
  let headers;
  await askModel(reviewer, null, review, subject, async (url, init) => {
    headers = init.headers;
    return reply(good);
  });
  assert.equal(Object.hasOwn(headers, 'authorization'), false);
});

test('askModel reports every failure as a problem without leaking the key', async () => {
  const run = (fetchImpl) => askModel(reviewer, 'secret-key', review, subject, fetchImpl);
  const timeout = Object.assign(new Error('late'), { name: 'TimeoutError' });
  assert.deepEqual(await run(async () => { throw timeout; }), { ok: false, problem: 'reviewer timed out' });
  assert.deepEqual(await run(async () => { throw new Error('secret-key refused'); }), { ok: false, problem: 'reviewer unreachable' });
  assert.deepEqual(await run(async () => { throw null; }), { ok: false, problem: 'reviewer unreachable' });
  assert.deepEqual(await run(async () => new Response('no', { status: 401 })), { ok: false, problem: 'reviewer answered HTTP 401' });
  assert.deepEqual(await run(async () => new Response('not json')), { ok: false, problem: 'reviewer answer unreadable' });
  assert.deepEqual(await run(async () => new Response(null)), { ok: false, problem: 'reviewer answer unreadable' });
  assert.deepEqual(await run(async () => new Response('x'.repeat(70000))), { ok: false, problem: 'reviewer answer too large' });
  assert.deepEqual(await run(async () => new Response('{}')), { ok: false, problem: 'reviewer answer unusable' });
  assert.deepEqual(await run(async () => reply('maybe')), { ok: false, problem: 'reviewer answer unusable' });
});

test('askModel stops reading an answer that never ends at the size limit', async () => {
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));
    },
    cancel() { cancelled = true; },
  });
  const result = await askModel(reviewer, null, review, subject, async () => new Response(endless));
  assert.deepEqual(result, { ok: false, problem: 'reviewer answer too large' });
  assert.ok(pulled < 20);
  assert.equal(cancelled, true);
});

test('askModel really stops at the timeout', async () => {
  const result = await askModel({ ...reviewer, timeoutSeconds: 1 }, null, review, subject, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  assert.deepEqual(result, { ok: false, problem: 'reviewer timed out' });
});

test('askModel stops at the timeout even when fetch ignores the signal', async () => {
  const started = Date.now();
  const result = await askModel({ ...reviewer, timeoutSeconds: 1 }, null, review, subject, () => new Promise(() => {}));
  assert.deepEqual(result, { ok: false, problem: 'reviewer timed out' });
  assert.ok(Date.now() - started < 5000);
});

test('askModel stops when the stop signal fires, and does not start when it already has', async () => {
  const stop = new AbortController();
  let seen;
  const waiting = askModel({ ...reviewer, timeoutSeconds: 30 }, null, review, subject, (url, init) => {
    seen = init.signal;
    stop.abort();
    return new Promise(() => {});
  }, stop.signal);
  assert.deepEqual(await waiting, { ok: false, problem: 'review stopped' });
  assert.equal(seen.aborted, true);
  let called = false;
  const late = await askModel(reviewer, null, review, subject, async () => { called = true; return reply(good); }, stop.signal);
  assert.deepEqual(late, { ok: false, problem: 'review stopped' });
  assert.equal(called, false);
});

test('judge approves only an allow whose certainty is accepted', () => {
  const answer = (verdict, certainty, reason = 'why') => ({ ok: true, answer: { verdict, certainty, reason } });
  assert.deepEqual(judge(answer('allow', 'sure'), ['sure']), { allowed: true, certainty: 'sure', reason: 'why' });
  assert.deepEqual(judge(answer('allow', 'likely'), ['sure', 'likely']), { allowed: true, certainty: 'likely', reason: 'why' });
  assert.deepEqual(judge(answer('allow', 'likely'), ['sure']), {
    allowed: false, certainty: 'likely', reason: 'why', short: 'model only likely: why',
  });
  assert.equal(judge(answer('allow', 'unsure', ''), ['sure', 'likely']).short, 'model only unsure');
  assert.equal(judge(answer('allow', 'unsure'), ['sure', 'likely', 'unsure']).allowed, false);
  assert.equal(judge(answer('refuse', 'sure'), ['sure']).short, 'model refused: why');
  assert.deepEqual(judge({ ok: false, problem: 'reviewer timed out' }, ['sure']), {
    allowed: false, short: 'review failed: reviewer timed out',
  });
});
