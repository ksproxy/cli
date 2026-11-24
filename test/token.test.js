import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { main, takeProject } from '../src/cli.js';
import { appendAudit } from '../src/audit.js';
import {
  PROJECT_DEFAULT, PROJECT_KEY, listenDir, rootStateDir, withProject,
} from '../src/paths.js';
import { liveSessions, otherInventories, usedPorts } from '../src/projects.js';
import { writeSession } from '../src/session.js';
import {
  TOKEN_DAYS, TOKEN_FILE_BYTES, TOKEN_PREFIX, USE_WRITE_MS, WARN_DAYS, checkToken, expiryWarning, newToken, noteUse,
  revokeToken, sameDigest, tokenLines, tokenPath, tokenState,
} from '../src/token.js';
import { fakeProcess, fakeSsh } from './start-helpers.js';
import { tempDir } from './temp.js';

const CONFIG_KEY = ['KSPROXY', 'CONFIG', 'DIR'].join('_');
const STATE_KEY = ['KSPROXY', 'STATE', 'DIR'].join('_');
const SSH_KEY = ['KSPROXY', 'SSH'].join('_');

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-22T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms);

const dirs = [];

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function world() {
  const base = fs.realpathSync(tempDir('ks-tok-'));
  dirs.push(base);
  const env = { ...process.env, [CONFIG_KEY]: path.join(base, 'cfg'), [STATE_KEY]: path.join(base, 'st'), [SSH_KEY]: fakeSsh };
  delete env[PROJECT_KEY];
  return {
    base, env, cfg: env[CONFIG_KEY], st: env[STATE_KEY], file: path.join(base, 'st', 'listen', 'token.json'),
  };
}

async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

const hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const modeOf = (file) => fs.statSync(file).mode & 0o777;

// A record as newToken writes it, for the token given, with some fields changed.
function recordFor(token, changes = {}) {
  return {
    version: 1,
    sha256: hex(token),
    created: T0.toISOString(),
    expires: at(TOKEN_DAYS * DAY).toISOString(),
    revoked: null,
    lastUsed: null,
    lastAddress: null,
    ...changes,
  };
}

function writeRecord(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

// One character of the token changed: the last one, to another base64url character.
const oneOff = (token) => token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');

test('the constants of the token and its folder, the same for every project', () => {
  assert.equal(TOKEN_PREFIX, 'ksp_');
  assert.equal(TOKEN_DAYS, 365);
  assert.equal(WARN_DAYS, 30);
  assert.equal(USE_WRITE_MS, 60000);
  assert.equal(PROJECT_DEFAULT, 'default');
  const env = { [STATE_KEY]: '/st' };
  assert.equal(listenDir(env), '/st/listen');
  assert.equal(listenDir(withProject(env, 'shop')), '/st/listen');
  assert.equal(listenDir(withProject(env, 'shop')), path.join(rootStateDir(env), 'listen'));
  assert.equal(tokenPath(withProject(env, 'shop')), '/st/listen/token.json');
});

test('newToken makes ksp_ and 43 base64url characters, and keeps only its digest, with modes 0600 and 0700', () => {
  const { env, file, st } = world();
  const token = newToken(env, T0);
  assert.match(token, /^ksp_[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64url').length, 32);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(token), 'the token is not in the file');
  assert.ok(!text.includes(token.slice(TOKEN_PREFIX.length)), 'nor its random part');
  assert.deepEqual(readJson(file), recordFor(token));
  assert.equal(readJson(file).expires, '2027-11-22T10:00:00.000Z');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.join(st, 'listen')), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(st, 'listen')), ['token.json'], 'no temporary file is left');
  assert.notEqual(newToken(env, T0), token, 'each token is new');
});

test('newToken without a project or with one writes the same file, and a new token replaces the old one', () => {
  const { env, file } = world();
  const first = newToken(withProject(env, 'shop'), T0);
  assert.equal(checkToken(env, first, T0), 'ok');
  fs.chmodSync(path.dirname(file), 0o755);
  fs.chmodSync(file, 0o644);
  const second = newToken(env);
  assert.equal(checkToken(env, first), 'wrong', 'the old token stops working at once');
  assert.equal(checkToken(withProject(env, 'ops'), second), 'ok');
  assert.equal(modeOf(file), 0o600);
  assert.equal(modeOf(path.dirname(file)), 0o700);
  assert.ok(Math.abs(Date.parse(readJson(file).created) - Date.now()) < 60000, 'now is the default time');
});

test('checkToken gives each of its six answers', () => {
  const { env, file } = world();
  assert.equal(checkToken(env, 'ksp_x', T0), 'unreadable', 'no file: nothing is let in');
  const token = newToken(env, T0);
  assert.equal(checkToken(env, token, T0), 'ok');
  assert.equal(checkToken(env, token, at(TOKEN_DAYS * DAY - 1)), 'ok');
  for (const absent of ['', undefined, null, 7, ['x']]) assert.equal(checkToken(env, absent, T0), 'missing', String(absent));
  assert.equal(checkToken(env, oneOff(token), T0), 'wrong');
  assert.equal(checkToken(env, token.slice(0, -1), T0), 'wrong');
  assert.equal(checkToken(env, `${token} `, T0), 'wrong');
  assert.equal(checkToken(env, token.slice(TOKEN_PREFIX.length), T0), 'wrong');
  assert.equal(checkToken(env, hex(token), T0), 'wrong', 'the digest itself is not the token');
  assert.equal(checkToken(env, token, at(TOKEN_DAYS * DAY)), 'expired');
  assert.equal(checkToken(env, oneOff(token), at(TOKEN_DAYS * DAY)), 'wrong', 'a wrong token is wrong, whatever the state');
  assert.equal(revokeToken(env, at(DAY)), 'revoked');
  assert.equal(checkToken(env, token, at(DAY)), 'revoked');
  assert.equal(checkToken(env, token, at(TOKEN_DAYS * DAY)), 'revoked', 'revoked comes before expired');
  assert.equal(checkToken(env, oneOff(token), at(DAY)), 'wrong');
  fs.writeFileSync(file, 'not json');
  assert.equal(checkToken(env, token, T0), 'unreadable');
});

test('a file that cannot be read, or that is not exactly a token record, never lets a token in', () => {
  const { env, file } = world();
  const token = 'ksp_known';
  const bad = [
    ['not JSON', 'not json'],
    ['empty', ''],
    ['null', 'null'],
    ['a list', JSON.stringify([recordFor(token)])],
    ['version 2', recordFor(token, { version: 2 })],
    ['no version', recordFor(token, { version: undefined })],
    ['a digest of 63 characters', recordFor(token, { sha256: hex(token).slice(1) })],
    ['a digest of 65 characters', recordFor(token, { sha256: `${hex(token)}0` })],
    ['a digest in capitals', recordFor(token, { sha256: hex(token).toUpperCase() })],
    ['a digest that is not hex', recordFor(token, { sha256: `${hex(token).slice(1)}g` })],
    ['a digest that is a number', recordFor(token, { sha256: 7 })],
    ['no digest', recordFor(token, { sha256: undefined })],
    ['created not a date', recordFor(token, { created: 'yesterday' })],
    ['created not in ISO form', recordFor(token, { created: 'Sun, 22 Nov 2026 10:00:00 GMT' })],
    ['expires missing', recordFor(token, { expires: undefined })],
    ['expires a number', recordFor(token, { expires: Date.parse('2099-01-01') })],
    ['revoked false', recordFor(token, { revoked: false })],
    ['revoked missing', recordFor(token, { revoked: undefined })],
    ['revoked not a date', recordFor(token, { revoked: 'yes' })],
    ['lastUsed not a date', recordFor(token, { lastUsed: 'now', lastAddress: '127.0.0.1' })],
    ['lastAddress with a space', recordFor(token, { lastUsed: T0.toISOString(), lastAddress: 'a b' })],
    ['lastAddress too long', recordFor(token, { lastUsed: T0.toISOString(), lastAddress: 'a'.repeat(65) })],
    ['lastAddress a number', recordFor(token, { lastUsed: T0.toISOString(), lastAddress: 7 })],
    ['lastUsed without lastAddress', recordFor(token, { lastUsed: T0.toISOString() })],
    ['lastAddress without lastUsed', recordFor(token, { lastAddress: '127.0.0.1' })],
  ];
  for (const [what, value] of bad) {
    writeRecord(file, value);
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(checkToken(env, token, T0), 'unreadable', what);
    assert.deepEqual(tokenState(env, T0), { state: 'unreadable', record: null }, what);
    assert.equal(revokeToken(env, T0), 'unreadable', what);
    assert.equal(noteUse(env, '127.0.0.1', T0), false, what);
    assert.equal(fs.readFileSync(file, 'utf8'), before, `${what}: the file is not changed`);
  }
  writeRecord(file, recordFor(token));
  assert.equal(checkToken(env, token, T0), 'ok', 'the same record, well formed, is ok');
  writeRecord(file, { ...recordFor(token), extra: 'kept out' });
  assert.equal(checkToken(env, token, T0), 'ok', 'a key that is not known is left out');
  assert.equal(Object.hasOwn(tokenState(env, T0).record, 'extra'), false);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.equal(checkToken(env, token, T0), 'unreadable', 'a folder in place of the file');
  assert.equal(revokeToken(env, T0), 'unreadable');
  assert.equal(noteUse(env, '127.0.0.1', T0), false);
});

test('a root state folder that is a file makes the token unreadable, not absent', () => {
  const { env, st } = world();
  fs.writeFileSync(st, 'a file');
  assert.deepEqual(tokenState(env, T0), { state: 'unreadable', record: null });
  assert.equal(checkToken(env, 'ksp_x', T0), 'unreadable');
});

test('sameDigest compares two digests of any length without throwing', () => {
  const a = crypto.createHash('sha256').update('a').digest();
  const b = crypto.createHash('sha256').update('b').digest();
  assert.equal(sameDigest(a, Buffer.from(a)), true);
  assert.equal(sameDigest(a, b), false);
  assert.equal(sameDigest(a, a.subarray(1)), false);
  assert.equal(sameDigest(Buffer.alloc(0), a), false);
});

test('tokenState gives none, ok, revoked and expired with the record', () => {
  const { env } = world();
  assert.deepEqual(tokenState(env, T0), { state: 'none', record: null });
  assert.ok(!fs.existsSync(listenDir(env)), 'reading makes no folder');
  const token = newToken(env, T0);
  assert.deepEqual(tokenState(env, T0), { state: 'ok', record: recordFor(token) });
  assert.equal(tokenState(env, at(TOKEN_DAYS * DAY)).state, 'expired');
  assert.equal(tokenState(env).state, 'ok', 'now is the default time');
  revokeToken(env, at(2 * DAY));
  assert.deepEqual(tokenState(env, at(3 * DAY)), { state: 'revoked', record: recordFor(token, { revoked: at(2 * DAY).toISOString() }) });
});

test('noteUse writes the last use at most once a minute, in place, and never throws', () => {
  const { env, file } = world();
  assert.equal(noteUse(env, '127.0.0.1', T0), false, 'no file');
  assert.ok(!fs.existsSync(file), 'no file is made');
  const token = newToken(env, T0);
  const inode = fs.statSync(file).ino;
  assert.equal(noteUse(env, '192.0.2.10', at(1000)), true);
  assert.deepEqual(readJson(file), recordFor(token, { lastUsed: at(1000).toISOString(), lastAddress: '192.0.2.10' }));
  assert.equal(noteUse(env, '192.0.2.11', at(1000 + USE_WRITE_MS - 1)), false, 'within a minute');
  assert.equal(readJson(file).lastAddress, '192.0.2.10');
  assert.equal(noteUse(env, '192.0.2.11', at(1000 + USE_WRITE_MS)), true, 'a minute later');
  assert.equal(readJson(file).lastAddress, '192.0.2.11');
  assert.equal(fs.statSync(file).ino, inode, 'written in place, in the file it read');
  assert.equal(modeOf(file), 0o600);
  // A shorter text leaves spaces at the end of the file, which JSON allows.
  assert.equal(noteUse(env, '::1', at(10 * USE_WRITE_MS)), true);
  assert.match(fs.readFileSync(file, 'utf8'), /}\n +$/);
  assert.equal(tokenState(env, at(10 * USE_WRITE_MS)).record.lastAddress, '::1');
  assert.equal(checkToken(env, token, at(10 * USE_WRITE_MS)), 'ok');
  // A clock moved back by more than a minute writes again.
  assert.equal(noteUse(env, '192.0.2.12', at(5 * USE_WRITE_MS)), true);
  assert.equal(readJson(file).lastUsed, at(5 * USE_WRITE_MS).toISOString());
  assert.equal(noteUse(env, '192.0.2.13'), true, 'now is the default time');
});

test('noteUse writes unknown for an address that is not a short printable text', () => {
  const { env, file } = world();
  newToken(env, T0);
  const cases = [undefined, null, '', 'a b', 'a'.repeat(65), 'café', 'x\ny', 42];
  cases.forEach((address, i) => {
    assert.equal(noteUse(env, address, at(i * USE_WRITE_MS)), true, String(address));
    assert.equal(readJson(file).lastAddress, 'unknown', String(address));
  });
  assert.equal(noteUse(env, `fe80::1%en0${'a'.repeat(53)}`, at(100 * USE_WRITE_MS)), true);
  assert.equal(readJson(file).lastAddress.length, 64);
});

test('a revoke replaces the file, so a later note of use, which writes in the file it opened, cannot undo it', () => {
  const { env, file } = world();
  const token = newToken(env, T0);
  const opened = fs.openSync(file, 'r');
  try {
    assert.equal(revokeToken(env, at(DAY)), 'revoked');
    assert.notEqual(fs.fstatSync(opened).ino, fs.statSync(file).ino, 'the revoke wrote a new file');
    assert.equal(fs.fstatSync(opened).nlink, 0, 'the file a note of use had opened is no longer the token file');
  } finally {
    fs.closeSync(opened);
  }
  assert.equal(noteUse(env, '192.0.2.10', at(DAY + 1)), true);
  assert.equal(checkToken(env, token, at(DAY + 2)), 'revoked');
  assert.equal(readJson(file).revoked, at(DAY).toISOString());
});

test('revokeToken: none, revoked, already', () => {
  const { env, file } = world();
  assert.equal(revokeToken(env, T0), 'none');
  assert.ok(!fs.existsSync(listenDir(env)), 'nothing is made');
  const token = newToken(env, T0);
  noteUse(env, '192.0.2.10', at(1000));
  assert.equal(revokeToken(env, at(DAY)), 'revoked');
  assert.deepEqual(readJson(file), recordFor(token, { revoked: at(DAY).toISOString(), lastUsed: at(1000).toISOString(), lastAddress: '192.0.2.10' }));
  assert.equal(modeOf(file), 0o600);
  assert.equal(revokeToken(env, at(2 * DAY)), 'already');
  assert.equal(readJson(file).revoked, at(DAY).toISOString(), 'the first date stays');
  newToken(env, T0);
  assert.equal(revokeToken(env, at(TOKEN_DAYS * DAY + DAY)), 'revoked', 'an expired token can be revoked');
  newToken(env, T0);
  assert.equal(revokeToken(env), 'revoked', 'now is the default time');
});

test('tokenLines for each state, never with the token', () => {
  const { env } = world();
  const token = newToken(env, T0);
  const lines = (now) => tokenLines(tokenState(env, now).record, now);
  assert.deepEqual(lines(T0), ['created 2026-11-22', 'expires 2027-11-22', 'revoked no', 'last used never']);
  noteUse(env, '192.0.2.10', at(2 * DAY));
  assert.deepEqual(lines(at(3 * DAY)), ['created 2026-11-22', 'expires 2027-11-22', 'revoked no', 'last used 2026-11-24 from 192.0.2.10']);
  assert.deepEqual(lines(at(TOKEN_DAYS * DAY)), ['created 2026-11-22', 'expired 2027-11-22', 'revoked no', 'last used 2026-11-24 from 192.0.2.10']);
  revokeToken(env, at(4 * DAY));
  assert.deepEqual(lines(at(5 * DAY)), ['created 2026-11-22', 'expires 2027-11-22', 'revoked 2026-11-26', 'last used 2026-11-24 from 192.0.2.10']);
  const all = [T0, at(5 * DAY), at(TOKEN_DAYS * DAY)].flatMap(lines).join('\n');
  assert.ok(!all.includes(token) && !all.includes(hex(token)));
  assert.equal(tokenLines(tokenState(env).record).length, 4, 'now is the default time');
});

test('expiryWarning in the last 30 days only, and not for a revoked or expired token', () => {
  const { env } = world();
  newToken(env, T0);
  const { record } = tokenState(env, T0);
  const left = (ms) => at(TOKEN_DAYS * DAY - ms);
  const text = 'the token expires on 2027-11-22; type new-token to replace it';
  assert.equal(expiryWarning(record, left(31 * DAY)), null);
  assert.equal(expiryWarning(record, left(30 * DAY + 1)), null);
  assert.equal(expiryWarning(record, left(30 * DAY)), text);
  assert.equal(expiryWarning(record, left(1000)), text);
  assert.equal(expiryWarning(record, left(0)), null, 'expired at that moment');
  assert.equal(expiryWarning(record, left(-DAY)), null);
  assert.equal(expiryWarning(record), null, 'now is the default time');
  assert.equal(expiryWarning({ ...record, revoked: T0.toISOString() }, left(DAY)), null);
});

test('ksproxy token prints the dates, never the token, and says when there is none', async () => {
  const { env, st } = world();
  let r = await cli(['token'], env);
  assert.deepEqual(r, { code: 0, stdout: 'no token yet: start with --listen to make one\n', stderr: '' });
  assert.ok(!fs.existsSync(path.join(st, 'listen')), 'nothing is made');
  const now = new Date();
  const token = newToken(env, now);
  r = await cli(['token'], env);
  assert.equal(r.code, 0);
  const day = (d) => d.toISOString().slice(0, 10);
  assert.equal(r.stdout, `created ${day(now)}\nexpires ${day(new Date(now.getTime() + TOKEN_DAYS * DAY))}\nrevoked no\nlast used never\n`);
  assert.ok(!r.stdout.includes(token));
  // The token is the same for every project: an inherited project variable changes nothing.
  r = await cli(['token'], { ...env, [PROJECT_KEY]: 'shop' });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^created /);
});

test('ksproxy token revoke: revoked, already, none, from any terminal', async () => {
  const { env } = world();
  const hint = 'make a new one with new-token in the start terminal, or start with --new-token';
  let r = await cli(['token', 'revoke'], env);
  assert.deepEqual(r, { code: 0, stdout: 'there is no token\n', stderr: '' });
  const token = newToken(env);
  r = await cli(['token', 'revoke'], env);
  assert.deepEqual(r, { code: 0, stdout: `the token is revoked; ${hint}\n`, stderr: '' });
  assert.equal(checkToken(env, token), 'revoked');
  r = await cli(['token', 'revoke'], env);
  assert.deepEqual(r, { code: 0, stdout: `the token was already revoked; ${hint}\n`, stderr: '' });
  r = await cli(['token'], env);
  assert.match(r.stdout, /\nrevoked \d{4}-\d\d-\d\d\n/);
});

test('ksproxy token and token revoke with a file that cannot be read say so and exit 1', async () => {
  const { env, file } = world();
  writeRecord(file, 'not json');
  const text = `cannot read ${file}: no request is let in while it cannot be read; start with --new-token to replace it\n`;
  for (const args of [['token'], ['token', 'revoke']]) {
    const r = await cli(args, env);
    assert.deepEqual(r, { code: 1, stdout: '', stderr: text }, args.join(' '));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('any other word after token, and --project, is a usage error', async () => {
  const { env, st } = world();
  const message = 'usage: ksproxy token [revoke]; the token serves every project, so it takes no --project';
  for (const args of [['token', 'new'], ['token', 'revoke', 'now'], ['token', '--project', 'shop'], ['token', '--project=default'],
    ['token', 'revoke', '--project', 'shop'], ['token', '--help'], ['token', 'Revoke']]) {
    const r = await cli(args, env);
    assert.equal(r.code, 2, args.join(' '));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.startsWith(`${message}\nUsage: ksproxy <command>`), r.stderr);
  }
  assert.ok(!fs.existsSync(st), 'nothing was read or written');
});

test('the usage lists the two token commands and the name default', async () => {
  const { env } = world();
  const r = await cli(['--help'], env);
  assert.match(r.stdout, /\n {2}token {37}show when the network token was made, expires and was last used\n/);
  assert.match(r.stdout, /\n {2}token revoke {30}revoke the network token at once\n/);
  assert.match(r.stdout, /\n {2}--project NAME {28}use the project NAME \(projects\/NAME\.json\), or default \(inventory\.json\)\n/);
});

test('takeProject takes the name default as no project, and still refuses the flag twice', () => {
  assert.deepEqual(takeProject(['--project', 'default']), { project: null, rest: [] });
  assert.deepEqual(takeProject(['--all', '--project=default', '-v']), { project: null, rest: ['--all', '-v'] });
  assert.deepEqual(takeProject(['--project', 'default', 'ssh', 'web1', 'uptime'], { beforeKind: true }), { project: null, rest: ['ssh', 'web1', 'uptime'] });
  assert.deepEqual(takeProject(['--project', 'default', '--project', 'shop']), { error: '--project given twice' });
  assert.deepEqual(takeProject(['--project=default', '--project=default']), { error: '--project given twice' });
  assert.deepEqual(takeProject(['--project', 'shop', '--project', 'default']), { error: '--project given twice' });
  assert.deepEqual(takeProject(['--project', 'defaults']), { project: 'defaults', rest: [] });
});

const inventoryOf = (name) => ({ ssh: [{ name, host: `${name}.example.com`, allow: ['uptime'] }] });

function writeInventory(file, inventory) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(inventory));
}

test('init --project default writes inventory.json, never projects/default.json', async () => {
  const { env, cfg } = world();
  const r = await cli(['init', '--project', 'default'], env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `wrote ${path.join(cfg, 'inventory.json')} — edit it, then run: ksproxy start\n`);
  assert.ok(!fs.existsSync(path.join(cfg, 'projects')));
  const again = await cli(['init', '--project=default'], env);
  assert.equal(again.stdout, `already exists: ${path.join(cfg, 'inventory.json')}\n`);
});

test('check --project default reads inventory.json, and is refused while projects/default.json exists', async () => {
  const { env, cfg } = world();
  writeInventory(path.join(cfg, 'inventory.json'), inventoryOf('web1'));
  let r = await cli(['check', '--project', 'default', 'ssh', 'web1', 'uptime'], env);
  assert.deepEqual(r, { code: 0, stdout: 'ALLOWED by rule: uptime\n', stderr: '' });
  writeInventory(path.join(cfg, 'projects', 'default.json'), inventoryOf('other'));
  r = await cli(['check', '--project=default', 'ssh', 'other', 'uptime'], env);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^--project default now means inventory.json, but an old project named default is still here/);
  fs.rmSync(path.join(cfg, 'projects', 'default.json'));
  fs.rmSync(path.join(cfg, 'inventory.json'));
  r = await cli(['check', '--project', 'default', 'ssh', 'web1', 'uptime'], env);
  assert.equal(r.stderr, `inventory not found: ${path.join(cfg, 'inventory.json')}; run: ksproxy init\n`);
});

test('status --project default is status without a project: every live session', async () => {
  const { env, st } = world();
  let r = await cli(['status', '--project', 'default'], env);
  assert.deepEqual(r, { code: 1, stdout: 'no session — run: ksproxy start\n', stderr: '' });
  const live = (dir, startedAt, name) => {
    const sockets = path.join(path.dirname(dir), 's');
    writeSession(dir, {
      version: 1, pid: process.pid, startedAt, targets: [{ kind: 'ssh', name, host: 'h', socket: path.join(sockets, `ssh-${name}`), allow: [], state: 'up' }],
    });
    fs.mkdirSync(sockets, { recursive: true });
    fs.writeFileSync(path.join(sockets, `ssh-${name}`), '');
  };
  live(path.join(st, 'session'), 'd', 'web0');
  live(path.join(st, 'p', 'shop', 'session'), 's', 'web2');
  r = await cli(['status', '--project=default'], env);
  assert.deepEqual(r, {
    code: 0,
    stdout: `session pid ${process.pid}, started d\n  up    ssh   web0\nproject shop: session pid ${process.pid}, started s\n  up    ssh   web2\n`,
    stderr: '',
  });
  assert.deepEqual(await cli(['status'], env), r);
});

test('log --project default reads the default log folder, and is refused while p/default exists', async () => {
  const { env, st } = world();
  const entry = (command) => ({
    event: 'call', tool: 'ssh_exec', kind: 'ssh', target: 'web1', command, decision: 'allowed', rule: command, exitCode: 0,
  });
  for (const [dir, command] of [[path.join(st, 'logs'), 'df-default']]) {
    fs.mkdirSync(dir, { recursive: true });
    appendAudit(path.join(dir, 'audit.log'), entry(command));
  }
  const r = await cli(['log', '--project', 'default'], env);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /df-default/);
  assert.deepEqual(await cli(['log'], env), r);
  fs.mkdirSync(path.join(st, 'p', 'default', 'logs'), { recursive: true });
  assert.equal((await cli(['log', '--project', 'default'], env)).code, 2);
});

test('the other inventories still read projects/default.json, for its secret files and its ports, for every command', () => {
  const { env, cfg } = world();
  const old = path.join(cfg, 'projects', 'default.json');
  writeInventory(path.join(cfg, 'inventory.json'), inventoryOf('web0'));
  writeInventory(path.join(cfg, 'projects', 'ops.json'), {
    kubernetes: [{ name: 'lab', kubeconfig: '/k/lab.yaml', context: 'lab', proxyPort: 8011, allow: ['get ...'] }],
  });
  fs.writeFileSync(old, 'not json');
  const shop = withProject(env, 'shop');
  assert.deepEqual(otherInventories(shop), {
    others: [{ where: 'the default inventory', raw: inventoryOf('web0') }], unreadable: old,
  }, 'a file that cannot be read keeps every local target closed, as any other file');
  writeInventory(old, {
    kubernetes: [{ name: 'old', kubeconfig: '/k/old.yaml', context: 'old', proxyPort: 8012, allow: ['get ...'] }],
  });
  for (const own of [shop, env, withProject(env, 'default')]) {
    const inventories = otherInventories(own);
    assert.equal(inventories.unreadable, null);
    assert.ok(inventories.others.some(({ where }) => where === 'projects/default.json'));
    const { used } = usedPorts(own);
    assert.equal(used.get(8012), 'projects/default.json');
  }
  assert.equal(usedPorts(shop).used.get(8011), 'project ops');
  assert.deepEqual(otherInventories(env).others.map(({ where }) => where), ['projects/default.json', 'project ops']);
});

test('a session folder p/default is never a project: the default session is listed once', () => {
  const { env, st } = world();
  const live = (dir, name) => writeSession(dir, {
    version: 1, pid: process.pid, startedAt: 't', targets: [{ kind: 'ssh', name, host: 'h', allow: [], state: 'up' }],
  });
  live(path.join(st, 'session'), 'web0');
  live(path.join(st, 'p', 'default', 'session'), 'web9');
  live(path.join(st, 'p', 'shop', 'session'), 'web2');
  assert.deepEqual(liveSessions(env).map(({ project, session }) => [project, session.targets[0].name]), [[null, 'web0'], ['shop', 'web2']]);
});

// --- The size of token.json never changes once it is made, and a revoke never undoes a new token ---

const sizeOf = (file) => fs.statSync(file).size;

test('every write of token.json gives exactly TOKEN_FILE_BYTES bytes, and a note of use never changes the size', () => {
  const { env, file } = world();
  assert.equal(TOKEN_FILE_BYTES, 512);
  const token = newToken(env, T0);
  assert.equal(sizeOf(file), 512);
  assert.match(fs.readFileSync(file, 'utf8'), /^\{\n {2}"version": 1,\n[^]*\n\}\n +$/, 'the JSON, then spaces, which JSON allows');
  for (const [i, address] of ['192.0.2.10', `fe80::1%en0${'a'.repeat(53)}`, '::1', undefined].entries()) {
    assert.equal(noteUse(env, address, at((i + 1) * USE_WRITE_MS)), true);
    assert.equal(sizeOf(file), 512, String(address));
  }
  assert.equal(revokeToken(env, at(DAY)), 'revoked');
  assert.equal(sizeOf(file), 512);
  assert.deepEqual(readJson(file), recordFor(token, { revoked: at(DAY).toISOString(), lastUsed: at(4 * USE_WRITE_MS).toISOString(), lastAddress: 'unknown' }));
});

test('the largest record there can be fits in TOKEN_FILE_BYTES: times of 27 characters and 64 characters that JSON escapes', () => {
  const { env, file } = world();
  const last = new Date(8.64e15);
  const token = newToken(env, new Date(last.getTime() - TOKEN_DAYS * DAY));
  const address = '"\\'.repeat(32);
  assert.equal(address.length, 64);
  assert.equal(noteUse(env, address, last), true);
  assert.equal(revokeToken(env, last), 'revoked');
  const record = recordFor(token, {
    created: new Date(last.getTime() - TOKEN_DAYS * DAY).toISOString(),
    expires: last.toISOString(),
    revoked: last.toISOString(),
    lastUsed: last.toISOString(),
    lastAddress: address,
  });
  assert.equal(last.toISOString(), '+275760-09-13T00:00:00.000Z');
  assert.equal(new Date(-8.64e15).toISOString().length, 27, 'the earliest time is as long');
  assert.equal(record.created.length, 27);
  assert.deepEqual(readJson(file), record);
  const needed = Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
  assert.ok(needed <= TOKEN_FILE_BYTES, `the largest record needs ${needed} bytes`);
  assert.equal(sizeOf(file), TOKEN_FILE_BYTES);
});

test('noteUse writes exactly the length of the file it read, and nothing when the record would not fit in it', () => {
  const { env, file } = world();
  const token = 'ksp_known';
  // A file of another length, such as one written by hand: the size stays.
  writeRecord(file, `${JSON.stringify(recordFor(token), null, 2)}\n${' '.repeat(600)}`);
  const size = sizeOf(file);
  assert.equal(noteUse(env, '192.0.2.10', T0), true);
  assert.equal(sizeOf(file), size);
  assert.equal(readJson(file).lastAddress, '192.0.2.10');
  // A text of the record with no room for the last use: nothing is written.
  writeRecord(file, recordFor(token));
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(noteUse(env, '192.0.2.10', T0), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(checkToken(env, token, T0), 'ok');
});

// Calls make right after each read of token.json that works, with the number of that read, from 1, as another process
// would act between two steps of revokeToken. Gives the function that puts readFileSync back and gives the count.
function onTokenReads(file, make) {
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function patched(...args) {
    if (args[0] !== file) return real.apply(this, args);
    reads += 1;
    const text = real.apply(this, args);
    make(reads);
    return text;
  };
  return () => {
    fs.readFileSync = real;
    return reads;
  };
}

test('revokeToken reads the file again just before its rename, and starts over when a new token came in between', () => {
  const { env, file } = world();
  const first = newToken(env, T0);
  let second = null;
  const done = onTokenReads(file, (read) => {
    if (read === 1) second = newToken(env, at(1000));
  });
  let result;
  try {
    result = revokeToken(env, at(DAY));
  } finally {
    assert.equal(done(), 4, 'two tries, each with its read and the read before the rename');
  }
  assert.equal(result, 'revoked');
  assert.equal(checkToken(env, second, at(DAY)), 'revoked', 'the new token is the one revoked');
  assert.equal(checkToken(env, first, at(DAY)), 'wrong');
  assert.deepEqual(readJson(file), recordFor(second, { created: at(1000).toISOString(), expires: at(1000 + TOKEN_DAYS * DAY).toISOString(), revoked: at(DAY).toISOString() }));
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['token.json'], 'no temporary file is left');
});

test('revokeToken starts over when the file goes between its read and its rename, and then finds no token', () => {
  const { env, file } = world();
  newToken(env, T0);
  const done = onTokenReads(file, (read) => {
    if (read === 1) fs.rmSync(file);
  });
  try {
    assert.equal(revokeToken(env, at(DAY)), 'none');
  } finally {
    assert.equal(done(), 3);
  }
  assert.deepEqual(fs.readdirSync(path.dirname(file)), []);
});

test('revokeToken tries three times; the third revokes the record it read, so a token made after that read fails closed', () => {
  const { env, file } = world();
  const tokens = [newToken(env, T0)];
  const done = onTokenReads(file, (read) => {
    if (read % 2 === 1) tokens.push(newToken(env, at(read * 1000)));
  });
  let result;
  try {
    result = revokeToken(env, at(DAY));
  } finally {
    assert.equal(done(), 5, 'three reads, and a read before the rename on the first two tries only');
  }
  assert.equal(result, 'revoked');
  assert.equal(tokens.length, 4);
  assert.equal(readJson(file).sha256, hex(tokens[2]), 'the record of the third read');
  assert.equal(readJson(file).revoked, at(DAY).toISOString());
  assert.deepEqual(tokens.map((token) => checkToken(env, token, at(DAY))), ['wrong', 'wrong', 'revoked', 'wrong'], 'no token lets a request in');
  assert.equal(sizeOf(file), TOKEN_FILE_BYTES);
});
