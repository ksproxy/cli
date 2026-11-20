import fs from 'node:fs';
import { run } from './exec.js';
import { sshBin } from './paths.js';

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
