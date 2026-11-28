#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';

const argv = process.argv.slice(2);
const last = argv[argv.length - 1];

if (process.env.KSPROXY_FAKE_SSH_LOG) {
  fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_LOG, `${JSON.stringify(argv)}\n`);
}
if (process.env.KSPROXY_FAKE_SSH_ENV_LOG) {
  fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_ENV_LOG, `${JSON.stringify({ argv, env: process.env })}\n`);
}

function valueAfter(flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

// The stream mode of the service tunnels: the arguments must be exactly the isolation options of the design, then
// either -W ADDRESS -- ksproxy-tunnel, or -T -e none -- ksproxy-tunnel and one nested command whose every hop has the
// fixed words of a jump and whose last hop alone has -W just before its server. Anything else exits with 64.
// Without the socket of the shared connection it fails as ssh does. Else stdin and stdout are joined to the loopback
// port KSPROXY_FAKE_SSH_STREAM_PORT, each end passed on. KSPROXY_FAKE_SSH_STREAM_FAIL: "quiet" exits with 255 and
// prints nothing, a number N prints a line and N more bytes to stderr first. KSPROXY_FAKE_SSH_STREAM_LINGER: the
// process stays after its output ended, until it is killed. KSPROXY_FAKE_SSH_STREAM_DONE: prints that text and exits
// with 0 without reading stdin. KSPROXY_FAKE_SSH_STREAM_COMMAND: the exact nested command.
const ISOLATION = (socket) => [
  '-F', '/dev/null', '-o', `ControlPath=${socket}`, '-o', 'ControlMaster=no', '-o', 'HostName=ksproxy.invalid',
  '-o', 'ProxyCommand=/usr/bin/false', '-o', 'BatchMode=yes', '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=/dev/null', '-o', 'PubkeyAuthentication=no', '-o', 'PasswordAuthentication=no',
  '-o', 'KbdInteractiveAuthentication=no',
];
const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ADDRESS = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+):[0-9]+$/;
const JUMP_FLAGS = ['-i', '-p', '-l', '-o', '-J'];

function refuse(why) {
  process.stderr.write(`fake-ssh: ${why}\n`);
  process.exit(64);
}

// The -W address of a nested command, after its strict check.
function nestedAddress(command) {
  const words = command.split(' ');
  if (!words.every((w) => PLAIN.test(w))) refuse('a word of the nested command is not plain');
  const hops = [[]];
  for (const w of words) {
    if (w === '--') hops.push([]);
    else hops.at(-1).push(w);
  }
  if (hops.length > 5) refuse('more than five jumps');
  let address;
  hops.forEach((hop, i) => {
    const lastHop = i === hops.length - 1;
    const tail = lastHop ? hop.slice(-5) : hop.slice(-3);
    if (hop.slice(0, 6).join(' ') !== 'ssh -T -e none -o BatchMode=yes') refuse(`hop ${i}: not the fixed words`);
    if (tail[0] !== '-o' || tail[1] !== 'ConnectTimeout=10') refuse(`hop ${i}: no connect timeout before the server`);
    if (lastHop && tail[2] !== '-W') refuse('-W is not just before the last server');
    const middle = hop.slice(6, hop.length - tail.length);
    for (let j = 0; j < middle.length; j += 2) {
      if (!JUMP_FLAGS.includes(middle[j]) || middle[j + 1] === undefined || middle[j + 1].startsWith('-')) {
        refuse(`hop ${i}: an option that a jump cannot have`);
      }
    }
    if (lastHop) address = tail[3];
  });
  return address;
}

function streamMode() {
  const control = argv[3] ?? '';
  const socket = control.slice('ControlPath='.length);
  const own = ISOLATION(socket);
  if (!control.startsWith('ControlPath=') || JSON.stringify(argv.slice(0, own.length)) !== JSON.stringify(own)) {
    refuse('not the isolation options');
  }
  const rest = argv.slice(own.length);
  let address;
  if (rest[0] === '-W') {
    if (rest.length !== 4 || rest[2] !== '--' || rest[3] !== 'ksproxy-tunnel') refuse('-W is not in its place');
    address = rest[1];
  } else {
    if (rest.length !== 6 || rest.slice(0, 5).join(' ') !== '-T -e none -- ksproxy-tunnel') refuse('not a nested command');
    const want = process.env.KSPROXY_FAKE_SSH_STREAM_COMMAND;
    if (want !== undefined && rest[5] !== want) refuse('not the expected nested command');
    address = nestedAddress(rest[5]);
  }
  if (!ADDRESS.test(address)) refuse('not a service address');
  if (!fs.existsSync(socket)) {
    process.stderr.write(`Control socket connect(${socket}): No such file or directory\n`);
    process.stderr.write('kex_exchange_identification: Connection closed by remote host\n', () => process.exit(255));
    return;
  }
  if (process.env.KSPROXY_FAKE_SSH_PID_LOG) fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_PID_LOG, `${process.pid}\n`);
  const fail = process.env.KSPROXY_FAKE_SSH_STREAM_FAIL;
  if (fail === 'quiet') process.exit(255);
  if (fail !== undefined) {
    const text = `channel 0: open failed: connect failed: Connection refused\n${'x'.repeat(Number(fail))}`;
    process.stderr.write(text, () => process.exit(255));
    return;
  }
  const done = process.env.KSPROXY_FAKE_SSH_STREAM_DONE;
  if (done !== undefined) {
    process.stdout.write(done, () => process.exit(0));
    return;
  }
  // A socket on fd 1, not a file stream: a file stream fails with "write failed" when the pipe is full.
  const out = new net.Socket({ fd: 1, readable: false, writable: true });
  out.on('error', () => process.exit(255));
  const sock = net.connect({ port: Number(process.env.KSPROXY_FAKE_SSH_STREAM_PORT), host: '127.0.0.1', allowHalfOpen: true });
  let sockClosed = false;
  let outClosed = false;
  const linger = process.env.KSPROXY_FAKE_SSH_STREAM_LINGER !== undefined;
  if (linger) setInterval(() => {}, 60000);
  const maybeExit = () => {
    if (sockClosed && outClosed && !linger) process.exit(0);
  };
  sock.on('error', () => process.exit(255));
  sock.on('close', () => {
    sockClosed = true;
    maybeExit();
  });
  out.on('close', () => {
    outClosed = true;
    maybeExit();
  });
  process.stdin.pipe(sock);
  sock.pipe(out);
}

if (argv[0] === '-F' && argv[1] === '/dev/null') {
  streamMode();
} else if (argv.includes('-M')) {
  if (process.env.KSPROXY_FAKE_SSH_FAIL_HOST && process.env.KSPROXY_FAKE_SSH_FAIL_HOST === last) process.exit(255);
  const opt = argv.find((a, i) => argv[i - 1] === '-o' && a.startsWith('ControlPath='));
  if (!opt) process.exit(64);
  fs.writeFileSync(opt.slice('ControlPath='.length), '');
  process.exit(0);
} else if (argv.includes('-O') && valueAfter('-O') === 'check') {
  const trace = (word) => {
    if (process.env.KSPROXY_FAKE_SSH_TRACE) {
      fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_TRACE, `${word}\n`);
    }
  };
  // KSPROXY_FAKE_SSH_CHECK_FAIL_ONCE names a file: while it holds the host of this check, the check removes the file
  // and fails once, with the socket left as it is.
  const failOnce = () => {
    const file = process.env.KSPROXY_FAKE_SSH_CHECK_FAIL_ONCE;
    if (file === undefined || !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== last) return false;
    fs.rmSync(file, { force: true });
    return true;
  };
  const finishCheck = () => {
    trace('end');
    if (failOnce()) process.exit(255);
    process.exit(fs.existsSync(valueAfter('-S')) ? 0 : 255);
  };
  trace('begin');
  const delay = Number(process.env.KSPROXY_FAKE_SSH_CHECK_MS ?? 0);
  if (delay > 0) setTimeout(finishCheck, delay);
  else finishCheck();
} else if (argv.includes('-O') && valueAfter('-O') === 'exit') {
  fs.rmSync(valueAfter('-S'), { force: true });
  process.exit(0);
} else if (argv.includes('-F')) {
  const sep = argv.indexOf('--');
  const name = argv[sep - 1];
  const command = argv.slice(sep + 1).join(' ');
  if (command === 'fail') {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (command === 'env') {
    process.stdout.write(`ENV=${JSON.stringify(Object.keys(process.env).sort())}\n`);
    process.exit(0);
  }
  if (command === 'slow') {
    // A test that ends the call can find this process by its pid.
    if (process.env.KSPROXY_FAKE_SSH_PID_LOG) fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_PID_LOG, `${process.pid}\n`);
    setTimeout(() => process.exit(0), 10000);
  } else {
    process.stdout.write(`ran ${name} ${command}\n`);
    process.exit(0);
  }
} else {
  process.exit(64);
}
