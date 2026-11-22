import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerCall } from '../src/tools.js';
import { kindByKey } from '../src/kinds/index.js';
import { escapeText } from '../src/kinds/engines/resp.js';
import { respServer } from './fixtures/resp-server.js';
import { tempDir } from './temp.js';

// The forms of a secret that a kind sends or a service shows (the base64 credential of basic auth, the escaped redis
// password, the decoded mongodb password) are hidden by the core before any cut, so a piece of one is never shown.

const VISIBLE = 262144;
const NOTE = '[output truncated at 262144 bytes per stream]';
const STEP = 4;
// How many bytes of a form come before the visible limit: with fewer than 10, [hidden] itself crosses the limit and is cut.
const INTO = [1, 5, 10, 20, 30];

const root = fs.realpathSync(tempDir('ks-forms-', os.tmpdir()));
fs.mkdirSync(path.join(root, 'st', 'logs'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'cfg'), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'home'),
  [['KSPROXY', 'STATE', 'DIR'].join('_')]: path.join(root, 'st'),
  [['KSPROXY', 'CONFIG', 'DIR'].join('_')]: path.join(root, 'cfg'),
};

const servers = [];
after(async () => {
  for (const server of servers) await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function call(kind, target, secrets, input) {
  return answerCall({
    kind, name: target.name, input, timeoutSeconds: 30,
  }, {
    calls: new Map([[`${kind}:${target.name}`, { target, secrets }]]),
    session: { targets: [target] },
    env,
    signal: new AbortController().signal,
    review: async () => null,
    stderr: process.stderr,
  });
}

function stdoutOf(text) {
  const from = text.indexOf('--- stdout ---\n') + 15;
  const ends = [text.indexOf('\n--- stderr ---'), text.indexOf(`\n${NOTE}`)].filter((at) => at !== -1);
  return text.slice(from, ends.length === 0 ? text.length : Math.min(...ends));
}

// No piece of the form of four characters or more is shown, the whole form included.
function assertNoPiece(text, form, what) {
  for (let n = 4; n <= form.length; n += 1) assert.ok(!text.includes(form.slice(0, n)), `${what}: the first ${n} characters of the form are shown`);
}

function auditText() {
  const file = path.join(root, 'st', 'logs', 'audit.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

describeHttp();
describeRedis();
describeMongo();

function describeHttp() {
  const USER = 'forms-user-UNMISTAKABLE';
  const PASSWORD = 'forms-pass-UNMISTAKABLE-41c9';
  const BASIC = Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
  const HEAD = 'HTTP 200\ncontent-type: text/plain\n\n';
  let base;

  before(async () => {
    // GET /many?lead=N: N times x, then the Authorization header and a newline, over and over, far past any limit.
    // GET /once?lead=N: N times x, then the Authorization header once.
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const lead = 'x'.repeat(Number(url.searchParams.get('lead')));
      const line = `${req.headers.authorization}\n`;
      res.on('error', () => {});
      res.writeHead(200, { 'content-type': 'text/plain' });
      if (url.pathname === '/once') {
        res.end(lead + line);
        return;
      }
      res.end(lead + line.repeat(Math.ceil((4 * VISIBLE) / line.length)));
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    servers.push({ close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) });
    base = `http://127.0.0.1:${server.address().port}/`;
  });

  const target = () => ({
    kind: 'http',
    name: 'echo',
    description: '',
    allow: ['GET /many', 'GET /once'],
    baseUrl: base,
    auth: { basicUserEnv: 'FORMS_USER', basicPasswordEnv: 'FORMS_PASSWORD' },
    state: 'up',
  });
  const secrets = { FORMS_USER: USER, FORMS_PASSWORD: PASSWORD };

  test('http: the base64 credential that the read limit cuts is never shown in part', async () => {
    const unit = `Basic ${BASIC}\n`.length;
    for (let lead = 0; lead < unit; lead += STEP) {
      const answer = await call('http', target(), secrets, { method: 'GET', path: '/many', query: { lead } });
      assertNoPiece(answer.text, BASIC, `lead ${lead}`);
      assert.ok(answer.text.endsWith(NOTE), `lead ${lead}`);
      assert.ok(stdoutOf(answer.text).startsWith(`${HEAD}${'x'.repeat(lead)}Basic [hidden]\n`), `lead ${lead}`);
    }
    assertNoPiece(auditText(), BASIC, 'the audit log');
  });

  test('http: the base64 credential that crosses the visible limit is hidden whole before the cut', async () => {
    for (const into of INTO) {
      const lead = VISIBLE - HEAD.length - 'Basic '.length - into;
      const answer = await call('http', target(), secrets, { method: 'GET', path: '/once', query: { lead } });
      assertNoPiece(answer.text, BASIC, `${into} bytes in`);
      assert.ok(answer.text.endsWith(into < 10 ? NOTE : 'xBasic [hidden]'), `${into} bytes in`);
    }
  });
}

function describeRedis() {
  const PASSWORD = 'pw\u0001\u0002-R3D1S-forms\u0003-UNMISTAKABLE';
  const ESCAPED = escapeText(PASSWORD);
  let server;

  before(async () => {
    // GET many: an array of the password, long enough that its formatted lines pass the read limit.
    // GET once N: an array of N times x and then the password.
    server = await respServer((words) => {
      if (words[0] === 'AUTH') return '+OK\r\n';
      const bulk = (text) => `$${Buffer.byteLength(text)}\r\n${text}\r\n`;
      if (words[1] === 'many') {
        const count = 7000;
        return `*${count}\r\n${bulk(PASSWORD).repeat(count)}`;
      }
      return `*2\r\n${bulk('x'.repeat(Number(words[2])))}${bulk(PASSWORD)}`;
    });
    servers.push(server);
  });

  const target = () => ({
    kind: 'redis',
    name: 'cache',
    description: '',
    allow: ['GET ...'],
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    db: 0,
    userEnv: null,
    passwordEnv: 'FORMS_REDIS_PASSWORD',
    state: 'up',
  });
  const secrets = { FORMS_REDIS_PASSWORD: PASSWORD };

  test('redis: a reply over the read limit gives the same answer whatever the length of the password', async () => {
    const big = await respServer((words) => (words[0] === 'AUTH' ? '+OK\r\n' : `$400000\r\n${'x'.repeat(400000)}\r\n`));
    servers.push(big);
    const answers = [];
    for (const password of ['short-pw-123', `long-${'p'.repeat(4000)}`]) {
      answers.push(await call('redis', { ...target(), port: big.port }, { FORMS_REDIS_PASSWORD: password }, 'GET big'));
    }
    assert.equal(answers[0].text, answers[1].text);
    assert.equal(answers[0].text, 'exit code: 1\n--- stderr ---\nthe reply is larger than the output limit and was cut off\n[output truncated at 262144 bytes per stream]');
  });

  test('redis: the escaped password past the read limit or across the visible limit is never shown in part', async () => {
    const many = await call('redis', target(), secrets, 'GET many');
    assertNoPiece(many.text, ESCAPED, 'many');
    assert.ok(many.text.endsWith(NOTE));
    assert.ok(stdoutOf(many.text).startsWith('   1) "[hidden]"\n'), stdoutOf(many.text).slice(0, 40));
    for (const into of INTO) {
      // The line of the password starts after 1) "x...x" and a newline and 2) and a quote: 10 bytes more than the x.
      const answer = await call('redis', target(), secrets, `GET once ${VISIBLE - 10 - into}`);
      assertNoPiece(answer.text, ESCAPED, `${into} bytes in`);
      assert.ok(answer.text.endsWith(into < 10 ? NOTE : 'x"\n2) "[hidden]"'), `${into} bytes in`);
    }
    assertNoPiece(auditText(), ESCAPED, 'the audit log');
  });
}

function describeMongo() {
  const fake = fileURLToPath(new URL('./fixtures/fake-mongosh.js', import.meta.url));
  const PASSWORD = 'Pa55%2Fw0rd-FORMS-UNMISTAKABLE-7f3e';
  const DECODED = 'Pa55/w0rd-FORMS-UNMISTAKABLE-7f3e';
  const URI = `mongodb://report-user:${PASSWORD}@db1.example.com:27017/?authSource=admin`;
  const modeFile = path.join(root, 'mongosh.mode');
  const program = path.join(root, 'mongosh-wrapper');
  fs.writeFileSync(program, [
    '#!/bin/sh',
    `export FAKE_MONGOSH_MODE_FILE='${modeFile}'`,
    `exec '${process.execPath}' '${fake}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  const target = {
    kind: 'mongodb',
    name: 'orders',
    description: '',
    allow: ['ping'],
    database: 'shop',
    uriEnv: 'FORMS_MONGO_URI',
    writes: false,
    joins: false,
    program,
    state: 'up',
  };
  const secrets = { FORMS_MONGO_URI: URI };

  test('mongodb: the decoded password past the read limit or across the visible limit is never shown in part', async () => {
    for (let lead = 0; lead < DECODED.length; lead += STEP) {
      fs.writeFileSync(modeFile, `repeat ${lead}`);
      const answer = await call('mongodb', target, secrets, { command: { ping: 1 } });
      assertNoPiece(answer.text, DECODED, `lead ${lead}`);
      assert.ok(answer.text.endsWith(NOTE), `lead ${lead}`);
      assert.ok(stdoutOf(answer.text).startsWith(`${'x'.repeat(lead)}[hidden][hidden]`), `lead ${lead}`);
    }
    for (const into of INTO) {
      fs.writeFileSync(modeFile, `once ${VISIBLE - into}`);
      const answer = await call('mongodb', target, secrets, { command: { ping: 1 } });
      assertNoPiece(answer.text, DECODED, `${into} bytes in`);
      assert.ok(answer.text.endsWith(into < 10 ? NOTE : 'x[hidden]'), `${into} bytes in`);
    }
    assertNoPiece(auditText(), DECODED, 'the audit log');
  });
}
