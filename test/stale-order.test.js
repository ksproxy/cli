import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import echo from './fixtures/kind-echo.js';
import { KINDS } from '../src/kinds/index.js';
import {
  cleanupAll, launch, makeWorld, ready, stopWith,
} from './start-helpers.js';

const calls = [];

function reaper(name) {
  return {
    ...echo,
    key: name,
    flag: name,
    label: name,
    word: name,
    noun: `${name} target`,
    countNoun: `${name} target(s)`,
    tool: { ...echo.tool, name: `${name}_exec` },
    async reapStale() {
      calls.push(name);
      return [`reaped ${name}`, `reaped ${name} again`];
    },
  };
}

KINDS.push(reaper('ea'), reaper('eb'));

after(() => cleanupAll());

test('what a killed run left is cleaned in reverse list order, and each kind\'s lines are printed in that order', async () => {
  const world = await makeWorld();
  const run = launch(world, { ssh: ['web1'] });
  await ready(run);
  assert.deepEqual(calls, ['eb', 'ea']);
  const err = run.proc.stderr.text;
  const at = ['reaped eb\n', 'reaped eb again\n', 'reaped ea\n', 'reaped ea again\n'].map((line) => err.indexOf(line));
  assert.ok(at.every((n) => n >= 0), err);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
  assert.equal(await stopWith(run), 0);
});
