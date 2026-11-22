import { DEFAULT_OUTPUT_KIB, outputKiB } from './checks.js';
import { KINDS, kindByKey } from './kinds/index.js';

// The agent runs node itself, so the flag of the shebang of bin/ksproxy.js is given here too: SIGUSR1 never opens the
// inspector of ksproxy mcp, not even in the first milliseconds, before the bin adds its listener.
export const NODE_FLAGS = ['--disable-sigusr1'];

// The MCP server of a project is started with --project NAME, so that it reads that project's session only.
export function mcpConfig(nodePath, binPath, project = null) {
  const args = [...NODE_FLAGS, binPath, 'mcp', ...(project === null ? [] : ['--project', project])];
  return { mcpServers: { 'ksproxy': { command: nodePath, args } } };
}

// One line under the section of a target whose output limit is not the default, else none.
function outputLine(target) {
  const kib = outputKiB(target);
  return kib === DEFAULT_OUTPUT_KIB ? '' : `\n- Output is cut at ${kib} KiB per stream for this target.`;
}

export function agentMdText(session) {
  const sections = session.targets.map((t) => `${kindByKey(t.kind).agentSection(t)}${outputLine(t)}`);
  return [
    session.project === undefined ? '# ksproxy session' : `# ksproxy session: project ${session.project}`,
    '',
    'The user has opened the servers, clusters and folders below for you. You reach them only through the ksproxy MCP tools. Call `list_targets` first to see what is open right now.',
    '',
    '## Tools',
    '',
    '- `list_targets` - the open targets, their state and their allowed commands.',
    ...KINDS.filter((kind) => kind.brokered !== true || session.targets.some((t) => t.kind === kind.key))
      .map((kind) => kind.toolBullet),
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
