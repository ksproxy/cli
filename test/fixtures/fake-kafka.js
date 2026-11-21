#!/usr/bin/env node
import fs from 'node:fs';

// A stand-in for a Kafka command-line client. Its first argument is the program name the wrapper script gives it;
// the rest are the arguments ksproxy passed. It prints the program, the arguments, its working folder, what that
// folder holds and its environment as one JSON line, and never reads a file it is pointed at. Words among the
// arguments steer it: sleep, flood, fail, touch.
const [program, ...argv] = process.argv.slice(2);

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
    program, argv, cwd: process.cwd(), entries: fs.readdirSync('.'), env: process.env,
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (argv.includes('touch')) fs.writeFileSync('left-behind.txt', 'x');
}
