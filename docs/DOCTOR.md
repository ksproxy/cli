# Checking your targets with doctor: exact rules

The README has the short version. This page lists every check, message and limit of `ksproxy doctor`. What it changes for security is in "What local listed programs and `ksproxy doctor` change" in [SECURITY.md](../SECURITY.md#what-local-listed-programs-and-ksproxy-doctor-change).

`ksproxy doctor` tells you, target by target, whether your inventory still works: the credential is there, the target can be reached and opened, and one harmless read succeeds. It changes nothing on any target.

When `ksproxy start` fails, run the same line again with `doctor` in place of `start`. `start` stops at the first problem; doctor goes on and shows all of them in one run.

**Contents**

- [Arguments](#arguments)
- [The pre-checks of `start`](#the-pre-checks-of-start)
- [Each target](#each-target)
- [Output](#output)
- [A project with a running session](#a-project-with-a-running-session)
- [What it writes, and what it contacts](#what-it-writes-and-what-it-contacts)

## Arguments

- **Exactly those of `ksproxy start`:** `--project` (one name or a list), `--all`, the kind flags, `-v`, `--listen`, `--tls-cert` and `--tls-key`.
- **`--new-token`** is accepted with `--listen` only, and then changes nothing. Without `--listen` it is a usage error (exit 2).
- **Target names** may also be given as plain words (`ksproxy doctor web1 shop-db`).
- **With no selection,** doctor checks every target of the selected projects and never shows the picker.
- It has no flag of its own.

## The pre-checks of `start`

Doctor runs them in the order of `start`:

1. The inventory of each project loads.
2. No session of the project runs.
3. The `--listen` values are valid.
4. The TLS files can be read and belong together.
5. No other program listens on the address.
6. The token file can be read.

A failed pre-check is printed as `FAIL` with the message of `start`. With `--listen`, doctor also opens each address for a moment and closes it again, without making a token.

## Each target

Targets are checked one after another. For each, doctor:

1. reads its credential from the environment;
2. applies the inventory checks and prints the warnings that `start` prints;
3. opens the target the way a session does;
4. runs **one fixed, read-only check** of its kind;
5. closes it.

The check is fixed by ksproxy. It is never taken from your `allow` rules, and it is never sent to the model reviewer.

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
| `postgres`, `mysql` | `select 1`. With `tls` `verify` or `require`, opening the target already ran one `select 1` to check TLS, and a TLS failure is `FAIL` with its reason. |
| `mongodb` | The `ping` command. |
| `kafka` | List the topics. |
| `mcp` | The server starts and its tools are listed. A local server is never called; see [MCP-SERVERS.md](MCP-SERVERS.md#ksproxy-check-and-ksproxy-doctor). |

- **A kind with no check of its own** is `OK` once it has opened.
- **Time limits.** Each target has its open time limit and then 30 seconds for the check, so a dead host does not hang the run.
- **Ctrl-C** stops the run, closes what is open and exits 1.

## Output

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

- **Each line has the format of the log:** `OK` or `FAIL` and a short detail, cleaned, with every secret value hidden.
- **The lines that `start` would print** while it opens a target (`WARN`, `SKIPPED`) are printed too.
- **With several projects** each line starts with `[NAME] `, as in `start`.
- **The last line** is `N of M targets OK`.
- **Exit code:** 0 when every checked target is `OK`, 1 otherwise, 2 for a usage error.

## A project with a running session

- It is reported as `FAIL` (`a session of project NAME is running`, with its process number), and its targets are not opened, because a session holds fixed ports and the socket folder.
- Other projects of the same run are checked.
- To look at a running session, use `ksproxy status`.

## What it writes, and what it contacts

- **It writes nothing a session writes.** It uses a temporary socket folder of its own and removes it at the end. It never writes `session.json`, the call socket or the agent files, so no agent can reach a target through it, and it writes nothing to the audit log.
- **If doctor is killed** before it can remove the folder, the next `ksproxy doctor` or `ksproxy start` stops the cluster proxies and ssh connections left in it and removes it. A folder left empty by a doctor killed while it was making it is removed once it is five minutes old.
- **It does contact every checked target** with your credentials, with the one read of its kind, and for a `postgres` or `mysql` target with `tls` `verify` or `require` also with the TLS check of opening.
- **It does not run your `allow` rules** (use `ksproxy check` for that), and it repairs nothing.
