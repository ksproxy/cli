#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// A stand-in for mongosh. It never reads or runs the script it is given. As mongosh does, it writes a log under
// HOME/.mongodb/mongosh. It appends one JSON line to the file named by FAKE_MONGOSH_LOG with its arguments, HOME and
// the three variables of the mongodb kind, then answers as the test chose:
// the text of the file named by FAKE_MONGOSH_MODE_FILE, else ok. A test wraps it in a small shell script that sets
// those two variables, since the kind gives the client only a minimal environment.
const argv = process.argv.slice(2);
const { MGO_URI: uri, MGO_DB: db, MGO_DOC: doc } = process.env;
const logDir = path.join(process.env.HOME, '.mongodb', 'mongosh');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, `${process.pid}_log`), `${doc}\n`);
if (process.env.FAKE_MONGOSH_LOG) {
  fs.appendFileSync(process.env.FAKE_MONGOSH_LOG, `${JSON.stringify({
    argv, uri, db, doc, names: Object.keys(process.env).sort(), cwd: process.cwd(), home: process.env.HOME,
  })}\n`);
}
const modeFile = process.env.FAKE_MONGOSH_MODE_FILE;
const mode = modeFile && fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';

if (mode === 'ok') {
  process.stdout.write(`${JSON.stringify({ received: JSON.parse(doc), ok: 1 }, null, 2)}\n`);
} else if (mode === 'cursor') {
  process.stdout.write(`${JSON.stringify({ cursor: { firstBatch: [{ _id: 1 }], id: 0, ns: `${db}.orders` }, ok: 1 }, null, 2)}\n`);
  process.stderr.write('more results exist: only the first batch is shown and the cursor was closed\n');
} else if (mode === 'error') {
  process.stderr.write('error: Unauthorized: not authorized on shop to execute command\n');
  process.exitCode = 1;
} else if (mode === 'env') {
  process.stdout.write(`${JSON.stringify(process.env)}\n`);
} else if (mode === 'password') {
  const userinfo = uri.slice(uri.indexOf('://') + 3, uri.lastIndexOf('@'));
  const password = userinfo.slice(userinfo.indexOf(':') + 1);
  process.stdout.write(`raw ${password}\n`);
  process.stderr.write(`decoded ${decodeURIComponent(password)}\n`);
} else if (mode.startsWith('repeat ') || mode.startsWith('once ')) {
  // repeat N: N times x, then the decoded password over and over, far past any limit; once N: the password once.
  const [name, count] = mode.split(' ');
  const userinfo = uri.slice(uri.indexOf('://') + 3, uri.lastIndexOf('@'));
  const decoded = decodeURIComponent(userinfo.slice(userinfo.indexOf(':') + 1));
  const tail = name === 'once' ? `${decoded}\n` : decoded.repeat(Math.ceil((4 * 262144) / decoded.length));
  process.stdout.write(`${'x'.repeat(Number(count))}${tail}`);
} else if (mode === 'tunnel' || mode === 'address') {
  // tunnel: connects to the host of the connection string (after its last @, up to the first /), sends PING for the
  // ping command and GET NAME for another, and prints the line that comes back, as the service of a tunnel test
  // answers. address: prints the address and the connection string, as and inside JSON, the way an error of the
  // driver can name them, and exits 1.
  const authority = uri.slice(uri.indexOf('://') + 3).split(/[?#]/)[0];
  const address = authority.slice(authority.lastIndexOf('@') + 1).split('/')[0];
  const at = address.lastIndexOf(':');
  if (mode === 'address') {
    process.stdout.write(`${JSON.stringify({ uri, address })}\n`);
    process.stderr.write(`error: MongoServerSelectionError: connect ECONNREFUSED ${address}; ${uri}\n`);
    process.exitCode = 1;
  } else {
    const [name] = Object.keys(JSON.parse(doc));
    const socket = net.connect({ host: address.slice(0, at), port: Number(address.slice(at + 1)) });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk;
      if (!text.includes('\n')) return;
      process.stdout.write(`${JSON.stringify({ reply: text.split('\n')[0], ok: 1 })}\n`);
      socket.destroy();
    });
    socket.on('error', (err) => {
      process.stderr.write(`error: MongoServerSelectionError: ${err.message}\n`);
      process.exitCode = 1;
    });
    socket.write(name === 'ping' ? 'PING\n' : `GET ${name}\n`);
  }
} else if (mode === 'sleep') {
  setTimeout(() => {}, 60000);
} else if (mode === 'flood') {
  const chunk = 'y'.repeat(65536);
  const write = () => {
    while (process.stdout.write(chunk));
    process.stdout.once('drain', write);
  };
  write();
}
