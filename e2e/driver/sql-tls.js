// The TLS of the postgres and mysql targets (see "TLS" under postgres and mysql in docs/SERVICES.md). The servers db and
// crm-db have certificates of the CA of the run, which is no CA of the system: the targets of the examples name it in
// caFile (see main.js), and the project tls holds targets without it. A verify target without caFile is SKIPPED at start
// and FAIL in doctor, with a fixed reason and a line that gives the way out; a require target works without caFile with
// psql; the MariaDB client cannot require TLS without a check, so such a target is skipped too. At the end the logs of
// both servers show that every connection of the run used TLS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { doctor } from './doctor.js';
import { startPlain } from './session.js';

const HOME = os.homedir();
export const CA_FILE = path.join(HOME, 'certs', 'db-ca.pem');
const PROJECT = 'tls';
const PG_LOG = '/pglog/postgresql.log';
const MY_LOG = '/mylog/general.log';
const CERT = "the server's TLS certificate did not verify";
const SYSTEM_WAY = (host) => `the certificate was checked against the system's CAs and the host name ${host}; name the CA that signed it in "caFile", or set "tls" to "require" or "prefer" to skip the check`;
const MARIADB_REQUIRE = 'the MariaDB client cannot require TLS without a check';
const MARIADB_WAY = 'set "tls" to "verify" (with "caFile" when this system does not trust the CA), or to "prefer"';

// The targets of the project: what an owner who upgrades without caFile has, and the two kinds of require.
const PROJECT_INVENTORY = {
  postgres: [
    {
      name: 'pg-system', host: 'db', database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', allow: ['select 1'],
    },
    {
      name: 'pg-require', host: 'db', database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', tls: 'require', allow: ['select 1'],
    },
  ],
  mysql: [
    {
      // The default client, the program mysql, which is the MariaDB client here: its version says so.
      name: 'my-system', host: 'crm-db', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', allow: ['select 1'],
    },
    {
      name: 'my-require', host: 'crm-db', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', client: 'mariadb', tls: 'require', allow: ['select 1'],
    },
  ],
};
// Each failing target: its label, its name, the short reason and the way out.
const FAILING = [
  ['pg', 'pg-system', CERT, SYSTEM_WAY('db')],
  ['my', 'my-system', CERT, SYSTEM_WAY('crm-db')],
  ['my', 'my-require', MARIADB_REQUIRE, MARIADB_WAY],
];

// Copies the CA of the run to the caFile that the examples name. Run before the inventory is used.
export function installCaFile() {
  fs.mkdirSync(path.dirname(CA_FILE), { recursive: true, mode: 0o700 });
  fs.copyFileSync('/secrets/ca.crt', CA_FILE);
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A line of the target with the status, or a said line (no status) with the text.
const lineOf = (label, name, status, text) => new RegExp(`${label} +${escaped(name)} +${status === null ? '' : `${status} +`}${escaped(text)}\n`);

// Gives the output of doctor and of start, for the leak check.
export async function sqlTlsScenario({ checks, env }) {
  const projects = path.join(HOME, '.config', 'ksproxy', 'projects');
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(projects, `${PROJECT}.json`), `${JSON.stringify(PROJECT_INVENTORY, null, 2)}\n`, { mode: 0o600 });

  checks.begin('sql tls: doctor, targets without caFile');
  const ran = await doctor(['--project', PROJECT], env);
  checks.check('doctor fails, and only the require target of psql is OK', ran.code === 1 && ran.text.includes('1 of 4 targets OK')
    && lineOf('pg', 'pg-require', 'OK', 'select 1 answered').test(ran.text), ran.text);
  for (const [label, name, reason, wayOut] of FAILING) {
    checks.check(`${name}: FAIL, ${reason}`, lineOf(label, name, 'FAIL', reason).test(ran.text), ran.text);
    checks.check(`${name}: the way out names "tls" and "caFile"`, lineOf(label, name, null, wayOut).test(ran.text), ran.text);
  }

  checks.begin('sql tls: start, targets without caFile');
  const started = await startPlain(env, ['--project', PROJECT]);
  const text = started.output();
  checks.check('pg-require opens without caFile', /pg +pg-require +UP\n/.test(text), text);
  for (const [label, name, reason, wayOut] of FAILING) {
    checks.check(`${name}: SKIPPED, ${reason}`, lineOf(label, name, 'SKIPPED', reason).test(text), text);
    checks.check(`${name}: the way out is said before it`, lineOf(label, name, null, wayOut).test(text), text);
  }
  const how = await started.stop();
  checks.check('SIGINT stops start', how.code === 0, JSON.stringify(how));

  checks.begin('sql tls: the logs of the servers');
  // A failed check of a certificate ends before the login, so every connection that logged in used TLS.
  const authorized = fs.readFileSync(PG_LOG, 'utf8').split('\n').filter((line) => line.includes('connection authorized: user=agent_'));
  checks.check(
    `every connection of agent_ro and agent_rw to PostgreSQL used TLS (${authorized.length})`,
    authorized.length > 0 && authorized.every((line) => line.includes(' SSL enabled (protocol=TLSv1.')),
    authorized.filter((line) => !line.includes(' SSL enabled')).join('\n'),
  );
  const connects = fs.readFileSync(MY_LOG, 'utf8').split('\n').filter((line) => line.includes('Connect\tagent_'));
  checks.check(
    `every connection of agent_ro and agent_rw to MariaDB used TLS (${connects.length})`,
    connects.length > 0 && connects.every((line) => line.endsWith(' using SSL/TLS')),
    connects.filter((line) => !line.endsWith(' using SSL/TLS')).join('\n'),
  );
  return [ran.text, text];
}
