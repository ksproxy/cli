import fs from 'node:fs';
import path from 'node:path';
import { tokenizeSshCommand } from '../../allowlist.js';
import { HOST_RE } from '../../checks.js';
import { run } from '../../exec.js';
import { CALL_SOCKET_NAME, REVIEW_SOCKET_NAME, sshBin } from '../../paths.js';

export const MAX_JUMPS = 5;
const JUMP_OPTIONS = ['-i', '-p', '-l', '-o', '-J'];
export const JUMP_SETTINGS = [
  'Port', 'User', 'IdentityFile', 'IdentitiesOnly', 'StrictHostKeyChecking', 'UserKnownHostsFile', 'HostKeyAlias',
  'ConnectTimeout', 'AddressFamily', 'LogLevel', 'ServerAliveInterval', 'ServerAliveCountMax', 'ProxyJump', 'Compression',
  'HostKeyAlgorithms', 'PubkeyAcceptedAlgorithms', 'KexAlgorithms', 'Ciphers', 'MACs', 'PreferredAuthentications',
];
const SETTING_RE = /^([^=]+)=(.+)$/;

// A word that zsh may rewrite with a non-default setting: a leading "=", "==" or ":=".
export function zshEqualsWord(word) {
  return word.startsWith('=') || word.includes('==') || word.includes(':=');
}

function checkSetting(value) {
  const match = SETTING_RE.exec(value);
  if (match === null) throw new Error('the value of -o must have the form Key=Value');
  const key = match[1].toLowerCase();
  if (!JUMP_SETTINGS.some((setting) => setting.toLowerCase() === key)) {
    throw new Error(`the setting ${match[1]} is not supported in a jump; supported: ${JUMP_SETTINGS.join(' ')}`);
  }
}

// Checks the words of one jump and returns its options (flags and values, in order) and its server.
export function parseJump(words) {
  if (words[0] !== 'ssh') throw new Error('must start with "ssh"');
  if (words.some(zshEqualsWord)) throw new Error('a word may not start with "=" or contain "==" or ":="');
  const options = [];
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    const flag = words[i];
    if (!JUMP_OPTIONS.includes(flag)) {
      throw new Error(`option ${flag} is not supported; the supported options are ${JUMP_OPTIONS.join(' ')}, each followed by its value as a separate word; for other settings use -o Key=Value`);
    }
    const value = words[i + 1];
    if (value === undefined) throw new Error(`option ${flag} needs a value`);
    if (value.startsWith('-')) throw new Error(`the value of ${flag} may not start with "-"`);
    if (flag === '-o') checkSetting(value);
    options.push(flag, value);
    i += 2;
  }
  const server = words[i];
  if (server === undefined) throw new Error('needs a server after the options');
  if (!HOST_RE.test(server)) throw new Error(`server must match ${HOST_RE} (no leading "-")`);
  if (i + 1 < words.length) throw new Error('nothing may follow the server; the command comes from the allow list');
  return { options, server };
}

// The words of one jump without its server: ssh, ksproxy's fixed options, the owner's options from parseJump, and the
// connect timeout after them, so that a value of the owner wins. Throws the error of the tokenizer or of parseJump.
export function jumpWords(jump) {
  const { options, server } = parseJump(tokenizeSshCommand(jump));
  return { words: ['ssh', '-T', '-e', 'none', '-o', 'BatchMode=yes', ...options, '-o', 'ConnectTimeout=10'], server };
}

// The text that goes before the agent's command: '' without jumps, null when the jumps cannot be used.
export function jumpPrefix(jumps) {
  if (jumps === undefined) return '';
  if (!Array.isArray(jumps) || jumps.length === 0 || jumps.length > MAX_JUMPS) return null;
  const parts = [];
  try {
    for (const jump of jumps) {
      const { words, server } = jumpWords(jump);
      parts.push([...words, server, '--'].join(' '));
    }
  } catch {
    return null;
  }
  return parts.join(' ');
}

export function masterArgs(socket, host, extra = []) {
  return [
    '-M', '-N', '-f',
    '-o', `ControlPath=${socket}`,
    '-o', 'ControlPersist=no',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    ...extra,
    '--', host,
  ];
}

export function controlArgs(socket, op, host) {
  return ['-S', socket, '-O', op, host];
}

export function sshConfigText(targets) {
  return targets.map(({ name, socket }) => [
    `Host ${name}`,
    '  HostName ksproxy.invalid',
    `  ControlPath ${socket}`,
    '  ControlMaster no',
    '  BatchMode yes',
    '  IdentityAgent none',
    '  IdentitiesOnly yes',
    '  IdentityFile /dev/null',
    '  PubkeyAuthentication no',
    '  PasswordAuthentication no',
    '  KbdInteractiveAuthentication no',
    '  ProxyCommand /usr/bin/false',
    '  UserKnownHostsFile /dev/null',
    '',
  ].join('\n')).join('\n');
}

export function execArgs(configFile, name, command) {
  return ['-F', configFile, '-T', name, '--', command];
}

export async function checkMaster({ socket, host }, env = process.env) {
  const r = await run(sshBin(env), controlArgs(socket, 'check', host), { timeoutMs: 5000, env });
  return r.exitCode === 0;
}

export async function closeMaster({ socket, host }, env = process.env) {
  try {
    await run(sshBin(env), controlArgs(socket, 'exit', host), { timeoutMs: 5000, env });
  } catch {
    // run never rejects; guard anyway
  }
  try {
    fs.rmSync(socket, { force: true });
  } catch {
    // best effort
  }
}

export async function openMaster({ socket, host, extra = [] }, env = process.env) {
  await closeMaster({ socket, host }, env);
  const r = await run(sshBin(env), masterArgs(socket, host, extra), { inherit: true, timeoutMs: 120000, env });
  if (r.spawnError) return { ok: false, error: r.spawnError };
  if (r.exitCode !== 0) return { ok: false, error: `ssh exited with code ${r.exitCode}` };
  if (!(await checkMaster({ socket, host }, env))) {
    return { ok: false, error: 'the connection did not stay open' };
  }
  return { ok: true };
}

export async function closeStaleSockets(dir, env) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith('.pid') || name === REVIEW_SOCKET_NAME || name === CALL_SOCKET_NAME) continue;
    await closeMaster({ socket: path.join(dir, name), host: 'stale' }, env);
  }
}
