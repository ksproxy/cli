# A service behind a server: exact rules and limits

The README has the short version. This page lists every rule and every limit of `tunnel` on a service target.

A database or a cache often listens only on an internal address that this machine cannot reach, but a server of yours can. By hand you run `ssh -L` in another terminal, or connect to a first server and then to a second one, and point your client at the local end. `tunnel` makes ksproxy do that for the target, inside `ksproxy start`. You write the target as if this machine could reach the service, and `tunnel` says how:

```json
{
  "name": "orders",
  "uriEnv": "ORDERS_MONGO_URI",
  "database": "shop",
  "tunnel": { "host": "bastion1" },
  "allow": ["find orders"]
}
```

With a key that is stored on the first server, add the ssh command that uses it:

```json
{
  "name": "orders",
  "uriEnv": "ORDERS_MONGO_URI",
  "database": "shop",
  "tunnel": {
    "host": "bastion1",
    "jumps": ["ssh -i .ssh/app_key opsuser@192.0.2.10"]
  },
  "allow": ["find orders"]
}
```

**Contents**

- [How a tunnel must be written](#how-a-tunnel-must-be-written)
- [What is sent](#what-is-sent)
- [The order at start and in doctor](#the-order-at-start-and-in-doctor)
- [Ports](#ports)
- [What each kind does](#what-each-kind-does)
- [What each server needs](#what-each-server-needs)
- [Keys limited on the servers](#keys-limited-on-the-servers)
- [Who can read the traffic](#who-can-read-the-traffic)
- [When the shared connection drops](#when-the-shared-connection-drops)
- [Limits](#limits)

## How a tunnel must be written

| Field | Detail |
|---|---|
| `tunnel` | An optional object on a `postgres`, `mysql`, `redis`, `mongodb`, `http`, `elasticsearch` or `rabbitmq` target. Unknown keys are an error. |
| `host` | Required. The first server, written as the `host` of an ssh target: a name from your ssh configuration. |
| `jumps` | Optional. 0 to 5 ssh commands, in order, with the rules of the `jumps` of an ssh target (see [JUMPS.md](JUMPS.md#how-a-jump-must-be-written)). A `~` is refused: a path without a leading `/` starts in the home folder of that login on the server before the jump. |

Rules of the target itself do not change. The service address is the one the target already has: the `host` and `port` of a postgres, mysql or redis target, the one host of a mongodb connection string, and the host and port of the URL of an http, elasticsearch or rabbitmq target (`baseUrl` or `url`), with 80 for `http` and 443 for `https` when the URL names no port. No port is written in the `tunnel`.

An IPv6 service address is allowed only without `jumps`: in a nested command its brackets would be shell characters.

The `tunnel` of a `kubernetes` target is another field with the same name (`host`, `localPort` and `remote`). It is not changed.

## What is sent

The first server is opened once with ssh, as for an ssh target. For each connection to the service, ksproxy then runs one more `ssh` that uses only that shared connection. `-F /dev/null`, `HostName=ksproxy.invalid`, `ProxyCommand=/usr/bin/false`, `IdentityAgent=none`, `IdentityFile=/dev/null` and the options that turn off every login method keep that ssh from reading your ssh configuration, loading a key, asking for a password or opening a connection of its own. The first part of each command below is that isolation. `SOCKET` is the shared connection's socket, in ksproxy's socket folder.

Without jumps, the first server connects to the service (`-W` is a plain byte stream):

```text
ssh -F /dev/null -o ControlPath=SOCKET -o ControlMaster=no -o HostName=ksproxy.invalid -o ProxyCommand=/usr/bin/false -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -W 10.0.0.5:27017 -- ksproxy-tunnel
```

With one jump `ssh -i .ssh/app_key opsuser@192.0.2.10`, the first server runs the jump, and `-W` goes before the last server:

```text
ssh -F /dev/null -o ControlPath=SOCKET -o ControlMaster=no -o HostName=ksproxy.invalid -o ProxyCommand=/usr/bin/false -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -T -e none -- ksproxy-tunnel 'ssh -T -e none -o BatchMode=yes -i .ssh/app_key -o ConnectTimeout=10 -W 10.0.0.5:27017 opsuser@192.0.2.10'
```

With two jumps, `ssh -i .ssh/key1 user1@192.0.2.10` and `ssh -i .ssh/key2 user2@192.0.2.20`, each jump is nested after the `--` of the one before it:

```text
ssh -F /dev/null -o ControlPath=SOCKET -o ControlMaster=no -o HostName=ksproxy.invalid -o ProxyCommand=/usr/bin/false -o BatchMode=yes -o UserKnownHostsFile=/dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o PubkeyAuthentication=no -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -T -e none -- ksproxy-tunnel 'ssh -T -e none -o BatchMode=yes -i .ssh/key1 -o ConnectTimeout=10 user1@192.0.2.10 -- ssh -T -e none -o BatchMode=yes -i .ssh/key2 -o ConnectTimeout=10 -W 10.0.0.5:27017 user2@192.0.2.20'
```

The jump words are your text, with `-T`, `-e none`, `-o BatchMode=yes`, `-o ConnectTimeout=10` added as for the `jumps` of an ssh target. Since this release an ssh target's jumps also get `-e none`. The service address after `-W` is built by ksproxy from the target and checked again: a name or an IPv4 address and a port, or `[IPv6]:port` without jumps. Nothing the agent writes is ever part of these commands.

## The order at start and in doctor

1. **The inventory is read.** The route is checked: the grammar of `host` and `jumps`, and what the kind refuses without a secret (a mysql target with `"tls": "verify"`). A broken route is an inventory error. A `tunnel` on a kind that cannot use one is `this kind cannot use a tunnel`.
2. **The first servers, one at a time, before the first target that has a route.** Each different `host` of this start is opened once, and every target that names it shares that connection, so a password is asked once per server. ssh targets and kubernetes tunnels keep their own connections. When a first server cannot be opened, every target behind it is `SKIPPED` with ssh's failure, usually `ssh exited with code N`; what ssh printed is in your terminal. In `ksproxy doctor` the line is `FAIL`, and it names the first server.
3. **Then each target:** its service address (`tunnelTo`); for postgres, mysql and mongodb the loopback port; then a trial, which is the kind's own fixed read-only check (`select 1`, `PING`, `ping`; for the http kinds see below) run once through the tunnel; then the kind's own `open`. The trial is given 10 seconds for the first server and for each jump, and 10 seconds more. For an `http` target the check is `OPTIONS *` on plain http (a request with no path and no credential; any reply that starts with `HTTP/` is an answer) and only the TLS handshake on https, with the certificate checked against the real host. An `elasticsearch` target sends `GET /_cluster/health` and a `rabbitmq` target `GET /api/whoami`, the fixed request of its `ksproxy doctor` check, with its credential, through the tunnel. The line `OPENING` ends with `, through bastion1` or `, through bastion1, then 1 jump`.
4. **A target that fails is `SKIPPED`** (`FAIL` in `doctor`) with one of these reasons:
   - `ssh exited with code N`, or another failure of that ssh (`the connection did not stay open`): the first server could not be opened.
   - `the route failed: ...`: the trial ended with an ssh error, for example a wrong jump key, a refused jump or a server that forbids forwarding. What follows is ssh's own text, on one line, at most 300 characters, or ksproxy's own reason when no connection could be made (`the shared connection is not open`, or the limit of 8 connections with jumps).
   - `the service did not answer through the tunnel: ...`: the route worked but the service gave no answer, or the check failed.
   - `the loopback port could not be opened: ...`.
   - `the address of the service could not be found`, `the service address must be host:port or [IPv6]:port`, or `an IPv6 service address cannot be used with jumps`: the target gives no address that a tunnel can use.
   - the refusal of the kind, such as the ones under "What each kind does".
5. **While running,** the health check asks the shared connection first. See "When the shared connection drops".
6. **At Ctrl-C,** each target's kind is closed, then its loopback port and its ssh children, then every shared connection. `ksproxy doctor` closes the same things before it removes its temporary folder.

A first server is shared inside one `start`, or inside one project of one `doctor` run. `ksproxy doctor` skips a project that has a live session, as before. `ksproxy check` opens nothing and does not try a route.

## Ports

- **No port is written in the inventory.** For postgres, mysql and mongodb the client is a program, so `start` listens on `127.0.0.1` with a port that the system chooses in that one step. Only the number `127.0.0.1` is given to a client, never `localhost`.
- **`redis`, `http`, `elasticsearch` and `rabbitmq` use no port.** ksproxy's own code makes the connection and uses the ssh stream as its socket.
- The loopback port accepts a connection only while an open, a check or a call of that target is running. A connection is closed when the ones that were running when it was made have ended, also when later calls still run. The port itself is closed after the calls of that target have ended.
- The agent decides how long the port accepts: one call can run up to 600 seconds (and a second more before it is given up), and calls can overlap.
- ksproxy writes the port to no file of the session: not `session.json`, not `AGENT.md`. A client program's own error text can name it. In a call that text is part of the answer to the agent, and the output of a call is never logged. When the trial at `start` fails, that text is in the `SKIPPED` line, in your terminal and in the log; the port is closed by then.
- These ports are not in the list of ports that ksproxy checks across inventory files. The kubernetes `proxyPort` and `tunnel.localPort` are unchanged.
- After a kill with SIGKILL the port is gone with the process, and the ssh children end when their streams close. The next `ksproxy start` closes the shared connection that was left behind.

## What each kind does

| Kind | Through a tunnel |
|---|---|
| `postgres` | `psql` gets `PGHOSTADDR=127.0.0.1` and the loopback port. `--host` is still the real name, so `"tls": "verify"` still checks the certificate against that name. |
| `mysql` | The client gets `--host=127.0.0.1 --port=PORT --protocol=TCP`. Both clients check the certificate's name against the address they connect to, so `"tls": "verify"` is refused in the inventory, and so is a `caFile`, which makes `verify` the default. Leave `tls` out (`prefer`) or write `"tls": "require"` where your client supports it. |
| `redis` | The ssh stream is the socket. With `tls`, the handshake runs over that stream and the certificate is still checked against the real host. |
| `mongodb` | The host of the connection string is replaced as text by `127.0.0.1:PORT`. Any `directConnection` option is replaced by `directConnection=true`, empty options are dropped, and a `/` is added when the string has no path. The rest is kept as written. |
| `http`, `elasticsearch`, `rabbitmq` | The ssh stream is the socket of each request, one stream and one connection for each call. No port is opened. The `Host` header is the real host of the URL. With `https`, the TLS handshake runs over the stream and the certificate is checked against the real host, as without a tunnel. Plain `http` is allowed and gets the WARN line of "Who can read the traffic". A proxy of the environment (`NODE_USE_ENV_PROXY`) is never used for a tunnelled request. |
| `kafka`, `command`, `mcp` | Not supported. Kafka brokers tell clients their own addresses. A `tunnel` on them is `this kind cannot use a tunnel`. |

A mongodb target through a tunnel is refused when it opens (`SKIPPED`), with a reason, when its connection string has: `mongodb+srv`, no host, several hosts, a socket or percent-encoded host, any TLS option (a name that starts with `tls` or `ssl`), `loadBalanced`, a proxy option (a name that starts with `proxy`), an `@` that is not percent-encoded other than the one before the host, or a `/` in the user information that is not percent-encoded. An IPv6 host is refused with jumps. These are checked when the target opens because the connection string is a secret that the inventory does not hold.

## What each server needs

- **The last server** must allow TCP forwarding (`AllowTcpForwarding yes` or `local` in its `sshd_config`) and must reach the service. With jumps, the last server is the last jump.
- **The other servers** need no forwarding, except a server that a jump names with `-J` or `-o ProxyJump=...`: it forwards as a last server does, and the server that runs that jump needs an OpenSSH client 7.3 or later. A server that runs a jump needs to run a command, an OpenSSH client 5.4 or later, and a POSIX shell.
- **A key that a jump uses** must work without a prompt: no passphrase, and the host key already known on the server before the jump.

## Keys limited on the servers

The key that ksproxy uses can be limited in `authorized_keys` on the first server, so that it can do no more than the tunnel. ksproxy's end-to-end tests try both forms below against a real sshd; try yours with `ksproxy doctor`.

Without jumps, allow only the forwarding to the service, and no command. Write the host exactly as the target writes it:

```text
restrict,port-forwarding,permitopen="10.0.0.5:27017",command="/bin/false" ssh-ed25519 AAAA... ksproxy
```

`restrict` alone still lets the key run commands on the server; `command=` stops that, and the forwarding still works.

With jumps, the first server runs one command. Force exactly that command; it is the text that ksproxy sends after `ksproxy-tunnel` (see "What is sent"):

```text
restrict,command="ssh -T -e none -o BatchMode=yes -i .ssh/app_key -o ConnectTimeout=10 -W 10.0.0.5:27017 opsuser@192.0.2.10" ssh-ed25519 AAAA... ksproxy
```

**Such a line limits the key for one route.** One shared connection per first server serves every target behind it, with one key. Without jumps, write one `permitopen=` for the address of each target. With jumps, a forced command serves exactly one route: the server runs it whatever ksproxy sends, so a second target with jumps through the same first server would reach the first target's service, without an error when both speak the same protocol. Give each such route a key of its own: a `Host` name of its own with its own `IdentityFile` in your ssh configuration, used as that target's `tunnel.host`. Do not use a limited key for an ssh target.

ksproxy cannot see or check these lines on your servers. Try the route with `ksproxy doctor` after you change them.

## Who can read the traffic

- **Every server on the route can read and change the traffic, unless the target checks the certificate of the service:** each server decrypts and encrypts again. That includes a password sent in clear and the read-only setting that a SQL client sends at the start.
- The certificate is checked for postgres with `"tls": "verify"`, for redis with `tls`, and for an `http`, `elasticsearch` or `rabbitmq` target with an `https` URL. In the other cases `ksproxy start` and `ksproxy doctor` print one WARN line for the target: `the servers on the route can read and change the traffic: this target does not check the certificate of the service`. A mongodb target through a tunnel always gets it, because TLS options are refused there, and so does an http, elasticsearch or rabbitmq target with a plain `http` URL, which is allowed.
- **TLS stays your choice.** ksproxy never requires it, with a tunnel or without one.

## When the shared connection drops

The health check asks the shared connection of a target first. When it is gone:

- the target is `DOWN`, with the line `the shared connection to bastion1 is gone: the target stays down until ksproxy start is run again`;
- a call is refused with `the connection to this target is down until ksproxy start is run again`, and new connections to its loopback port are closed at once;
- a call that was running fails with its client's own error.

The target stays down until `ksproxy start` is run again. ksproxy does not reconnect and never asks for a password in the middle of a session. Every other target that shares that first server goes `DOWN` at its own next health check; until then a call to it fails with its client's own error.

## Limits

- At most 16 open connections per target that has a loopback port (a connection that is closing, for at most about a second, is not counted), and at most 8 connections with jumps at once over one shared connection, for all its targets together. Beyond that a connection is refused or closed. The 8 keeps under the 10 sessions that sshd allows by default on one connection.
- With jumps, each connection is one session on the first server and a full ssh login on every further hop, so a call takes that much longer.
- The bytes of every connection pass through the `ksproxy start` process.
- The first server's own setup is trusted, as for `jumps`: a start-up file that prints text breaks the stream. The trial at `start` shows it.
- A jump's `-i` path is read on the server before that jump. Each hop gives up connecting after 10 seconds unless you set `-o ConnectTimeout=...`.
- The socket of a shared connection is in the socket folder under the prefix `tnl-`. The length limit of an ssh socket path is checked before anything opens, and so is a clash of two hosts on one socket; either is an error that says so.
- Every call to an `http`, `elasticsearch` or `rabbitmq` target opens its own connection through the tunnel and closes it after the reply. No connection is kept for reuse, so with jumps each call pays the full ssh login of every hop.
- ksproxy tells the agent nothing new: the route is not in `list_targets`, `AGENT.md`, `session.json`, a refusal or the entry of a call in the log. The terminal of `start` and the start lines of the audit log name the first server, as the line of an ssh target does. Two things can still reach the agent in an answer: the error text of a client program can name `127.0.0.1` and the loopback port, and the service can tell its client the address of the last server. See [SECURITY.md](../SECURITY.md#what-is-not-in-scope).
- A jump may use `-J` or `-o ProxyJump=...`, as the `jumps` of an ssh target may. That server then connects through one more server that you named there.
- Who can reach the loopback port and the shared connection's socket: see [SECURITY.md](../SECURITY.md#what-is-not-in-scope).
