// The ssh examples of docs/EXAMPLES.md against the container web1, and jumps (docs/JUMPS.md) to app1, which only web1
// reaches. The rules are those of the examples. The server has no systemd, journald, nginx or sudo, so the allowed
// calls are the ones it can answer (uptime, df, free, tail of a seeded nginx log); the refused calls are those of the
// docs, word for word, since a refused call never reaches the server. The seeded log is long (see
// e2e/images/server/Dockerfile), so reading all of it gives a cut answer.
import dns from 'node:dns/promises';
import { clip } from './lib.js';

const REFUSED = (target) => `REFUSED (ssh ${target}): `;
const NO_RULE = 'not on the allowlist';
// The seeded log: 6345599 bytes, 6.1 MiB, ending in the last line of e2e/images/server/error.log.
const LOG_LAST_LINE = '2026/11/20 09:30:00 [notice] 1#1: signal 1 (SIGHUP) received from 412, reconfiguring';
const CUT_HEAD = [
  'exit code: 0',
  '[stdout cut: showing 256 KiB of 6.1 MiB]',
  'narrow it: tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first',
  '--- stdout ---',
  '',
].join('\n');

export async function sshScenario({ checks, agent }) {
  checks.begin('ssh: web1, read only');
  const run = (server, command) => agent.call('ssh_exec', { server, command });
  const allowed = async (server, command, expect, name = `allowed: ${command}`) => {
    const answer = await run(server, command);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (server, command, why, reason = NO_RULE) => {
    const answer = await run(server, command);
    checks.check(`refused: ${command} (${why})`, answer.isError && answer.text.startsWith(`${REFUSED(server)}${reason}`), clip(answer.text));
    return answer;
  };

  await allowed('web1', 'uptime', (text) => text.includes('load average'));
  await allowed('web1', 'df -h', (text) => text.includes('Filesystem'));
  await allowed('web1', 'free -m', (text) => text.includes('Mem:'));
  // The docs' allowed call is journalctl -u nginx -n 200 --no-pager; the container keeps the nginx log in a file.
  await allowed('web1', 'tail -n 2 /var/log/nginx/error.log', (text) => text.includes('Connection refused')
    && text.includes('signal 1 (SIGHUP)') && !text.includes('favicon.ico'));
  await refused('web1', 'systemctl restart nginx', 'no rule allows a restart');
  await refused('web1', 'systemctl status --all', '* never matches a flag');

  checks.begin('ssh: web1, an answer past the output limit');
  const long = await run('web1', 'tail -n 100000 /var/log/nginx/error.log');
  checks.check(
    'a long log: the line after the exit code gives its total size, then the hint of ssh',
    !long.isError && long.text.startsWith(CUT_HEAD),
    clip(long.text),
  );
  checks.check(
    'a long log: its first part, the cut marker, then its last 16 KiB up to the last line of the file',
    long.text.startsWith(`${CUT_HEAD}2026/11/19 08:00:00 [warn] 31#31: *`) && /\n\[\.\.\. 5\.8 MiB cut here \.\.\.\]\n2026\//.test(long.text)
      && long.text.endsWith(`\n${LOG_LAST_LINE}`) && Buffer.byteLength(long.text) - CUT_HEAD.length <= 256 * 1024,
    clip(long.text.slice(-700)),
  );

  checks.begin('ssh: web1-ops, read and write');
  await allowed('web1-ops', 'uptime', (text) => text.includes('load average'));
  // Allowed by the rules and sent to web1, where the login has no sudo: the account is the boundary.
  const reload = await run('web1-ops', 'sudo systemctl reload nginx');
  checks.check(
    'allowed: sudo systemctl reload nginx (reaches web1, where the login has no sudo)',
    reload.isError && reload.text.startsWith('exit code: 127') && reload.text.includes('sudo: command not found'),
    clip(reload.text),
  );
  await refused('web1-ops', 'sudo systemctl restart postgresql', 'the rules name nginx only');

  checks.begin('ssh: app1 through web1 (jumps)');
  const direct = await dns.lookup('app1').then((found) => found.address, (err) => err.code);
  checks.check('app1 is not reachable from the runner, only from web1', direct === 'ENOTFOUND' || direct === 'EAI_AGAIN', `app1 resolved to ${direct}`);
  await allowed('app1', 'hostname', (text) => /^--- stdout ---\napp1$/m.test(text), 'allowed: hostname runs on app1, through web1');
  await allowed('app1', 'uptime', (text) => text.includes('load average'));
  const restart = await refused('app1', 'systemctl restart nginx', 'no rule allows a restart');
  checks.check('the refusal does not show the jump', !restart.text.includes('app_key') && !restart.text.includes('opsuser'), clip(restart.text));
  await refused('app1', 'hostname a==b', 'a word with == on a target with jumps', 'a word may not start with "=" or contain "=="');
  const listed = await agent.call('list_targets');
  checks.check(
    'list_targets shows app1 without its jump',
    !listed.isError && listed.text.includes('"app1"') && !listed.text.includes('app_key') && !listed.text.includes('opsuser'),
    clip(listed.text, 2000),
  );
}
