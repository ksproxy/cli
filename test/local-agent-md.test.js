import test from 'node:test';
import assert from 'node:assert/strict';
import { agentMdText } from '../src/agent-md.js';

const LOCAL = {
  kind: 'local',
  name: 'infra',
  description: 'terraform repo',
  allow: ['git status', 'terraform plan'],
  cwd: '/Users/someone/projects/infra',
  path: '/usr/bin:/bin',
  state: 'up',
};

test('the guide names local_exec, the allowed commands and the two fixed rules, and never the folder', () => {
  const text = agentMdText({ targets: [LOCAL] });
  assert.match(text, /^### Local folder `infra` - terraform repo$/m);
  assert.ok(text.includes('- `local_exec { target, command, timeout_seconds? }` - run one command on this machine in a target\'s folder.'));
  assert.ok(text.includes('- Tool: `local_exec` with `target: "infra"`'));
  assert.ok(text.includes('- Allowed commands: git status; terraform plan'));
  assert.ok(text.includes('- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax; no shell runs it.'));
  assert.ok(text.includes('- `*` in a rule matches exactly one plain argument and `...` any number of them: a name or relative path made of letters, digits and `_ . / -`, not starting with `-`. A wildcard never matches a flag (`-n`, `--oneline`, `--flag=value`); flags and anything else are refused unless the user wrote them into a rule literally.'));
  assert.ok(text.includes('- Every plain argument is resolved with links followed and must stay inside the target\'s folder; `..`, links that lead out and links that cannot be resolved are refused.'));
  assert.ok(text.includes('- The first word of a command is the program, named by the rules. ksproxy\'s own files are always refused.'));
  assert.ok(text.includes('An argument longer than 512 bytes is refused.'));
  assert.ok(!text.includes('1000 bytes'));
  assert.ok(text.includes('- A bare program name is found through the user\'s absolute PATH entries only; a file in this folder is never found by name, so a rule that runs one names it with its path (for example `./run.sh`).'));
  assert.ok(!text.includes('/Users/someone'));
  assert.ok(!text.includes('/usr/bin:/bin'));
  assert.ok(!text.includes('Connection state'));
});

test('a heading without a description is plain, and a stray allowOutsidePaths in the session changes nothing', () => {
  const text = agentMdText({ targets: [{ ...LOCAL, description: '', allowOutsidePaths: true }] });
  assert.match(text, /^### Local folder `infra`$/m);
  assert.ok(!text.includes('outside the target'));
  assert.ok(text.includes('must stay inside the target\'s folder'));
  assert.equal(text, agentMdText({ targets: [{ ...LOCAL, description: '' }] }));
});

test('an empty allowlist is described, and a folder that is down is reported', () => {
  const text = agentMdText({ targets: [{ ...LOCAL, allow: [], state: 'down' }] });
  assert.ok(text.includes('- Allowed commands: nothing (empty allowlist)'));
  assert.ok(text.includes('- The folder is not available (`down`): calls may fail until the user fixes it.'));
});

test('the guide and its off-limits list cover all three kinds', () => {
  const text = agentMdText({
    targets: [
      { kind: 'ssh', name: 'web1', description: '', allow: ['uptime'] },
      LOCAL,
    ],
  });
  assert.ok(text.includes('servers, clusters and folders below'));
  assert.ok(text.includes('no shell syntax in ssh or local commands'));
  assert.ok(text.includes('Do not run `ssh`, `kubectl`, `curl` or any other program to reach these targets yourself'));
});
