# Projects: exact rules and limits

The README has the short version. This page lists every rule, message and limit of projects.

A project is a set of targets for one agent, kept in its own inventory file. Use projects when two agents work in two repositories at the same time and each should be offered only its own targets. Nothing changes for you if you never pass `--project`.

A project is not a wall between your own agents: see "What is not in scope" in [SECURITY.md](../SECURITY.md#what-is-not-in-scope).

**Contents**

- [Making and starting a project](#making-and-starting-a-project)
- [Several projects in one start](#several-projects-in-one-start)
- [Sessions, status, log and check](#sessions-status-log-and-check)
- [Project names](#project-names)
- [The name `default`](#the-name-default)
- [What two projects share](#what-two-projects-share)
- [From another machine over ssh](#from-another-machine-over-ssh)

## Making and starting a project

1. `ksproxy init --project shop` writes a sample to `~/.config/ksproxy/projects/shop.json` (folder mode 0700, file mode 0600). The file has the same format as `inventory.json`, with its own `reviewers`. It never overwrites a file.
2. `ksproxy start --project shop --all` opens the targets of that file only. The picker, `--all` and the kind flags choose among them. The session files and the log are in `~/.ksproxy/p/shop/`. If the file is missing, `start` says `inventory not found: <path>; run: ksproxy init --project shop`.
3. The MCP config and the Claude Code line that `start` prints end with `mcp --project shop`. Add them to the MCP configuration of the repository of that agent:

   ```
   claude mcp add ksproxy -- <node> --disable-sigusr1 <path to bin/ksproxy.js> mcp --project shop
   ```

   `ksproxy mcp --project shop` reads only the session of `shop`. With no live session every tool answers `No active session. Ask the user to run` and the command `ksproxy start --project shop`.

## Several projects in one start

`ksproxy start --project shop,ops --all` runs several projects in one process and one terminal. `--project` takes a comma-separated list only for `start`.

- Each project runs as a separate `start` would: its own inventory file, state folder, session, log and health checks.
- Before anything opens, `start` checks every project. If one check fails, nothing opens, and `start` exits 1 with the message of the first failure.
- With several projects, every output line starts with `[NAME] `, such as `[shop] `.
- The kind flags, such as `--ssh a,b`, need a single project.
- Without `--all`, the picker runs once per project in a terminal. Outside a terminal, several projects need `--all`.
- When one project stops, all of them stop, and `start` exits 1.

## Sessions, status, log and check

- **Sessions run side by side.** Sessions of different projects, and the default session, run at the same time. Each has its own ssh connections, proxies, sockets, working folders and log.
- **One session per project.** Only one session runs at a time for each project, and for the default (no project).
- **`ksproxy status`** without `--project` lists every live session, the default first, then each project by name, under `session pid N, started T` or `project shop: session pid N, started T`. It exits 0 when at least one session is live and every target is up.
- **`ksproxy status --project shop`** shows that session only. With none live it says `no session — run: ksproxy start --project shop`.
- **`ksproxy log --project shop`** shows the log of that project. Without `--project` it shows the default log.
- **`ksproxy check --project shop ssh web1 uptime`** reads the file of that project. There `--project` must come before the kind.

## Project names

- A project name is 1 to 24 characters: lower-case letters, digits, `-` and `_`, starting with a letter or a digit.
- It is short because it is part of every socket path.
- Any other name is a usage error (exit 2).
- Only the flag chooses a project. An environment variable of your shell never does.

## The name `default`

- **`default` means the default inventory** (`inventory.json`) wherever `--project` is accepted. `--project default,shop` runs the default inventory and `shop`, and `--project default` is the same as no `--project`.
- **So `default` is not the name of a project,** and `ksproxy init --project default` writes `inventory.json`.
- **An old `projects/default.json` is still read.** No command uses it as a project, but ksproxy still reads it, so that the files it protects stay protected and its ports stay taken.
- **While a project named `default` still exists** (a file `projects/default.json` in the config folder, or a folder `p/default` in the state folder), every command given `--project default` is refused with `--project default now means inventory.json, but an old project named default is still here (PATH); rename it, for example to default-old, and update its agent configs`, where PATH is the file or the folder.

## What two projects share

Nothing is shared between two project files. A target written in two files is opened twice, once for each running project.

Kubernetes ports are checked across files:

- A `proxyPort` or `tunnel.localPort` may be named in one inventory file only, because the port is what ties a cluster to its proxy.
- When another inventory file, or a live session of another project or of the default, names the same port, `start` skips that cluster with `port 8001 is also used by project ops; give each project its own port`. So a call through one project never reaches the cluster of another.
- When another inventory file cannot be read or is not valid JSON, `start` skips every cluster with `cannot read <file> to check its ports`.
- `ksproxy init`, with or without `--project`, writes a sample whose ports no other inventory file and no live session uses.

## From another machine over ssh

An agent on another machine can use a project of this machine over ssh only with a key that is limited to that one command.

- Put the options `restrict,command="<node path> --disable-sigusr1 <path to bin/ksproxy.js> mcp --project shop"` before that key in `~/.ssh/authorized_keys` of this machine.
- Then the MCP command of the other machine is `ssh <this machine>`, and the key can run nothing else.
- **Without those options the other machine gets a full shell of this user,** which reaches the credentials and sockets of every project.
- This ssh way needs no network port of ksproxy. The other way, with a port and a token, is in [NETWORK-ACCESS.md](NETWORK-ACCESS.md).
