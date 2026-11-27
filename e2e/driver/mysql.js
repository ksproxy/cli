// The mysql examples of docs/EXAMPLES.md against MariaDB 11.4 with the client of Debian (mariadb-client 10.11):
// crm-db runs the program mysql (the default client), crm-db-rw and crm-db-wide run mariadb. The seed is in
// e2e/images/crm-db/seed.sh; the expected rows are computed here the same way. The server writes every statement to
// its general log, so the log shows which calls reached it: every allowed statement is there, and no refused one.
import { clip, logChecks } from './lib.js';

const GENERAL_LOG = '/mylog/general.log';
const CITIES = ['Springfield', 'Riverside', 'Fairview', 'Lakeside'];

// The seeded rows, as seed.sh makes them, in the tab-separated lines of the client's batch mode.
const customerLine = (n) => [n, `Customer ${n}`, `customer${n}@example.com`, CITIES[n % 4]].join('\t');
function ticket(n) {
  const closed = n % 3 === 0;
  return {
    id: n, customer: ((n - 1) % 20) + 1, subject: `Ticket ${n}`, assignee: closed ? 'support' : 'NULL', status: closed ? 'closed' : 'open',
  };
}
const ticketLine = (t) => [t.id, t.customer, t.subject, t.assignee, t.status].join('\t');
const TICKET_HEAD = 'id\tcustomer_id\tsubject\tassignee\tstatus';
// A statement in the general log: the end of a Query line, so that a refused statement that starts with an allowed
// one is not found in the line of the allowed one.
const call = (statement) => ({ name: statement, marker: `Query\t${statement}\n` });

export async function mysqlScenario({ checks, agent }) {
  const reached = [];
  const kept = [];
  const query = (target, statement) => agent.call('mysql_query', { target, query: statement });
  const allowed = async (target, statement, expect, name = `allowed: ${statement}`) => {
    const answer = await query(target, statement);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text));
    reached.push(call(statement));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, statement, why, reason) => {
    const answer = await query(target, statement);
    checks.check(`refused: ${statement} (${why})`, answer.isError && answer.text.startsWith(`REFUSED (mysql ${target}): `)
      && answer.text.includes(reason), clip(answer.text));
    kept.push(call(statement));
    return answer;
  };

  checks.begin('mysql: crm-db, read only, client mysql (agent_ro)');
  await allowed('crm-db', 'show tables', (text) => text.includes('Tables_in_crm\ncustomers\ntickets'));
  await allowed('crm-db', 'describe customers', (text) => ['id\tint(11)\tNO\tPRI', 'name\tvarchar(64)', 'email\tvarchar(128)', 'city\tvarchar(64)']
    .every((line) => text.includes(`\n${line}`)));
  await allowed('crm-db', 'select * from customers where id = 7', (text) => text.includes(`id\tname\temail\tcity\n${customerLine(7)}`));
  await refused('crm-db', 'select * from customers where id = 7 or 1 = 1', 'the statement has more words than the rule', 'not on the allowlist');

  checks.begin('mysql: crm-db-rw, may assign and close tickets, client mariadb (agent_rw)');
  const seven = ticket(7);
  await allowed('crm-db-rw', 'select * from tickets where id = 7', (text) => text.includes(`${TICKET_HEAD}\n${ticketLine(seven)}`));
  await allowed('crm-db-rw', "update tickets set assignee = 'ops-team' where id = 7", () => true);
  await allowed('crm-db-rw', "update tickets set status = 'closed' where id = 7", () => true);
  Object.assign(seven, { assignee: 'ops-team', status: 'closed' });
  await allowed('crm-db-rw', 'select * from tickets where id = 7', (text) => text.includes(ticketLine(seven)), 'the updates assigned and closed ticket 7');
  await refused('crm-db-rw', 'delete from tickets where id = 7', 'no rule allows delete', 'not on the allowlist');
  await allowed('crm-db-rw', 'select * from tickets where id = 7', (text) => text.includes(ticketLine(seven)), 'the refused delete changed nothing: ticket 7 is still there');

  checks.begin('mysql: crm-db-wide, "select ..." on a read-only target');
  // The rule lets the call through; the function writes, and the read-only transaction of the target stops it.
  const write = 'select close_ticket(8)';
  const answer = await query('crm-db-wide', write);
  checks.check(
    `the server refuses ${write}: read-only transaction`,
    answer.isError && answer.text.includes('Cannot execute statement in a READ ONLY transaction'),
    clip(answer.text),
  );
  reached.push(call(write));
  await allowed('crm-db-rw', 'select * from tickets where id = 8', (text) => text.includes(ticketLine(ticket(8))), 'ticket 8 is still open');

  checks.begin('mysql: TLS, the certificate checked against caFile');
  // The server says which cipher the connection of this very call uses; it is empty without TLS.
  await allowed(
    'crm-db-wide',
    "select variable_value from information_schema.session_status where variable_name = 'Ssl_cipher'",
    (text) => /variable_value\nTLS_[A-Z0-9_]+/.test(text),
    'a call runs over TLS: Ssl_cipher names a TLS cipher',
  );

  checks.begin('mysql: the general log of the server');
  const text = await logChecks(checks, {
    file: GENERAL_LOG, reached, kept, noun: 'statement',
  });
  const connects = text.split('\n').filter((line) => line.includes('Connect\tagent_'));
  checks.check(
    'every connection of agent_ro and agent_rw used TLS (Connect ... using SSL/TLS)',
    connects.length > 0 && connects.every((line) => line.endsWith(' using SSL/TLS')),
    connects.join('\n'),
  );
  // Each connection first runs the init command of the client: the row limit, and READ ONLY unless readOnly is false.
  checks.check('the read-only targets ran in a read-only transaction', text.includes('Query\tSET SESSION sql_select_limit=1000; SET SESSION TRANSACTION READ ONLY\n'), 'no SET SESSION TRANSACTION READ ONLY in the log');
  checks.check('the read-and-write target ran without it', text.includes('Query\tSET SESSION sql_select_limit=1000\n'), 'no init command without READ ONLY in the log');
}
