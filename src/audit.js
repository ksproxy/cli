import fs from 'node:fs';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function clipEntry(entry) {
  const out = { ...entry };
  if (typeof out.target === 'string') out.target = clip(out.target, 64);
  if (typeof out.command === 'string') out.command = clip(out.command, 2000);
  if (Array.isArray(out.args)) {
    out.args = out.args.slice(0, 50).map((a) => (typeof a === 'string' ? clip(a, 500) : a));
  }
  if (typeof out.reason === 'string') out.reason = clip(out.reason, 500);
  if (typeof out.short === 'string') out.short = clip(out.short, 120);
  if (typeof out.message === 'string') out.message = clip(out.message, 120);
  return out;
}

export function appendAudit(file, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...clipEntry(entry) });
  fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
}

export function rotateAudit(file, maxBytes = MAX_LOG_BYTES) {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

export function readAuditEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const entry = JSON.parse(raw);
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) entries.push({ entry, raw });
    } catch {
      // not an audit entry
    }
  }
  return entries;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

export function clock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

const TERMINAL_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

export function sanitizeForTerminal(text) {
  return String(text).replace(
    TERMINAL_UNSAFE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

export function logOptionsFor(stream, env = process.env) {
  if (!stream || stream.isTTY !== true) return { width: 240, color: false };
  const width = Number.isInteger(stream.columns) && stream.columns > 0 ? stream.columns : 120;
  const color = env.NO_COLOR === undefined && env.TERM !== 'dumb';
  return { width, color };
}

const DEFAULT_WIDTH = 240;
const STATUS_AT = 8 + 1 + 4 + 1 + 10 + 1;
const LIFECYCLE_STATUS = {
  target_opening: 'OPENING',
  target_up: 'UP',
  target_skipped: 'SKIPPED',
  target_warn: 'WARN',
  target_down: 'DOWN',
  target_recovered: 'UP',
  session_start: 'READY',
  session_closing: 'CLOSING',
  session_end: 'CLOSED',
};
const GREEN = '32';
const YELLOW = '33';
const RED = '31';
const STATUS_COLOR = {
  ok: GREEN,
  UP: GREEN,
  READY: GREEN,
  TIMEOUT: YELLOW,
  ERROR: YELLOW,
  WARN: YELLOW,
  SKIPPED: YELLOW,
  DENIED: RED,
  DOWN: RED,
};

function statusColor(status) {
  if (status.startsWith('exit ')) return YELLOW;
  return STATUS_COLOR[status];
}

function isKube(entry) {
  return entry.tool === 'kubectl' || entry.kind === 'kube' || entry.kind === 'kubernetes';
}

function isLocal(entry) {
  return entry.tool === 'local_exec' || entry.kind === 'loc' || entry.kind === 'local';
}

function callDetail(entry, verbose) {
  const raw = isKube(entry) ? entry.args : entry.command;
  let text = '(invalid)';
  if (Array.isArray(raw)) text = raw.join(' ');
  else if (typeof raw === 'string') text = raw;
  else if (raw === undefined) text = '';
  text = sanitizeForTerminal(text);
  if (entry.decision === 'refused') {
    const reason = entry.short ?? (entry.reason === undefined ? undefined : clip(entry.reason, 60));
    if (reason === undefined) return text;
    const bracket = `[${clip(sanitizeForTerminal(reason), 120)}]`;
    return text === '' ? bracket : `${text}  ${bracket}`;
  }
  if (!verbose) return text;
  const parts = [];
  if (entry.rule !== undefined) parts.push(`rule: ${sanitizeForTerminal(entry.rule)}`);
  if (Number.isFinite(entry.stdoutBytes)) parts.push(`out ${entry.stdoutBytes}B`);
  if (Number.isFinite(entry.stderrBytes)) parts.push(`err ${entry.stderrBytes}B`);
  return parts.length === 0 ? text : `${text}  (${parts.join(', ')})`;
}

function callStatus(entry) {
  if (entry.decision === 'refused') return 'DENIED';
  if (entry.spawnError !== undefined && entry.spawnError !== null) return 'ERROR';
  if (entry.timedOut) return 'TIMEOUT';
  if (entry.exitCode === 0) return 'ok';
  return clip(`exit ${sanitizeForTerminal(entry.exitCode ?? '?')}`, 12);
}

function lifecycleKind(entry) {
  if (entry.kind === 'ssh') return 'ssh';
  if (entry.kind === 'kube' || entry.kind === 'kubernetes') return 'kube';
  if (isLocal(entry)) return 'loc';
  return '--';
}

export function formatLogLine(entry, { width = DEFAULT_WIDTH, color = false, verbose = false } = {}) {
  const event = entry.event ?? 'call';
  let kind;
  let target;
  let status;
  let duration = '';
  let detail;
  if (event === 'call') {
    if (isKube(entry)) kind = 'kube';
    else kind = isLocal(entry) ? 'loc' : 'ssh';
    target = entry.target ?? '';
    status = callStatus(entry);
    if (entry.decision !== 'refused') duration = formatDuration(entry.durationMs);
    detail = callDetail(entry, verbose);
  } else if (event === 'list') {
    kind = '--';
    target = 'agent';
    status = 'LIST';
    detail = 'list_targets';
  } else if (Object.hasOwn(LIFECYCLE_STATUS, event)) {
    status = LIFECYCLE_STATUS[event];
    if (event.startsWith('session_')) {
      kind = '--';
      target = 'session';
    } else {
      kind = lifecycleKind(entry);
      target = entry.target ?? '';
    }
    detail = sanitizeForTerminal(entry.message ?? '');
  } else {
    return null;
  }

  const plain = [
    clock(entry.ts),
    pad(kind, 4),
    pad(clip(sanitizeForTerminal(target), 10), 10),
    pad(status, 8),
    pad(duration, 6),
    detail,
  ].join(' ');
  const max = Number.isInteger(width) && width >= 2 ? width : DEFAULT_WIDTH;
  const line = clip(plain.trimEnd(), max);
  if (!color) return line;
  const code = statusColor(status);
  if (code === undefined || line.slice(STATUS_AT, STATUS_AT + status.length) !== status) return line;
  return `${line.slice(0, STATUS_AT)}\u001b[${code}m${status}\u001b[0m${line.slice(STATUS_AT + status.length)}`;
}

export const formatAuditLine = formatLogLine;
