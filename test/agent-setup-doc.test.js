import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { validateInventory } from '../src/inventory.js';
import { KINDS, cliName, flaggedKinds, kindByKey } from '../src/kinds/index.js';
import { fakeProcess } from './start-helpers.js';
import { shellWords } from './shell-words.js';
import { tempDir } from './temp.js';

// docs/AGENT-SETUP.md gives an agent's answer in two worked examples (an inventory entry, ksproxy check lines with the
// refusals they quote, and the commands to run), a prompt, and a table with one row for each kind. This test keeps the
// page true. Each entry is valid; each check line gets the verdict the page claims from the code that ksproxy check runs
// (a quoted refusal must be how the real answer begins); each doctor and start line uses only real flags and the names
// of the page; the prompt lists every kind word and every inventory list exactly; and the table agrees with the code
// on the key, the flag, the tunnel and the secret fields of each kind. Nothing is opened: check decides from the rules
// alone, in a temporary config folder.
//
// AGENT_SETUP_PAGE: an optional environment variable that names another file to read in place of docs/AGENT-SETUP.md.
// It is for trying a wrong copy of the page, to see that this test fails on it; an empty value means the real page.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = fs.readFileSync(process.env.AGENT_SETUP_PAGE || path.join(ROOT, 'docs', 'AGENT-SETUP.md'), 'utf8');
const CONFIG_DIR = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const STATE_DIR = ['KSPROXY', 'STATE', 'DIR'].join('_');
const EXAMPLES = { 'Example: logs of a service on a server': 'ssh', 'Example: a database behind a bastion server': 'postgres' };
const SAMPLE = /^- \*\*(Allowed|Refused):\*\* `([^`]+)`(.*)$/;
// A name in a command that is no entry of the page: the mcp example's target, and the placeholder of a project.
const OTHER_NAMES = ['jira', 'NAME'];

// The "## " sections of the page, each with its lines.
function sections(text) {
  const found = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    if (!fence && line.startsWith('## ')) found.push({ heading: line.slice(3), lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  return found;
}

const SECTIONS = sections(DOC);
const section = (heading) => SECTIONS.find((s) => s.heading === heading);

// The first json block of a section, and its Allowed and Refused lines with the text after the command.
function example(heading) {
  const lines = section(heading).lines;
  const start = lines.indexOf('```json');
  assert.notEqual(start, -1, `${heading}: no json block`);
  const end = lines.indexOf('```', start);
  return {
    entry: JSON.parse(lines.slice(start + 1, end).join('\n')),
    samples: lines.map((line) => SAMPLE.exec(line)).filter((m) => m !== null)
      .map((m) => ({ expected: m[1] === 'Allowed' ? 'allowed' : 'refused', line: m[2], rest: m[3] })),
  };
}

const ENTRIES = Object.keys(EXAMPLES).map((heading) => example(heading).entry);

for (const [heading, key] of Object.entries(EXAMPLES)) {
  test(`${heading}: the entry is valid and ksproxy check gives the verdicts of the page`, async () => {
    const kind = kindByKey(key);
    const { entry, samples } = example(heading);
    assert.doesNotThrow(() => validateInventory({ [kind.key]: [entry] }));
    assert.ok(samples.filter((s) => s.expected === 'allowed').length >= 2, 'two calls that are allowed');
    assert.ok(samples.filter((s) => s.expected === 'refused').length >= 2, 'two calls that are refused');
    const base = fs.realpathSync(tempDir('ks-agent-setup-'));
    fs.mkdirSync(path.join(base, 'cfg'));
    fs.writeFileSync(path.join(base, 'cfg', 'inventory.json'), JSON.stringify({ [kind.key]: [entry] }));
    const env = { [CONFIG_DIR]: path.join(base, 'cfg'), [STATE_DIR]: path.join(base, 'st') };
    for (const { expected, line, rest } of samples) {
      const words = shellWords(line);
      assert.deepEqual(words.slice(0, 4), ['ksproxy', 'check', cliName(kind), entry.name], line);
      const proc = fakeProcess();
      const code = await main(words.slice(1), env, { process: proc });
      const said = `${line}\n${proc.stdout.text}${proc.stderr.text}`;
      assert.equal(code, expected === 'allowed' ? 0 : 1, said);
      assert.equal(proc.stderr.text, '', said);
      if (expected === 'allowed') {
        assert.match(proc.stdout.text, /^ALLOWED by rule: /, said);
      } else {
        const quoted = [...rest.matchAll(/`(REFUSED: [^`]+)`/g)].map((m) => m[1]);
        assert.equal(quoted.length, 1, `a refused line quotes one refusal: ${line}`);
        assert.ok(proc.stdout.text.startsWith(quoted[0]), `the page quotes "${quoted[0]}"\n${said}`);
      }
    }
  });
}

// Every command of the page that starts ksproxy doctor or ksproxy start, from code blocks and from inline code.
function commandLines() {
  const fenced = DOC.split('\n').filter((line) => /^ksproxy (doctor|start)\b/.test(line));
  const inline = [...DOC.matchAll(/`(ksproxy (?:doctor|start)[^`]*)`/g)].map((m) => m[1]);
  return [...fenced, ...inline];
}

test('every doctor and start command uses real flags, takes values only after a flag and names the entries of the page', () => {
  const kindOfFlag = new Map(flaggedKinds().map((kind) => [`--${kind.flag}`, kind.key]));
  const entryNames = (key) => Object.entries(EXAMPLES).filter(([, k]) => k === key)
    .map(([heading]) => example(heading).entry.name);
  const allNames = new Set([...ENTRIES.map((entry) => entry.name), ...OTHER_NAMES]);
  const lines = commandLines();
  assert.ok(lines.length >= 10, 'the page has commands to check');
  for (const line of lines) {
    const words = line.replace(/\.\.\.$/, '').split(' ').slice(1);
    const command = words.shift();
    assert.ok(command === 'doctor' || command === 'start', line);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (word === '--all') continue;
      if (word === '--project') {
        i += 1;
        assert.ok(OTHER_NAMES.includes(words[i]), `${words[i]} is no project name of the page: ${line}`);
      } else if (kindOfFlag.has(word)) {
        i += 1;
        const names = [...entryNames(kindOfFlag.get(word)), ...OTHER_NAMES];
        assert.ok(names.includes(words[i]), `${words[i]} is no ${kindOfFlag.get(word)} entry of the page: ${line}`);
      } else {
        // Only doctor takes target names as plain words; start takes none.
        assert.ok(!word.startsWith('-'), `${word} is no flag of ${command}: ${line}`);
        assert.equal(command, 'doctor', `${word} is neither a flag nor the value of one: ${line}`);
        assert.ok(allNames.has(word), `${word} is no name of the page: ${line}`);
      }
    }
  }
});

test('the prompt keeps its rules of what the agent never does, and the rules section keeps the agent from start and doctor', () => {
  const prompt = /```text\n([\s\S]*?)```/.exec(DOC)[1].replace(/\s+/g, ' ');
  const never = /Never run [^.]*\./.exec(prompt)?.[0] ?? '';
  for (const command of ['ksproxy start', 'ksproxy doctor', 'ksproxy init', 'ksproxy token']) {
    assert.ok(never.includes(`\`${command}\``), `the Never run sentence names ${command}`);
  }
  for (const name of ['KSPROXY_CONFIG_DIR', 'XDG_CONFIG_HOME', 'KSPROXY_STATE_DIR', 'MCP client configuration']) {
    assert.ok(prompt.includes(name), name);
  }
  assert.match(prompt, /Never read [^.:]*any file that holds a secret/);
  assert.match(prompt, /Never edit the inventory file/);
  const rules = section('The rules that keep you in control').lines.join(' ');
  assert.match(rules, /never runs `ksproxy start`/);
  assert.match(rules, /does not run `ksproxy doctor`/);
  assert.doesNotMatch(rules, /\bmay run\b|\bcan run\b/);
});

test('the prompt lists the kind words and the inventory lists exactly', () => {
  const prompt = /```text\n([\s\S]*?)```/.exec(DOC)[1].replace(/\s+/g, ' ');
  const after = (start) => prompt.slice(prompt.indexOf(start) + start.length).split('. ')[0];
  const words = (text) => text.split(/,\s*|\s+or\s+/).map((w) => w.trim().replace(/\.$/, ''));
  assert.deepEqual(words(after('KIND is one of: ')), KINDS.map(cliName));
  assert.deepEqual(words(after('the inventory it goes in: ')), KINDS.map((kind) => kind.key));
});

// The table of every kind: one row for each kind, in order, as the cells of its line.
const ROWS = () => section('Every kind').lines.filter((line) => line.startsWith('| `')).map((line) => line.split('|').map((c) => c.trim()));

test('the table of every kind has one row for each kind, in order, with the real key and flag', () => {
  const rows = ROWS();
  assert.deepEqual(rows.map((cells) => cells[1]), KINDS.map((kind) => `\`${kind.key}\``));
  KINDS.forEach((kind, i) => {
    assert.equal(rows[i][2], `\`"${kind.key}"\``, kind.key);
    if (kind.flag === undefined) assert.ok(rows[i][3].startsWith('none'), kind.key);
    else assert.equal(rows[i][3], `\`--${kind.flag}\``, kind.key);
    assert.ok(rows[i][7].includes(`(EXAMPLES.md#${kind.key})`), kind.key);
  });
});

test('the tunnel column says yes exactly for the kinds that have a tunnel route, and its own for kubernetes', () => {
  const rows = ROWS();
  KINDS.forEach((kind, i) => {
    const cell = rows[i][5];
    if (kind.key === 'kubernetes') assert.ok(cell.startsWith('its own'), kind.key);
    else if (typeof kind.tunnelTo === 'function') assert.ok(cell.startsWith('yes'), kind.key);
    else assert.ok(cell.startsWith('no'), kind.key);
  });
});

// The fields of an entry that name an environment variable: every key that ends in Env, at any depth.
function envFields(value, found = new Set()) {
  for (const [key, inner] of Object.entries(value)) {
    if (key.endsWith('Env')) found.add(key);
    if (inner !== null && typeof inner === 'object') envFields(inner, found);
  }
  return found;
}

test('the secret column names the secret fields of each kind', () => {
  const rows = ROWS();
  const kindSource = (kind) => fs.readdirSync(path.join(ROOT, 'src', 'kinds', 'engines')).map((f) => path.join('engines', f))
    .concat(path.join(kind.key, 'index.js')).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'kinds', f), 'utf8')).join('\n');
  KINDS.forEach((kind, i) => {
    const cell = rows[i][4];
    const named = [...cell.matchAll(/`(\w+Env)`/g)].map((m) => m[1]);
    // A kind with no secret function holds no secret variable: its cell says none.
    if (typeof kind.secrets !== 'function') assert.ok(cell.startsWith('none') && named.length === 0, kind.key);
    // A field of the kind's own sample that names a secret is in the cell.
    for (const field of envFields(kind.sample[0])) assert.ok(named.includes(field), `${kind.key}: ${field}`);
    // A field the cell names is a key that the code of the kind knows.
    for (const field of named) assert.ok(kindSource(kind).includes(field), `${kind.key}: ${field} is no field`);
  });
});

// The prompt text, with its lines joined by single spaces.
const promptText = () => /```text\n(You help[\s\S]*?)```/.exec(DOC)[1].replace(/\s+/g, ' ');

test('the word classes that item 2 of the prompt advises hold no dot and no slash', () => {
  const item = /2\. Keep it read-only[\s\S]*?(?= 3\. Never write)/.exec(promptText())[0];
  const classes = [...item.matchAll(/\[[^\]]*\]/g)].map((m) => m[0]);
  assert.ok(classes.length >= 3, 'item 2 shows word classes');
  for (const cls of classes) assert.ok(!/[./]/.test(cls), `${cls} must hold no . and no /`);
});

test('the prompt says that each kind without a flag has none', () => {
  const kinds = KINDS.filter((kind) => kind.flag === undefined);
  assert.ok(kinds.length > 0);
  for (const kind of kinds) assert.ok(promptText().includes(`${kind.key} has none`), kind.key);
});

test('in each worked example the stop-the-session sentence comes before the first doctor line', () => {
  for (const heading of Object.keys(EXAMPLES)) {
    const text = section(heading).lines.join('\n');
    const stop = text.indexOf('stop it with Ctrl-C');
    const doctor = text.search(/^ksproxy doctor /m);
    assert.ok(stop !== -1 && doctor !== -1 && stop < doctor, heading);
  }
});

test('the rules section names the three variables that move the folders', () => {
  const rules = section('The rules that keep you in control').lines.join(' ');
  for (const name of ['KSPROXY_CONFIG_DIR', 'XDG_CONFIG_HOME', 'KSPROXY_STATE_DIR']) assert.ok(rules.includes(name), name);
});
