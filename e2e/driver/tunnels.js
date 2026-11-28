// The service tunnels (docs/TUNNELS.md): targets that this machine cannot reach, behind app1, reached through web1 and
// one jump. app1 is the only server of the run that allows TCP forwarding; web1 runs the jump only. inner-db and
// inner-mongo are on the network back only, which the runner is not on, and app1 reaches crm-db, cache, mq, grafana
// and es on it too. The http kinds (http, rabbitmq, elasticsearch) take the ssh stream as the socket of each request:
// no loopback port, the Host header of the real host, and for https the certificate checked against the real name.
//
// tunnelScenario runs in the session of main.js: a direct connection from the runner fails, a read goes through each
// tunnelled target, the server logs show the connections coming from app1's address, and start holds one shared
// connection and one loopback port per target with a client program. esTunnelScenario does the same for the
// elasticsearch target of group b. tunnelProjectScenario runs once that session
// has stopped, with a project of its own: the OPENING lines name the route, the WARN line is there only for the targets
// that do not check a certificate, and the routes that cannot work are SKIPPED with their reason.
//
// The expected SKIPPED reasons, from the code (src/start.js openTunnel, src/kinds/engines/tunnel.js openStream):
// a reason "the route failed: ..." needs a stream ssh that exited with a code that is not 0. Without jumps, web1's
// "AllowTcpForwarding no" refuses the channel; the stream ssh asks the shared connection for it (-W over the control
// socket), the shared connection gets the refusal, and OpenSSH's control client then ends with "Stdio forwarding
// request failed: Session open refused by peer" and code 255. With a wrong jump key, the ssh on web1 ends with
// "opsuser@app1: Permission denied (publickey)." and code 255, which the stream ssh passes on as its own code.
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  inventory, TUNNEL_JUMP, TUNNEL_KEY, WRONG_KEY_JUMP,
} from './inventory.js';
import {
  bodyOf, clip, logChecks, processes, stdoutOf, waitFor,
} from './lib.js';
import { ownAddress, pidsOf, startPlain } from './session.js';

const HOME = os.homedir();
const PROJECT = 'tunnels';
const INNER_PG_LOG = '/inner-pglog/postgresql.log';
const INNER_MONGO_LOG = '/inner-mongolog/mongod.log';
const GENERAL_LOG = '/mylog/general.log';
const GRAFANA_LOG = '/httplog/requests.log';
const MQ_LOG = '/mqlog';
const ES_LOG = '/eslog/requests.log';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export const NO_CERTIFICATE = 'the servers on the route can read and change the traffic: this target does not check the certificate of the service';
// Each tunnelled target of the session: kind, label, name, whether it checks the certificate, whether it has a loopback
// port (the kinds with a client program).
const TUNNELLED = [
  ['postgres', 'pg', 'pg-tunnel', true, true],
  ['mysql', 'my', 'my-tunnel', false, true],
  ['mongodb', 'mgo', 'mgo-tunnel', false, true],
  ['redis', 'rds', 'rds-tunnel', true, false],
  ['http', 'http', 'gf-tunnel', true, false],
  ['http', 'http', 'gf-plain', false, false],
  ['rabbitmq', 'mq', 'mq-tunnel', true, false],
];
// The targets through the keys limited on web1 (docs/TUNNELS.md, "Keys limited on the servers"): label, name, and
// what the OPENING line says of the route.
const LIMITED = [
  ['http', 'gf-fwd', 'through web1-fwd'],
  ['http', 'gf-forced', 'through web1-jmp, then 1 jump'],
  ['http', 'gf-badjump', 'through web1-jmp, then 1 jump'],
];
// The tunnelled targets of group a, for the check of doctor: label and name.
export const TUNNELLED_TARGETS = [...TUNNELLED.map(([, label, name]) => [label, name]), ...LIMITED.map(([label, name]) => [label, name])];
const target = (kind, name) => inventory[kind].find((t) => t.name === name);

// The project: the tunnelled targets of the session, and four that cannot open: two without jumps through web1, which
// forbids forwarding (one with a loopback port, one with the stream as its socket), one with a wrong jump key, and
// gf-alias, which names grafana by its other name dashboards on the network back: the route works, and the check of
// the certificate through the tunnel fails, as the certificate holds the name grafana only. And two through the keys
// limited on web1: gf-fwd80 names grafana's port 80, which the key of fwd may not open (permitopen="grafana:443"),
// and mq-forced names mq through the key of ops whose forced command goes to grafana:443 whatever ksproxy sends.
export const PROJECT_INVENTORY = {
  postgres: [
    target('postgres', 'pg-tunnel'),
    {
      name: 'pg-nofwd',
      host: 'inner-db',
      database: 'shop',
      user: 'agent_ro',
      passwordEnv: 'SHOP_DB_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      tunnel: { host: 'web1' },
      allow: ['select 1'],
    },
    {
      name: 'pg-badkey',
      host: 'inner-db',
      database: 'shop',
      user: 'agent_ro',
      passwordEnv: 'SHOP_DB_PASSWORD',
      caFile: '~/certs/db-ca.pem',
      tunnel: { host: 'web1', jumps: [WRONG_KEY_JUMP] },
      allow: ['select 1'],
    },
  ],
  mysql: [target('mysql', 'my-tunnel')],
  mongodb: [target('mongodb', 'mgo-tunnel')],
  redis: [
    target('redis', 'rds-tunnel'),
    {
      name: 'rds-nofwd',
      host: 'cache',
      port: 6380,
      tls: true,
      userEnv: 'REDIS_USER',
      passwordEnv: 'REDIS_PASSWORD',
      tunnel: { host: 'web1' },
      allow: ['GET *'],
    },
  ],
  http: [
    target('http', 'gf-tunnel'),
    target('http', 'gf-plain'),
    target('http', 'gf-fwd'),
    target('http', 'gf-forced'),
    target('http', 'gf-badjump'),
    {
      name: 'gf-alias',
      baseUrl: 'https://dashboards',
      auth: { bearerEnv: 'GRAFANA_TOKEN' },
      tunnel: { host: 'web1', jumps: [TUNNEL_JUMP] },
      allow: ['GET /api/search'],
    },
    {
      name: 'gf-fwd80',
      baseUrl: 'http://grafana',
      auth: { bearerEnv: 'GRAFANA_TOKEN' },
      tunnel: { host: 'web1-fwd' },
      allow: ['GET /api/search'],
    },
  ],
  rabbitmq: [
    target('rabbitmq', 'mq-tunnel'),
    {
      name: 'mq-forced',
      url: 'https://mq:15671',
      userEnv: 'MQ_USER',
      passwordEnv: 'MQ_PASSWORD',
      tunnel: { host: 'web1-jmp', jumps: [TUNNEL_JUMP] },
      allow: ['GET /api/overview'],
    },
  ],
};
// Each target of the project that cannot open: label, name, what its SKIPPED reason says, and its pattern.
const REFUSED_CHANNEL = ['the route failed: ... Stdio forwarding request failed', 'the route failed: [^\\n]*Stdio forwarding request failed[^\\n]*'];
export const SKIPPED = [
  ['pg', 'pg-nofwd', ...REFUSED_CHANNEL],
  ['rds', 'rds-nofwd', ...REFUSED_CHANNEL],
  ['pg', 'pg-badkey', 'the route failed: ... Permission denied (publickey)', 'the route failed: [^\\n]*Permission denied \\(publickey\\)[^\\n]*'],
  ['http', 'gf-alias', 'the service did not answer through the tunnel: ... ERR_TLS_CERT_ALTNAME_INVALID',
    'the service did not answer through the tunnel: [^\\n]*ERR_TLS_CERT_ALTNAME_INVALID[^\\n]*'],
  // docs/TUNNELS.md, without jumps: permitopen= lets the key of fwd open grafana:443 only.
  ['http', 'gf-fwd80', ...REFUSED_CHANNEL],
  // docs/TUNNELS.md, with jumps: the forced command wins. web1 runs the jump to app1 and -W grafana:443 whatever the
  // route of mq-forced says, so its stream reaches grafana, whose certificate is not valid for the name mq.
  // The check of a rabbitmq target says only "could not connect" when the TLS handshake fails; mq-tunnel, with the same
  // jump and address through web1, opens.
  ['mq', 'mq-forced', 'the service did not answer through the tunnel: could not connect (it reached grafana:443)',
    'the service did not answer through the tunnel: could not connect'],
];

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A line of start, as sql-tls.js reads it: the kind's label, the target, the status, then the rest of the line,
// which matches rest (a pattern source) when it is given.
export const lineRe = (label, name, status, rest = '') => new RegExp(`(^|\\s)${label} +${escaped(name)} +${status}${rest === '' ? '' : ` +${rest}`}\\n`);

// The ports in LISTEN state on 127.0.0.1 in the text of /proc/net/tcp: [{ port, inode }].
export function loopbackListeners(text) {
  return text.split('\n').slice(1).map((line) => line.trim().split(/\s+/)).filter((f) => f.length > 9 && f[3] === '0A')
    .map((f) => ({ local: f[1], inode: f[9] }))
    .filter(({ local }) => local.split(':')[0] === '0100007F')
    .map(({ local, inode }) => ({ port: parseInt(local.split(':')[1], 16), inode }));
}

// The socket inodes that the processes pids hold open.
function socketInodes(pids) {
  const inodes = new Set();
  for (const pid of pids) {
    let fds = [];
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        if (match !== null) inodes.add(match[1]);
      } catch {
        // the descriptor closed meanwhile
      }
    }
  }
  return inodes;
}

const listenersNow = () => loopbackListeners(fs.readFileSync('/proc/net/tcp', 'utf8'));
// The loopback ports that a ksproxy start of this container listens on, sorted.
export function startLoopbackPorts() {
  const inodes = socketInodes(pidsOf((cmd) => /\bksproxy(\.js)? start\b/.test(cmd)));
  return listenersNow().filter(({ inode }) => inodes.has(inode)).map(({ port }) => port).sort((a, b) => a - b);
}
// Which of ports are still listening on 127.0.0.1, after up to 10 s.
export async function stillListening(ports) {
  const now = () => listenersNow().map(({ port }) => port).filter((port) => ports.includes(port));
  return waitFor(() => (now().length === 0 ? [] : null), { ms: 10000, what: 'the loopback ports to close' }).catch(now);
}
// The ssh processes of the tunnels: their shared connections (socket tnl-...) and the stream ssh over them.
export const tunnelSsh = () => processes().filter((cmd) => cmd.includes('/tnl-'));

// The address of each connection that PostgreSQL logged (log_connections), in order.
export const pgSources = (text) => [...text.matchAll(/connection received: host=(\S+) port=\d+/g)].map((m) => m[1]);
// The address of each connection that MongoDB accepted, in order.
export const mongoSources = (text) => text.split('\n').filter((line) => line.includes('"Connection accepted"'))
  .flatMap((line) => {
    const match = /"remote":"([^"]+):\d+"/.exec(line);
    return match === null ? [] : [match[1]];
  });
// Each connection of user in the general log of MariaDB: { host, tls }.
export const mariadbConnects = (text, user) => text.split('\n').filter((line) => line.includes(`Connect\t${user}@`))
  .map((line) => ({ host: line.slice(line.indexOf(`Connect\t${user}@`) + `Connect\t${user}@`.length).split(' ')[0], tls: line.endsWith(' using SSL/TLS') }));
// The value of Ssl_cipher in the batch output of the client: '' when the connection has no TLS, undefined when the
// output is not that of the query.
export function cipherOf(answerText) {
  const match = /^variable_value\n([^\n]*)/.exec(stdoutOf(answerText));
  return match === null ? undefined : match[1].trim();
}

// Each request in the log of the Grafana stand-in, parsed: { method, path, query, auth, status, target, host, from,
// port }. A line that is not JSON is skipped.
export const grafanaRequests = (text) => text.split('\n').filter(Boolean).flatMap((line) => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});
// The request of a search with the words query in the log of the Grafana stand-in, as the driver sends it: the
// first one, or undefined.
const searchOf = (requests, query) => requests.find((r) => r.method === 'GET' && r.path === '/api/search' && r.query?.query === query);
// The address of each request that Elasticsearch logged for method and path ("received request from [...
// remoteAddress=/ADDRESS:PORT}]"), in order.
export const esSources = (text, method, path) => text.split('\n').filter((line) => line.includes(`][${method}][${path}`) && line.includes('received request'))
  .flatMap((line) => {
    const match = /remoteAddress=\/?([0-9.]+):\d+/.exec(line);
    return match === null ? [] : [match[1]];
  });

// What a connection from the runner to host and port gives: 'connected', the error code, or 'timeout'.
function tryConnect(host, port, ms = 5000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(ms, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (err) => done(err.code ?? err.message));
  });
}

// The runner's own ssh with args (~/.ssh/config of the runner), with no input: { code, out, err }.
function runSsh(args) {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

// The address of name as web1 sees it, asked over the owner's own ssh to web1. Gives the address or the error text.
async function addressOnWeb1(name) {
  const { code, out, err } = await runSsh(['web1', 'getent', 'ahostsv4', name]);
  const first = out.split('\n')[0].trim().split(/\s+/)[0];
  return code === 0 && IPV4.test(first) ? first : `ssh exited with ${code}: ${err.trim()}`;
}

// The Host names of the keys limited on web1, added to the runner's ssh configuration before start (group a): the
// owner names each limited key with a Host of its own and its own IdentityFile, as docs/TUNNELS.md says. The file
// of the image belongs to root; its folder belongs to node, so the file is written again with the two entries added.
// It is not changed in the image: that layer comes before the layers that install packages.
export function installLimitedHosts() {
  const file = path.join(HOME, '.ssh', 'config');
  const entry = (name, user, key) => [`Host ${name}`, '  HostName web1', `  User ${user}`, `  IdentityFile /secrets/${key}`,
    '  IdentitiesOnly yes', '  IdentityAgent none', '  UserKnownHostsFile /secrets/known_hosts', '  GlobalKnownHostsFile /dev/null',
    '  StrictHostKeyChecking yes', '  BatchMode yes', '  ConnectTimeout 10', ''].join('\n');
  const text = `${fs.readFileSync(file, 'utf8').trimEnd()}\n\n# The keys limited on web1 (e2e/driver/tunnels.js).\n${entry('web1-fwd', 'fwd', 'fwd_key')}${entry('web1-jmp', 'ops', 'jmp_key')}`;
  fs.rmSync(file);
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// The scenario in the session. It keeps the loopback ports of start in context.tunnelPorts, for the check after the
// stop in main.js.
export async function tunnelScenario(context) {
  const { checks, agent } = context;
  const call = (tool, args) => agent.call(tool, args);
  const runner = ownAddress();

  checks.begin('tunnels: the inner network');
  for (const name of ['inner-db', 'inner-mongo']) {
    const direct = await dns.lookup(name).then((found) => found.address, (err) => err.code);
    checks.check(`${name}: a direct connection from the runner fails, as its name is not known here`, direct === 'ENOTFOUND' || direct === 'EAI_AGAIN', `${name} resolved to ${direct}`);
  }
  const seen = {};
  for (const name of ['app1', 'inner-db', 'inner-mongo']) seen[name] = await addressOnWeb1(name);
  checks.check('web1 gives the addresses of app1, inner-db and inner-mongo', ['app1', 'inner-db', 'inner-mongo'].every((name) => IPV4.test(seen[name])), JSON.stringify(seen));
  const app1 = seen.app1;
  for (const [name, port] of [['inner-db', 5432], ['inner-mongo', 27017]]) {
    const got = IPV4.test(seen[name]) ? await tryConnect(seen[name], port) : 'no address';
    checks.check(`${name}: a direct connection from the runner to its address fails`, got !== 'connected' && got !== 'no address', `${seen[name]}:${port}: ${got}`);
  }

  checks.begin('tunnels: what start holds while it runs');
  const shared = tunnelSsh().filter((cmd) => / -M /.test(cmd));
  const firstServers = shared.map((cmd) => cmd.split(' -- ').at(-1)).sort();
  checks.check('one shared connection for the tunnels per first server: web1, web1-fwd and web1-jmp', JSON.stringify(firstServers) === '["web1","web1-fwd","web1-jmp"]', shared.join('\n'));
  const ports = startLoopbackPorts();
  context.tunnelPorts = ports;
  checks.check('start listens on one loopback port for each of pg-tunnel, my-tunnel and mgo-tunnel, and none for rds-tunnel, gf-tunnel, gf-plain and mq-tunnel', ports.length === 3, `ports: ${ports.join(', ')}`);

  checks.begin('tunnels: a read through each tunnelled target');
  // inner-db and inner-mongo have the seed of db and mongo, unchanged by the other scenarios: order 41 belongs to
  // customer 6, is paid and has the total 297.25.
  const pgRow = await call('postgres_query', { target: 'pg-tunnel', query: 'select * from orders where id = 41' });
  checks.check('pg-tunnel: select * from orders where id = 41', !pgRow.isError && pgRow.text.startsWith('exit code: 0') && pgRow.text.includes('41|6|paid|297.25'), clip(pgRow.text));
  const pgTls = await call('postgres_query', { target: 'pg-tunnel', query: 'select ssl, version from pg_stat_ssl where pid = pg_backend_pid()' });
  checks.check('pg-tunnel: the call runs over TLS checked against caFile and the name inner-db (pg_stat_ssl says ssl t)', !pgTls.isError && /ssl\|version\nt\|TLSv1\.[23]/.test(pgTls.text), clip(pgTls.text));
  const myRow = await call('mysql_query', { target: 'my-tunnel', query: 'select * from customers where id = 3' });
  checks.check('my-tunnel: select * from customers where id = 3', !myRow.isError && myRow.text.startsWith('exit code: 0')
    && myRow.text.includes('id\tname\temail\tcity\n3\tCustomer 3\tcustomer3@example.com\tLakeside'), clip(myRow.text));
  const myTls = await call('mysql_query', { target: 'my-tunnel', query: "select variable_value from information_schema.session_status where variable_name = 'Ssl_cipher'" });
  const cipher = cipherOf(myTls.text);
  checks.check('my-tunnel: the server answers which cipher the call uses (empty without TLS)', !myTls.isError && cipher !== undefined, clip(myTls.text));
  const mgoRow = await call('mongodb_command', { target: 'mgo-tunnel', command: { find: 'orders', filter: { _id: 41 } } });
  let mgoReply;
  try {
    mgoReply = JSON.parse(stdoutOf(mgoRow.text));
  } catch {
    mgoReply = undefined;
  }
  checks.check('mgo-tunnel: find orders 41', !mgoRow.isError && mgoReply?.ok === 1 && mgoReply?.cursor?.firstBatch?.[0]?.status === 'paid', clip(mgoRow.text));
  const mgoCount = await call('mongodb_command', { target: 'mgo-tunnel', command: { count: 'orders' } });
  checks.check('mgo-tunnel: count orders gives the 60 seeded orders', !mgoCount.isError && /"n":\s*60\b/.test(stdoutOf(mgoCount.text)), clip(mgoCount.text));
  const rdsGet = await call('redis_command', { target: 'rds-tunnel', command: 'GET session:7f3a' });
  checks.check('rds-tunnel: GET session:7f3a over TLS checked against the name cache', !rdsGet.isError && rdsGet.text.startsWith('exit code: 0') && rdsGet.text.includes('"user:42"'), clip(rdsGet.text));
  const rdsDel = await call('redis_command', { target: 'rds-tunnel', command: 'DEL session:7f3a' });
  checks.check('rds-tunnel: refused: DEL session:7f3a, and the refusal says nothing of the route', rdsDel.isError
    && rdsDel.text.startsWith('REFUSED (redis rds-tunnel): not on the allowlist') && !/web1|app1|app_key/.test(rdsDel.text), clip(rdsDel.text));
  // The http kinds: the stream of the tunnel is the socket of each request. The search words tell the requests of
  // each target apart in the log of the Grafana stand-in.
  const search = (name, words) => call('http_request', {
    target: name, method: 'GET', path: '/api/search', query: { query: words },
  });
  const gfGet = await search('gf-tunnel', 'orders');
  checks.check('gf-tunnel: GET /api/search over https checked against the name grafana', !gfGet.isError && gfGet.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200')
    && JSON.stringify(bodyOf(gfGet.text)?.map((d) => d.uid)) === '["shop-orders"]', clip(gfGet.text));
  const gfDel = await call('http_request', { target: 'gf-tunnel', method: 'DELETE', path: '/api/dashboards/uid/shop-orders' });
  checks.check('gf-tunnel: refused: DELETE /api/dashboards/uid/shop-orders, and the refusal says nothing of the route', gfDel.isError
    && gfDel.text.startsWith('REFUSED (http gf-tunnel): not on the allowlist') && !/web1|app1|app_key/.test(gfDel.text), clip(gfDel.text));
  const plainGet = await search('gf-plain', 'infra');
  checks.check('gf-plain: GET /api/search in plain http', !plainGet.isError && plainGet.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200')
    && JSON.stringify(bodyOf(plainGet.text)?.map((d) => d.uid)) === '["infra-nodes"]', clip(plainGet.text));
  const plainPost = await call('http_request', { target: 'gf-plain', method: 'POST', path: '/api/annotations', body: { text: 'through the tunnel' } });
  checks.check('gf-plain: refused: POST /api/annotations, and the refusal says nothing of the route', plainPost.isError
    && plainPost.text.startsWith('REFUSED (http gf-plain): not on the allowlist') && !/web1|app1|app_key/.test(plainPost.text), clip(plainPost.text));
  const mqGet = await call('rabbitmq_request', { target: 'mq-tunnel', method: 'GET', path: '/api/overview' });
  checks.check('mq-tunnel: GET /api/overview over https checked against the name mq', !mqGet.isError && mqGet.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200')
    && bodyOf(mqGet.text)?.rabbitmq_version === '3.10.5', clip(mqGet.text));
  const mqNodes = await call('rabbitmq_request', { target: 'mq-tunnel', method: 'GET', path: '/api/nodes' });
  checks.check('mq-tunnel: refused: GET /api/nodes, and the refusal says nothing of the route', mqNodes.isError
    && mqNodes.text.startsWith('REFUSED (rabbitmq mq-tunnel): not on the allowlist') && !/web1|app1|app_key/.test(mqNodes.text), clip(mqNodes.text));

  checks.begin('tunnels: what the agent sees');
  const listed = await call('list_targets', {});
  let entries = [];
  try {
    entries = JSON.parse(listed.text).targets;
  } catch {
    // checked below
  }
  const shown = TUNNELLED_TARGETS.map(([, name]) => entries.find((entry) => entry.name === name));
  // The names and descriptions are the inventory's own words (they say tunnel and app1): the route is the first server
  // web1, the jump's key and its login, and no entry may have a field beyond the usual five.
  const usual = ['allow', 'description', 'kind', 'name', 'state'];
  checks.check(`list_targets shows the ${TUNNELLED_TARGETS.length} tunnelled targets up, and nothing of their routes`, shown.every((entry) => entry?.state === 'up'
    && Object.keys(entry).sort().join() === usual.join()
    && !/web1|app_key|opsuser@|jumps/i.test(JSON.stringify(entry))), clip(JSON.stringify(shown), 2000));

  checks.begin('tunnels: the logs of the servers');
  const pgLog = await logChecks(checks, {
    file: INNER_PG_LOG, reached: [{ name: 'select * from orders where id = 41', marker: 'statement: select * from orders where id = 41\n' }], kept: [], noun: 'statement through the tunnel',
  });
  // The health check of the container connects from 127.0.0.1, the seed through the local socket.
  const pgFrom = pgSources(pgLog).filter((host) => host !== '127.0.0.1' && host !== '[local]');
  checks.check(`inner-db: every connection from outside its container came from app1 (${app1}), none from the runner (${runner})`,
    pgFrom.length > 0 && pgFrom.every((host) => host === app1), `connections from: ${pgFrom.join(', ')}`);
  const pgAuthorized = pgLog.split('\n').filter((line) => line.includes('connection authorized: user=agent_ro'));
  checks.check(`inner-db: every connection of pg-tunnel used TLS (${pgAuthorized.length})`, pgAuthorized.length > 0
    && pgAuthorized.every((line) => line.includes(' SSL enabled (protocol=TLSv1.')), pgAuthorized.join('\n'));

  const mongoLog = await logChecks(checks, {
    file: INNER_MONGO_LOG, reached: [{ name: 'find orders 41', marker: '{"find":"orders","filter":{"_id":41}' }], kept: [], noun: 'command through the tunnel',
  });
  // The health check of the container connects from the container's own address.
  const mongoFrom = mongoSources(mongoLog).filter((host) => host !== '127.0.0.1' && host !== seen['inner-mongo']);
  checks.check(`inner-mongo: every connection from outside its container came from app1 (${app1}), none from the runner (${runner})`,
    mongoFrom.length > 0 && mongoFrom.every((host) => host === app1), `connections from: ${mongoFrom.join(', ')}`);

  const myLog = await logChecks(checks, {
    file: GENERAL_LOG, reached: [{ name: 'select * from customers where id = 3', marker: 'Query\tselect * from customers where id = 3\n' }], kept: [], noun: 'statement through the tunnel',
  });
  const connects = mariadbConnects(myLog, 'tunnel_ro');
  checks.check(`crm-db: every connection of my-tunnel came from app1 (${app1}), none from the runner (${runner})`,
    connects.length > 0 && connects.every((c) => c.host === app1), connects.map((c) => c.host).join(', '));
  // What the MariaDB client does on prefer through the tunnel, as the server saw it; the check is that both views
  // agree, and its name says which it was.
  const tls = connects.length > 0 && connects.every((c) => c.tls);
  const plain = connects.length > 0 && connects.every((c) => !c.tls);
  const used = cipher === undefined || cipher === '' ? 'used no TLS' : `used TLS (${cipher})`;
  checks.check(
    `my-tunnel, TLS prefer: the MariaDB client ${used} through the tunnel, and the general log says the same for its ${connects.length} connections`,
    cipher !== undefined && ((cipher !== '' && tls) || (cipher === '' && plain)),
    connects.map((c) => `${c.host} ${c.tls ? 'SSL/TLS' : 'no TLS'}`).join('\n'),
  );

  // The Grafana stand-in logs the client's address, the Host header and the port of each request.
  await logChecks(checks, {
    file: GRAFANA_LOG,
    reached: [
      { name: 'GET /api/search?query=orders (gf-tunnel)', marker: '"query":{"query":"orders"}' },
      { name: 'GET /api/search?query=infra (gf-plain)', marker: '"query":{"query":"infra"}' },
    ],
    kept: [
      { name: 'DELETE /api/dashboards/uid/shop-orders (gf-tunnel)', marker: '"path":"/api/dashboards/uid/shop-orders"' },
      { name: 'POST /api/annotations "through the tunnel" (gf-plain)', marker: 'through the tunnel' },
    ],
    noun: 'request through the tunnel',
  });
  const requests = grafanaRequests(fs.readFileSync(GRAFANA_LOG, 'utf8'));
  for (const [name, words, port] of [['gf-tunnel', 'orders', 443], ['gf-plain', 'infra', 80]]) {
    const seenBy = searchOf(requests, words);
    checks.check(`grafana: the request of ${name} came from app1 (${app1}), not from the runner (${runner}), on port ${port}, with the token of its target`,
      seenBy?.from === app1 && seenBy?.port === port && seenBy?.auth === 'viewer', JSON.stringify(seenBy));
    checks.check(`grafana: the request of ${name} has the Host header of the real host (grafana)`, seenBy?.host === 'grafana', JSON.stringify(seenBy));
  }
  // The trial of gf-plain at start sends OPTIONS * through the tunnel: no path of the API and no credential.
  const asked = requests.filter((r) => r.method === 'OPTIONS');
  checks.check(`grafana: the check of gf-plain at start reached it as OPTIONS * from app1, with no credential and the Host grafana (${asked.length})`, asked.length > 0
    && asked.every((r) => r.target === '*' && r.from === app1 && r.port === 80 && r.auth === 'none' && r.host === 'grafana'), JSON.stringify(asked));
  const onPlain = requests.filter((r) => r.port === 80);
  checks.check('grafana: every request in plain http came through the tunnel, from app1', onPlain.length > 0 && onPlain.every((r) => r.from === app1),
    clip(JSON.stringify(onPlain), 2000));

  const escapedApp1 = escaped(app1);
  await logChecks(checks, {
    file: MQ_LOG,
    reached: [{ name: `GET /api/overview (mq-tunnel), from app1 (${app1})`, marker: new RegExp(`^${escapedApp1} - e2e-mq-reader \\[[^\\]]*\\] "GET /api/overview HTTP/1\\.1"`, 'm') }],
    kept: [{ name: `GET /api/nodes (mq-tunnel), from app1 (${app1})`, marker: new RegExp(`^${escapedApp1} - \\S+ \\[[^\\]]*\\] "GET /api/nodes `, 'm') }],
    noun: 'request through the tunnel',
  });
}

// The two lines of docs/TUNNELS.md, "Keys limited on the servers", on the sshd of web1 (e2e/setup/secrets.sh), in the
// session of main.js. Without jumps, web1-fwd: the login fwd, the only one that may forward on web1, with
// restrict,port-forwarding,permitopen="grafana:443",command="/bin/false". With jumps, web1-jmp: a second key of ops
// with restrict,command="<the jump text of gf-forced>". The targets that cannot open are in the project
// (gf-fwd80, mq-forced; see SKIPPED).
export async function limitedKeysScenario(context) {
  const { checks, agent, session } = context;
  const runner = ownAddress();
  const app1 = await addressOnWeb1('app1');
  const web1 = await runSsh(['web1', 'hostname', '-I']);
  const web1Addresses = web1.out.trim().split(/\s+/).filter((address) => IPV4.test(address));
  const search = (name, words) => agent.call('http_request', {
    target: name, method: 'GET', path: '/api/search', query: { query: words },
  });
  const read = async (name, words, uids) => {
    const answer = await search(name, words);
    return { ok: !answer.isError && answer.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200') && JSON.stringify(bodyOf(answer.text)?.map((d) => d.uid)) === JSON.stringify(uids), text: answer.text };
  };
  const text = session.output();

  checks.begin('tunnels: keys limited on web1, without jumps (web1-fwd)');
  // The terminal of the session cuts long lines; the OPENING lines are checked in the project tunnels.
  checks.check('gf-fwd: UP', lineRe('http', 'gf-fwd', 'UP').test(text), text);
  const fwd = await read('gf-fwd', 'overview', ['shop-overview']);
  checks.check('gf-fwd: GET /api/search through the key limited to grafana:443', fwd.ok, clip(fwd.text));
  const command = await runSsh(['web1-fwd', 'echo', 'limited-key-ran']);
  checks.check('web1-fwd: the same key runs no command: ssh web1-fwd echo ... ends with code 1 (command="/bin/false") and prints nothing',
    command.code === 1 && command.out === '', JSON.stringify(command));
  const unlimited = await runSsh(['web1', 'echo', 'limited-key-ran']);
  checks.check('web1: the key of ops without options runs the same command', unlimited.code === 0 && unlimited.out === 'limited-key-ran\n', JSON.stringify(unlimited));

  checks.begin('tunnels: keys limited on web1, with jumps (web1-jmp)');
  const forced = fs.readFileSync('/secrets/jmp_forced_command', 'utf8');
  const { checkTunnel, streamArgs } = await import('/opt/ksproxy/src/kinds/engines/tunnel.js');
  const sent = streamArgs({ socket: '/socket', jumps: checkTunnel(target('http', 'gf-forced').tunnel, 'gf-forced').jumps, to: 'grafana:443' }).at(-1);
  checks.check('the forced command of the key of web1-jmp is the jump text that ksproxy sends for gf-forced', sent === forced, `sent: ${sent}\nforced: ${forced}`);
  for (const name of ['gf-forced', 'gf-badjump']) checks.check(`${name}: UP`, lineRe('http', name, 'UP').test(text), text);
  const forcedRead = await read('gf-forced', 'nodes', ['infra-nodes']);
  checks.check('gf-forced: GET /api/search through the key whose forced command is its route', forcedRead.ok, clip(forcedRead.text));
  // The danger that docs/TUNNELS.md names: the forced command wins. The jump of gf-badjump names wrong_key, which app1
  // does not accept (pg-badkey, with that jump through web1, is SKIPPED in the project tunnels), and yet it opens and
  // reads, because web1 runs the jump of gf-forced instead.
  const badRead = await read('gf-badjump', 'view', ['shop-overview']);
  checks.check('gf-badjump: GET /api/search works although app1 does not accept its jump key: web1 ran the forced command', badRead.ok, clip(badRead.text));

  checks.begin('tunnels: keys limited on web1, the log of grafana');
  await logChecks(checks, {
    file: GRAFANA_LOG,
    reached: ['overview', 'nodes', 'view'].map((words) => ({ name: `GET /api/search?query=${words}`, marker: `"query":{"query":"${words}"}` })),
    kept: [],
    noun: 'request through a limited key',
  });
  const requests = grafanaRequests(fs.readFileSync(GRAFANA_LOG, 'utf8'));
  const viaFwd = searchOf(requests, 'overview');
  checks.check(`grafana: the request of gf-fwd came from web1 (${web1Addresses.join(', ')}), which connects without jumps, on port 443, Host grafana`,
    web1Addresses.includes(viaFwd?.from) && viaFwd?.from !== runner && viaFwd?.port === 443 && viaFwd?.host === 'grafana', JSON.stringify(viaFwd));
  for (const [name, words] of [['gf-forced', 'nodes'], ['gf-badjump', 'view']]) {
    const seenBy = searchOf(requests, words);
    checks.check(`grafana: the request of ${name} came from app1 (${app1}), on port 443, Host grafana`,
      seenBy?.from === app1 && seenBy?.port === 443 && seenBy?.host === 'grafana', JSON.stringify(seenBy));
  }
}

// The elasticsearch target of group b through the tunnel, in the session of main.js: a read, a refusal, the request
// log of the node with the address of app1, the OPENING line, no loopback port, and nothing of the route in
// list_targets.
export async function esTunnelScenario(context) {
  const { checks, agent, session } = context;
  const call = (tool, args) => agent.call(tool, args);
  const runner = ownAddress();
  const app1 = await addressOnWeb1('app1');

  checks.begin('tunnels: the elasticsearch target es-tunnel');
  const shared = tunnelSsh().filter((cmd) => / -M /.test(cmd));
  checks.check('one shared connection for the tunnels, to web1', shared.length === 1 && shared[0].endsWith(' -- web1'), shared.join('\n'));
  const ports = startLoopbackPorts();
  checks.check('start listens on no loopback port for es-tunnel', ports.length === 0, `ports: ${ports.join(', ')}`);
  const text = session.output();
  checks.check('es-tunnel: OPENING names the route (through web1, then 1 jump), then UP', lineRe('es', 'es-tunnel', 'OPENING', '[^\\n]*, through web1, then 1 jump').test(text)
    && lineRe('es', 'es-tunnel', 'UP').test(text), text);
  checks.check('es-tunnel: no WARN, as it checks the certificate of the service', !lineRe('es', 'es-tunnel', 'WARN', escaped(NO_CERTIFICATE)).test(text), text);

  const health = await call('elasticsearch_request', { target: 'es-tunnel', method: 'GET', path: '/_cluster/health' });
  checks.check('es-tunnel: GET /_cluster/health over https checked against the name es', !health.isError && health.text.startsWith('exit code: 0\n--- stdout ---\nHTTP 200')
    && bodyOf(health.text)?.cluster_name === 'e2e', clip(health.text));
  const cat = await call('elasticsearch_request', { target: 'es-tunnel', method: 'GET', path: '/_cat/indices' });
  checks.check('es-tunnel: refused: GET /_cat/indices, and the refusal says nothing of the route', cat.isError
    && cat.text.startsWith('REFUSED (elasticsearch es-tunnel): not on the allowlist') && !/web1|app1|app_key/.test(cat.text), clip(cat.text));

  const listed = await call('list_targets', {});
  let entry;
  try {
    entry = JSON.parse(listed.text).targets.find((t) => t.name === 'es-tunnel');
  } catch {
    entry = undefined;
  }
  checks.check('list_targets shows es-tunnel up, and nothing of its route', entry?.state === 'up'
    && Object.keys(entry).sort().join() === 'allow,description,kind,name,state' && !/web1|app_key|opsuser@|jumps/i.test(JSON.stringify(entry)), clip(JSON.stringify(entry)));

  const log = await logChecks(checks, {
    file: ES_LOG,
    reached: [{ name: 'GET /_cluster/health', marker: '][GET][/_cluster/health] received request' }],
    kept: [],
    noun: 'request through the tunnel',
  });
  // es-logs and search-rw also ask for the health of the cluster, from the runner; the seed of the node asks from
  // 127.0.0.1 inside its container.
  const from = esSources(log, 'GET', '/_cluster/health').filter((address) => address !== '127.0.0.1');
  checks.check(`es: the health requests came from the runner (${runner}) for es-logs and search-rw, and from app1 (${app1}) for es-tunnel`,
    from.includes(app1) && from.every((address) => address === app1 || address === runner), `from: ${from.join(', ')}`);
  checks.check('es: the refused GET /_cat/indices of es-tunnel never reached the node: each one in its log came from the runner (es-logs)',
    esSources(log, 'GET', '/_cat/indices').every((address) => address === runner),
    esSources(log, 'GET', '/_cat/indices').join(', '));
}

// The scenario of the project tunnels, once the session of main.js has stopped. Gives the output of start, for the leak
// check.
export async function tunnelProjectScenario({ checks, env }) {
  const projects = path.join(HOME, '.config', 'ksproxy', 'projects');
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projects, `${PROJECT}.json`), `${JSON.stringify(PROJECT_INVENTORY, null, 2)}\n`, { mode: 0o600 });

  checks.begin('tunnels: start, the project tunnels');
  const started = await startPlain(env, ['--project', PROJECT]);
  const text = started.output();
  for (const [, label, name, checksCertificate] of TUNNELLED) {
    checks.check(`${name}: OPENING names the route (through web1, then 1 jump), then UP`, lineRe(label, name, 'OPENING', '[^\\n]*, through web1, then 1 jump').test(text)
      && lineRe(label, name, 'UP').test(text), text);
    const warned = lineRe(label, name, 'WARN', escaped(NO_CERTIFICATE)).test(text);
    checks.check(`${name}: ${checksCertificate ? 'no WARN, as it checks the certificate of the service' : 'one WARN: the servers on the route can read the traffic'}`, warned === !checksCertificate, text);
  }
  checks.check('pg-nofwd: OPENING names the route without jumps (through web1)', lineRe('pg', 'pg-nofwd', 'OPENING', '[^\\n]*, through web1').test(text), text);
  for (const [label, name, route] of LIMITED) {
    checks.check(`${name}: OPENING names the route (${route}), then UP, and no WARN`, lineRe(label, name, 'OPENING', `[^\\n]*, ${escaped(route)}`).test(text)
      && lineRe(label, name, 'UP').test(text) && !lineRe(label, name, 'WARN', escaped(NO_CERTIFICATE)).test(text), text);
  }
  checks.check('gf-fwd80: OPENING names the route without jumps (through web1-fwd)', lineRe('http', 'gf-fwd80', 'OPENING', '[^\\n]*, through web1-fwd').test(text), text);
  checks.check('mq-forced: OPENING names the route (through web1-jmp, then 1 jump)', lineRe('mq', 'mq-forced', 'OPENING', '[^\\n]*, through web1-jmp, then 1 jump').test(text), text);
  for (const [label, name, said, reason] of SKIPPED) {
    checks.check(`${name}: SKIPPED, ${said}`, lineRe(label, name, 'SKIPPED', reason).test(text), text);
  }
  const ports = startLoopbackPorts();
  checks.check('the skipped targets keep no loopback port: start listens on one for each of pg-tunnel, my-tunnel and mgo-tunnel', ports.length === 3, `ports: ${ports.join(', ')}`);
  const how = await started.stop();
  checks.check('SIGINT stops start', how.code === 0, JSON.stringify(how));
  const left = await waitFor(() => (tunnelSsh().length === 0 ? [] : null), { ms: 10000, what: 'the ssh of the tunnels to end' }).catch(tunnelSsh);
  checks.check('no shared connection or stream ssh of the tunnels is left', left.length === 0, left.join('\n'));
  const open = await stillListening(ports);
  checks.check('no loopback port of the tunnels is left', ports.length > 0 && open.length === 0, `still listening: ${open.join(', ')}`);
  return text;
}

// The route of the tunnels, for the leak check: the jump and its key path appear in no answer, file or line.
export const ROUTE_VALUES = { 'the jump of the tunnels': TUNNEL_JUMP, 'the key path of the jump of the tunnels': TUNNEL_KEY };
