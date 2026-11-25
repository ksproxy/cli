import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { validateInventory } from '../src/inventory.js';
import { KINDS, cliName, kindByKey } from '../src/kinds/index.js';
import { fakeProcess } from './start-helpers.js';
import { tempDir } from './temp.js';

// docs/EXAMPLES.md shows, for every kind, a read-only entry and a read-and-write entry, each with sample calls marked
// as allowed or refused. This test keeps that page true: every entry passes the real inventory validation, and every
// sample call gets the decision the page claims from the code that ksproxy check runs. Nothing is opened or run: check
// decides from the rules alone, and what a kind looks up first (a folder, a program, the Kafka clients) is made in a
// temporary folder.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'EXAMPLES.md'), 'utf8');
const CONFIG_DIR = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const STATE_DIR = ['KSPROXY', 'STATE', 'DIR'].join('_');
const LABELS = { 'Read-only': 'read-only', 'Read and write': 'read and write' };
const MARKER = /^\*\*(Read-only|Read and write):\*\*/;
const SAMPLE = /^- \*\*(Allowed|Refused):\*\* `([^`]+)`/;
const KAFKA_CLIENTS = ['kafka-topics', 'kafka-consumer-groups', 'kafka-configs', 'kafka-acls', 'kafka-log-dirs', 'kafka-broker-api-versions'];
// Outside quotes a shell would read these characters itself; inside double quotes these.
const SHELL_SPECIAL = '\\$`*?[]{}|&;<>()~!#';
const DOUBLE_SPECIAL = '\\$`!';

// The sections of the page: each "## kind" heading with its examples, each example with its label, the text of its
// JSON block and its sample lines. Fenced blocks are skipped when looking for headings, markers and samples.
function readPage(text) {
  const sections = [];
  let example = null;
  let fence = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (line.startsWith('```')) {
        if (example !== null && fence.json && example.json === null) example.json = fence.lines.join('\n');
        fence = null;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (line.startsWith('```')) {
      fence = { json: line.trim() === '```json', lines: [] };
      continue;
    }
    if (line.startsWith('## ')) {
      sections.push({ heading: line.slice(3).replaceAll('`', '').trim(), examples: [] });
      example = null;
      continue;
    }
    const marker = MARKER.exec(line);
    if (marker !== null) {
      assert.ok(sections.length > 0, `an example before the first kind section: ${line}`);
      example = { label: LABELS[marker[1]], json: null, samples: [] };
      sections.at(-1).examples.push(example);
      continue;
    }
    const sample = SAMPLE.exec(line);
    if (sample !== null) {
      assert.ok(example !== null && example.json !== null, `a sample call outside an example: ${line}`);
      example.samples.push({ expected: sample[1] === 'Allowed' ? 'allowed' : 'refused', line: sample[2] });
    }
  }
  assert.equal(fence, null, 'a fenced block is not closed');
  return sections;
}

// The words of a sample line as a shell would split them: single and double quotes group a word. A character that a
// shell would read itself (a glob, a variable, a redirect) must be quoted, so that a person can paste the line.
function shellWords(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (const ch of line) {
    if (quote !== null) {
      assert.ok(quote === "'" || !DOUBLE_SPECIAL.includes(ch), `"${ch}" inside double quotes in: ${line}`);
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (ch === ' ') {
      if (word !== null) words.push(word);
      word = null;
    } else {
      assert.ok(!SHELL_SPECIAL.includes(ch), `"${ch}" must be quoted in: ${line}`);
      word = (word ?? '') + ch;
    }
  }
  assert.equal(quote, null, `a quote is not closed in: ${line}`);
  if (word !== null) words.push(word);
  return words;
}

const PAGE = readPage(DOC);
// Each example with its kind; a heading that names no kind fails the first test, and its examples are left out here.
const EXAMPLES = PAGE.filter((section) => kindByKey(section.heading) !== undefined)
  .flatMap((section) => section.examples.map((example) => ({ ...example, kind: kindByKey(section.heading) })));

// An executable file that is never run: check only looks it up.
function fakeProgram(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return file;
}

// A temporary config folder whose inventory holds the entry, with what the kind's check looks up made next to it: the
// folder of a local target, the program of a command target, the clients and the client configuration of a kafka
// target. The environment names only that folder, the state folder and the temporary PATH.
function worldFor(kind, entry) {
  const base = fs.realpathSync(tempDir('ks-examples-'));
  const bin = path.join(base, 'bin');
  const config = path.join(base, 'cfg');
  fs.mkdirSync(bin);
  fs.mkdirSync(config);
  const target = { ...entry };
  if (kind.key === 'local') {
    target.cwd = path.join(base, 'work');
    fs.mkdirSync(target.cwd);
  }
  if (kind.key === 'command') {
    const program = fakeProgram(bin, path.basename(entry.program));
    if (path.isAbsolute(entry.program)) target.program = program;
  }
  if (kind.key === 'kafka') {
    for (const name of KAFKA_CLIENTS) fakeProgram(bin, name);
    target.binDir = bin;
    if (entry.clientConfig !== undefined) {
      target.clientConfig = path.join(base, 'client.properties');
      fs.writeFileSync(target.clientConfig, '');
    }
  }
  fs.writeFileSync(path.join(config, 'inventory.json'), JSON.stringify({ [kind.key]: [target] }));
  return { PATH: bin, [CONFIG_DIR]: config, [STATE_DIR]: path.join(base, 'st') };
}

test('every kind has a section with a read-only and a read-and-write example, in the order of the kinds', () => {
  assert.deepEqual(PAGE.map((section) => section.heading), KINDS.map((kind) => kind.key));
  for (const section of PAGE) {
    assert.deepEqual(section.examples.map((example) => example.label), ['read-only', 'read and write'], section.heading);
  }
});

test('every example is one valid inventory entry of its kind, with a sample call allowed and one refused', () => {
  for (const { kind, label, json, samples } of EXAMPLES) {
    const where = `${kind.key} ${label}`;
    assert.notEqual(json, null, `${where}: no JSON block`);
    const entry = JSON.parse(json);
    assert.equal(typeof entry, 'object', where);
    assert.ok(!Array.isArray(entry), where);
    assert.doesNotThrow(() => validateInventory({ [kind.key]: [entry] }), where);
    assert.ok(samples.some((sample) => sample.expected === 'allowed'), `${where}: no allowed sample`);
    assert.ok(samples.some((sample) => sample.expected === 'refused'), `${where}: no refused sample`);
  }
});

test('the read-only and the read-and-write entry of a kind have different names', () => {
  for (const section of PAGE) {
    const names = section.examples.map((example) => JSON.parse(example.json).name);
    assert.equal(new Set(names).size, names.length, section.heading);
  }
});

for (const { kind, label, json, samples } of EXAMPLES) {
  test(`${kind.key}, ${label}: ksproxy check decides each sample call as the page says`, async () => {
    const entry = JSON.parse(json);
    const env = worldFor(kind, entry);
    for (const { expected, line } of samples) {
      const words = shellWords(line);
      assert.deepEqual(words.slice(0, 4), ['ksproxy', 'check', cliName(kind), entry.name], line);
      assert.ok(words.length > 4, `no call in: ${line}`);
      const proc = fakeProcess();
      const code = await main(words.slice(1), env, { process: proc });
      const said = `${line}\n${proc.stdout.text}${proc.stderr.text}`;
      if (expected === 'allowed') {
        assert.equal(code, 0, said);
        assert.match(proc.stdout.text, /^ALLOWED by rule: /, said);
      } else {
        assert.equal(code, 1, said);
        assert.match(proc.stdout.text, /^REFUSED: /, said);
      }
      assert.equal(proc.stderr.text, '', said);
    }
  });
}
