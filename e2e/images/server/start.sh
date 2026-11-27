#!/bin/bash
# Starts the ssh server for one login with the keys of this run, which the service make-secrets put in /secrets:
# host_key, authorized_keys, and on web1 also app_key and known_hosts, the key and the host key for the jump to app1.
# $1 is the login: ops on web1, opsuser on app1.
set -euo pipefail
login=$1
home=$(getent passwd "$login" | cut -d: -f6)

install -m 0600 /secrets/host_key /etc/ssh/ssh_host_ed25519_key
install -d -m 0700 -o "$login" -g "$login" "$home/.ssh"
install -m 0600 -o "$login" -g "$login" /secrets/authorized_keys "$home/.ssh/authorized_keys"
for file in app_key known_hosts; do
  if [ -f "/secrets/$file" ]; then
    install -m 0600 -o "$login" -g "$login" "/secrets/$file" "$home/.ssh/$file"
  fi
done
printf 'AllowUsers %s\n' "$login" > /etc/ssh/sshd_config.d/20-login.conf

exec /usr/sbin/sshd -D -e
