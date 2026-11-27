// The second client of the network listener: its own container on the compose network, as an agent on another
// machine. It waits for /handoff/request.json from the driver (the URL and the token that start showed once), sends
// its requests, and writes /handoff/result.json. It knows nothing else of the run.
import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { postJson } from './lib.js';

const REQUEST = '/handoff/request.json';
const RESULT = '/handoff/result.json';

const message = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const INITIALIZE = message(1, 'initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-peer', version: '1.0' },
});

async function serve(request) {
  const auth = { Authorization: `Bearer ${request.token}` };
  const send = (body, headers = auth) => postJson(request.url, body, headers).catch((err) => ({ status: 0, text: String(err) }));
  const steps = {
    initialize: await send(INITIALIZE),
    initialized: await send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    list: await send(message(2, 'tools/list')),
    ssh: await send(message(3, 'tools/call', { name: 'ssh_exec', arguments: { server: 'web1', command: 'uptime' } })),
    postgres: await send(message(4, 'tools/call', {
      name: 'postgres_query', arguments: { target: 'shop-db', query: 'select * from orders where id = 7' },
    })),
    refused: await send(message(5, 'tools/call', { name: 'ssh_exec', arguments: { server: 'web1', command: 'systemctl restart nginx' } })),
    wrongToken: await send(INITIALIZE, { Authorization: `Bearer ${request.wrong}` }),
    noToken: await send(INITIALIZE, {}),
  };
  const addresses = Object.values(os.networkInterfaces()).flat()
    .filter((address) => address.family === 'IPv4' && !address.internal).map((address) => address.address);
  return { addresses, steps };
}

for (;;) {
  if (fs.existsSync(REQUEST)) {
    const request = JSON.parse(fs.readFileSync(REQUEST, 'utf8'));
    fs.rmSync(REQUEST);
    const result = await serve(request);
    fs.writeFileSync(`${RESULT}.part`, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(`${RESULT}.part`, RESULT);
  }
  await sleep(200);
}
