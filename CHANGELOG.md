# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/ksproxy/cli/releases/tag/v0.1.0
