// The driver of the e2e tests. It runs in the runner container as the user node and plays both sides: the owner, who
// writes the inventory and runs ksproxy start in a terminal with the credentials, and the agent, which speaks MCP to
// ksproxy mcp over stdio. The container peer is a second agent over the network. Every check is printed; the exit
// code is 1 when one failed. What it saw is kept in ~/out, which scripts/e2e.sh copies to e2e/logs on failure.
// The argument names the group of the run (a compose profile, see e2e/compose.yaml); its servers are the ones running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory as wholeInventory } from './inventory.js';
import { leakChecks, folderText } from './leaks.js';
import { listenScenario } from './listen.js';
import { mcpScenario } from './mcp.js';
import { postgresScenario } from './postgres.js';
import { mysqlScenario } from './mysql.js';
import { redisScenario } from './redis.js';
import { mongodbScenario } from './mongodb.js';
import { rabbitmqScenario } from './rabbitmq.js';
import { httpScenario } from './http.js';
import { elasticsearchScenario } from './elasticsearch.js';
import { kafkaScenario } from './kafka.js';
import { commandScenario } from './command.js';
import { AUDIT_LOG as KUBE_AUDIT_LOG, installKubeconfigs, kubernetesScenario } from './kubernetes.js';
import { doctorScenario } from './doctor.js';
import { installCaFile, sqlTlsScenario } from './sql-tls.js';
import {
  Checks, StdioClient, processes, waitFor,
} from './lib.js';
import {
  LOG_FOLDER, SESSION_FOLDER, STATE, pidsOf, startPlain, startSession,
} from './session.js';
import { sshScenario } from './ssh.js';
import {
  ROUTE_VALUES, TUNNELLED_TARGETS, esTunnelScenario, installLimitedHosts, limitedKeysScenario, stillListening,
  tunnelProjectScenario, tunnelScenario, tunnelSsh,
} from './tunnels.js';

// The groups: the kinds of the inventory, the scenarios, the targets over https with the CA of the run, which fail
// the check of doctor without it, and the tunnelled targets (label and name), whose route is a secret of the run for
// the leak check.
const GROUPS = {
  a: {
    kinds: ['ssh', 'postgres', 'mysql', 'redis', 'mongodb', 'rabbitmq', 'http', 'mcp'],
    scenarios: [
      ['ssh', sshScenario], ['postgres', postgresScenario], ['mysql', mysqlScenario], ['redis', redisScenario],
      ['mongodb', mongodbScenario], ['rabbitmq', rabbitmqScenario], ['http', httpScenario], ['mcp', mcpScenario],
      ['tunnels', tunnelScenario], ['keys limited', limitedKeysScenario], ['network access', listenScenario],
    ],
    tunnels: true,
    tunnelled: TUNNELLED_TARGETS,
    httpsTargets: ['everything-net', 'grafana', 'gf-tunnel'],
  },
  b: {
    kinds: ['elasticsearch', 'kafka', 'command'],
    scenarios: [
      ['elasticsearch', elasticsearchScenario], ['elasticsearch tunnel', esTunnelScenario], ['kafka', kafkaScenario],
      ['command', commandScenario],
    ],
    tunnelled: [['es', 'es-tunnel']],
    httpsTargets: ['es-logs', 'search-rw', 'es-tunnel'],
  },
  // The kubeconfig of each kubernetes target holds the CA of the cluster, so doctor needs no CA of the run.
  c: {
    kinds: ['kubernetes'],
    scenarios: [['kubernetes', kubernetesScenario]],
    tunnelled: [],
    httpsTargets: [],
  },
};
const group = GROUPS[process.argv[2]];
if (group === undefined) {
  process.stderr.write(`usage: main.js GROUP, one of ${Object.keys(GROUPS).join(', ')}\n`);
  process.exit(2);
}
const inventory = Object.fromEntries(Object.entries(wholeInventory).filter(([kind]) => group.kinds.includes(kind)));
const HOME = os.homedir();
const OUT = path.join(HOME, 'out');
const began = Date.now();
const checks = new Checks();
const secrets = JSON.parse(fs.readFileSync('/secrets/secrets.json', 'utf8'));
const secretFile = (name) => fs.readFileSync(path.join('/secrets', name), 'utf8').trim();
// The API key of es-logs, which Elasticsearch made for this run (group b only): the encoded form that ksproxy sends,
// and the key inside it, are secrets of the run too.
const ES_KEY_FILE = '/esout/api_key';
const esApiKey = fs.existsSync(ES_KEY_FILE) ? fs.readFileSync(ES_KEY_FILE, 'utf8').trim() : undefined;
if (esApiKey !== undefined) {
  secrets['es-logs API key, encoded'] = esApiKey;
  secrets['es-logs API key'] = Buffer.from(esApiKey, 'base64').toString('utf8').split(':')[1];
}
// The kubeconfigs of the kubernetes targets, which the cluster made for this run (group c only), go to ~/.kube as the
// examples name them; their tokens are secrets of the run too.
if (group.kinds.includes('kubernetes')) Object.assign(secrets, installKubeconfigs());
// The caFile of the postgres and mysql targets (group a only): the CA of the run, which signed the certificates of db and
// crm-db, goes where the examples name it.
const sqlTls = group.kinds.includes('postgres');
if (sqlTls) installCaFile();
// The service tunnels (groups a and b): their route, the jump and its key path, must reach no answer or file either.
if (group.tunnelled.length > 0) Object.assign(secrets, ROUTE_VALUES);
// The Host names of the keys limited on web1 (group a only), in the runner's ssh configuration.
if (group.tunnels) installLimitedHosts();
const keep = (name, text) => fs.writeFileSync(path.join(OUT, name), text);

fs.mkdirSync(OUT, { recursive: true });
const configDir = path.join(HOME, '.config', 'ksproxy');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(configDir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });

checks.begin('start');
// The credentials, only in the environment of start. The CA of the run makes start trust the servers over https and
// TLS.
const ownerEnv = {
  SHOP_DB_PASSWORD: secretFile('shop_db_password'),
  SHOP_DB_RW_PASSWORD: secretFile('shop_db_rw_password'),
  EVERYTHING_TOKEN: secretFile('mcp_token'),
  CRM_DB_PASSWORD: secretFile('crm_db_password'),
  CRM_DB_RW_PASSWORD: secretFile('crm_db_rw_password'),
  CRM_DB_TUNNEL_PASSWORD: secretFile('crm_db_tunnel_password'),
  REDIS_USER: secretFile('redis_user'),
  REDIS_PASSWORD: secretFile('redis_password'),
  REDIS_OPS_USER: secretFile('redis_ops_user'),
  REDIS_OPS_PASSWORD: secretFile('redis_ops_password'),
  ORDERS_MONGO_URI: secretFile('orders_mongo_uri'),
  ORDERS_MONGO_RW_URI: secretFile('orders_mongo_rw_uri'),
  ORDERS_MONGO_TUNNEL_URI: secretFile('orders_mongo_tunnel_uri'),
  MQ_USER: secretFile('mq_user'),
  MQ_PASSWORD: secretFile('mq_password'),
  MQ_OPS_USER: secretFile('mq_ops_user'),
  MQ_OPS_PASSWORD: secretFile('mq_ops_password'),
  GRAFANA_TOKEN: secretFile('grafana_token'),
  GRAFANA_NOTES_TOKEN: secretFile('grafana_notes_token'),
  ES_SEARCH_USER: secretFile('es_search_user'),
  ES_SEARCH_PASSWORD: secretFile('es_search_password'),
  ...(esApiKey === undefined ? {} : { ES_LOGS_API_KEY: esApiKey }),
  SHOP_GH_READ_TOKEN: secretFile('gh_read_token'),
  SHOP_GH_TRIAGE_TOKEN: secretFile('gh_triage_token'),
  NODE_EXTRA_CA_CERTS: '/secrets/ca.crt',
};
const session = await startSession(ownerEnv).catch((err) => {
  checks.check('start is ready and shows the token', false, err.message);
  keep('start-terminal.txt', err.message);
  process.exit(1);
});
const opened = Object.values(inventory).flat().map((target) => target.name);
const upLines = session.output().split('\n').filter((line) => / UP$/.test(line)).length;
checks.check('the terminal shows every target UP', upLines === opened.length, session.output());
checks.check('the network token is shown once on the terminal', session.output().split(session.token).length === 2, 'shown more than once');

// The agent: ksproxy mcp as start's mcp.json names it, with no credential in its environment.
const config = JSON.parse(fs.readFileSync(path.join(SESSION_FOLDER, 'mcp.json'), 'utf8')).mcpServers.ksproxy;
const agent = new StdioClient(config.command, config.args, { PATH: process.env.PATH, HOME });
const init = await agent.request('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-driver', version: '1.0' },
});
checks.check('ksproxy mcp answers initialize', init.result?.serverInfo?.name === 'ksproxy', JSON.stringify(init));
agent.notify('notifications/initialized');
const listTools = async () => (await agent.request('tools/list')).result.tools;
// The tools of the mcp targets come once the session has listed them.
const tools = group.kinds.includes('mcp') ? await waitFor(async () => {
  const list = await listTools();
  return list.some((tool) => tool.name === 'everything-net__echo') ? list : null;
}, { ms: 20000, what: 'the tools of the mcp targets in tools/list' }).catch(listTools) : await listTools();
// "Which tools the agent sees" in docs/SERVICES.md: the tool of a service kind only when the inventory has one.
const serviceTools = {
  http: 'http_request', command: 'command_exec', elasticsearch: 'elasticsearch_request', rabbitmq: 'rabbitmq_request',
  redis: 'redis_command', postgres: 'postgres_query', mysql: 'mysql_query', mongodb: 'mongodb_command', kafka: 'kafka_exec',
};
const toolNames = tools.map((tool) => tool.name);
const wrongTools = Object.entries(serviceTools).filter(([kind, name]) => toolNames.includes(name) !== group.kinds.includes(kind));
checks.check('tools/list has the tool of each service kind of the inventory, and no other', wrongTools.length === 0,
  `listed: ${toolNames.join(', ')}`);
const listed = await agent.call('list_targets');
let states = [];
try {
  states = JSON.parse(listed.text).targets.map((target) => `${target.name} ${target.state}`);
} catch {
  // checked below
}
checks.check('list_targets shows every target up', opened.every((name) => states.includes(`${name} up`)), listed.text);

const context = { checks, agent, tools, session };
for (const [name, scenario] of group.scenarios) {
  await checks.step(`${name}: the scenario ran to its end`, () => scenario(context));
}

// The session folder while the session runs, then Ctrl-C.
const sessionWhileRunning = folderText(SESSION_FOLDER);
checks.begin('stop');
await agent.close();
const how = await session.stop();
checks.check('Ctrl-C on the terminal stops start', how.code === 0, `start ended with ${JSON.stringify(how)}`);
const tail = session.output().split('\n').slice(-5).join('\n');
checks.check('the terminal says the session closed', / session +CLOSED /.test(tail), tail);
// Nothing that start ran is left: no ssh connection, MCP server, client program, kubectl proxy or start.
const ofStart = () => processes().filter((cmd) => cmd.includes('ControlPath=') || cmd.includes('server-everything')
  || /^(\S*\/)?(psql|mysql|mariadb|mongosh|kubectl)\b/.test(cmd) || cmd.includes('/opt/kafka/') || cmd.includes('/usr/local/bin/gh')
  || /\bksproxy(\.js)? (start|doctor)\b/.test(cmd));
const leftOver = (what) => waitFor(() => (ofStart().length === 0 ? [] : null), { ms: 10000, what })
  .catch(() => ofStart());
const left = await leftOver('the processes of start to end');
checks.check('no ssh connection, MCP server, client program, kubectl proxy or start process is left', left.length === 0, left.join('\n'));
// The loopback ports of the tunnels, which the tunnels scenario saw start listen on.
if (group.tunnels) {
  const ports = context.tunnelPorts ?? [];
  const open = await stillListening(ports);
  checks.check('no loopback port of the tunnels is left', ports.length > 0 && open.length === 0, `seen: ${ports.join(', ')}; still listening: ${open.join(', ')}`);
}
if (group.tunnelled.length > 0) {
  const streams = await waitFor(() => (tunnelSsh().length === 0 ? [] : null), { ms: 10000, what: 'the ssh of the tunnels to end' }).catch(tunnelSsh);
  checks.check('no shared connection or stream ssh of the tunnels is left', streams.length === 0, streams.join('\n'));
}

const doctorText = await checks.step('doctor: the scenario ran to its end', () => doctorScenario({
  checks, env: ownerEnv, count: opened.length, httpsTargets: group.httpsTargets, tunnelled: group.tunnelled,
}));
// Targets without caFile, in a project of their own, through doctor and start; then the logs of the SQL servers.
const tlsText = sqlTls ? await checks.step('sql tls: the scenario ran to its end', () => sqlTlsScenario({ checks, env: ownerEnv })) : [];
// The routes of the tunnels that cannot work, in a project of their own, through start.
const tunnelText = group.tunnels ? await checks.step('tunnels, project: the scenario ran to its end', () => tunnelProjectScenario({ checks, env: ownerEnv })) : '';
const leftByDoctor = await leftOver('the processes of doctor to end');
checks.check('doctor leaves no ssh connection, MCP server, client program or kubectl proxy', leftByDoctor.length === 0, leftByDoctor.join('\n'));

// A start killed with SIGKILL leaves its kubectl proxies running. The kubectl of k3s shows only its name in the process
// list, never " proxy ", so the next start closes them by the program name its pid records hold.
if (group.kinds.includes('kubernetes')) {
  checks.begin('hard kill');
  const proxyPids = () => pidsOf((cmd) => /^(\S*\/)?kubectl(\s|$)/.test(cmd));
  const killed = await startPlain(ownerEnv);
  const before = proxyPids();
  checks.check('the first start runs one kubectl proxy per target', before.length === opened.length, `proxies: ${before.join(', ')}`);
  process.kill(killed.pid, 'SIGKILL');
  await killed.exited;
  await new Promise((resolve) => { setTimeout(resolve, 500); });
  checks.check('after a SIGKILL of start, its kubectl proxies still run', before.every((pid) => proxyPids().includes(pid)), `left: ${proxyPids().join(', ')}`);
  const next = await startPlain(ownerEnv);
  const closed = new RegExp(`closed ${opened.length} proxy process\\(es\\) left by an earlier run`);
  checks.check('the next start closes the proxies the killed one left', closed.test(next.output()), next.output());
  checks.check('the old proxies are gone', before.every((pid) => !proxyPids().includes(pid)), `still: ${proxyPids().join(', ')}`);
  const ups = next.output().split('\n').filter((line) => / UP$/.test(line)).length;
  checks.check('the next start opens every target again', ups === opened.length, next.output());
  const how = await next.stop();
  checks.check('SIGINT stops the next start', how.code === 0, JSON.stringify(how));
  const leftAfter = await leftOver('the processes of the next start to end');
  checks.check('no kubectl proxy or start process is left after the hard kill', leftAfter.length === 0, leftAfter.join('\n'));
  keep('hard-kill-terminal.txt', `${killed.output()}\n--- next start ---\n${next.output()}`);
}

const auditText = folderText(LOG_FOLDER);
checks.begin('secrets');
checks.check(`the leak check looks for ${Object.keys(secrets).length} secret values of the run`, Object.keys(secrets).length >= 10, JSON.stringify(Object.keys(secrets)));
leakChecks(checks, {
  'the answers over stdio': agent.seen.join('\n'),
  'the answers over the network': (session.peerAnswers ?? []).join('\n'),
  'the audit log': auditText,
  'the session folder while running': sessionWhileRunning,
  'the session folder after the stop': folderText(SESSION_FOLDER),
  'the listener folder (only a hash of the token)': folderText(path.join(STATE, 'listen')),
  'the terminal output of start': session.output(),
  'the output of doctor': (doctorText ?? []).join('\n'),
  'the output of doctor and start for the targets without caFile': (tlsText ?? []).join('\n'),
  ...(group.tunnels ? { 'the output of start for the project tunnels': tunnelText ?? '' } : {}),
  ...(group.kinds.includes('kubernetes') ? { 'the audit log of the API server': fs.readFileSync(KUBE_AUDIT_LOG, 'utf8') } : {}),
}, secrets, session.token);

keep('start-terminal.txt', session.output());
keep('agent-stdio.txt', agent.seen.join('\n'));
keep('audit.txt', auditText);
keep('session-while-running.txt', sessionWhileRunning);
keep('doctor.txt', (doctorText ?? []).join('\n'));
keep('sql-tls.txt', (tlsText ?? []).join('\n'));
if (group.tunnels) keep('tunnels-terminal.txt', tunnelText ?? '');
keep('checks.json', `${JSON.stringify(checks.list, null, 2)}\n`);

const seconds = ((Date.now() - began) / 1000).toFixed(1);
const failed = checks.failed;
process.stdout.write(`\n${checks.list.length - failed.length} of ${checks.list.length} checks passed in ${seconds} s\n`);
for (const check of failed) process.stdout.write(`FAILED: ${check.area}: ${check.name}\n`);
process.exit(failed.length === 0 ? 0 : 1);
