import fs from 'node:fs';
import path from 'node:path';
import { sanitizeForTerminal } from './audit.js';
import { isObject } from './checks.js';
import { listenDir } from './paths.js';
import { isLive } from './session.js';
import { tokenState } from './token.js';

// What `ksproxy status` shows of the network listener. The listener writes listen.json; another process of the user
// can write it too, so the shape is checked and every text is cleaned before it is printed.

const isCount = (value) => Number.isInteger(value) && value >= 0;
const isText = (value) => typeof value === 'string';
const isTimeOrNull = (value) => value === null || (isText(value) && !Number.isNaN(Date.parse(value)));
const isTexts = (value) => Array.isArray(value) && value.every(isText);

function isClient(client) {
  return isObject(client) && isText(client.from) && isText(client.client)
    && isTimeOrNull(client.firstSeen) && isTimeOrNull(client.lastCall)
    && isCount(client.calls) && isCount(client.open) && isCount(client.wrong) && isTexts(client.projects);
}

// The record of listen.json when it has the shape the listener writes and its process is live, else null. The start
// time of the process, when the file has one, tells a reused pid from the listener's own, as for a session.
export function readListener(env) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(listenDir(env), 'listen.json'), 'utf8'));
  } catch {
    return null;
  }
  const shaped = isObject(record) && record.version === 1 && isTexts(record.addresses) && record.addresses.length > 0
    && typeof record.tls === 'boolean' && Array.isArray(record.clients) && record.clients.every(isClient);
  return shaped && isLive({ pid: record.pid, processStartedAt: record.processStartedAt }) ? record : null;
}

const clean = (text) => sanitizeForTerminal(text);

// A time as YYYY-MM-DD HH:MM:SS in local time.
function stamp(iso) {
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// The day of a time kept in token.json, in UTC, as `ksproxy token` shows it.
const dayOf = (iso) => iso.slice(0, 10);

function tokenLine(env, now) {
  const { state, record } = tokenState(env, now);
  if (state === 'ok') return `token from ${dayOf(record.created)}, expires ${dayOf(record.expires)}`;
  if (state === 'none') return 'no token';
  if (state === 'unreadable') return 'token file cannot be read';
  return `token ${state}`;
}

function clientLine(client) {
  const parts = [
    `  ${clean(client.from)}`,
    clean(client.client),
    client.open > 0 ? 'connected' : 'not connected',
    client.lastCall === null ? 'last call never' : `last call ${stamp(client.lastCall)}`,
    `${client.calls} calls`,
  ];
  if (client.projects.length > 0) parts.push(`projects ${client.projects.map(clean).join(', ')}`);
  return parts.join('  ');
}

// The lines of status for the listener, or none when no live listener has written a file of the right shape.
export function listenerLines(env, now = new Date()) {
  const record = readListener(env);
  if (record === null) return [];
  return [
    `listening on ${record.addresses.map(clean).join(', ')} (${record.tls ? 'https' : 'http'})`,
    tokenLine(env, now),
    ...record.clients.map(clientLine),
    ...record.clients.filter((c) => c.wrong > 0).map((c) => `  refused ${c.wrong} wrong tokens from ${clean(c.from)}`),
  ];
}
