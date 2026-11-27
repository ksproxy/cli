import { DEFAULT_OUTPUT_KIB, END_PART_KIB, outputKiB } from './checks.js';
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

// The section on cut output: the limit, the cut line, the end part of ssh, kubernetes and local, what a brokered call
// shows and loses, and the hint of each kind with a target in the
// session, once for each text, after the tools of the kinds that give it.
function cutSection(session) {
  const hints = new Map();
  for (const kind of KINDS) {
    if (kind.cutHint === undefined || !session.targets.some((t) => t.kind === kind.key)) continue;
    hints.set(kind.cutHint, [...(hints.get(kind.cutHint) ?? []), `\`${kind.tool.name}\``]);
  }
  return [
    '## When output is cut',
    '',
    `- Each stream of a call is cut at ${DEFAULT_OUTPUT_KIB} KiB, or at the limit that its target names above. The answer then says so in a line right after the exit code.`,
    `- On an ssh server, a Kubernetes cluster or a local folder, the line says how much of the stream the answer shows, and the answer also shows the last ${END_PART_KIB} KiB of the stream, after a line such as \`[... 9.1 MiB cut here ...]\`. The sizes are close, not exact.`,
    `- On every other target, the answer shows the start of the stream up to the limit, with no end part, and the line says \`cut at ${DEFAULT_OUTPUT_KIB} KiB: the rest was left out\`.`,
    '- On those other targets, a call that did not end on its own (the time limit, a reply that broke off, a program stopped at the limit) also loses the end of each stream: its last 1 KiB at least, back to the end of a line, so a short output is not shown at all. The line then says `its end was left out`. Make such a call end on its own, for example with a limit on what it reads or a shorter wait of its own.',
    '- Narrow the call rather than reading more of its output. These are hints only: the rules of each target still decide what may run.',
    ...[...hints].map(([hint, tools]) => `  - ${tools.join(', ')}: ${hint}`),
    '',
  ];
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
    ...cutSection(session),
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
