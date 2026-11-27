// ksproxy start as the owner runs it: in the foreground of a terminal, here a pseudo-terminal made by script
// (util-linux), with the credentials in its environment. The terminal is what shows the network token, once.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitFor } from './lib.js';

const HOME = os.homedir();
export const STATE = path.join(HOME, '.ksproxy');
export const SESSION_FOLDER = path.join(STATE, 'session');
export const LOG_FOLDER = path.join(STATE, 'logs');
const PORT = 7443;
// The one line per project that start prints with a new token.
const TOKEN_LINE = /claude mcp add --transport http ksproxy-default (http:\/\/\S+\/mcp) --header "Authorization: Bearer (ksp_[A-Za-z0-9_-]+)"/;

// The runner's own address on the compose network: the only IPv4 address that is not loopback.
export function ownAddress() {
  const found = Object.values(os.networkInterfaces()).flat().filter((address) => address.family === 'IPv4' && !address.internal);
  if (found.length !== 1) throw new Error(`expected one network address, found ${found.map((a) => a.address).join(', ')}`);
  return found[0].address;
}

// Every entry of the audit log, oldest first; a line that is not JSON is skipped.
export function auditEntries() {
  const file = path.join(LOG_FOLDER, 'audit.log');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

// Starts ksproxy start --all --listen ADDRESS:7443 with env added to a small environment. Resolves once start says it
// is ready and the listener runs, with the token and the URL from the terminal.
export async function startSession(env) {
  const address = ownAddress();
  const command = `ksproxy start --all --listen ${address}:${PORT}`;
  const child = spawn('script', ['--quiet', '--flush', '--return', '--command', command, '/dev/null'], {
    env: {
      PATH: process.env.PATH, HOME, LANG: 'C.UTF-8', TERM: 'dumb', SHELL: '/bin/bash', ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let text = '';
  const take = (chunk) => {
    text += chunk.toString('utf8').replace(/\r/g, '');
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let ended = null;
  exited.then((how) => { ended = how; });

  const session = {
    command,
    output: () => text,
    auditEntries,
    async stop(ms = 30000) {
      // Ctrl-C on the terminal.
      child.stdin.write('\x03');
      const timer = setTimeout(() => child.kill('SIGKILL'), ms);
      const how = await exited;
      clearTimeout(timer);
      return how;
    },
  };
  await waitFor(() => {
    if (ended !== null) throw new Error(`start ended (${JSON.stringify(ended)}) before it was ready`);
    return text.includes('Leave this running.') && TOKEN_LINE.test(text);
  }, { ms: 180000, what: 'start to be ready and to show the token' }).catch((err) => {
    child.kill('SIGKILL');
    throw new Error(`${err.message}; its terminal:\n${text}`);
  });
  const [, url, token] = TOKEN_LINE.exec(text);
  return { ...session, listenUrl: url, token, address };
}

// The pid of each process of this container whose command line (its words joined by spaces) passes test.
export const pidsOf = (test) => fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).filter((pid) => {
  try {
    return test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim());
  } catch {
    return false;
  }
}).map(Number);

// ksproxy start --all without a terminal and without the listener, as a run in the background starts it: its
// processes have no controlling terminal, so a SIGKILL of start leaves them running, as a crash does. extra are more
// arguments, such as --project NAME. Resolves once start says it is ready, with its pid, its output so far and a stop
// that sends SIGINT, as Ctrl-C does.
export async function startPlain(env, extra = []) {
  const child = spawn('ksproxy', ['start', '--all', ...extra], {
    env: {
      PATH: process.env.PATH, HOME, LANG: 'C.UTF-8', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  const take = (chunk) => {
    text += chunk.toString('utf8');
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let ended = null;
  exited.then((how) => { ended = how; });
  await waitFor(() => {
    if (ended !== null) throw new Error(`start ended (${JSON.stringify(ended)}) before it was ready:\n${text}`);
    return text.includes('Leave this running.');
  }, { ms: 180000, what: 'start without a terminal to be ready' });
  return {
    pid: child.pid,
    output: () => text,
    exited,
    async stop(ms = 30000) {
      child.kill('SIGINT');
      const timer = setTimeout(() => child.kill('SIGKILL'), ms);
      const how = await exited;
      clearTimeout(timer);
      return how;
    },
  };
}

