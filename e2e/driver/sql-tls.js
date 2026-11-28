// The TLS of the postgres and mysql targets (see "TLS" under postgres and mysql in docs/SERVICES.md). The servers db and
// crm-db have certificates of the CA of the run, which is no CA of the system: the targets of the examples name it in
// caFile (see main.js), and the project tls holds targets without it. A target that writes "tls": "verify" without
// caFile is SKIPPED at start and FAIL in doctor, with a fixed reason and a line that gives the way out; a require target
// works without caFile with psql; the MariaDB client cannot require TLS without a check, so such a target is skipped
// too. A target without tls and without caFile is prefer: it is OK in doctor and opens at start, with no check of the
// certificate. At the end the logs of both servers show that every connection of the run used TLS, but the one of the
// mysql target with prefer, as the MariaDB client 10.11 gets no TLS option for prefer and so uses no TLS.
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

// The targets of the project: verify without caFile, the two kinds of require, and what an owner who writes neither tls
// nor caFile has.
const PROJECT_INVENTORY = {
  postgres: [
    {
      name: 'pg-system', host: 'db', database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', tls: 'verify', allow: ['select 1'],
    },
    {
      name: 'pg-require', host: 'db', database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', tls: 'require', allow: ['select 1'],
    },
    {
      name: 'pg-prefer', host: 'db', database: 'shop', user: 'agent_ro', passwordEnv: 'SHOP_DB_PASSWORD', allow: ['select 1'],
    },
  ],
  mysql: [
    {
      // The default client, the program mysql, which is the MariaDB client here: its version says so.
      name: 'my-system', host: 'crm-db', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', tls: 'verify', allow: ['select 1'],
    },
    {
      name: 'my-require', host: 'crm-db', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', client: 'mariadb', tls: 'require', allow: ['select 1'],
    },
    {
      name: 'my-prefer', host: 'crm-db', database: 'crm', user: 'agent_ro', passwordEnv: 'CRM_DB_PASSWORD', allow: ['select 1'],
    },
  ],
};
// Each target without tls and without caFile: its label, its name and the text of its OPENING line.
const PREFER = [
  ['pg', 'pg-prefer', 'agent_ro@db:5432/shop, read-only, TLS prefer'],
  ['my', 'my-prefer', 'agent_ro@crm-db:3306/crm, read-only, TLS prefer'],
];
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
  checks.check('doctor fails, and only the require target of psql and the two prefer targets are OK', ran.code === 1 && ran.text.includes('3 of 6 targets OK')
    && lineOf('pg', 'pg-require', 'OK', 'select 1 answered').test(ran.text), ran.text);
  for (const [label, name] of PREFER) {
    checks.check(`${name}: OK without tls and without caFile`, lineOf(label, name, 'OK', 'select 1 answered').test(ran.text), ran.text);
  }
  for (const [label, name, reason, wayOut] of FAILING) {
    checks.check(`${name}: FAIL, ${reason}`, lineOf(label, name, 'FAIL', reason).test(ran.text), ran.text);
    checks.check(`${name}: the way out names "tls" and "caFile"`, lineOf(label, name, null, wayOut).test(ran.text), ran.text);
  }

  checks.begin('sql tls: start, targets without caFile');
  const started = await startPlain(env, ['--project', PROJECT]);
  const text = started.output();
  checks.check('pg-require opens without caFile', /pg +pg-require +UP\n/.test(text), text);
  for (const [label, name, opening] of PREFER) {
    checks.check(`${name}: opens with TLS prefer`, lineOf(label, name, 'OPENING', opening).test(text)
      && new RegExp(`${label} +${escaped(name)} +UP\n`).test(text), text);
  }
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
  // my-prefer connects once, for the select 1 of doctor (open runs nothing for prefer). Prefer gives the client no TLS
  // option, and the MariaDB client 10.11 then uses no TLS, so that one connection of agent_ro may be without it.
  const connects = fs.readFileSync(MY_LOG, 'utf8').split('\n').filter((line) => line.includes('Connect\tagent_'));
  const plain = connects.filter((line) => !line.endsWith(' using SSL/TLS'));
  checks.check(
    `every connection of agent_ro and agent_rw to MariaDB used TLS (${connects.length}), but at most the one of my-prefer`,
    connects.length > plain.length && plain.length <= 1 && plain.every((line) => line.includes('Connect\tagent_ro@')),
    plain.join('\n'),
  );
  return [ran.text, text];
}
