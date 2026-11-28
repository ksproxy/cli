# An ssh server for the e2e tests: web1, which the runner reaches, and app1, which only web1 reaches (jumps, and the
# last server of the service tunnels, the only one that allows TCP forwarding: see start.sh). The
# download here is openssh-server from Debian. The host keys of the package are removed: start.sh installs the ones of
# the run.
FROM node:24

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssh-server; \
    rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*; \
    install -d -m 0755 /run/sshd; \
    useradd --create-home --shell /bin/bash ops; \
    useradd --create-home --shell /bin/bash opsuser; \
    usermod --password '*' ops; \
    usermod --password '*' opsuser; \
    install -d -m 0755 /var/log/nginx

COPY server.conf /etc/ssh/sshd_config.d/10-e2e.conf
COPY error.log /var/log/nginx/error.log
# A long log for the check of a cut answer (e2e/driver/ssh.js): 45000 lines of 141 bytes before the lines of error.log,
# 6345599 bytes in all.
RUN set -eux; \
    awk 'BEGIN { for (i = 1; i <= 45000; i++) printf "2026/11/19 08:00:00 [warn] 31#31: *%06d an upstream response is buffered to a temporary file, client: 192.0.2.10, server: web1.example.com\n", i }' \
      | cat - /var/log/nginx/error.log > /tmp/error.log; \
    mv /tmp/error.log /var/log/nginx/error.log
COPY start.sh /usr/local/bin/e2e-start
RUN chmod 0644 /etc/ssh/sshd_config.d/10-e2e.conf /var/log/nginx/error.log && chmod 0755 /usr/local/bin/e2e-start

ENTRYPOINT ["/usr/local/bin/e2e-start"]
