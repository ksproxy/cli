import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import kafkaKind from '../src/kinds/kafka/index.js';
import { KINDS, kindByFlag, kindByKey, kindByTool, secretFilesOf } from '../src/kinds/index.js';
import { WORK_FOLDER } from '../src/kinds/engines/command.js';
import { checkKind } from './kind-contract.js';
import { InventoryError, validateInventory } from '../src/inventory.js';
import { callTool, toolDefinitions } from '../src/tools.js';
import { agentMdText } from '../src/agent-md.js';
import { main } from '../src/cli.js';
import {
  cleanupAll, fakeProcess, launch, makeWorld, ready, stopWith, waitFor,
} from './start-helpers.js';
import { tempDir } from './temp.js';

const fake = fileURLToPath(new URL('./fixtures/fake-kafka.js', import.meta.url));
const CONFIG_LINE = 'sasl.jaas.config=KAFKA-CLIENT-S3CR3T-4d1f0c-unmistakable';
const PROGRAMS = {
  topics: 'kafka-topics',
  groups: 'kafka-consumer-groups',
  configs: 'kafka-configs',
  acls: 'kafka-acls',
  'log-dirs': 'kafka-log-dirs',
  'broker-api-versions': 'kafka-broker-api-versions',
};
const FIRST_WORDS = Object.keys(PROGRAMS);
const FORBIDDEN = [
  '--bootstrap-server', '--bootstrap-controller', '--command-config', '--config-file', '--zookeeper', '--zk-tls-config-file',
  '--admin.config', '--consumer.config', '--producer.config', '--consumer-property', '--producer-property', '--command-property',
  '--add-config-file', '--delete-config-file', '--offsets-file', '--from-file', '--reassignment-json-file', '--path-to-json-file',
  '--truststore', '--keystore',
];
const GENERIC = ['--authorizer-properties', '--ssl-config', '--my-file', '--config', '--property', '--Some-FILE', '--extra-configuration'];
const WRITE_FLAGS = [
  '--create', '--delete', '--alter', '--add', '--remove', '--add-config', '--delete-config', '--reset-offsets', '--delete-offsets',
  '--execute', '--partitions', '--replication-factor', '--replica-assignment', '--force', '--delete-records', '--to-earliest',
  '--to-latest', '--to-offset', '--to-datetime', '--to-current', '--shift-by', '--by-duration',
];
const ALLOW = [
  'topics --list', 'topics --describe --topic *', 'groups --list', 'groups --describe --group *',
  'configs --describe --entity-type topics --entity-name *', 'broker-api-versions', 'log-dirs --describe',
  'regex(acls --list|acls --list --principal [A-Za-z:]+)', 'topics --create --topic * --partitions *', 'topics sleep', 'topics flood',
  'topics fail', 'topics touch',
];

const dirs = [];
const providers = [];
after(async () => {
  cleanupAll();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  for (const server of providers) {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  }
});

function scratch() {
  const dir = fs.realpathSync(tempDir('ks-kfk-'));
  dirs.push(dir);
  return dir;
}

// A folder of stand-in clients: each is a shell script that logs its start and runs the fake with its own name.
function makeBin(base, { names = Object.values(PROGRAMS), sh = [], log } = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'bin-'));
  for (const name of names) {
    const file = path.join(dir, sh.includes(name) ? `${name}.sh` : name);
    const logLine = log === undefined ? '' : `echo "$0" >> '${log}'\n`;
    fs.writeFileSync(file, `#!/bin/sh\n${logLine}exec '${process.execPath}' '${fake}' ${name} "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

function makeConfig(base) {
  const file = path.join(base, 'client.properties');
  fs.writeFileSync(file, `security.protocol=SASL_SSL\n${CONFIG_LINE}\n`);
  return file;
}

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

const one = (entry) => validateInventory({ kafka: [{ name: 'k', bootstrap: 'kafka.internal:9093', ...entry }] }).kafka[0];
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
const kafkaCalls = (world) => auditOf(world).filter((e) => e.event === 'call' && e.tool === 'kafka_exec');
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

const programs = Object.fromEntries(FIRST_WORDS.map((word) => [word, `/opt/kafka/bin/${PROGRAMS[word]}`]));
const decideTarget = (extra = {}) => ({
  kind: 'kafka', name: 'k', bootstrap: 'h:1', clientConfig: null, binDir: null, writes: false, allow: [], programs, ...extra,
});
const decideWith = (extra, input) => kafkaKind.decide(decideTarget(extra), input);

test('kafka is a brokered kind appended to the list and meets the contract', () => {
  assert.equal(KINDS[11], kafkaKind);
  assert.equal(KINDS[12], kindByKey('mcp'), 'the mcp kind comes after it');
  assert.equal(kindByKey('kafka'), kafkaKind);
  assert.equal(kindByFlag('kafka'), kafkaKind);
  assert.equal(kindByTool('kafka_exec'), kafkaKind);
  checkKind(kafkaKind, KINDS);
  assert.equal(kafkaKind.brokered, true);
  assert.equal(kafkaKind.label, 'kfk');
  assert.equal(kafkaKind.word, 'kafka');
  assert.equal(kafkaKind.tool.detailKey, 'command');
  assert.equal(kafkaKind.tool.detailIsArray, false);
  assert.equal(kafkaKind.secrets, undefined, 'no secret variable for this kind');
});

test('a kafka entry is validated into a target', () => {
  assert.deepEqual(one({}), {
    kind: 'kafka',
    name: 'k',
    bootstrap: 'kafka.internal:9093',
    clientConfig: null,
    binDir: null,
    writes: false,
    description: '',
    allow: [],
  });
  assert.deepEqual(one({
    bootstrap: 'a.b-c:1,10.0.0.1:65535,h2:9092', clientConfig: '~/secrets/kafka.properties', binDir: '/opt/kafka/../kafka/bin', writes: true, description: 'd', allow: ['topics --list'],
  }), {
    kind: 'kafka',
    name: 'k',
    bootstrap: 'a.b-c:1,10.0.0.1:65535,h2:9092',
    clientConfig: path.join(os.homedir(), 'secrets', 'kafka.properties'),
    binDir: '/opt/kafka/bin',
    writes: true,
    description: 'd',
    allow: ['topics --list'],
  });
  assert.equal(one({ clientConfig: '/etc/kafka//c.properties' }).clientConfig, '/etc/kafka/c.properties');
  assert.equal(one({ binDir: '~/kafka/bin' }).binDir, path.join(os.homedir(), 'kafka', 'bin'));
  assert.equal(one({ writes: false }).writes, false);
  assert.equal(one({ bootstrap: '.:1' }).bootstrap, '.:1');
});

test('every mistake in a kafka entry is an inventory error that names the field', () => {
  fails({ shell: true }, 'kafka "k": unknown key "shell"');
  const bootstrap = 'kafka "k": bootstrap: must be one or more host:port joined by commas (a host of letters, digits, dots and "-" that does not start with "-", and a port from 1 to 65535)';
  for (const value of [undefined, '', 5, null, ['a:1'], 'host', 'host:', ':1', 'host:0', 'host:65536', 'host:070', 'host:1x', '-host:1', 'ho st:1', 'host:1,', ',host:1', 'a:1,,b:2', 'a:1, b:2', 'user@host:1', 'host:1/x', '[::1]:9092', 'h_h:1', `${'h'.repeat(254)}:1`, 'host:99999']) {
    fails({ bootstrap: value }, bootstrap);
  }
  const absolute = (field) => `kafka "k": ${field}: must be an absolute path or start with "~/"`;
  const nonEmpty = (field) => `kafka "k": ${field}: must be a non-empty path`;
  for (const field of ['clientConfig', 'binDir']) {
    for (const value of ['rel/path', './x', '~user/x', 'file.properties']) fails({ [field]: value }, absolute(field));
    for (const value of ['', 5, null, ['/x'], {}]) fails({ [field]: value }, nonEmpty(field));
  }
  for (const value of ['yes', 1, 0, null, [], 'true']) fails({ writes: value }, 'kafka "k": writes: must be true or false');
  fails({ allow: 'any' }, 'kafka "k": allow: "any" is not supported for kafka targets; list the commands');
  fails({ allow: 'topics --list' }, 'kafka "k": allow: must be an array of rule strings');
  fails({ allow: ['topics ... x'] }, 'kafka "k": allow[0]: "..." is only allowed as the last token: topics ... x');
  fails({ allow: ['regex(topics (x)'] }, `kafka "k": allow[0]: regex does not compile: ${(() => { try { RegExp('topics (x'); } catch (err) { return err.message; } return ''; })()}`);
  fails({ review: { reviewer: 'r1', policy: 'p', programs: ['ls'] } }, 'kafka "k": review.programs: is only for local targets');
  fails({ review: { reviewer: 'nope', policy: 'p' } }, 'kafka "k": review.reviewer: must name an entry of "reviewers"');
  const lookaround = (i) => `kafka "k": allow[${i}]: a regex rule of a kafka target may not use a lookaround, (?= (?! (?<= or (?<!, because ksproxy could not tell which options the rule allows`;
  for (const rule of ['regex(topics (?!(--delete))\\S+( \\S+)*)', 'regex(topics(?= --list) --list)', 'regex((?<=x)topics)', 'regex((?<!x)topics --list)']) {
    fails({ allow: ['topics --list', rule] }, lookaround(1));
  }
  for (const rule of ['regex(topics \\(?=x)', 'regex(topics [(?!]x)', 'regex(topics (?:--list|--describe))']) {
    assert.deepEqual(one({ allow: [rule] }).allow, [rule], rule);
  }
  fails({ description: 5 }, 'kafka "k": description: must be a string');
  assert.throws(() => validateInventory({ kafka: [{ bootstrap: 'a:1' }] }), /kafka #0: name/);
});

test('the sample is the entry of the documentation and validates', () => {
  const [sample] = kafkaKind.sample;
  assert.equal(sample.name, 'kafka-prod');
  assert.equal(sample.bootstrap, 'kafka.internal:9093');
  assert.equal(sample.writes, false);
  assert.ok(sample.allow.includes('topics --describe --topic *'));
  assert.equal(validateInventory({ kafka: structuredClone(kafkaKind.sample) }).kafka[0].kind, 'kafka');
});

test('the first word picks the client from the fixed table and any other first word is refused', () => {
  const allow = FIRST_WORDS.map((word) => `${word} ...`);
  for (const word of FIRST_WORDS) {
    assert.deepEqual(decideWith({ allow }, `${word} x`), { allowed: true, rule: `${word} ...`, argv: [word, 'x'] });
  }
  for (const word of ['kafka-topics', 'kafka-topics.sh', 'Topics', 'TOPICS', 'constructor', '__proto__', 'produce', 'consume', 'console-consumer', '/usr/bin/id', 'topic', 'topicsx', 'toString']) {
    const decision = decideWith({ allow: ['regex(.*)'] }, `${word} --list`);
    assert.deepEqual(decision, {
      allowed: false, reason: `unknown kafka command "${word}": the first word must be one of topics, groups, configs, acls, log-dirs, broker-api-versions`, short: 'unknown kafka command',
    }, word);
  }
  assert.match(decideWith({}, `${'a'.repeat(300)} x`).reason, /^unknown kafka command "a{63}…": /);
});

test('plain words only: the tokenizer refuses shell syntax, an empty call and a call that is not text', () => {
  const call = (input) => decideWith({ allow: ['topics ...'] }, input);
  for (const [input, short] of [
    ['topics --list; id', 'character ";" not allowed'], ['topics $(id)', 'character "$" not allowed'], ['topics a|b', 'character "|" not allowed'],
    ['topics "a b"', 'character """ not allowed'], ['topics a>b', 'character ">" not allowed'], ['topics ~/x', 'character "~" not allowed'],
    ['topics *', 'character "*" not allowed'], ['--list', 'starts with "-"'], ['', 'empty command'], ['x'.repeat(5000), 'command too long'],
    [['topics'], 'invalid command'],
  ]) {
    const decision = call(input);
    assert.equal(decision.allowed, false, String(input));
    assert.equal(decision.short, short, String(input));
    assert.equal(decision.unmatched, undefined, String(input));
  }
});

test('the rules use the shared matcher on all the words; a wildcard never takes a flag; a regex rule must write a flag whole', () => {
  const target = { allow: ALLOW };
  const call = (input) => decideWith(target, input);
  assert.equal(call('topics --list').rule, 'topics --list');
  assert.equal(call('topics --describe --topic orders').rule, 'topics --describe --topic *');
  assert.equal(call('configs --describe --entity-type topics --entity-name orders').rule, 'configs --describe --entity-type topics --entity-name *');
  assert.equal(call('broker-api-versions').rule, 'broker-api-versions');
  assert.equal(call('acls --list').rule, 'regex(acls --list|acls --list --principal [A-Za-z:]+)');
  assert.equal(call('acls --list --principal User:bob').rule, 'regex(acls --list|acls --list --principal [A-Za-z:]+)');
  const unlisted = (input, argv) => assert.deepEqual(call(input), {
    allowed: false, reason: `not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}`, short: 'not on allowlist', unmatched: true, argv,
  });
  unlisted('topics --describe --topic --list', ['topics', '--describe', '--topic', '--list']);
  unlisted('topics --describe --topic orders extra', ['topics', '--describe', '--topic', 'orders', 'extra']);
  unlisted('topics --list --exclude-internal', ['topics', '--list', '--exclude-internal']);
  unlisted('groups --describe --group g --members', ['groups', '--describe', '--group', 'g', '--members']);
  unlisted('acls --list --principal --x', ['acls', '--list', '--principal', '--x']);
  unlisted('acls', ['acls']);
  assert.equal(decideWith({ allow: ['topics ...'] }, 'topics --list').unmatched, true, '... never takes a flag');
  assert.equal(decideWith({ allow: ['topics ...'] }, 'topics a b c').rule, 'topics ...');
  assert.equal(decideWith({ allow: ['topics --list ...'] }, 'topics --list x').rule, 'topics --list ...');
  assert.equal(decideWith({ allow: ['regex(.*)'] }, 'topics --list').unmatched, true, 'regex(.*) does not write the flag');
  assert.equal(decideWith({ allow: ['regex(.*)'] }, 'topics orders').rule, 'regex(.*)');
  assert.equal(decideWith({ allow: ['regex(topics (--list|--describe))'] }, 'topics --list').rule, 'regex(topics (--list|--describe))');
  assert.equal(decideWith({ allow: ['regex(topics(?: --describe){0}( \\S+)*)'] }, 'topics --describe').unmatched, true, 'a flag in a group repeated zero times is not written');
  assert.equal(decideWith({ allow: ['regex(topics( --list)?( \\S+)*)'] }, 'topics --list').unmatched, true, 'nor in a group that may be skipped');
  assert.equal(decideWith({ allow: ['regex(topics( --list)( \\S+)*)'] }, 'topics --list').rule, 'regex(topics( --list)( \\S+)*)');
  assert.equal(decideWith({ allow: ['topics --describe --topic *'] }, 'topics --describe --topic=orders').unmatched, true);
  assert.deepEqual(decideWith({ allow: [] }, 'topics --list'), {
    allowed: false, reason: 'the allowlist for this target is empty, so every command is refused', short: 'allowlist is empty', unmatched: true, argv: ['topics', '--list'],
  });
});

test('fixed refusals: an option that changes the server or the client configuration or names a file, on every path', () => {
  const rules = [['topics ...'], ['regex(.*)'], ['regex(topics .*)'], ['topics --list ...'], ['regex(topics .*)', 'topics ...', 'groups ...', 'configs ...']];
  const words = [...FORBIDDEN, ...GENERIC];
  for (const word of FORBIDDEN) {
    words.push(word.toUpperCase(), `${word}=x`, `${word.toUpperCase()}=a=b`, word.slice(1), `${word}s`, `${word}-x`, `${word}.x`);
  }
  for (const word of words) {
    for (const allow of rules) {
      for (const writes of [false, true]) {
        for (const [input, bad] of [[`topics --list ${word} x`, word], [`topics ${word}`, word], [`groups ${word}=y --list`, `${word}=y`], [`configs --describe --entity-type topics ${word}`, word]]) {
          const decision = decideWith({ allow, writes }, input);
          assert.deepEqual(decision, {
            allowed: false,
            reason: `"${bad}" changes the server or the client configuration, or names a file, a configuration or a property: the user fixes those for this target`,
            short: 'fixed option refused',
          }, `${input} with ${allow}`);
        }
      }
    }
  }
  assert.equal(decideWith({ allow: ['regex(topics --describe --topic .*)'] }, 'topics --describe --topic x').rule, 'regex(topics --describe --topic .*)');
  for (const word of ['--entity-type', '--entity-name', '--entity-default', '--describe', '--all', '--topic', '--group', '--list', '--members', '--state', '--verbose', '--principal', '--exclude-internal', '--timeout', '--topic-list', '--broker-list', '--under-replicated-partitions', '--entity-type=topics', '-x']) {
    assert.equal(decideWith({ allow: [`regex(topics ${word.replaceAll('.', '\\.')})`] }, `topics ${word}`).allowed, true, word);
  }
  assert.equal(decideWith({ allow: ['configs --describe --entity-type topics --entity-name *'] }, 'configs --describe --entity-type topics --entity-name x').allowed, true);
});

test('fixed refusals: write flags need writes on and a rule, and a reviewer cannot approve them', () => {
  const rules = [['topics ...'], ['regex(.*)'], ['topics --list ...'], ['topics --create --topic * --partitions *', 'regex(topics .*)']];
  const flagged = [...WRITE_FLAGS, ...WRITE_FLAGS.map((flag) => flag.toUpperCase()), ...WRITE_FLAGS.map((flag) => `${flag}=3`), ...WRITE_FLAGS.map((flag) => flag.slice(1))];
  for (const flag of flagged) {
    for (const allow of [...rules, [`regex(topics --list ${flag.replace(/[-.=]/g, '\\$&')} .*)`]]) {
      const decision = decideWith({ allow, writes: false }, `topics --list ${flag} x`);
      assert.deepEqual(decision, {
        allowed: false, reason: `"${flag}" is a write flag and writes are off for this target`, short: 'writes are off',
      }, `${flag} with ${allow}`);
      assert.equal(decision.unmatched, undefined);
    }
  }
  for (const flag of ['--create', '--delete', '--partitions=3', '-alter', '--ADD-CONFIG']) {
    const decision = decideWith({ allow: ['topics ...', 'regex(.*)'], writes: true }, `topics ${flag} --topic x`);
    assert.deepEqual(decision, {
      allowed: false, reason: `"${flag}" needs a rule that names it: a wildcard or a reviewer cannot allow a write`, short: 'write needs a rule',
    }, flag);
    assert.equal(decision.unmatched, undefined, 'never sent to a reviewer');
  }
  assert.equal(decideWith({ allow: [], writes: true }, 'topics --create').short, 'write needs a rule');
  const named = { allow: ['topics --create --topic * --partitions *', 'topics --delete --topic old'], writes: true };
  assert.deepEqual(decideWith(named, 'topics --create --topic new --partitions 3'), {
    allowed: true, rule: 'topics --create --topic * --partitions *', argv: ['topics', '--create', '--topic', 'new', '--partitions', '3'],
  });
  assert.equal(decideWith(named, 'topics --delete --topic old').rule, 'topics --delete --topic old');
  assert.equal(decideWith(named, 'topics --delete --topic other').short, 'write needs a rule');
  assert.equal(decideWith({ allow: ['regex(topics --delete --topic .*)'], writes: true }, 'topics --delete --topic x').allowed, true);
  assert.equal(decideWith({ allow: ['topics --create --topic *'], writes: false }, 'topics --create --topic x').short, 'writes are off');
});

test('an abbreviation of a write flag, two characters or more after the dashes, counts as that write flag', () => {
  for (const flag of ['--del', '--de', '--alte', '--partit', '--cr', '--reset-off', '--to-ear', '-shift', '--Repl', '--by=1', '--forc']) {
    assert.deepEqual(decideWith({ allow: ['topics ...'], writes: false }, `topics --list ${flag} x`), {
      allowed: false, reason: `"${flag}" is a write flag and writes are off for this target`, short: 'writes are off',
    }, flag);
    assert.equal(decideWith({ allow: ['regex(.*)'], writes: true }, `topics --list ${flag} x`).short, 'write needs a rule', flag);
  }
  for (const word of ['--d', '-a', '--describe', '--topic', '--all-groups', '--members', '--offsets', '--state', '--verbose', '--exclude-internal', '--if-exists', '--timeout', '--dry-run', '--export', '--type']) {
    assert.equal(decideWith({ allow: [`topics --list ${word} x`], writes: false }, `topics --list ${word} x`).allowed, true, word);
  }
});

test('fixed refusals: a word that points at a file on this machine, except where a name follows --topic, --group, --entity-name or --principal', () => {
  const rules = [['topics ... x'], ['regex(.*)'], ['topics * *', 'topics --describe --topic * *', 'topics * * *'], ['regex(topics [^ ]+ [^ ]+)']];
  const bad = ['/etc/passwd', '/x', '../x', 'a/../b', '../../etc/hosts', './x', '.hidden/x', '/', 'x=/etc/passwd', 'x=../y', 'path=a/../b', '--out=/etc/x', '.ssh/id', '~/x', '~root/x'];
  const refused = (word) => ({
    allowed: false, reason: `"${word}" looks like a path on this machine: a word with a "/" that starts with "/", "~" or "." or holds a ".." part is refused`, short: 'path refused',
  });
  for (const word of bad.filter((w) => !w.includes('~'))) {
    for (const allow of rules) {
      assert.deepEqual(decideWith({ allow }, `topics x ${word}`), refused(word), `${word} with ${allow}`);
      assert.deepEqual(decideWith({ allow }, `topics ${word} x`), refused(word), `${word} first with ${allow}`);
    }
  }
  for (const word of ['~/x', '~root/x']) assert.equal(decideWith({ allow: ['regex(.*)'] }, `topics ${word}`).short, 'character "~" not allowed');
  const allow = ['topics --describe --topic *', 'groups --describe --group *', 'configs --describe --entity-type topics --entity-name *', 'acls --list --principal *', 'topics *', 'regex(.*)'];
  for (const [input, rule] of [
    ['topics --describe --topic /etc/passwd', 'topics --describe --topic *'], ['topics --describe --topic ../x', 'topics --describe --topic *'],
    ['groups --describe --group a/../b', 'groups --describe --group *'], ['configs --describe --entity-type topics --entity-name /x/y', 'configs --describe --entity-type topics --entity-name *'],
    ['acls --list --principal /x', 'acls --list --principal *'], ['topics a/b', 'topics *'], ['topics a.b/c', 'topics *'], ['topics x.y.z', 'topics *'],
  ]) {
    assert.equal(decideWith({ allow }, input).rule, rule, input);
  }
  assert.equal(decideWith({ allow: ['regex(topics --topic=/etc/x)'] }, 'topics --topic=/etc/x').rule, 'regex(topics --topic=/etc/x)');
  assert.equal(decideWith({ allow: ['regex(topics --TOPIC=/etc/x)'] }, 'topics --TOPIC=/etc/x').allowed, true);
  assert.equal(decideWith({ allow: ['regex(topics --topic=.*)'] }, 'topics --topic=/etc/x').short, 'not on allowlist', 'the name after = is not a path refusal, and the pattern does not write the flag whole');
  assert.equal(decideWith({ allow }, 'topics --describe --topic x /etc/passwd').short, 'path refused');
  assert.equal(decideWith({ allow: ['regex(.*)'] }, 'topics --Topic /etc/x').short, 'not on allowlist', 'the flag names a value, so the path is not the refusal; a regex rule that does not write the flag does not allow it');
});

test('an argument file is refused whatever the rules say', () => {
  for (const word of ['@args', '@/etc/passwd', '@']) {
    const decision = decideWith({ allow: ['regex(.*)', 'topics ...'] }, `topics ${word}`);
    assert.equal(decision.allowed, false, word);
    assert.equal(decision.unmatched, undefined, word);
  }
  assert.deepEqual(decideWith({ allow: ['regex(.*)'] }, 'topics @args'), {
    allowed: false, reason: '"@args" looks like an argument file: a word that starts with "@" is refused', short: 'path refused',
  });
});

test('a call for a client that was not found is refused with a clear text', () => {
  const partial = { programs: { topics: '/opt/kafka/bin/kafka-topics' }, allow: ['topics ...', 'groups ...'] };
  assert.equal(decideWith(partial, 'topics x').allowed, true);
  assert.deepEqual(decideWith(partial, 'groups x'), {
    allowed: false, reason: 'the client kafka-consumer-groups was not found when this target opened, so groups cannot be used', short: 'client not found',
  });
});

test('resolving the clients: the bare name, then name.sh, on PATH or in binDir, and the cases that find none', () => {
  const base = scratch();
  const state = path.join(base, 'st');
  const config = path.join(base, 'cfg');
  fs.mkdirSync(state);
  fs.mkdirSync(config);
  const env = { PATH: `relative/bin:${process.env.PATH}`, KSPROXY_STATE_DIR: state, KSPROXY_CONFIG_DIR: config };
  const target = (extra = {}) => ({ ...decideTarget(), ...extra });
  const open = (extra, over = {}) => kafkaKind.open(target(extra), { env: { ...env, ...over }, secrets: {} });

  const both = makeBin(base, { sh: ['kafka-acls', 'kafka-log-dirs'] });
  fs.writeFileSync(path.join(both, 'kafka-acls'), '#!/bin/sh\n', { mode: 0o755 });
  const found = open({ binDir: both });
  assert.equal(found.ok, true);
  assert.deepEqual(found.notes, []);
  assert.deepEqual(found.extras.programs, {
    topics: path.join(both, 'kafka-topics'),
    groups: path.join(both, 'kafka-consumer-groups'),
    configs: path.join(both, 'kafka-configs'),
    acls: path.join(both, 'kafka-acls'),
    'log-dirs': path.join(both, 'kafka-log-dirs.sh'),
    'broker-api-versions': path.join(both, 'kafka-broker-api-versions'),
  });

  const partial = makeBin(base, { names: ['kafka-topics', 'kafka-acls'], sh: ['kafka-acls'] });
  fs.writeFileSync(path.join(partial, 'kafka-configs'), '#!/bin/sh\n', { mode: 0o644 });
  const some = open({ binDir: partial });
  assert.deepEqual(Object.keys(some.extras.programs), ['topics', 'acls']);
  assert.deepEqual(some.notes, [
    'kafka-consumer-groups was not found: calls that need it are refused',
    'kafka-configs was not found: calls that need it are refused',
    'kafka-log-dirs was not found: calls that need it are refused',
    'kafka-broker-api-versions was not found: calls that need it are refused',
  ]);

  const empty = fs.mkdtempSync(path.join(base, 'empty-'));
  assert.deepEqual(open({ binDir: empty }), { ok: false, error: `none of the Kafka client programs was found in ${empty}` });
  assert.deepEqual(open({ binDir: path.join(base, 'no-such-dir') }), { ok: false, error: `none of the Kafka client programs was found in ${path.join(base, 'no-such-dir')}` });

  const onPath = makeBin(base, { sh: ['kafka-configs'] });
  const viaPath = open({ binDir: null }, { PATH: `relative/bin:${onPath}` });
  assert.equal(viaPath.extras.programs.topics, path.join(onPath, 'kafka-topics'));
  assert.equal(viaPath.extras.programs.configs, path.join(onPath, 'kafka-configs.sh'));
  assert.deepEqual(open({ binDir: null }, { PATH: '/usr/bin:/bin' }), { ok: false, error: 'none of the Kafka client programs was found on PATH' });
  assert.deepEqual(open({ binDir: null }, { PATH: undefined }), { ok: false, error: 'none of the Kafka client programs was found on PATH' });

  const inside = makeBin(state);
  assert.deepEqual(open({ binDir: inside }), { ok: false, error: `none of the Kafka client programs was found in ${inside}` });

  const properties = makeConfig(base);
  assert.equal(open({ binDir: both, clientConfig: properties }).ok, true);
  const missing = path.join(base, 'missing.properties');
  assert.deepEqual(open({ binDir: both, clientConfig: missing }), { ok: false, error: `clientConfig ${missing} is not a regular file that exists` });
  assert.deepEqual(open({ binDir: both, clientConfig: base }), { ok: false, error: `clientConfig ${base} is not a regular file that exists` });
  const link = path.join(base, 'link.properties');
  fs.symlinkSync(properties, link);
  assert.equal(open({ binDir: both, clientConfig: link }).ok, true, 'a link to a regular file is a regular file');
  const dangling = path.join(base, 'dangling.properties');
  fs.symlinkSync(missing, dangling);
  assert.equal(open({ binDir: both, clientConfig: dangling }).ok, false);
  assert.equal(open({ binDir: empty, clientConfig: missing }).error, `clientConfig ${missing} is not a regular file that exists`, 'the file is checked first');

  assert.deepEqual(kafkaKind.forCheck(target({ binDir: both }), { env }), { target: { ...target({ binDir: both }), programs: found.extras.programs } });
  assert.deepEqual(kafkaKind.forCheck(target({ binDir: empty }), { env }), { refusal: `none of the Kafka client programs was found in ${empty}` });
  assert.deepEqual(kafkaKind.forCheck(target({ binDir: both, clientConfig: missing }), { env }), { refusal: `clientConfig ${missing} is not a regular file that exists` });
});

test('the target in the menu, the opening line, the record, the messages and the secret file', () => {
  const target = (extra = {}) => decideTarget({ description: 'prod', bootstrap: 'a:1,b:2', ...extra });
  assert.equal(kafkaKind.hint(target()), 'a:1,b:2 - prod');
  assert.equal(kafkaKind.hint(target({ description: '' })), 'a:1,b:2');
  assert.equal(kafkaKind.openingMessage(target()), 'a:1,b:2, no client configuration, writes off');
  assert.equal(kafkaKind.openingMessage(target({ clientConfig: '/s/k.properties', writes: true })), 'a:1,b:2, with a client configuration file, writes on');
  assert.ok(!kafkaKind.openingMessage(target({ clientConfig: '/s/k.properties' })).includes('/s/k.properties'));
  const opened = { target: target({ clientConfig: '/s/k.properties', allow: ['topics --list'] }), programs: { topics: '/b/kafka-topics' } };
  assert.deepEqual(kafkaKind.record(opened, { reviewed: true }), {
    kind: 'kafka', name: 'k', description: 'prod', allow: ['topics --list'], bootstrap: 'a:1,b:2', clientConfig: '/s/k.properties', writes: false, programs: { topics: '/b/kafka-topics' }, state: 'up', review: true,
  });
  assert.equal(kafkaKind.record(opened, { reviewed: false }).review, undefined);
  assert.equal(kafkaKind.downMessage(), 'the call service is not answering');
  assert.equal(kafkaKind.backMessage, 'the call service is back');
  assert.deepEqual(kafkaKind.secretFiles([target(), target({ clientConfig: '/s/a.properties' }), target({ clientConfig: '/s/b.properties' })]), ['/s/a.properties', '/s/b.properties']);
  assert.deepEqual(kafkaKind.secretFiles([]), []);
});

test('perform runs the resolved client with the server, the client configuration and the words after the first', async () => {
  const base = scratch();
  const bin = makeBin(base);
  const properties = makeConfig(base);
  const env = {
    PATH: process.env.PATH, KSPROXY_STATE_DIR: path.join(base, 'st'), KAFKA_TEST_OTHER: 'not-this-one', KSPROXY_X: 'no',
  };
  const ctx = {
    env, secrets: {}, timeoutMs: 10000, maxBytes: 262144, signal: new AbortController().signal,
  };
  const recorded = (extra) => ({
    ...decideTarget({ bootstrap: 'a.example:9092,b.example:9093', programs: Object.fromEntries(FIRST_WORDS.map((word) => [word, path.join(bin, PROGRAMS[word])])) }), ...extra,
  });
  for (const word of FIRST_WORDS) {
    const result = await kafkaKind.perform(recorded(), { allowed: true, rule: 'r', argv: [word, '--describe', 'x'] }, ctx);
    const report = JSON.parse(result.stdout);
    assert.equal(report.program, PROGRAMS[word]);
    assert.deepEqual(report.argv, ['--bootstrap-server', 'a.example:9092,b.example:9093', '--describe', 'x']);
    assert.equal(report.env.KAFKA_TEST_OTHER, undefined);
    assert.ok(Object.keys(report.env).every((key) => !key.startsWith('KSPROXY_')));
  }
  const withConfig = await kafkaKind.perform(recorded({ clientConfig: properties }), { allowed: true, rule: 'review', argv: ['topics', '--list'] }, ctx);
  assert.deepEqual(JSON.parse(withConfig.stdout).argv, ['--bootstrap-server', 'a.example:9092,b.example:9093', '--command-config', properties, '--list']);
  assert.ok(!withConfig.stdout.includes(CONFIG_LINE) && !withConfig.stderr.includes(CONFIG_LINE));
  const bare = await kafkaKind.perform(recorded(), { allowed: true, rule: 'r', argv: ['broker-api-versions'] }, ctx);
  assert.deepEqual(JSON.parse(bare.stdout).argv, ['--bootstrap-server', 'a.example:9092,b.example:9093']);
  assert.deepEqual(fs.readdirSync(path.join(base, 'st', WORK_FOLDER)), []);
});

test('the notes for the agent: the table, what is fixed, what is refused, writes and review', () => {
  const target = (extra = {}) => ({ ...decideTarget({ description: 'prod cluster', allow: ['topics --list', 'groups --list'], clientConfig: '/secret/place/c.properties', bootstrap: 'secret-host:9093' }), ...extra });
  const notes = kafkaKind.agentSection(target({ review: true }));
  assert.ok(notes.includes('a flag is allowed only where the user wrote it into a rule, or when the target has a reviewer and it approves a call that no rule matches (never one with a write flag).'));
  assert.match(notes, /^### Kafka target `k` - prod cluster\n\n- Tool: `kafka_exec` with `target: "k"`/);
  assert.ok(notes.includes('`topics` runs kafka-topics, `groups` kafka-consumer-groups, `configs` kafka-configs, `acls` kafka-acls, `log-dirs` kafka-log-dirs and `broker-api-versions` kafka-broker-api-versions'));
  assert.ok(notes.includes('Any other first word is refused.'));
  assert.ok(notes.includes('- Allowed commands: topics --list; groups --list'));
  assert.ok(notes.includes('The user fixed the server address and the client configuration'));
  assert.ok(notes.includes('--bootstrap-server'));
  assert.ok(notes.includes('--command-config'));
  assert.ok(notes.includes('any option whose name holds file, config or property'));
  assert.ok(notes.includes('a word that points at a file on this machine'));
  assert.ok(notes.includes('Write flags (--create, --delete, --alter, --add, --remove, --add-config, --delete-config, --reset-offsets, --delete-offsets, --execute, --partitions, --replication-factor, --replica-assignment, --force, --delete-records, --to-earliest, --to-latest, --to-offset, --to-datetime, --to-current, --shift-by, --by-duration) are refused unless the user turned writes on for this target and a rule allows the command; writes are off here. An abbreviation of a write flag, such as `--del`, counts as that flag.'));
  assert.ok(notes.includes('never a word that starts with `-`'));
  assert.ok(notes.includes('no shell runs it'));
  assert.ok(notes.endsWith('- A command that is not on this list is reviewed before it runs and may be refused.'));
  assert.ok(!notes.includes('secret-host') && !notes.includes('/secret/place'));
  const writable = kafkaKind.agentSection(target({ writes: true, description: '' }));
  assert.ok(writable.startsWith('### Kafka target `k`\n'));
  assert.ok(writable.includes('writes are on here.'));
  assert.ok(!writable.includes('reviewed before'));
});

test('the tool is listed when the inventory holds a kafka target, and AGENT.md lists it for a session that has one', () => {
  const names = (tools) => tools.map((t) => t.name);
  assert.ok(!names(toolDefinitions({ ssh: [{}] })).includes('kafka_exec'));
  assert.ok(names(toolDefinitions({ kafka: [{}] })).includes('kafka_exec'));
  assert.ok(names(toolDefinitions(null)).includes('kafka_exec'));
  const properties = kafkaKind.tool.definition.inputSchema;
  assert.deepEqual(properties.required, ['target', 'command']);
  assert.equal(properties.properties.timeout_seconds.maximum, 600);
  const text = agentMdText({ targets: [{ ...decideTarget({ allow: ['topics --list'] }), state: 'up' }] });
  assert.ok(text.includes('- `kafka_exec { target, command, timeout_seconds? }` - run one allowlisted Kafka client command on a kafka target.\n'));
  assert.ok(text.includes('### Kafka target `k`'));
});

async function kafkaWorld({ targets, reviewer, extra = {} } = {}) {
  const world = await makeWorld(extra);
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  const outside = scratch();
  world.outside = outside;
  world.bin = makeBin(outside, { log: path.join(outside, 'starts.log'), sh: ['kafka-log-dirs'] });
  world.startsLog = path.join(outside, 'starts.log');
  world.properties = makeConfig(outside);
  world.targets = targets ?? [{
    name: 'kafka-prod', bootstrap: 'kafka.internal:9093', clientConfig: world.properties, binDir: world.bin, description: 'prod cluster', allow: ALLOW,
  }];
  inventory.kafka = world.targets;
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.inventoryFile = file;
  world.workRoot = path.join(world.env.KSPROXY_STATE_DIR, WORK_FOLDER);
  return world;
}

test('ksproxy check kafka: the words of a call, a client that is missing, and a bad client configuration', async () => {
  const world = await kafkaWorld();
  const check = (...words) => cli(['check', 'kafka', 'kafka-prod', ...words], world.env);
  assert.deepEqual(await check('topics', '--describe', '--topic', 'orders'), { code: 0, stdout: 'ALLOWED by rule: topics --describe --topic *\n', stderr: '' });
  assert.equal((await check('topics', '--list', '--bootstrap-server', 'x:1')).stdout, 'REFUSED: "--bootstrap-server" changes the server or the client configuration, or names a file, a configuration or a property: the user fixes those for this target\n');
  assert.equal((await check('topics', '--delete', '--topic', 'x')).stdout, 'REFUSED: "--delete" is a write flag and writes are off for this target\n');
  assert.equal((await check('produce', 'x')).stdout.startsWith('REFUSED: unknown kafka command "produce"'), true);
  assert.equal((await check('topics', '--list', '--verbose')).stdout, `REFUSED: not on the allowlist for this target. Allowed: ${ALLOW.join('; ')}\n`);
  const file = world.inventoryFile;
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  const empty = fs.mkdtempSync(path.join(world.outside, 'empty-'));
  inventory.kafka[0].binDir = empty;
  fs.writeFileSync(file, JSON.stringify(inventory));
  assert.equal((await check('topics', '--list')).stdout, `REFUSED: none of the Kafka client programs was found in ${empty}\n`);
  inventory.kafka[0].binDir = world.bin;
  inventory.kafka[0].clientConfig = path.join(world.outside, 'gone.properties');
  fs.writeFileSync(file, JSON.stringify(inventory));
  assert.equal((await check('topics', '--list')).stdout, `REFUSED: clientConfig ${path.join(world.outside, 'gone.properties')} is not a regular file that exists\n`);
});

test('the client configuration is a secret file: local targets cannot reach it', async () => {
  const world = await kafkaWorld();
  const inventory = validateInventory(JSON.parse(fs.readFileSync(world.inventoryFile, 'utf8')));
  assert.deepEqual(secretFilesOf(inventory).filter((file) => file === world.properties), [world.properties]);
  const file = world.inventoryFile;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.local = [{ name: 'beside', cwd: world.outside, description: 'the folder with the client configuration', allow: ['ls ...'] }];
  fs.writeFileSync(file, JSON.stringify(raw));
  const verdict = await cli(['check', 'local', 'beside', 'ls'], world.env);
  assert.deepEqual(verdict, { code: 1, stdout: 'REFUSED: folder contains a kubeconfig named in the inventory\n', stderr: '' });
});

test('a session with kafka targets: the exact call, every fixed refusal before any run, limits, review, every audit once, no secret anywhere', async () => {
  const reviewer = await provider();
  const world = await kafkaWorld({ reviewer });
  const outside = world.outside;
  const partial = makeBin(outside, { names: ['kafka-topics'], log: world.startsLog });
  const targets = [
    {
      name: 'kafka-prod', bootstrap: 'kafka.internal:9093', clientConfig: world.properties, binDir: world.bin, description: 'prod cluster', allow: ALLOW, review: { reviewer: 'r1', policy: 'read only' },
    },
    {
      name: 'kafka-w', bootstrap: 'w.internal:9092', binDir: world.bin, writes: true, allow: ['topics --create --topic * --partitions *', 'topics --delete --topic old'], review: { reviewer: 'r1', policy: 'anything' },
    },
    {
      name: 'part', bootstrap: 'p:1', binDir: partial, allow: ['topics ...', 'groups ...'],
    },
    { name: 'gone', bootstrap: 'g:1', clientConfig: path.join(outside, 'gone.properties'), binDir: world.bin },
    { name: 'none', bootstrap: 'n:1', binDir: fs.mkdtempSync(path.join(outside, 'empty-')) },
  ];
  const raw = JSON.parse(fs.readFileSync(world.inventoryFile, 'utf8'));
  raw.kafka = targets;
  fs.writeFileSync(world.inventoryFile, JSON.stringify(raw));

  const run = launch(world, { kafka: ['kafka-prod', 'kafka-w', 'part', 'gone', 'none'] });
  await ready(run);
  const err = run.proc.stderr.text;
  assert.match(err, /kfk +kafka-prod +OPENING +kafka\.internal:9093, with a client configuration file, writes off\n/);
  assert.match(err, /kfk +kafka-prod +UP\n/);
  assert.match(err, /kfk +kafka-w +OPENING +w\.internal:9092, no client configuration, writes on\n/);
  assert.match(err, /kfk +part +WARN +kafka-consumer-groups was not found: calls that need it are refused\n/);
  assert.match(err, /kfk +gone +SKIPPED +clientConfig .*gone\.properties is not a regular file that exists\n/);
  assert.match(err, /kfk +none +SKIPPED +none of the Kafka client programs was found in .*empty-/);
  const replies = [];
  const ask = async (name, command, extra = {}) => {
    const reply = await callTool('kafka_exec', { target: name, command, ...extra }, world.env);
    replies.push(reply.text);
    return reply;
  };
  const bodyOf = (reply) => JSON.parse(reply.text.split('\n--- stdout ---\n')[1]);

  const described = await ask('kafka-prod', 'topics  --describe --topic orders');
  assert.equal(described.isError, false, described.text);
  assert.equal(described.text.split('\n')[0], 'exit code: 0');
  const report = bodyOf(described);
  assert.equal(report.program, 'kafka-topics');
  assert.deepEqual(report.argv, ['--bootstrap-server', 'kafka.internal:9093', '--command-config', world.properties, '--describe', '--topic', 'orders']);
  assert.match(report.cwd, /^<ksproxy>\/run\/cmd-/);
  assert.deepEqual(report.entries, []);
  assert.ok(Object.keys(report.env).every((key) => !key.startsWith('KSPROXY_')));
  assert.deepEqual(fs.readdirSync(world.workRoot), []);
  const logDirs = bodyOf(await ask('kafka-prod', 'log-dirs --describe'));
  assert.equal(logDirs.program, 'kafka-log-dirs');
  assert.deepEqual(logDirs.argv.slice(0, 2), ['--bootstrap-server', 'kafka.internal:9093']);
  assert.equal(bodyOf(await ask('kafka-w', 'topics --create --topic fresh --partitions 3')).argv.join(' '), '--bootstrap-server w.internal:9092 --create --topic fresh --partitions 3');
  assert.equal(bodyOf(await ask('kafka-w', 'topics --delete --topic old')).argv.at(-1), 'old');
  assert.equal(bodyOf(await ask('part', 'topics orders')).program, 'kafka-topics');

  assert.deepEqual((await ask('kafka-prod', 'topics fail')), { text: 'exit code: 3\n--- stderr ---\nit failed', isError: true });
  assert.deepEqual(fs.readdirSync(world.workRoot), []);
  const touched = await ask('kafka-prod', 'topics touch');
  assert.equal(touched.isError, false);
  assert.deepEqual(fs.readdirSync(world.workRoot), []);
  const flood = await ask('kafka-prod', 'topics flood');
  assert.equal(flood.isError, true);
  assert.ok(flood.text.startsWith('exit code: null\n--- stdout ---\nyyyy'));
  assert.ok(flood.text.endsWith('\n[output truncated at 262144 bytes per stream]'));
  const slow = await ask('kafka-prod', 'topics sleep', { timeout_seconds: 1 });
  assert.equal(slow.text, 'timed out after 1s');
  assert.deepEqual(fs.readdirSync(world.workRoot), []);
  const ran = lines(world.startsLog).length;
  assert.equal(ran, 9);

  const refusedCalls = [];
  for (const word of FORBIDDEN) refusedCalls.push(['kafka-prod', `topics --list ${word} x`, 'fixed option refused'], ['kafka-w', `topics ${word}=x`, 'fixed option refused']);
  for (const word of GENERIC) refusedCalls.push(['kafka-prod', `topics ${word} x`, 'fixed option refused']);
  for (const flag of WRITE_FLAGS) refusedCalls.push(['kafka-prod', `topics --list ${flag}`, 'writes are off']);
  refusedCalls.push(
    ['kafka-prod', 'topics --create --topic * --partitions 3', 'character "*" not allowed'],
    ['kafka-prod', 'topics --create --topic x --partitions 3', 'writes are off'],
    ['kafka-prod', 'topics --describe --topic x /etc/passwd', 'path refused'],
    ['kafka-prod', 'topics --describe --topic x ../up', 'path refused'],
    ['kafka-prod', 'topics @args', 'path refused'],
    ['kafka-prod', 'produce x', 'unknown kafka command'],
    ['kafka-prod', 'kafka-topics --list', 'unknown kafka command'],
    ['kafka-prod', 'topics --list; id', 'character ";" not allowed'],
    ['kafka-w', 'topics --delete --topic other', 'write needs a rule'],
    ['kafka-w', 'topics --alter --topic old', 'write needs a rule'],
    ['part', 'groups --list', 'client not found'],
    ['part', 'acls --list', 'client not found'],
  );
  const askedBefore = reviewer.asked.length;
  for (const [name, command] of refusedCalls) {
    const reply = await ask(name, command);
    assert.equal(reply.isError, true, command);
    assert.match(reply.text, new RegExp(`^REFUSED \\(kafka ${name}\\): `), command);
  }
  assert.equal(lines(world.startsLog).length, ran, 'no refused call started a client');
  assert.equal(reviewer.asked.length, askedBefore, 'no fixed refusal went to the reviewer');

  const reviewed = await ask('kafka-prod', 'groups --describe --group g1 --members');
  assert.equal(reviewed.isError, false, reviewed.text);
  assert.equal(reviewer.asked.length, askedBefore + 1);
  assert.deepEqual(JSON.parse(reviewer.asked[askedBefore].messages[1].content).command, ['groups', '--describe', '--group', 'g1', '--members']);
  assert.equal(bodyOf(reviewed).program, 'kafka-consumer-groups');
  assert.equal(lines(world.startsLog).length, ran + 1);

  assert.equal((await ask('kafka-prod', ['topics'])).text, 'invalid arguments: command must be a string');
  assert.equal((await ask('nope', 'topics --list')).text, 'unknown kafka target "nope". Open targets: kafka-prod, kafka-w, part');
  assert.equal((await ask('gone', 'topics --list')).text, 'unknown kafka target "gone". Open targets: kafka-prod, kafka-w, part');

  const recorded = JSON.parse(fs.readFileSync(path.join(world.sessionDir, 'session.json'), 'utf8')).targets.filter((t) => t.kind === 'kafka');
  assert.deepEqual(recorded.map((t) => t.name), ['kafka-prod', 'kafka-w', 'part']);
  assert.deepEqual(recorded[0], {
    kind: 'kafka',
    name: 'kafka-prod',
    description: 'prod cluster',
    allow: ALLOW,
    bootstrap: 'kafka.internal:9093',
    clientConfig: world.properties,
    writes: false,
    programs: {
      topics: path.join(world.bin, 'kafka-topics'),
      groups: path.join(world.bin, 'kafka-consumer-groups'),
      configs: path.join(world.bin, 'kafka-configs'),
      acls: path.join(world.bin, 'kafka-acls'),
      'log-dirs': path.join(world.bin, 'kafka-log-dirs.sh'),
      'broker-api-versions': path.join(world.bin, 'kafka-broker-api-versions'),
    },
    state: 'up',
    review: true,
  });
  const notes = fs.readFileSync(path.join(world.sessionDir, 'AGENT.md'), 'utf8');
  assert.ok(notes.includes('`kafka_exec {'));
  assert.ok(!notes.includes('kafka.internal') && !notes.includes(world.properties));
  await waitFor(() => /kfk +nope +DENIED/.test(run.proc.stdout.text), 10000, 'the live lines');
  assert.equal(await stopWith(run), 0);

  const calls = kafkaCalls(world);
  assert.equal(calls.length, 9 + refusedCalls.length + 1 + 3);
  assert.equal(calls[0].command, 'topics  --describe --topic orders');
  assert.equal(calls[0].rule, 'topics --describe --topic *');
  assert.equal(calls[8].timedOut, true);
  const refusedShorts = calls.filter((e) => e.decision === 'refused').map((e) => e.short);
  assert.deepEqual(refusedShorts.slice(0, refusedCalls.length), refusedCalls.map(([, , short]) => short));
  assert.deepEqual(refusedShorts.slice(refusedCalls.length), ['invalid arguments', 'unknown target', 'unknown target']);
  assert.equal(calls.filter((e) => e.rule === 'review').length, 1);

  const everything = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) everything.push(fs.readFileSync(file, 'utf8'));
  for (const text of everything) {
    assert.ok(!text.includes(CONFIG_LINE), `the configuration line in: ${text.slice(0, 200)}`);
    assert.ok(!text.includes('KAFKA-CLIENT-S3CR3T'), 'the secret part of the configuration');
  }
});

test('a stop of the session during a call kills the client and removes its folder', async () => {
  const world = await kafkaWorld();
  const run = launch(world, { kafka: ['kafka-prod'] });
  await ready(run);
  const pending = callTool('kafka_exec', { target: 'kafka-prod', command: 'topics sleep' }, world.env);
  await waitFor(() => lines(world.startsLog).length === 1 && fs.existsSync(world.workRoot) && fs.readdirSync(world.workRoot).length === 1, 10000, 'the client to start');
  assert.equal(await stopWith(run), 0);
  const answer = await pending;
  assert.equal(answer.isError, true);
  await waitFor(() => fs.readdirSync(world.workRoot).length === 0, 5000, 'the folder to be removed');
  assert.equal(kafkaCalls(world).filter((e) => e.short === 'session stopped').length, 1);
});
