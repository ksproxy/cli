# Let your agent propose a target

You can ask an AI agent to write the inventory entry for a target, but the agent must not apply it. This page gives a prompt for that. With it, the agent answers with an entry, the checks that test its rules and the commands to run, and you read them and decide.

**Contents**

- [What this is](#what-this-is)
- [The rules that keep you in control](#the-rules-that-keep-you-in-control)
- [The prompt](#the-prompt)
- [Example: logs of a service on a server](#example-logs-of-a-service-on-a-server)
- [Example: a database behind a bastion server](#example-a-database-behind-a-bastion-server)
- [Every kind](#every-kind)
- [Read the proposal before you use it](#read-the-proposal-before-you-use-it)

## What this is

You tell the agent what you want it to reach. It answers with one inventory entry, the `ksproxy check` lines that test the rules of that entry, and the `ksproxy doctor` and `ksproxy start` commands. You read them, edit the inventory yourself and start ksproxy in your own terminal. The agent proposes; you apply.

If a session already runs, stop it with Ctrl-C in its terminal before you run `doctor`, then start again with every target you want, for example `ksproxy start --ssh web1 --pg shop-db`: `start` opens only the targets you name.

## The rules that keep you in control

- **The agent never edits the inventory, or anything in the config folder or the state folder of ksproxy.** By default these are `~/.config/ksproxy` (the inventory and the project files are there) and `~/.ksproxy` (the sessions and the log). The variables `KSPROXY_CONFIG_DIR`, `XDG_CONFIG_HOME` (the folder is then `XDG_CONFIG_HOME/ksproxy`, and it counts only when `KSPROXY_CONFIG_DIR` is not set) and `KSPROXY_STATE_DIR` move them. An agent that could write its own rules would give itself access. ksproxy refuses a `local` target whose folder overlaps either folder and, on a local target, any wildcard argument that names them (see [LOCAL-TARGETS.md](LOCAL-TARGETS.md)). It does not check a path you write into a rule yourself, or what the program itself opens. And a shell of yours can still write there. So do not give the agent a shell of yours. Run it without a general shell, in a sandbox or as another user, as the README says: "Run the agent without a shell of yours, in a sandbox, or as another user." See [SECURITY.md](../SECURITY.md#hardening-the-agent).
- **The agent never runs `ksproxy start`, and does not run `ksproxy doctor` either.** `start` runs in your terminal, holds the secrets and may ask you for a password there. `doctor` with no names opens every target with your keys and your environment.
- **The agent never sees a secret.** It names an environment variable, for example `SHOP_DB_PASSWORD`, and you set the value before you start ksproxy.

## The prompt

Copy this text as it is, and add what you want the agent to reach.

```text
You help me set up ksproxy targets. You only PROPOSE; I apply.

The format is in these two pages. Read them before you answer:
https://github.com/ksproxy/cli/blob/main/docs/EXAMPLES.md
https://github.com/ksproxy/cli/blob/main/docs/RULES.md
For one kind, read its own page too: SERVICES.md (the services),
MCP-SERVERS.md, LOCAL-TARGETS.md, TUNNELS.md, in the same folder.

When I ask for access to something:
1. Propose ONE inventory entry as a JSON code block. Say which list of
   the inventory it goes in: ssh, kubernetes, local, http, command,
   elasticsearch, rabbitmq, redis, postgres, mysql, mongodb, kafka or
   mcp. Propose only what I asked for. Offer anything more
   separately, and say what it adds. If a part of the entry can reach
   more than I asked (a search that takes any query, a tool whose
   other arguments are free), leave it out of the entry and offer it
   separately. For an MCP server, ask me for its tool names and their
   arguments; do not guess them.
2. Keep it read-only and as narrow as the task needs: fixed paths and
   fixed names in the rules, a number limited by a regex where a
   command takes one, no "allow": "any", no wide regex. A `regex(`
   rule must match the whole call, its words joined by single spaces
   (on kubernetes too). In it `.` matches any character, a space too:
   write every backslash twice in the JSON, so `\\.` for a dot. For a
   name that changes, use `[a-z0-9][a-z0-9_-]*`: it starts with a
   letter or digit and holds no `.` or `/`, so it can match neither a
   flag nor `..`. Write any fixed part after it, as in
   `[a-z0-9][a-z0-9_-]*\\.log` for a log file. If a name needs a dot,
   write the dot as a fixed `\\.` between two such classes. Do not end
   a rule with `...` unless I asked for any arguments. If I asked for
   a change, list the write rules separately and say what each one
   lets you do.
3. Never write a secret. Name an environment variable for it and tell
   me to set it before I start ksproxy.
4. Give me `ksproxy check KIND NAME CALL` lines for two calls that
   must be allowed and two that must be refused, so that I can test
   the rules. KIND is one of: ssh, kube, local, http, command, es, mq,
   redis, pg, mysql, mongo, kafka, mcp. Quote for my shell a SQL
   statement, the JSON of an mcp call, and any word with one of
   * ? ( ) [ ] { } $ ; | & < > ` \ ~ ! #. Use single quotes. You may
   use double quotes around a statement that holds single quotes only
   when it holds no $, `, \ or !. Otherwise use single quotes and
   write each single quote inside as '\'' (so it's becomes 'it'\''s').
   I must add the entry to my inventory before these lines work.
5. Give me the commands to run: `ksproxy doctor` first, then
   `ksproxy start`. `doctor` takes the same arguments as `start` (the
   kind flags, `--all`, `--project NAME`), or target names as plain
   words. Use the flag of the kind and the target name. The flag of a
   kind is `--` followed by its KIND word from item 4, for example
   `ksproxy doctor --ssh web1`, `--kube` for kubernetes, `--pg` for
   postgres; mcp has none. For an `mcp` target: `ksproxy doctor NAME`,
   then `ksproxy start` with no flag, which asks me which targets to
   open, or `ksproxy start --all` (which opens every target of the
   inventory). If a session already runs, tell me to stop it with
   Ctrl-C before `doctor` (doctor fails while a session of the project
   runs), and to start again with every target I want.
6. Say plainly what the entry lets you do that I may not expect.

Never edit the inventory file, or anything in the config folder or the
state folder of ksproxy (by default ~/.config/ksproxy and ~/.ksproxy,
or the folders that KSPROXY_CONFIG_DIR, XDG_CONFIG_HOME/ksproxy or
KSPROXY_STATE_DIR point to). Never edit your own MCP client
configuration. Never read a kubeconfig, a Kafka client file, a CA file,
ssh keys or any file that holds a secret: ask me what you need to know.
Never run `ksproxy start`, `ksproxy doctor`, `ksproxy init` or
`ksproxy token` yourself. If a tool answers that no session is
running, tell me which `ksproxy start` command to run, and wait.
```

In the prompt, every backslash of a regex is written twice, so a dot is `\\.`, the way the agent must write it inside the JSON of the inventory. The two pages are read from GitHub `main`, so they can describe a newer version than the one you installed.

If the target belongs to a project, tell the agent so. Then the commands get `--project NAME`: `ksproxy check --project NAME ssh web1 ...`, `ksproxy doctor --project NAME --ssh web1` and `ksproxy start --project NAME --ssh web1`. In `check`, `--project NAME` comes before the kind. See [PROJECTS.md](PROJECTS.md).

## Example: logs of a service on a server

You ask: "Let me read the nginx logs on web1."

A good answer. Put this entry in the `ssh` list of the inventory:

```json
{
  "name": "web1",
  "host": "web1.example.com",
  "description": "shop web server, nginx logs only",
  "allow": [
    "regex(journalctl -u nginx -n [1-9][0-9]{0,2} --no-pager)",
    "regex(tail -n [1-9][0-9]{0,2} /var/log/nginx/error\\.log)"
  ]
}
```

It is narrower than the entry of [docs/EXAMPLES.md](EXAMPLES.md#ssh). The number of lines is limited to 999, and only one log file can be read. A `regex(` rule must match all the words of the call, joined by single spaces, and a `.` matches any character, a space too. So the dot of `error.log` is written `\\.` in the file. Without it, the call `tail -n 50 /var/log/nginx/error log` would be allowed, and it reads two files.

Add the entry to your inventory first: `ksproxy check` reads it from there. Then test the rules:

- **Allowed:** `ksproxy check ssh web1 journalctl -u nginx -n 200 --no-pager`
- **Allowed:** `ksproxy check ssh web1 tail -n 50 /var/log/nginx/error.log`
- **Refused:** `ksproxy check ssh web1 journalctl -u nginx -n 100000 --no-pager`: the number has more than 3 digits. ksproxy says a line that begins `REFUSED: not on the allowlist for this target`.
- **Refused:** `ksproxy check ssh web1 tail -n 50 /etc/shadow`: the rules name one file. ksproxy says a line that begins `REFUSED: not on the allowlist for this target`.
- **Refused:** `ksproxy check ssh web1 tail -n 50 /var/log/nginx/error log`: two files. ksproxy says a line that begins `REFUSED: not on the allowlist for this target`.

If a session already runs, stop it with Ctrl-C in its terminal before you run `doctor`, then start again with every target you want, for example `ksproxy start --ssh web1 --pg shop-db`: `start` opens only the targets you name.

Then run these two commands, the first one to find every problem and the second one to open the target:

```text
ksproxy doctor --ssh web1
ksproxy start --ssh web1
```

Warning from the agent: "Use a login without `sudo` rights on web1. The rules match words. The rights of the login are what really stops a change. This entry lets me read the nginx error log and the nginx messages of the journal, and both can show addresses and URLs of your visitors."

## Example: a database behind a bastion server

You ask: "Let me read the orders table of the shop database. Only bastion1 can reach it."

A good answer. Put this entry in the `postgres` list of the inventory:

```json
{
  "name": "shop-db",
  "host": "db1.example.com",
  "database": "shop",
  "user": "agent_ro",
  "passwordEnv": "SHOP_DB_PASSWORD",
  "tls": "verify",
  "caFile": "~/certs/db-ca.pem",
  "tunnel": { "host": "bastion1" },
  "description": "shop database through bastion1, orders only, read only",
  "allow": [
    "select id, status, total from orders where id = *",
    "select count(\\*) from orders where status = *"
  ]
}
```

Notes on the entry:

- `agent_ro` is a database user that can only read the table `orders`. Create it before you start.
- `tunnel` with `host` makes `ksproxy start` reach the database through `bastion1`. See [TUNNELS.md](TUNNELS.md).
- In a rule of this kind, `*` is one value: a number or a string in single quotes, never a name. The SQL star is written `\*`, and in the file `\\*`, as in `count(\\*)`. The rule with `id = *` reads one order by its id and nothing else.
- `"tls": "verify"` checks the certificate of the service against `caFile` (without `caFile`, against the CAs of the system). It is your choice: leave out both `tls` and `caFile`, and the target uses `prefer`.

Add the entry to your inventory first. Then test the rules:

- **Allowed:** `ksproxy check pg shop-db "select id, status, total from orders where id = 42"`
- **Allowed:** `ksproxy check pg shop-db "select count(*) from orders where status = 'open'"`
- **Refused:** `ksproxy check pg shop-db "update orders set status = 'paid' where id = 42"`: ksproxy says a line that begins `REFUSED: "update" can change data or the schema, and this target is read-only`.
- **Refused:** `ksproxy check pg shop-db "select id, status, total from orders where id = 42 or 1 = 1"`: the statement has more words than the rule. ksproxy says a line that begins `REFUSED: not on the allowlist for this target`.

If a session already runs, stop it with Ctrl-C in its terminal before you run `doctor`, then start again with every target you want, for example `ksproxy start --ssh web1 --pg shop-db`: `start` opens only the targets you name.

Set the password in your own terminal, then run the two commands in the same terminal. `ksproxy start` may ask you for the ssh password of `bastion1` there:

```text
export SHOP_DB_PASSWORD='the password of agent_ro'
ksproxy doctor --pg shop-db
ksproxy start --pg shop-db
```

Warning from the agent: "If you leave out `tls`, the servers on the route can read and change the traffic, and ksproxy warns about it. I did not write the password: you set `SHOP_DB_PASSWORD`."

## Every kind

The prompt works for every kind. This table says where the entry of each kind goes, how it is started, which secret you set, whether it may have a `tunnel`, and gives a request you could make. Each kind has at least two full examples in [docs/EXAMPLES.md](EXAMPLES.md).

| Kind | List in the inventory | Flag of `start` | Secret you set | `tunnel` | A request | Examples |
|---|---|---|---|---|---|---|
| `ssh` | `"ssh"` | `--ssh` | none: your own ssh keys, and a password in the terminal of `start` | no (a server behind a server uses `jumps`) | "Let me see the disks of web1." | [ssh](EXAMPLES.md#ssh) |
| `kubernetes` | `"kubernetes"` | `--kube` | none in the entry: the file named by `kubeconfig` | its own, with other fields: see [RULES.md](RULES.md#the-fields) | "Let me look at the pods of the cluster lab." | [kubernetes](EXAMPLES.md#kubernetes) |
| `local` | `"local"` | `--local` | none | no | "Let me read the git log of my project folder." | [local](EXAMPLES.md#local) |
| `http` | `"http"` | `--http` | none, or `bearerEnv`, or `basicUserEnv` with `basicPasswordEnv`, or `headerEnv` (with `headerName`), inside `auth` | yes | "Let me read the dashboards of Grafana." | [http](EXAMPLES.md#http) |
| `command` | `"command"` | `--command` | each `fromEnv` in `env` | no | "Let me list the open issues with the GitHub CLI." | [command](EXAMPLES.md#command) |
| `elasticsearch` | `"elasticsearch"` | `--es` | none, or `userEnv` with `passwordEnv`, or `apiKeyEnv` | yes | "Let me search the log indices for errors." | [elasticsearch](EXAMPLES.md#elasticsearch) |
| `rabbitmq` | `"rabbitmq"` | `--mq` | none, or `userEnv` with `passwordEnv` | yes | "Let me see the size of the queues." | [rabbitmq](EXAMPLES.md#rabbitmq) |
| `redis` | `"redis"` | `--redis` | none, or `passwordEnv`, or `userEnv` with `passwordEnv` | yes | "Let me read the cache keys of the shop." | [redis](EXAMPLES.md#redis) |
| `postgres` | `"postgres"` | `--pg` | `passwordEnv` | yes | "Let me read the orders table." | [postgres](EXAMPLES.md#postgres) |
| `mysql` | `"mysql"` | `--mysql` | `passwordEnv` | yes, without `"tls": "verify"` or `caFile` (see [TUNNELS.md](TUNNELS.md)) | "Let me read the customers of the crm database." | [mysql](EXAMPLES.md#mysql) |
| `mongodb` | `"mongodb"` | `--mongo` | `uriEnv` (the whole connection string) | yes, for a `mongodb://` string with one host and none of the options that [TUNNELS.md](TUNNELS.md) names | "Let me read the orders of the shop database." | [mongodb](EXAMPLES.md#mongodb) |
| `kafka` | `"kafka"` | `--kafka` | none in the entry: the file named by `clientConfig` | no | "Let me see the lag of the consumer group billing." | [kafka](EXAMPLES.md#kafka) |
| `mcp` | `"mcp"` | none: `ksproxy start` with no flag asks which targets to open, or use `--all` | each `fromEnv` in `env` for a local server, or `tokenEnv` (and `userEnv`) with `login` for a remote one | no | "Let me read the issues of the Jira project SHOP." | [mcp](EXAMPLES.md#mcp) |

- **The word for `ksproxy check`** is the flag without `--` (`kube`, `pg`, `mongo`, `es`, `mq`), or `mcp`.
- **A secret that is a file** (a kubeconfig, a Kafka client file) is named in the entry and is never written in it. Tell the agent that the file exists, and do not let it read the file.
- **For `mcp`,** `ksproxy start` with no flag asks which targets to open (or use `ksproxy start --all`), and `ksproxy doctor` checks it by its name (`ksproxy doctor jira`) or with `--all`. `ksproxy doctor` does not print the names of the tools of an MCP server: it prints how many the server listed and how many the rules export, and it names any tool of the rules that the server does not list.

## Read the proposal before you use it

Look for these before you copy an entry into your inventory:

- **`"allow": "any"`.** It allows every call. A proposal for a read-only task has no reason for it.
- **A `*` where a number or a file name should be fixed.** `head -n * FILE` lets the agent read the start of the file up to the output limit. `regex(head -n [1-9][0-9]? FILE)` limits it to 99 lines.
- **`...` at the end of a rule.** It allows any words after it. `get pods -n shop ...` also allows `get pods -n shop -A` and `get pods -n shop -n kube-system`.
- **A namespace that is only in the words.** On a `kubernetes` target, a `-n shop` in a rule keeps other namespaces out only when nothing can follow it. The role behind the kubeconfig is the real limit.
- **A wide `regex(`.** A pattern such as `.*` or `\S+` also matches an option, such as `-delete`.
- **A `.` in a `regex(`.** The pattern must match the whole call, its words joined by single spaces. A `.` matches any character, a space too, so write `\\.` in the file for a dot. A class such as `[a-z0-9./-]+` also matches a flag, and `a/../../etc/shadow`. For a name that changes, use `[a-z0-9][a-z0-9_-]*`: it starts with a letter or digit and holds no `.` or `/`. Write any fixed part after it, as in `[a-z0-9][a-z0-9_-]*\\.log`, and write a dot inside a name as a fixed `\\.` between two such classes.
- **`review` on the target.** A call that no rule allows can be sent to a model, which may allow it (see [MODEL-REVIEW.md](MODEL-REVIEW.md)).
- **More than you asked for.** A proposal for "the keys of a cache" that also allows `GET *` lets the agent read every value. Ask for less.
- **Write words on a read target.** Look for `update`, `delete`, `insert`, `restart`, `apply`, `sudo` and the like, and for `"readOnly": false` (postgres, mysql), `"writes": true` (mongodb, kafka), `"joins": true` (mongodb: `$lookup` and the like read other collections), `manifestRoots` (kubernetes: allows `apply -f`), and `programs` with `paths` on a local target.
- **A login with more rights than the task needs.** The account behind the target is the real boundary. A rule only matches words.

The `ksproxy check` lines and your own reading are the control. The prompt only makes a good proposal more likely.
