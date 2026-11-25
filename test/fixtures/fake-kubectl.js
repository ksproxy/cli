#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';

const argv = process.argv.slice(2);

if (process.env.KSPROXY_FAKE_KUBECTL_ENV_LOG) {
  fs.appendFileSync(process.env.KSPROXY_FAKE_KUBECTL_ENV_LOG, `${JSON.stringify({ argv, env: process.env })}\n`);
}

if (argv.includes('proxy')) {
  const portArg = argv.find((a) => a.startsWith('--port='));
  const port = Number(portArg.slice('--port='.length));
  const status = Number(process.env.KSPROXY_FAKE_KUBECTL_STATUS ?? 200);
  const hold = process.env.KSPROXY_FAKE_KUBECTL_HOLD;
  let versions = 0;
  const server = http.createServer((req, res) => {
    // With KSPROXY_FAKE_KUBECTL_HOLD, only the first GET /version is answered, the probe of open: every later one, the
    // doctor check, is held without an answer, and a line is added to the file it names.
    if (req.url === '/version') versions += 1;
    if (hold && req.url === '/version' && versions > 1) {
      fs.appendFileSync(hold, 'held\n');
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    // /version answers as a cluster does, for the doctor check; every other path answers {}.
    res.end(req.url === '/version' ? '{"major":"1","minor":"31","gitVersion":"v1.31.2"}' : '{}');
  });
  server.listen(port, '127.0.0.1');
  // With KSPROXY_FAKE_KUBECTL_IGNORE_TERM the proxy is one that is slow to close: it stays up after SIGTERM, so a
  // test that kills it at a close limit kills a running proxy, never one that is writing its coverage file as it exits.
  process.on('SIGTERM', () => {
    if (process.env.KSPROXY_FAKE_KUBECTL_IGNORE_TERM) return;
    server.close();
    process.exit(0);
  });
} else if (argv.includes('--print-env')) {
  process.stdout.write(`ENV=${JSON.stringify(Object.keys(process.env).sort())}\nKUBERC=${process.env.KUBERC ?? 'unset'}\n`);
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify(argv));
  process.exit(Number(process.env.KSPROXY_FAKE_KUBECTL_EXIT ?? 0));
}
