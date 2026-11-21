#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

// A stand-in for psql: it records each start in HOME/sql-starts.log, then prints its arguments, the variables a
// libpq client reads and its whole environment as one JSON line. The statement (the word after the last --command)
// steers it: one that holds
// slow waits, flood floods stdout, fail fails.
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'sql-starts.log'), `psql ${process.pid}\n`);
const statement = argv[argv.lastIndexOf('--command') + 1] ?? '';

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
  process.stderr.write('ERROR:  relation "fail" does not exist\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ client: 'psql', argv, env: process.env })}\n`);
}
