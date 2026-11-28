# Examples: a read-only and a read-and-write target for each kind

This page gives two inventory entries for each kind of target. The first lets the agent look but change nothing. The second also allows a few chosen changes, and nothing more. Copy the one you need and change the names.

How to read the examples:

- **One entry per block.** Each JSON block is one entry. Put it in the array of its kind in `inventory.json`, for example `"postgres": [ { ... } ]`. The two entries of a kind have different names, so you can keep both.
- **Everything else is refused.** A call runs when a rule, a listed program or the reviewer allows it, and no fixed refusal applies. An entry without `allow` refuses every call.
- **Each example has sample calls.** They are written as `ksproxy check` takes them, with the answer it gives: allowed (exit 0) or refused (exit 1). The word after `check` is the flag of the kind (`kube`, `pg`, `mongo` and so on), or `mcp`. `ksproxy check` opens nothing and contacts nothing; for a `local`, `command` or `kafka` target it first looks for the folder, the program, or the client programs and the client file. The tests of ksproxy run every sample on this page.
- **Quotes are for your shell.** A SQL statement, a JSON document or a word with `*` is quoted, so that the shell passes it unchanged.
- **The account is the real boundary.** Rules match the words of a call. They do not understand what the call does. Give each target a login, a role or a token that can do only what its rules allow; the rules are a second lock.
- **No secret in the inventory.** A credential is always named, never written: an environment variable (`passwordEnv`, `tokenEnv`, `fromEnv` and the like) that `ksproxy start` reads, or a file you name, such as a kubeconfig or a Kafka client file.
- **Made-up values.** Hosts end in `example.com`, and names such as `web1`, `shop` and `orders` are examples.

| Kind | Read-only | Read and write |
|---|---|---|
| [ssh](#ssh) | status and logs of a web server | also reload or restart nginx |
| [kubernetes](#kubernetes) | look at a cluster | also restart and scale one deployment |
| [local](#local) | look at a repository | also change files in one folder |
| [http](#http) | read Grafana dashboards | also add annotations |
| [command](#command) | read issues with the GitHub CLI | also set two labels |
| [elasticsearch](#elasticsearch) | search log indices | also update documents of one index |
| [rabbitmq](#rabbitmq) | read queues and nodes | also set up one retry queue |
| [redis](#redis) | read keys | also clear cached pages and switch one flag |
| [postgres](#postgres) | read orders | also set the status of one order |
| [mysql](#mysql) | read customers | also assign and close tickets |
| [mongodb](#mongodb) | read orders | also update orders and add notes |
| [kafka](#kafka) | describe topics and groups | also create one topic and reset one group |
| [mcp](#mcp) | read Jira issues | also comment on issues of one project |

## ssh

A server you reach with your own ssh setup. There is no secret in the entry: `ksproxy start` opens the connection with your keys, and may ask for a password or a passphrase in its terminal.

**Read-only:** the health, the services and the nginx logs of one web server.

```json
{
  "name": "web1",
  "host": "web1.example.com",
  "description": "shop web server, read only",
  "allow": [
    "uptime",
    "df -h",
    "free -m",
    "systemctl status *",
    "journalctl -u nginx -n * --no-pager",
    "tail -n * /var/log/nginx/error.log"
  ]
}
```

- **Can do:** see the load, the disks and the memory, the state of any one service, and the last lines of the nginx logs.
- **Allowed:** `ksproxy check ssh web1 journalctl -u nginx -n 200 --no-pager`
- **Refused:** `ksproxy check ssh web1 systemctl restart nginx`: no rule allows a restart.
- **Refused:** `ksproxy check ssh web1 systemctl status --all`: `*` matches one word that does not start with `-`, so it never matches a flag.
- **Safety:** use a login without `sudo` rights. The rules match words; the rights of the login are what really stops a change.

**Read and write:** the same reads, and nginx may be checked, reloaded and restarted.

```json
{
  "name": "web1-ops",
  "host": "web1.example.com",
  "description": "shop web server, may reload and restart nginx",
  "allow": [
    "uptime",
    "systemctl status *",
    "journalctl -u nginx -n * --no-pager",
    "sudo nginx -t",
    "sudo systemctl reload nginx",
    "sudo systemctl restart nginx"
  ]
}
```

- **Can do:** test the nginx configuration, then reload or restart nginx. Nothing else on the server can change.
- **Allowed:** `ksproxy check ssh web1-ops sudo systemctl reload nginx`
- **Refused:** `ksproxy check ssh web1-ops sudo systemctl restart postgresql`: the rules name nginx only.
- **Safety:** give the login a sudoers entry for exactly these three commands, without a password, since a call cannot answer a password prompt. Never write a rule such as `sudo ...`: it runs anything as root.

## kubernetes

A cluster reached with a kubeconfig that you name. `ksproxy start` runs `kubectl proxy` with it; the agent's calls go through that proxy and never see the kubeconfig. Secret resources, `exec` and many other verbs and flags are always refused (see [RULES.md](RULES.md#the-kubernetes-command-gate)).

**Read-only:** look at workloads, logs and events.

```json
{
  "name": "lab",
  "kubeconfig": "~/.kube/lab-viewer.yaml",
  "proxyPort": 8001,
  "description": "lab cluster, read only",
  "allow": ["get ...", "describe ...", "logs ...", "top pods ...", "events ..."]
}
```

- **Can do:** list and describe resources, read logs, and see pod usage and events, in every namespace the identity may read.
- **Allowed:** `ksproxy check kube lab logs deploy/web -n shop --tail 200`
- **Refused:** `ksproxy check kube lab get secret db-password -n shop`: secret resources are never allowed, whatever the rules say.
- **Refused:** `ksproxy check kube lab delete pod web-7d9c -n shop`: no rule allows `delete`.
- **Safety:** Kubernetes RBAC on the identity in the kubeconfig is the real boundary. Give it a read-only role, such as the built-in `view` cluster role, not your admin login.

**Read and write:** the same reads, and one deployment may be restarted and scaled.

```json
{
  "name": "lab-deploy",
  "kubeconfig": "~/.kube/lab-deployer.yaml",
  "proxyPort": 8002,
  "description": "lab cluster, may restart and scale shop/web",
  "allow": [
    "get ...",
    "describe ...",
    "logs ...",
    "rollout status deployment/web -n shop",
    "rollout restart deployment/web -n shop",
    "regex(scale deployment/web --replicas=[1-5] -n shop)"
  ]
}
```

- **Can do:** restart the deployment `web` in the namespace `shop`, follow the rollout, and scale it to 1 to 5 replicas.
- **Allowed:** `ksproxy check kube lab-deploy scale deployment/web --replicas=3 -n shop`
- **Refused:** `ksproxy check kube lab-deploy scale deployment/web --replicas=20 -n shop`: the pattern allows 1 to 5 replicas only.
- **Refused:** `ksproxy check kube lab-deploy rollout restart deployment/api -n shop`: the rules name `web` only.
- **Word order:** a rule is matched word by word, so the agent must send `-n shop` at the end, as the rule writes it.
- **Safety:** give this identity a Role in `shop` that may change only the deployment `web` (`resourceNames: ["web"]`). A `proxyPort` must differ from every other port in your inventory files.

## local

A folder on your own machine. There is no secret: the commands run as you, so this is the riskiest kind. `"allow": "any"` is refused, and a wildcard never matches a flag.

**Read-only:** look at a repository.

```json
{
  "name": "shop-repo",
  "cwd": "~/projects/shop",
  "description": "shop source, read only",
  "allow": [
    "git status",
    "git log --oneline -n * ...",
    "git diff ...",
    "ls -l ...",
    "cat *",
    "grep -rn * src"
  ],
  "protect": ["config/secrets"]
}
```

- **Can do:** see the git state, the history and the changes, list folders, read one file at a time, and search `src`.
- **Allowed:** `ksproxy check local shop-repo git log --oneline -n 20`
- **Refused:** `ksproxy check local shop-repo cat config/secrets/stripe.json`: the path is inside a `protect` entry.
- **Refused:** `ksproxy check local shop-repo cat certs/server.key`: the name usually holds a secret.
- **Safety:** every path must stay inside the folder, but a program can still read what its own configuration names. `git` reads its configuration and hooks from the folder: allow it only on a repository you trust. `git diff` prints a tracked secret, also one inside `protect`, and `grep -rn word src` reads every file below `src` (a `src/.env` too). Keep secrets untracked and out of `src`.

**Read and write:** a few listed programs may change files in one folder.

```json
{
  "name": "shop-docs",
  "cwd": "~/projects/shop",
  "description": "may change files in docs; new names can land in the folder root",
  "allow": ["git status", "git diff ..."],
  "programs": ["ls", "cat", "grep", "mkdir", "cp", "mv"],
  "paths": ["docs"],
  "protect": ["docs/private"]
}
```

- **Can do:** run `ls`, `cat`, `grep`, `mkdir`, `cp` and `mv` with any flags; every path the command names must be inside `docs`. A new name without a `/` (`cp docs/a.md notes`) lands in the folder root, and a command with no path (`grep -r password`) reads the whole folder, `protect` entries and secret-looking files included. Also `git status` and `git diff`.
- **Allowed:** `ksproxy check local shop-docs mv docs/old-setup.md docs/setup.md`
- **Refused:** `ksproxy check local shop-docs cp src/config.js docs/config.js`: `src/config.js` is outside `paths`.
- **Safety:** a listed program takes any flags and arguments. List only programs you would let the agent use freely on that folder: no shell, interpreter, archive program or program that starts other programs. `ksproxy start` and `ksproxy check` warn when you list one. Leave `grep` out if the folder holds secrets.

## http

Any HTTP API. `ksproxy start` holds the credential and sends each request. A rule is a method and a path; in `ksproxy check`, the word `+body` stands for a JSON body.

**Read-only:** read dashboards from Grafana.

```json
{
  "name": "grafana",
  "baseUrl": "https://grafana.example.com",
  "auth": { "bearerEnv": "GRAFANA_TOKEN" },
  "description": "dashboards, read only",
  "allow": ["GET /api/search", "GET /api/dashboards/uid/*", "GET /api/annotations"]
}
```

- **Can do:** search dashboards, read one dashboard by its uid, and list annotations.
- **Allowed:** `ksproxy check http grafana GET /api/dashboards/uid/shop-overview`
- **Refused:** `ksproxy check http grafana DELETE /api/dashboards/uid/shop-overview`: no rule allows `DELETE`.
- **Safety:** a rule sees the method and the path, never the query. Use a service account token with the Viewer role, so that the token cannot change anything either.

**Read and write:** the same reads, and annotations may be added, for example to mark a deploy.

```json
{
  "name": "grafana-notes",
  "baseUrl": "https://grafana.example.com",
  "auth": { "bearerEnv": "GRAFANA_NOTES_TOKEN" },
  "description": "dashboards, may add annotations",
  "allow": ["GET /api/search", "GET /api/dashboards/uid/*", "GET /api/annotations", "POST /api/annotations +body"]
}
```

- **Can do:** the reads above, and create an annotation from a JSON body.
- **Allowed:** `ksproxy check http grafana-notes POST /api/annotations +body`
- **Refused:** `ksproxy check http grafana-notes DELETE /api/annotations/17`: no rule allows `DELETE`.
- **Safety:** `+body` allows any JSON body, because a rule cannot see what the body says. Give the token only the right to write annotations.

**Behind a server:** the read-only target of this kind, for a Grafana that only `bastion1` can reach.

```json
{
  "name": "grafana-via",
  "baseUrl": "https://grafana.internal.example.com",
  "auth": { "bearerEnv": "GRAFANA_TOKEN" },
  "tunnel": {
    "host": "bastion1"
  },
  "description": "dashboards through bastion1, read only",
  "allow": ["GET /api/search", "GET /api/dashboards/uid/*"]
}
```

No loopback port is opened for `http`: each request goes through the ssh stream. The certificate of an `https` URL is still checked against `grafana.internal.example.com`, and a plain `http` URL is allowed but gets a warning. See [TUNNELS.md](TUNNELS.md).

## command

One program that you name, such as the command-line client of a service. The agent gives the words after the program, and the rules say which words may follow it. The token reaches the program only through `env`.

**Read-only:** read issues and pull requests of one repository with the GitHub CLI.

```json
{
  "name": "gh-shop",
  "program": "gh",
  "env": { "GH_TOKEN": { "fromEnv": "SHOP_GH_READ_TOKEN" } },
  "description": "issues and pull requests of example/shop, read only",
  "allow": [
    "issue list -R example/shop",
    "issue view * -R example/shop",
    "pr list -R example/shop",
    "pr view * -R example/shop",
    "pr checks * -R example/shop"
  ]
}
```

- **Can do:** list and read the issues and pull requests of `example/shop`, and see the checks of a pull request.
- **Allowed:** `ksproxy check command gh-shop issue view 42 -R example/shop`
- **Refused:** `ksproxy check command gh-shop issue view 42 -R example/billing`: the rules name `example/shop` only.
- **Refused:** `ksproxy check command gh-shop issue list --state all -R example/shop`: a flag is allowed only where a rule writes it.
- **Safety:** ksproxy does not know what the program does. It runs as you, with your `HOME`, so it can also read its own saved settings there. Use a fine-grained token that can only read `example/shop`.

**Read and write:** the same reads of issues, and two labels may be added or removed.

```json
{
  "name": "gh-triage",
  "program": "gh",
  "env": { "GH_TOKEN": { "fromEnv": "SHOP_GH_TRIAGE_TOKEN" } },
  "description": "issues of example/shop, may set two labels",
  "allow": [
    "issue list -R example/shop",
    "issue view * -R example/shop",
    "regex(issue edit [0-9]+ (--add-label|--remove-label) (bug|needs-info) -R example/shop)"
  ]
}
```

- **Can do:** read issues, and add or remove the label `bug` or `needs-info` on one issue at a time.
- **Allowed:** `ksproxy check command gh-triage issue edit 42 --add-label bug -R example/shop`
- **Refused:** `ksproxy check command gh-triage issue edit 42 --add-label wontfix -R example/shop`: the pattern names two labels only.
- **Safety:** in a regex rule of a `command` target, a flag is allowed only when the pattern writes it out whole, so `--add-label` and `--remove-label` are spelled in full. Give the token write access to the issues of `example/shop` only.

## elasticsearch

The REST API of Elasticsearch. Rules work as for `http`. Bulk writes, deletes by query, scripts, snapshots, security and a few other areas are always refused (see [SERVICES.md](SERVICES.md#elasticsearch)).

**Read-only:** search the log indices.

```json
{
  "name": "es-logs",
  "url": "https://es.example.com:9200",
  "apiKeyEnv": "ES_LOGS_API_KEY",
  "description": "logs, read only",
  "allow": [
    "GET /_cluster/health",
    "GET /_cat/indices",
    "GET /*/_mapping",
    "POST /*/_search +body",
    "POST /*/_count +body"
  ]
}
```

- **Can do:** see the health of the cluster, list the indices, read a mapping, and search or count in any index pattern, `_all` included.
- **Allowed:** `ksproxy check es es-logs POST /logs-2026.11/_search +body`
- **Refused:** `ksproxy check es es-logs DELETE /logs-2026.11`: deleting an index is never allowed, whatever the rules say.
- **Safety:** `*` is one path segment, which can be `_all`, `*`, a pattern or a comma list, so `POST /*/_search +body` can search every index, `.security` included. The API key decides which indices can be read; give it read rights on the log indices only.

**Read and write:** documents of one index may be updated.

```json
{
  "name": "search-rw",
  "url": "https://es.example.com:9200",
  "userEnv": "ES_SEARCH_USER",
  "passwordEnv": "ES_SEARCH_PASSWORD",
  "description": "products index, may update documents",
  "allow": [
    "GET /_cluster/health",
    "POST /products/_search +body",
    "GET /products/_doc/*",
    "POST /products/_update/* +body"
  ]
}
```

- **Can do:** search `products`, read one document, and update one document by its id.
- **Allowed:** `ksproxy check es search-rw POST /products/_update/sku-1042 +body`
- **Refused:** `ksproxy check es search-rw POST /products/_delete_by_query +body`: `_delete_by_query` is never allowed.
- **Safety:** a rule cannot see what the update body changes. A body key that runs a script is always refused, but give the user write rights on `products` only.

**Behind a server:** the read-only target of this kind, for a cluster that only `bastion1` can reach.

```json
{
  "name": "es-via",
  "url": "https://es.internal.example.com:9200",
  "apiKeyEnv": "ES_LOGS_API_KEY",
  "tunnel": {
    "host": "bastion1"
  },
  "description": "logs through bastion1, read only",
  "allow": [
    "GET /_cluster/health",
    "POST /*/_search +body"
  ]
}
```

No loopback port is opened for `elasticsearch`. The certificate is still checked against `es.internal.example.com`. See [TUNNELS.md](TUNNELS.md).

## rabbitmq

The management HTTP API of RabbitMQ. It cannot publish or take messages, and it cannot purge a queue. The default virtual host `/` is written `%2F` in a path.

**Read-only:** read the state of the broker.

```json
{
  "name": "mq-prod",
  "url": "https://mq.example.com:15671",
  "userEnv": "MQ_USER",
  "passwordEnv": "MQ_PASSWORD",
  "description": "management API, read only",
  "allow": ["GET /api/overview", "GET /api/nodes", "GET /api/queues/%2F/...", "GET /api/exchanges/%2F/..."]
}
```

- **Can do:** see the overview and the nodes, and the queues and exchanges of the default virtual host.
- **Allowed:** `ksproxy check mq mq-prod GET /api/queues/%2F/orders`
- **Refused:** `ksproxy check mq mq-prod DELETE /api/queues/%2F/orders/contents`: purging a queue is never allowed.
- **Safety:** use a RabbitMQ user with the `monitoring` tag and no configure or write permissions.

**Read and write:** one retry queue may be created and bound.

```json
{
  "name": "mq-ops",
  "url": "https://mq.example.com:15671",
  "userEnv": "MQ_OPS_USER",
  "passwordEnv": "MQ_OPS_PASSWORD",
  "description": "management API, may set up orders-retry",
  "allow": [
    "GET /api/overview",
    "GET /api/queues/%2F/...",
    "PUT /api/queues/%2F/orders-retry +body",
    "POST /api/bindings/%2F/e/orders/q/orders-retry +body"
  ]
}
```

- **Can do:** read the queues, create the queue `orders-retry`, and bind it to the exchange `orders`.
- **Allowed:** `ksproxy check mq mq-ops PUT /api/queues/%2F/orders-retry +body`
- **Refused:** `ksproxy check mq mq-ops POST /api/exchanges/%2F/orders/publish +body`: publishing a message is never allowed.
- **Safety:** a rule cannot see the body, such as the settings of the new queue. Give the user permissions that cover only these names.

**Behind a server:** the read-only target of this kind, for a broker that only `bastion1` can reach, through one jump.

```json
{
  "name": "mq-via",
  "url": "https://mq.internal.example.com:15671",
  "userEnv": "MQ_USER",
  "passwordEnv": "MQ_PASSWORD",
  "tunnel": {
    "host": "bastion1",
    "jumps": [
      "ssh -i .ssh/app_key opsuser@192.0.2.10"
    ]
  },
  "description": "management API through bastion1 and one jump, read only",
  "allow": ["GET /api/overview", "GET /api/nodes"]
}
```

No loopback port is opened for `rabbitmq`. With `jumps`, each call makes a full ssh login on every hop. See [TUNNELS.md](TUNNELS.md).

## redis

ksproxy speaks the Redis protocol itself. A command is plain words, so a value with a space or a quote cannot be sent. Scripts, whole-server commands and blocking commands are always refused.

**Read-only:** read keys of a session cache.

```json
{
  "name": "cache",
  "host": "cache.example.com",
  "port": 6380,
  "tls": true,
  "userEnv": "REDIS_USER",
  "passwordEnv": "REDIS_PASSWORD",
  "description": "session cache, read only",
  "allow": ["GET *", "TTL *", "HGETALL *", "SCAN * MATCH session:* COUNT 100", "INFO ..."]
}
```

- **Can do:** read one key, its time to live or one hash, read the `session:` keys page by page, and read the server info.
- **Allowed:** `ksproxy check redis cache 'SCAN 0 MATCH session:* COUNT 100'`
- **Refused:** `ksproxy check redis cache DEL session:7f3a`: no rule allows `DEL`.
- **Safety:** a star inside a word is literal, so `session:*` allows exactly that pattern. Give the Redis user an ACL that allows only these commands, plus `PING` if you use `ksproxy doctor`, which sends it.

**Read and write:** cached pages may be deleted and one feature flag switched.

```json
{
  "name": "cache-ops",
  "host": "cache.example.com",
  "port": 6380,
  "tls": true,
  "userEnv": "REDIS_OPS_USER",
  "passwordEnv": "REDIS_OPS_PASSWORD",
  "description": "cache, may clear pages and switch new-checkout",
  "allow": [
    "GET *",
    "TTL *",
    "regex(DEL cache:page:[a-z0-9-]+)",
    "SET feature:new-checkout on",
    "SET feature:new-checkout off"
  ]
}
```

- **Can do:** read keys, delete one cached page at a time, and turn `feature:new-checkout` on or off.
- **Allowed:** `ksproxy check redis cache-ops DEL cache:page:home`
- **Refused:** `ksproxy check redis cache-ops DEL session:7f3a`: the pattern allows `cache:page:` keys only.
- **Refused:** `ksproxy check redis cache-ops FLUSHDB`: never allowed on a redis target.
- **Safety:** give the Redis user an ACL limited to these commands and these keys (plus `PING` for `ksproxy doctor`), so that the server enforces the same limits.

**Behind a server:** the read-only target of this kind, for a cache that only `bastion1` can reach.

```json
{
  "name": "cache-via",
  "host": "10.0.0.5",
  "port": 6379,
  "passwordEnv": "REDIS_PASSWORD",
  "tunnel": {
    "host": "bastion1"
  },
  "description": "cache through bastion1, read only",
  "allow": [
    "GET *",
    "TTL *"
  ]
}
```

No loopback port is opened for `redis`: the connection goes through the ssh stream. With `"tls": true` the certificate is still checked against `10.0.0.5`. See [TUNNELS.md](TUNNELS.md).

## postgres

One SQL statement per call, run with `psql`. In a rule, `*` is one value (a number or a quoted string, never a name), and `\*` is the SQL star, written `\\*` in the file. Left out, `tls` is `prefer` (TLS when the server offers it, no check of the certificate), and it is `verify` when the entry names a `caFile`, as in these examples: the connection uses TLS and checks the server's certificate against that CA. Write `"tls": "verify"` to check against the CAs of this system (see "TLS" under postgres in [SERVICES.md](SERVICES.md#postgres)).

**Read-only:** read orders.

```json
{
  "name": "shop-db",
  "host": "db.example.com",
  "database": "shop",
  "user": "agent_ro",
  "passwordEnv": "SHOP_DB_PASSWORD",
  "caFile": "~/certs/db-ca.pem",
  "description": "shop database, read only",
  "allow": [
    "select \\* from orders where id = *",
    "select count(\\*) from orders where status = *",
    "select id, status, total from orders where customer_id = * order by id desc limit 20"
  ]
}
```

- **Can do:** read one order, count the orders in one status, and list the last 20 orders of one customer.
- **Allowed:** `ksproxy check pg shop-db "select * from orders where id = 42"`
- **Refused:** `ksproxy check pg shop-db "update orders set status = 'paid' where id = 42"`: the target is read-only.
- **Safety:** `readOnly` is on unless you write `false`, so each statement runs in a read-only transaction. Still use a database user that can only read these tables.

**Read and write:** the status of one order may be changed.

```json
{
  "name": "shop-db-rw",
  "host": "db.example.com",
  "database": "shop",
  "user": "agent_rw",
  "passwordEnv": "SHOP_DB_RW_PASSWORD",
  "caFile": "~/certs/db-ca.pem",
  "readOnly": false,
  "description": "shop database, may change the status of an order",
  "allow": [
    "select \\* from orders where id = *",
    "update orders set status = 'shipped' where id = *",
    "update orders set status = 'cancelled' where id = *"
  ]
}
```

- **Can do:** read one order, and set the status of one order, chosen by its id, to `shipped` or `cancelled`.
- **Allowed:** `ksproxy check pg shop-db-rw "update orders set status = 'shipped' where id = 42"`
- **Refused:** `ksproxy check pg shop-db-rw "update orders set status = 'shipped'"`: without `where id = ...` no rule matches, so a change of every row is refused.
- **Safety:** `"readOnly": false` turns off the read-only transaction for every statement of this target. Give `agent_rw` only `SELECT` on `orders` and `UPDATE` of its `status` column.

**Behind a server:** the read-only target of this kind, for a database that only `bastion1` can reach.

```json
{
  "name": "shop-db-via",
  "host": "10.0.0.5",
  "database": "shop",
  "user": "agent_ro",
  "passwordEnv": "SHOP_DB_PASSWORD",
  "tls": "verify",
  "caFile": "~/certs/db-ca.pem",
  "tunnel": {
    "host": "bastion1"
  },
  "description": "shop database through bastion1, read only",
  "allow": [
    "select \\* from orders where id = *"
  ]
}
```

`psql` connects to a loopback port of `start`, and the certificate is still checked against `10.0.0.5`, the name the target writes. See [TUNNELS.md](TUNNELS.md).

## mysql

MySQL and MariaDB, through the `mysql` or `mariadb` client. Rules, TLS and `caFile` work as for `postgres`. A result holds at most 1,000 rows.

**Read-only:** read customers.

```json
{
  "name": "crm-db",
  "host": "crm-db.example.com",
  "database": "crm",
  "user": "agent_ro",
  "passwordEnv": "CRM_DB_PASSWORD",
  "caFile": "~/certs/db-ca.pem",
  "description": "crm database, read only",
  "allow": ["show tables", "describe customers", "select \\* from customers where id = *"]
}
```

- **Can do:** list the tables, see the columns of `customers`, and read one customer by id.
- **Allowed:** `ksproxy check mysql crm-db "select * from customers where id = 7"`
- **Refused:** `ksproxy check mysql crm-db "select * from customers where id = 7 or 1 = 1"`: the statement has more words than the rule.
- **Safety:** use a user with `SELECT` rights only. The time limit stops the client, not always the statement on the server, so set a time limit on the server too.

**Read and write:** tickets may be assigned and closed.

```json
{
  "name": "crm-db-rw",
  "host": "crm-db.example.com",
  "database": "crm",
  "user": "agent_rw",
  "passwordEnv": "CRM_DB_RW_PASSWORD",
  "caFile": "~/certs/db-ca.pem",
  "client": "mariadb",
  "readOnly": false,
  "description": "crm database, may assign and close tickets",
  "allow": [
    "select \\* from tickets where id = *",
    "update tickets set assignee = * where id = *",
    "update tickets set status = 'closed' where id = *"
  ]
}
```

- **Can do:** read one ticket, set its assignee, or close it.
- **Allowed:** `ksproxy check mysql crm-db-rw "update tickets set assignee = 'ops-team' where id = 7"`
- **Refused:** `ksproxy check mysql crm-db-rw "delete from tickets where id = 7"`: no rule allows `delete`.
- **Safety:** give `agent_rw` only `SELECT` and `UPDATE` of the `assignee` and `status` columns of `tickets`. `"client": "mariadb"` runs the `mariadb` program instead of `mysql`.

**Behind a server:** the read-only target of this kind, for a server that only `bastion1` can reach.

```json
{
  "name": "crm-db-via",
  "host": "10.0.0.5",
  "database": "crm",
  "user": "agent_ro",
  "passwordEnv": "CRM_DB_PASSWORD",
  "tls": "prefer",
  "tunnel": {
    "host": "bastion1"
  },
  "description": "crm database through bastion1, read only",
  "allow": [
    "show tables",
    "describe customers",
    "select \\* from customers where id = *"
  ]
}
```

The client connects to a loopback port of `start`. `"tls": "verify"`, and a `caFile`, are refused with a tunnel, because the client checks the certificate against `127.0.0.1`. See [TUNNELS.md](TUNNELS.md).

## mongodb

One command document per call, run by `mongosh` with a fixed script. A rule sees only the command name and the collection, such as `find orders`, never the filter.

**Read-only:** read orders.

```json
{
  "name": "orders-db",
  "uriEnv": "ORDERS_MONGO_URI",
  "database": "shop",
  "description": "orders, read only",
  "allow": ["find orders", "count orders", "aggregate orders", "listCollections"]
}
```

- **Can do:** find, count and aggregate in `orders` with any filter, and list the collections. A `find` returns at most 100 documents.
- **Allowed:** `ksproxy check mongo orders-db '{"find": "orders", "filter": {"status": "open"}, "limit": 10}'`
- **Refused:** `ksproxy check mongo orders-db '{"find": "customers"}'`: no rule names `customers`.
- **Safety:** `writes` is off unless you write `true`, so only read commands run, and `$lookup` and the other joins are refused unless you set `joins`. Use a database user with read rights only.

**Read and write:** orders may be updated and notes added.

```json
{
  "name": "orders-rw",
  "uriEnv": "ORDERS_MONGO_RW_URI",
  "database": "shop",
  "writes": true,
  "description": "orders, may update orders and add notes",
  "allow": ["find orders", "count orders", "update orders", "insert order_notes"]
}
```

- **Can do:** read `orders`, update documents of `orders`, and insert documents into `order_notes`.
- **Allowed:** `ksproxy check mongo orders-rw '{"insert": "order_notes", "documents": [{"order": 42, "note": "refund sent"}]}'`
- **Refused:** `ksproxy check mongo orders-rw '{"delete": "orders", "deletes": [{"q": {"status": "test"}, "limit": 0}]}'`: no rule allows `delete`.
- **Safety:** a rule does not see the filter or the change, so `update orders` also allows an update of every document of `orders`. Give the user write rights on these two collections only.

**Behind a server:** the read-only target of this kind, through `bastion1` and one jump.

```json
{
  "name": "orders-db-via",
  "uriEnv": "ORDERS_MONGO_URI",
  "database": "shop",
  "tunnel": {
    "host": "bastion1",
    "jumps": [
      "ssh -i .ssh/app_key opsuser@192.0.2.10"
    ]
  },
  "description": "orders through bastion1 and one jump, read only",
  "allow": [
    "find orders",
    "count orders"
  ]
}
```

The connection string in `ORDERS_MONGO_URI` is written as if this machine could reach the server, for example with the host `10.0.0.5`. It must name one host and no TLS option. See [TUNNELS.md](TUNNELS.md).

## kafka

The Kafka command-line clients that you installed. The first word picks the client (`topics`, `groups`, `configs`, `acls`, `log-dirs`, `broker-api-versions`), and ksproxy adds the server address and your client file. A `*` never matches a flag, so each flag is written into a rule.

**Read-only:** describe topics and consumer groups.

```json
{
  "name": "kafka-prod",
  "bootstrap": "kafka.example.com:9093",
  "clientConfig": "~/secrets/kafka-read.properties",
  "binDir": "/opt/kafka/bin",
  "description": "production cluster, read only",
  "allow": ["topics --list", "topics --describe --topic *", "groups --list", "groups --describe --group *"]
}
```

- **Can do:** list topics and consumer groups, and describe one of each.
- **Allowed:** `ksproxy check kafka kafka-prod topics --describe --topic orders`
- **Refused:** `ksproxy check kafka kafka-prod topics --delete --topic orders`: `writes` is off, so every write flag is refused.
- **Safety:** the credentials stay in the client file, which ksproxy never reads. The Kafka ACLs of that user are the real boundary: allow it only Describe on topics and groups, and DescribeConfigs on topics, which `topics --describe` also reads.

**Read and write:** one topic may be created and one group reset.

```json
{
  "name": "kafka-ops",
  "bootstrap": "kafka.example.com:9093",
  "clientConfig": "~/secrets/kafka-ops.properties",
  "binDir": "/opt/kafka/bin",
  "writes": true,
  "description": "production cluster, may create orders-retry and reset billing",
  "allow": [
    "topics --list",
    "topics --describe --topic *",
    "groups --describe --group *",
    "topics --create --topic orders-retry --partitions 6 --replication-factor 3",
    "groups --reset-offsets --group billing --topic orders --to-latest --execute"
  ]
}
```

- **Can do:** the reads above, create the topic `orders-retry`, and reset the group `billing` to the newest messages of `orders`.
- **Allowed:** `ksproxy check kafka kafka-ops groups --reset-offsets --group billing --topic orders --to-latest --execute`
- **Refused:** `ksproxy check kafka kafka-ops topics --delete --topic orders`: a write flag needs a rule that names it.
- **Safety:** `"writes": true` only lets a rule allow a write; each write is still written out in a rule. Give the user ACLs for these two changes only.

## mcp

An MCP server, local or remote. Its allowed tools appear in the agent's own tool list as `TARGET__TOOL`. In `ksproxy check` the word is `mcp`, then the tool, then its arguments as one JSON object.

**Read-only:** read Jira issues through a local server.

```json
{
  "name": "jira",
  "description": "Jira of jira.example.com, read only",
  "command": ["uvx", "--exclude-newer", "2026-11-01", "mcp-atlassian@0.24.8"],
  "env": {
    "JIRA_URL": "https://jira.example.com",
    "JIRA_USERNAME": "agent@example.com",
    "JIRA_API_TOKEN": { "fromEnv": "JIRA_READ_TOKEN" }
  },
  "allow": ["jira_get_issue", "jira_search"]
}
```

- **Can do:** read one issue, and search with JQL.
- **Allowed:** `ksproxy check mcp jira jira_get_issue '{"issue_key": "SHOP-42"}'`
- **Refused:** `ksproxy check mcp jira jira_add_comment '{"issue_key": "SHOP-42", "body": "Done"}'`: the tool is not on the list.
- **Safety:** the server is third-party code that runs as you. Pin its exact version (`@0.24.8`); `--exclude-newer` fixes its dependencies to a date. A rule cannot limit what a JQL query reads, so give the server an account that sees only the projects the agent needs.
- **Remote server:** use `url`, `login` and `tokenEnv` in place of `command` and `env`.

**Read and write:** the same reads, and comments may be added to issues of one project.

```json
{
  "name": "jira-rw",
  "description": "Jira of jira.example.com, may comment on SHOP issues",
  "command": ["uvx", "--exclude-newer", "2026-11-01", "mcp-atlassian@0.24.8"],
  "env": {
    "JIRA_URL": "https://jira.example.com",
    "JIRA_USERNAME": "agent@example.com",
    "JIRA_API_TOKEN": { "fromEnv": "JIRA_TOKEN" }
  },
  "allow": [
    "jira_get_issue",
    "jira_search",
    { "tool": "jira_add_comment", "arguments": { "issue_key": "regex(SHOP-[0-9]+)" } }
  ]
}
```

- **Can do:** the reads above, and add a comment to an issue of the project `SHOP`.
- **Allowed:** `ksproxy check mcp jira-rw jira_add_comment '{"issue_key": "SHOP-42", "body": "Fixed in build 512"}'`
- **Refused:** `ksproxy check mcp jira-rw jira_add_comment '{"issue_key": "HR-7", "body": "Done"}'`: the pattern allows `SHOP-` issues only.
- **Safety:** an argument that a rule does not name is free, so the text of the comment can be anything. Give the account the right to comment only where the agent may.
