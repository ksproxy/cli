import fs from 'node:fs';
import net from 'node:net';
import vault from './kind-brokered.js';

// Two test-only kinds that can be tunnelled, built on the test vault: one whose client is ksproxy's own code and
// takes the stream (tunnel.connect), one whose client connects to a loopback listener (tunnelListener: true, then
// tunnel.host and tunnel.port). No real kind has the hooks yet. Each sends one line through the tunnel and reads one
// line back: PING gives PONG (the doctor hook, which is also the trial, and probe), GET WORDS gives VALUE WORDS
// (perform). The service at the other end is a loopback server of the test, which fake-ssh joins in stream mode.

// What the tests steer and read back. log: a file that gets one JSON line per hook, in the order they ran, the same
// file the fake ssh writes its arguments to; to: what tunnelTo gives (a function of the target and the secrets);
// onDoctor, onOpen: called with the opened entry, or the target and its context, before the hook goes on; openResult:
// what open gives instead of ok. tunnels: the tunnel each open was given, by target name.
export const steer = {};
export function resetSteer() {
  Object.assign(steer, {
    log: null,
    to: () => 'svc.example.com:5432',
    onDoctor: null,
    onOpen: null,
    openResult: null,
    tunnels: new Map(),
    trials: [],
  });
}
resetSteer();

function note(kind, event, name) {
  if (steer.log !== null) fs.appendFileSync(steer.log, `${JSON.stringify({ kind, event, name })}\n`);
}

// A client socket through a tunnel: the stream itself, or a connection to the listener. null when connect throws.
function clientOf(tunnel) {
  if (tunnel.connect === undefined) return net.connect({ host: tunnel.host, port: tunnel.port });
  try {
    return tunnel.connect();
  } catch {
    return null;
  }
}

// One line sent through the tunnel, and the first line that comes back; null when the other side ends or fails
// first, or the signal fires. The client is closed either way.
export function exchange(tunnel, line, signal) {
  const socket = clientOf(tunnel);
  if (socket === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = '';
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.on('data', (chunk) => {
      text += chunk;
      const at = text.indexOf('\n');
      if (at !== -1) done(text.slice(0, at));
    });
    socket.on('error', () => done(null));
    socket.on('end', () => done(null));
    socket.on('close', () => done(null));
    if (signal?.aborted) done(null);
    signal?.addEventListener('abort', () => done(null), { once: true });
    socket.write(`${line}\n`);
  });
}

export function tunnelledKind(key, label, { listener = false, close = true } = {}) {
  const tool = `${key}_read`;
  const kind = {
    ...vault,
    key,
    flag: key,
    label,
    word: key,
    noun: `${key} target`,
    countNoun: `${key} target(s)`,
    validate(entry, where, ctx) {
      return { ...vault.validate(entry, where, ctx), kind: key };
    },
    record(opened, ctx) {
      return { ...vault.record(opened, ctx), kind: key };
    },
    tunnelTo(target, secrets) {
      note(key, 'tunnelTo', target.name);
      return steer.to(target, secrets);
    },
    tunnelChecksCertificate(target) {
      return target.description === 'checked';
    },
    async doctor(opened, { signal }) {
      note(key, 'doctor', opened.target.name);
      steer.trials.push(opened);
      if (steer.onDoctor !== null) await steer.onDoctor(opened, signal);
      const reply = await exchange(opened.tunnel, 'PING', signal);
      return reply === 'PONG' ? { ok: true, detail: 'PONG' } : { ok: false, detail: 'no answer to PING' };
    },
    async open(target, ctx) {
      note(key, 'open', target.name);
      steer.tunnels.set(target.name, ctx.tunnel);
      if (steer.onOpen !== null) await steer.onOpen(target, ctx);
      return steer.openResult ?? { ok: true, extras: { opener: key } };
    },
    async perform(target, decision, { opened, signal }) {
      const [word] = decision.argv;
      if (word === 'hold') {
        // A call that keeps its connection open until the session stops it.
        const socket = clientOf(opened.tunnel);
        socket.on('error', () => {});
        socket.write('GET hold\n');
        await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
        socket.destroy();
        return { exitCode: 0, stdout: 'held\n', stderr: '' };
      }
      const reply = await exchange(opened.tunnel, `GET ${decision.argv.join(' ')}`, signal);
      if (reply === null) return { exitCode: 1, stdout: '', stderr: 'no answer through the tunnel\n' };
      return { exitCode: 0, stdout: `${reply}\n`, stderr: '' };
    },
    async probe(target, { opened }) {
      return (await exchange(opened.tunnel, 'PING')) === 'PONG' ? 'up' : 'down';
    },
    downMessage() {
      return `${key} is not answering`;
    },
    toolBullet: `- \`${tool} { target, command, timeout_seconds? }\` - read from a test service.`,
    agentSection(target) {
      return `### ${key} target \`${target.name}\`\n- Tool: \`${tool}\` with \`target: "${target.name}"\``;
    },
    tool: { ...vault.tool, name: tool, definition: { ...vault.tool.definition, name: tool } },
  };
  if (listener) kind.tunnelListener = true;
  if (close) {
    kind.close = async (opened) => {
      note(key, 'close', opened.target.name);
    };
    kind.closeLimit = `${key}CloseMs`;
    kind.closeMs = 5000;
  } else {
    delete kind.close;
  }
  return kind;
}

// The service at the end of every tunnel: a loopback server that answers each line. silent: it ends each
// connection without an answer. lines: every line it read, in order; connections: how many it was given.
export async function startService() {
  const service = {
    silent: false, lines: [], connections: 0, sockets: new Set(),
  };
  const server = net.createServer((socket) => {
    service.connections += 1;
    service.sockets.add(socket);
    socket.on('close', () => service.sockets.delete(socket));
    socket.on('error', () => {});
    if (service.silent) {
      // Ended, not destroyed: a reset would make the fake ssh fail, which is a failure of the route.
      socket.resume();
      socket.end();
      return;
    }
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n')) {
        const line = text.slice(0, at);
        text = text.slice(at + 1);
        service.lines.push(line);
        if (line !== 'GET hold') socket.write(line === 'PING' ? 'PONG\n' : `VALUE ${line.slice(4)}\n`);
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  service.port = server.address().port;
  service.close = () => new Promise((resolve) => {
    for (const socket of service.sockets) socket.destroy();
    server.close(resolve);
  });
  return service;
}
