import test from 'node:test';
import assert from 'node:assert/strict';
import { KINDS } from '../src/kinds/index.js';
import { reviewRoute, reviewWordsProblem } from '../src/tools.js';

KINDS.push({
  key: 'both',
  wordsNotForReview: () => 'the kind\'s word check',
  notForReview: () => 'the kind\'s own check',
});

const refusal = (argv) => ({ allowed: false, unmatched: true, argv });

test('the kind\'s word check is asked before its own notForReview', () => {
  assert.deepEqual(reviewRoute('both', refusal(['get', 'pods']), true), {
    note: 'It was not sent to the reviewer: the kind\'s word check.',
  });
});

test('the checks every kind gets come before the kind\'s word check', () => {
  assert.equal(reviewWordsProblem('both', ['a b']), 'a word contains a space, a control character or a double quote');
  assert.deepEqual(reviewRoute('both', refusal(['a b']), true), {
    note: 'It was not sent to the reviewer: a word contains a space, a control character or a double quote.',
  });
});
