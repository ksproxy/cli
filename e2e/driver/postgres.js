// The postgres examples of docs/EXAMPLES.md against PostgreSQL 17 with real psql 17. The seed is in
// e2e/images/db/seed.sh; the expected rows are computed here the same way. The server logs every statement, so the
// log shows which calls reached it: every allowed statement is there, and no refused one.
import { clip, logChecks } from './lib.js';

const SERVER_LOG = '/pglog/postgresql.log';
const STATUSES = ['pending', 'paid', 'shipped', 'cancelled'];

// The seeded orders, as seed.sh makes them.
function seeded() {
  const rows = new Map();
  for (let n = 1; n <= 60; n += 1) {
    rows.set(n, {
      id: n, customer: n % 7 === 0 ? 7 : n % 7, status: STATUSES[n % 4], total: (n * 7.25).toFixed(2),
    });
  }
  rows.get(42).status = 'pending';
  return rows;
}

// A statement in the server log: it ends its line, so a refused statement that starts with an allowed one is not found
// in the line of the allowed one.
const call = (statement) => ({ name: statement, marker: `statement: ${statement}\n` });
const count = (rows, status) => [...rows.values()].filter((row) => row.status === status).length;
const rowLine = (row) => `${row.id}|${row.customer}|${row.status}|${row.total}`;

export async function postgresScenario({ checks, agent }) {
  const rows = seeded();
  const reached = [];
  const kept = [];
  const query = (target, statement) => agent.call('postgres_query', { target, query: statement });
  const allowed = async (target, statement, expect, name = `allowed: ${statement}`) => {
    const answer = await query(target, statement);
    checks.check(name, !answer.isError && answer.text.startsWith('exit code: 0') && expect(answer.text), clip(answer.text));
    reached.push(call(statement));
    return answer;
  };
  // A refusal of ksproxy, with the reason that the docs give for it.
  const refused = async (target, statement, why, reason) => {
    const answer = await query(target, statement);
    checks.check(`refused: ${statement} (${why})`, answer.isError && answer.text.startsWith(`REFUSED (postgres ${target}): `)
      && answer.text.includes(reason), clip(answer.text));
    kept.push(call(statement));
    return answer;
  };

  checks.begin('postgres: shop-db, read only (agent_ro)');
  await allowed('shop-db', 'select * from orders where id = 42', (text) => text.includes('id|customer_id|status|total')
    && text.includes(rowLine(rows.get(42))));
  await allowed('shop-db', "select count(*) from orders where status = 'paid'", (text) => text.includes(`count\n${count(rows, 'paid')}`));
  const last = [...rows.values()].filter((row) => row.customer === 7).map((row) => row.id).sort((a, b) => b - a);
  await allowed(
    'shop-db',
    'select id, status, total from orders where customer_id = 7 order by id desc limit 20',
    (text) => text.includes(last.map((id) => `${id}|${rows.get(id).status}|${rows.get(id).total}`).join('\n')),
  );
  await refused('shop-db', "update orders set status = 'paid' where id = 42", 'the target is read-only', 'this target is read-only');

  checks.begin('postgres: shop-db-rw, may set the status (agent_rw)');
  await allowed('shop-db-rw', "update orders set status = 'shipped' where id = 42", () => true);
  rows.get(42).status = 'shipped';
  await allowed('shop-db-rw', 'select * from orders where id = 42', (text) => text.includes(rowLine(rows.get(42))), 'the update changed order 42 to shipped');
  await refused('shop-db-rw', "update orders set status = 'shipped'", 'no rule matches without where id', 'not on the allowlist');
  await allowed(
    'shop-db',
    "select count(*) from orders where status = 'shipped'",
    (text) => text.includes(`count\n${count(rows, 'shipped')}`),
    `the refused update changed nothing: ${count(rows, 'shipped')} orders are shipped`,
  );

  checks.begin('postgres: shop-db-wide, "select ..." on a read-only target');
  // The rule lets the call through; the function writes, and the read-only transaction of the target stops it.
  const write = "select set_order_status(42, 'cancelled')";
  const answer = await query('shop-db-wide', write);
  checks.check(
    `the server refuses ${write}: read-only transaction`,
    answer.isError && answer.text.includes('cannot execute UPDATE in a read-only transaction'),
    clip(answer.text),
  );
  reached.push(call(write));
  await allowed('shop-db', 'select * from orders where id = 42', (text) => text.includes(rowLine(rows.get(42))), 'order 42 is still shipped');

  checks.begin('postgres: a result past the output limit');
  // About 1 MiB of rows: psql is stopped at the read limit, and the answer shows the first 256 KiB of its output, with
  // no end part (a brokered stream never has one).
  const big = "select repeat('x', 1000) from generate_series(1, 1000)";
  const cut = await query('shop-db-wide', big);
  checks.check(
    'psql is stopped at the limit: the line after the exit code says so, then the hint of postgres',
    cut.isError && cut.text.startsWith([
      'exit code: null',
      '[stdout cut at 256 KiB: the rest was left out]',
      'narrow it: fewer columns, a WHERE and a LIMIT, or count(*) first',
      '--- stdout ---',
      '',
    ].join('\n')) && !cut.text.includes(' cut here ...]'),
    clip(cut.text),
  );
  reached.push(call(big));

  checks.begin('postgres: TLS, the certificate checked against caFile');
  // The server says whether the connection of this very call uses TLS.
  await allowed(
    'shop-db-wide',
    'select ssl, version from pg_stat_ssl where pid = pg_backend_pid()',
    (text) => /ssl\|version\nt\|TLSv1\.[23]/.test(text),
    'a call runs over TLS: pg_stat_ssl says ssl t',
  );

  checks.begin('postgres: the statement log of the server');
  const text = await logChecks(checks, {
    file: SERVER_LOG, reached, kept, noun: 'statement',
  });
  checks.check('the read-only targets ran in a read-only transaction', text.includes('statement: SET TRANSACTION READ ONLY'), 'no SET TRANSACTION READ ONLY in the log');
  const authorized = text.split('\n').filter((line) => line.includes('connection authorized: user=agent_'));
  checks.check(
    'every connection of agent_ro and agent_rw used TLS (log_connections: SSL enabled)',
    authorized.length > 0 && authorized.every((line) => line.includes(' SSL enabled (protocol=TLSv1.')),
    authorized.join('\n'),
  );
}
