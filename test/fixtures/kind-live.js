import { randomUUID } from 'node:crypto';
import {
  AllowError, decide, describeAllow, tokenizeSshCommand,
} from '../../src/allowlist.js';
import {
  InventoryError, checkAllow, checkKeys, checkSecretVariable,
} from '../../src/checks.js';

const LIVE_KEYS = ['name', 'tokenEnv', 'description', 'allow', 'hold', 'say', 'after'];
const AFTER_MS = 20000;

// What the tests steer and read back. opened holds, for each target that opened, the nonce of its live object: a text
// that only the live object holds, so a file or a log that holds it got it from the opened entry.
export const control = {};
export function resetControl() {
  Object.assign(control, {
    opened: [], probes: [], holding: [], aborted: [], gaveUp: [], probe: 'up', probeSay: null, serial: 0,
  });
}
resetControl();

const waitUntil = async (ready) => {
  const deadline = Date.now() + AFTER_MS;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 10); });
};

// A test-only brokered kind without a flag, as the mcp kind is, named after key (at most 4 characters): open keeps a
// live object in its extras, and perform, probe and downMessage reach it through the opened entry. open says a line
// through ctx.say when the target has say, waits for ctx.signal when it has hold, and gives up once the target named in
// after waits, when it has after. The live object keeps say, so a later probe can say a line too.
export const liveKind = (key) => ({
  key,
  label: key,
  word: key,
  noun: `${key} target`,
  countNoun: `${key} target(s)`,
  brokered: true,
  sample: [{ name: 'l1', description: `a ${key} target`, allow: ['ping'] }],
  hint(target) {
    return target.description ? `${key} - ${target.description}` : key;
  },
  validate(entry, where) {
    checkKeys(entry, LIVE_KEYS, where);
    if (entry.tokenEnv !== undefined) checkSecretVariable(entry.tokenEnv, `${where}: tokenEnv`, 'the token');
    for (const field of ['say', 'after']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') throw new InventoryError(`${where}: ${field}: must be a string`);
    }
    return {
      kind: key,
      name: entry.name,
      ...(entry.tokenEnv === undefined ? {} : { tokenEnv: entry.tokenEnv }),
      description: entry.description ?? '',
      allow: checkAllow(entry, where),
      hold: entry.hold === true,
      ...(entry.say === undefined ? {} : { say: entry.say }),
      ...(entry.after === undefined ? {} : { after: entry.after }),
    };
  },
  secrets(target) {
    return { env: target.tokenEnv === undefined ? [] : [target.tokenEnv], files: [] };
  },
  openingMessage() {
    return 'a live object';
  },
  async open(target, { signal, say }) {
    if (target.say !== undefined) say(target.say);
    if (target.hold) {
      control.holding.push(target.name);
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
      control.aborted.push(target.name);
      return { ok: false, error: 'stopped' };
    }
    if (target.after !== undefined) {
      await waitUntil(() => control.holding.includes(target.after));
      control.gaveUp.push(target.name);
      return { ok: false, error: 'it gave up' };
    }
    control.serial += 1;
    const live = { nonce: randomUUID(), serial: control.serial, say };
    control.opened.push({
      name: target.name, description: target.description, nonce: live.nonce, serial: live.serial, signal: signal instanceof AbortSignal,
    });
    return { ok: true, extras: { live } };
  },
  record(opened) {
    return {
      kind: key,
      name: opened.target.name,
      description: opened.target.description,
      allow: opened.target.allow,
      state: 'up',
    };
  },
  downMessage(target, state, opened) {
    return `live object ${opened.live.serial} is ${state}`;
  },
  backMessage: 'the live object is back',
  decide(target, input) {
    try {
      const tokens = tokenizeSshCommand(input);
      return { ...decide(tokens, target.allow), argv: tokens };
    } catch (err) {
      if (err instanceof AllowError) return { allowed: false, reason: err.message, short: err.short };
      throw err;
    }
  },
  async perform(target, decision, { opened }) {
    return { exitCode: 0, stdout: `${target.name} reached ${opened.live.nonce}\n`, stderr: '' };
  },
  async probe(target, { opened }) {
    control.probes.push({ description: target.description, nonce: opened.live.nonce });
    if (control.probeSay !== null) opened.live.say(`${control.probeSay} ${opened.live.serial}`);
    return control.probe;
  },
  toolBullet: `- \`${key}_call { target, command, timeout_seconds? }\` - reach a live test object.`,
  agentSection(target) {
    return [
      `### ${key} target \`${target.name}\``,
      `- Tool: \`${key}_call\` with \`target: "${target.name}"\`; allowed commands: ${describeAllow(target.allow)}`,
    ].join('\n');
  },
  tool: {
    name: `${key}_call`,
    nameKey: 'target',
    detailKey: 'command',
    detailIsArray: false,
    definition: {
      name: `${key}_call`,
      description: 'Reach a live test object.',
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
});

export default liveKind('live');
