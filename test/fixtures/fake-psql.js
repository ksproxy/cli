#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// A stand-in for psql: it records each start in HOME/sql-starts.log, then prints its arguments, the variables a
// libpq client reads and its whole environment as one JSON line. The statement (the word after the last --command)
// steers it: one that holds
// slow waits, flood floods stdout, fail fails.
// The host steers the TLS answer as libpq gives it: a host that starts with no-tls has a server without TLS, so
// PGSSLMODE require or verify-full fails; bad-cert has a certificate that verify-full does not accept; old-libpq is
// reached by a libpq older than 16, which takes PGSSLROOTCERT=system for a file name.
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'sql-starts.log'), `psql ${process.pid}\n`);
const statement = argv[argv.lastIndexOf('--command') + 1] ?? '';
const host = argv[argv.indexOf('--host') + 1] ?? '';
const mode = process.env.PGSSLMODE;
const tlsFailure = () => {
  if (mode !== 'require' && mode !== 'verify-full') return null;
  if (host.startsWith('no-tls')) return 'server does not support SSL, but SSL was required';
  if (mode === 'require') return null;
  if (host.startsWith('old-libpq') && process.env.PGSSLROOTCERT === 'system') {
    return 'root certificate file "system" does not exist\nEither provide the file or change sslmode to disable server certificate verification.';
  }
  return host.startsWith('bad-cert') ? 'SSL error: certificate verify failed' : null;
};
const failure = tlsFailure();

if (failure !== null) {
  process.stderr.write(`psql: error: connection to server at "${host}" (192.0.2.10), port 5432 failed: ${failure}\n`);
  process.exitCode = 2;
} else if (statement.includes('slow')) {
  setTimeout(() => {}, 60000);
} else if (statement.includes('flood')) {
  const chunk = 'y'.repeat(65536);
  const write = () => {
    while (process.stdout.write(chunk));
    process.stdout.once('drain', write);
  };
  write();
} else if (statement.includes('fail')) {
  process.stderr.write('ERROR:  relation "fail" does not exist\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ client: 'psql', argv, env: process.env })}\n`);
}
