import path from 'node:path';
import {
  AllowError, decide, describeAllow, tokenizeSshCommand,
} from '../../src/allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkReview, checkSecretVariable,
} from '../../src/checks.js';

const VAULT_KEYS = ['name', 'tokenEnv', 'tokenFile', 'description', 'allow', 'review'];

// What the tests steer and read back. It never holds a secret value: only names, lengths and flags.
export const control = {
  probe: 'up', probes: [], opened: [], aborted: 0,
};

// A test-only brokered kind: the call is decided and carried out inside ksproxy start, which holds the token.
// perform answers with the length of the token, never the token, and with the words of the call.
export default {
  key: 'vault',
  flag: 'vault',
  label: 'vlt',
  word: 'vault',
  noun: 'vault target',
  countNoun: 'vault target(s)',
  brokered: true,
  sample: [{
    name: 'v1', tokenEnv: 'VAULT_TEST_TOKEN', description: 'a test vault', allow: ['read *'],
  }],
  hint(target) {
    return target.description ? `vault - ${target.description}` : 'vault';
  },
  validate(entry, where, { reviewers }) {
    checkKeys(entry, VAULT_KEYS, where);
    checkSecretVariable(entry.tokenEnv, `${where}: tokenEnv`, 'the token');
    if (entry.tokenFile !== undefined && (typeof entry.tokenFile !== 'string' || !path.isAbsolute(entry.tokenFile))) {
      throw new InventoryError(`${where}: tokenFile: must be an absolute path`);
    }
    const allow = checkAllow(entry, where);
    return {
      kind: 'vault',
      name: entry.name,
      tokenEnv: entry.tokenEnv,
      ...(entry.tokenFile === undefined ? {} : { tokenFile: entry.tokenFile }),
      description: entry.description ?? '',
      allow,
      ...checkReview(entry, where, reviewers, allow, { programs: false }),
    };
  },
  secrets(target) {
    return { env: [target.tokenEnv], files: target.tokenFile === undefined ? [] : [target.tokenFile] };
  },
  secretFiles(targets) {
    return targets.filter((t) => t.tokenFile !== undefined).map((t) => t.tokenFile);
  },
  openingMessage(target) {
    return `token from ${target.tokenEnv}`;
  },
  async open(target, { secrets }) {
    control.opened.push({ name: target.name, names: Object.keys(secrets) });
    return { ok: true, extras: {} };
  },
  record(opened, { reviewed }) {
    return {
      kind: 'vault',
      name: opened.target.name,
      description: opened.target.description,
      allow: opened.target.allow,
      tokenEnv: opened.target.tokenEnv,
      ...(opened.target.tokenFile === undefined ? {} : { tokenFile: opened.target.tokenFile }),
      state: 'up',
      ...(reviewed ? { review: true } : {}),
    };
  },
  downMessage() {
    return 'vault is not answering';
  },
  backMessage: 'vault is back',
  decide(target, input) {
    try {
      const tokens = tokenizeSshCommand(input);
      if (tokens[0] === 'crash') throw new Error('decide broke at /secret/path');
      const decision = decide(tokens, target.allow);
      return { ...decision, argv: tokens };
    } catch (err) {
      if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
      throw err;
    }
  },
  async perform(target, decision, {
    env, secrets, timeoutMs, maxBytes, signal,
  }) {
    const token = secrets[target.tokenEnv];
    const fileNote = target.tokenFile === undefined ? '' : ` and a file of ${secrets[target.tokenFile].length} characters`;
    const [action, ...rest] = decision.argv;
    switch (action) {
      case 'boom':
        throw new Error(`failed with ${token} at /secret/path`);
      case 'odd':
        return { exitCode: 'zero', stdout: 1, stderr: '' };
      case 'fail':
        return { exitCode: 3, stdout: '', stderr: `no such key ${rest.join(' ')}\n` };
      case 'hang':
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
        control.aborted += 1;
        return {
          exitCode: null, stdout: `partial after ${timeoutMs} ms\n`, stderr: '', timedOut: true,
        };
      case 'stuck':
        return new Promise(() => {});
      case 'flood':
        return { exitCode: 0, stdout: 'f'.repeat(maxBytes + 100), stderr: '' };
      case 'ctl':
        return { exitCode: 0, stdout: '\u0001'.repeat(maxBytes), stderr: '' };
      case 'envkeys':
        return { exitCode: 0, stdout: `${Object.keys(env).sort().join('\n')}\n`, stderr: '' };
      case 'where':
        return { exitCode: 0, stdout: `state in ${env.KSPROXY_STATE_DIR}/x\n`, stderr: '' };
      case 'cut':
        return {
          exitCode: 0, stdout: 'cut short', stderr: '', truncated: true,
        };
      default:
        return {
          exitCode: 0,
          stdout: `vault ${target.name}: ${decision.argv.join(' ')} with a token of ${token.length} characters${fileNote}\n`,
          stderr: '',
        };
    }
  },
  async probe(target, { secrets }) {
    control.probes.push({ name: target.name, hasToken: typeof secrets[target.tokenEnv] === 'string' });
    if (control.probe === 'throw') throw new Error('probe broke');
    return control.probe;
  },
  toolBullet: '- `vault_read { target, command, timeout_seconds? }` - read from a test vault.',
  agentSection(target) {
    return [
      `### vault target \`${target.name}\``,
      `- Tool: \`vault_read\` with \`target: "${target.name}"\`; allowed commands: ${describeAllow(target.allow)}`,
    ].join('\n');
  },
  tool: {
    name: 'vault_read',
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: 'vault_read',
      description: 'Read from a test vault.',
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
