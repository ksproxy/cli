import assert from 'node:assert/strict';

// Outside quotes a shell would read these characters itself; inside double quotes these.
const SHELL_SPECIAL = '\\$`*?[]{}|&;<>()~!#';
const DOUBLE_SPECIAL = '\\$`!';

// The words of a sample line as a shell would split them: single and double quotes group a word. A character that a
// shell would read itself (a glob, a variable, a redirect) must be quoted, so that a person can paste the line.
export function shellWords(line) {
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
