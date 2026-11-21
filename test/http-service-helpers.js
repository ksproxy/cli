import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { main } from '../src/cli.js';
import { fakeProcess, makeWorld } from './start-helpers.js';

// A stand-in service on the loopback address with a log of every request it got. The reply to a path ending in /echo-headers holds the
// request headers; any other path is answered with the method and the url.
export async function startService() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method, url: req.url, headers: req.headers, body,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      const url = new URL(req.url, 'http://x');
      res.end(JSON.stringify(url.pathname.endsWith('/echo-headers') ? req.headers : { method: req.method, url: req.url, body }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/prefix` };
}

// A stand-in review provider that gives one verdict to every question and keeps the questions.
export async function startProvider(verdict = 'allow') {
  const asked = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      asked.push(JSON.parse(body));
      const content = JSON.stringify({ verdict, certainty: 'sure', reason: 'fine' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { server, asked, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

export async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => { server.close(resolve); });
}

// A world whose inventory holds the given targets under the key of the kind.
export async function serviceWorld(key, { targets, extraEnv = {}, reviewer } = {}) {
  const world = await makeWorld({ extraEnv });
  const file = path.join(world.env.KSPROXY_CONFIG_DIR, 'inventory.json');
  const inventory = JSON.parse(fs.readFileSync(file, 'utf8'));
  inventory[key] = targets;
  if (reviewer) inventory.reviewers = { r1: { baseUrl: reviewer.baseUrl, model: 'm' } };
  fs.writeFileSync(file, JSON.stringify(inventory));
  world.inventoryFile = file;
  return world;
}

export const auditOf = (world) => fs.readFileSync(world.auditLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

export function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export async function cli(args, env) {
  const proc = fakeProcess();
  const code = await main(args, env, { process: proc });
  return { code, stdout: proc.stdout.text, stderr: proc.stderr.text };
}

// Every text a secret could have reached: the terminal, the replies, the audit log and every file of the state folder.
export function everythingOf(world, run, replies) {
  const texts = [run.proc.stdout.text, run.proc.stderr.text, ...replies, fs.readFileSync(world.auditLog, 'utf8')];
  for (const file of filesUnder(path.join(world.base, 'st'))) texts.push(fs.readFileSync(file, 'utf8'));
  return texts;
}
