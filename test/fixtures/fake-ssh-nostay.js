#!/usr/bin/env node
const argv = process.argv.slice(2);
const opIndex = argv.indexOf('-O');
const op = opIndex === -1 ? null : argv[opIndex + 1];

if (op === 'check') process.exit(255);
process.exit(0);
