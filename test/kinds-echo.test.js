import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import echo from './fixtures/kind-echo.js';
import { KINDS, kindByFlag, kindByKey, kindByTool } from '../src/kinds/index.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, sampleInventory, validateInventory } from '../src/inventory.js';
import { handleMessage } from '../src/mcp.js';
import { callTool } from '../src/tools.js';
import { main } from '../src/cli.js';
import {
  cleanupAll, fakeProcess, makeWorld, ready, registerRun, stopWith, waitFor,
} from './start-helpers.js';

KINDS.push(echo);

after(() => cleanupAll());

const sessionOf = (world) => JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8'));

async function echoWorld() {
  const world = await makeWorld({ kubernetes: [{ name: 'lab' }], local: [{}] });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.echo = [{ name: 'x', description: 'prints words', allow: ['say *', 'hello ...'] }];
  fs.writeFileSync(file, JSON.stringify(inventory));
  return world;
}

function runMain(world, argv) {
  const proc = fakeProcess();
  const run = { proc, done: main(argv, world.env, { process: proc }) };
  registerRun(run);
  return run;
}

test('the list holds echo after the three built-in kinds and the lookups find it', () => {
  assert.deepEqual(KINDS.map((kind) => kind.key), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka', 'echo']);
  assert.equal(kindByKey('echo'), echo);
  assert.equal(kindByFlag('echo'), echo);
  assert.equal(kindByTool('echo_exec'), echo);
});

test('an inventory with an echo entry validates and a bad one is refused with a message that names it', () => {
  const inventory = validateInventory({ echo: [{ name: 'x', description: 'd', allow: ['say *'] }] });
  assert.deepEqual(Object.keys(inventory), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka', 'echo', 'reviewers']);
  assert.deepEqual(inventory.echo, [{ kind: 'echo', name: 'x', description: 'd', allow: ['say *'] }]);
  assert.throws(() => validateInventory({ echo: [{ name: 'x', allow: 'nope' }] }), (err) => {
    assert.ok(err instanceof InventoryError);
    assert.match(err.message, /^echo "x": allow: /);
    return true;
  });
  assert.throws(() => validateInventory({ echo: [{ name: 'x', host: 'h' }] }), /echo "x": unknown key "host"/);
  assert.throws(() => validateInventory({ echo: [{ name: 'x' }, { name: 'x' }] }), /echo "x": name: duplicate name/);
  assert.throws(() => validateInventory({ echo: 'x' }), /inventory: echo: must be an array/);
  assert.deepEqual(Object.keys(sampleInventory()), ['ssh', 'kubernetes', 'local', 'http', 'command', 'elasticsearch', 'rabbitmq', 'redis', 'postgres', 'mysql', 'mongodb', 'kafka', 'echo']);
});

test('echo meets the contract of a kind', () => {
  checkKind(echo, KINDS);
  assert.equal(echo.close, undefined);
});

test('tools/list ends with echo_exec', async () => {
  const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(reply.result.tools.map((t) => t.name), ['list_targets', 'ssh_exec', 'kubectl', 'local_exec', 'echo_exec']);
});

test('ksproxy start --echo opens it after the other kinds, a call prints the words, and the session closes cleanly', async () => {
  const world = await echoWorld();
  const run = runMain(world, ['start', '--ssh', 'web1', '--kube', 'lab', '--local', 'infra', '--echo', 'x']);
  await ready(run);

  const err = run.proc.stderr.text;
  assert.ok(err.includes('echo x          OPENING         prints the words of x\n'), err);
  assert.match(err, /echo x +UP\n/);
  assert.ok(err.indexOf('loc  infra') < err.indexOf('echo x'), err);

  const session = sessionOf(world);
  assert.deepEqual(session.targets.map((t) => t.kind), ['ssh', 'kubernetes', 'local', 'echo']);
  assert.deepEqual(session.targets[3], {
    kind: 'echo', name: 'x', description: 'prints words', allow: ['say *', 'hello ...'], state: 'up',
  });
  assert.match(run.proc.stdout.text, /READY +4 targets/);

  const agentMd = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(agentMd.includes('- `echo_exec { target, command, timeout_seconds? }`'));
  assert.ok(agentMd.includes('### echo target `x`\n- Tool: `echo_exec` with `target: "x"`'));
  assert.ok(agentMd.indexOf('### Local folder') < agentMd.indexOf('### echo target'));

  const listed = await callTool('list_targets', {}, world.env);
  assert.equal(JSON.parse(listed.text).targets.at(-1).state, 'up');

  const ok = await callTool('echo_exec', { target: 'x', command: 'say hello' }, world.env);
  assert.equal(ok.isError, false, ok.text);
  assert.ok(ok.text.includes('say hello'), ok.text);
  const open = await callTool('echo_exec', { target: 'x', command: 'hello -v b c' }, world.env);
  assert.equal(open.isError, false, open.text);
  assert.ok(open.text.includes('hello -v b c'), open.text);
  const refused = await callTool('echo_exec', { target: 'x', command: 'other' }, world.env);
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^REFUSED \(echo x\): not on the allowlist for this target/);
  const bad = await callTool('echo_exec', { target: 'x', command: 'say "a"' }, world.env);
  assert.match(bad.text, /^REFUSED \(echo x\): character /);
  const unknown = await callTool('echo_exec', { target: 'nope', command: 'say a' }, world.env);
  assert.match(unknown.text, /^unknown echo target "nope". Open targets: x$/);

  await waitFor(() => /DENIED/.test(run.proc.stdout.text), 10000, 'the call lines');
  assert.match(run.proc.stdout.text, /echo x +ok .*say hello/);
  assert.match(run.proc.stdout.text, /echo x +DENIED +other {2}\[not on allowlist\]/);

  const status = runMain(world, ['status']);
  assert.equal(await status.done, 0);
  assert.match(status.proc.stdout.text, /up {4}echo {2}x\n/);

  assert.equal(await stopWith(run), 0);
  assert.match(run.proc.stderr.text, /CLOSED +5 calls: 2 ok, 0 failed, 3 denied/);
  assert.equal(fs.existsSync(path.join(world.sessionDir, 'session.json')), false);
});

test('ksproxy check echo says whether a command would be allowed', async () => {
  const world = await echoWorld();
  const allowed = runMain(world, ['check', 'echo', 'x', 'say', 'hi']);
  assert.equal(await allowed.done, 0);
  assert.equal(allowed.proc.stdout.text, 'ALLOWED by rule: say *\n');
  const refused = runMain(world, ['check', 'echo', 'x', 'other']);
  assert.equal(await refused.done, 1);
  assert.match(refused.proc.stdout.text, /^REFUSED: not on the allowlist for this target/);
  const unknown = runMain(world, ['check', 'echo', 'nope', 'say', 'hi']);
  assert.equal(await unknown.done, 2);
  assert.match(unknown.proc.stderr.text, /^unknown echo target "nope"; known: x\n$/);
});

test('start --echo with a name that is not in the inventory is refused, and --all opens echo too', async () => {
  const world = await echoWorld();
  const wrong = runMain(world, ['start', '--echo', 'nope']);
  assert.equal(await wrong.done, 1);
  assert.match(wrong.proc.stderr.text, /^unknown echo target "nope"; known echo targets: x$/m);

  const run = runMain(world, ['start', '--all']);
  await ready(run);
  assert.deepEqual(sessionOf(world).targets.map((t) => t.kind), ['ssh', 'kubernetes', 'local', 'echo']);
  assert.equal(await stopWith(run), 0);
});
