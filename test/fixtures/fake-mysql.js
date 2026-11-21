#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// A stand-in for the mysql and mariadb clients: it records each start in HOME/sql-starts.log, then prints the name
// it was started under, its arguments and its whole environment as one JSON line. The statement steers it: one that
// holds slow waits, flood floods stdout, fail fails.
const argv = process.argv.slice(2);
const name = path.basename(process.argv[1]);
fs.appendFileSync(path.join(process.env.HOME, 'sql-starts.log'), `${name} ${process.pid}\n`);
const statement = (argv.find((arg) => arg.startsWith('--execute=')) ?? '').slice('--execute='.length);

if (statement.includes('slow')) {
  setTimeout(() => {}, 60000);
} else if (statement.includes('flood')) {
  const chunk = 'y'.repeat(65536);
  const write = () => {
    while (process.stdout.write(chunk));
    process.stdout.once('drain', write);
  };
  write();
} else if (statement.includes('fail')) {
  process.stderr.write("ERROR 1146 (42S02): Table 'crm.fail' doesn't exist\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ client: name, argv, env: process.env })}\n`);
}
