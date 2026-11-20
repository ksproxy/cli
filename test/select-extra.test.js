import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { checkbox, reduceKey } from '../src/select.js';

const ITEMS = [
  { label: 'alpha', hint: 'first' },
  { label: 'beta' },
  { label: 'gamma', hint: 'third' },
];

function fakeTty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawCalls = [];
  input.setRawMode = (flag) => { input.rawCalls.push(flag); return input; };
  return input;
}

function collect(stream) {
  let text = '';
  stream.on('data', (c) => { text += c; });
  return () => text;
}

test('reduceKey with an empty list keeps the cursor at 0 and ignores unknown keys', () => {
  const empty = {
    cursor: 0, selected: [], count: 0, done: false, cancelled: false,
  };
  assert.equal(reduceKey(empty, 'up').cursor, 0);
  assert.equal(reduceKey(empty, 'down').cursor, 0);
  const same = reduceKey({ ...empty, count: 3, cursor: 1 }, 'unknown-key');
  assert.deepEqual(same, {
    cursor: 1, selected: [], count: 3, done: false, cancelled: false,
  });
});

test('terminal keys: arrow up, application-mode arrows, modified arrows, k, and newline', async () => {
  const input = fakeTty();
  const result = checkbox({
    title: 'Pick', items: ITEMS, input, output: new PassThrough(), signals: new EventEmitter(),
  });
  input.write('\u001b[B');
  input.write('\u001b[1;5B');
  input.write('\u001b[A');
  input.write('\u001bOA');
  input.write('\u001bOB');
  input.write('\u001b[C');
  input.write('k');
  input.write('j');
  input.write(' ');
  input.write('\n');
  assert.deepEqual(await result, [1]);
});

test('terminal keys: the cursor really moves (checked on the drawn screen)', async () => {
  const input = fakeTty();
  const output = new PassThrough();
  const text = collect(output);
  const result = checkbox({
    title: 'Pick', items: ITEMS, input, output, signals: new EventEmitter(),
  });
  input.write('\u001b[A');
  input.write('\r');
  assert.deepEqual(await result, []);
  const screen = text();
  assert.ok(screen.includes('> [ ] gamma  third'));
  assert.ok(screen.includes('  [ ] beta\n'));
  assert.ok(!screen.includes('beta  undefined'));
});

test('rows are cut to the width of a narrow terminal', async () => {
  const input = fakeTty();
  const output = new PassThrough();
  output.columns = 12;
  const text = collect(output);
  const result = checkbox({
    title: 'Which kinds of proxy?', items: ITEMS, input, output, signals: new EventEmitter(),
  });
  input.write('q');
  assert.equal(await result, null);
  const lines = text().split('\n');
  assert.ok(lines.some((l) => l.endsWith('Which kinds')), JSON.stringify(lines));
  assert.ok(lines.every((l) => l.replace(/\u001b\[[0-9;?]*[A-Za-z]|\r/g, '').length <= 11), JSON.stringify(lines));
});

test('an error while redrawing after a key rejects and restores the terminal', async () => {
  const input = fakeTty();
  let calls = 0;
  const output = {
    write() {
      calls += 1;
      if (calls === 3) throw new Error('redraw failed');
      return true;
    },
  };
  const result = checkbox({
    title: 'Pick', items: ITEMS, input, output, signals: new EventEmitter(),
  });
  input.write('j');
  await assert.rejects(result, /redraw failed/);
  assert.deepEqual(input.rawCalls, [true, false]);
});

test('a terminal that is already gone does not stop the selection from returning', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = (flag) => {
    if (flag === false) throw new Error('no terminal');
    return input;
  };
  input.pause = () => { throw new Error('cannot pause'); };
  const output = {
    write(text) {
      if (text === '\u001b[?25h') throw new Error('closed');
      return true;
    },
  };
  const result = checkbox({
    title: 'Pick', items: ITEMS, input, output, signals: new EventEmitter(),
  });
  input.write('\r');
  assert.deepEqual(await result, []);
});

test('SIGTERM and SIGHUP cancel the selection and the listeners are removed', async () => {
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    const input = fakeTty();
    const signals = new EventEmitter();
    const result = checkbox({
      title: 'Pick', items: ITEMS, input, output: new PassThrough(), signals,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signals.listenerCount('SIGTERM'), 1);
    assert.equal(signals.listenerCount('SIGHUP'), 1);
    signals.emit(signal);
    assert.equal(await result, null);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(signals.listenerCount('SIGHUP'), 0);
    assert.deepEqual(input.rawCalls, [true, false]);
  }
});

test('an input error rejects the selection', async () => {
  const input = fakeTty();
  const result = checkbox({
    title: 'Pick', items: ITEMS, input, output: new PassThrough(), signals: new EventEmitter(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit('error', new Error('input broke'));
  await assert.rejects(result, /input broke/);
});

test('numbered mode shows items without a hint as the label alone', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const text = collect(output);
  input.write('\n');
  assert.deepEqual(await checkbox({ title: 'Pick', items: ITEMS, input, output }), []);
  assert.ok(text().includes('  2) beta\n'));
  assert.ok(text().includes('  1) alpha  first\n'));
});
