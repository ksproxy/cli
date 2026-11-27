// Network access (docs/NETWORK-ACCESS.md): start listens on the runner's address on the compose network, and the
// container peer calls /mcp with the token that start showed once on its terminal, then with a wrong token and with
// none.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { clip, waitFor } from './lib.js';

const REQUEST = '/handoff/request.json';
const RESULT = '/handoff/result.json';

const parsed = (step) => {
  try {
    return JSON.parse(step.text);
  } catch {
    return null;
  }
};
const toolText = (step) => parsed(step)?.result?.content?.map((part) => part.text).join('\n') ?? '';

export async function listenScenario({ checks, session }) {
  checks.begin('network access: a second container with the token');
  const wrong = `ksp_${randomBytes(24).toString('base64url')}`;
  fs.writeFileSync(`${REQUEST}.part`, JSON.stringify({ url: session.listenUrl, token: session.token, wrong }), { mode: 0o600 });
  fs.renameSync(`${REQUEST}.part`, REQUEST);
  const result = await waitFor(() => fs.existsSync(RESULT) && JSON.parse(fs.readFileSync(RESULT, 'utf8')), {
    ms: 120000, what: 'the answers of the peer container',
  });
  fs.rmSync(RESULT);
  const { steps } = result;
  const peer = result.addresses[0];
  session.peerAddress = peer;
  session.peerAnswers = Object.values(steps).map((step) => step.text);

  const init = parsed(steps.initialize);
  checks.check('initialize with the token', steps.initialize.status === 200 && init?.result?.serverInfo?.name === 'ksproxy', clip(steps.initialize.text));
  checks.check('the notification is accepted with 202', steps.initialized.status === 202, `${steps.initialized.status} ${clip(steps.initialized.text)}`);
  const names = parsed(steps.list)?.result?.tools?.map((tool) => tool.name) ?? [];
  checks.check('tools/list has the tools of the session', names.includes('ssh_exec') && names.includes('everything-net__echo'), clip(steps.list.text));
  const ssh = toolText(steps.ssh);
  checks.check('allowed: ssh_exec web1 uptime', steps.ssh.status === 200 && ssh.startsWith('exit code: 0') && ssh.includes('load average'), clip(steps.ssh.text));
  const pg = toolText(steps.postgres);
  checks.check('allowed: select * from orders where id = 7 on shop-db', steps.postgres.status === 200 && pg.includes('7|7|'), clip(steps.postgres.text));
  const refused = toolText(steps.refused);
  checks.check('refused: systemctl restart nginx, as on stdio', refused.startsWith('REFUSED (ssh web1): not on the allowlist'), clip(steps.refused.text));
  checks.check('a wrong token gets 401', steps.wrongToken.status === 401, `${steps.wrongToken.status} ${clip(steps.wrongToken.text)}`);
  checks.check('no token gets 401', steps.noToken.status === 401, `${steps.noToken.status} ${clip(steps.noToken.text)}`);

  const terminal = () => session.output();
  await waitFor(() => terminal().includes(`[listen] ${peer} e2e-peer`) && terminal().includes(`refused 1 wrong token from ${peer}`), {
    ms: 10000, what: 'the listener lines on the terminal',
  }).catch(() => {});
  checks.check('the terminal names the client that connected', terminal().includes(`[listen] ${peer} e2e-peer`) && terminal().includes('connected'),
    clip(terminal().split('\n').filter((line) => line.includes('[listen]')).join('\n'), 2000));
  checks.check('the terminal names the address of the wrong token', terminal().includes(`refused 1 wrong token from ${peer}`),
    clip(terminal().split('\n').filter((line) => line.includes('[listen]')).join('\n'), 2000));

  const entries = session.auditEntries().filter((entry) => entry.from === peer);
  const calls = entries.filter((entry) => entry.event === 'call');
  checks.check(
    'the audit log has the three calls from the peer\'s address',
    calls.length === 3 && calls.filter((entry) => entry.decision === 'allowed').length === 2,
    clip(JSON.stringify(entries, null, 1), 2000),
  );
}
