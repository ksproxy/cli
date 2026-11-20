import { describeAllow } from './allowlist.js';

export function mcpConfig(nodePath, binPath) {
  return { mcpServers: { 'ksproxy': { command: nodePath, args: [binPath, 'mcp'] } } };
}

function sshSection(target) {
  const lines = [
    `### ssh server \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
    '',
    `- Tool: \`ssh_exec\` with \`server: "${target.name}"\``,
    `- Allowed commands: ${describeAllow(target.allow)}`,
  ];
  if (target.allow !== 'any') {
    lines.push('- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax.');
    lines.push('- `*` in a rule matches exactly one argument that does not start with `-`; `...` matches any remaining arguments.');
  }
  return lines.join('\n');
}

function kubeSection(target) {
  const lines = [
    `### Kubernetes cluster \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
    '',
    `- Tool: \`kubectl\` with \`cluster: "${target.name}"\``,
    `- Allowed commands: ${describeAllow(target.allow)}`,
    '- Pass `args` as an array with the verb first, one element per argument, for example `["get","pods","-n","web"]`.',
    '- Write short flags separately (`-o json`, not `-ojson`).',
    '- kubectl takes the verb first and only a fixed set of flags; any other verb or flag is refused. Output formats are `json`, `yaml`, `wide`, `name`, `jsonpath=...`, `jsonpath-as-json=...` and `custom-columns=...`.',
  ];
  if (target.manifestRoots.length > 0) {
    lines.push(`- \`-f\` and \`--patch-file\` each take one regular file (not a directory) inside:${target.manifestRoots.join(', ')}`);
  } else {
    lines.push('- File flags (`-f`, `--patch-file`) are refused: this cluster has no manifest folders configured.');
  }
  if (target.state !== 'up') {
    lines.push(`- Connection state is \`${target.state}\`: calls may fail until the user fixes it.`);
  }
  return lines.join('\n');
}

function localSection(target) {
  const lines = [
    `### Local folder \`${target.name}\`${target.description ? ` - ${target.description}` : ''}`,
    '',
    `- Tool: \`local_exec\` with \`target: "${target.name}"\``,
    `- Allowed commands: ${describeAllow(target.allow)}`,
    '- A command is plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes, pipes, redirects, variables or other shell syntax; no shell runs it.',
    '- `*` in a rule matches exactly one plain argument and `...` any number of them: a name or relative path made of letters, digits and `_ . / -`, not starting with `-`. A wildcard never matches a flag (`-n`, `--oneline`, `--flag=value`); flags and anything else are refused unless the user wrote them into a rule literally.',
    '- Every plain argument is resolved with links followed and must stay inside the target\'s folder; `..`, links that lead out and links that cannot be resolved are refused.',
    '- The first word of a command is the program, named by the rules. ksproxy\'s own files are always refused. An argument longer than 512 bytes is refused.',
    '- A bare program name is found through the user\'s absolute PATH entries only; a file in this folder is never found by name, so a rule that runs one names it with its path (for example `./run.sh`).',
  ];
  if (target.state !== 'up') {
    lines.push(`- The folder is not available (\`${target.state}\`): calls may fail until the user fixes it.`);
  }
  return lines.join('\n');
}

const SECTIONS = { ssh: sshSection, kubernetes: kubeSection, local: localSection };

export function agentMdText(session) {
  const sections = session.targets.map((t) => SECTIONS[t.kind](t));
  return [
    '# ksproxy session',
    '',
    'The user has opened the servers, clusters and folders below for you. You reach them only through the ksproxy MCP tools. Call `list_targets` first to see what is open right now.',
    '',
    '## Tools',
    '',
    '- `list_targets` - the open targets, their state and their allowed commands.',
    '- `ssh_exec { server, command, timeout_seconds? }` - run one command on an ssh server.',
    '- `kubectl { cluster, args, timeout_seconds? }` - run kubectl against a cluster.',
    '- `local_exec { target, command, timeout_seconds? }` - run one command on this machine in a target\'s folder.',
    '',
    'Every call is checked against the target\'s allowlist and written to an audit log that the user is watching. A refused call tells you what is allowed.',
    '',
    '## Open targets',
    '',
    sections.join('\n\n'),
    '',
    '## Off limits',
    '',
    '- Do not run `ssh`, `kubectl`, `curl` or any other program to reach these targets yourself; use the tools above.',
    '- Do not read or change anything in this folder, the ksproxy state folder or the ksproxy configuration folder.',
    '- Do not try to widen your access: no shell syntax in ssh or local commands, no identity or cluster flags, no secret resources, no exec, attach, cp, port-forward or proxy.',
    '- Command output is returned to you as written. Do not print credentials you happen to find.',
    '- If a command you need is not allowed, say so and ask the user; do not look for a way around the list.',
    '',
  ].join('\n');
}
