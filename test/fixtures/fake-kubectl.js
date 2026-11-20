#!/usr/bin/env node
import http from 'node:http';

const argv = process.argv.slice(2);

if (argv.includes('proxy')) {
  const portArg = argv.find((a) => a.startsWith('--port='));
  const port = Number(portArg.slice('--port='.length));
  const status = Number(process.env.KSPROXY_FAKE_KUBECTL_STATUS ?? 200);
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => {
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
