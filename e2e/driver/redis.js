// The redis examples of docs/EXAMPLES.md against Redis 7 over TLS on port 6380, with an ACL user for each target:
// e2e-cache-reader may run the read commands of cache on session: keys only, and e2e-cache-ops the commands of
// cache-ops, writing cache:page: keys and feature:new-checkout only. ksproxy speaks the protocol itself. The seed is in
// e2e/images/cache/start.sh. The command statistics of the server (INFO commandstats, which the rule "INFO ..."
// allows) show which commands reached it.
import { clip } from './lib.js';

const SESSIONS = ['session:7f3a', 'session:9b1c', 'session:c0de', 'session:7f3a:cart'];

export async function redisScenario({ checks, agent }) {
  const run = (target, command) => agent.call('redis_command', { target, command });
  const allowed = async (target, command, expect, name = `allowed: ${command}`) => {
    const answer = await run(target, command);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, command, why, reason) => {
    const answer = await run(target, command);
    checks.check(`refused: ${command} (${why})`, answer.isError && answer.text.startsWith(`REFUSED (redis ${target}): ${reason}`), clip(answer.text));
    return answer;
  };

  checks.begin('redis: cache, read only (e2e-cache-reader)');
  await allowed('cache', 'GET session:7f3a', (text) => text.includes('"user:42"'));
  await allowed('cache', 'TTL session:7f3a', (text) => {
    const seconds = Number(/\(integer\) (\d+)/.exec(text)?.[1]);
    return seconds > 0 && seconds <= 3600;
  });
  await allowed('cache', 'HGETALL session:7f3a:cart', (text) => text.includes('"sku-1042"') && text.includes('"sku-7"'));
  await allowed('cache', 'SCAN 0 MATCH session:* COUNT 100', (text) => SESSIONS.every((key) => text.includes(`"${key}"`))
    && !text.includes('cache:page') && !text.includes('feature:'));
  await allowed('cache', 'INFO server', (text) => text.includes('redis_version:7.'));
  await refused('cache', 'DEL session:7f3a', 'no rule allows DEL', 'not on the allowlist');
  // The rule GET * lets the call through; the ACL of the user, which may read session: keys only, stops it.
  const page = await run('cache', 'GET cache:page:home');
  checks.check(
    'the server refuses GET cache:page:home: the ACL of the user allows session: keys only',
    page.isError && page.text.startsWith('exit code: 1') && page.text.includes('(error) NOPERM'),
    clip(page.text),
  );

  checks.begin('redis: cache-ops, may clear pages and switch new-checkout (e2e-cache-ops)');
  await allowed('cache-ops', 'GET feature:new-checkout', (text) => text.includes('"off"'));
  await allowed('cache-ops', 'SET feature:new-checkout on', (text) => text.includes('--- stdout ---\nOK'));
  await allowed('cache-ops', 'GET feature:new-checkout', (text) => text.includes('"on"'), 'the flag is now on');
  await allowed('cache-ops', 'DEL cache:page:home', (text) => text.includes('(integer) 1'));
  await allowed('cache-ops', 'GET cache:page:home', (text) => text.includes('(nil)'), 'the page is gone');
  await refused('cache-ops', 'DEL session:7f3a', 'the pattern allows cache:page: keys only', 'not on the allowlist');
  await refused('cache-ops', 'FLUSHDB', 'never allowed on a redis target', 'FLUSHDB is never allowed on a redis target');
  await allowed('cache', 'GET session:7f3a', (text) => text.includes('"user:42"'), 'the refused calls changed nothing: session:7f3a is still there');
  await allowed('cache-ops', 'GET cache:page:about', (text) => text.includes('"cached-about-page"'), 'the other page is still there');

  checks.begin('redis: the command statistics of the server');
  const stats = await allowed('cache', 'INFO commandstats', (text) => text.includes('cmdstat_get:'));
  checks.check('only the allowed DEL reached the server (calls=1)', /cmdstat_del:calls=1,/.test(stats.text), clip(stats.text, 2000));
  checks.check('FLUSHDB never reached the server', !/cmdstat_flushdb:/.test(stats.text), clip(stats.text, 2000));
  checks.check('the server counted the GET that the ACL refused', /cmdstat_get:calls=\d+,usec=\d+,usec_per_call=[\d.]+,rejected_calls=1,/.test(stats.text), clip(stats.text, 2000));
}
