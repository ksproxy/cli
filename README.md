# ksproxy

Let AI agents run allowlisted ssh, kubectl, local, database, queue and HTTP API calls without your credentials.

## What it does

ksproxy lets an AI agent run commands on ssh servers and Kubernetes clusters without ever holding a credential, run a short list of commands in a folder on your own machine, and use databases, queues and HTTP APIs (PostgreSQL, MySQL, MongoDB, Redis, Elasticsearch, RabbitMQ, Kafka and any HTTP API), and use the tools of MCP servers, local or remote (see "MCP servers"). You run one command in a terminal, pick the targets, and leave it running; the agent reaches those targets only through a built-in MCP server. Every call is checked against a per-target allowlist that refuses everything by default, every call is logged, and Ctrl-C closes all access.

## What it is for, and what it is not

ksproxy is made for one job: **developing and debugging with an AI agent, safely.** The agent can look at logs, inspect a cluster, read a few rows or check a queue, while you keep the credentials, decide what is allowed, and can read afterwards what was done. Safety comes first: when ksproxy is not sure, it refuses.

It is not a general proxy, a tunnel, or a tool to move data. These limits follow from that purpose:

| Limit | What it means |
|---|---|
| One call, one answer | Every call is one command, request or statement that ends. There is no interactive shell, no open connection between calls, and nothing is streamed. |
| Output is cut at 256 KiB | Each of the two output streams is cut at 256 KiB and the answer says so. A large file or a large result does not pass through; the agent must ask for a piece (`head`, `tail`, `grep`, `limit`, a filter). `maxOutputKiB` in the inventory raises the limit to at most 4 MiB for one target. A large answer fills the agent's context, so raise it only where it is needed. |
| A call has a time limit | 60 seconds by default, 600 at most. The limit stops the program on your machine; a command already running on an ssh server, or a statement on a MySQL server, may go on there until it ends. |
| Small results from databases | MongoDB returns at most 100 documents per call and never leaves a cursor open, so a larger result is read page by page with a filter. MySQL returns at most 1,000 rows. Change streams, `getMore` and other calls that wait or continue are refused. |
| No file transfer | Nothing copies a file to or from a target. |
| Rules match words, not meaning | A rule decides by the words of a call. It does not understand what a command does, so the rights of the account a target uses are the real boundary. Use a read-only account wherever you can. |
| Not a wall against your own user | A process that runs as your user and can inspect processes or read your files can reach what `ksproxy start` holds. Run the agent without a shell of your user, in a sandbox, or as another user. Projects do not change this. |
| macOS and Linux only | Node.js 24 or newer; the `ksproxy` program needs an `env` that knows `-S` (macOS, or GNU coreutils 8.30 or newer). |

The details are in [Security model and limits](#security-model-and-limits) and, for databases, queues and HTTP APIs, in [docs/SERVICES.md](docs/SERVICES.md).

## Install

Requires Node.js 24 or later and `ssh`. `kubectl` is needed only for Kubernetes targets, and `psql`, `mysql` or `mariadb`, `mongosh` and the Kafka client programs only for the kinds that use them. There are no npm dependencies. macOS and Linux only. The `ksproxy` command starts Node through `env -S` with `--disable-sigusr1`, so the system's `env` must support `-S`, as the `env` of macOS and of GNU coreutils 8.30 or later do.

```
npm install -g @ksproxy/cli
```

That puts `ksproxy` on your PATH. To run from a checkout instead:

```
git clone https://github.com/ksproxy/cli.git ksproxy
cd ksproxy
npm link
```

Homepage: https://ksproxy.github.io/cli/ · Source: https://github.com/ksproxy/cli · Releases: [CHANGELOG.md](CHANGELOG.md) · Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## Quick start

1. `ksproxy init` writes a sample inventory to `~/.config/ksproxy/inventory.json` (mode 0600) and prints its path. It never overwrites an existing file.
2. Edit the inventory: your own targets, and an `allow` list for each. A target with no `allow` refuses everything.
3. `ksproxy start` asks which kinds (ssh, kubernetes, local and the service kinds) and which targets to open, opens them (ssh may ask for your password or key passphrase in this terminal), prints a summary, and stays in the foreground printing one line per agent call and per event (see "The log" below). Non-interactive: `--ssh a,b`, `--kube x,y`, `--local p,q`, the flags of the service kinds (see "Databases, queues and HTTP APIs"), `--all`. Run `ksproxy start` with the environment variables that your service targets name. Without a terminal and without one of these flags, `start` exits with an error. Opening a local target only checks that its folder exists and may be used (see "Local targets"); closing it does nothing. `-v` / `--verbose` adds the matched rule and the output sizes to each allowed call.
4. Add the printed MCP config to your agent once. For Claude Code the summary prints the exact line:

   ```
   claude mcp add ksproxy -- <node> --disable-sigusr1 <path to bin/ksproxy.js> mcp
   ```

   The config is the same on every run, so you do this once.
5. Press Ctrl-C when you are done. Every ssh connection and tunnel is closed, every proxy is stopped, `session.json` and the socket folder are removed, and the audit log in `logs/` is kept. The other session files (`ssh_config`, `kubeconfig`, `AGENT.md`, `mcp.json` and the proxy logs) stay until the next `start`.

Other commands: `ksproxy status [--project NAME]` (every live session and each target's state, then the time of the last call and the number of calls this session; exit 0 only when everything is up), `ksproxy log [-n N] [--denied] [--json] [--from ADDRESS] [--project NAME]` (the history, see "The log"), `ksproxy token` and `ksproxy token revoke` (the network token, see "Network access"), `ksproxy check [--project NAME] <flag of the kind> <name> <command...>`, for example `ksproxy check ssh web1 uptime` (see below; for an `mcp` target the word is `mcp`, see "MCP servers"), `ksproxy doctor` (takes the arguments of `start` and checks every target without opening a session, see "Checking your targets with doctor"), `ksproxy mcp [--project NAME]` (the MCP server; your agent starts it, you do not), `ksproxy --help`, `ksproxy --version`. `ksproxy init` and `ksproxy start` take `--project NAME` too. `ksproxy start` also takes `--project a,b` (several projects, see "Projects") and `--listen HOST:PORT`, `--new-token`, `--tls-cert FILE` and `--tls-key FILE` (see "Network access").

Only one session runs at a time for each project, and for the default (no project). `start` refuses while a live session of the same project exists and cleans up a stale one. See "Projects" below.

## Checking your targets with doctor

`ksproxy doctor` tells you, target by target, whether your inventory still works: the credential is there, the target can be reached and opened, and one harmless read succeeds. It changes nothing on any target.

It takes exactly the arguments of `ksproxy start`: `--project` (one name or a list), `--all`, the kind flags, `-v`, `--listen`, `--tls-cert` and `--tls-key`. `--new-token` is accepted and changes nothing. Target names may also be given as plain words (`ksproxy doctor web1 shop-db`). With no selection, doctor checks every target of the selected projects and never shows the picker. It has no flag of its own.

When `ksproxy start` fails, run the same line again with `doctor` in place of `start`. `start` stops at the first problem; doctor goes on and shows all of them in one run. It reports:

- the pre-checks of `start`, in the order of `start`: the inventory of each project loads; no session of the project runs; the `--listen` values are valid; the TLS files can be read and belong together; no other program listens on the address; the token file can be read. A failed pre-check is printed as `FAIL` with the message of `start`. With `--listen`, doctor also opens each address for a moment and closes it again, without making a token.
- each target: doctor reads its credential from the environment, applies the inventory checks and prints the warnings that `start` prints, opens the target the way a session does, runs **one fixed, read-only check** of its kind, and closes it. Targets are checked one after another. The check is fixed by ksproxy; it is never taken from your `allow` rules, and it is never sent to the model reviewer.

| Kind | The check |
|---|---|
| `ssh` | The connection opens. Nothing is run on the server. |
| `kubernetes` | `GET /version` through the opened proxy. |
| `local` | The folder checks. |
| `http` | The host answers on its port (TLS for https). No request is sent. |
| `command` | The program is found. Nothing is run. |
| `elasticsearch` | `GET /_cluster/health` |
| `rabbitmq` | `GET /api/whoami` |
| `redis` | `PING` |
| `postgres`, `mysql` | `select 1` |
| `mongodb` | The `ping` command. |
| `kafka` | List the topics. |
| `mcp` | The server starts and its tools are listed. A local server is never called; see "MCP servers". |

A kind with no check of its own is `OK` once it has opened. Each target has its open time limit and then 30 seconds for the check, so a dead host does not hang the run. Ctrl-C stops the run, closes what is open and exits 1.

```text
$ ksproxy doctor
10:00:01 --   inventory  OK              loaded /home/someone/.config/ksproxy/inventory.json
10:00:01 --   session    OK              no session is running
10:00:01 ssh  web1       OK              connected
10:00:02 kube lab        OK              server v1.31.2
10:00:02 loc  infra      OK              folder checks passed
10:00:03 pg   shop-db    OK              select 1 answered
10:00:03 rds  cache      OK              PONG
10:00:04 es   es-logs    FAIL            HTTP 401 from GET /_cluster/health: authentication failed
5 of 6 targets OK
```

Each line has the format of the log: `OK` or `FAIL` and a short detail, cleaned, with every secret value hidden. The lines that `start` would print while it opens a target (`WARN`, `SKIPPED`) are printed too. With several projects each line starts with `[NAME] `, as in `start`. The last line is `N of M targets OK`.

Exit code: 0 when every checked target is `OK`, 1 otherwise, 2 for a usage error.

- **A project with a running session** is reported as `FAIL` (`a session of project NAME is running`, with its process number) and its targets are not opened, because a session holds fixed ports and the socket folder. Other projects of the same run are checked. To look at a running session, use `ksproxy status`.
- **It writes nothing a session writes.** It uses a temporary socket folder of its own and removes it at the end. If doctor is killed before it can remove the folder, the next `ksproxy doctor` or `ksproxy start` stops the cluster proxies and ssh connections left in it and removes it; a folder left empty by a doctor killed while it was making it is removed once it is five minutes old. It never writes `session.json`, the call socket or the agent files, so no agent can reach a target through it, and it writes nothing to the audit log.
- **It does contact every checked target** with your credentials, with the one read of its kind. It does not run your `allow` rules (use `ksproxy check` for that) and it repairs nothing.

## Projects

A project is a set of targets for one agent, kept in its own inventory file. Use projects when two agents work in two repositories at the same time and each should be offered only its own targets. Nothing changes for you if you never pass `--project`.

1. `ksproxy init --project shop` writes a sample to `~/.config/ksproxy/projects/shop.json` (folder mode 0700, file mode 0600). The file has the same format as `inventory.json`, with its own `reviewers`. It never overwrites a file.
2. `ksproxy start --project shop --all` opens the targets of that file only. The picker, `--all` and the kind flags choose among them. The session files and the log are in `~/.ksproxy/p/shop/`. If the file is missing, `start` says `inventory not found: <path>; run: ksproxy init --project shop`.
3. The MCP config and the Claude Code line that `start` prints end with `mcp --project shop`. Add them to the MCP configuration of the repository of that agent:

   ```
   claude mcp add ksproxy -- <node> --disable-sigusr1 <path to bin/ksproxy.js> mcp --project shop
   ```

   `ksproxy mcp --project shop` reads only the session of `shop`. With no live session every tool answers `No active session. Ask the user to run` and the command `ksproxy start --project shop`.

`ksproxy start --project shop,ops --all` runs several projects in one process and one terminal. `--project` takes a comma-separated list only for `start`. Each project runs as a separate `start` would: its own inventory file, state folder, session, log and health checks. Before anything opens, `start` checks every project, and if one check fails, nothing opens and `start` exits 1 with the message of the first failure. With several projects, every output line starts with `[NAME] `, such as `[shop] `. The kind flags, such as `--ssh a,b`, need a single project. Without `--all`, the picker runs once per project in a terminal; outside a terminal, several projects need `--all`. When one project stops, all of them stop, and `start` exits 1.

The name `default` means the default inventory (`inventory.json`) wherever `--project` is accepted: `--project default,shop` runs the default inventory and `shop`, and `--project default` is the same as no `--project`. So `default` is not the name of a project, and `ksproxy init --project default` writes `inventory.json`. No command uses `projects/default.json` as a project, but ksproxy still reads it, so that the files it protects stay protected and its ports stay taken. While a project named `default` still exists (a file `projects/default.json` in the config folder, or a folder `p/default` in the state folder), every command given `--project default` is refused with `--project default now means inventory.json, but an old project named default is still here (PATH); rename it, for example to default-old, and update its agent configs`, where PATH is the file or the folder.

A project name is 1 to 24 characters: lower-case letters, digits, `-` and `_`, starting with a letter or a digit. It is short because it is part of every socket path. Any other name is a usage error (exit 2). Only the flag chooses a project; an environment variable of your shell never does.

Sessions of different projects, and the default session, run at the same time. Each has its own ssh connections, proxies, sockets, working folders and log. `ksproxy status` without `--project` lists every live session, the default first, then each project by name, under `session pid N, started T` or `project shop: session pid N, started T`. It exits 0 when at least one session is live and every target is up. With `--project shop` it shows that session only, and with none live it says `no session — run: ksproxy start --project shop`. `ksproxy log --project shop` shows the log of that project; without `--project` it shows the default log. `ksproxy check --project shop ssh web1 uptime` reads the file of that project, and there `--project` must come before the kind.

Nothing is shared between two project files. A target written in two files is opened twice, once for each running project. A Kubernetes port, `proxyPort` or `tunnel.localPort`, may be named in one inventory file only, because the port is what ties a cluster to its proxy. When another inventory file, or a live session of another project or of the default, names the same port, `start` skips that cluster with `port 8001 is also used by project ops; give each project its own port`, so a call through one project never reaches the cluster of another. When another inventory file cannot be read or is not valid JSON, `start` skips every cluster with `cannot read <file> to check its ports`. `ksproxy init`, with or without `--project`, writes a sample whose ports no other inventory file and no live session uses. A project is not a wall between your own agents: see [SECURITY.md](SECURITY.md).

An agent on another machine can use a project of this machine over ssh only with a key that is limited to that one command. Put the options `restrict,command="<node path> --disable-sigusr1 <path to bin/ksproxy.js> mcp --project shop"` before that key in `~/.ssh/authorized_keys` of this machine; then the MCP command of the other machine is `ssh <this machine>`, and the key can run nothing else. Without those options the other machine gets a full shell of this user, which reaches the credentials and sockets of every project. This ssh way needs no network port of ksproxy. The other way, with a port and a token, is described in "Network access" below.

## Network access

By default ksproxy opens no network port. With `--listen`, `ksproxy start` also serves its projects over HTTP, so that an agent on another device of your local network, or on this machine, can use them. Everything runs in one terminal:

```
ksproxy start --project shop,ops --all --listen 192.168.1.20:7443 --listen 127.0.0.1:7443
```

- **Addresses.** `--listen` may be given several times. The host must be an IP address (IPv6 in brackets, such as `[fd00::5]:7443`), never a name, and it must be a loopback or private address of this machine. `0.0.0.0`, `::` and every other address are refused before anything opens. Only one `start` with `--listen` runs at a time.
- **URLs.** `POST http://192.168.1.20:7443/p/shop/mcp` reaches the project `shop`; `/mcp` reaches the default project. A project that this `start` does not run answers `404`. Only Claude Code and other MCP clients that can send a token in a header are served, not the Claude app.
- **The client line.** When `start` makes a token, it prints it once, with one line per project:

  ```
  claude mcp add --transport http ksproxy-shop http://192.168.1.20:7443/p/shop/mcp --header "Authorization: Bearer ksp_…"
  ```

  The default project is `ksproxy-default`, with the URL `http://HOST:PORT/mcp`. Run the line on the machine of the agent. Any listen address works in it.
- **The token.** There is one token for every project of that `start`. It is valid for one year, or until it is revoked or replaced. Only its SHA-256 is kept, in `listen/token.json` in the state folder. `ksproxy token` shows when it was made, when it expires, whether it is revoked and when and from where it was last used, never the token. `ksproxy token revoke` revokes it at once from any terminal. A new token is made, and shown, only when the output of `start` is a terminal: type `new-token` and Enter, or start with `--new-token`. If the output is a file or a pipe and a new token would be needed, `start` refuses before anything opens with `a new token is shown only on a terminal: run this start once with its output on a terminal`, and a typed `new-token` then prints `[listen] a new token is shown only on a terminal`. The old token stops at once. A later `start` prints only `token from 2026-11-22, expires 2027-11-22`. In the last 30 days `start` warns that the token expires.
- **Plain HTTP is the default.** Anyone who can record the traffic of that network can read the token and every answer. On a shared network use TLS with your own certificate: `--tls-cert FILE --tls-key FILE` (both or neither, only with `--listen`). A pair that does not belong together is refused before anything opens with `--tls-cert and --tls-key cannot be used together: MESSAGE`. The URLs then start with `https`. The key file is read once, and a local target can never reach it. `ksproxy check` cannot know about this file.
- **Whoever holds the token can use every project of that `start`**, with the rules of each target, until you revoke or replace it. Keep it as you keep a password.
- **What the listener refuses.** A request with an `Origin` header; a `Host` header that does not name the listen address; a missing, wrong, revoked or expired token (`401`); an address with 10 wrong tokens in a minute is blocked for a minute (`429`); a body over 256 KiB; more than 64 open connections, or more than 16 from one address; a new call while 16 calls are running (`503`, try again soon). A request must arrive within 10 seconds, and a connection that is idle is closed after 60 seconds. Every rule, refusal, review and limit of `ksproxy mcp` applies to these calls unchanged.
- **Seeing who is connected.** The `start` terminal prints `[listen] 192.168.1.31 claude-code 2.1 connected` when an address first sends a valid request, and `[listen] refused 3 wrong tokens from 192.168.1.50` after wrong tokens. The terminal shows at most 10 such lines a minute; further addresses are summed up in one line, `[listen] refused 12 wrong tokens from 4 other addresses`. The lines `[listen] cannot listen: …` and `[listen] cannot make a new token: …` go to stderr. `ksproxy status` shows the listen addresses, the token and each client with its last call and number of calls. Every logged call from the network carries the address, shown as `from ADDRESS`; `ksproxy log --from 192.168.1.31` shows only those entries. The address and the client name are information, not proof (see [SECURITY.md](SECURITY.md)).
- **Stopping.** Ctrl-C, or closing the terminal, ends every running call, including calls that came over the network: the listener stops their programs and waits at most 5 seconds for them.
- **Run it in the foreground.** `start --listen` must run in the foreground of a terminal. As a background job (`&`) it is stopped by the system when it reads the terminal for `new-token`. To run it without a terminal, give it none on stdin (`ksproxy start --listen … < /dev/null`), and make the token first, in a terminal.
- **Private is about addresses, not about who is near.** A private address on a VPN or overlay interface reaches every peer of that network. A link-local address on an interface such as `awdl0` or `llw0` on macOS can reach nearby Apple devices that are not on your network. Choose the addresses with care, and keep the token secret in every case.
- **If the token file cannot be read,** `start --listen` stops with `cannot read FILE: start with --new-token to replace it`.

## Inventory reference

`inventory.json` lives in `$KSPROXY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ksproxy`, else `~/.config/ksproxy`. The file of a project has the same format and lives in the `projects` folder there, as `projects/NAME.json` (see "Projects").

```json
{
  "ssh": [
    {
      "name": "web1",
      "host": "web1.example.com",
      "description": "production web box",
      "allow": ["systemctl status *", "journalctl -u myapp ...", "df -h"]
    }
  ],
  "kubernetes": [
    {
      "name": "lab",
      "kubeconfig": "~/.kube/lab-agent.yaml",
      "proxyPort": 8001,
      "tunnel": { "host": "bastion.example.com", "localPort": 16443, "remote": "127.0.0.1:6443" },
      "manifestRoots": ["~/projects/lab/manifests"],
      "description": "lab cluster",
      "allow": ["get ...", "describe ...", "logs ...", "rollout status ...", "apply -f *"]
    }
  ],
  "local": [
    {
      "name": "infra",
      "cwd": "~/projects/infra",
      "description": "terraform repo",
      "allow": ["git status", "git log --oneline -n * ...", "terraform plan", "ls -l ..."]
    }
  ]
}
```

Any validation failure is an error that names the entry and the field. Unknown keys anywhere are errors, so a typo cannot silently drop a restriction.

| Field | Rule |
|---|---|
| top level | An object with optional `ssh`, `kubernetes`, `local` and service-kind arrays (see "Databases, queues and HTTP APIs"), `mcp` (see "MCP servers"), and `reviewers`. |
| `reviewers`, `review` (optional) | Model review of commands no rule matches. See "Model review (optional)". |
| `name` | `^[a-z0-9][a-z0-9-]{0,30}$`, unique within its kind. |
| `ssh[].host` | An ssh destination your own ssh config resolves. `^[A-Za-z0-9][A-Za-z0-9._@-]*$`; it may not start with `-`. |
| `ssh[].jumps` (optional) | ssh targets only. 1 to 5 ssh commands that follow `host`, in order, for a server that only the first one can reach. Each is `ssh`, then any of `-i -p -l -J` or `-o Key=Value` (listed settings only) with a value as a separate word, then one server. `allow` must be a list, not `"any"`. See "A server behind another server". |
| `kubernetes[].kubeconfig` | A path; `~/` is expanded. It is your real kubeconfig for that cluster and is read only by `kubectl proxy`. |
| `proxyPort`, `tunnel.localPort` | Integers 1024-65535, unique across the whole file, and not named in any other inventory file (see "Projects"). |
| `tunnel` (optional) | `host` as above; `remote` is `host:port`. When present, point the kubeconfig's server at `https://127.0.0.1:<localPort>`; the tool does not verify this. |
| `manifestRoots` (optional) | Absolute or `~/` directories. The only places `-f` and `--patch-file` may read a single file from. |
| `local[].cwd` | The folder the commands run in. Required; absolute or `~/`. It is never shown to the agent. |
| `local[].protect` (optional) | Local targets only. Up to 50 files and folders inside `cwd` that no wildcard argument or argument sent to the model reviewer may name, enter or contain. Plain paths relative to `cwd`, no patterns. See "Local targets". |
| `local[].paths` (optional) | Local targets only. Up to 50 files, folders and patterns inside `cwd` that every path of a call must lie inside: a wildcard argument of a rule, a path of a listed program, a path of a reviewed command. See "Listed programs inside chosen paths". |
| `local[].programs` (optional) | Local targets only. Up to 50 bare program names that may run with any arguments inside `paths`; it needs `paths`. See "Listed programs inside chosen paths". |
| `description` (optional) | A string shown in the selection list and to the agent. |
| `maxOutputKiB` (optional) | Any kind of target. The output limit of each of the two streams of a call, in KiB: an integer from 256 to 4096. Without it the limit is 256 KiB. It only raises the limit for this target; `list_targets` and `AGENT.md` show it when it is not 256. The agent cannot ask for more. |
| `allow` | An array of rule strings, or the string `"any"`. Missing means an empty list, which refuses everything. `start` warns for each selected target with an empty list; the warning is printed before the target is opened, even if the target is then skipped. `"any"` is an error for `local` targets: list the commands, and every `local` rule must start with the program name (not `*` or `...`), or list programs with `programs` and `paths` (see "Listed programs inside chosen paths"). |

State is kept in `~/.ksproxy` (override: `KSPROXY_STATE_DIR`). Keep that path short: unix socket paths are limited in length, and `start` fails with a clear message if one would exceed 100 bytes, or 83 bytes for the socket of an ssh connection or a cluster tunnel, because ssh first creates that socket under a name 17 bytes longer. Directories are created 0700 and files 0600. `ssh` and `kubectl` are found on `PATH`; `KSPROXY_SSH` and `KSPROXY_KUBECTL` override them with absolute paths. `KSPROXY_PSQL`, `KSPROXY_MYSQL` and `KSPROXY_MONGOSH` do the same for the database clients.

## Allowlist rules

A rule is whitespace-separated tokens, matched against the command's arguments.

| Token | Matches |
|---|---|
| a literal | an argument equal to it |
| `*` | exactly one argument that does not start with `-` (in a local rule: one plain name or relative path; in a `postgres` or `mysql` rule: one value, a number such as `-1` or `1.5` or one string in single quotes, never a name) |
| `...` | zero or more arguments of any shape; only legal as the last token (in a local, `command` or `kafka` rule: never a word that starts with `-`; in a local rule also only plain names and relative paths: write every flag into the rule) |
| `\*` | only the argument `*`, a literal star |
| `regex(...)`, as the whole rule | the whole command matches the pattern |

An empty rule, or `...` anywhere but last, is an inventory error. For the service kinds the words are those of a request, a SQL statement, a Redis command and so on; see [docs/SERVICES.md](docs/SERVICES.md). Examples:

- `df -h` allows exactly `df -h`, and nothing else (not `df`, not `df -h /`).
- `systemctl status *` allows `systemctl status nginx`, not `systemctl status` and not `systemctl status --all`.
- `journalctl -u myapp ...` allows `journalctl -u myapp --since today -n 50`, not `journalctl -u other`.
- `get ...` (Kubernetes) allows `get pods -A` and any other `get`.
- `apply -f *` (Kubernetes) allows `apply -f <one path>`; the path must also sit inside `manifestRoots`.
- `get pods -l \*` (Kubernetes) allows `get pods -l *` and nothing else in that place.
- `regex(systemctl status (nginx|redis))` allows `systemctl status nginx` and `systemctl status redis`, not `systemctl status nginx --all`.

A regex rule is tried on the command's words joined by single spaces and must match all of it, with or without `^` and `$`. It has no flags and is not tried on a command longer than 1000 characters. Kubernetes arguments can hold spaces; they are still joined by single spaces. A rule is either words or one `regex(...)`, never both: `regex(` inside a word rule is an inventory error, and so is an empty pattern or one that does not compile. The strict tokenizer and the fixed refusals run first, so a regex rule cannot allow what they refuse.

A regex rule matches exactly what its pattern says, unlike `*`, which never matches an option. So `\S+` and `.*` also match an option such as `-delete`: `regex(find /srv/app \S+)` allows `find /srv/app -delete`. Write `[^-\s]\S*` for "one word that is not an option". On `command` and `kafka` targets it is the other way round: a regex rule allows a word that starts with `-` only when the pattern holds that exact word, so `\S+` never matches `-x` there.

In the inventory file a backslash is written twice, because JSON uses it too: `"get pods -l \\*"`, `"regex(\\./run\\.sh)"`.

A pattern with a backreference, a repeat around a group that holds a repeat or `|`, such as `(a+)+`, or two repeats in a row that can match the same character, such as `.*.*` or `\S*\S*`, gets a warning from `ksproxy start` and `ksproxy check`: `allow[N]: this pattern can be very slow on some inputs`. The rule still works. Every match of a regex rule stops after 100 ms: a match that takes longer counts as no match, and the refusal says which rule took too long.

On a local target a regex rule must start with the program name, written literally (`\.` for a dot). When it matches, the first word must be that program, and every other word is checked like a word matched by `*`. So a regex rule there never allows a flag.

**ssh commands** arrive as one string and are tokenised strictly: at most 4096 bytes, trimmed, split on runs of spaces or tabs, and the first token may not start with `-`. Every character of every token must be one of `A-Z a-z 0-9 _ @ % + = : , . / -`. Everything else is refused and named in the error: quotes, `; | & $ \` ( ) { } < > * ? [ ] ! # ~ \`, newlines, control characters and non-ASCII. The tokens are matched against the rules and the remote command is the tokens joined by single spaces, so no shell syntax can be present.

`"allow": "any"` on an ssh target skips tokenising and matching, and the command is sent as written, so pipes and redirects work. It must still be non-empty, at most 4096 bytes, free of control characters (a tab is allowed), and not start with `-`. On a Kubernetes target `"any"` still goes through the hard refusals below.

**Local commands** arrive as one string and go through the same strict tokeniser as ssh commands, then through the checks in "Local targets".

**Kubernetes arguments** arrive as an array and run locally without a shell. Each must be a non-empty string of at most 4096 bytes with no control characters. They are matched after the kubectl allowlist described below.

A refusal names the target and lists its rules, so the agent can adapt.

Test a rule without opening anything:

```
ksproxy check ssh web1 systemctl status nginx     # ALLOWED by rule: systemctl status *   (exit 0)
ksproxy check ssh web1 rm -rf /                   # REFUSED: ...                            (exit 1)
ksproxy check kube lab get secrets                # REFUSED: secret resources are never allowed
ksproxy check local infra git status              # ALLOWED by rule: git status
```

Exit 0 is allowed, 1 is refused, 2 is a usage or inventory problem. For a command that no rule matches on a reviewed target, `check` prints `NOT ON THE ALLOWLIST: a running session asks reviewer "<name>"` and exits 1. It never calls a model.

## A server behind another server

Some servers are only reachable from another server, with a key that is stored there. `jumps` lists the ssh commands you would type after connecting to `host`:

```json
{
  "name": "app1",
  "host": "bastion1",
  "jumps": ["ssh -i .ssh/app_key -o LogLevel=ERROR opsuser@192.0.2.10"],
  "allow": ["uptime", "systemctl status *"]
}
```

`ksproxy start` opens the connection to `host`. For the call `uptime`, ksproxy sends exactly this over it, and `uptime` runs on the last server:

```
ssh -T -o BatchMode=yes -i .ssh/app_key -o LogLevel=ERROR -o ConnectTimeout=10 opsuser@192.0.2.10 -- uptime
```

- The agent's words come after `--`. They cannot become options of that ssh or start another command on the first server.
- `"allow": "any"` is refused on such a target.
- The tools never show the jump text to the agent. `ksproxy check ssh app1 uptime` shows you the exact string.
- Do not also list the first server as a target, unless you want the agent to run commands on it.

Before you rely on it:

- The key must work without a prompt: no passphrase, and the host key already known on that server.
- `-i .ssh/app_key` is read on the server before the jump, starting in that login's home folder. `~` is not accepted.
- `-o LogLevel=ERROR` keeps ssh's own notices, which can name the inner address, out of the output.
- The first server's own setup is trusted: its shell start-up files and ssh configuration decide what `ssh` does there.

More than one jump, the accepted options and every limit are in [docs/JUMPS.md](docs/JUMPS.md).

## Model review (optional)

When no rule matches a command, ksproxy can ask a model if the command fits a policy you wrote, instead of refusing it. It is off by default and set per target. Any provider with an OpenAI-compatible chat API works.

```json
{
  "reviewers": {
    "groq": {
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "<model id>",
      "keyEnv": "GROQ_API_KEY"
    }
  },
  "ssh": [
    {
      "name": "web1",
      "host": "web1.example.com",
      "allow": ["uptime", "df -h"],
      "review": {
        "reviewer": "groq",
        "policy": "read-only diagnostics, no restarts, no file contents",
        "accept": ["sure"]
      }
    }
  ],
  "local": [
    {
      "name": "infra",
      "cwd": "~/projects/infra",
      "allow": ["git status"],
      "review": { "reviewer": "groq", "policy": "read-only", "programs": ["ls", "wc"] }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `reviewers.<name>.baseUrl` | `https://`, or `http://` for localhost only. |
| `reviewers.<name>.model` | The model id. |
| `reviewers.<name>.keyEnv` | Optional. The environment variable that holds the API key when you run `ksproxy start`. It may not be a variable the session needs (`PATH`, `HOME`, `SSH_*` and similar). It is removed from the environment of every program the session starts. |
| `reviewers.<name>.timeoutSeconds`, `maxCalls` | Optional. Defaults 10 and 200 calls per session. Failed calls count. |
| `review.reviewer` | A name from `reviewers`. |
| `review.policy` | What the agent may do, in plain words. Up to 1000 characters. |
| `review.accept` | Optional. `sure`, `likely` or both. Default `["sure"]`. |
| `review.programs` | Local targets only, required there. The programs the model may approve. |

How a command is handled:

1. Fixed refusals and your `allow` rules run first. A match runs the command and the model is not asked.
2. If no rule matches and the target has `review`, ksproxy checks that the command may be reviewed at all. If not, it is refused, and the refusal says why it was not reviewed.
3. The model answers allow or refuse, and how certain it is: sure, likely or unsure. The command runs only on allow with a certainty listed in `accept`.
4. Anything else is a refusal: a timeout, a bad answer, a missing key, a spent call budget, a review service that does not answer.

What is never sent to the model:

| Target | Not reviewed |
|---|---|
| All | More than 64 words, a word longer than 200 characters, or a word with a space, a control character or a double quote. In SQL a comma or a bracket is a word. |
| ssh | A first word with `=`, such as `VAR=x uptime`. |
| kubernetes | Any verb that is not a read verb (`get`, `describe`, `logs` and similar). |
| local | A program that is not in `programs`, a flag with a value (`--format=x`), a path outside the folder. |

Put such a command on the allow list if you need it.

The key is read only from the environment of `ksproxy start`. It is never written to a file or a log. A reviewed call in the log:

```
14:02:11 ssh  web1       ok       0.4s journalctl -u k3s -n 50  (model: read-only log view)
14:02:40 ssh  web1       DENIED        systemctl restart k3s  [model refused: restarts a service]
14:03:30 ssh  web1       DENIED        ps aux  [review failed: reviewer timed out]
```

### What review cannot do

- The model judges the words of a command, not what it does. `cat notes.txt` looks harmless even when the file holds a password.
- The agent writes the command, so it can try to make a harmful one look harmless. Keep write commands on the allow list.
- The command, the policy and the target name go to the provider. Output and credentials do not. A local model avoids even that.
- On a local target the model decides which flags are fine. Do not list a program that starts other programs or writes outside the folder: `find`, `xargs`, `env`, `make`, `git`, interpreters.
- The model's reason is not in the tool's reply, but it is in the audit log. An agent that can read ksproxy's state folder can read it there.
- A reviewer on `localhost` is whatever program listens on that port.

Every check, message and limit is in [docs/MODEL-REVIEW.md](docs/MODEL-REVIEW.md).

## What Kubernetes commands are available

The kubectl gate is an allowlist: a verb, flag or spelling that is not on a built-in list is refused. It applies before your per-target `allow` rules and also when `allow` is `"any"`.

- **Verbs.** The verb must be the first argument; flags go after it. Available verbs: `get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `api-versions`, `version`, `events`, `auth` (only `auth can-i` and `auth whoami`), `cluster-info`, `apply`, `create`, `delete`, `patch`, `replace`, `rollout`, `scale`, `autoscale`, `label`, `annotate`, `set`, `expose`, `wait`, `diff`, `cordon`, `uncordon`, `drain`, `taint`. Anything else, including plugins and `exec`, `cp`, `port-forward`, `proxy`, `debug`, `config`, `edit`, `run`, `kustomize` and `completion`, is refused.
- **Flags.** Only flags on a built-in list are accepted; anything else is refused. That covers identity and target flags (`--kubeconfig`, `--context`, `--server`, `--token`, `--as`, ...), local-file flags (`--from-file`, `--from-env-file`, `--template`) and debugging flags (`-v`, `--profile`, `--cache-dir`, `--kuberc`). Underscore spellings (`--from_file`) are treated as their dash form. Write short flags separately (`-o json`, not `-ojson`); a bare `--` is refused.
- **Output formats.** `-o` and `--output` accept only `json`, `yaml`, `wide`, `name`, `jsonpath=...`, `jsonpath-as-json=...` and `custom-columns=...`. The `...-file` variants and Go templates are refused.
- **Manifest flags.** `-f`, `--filename` and `--patch-file` (as `flag value` or `flag=value`; `-f` is not checked for `logs`, where it means follow): the value must be one regular file whose real path is inside one of the target's `manifestRoots`. URLs, `-` (stdin), `..` escapes, symlinks that leave the root, and any path when no `manifestRoots` is configured are refused. Directories are refused because kubectl would walk them and follow symlinks that leave the root, which the path check cannot see. `-k` and `--kustomize` are not available because kustomize can fetch remote bases with your git credentials and read outside the root. `apply edit-last-applied` is refused because it opens an editor.
- **Specific refusals.** `create token` (it would hand out a credential), `cluster-info dump`, and secret resources: any argument that, split on `,`, has a part matching `^secrets?([./]|$)` (case-insensitive), including after an `=`.
- **Arguments.** Every argument must be a non-empty single-line string of at most 4096 bytes with no control characters.

`kubectl proxy` itself also rejects the API paths for pod exec, attach, port-forward, secrets and service account tokens. These are a second lock. Kubernetes RBAC on the identity behind your kubeconfig is the boundary.

## Local targets

A `local` target lets the agent run a short list of commands in one folder on your own machine, through the `local_exec` tool.

It is the riskiest kind of target: the command runs as you, on the machine that holds your keys. Keep its allow list short.

```json
{ "name": "infra", "cwd": "~/projects/infra", "allow": ["git status", "ls -l ...", "cat *"], "protect": ["secrets"] }
```

### What is checked on every call

| Check | What it means |
|---|---|
| No shell | Only plain words get through: no quotes, pipes, redirects, `$` or `~`. The program is started directly. |
| You choose the program | Every rule starts with a program name that you wrote. |
| You choose the flags | `*` and `...` match plain names and relative paths only, never a flag. Write each flag into the rule: `ls -l ...`. |
| Paths stay in the folder | A path matched by a wildcard may not contain `..`. Links are followed first, and the result must be inside `cwd`. |
| Secrets stay closed | Neither a wildcard nor an argument sent to the model reviewer may name a path you listed in `protect`, or a name that usually holds secrets (`.env`, key files, `terraform.tfstate`). |
| ksproxy's files are off limits | Its state and configuration folders, and the kubeconfig and Kafka client files named in any of your inventory files (the default and every project file), can never be reached. |
| Small environment | The program gets only `PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`. A file in the folder never replaces a system program of the same name. |

The first check that fails refuses the call, with a short reason in the log.

### Good to know

- **Folders that cannot be a target:** the filesystem root, your home directory or a parent of it, ksproxy's own folders, and a folder that contains a kubeconfig or Kafka client file named in any of your inventory files. Such a target is `SKIPPED`; `ksproxy check local <name>`, or `ksproxy check --project NAME local <name>` for a target of a project, tells you why, and a refused call tells the agent to ask you for that same command. When another inventory file cannot be read or is not valid JSON, the files it names are not known, so every local target is `SKIPPED` with `cannot read <file> to protect the files it names`, and `ksproxy check` refuses the same way.
- **One file outside the folder:** write it into a rule as it is, for example `cat /etc/hosts`. That allows exactly that command.
- **To open one secret-looking file anyway:** write it into a rule as it is, for example `cat .env.production`. `.env.example`, `.env.sample`, `.env.template` and `.env.dist` are not treated as secrets.
- **`"allow": "any"` is refused** for local targets. List the commands, or list programs with `programs` and `paths` (see "Listed programs inside chosen paths").

### What the checks cannot do

- They see the arguments, not what a program opens by itself through its own configuration or includes.
- A recursive command (`grep -r`, `ls -R`) reads the whole folder, and one that follows links can leave it.
- The secret name check looks only at the argument's own path. `grep -r x .` still reads a secret-looking file below it unless that file is in `protect`. `git diff` and `git log -p` print a tracked secret without naming it. Output is not scrubbed.
- Some programs run code they find in the folder: `git` hooks, `make`, `npm` scripts, `terraform plan`.
- A rule that writes files, together with a rule that runs a file from the folder, lets the agent run its own code.
- Whatever you write literally in a rule is allowed exactly as written.

Allow only programs and flags you would run on that folder yourself. The exact rules, limits and refusal messages are in [docs/LOCAL-TARGETS.md](docs/LOCAL-TARGETS.md).

### Listed programs inside chosen paths

**What this means, plainly.** With a `programs` list, the agent can run the programs you name with any flags and arguments, as you, on this machine, as long as every path the command names is inside the `paths` you chose. You name programs, not command patterns. A program can do more than its arguments say: the agent can, for example, write a file and then have another program read that file as instructions. Name only programs you would let the agent use freely on that folder.

```json
{ "name": "docs", "cwd": "~/projects/shop",
  "programs": ["cat", "grep", "sed", "ls", "head", "wc"],
  "allow": ["git status", "git diff ..."],
  "paths": ["docs", "README.md", "assets/*.png"], "protect": ["docs/private"] }
```

- **`programs`** is a list of 1 to 50 bare program names: letters, digits and `_ . + -`, not starting with `-`, and no `/`, with no repeats. It needs `paths`. The first word of a call must be exactly one of the names (`CAT` is not `cat`). The program is found on the clean `PATH`, so a file in the folder never replaces it, and a program given as a path (`./run.sh`, `/usr/bin/cat`) is never taken from `programs`.
- **`paths`** is a list of 1 to 50 entries, each relative to `cwd` (no leading `/` or `~`, no `..` part). An entry is a folder (`docs`), a file (`README.md`) or a pattern. In a pattern, `*` stands for any characters inside one folder or file name, names that start with a dot included (`assets/*.png`), `**` for any number of folders (`**/*.md`), and `.` for the whole folder. A path is inside when it, or a folder above it, matches an entry, judged on the real `cwd` after links are followed.
- **Your rules in `allow` are tried first** and are checked exactly as before. When `paths` is given, every wildcard argument of a rule that is a path must also be inside `paths`. `paths` may be given without `programs` for that alone. In the example, `git status` is allowed by its own rule although `git` is not in `programs`.
- **Which arguments are paths.** Each positional argument, the value after `=` of a long flag (`--output=out/x`), and every tail of a short flag from its third character on (`-oout`); after `--` every word is checked whole and also as a flag would be, since `--` can be the value of the flag before it (`sort -T -- -onotes` writes `notes`). Such a word is a path when it contains `/`, or when the whole word or a part of it after `= : @ , + %` starts with `.` or names an existing entry of `cwd` (`prod+creds`). Other words, such as a search word or a number, are free. Give a path as its own word: a value glued to a short flag is checked whole, with every tail.
- **What every path must pass.** The checks of every local target (no `..`, the length limits, links followed, inside the real `cwd`, not a `protect` entry, not a name that usually holds secrets, not ksproxy's own files), a plain relative path (letters, digits and `_ . / -`), and then inside `paths`. The first failure refuses the call.
- **No program is refused for being listed.** You chose it. When you list a program that can act as you, `ksproxy start` and `ksproxy check` warn, for example `programs that can act as you: python3, ps; the agent can use them with your whole account`. A name is compared by its base name in lower case, also without a version (`python3.12`) and without a leading `g`, `gnu` or `bsd` (`gnumake`; `gzip` and `gunzip` keep their `g`), and by the part of each before its first `-` (`docker-buildx` is `docker`). The list:
  - shells: `sh`, `bash`, `rbash`, `zsh`, `dash`, `ksh`, `mksh`, `fish`, `csh`, `tcsh`, `pwsh`, `busybox`, `toybox`;
  - interpreters: `python`, `perl`, `php`, `lua` (and every name that starts with them), `node`, `nodejs`, `deno`, `bun`, `ruby`, `irb`, `erb`, `tclsh`, `wish`, `expect`, `osascript`, `awk`, `gawk`, `mawk`, `nawk`, `R`, `Rscript`, `julia`, `java`, `jshell`, `groovy`, `scala`, `kotlin`, `swift`, `dotnet`, `ghci`, `runghc`, `erl`, `elixir`, `iex`, `guile`, `racket`, `sbcl`, `m4`, `dc`, `sqlite3`, `duckdb`;
  - programs that run other programs: `env`, `xargs`, `exec`, `command`, `nohup`, `nice`, `timeout`, `time`, `watch`, `stdbuf`, `setsid`, `script`, `parallel`, `flock`, `taskset`, `ionice`, `chrt`, `caffeinate`, `arch`, `sandbox-exec`, `open`, `xdg-open`, `xcrun`, `tmux`, `screen`, `entr`, `ssh-agent`, `crontab`, `at`, `batch`, `launchctl`, `systemctl`, `systemd-run`, `taskpolicy`, `lockf`, `prlimit`, `shortcuts`, `automator`;
  - privileges: `sudo`, `doas`, `su`, `pkexec`, `chroot`, `unshare`, `nsenter`, `runuser`, `setpriv`, `capsh`, `sg`, `newgrp`, `fakeroot`;
  - network clients: `curl`, `wget`, `nc`, `ncat`, `netcat`, `socat`, `ssh`, `scp`, `sftp`, `rsync`, `ftp`, `lftp`, `telnet`, `openssl`, `http`, `xh`, `aria2c`, `rclone`, `dig`, `nslookup`, `host`, `mail`, `mailx`, `sendmail`, `mutt`, `psql`, `mysql`, `mongosh`, `redis-cli`, `pg_dump`, `pg_dumpall`, `mysqldump`;
  - editors and pagers: `vi`, `vim`, `nvim`, `view`, `ex`, `ed`, `nano`, `pico`, `emacs`, `mg`, `micro`, `code`, `less`, `more`, `most`, `man`;
  - debuggers: `lldb`, `gdb`, `strace`, `ltrace`, `dtrace`, `dtruss`, `valgrind`, `perf`;
  - build tools and compilers: `make`, `cmake`, `ninja`, `bazel`, `meson`, `scons`, `gradle`, `mvn`, `ant`, `rake`, `cargo`, `go`, `cc`, `gcc`, `g++`, `c++`, `clang`, `clang++`, `javac`, `xcodebuild`;
  - package managers: `npm`, `npx`, `yarn`, `pnpm`, `corepack`, `pip` (and every name that starts with it), `uv`, `uvx`, `poetry`, `conda`, `mamba`, `gem`, `bundle`, `bundler`, `composer`, `rustup`, `brew`, `port`, `apt`, `apt-get`, `dpkg`, `yum`, `dnf`, `rpm`, `apk`, `pacman`, `nix`, `nix-env`, `nix-shell`, `snap`, `flatpak`, `asdf`, `mise`;
  - document tools, which run filters or commands, or read any file: `pandoc`, `latexmk`, `tex`, `latex`, `pdftex`, `pdflatex`, `xetex`, `xelatex`, `luatex`, `lualatex`, `groff`, `troff`, `nroff`;
  - archive programs, because an unpacked member can have an absolute name, or be a link that points anywhere, which a program that follows links then reads: `tar`, `unzip`, `zip`, `cpio`, `pax`, `ditto`;
  - other processes, your data and saved logins: `ps`, `pgrep`, `pkill`, `kill`, `killall`, `lsof`, `top`, `htop`, `security`, `defaults`, `pbpaste`, `pbcopy`, `log`, `dscl`, `gpg`, `ssh-add`, `op`, `vault`, `pass`, `gh`, `glab`, `aws`, `gcloud`, `gsutil`, `az`, `doctl`, `heroku`, `flyctl`, `vercel`, `terraform`, `pulumi`, `ansible`, `helm`, `kubectl`, `docker`, `podman`, `nerdctl`, `minikube`, `git`, `svn`, `hg`, `ksproxy`, `ssh-keygen`, `oc`, `k9s`, `stern`, `kubectx`, `kubens`, `argocd`, `flux`, `istioctl`, `docker-compose`, `aws-vault`, `sops`, `bw`, `tofu`, `terragrunt`, `ansible-playbook`, `mdfind`, `screencapture`.
- **Options that are always refused**, whatever you list, also shortened (`--to-com`), with `=` or with a separate value, and inside a group of short flags (`-xPf`). This list is a best effort, like the list above: a program can have other options that run code or reach outside the paths. The options: `find` with `-exec`, `-execdir`, `-ok` or `-okdir`; `tar` (and `gtar`, `bsdtar`) with `-I`, `-F`, `-P`, `-C`, `-T`, `--to-command`, `--use-compress-program`, `--checkpoint-action`, `--info-script`, `--new-volume-script`, `--rsh-command`, `--rmt-command`, `--absolute-names`, `--absolute-paths`, `--directory`, `--cd`, `--files-from` or `--insecure`, also in its first argument without a dash (`tar xPf`); `cpio` with `--insecure` or `--rsh-command`; `tar`, `cpio` and `pax` with any argument that holds `:` (a remote archive); `zip` with `-TT` or `--unzip-command`; `unzip` with `-:`; `sort` with `--compress-program`; `split` with `--filter`; `install` with `--strip-program`; `sdiff` and `diff3` with `--diff-program`; `sed` with a script whose command is `e`, `w`, `W`, `r` or `R`, or an `s` command with the flag `e` or `w`, and `sed -f` or `--file`. An exact option of the same program that only shares a start with a refused one is not refused: `tar --checkpoint=1`, `tar --file=docs/a.tar`, `sort --check` and `install --strip` work.
- **`review`** may be used with `programs`. A call that no rule allows and whose program is not in `programs` goes to the reviewer as before, and every path of a reviewed command must also be inside `paths`. A call of a listed program that a check refuses is never reviewed.
- **`"allow": "any"` is still refused** for local targets, and so is every rule that starts with `*` or `...`, `* ...` included.
- **At start**, `ksproxy start` prints a `WARN` line for each such target that names the programs and the paths in full, for example `programs cat, grep, sed may run with any arguments inside docs, README.md, assets/*.png`, and the warning above when it applies. `AGENT.md` tells the agent the listed programs, that every path must be inside the paths shown, and the options always refused. `ksproxy check local NAME COMMAND` explains a refusal as before, and prints `ALLOWED by rule: programs: cat` for a call that a listed program allows.

What this mode cannot do:

- A listed program runs with your `HOME`, like every local command, so a program that reads saved logins can use them.
- An argument that is not a path by the rule above is free. A program can still create or read a file named by such a word in `cwd` (`touch notes` creates `cwd/notes` when `notes` does not exist yet), and a flag value given as its own word that starts with `-` (`sort -o -notes`) is taken as a flag.
- Archive members are not checked. An archive unpacked inside `paths` can hold names that land elsewhere inside `cwd`, and `cpio` and `pax` can unpack a member with an absolute name, anywhere you can write. An unpacked archive can also hold links that point anywhere, so a program that follows links (`grep -R`, `cp -RL`, `zip -r`) can then read any file of yours through them. This is why `tar`, `unzip`, `zip`, `cpio`, `pax` and `ditto` are on the list of programs that can act as you. Leave them out of `programs` if that matters.
- A recursive command reads everything below a path inside `paths`, and a command with no path argument works on the whole folder (`grep -r word`).
- Output is not scrubbed, except that the folder and ksproxy's state folder are replaced as for every local target.

The full rules are in [docs/LOCAL-TARGETS.md](docs/LOCAL-TARGETS.md#listed-programs-inside-chosen-paths).

## Databases, queues and HTTP APIs

Nine more kinds of target let the agent use a service that needs a password or a token. You name the credential in the inventory as an environment variable; `ksproxy start` reads it, keeps it in its own memory and carries out each call, so the agent never holds it. Every call still goes through the strict reader of the kind, its fixed refusals and your allowlist, and everything not allowed is refused.

```json
{ "postgres": [{ "name": "shop-db", "host": "db.internal.example", "database": "shop", "user": "agent_ro",
                 "passwordEnv": "SHOP_DB_PASSWORD",
                 "allow": ["select \\* from orders where id = *", "select count(\\*) from orders"] }] }
```

| Kind | Flag | Tool | A rule looks like |
|---|---|---|---|
| `http` | `--http` | `http_request` | `GET /api/dashboards/uid/*` |
| `command` | `--command` | `command_exec` | `usage *` |
| `elasticsearch` | `--es` | `elasticsearch_request` | `POST /*/_search +body` |
| `rabbitmq` | `--mq` | `rabbitmq_request` | `GET /api/queues/...` |
| `redis` | `--redis` | `redis_command` | `GET *` |
| `postgres` | `--pg` | `postgres_query` | `select \* from orders where id = *` |
| `mysql` | `--mysql` | `mysql_query` | `show tables` |
| `mongodb` | `--mongo` | `mongodb_command` | `find orders` |
| `kafka` | `--kafka` | `kafka_exec` | `topics --describe --topic *` |

The inventory fields, the words that a rule sees, the fixed refusals, the programs you must install (`psql`, `mysql`, `mongosh` and the Kafka clients) and the limits of each kind are in [docs/SERVICES.md](docs/SERVICES.md). The database user's rights are the real boundary, and nothing here has been run against a real service by the tests: try each target once with a read-only account.

## MCP servers

The `mcp` kind proxies an MCP server, local or remote, so that the agent uses the tools of that server without holding its credential. `ksproxy start` starts the server (or connects to it) with the credential it holds, and the allowed tools of the server appear in the agent's own tool list. Every call is checked against your rules (everything not allowed is refused), run, cleaned of secrets and written to the log, as for every other kind. There is no new command and no new flag: choose `mcp` targets in the picker or with `--all`, like any target.

### Adding a server

```json
{
  "mcp": [
    {
      "name": "jira",
      "description": "Jira of jira.example.com",
      "command": ["uvx", "mcp-atlassian@0.24.8"],
      "env": {
        "JIRA_URL": "https://jira.example.com",
        "JIRA_USERNAME": "someone@example.com",
        "JIRA_API_TOKEN": { "fromEnv": "JIRA_TOKEN" }
      },
      "allow": [
        "jira_get_issue",
        "jira_search",
        { "tool": "jira_add_comment", "arguments": { "issue_key": "regex(SHOP-[0-9]+)" } }
      ]
    },
    {
      "name": "gh",
      "command": ["github-mcp-server", "stdio", "--read-only", "--toolsets", "issues"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": { "fromEnv": "GH_TOKEN" } },
      "allow": [{ "tool": "list_issues", "arguments": { "owner": "example", "repo": "shop" } }]
    },
    {
      "name": "ghremote",
      "url": "https://api.githubcopilot.com/mcp/x/issues/readonly",
      "login": "token",
      "tokenEnv": "GH_TOKEN",
      "allow": ["list_issues"]
    }
  ]
}
```

Each target has exactly one of `command` and `url`.

- **`command`** runs a local server over stdio: a list of words, started without a shell, in an empty private folder. `uvx`, `npx`, `pipx`, `bunx`, `docker run -i` and a program on your `PATH` all work.
- **`url`** connects to a remote server over HTTP. It must be `https`, or `http` on a loopback address only; it may not hold a user name or password; a query such as `?tools=all` is allowed. No redirect is followed. `login` is `none` (the default), `token` (`tokenEnv` names the variable that holds the token, sent as a bearer token) or `basic` (`userEnv` and `tokenEnv`). The OAuth login in a browser is not supported yet (see "What is not supported").
- **`env`** (with `command`) sets the server's environment variables. A value is a plain string, or `{ "fromEnv": "NAME" }` for a value that `ksproxy start` holds in its own environment; that value is treated as a secret and hidden everywhere. A name that starts with `LD_` or `DYLD_` is refused, as for the `command` kind. `start` warns when a plain value has a name that looks like a secret (it holds `TOKEN`, `PASSWORD`, `KEY` or `SECRET`): use `fromEnv` for it.
- **`arguments`** (optional) pins arguments, see below. **`timeoutSeconds`** (optional, 1 to 600, default 60) is the time limit of one call. A tool argument named `timeout_seconds` goes to the server unchanged. `review` is not available for `mcp` targets: it is an inventory error.

The server gets a small environment: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, the cache folders `XDG_CACHE_HOME`, `UV_CACHE_DIR` and `npm_config_cache` when set, and your `env`. No other variable of `ksproxy start` reaches it. Proxy and certificate variables reach the server only through `env`. The program in `command[0]` is checked the way the `command` kind checks its program.

`command` and `url` are not secret fields: both are written to `session.json`, and the `OPENING` line (the terminal and the log) shows the command and the URL without its query. Put a key in `env` with `fromEnv` for a local server, or use `login` for a remote one; `start` and `check` warn when a query name of `url` looks like a secret, and when a word of `command` does: an option such as `--token`, a setting such as `-e GH_TOKEN=...` (write `-e GH_TOKEN` and set it in `env` instead), a header such as `Authorization: Bearer ...`, or a URL with a password. A remote server that only takes its key in the URL cannot be given one safely.

### Pinning

A server run by a package runner downloads and runs code at every start, so the version must be exact. The check is made per runner, and an option it does not know is refused (so is a short option group such as `-it`):

| Runner | What is required | What is refused |
|---|---|---|
| `npx`, `bunx` | An exact version on every package, including every `-p` or `--package` value: `name@1.2.3`, `@scope/name@1.2.3`. | A package without an exact version (a range or a tag such as `@latest`); `npx -c` and `--call`. |
| `uvx` | The command word as `name@1.2.3`, or `--from` with an exact version (`name==1.2.3` or `name@1.2.3`); every `--with` exact too. | `@latest`, wildcards such as `==1.2.*`, git, URL and path specs, `--with-requirements`, `--with-editable`. |
| `pipx` | `pipx run`, with an exact version in `--spec` or in the package word (`name==1.2.3`). | Any other `pipx` command; `--pip-args`. |
| `docker run`, `podman run`, `nerdctl run`, `finch run` | An image with a tag other than `latest`, or a digest (`@sha256:...`), and the options `-i` and `--rm`. A tag can be moved by whoever publishes the image; only a digest fixes it. | Any other subcommand; an image with no tag or `latest`; `-t`, `--tty`, `-d`, `--detach`. |

The runner is found by the base name of `command[0]`, in any letter case. `go run` of a module needs an exact version (`path@v1.2.3`). `npm`, `pnpm`, `pnpx`, `yarn`, `bun`, `uv`, `deno`, `dnx`, `pixi`, `mise` and `corepack` are refused whatever their words, and so are `python -m pipx` and `python -m uv`, because each can download and run a package in a way the check cannot read: use `npx`, `bunx`, `uvx` or `pipx run` with a pin, or `node` or `python` for a script of your own. Any other program (`github-mcp-server stdio`) is your own program and is not checked. An error says how to pin the package.

The pin fixes the package, **not its dependencies**. They are chosen when the package starts. For `uvx`, `--exclude-newer DATE` fixes them to a date: `["uvx", "--exclude-newer", "2026-11-01", "mcp-atlassian@0.24.8"]`.

### Rules

A rule is the name the server gives the tool (for example `jira_get_issue`, not `jira__jira_get_issue`). It is one of these:

- **a string**: allows that tool with any arguments;
- **an object** `{ "tool": NAME, "arguments": { ARG: VALUE, ... } }`: allows the tool only when every named top-level argument is present and matches. A `VALUE` is a JSON string, number or boolean that must be equal; `"*"` (present, any value; `"\\*"` is a literal star); or `"regex(...)"`, which must match the whole text of the value (a string as it is, anything else as compact JSON with sorted keys), at most 1,000 characters, stopped after 100 ms.

Arguments a rule does not name are free. There is no regex over a whole rule and no dotted path. `"allow": "any"` is an error for an `mcp` target, as for `local`, `command` and SQL targets: list the tools. When the server's schema lists its arguments, an argument the schema does not declare is refused, and a rule that names an argument the schema lacks gives a warning at start.

**Pinned arguments.** With `"arguments": { "cloudId": "0123-example" }` on the target, ksproxy adds those values to every call of a tool whose schema declares them and refuses a call whose own value differs. They are removed from the schema that the agent sees. Use it where one account reaches several sites or projects. A pin is sent only to a tool whose schema declares it, so a rule that names a pinned argument allows a tool that does not declare it no call at all: the call is refused, and `start` warns about such a rule.

**A rule cannot limit what a query reads.** A regex on a query-language value (JQL, CQL, a search string) cannot say what the query reads: `project = SHOP OR project = HR` can pass a pattern meant for `SHOP`. Rules choose tools and fixed values. The rights of the account behind the credential limit the data, so give the server an account that has only the rights the agent needs, and read what a server does before you add it.

### What the agent sees

- Each allowed tool of a target is in the agent's tool list as `TARGET__TOOL` (for example `jira__jira_get_issue`), with the server's input schema. The description starts with `[from the MCP server "jira"]`, so the agent knows the text comes from the server. The whole name is at most 50 characters. A tool is not listed when its name has characters outside `A-Za-z0-9_-`, its schema is not an object schema or has a top-level `oneOf`, `anyOf` or `allOf`, the server lists the name twice, a key or a value of its schema (other than a description or a title) holds a hidden character (a control, format or variation selector character; a newline or a tab is fine), or the limits are passed (200 tools per target, 64 KiB and 64 levels per schema, 1 MiB for all of a session); `start` warns for each. Descriptions are clipped to 1,000 characters and cleaned of control and hidden characters; `outputSchema` and `annotations` are never passed on.
- The tools exist while a session of the project runs, listed after ksproxy's own tools. A call of one goes through the same rules, audit and answer as `mcp_call` and is logged as `mcp_call`. The agent's arguments are sent as given (an argument named `timeout_seconds` belongs to the server); the time limit is the target's `timeoutSeconds`.
- Over the local `ksproxy mcp`, the agent is told within about 2 seconds when the tools appear or go (`list_changed`), when the inventory held an `mcp` target (or could not be read) as the agent connected. After you add your first `mcp` target, reconnect the agent's ksproxy server once (in Claude Code, `/mcp`). Over the network listener nothing is pushed, so a client sees the tools after it reconnects or asks for the list again.
- A fixed tool, `mcp_call` with `target`, `tool` and `arguments`, answers when it is called but is not in the tool list. It serves clients that cannot refresh their list.
- `list_targets` shows the target, its state and, in `tools`, the names of the exported tools; `AGENT.md` says which tools are exported and repeats the warning about queries.
- An answer is text. An image, audio or binary part becomes one line such as `[image, image/png, 41213 bytes, not shown]`. An answer that the server marks as an error is an error answer. A server that asks the client for something (sampling, elicitation, roots) is told it is not supported, and the call goes on; if the server then says it needs input, the call ends as an error. The usual output limit applies.
- Calls to one local server run one at a time.

### What you see at `ksproxy start`

Starting a local server can take a while (the first `uvx` run downloads the package: up to 120 seconds; a remote server: 30 seconds). Ctrl-C ends the wait. A server whose list of tools takes more than 16 MiB over all its pages is skipped.

```text
10:00:01 mcp  jira       OPENING         uvx mcp-atlassian@0.24.8, 3 variables
10:00:09 mcp  jira                       41 tools listed, 3 exported
10:00:09 mcp  jira       UP
```

`start` warns when a rule names a tool the server does not list, when a tool is not exported, and for the secret-looking plain values of `env`. When a server fails to start or stops, its last lines on stderr (cleaned, with secrets hidden) are shown **in the `start` terminal only**. The audit log gets a fixed text, and the agent never sees the server's stderr, because it can hold a token. A server that stops makes its target `down`; it is not restarted.

`ksproxy check mcp NAME TOOL` and `ksproxy check mcp NAME TOOL '{"issue_key":"SHOP-1"}'` answer from the rules alone (there is no session). `mcp` here is the kind word, not a flag.

`ksproxy doctor` starts the server and lists its tools. For a local server it reports `N tools listed, M exported; the credential is checked only by a call`: doctor never calls a tool, so it cannot show that the token works. For a remote server the authenticated list of tools proves the token.

### Remote Atlassian server

For Atlassian's remote server, add `?tools=all` to the `url` if you want its full tool list, and pin `cloudId` with `arguments` so that a tool that takes `cloudId` cannot reach another site (a pin reaches only the tools whose schema declares it, so check that each tool you allow does). Find out first whether your organisation allows API tokens for it:

```sh
curl -s -u someone@example.com:"$JIRA_TOKEN" https://<your-site>.atlassian.net/rest/api/3/myself
```

If this shows your account, API tokens work. If it is refused, the remote server needs the OAuth login, which is not supported yet.

### What is not supported

The OAuth login in a browser (a later phase), model review of `mcp` calls, a whole-rule regex or dotted paths in rules, following a change of the server's tools while the target is open (the list is taken once, when the target opens; the next `start` takes the new one), restarting a server that stopped, resources, prompts, completions, sampling, elicitation, roots and subscriptions, the older HTTP+SSE transport, a sandbox for local servers, and images passed on as images.

### Two checks to make by hand

These depend on the agent program, not on ksproxy, so try them once in Claude Code: that its tool list refreshes during a session after `list_changed` (start the session, then `ksproxy start`), and that a name with `__` such as `jira__jira_get_issue` works in its permission rules.

Read "What the MCP server changes" in [SECURITY.md](SECURITY.md) before you add a local server: it is third-party code that runs as you.

## Session folder

`start` writes `~/.ksproxy/session/` (for a project, `~/.ksproxy/p/NAME/session/`; its `s/`, `run/` and `logs/` folders are under `~/.ksproxy/p/NAME/` in the same way), each file by write-to-temp and rename; `session.json` is written last, so its presence means the session is ready. A target skipped at opening appears in none of these files.

| File | Content |
|---|---|
| `session.json` | `project` (for a project only), `pid`, `startedAt`, and per open target what the MCP server needs: kind, name, description, allow rules, socket path or proxy port, manifest roots, and for a local target its folder, the cleaned `PATH` of `ksproxy start` (absolute entries outside the folder) and the protected locations it must never touch (the inventory's kubeconfig files and ksproxy's own state and configuration folders) |
| `ssh_config` | credential-free ssh config; it can only reuse a master you opened |
| `kubeconfig` | credential-free kubeconfig pointing at the local proxy ports |
| `AGENT.md` | what the agent may use and what is off limits |
| `mcp.json` | the MCP config block |
| `kube-<name>.log` | `kubectl proxy` output |

The audit log is not in the session folder. It sits in `~/.ksproxy/logs/` (mode 0700), which `start` creates and `ksproxy mcp` only writes to:

| File | Content |
|---|---|
| `audit.log` | JSON lines, one per call, `list_targets` call and session event (kept after exit; see "The log") |
| `audit-YYYYMMDD-HHMMSS.log` | an earlier `audit.log`, renamed when it grew past 5 MiB (UTC time; `-2`, `-3` if the name is taken); the newest 5 are kept |

Next to the sockets (`~/.ksproxy/s/`), `start` keeps `kube-<name>.pid` for each proxy process (pid and start time), so a later `start` can stop a proxy left by a killed run.

The MCP server re-reads the session on every call. With no live session every tool answers that the user must run `ksproxy start` (`ksproxy start --project NAME` for a project). When a session stops, the `run/` folder of a project is left empty, and the next start of that project removes it. Tools: `list_targets`, `ssh_exec { server, command, timeout_seconds? }`, `kubectl { cluster, args, timeout_seconds? }`, `local_exec { target, command, timeout_seconds? }`, and one tool for each service kind in the table above, listed only when the inventory holds a target of that kind. A service call is sent over the private socket `call-sock` in the socket folder to `ksproxy start`, which decides it, carries it out and writes its audit entry. Timeouts are 1-600 seconds (default 60); stdout and stderr are each capped at 256 KiB, or at the `maxOutputKiB` of the target.

Each call of a target tool appends an audit entry with the time, tool, target, the call (`command`, `args`, `query` or `request`), the decision, the reason when refused, and when run the exit code, duration and output sizes. Output is not logged.

## The log

`start` prints every call and every event in one format (with several projects each line starts with `[NAME] `), and `ksproxy log` shows the same lines afterwards:

```
12:18:40 ssh  web1       OPENING         web1
12:18:41 ssh  web1       UP
12:18:43 kube staging    SKIPPED         port 8002 is already in use
12:18:43 --   session    READY           3 targets, pid 31973
12:19:19 ssh  web1       ok       0.1s   uptime
12:19:20 ssh  web1       DENIED          cat /etc/shadow  [not on allowlist]
12:19:21 kube lab        exit 1   0.3s   auth can-i delete pods -n web
12:19:22 kube lab        TIMEOUT  60.0s  logs -f api-1
12:19:23 kube lab        DENIED          get secrets -A  [secret resource]
12:19:24 loc  infra      DENIED          cat /etc/hosts  [not a plain argument]
12:19:25 --   agent      LIST            list_targets
12:40:02 ssh  web2       DOWN            connection lost
12:40:32 ssh  web2       UP              connection is back
12:41:00 --   session    CLOSING         Ctrl-C
12:41:01 --   session    CLOSED          23 calls: 17 ok, 2 failed, 4 denied
```

Columns, one space apart: local time, kind (`ssh`, `kube`, `loc`, `http`, `cmd`, `es`, `mq`, `rds`, `pg`, `my`, `mgo`, `kfk`, `--`), target (cut to 10 characters), status, duration, detail. The detail is the ssh or local command or the kubectl arguments; a refused call adds the short reason in brackets. The agent still receives the full explanation with the allowed rules; only the log is short. A line is cut to the terminal width (120 if unknown), or 240 characters when the output is not a terminal, and every value in it has control and bidirectional characters escaped as `\uXXXX`.

| Status | Meaning |
|---|---|
| `ok` | an allowed call that exited 0 |
| `exit N` | an allowed call that exited with a non-zero code |
| `TIMEOUT` | an allowed call that ran out of time (duration `0.4s`, or `1m05s` from a minute up) |
| `ERROR` | an allowed call whose program could not start |
| `DENIED` | a refused call, with the short reason |
| `OPENING` `UP` `SKIPPED` `WARN` | a target opening, open, not opened (a local target says `folder not found: <cwd>`, `not a directory: <cwd>`, `folder is too broad: ...`, `folder overlaps ksproxy's own files`, `folder contains a kubeconfig named in the inventory`, `folder cannot be resolved` or `cannot read <file> to protect the files it names`), or opened with a warning (empty allowlist, token rejected, cluster not answering, a secret shorter than 8 characters) |
| `DOWN` `UP` | the health check found an open target gone, then back |
| `REVIEW` | a target uses model review: `reviewer NAME, accepts LEVELS` |
| `LIST` | the agent called `list_targets` |
| `READY` `CLOSING` `CLOSED` | the session is ready; why it is closing (`Ctrl-C`, `terminal closed`, `terminated`, `output closed`, `error: ...`); and how many calls it served |

Lifecycle lines go to stderr, except `READY`, which goes to stdout with the call lines. When the stream is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`, the status word is coloured: green `ok` `UP` `READY` `REVIEW`, yellow `exit N` `TIMEOUT` `ERROR` `WARN` `SKIPPED`, red `DENIED` `DOWN`. Nothing else is coloured. With `--verbose` an allowed call ends with `  (rule: <rule>, out <n>B, err <n>B)`.

Every 30 seconds `start` checks each open target (override in milliseconds with `KSPROXY_HEALTH_MS`, minimum 200) and logs `DOWN` when one that was up is not, and `UP` when it returns.

`audit.log` keeps one JSON line per entry, each with `ts` and `event`:

| `event` | Other fields |
|---|---|
| `call` | `tool`, `kind`, `target`, the call as `command`, `args`, `query` or `request` (the field named by the tool of the kind; `request` is an object, see docs/KINDS.md), `decision`; when refused `reason` and `short`; when run `rule` (`review` when a model approved it, with `review.certainty` and `review.reason`), `exitCode`, `timedOut`, `spawnError`, `durationMs`, `stdoutBytes`, `stderrBytes`; for a call that came over the network `from` (the address) and `client` (the client name) |
| `list` | none |
| `target_opening`, `target_up`, `target_skipped`, `target_warn`, `target_review`, `target_down`, `target_recovered` | `kind`, `target`, `message` |
| `session_start` | `project` (for a project only), `pid`, `targets` (`kind`, `name`, `state`), `message` |
| `session_closing` | `message` (why) |
| `session_end` | `ok`, `failed`, `denied`, `message` |

An entry without `event` (from an older version) is read as a call. `ksproxy start` renames `audit.log` to `audit-YYYYMMDD-HHMMSS.log` when it is larger than 5 MiB, at the start of a session and during one. The 5 newest old files are kept and older ones are deleted, so the log folder holds about 30 MiB at most. The files of version 0.1.0 (`audit.log` and `audit.log.1` in the session folder) are moved into the logs folder at the next `start`.

`ksproxy log` prints the last 50 entries; `-n N` (1 to 5000) changes the count, `--denied` keeps only refused calls, `--from ADDRESS` keeps only the calls that came over the network from that address (their line shows `from ADDRESS` before the detail), and `--json` prints the raw lines (with control and bidirectional characters escaped, so each line is still valid JSON). It reads on into the old files, newest first, when the current file has fewer entries than `-n`. It always includes the verbose detail. With no log it prints `no log yet`.

## Security model and limits

The allowlist is a second lock; the first is that the agent never holds a credential. You open the connections; the agent can only use sockets and proxy ports through the MCP server. What this does not do:

- **A local command runs as you, on the machine that holds your keys.** Give local targets the shortest allow list of all.
- **The folder check for local targets looks at arguments only.** A program can still read other files by itself, and some programs run code they find in the folder. See "Local targets".
- **`"any"` is refused for local targets on purpose.** A local target lists its commands, or the programs that may run with any arguments inside chosen `paths`. A listed program runs as you, and one that can act as you (an interpreter, a network client, a program that uses your saved logins) gives the agent your whole account; `ksproxy start` warns about it. See "Listed programs inside chosen paths".
- **`ksproxy doctor` contacts every target** it checks with your credentials, with one fixed read-only check of its kind. It changes nothing on a target.
- **The allowlist binds the MCP path only.** The sockets and proxy ports belong to you, so an agent that also has an unrestricted local shell can call `ssh -S <sock>` or `curl 127.0.0.1:<port>` directly.
- **An agent that can edit the inventory or session files can widen its own rules.** Same exposure.
- **The credentials of service targets live only in the memory of `ksproxy start`.** `ksproxy mcp` forwards a service call over a private socket, and every failure on that path is a refusal. The rights of the database or service account are the real boundary, a secret that the service returns in its own output reaches the agent, and rules do not understand what a request does. See "What these kinds do not protect against" in [docs/SERVICES.md](docs/SERVICES.md).
- **A process that runs as you can read the credentials that `ksproxy start` holds.** `start` keeps the environment it was started with, and the system shows that environment to any process of the same user (`ps -E` on macOS, `/proc/<pid>/environ` on Linux), just as such a process can read your private keys and your cluster configuration. `ksproxy` does not open the Node inspector on `SIGUSR1` (it runs Node with `--disable-sigusr1`), but that does not close this route. So run the agent with no shell of your user, or in a sandbox, or as another user; see "Hardening the agent".
- **A rule is only as safe as the program it allows.** `find ...`, `awk ...`, `vim`, `less`, `sudo ...` and similar can run other commands.
- **Command output is returned as-is.** A program that prints a secret leaks it to the agent. The tool replaces the state folder path, a local target's folder (also in another letter case) and the local proxy addresses in the output, but that is not redaction.
- **"Secret resources are never allowed" covers reading Secret objects through this tool.** A workload that the identity is allowed to create or change can still mount a Secret; only Kubernetes RBAC prevents that.
- **The remote user's own permissions and Kubernetes RBAC remain the boundary.** Give the ssh user and the Kubernetes identity only what you are willing to let the agent do.
- **If `start` is killed with SIGKILL or the machine loses power, ssh connections and `kubectl proxy` processes it opened can outlive it.** After a hard kill, the next `ksproxy start` closes the leftover ssh connections and the proxy processes it recorded (it signals a recorded pid only if that process still has the recorded start time and its command line contains ` proxy `). `start` closes everything on SIGINT, SIGTERM and SIGHUP, and also when writing to its terminal fails or an unexpected error occurs.
- **Applying a workload the identity may create can yield credentials or more access.** A Pod that mounts a service-account token, a RoleBinding or a privileged pod are examples. Only Kubernetes RBAC prevents that; this tool does not inspect manifest contents.
- **`diff` runs the `diff` program found on `PATH`.**
- **kubectl keeps a discovery cache** under your home directory.
- **Scrubbing ports and paths from output is cosmetic.** An agent with a local shell can find them anyway.
- **A manifest can be swapped between the path check and kubectl opening it.** A process with local write access could do this; such a process is already outside this tool's protection.

Out of scope: creating server users, sudoers rules, RBAC, tokens or kubeconfigs; file transfer; interactive shells; port forwarding for the agent; redacting secrets from output; Windows.

### Hardening the agent

The deny rules below are best effort. `Bash(ssh *)` does not stop `/usr/bin/ssh` or `curl 127.0.0.1:<port>`, and `Read(...)` rules do not stop a shell command from reading a file. The reliable setups are:

- an agent with **no general shell**, so the MCP tools are the only way to run anything; or
- an agent whose shell runs in a **sandbox** that cannot read `~/.ksproxy` or `~/.config/ksproxy`, cannot reach local sockets and ports, and cannot see the other processes of your user; or
- an agent whose shell runs as **another user**.

For Claude Code, the deny rules still raise the bar. Put them in `.claude/settings.json` (per project) or `~/.claude/settings.json` (everywhere):

```json
{
  "permissions": {
    "deny": [
      "Read(~/.ksproxy/**)",
      "Edit(~/.ksproxy/**)",
      "Read(~/.config/ksproxy/**)",
      "Edit(~/.config/ksproxy/**)",
      "Bash(ssh *)",
      "Bash(kubectl *)"
    ]
  }
}
```

## Development

```
npm test
```

The complete logic, module by module, is drawn as Mermaid diagrams in [docs/LOGIC.md](docs/LOGIC.md); `test/logic-docs.test.js` fails when a module or an exported function is missing from it.

Each kind of target is one folder, and the core walks the list of kinds:

```
src/kinds/index.js         the ordered list of kinds
src/kinds/<name>/index.js  one kind: ssh, kubernetes, local or one of the service kinds
src/kinds/<name>/*.js      the mechanics of that kind (master.js, cluster.js, folder.js)
src/kinds/engines/*.js     what several service kinds share (http, command, resp, sql)
src/*.js                   the core: inventory, start, tools, review, audit, cli
test/fixtures/kind-echo.js a test-only kind, the smallest example
```

How to add a kind is in [docs/KINDS.md](docs/KINDS.md).

There are no dependencies to install: `package.json` has none, and tests use only `node:test` and `node:assert/strict`. `npm test` runs `node --test` with Node's built-in coverage over `src/` and `bin/`, and it fails when line, branch or function coverage is below 100%. Keep it at 100%: a change that adds code needs tests that reach it. To see which lines are missed, run the suite with the coverage report and read the "uncovered lines" column:

```
node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' 'test/*.test.js'
```

Quote the globs so Node, not the shell, expands them. Branch gaps do not show up in that column; a file below 100% in "branch %" has an untested `if`, `?:`, `??` or `catch`, so read the code around its other lines. For a per-branch listing, add `--test-reporter=lcov --test-reporter-destination=coverage.lcov` and look for `BRDA` entries that end in `,0`.

Most tests call the code in the test's own process, so the coverage counts. `start` and `main` take an optional last argument (a process-like object, and for `start` also the checkbox, the health probe and the close time limits), which the tests use to drive signals, streams and timers; the defaults are the real ones. Only `bin/ksproxy.js` is exercised through a child process, and its coverage reaches the report because those tests pass `NODE_V8_COVERAGE` through to the child.

No test contacts a real server or cluster. `ssh` and `kubectl` are replaced through `KSPROXY_SSH` and `KSPROXY_KUBECTL` with the stubs in `test/fixtures/`. `fake-ssh.js` creates and removes the control socket file and answers `-O check` and `-O exit`; it prints `ran <name> <command>` for an exec, and `fail` and `slow` commands give exit 3 and a 10 second wait. `KSPROXY_FAKE_SSH_CHECK_MS` delays each `-O check` answer and `KSPROXY_FAKE_SSH_TRACE` appends `begin` and `end` to a file around it, which the health-check test uses to show that two checks never overlap. `fake-kubectl.js` listens on the `--port` given to `proxy` and answers every request with `KSPROXY_FAKE_KUBECTL_STATUS` (default 200); for any other call it prints its arguments as JSON. `fake-ssh-nostay.js` opens a master without leaving a socket (so `-O check` fails), and `fake-ssh-flood.js` prints 300000 bytes. Each test passes its own environment with `KSPROXY_CONFIG_DIR` and `KSPROXY_STATE_DIR` pointing into a fresh directory under `/tmp`, so the real home directory is never touched. The local-target tests run real programs (`cat`, `ls`, `env` and small node scripts) in temporary folders.
