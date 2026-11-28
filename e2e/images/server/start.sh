#!/bin/bash
# Starts the ssh server for one login with the keys of this run, which the service make-secrets put in /secrets:
# host_key, authorized_keys, and on web1 also app_key and known_hosts, the key and the host key for the jump to app1,
# and wrong_key, a key that app1 does not accept (for the tunnel with a wrong jump key, e2e/driver/tunnels.js).
# $1 is the login: ops on web1, opsuser on app1; on web1 its authorized_keys also holds the second key of ops, limited
# to one forced command (see e2e/setup/secrets.sh). With E2E_FORWARDING=yes (app1 only) the server allows TCP forwarding,
# which the last server of a service tunnel needs; sshd keeps the first value it reads, so the setting goes in a file
# that comes before 10-e2e.conf, which says "AllowTcpForwarding no".
set -euo pipefail
login=$1
home=$(getent passwd "$login" | cut -d: -f6)

install -m 0600 /secrets/host_key /etc/ssh/ssh_host_ed25519_key
install -d -m 0700 -o "$login" -g "$login" "$home/.ssh"
install -m 0600 -o "$login" -g "$login" /secrets/authorized_keys "$home/.ssh/authorized_keys"
for file in app_key wrong_key known_hosts; do
  if [ -f "/secrets/$file" ]; then
    install -m 0600 -o "$login" -g "$login" "/secrets/$file" "$home/.ssh/$file"
  fi
done
users=$login
# E2E_FORWARD_USER (web1 only): a second login, with the key of /secrets/fwd_authorized_keys, whose line limits it as
# docs/TUNNELS.md says ("Keys limited on the servers"), and which alone may forward TCP on this server. The Match block
# goes at the end of the main file, after every setting for all users.
if [ -n "${E2E_FORWARD_USER:-}" ]; then
  fwd=$E2E_FORWARD_USER
  useradd --create-home --shell /bin/bash "$fwd"
  usermod --password '*' "$fwd"
  fwd_home=$(getent passwd "$fwd" | cut -d: -f6)
  install -d -m 0700 -o "$fwd" -g "$fwd" "$fwd_home/.ssh"
  install -m 0600 -o "$fwd" -g "$fwd" /secrets/fwd_authorized_keys "$fwd_home/.ssh/authorized_keys"
  printf '\nMatch User %s\n  AllowTcpForwarding yes\n' "$fwd" >> /etc/ssh/sshd_config
  users="$users $fwd"
fi
printf 'AllowUsers %s\n' "$users" > /etc/ssh/sshd_config.d/20-login.conf
if [ "${E2E_FORWARDING:-no}" = yes ]; then
  printf 'AllowTcpForwarding yes\n' > /etc/ssh/sshd_config.d/05-forwarding.conf
fi

exec /usr/sbin/sshd -D -e
