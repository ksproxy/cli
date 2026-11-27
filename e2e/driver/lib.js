// What the driver's scenarios share: the record of checks, waiting for a condition with a deadline, an MCP client over
// stdio, a JSON POST over HTTP, the checks against a server's log, reading a reply, and the processes of the runner.
// Plain Node, no dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

// The checks of a run, in order. Each scenario records its checks under its area; a failed check never stops the run,
// so that one report shows every failure.
export class Checks {
  constructor(log = (line) => process.stdout.write(`${line}\n`)) {
    this.list = [];
    this.log = log;
    this.area = '';
  }

  begin(area) {
    this.area = area;
    this.log(`\n== ${area}`);
  }

  // Records one check; detail is shown only when it failed. Gives ok.
  check(name, ok, detail = '') {
    const passed = ok === true;
    this.list.push({ area: this.area, name, ok: passed, detail: passed ? '' : String(detail) });
    this.log(`${passed ? '  ok    ' : '  FAIL  '}${name}${passed || detail === '' ? '' : `\n        ${String(detail).split('\n').join('\n        ')}`}`);
    return passed;
  }

  // Runs one step; an exception is recorded as a failed check with its message, and the run goes on.
  async step(name, fn) {
    try {
      return await fn();
    } catch (err) {
      this.check(name, false, err?.stack ?? err);
      return undefined;
    }
  }

  get failed() {
    return this.list.filter((c) => !c.ok);
  }
}

// Polls fn every everyMs until it gives a value that is not undefined, null or false, and gives that value; throws
// with what when ms pass first.
export async function waitFor(fn, { ms = 30000, everyMs = 200, what = 'a condition' } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

// An MCP client over stdio, as an agent runs ksproxy mcp: one JSON message per line. Notifications from the server
// are kept in notes. Every answer and every line on stderr is kept in seen, for the leak check.
export class StdioClient {
  constructor(command, args, env) {
    this.child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.nextId = 1;
    this.waiting = new Map();
    this.notes = [];
    this.seen = [];
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.#onLine(line));
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => this.seen.push(line));
  }

  #onLine(line) {
    this.seen.push(line);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = this.waiting.get(message.id);
    if (message.method !== undefined || waiter === undefined) {
      this.notes.push(message);
      return;
    }
    this.waiting.delete(message.id);
    waiter(message);
  }

  request(method, params = {}, ms = 120000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no answer to ${method} within ${ms} ms`));
      }, ms);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  // One tools/call: { text, isError }, or the JSON-RPC error as the text with isError.
  async call(name, args = {}, ms = 120000) {
    const answer = await this.request('tools/call', { name, arguments: args }, ms);
    if (answer.error !== undefined) return { text: `error ${answer.error.code}: ${answer.error.message}`, isError: true };
    return { text: answer.result.content.map((part) => part.text ?? '').join('\n'), isError: answer.result.isError === true };
  }

  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 5000);
    await this.exited;
    clearTimeout(timer);
  }
}

// One POST of a JSON body; gives { status, headers, text }. The Host header is the one of the URL, as a client sends
// it.
export function postJson(url, body, headers = {}) {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(text),
        ...headers,
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${url} within 120 s`)));
    req.on('error', reject);
    req.end(text);
  });
}

// The command line of every process of this container, its words joined by spaces.
export const processes = () => fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
  try {
    return [fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()];
  } catch {
    return [];
  }
}).filter(Boolean);

// The first line of a text, for a short detail.
export const firstLine = (text) => String(text).split('\n')[0];

// A text cut to n characters, for a detail.
export const clip = (text, n = 600) => (String(text).length > n ? `${String(text).slice(0, n)}...` : String(text));

// The standard output of a call's reply: the text after "--- stdout ---" up to "--- stderr ---", or "".
export function stdoutOf(text) {
  const at = String(text).indexOf('--- stdout ---\n');
  if (at === -1) return '';
  const rest = String(text).slice(at + '--- stdout ---\n'.length);
  const end = rest.indexOf('\n--- stderr ---');
  return end === -1 ? rest : rest.slice(0, end);
}

// The body of an http reply ("HTTP 200", the content type, an empty line, the body) as JSON, or undefined.
export function bodyOf(text) {
  const out = stdoutOf(text);
  try {
    return JSON.parse(out.slice(out.indexOf('\n\n') + 2));
  } catch {
    return undefined;
  }
}

// The checks against a server's log: every call that reached the server is in file, and no refused (kept) call is.
// Each call is { name, marker }, marker being the text that the call leaves in the log, or a pattern that matches it.
// Waits up to 15 s for the reached calls, as a server may write its log a little later. file may be a folder, whose
// files are read together. noun names the calls in the checks. Gives the log.
export async function logChecks(checks, {
  file, reached, kept, noun = 'call',
}) {
  const read = () => {
    if (!fs.existsSync(file)) return '';
    if (!fs.statSync(file).isDirectory()) return fs.readFileSync(file, 'utf8');
    return fs.readdirSync(file).sort().map((name) => fs.readFileSync(`${file}/${name}`, 'utf8')).join('');
  };
  const has = (text, call) => (typeof call.marker === 'string' ? text.includes(call.marker) : call.marker.test(text));
  const missing = (text) => reached.filter((call) => !has(text, call));
  const text = await waitFor(() => {
    const now = read();
    return missing(now).length === 0 ? now : null;
  }, { ms: 15000, what: `every allowed ${noun} in ${file}` }).catch(() => read());
  checks.check(`every allowed ${noun} reached the server`, missing(text).length === 0,
    `missing from ${file}:\n${missing(text).map((call) => call.name).join('\n')}`);
  for (const call of kept) {
    checks.check(`never reached the server: ${call.name}`, !has(text, call), `found in ${file}`);
  }
  return text;
}
