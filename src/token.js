import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isObject } from './checks.js';
import { ensureDir, listenDir, writeFileAtomic } from './paths.js';

// The global token of the network listener: one for every project. Only its SHA-256 is kept, in token.json; the token
// itself is given back once, by newToken, and is never written to a file, a log or a message here.

export const TOKEN_PREFIX = 'ksp_';
export const TOKEN_DAYS = 365;
export const WARN_DAYS = 30;
export const USE_WRITE_MS = 60000;
// The size of token.json, always: every write pads the text with spaces to it, so a reader in another process never
// sees the file grow or shrink, and so never reads a cut text. The largest record there can be needs fewer bytes.
export const TOKEN_FILE_BYTES = 512;

const TOKEN_BYTES = 32;
// How many times revokeToken reads the file and tries again when a new token came in between.
const REVOKE_TRIES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// A client address as the file keeps it: 1 to 64 printable ASCII characters, no space.
const ADDRESS_RE = /^[\x21-\x7e]{1,64}$/;
const UNKNOWN_ADDRESS = 'unknown';

export function tokenPath(env) {
  return path.join(listenDir(env), 'token.json');
}

const digestOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

// The day of a time kept in the file, as YYYY-MM-DD in UTC.
const dayOf = (time) => time.slice(0, 10);

// The text of a record: JSON with two spaces and a new line, then spaces up to bytes, which JSON allows. Every field is
// ASCII, so its length in characters is its length in bytes.
const textOf = (record, bytes = TOKEN_FILE_BYTES) => `${JSON.stringify(record, null, 2)}\n`.padEnd(bytes);

// A time exactly as toISOString writes it.
const isTime = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;

const isAddress = (value) => typeof value === 'string' && ADDRESS_RE.test(value);

// The record in the text of token.json, with only the keys it knows, or null when the text is not exactly one: a
// digest of 64 lower-case hex characters, the times as toISOString writes them, and lastUsed with lastAddress both
// null or both set.
function parseRecord(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || raw.version !== 1 || typeof raw.sha256 !== 'string' || !DIGEST_RE.test(raw.sha256)) return null;
  if (!isTime(raw.created) || !isTime(raw.expires) || !(raw.revoked === null || isTime(raw.revoked))) return null;
  const neverUsed = raw.lastUsed === null && raw.lastAddress === null;
  if (!neverUsed && !(isTime(raw.lastUsed) && isAddress(raw.lastAddress))) return null;
  return {
    version: 1,
    sha256: raw.sha256,
    created: raw.created,
    expires: raw.expires,
    revoked: raw.revoked,
    lastUsed: raw.lastUsed,
    lastAddress: raw.lastAddress,
  };
}

// The record of token.json, 'none' when there is no file, or 'unreadable' when it cannot be read or is not a record.
function readRecord(env) {
  let text;
  try {
    text = fs.readFileSync(tokenPath(env), 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? 'none' : 'unreadable';
  }
  return parseRecord(text) ?? 'unreadable';
}

// Writes a new file at token.json, of TOKEN_FILE_BYTES bytes. keep is asked just before the rename; false leaves the
// file as it was, and the result is false.
function writeRecord(env, record, keep) {
  ensureDir(listenDir(env));
  return writeFileAtomic(tokenPath(env), textOf(record), keep);
}

// Makes a new token, which replaces the one before at once, and gives it back. Only its digest is written.
export function newToken(env, now = new Date()) {
  const token = `${TOKEN_PREFIX}${crypto.randomBytes(TOKEN_BYTES).toString('base64url')}`;
  writeRecord(env, {
    version: 1,
    sha256: digestOf(token).toString('hex'),
    created: now.toISOString(),
    expires: new Date(now.getTime() + TOKEN_DAYS * DAY_MS).toISOString(),
    revoked: null,
    lastUsed: null,
    lastAddress: null,
  });
  return token;
}

// The state of the token now, with its record when the file holds one. A revoked token is revoked even once expired.
export function tokenState(env, now = new Date()) {
  const record = readRecord(env);
  if (typeof record === 'string') return { state: record, record: null };
  if (record.revoked !== null) return { state: 'revoked', record };
  if (now.getTime() >= Date.parse(record.expires)) return { state: 'expired', record };
  return { state: 'ok', record };
}

// Whether two digests are the same, compared in constant time. timingSafeEqual throws on buffers of different
// lengths, so the lengths are compared first.
export function sameDigest(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// What the listener does with the text after "Bearer ": only ok lets the request in. The file is read on every call,
// so a revoke or a new token from any process counts at once. No file, or one that cannot be read or is not a record,
// is unreadable. A wrong token is wrong whatever the state of the file, so only the holder of the token learns that it
// was revoked or expired.
export function checkToken(env, presented, now = new Date()) {
  if (typeof presented !== 'string' || presented === '') return 'missing';
  const { state, record } = tokenState(env, now);
  if (record === null) return 'unreadable';
  if (!sameDigest(digestOf(presented), Buffer.from(record.sha256, 'hex'))) return 'wrong';
  return state;
}

// Writes when and from where the token was last used, at most once per USE_WRITE_MS, and never throws. It writes in
// place, into the file it opened and read, and never through a new file: a revoke or a new token from another process
// puts a new file at token.json, so a write that comes after it lands in the old file, which is no longer token.json,
// and can never undo it. The new text is padded with spaces to exactly the length of the old one, which JSON allows, so
// no old character is left after it and the size of the file never changes; a text that would not fit is not written.
export function noteUse(env, address, now = new Date()) {
  let fd = null;
  let written = false;
  try {
    fd = fs.openSync(tokenPath(env), 'r+');
    const old = fs.readFileSync(fd);
    const record = parseRecord(old.toString('utf8'));
    const recent = record !== null && record.lastUsed !== null
      && Math.abs(now.getTime() - Date.parse(record.lastUsed)) < USE_WRITE_MS;
    if (record !== null && !recent) {
      const lastAddress = isAddress(address) ? address : UNKNOWN_ADDRESS;
      const text = textOf({ ...record, lastUsed: now.toISOString(), lastAddress }, old.length);
      if (text.length === old.length) {
        fs.writeSync(fd, text, 0);
        written = true;
      }
    }
  } catch {
    // No file, or one that cannot be opened or read: the use is not written.
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return written;
}

// Sets revoked: 'revoked', 'already' when it was set before (its date stays), 'none' when there is no token, or
// 'unreadable', which changes nothing. Just before its rename it reads the file again: when the digest there is not the
// one it read first, such as after a new token from the start terminal, it starts over, so it never puts back an old
// record over a new one. The third try revokes the record it read without that check. A new token made in the short
// time between the last read and the rename is lost: the file then holds a revoked record, so it fails closed.
export function revokeToken(env, now = new Date()) {
  for (let tries = 1; ; tries += 1) {
    const record = readRecord(env);
    if (typeof record === 'string') return record;
    if (record.revoked !== null) return 'already';
    // The digest of the file now; none and unreadable, which are texts, have no digest.
    const unchanged = () => readRecord(env).sha256 === record.sha256;
    const keep = tries < REVOKE_TRIES ? unchanged : undefined;
    if (writeRecord(env, { ...record, revoked: now.toISOString() }, keep)) return 'revoked';
  }
}

// The lines that ksproxy token prints: the dates of the record, never the token or its digest.
export function tokenLines(record, now = new Date()) {
  const expired = now.getTime() >= Date.parse(record.expires);
  return [
    `created ${dayOf(record.created)}`,
    `${expired ? 'expired' : 'expires'} ${dayOf(record.expires)}`,
    `revoked ${record.revoked === null ? 'no' : dayOf(record.revoked)}`,
    record.lastUsed === null ? 'last used never' : `last used ${dayOf(record.lastUsed)} from ${record.lastAddress}`,
  ];
}

// The warning of the start terminal in the last WARN_DAYS days before the token expires, else null.
export function expiryWarning(record, now = new Date()) {
  const left = Date.parse(record.expires) - now.getTime();
  if (record.revoked !== null || left <= 0 || left > WARN_DAYS * DAY_MS) return null;
  return `the token expires on ${dayOf(record.expires)}; type new-token to replace it`;
}
