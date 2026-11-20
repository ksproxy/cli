import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = path.join(ROOT, 'docs', 'LOGIC.md');
const DIAGRAM_TYPES = ['flowchart TD', 'flowchart LR', 'sequenceDiagram', 'stateDiagram-v2'];
const RESERVED_IDS = new Set(['end', 'class', 'graph', 'style', 'default']);
const FORBIDDEN_IN_LABELS = ['`', '<', '>', '{', '}', '|', '#'];
const PAIRS = { ']': '[', '}': '{', ')': '(' };

const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

function sourceFiles() {
  const files = [];
  for (const dir of ['src', 'bin']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`);
    }
  }
  return files;
}

function exportedNames(source) {
  const names = new Set();
  const declaration = /^\s*export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|class\s+)([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) names.add(match[1]);
  const list = /^\s*export\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(list)) {
    for (const part of match[1].split(',')) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      names.add(words.length >= 3 && words[words.length - 2] === 'as' ? words[words.length - 1] : words[0]);
    }
  }
  return [...names];
}

function sections(text) {
  const heads = [...text.matchAll(/^## (.+)$/gm)];
  return heads.map((head, i) => ({
    title: head[1].trim(),
    body: text.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : text.length),
  }));
}

function mermaidBlocks(text) {
  return [...text.matchAll(/^```mermaid[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)].map((m) => m[1]);
}

function lineNumberOf(text, block) {
  return text.slice(0, text.indexOf(block)).split('\n').length;
}

function wholeWord(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

// Splits one flowchart line into the text outside double quotes and the quoted strings.
function splitQuotes(line) {
  let outside = '';
  const quoted = [];
  let current = null;
  for (const ch of line) {
    if (ch === '"') {
      if (current === null) {
        current = '';
        outside += '"';
      } else {
        quoted.push(current);
        current = null;
        outside += '"';
      }
    } else if (current === null) {
      outside += ch;
    } else {
      current += ch;
    }
  }
  return { outside, quoted, open: current !== null };
}

function flowchartProblems(lines) {
  const problems = [];
  lines.forEach((line, i) => {
    const where = `diagram line ${i + 1}: ${line.trim()}`;
    const { outside, quoted, open } = splitQuotes(line);
    if (open) problems.push(`unbalanced double quotes on ${where}`);
    const stack = [];
    for (const ch of outside) {
      if (ch === '[' || ch === '{' || ch === '(') stack.push(ch);
      if (PAIRS[ch]) {
        if (stack.pop() !== PAIRS[ch]) problems.push(`unbalanced "${ch}" on ${where}`);
      }
    }
    if (stack.length > 0) problems.push(`unclosed "${stack.join('')}" on ${where}`);
    if (/[[{(](?!")/.test(outside)) problems.push(`a node label is not a quoted string on ${where}`);
    if (/\|(?!")/.test(outside.replace(/"\|/g, '"'))) problems.push(`an edge label is not a quoted string on ${where}`);
    for (const label of quoted) {
      const bare = label.replaceAll('<br/>', '');
      for (const ch of FORBIDDEN_IN_LABELS) {
        if (bare.includes(ch)) problems.push(`forbidden character ${ch} in label "${label}" on ${where}`);
      }
    }
    const ids = outside.replace(/"[^"]*"/g, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    for (const id of ids) {
      if (RESERVED_IDS.has(id.toLowerCase())) problems.push(`reserved word "${id}" used as a node id on ${where}`);
    }
  });
  return problems;
}

function sequenceProblems(lines) {
  const problems = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    const where = `diagram line ${i + 1}: ${trimmed}`;
    if (/[;#]/.test(trimmed)) problems.push(`";" or "#" on ${where}`);
    if (/^(participant|actor)\b/.test(trimmed) && !/^(participant|actor)\s+[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) {
      problems.push(`participant name is not a single word on ${where}`);
    }
  });
  return problems;
}

function stateProblems(lines) {
  const problems = [];
  lines.forEach((line, i) => {
    if (/[;#{}]/.test(line)) problems.push(`";", "#" or a brace on diagram line ${i + 1}: ${line.trim()}`);
  });
  return problems;
}

test('docs/LOGIC.md exists and README.md links to it', () => {
  assert.ok(fs.existsSync(DOC_PATH), 'docs/LOGIC.md is missing');
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('(docs/LOGIC.md)'), 'README.md has no link to docs/LOGIC.md');
});

test('every source file has a section with at least one mermaid diagram', () => {
  const byTitle = new Map(sections(doc).map((s) => [s.title, s.body]));
  for (const file of sourceFiles()) {
    const body = byTitle.get(file);
    assert.ok(body !== undefined, `docs/LOGIC.md has no "## ${file}" section`);
    assert.ok(mermaidBlocks(body).length > 0, `the "## ${file}" section has no mermaid diagram`);
  }
});

test('every exported name appears in its file section', () => {
  const byTitle = new Map(sections(doc).map((s) => [s.title, s.body]));
  const missing = [];
  for (const file of sourceFiles()) {
    const body = byTitle.get(file) ?? '';
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const name of exportedNames(source)) {
      if (!wholeWord(name).test(body)) missing.push(`${file}: export ${name} is not documented in its section`);
    }
  }
  assert.deepEqual(missing, []);
});

test('the document has no section for a source file that does not exist', () => {
  const files = new Set(sourceFiles());
  const titles = sections(doc).map((s) => s.title).filter((t) => /^(src|bin)\//.test(t));
  for (const title of titles) {
    assert.ok(files.has(title), `section "## ${title}" names a file that does not exist`);
  }
  assert.equal(new Set(titles).size, titles.length, 'a source file has more than one section');
});

test('every mermaid block uses an allowed type and safe syntax', () => {
  const blocks = mermaidBlocks(doc);
  assert.ok(blocks.length > 0, 'no mermaid blocks found');
  const problems = [];
  for (const block of blocks) {
    const at = `mermaid block at docs/LOGIC.md line ${lineNumberOf(doc, block)}`;
    if (block.includes('\t')) problems.push(`${at}: contains a tab`);
    const lines = block.split('\n');
    const first = lines.findIndex((l) => l.trim() !== '');
    const type = first === -1 ? '' : lines[first].trim();
    if (!DIAGRAM_TYPES.includes(type)) {
      problems.push(`${at}: first line "${type}" is not one of ${DIAGRAM_TYPES.join(', ')}`);
      continue;
    }
    const body = lines.slice(first + 1).filter((l) => l.trim() !== '');
    let found = [];
    if (type.startsWith('flowchart')) found = flowchartProblems(body);
    else if (type === 'sequenceDiagram') found = sequenceProblems(body);
    else found = stateProblems(body);
    for (const p of found) problems.push(`${at}: ${p}`);
  }
  assert.deepEqual(problems, []);
});

test('PART 1 has at least seven mermaid diagrams', () => {
  const start = doc.search(/^# PART 1\b/m);
  const end = doc.search(/^# PART 2\b/m);
  assert.ok(start !== -1, 'no "# PART 1" heading');
  assert.ok(end > start, 'no "# PART 2" heading after "# PART 1"');
  const count = mermaidBlocks(doc.slice(start, end)).length;
  assert.ok(count >= 7, `PART 1 has ${count} mermaid diagrams, expected at least 7`);
});
