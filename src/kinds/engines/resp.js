import net from 'node:net';
import tls from 'node:tls';

// The resp engine: the Redis protocol spoken directly over TCP or TLS. It writes one command as an array of bulk
// strings, reads the server's reply with a strict incremental reader, and prints the reply as the usual client does.
// The bytes the server sends and the words the agent chose are both treated as hostile.

export const MAX_DEPTH = 32;
const HEADER_LIMIT = 21;
const CRLF = Buffer.from('\r\n');
const LENGTH_RE = /^(?:-1|0|[1-9]\d{0,17})$/;
const NEGATIVE_RE = /^-\d+$/;
const INTEGER_RE = /^[-+]?\d{1,20}$/;
const BIG_RE = /^[-+]?\d+$/;
const DOUBLE_RE = /^[-+]?(?:inf|nan|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)$/;
const INCOMPLETE = Symbol('incomplete');
const OPENED = Symbol('opened');
const AGGREGATES = {
  0x2a: 'array', 0x25: 'map', 0x7e: 'set', 0x3e: 'push',
};
const EMPTY = {
  array: '(empty array)', push: '(empty array)', set: '(empty set)', map: '(empty hash)',
};
const ESCAPES = {
  0x5c: '\\\\', 0x22: '\\"', 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t', 0x07: '\\a', 0x08: '\\b',
};

const REACH_FAILED = 'the server could not be reached\n';
const TLS_FAILED = 'the server could not be reached over TLS, or its certificate is not trusted for this host\n';
const CONNECTION_FAILED = 'the connection to the server failed\n';
const CLOSED_EARLY = 'the server closed the connection before it answered\n';
const AUTH_FAILED = 'the server did not accept the credentials\n';
const OVER_LIMIT = 'the reply is larger than the output limit';

// A reply the reader refuses. overflow is true when the reply passed the size limit.
export class ReplyError extends Error {
  constructor(message, overflow = false) {
    super(message);
    this.overflow = overflow;
  }
}

const refuse = (message) => {
  throw new ReplyError(message);
};

// One command as an array of bulk strings: *N, then $len (in bytes) and the word for each word. Because every word is
// length-prefixed, no word can end the command or start another one. The inline form is never written.
export function encodeCommand(words) {
  if (!Array.isArray(words) || words.length === 0 || !words.every((w) => typeof w === 'string')) {
    throw new Error('a command is a non-empty list of strings');
  }
  const parts = [Buffer.from(`*${words.length}\r\n`)];
  for (const word of words) {
    const data = Buffer.from(word, 'utf8');
    parts.push(Buffer.from(`$${data.length}\r\n`), data, CRLF);
  }
  return Buffer.concat(parts);
}

// The number in a length header; -1 only where a null is allowed. Checked before anything is allocated from it.
function readLength(text, nullable) {
  if (NEGATIVE_RE.test(text) && !(nullable && text === '-1')) refuse('a length is negative');
  if (!LENGTH_RE.test(text)) refuse('a length is not a number');
  return Number(text);
}

function lineValue(type, line) {
  const text = line.toString('latin1');
  if (type === 0x2b || type === 0x2d) {
    if (line.includes(0x0a) || line.includes(0x0d)) refuse('a simple string or an error holds a line break');
    return { type: type === 0x2b ? 'simple' : 'error', data: Buffer.from(line) };
  }
  if (type === 0x3a) {
    if (!INTEGER_RE.test(text)) refuse('an integer is not a number');
    return { type: 'integer', text };
  }
  if (type === 0x2c) {
    if (!DOUBLE_RE.test(text)) refuse('a double is not a number');
    return { type: 'double', text };
  }
  if (type === 0x23) {
    if (text !== 't' && text !== 'f') refuse('a boolean is not t or f');
    return { type: 'boolean', value: text === 't' };
  }
  if (type === 0x28) {
    if (!BIG_RE.test(text)) refuse('a big number is not a number');
    return { type: 'big', text };
  }
  if (text !== '') refuse('a null holds data');
  return { type: 'null' };
}

const LINE_TYPES = [0x2b, 0x2d, 0x3a, 0x2c, 0x23, 0x28, 0x5f];
const BLOB_TYPES = [0x24, 0x21, 0x3d];

// The strict incremental reader. push(chunk) adds bytes as they arrive; read() returns the next complete reply or
// null. It keeps the aggregates it is inside on a stack, so no byte is read twice, and it counts every byte against
// maxBytes. Nothing is allocated from a length the server sent before that length is checked.
export class ReplyReader {
  constructor({ maxBytes = Infinity, maxDepth = MAX_DEPTH } = {}) {
    this.maxBytes = maxBytes;
    this.maxDepth = maxDepth;
    this.data = Buffer.alloc(0);
    this.start = 0;
    this.end = 0;
    this.base = 0;
    this.scanFrom = 0;
    this.stack = [];
  }

  push(chunk) {
    if (this.base + this.end + chunk.length > this.maxBytes) throw new ReplyError(OVER_LIMIT, true);
    if (this.start > this.data.length / 2) {
      this.data.copy(this.data, 0, this.start, this.end);
      this.base += this.start;
      this.scanFrom -= this.start;
      this.end -= this.start;
      this.start = 0;
    }
    if (this.end + chunk.length > this.data.length) {
      const grown = Buffer.alloc(Math.max(this.data.length * 2, this.end + chunk.length));
      this.data.copy(grown, 0, 0, this.end);
      this.data = grown;
    }
    chunk.copy(this.data, this.end);
    this.end += chunk.length;
  }

  // Whether an element that ends at offset (in this buffer) could fit in the size limit.
  fits(offset) {
    return this.base + offset <= this.maxBytes;
  }

  element() {
    if (this.start >= this.end) return INCOMPLETE;
    const type = this.data[this.start];
    if (!LINE_TYPES.includes(type) && !BLOB_TYPES.includes(type) && AGGREGATES[type] === undefined) {
      const hex = type.toString(16).padStart(2, '0');
      refuse(`the reply has an unknown type byte 0x${hex}`);
    }
    const lineEnd = this.data.subarray(0, this.end).indexOf(CRLF, Math.max(this.start + 1, this.scanFrom));
    const header = !LINE_TYPES.includes(type);
    if (lineEnd === -1) {
      if (header && this.end - this.start > HEADER_LIMIT) refuse('a length is not a number');
      this.scanFrom = Math.max(this.start, this.end - 1);
      return INCOMPLETE;
    }
    const line = this.data.subarray(this.start + 1, lineEnd);
    const body = lineEnd + 2;
    if (!header) {
      const value = lineValue(type, line);
      this.start = body;
      return value;
    }
    if (BLOB_TYPES.includes(type)) return this.blob(type, line.toString('latin1'), body);
    return this.aggregate(AGGREGATES[type], line.toString('latin1'), body);
  }

  blob(type, text, body) {
    const size = readLength(text, type === 0x24);
    if (size === -1) {
      this.start = body;
      return { type: 'null' };
    }
    if (!this.fits(body + size + 2)) throw new ReplyError(OVER_LIMIT, true);
    if (this.end < body + size + 2) {
      this.scanFrom = this.start;
      return INCOMPLETE;
    }
    if (this.data[body + size] !== 0x0d || this.data[body + size + 1] !== 0x0a) refuse('a bulk string does not end in CRLF');
    const data = Buffer.from(this.data.subarray(body, body + size));
    this.start = body + size + 2;
    if (type === 0x24) return { type: 'bulk', data };
    if (type === 0x21) return { type: 'error', data };
    if (size < 4 || data[3] !== 0x3a) refuse('a verbatim string has no format');
    return { type: 'verbatim', format: data.subarray(0, 3).toString('latin1'), data: data.subarray(4) };
  }

  aggregate(kind, text, body) {
    const count = readLength(text, kind === 'array');
    this.start = body;
    if (count === -1) return { type: 'null' };
    const elements = kind === 'map' ? count * 2 : count;
    if (!this.fits(body + elements * 3)) throw new ReplyError(OVER_LIMIT, true);
    if (elements === 0) return { type: kind, items: [] };
    if (this.stack.length >= this.maxDepth) refuse(`the reply is nested deeper than ${this.maxDepth} levels`);
    this.stack.push({ type: kind, remaining: elements, items: [] });
    return OPENED;
  }

  read() {
    for (;;) {
      let value = this.element();
      if (value === INCOMPLETE) return null;
      if (value !== OPENED) {
        for (;;) {
          if (this.stack.length === 0) return value;
          const top = this.stack[this.stack.length - 1];
          top.items.push(value);
          top.remaining -= 1;
          if (top.remaining > 0) break;
          this.stack.pop();
          value = { type: top.type, items: top.items };
        }
      }
    }
  }

  // The bytes after the replies read so far.
  rest() {
    return Buffer.from(this.data.subarray(this.start, this.end));
  }
}

// The first reply in buffer and the bytes after it, or null when the reply is not complete. Throws ReplyError.
export function readReply(buffer, options = {}) {
  const reader = new ReplyReader(options);
  reader.push(buffer);
  const value = reader.read();
  return value === null ? null : { value, rest: reader.rest() };
}

// Bytes as text that cannot forge a line or hide a character: printable ASCII as it is, \\ \" \n \r \t \a \b, and
// every other byte as \xHH.
function escapeBytes(data) {
  let out = '';
  for (const byte of data) {
    if (ESCAPES[byte] !== undefined) out += ESCAPES[byte];
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

// A text as formatReply would print it inside a string, so that a secret can be found in the reply.
export function escapeText(text) {
  return escapeBytes(Buffer.from(text, 'utf8'));
}

function scalarText(value) {
  if (value.type === 'simple') return escapeBytes(value.data);
  if (value.type === 'error') return `(error) ${escapeBytes(value.data)}`;
  if (value.type === 'integer') return `(integer) ${value.text}`;
  if (value.type === 'double') return `(double) ${value.text}`;
  if (value.type === 'big') return `(big number) ${value.text}`;
  if (value.type === 'boolean') return value.value ? '(true)' : '(false)';
  if (value.type === 'null') return '(nil)';
  return `"${escapeBytes(value.data)}"`;
}

// Where the lines of a reply go: they are kept until their bytes, each with its newline, pass maxBytes, and the
// formatting stops there, so that a deep and wide reply is never built in full. Every line is ASCII.
function lineSink(maxBytes) {
  const lines = [];
  let bytes = 0;
  return {
    lines,
    add(line) {
      lines.push(line);
      bytes += line.length + 1;
    },
    full: () => bytes > maxBytes,
    left: () => maxBytes - bytes,
  };
}

// The lines of a value: a scalar on one line, an aggregate numbered with its items indented under their number.
// first goes before the first line and rest before every other line, so each line is written once with its indent.
function emitLines(value, first, rest, sink) {
  if (value.items === undefined) {
    sink.add(first + scalarText(value));
    return;
  }
  if (value.items.length === 0) {
    sink.add(first + EMPTY[value.type]);
    return;
  }
  const map = value.type === 'map';
  const count = map ? value.items.length / 2 : value.items.length;
  const width = String(count).length;
  for (let i = 0; i < count && !sink.full(); i += 1) {
    const number = `${String(i + 1).padStart(width)}${map ? '#' : ')'} `;
    const head = (i === 0 ? first : rest) + number;
    const pad = rest + ' '.repeat(number.length);
    if (map) emitEntry(value.items[i * 2], value.items[i * 2 + 1], head, pad, sink);
    else emitLines(value.items[i], head, pad, sink);
  }
}

// One pair of a map: the key's lines, the last one followed by " => " and the value, whose further lines go under
// its first. The key is formatted first with what is left of the limit; a key that passes it ends the text.
function emitEntry(key, item, head, pad, sink) {
  const keySink = lineSink(sink.left());
  emitLines(key, '', '', keySink);
  const keyLines = keySink.lines;
  const whole = !keySink.full();
  (whole ? keyLines.slice(0, -1) : keyLines).forEach((line, j) => sink.add((j === 0 ? head : pad) + line));
  if (!whole) return;
  const last = keyLines.at(-1);
  emitLines(item, `${keyLines.length === 1 ? head : pad}${last} => `, pad + ' '.repeat(last.length + 4), sink);
}

// The reply as the usual client prints it, ending in a newline. With maxBytes the text stops at the first line that
// passes it: it is the start of the whole text and a little longer than maxBytes, which the caller then cuts.
export function formatReply(value, maxBytes = Infinity) {
  const sink = lineSink(maxBytes);
  emitLines(value, '', '', sink);
  return `${sink.lines.join('\n')}\n`;
}

function defaultConnect(options, useTls) {
  return useTls ? tls.connect(options) : net.connect(options);
}

const failure = (stderr) => ({ exitCode: 1, stdout: '', stderr });
const TIMED_OUT = {
  exitCode: null, stdout: '', stderr: '', timedOut: true,
};

// One call: connect (TLS when the target says so, the certificate checked against the host name), AUTH when a
// password is set, SELECT when db is not 0, then the one command, each sent after the answer to the one before;
// then the socket is destroyed. A refused AUTH or SELECT is a fixed text that never repeats the server's answer.
export function exchange({
  host, port, tls: useTls = false, user, password, db = 0, words, timeoutMs, maxBytes, signal, connect = defaultConnect,
}) {
  const steps = [];
  if (password !== undefined) steps.push({ words: user === undefined ? ['AUTH', password] : ['AUTH', user, password], failed: AUTH_FAILED });
  if (db !== 0) steps.push({ words: ['SELECT', String(db)], failed: `the server did not select database ${db}\n` });
  steps.push({ words });
  return new Promise((resolve) => {
    const reader = new ReplyReader({ maxBytes });
    let socket = null;
    let connected = false;
    let done = false;
    let step = 0;
    let timer = null;
    const reachFailed = useTls ? TLS_FAILED : REACH_FAILED;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (socket !== null) socket.destroy();
      resolve(result);
    };
    function onAbort() {
      finish(TIMED_OUT);
    }
    const lost = () => finish(failure(connected ? CLOSED_EARLY : reachFailed));
    const answer = (value) => {
      const current = steps[step];
      if (step === steps.length - 1) {
        finish({ exitCode: value.type === 'error' ? 1 : 0, stdout: formatReply(value, maxBytes), stderr: '' });
        return;
      }
      if (value.type !== 'simple' || value.data.toString('latin1') !== 'OK') {
        finish(failure(current.failed));
        return;
      }
      step += 1;
      socket.write(encodeCommand(steps[step].words));
    };
    if (signal.aborted) {
      resolve(TIMED_OUT);
      return;
    }
    timer = setTimeout(onAbort, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    const options = { host, port, ...(useTls && net.isIP(host) === 0 ? { servername: host } : {}) };
    try {
      socket = connect(options, useTls);
    } catch {
      finish(failure(reachFailed));
      return;
    }
    socket.once(useTls ? 'secureConnect' : 'connect', () => {
      connected = true;
      socket.write(encodeCommand(steps[0].words));
    });
    socket.on('data', (chunk) => {
      const values = [];
      try {
        reader.push(chunk);
        for (let value = reader.read(); value !== null; value = reader.read()) values.push(value);
      } catch (err) {
        finish(err.overflow
          ? { ...failure(`${OVER_LIMIT} and was cut off\n`), truncated: true }
          : failure(`the reply could not be read: ${err.message}\n`));
        return;
      }
      for (const value of values) {
        if (done) break;
        answer(value);
      }
    });
    socket.on('error', () => finish(failure(connected ? CONNECTION_FAILED : reachFailed)));
    socket.on('close', lost);
  });
}
