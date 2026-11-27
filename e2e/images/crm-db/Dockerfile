# MariaDB for the e2e tests: the crm database of the mysql examples of docs/EXAMPLES.md with its two logins. The
# download here is the image mariadb:11.4. Once the database is set up, the server logs every statement to
# /mylog/general.log (see seed.sh), a volume that the runner reads, so that the driver can show which calls reached the
# server. The log file and the setting file are made here, readable by the runner and writable by the server.
FROM mariadb:11.4

RUN install -d -o mysql -g mysql -m 0755 /mylog \
 && install -o mysql -g mysql -m 0644 /dev/null /mylog/general.log \
 && install -o mysql -g mysql -m 0644 /dev/null /etc/mysql/conf.d/90-e2e-general-log.cnf
COPY seed.sh /docker-entrypoint-initdb.d/10-seed.sh
RUN chmod 0644 /docker-entrypoint-initdb.d/10-seed.sh
