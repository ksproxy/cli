import net from 'node:net';
import tls from 'node:tls';

// A stand-in Redis server on the loopback address. It reads commands sent as arrays of bulk strings (its own small
// parser, so that the engine's encoder is checked by something else), records every command and every byte, and
// answers through answer(words, connection): a string or Buffer to send, an array of them to send as separate
// writes, or null to say nothing.

// The commands in buffer: { commands, rest }, each command an array of strings; throws on anything else.
export function parseCommands(buffer) {
  const commands = [];
  let at = 0;
  const line = () => {
    const end = buffer.indexOf('\r\n', at);
    if (end === -1) return null;
    const text = buffer.subarray(at, end).toString('latin1');
    at = end + 2;
    return text;
  };
  for (;;) {
    const start = at;
    const head = line();
    if (head === null) return { commands, rest: buffer.subarray(start) };
    if (!/^\*[1-9]\d*$/.test(head)) throw new Error(`not an array of bulk strings: ${head}`);
    const words = [];
    let complete = true;
    for (let i = 0; i < Number(head.slice(1)); i += 1) {
      const size = line();
      if (size === null) {
        complete = false;
        break;
      }
      if (!/^\$\d+$/.test(size)) throw new Error(`not a bulk string: ${size}`);
      const n = Number(size.slice(1));
      if (buffer.length < at + n + 2) {
        complete = false;
        break;
      }
      words.push(buffer.subarray(at, at + n).toString('utf8'));
      if (buffer.subarray(at + n, at + n + 2).toString('latin1') !== '\r\n') throw new Error('a bulk string does not end in CRLF');
      at += n + 2;
    }
    if (!complete) return { commands, rest: buffer.subarray(start) };
    commands.push(words);
  }
}

export async function respServer(answer, { tlsOptions } = {}) {
  const commands = [];
  const raw = [];
  const sockets = new Set();
  const onConnection = (socket) => {
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      raw.push(chunk);
      pending = Buffer.concat([pending, chunk]);
      let parsed;
      try {
        parsed = parseCommands(pending);
      } catch {
        socket.destroy();
        return;
      }
      pending = parsed.rest;
      for (const words of parsed.commands) {
        commands.push(words);
        const reply = answer(words, socket);
        if (reply === null || socket.destroyed) continue;
        for (const part of Array.isArray(reply) ? reply : [reply]) socket.write(part);
      }
    });
  };
  const server = tlsOptions === undefined
    ? net.createServer(onConnection)
    : tls.createServer(tlsOptions, onConnection);
  server.on('tlsClientError', () => {});
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port,
    commands,
    raw,
    bytes: () => Buffer.concat(raw),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => { server.close(resolve); });
    },
  };
}

// A plain answer for the usual commands, for the tests that only need a server that works.
export function simpleAnswer(words) {
  const name = words[0].toUpperCase();
  if (name === 'AUTH' || name === 'SELECT' || name === 'SET') return '+OK\r\n';
  if (name === 'PING') return '+PONG\r\n';
  if (name === 'GET') return words[1] === 'missing' ? '$-1\r\n' : `$${Buffer.byteLength(`value-of-${words[1]}`)}\r\nvalue-of-${words[1]}\r\n`;
  if (name === 'TTL') return ':42\r\n';
  if (name === 'KEYS') return '*2\r\n$6\r\nuser:1\r\n$6\r\nuser:2\r\n';
  return '-ERR unknown command\r\n';
}
