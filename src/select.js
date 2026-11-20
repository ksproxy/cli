import readline from 'node:readline';

const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';

export function reduceKey(state, key) {
  const { count } = state;
  const selected = [...state.selected];
  const next = { ...state, selected };
  switch (key) {
    case 'up':
      next.cursor = count === 0 ? 0 : (state.cursor - 1 + count) % count;
      break;
    case 'down':
      next.cursor = count === 0 ? 0 : (state.cursor + 1) % count;
      break;
    case 'space': {
      const at = selected.indexOf(state.cursor);
      if (at === -1) selected.push(state.cursor);
      else selected.splice(at, 1);
      selected.sort((a, b) => a - b);
      break;
    }
    case 'a':
      next.selected = selected.length === count ? [] : Array.from({ length: count }, (_, i) => i);
      break;
    case 'enter':
      next.done = true;
      break;
    case 'cancel':
      next.cancelled = true;
      break;
    default:
      break;
  }
  return next;
}

export function parseNumberSelection(text, count) {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.toLowerCase() === 'all') return Array.from({ length: count }, (_, i) => i);
  const picked = new Set();
  for (const token of trimmed.split(/[\s,]+/).filter(Boolean)) {
    const n = /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > count) {
      throw new Error(`invalid choice "${token}": enter numbers from 1 to ${count}, or "all"`);
    }
    picked.add(n - 1);
  }
  return [...picked].sort((a, b) => a - b);
}

function parseKeys(text) {
  const keys = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\u001b') {
      if (text[i + 1] === '[' || text[i + 1] === 'O') {
        let j = i + 2;
        while (j < text.length && text.charCodeAt(j) >= 0x30 && text.charCodeAt(j) <= 0x3f) j += 1;
        if (text[j] === 'A') keys.push('up');
        else if (text[j] === 'B') keys.push('down');
        i = j;
      } else {
        keys.push('cancel');
      }
    } else if (c === '\u0003' || c === 'q' || c === 'Q') keys.push('cancel');
    else if (c === 'k') keys.push('up');
    else if (c === 'j') keys.push('down');
    else if (c === ' ') keys.push('space');
    else if (c === 'a' || c === 'A') keys.push('a');
    else if (c === '\r' || c === '\n') keys.push('enter');
  }
  return keys;
}

function describe(item) {
  return item.hint ? `${item.label}  ${item.hint}` : item.label;
}

async function rawCheckbox({
  title, items, input, output, signals,
}) {
  let state = {
    cursor: 0, selected: [], count: items.length, done: false, cancelled: false,
  };
  let drawn = 0;
  let onData = null;
  let onEnd = null;
  let onSignal = null;

  const draw = () => {
    const width = Number.isInteger(output.columns) ? output.columns - 1 : Infinity;
    const rows = [
      title,
      ...items.map((item, i) => {
        const mark = state.selected.includes(i) ? 'x' : ' ';
        const pointer = i === state.cursor ? '>' : ' ';
        return `${pointer} [${mark}] ${describe(item)}`;
      }),
      '(up/down or j/k move, space toggles, a toggles all, enter confirms, q cancels)',
    ].map((row) => (row.length > width ? row.slice(0, Math.max(width, 1)) : row));
    const rewind = drawn > 0 ? `\u001b[${drawn}A\r\u001b[J` : '';
    output.write(`${rewind}${rows.join('\n')}\n`);
    drawn = rows.length;
  };

  try {
    input.setRawMode(true);
    input.resume();
    output.write(HIDE_CURSOR);
    draw();
    await new Promise((resolve, reject) => {
      onData = (chunk) => {
        try {
          for (const key of parseKeys(chunk.toString('utf8'))) {
            state = reduceKey(state, key);
            if (state.done || state.cancelled) break;
          }
          draw();
          if (state.done || state.cancelled) resolve();
        } catch (err) {
          reject(err);
        }
      };
      onEnd = () => {
        state = { ...state, cancelled: true };
        resolve();
      };
      onSignal = onEnd;
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', reject);
      signals.once('SIGTERM', onSignal);
      signals.once('SIGHUP', onSignal);
    });
  } finally {
    if (onData) input.off('data', onData);
    if (onEnd) input.off('end', onEnd);
    if (onSignal) {
      signals.off('SIGTERM', onSignal);
      signals.off('SIGHUP', onSignal);
    }
    try { input.setRawMode(false); } catch { /* terminal already gone */ }
    try { input.pause(); } catch { /* ignore */ }
    try { output.write(SHOW_CURSOR); } catch { /* ignore */ }
  }
  return state.cancelled ? null : state.selected;
}

async function lineCheckbox({ title, items, input, output }) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const queue = [];
  let closed = false;
  let wake = null;
  rl.on('line', (line) => {
    queue.push(line);
    if (wake) wake();
  });
  rl.on('close', () => {
    closed = true;
    if (wake) wake();
  });
  const nextLine = async () => {
    while (queue.length === 0 && !closed) {
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
    return queue.length > 0 ? queue.shift() : null;
  };

  const readChoice = async () => {
    output.write('Choose (numbers like 1,3 or "all", empty for none): ');
    const line = await nextLine();
    if (line === null) return { value: null };
    try {
      return { value: parseNumberSelection(line, items.length) };
    } catch (err) {
      output.write(`${err.message}\n`);
      return { error: err };
    }
  };

  const choose = async () => {
    output.write(`${title}\n`);
    items.forEach((item, i) => output.write(`  ${i + 1}) ${describe(item)}\n`));
    const first = await readChoice();
    if (!first.error) return first.value;
    const second = await readChoice();
    if (second.error) throw second.error;
    return second.value;
  };
  return choose().finally(() => rl.close());
}

export async function checkbox({
  title, items, input = process.stdin, output = process.stderr, signals = process,
}) {
  if (input.isTTY && typeof input.setRawMode === 'function') {
    return rawCheckbox({
      title, items, input, output, signals,
    });
  }
  return lineCheckbox({ title, items, input, output });
}
