#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// A stand-in for the mysql and mariadb clients: it records each start in HOME/sql-starts.log, then prints the name
// it was started under, its arguments and its whole environment as one JSON line. The statement steers it: one that
// holds slow waits, flood floods stdout, fail fails.
// A name that holds mariadb is the MariaDB client, any other the MySQL client, as their --version says. Each refuses
// the TLS options of the other, as the real clients do. The host steers the TLS answer: a host that starts with
// no-tls has a server without TLS, so a call that requires TLS fails; bad-cert has a certificate that a check refuses.
const argv = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const mariadb = name.includes('mariadb');
fs.appendFileSync(path.join(process.env.HOME, 'sql-starts.log'), `${name} ${process.pid}\n`);
const statement = (argv.find((arg) => arg.startsWith('--execute=')) ?? '').slice('--execute='.length);
const host = (argv.find((arg) => arg.startsWith('--host=')) ?? '').slice('--host='.length);
const foreign = argv.find((arg) => (mariadb ? arg.startsWith('--ssl-mode=') : arg === '--ssl' || arg === '--ssl-verify-server-cert'));
const verifies = argv.includes(mariadb ? '--ssl-verify-server-cert' : '--ssl-mode=VERIFY_IDENTITY');
const requires = verifies || (!mariadb && argv.includes('--ssl-mode=REQUIRED'));
const fail = (text, code) => {
  process.stderr.write(`${text}\n`);
  process.exitCode = code;
};

if (argv.includes('--version')) {
  process.stdout.write(mariadb
    ? `${name}  Ver 15.1 Distrib 10.11.19-MariaDB, for debian-linux-gnu (x86_64) using  EditLine wrapper\n`
    : `${name}  Ver 8.4.3 for Linux on x86_64 (MySQL Community Server - GPL)\n`);
} else if (foreign !== undefined) {
  fail(mariadb ? `${name}: unknown variable '${foreign.slice(2)}'` : `${name}: [ERROR] unknown option '${foreign}'.`, 7);
} else if (host.startsWith('no-tls') && requires) {
  fail(mariadb ? 'ERROR 2026 (HY000): TLS/SSL error: SSL is required, but the server does not support it'
    : "ERROR 2026 (HY000): SSL connection error: SSL is required but the server doesn't support it", 1);
} else if (host.startsWith('bad-cert') && verifies) {
  fail(mariadb ? 'ERROR 2026 (HY000): TLS/SSL error: unable to get local issuer certificate'
    : 'ERROR 2026 (HY000): SSL connection error: error:0A000086:SSL routines::certificate verify failed', 1);
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
  fail("ERROR 1146 (42S02): Table 'crm.fail' doesn't exist", 1);
} else {
  process.stdout.write(`${JSON.stringify({ client: name, argv, env: process.env })}\n`);
}
