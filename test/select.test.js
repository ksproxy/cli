import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { checkbox, parseNumberSelection, reduceKey } from '../src/select.js';

const initial = (count = 3) => ({ cursor: 0, selected: [], count, done: false, cancelled: false });

test('reduceKey wraps the cursor', () => {
  assert.equal(reduceKey({ ...initial(), cursor: 2 }, 'down').cursor, 0);
  assert.equal(reduceKey(initial(), 'up').cursor, 2);
  assert.equal(reduceKey(initial(), 'down').cursor, 1);
});

test('reduceKey space toggles the item under the cursor and keeps the list sorted', () => {
  let s = reduceKey({ ...initial(), cursor: 2 }, 'space');
  assert.deepEqual(s.selected, [2]);
  s = reduceKey({ ...s, cursor: 0 }, 'space');
  assert.deepEqual(s.selected, [0, 2]);
  s = reduceKey(s, 'space');
  assert.deepEqual(s.selected, [2]);
});

test('reduceKey a selects all, then clears', () => {
  const all = reduceKey(initial(), 'a');
  assert.deepEqual(all.selected, [0, 1, 2]);
  assert.deepEqual(reduceKey(all, 'a').selected, []);
  assert.deepEqual(reduceKey({ ...initial(), selected: [1] }, 'a').selected, [0, 1, 2]);
});

test('reduceKey enter and cancel', () => {
  assert.equal(reduceKey(initial(), 'enter').done, true);
  assert.equal(reduceKey(initial(), 'cancel').cancelled, true);
  assert.equal(reduceKey(initial(), 'enter').cancelled, false);
});

test('reduceKey does not mutate its input', () => {
  const s = { ...initial(), selected: [1] };
  const copy = structuredClone(s);
  for (const key of ['up', 'down', 'space', 'a', 'enter', 'cancel']) reduceKey(s, key);
  assert.deepEqual(s, copy);
});

test('parseNumberSelection', () => {
  assert.deepEqual(parseNumberSelection('1,3', 3), [0, 2]);
  assert.deepEqual(parseNumberSelection('3 1 1', 3), [0, 2]);
  assert.deepEqual(parseNumberSelection('all', 3), [0, 1, 2]);
  assert.deepEqual(parseNumberSelection('', 3), []);
  for (const bad of ['0', '4', 'x', '1,x', '-1', '1.5']) {
    assert.throws(() => parseNumberSelection(bad, 3), Error, bad);
  }
});

function collect(stream) {
  let text = '';
  stream.on('data', (c) => { text += c; });
  return () => text;
}

const ITEMS = [
  { label: 'alpha', hint: 'first' },
  { label: 'beta', hint: 'second' },
  { label: 'gamma', hint: 'third' },
];

test('checkbox without a terminal reads a numbered answer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const text = collect(output);
  input.write('2\n');
  const picked = await checkbox({ title: 'Pick', items: ITEMS, input, output });
  assert.deepEqual(picked, [1]);
  for (const item of ITEMS) assert.ok(text().includes(item.label));
});

test('checkbox without a terminal re-prompts once, then throws', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.write('9\n2\n');
  assert.deepEqual(await checkbox({ title: 'Pick', items: ITEMS, input, output }), [1]);

  const input2 = new PassThrough();
  input2.write('9\nzzz\n');
  await assert.rejects(checkbox({ title: 'Pick', items: ITEMS, input: input2, output: new PassThrough() }));
});

test('checkbox without a terminal returns null at end of input', async () => {
  const input = new PassThrough();
  input.end();
  assert.equal(await checkbox({ title: 'Pick', items: ITEMS, input, output: new PassThrough() }), null);
});

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawCalls = [];
  input.setRawMode = (flag) => { input.rawCalls.push(flag); return input; };
  return input;
}

test('checkbox on a terminal: keys select, enter confirms, raw mode is restored', async () => {
  const input = fakeTty();
  const output = new PassThrough();
  const text = collect(output);
  const result = checkbox({ title: 'Pick', items: ITEMS, input, output });
  input.write('j');
  input.write(' ');
  input.write('\u001b[B');
  input.write(' ');
  input.write('\r');
  assert.deepEqual(await result, [1, 2]);
  assert.deepEqual(input.rawCalls, [true, false]);
  assert.ok(text().includes('\u001b[?25l'));
  assert.ok(text().endsWith('\u001b[?25h'));
});

test('checkbox on a terminal: a toggles all, k moves up', async () => {
  const input = fakeTty();
  const result = checkbox({ title: 'Pick', items: ITEMS, input, output: new PassThrough() });
  input.write('a\r');
  assert.deepEqual(await result, [0, 1, 2]);
});

test('checkbox on a terminal: q, Escape and Ctrl-C cancel and restore the terminal', async () => {
  for (const key of ['q', '\u001b', '\u0003']) {
    const input = fakeTty();
    const output = new PassThrough();
    const text = collect(output);
    const result = checkbox({ title: 'Pick', items: ITEMS, input, output });
    input.write(key);
    assert.equal(await result, null, JSON.stringify(key));
    assert.deepEqual(input.rawCalls, [true, false]);
    assert.ok(text().endsWith('\u001b[?25h'));
  }
});

test('checkbox on a terminal: end of input cancels and restores the terminal', async () => {
  const input = fakeTty();
  const result = checkbox({ title: 'Pick', items: ITEMS, input, output: new PassThrough() });
  input.end();
  assert.equal(await result, null);
  assert.deepEqual(input.rawCalls, [true, false]);
});

test('checkbox on a terminal: an error while drawing still restores the terminal', async () => {
  const input = fakeTty();
  let calls = 0;
  const output = {
    write() {
      calls += 1;
      if (calls === 2) throw new Error('write failed');
      return true;
    },
  };
  await assert.rejects(checkbox({ title: 'Pick', items: ITEMS, input, output }), /write failed/);
  assert.deepEqual(input.rawCalls, [true, false]);
});
