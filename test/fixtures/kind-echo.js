import { AllowError, decide, describeAllow, tokenizeSshCommand } from '../../src/allowlist.js';
import { checkAllow, checkKeys } from '../../src/checks.js';
import { minimalEnv } from '../../src/exec.js';

const ECHO_KEYS = ['name', 'description', 'allow'];
const PRINT_WORDS = 'console.log(process.argv.slice(1).join(" "))';

export default {
  key: 'echo',
  flag: 'echo',
  label: 'echo',
  word: 'echo',
  noun: 'echo target',
  countNoun: 'echo target(s)',
  sample: [{ name: 'say', description: 'prints the words it is given', allow: ['say *'] }],
  hint(target) {
    return target.description ? `echo - ${target.description}` : 'echo';
  },
  validate(entry, where) {
    checkKeys(entry, ECHO_KEYS, where);
    return {
      kind: 'echo',
      name: entry.name,
      description: entry.description ?? '',
      allow: checkAllow(entry, where),
    };
  },
  openingMessage(target) {
    return `prints the words of ${target.name}`;
  },
  async open() {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    return { ok: true, extras: {} };
  },
  record(opened) {
    return {
      kind: 'echo',
      name: opened.target.name,
      description: opened.target.description,
      allow: opened.target.allow,
      state: 'up',
    };
  },
  downMessage() {
    return 'echo is gone';
  },
  backMessage: 'echo is back',
  decide(target, input) {
    try {
      const tokens = tokenizeSshCommand(input);
      const decision = decide(tokens, target.allow);
      return decision.allowed ? { ...decision, command: tokens.join(' ') } : decision;
    } catch (err) {
      if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
      throw err;
    }
  },
  command(target, decision, { env }) {
    return {
      program: process.execPath,
      args: ['-e', PRINT_WORDS, '--', ...decision.command.split(' ')],
      options: { env: minimalEnv(env) },
    };
  },
  async state() {
    return 'up';
  },
  toolBullet: '- `echo_exec { target, command, timeout_seconds? }` - print the words of an allowed command.',
  agentSection(target) {
    return [
      `### echo target \`${target.name}\``,
      `- Tool: \`echo_exec\` with \`target: "${target.name}"\`; allowed commands: ${describeAllow(target.allow)}`,
    ].join('\n');
  },
  tool: {
    name: 'echo_exec',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'echo_exec',
      description: 'Print the words of one allowed command.',
      inputSchema: {
        type: 'object',
        required: ['target', 'command'],
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Target name from list_targets' },
          command: { type: 'string', description: 'Command words, separated by spaces' },
          timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 60 },
        },
      },
    },
  },
};
