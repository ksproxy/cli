import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import commandKind, { hasLookaround, resolveProgram } from '../src/kinds/command/index.js';
import { KINDS, kindByKey, kindByTool } from '../src/kinds/index.js';
import { WORK_FOLDER } from '../src/kinds/engines/command.js';
import { withProject } from '../src/paths.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import { main } from '../src/cli.js';
import {
  alive, cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

const fake = fileURLToPath(new URL('./fixtures/fake-client.js', import.meta.url));
const fixtures = path.dirname(fake);
const SECRET = 'cmd-S3CR3T-9b27e1-unmistakable';
const SECRET_VAR = 'CMD_TEST_REPORT_SECRET';
const ALLOW = ['usage *', 'summary', 'regex(usage (daily|weekly))', 'regex(stats|stats --json)', 'list ...', 'show --long *', 'sleep', 'touch', 'flood', 'fail'];

const providers = [];
after(async () => {
  cleanupAll();
  for (const server of providers) {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
});

async function provider(verdict = 'allow') {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const content = JSON.stringify({ verdict, certainty: 'sure', reason: 'fine' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  providers.push(server);
  return { asked, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

const one = (entry) => validateInventory({ command: [{ name: 'r', program: fake, ...entry }] }).command[0];
const fails = (entry, message) => assert.throws(() => one(entry), (err) => {
  assert.ok(err instanceof InventoryError, err.message);
  assert.equal(err.message, message);
  return true;
});

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

async function commandWorld({ targets, reviewer, extraEnv = {} } = {}) {
  const world = await makeWorld({ extraEnv: { [SECRET_VAR]: SECRET, PATH: `${fixtures}:${process.env.PATH}`, ...extraEnv } });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory.command = targets ?? [{
    name: 'rep', program: 'fake-client.js', args: ['--format', 'text'], env: { REPORT_TOKEN: { fromEnv: SECRET_VAR } }, description: 'report stand-in', allow: ALLOW,
  }];
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.inventoryFile = file;
  world.workRoot = path.join(world.env.KSPROXY_STATE_DIR, WORK_FOLDER);
  return world;
}

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const commandCalls = (world) => auditOf(world).filter((e) => e.event === 'call' && e.tool === 'command_exec');

test('command is a brokered kind appended to the list and meets the contract', () => {
  assert.equal(KINDS[4], commandKind);
  assert.equal(kindByKey('command'), commandKind);
  assert.equal(kindByTool('command_exec'), commandKind);
  checkKind(commandKind, KINDS);
  assert.equal(commandKind.brokered, true);
  assert.equal(commandKind.label, 'cmd');
  assert.equal(commandKind.flag, 'command');
  assert.equal(commandKind.tool.detailKey, 'command');
  assert.equal(commandKind.tool.detailIsArray, false);
});

test('a command entry is validated into a target', () => {
  assert.deepEqual(one({
    args: ['--format', 'text', '~/reports', '~', 'a~/b', ''], env: { REPORT_TOKEN: { fromEnv: 'REPORT_TOKEN' }, OTHER: { fromEnv: 'SRC_B' } }, allow: ['usage *'], description: 'd',
  }), {
    kind: 'command',
    name: 'r',
    program: fake,
    args: ['--format', 'text', path.join(os.homedir(), 'reports'), '~', 'a~/b', ''],
    env: { REPORT_TOKEN: 'REPORT_TOKEN', OTHER: 'SRC_B' },
    description: 'd',
    allow: ['usage *'],
  });
  const bare = one({});
  assert.deepEqual([bare.args, bare.env, bare.allow, bare.description], [[], {}, [], '']);
  assert.equal(one({ program: 'report-tool_2.1+x' }).program, 'report-tool_2.1+x');
  assert.equal(one({ program: '~/bin/report' }).program, path.join(os.homedir(), 'bin', 'report'));
  assert.equal(one({ program: '/usr//bin/../bin/env' }).program, '/usr/bin/env');
  assert.equal(one({ args: Array(50).fill('x'.repeat(1024)) }).args.length, 50);
});

test('every mistake in a command entry is an inventory error that names the field', () => {
  fails({ shell: true }, 'command "r": unknown key "shell"');
  const program = 'command "r": program: must be an absolute path, a path that starts with "~/", or a program name of letters, digits and _ . + - that is looked up on PATH';
  for (const value of [undefined, '', 5, './report', 'bin/report', '-x', '.hidden', 'a b', '~', '~user/x', 'x\ny', `/${'p'.repeat(1024)}`]) fails({ program: value }, program);
  const args = 'command "r": args: must be a list of at most 50 strings, each at most 1024 bytes and without control characters';
  for (const value of ['--format text', [5], ['a\tb'], ['a\u007f'], Array(51).fill('x'), ['x'.repeat(1025)], {}]) fails({ args: value }, args);
  const env = 'command "r": env: must be an object of at most 50 variables, each {"fromEnv": NAME}';
  for (const value of [[], 'X', null]) fails({ env: value }, env);
  fails({ env: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`V${i}`, { fromEnv: 'S' }])) }, env);
  const form = (name) => `command "r": env["${name}"]: must be {"fromEnv": NAME}`;
  for (const value of ['S', null, {}, { fromEnv: 'S', extra: 1 }, { from: 'S' }, ['S']]) fails({ env: { TOKEN: value } }, form('TOKEN'));
  fails({ env: { lower: { fromEnv: 'S' } } }, 'command "r": env["lower"]: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ env: { 'A\nB': { fromEnv: 'S' } } }, 'command "r": env["A\\nB"]: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ env: { KSPROXY_X: { fromEnv: 'S' } } }, 'command "r": env["KSPROXY_X"]: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LANG', 'SSH_AUTH_SOCK']) {
    fails({ env: { [name]: { fromEnv: 'S' } } }, `command "r": env["${name}"]: ${name} is a variable the session needs; name a variable that must hold only the secret`);
  }
  for (const name of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_X']) {
    fails({ env: { [name]: { fromEnv: 'S' } } }, `command "r": env["${name}"]: ${name} changes how programs are loaded; name another variable`);
  }
  fails({ env: { T: { fromEnv: 'lower' } } }, 'command "r": env["T"].fromEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ env: { T: { fromEnv: 'PATH' } } }, 'command "r": env["T"].fromEnv: PATH is a variable the session needs; name a variable that must hold only the secret');
  fails({ env: { T: { fromEnv: 'KSPROXY_TOKEN' } } }, 'command "r": env["T"].fromEnv: must be the name of an environment variable (capitals, digits and "_") that does not start with KSPROXY_');
  fails({ allow: 'any' }, 'command "r": allow: "any" is not supported for command targets; list the commands');
  fails({ allow: 'usage' }, 'command "r": allow: must be an array of rule strings');
  fails({ allow: ['usage ... x'] }, 'command "r": allow[0]: "..." is only allowed as the last token: usage ... x');
  fails({ allow: ['regex(usage (x)'] }, `command "r": allow[0]: regex does not compile: ${(() => { try { RegExp('usage (x'); } catch (err) { return err.message; } return ''; })()}`);
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'command "r": review.programs: is only for local targets');
});

test('a regex rule with a lookaround is an inventory error on a command target', () => {
  const message = (i) => `command "r": allow[${i}]: a regex rule of a command target may not use a lookaround, (?= (?! (?<= or (?<!, because ksproxy could not tell which options the rule allows`;
  for (const rule of ['regex(deploy (?!(--force))\\S+( \\S+)*)', 'regex(a(?=b)b)', 'regex((?<=x)y)', 'regex((?<!x)y)', 'regex([a](?!-x).*)']) {
    fails({ allow: ['summary', rule] }, message(1));
  }
  for (const rule of ['regex(a\\(?=b)', 'regex(a[(?=]b)', 'regex(a[\\](?=]b)', 'regex((?:a)|(?<name>b))', 'regex(a\\\\[(?!]x)']) {
    assert.deepEqual(one({ allow: [rule] }).allow, [rule], rule);
  }
  assert.equal(hasLookaround('[(?=x'), false, 'a class without its end runs to the end of the text');
  assert.equal(hasLookaround('x(?<=y'), true);
});

test('resolveProgram: an absolute path, a name on the PATH of start, and every reason a program is refused', () => {
  const base = fs.realpathSync(tempDir('ks-cmdp-'));
  try {
    const state = path.join(base, 'st');
    const config = path.join(base, 'cfg');
    fs.mkdirSync(state);
    fs.mkdirSync(config);
    const env = { PATH: `relative/bin:${fixtures}:/usr/bin`, KSPROXY_STATE_DIR: state, KSPROXY_CONFIG_DIR: config };
    assert.deepEqual(resolveProgram(fake, env), { program: fake });
    assert.deepEqual(resolveProgram('fake-client.js', env), { program: fake });
    assert.deepEqual(resolveProgram('no-such-program-ks', env), { error: 'program no-such-program-ks was not found on PATH' });
    assert.deepEqual(resolveProgram('fake-client.js', { ...env, PATH: undefined }), { error: 'program fake-client.js was not found on PATH' });
    const plain = path.join(base, 'plain');
    fs.writeFileSync(plain, '#!/bin/sh\n', { mode: 0o644 });
    assert.deepEqual(resolveProgram(plain, env), { error: `program ${plain} is not an executable file` });
    assert.deepEqual(resolveProgram(base, env), { error: `program ${base} is not an executable file` });
    assert.deepEqual(resolveProgram(path.join(base, 'gone'), env), { error: `program ${path.join(base, 'gone')} is not an executable file` });
    assert.deepEqual(resolveProgram('plain', { ...env, PATH: base }), { error: 'program plain was not found on PATH' });
    for (const dir of [state, config]) {
      const inside = path.join(dir, 'tool');
      fs.copyFileSync(fake, inside);
      fs.chmodSync(inside, 0o755);
      assert.deepEqual(resolveProgram(inside, env), { error: `program ${inside} is inside ksproxy's own folders` });
      assert.deepEqual(resolveProgram('tool', { ...env, PATH: dir }), { error: `program ${inside} is inside ksproxy's own folders` });
    }
    const link = path.join(base, 'link');
    fs.symlinkSync(path.join(state, 'tool'), link);
    assert.deepEqual(resolveProgram(link, env), { error: `program ${link} is inside ksproxy's own folders` });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveProgram of project shop refuses a program anywhere in the root state folder, every project included', () => {
  const base = fs.realpathSync(tempDir('ks-cmdq-'));
  try {
    const state = path.join(base, 'st');
    const config = path.join(base, 'cfg');
    const viaLink = path.join(base, 'st-link');
    fs.mkdirSync(config);
    fs.mkdirSync(state);
    fs.symlinkSync(state, viaLink);
    const env = withProject({ PATH: '/usr/bin', KSPROXY_STATE_DIR: viaLink, KSPROXY_CONFIG_DIR: config }, 'shop');
    for (const dir of [path.join(state, 'p', 'ops'), path.join(state, 'session'), path.join(state, 'p', 'shop', 'run'), path.join(config, 'projects')]) {
      fs.mkdirSync(dir, { recursive: true });
      const inside = path.join(dir, 'tool');
      fs.copyFileSync(fake, inside);
      fs.chmodSync(inside, 0o755);
      assert.deepEqual(resolveProgram(inside, env), { error: `program ${inside} is inside ksproxy's own folders` }, dir);
      assert.deepEqual(resolveProgram('tool', { ...env, PATH: dir }), { error: `program ${inside} is inside ksproxy's own folders` }, dir);
    }
    assert.deepEqual(resolveProgram(fake, env), { program: fake });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('decide: plain words only, flags only where a rule writes them, the fixed options never repeated', () => {
  const target = { args: ['--format', 'text', '-q'], allow: ALLOW };
  const call = (input) => commandKind.decide(target, input);
  assert.deepEqual(call('usage disk'), { allowed: true, rule: 'usage *', argv: ['usage', 'disk'] });
  assert.equal(call('summary').rule, 'summary');
  assert.equal(call('usage daily').rule, 'usage *');
  assert.equal(call('list a b c').rule, 'list ...');
  assert.equal(call('list').rule, 'list ...');
  assert.equal(call('show --long x').rule, 'show --long *');
  assert.equal(call('stats').rule, 'regex(stats|stats --json)');
  assert.equal(call('stats --json').rule, 'regex(stats|stats --json)');
  const unlisted = (input, argv) => assert.deepEqual(call(input), {
    allowed: false, reason: `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`, short: 'not on allowlist', unmatched: true, argv,
  });
  unlisted('usage -x', ['usage', '-x']);
  unlisted('usage --all', ['usage', '--all']);
  unlisted('list a --all', ['list', 'a', '--all']);
  unlisted('list -r', ['list', '-r']);
  unlisted('show --short x', ['show', '--short', 'x']);
  unlisted('show --long -x', ['show', '--long', '-x']);
  unlisted('stats --jso', ['stats', '--jso']);
  unlisted('usage daily weekly', ['usage', 'daily', 'weekly']);
  unlisted('other', ['other']);
  assert.deepEqual(call('list --format'), {
    allowed: false, reason: '"--format" repeats an option the user fixed for this target', short: 'repeats a fixed option',
  });
  assert.equal(call('usage -q').short, 'repeats a fixed option');
  assert.equal(call('list text').rule, 'list ...', 'a fixed word that is not a flag may be repeated');
  for (const [input, short] of [
    ['usage $(id)', 'character "$" not allowed'], ['usage a;b', 'character ";" not allowed'], ['usage a|b', 'character "|" not allowed'],
    ['usage `x`', 'character "`" not allowed'], ['usage "a b"', 'character """ not allowed'], ['usage a>b', 'character ">" not allowed'],
    ['usage ~/x', 'character "~" not allowed'], ['usage *', 'character "*" not allowed'], ['usage a\nb', 'character U+000A not allowed'],
    ['--help', 'starts with "-"'], ['', 'empty command'], ['x'.repeat(5000), 'command too long'],
  ]) {
    const decision = call(input);
    assert.equal(decision.allowed, false, input);
    assert.equal(decision.short, short, input);
    assert.equal(decision.unmatched, undefined, input);
  }
  assert.equal(commandKind.decide({ args: [], allow: [] }, 'x').short, 'allowlist is empty');
});

test('a regex rule allows a word that starts with "-" only when the pattern writes it as a whole word', () => {
  const decideWith = (rule, input) => commandKind.decide({ args: [], allow: [rule] }, input).allowed;
  assert.equal(decideWith('regex(r -[a-z])', 'r -x'), false);
  assert.equal(decideWith('regex(r --?x)', 'r -x'), false);
  assert.equal(decideWith('regex(r -x?)', 'r -x'), false);
  assert.equal(decideWith('regex(r \\S+)', 'r --delete'), false);
  assert.equal(decideWith('regex(r .*)', 'r a --delete'), false);
  assert.equal(decideWith('regex(r --delete-all|r \\S+)', 'r --delete'), false);
  assert.equal(decideWith('regex(r --format=\\w+)', 'r --format=json'), false);
  assert.equal(decideWith('regex(r a:-x|r \\S+)', 'r -x'), false);
  assert.equal(decideWith('regex(r -x)', 'r -x'), true);
  assert.equal(decideWith('regex(^r -x$)', 'r -x'), true);
  assert.equal(decideWith('regex(r (-x|-y))', 'r -y'), true);
  assert.equal(decideWith('regex(r (?:-x|-y) \\d+)', 'r -x 5'), true);
  assert.equal(decideWith('regex(r( -v)? \\w+)', 'r -v abc'), false, 'a flag in a group that may be skipped is not written');
  assert.equal(decideWith('regex(r( -v)? \\w+)', 'r abc'), true);
  assert.equal(decideWith('regex(r|r -v \\w+)', 'r -v abc'), true, 'the way to write an optional flag');
  assert.equal(decideWith('regex(r -x -x)', 'r -x -x'), true);
  assert.equal(decideWith('regex(r a-x)', 'r a-x'), true);
  assert.equal(decideWith('regex(-q|r -q)', 'r -q'), true);
});

test('a flag in a group repeated with a quantifier that allows zero times is not written by the rule', () => {
  const decideWith = (rule, input) => commandKind.decide({ args: [], allow: [rule] }, input).allowed;
  for (const rule of ['regex(r(?: --force){0}( \\S+)*)', 'regex(r(?: --force)?( \\S+)*)', 'regex(r( --force)*( \\S+)*)',
    'regex(r( --force){0,2}( \\S+)*)', 'regex(r( --force){0,}( \\S+)*)', 'regex(r(( --force) x){0}( \\S+)*)', 'regex(r(?:( --force)+)??( \\S+)*)',
    'regex(r(( --force)+ x){00,3}( \\S+)*)']) {
    assert.equal(decideWith(rule, 'r --force'), false, rule);
  }
  for (const rule of ['regex(r( --force){1}( \\S+)*)', 'regex(r( --force)+( \\S+)*)', 'regex(r( --force){1,}( \\S+)*)', 'regex(r(( --force)){1,3}( \\S+)*)',
    'regex(r( --force)[?]?( \\S+)*)', 'regex(r( --force)( [(]?\\S+)*)', 'regex(r( --force)( [\\](]?\\S+)*)', 'regex(r\\(?( --force)( \\S+)*)']) {
    assert.equal(decideWith(rule, 'r --force'), true, rule);
  }
});

test('the target in the menu, the opening line, the secrets, open, the record, the notes and the clean-up', async () => {
  const target = (extra = {}) => ({
    kind: 'command', name: 'rep', program: 'fake-client.js', args: ['--format', 'text'], env: { REPORT_TOKEN: 'SRC', OTHER: 'OTHER' }, description: 'reports', allow: ['usage *'], ...extra,
  });
  assert.equal(commandKind.hint(target()), 'fake-client.js - reports');
  assert.equal(commandKind.hint(target({ description: '' })), 'fake-client.js');
  assert.equal(commandKind.openingMessage(target()), 'fake-client.js, 2 fixed arguments, secrets REPORT_TOKEN from SRC, OTHER');
  assert.equal(commandKind.openingMessage(target({ args: [], env: {} })), 'fake-client.js, 0 fixed arguments, no secrets');
  assert.deepEqual(commandKind.secrets(target({ env: { A: 'S', B: 'S', C: 'T' } })), { env: ['S', 'T'], files: [] });
  const env = { PATH: fixtures, KSPROXY_STATE_DIR: '/nonexistent-ks/st', KSPROXY_CONFIG_DIR: '/nonexistent-ks/cfg' };
  assert.deepEqual(commandKind.open(target(), { env, secrets: {} }), { ok: true, extras: { program: fake } });
  assert.deepEqual(commandKind.open(target({ program: 'nope-ks' }), { env, secrets: {} }), { ok: false, error: 'program nope-ks was not found on PATH' });
  assert.deepEqual(commandKind.record({ target: target(), program: fake }, { reviewed: true }), {
    kind: 'command', name: 'rep', description: 'reports', allow: ['usage *'], program: fake, args: ['--format', 'text'], env: { REPORT_TOKEN: 'SRC', OTHER: 'OTHER' }, state: 'up', review: true,
  });
  assert.equal(commandKind.record({ target: target(), program: fake }, { reviewed: false }).review, undefined);
  assert.equal(commandKind.downMessage(), 'the call service is not answering');
  assert.equal(commandKind.backMessage, 'the call service is back');
  assert.deepEqual(commandKind.forCheck(target(), { env }), { target: { ...target(), program: fake } });
  assert.deepEqual(commandKind.forCheck(target({ program: 'nope-ks' }), { env }), { refusal: 'program nope-ks was not found on PATH' });

  const notes = commandKind.agentSection({ ...target(), program: fake, review: true });
  assert.match(notes, /^### Command target `rep` - reports\n\n- Tool: `command_exec` with `target: "rep"`/);
  assert.ok(notes.includes('- Allowed commands: usage *'));
  assert.ok(notes.includes('never a word that starts with `-`'));
  assert.ok(notes.includes('a flag is allowed only where the user wrote it into a rule, or when the target has a reviewer and it approves a call that no rule matches.'));
  assert.ok(notes.includes('repeats one of the options the user fixed'));
  assert.ok(notes.includes('no shell runs it'));
  assert.ok(notes.includes('ksproxy does not know what this program does'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes(fake), 'the program path is not in the notes');
  assert.ok(!notes.includes('--format'), 'the fixed arguments are not in the notes');
  const plain = commandKind.agentSection({ ...target({ description: '' }) });
  assert.ok(plain.startsWith('### Command target `rep`\n'));
  assert.ok(!plain.includes('reviewed before'));

  const base = fs.realpathSync(tempDir('ks-cmdr-'));
  const left = path.join(base, 'st', WORK_FOLDER, 'cmd-abc');
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, 'f'), 'x');
  assert.deepEqual(await commandKind.reapStale({ socketDir: path.join(base, 'st', 's'), env: { KSPROXY_STATE_DIR: path.join(base, 'st') } }), []);
  assert.equal(fs.existsSync(path.join(base, 'st', WORK_FOLDER)), false);
  assert.deepEqual(await commandKind.reapStale({ socketDir: path.join(base, 'st', 's'), env: { KSPROXY_STATE_DIR: path.join(base, 'st') } }), []);
  fs.rmSync(base, { recursive: true, force: true });
});

test('perform runs the recorded program with the fixed arguments, the words and the secret under the child name', async () => {
  const base = fs.realpathSync(tempDir('ks-cmdq-'));
  try {
    const env = { PATH: process.env.PATH, KSPROXY_STATE_DIR: path.join(base, 'st'), [SECRET_VAR]: 'not-this-one' };
    const result = await commandKind.perform(
      { program: fake, args: ['--format', 'text'], env: { REPORT_TOKEN: SECRET_VAR } },
      { allowed: true, rule: 'usage *', argv: ['usage', 'disk'] },
      {
        env, secrets: { [SECRET_VAR]: SECRET }, timeoutMs: 10000, maxBytes: 262144, signal: new AbortController().signal,
      },
    );
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.argv, ['--format', 'text', 'usage', 'disk']);
    assert.equal(report.env.REPORT_TOKEN, SECRET);
    assert.equal(report.env[SECRET_VAR], undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the tool is listed when the inventory holds a command target, and AGENT.md lists it for a session that has one', () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ ssh: [{}] })).includes('command_exec'));
  assert.ok(names(toolDefinitions({ command: [{}] })).includes('command_exec'));
  assert.ok(names(toolDefinitions(null)).includes('command_exec'));
  const session = {
    targets: [{
      kind: 'command', name: 'rep', description: '', allow: ['summary'], program: fake, args: [], env: {}, state: 'up',
    }],
  };
  const text = agentMdText(session);
  assert.ok(text.includes('- `command_exec { target, command, timeout_seconds? }` - run one allowlisted command of a command target.\n'));
  assert.ok(text.includes('### Command target `rep`'));
});

test('ksproxy check command takes the words of a call, and refuses a program that cannot be found', async () => {
  const world = await commandWorld();
  const check = (...words) => cli(['check', 'command', 'rep', ...words], world.env);
  assert.deepEqual(await check('usage', 'disk'), { code: 0, stdout: 'ALLOWED by rule: usage *\n', stderr: '' });
  assert.equal((await check('usage', '-x')).stdout, `REFUSED: not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}\n`);
  assert.equal((await check('list', '--format')).stdout, 'REFUSED: "--format" repeats an option the user fixed for this target\n');
  assert.equal((await check('usage', '$(id)')).stdout.startsWith('REFUSED: character "$" is not allowed'), true);
  const missing = await cli(['check', 'command', 'rep', 'summary'], { ...world.env, PATH: '/usr/bin:/bin' });
  assert.equal(missing.stdout, 'REFUSED: program fake-client.js was not found on PATH\n');
});

test('a session with a command target: the exact call, refusals before any run, the folder removed, every audit once, no secret anywhere', async () => {
  const world = await commandWorld({
    targets: [
      {
        name: 'rep', program: 'fake-client.js', args: ['--format', 'text'], env: { REPORT_TOKEN: { fromEnv: SECRET_VAR } }, description: 'report stand-in', allow: ALLOW,
      },
      { name: 'gone', program: 'no-such-program-ks', allow: ['x'] },
      { name: 'unset', program: fake, env: { T: { fromEnv: 'CMD_TEST_NOT_SET' } }, allow: ['x'] },
    ],
  });
  const run = launch(world, { ssh: ['web1'], command: ['rep', 'gone', 'unset'] });
  await ready(run);
  assert.match(run.proc.stderr.text, /cmd +rep +OPENING +fake-client\.js, 2 fixed arguments, secrets REPORT_TOKEN from CMD_TEST_REPORT_SECRET\n/);
  assert.match(run.proc.stderr.text, /cmd +rep +UP\n/);
  assert.match(run.proc.stderr.text, /cmd +gone +SKIPPED +program no-such-program-ks was not found on PATH\n/);
  assert.match(run.proc.stderr.text, /cmd +unset +SKIPPED +CMD_TEST_NOT_SET is not set\n/);
  const agentEnv = { ...world.env };
  delete agentEnv[SECRET_VAR];
  const replies = [];
  const ask = async (args) => {
    const reply = await callTool('command_exec', args, agentEnv);
    replies.push(reply.text);
    return reply;
  };

  const usage = await ask({ target: 'rep', command: 'usage  disk' });
  assert.equal(usage.isError, false, usage.text);
  const [head, body] = usage.text.split('\n--- stdout ---\n');
  assert.equal(head, 'exit code: 0');
  const report = JSON.parse(body);
  assert.deepEqual(report.argv, ['--format', 'text', 'usage', 'disk']);
  assert.match(report.cwd, /^<ksproxy>\/run\/cmd-/);
  assert.deepEqual(report.entries, []);
  assert.equal(report.env.REPORT_TOKEN, '[hidden]', 'the core hides the secret the child printed');
  assert.ok(Object.keys(report.env).every((key) => !key.startsWith('KSPROXY_')));
  assert.equal(report.env[SECRET_VAR], undefined);
  assert.deepEqual(fs.readdirSync(world.workRoot), []);

  const touched = await ask({ target: 'rep', command: 'touch' });
  assert.equal(touched.isError, false);
  assert.deepEqual(fs.readdirSync(world.workRoot), []);
  const failed = await ask({ target: 'rep', command: 'fail' });
  assert.deepEqual(failed, { text: 'exit code: 3\n--- stderr ---\nit failed', isError: true });
  const flood = await ask({ target: 'rep', command: 'flood' });
  assert.equal(flood.isError, true);
  assert.ok(flood.text.startsWith('exit code: null\n--- stdout ---\nyyyy'));
  assert.ok(flood.text.endsWith('\n[output truncated at 262144 bytes per stream]'));
  const slow = await ask({ target: 'rep', command: 'sleep', timeout_seconds: 1 });
  assert.equal(slow.text, 'timed out after 1s');
  assert.deepEqual(fs.readdirSync(world.workRoot), []);

  const refused = [
    ['usage -x', 'not on allowlist'], ['list --format', 'repeats a fixed option'], ['usage $(id)', 'character "$" not allowed'],
    ['summary; id', 'character ";" not allowed'], ['--help', 'starts with "-"'], ['other', 'not on allowlist'],
  ];
  for (const [command] of refused) {
    const reply = await ask({ target: 'rep', command });
    assert.equal(reply.isError, true);
    assert.match(reply.text, /^REFUSED \(command rep\): /);
  }
  assert.equal((await ask({ target: 'rep', command: ['usage'] })).text, 'invalid arguments: command must be a string');
  assert.equal((await ask({ target: 'nope', command: 'summary' })).text, 'unknown command target "nope". Open targets: rep');

  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets;
  assert.deepEqual(recorded.find((t) => t.kind === 'command'), {
    kind: 'command', name: 'rep', description: 'report stand-in', allow: ALLOW, program: fake, args: ['--format', 'text'], env: { REPORT_TOKEN: SECRET_VAR }, state: 'up',
  });
  const notes = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(notes.includes('`command_exec {'));
  await waitFor(() => /cmd +nope +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  assert.equal(await stopWith(run), 0);

  const calls = commandCalls(world);
  assert.equal(calls.length, 5 + refused.length + 2);
  assert.deepEqual(calls.filter((e) => e.decision === 'refused').map((e) => e.short), [...refused.map(([, short]) => short), 'invalid arguments', 'unknown target']);
  assert.deepEqual(calls[0].command, 'usage  disk');
  assert.equal(calls[0].rule, 'usage *');
  assert.equal(calls[4].timedOut, true);
  assert.match(run.proc.stdout.text, /cmd +rep +ok .*usage {2}disk\n/);

  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) assert.ok(!text.includes(SECRET), `the secret in: ${text.slice(0, 200)}`);
});

test('a stop of the session during a call kills the child and removes its folder; an unlisted command goes to the reviewer', async () => {
  const reviewer = await provider();
  const world = await commandWorld({
    reviewer,
    targets: [{
      name: 'rev', program: fake, args: ['--pid-file'], allow: ['summary'], review: { reviewer: 'r1', policy: 'reports only' },
    }],
  });
  const pidFile = path.join(world.base, 'child.pid');
  const run = launch(world, { command: ['rev'] });
  await ready(run);
  const reviewed = await callTool('command_exec', { target: 'rev', command: `${pidFile} weekly` }, world.env);
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewer.asked.length, 1);
  assert.deepEqual(JSON.parse(reviewer.asked[0].messages[1].content).command, [pidFile, 'weekly']);
  assert.deepEqual(JSON.parse(reviewed.text.split('--- stdout ---\n')[1]).argv, ['--pid-file', pidFile, 'weekly']);
  fs.rmSync(pidFile);

  const pending = callTool('command_exec', { target: 'rev', command: `${pidFile} sleep` }, world.env);
  await waitFor(() => fs.existsSync(pidFile), 10000, 'the child to start');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(fs.readdirSync(world.workRoot).length, 1);
  assert.equal(await stopWith(run), 0);
  const answer = await pending;
  assert.equal(answer.isError, true);
  await waitFor(() => !alive(pid), 5000, 'the child to be gone');
  await waitFor(() => fs.readdirSync(world.workRoot).length === 0, 5000, 'the folder to be removed');
  const [entry] = commandCalls(world).filter((e) => e.rule === 'review');
  assert.equal(entry.command, `${pidFile} weekly`);
  assert.equal(commandCalls(world).filter((e) => e.short === 'session stopped').length, 1);
});

test('a working folder left by a killed run is removed when the next session starts', async () => {
  const world = await commandWorld();
  const left = path.join(world.workRoot, 'cmd-left');
  fs.mkdirSync(left, { recursive: true });
  const run = launch(world, { command: ['rep'] });
  await ready(run);
  assert.equal(fs.existsSync(left), false);
  assert.equal(await stopWith(run), 0);
});
