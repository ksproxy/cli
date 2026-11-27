// The remote MCP server of the e2e tests. server-everything serves Streamable HTTP on 127.0.0.1:3001 only (its
// default), started by npx from its cache with no network. In front of it, this https server on port 8443 holds the
// certificate of the run and lets in only requests that carry the bearer token of the run; it drops that header before
// it passes a request on. Files in /secrets: server.crt, server.key, token.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const UPSTREAM = { host: '127.0.0.1', port: 3001 };
const PORT = 8443;
const expected = Buffer.from(`Bearer ${fs.readFileSync('/secrets/token', 'utf8').trim()}`);
// Headers of one connection only, which each side sets for itself.
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'];

const server = spawn('npx', ['-y', '@modelcontextprotocol/server-everything@2.3.1', 'streamableHttp'], {
  env: { ...process.env, npm_config_offline: 'true', PORT: String(UPSTREAM.port) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
server.on('exit', (code, signal) => {
  console.error(`server-everything stopped (${code ?? signal})`);
  process.exit(1);
});
for (const name of ['SIGTERM', 'SIGINT']) {
  process.on(name, () => {
    server.kill('SIGTERM');
    process.exit(0);
  });
}

const authorized = (header) => {
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
};
const without = (headers, names) => Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));

const front = https.createServer({
  cert: fs.readFileSync('/secrets/server.crt'),
  key: fs.readFileSync('/secrets/server.key'),
}, (req, res) => {
  if (!authorized(req.headers.authorization)) {
    console.log(`401 ${req.method} ${req.url}`);
    res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
    res.end('a valid bearer token is needed\n');
    return;
  }
  const headers = { ...without(req.headers, ['authorization', 'host', ...HOP]), host: `${UPSTREAM.host}:${UPSTREAM.port}` };
  const out = http.request({ ...UPSTREAM, method: req.method, path: req.url, headers }, (back) => {
    console.log(`${back.statusCode} ${req.method} ${req.url}`);
    res.writeHead(back.statusCode, without(back.headers, HOP));
    back.pipe(res);
  });
  out.on('error', (err) => {
    console.error(`upstream: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('upstream failed\n');
  });
  req.pipe(out);
});

// Listen only once the server answers on its port, so that the health check means the whole chain is up.
const deadline = Date.now() + 120000;
for (;;) {
  const ready = await new Promise((resolve) => {
    const socket = net.connect(UPSTREAM, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
  if (ready) break;
  if (Date.now() > deadline) throw new Error('server-everything did not open its port within 120 s');
  await sleep(200);
}
front.listen(PORT, '0.0.0.0', () => console.log(`https front on port ${PORT}`));
