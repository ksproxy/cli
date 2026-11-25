import assert from 'node:assert/strict';
import { validateInventory } from '../src/inventory.js';
import { cliName } from '../src/kinds/index.js';

// flag may be left out: such a kind is chosen with the picker, --all or a target name of doctor, and check takes its key.
const NAME_FIELDS = ['key', 'flag', 'label', 'word', 'noun', 'countNoun'];
const OPTIONAL_NAMES = ['flag'];
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED_FLAGS = ['all', 'verbose', 'help', 'version'];
const MAX_LABEL = 4;
const FUNCTIONS = ['decide', 'agentSection', 'validate', 'hint', 'openingMessage', 'open', 'record', 'downMessage'];
const OPTIONAL_FUNCTIONS = [
  'wordsNotForReview', 'notForReview', 'reviewServerCheck', 'scrubDirs', 'scrubText', 'forCheck', 'checkExtra', 'secretFiles',
  'reapStale', 'prepare', 'close', 'onCloseTimeout', 'sessionFiles', 'secrets', 'checkInput', 'ruleWarnings', 'hiddenForms',
  'ports', 'freeSample', 'doctor', 'listFields',
];
const DETAIL_SHAPES = ['object'];
// A brokered kind is carried out inside ksproxy start by perform; every other kind names the one process to start with command.
const BROKERED_ONLY = ['perform', 'probe', 'hiddenForms'];
const UNBROKERED_ONLY = ['command', 'state'];

const identifiers = (kind) => [kind.key, kind.label, kind.tool.name];

// Throws an assertion error when the kind breaks the contract; list is every kind in the list, the kind included.
export function checkKind(kind, list) {
  const at = (what) => `${kind.key}: ${what}`;
  for (const name of NAME_FIELDS) {
    if (OPTIONAL_NAMES.includes(name) && kind[name] === undefined) continue;
    assert.equal(typeof kind[name], 'string', at(name));
    assert.notEqual(kind[name], '', at(name));
    assert.equal(list.filter((other) => other[name] === kind[name]).length, 1, at(`${name} must be unique`));
  }
  for (const name of ['key', 'flag', 'label']) {
    if (kind[name] !== undefined) assert.match(kind[name], NAME_RE, at(name));
  }
  assert.ok(kind.label.length <= MAX_LABEL, at(`label is at most ${MAX_LABEL} characters`));
  assert.ok(!RESERVED_FLAGS.includes(kind.flag), at('flag is an option of its own'));
  // check takes the flag, or the key of a kind without one: no two kinds may share that name.
  assert.equal(list.filter((other) => cliName(other) === cliName(kind)).length, 1, at(`${cliName(kind)} names another kind on the command line`));
  for (const other of list.filter((item) => item !== kind)) {
    for (const value of identifiers(kind)) {
      assert.ok(!identifiers(other).includes(value), at(`${value} is also a key, a label or a tool name of ${other.key}`));
    }
  }

  for (const name of FUNCTIONS) assert.equal(typeof kind[name], 'function', at(name));
  for (const name of OPTIONAL_FUNCTIONS) {
    if (kind[name] !== undefined) assert.equal(typeof kind[name], 'function', at(name));
  }
  assert.ok(kind.brokered === undefined || kind.brokered === true, at('brokered is true or left out'));
  if (kind.brokered === true) {
    assert.equal(typeof kind.perform, 'function', at('perform'));
    if (kind.probe !== undefined) assert.equal(typeof kind.probe, 'function', at('probe'));
    for (const name of UNBROKERED_ONLY) assert.equal(kind[name], undefined, at(`a brokered kind has no ${name}`));
  } else {
    for (const name of UNBROKERED_ONLY) assert.equal(typeof kind[name], 'function', at(name));
    for (const name of BROKERED_ONLY) assert.equal(kind[name], undefined, at(`${name} is only for a brokered kind`));
  }
  assert.equal(typeof kind.backMessage, 'string', at('backMessage'));
  assert.notEqual(kind.backMessage, '', at('backMessage'));
  assert.equal(typeof kind.toolBullet, 'string', at('toolBullet'));
  assert.ok(kind.toolBullet.includes(kind.tool.name), at('toolBullet names the tool'));

  if (kind.close === undefined) {
    for (const name of ['closeLimit', 'closeMs', 'onCloseTimeout']) assert.equal(kind[name], undefined, at(name));
  } else {
    assert.equal(typeof kind.closeLimit, 'string', at('closeLimit'));
    assert.ok(Number.isInteger(kind.closeMs) && kind.closeMs > 0, at('closeMs'));
  }

  const { tool } = kind;
  assert.equal(typeof tool.name, 'string', at('tool.name'));
  assert.equal(typeof tool.nameKey, 'string', at('tool.nameKey'));
  assert.equal(typeof tool.detailKey, 'string', at('tool.detailKey'));
  assert.equal(typeof tool.detailIsArray, 'boolean', at('tool.detailIsArray'));
  assert.equal(tool.definition.name, tool.name, at('definition name'));
  // listed false: the tool is never in tools/list, though it answers when called (mcp_call).
  assert.ok(tool.listed === undefined || tool.listed === false, at('tool.listed is false or left out'));
  assert.ok(tool.definition.inputSchema.properties[tool.nameKey], at('definition has the name argument'));
  // detailShape 'object': the call is every argument but the name and timeout_seconds, and detailKey only names the
  // field of the audit entry, which auditedDetail fills and detailText shows. Without it the call is one argument.
  assert.ok(tool.detailShape === undefined || DETAIL_SHAPES.includes(tool.detailShape), at('tool.detailShape is object or left out'));
  if (tool.detailShape === 'object') {
    assert.equal(tool.detailIsArray, false, at('an object call is not an array'));
    assert.equal(tool.definition.inputSchema.properties[tool.detailKey], undefined, at('detailKey of an object call is not an argument'));
    assert.equal(typeof tool.auditedDetail, 'function', at('tool.auditedDetail'));
    assert.equal(typeof tool.detailText, 'function', at('tool.detailText'));
  } else {
    assert.ok(tool.definition.inputSchema.properties[tool.detailKey], at('definition has the detail argument'));
    assert.equal(tool.auditedDetail, undefined, at('tool.auditedDetail is only for an object call'));
    assert.equal(tool.detailText, undefined, at('tool.detailText is only for an object call'));
  }

  assert.ok(Array.isArray(kind.sample) && kind.sample.length > 0, at('sample'));
  const inventory = validateInventory({ [kind.key]: structuredClone(kind.sample) });
  assert.deepEqual(inventory[kind.key].map((t) => t.kind), kind.sample.map(() => kind.key), at('validate sets kind'));
  const [target] = inventory[kind.key];
  assert.equal(typeof kind.hint(target), 'string', at('hint'));
  assert.ok(kind.hint({ ...target, description: '' }).length > 0, at('hint without a description'));
  assert.ok(kind.hint(target).endsWith(target.description), at('hint ends with the description'));
}
