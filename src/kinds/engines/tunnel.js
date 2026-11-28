import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { tokenizeSshCommand } from '../../allowlist.js';
import {
  InventoryError, checkHost, checkKeys, isObject,
} from '../../checks.js';
import { minimalEnv } from '../../exec.js';
import { socketPath, sshBin } from '../../paths.js';
import {
  MAX_JUMPS, checkMaster, closeMaster, jumpWords, openMaster, parseJump,
} from '../ssh/master.js';

// The service tunnels: one ssh child per connection to a service, each a plain byte stream (-W) over a shared
// connection (a ControlMaster) to the first server, through the jumps of the route when it has some.

const TUNNEL_KEYS = ['host', 'jumps'];
export const MAX_LISTENER_CONNECTIONS = 16;
export const MAX_JUMP_CONNECTIONS = 8;
export const STDERR_CAP = 4096;
// The name every stream ssh is given: the shared connection answers for it, and HostName ksproxy.invalid with
// ProxyCommand /usr/bin/false keeps it from ever reaching a host by itself.
export const TUNNEL_DESTINATION = 'ksproxy-tunnel';
// After its output ended, a child is given this long to exit by itself before it is killed.
const EXIT_GRACE_MS = 1000;

// The route of a service target: host as an ssh target's host, jumps 0 to MAX_JUMPS ssh commands as an ssh target's
// jumps. Gives { host, jumps }, jumps always a list of the jump texts with their words joined by single spaces.
export function checkTunnel(value, where) {
  if (!isObject(value)) throw new InventoryError(`${where}: tunnel: must be an object with "host" and optional "jumps"`);
  checkKeys(value, TUNNEL_KEYS, `${where}: tunnel`);
  checkHost(value.host, `${where}: tunnel.host`);
  const list = value.jumps === undefined ? [] : value.jumps;
  if (!Array.isArray(list) || list.length > MAX_JUMPS) {
    throw new InventoryError(`${where}: tunnel.jumps: must be a list of 0 to ${MAX_JUMPS} ssh commands`);
  }
  const jumps = list.map((jump, j) => {
    const at = `${where}: tunnel.jumps[${j}]`;
    if (typeof jump !== 'string' || jump.trim() === '') {
      throw new InventoryError(`${at}: must be an ssh command, for example "ssh -i .ssh/key user@server"`);
    }
    if (jump.includes('~')) {
      throw new InventoryError(`${at}: "~" is not allowed; a path without a leading "/" starts in the home folder of that login`);
    }
    try {
      const words = tokenizeSshCommand(jump);
      parseJump(words);
      return words.join(' ');
    } catch (err) {
      throw new InventoryError(`${at}: ${err.message}`);
    }
  });
  return { host: value.host, jumps };
}

const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?';
const NAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const V6_RE = /^\[([0-9A-Fa-f:.]+)\]:([^:]+)$/;
const PORT_RE = /^[1-9][0-9]{0,4}$/;
const BAD_TO = 'the service address must be host:port or [IPv6]:port';

// The -W address: host:port with a host name or an IPv4 address, or [v6]:port without jumps. The value is never in
// the message: it may come from a secret.
function checkTo(to, jumped) {
  if (typeof to !== 'string') throw new Error(BAD_TO);
  const v6 = V6_RE.exec(to);
  let port;
  if (v6 !== null) {
    if (!net.isIPv6(v6[1])) throw new Error(BAD_TO);
    port = v6[2];
  } else {
    const at = to.lastIndexOf(':');
    const host = to.slice(0, at);
    if (at < 1 || host.length > 253 || !NAME_RE.test(host)) throw new Error(BAD_TO);
    port = to.slice(at + 1);
  }
  if (!PORT_RE.test(port) || Number(port) > 65535) throw new Error(BAD_TO);
  if (v6 !== null && jumped) throw new Error('an IPv6 service address cannot be used with jumps');
}

// The options that tie a stream ssh to the shared connection at socket and to nothing else: no configuration file of
// the owner, no key, no agent, no prompt, and no connection of its own when the socket is gone.
export function isolationArgs(socket) {
  return [
    '-F', '/dev/null',
    '-o', `ControlPath=${socket}`,
    '-o', 'ControlMaster=no',
    '-o', 'HostName=ksproxy.invalid',
    '-o', 'ProxyCommand=/usr/bin/false',
    '-o', 'BatchMode=yes',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'IdentityAgent=none',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityFile=/dev/null',
    '-o', 'PubkeyAuthentication=no',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
  ];
}

// The arguments of one stream ssh. Without jumps the shared connection itself connects to the address. With jumps the
// first server runs the nested command: each jump's words, its server and --, and for the last jump -W before its
// server and nothing after it. That command is read by the shell of each server on the way, so every word in it must
// be plain: the jump words passed the tokenizer, which keeps only letters, digits and _ @ % + = : , . / -, and
// parseJump; the address passed checkTo, which allows no bracket with jumps. Throws when either is broken.
export function streamArgs({ socket, jumps, to }) {
  if (!Array.isArray(jumps) || jumps.length > MAX_JUMPS) {
    throw new Error(`jumps must be a list of 0 to ${MAX_JUMPS} ssh commands`);
  }
  checkTo(to, jumps.length > 0);
  const own = isolationArgs(socket);
  if (jumps.length === 0) return [...own, '-W', to, '--', TUNNEL_DESTINATION];
  const hops = jumps.map(jumpWords);
  const words = hops.flatMap(({ words: hop, server }, i) => (
    i === hops.length - 1 ? [...hop, '-W', to, server] : [...hop, server, '--']));
  return [...own, '-T', '-e', 'none', '--', TUNNEL_DESTINATION, words.join(' ')];
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // the child never started, or it is gone already
  }
}

// One ssh child as a Duplex stream: what is written goes to its stdin, what it prints comes out, and the end of each
// side is passed on (half close). Its stderr is read all the time, so the child is never blocked, and its first
// STDERR_CAP bytes are kept. A child that fails, not killed by the stream, sets stream.reason to that text (or to its
// exit code or signal, or the spawn error); when the stream is still in use it is then destroyed with that error.
// stream.exited is fulfilled with { reason } once the child is gone. After a child that ended well, what is written
// is dropped and the stream waits for its user to end it. Destroying the stream kills the child at once when its
// output is still open (its user went away), else after EXIT_GRACE_MS; 'close' comes only after the child is gone.
// 'connect' is emitted when the child is running.
export function openStream(args, env = process.env) {
  const child = spawn(sshBin(env), args, { env: minimalEnv(env), stdio: 'pipe', detached: true });
  const kept = [];
  let keptBytes = 0;
  let spawnError = null;
  let outputEnded = false;
  let killed = false;
  let gone = false;
  let waiting = null;
  let afterExit = null;
  let timer = null;
  const kill = () => {
    killed = true;
    killGroup(child);
  };
  const release = () => {
    const callback = waiting;
    waiting = null;
    callback?.();
  };

  const stream = new Duplex({
    write(chunk, encoding, callback) {
      if (gone || child.stdin.write(chunk)) {
        callback();
        return;
      }
      waiting = callback;
    },
    final(callback) {
      child.stdin.end();
      callback();
    },
    read() {
      child.stdout.resume();
    },
    destroy(err, callback) {
      if (gone) {
        callback(err);
        return;
      }
      afterExit = () => callback(err);
      if (outputEnded) {
        // The end of its input lets a child that is ending go at once, before the time is up.
        child.stdin.destroy();
        timer = setTimeout(kill, EXIT_GRACE_MS);
      } else {
        kill();
      }
    },
  });
  stream.reason = null;
  let exited;
  stream.exited = new Promise((resolve) => {
    exited = resolve;
  });

  child.on('spawn', () => stream.emit('connect'));
  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.stdin.on('error', release);
  child.stdin.on('drain', release);
  child.stdout.on('data', (chunk) => {
    if (!stream.push(chunk)) child.stdout.pause();
  });
  child.stdout.on('end', () => {
    outputEnded = true;
    stream.push(null);
  });
  child.stderr.on('data', (chunk) => {
    const room = STDERR_CAP - keptBytes;
    if (room <= 0) return;
    const piece = chunk.subarray(0, room);
    kept.push(piece);
    keptBytes += piece.length;
  });
  child.on('close', (code, signal) => {
    gone = true;
    clearTimeout(timer);
    release();
    if (!killed && code !== 0) {
      const text = Buffer.concat(kept).toString('utf8').trim();
      const ended = signal === null ? `ssh exited with code ${code}` : `ssh ended with signal ${signal}`;
      stream.reason = spawnError ?? (text === '' ? ended : text);
    }
    exited({ reason: stream.reason });
    if (afterExit !== null) afterExit();
    else if (stream.reason !== null) stream.destroy(new Error(stream.reason));
  });
  return stream;
}

// Joins an accepted socket and a stream, both ways, each end passed on (half close). When the socket closes, the
// stream is destroyed (its child killed); when the stream closes, the socket is ended and then destroyed.
// Gives a promise that is fulfilled once both are closed.
function join(socket, stream) {
  const closed = (s) => new Promise((resolve) => {
    s.once('close', resolve);
  });
  const done = Promise.all([closed(socket), closed(stream)]);
  const drop = () => {
    socket.destroy();
    stream.destroy();
  };
  socket.on('error', drop);
  stream.on('error', drop);
  socket.on('close', () => stream.destroy());
  stream.on('close', () => socket.end(() => socket.destroy()));
  socket.pipe(stream);
  stream.pipe(socket);
  return done;
}

// A loopback listener on 127.0.0.1 with a port the system chooses. Each accepted connection is joined to connect(),
// a function that gives a Duplex stream; when it throws, the connection is closed. A connection is accepted only while
// the gate is held (hold() gives the release function), close was not asked, and fewer than MAX_LISTENER_CONNECTIONS
// are open; any other is closed at once. A connection belongs to the holds that were taken when it was accepted, and is closed when
// the last of those is released: one that another process made during a call never outlives the calls that ran then,
// however many later calls overlap, and a pair that is ending no longer counts toward the limit. close() takes no new
// hold, waits for the holds to end, then closes the port and every connection, and is fulfilled once they are all gone.
// Gives { host, port, hold, close }.
export function openListener(connect) {
  const live = new Set();
  const ending = new Set();
  const holds = new Set();
  let closing = null;
  let wake = null;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (closing !== null || holds.size === 0 || live.size >= MAX_LISTENER_CONNECTIONS) {
      socket.destroy();
      return;
    }
    let stream;
    try {
      stream = connect();
    } catch {
      socket.destroy();
      return;
    }
    const pair = {
      socket, stream, done: join(socket, stream), owners: new Set(holds),
    };
    live.add(pair);
    pair.done.then(() => {
      live.delete(pair);
      ending.delete(pair);
    });
  });

  // Ends every open connection that no hold in owners keeps (all of them without owners); each counts as ending, not
  // as open, until its child is gone.
  const drop = (gone) => {
    for (const pair of live) {
      pair.owners.delete(gone);
      if (gone !== undefined && pair.owners.size > 0) continue;
      live.delete(pair);
      ending.add(pair);
      pair.socket.destroy();
      pair.stream.destroy();
    }
  };

  const hold = () => {
    if (closing !== null) return () => {};
    const mine = {};
    holds.add(mine);
    return () => {
      if (!holds.delete(mine)) return;
      drop(mine);
      if (holds.size === 0 && wake !== null) wake();
    };
  };

  const shut = async () => {
    if (holds.size > 0) {
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
    const stopped = new Promise((resolve) => {
      server.close(resolve);
    });
    drop();
    await Promise.all([stopped, ...[...ending].map((pair) => pair.done)]);
  };

  const close = () => {
    closing ??= shut();
    return closing;
  };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        host: '127.0.0.1', port: server.address().port, hold, close,
      });
    });
  });
}

// The socket of the shared connection to host: tnl- and 8 hex characters of a hash of the host. Throws the error of
// socketPath when the path is too long for ssh.
function masterSocket(host, env) {
  return socketPath('tnl', createHash('sha256').update(host).digest('hex').slice(0, 8), env);
}

// The shared connections of one start (or one doctor run of a project): at most one per first server.
//   socketFor(host): the socket path, checked for its length (throws), before anything opens.
//   open(host): opens the connection once (openMaster); every later call gives the same result, { ok } or
//     { ok: false, error }.
//   connector({ host, jumps }, to): checks the arguments now (throws streamArgs' errors) and gives connect(), which
//     makes one stream over that connection (openStream), or throws when the connection is not open or when
//     MAX_JUMP_CONNECTIONS streams with jumps are open over it already.
//   check(host): checkMaster; once it fails, the connection counts as gone for good and connect() throws.
//   closeAll(): closes every connection that was opened or tried (closeMaster), after its open has ended.
export function sharedMasters(env = process.env) {
  const masters = new Map();
  const owners = new Map();

  const entry = (host) => {
    const known = masters.get(host);
    if (known !== undefined) return known;
    const socket = masterSocket(host, env);
    const other = owners.get(socket);
    if (other !== undefined) {
      throw new Error(`the shared connections to ${other} and ${host} would use the same socket; write one of them in another form`);
    }
    const master = {
      host, socket, opening: null, ok: false, jumped: 0,
    };
    masters.set(host, master);
    owners.set(socket, host);
    return master;
  };

  const opened = async (master) => {
    const result = await openMaster({ socket: master.socket, host: master.host }, env);
    master.ok = result.ok;
    return result;
  };

  return {
    socketFor(host) {
      return entry(host).socket;
    },
    open(host) {
      let master;
      try {
        master = entry(host);
      } catch (err) {
        return Promise.resolve({ ok: false, error: err.message });
      }
      master.opening ??= opened(master);
      return master.opening;
    },
    connector({ host, jumps }, to) {
      const master = entry(host);
      const args = streamArgs({ socket: master.socket, jumps, to });
      const jumped = jumps.length > 0;
      return () => {
        if (!master.ok) throw new Error('the shared connection is not open');
        if (jumped && master.jumped >= MAX_JUMP_CONNECTIONS) {
          throw new Error(`at most ${MAX_JUMP_CONNECTIONS} connections with jumps may be open at once over one shared connection`);
        }
        const stream = openStream(args, env);
        if (jumped) {
          master.jumped += 1;
          stream.once('close', () => {
            master.jumped -= 1;
          });
        }
        return stream;
      };
    },
    async check(host) {
      const master = masters.get(host);
      if (master === undefined || !master.ok) return false;
      master.ok = await checkMaster({ socket: master.socket, host }, env);
      return master.ok;
    },
    async closeAll() {
      for (const master of masters.values()) {
        if (master.opening === null) continue;
        await master.opening;
        master.ok = false;
        await closeMaster({ socket: master.socket, host: master.host }, env);
      }
    },
  };
}
