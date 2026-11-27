#!/bin/bash
# The seed of the shop database, run once by the postgres image when the data folder is new. The passwords of the two
# roles are made per run by the service make-secrets. Orders 1 to 60: order N belongs to customer N mod 7 (7 when
# that is 0), has the status pending, paid, shipped or cancelled by N mod 4, and the total N * 7.25. Order 42 of
# customer 7 is pending. The driver computes the same values.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set ro="$(cat /secrets/agent_ro_password)" --set rw="$(cat /secrets/agent_rw_password)" <<'SQL'
create table orders (
  id integer primary key,
  customer_id integer not null,
  status text not null,
  total numeric(10, 2) not null
);
insert into orders (id, customer_id, status, total)
  select n,
         case when n % 7 = 0 then 7 else n % 7 end,
         (array['pending', 'paid', 'shipped', 'cancelled'])[n % 4 + 1],
         n * 7.25
  from generate_series(1, 60) as n;
update orders set status = 'pending' where id = 42;

-- A function that writes, for the read-only target with "select ...": the rule lets the call through, and only the
-- read-only transaction of that target stops it.
create function set_order_status(order_id integer, new_status text) returns void
  language sql as $$ update orders set status = new_status where id = order_id $$;

-- The passwords are not written to the statement log.
set log_statement = 'none';
create role agent_ro login password :'ro';
create role agent_rw login password :'rw';
reset log_statement;

grant connect on database shop to agent_ro, agent_rw;
grant usage on schema public to agent_ro, agent_rw;
grant select on orders to agent_ro, agent_rw;
grant update (status) on orders to agent_rw;
SQL
