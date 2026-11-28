import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The user documents open with a contents list. It must name every section in order, with links that work, so that it
// never goes stale when a section is added, renamed or removed. docs/EXAMPLES.md has its own table of the kinds.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARK = '**Contents**';

// Each page, and the deepest heading level its list shows (3: sections and their sub-sections).
const PAGES = {
  'README.md': 3,
  'SECURITY.md': 2,
  'docs/AGENT-SETUP.md': 2,
  'docs/DEVELOPMENT.md': 2,
  'docs/DOCTOR.md': 2,
  'docs/JUMPS.md': 2,
  'docs/KINDS.md': 2,
  'docs/LOCAL-TARGETS.md': 3,
  'docs/LOGIC.md': 2,
  'docs/MCP-SERVERS.md': 3,
  'docs/MODEL-REVIEW.md': 2,
  'docs/NETWORK-ACCESS.md': 2,
  'docs/PROJECTS.md': 2,
  'docs/RELEASING.md': 3,
  'docs/RULES.md': 2,
  'docs/SERVICES.md': 2,
  'docs/SESSION-AND-LOG.md': 2,
  'docs/TUNNELS.md': 2,
};

// The anchor GitHub gives a heading: lower case, punctuation other than - and _ dropped, spaces as -.
const slug = (heading) => heading.trim().toLowerCase().replace(/`/g, '').replace(/[^\p{L}\p{N} _-]/gu, '')
  .replace(/ /g, '-');

// The headings of a page outside code blocks, each with its level and the anchor GitHub gives it (a repeated anchor
// gets -1, -2 and so on), and the line of each.
function headings(lines) {
  const seen = new Map();
  const found = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (line.startsWith('```')) fence = !fence;
    const match = fence ? null : /^(#{1,6}) (.*)$/.exec(line);
    if (match === null) return;
    const base = slug(match[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.push({
      level: match[1].length, text: match[2], anchor: count === 0 ? base : `${base}-${count}`, index,
    });
  });
  return found;
}

// The list a page should open with: one line per heading of level 2 up to depth, indented by level.
const expectedList = (found, depth) => found.filter((h) => h.level >= 2 && h.level <= depth)
  .map((h) => `${'  '.repeat(h.level - 2)}- [${h.text.replace(/\]/g, '\\]')}](#${h.anchor})`);

for (const [file, depth] of Object.entries(PAGES)) {
  test(`${file} opens with a contents list of its sections`, () => {
    const lines = fs.readFileSync(`${ROOT}/${file}`, 'utf8').split('\n');
    const at = lines.indexOf(MARK);
    assert.notEqual(at, -1, `${file} has no ${MARK} line`);
    assert.equal(lines[at + 1], '', `${file}: a blank line follows ${MARK}`);
    let end = at + 2;
    while (end < lines.length && lines[end] !== '') end += 1;
    const found = headings(lines);
    assert.deepEqual(lines.slice(at + 2, end), expectedList(found, depth), `${file}: the contents list must name every section in order`);
    const firstSection = found.find((h) => h.index > 0 && h.level <= 2);
    assert.ok(firstSection === undefined || at < firstSection.index, `${file}: the contents list comes before the first section`);
  });
}

test('every user document with several sections is in the list above', () => {
  const pages = ['README.md', 'SECURITY.md', ...fs.readdirSync(`${ROOT}/docs`).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)];
  const several = pages.filter((file) => file !== 'docs/EXAMPLES.md'
    && fs.readFileSync(`${ROOT}/${file}`, 'utf8').split('\n').filter((line) => line.startsWith('## ')).length >= 3);
  assert.deepEqual(several.filter((file) => !Object.hasOwn(PAGES, file)), []);
});
