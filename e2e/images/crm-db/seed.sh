# The seed of the crm database, which the mariadb image sources once, as the user mysql, when the data folder is new
# (docker_process_sql runs the client as root on the server of the setup). The passwords of the two logins are made
# per run by the service make-secrets. Customers 1 to 20: customer N is "Customer N" in the city N mod 4 of the list.
# Tickets 1 to 30: ticket N belongs to customer (N - 1) mod 20 + 1; it is closed and assigned to support when N is a
# multiple of 3, else open and not assigned. The driver computes the same values.
#
# The general log is switched on here, in a setting file, so that only the server of the run writes it: the server
# of this setup runs statements that hold the passwords of root and of the health check, and the log would keep them.

ro=$(cat /secrets/agent_ro_password)
rw=$(cat /secrets/agent_rw_password)

docker_process_sql --database=crm <<SQL
create table customers (
  id integer primary key,
  name varchar(64) not null,
  email varchar(128) not null,
  city varchar(64) not null
);
insert into customers (id, name, email, city)
  select seq, concat('Customer ', seq), concat('customer', seq, '@example.com'),
         elt(seq % 4 + 1, 'Springfield', 'Riverside', 'Fairview', 'Lakeside')
  from seq_1_to_20;

create table tickets (
  id integer primary key,
  customer_id integer not null,
  subject varchar(128) not null,
  assignee varchar(64),
  status varchar(16) not null
);
insert into tickets (id, customer_id, subject, assignee, status)
  select seq, (seq - 1) % 20 + 1, concat('Ticket ', seq),
         if(seq % 3 = 0, 'support', null), if(seq % 3 = 0, 'closed', 'open')
  from seq_1_to_30;

-- A function that writes, for the read-only target with "select ...": the rule lets the call through, and only the
-- read-only transaction of that target stops it. It runs with the rights of the caller.
delimiter //
create function close_ticket(ticket_id integer) returns integer
  sql security invoker modifies sql data
begin
  update tickets set status = 'closed' where id = ticket_id;
  return row_count();
end //
delimiter ;

create user agent_ro@'%' identified by '$ro';
create user agent_rw@'%' identified by '$rw';
grant select on crm.* to agent_ro@'%';
grant select, update (assignee, status) on crm.tickets to agent_rw@'%';
grant execute on function crm.close_ticket to agent_rw@'%';
SQL

printf '%s\n' '[mariadbd]' 'general_log = 1' 'general_log_file = /mylog/general.log' \
  > /etc/mysql/conf.d/90-e2e-general-log.cnf
