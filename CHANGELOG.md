# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.1] - 2026-11-25

### Changed

- **A short README.** The README is a short guide in bullets (807 lines down to 162). The detail moved to pages under `docs/`: rules and the inventory, `doctor`, the session folder and the log, projects, network access, MCP servers and development. "Hardening the agent" moved to SECURITY.md.
- **Examples for every kind.** `docs/EXAMPLES.md` gives a read-only and a read-and-write target for each kind, with allowed and refused calls, all checked by a test.
- **Contents lists.** The README, SECURITY.md and each page under `docs/` open with a list of their sections, kept in step by a test.
- **The homepage** now covers every kind of target, MCP servers, projects, network access and `ksproxy doctor`.

## [0.7.0] - 2026-11-25

### Added

- The `mcp` kind: `ksproxy start` starts a local MCP server (`uvx`, `npx`, `pipx`, `bunx`, `docker run -i` or any program) or connects to a remote one (https, with no login, a bearer token or basic auth), holds its credential, and the allowed tools appear in the agent's tool list as `TARGET__TOOL`. Rules are tool names or objects with argument values, `"allow": "any"` is refused, `arguments` pins values, `timeoutSeconds` sets the time limit of a call, and `env` takes plain values or `{ "fromEnv": NAME }`. Package runners must name an exact version, and `npm`, `pnpm`, `yarn`, `bun`, `uv`, `deno`, `dnx`, `pixi`, `mise`, `corepack`, `python -m pipx` and `python -m uv` are refused as a server's program. It adds no command and no flag: choose `mcp` targets with the picker or `--all`, check them with `ksproxy check mcp NAME TOOL [JSON]`, and see them in `ksproxy doctor`. `ksproxy mcp` tells the agent when the tools appear or go (`notifications/tools/list_changed`, for an inventory with an `mcp` target), and `list_targets` shows the exported tools of an `mcp` target. See "MCP servers" in the README and "What the MCP server changes" in SECURITY.md.

## [0.6.0] - 2026-11-25

### Added

- Local targets: a new `programs` list, with a new `paths` list (folders, files and patterns with `*`, `**` and `.`), lets the agent run the programs you name, with any arguments, inside those paths. The program word must be exactly one of the names, never a path. Every path a command names is checked, a best-effort list of options that run code or reach outside the paths is always refused (such as `find -exec`, `tar -P`, `tar -C`, `tar --to-command`, `cpio --insecure`, `sort --compress-program`, `split --filter`, `install --strip-program`, an archive name with `:`, `unzip -:` and sed scripts with `e`, `w` or `r`), and the rules in `allow` are tried first. `review` may be used with it, and every path of a reviewed command must also be inside `paths`. `ksproxy start` names the programs and paths of such a target, and `ksproxy start` and `ksproxy check` warn about a listed program that can act as you, such as an interpreter, `ps`, `gh` or an archive program such as `tar`, whose unpacked links can point anywhere. `paths` may also be given with listed rules only, to limit their wildcard arguments. See "Listed programs inside chosen paths" in the README.
- `ksproxy doctor` takes the arguments of `ksproxy start` and reports, in one run, every pre-check of `start` and every target, each with one fixed read-only check of its kind. It changes nothing on a target and writes neither the session nor the log. Exit code 0 when everything is OK, 1 otherwise, 2 for a usage error.

## [0.5.0] - 2026-11-24

### Added

- Network access: `ksproxy start --listen HOST:PORT` (given once or several times) serves the projects of that start over HTTP on loopback or private addresses of this machine, at `/mcp` and `/p/NAME/mcp`, behind one global token. `--tls-cert FILE --tls-key FILE` turn on TLS, and `--new-token` makes a new token at start. The listener refuses a request with an `Origin` header, a wrong `Host`, a wrong token (10 in a minute block the address for a minute) and a body over 256 KiB. Its limits are 64 connections, 16 of them from one address, 16 calls running at once (`503`), 10 seconds for a request to arrive and 60 seconds idle.
- `ksproxy token` shows when the token was made, expires and was last used, and `ksproxy token revoke` revokes it at once. Typing `new-token` in the `start` terminal makes a new one.
- Several projects in one start: `ksproxy start --project shop,ops --all` runs them in one terminal, with `[NAME] ` before each line. `default` names the default inventory in the list.
- `ksproxy log --from ADDRESS` shows the calls that came over the network from one address. Their entries carry `from` and `client`.
- `ksproxy status` shows the listen addresses, the token and the clients of a live listener.

### Changed

- `default` is a reserved project name: it means the default inventory wherever `--project` is accepted, no command uses `projects/default.json` as a project, but ksproxy still reads it so that the files it protects stay protected and its ports stay taken, and `ksproxy init --project default` writes `inventory.json`. While a project named `default` still exists (`projects/default.json` or `p/default`), `--project default` is refused with `--project default now means inventory.json, but an old project named default is still here (PATH); rename it, for example to default-old, and update its agent configs`.
- Migration: if you had a project named `default`, rename its file (`projects/default.json` to `projects/default-old.json`) and its state folder (`p/default` to `p/default-old`), and update the agent configs that use `mcp --project default`.

## [0.4.0] - 2026-11-22

### Added

- Projects: `--project NAME` on every command gives a set of targets of its own (`projects/NAME.json` in the config folder) and a state folder of its own (`p/NAME/` in the state folder), so sessions of different projects, and the default session, run at the same time. `ksproxy status` without `--project` lists every live session. The guards that keep ksproxy's own files out of reach cover the folders of every project, and a local target never reaches a kubeconfig or Kafka client file that any inventory file names. A Kubernetes port that another inventory file or another live session names is refused at `start`, and `ksproxy init` writes a sample with ports that no other file uses.

### Changed

- The socket path of an ssh connection (`s/ssh-NAME`) and of a cluster tunnel (`s/tun-NAME`) may be at most 83 bytes, not 100, because ssh first creates the socket under a name 17 bytes longer and then renames it. A target whose path is 84 to 100 bytes is now refused by `start` with `socket path too long` before anything opens; such a target never worked, because ssh could not create its socket.

## [0.3.0] - 2026-11-22

### Added

- Nine kinds of target for services, run through a new broker: `http`, `command`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql`, `mongodb` and `kafka`. Each has a flag for `ksproxy start`, an MCP tool (`http_request`, `command_exec`, `elasticsearch_request`, `rabbitmq_request`, `redis_command`, `postgres_query`, `mysql_query`, `mongodb_command`, `kafka_exec`), a strict reader and fixed refusals that no rule can lift. The reference is `docs/SERVICES.md`.
- The broker: `ksproxy start` reads the credentials of service targets from environment variables, keeps them in its own memory, decides and carries out each call, and writes the audit entry. `ksproxy mcp` forwards the call over a private socket in the socket folder, and every failure on that path is a refusal. The tool of a service kind is listed only when the inventory holds a target of that kind.
- `regex(...)` rules: a rule written as `regex(...)`, as the whole rule, is tried on the words of a command joined by single spaces. A pattern that can be very slow gets a warning at `ksproxy start` and `ksproxy check`. Every match stops after 100 ms and counts as no match, and a regex rule is not tried on a command longer than 1000 characters. A regex rule of a `command` or `kafka` target may not use a lookaround.
- `\*` in a rule matches a literal star. In the inventory file it is written `\\*`. The SQL kinds warn when a bare `*` follows `select` or `(`.
- In a word rule of the `postgres` and `mysql` kinds, `*` matches one value: a number (`42`, `-1`, `1.5`) or one string in single quotes, never a name or a keyword, so `where id = *` does not allow `where id = id`. A `*` right after `from`, `join`, `into`, `update`, `table` or `describe` gets a warning, as it can never match. Every other kind keeps `*` as one word.
- `ksproxy` keeps the Node inspector closed on `SIGUSR1`.
- `ksproxy start` warns when a secret of a service target, or a part of one that is hidden on its own (such as the password inside a connection string), is shorter than 8 characters, naming the variable or the file, because hiding so short a value in the output can give it away. A variable that holds only a user name gets no warning.
- `maxOutputKiB`, an optional field of a target of any kind, raises the output limit of each stream for that target from 256 KiB to at most 4096 KiB; `list_targets` and `AGENT.md` show a raised limit, and the answer line of a service call may now be up to 16 MiB.

### Changed

- Internal: each kind of target now lives in its own folder under `src/kinds/` behind one interface. There is no change in behaviour for ssh, kubernetes and local, except the inspector and the regex limits listed under Added.
- A session file edited by hand to hold a target of an unknown kind is now reported with the state `error` by `ksproxy status` and `list_targets`, instead of failing.
- Rules on every kind, ssh, kubernetes and local included: a rule that starts with `regex(` is now read as a regex rule, and the text `regex(` anywhere else in a rule is an inventory error, as is a regex rule that is empty or does not compile. Such a rule used to be an ordinary word rule.
- The rule word `\*` now matches only the argument `*`. On a Kubernetes target it used to match only the two-character argument `\*`. On ssh and local targets the tokenizer refuses both characters, so nothing changes there.

## [0.2.0] - 2026-11-21

### Added

- Optional model review. When no rule matches a command on a target that has `review`, ksproxy asks an OpenAI-compatible model whether the command fits your policy. Off by default.
- Inventory: a `reviewers` block (`baseUrl`, `model`, `keyEnv`, `timeoutSeconds`, `maxCalls`) and a per-target `review` (`reviewer`, `policy`, `accept`, and `programs` for local targets).
- `accept` says which certainty levels count as approval: `sure` (the default) and `likely`. Anything that is not a clean approval is a refusal.
- Checks the model cannot override: fixed refusals and allow rules run first, clusters are reviewed for read verbs only, and local targets only for listed `programs` with simple flags and arguments that stay in the folder.
- A refusal says why a command was not sent to the reviewer, and `ksproxy check` does too.
- The API key is read from the variable named by `keyEnv`, kept in memory only, and removed from the environment of every program the session starts.
- `REVIEW` lines and the model's reason in the log, `review: true` in `list_targets`, and a line in `AGENT.md` for a reviewed target.
- `docs/MODEL-REVIEW.md` with every check, message and limit.
- `jumps` on an ssh target: ssh commands that follow `host`, for a server that only the first one can reach. The agent's allowed command runs on the last one, through the tools only the fixed jump and an allowed command are sent to the first server, and the tools never show the jump text. `"allow": "any"` is refused with `jumps`.
- `protect` on a local target: files and folders inside the folder that no wildcard or reviewed argument may name, enter or contain. `ksproxy start` warns about secret-looking names it finds at the top of the folder.

### Changed

- On a local target a wildcard no longer matches a name that usually holds secrets (`.env`, key files, `terraform.tfstate` and similar). Write the path into a rule to allow it.
- The audit log moved to `logs/` in the state folder (`logs/audit.log`). It is rotated during a session too, not only at start, and an old file is named `audit-YYYYMMDD-HHMMSS.log`. The five newest old files are kept. `ksproxy log` reads on into them. Files from 0.1.0 (`audit.log` and `audit.log.1` in the session folder) are moved on the next start.
- Shorter package description.
- Shorter "Local targets" section in the README. The exact rules moved to `docs/LOCAL-TARGETS.md`.

## [0.1.0] - 2026-11-20

First release.

### Added

- `ksproxy start`: pick targets from a menu (or with `--ssh`, `--kube`, `--local`, `--all`), open them, and stay in the foreground. Ctrl-C closes every ssh connection and tunnel and stops every proxy.
- Three kinds of target in `inventory.json`, with strict validation and an error for every unknown key:
  - `ssh`: a connection you open (OpenSSH ControlMaster) that the agent can only reuse;
  - `kubernetes`: a `kubectl proxy`, optionally through an ssh tunnel;
  - `local`: a folder on your own machine.
- A built-in MCP server (`ksproxy mcp`) with the tools `list_targets`, `ssh_exec`, `kubectl` and `local_exec`, so an agent reaches the targets without holding a credential.
- A default-deny allowlist per target, with literal, `*` and `...` tokens. Shell syntax is refused outright for ssh and local commands, and commands are started without a shell.
- A fixed list of kubectl verbs and flags, checks on output formats and manifest paths (`manifestRoots`), and refusal of secret resources, `exec`, `port-forward` and `create token`, whatever the rules say.
- Local targets are confined to their folder: a wildcard matches only plain names and paths (never a flag), links are followed before the check, `..` is refused, ksproxy's own files and the inventory's kubeconfigs are off limits, the root and the home directory cannot be targets, and the command gets a minimal environment.
- One log line per call and per session event in the terminal, with a short reason for every refusal; a JSON-lines `audit.log`; and `ksproxy log [-n N] [--denied] [--json]`.
- A health check every 30 seconds that logs `DOWN` and `UP`, and clean-up of connections and proxies left by a killed session on the next `start`.
- `ksproxy init`, `ksproxy status` and `ksproxy check <ssh|kube|local> <name> <command...>` to create an inventory, inspect the session, and test a rule without opening anything.
- No npm dependencies. Requires Node.js 24 or later, on macOS or Linux.

[0.7.1]: https://github.com/ksproxy/cli/releases/tag/v0.7.1
[0.7.0]: https://github.com/ksproxy/cli/releases/tag/v0.7.0
[0.6.0]: https://github.com/ksproxy/cli/releases/tag/v0.6.0
[0.5.0]: https://github.com/ksproxy/cli/releases/tag/v0.5.0
[0.4.0]: https://github.com/ksproxy/cli/releases/tag/v0.4.0
[0.3.0]: https://github.com/ksproxy/cli/releases/tag/v0.3.0
[0.2.0]: https://github.com/ksproxy/cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/ksproxy/cli/releases/tag/v0.1.0
