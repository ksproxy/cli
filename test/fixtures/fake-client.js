#!/usr/bin/env node
import fs from 'node:fs';

// A stand-in for a command-line client: it prints its arguments, its working folder, what that folder holds and its
// environment as one JSON line. Words among its arguments steer it: sleep, flood, fail, touch; --pid-file FILE
// records its pid first, in one step (a rename), so that a test which sees the file can always read the pid.
const argv = process.argv.slice(2);
const pidAt = argv.indexOf('--pid-file');
if (pidAt !== -1) {
  fs.writeFileSync(`${argv[pidAt + 1]}.part`, String(process.pid));
  fs.renameSync(`${argv[pidAt + 1]}.part`, argv[pidAt + 1]);
}

if (argv.includes('sleep')) {
  setTimeout(() => {}, 60000);
} else if (argv.includes('flood')) {
  const chunk = 'y'.repeat(65536);
  const write = () => {
    while (process.stdout.write(chunk));
    process.stdout.once('drain', write);
  };
  write();
} else if (argv.includes('fail')) {
  process.stderr.write('it failed\n');
  process.exitCode = 3;
} else {
  const report = {
    argv, cwd: process.cwd(), entries: fs.readdirSync('.'), env: process.env,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (argv.includes('touch')) fs.writeFileSync('left-behind.txt', 'x');
}
