import fs from 'node:fs';
import net from 'node:net';
import { clip } from './text.js';

export const MAX_CALL_BYTES = 256 * 1024;
// The longest answer line: 4 times the largest output limit of one stream, 4 MiB. answerCall keeps the line of a
// call within the same share of that call's own limit, 1 MiB for the default 256 KiB.
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
export const MAX_CONNECTIONS = 64;

// Every way a brokered call can fail ends in one of these texts, and nothing else of the failure is shown.
export const CALL_FAILED = {
  noAnswer: 'the session did not answer',
  timedOut: 'the session did not answer in time',
  unsendable: 'the call could not be sent',
  replyTooLarge: 'the answer is too large',
  badReply: 'the answer could not be read',
  badRequest: 'the call could not be read',
  failed: 'the call failed inside the session',
  notOpen: 'this target is not open in the session',
};

export function callRefusal(why, word, name) {
  const where = word === undefined ? '' : ` (${word} ${clip(name, 64)})`;
  return { text: `REFUSED${where}: ${why}`, isError: true };
}

function validCall(request) {
  return request !== null && typeof request === 'object' && !Array.isArray(request)
    && typeof request.kind === 'string'
    && typeof request.name === 'string'
    && Object.hasOwn(request, 'input')
    && Number.isInteger(request.timeoutSeconds) && request.timeoutSeconds >= 1 && request.timeoutSeconds <= 600;
}

function validAnswer(answer) {
  return answer !== null && typeof answer === 'object' && typeof answer.text === 'string' && typeof answer.isError === 'boolean';
}

// The size in bytes of the line that carries the answer: its text and isError as JSON, and the newline.
export function answerBytes(answer) {
  return Buffer.byteLength(JSON.stringify({ text: answer.text, isError: answer.isError })) + 1;
}

// The one line the server writes back: the answer, or a fixed refusal when it is not an answer or is too large.
// answerCall keeps its answers within MAX_ANSWER_BYTES, so the second refusal is only for another handler.
function answerLine(answer) {
  if (!validAnswer(answer)) return `${JSON.stringify(callRefusal(CALL_FAILED.failed))}\n`;
  if (answerBytes(answer) > MAX_ANSWER_BYTES) return `${JSON.stringify(callRefusal(CALL_FAILED.replyTooLarge))}\n`;
  return `${JSON.stringify({ text: answer.text, isError: answer.isError })}\n`;
}

// The server writes the answer and closes the connection itself once it is sent, without waiting for the client
// to close its side; a client that does not read the answer is dropped waitMs later. So no connection that has
// had its answer keeps a place among the MAX_CONNECTIONS.
export function sendAndClose(conn, line, waitMs) {
  const drop = setTimeout(() => conn.destroy(), waitMs);
  conn.on('close', () => clearTimeout(drop));
  conn.end(line, () => conn.destroy());
}

async function settle(handle, line, signal) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return callRefusal(CALL_FAILED.badRequest);
  }
  if (!validCall(request)) return callRefusal(CALL_FAILED.badRequest);
  try {
    return await handle({
      kind: request.kind,
      name: request.name,
      input: request.input,
      timeoutSeconds: request.timeoutSeconds,
      ...(Object.hasOwn(request, 'origin') ? { origin: request.origin } : {}),
    }, signal);
  } catch {
    return null;
  }
}

export function startCallServer({ socket, handle, requestTimeoutMs = 5000 }) {
  const open = new Set();
  const stopper = new AbortController();

  const server = net.createServer((conn) => {
    open.add(conn);
    let buffered = '';
    conn.setEncoding('utf8');
    const deadline = setTimeout(() => conn.destroy(), requestTimeoutMs);
    conn.on('error', () => {});
    conn.on('close', () => {
      clearTimeout(deadline);
      open.delete(conn);
    });
    const onData = (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (Buffer.byteLength(end === -1 ? buffered : buffered.slice(0, end + 1)) > MAX_CALL_BYTES) {
        conn.destroy();
        return;
      }
      if (end === -1) return;
      conn.off('data', onData);
      clearTimeout(deadline);
      settle(handle, buffered.slice(0, end), stopper.signal).then((answer) => sendAndClose(conn, answerLine(answer), requestTimeoutMs));
    };
    conn.on('data', onData);
  });
  server.maxConnections = MAX_CONNECTIONS;

  return new Promise((resolve, reject) => {
    fs.rmSync(socket, { force: true });
    server.once('error', reject);
    server.listen(socket, () => {
      try {
        fs.chmodSync(socket, 0o600);
      } catch (err) {
        server.close(() => reject(err));
        return;
      }
      resolve({
        close: () => new Promise((done) => {
          stopper.abort();
          for (const conn of open) conn.destroy();
          server.close(() => {
            fs.rmSync(socket, { force: true });
            done();
          });
        }),
      });
    });
  });
}

function readAnswer(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    return null;
  }
  return validAnswer(answer) ? { text: answer.text, isError: answer.isError } : null;
}

export function askCall(socket, request, timeoutMs, word) {
  const name = request?.name;
  let line;
  try {
    line = `${JSON.stringify(request)}\n`;
  } catch {
    return Promise.resolve(callRefusal(CALL_FAILED.unsendable, word, name));
  }
  if (Buffer.byteLength(line) > MAX_CALL_BYTES) return Promise.resolve(callRefusal(CALL_FAILED.unsendable, word, name));
  return new Promise((resolve) => {
    let buffered = '';
    let size = 0;
    let settled = false;
    const conn = net.connect(socket);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(callRefusal(CALL_FAILED.timedOut, word, name)), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('error', () => finish(callRefusal(CALL_FAILED.noAnswer, word, name)));
    conn.on('connect', () => conn.write(line));
    // The decoder gives whole characters, so the bytes of the chunks add up to those of the text: each chunk is
    // counted once, and nothing is read past MAX_ANSWER_BYTES and one chunk.
    conn.on('data', (chunk) => {
      buffered += chunk;
      size += Buffer.byteLength(chunk);
      if (size > MAX_ANSWER_BYTES) finish(callRefusal(CALL_FAILED.replyTooLarge, word, name));
    });
    conn.on('close', () => {
      if (buffered === '') {
        finish(callRefusal(CALL_FAILED.noAnswer, word, name));
        return;
      }
      finish(readAnswer(buffered) ?? callRefusal(CALL_FAILED.badReply, word, name));
    });
  });
}

// Whether something accepts a connection on the socket; the connection is closed at once.
export function callSocketOpen(socket) {
  return new Promise((resolve) => {
    const conn = net.connect(socket);
    conn.on('connect', () => {
      conn.destroy();
      resolve(true);
    });
    conn.on('error', () => resolve(false));
  });
}
