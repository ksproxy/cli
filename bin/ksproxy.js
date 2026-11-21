#!/usr/bin/env -S node --disable-sigusr1
process.on('SIGUSR1', () => {});
const { runCli } = await import('../src/cli.js');

runCli(process.argv.slice(2));
