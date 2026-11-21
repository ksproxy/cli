#!/usr/bin/env node
import fs from 'node:fs';

const argv = process.argv.slice(2);
const last = argv[argv.length - 1];

if (process.env.KSPROXY_FAKE_SSH_LOG) {
  fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_LOG, `${JSON.stringify(argv)}\n`);
}
if (process.env.KSPROXY_FAKE_SSH_ENV_LOG) {
  fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_ENV_LOG, `${JSON.stringify({ argv, env: process.env })}\n`);
}

function valueAfter(flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv.includes('-M')) {
  if (process.env.KSPROXY_FAKE_SSH_FAIL_HOST && process.env.KSPROXY_FAKE_SSH_FAIL_HOST === last) process.exit(255);
  const opt = argv.find((a, i) => argv[i - 1] === '-o' && a.startsWith('ControlPath='));
  if (!opt) process.exit(64);
  fs.writeFileSync(opt.slice('ControlPath='.length), '');
  process.exit(0);
} else if (argv.includes('-O') && valueAfter('-O') === 'check') {
  const trace = (word) => {
    if (process.env.KSPROXY_FAKE_SSH_TRACE) {
      fs.appendFileSync(process.env.KSPROXY_FAKE_SSH_TRACE, `${word}\n`);
    }
  };
  const finishCheck = () => {
    trace('end');
    process.exit(fs.existsSync(valueAfter('-S')) ? 0 : 255);
  };
  trace('begin');
  const delay = Number(process.env.KSPROXY_FAKE_SSH_CHECK_MS ?? 0);
  if (delay > 0) setTimeout(finishCheck, delay);
  else finishCheck();
} else if (argv.includes('-O') && valueAfter('-O') === 'exit') {
  fs.rmSync(valueAfter('-S'), { force: true });
  process.exit(0);
} else if (argv.includes('-F')) {
  const sep = argv.indexOf('--');
  const name = argv[sep - 1];
  const command = argv.slice(sep + 1).join(' ');
  if (command === 'fail') {
    process.stderr.write('boom\n');
    process.exit(3);
  }
  if (command === 'env') {
    process.stdout.write(`ENV=${JSON.stringify(Object.keys(process.env).sort())}\n`);
    process.exit(0);
  }
  if (command === 'slow') {
    setTimeout(() => process.exit(0), 10000);
  } else {
    process.stdout.write(`ran ${name} ${command}\n`);
    process.exit(0);
  }
} else {
  process.exit(64);
}
