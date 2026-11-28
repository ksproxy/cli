# ksproxy

Let AI agents run allowlisted ssh, kubectl, local, database, queue, HTTP API and MCP server calls without your credentials.

- **The agent never holds a credential.** You run `ksproxy start` and leave it running. The agent reaches your targets only through ksproxy's MCP server.
- **Default deny.** Every call is checked against the target's allow list. Anything not allowed is refused.
- **Everything is logged,** and Ctrl-C closes all access.
- **Works with** any MCP client that can run a local command (`ksproxy mcp`), such as Claude Code, and over your network with clients that send a token in a header.

[Homepage](https://ksproxy.github.io/cli/) · [Examples for every kind](docs/EXAMPLES.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

**Contents**

- [What it is for, and what it is not](#what-it-is-for-and-what-it-is-not)
- [Install](#install)
- [Quick start](#quick-start)
- [Targets and rules](#targets-and-rules)
- [Local targets](#local-targets)
  - [Listed programs inside chosen paths](#listed-programs-inside-chosen-paths)
- [MCP servers](#mcp-servers)
- [Model review (optional)](#model-review-optional)
- [Projects](#projects)
- [Network access](#network-access)
- [Security model and limits](#security-model-and-limits)
- [Development](#development)

## What it is for, and what it is not

- **For** developing and debugging with an AI agent: read logs, inspect a cluster, read a few rows, check a queue. When ksproxy is not sure, it refuses.
- **One call, one answer.** No interactive shell, no open connection between calls, no streaming, no file transfer.
- **Output is cut at 256 KiB** per stream, and the answer says so near its top, where a client that shortens long answers still shows it. On ssh, Kubernetes and local targets the line says how much is shown, and the answer also shows the last 16 KiB; the sizes are close, not exact. On the other targets the answer shows the first 256 KiB (a little less when paths were removed from it) with `[stdout cut at 256 KiB: the rest was left out]` and no end part, and a call that did not end on its own (a time limit, a broken reply) loses its last 1 KiB at least, back to the end of a line, so a short output of a call that timed out is not shown: make such a call end on its own. A hint of the kind says how to narrow the call (`tail -n 200`, a `LIMIT`, the API's paging). Raise `maxOutputKiB` for one target (at most 4 MiB). MongoDB returns at most 100 documents and MySQL 1,000 rows per call.
- **A call has a time limit:** 60 seconds by default, 600 at most. A command already running on a server may go on there.
- **Rules match words, not meaning.** The rights of the account behind each target are the real boundary: use read-only accounts.
- **Not a wall against your own user.** A process that runs as you can reach what `ksproxy start` holds. Run the agent without a shell of yours, in a sandbox, or as another user.

## Install

```
npm install -g @ksproxy/cli
```

- **Node.js 24 or later and `ssh`,** on macOS or Linux. No npm dependencies.
- **Clients only for the kinds you use:** `kubectl`, `psql`, `mysql` or `mariadb`, `mongosh`, the Kafka clients.
- **`env -S` is needed** (macOS, or GNU coreutils 8.30 or later): `ksproxy` starts Node through it with `--disable-sigusr1`.
- **From a checkout:** `git clone https://github.com/ksproxy/cli.git ksproxy`, `cd ksproxy`, `npm link`.

## Quick start

1. **`ksproxy init`** writes a sample inventory to `~/.config/ksproxy/inventory.json` (mode 0600). It never overwrites a file.
2. **Add your targets,** each with an `allow` list. [docs/EXAMPLES.md](docs/EXAMPLES.md) has a read-only and a read-and-write target for every kind. Test a rule without opening anything: `ksproxy check ssh web1 df -h`.
3. **`ksproxy start`** asks which targets to open (or use `--all` or the kind flags), then stays in the foreground and prints one line per call. Run it with the environment variables your targets name; ssh may ask for a password in that terminal.
4. **If it fails, run `ksproxy doctor`** with the same arguments. It checks every target and shows every problem in one run ([docs/DOCTOR.md](docs/DOCTOR.md)).
5. **Connect your agent once** with the line `start` prints. For Claude Code: `claude mcp add ksproxy -- <node> --disable-sigusr1 <path to bin/ksproxy.js> mcp`.
6. **Ctrl-C** closes every connection and proxy. The log in `~/.ksproxy/logs/` is kept ([docs/SESSION-AND-LOG.md](docs/SESSION-AND-LOG.md)).

One session runs at a time per project: `start` refuses while one is live.

| Command | What it does |
|---|---|
| `ksproxy init` | Write a sample inventory. |
| `ksproxy start` | Open targets and serve the agent: `--all`, the kind flags, `-v`, `--project`, `--listen`. |
| `ksproxy doctor` | Check every target with the arguments of `start`, without opening a session. |
| `ksproxy check WORD NAME CALL...` | Say whether a call would be allowed. `WORD` is the kind's flag without `--` (`ssh`, `kube`, `pg`, ...) or `mcp`. |
| `ksproxy status` | Live sessions and the state of each target. |
| `ksproxy log [-n N] [--denied] [--json] [--from ADDRESS]` | The history of calls and events. |
| `ksproxy token`, `ksproxy token revoke` | The network token's dates, and revoking it. |
| `ksproxy mcp` | The MCP server. Your agent starts it. |

Every command but `token` takes `--project NAME`.

## Targets and rules

| Kind | Flag | What the agent gets | Details |
|---|---|---|---|
| `ssh` | `--ssh` | commands on a server, also one behind another server (`jumps`) | [RULES](docs/RULES.md), [JUMPS](docs/JUMPS.md) |
| `kubernetes` | `--kube` | kubectl through a fixed gate: no `exec`, no port forwarding, no secrets | [RULES](docs/RULES.md#the-kubernetes-command-gate) |
| `local` | `--local` | a short list of commands in one folder, as you | [LOCAL-TARGETS](docs/LOCAL-TARGETS.md) |
| `http`, `command`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql`, `mongodb`, `kafka` | `--http`, `--command`, `--es`, `--mq`, `--redis`, `--pg`, `--mysql`, `--mongo`, `--kafka` | requests, statements or client commands, run by `start` with the credential it holds. An `http`, `elasticsearch`, `rabbitmq`, `postgres`, `mysql`, `redis` or `mongodb` target can sit behind a server (`tunnel`) | [SERVICES](docs/SERVICES.md), [TUNNELS](docs/TUNNELS.md) |
| `mcp` | none: the picker or `--all` | the tools of an MCP server, as `TARGET__TOOL` | [MCP-SERVERS](docs/MCP-SERVERS.md) |

A rule is a list of words matched against the call:

| Token | Matches |
|---|---|
| a literal | that exact word |
| `*` | one word that does not start with `-` |
| `...` | any number of words, at the end only |
| `regex(...)` | the whole call, when it is the whole rule |

- **Example:** `systemctl status *` allows `systemctl status nginx`, not `systemctl status --all`.
- **Strict inventory:** an unknown key is an error, so a typo never drops a restriction. A missing `allow` refuses everything.
- **Every field, and what each token matches on each kind:** [docs/RULES.md](docs/RULES.md).

## Local targets

The riskiest kind: **the command runs as you, on the machine that holds your keys.** Keep the list short.

```json
{ "name": "infra", "cwd": "~/projects/infra", "allow": ["git status", "ls -l ...", "cat *"], "protect": ["secrets"] }
```

- **No shell, plain words only.** Every rule starts with a program, and `*` and `...` never match a flag.
- **Paths stay in the folder,** and secret-looking names and `protect` entries are refused.
- **What it cannot stop:** what a program opens by itself, a recursive command reading the whole folder, and code a program runs from the folder (`git` hooks, `make`, `npm` scripts). Output is not scrubbed.

Details: [docs/LOCAL-TARGETS.md](docs/LOCAL-TARGETS.md).

### Listed programs inside chosen paths

`"programs": ["cat", "grep", "ls"], "paths": ["docs"]` lets the agent run those programs **with any flags, as you,** while every path a command names stays inside `paths`.

- **A program that can act as you** (a shell, an interpreter, a network client, an archive program) gives away your whole account. `start` and `check` warn when you list one.
- **Words that are not paths are free,** and a command with no path (`grep -r word`) reads the whole folder.

Details: [docs/LOCAL-TARGETS.md](docs/LOCAL-TARGETS.md#listed-programs-inside-chosen-paths).

## MCP servers

The agent uses the tools of an MCP server without holding its credential:

```json
{ "mcp": [{ "name": "jira", "command": ["uvx", "mcp-atlassian@0.24.8"],
            "env": { "JIRA_URL": "https://jira.example.com", "JIRA_API_TOKEN": { "fromEnv": "JIRA_TOKEN" } },
            "allow": ["jira_get_issue", { "tool": "jira_add_comment", "arguments": { "issue_key": "regex(SHOP-[0-9]+)" } }] }] }
```

- **Local (`command`) or remote (`url`,** with `login` `none`, `token` or `basic`). Secrets go in `env` with `fromEnv`, or in `login`.
- **Pin the version:** package runners need an exact version. The pin does not fix the package's dependencies.
- **Tools appear as `TARGET__TOOL`.** Reconnect the agent's ksproxy server once after you add your first `mcp` target.
- **A local server is third-party code that runs as you,** and a rule cannot limit what a query (JQL, a search) reads.

Details: [docs/MCP-SERVERS.md](docs/MCP-SERVERS.md) and [SECURITY.md](SECURITY.md#what-the-mcp-server-changes).

## Model review (optional)

When no rule matches, a model you choose (any OpenAI-compatible API) can approve a call that fits a policy you wrote. Off by default, set per target.

- **Rules and fixed refusals come first.** Only an approval with a certainty you accept (`sure` by default) runs.
- **The model judges words, not effects,** and the agent writes the words: keep write commands on the allow list.
- **The call, the policy and the target name go to the provider;** output and credentials do not.

Details: [docs/MODEL-REVIEW.md](docs/MODEL-REVIEW.md).

## Projects

A project is a set of targets for one agent, in its own inventory file, `~/.config/ksproxy/projects/NAME.json`.

- **Use:** `ksproxy init --project shop`, then `ksproxy start --project shop --all`. Several in one terminal: `--project shop,ops`.
- **Not a wall between your own agents:** any process of your user can reach every project.

Details: [docs/PROJECTS.md](docs/PROJECTS.md).

## Network access

`--listen` serves projects over HTTP to agents on your local network: `ksproxy start --project shop --all --listen 192.168.1.20:7443`.

- **Loopback or private addresses only.** A project is at `/p/NAME/mcp`, the default at `/mcp`.
- **One token for every project,** shown once and valid one year. `ksproxy token revoke` ends it. Keep it as you keep a password.
- **Plain HTTP is the default.** On a shared network, use `--tls-cert FILE --tls-key FILE`.

Details: [docs/NETWORK-ACCESS.md](docs/NETWORK-ACCESS.md).

## Security model and limits

The agent never holds a credential; the allow list is a second lock.

- **The allow list binds only the MCP path.** An agent with its own shell can use the sockets and proxy ports directly, or edit the inventory.
- **Output is returned as it is:** a program that prints a secret leaks it. Only the credentials ksproxy holds are hidden.
- **The account is the boundary:** the remote user's rights, Kubernetes RBAC, the database or service account.
- **A rule is only as safe as the program it allows:** `find`, `awk`, `vim` and `sudo` can run other commands.
- **Harden the agent:** no general shell, or a shell in a sandbox or as another user. See [SECURITY.md](SECURITY.md#hardening-the-agent) for Claude Code deny rules.

Every limit, and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Development

`npm test` runs every test (no dependencies) and fails below 100% coverage. The logic is drawn in [docs/LOGIC.md](docs/LOGIC.md), adding a kind is in [docs/KINDS.md](docs/KINDS.md), and the rest is in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

`scripts/e2e.sh` runs the end-to-end tests: ksproxy against real servers in Docker containers ([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#end-to-end-tests)).
