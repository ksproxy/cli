#!/usr/bin/env node
const stateFolder = process.env[['KSPROXY', 'STATE', 'DIR'].join('_')];
process.stdout.write(`${'x'.repeat(262144 - 5)}${stateFolder}/y\n`);
