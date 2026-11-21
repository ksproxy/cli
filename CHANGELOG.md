# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.2.0]: https://github.com/ksproxy/cli/releases/tag/v0.2.0
[0.1.0]: https://github.com/ksproxy/cli/releases/tag/v0.1.0
