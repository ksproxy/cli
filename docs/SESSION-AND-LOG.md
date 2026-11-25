# The session folder and the log: exact reference

The README has the short version. This page lists every file that `ksproxy start` writes, every log line and every field of the audit log.

**Contents**

- [The session folder](#the-session-folder)
- [How the MCP server uses the session](#how-the-mcp-server-uses-the-session)
- [Sockets, proxies and clean-up](#sockets-proxies-and-clean-up)
- [The audit log files](#the-audit-log-files)
- [The log lines](#the-log-lines)
- [The audit log entries](#the-audit-log-entries)
- [`ksproxy log`](#ksproxy-log)

## The session folder

- `start` writes `~/.ksproxy/session/`. For a project it is `~/.ksproxy/p/NAME/session/`, and the project's `s/`, `run/` and `logs/` folders are under `~/.ksproxy/p/NAME/` in the same way.
- Each file is written by write-to-temp and rename. `session.json` is written last, so its presence means the session is ready.
- A target skipped at opening appears in none of these files.
- At Ctrl-C, `session.json` and the socket folder are removed. The other session files stay until the next `start`.

| File | Content |
|---|---|
| `session.json` | `project` (for a project only), `pid`, `startedAt`, and per open target what the MCP server needs: kind, name, description, allow rules, socket path or proxy port, manifest roots, and for a local target its folder, the cleaned `PATH` of `ksproxy start` (absolute entries outside the folder) and the protected locations it must never touch (the inventory's kubeconfig files and ksproxy's own state and configuration folders) |
| `ssh_config` | credential-free ssh config; it can only reuse a master you opened |
| `kubeconfig` | credential-free kubeconfig pointing at the local proxy ports |
| `AGENT.md` | what the agent may use and what is off limits |
| `mcp.json` | the MCP config block |
| `mcp-tools.json` | only when an `mcp` target is open: the tools that the agent sees as `TARGET__TOOL`, with the pid and start time of the session (see [MCP-SERVERS.md](MCP-SERVERS.md#what-the-agent-sees)) |
| `kube-<name>.log` | `kubectl proxy` output |

## How the MCP server uses the session

- **It re-reads the session on every call.** With no live session every tool answers that the user must run `ksproxy start` (`ksproxy start --project NAME` for a project).
- **When a session stops,** the `run/` folder of a project is left empty, and the next start of that project removes it.
- **Tools:** `list_targets`, `ssh_exec { server, command, timeout_seconds? }`, `kubectl { cluster, args, timeout_seconds? }`, `local_exec { target, command, timeout_seconds? }`, and one tool for each service kind (see [SERVICES.md](SERVICES.md)), listed only when the inventory holds a target of that kind. The tools of `mcp` targets are in [MCP-SERVERS.md](MCP-SERVERS.md#what-the-agent-sees).
- **Service calls** are sent over the private socket `call-sock` in the socket folder to `ksproxy start`, which decides each call, carries it out and writes its audit entry.
- **Limits.** Timeouts are 1-600 seconds (default 60). stdout and stderr are each capped at 256 KiB, or at the `maxOutputKiB` of the target.
- **Audit entries.** Each call of a target tool appends an audit entry with the time, tool, target, the call (`command`, `args`, `query` or `request`), the decision, the reason when refused, and when run the exit code, duration and output sizes. Output is not logged.

## Sockets, proxies and clean-up

- **Proxy records.** Next to the sockets (`~/.ksproxy/s/`), `start` keeps `kube-<name>.pid` for each proxy process (pid and start time), so a later `start` can stop a proxy left by a killed run.
- **A clean stop.** `start` closes everything on SIGINT, SIGTERM and SIGHUP, and also when writing to its terminal fails or an unexpected error occurs.
- **After a hard kill.** If `start` is killed with SIGKILL or the machine loses power, ssh connections and `kubectl proxy` processes it opened can outlive it. The next `ksproxy start` closes the leftover ssh connections and the proxy processes it recorded. It signals a recorded pid only if that process still has the recorded start time and its command line contains ` proxy `.

## The audit log files

The audit log is not in the session folder. It sits in `~/.ksproxy/logs/` (mode 0700), which `start` creates and `ksproxy mcp` only writes to.

| File | Content |
|---|---|
| `audit.log` | JSON lines, one per call, `list_targets` call and session event (kept after exit) |
| `audit-YYYYMMDD-HHMMSS.log` | an earlier `audit.log`, renamed when it grew past 5 MiB (UTC time; `-2`, `-3` if the name is taken); the newest 5 are kept |

- **Rotation.** `ksproxy start` renames `audit.log` to `audit-YYYYMMDD-HHMMSS.log` when it is larger than 5 MiB, at the start of a session and during one. The 5 newest old files are kept and older ones are deleted, so the log folder holds about 30 MiB at most.
- **Version 0.1.0 files.** The files of version 0.1.0 (`audit.log` and `audit.log.1` in the session folder) are moved into the logs folder at the next `start`.

## The log lines

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

- **Columns,** one space apart: local time, kind (`ssh`, `kube`, `loc`, `http`, `cmd`, `es`, `mq`, `rds`, `pg`, `my`, `mgo`, `kfk`, `mcp`, `--`), target (cut to 10 characters), status, duration, detail.
- **The detail** is the ssh or local command or the kubectl arguments. A refused call adds the short reason in brackets. The agent still receives the full explanation with the allowed rules; only the log is short.
- **Line length.** A line is cut to the terminal width (120 if unknown), or 240 characters when the output is not a terminal. Every value in it has control and bidirectional characters escaped as `\uXXXX`.

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

- **Streams.** Lifecycle lines go to stderr, except `READY`, which goes to stdout with the call lines.
- **Colour.** When the stream is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`, the status word is coloured: green `ok` `UP` `READY` `REVIEW`, yellow `exit N` `TIMEOUT` `ERROR` `WARN` `SKIPPED`, red `DENIED` `DOWN`. Nothing else is coloured.
- **Verbose.** With `--verbose` an allowed call ends with `  (rule: <rule>, out <n>B, err <n>B)`.
- **Health checks.** Every 30 seconds `start` checks each open target (override in milliseconds with `KSPROXY_HEALTH_MS`, minimum 200). It logs `DOWN` when one that was up is not, and `UP` when it returns.

## The audit log entries

`audit.log` keeps one JSON line per entry, each with `ts` and `event`:

| `event` | Other fields |
|---|---|
| `call` | `tool`, `kind`, `target`, the call as `command`, `args`, `query` or `request` (the field named by the tool of the kind; `request` is an object, see [KINDS.md](KINDS.md)), `decision`; when refused `reason` and `short`; when run `rule` (`review` when a model approved it, with `review.certainty` and `review.reason`), `exitCode`, `timedOut`, `spawnError`, `durationMs`, `stdoutBytes`, `stderrBytes`; for a call that came over the network `from` (the address) and `client` (the client name) |
| `list` | none |
| `target_opening`, `target_up`, `target_skipped`, `target_warn`, `target_review`, `target_down`, `target_recovered` | `kind`, `target`, `message` |
| `session_start` | `project` (for a project only), `pid`, `targets` (`kind`, `name`, `state`), `message` |
| `session_closing` | `message` (why) |
| `session_end` | `ok`, `failed`, `denied`, `message` |

An entry without `event` (from an older version) is read as a call.

## `ksproxy log`

`ksproxy log` prints the last 50 entries. It always includes the verbose detail, and with no log it prints `no log yet`.

- `-n N` (1 to 5000) changes the count. When the current file has fewer entries than `-n`, it reads on into the old files, newest first.
- `--denied` keeps only refused calls.
- `--from ADDRESS` keeps only the calls that came over the network from that address. Their line shows `from ADDRESS` before the detail.
- `--json` prints the raw lines, with control and bidirectional characters escaped, so each line is still valid JSON.
- `--project NAME` shows the log of that project; without it, the default log.
