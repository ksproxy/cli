# ksproxy

## What it does

ksproxy lets an AI agent run commands on ssh servers and Kubernetes clusters without ever holding a credential, and run a short list of commands in a folder on your own machine. You run one command in a terminal, pick the targets, and leave it running; the agent reaches those targets only through a built-in MCP server. Every call is checked against a per-target allowlist that refuses everything by default, every call is logged, and Ctrl-C closes all access.

## Install

Requires Node.js 24 or later and `ssh`. `kubectl` is needed only for Kubernetes targets. There are no npm dependencies. macOS and Linux only.

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
3. `ksproxy start` asks which kinds (ssh, kubernetes, local) and which targets to open, opens them (ssh may ask for your password or key passphrase in this terminal), prints a summary, and stays in the foreground printing one line per agent call and per event (see "The log" below). Non-interactive: `--ssh a,b`, `--kube x,y`, `--local p,q`, `--all`. Without a terminal and without one of these flags, `start` exits with an error. Opening a local target only checks that its folder exists and may be used (see "Local targets"); closing it does nothing. `-v` / `--verbose` adds the matched rule and the output sizes to each allowed call.
4. Add the printed MCP config to your agent once. For Claude Code the summary prints the exact line:

   ```
   claude mcp add ksproxy -- <node> <path to bin/ksproxy.js> mcp
   ```

   The config is the same on every run, so you do this once.
5. Press Ctrl-C when you are done. Every ssh connection and tunnel is closed, every proxy is stopped, `session.json` and the socket folder are removed, and `audit.log` is kept. The other session files (`ssh_config`, `kubeconfig`, `AGENT.md`, `mcp.json` and the proxy logs) stay until the next `start`.

Other commands: `ksproxy status` (live session and each target's state, then the time of the last call and the number of calls this session; exit 0 only when everything is up), `ksproxy log [-n N] [--denied] [--json]` (the history, see "The log"), `ksproxy check <ssh|kube|local> <name> <command...>` (see below), `ksproxy mcp` (the MCP server; your agent starts it, you do not), `ksproxy --help`, `ksproxy --version`.

Only one session runs at a time. `start` refuses while a live session exists and cleans up a stale one.

## Inventory reference

`inventory.json` lives in `$KSPROXY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ksproxy`, else `~/.config/ksproxy`.

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
| top level | An object with optional `ssh`, `kubernetes` and `local` arrays. |
| `name` | `^[a-z0-9][a-z0-9-]{0,30}$`, unique within its kind. |
| `ssh[].host` | An ssh destination your own ssh config resolves. `^[A-Za-z0-9][A-Za-z0-9._@-]*$`; it may not start with `-`. |
| `kubernetes[].kubeconfig` | A path; `~/` is expanded. It is your real kubeconfig for that cluster and is read only by `kubectl proxy`. |
| `proxyPort`, `tunnel.localPort` | Integers 1024-65535, unique across the whole file. |
| `tunnel` (optional) | `host` as above; `remote` is `host:port`. When present, point the kubeconfig's server at `https://127.0.0.1:<localPort>`; the tool does not verify this. |
| `manifestRoots` (optional) | Absolute or `~/` directories. The only places `-f` and `--patch-file` may read a single file from. |
| `local[].cwd` | The folder the commands run in. Required; absolute or `~/`. It is never shown to the agent. |
| `description` (optional) | A string shown in the selection list and to the agent. |
| `allow` | An array of rule strings, or the string `"any"`. Missing means an empty list, which refuses everything. `start` warns for each selected target with an empty list; the warning is printed before the target is opened, even if the target is then skipped. `"any"` is an error for `local` targets: list the commands, and every `local` rule must start with the program name (not `*` or `...`). |

State is kept in `~/.ksproxy` (override: `KSPROXY_STATE_DIR`). Keep that path short: unix socket paths are limited in length, and `start` fails with a clear message if one would exceed 100 bytes. Directories are created 0700 and files 0600. `ssh` and `kubectl` are found on `PATH`; `KSPROXY_SSH` and `KSPROXY_KUBECTL` override them with absolute paths.

## Allowlist rules

A rule is whitespace-separated tokens, matched against the command's arguments.

| Token | Matches |
|---|---|
| a literal | an argument equal to it |
| `*` | exactly one argument that does not start with `-` (in a local rule: one plain name or relative path) |
| `...` | zero or more arguments of any shape; only legal as the last token (in a local rule: plain names and relative paths only, never a flag: write every flag into the rule) |

An empty rule, or `...` anywhere but last, is an inventory error. Examples:

- `df -h` allows exactly `df -h`, and nothing else (not `df`, not `df -h /`).
- `systemctl status *` allows `systemctl status nginx`, not `systemctl status` and not `systemctl status --all`.
- `journalctl -u myapp ...` allows `journalctl -u myapp --since today -n 50`, not `journalctl -u other`.
- `get ...` (Kubernetes) allows `get pods -A` and any other `get`.
- `apply -f *` (Kubernetes) allows `apply -f <one path>`; the path must also sit inside `manifestRoots`.

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

Exit 0 is allowed, 1 is refused, 2 is a usage or inventory problem.

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

A `local` target lets the agent run allowlisted commands on this machine, in the folder named by `cwd`, through the `local_exec` tool. It is the riskiest kind: the command runs as you, on the machine that holds your keys. Every call goes through these steps, in this order, and the first one that fails refuses the call:

1. **Plain words only.** The command is tokenised exactly as for ssh: at most 4096 bytes, split on spaces and tabs, every character one of `A-Z a-z 0-9 _ @ % + = : , . / -`, and the first token may not start with `-`. No quotes, `~`, `$`, pipes, redirects or other shell syntax can get through. The program is started directly with an argument list; no shell is ever involved.
2. **A wildcard matches plain names and paths only, never a flag.** Both `*` and `...` match arguments that are a plain name or relative path: letters, digits and `_ . / -`, not starting with `-` (`a.txt`, `sub/b.txt`, `main..dev`, `20`, `.`). Everything else is refused with `not a plain argument`: every flag (`-l`, `--oneline`, `--since=2.days`, `-C`, `--upload-pack=sh`), an absolute path, `@`, `%`, `+`, `:`, `,` or `=` inside a positional, `--`, `-`, a `file:` URL. A flag is how a program is told to do something else (`git -C sub` changes the folder that later arguments resolve against; `--upload-pack=sh` names a program to run), so every flag the agent may use must be written literally into the rule: `ls -l ...`, `git log --oneline -n * ...`. A literal token is your own choice and is not checked (a rule such as `curl -d@/etc/hosts *` allows exactly what it says).
3. **Every plain value is checked.** The plain argument may not contain a `..` segment. Empty and `.` segments are dropped first (`a/./b` and `a//b` mean `a/b`; a trailing slash disappears, so `link/` is judged as `link`, not as a missing path under it; `.` and `./` name the folder itself). A plain argument longer than 512 bytes is refused (`argument too long`) before anything is joined. The result is joined to the real path of `cwd` (a folder is at most 400 bytes, see below), so the path the checks examine is never longer than the path the program opens; a joined path above 1000 bytes is refused with the same message as a backstop. The joined path is resolved so that links are followed in the order the system follows them (an existing path by its real path; a missing one by its nearest existing parent). A path that cannot be resolved is refused as `unresolvable link` (a dangling link, a loop or too many links), and one that cannot be examined is refused as `cannot be examined` (a name too long for the system, a folder you may not search). Only "does not exist" and "a file is in the way" let the check look at the nearest existing parent instead. A path that goes through a symbolic link into `/proc`, `/dev` or `/sys` is refused (`system link`), because such a link can resolve differently in ksproxy and in the command it starts. Neither the path nor its real path may be, contain or lie inside a protected location (`ksproxy files`): the ksproxy state folder, its configuration folder (each as recorded by `ksproxy start`, as written and by real path, letter case ignored on macOS and Windows) or any kubeconfig file named in your inventory. The real path must also be inside the real path of `cwd`; there is no switch that allows paths outside it. To let the agent read one file outside the folder, write it literally into a rule (`cat /etc/hosts`), which allows exactly that command. On macOS a real path is compared without a leading `/System/Volumes/Data` component, so both spellings of one file are the same file. When several rules match loosely, the refusal the agent sees is the most informative one, not `not a plain argument` when another reason exists.
4. **The program names itself.** The first token is the program. Every allow rule of a local target must start with a literal program name (never `*` or `...`), so the program is always chosen by you and is exempt from the path checks: `venv/bin/python`, a link to a system interpreter, keeps working.
5. **The allowlist.** The tokens must match one of the target's rules, as described under "Allowlist rules", in order. The first rule that matches and whose wildcard arguments pass the checks above allows the call; if a rule matches but its wildcard arguments are refused, the next rule is tried, and when none allows it the most useful refusal is reported (a specific reason rather than `not a plain argument`). `"any"` is refused here too, in case a session file was edited.

Folders that cannot be a local target: when `start` opens the target (and in `ksproxy check local`, and again on every call, against the protected locations recorded by `start`) the real path of `cwd` must not be the filesystem root, your home directory or a parent of it (`folder is too broad: pick a project folder, not <cwd>`), nor equal, contain or lie inside ksproxy's state folder or configuration folder (`folder overlaps ksproxy's own files`), nor contain any kubeconfig file named in your inventory (`folder contains a kubeconfig named in the inventory`), it must be resolvable and may not go through a link into `/proc`, `/dev` or `/sys` (`folder cannot be resolved`), and its real path may be at most 400 bytes (`folder path is too long`). Such a target is `SKIPPED`, with those messages, or with `folder not found` or `not a directory`. The agent is not told which of them applies, only that the folder is not acceptable and that you can run `ksproxy check local <name>`; that command, like `start`, shows you the detailed message. `ksproxy check local` applies the same checks and the same protected kubeconfigs as a live session.

The program runs with `cwd` as its working folder and with only the minimal environment (`PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`). Its `PATH` is built from the `PATH` that `ksproxy start` had, keeping only the absolute entries that are not inside the folder of any local target of the session: relative and empty entries (which would resolve against the folder), and entries that lie in a local target's folder or that a link leads into one, are dropped; if nothing is left it is `/usr/bin:/bin`. So a file named `git` in the folder is never the `git` that runs, but a rule that names a program with a slash (`./run.sh`, `venv/bin/python`) runs exactly that file. No `KSPROXY_*` variable and nothing else from your environment reaches the program. The folder and the state folder are replaced in the output by `<folder>` and `<ksproxy>`, as configured, as resolved and as the system spells it, and on macOS and Windows whatever the letter case; a path is replaced only where no letter, digit, `_`, `.` or `-` follows it (a folder `/work/app` is not replaced inside `/work/apple` or `/work/app.log`); a path cut in two by the 256 KiB output limit may be only partly replaced. `list_targets` never shows `cwd`. If the folder disappears the health check logs `DOWN` with `folder is gone`, and `UP` with `folder is back` when it returns.

The honest limits:

- **The check sees arguments, not what a program opens by itself.** A program can still read other files through its own configuration, includes, environment variables (including `HOME`) or a file whose content names another file. Allow only programs you would run on that folder yourself.
- **A flag you write into a rule is your choice**, including one that runs a command or changes directory. Allow only programs and flags you would run on that folder yourself.
- **A recursive program reads everything in the folder.** `grep -r`, `ls -R` and the like, given the folder or a directory, walk all of it; only the argument is checked, not what the program finds below it. A recursive program that follows links (`grep -R`, `ls -L`, `find -L`) also leaves the folder through links inside it.
- **Letter case on macOS.** The folder check treats names that differ only in letter case as the same, as on the default case-insensitive volume; on a case-sensitive volume this can make it refuse a path that is really elsewhere, or treat two different names as one.
- **Hard links inside the folder cannot be detected.** A hard link to a file elsewhere looks like any other file in the folder.
- **A file can change between the check and the program opening it** if something else with local write access is racing it; such a process is already outside this tool's protection.
- **A literal in a rule is exempt**, so a rule such as `curl -d@/etc/hosts *` allows exactly what it says.
- **Some programs execute code they find in the folder or in your home configuration.** `git` runs configured helpers and hooks, `terraform plan` runs external data sources, and `make`, `npm` and similar run scripts. Allowing such a program lets whatever is in the folder run as you.
- **A rule that lets the agent write files in the folder, combined with a rule that runs something from the folder, lets the agent run its own code.** For example `tee ...` plus `./run.sh`, or a `git` rule plus a writable `.git/hooks`.
- **A program that detaches from its process group (`setsid`) survives the timeout kill.** The timeout stops the program and its children in the same group, not one that left it.
- **Protected locations are those recorded by `ksproxy start`**, not whatever the agent host's environment says: ksproxy's own state and configuration folders and every kubeconfig of the inventory. If you later move one of these, start a new session.

`"any"` is refused for local targets on purpose; list the commands.

## Session folder

`start` writes `~/.ksproxy/session/`, each file by write-to-temp and rename; `session.json` is written last, so its presence means the session is ready. A target skipped at opening appears in none of these files.

| File | Content |
|---|---|
| `session.json` | `pid`, `startedAt`, and per open target what the MCP server needs: kind, name, description, allow rules, socket path or proxy port, manifest roots, and for a local target its folder, the cleaned `PATH` of `ksproxy start` (absolute entries outside the folder) and the protected locations it must never touch (the inventory's kubeconfig files and ksproxy's own state and configuration folders) |
| `ssh_config` | credential-free ssh config; it can only reuse a master you opened |
| `kubeconfig` | credential-free kubeconfig pointing at the local proxy ports |
| `AGENT.md` | what the agent may use and what is off limits |
| `mcp.json` | the MCP config block |
| `audit.log` | JSON lines, one per call, `list_targets` call and session event (kept after exit; see "The log") |
| `audit.log.1` | the previous `audit.log`, kept when that file grew past 5 MiB before a `start` |
| `kube-<name>.log` | `kubectl proxy` output |

Next to the sockets (`~/.ksproxy/s/`), `start` keeps `kube-<name>.pid` for each proxy process (pid and start time), so a later `start` can stop a proxy left by a killed run.

The MCP server re-reads the session on every call. With no live session every tool answers that the user must run `ksproxy start`. Tools: `list_targets`, `ssh_exec { server, command, timeout_seconds? }`, `kubectl { cluster, args, timeout_seconds? }`, `local_exec { target, command, timeout_seconds? }`. Timeouts are 1-600 seconds (default 60); stdout and stderr are each capped at 256 KiB.

Each `ssh_exec`, `kubectl` and `local_exec` call appends an audit entry with the time, tool, target, command or args, the decision, the reason when refused, and when run the exit code, duration and output sizes. Output is not logged.

## The log

`start` prints every call and every event in one format, and `ksproxy log` shows the same lines afterwards:

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

Columns, one space apart: local time, kind (`ssh`, `kube`, `loc`, `--`), target (cut to 10 characters), status, duration, detail. The detail is the ssh or local command or the kubectl arguments; a refused call adds the short reason in brackets. The agent still receives the full explanation with the allowed rules; only the log is short. A line is cut to the terminal width (120 if unknown), or 240 characters when the output is not a terminal, and every value in it has control and bidirectional characters escaped as `\uXXXX`.

| Status | Meaning |
|---|---|
| `ok` | an allowed call that exited 0 |
| `exit N` | an allowed call that exited with a non-zero code |
| `TIMEOUT` | an allowed call that ran out of time (duration `0.4s`, or `1m05s` from a minute up) |
| `ERROR` | an allowed call whose program could not start |
| `DENIED` | a refused call, with the short reason |
| `OPENING` `UP` `SKIPPED` `WARN` | a target opening, open, not opened (a local target says `folder not found: <cwd>`, `not a directory: <cwd>`, `folder is too broad: ...`, `folder overlaps ksproxy's own files`, `folder contains a kubeconfig named in the inventory` or `folder cannot be resolved`), or opened with a warning (empty allowlist, token rejected, cluster not answering) |
| `DOWN` `UP` | the health check found an open target gone, then back |
| `LIST` | the agent called `list_targets` |
| `READY` `CLOSING` `CLOSED` | the session is ready; why it is closing (`Ctrl-C`, `terminal closed`, `terminated`, `output closed`, `error: ...`); and how many calls it served |

Lifecycle lines go to stderr, except `READY`, which goes to stdout with the call lines. When the stream is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`, the status word is coloured: green `ok` `UP` `READY`, yellow `exit N` `TIMEOUT` `ERROR` `WARN` `SKIPPED`, red `DENIED` `DOWN`. Nothing else is coloured. With `--verbose` an allowed call ends with `  (rule: <rule>, out <n>B, err <n>B)`.

Every 30 seconds `start` checks each open target (override in milliseconds with `KSPROXY_HEALTH_MS`, minimum 200) and logs `DOWN` when one that was up is not, and `UP` when it returns.

`audit.log` keeps one JSON line per entry, each with `ts` and `event`:

| `event` | Other fields |
|---|---|
| `call` | `tool`, `kind`, `target`, `command` or `args`, `decision`; when refused `reason` and `short`; when run `rule`, `exitCode`, `timedOut`, `spawnError`, `durationMs`, `stdoutBytes`, `stderrBytes` |
| `list` | none |
| `target_opening`, `target_up`, `target_skipped`, `target_warn`, `target_down`, `target_recovered` | `kind`, `target`, `message` |
| `session_start` | `pid`, `targets` (`kind`, `name`, `state`), `message` |
| `session_closing` | `message` (why) |
| `session_end` | `ok`, `failed`, `denied`, `message` |

An entry without `event` (from an older version) is read as a call. When `audit.log` is larger than 5 MiB at the start of a session it is renamed to `audit.log.1`, replacing any older one.

`ksproxy log` prints the last 50 entries; `-n N` (1 to 5000) changes the count, `--denied` keeps only refused calls, and `--json` prints the raw lines (with control and bidirectional characters escaped, so each line is still valid JSON). It always includes the verbose detail. With no log it prints `no log yet`.

## Security model and limits

The allowlist is a second lock; the first is that the agent never holds a credential. You open the connections; the agent can only use sockets and proxy ports through the MCP server. What this does not do:

- **A local command runs as you, on the machine that holds your keys.** Give local targets the shortest allow list of all.
- **The "inside the folder" check looks at arguments only.** A wildcard in a local rule matches only plain names and paths, never a flag (flags and anything else must be written literally in the rule), each plain value is resolved with links followed and must stay in the folder, rules must name the program, and the root, your home directory, its parents and ksproxy's own folders cannot be local targets. But a program can still read elsewhere through its own configuration, includes, environment or a file whose content names another file; hard links inside the folder cannot be detected; a file can change between the check and the program opening it; a literal in a rule is exempt, including a flag that runs a command; a recursive program reads everything in the folder, and one that follows links (`-R`, `-L`) leaves it through links inside it; on a case-sensitive volume on macOS, names that differ only in letter case are treated as the same; some programs (`git`, `terraform plan`, `make`, `npm`) execute code they find in the folder or in your home configuration; a rule that writes files in the folder together with a rule that runs something from it lets the agent run its own code; and a program that leaves its process group survives the timeout. Allow only programs and flags you would run on that folder yourself. Protected locations are the ones `ksproxy start` recorded, and programs are found through the absolute `PATH` entries outside the folder. See "Local targets".
- **`"any"` is refused for local targets on purpose.** A local target always lists its commands.
- **The allowlist binds the MCP path only.** The sockets and proxy ports belong to you, so an agent that also has an unrestricted local shell can call `ssh -S <sock>` or `curl 127.0.0.1:<port>` directly.
- **An agent that can edit the inventory or session files can widen its own rules.** Same exposure.
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
- an agent whose shell runs in a **sandbox** that cannot read `~/.ksproxy` or `~/.config/ksproxy` and cannot reach local sockets and ports.

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

There are no dependencies to install: `package.json` has none, and tests use only `node:test` and `node:assert/strict`. `npm test` runs `node --test` with Node's built-in coverage over `src/` and `bin/`, and it fails when line, branch or function coverage is below 100%. Keep it at 100%: a change that adds code needs tests that reach it. To see which lines are missed, run the suite with the coverage report and read the "uncovered lines" column:

```
node --test --experimental-test-coverage --test-coverage-include='src/**' --test-coverage-include='bin/**' 'test/*.test.js'
```

Quote the globs so Node, not the shell, expands them. Branch gaps do not show up in that column; a file below 100% in "branch %" has an untested `if`, `?:`, `??` or `catch`, so read the code around its other lines. For a per-branch listing, add `--test-reporter=lcov --test-reporter-destination=coverage.lcov` and look for `BRDA` entries that end in `,0`.

Most tests call the code in the test's own process, so the coverage counts. `start` and `main` take an optional last argument (a process-like object, and for `start` also the checkbox, the health probe and the close time limits), which the tests use to drive signals, streams and timers; the defaults are the real ones. Only `bin/ksproxy.js` is exercised through a child process, and its coverage reaches the report because those tests pass `NODE_V8_COVERAGE` through to the child.

No test contacts a real server or cluster. `ssh` and `kubectl` are replaced through `KSPROXY_SSH` and `KSPROXY_KUBECTL` with the stubs in `test/fixtures/`. `fake-ssh.js` creates and removes the control socket file and answers `-O check` and `-O exit`; it prints `ran <name> <command>` for an exec, and `fail` and `slow` commands give exit 3 and a 10 second wait. `KSPROXY_FAKE_SSH_CHECK_MS` delays each `-O check` answer and `KSPROXY_FAKE_SSH_TRACE` appends `begin` and `end` to a file around it, which the health-check test uses to show that two checks never overlap. `fake-kubectl.js` listens on the `--port` given to `proxy` and answers every request with `KSPROXY_FAKE_KUBECTL_STATUS` (default 200); for any other call it prints its arguments as JSON. `fake-ssh-nostay.js` opens a master without leaving a socket (so `-O check` fails), and `fake-ssh-flood.js` prints 300000 bytes. Each test passes its own environment with `KSPROXY_CONFIG_DIR` and `KSPROXY_STATE_DIR` pointing into a fresh directory under `/tmp`, so the real home directory is never touched. The local-target tests run real programs (`cat`, `ls`, `env` and small node scripts) in temporary folders.
