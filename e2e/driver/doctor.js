// ksproxy doctor against the real targets, once the session has stopped (docs/DOCTOR.md): every target is OK with the
// credentials of the run, and the servers over https (the remote MCP server and the Grafana stand-in) fail without the
// CA of the run, which shows that ksproxy checks the server's certificate.
import { spawn } from 'node:child_process';
import os from 'node:os';

// Runs ksproxy doctor with the arguments and env added to a small environment; gives { code, text }.
export function doctor(args, env) {
  return new Promise((resolve) => {
    const child = spawn('ksproxy', ['doctor', ...args], {
      env: {
        PATH: process.env.PATH, HOME: os.homedir(), LANG: 'C.UTF-8', ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.on('exit', (code) => resolve({ code, text }));
  });
}

// Gives the output of each run, for the leak check. httpsTargets are the targets that must fail without the CA; a group
// without one skips that run.
export async function doctorScenario({
  checks, env, count, httpsTargets,
}) {
  checks.begin('doctor');
  const all = await doctor([], env);
  checks.check(`every target is OK (${count} of ${count})`, all.code === 0 && all.text.includes(`${count} of ${count} targets OK`), all.text);
  if (httpsTargets.length === 0) return [all.text];
  const withoutCa = { ...env };
  delete withoutCa.NODE_EXTRA_CA_CERTS;
  const bare = await doctor(httpsTargets, withoutCa);
  // The name column cuts a long name and ends it with an ellipsis.
  const failed = (name) => new RegExp(`${name.slice(0, 8)}\\S* +FAIL`).test(bare.text);
  checks.check(
    `without the CA of the run, ${httpsTargets.join(' and ')} fail their check`,
    bare.code === 1 && httpsTargets.every(failed) && bare.text.includes(`0 of ${httpsTargets.length} targets OK`),
    bare.text,
  );
  return [all.text, bare.text];
}
