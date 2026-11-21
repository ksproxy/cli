import path from 'node:path';
import {
  AllowError, checkRawSshCommand, decide, describeAllow, tokenizeSshCommand,
} from '../../allowlist.js';
import {
  InventoryError, checkAllow, checkHost, checkKeys, checkReview,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import { socketPath, sshBin } from '../../paths.js';
import {
  MAX_JUMPS, checkMaster, closeMaster, closeStaleSockets, execArgs, jumpPrefix, openMaster, parseJump, sshConfigText,
  zshEqualsWord,
} from './master.js';
import { REVIEWED } from '../shared.js';

const SSH_KEYS = ['name', 'host', 'jumps', 'description', 'allow', 'review'];

function decideSsh(target, input) {
  const jumped = target.jumps !== undefined;
  const prefix = jumpPrefix(target.jumps);
  if (prefix === null) {
    return {
      allowed: false,
      reason: 'this target\'s jumps are not usable; ask the user to restart ksproxy start',
      short: 'jumps not usable',
    };
  }
  if (jumped && target.allow === 'any') {
    return { allowed: false, reason: 'a target with jumps needs a list of rules, not "any"', short: 'allowlist is "any"' };
  }
  try {
    if (target.allow === 'any') {
      return { allowed: true, rule: 'any', command: checkRawSshCommand(input) };
    }
    const tokens = tokenizeSshCommand(input);
    if (jumped && tokens.some(zshEqualsWord)) {
      return {
        allowed: false,
        reason: 'a word may not start with "=" or contain "==" or ":=" on a target with jumps',
        short: 'unsafe "=" word',
      };
    }
    const carried = prefix ? { prefix } : {};
    const decision = decide(tokens, target.allow);
    if (!decision.allowed) return { ...decision, argv: tokens, ...carried };
    return {
      allowed: true, rule: decision.rule, command: tokens.join(' '), ...carried,
    };
  } catch (err) {
    if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
    throw err;
  }
}

// The words reach a login shell on the server; the tokenizer already keeps out
// quotes, ~, globs and braces, so only an assignment and the words that zsh may rewrite remain.
function wordsNotForReview(argv) {
  if (argv.some((w) => w.startsWith('='))) return 'a word starts with "=", which the server\'s shell may expand';
  if (argv.some((w) => w.includes('==') || w.includes(':='))) {
    return 'a word contains "==" or ":=", which the server\'s shell may rewrite';
  }
  if (argv[0].includes('=')) return 'the first word sets an environment variable on the server';
  return null;
}

function checkJumps(entry, where, allow) {
  const list = entry.jumps;
  if (list === undefined) return {};
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_JUMPS) {
    throw new InventoryError(`${where}: jumps: must be a list of 1 to ${MAX_JUMPS} ssh commands`);
  }
  if (allow === 'any') throw new InventoryError(`${where}: jumps: a target with jumps needs a list of rules, not "any"`);
  const out = list.map((jump, j) => {
    if (typeof jump !== 'string' || jump.trim() === '') {
      throw new InventoryError(`${where}: jumps[${j}]: must be an ssh command, for example "ssh -i .ssh/key user@server"`);
    }
    if (jump.includes('~')) {
      throw new InventoryError(`${where}: jumps[${j}]: "~" is not allowed; a path without a leading "/" starts in the home folder of that login`);
    }
    try {
      const words = tokenizeSshCommand(jump);
      parseJump(words);
      return words.join(' ');
    } catch (err) {
      throw new InventoryError(`${where}: jumps[${j}]: ${err.message}`);
    }
  });
  return { jumps: out };
}

export default {
  key: 'ssh',
  flag: 'ssh',
  label: 'ssh',
  word: 'ssh',
  noun: 'ssh server',
  countNoun: 'server(s)',
  sample: [
    {
      name: 'web1',
      host: 'web1.example.com',
      description: 'production web box',
      allow: ['systemctl status *', 'journalctl -u myapp ...', 'df -h'],
    },
  ],
  hint(target) {
    return target.description ? `${target.host} — ${target.description}` : target.host;
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, SSH_KEYS, where);
    checkHost(entry.host, `${where}: host`);
    const allow = checkAllow(entry, where);
    return {
      kind: 'ssh',
      name: entry.name,
      host: entry.host,
      ...checkJumps(entry, where, allow),
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  // Closes every socket a killed run left in the socket folder, the tunnels of clusters included.
  async reapStale({ socketDir, env }) {
    await closeStaleSockets(socketDir, env);
    return [];
  },
  prepare(targets, { env }) {
    return new Map(targets.map((t) => [t.name, socketPath('ssh', t.name, env)]));
  },
  openingMessage(t) {
    return t.jumps ? `${t.host}, then ${t.jumps.length} jump${t.jumps.length === 1 ? '' : 's'}` : t.host;
  },
  async open(t, { env, prepared: socket }) {
    const r = await openMaster({ socket, host: t.host }, env);
    return r.ok ? { ok: true, extras: { socket } } : r;
  },
  closeLimit: 'sshCloseMs',
  closeMs: 15000,
  close(o, { env }) {
    return closeMaster({ socket: o.socket, host: o.target.host }, env);
  },
  record(o, { reviewed }) {
    return {
      kind: 'ssh',
      name: o.target.name,
      description: o.target.description,
      allow: o.target.allow,
      host: o.target.host,
      ...(o.target.jumps ? { jumps: o.target.jumps } : {}),
      socket: o.socket,
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  sessionFiles(opened) {
    return [{ name: 'ssh_config', text: sshConfigText(opened.map((o) => ({ name: o.target.name, socket: o.socket }))) }];
  },
  downMessage() {
    return 'connection lost';
  },
  backMessage: 'connection is back',
  decide: decideSsh,
  wordsNotForReview,
  command(target, decision, { dir, env }) {
    const command = decision.prefix === undefined ? decision.command : `${decision.prefix} ${decision.command}`;
    return {
      program: sshBin(env),
      args: execArgs(path.join(dir, 'ssh_config'), target.name, command),
      options: { env: minimalEnv(env) },
    };
  },
  async state(target, env) {
    return (await checkMaster({ socket: target.socket, host: target.host }, env)) ? 'up' : 'down';
  },
  checkExtra(target, decision) {
    return decision.prefix === undefined ? [] : [`sent to ${target.host}: ${decision.prefix} ${decision.command}`];
  },
  toolBullet: '- `ssh_exec { server, command, timeout_seconds? }` - run one command on an ssh server.',
  agentSection(target) {
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
    if (target.jumps !== undefined) {
      lines.push('- This server is reached through a further ssh step that the user set up; your command runs on the final server.');
    }
    if (target.review === true) lines.push(REVIEWED);
    return lines.join('\n');
  },
  tool: {
    name: 'ssh_exec',
    nameKey: 'server',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'ssh_exec',
      description: 'Run one command on an open ssh server. The command is checked against that server\'s allowlist.',
      inputSchema: {
        type: 'object',
        required: ['server', 'command'],
        additionalProperties: false,
        properties: {
          server: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'Command to run on the server' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
