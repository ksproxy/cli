# Service targets: databases, queues and HTTP APIs

The README has the short version. This page is the full reference for the nine kinds that talk to a service: `http`, `command`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql`, `mongodb` and `kafka`.

A service target lets the agent send one request, one query or one command to a service that needs a password or a token. The agent never holds that credential. You name the credential in the inventory as the name of an environment variable. `ksproxy start` reads it once, keeps it in its own memory, removes it from the environment of everything else it runs, and uses it to carry out the call. The Kafka kind is the exception: its credentials stay in the client configuration file that you name. `ksproxy start` never reads or hides that file, and the Kafka client reads it on every call. `ksproxy mcp`, the program on the agent's side, only checks the shape of the call and forwards it to `ksproxy start` over a private socket. See "Brokered kinds" in [KINDS.md](KINDS.md) for the exact steps.

Every call is still default-deny. A call runs only when all of these hold, in this order:

1. The kind's strict reader accepts the call. It refuses what it cannot judge.
2. No fixed refusal of the kind applies. A fixed refusal is never lifted by a rule, by a `regex(...)` rule, by a reviewer or by `ksproxy check`.
3. One rule of the target's `allow` list matches the words of the call, or the model reviewer approves it (only when the target has `review`, and only for calls that may be reviewed).

Then the call runs, with the time and output limits below, and one entry is written to the audit log.

**Contents**

- [What every service kind has in common](#what-every-service-kind-has-in-common)
- [http](#http)
- [command](#command)
- [elasticsearch](#elasticsearch)
- [rabbitmq](#rabbitmq)
- [redis](#redis)
- [postgres](#postgres)
- [mysql](#mysql)
- [mongodb](#mongodb)
- [kafka](#kafka)
- [What these kinds do not protect against](#what-these-kinds-do-not-protect-against)

## What every service kind has in common

- **Inventory.** Each kind is a top-level array in `inventory.json`, named after the kind: `"postgres": [ ... ]`. Unknown keys are errors. `name`, `description`, `allow` and `review` work as for the other kinds. The value of a field that names a secret is always the name of an environment variable: capital letters, digits and `_`, not starting with `KSPROXY_` and not a variable the session needs (`PATH`, `HOME`, `SSH_*` and similar).
- **A missing secret.** When the variable is not set or is empty, the target is `SKIPPED` with `<VAR> is not set`, and the other targets still open.
- **Allow rules.** `*` is one word (for `postgres` and `mysql`, one value: see there), `...` is the rest of the words and may only be the last word, `\*` is a literal star (written `\\*` in the inventory file, because JSON uses the backslash itself), and `regex(...)` as the whole rule is a pattern tried on the words joined by single spaces. A regex rule is not tried on a command longer than 1000 characters. A `*` never matches a word that starts with `-`. A rule is words or one `regex(...)`, never both. The full table is in [RULES.md](RULES.md#rule-tokens).
- **`"allow": "any"`.** It is an error for `command`, `postgres`, `mysql`, `mongodb`, `kafka` and `mcp` targets (and ssh targets with `jumps`). It is accepted for `http`, `elasticsearch`, `rabbitmq` and `redis`: then every call that passes the strict reader and the fixed refusals is allowed. Use a list.
- **Time limit.** `timeout_seconds` is an integer from 1 to 600, default 60. The call ends at that limit.
- **Output limit.** Standard output and standard error are each cut at 262144 bytes (256 KiB), and the reply says so. The optional `maxOutputKiB` of a target, an integer from 256 to 4096, raises this limit for that target, up to 4 MiB per stream. `ksproxy start` takes the limit from its own inventory, so a session file edited by hand cannot raise it. The limits of a kind on the size of a result (100 documents for MongoDB, 1,000 rows for MySQL) do not change.
- **Reply.** The reply starts with `exit code: N` (or a note that the call timed out), then the standard output and the standard error. Every secret value of the target is replaced by `[hidden]` in the reply (the Kafka client configuration file is not a secret value that ksproxy holds, so nothing of it is hidden). A secret shorter than 8 characters gives a `WARN` line at `ksproxy start` that names its variable or file: hiding so short a value also hides ordinary text that matches it, which can give it away. When an output was cut, a line right after the first one says so, before the output:
  - **Cut at the limit:** `[stdout cut at 256 KiB: the rest was left out]` (the output limit of the target). The reply shows the first 256 KiB of the output once secrets are hidden, and nothing of its end. This is what a large result gives, whether the client program was stopped at the limit or the output was only a little longer than it.
  - **A call that did not end on its own** (the time limit, a body that broke off, a program stopped at the limit, a reply that was not read further) loses the end of each stream: its last 1 KiB, or 8 KiB for each 1024 characters of the longest secret when that secret has more than 128 characters, back to the end of a line. When what is left is shorter than the limit and 4 KiB, the line is `[stdout cut: the stream did not end on its own, so its end was left out]`. So a short output of a call that timed out is not shown at all. Make such a call end on its own, with a limit on what it reads or a shorter wait of its own.
  - There is no end part and no "showing X of Y" for these kinds, except `[stdout cut: showing 128 KiB of 200 KiB]` when a reply that escapes into many bytes must be made smaller. No line and no size tells the length of a secret, except how much of the end is left out: that tells only whether the longest secret of the target has more than 128 characters, and then its length in steps of 1024 characters. A start of a secret at the end of an output that ended on its own is shown as it is.
  - **A hint of the kind** follows, for example `narrow it: fewer columns, a WHERE and a LIMIT, or count(*) first` for `postgres` and `mysql`. It only suggests: the rules still decide.
  - **Paths.** The 256 KiB are counted before ksproxy removes its own paths from the output, so a reply with removed paths in it can show a little less than 256 KiB. A path that crosses the limit is left out whole. Nothing is dropped from the end of an output because of what it holds.
- **Review.** A call that no rule matches can go to the model reviewer when the target has `review`. Each kind below says which calls are never sent to it. For every kind, a call is also never sent when it has more than 64 words, a word longer than 200 characters, or a word with a space, a control character or a double quote. In SQL a comma, a bracket and a dot are words of their own, and a quoted string or name is one word, so a statement with a quoted text that holds a space is refused instead of reviewed.
- **The log.** The `kind` column of the log and of `ksproxy status` shows the label of the kind. The audit entry keeps the call as text, except for `http`, `elasticsearch`, `rabbitmq` and `mongodb`, where it keeps the method, the path and the query (encoded, at most 1024 characters), or the command name and the collection.
- **Trying a rule.** `ksproxy check <flag> <name> <call...>` says whether a call would be allowed, without opening anything. It uses the flag of the kind, for example `ksproxy check pg shop-db select 1`. For `http`, `elasticsearch` and `rabbitmq` the call is `METHOD PATH [+body]`, for example `ksproxy check es es-logs GET /_cat/indices`; the query cannot be tried. The usage line of `ksproxy check` in `--help` lists the flag of every kind.
- **Health.** `ksproxy start` asks each target's call service every 30 seconds and logs `DOWN` and `UP` as for the other kinds. A target that is `down` for `ksproxy mcp` means that the session did not answer. This check does not test the service itself: a database, queue or API that cannot be reached is found only when a call fails. Only a `postgres` or `mysql` target with `tls` `verify` or `require` connects once when it opens, to check TLS (see "TLS" under [postgres](#postgres)). A target with a `tunnel` also connects once when it opens, to try its route, and its health check asks its shared connection too (see [TUNNELS.md](TUNNELS.md)).
- **Behind a server.** A `postgres`, `mysql`, `redis`, `mongodb`, `http`, `elasticsearch` or `rabbitmq` target may have `"tunnel": { "host": "bastion1", "jumps": [...] }`: `ksproxy start` then reaches the service through that server, and through the `jumps` after it. The target is written as if this machine could reach the service. Details, limits and the exact commands are in [TUNNELS.md](TUNNELS.md). `command`, `kafka` and `mcp` cannot use a tunnel: `this kind cannot use a tunnel`.
- **Which tools the agent sees.** `tools/list` shows the tool of a service kind only when the inventory holds a target of that kind. A tool that is not listed still answers when called.

## http

A custom HTTP API: you give the base URL and the credential, and the rules say which requests may be sent.

```json
{
  "http": [
    {
      "name": "grafana",
      "baseUrl": "https://grafana.example.com",
      "auth": { "bearerEnv": "GRAFANA_TOKEN" },
      "description": "dashboards, read only",
      "allow": ["GET /api/search", "GET /api/dashboards/uid/*", "POST /api/ds/query +body"]
    }
  ]
}
```

`auth` is one of three forms, or left out when the API needs no credential:

| Form | Sends |
|---|---|
| `{ "bearerEnv": NAME }` | `Authorization: Bearer <value>` |
| `{ "basicUserEnv": NAME, "basicPasswordEnv": NAME }` | `Authorization: Basic` with the user and the password |
| `{ "headerName": "X-Api-Key", "headerEnv": NAME }` | that one header with the value. `headerName` is letters, digits and `-`, and may not be `host`, `content-length`, `transfer-encoding`, `connection`, `cookie`, `authorization`, `accept` or `content-type`. |

`baseUrl` may use `https` or `http`, for any host, and may not hold a user name, a password, a query or a fragment. TLS is your choice and is never required. With plain `http` to a host other than `localhost`, `127.0.0.1` or `[::1]`, `ksproxy start` and `ksproxy check` warn that any credential, every request and every answer travel without TLS, so that anyone on the way to the host can read them and the warning asks you to use `https` when the server has it. A scheme other than `http` and `https` is an inventory error.

- **Flag and label.** `ksproxy start --http a,b`. Label `http`.
- **Tunnel.** `tunnel` is allowed. No port is opened: each request goes through its own ssh stream to the host and port of `baseUrl` (80 or 443 when it names none), the `Host` header is the real host, and with `https` the certificate is still checked against the real host. Plain `http` is allowed and gets the warning that the servers on the route can read and change the traffic. A proxy of the environment is never used for a tunnelled request. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `http_request { target, method, path, query?, body?, timeout_seconds? }`. `method` is `GET`, `HEAD`, `POST`, `PUT`, `DELETE` or `PATCH`. `path` starts with `/` and has no query. `query` is an object of strings, numbers and booleans. `body` is a JSON object or array.
- **Words and rules.** The words are the method, one word per path segment with its leading slash, and `+body` when a body is sent: `POST /api/ds/query` with a body is `POST`, `/api`, `/ds`, `/query`, `+body`. A word rule is written as a request line: `METHOD /path` or `METHOD /path +body`. In the path, `*` is one segment, `...` is the rest and only as the last segment, `\*` is a segment that is exactly `*`, and a star inside a longer segment is literal. A rule that ends in `+body` allows a body and needs one. A rule without `+body` refuses a request with a body. Rules:
  - `GET /api/dashboards/uid/*` allows `GET /api/dashboards/uid/abc` and refuses `GET /api/dashboards/uid/abc/versions` and `DELETE /api/dashboards/uid/abc`.
  - `POST /api/ds/query +body` allows that POST with a JSON body and refuses it without one.
  - `regex(GET /api /v[12] /users)` allows `GET /api/v1/users` and `GET /api/v2/users`. The pattern sees the words, so each segment keeps its slash and is separated by a space.
- **The query.** Rules match the method and the path, and `+body`. Rules never match the query, so a rule that allows a path allows it with any query. The query names `_method`, `x-http-method-override`, `x-method-override` and `x-http-method` are always refused, in any letter case, because many web frameworks read them as the method of the request. The reviewer sees the query as one word per name, for example `?q=a+b`, after the words of the path, and its instructions say that these words are the query of the request; the audit log keeps the query too. A query word longer than 200 characters keeps the call from the reviewer. This holds for `http`, `elasticsearch` and `rabbitmq`.
- **Fixed refusals** (the strict reader, before any rule):
  - a method outside the six above;
  - a path that does not start with `/`, is longer than 2048 bytes, holds a space, a control character, `?`, `#`, a backslash, `@` or `;`, has an empty segment (`//` or a slash at the end), or has a segment made only of dots (`.`, `..`, `...`). A servlet container such as Tomcat reads `..;` as `..`, so `;` is refused in every path;
  - a `%` that is not followed by two hex digits, an encoded `/`, `\`, `.`, `;`, `%` or control character (`%2F` and `%3B` included), and an encoding that is not valid UTF-8, such as the overlong `%C0%AE`;
  - a character in a path outside letters, digits and `- . _ ~ ! $ & ' ( ) * + , = : %`;
  - a query with more than 50 names, an empty name, a name longer than 256 characters, a name or value with a control character, a value longer than 2048 characters or a value that is not a string, a finite number or a boolean, and the query names `_method`, `x-http-method-override`, `x-method-override` and `x-http-method` in any letter case;
  - a body that is not an object or array, is larger than 64 KiB, or goes with `GET` or `HEAD`;
  - an unknown field in the request;
  - a path that would leave the base URL.
- **Never reviewed.** A request with a body, because the reviewer sees only the words.
- **Installed on the machine.** Nothing.
- **Secrets in a header.** A bearer token, header value or API key must be printable ASCII, a basic-auth user name may not hold `:`, and neither basic value may hold a control character. Otherwise the target is `SKIPPED` with `<VAR> holds a character that is not allowed`. A secret value is also hidden as a JSON body writes it (a quote, a backslash and the control characters escaped, a slash escaped as PHP does, and the signs less-than, greater-than and ampersand escaped as Go and Rails do).
- **Limits.** The agent sets no header and no host: the host, port and scheme come from `baseUrl`. A redirect is not followed and is an error. The reply is `HTTP <status>`, the content type, an empty line and the body as text, cut at the output limit (256 KiB by default). The exit code is 0 for a status 200 to 299 and 1 otherwise. The common time limit applies. The secret values, and for basic auth the user and password in base64 as the header sends them, are replaced by `[hidden]` in the reply. When the reply did not end on its own, because the time limit came or the stream broke, its end is left out as said under "Reply" above, so a secret that the end cut shows no piece.

## command

Any one client program that you name. ksproxy does not know what the program does; the rules only say which words may follow its fixed arguments.

```json
{
  "command": [
    {
      "name": "disk-report",
      "program": "/usr/local/bin/report",
      "args": ["--format", "text"],
      "env": { "REPORT_TOKEN": { "fromEnv": "REPORT_TOKEN" } },
      "description": "disk usage report",
      "allow": ["usage *", "summary", "regex(usage (daily|weekly))"]
    }
  ]
}
```

- `program` is an absolute path, a path that starts with `~/`, or a plain name of letters, digits and `_ . + -` that `ksproxy start` looks up once, when the target opens, on the absolute entries of its `PATH`. The target is skipped when the program is not found, is not an executable file, or lies inside ksproxy's own state or configuration folders.
- `args` is up to 50 fixed arguments, each at most 1024 bytes and without control characters. A leading `~/` is expanded; the rest is passed as written. Put no secret here: an argument is visible in the process list of the machine.
- `env` maps the name of a variable for the program to `{ "fromEnv": NAME }`, a variable of `ksproxy start` that is read as a secret. It holds at most 50 entries. The program's own name for it may differ from the source name. Both names follow the rule for secret variables above, so the program cannot be given a variable named `PATH`, `HOME` or `NODE_OPTIONS`, and names that start with `LD_` or `DYLD_` are refused too.
- **Flag and label.** `ksproxy start --command a,b`. Label `cmd`.
- **Tool.** `command_exec { target, command, timeout_seconds? }`.
- **Words and rules.** The command is plain words: at most 4096 bytes, split on spaces and tabs, each character one of `A-Z a-z 0-9 _ @ % + = : , . / -`, the first word not starting with `-`. The words are matched against the rules; the program is started with the fixed arguments first and the agent's words after them, without a shell. Rules:
  - `usage *` allows `usage disk` and refuses `usage` and `usage disk extra`.
  - `summary` allows exactly `summary`.
  - `regex(usage (daily|weekly))` allows `usage daily` and `usage weekly`. A word that starts with `-` is allowed by a regex rule only when the pattern holds that exact word, outside a group that a quantifier allows zero times (`?`, `*`, `{0}`, `{0,n}`), so `regex(usage \S+)` and `regex(usage( -x)?( \S+)*)` never allow `usage -x`. Write an optional flag as two alternatives: `regex(stats|stats --json)`.
  - A regex rule may not use a lookaround (`(?=`, `(?!`, `(?<=` or `(?<!`); such a rule is an inventory error. A flag written inside a lookaround, such as `(?!--force)`, would count as held by the pattern, so ksproxy could not tell which flags the rule allows.
- **Fixed refusals.**
  - shell syntax and every character outside the list above;
  - a first word that starts with `-`;
  - a word that starts with `-` and equals one of the fixed `args`, because an option repeated after the fixed ones can change what they meant;
- **Never reviewed.** Nothing beyond the refusals above. A `*` or `...` never matches a word that starts with `-`, so a flag runs only when you wrote it into a rule. A call that no rule matches, a flag included, is refused unless the target has `review` and the model approves it. Turn `review` off on a target where no flag may ever run.
- **Installed on the machine.** The program you name.
- **Limits.** The program runs in an empty private folder that is removed afterwards, with only `PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR` plus the variables you gave in `env`. When one stream grows past the output limit (256 KiB by default) plus a margin of 32 KiB (more when a secret of the target has more than 128 characters: 8 KiB more less 1 KiB for each 1024 characters of the longest one), the program's process group is killed, and the reply shows each stream up to the output limit and says it was cut. At the time limit it is killed too. A program that cannot be started gives exit code `null` and `could not start the program` on standard error.

## elasticsearch

```json
{
  "elasticsearch": [
    {
      "name": "es-logs",
      "url": "https://es.internal.example.com:9200",
      "userEnv": "ES_USER",
      "passwordEnv": "ES_PASSWORD",
      "description": "logs, read only",
      "allow": ["GET /_cluster/health", "GET /_cat/...", "GET /logs-*/_search", "POST /*/_search +body", "GET /*/_mapping"]
    }
  ]
}
```

Use `userEnv` with `passwordEnv` (basic auth), or `apiKeyEnv` (sent as `Authorization: ApiKey <value>`), or neither. Giving both forms is an error. `url` follows the same rules as `baseUrl` of the `http` kind: `http` or `https`, and with plain `http` to another host, `ksproxy start` and `ksproxy check` warn that the credential and every answer can be read by anyone on the way.

- **Flag and label.** `ksproxy start --es a,b`. Label `es`.
- **Tunnel.** `tunnel` is allowed. No port is opened: each request goes through its own ssh stream to the host and port of `url` (80 or 443 when it names none), the `Host` header is the real host, and with `https` the certificate is still checked against the real host. Plain `http` is allowed and gets the warning that the servers on the route can read and change the traffic. A proxy of the environment is never used for a tunnelled request. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `elasticsearch_request { target, method, path, query?, body?, timeout_seconds? }`, with the same inputs as `http_request`.
- **Words and rules.** The same as for `http`: the method, one word per segment, `+body`. The query is not matched by rules, as for `http`. Rules:
  - `GET /_cat/...` allows `GET /_cat/indices` and `GET /_cat/shards/orders`, and refuses `POST /_cat/indices`.
  - `POST /*/_search +body` allows a search with a JSON body on any one index, and refuses a search without a body.
  - `GET /logs-*/_search` allows only the literal index name `logs-*`, because a star inside a segment is literal. Write `GET /*/_search` to allow every index.
- **Fixed refusals** (segments are compared decoded and in lower case):
  - any path with a segment `_bulk`, `_delete_by_query`, `_update_by_query`, `_reindex`, `_scripts`, `_snapshot`, `_security`, `_ingest`, `_ilm`, `_slm`, `_license` or `_xpack` (the 7.x routes to security and the license);
  - `_nodes` followed by a segment `shutdown` or `reload_secure_settings`;
  - `_cluster` followed by a segment `settings` or `reroute`, with any method but `GET`;
  - `DELETE` on an index (a path of one segment or less), on `_all`, and on a path with a `_data_stream` segment;
  - any method but `GET`, `HEAD` or `POST` on a path that ends in `_search`, `_count` or `_msearch`, and any method but `GET` or `HEAD` on a path with a `_mapping`, `_mappings` or `_settings` segment anywhere in it (any other method there writes the mapping or the settings, and Elasticsearch 7 still accepts typed and plural paths such as `/logs/_mapping/_doc` and `/logs/_doc/_mappings`);
  - a body that holds, at any depth, a key whose name holds `script` in any letter case (`script`, `script_fields`, `scripted_metric`, `script_score`, `bucket_script`, `minimum_should_match_script` and the like), a key `runtime_mappings` or `runtime` (runtime fields run a script), or a key `remove_index` (an `_aliases` action that deletes an index); and a body nested deeper than 32 levels;
  - the query names `source` and `source_content_type` in any letter case, because Elasticsearch reads `source` as the request body, which would pass the body checks and a rule without `+body`;
  - everything under "Fixed refusals" of the `http` kind (the strict reader).
- **Never reviewed.** A request with a body.
- **Installed on the machine.** Nothing.
- **Limits.** The same as `http`: no header from the agent, no redirect, reply cut at the output limit (256 KiB by default), body at most 64 KiB, the common time limit. A secret value is hidden as a JSON body writes it, too.

## rabbitmq

This kind speaks only the management HTTP API of RabbitMQ. It does not speak AMQP, so it cannot publish or consume messages.

```json
{
  "rabbitmq": [
    {
      "name": "mq-prod",
      "url": "https://mq.internal.example.com:15671",
      "userEnv": "MQ_USER",
      "passwordEnv": "MQ_PASSWORD",
      "description": "management API, read only",
      "allow": ["GET /api/overview", "GET /api/queues/...", "GET /api/exchanges/...", "GET /api/nodes"]
    }
  ]
}
```

`url` follows the same rules as `baseUrl` of the `http` kind: `http` or `https`, and with plain `http` to another host, `ksproxy start` and `ksproxy check` warn that the credential and every answer can be read by anyone on the way.

- **Flag and label.** `ksproxy start --mq a,b`. Label `mq`.
- **Tunnel.** `tunnel` is allowed. No port is opened: each request goes through its own ssh stream to the host and port of `url` (80 or 443 when it names none), the `Host` header is the real host, and with `https` the certificate is still checked against the real host. Plain `http` is allowed and gets the warning that the servers on the route can read and change the traffic. A proxy of the environment is never used for a tunnelled request. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `rabbitmq_request { target, method, path, query?, body?, timeout_seconds? }`, with the same inputs as `http_request`.
- **Words and rules.** The same as for `http`, and the query is not matched by rules. The default virtual host is written `%2F` in the API. This kind accepts a path segment that is exactly `%2F` (or `%2f`), and its word is `/%2F`. A `%2F` inside a longer segment and every other encoded slash, backslash, dot, semicolon, percent sign or control character are still refused. Rules:
  - `GET /api/queues/...` allows `GET /api/queues` and `GET /api/queues/%2F/orders`.
  - `GET /api/queues/%2F/*` allows one queue of the default virtual host, and refuses another virtual host.
  - `regex(GET /api /nodes)` allows `GET /api/nodes` only.
- **Fixed refusals** (segments are compared decoded and in lower case):
  - a path whose first segment is not `api`;
  - any method but `GET` or `HEAD` on `users`, `permissions`, `topic-permissions`, `user-limits`, `vhost-limits`, `parameters`, `global-parameters`, `policies`, `operator-policies`, `vhosts`, `auth` and `reset` (the second segment);
  - any method but `GET` on `definitions`;
  - taking messages off a queue (a path under `queues` that ends in `get`);
  - purging a queue (`DELETE` on a path under `queues` that ends in `contents`);
  - publishing a message (a path under `exchanges` that ends in `publish`);
  - everything under "Fixed refusals" of the `http` kind, except that a segment that is exactly `%2F` is accepted.
- **Never reviewed.** A request with a body.
- **Installed on the machine.** Nothing.
- **Limits.** The same as `http`. A secret value is hidden as a JSON body writes it, too.

## redis

ksproxy speaks the Redis protocol itself, over TCP or TLS, so nothing has to be installed.

```json
{
  "redis": [
    {
      "name": "cache",
      "host": "cache.internal.example",
      "port": 6379,
      "tls": false,
      "db": 0,
      "userEnv": "REDIS_USER",
      "passwordEnv": "REDIS_PASSWORD",
      "description": "cache, read only",
      "allow": ["GET *", "TTL *", "HGETALL *", "KEYS user:*", "INFO ..."]
    }
  ]
}
```

`port` defaults to 6379, `tls` to `false` and `db` to 0. `userEnv` and `passwordEnv` are both optional, but a user needs a password. With `tls` the certificate is checked against the host name, and there is no way to turn that off. TLS is off unless you write `"tls": true`; without it, the password, every command and every answer travel in plain text, so turn TLS on wherever the server offers it. When the password is set, `ksproxy start` sends `AUTH` first, and `SELECT` when `db` is not 0.

- **Flag and label.** `ksproxy start --redis a,b`. Label `rds`.
- **Tunnel.** `tunnel` is allowed. No port is opened: the connection goes through the ssh stream, and with `tls` the certificate is still checked against the real host. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `redis_command { target, command, timeout_seconds? }`.
- **Words and rules.** The command is plain words separated by spaces and tabs. The command name, and the subcommand of a command that has subcommands (`CONFIG`, `CLIENT`, `ACL`, `CLUSTER`, `OBJECT`, `XINFO` and the like), are turned into capital letters, in the call and in every word rule, before matching. Every other word must match exactly. A star inside a word is literal. Rules:
  - `GET *` allows `get user:42` and `GET user:42`, and refuses `GET a b` and `SET a b`.
  - `KEYS user:*` allows only the command `KEYS user:*`, with the star as written. Write `KEYS *` to allow any one pattern. Take care: the pattern `*` reads the whole keyspace and blocks the server while it does.
  - `regex(HGET user:[0-9]+ name)` allows `HGET user:7 name`. A regex rule sees the command name in capitals.
- **Fixed refusals** (before any rule, and again when the call is carried out):
  - scripts and code: `EVAL`, `EVALSHA`, `EVAL_RO`, `EVALSHA_RO`, `FCALL`, `FCALL_RO`, `FUNCTION`, `SCRIPT`, `MODULE`, `DEBUG`, `TFCALL`, `TFCALLASYNC`, `TFUNCTION`, `PFDEBUG`, `PFSELFTEST`;
  - whole-server commands: `SHUTDOWN`, `FLUSHALL`, `FLUSHDB`, `SWAPDB`, `REPLICAOF`, `SLAVEOF`, `FAILOVER`, `MIGRATE`, `RESTORE`, `RESTORE-ASKING`, `SAVE`, `BGSAVE`, `BGREWRITEAOF`, `REPLCONF`;
  - commands that block or never return: `MONITOR`, `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE`, `SYNC`, `PSYNC`, `WAIT`, `WAITAOF`, `BLPOP`, `BRPOP`, `BLMOVE`, `BRPOPLPUSH`, `BZPOPMIN`, `BZPOPMAX`, `BLMPOP`, `BZMPOP`, and `XREAD` or `XREADGROUP` with `BLOCK`;
  - connection commands: `AUTH`, `HELLO`, `RESET`, `QUIT`, `SELECT`, `MULTI`, `EXEC`, `WATCH`, `DISCARD`;
  - `CLUSTER` except `INFO`, `NODES`, `SLOTS`, `SHARDS` and `MYID`; `CONFIG` except `GET`; `ACL` except `WHOAMI`; `CLIENT` except `INFO`, `ID` and `GETNAME`;
  - `CONFIG GET` with an argument that holds `*`, `?`, `[` or `\`, or that holds `pass`, `auth` or `masteruser` in any letter case. A pattern such as `CONFIG GET *` returns every setting, and names such as `masterauth`, `masteruser` and `tls-key-file-pass` hold credentials that ksproxy does not know and so cannot hide. `CONFIG GET maxmemory` is still allowed when a rule names it. This check is not the real guard: give the target's Redis user no `config` right (for example `-config` or `-@admin` in its ACL) when it does not need one;
  - a command that is empty, longer than 4096 bytes or 64 words, a first word that is not a command name, and a word with a character outside letters, digits and `_ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |`. So a value with a space, a quote or a backslash cannot be sent.
- **Commands that need care in a rule.** `SORT`, `GEORADIUS` and `GEORADIUSBYMEMBER` write a new key when they are given `STORE`, or `STOREDIST` for the geo commands, so a rule such as `SORT ...` allows a write. `KEYS *` reads the whole keyspace. Name these commands with care, with the exact words you mean.
- **Never reviewed.** Nothing beyond the refusals above.
- **Installed on the machine.** Nothing.
- **Limits.** One timer covers the connection and the reply, and it is the call's time limit. A reply larger than the read limit is not shown at all: the call fails with `the reply is larger than the output limit and was cut off`. The read limit is the output limit, 256 KiB by default, plus a margin of 32 KiB, and more when a secret of the target has more than 128 characters (8 KiB less 1 KiB for each 1024 characters of the longest one). That size is counted in the raw reply, secrets included, so whether a reply near the limit is shown can tell something of the length of a secret in it. A smaller reply is shown cut at the output limit. A reply nested deeper than 32 levels or with an unknown type is an error. The reply is shown as the usual Redis client shows it: strings in double quotes with special characters escaped, `(integer) N`, `(nil)` and numbered lists. A refused `AUTH` or `SELECT` gives a fixed text and never repeats the server's answer. The user name and the password, as written and as shown escaped, are replaced by `[hidden]`.

## postgres

```json
{
  "postgres": [
    {
      "name": "shop-db",
      "host": "db.internal.example",
      "port": 5432,
      "database": "shop",
      "user": "agent_ro",
      "passwordEnv": "SHOP_DB_PASSWORD",
      "readOnly": true,
      "tls": "verify",
      "caFile": "~/certs/db-ca.pem",
      "description": "shop database, read only",
      "allow": ["select \\* from orders where id = *", "select count(\\*) from orders", "show server_version", "select ..."]
    }
  ]
}
```

`port` defaults to 5432. `host` is letters, digits, `.` and `-`, not starting with `-`. `database` and `user` are 1 to 63 letters, digits, `_`, `-` and `.`, not starting with `-`. `readOnly` is on unless you write `false`. `tls` and `caFile` are described under "TLS" below. `allow` is a list of statements.

- **TLS.** `tls` is `verify`, `require` or `prefer`. Left out, it is `prefer`, or `verify` when the target names a `caFile`. Written, `verify` and `require` work as below. TLS is your choice and is never required. (`host` cannot be a Unix socket or `::1`.)
  - **`verify`:** TLS is required, and the server's certificate must be signed by a trusted CA and name the host. psql gets `PGSSLMODE=verify-full` and `PGSSLROOTCERT` set to `caFile`, or to `system` for the CAs of this system.
  - **`require`:** TLS is required, and the certificate is not checked, so anyone who can stand between this machine and the server can still read the connection. psql gets `PGSSLMODE=require`.
  - **`prefer`:** TLS when the server offers it, and no check of the certificate, so anyone who can stand between this machine and the server can read the connection and change it. It is the default, and it is the behaviour before `tls` existed. psql gets `PGSSLMODE=prefer`. To check the certificate, write `"tls": "verify"`: it is one word away.
- **`caFile`.** The CA certificate that a `verify` target trusts instead of the CAs of this system: an absolute path, or one that starts with `~/`. With `require` or `prefer` it is an inventory error, since nothing checks the certificate there. It must be a file that can be read when the target opens, or the target is `SKIPPED`. It is not a secret and ksproxy never prints it, but local targets are refused access to it, as to a kubeconfig, so that an agent cannot replace it.
- **The TLS check when the target opens.** For `verify` and `require`, `ksproxy start` and `ksproxy doctor` run `select 1` once, through the same client and settings as a call, with a time limit of 5 seconds. When TLS fails, the target is `SKIPPED` (`FAIL` in doctor) with a fixed reason: `the server's TLS certificate did not verify`, `the server does not offer TLS` or `this psql cannot use the system's CAs`. A line just before it gives the way out, such as `name the CA that signed it in "caFile", or set "tls" to "require" or "prefer" to skip the check`; that line is never cut to the width of the terminal. Any other failure, such as a wrong password or a server that is down, opens the target as before, and the first call shows it.
- **The CAs of this system need psql 16.** libpq knows `PGSSLROOTCERT=system` from version 16 (psql 16 and later). With an older psql, a `verify` target without `caFile` is skipped with `this psql cannot use the system's CAs`: name the CA in `caFile`.
- **Flag and label.** `ksproxy start --pg a,b`. Label `pg`.
- **Tunnel.** `tunnel` is allowed. `psql` connects to `127.0.0.1` and a loopback port of `start` (`PGHOSTADDR`), while `--host` stays the real name, so `"tls": "verify"` still checks the certificate against it. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `postgres_query { target, query, timeout_seconds? }`.
- **Words and rules.** One statement is turned into words: an unquoted word is made lower case, a quoted string (`'...'`) or a quoted name (`"..."`) is one word as written, and each punctuation mark (`( ) , . = < > + - * /` and the others the reader knows) is a word of its own. One `;` at the very end is dropped. A rule is read the same way, where `*` is one value, `\*` is the SQL star, and `...` is the rest. Rules:
  - `select \* from orders where id = *` allows `select * from orders where id = 42` and `... where id = 'a1'`, and `... where id = -1`, and refuses `select password from orders where id = 42`, because only the star may stand where `\*` is, `... where id = id`, because a name is not a value, and `select * from orders where id = 1 or 1 = 1`, because the statement has more words.
  - `select count(\*) from orders` allows `select count(*) from orders` and refuses `select count(*) from orders where x = 1`. A table name is written into the rule: a `*` after `from` can never match, and `ksproxy start` and `ksproxy check` warn: `allow[N]: "*" after FROM, JOIN, INTO, UPDATE, TABLE or DESCRIBE matches one value, never a name, so this rule can never match; write the name, or use a regex(...) rule`. Use a `regex(...)` rule to allow several tables, such as `regex(select count\(\*\) from (orders|customers))`.
  - `select ...` allows any statement that starts with `select`. A fixed refusal or the read-only rule can still refuse it.
  - `regex(select (id|name) from users)` allows `select id from users` and `select name from users`. The pattern sees the lower-case words joined by single spaces, and a quoted string is one word as written.
  - A bare `*` right after `select` or `(` in a rule means one value, not the SQL star. `ksproxy start` and `ksproxy check` warn: `allow[N]: "*" matches one value here (a number or a quoted string); write \* for the SQL star`.
- **What one `*` matches.** One value of the statement, never a name. A value is exactly one of: a number, which is an optional `-` or `+`, digits, and an optional `.` with digits (`42`, `-1`, `+7`, `1.5`, `-0.25`; the reader splits `-1` and `1.5` into several words, and the `*` takes them all); or one string in single quotes (`'a1'`, `'it''s'`, with any text inside). Nothing else is a value: a name or a keyword (`id`, `null`, `true`, `all`, `default`, `current_user`), a word in double quotes or backticks, a punctuation mark, anything in brackets (`(select 1)`, `f(x)`), and a word that starts with a digit but is not only digits (`1e5`, `0x1F`, `1_000`). So `select \* from orders where id = *` refuses `... where id = id`, `... where id = null`, `... where id = 1 or 1 = 1` and `... limit all`. A sign is part of a number only at the start of the statement or after a punctuation mark that is not a closing bracket (`= -1`, `(-1`, `, -1`, `* -1`); after a name, a value, a string or `)` it is the minus sign, so the rule `select a *` refuses `select a - 1`. Where the words after a `*` could also be read as part of a number, the `*` takes the longest number and does not try a shorter one, so it never allows more than the rule says: `where a = * - 1` allows `where a = 5 - 1` and `where a = 5-1`, and `limit * . *` allows nothing, as `1.5` is one value. Write a name into the rule, or use a `regex(...)` rule.
- **A regex rule can match more than you mean.** Inside `regex(...)`, `.*` and `.+` also match spaces and quotes, so `regex(select \* from orders where name = '.*')` also allows `select * from orders where name = 'a' or name <> 'b'`. A negated class such as `[^ ]+` does the same when it does not leave out the quote. `ksproxy start` and `ksproxy check` warn when a regex rule repeats with no upper bound (`*`, `+`, `{n,}`) a part that can match a quote, or a space and other characters (`.`, `\S`, `\W`, `\D`, a class such as `[\s\S]` or `[a-z ]`, or a group that holds one, as in `(.)*` or `(?:.|x)+`), or holds a `[^...]` class without `'`. The check is simple and does not see everything: a repeat with a large upper bound (`.{0,1000}`) or a character written as a code (`\x27`) gives no warning. For one quoted string, write `'[^']*'`: `regex(select \* from orders where name = '[^']*')` allows `... where name = 'a b'` and refuses the statement above.
- **Fixed refusals** (the reader first, then the kind's list, then the read-only rule; none of them is reviewed):
  - the reader: a second statement, a comment (`--` or `/* */`), a backslash outside or inside a quoted string (with `standard_conforming_strings` off, the server would read a backslash in a string as an escape), `$` outside a quoted string (dollar quoting included), an escape string `E'...'` or `U&'...'`, any prefixed string, an unterminated quote, a control character, a character outside the SQL set, an empty statement, and a statement longer than 16384 bytes;
  - `COPY` with `PROGRAM` or with a quoted file name after `FROM` or `TO`;
  - `DO`, `LOAD`, `LISTEN`, `NOTIFY`, `UNLISTEN`, `CHECKPOINT` and `IMPORT` as the first word;
  - `CREATE`, `ALTER` or `DROP` of an extension, language, function, procedure, routine, aggregate, role, user, group, database, tablespace, server, subscription, publication, event, foreign object, operator, cast, conversion, transform, access method or system setting;
  - `SET` or `RESET` of the role, the authorization, the session authorization, the read-only settings or the transaction, also when the name is quoted (`set "role" = x`);
  - transaction and cursor control: `BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`, `ABORT`, `SAVEPOINT`, `RELEASE`, `PREPARE`, `EXECUTE`, `DEALLOCATE`, `DECLARE`, `FETCH`, `MOVE`, `CLOSE`, `LOCK`;
  - a call of `pg_stat_file`, `lo_import`, `lo_export`, `lo_unlink`, `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_rotate_logfile`, `pg_execute_server_program`, `pg_logdir_ls`, `pg_promote`, `pg_switch_wal`, `pg_create_restore_point`, `pg_backup_start`, `pg_backup_stop`, `pg_start_backup`, `pg_stop_backup`, `pg_log_backend_memory_contexts`, `set_config`, `query_to_xml`, `query_to_xmlschema`, `query_to_xml_and_xmlschema`, `cursor_to_xml`, `cursor_to_xmlschema`, `ts_stat`, `ts_rewrite`, `pg_notify`, `connectby`, `xpath_table`, `schedule`, `schedule_in_database`, `unschedule` or `alter_job`, or of a function whose name starts with `pg_read_`, `pg_ls_`, `pg_file_`, `dblink`, `pg_background_` or `crosstab`, or of any function of the schema `cron` (`cron.schedule`). A function name is compared with and without its schema, so `pg_catalog.pg_read_file(...)` is refused too;
  - a call of `pg_sleep`, `pg_sleep_for` or `pg_sleep_until`, or of a function whose name starts with `pg_advisory_` or `pg_try_advisory_`;
  - on a read-only target: a first word `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `ALTER`, `DROP`, `GRANT`, `REVOKE`, `COMMENT`, `REFRESH`, `REINDEX`, `CLUSTER`, `CALL`, `REPLACE`, `RENAME`, `VACUUM`, `ANALYZE`, `REASSIGN`, `SECURITY`, `OPTIMIZE`, `REPAIR`, `CHECKSUM`, `CACHE` or `LOAD`; `INTO` followed by a name, as in `SELECT ... INTO new_table`, which makes a table; and a statement that starts with `WITH` or `EXPLAIN` and holds `INSERT`, `UPDATE`, `DELETE` or `MERGE`. `VACUUM` and `ANALYZE` are refused here because a read-only transaction does not stop them.
- **Never reviewed.** Every refusal above.
- **Installed on the machine.** `psql`, found on the `PATH` of `ksproxy start`; psql 16 or later for a `verify` target without `caFile`. The environment variable `KSPROXY_PSQL` may name another program.
- **Limits.** `psql` is started without a shell, in an empty private folder, with `--no-psqlrc`, `ON_ERROR_STOP=1`, `FETCH_COUNT=1000` (it reads 1000 rows at a time instead of holding the whole result) and the statement as one argument. The password is only in the program's environment, with `PGSSLMODE` and `PGSSLROOTCERT` (see "TLS"); no other `PG...` variable of the environment of `ksproxy start` reaches psql. The connection asks for `statement_timeout` set to the call's time limit in milliseconds and `standard_conforming_strings=on`, and, unless `readOnly` is `false`, `default_transaction_read_only=on`. A connection pooler can drop these startup settings without an error, so psql also sets them inside the session: with `--single-transaction`, every `--command` runs in one transaction, first `SET TRANSACTION READ ONLY` (unless `readOnly` is `false`), then `SET LOCAL statement_timeout = <ms>` and `SET LOCAL standard_conforming_strings = on`, and the agent's statement last. The connection time limit is 10 seconds. There is no row limit; when one stream grows past the output limit (256 KiB by default) plus a fixed margin of 32 KiB the program is stopped, and the reply shows each stream up to the output limit. A password inside a json, jsonb or array value of a row is also hidden as JSON writes it (a quote and a backslash escaped).
- **Every statement runs inside a transaction.** A statement that cannot run inside a transaction, such as `VACUUM`, `CREATE DATABASE` or `CREATE INDEX CONCURRENTLY`, is therefore not possible through this kind: it fails with an error from the server.

## mysql

MySQL and MariaDB.

```json
{
  "mysql": [
    {
      "name": "crm-db",
      "host": "crm-db.internal.example",
      "port": 3306,
      "database": "crm",
      "user": "agent_ro",
      "passwordEnv": "CRM_DB_PASSWORD",
      "client": "mysql",
      "readOnly": true,
      "caFile": "~/certs/db-ca.pem",
      "description": "crm database, read only",
      "allow": ["show tables", "describe customers", "select \\* from customers where id = *"]
    }
  ]
}
```

The fields are those of `postgres`, with the default `port` 3306 and one more: `client` is `mysql` (the default) or `mariadb`, and it names the program to run.

- **TLS.** `tls` and `caFile` work as for `postgres`, with the same defaults (`prefer`, or `verify` with a `caFile`) and the same check when the target opens. The program that `client` names can be either client: on Debian and Ubuntu, `mysql` is the MariaDB client. So for `verify` and `require`, ksproxy first runs the program with `--version` and picks the options by what it says:
  - **The MySQL client:** `--ssl-mode=VERIFY_IDENTITY` for `verify`, `--ssl-mode=REQUIRED` for `require`, and `--ssl-ca=FILE` for `caFile`. These need MySQL 5.7.11 or later.
  - **The MariaDB client:** `--ssl --ssl-verify-server-cert` for `verify`, and `--ssl-ca=FILE` for `caFile`. `require` is refused: the MariaDB client requires TLS only when it checks the certificate, and otherwise goes on in plain text when the server offers no TLS. Such a target is `SKIPPED` with `the MariaDB client cannot require TLS without a check`; write `verify` (with `caFile`) or `prefer`.
  - **`prefer`:** no TLS option for either client, as before. The MySQL client then uses TLS when the server offers it. The MariaDB client before 11.4 does not try TLS at all without an option, so with that client `prefer` means plain text; write `"tls": "verify"` to have TLS there.
  - **Without `caFile`,** both clients use the CAs of this system, as their TLS library finds them.
- **Flag and label.** `ksproxy start --mysql a,b`. Label `my`.
- **Tunnel.** `tunnel` is allowed. The client connects to `127.0.0.1` and a loopback port of `start` over TCP. `"tls": "verify"`, and a `caFile`, which makes `verify` the default, are refused in the inventory with a reason, because the client checks the certificate against `127.0.0.1`; `prefer` (the default without `caFile`) works. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `mysql_query { target, query, timeout_seconds? }`.
- **Words and rules.** As for `postgres`, with the quotes of MySQL: `'...'` and `"..."` are strings, and `` `...` `` is a quoted name. Rules:
  - `show tables` allows exactly that statement.
  - `describe customers` allows exactly that statement. A `*` after `describe` can never match, as a table name is not a value.
  - `select \* from customers where id = *` allows `select * from customers where id = 7`. Write `\*` for the SQL star in the rule, and `\\*` in the file.
  - The warning for a bare `*` after `select` or `(` is the same as for `postgres`.
- **What one `*` matches, and regex rules.** The same as for `postgres`: one value, a number or one string in single quotes, never a name, so `where id = *` allows `where id = -1` and refuses `where id = id`. A quoted name in backticks (`` `id` ``) is not a value, and neither is `"id"`, which is a string by default but a name when the server runs with `ANSI_QUOTES`. A regex rule with `.*`, `.+` or a `[^...]` class without `'` gets the same warning; write `'[^']*'` for one quoted string.
- **Fixed refusals** (none is reviewed):
  - the reader: what the `postgres` reader refuses, with the quotes of MySQL, and also a `#` comment, a `/*! ... */` comment, and a first word that the `mysql` client takes as its own command (`system`, `source`, `delimiter`, `tee`, `notee`, `pager`, `nopager`, `edit`, `use`, `connect`, `charset`, `warnings`, `nowarning`, `prompt`, `rehash`, `status`, `help`, `quit`, `exit`, `go`, `ego`, `print`, `resetconnection`, `query_attributes`, `ssl_session_data_print`, `clear`, `?`);
  - `LOAD DATA` and `LOAD XML`;
  - `INTO OUTFILE`, `INTO DUMPFILE`, and `DATA DIRECTORY` or `INDEX DIRECTORY`;
  - `HANDLER`, `INSTALL`, `UNINSTALL`, `SHUTDOWN`, `RESTART`, `RESET`, `PURGE`, `CHANGE`, `START`, `STOP`, `KILL`, `FLUSH`, `GRANT`, `REVOKE`, `CLONE`, `BINLOG` and `IMPORT` as the first word;
  - transaction control and prepared statements: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, `LOCK`, `UNLOCK`, `PREPARE`, `EXECUTE`, `DEALLOCATE`, `XA`;
  - `SET` with `GLOBAL`, `PERSIST`, `PERSIST_ONLY`, `PASSWORD`, `TRANSACTION`, `TRANSACTION_READ_ONLY` or `TX_READ_ONLY`, also as a quoted name (``set `transaction_read_only` = 0``);
  - `CREATE`, `ALTER`, `DROP` or `RENAME` of a user, role, function, procedure, event, trigger, server, tablespace, logfile, instance or resource;
  - a call of `load_file`, `sys_exec`, `sys_eval`, `sys_get` or `sys_set`;
  - a call of `sleep`, `benchmark`, `get_lock`, `release_lock`, `release_all_locks`, `is_free_lock`, `is_used_lock`, `master_pos_wait`, `source_pos_wait`, `wait_for_executed_gtid_set` or `wait_until_sql_thread_after_gtids`, so `select sleep(3600)` and `do sleep(3600)` are refused;
  - on a read-only target: the same first words and the same `INTO` as for `postgres` (`OPTIMIZE`, `REPAIR`, `ANALYZE`, `CHECKSUM`, `CACHE INDEX` and `LOAD INDEX` are refused here, because a read-only transaction does not stop them). `INTO @name` fills a user variable and is not refused.
- **Never reviewed.** Every refusal above.
- **Installed on the machine.** `mysql` or `mariadb`, as `client` says, found on the `PATH` of `ksproxy start`; for `verify` and `require` the MySQL client 5.7.11 or later, and for `verify` any MariaDB client. `KSPROXY_MYSQL` may name another program.
- **Limits.** The client runs with `--no-defaults`, `--batch`, `--quick`, `--default-character-set=utf8mb4`, `--local-infile=0` and `--connect-timeout=10`, the TLS options (see "TLS"), and the statement as one argument. `--default-character-set=utf8mb4` makes the client read the statement as UTF-8 whatever the locale of `ksproxy start`; under a GBK, GB18030 or Big5 locale the client could otherwise read a backtick as part of the character before it. `--local-infile=0` stops the client from sending a file of this machine to the server, and `--quick` makes it print rows as they come instead of holding the whole result in memory. The password is only in the program's environment. `MYSQL_TEST_LOGIN_FILE` names a file in the call's empty private folder that does not exist, so a login file (`~/.mylogin.cnf`), which the MySQL client reads even with `--no-defaults`, cannot replace the password. The session sets `sql_select_limit` to 1000 rows and, unless `readOnly` is `false`, `SET SESSION TRANSACTION READ ONLY`. The statement is at most 16384 bytes. When one stream grows past the output limit (256 KiB by default) plus a fixed margin of 32 KiB the program is stopped, and the reply shows each stream up to the output limit. A password with a backslash, a tab, a newline or a NUL is also hidden as the client writes it in batch mode (a backslash and a letter), and as it shows inside a JSON text of a row.
- **The time limit stops the client, not necessarily the query.** ksproxy sets no time limit on the server, because the setting has another name on each server family and an unknown name would stop every connection. When the call's time limit stops the client, the server may go on with the statement until it ends; the functions that can wait without end are refused above. To limit the time on the server, set it there yourself: `max_execution_time` on MySQL (in milliseconds, for `SELECT`, as a global setting), or `max_statement_time` on MariaDB (in seconds; `ALTER USER ... WITH MAX_STATEMENT_TIME n` sets it for the one account).

## mongodb

```json
{
  "mongodb": [
    {
      "name": "orders-db",
      "uriEnv": "ORDERS_MONGO_URI",
      "database": "shop",
      "writes": false,
      "joins": false,
      "description": "orders, read only",
      "allow": ["find orders", "count *", "aggregate orders", "listCollections"]
    }
  ]
}
```

`uriEnv` names the variable that holds the connection string; it must start with `mongodb://` or `mongodb+srv://`. `database` is 1 to 63 characters without `/ \ . " $ * < > : | ?`, spaces or control characters. `writes` is `false` unless you write `true`. `joins` is `false` unless you write `true`; it lets a command use `$lookup`, `$graphLookup` and `$unionWith`, which read collections other than the one a rule names, and lets `create` make a view with `viewOn` or `pipeline`, which a later `find` on the view's name reads through.

- **Flag and label.** `ksproxy start --mongo a,b`. Label `mgo`.
- **Tunnel.** `tunnel` is allowed. The host of the connection string is replaced as text by a loopback port of `start`, and `directConnection=true` is set. It is refused when the target opens if the string has `mongodb+srv`, no host, several hosts, a socket or percent-encoded host, any TLS option, `loadBalanced`, a proxy option, or an `@` or a `/` in the wrong place that is not percent-encoded. Every such target gets the WARN about the certificate. See [TUNNELS.md](TUNNELS.md#what-each-kind-does).
- **Tool.** `mongodb_command { target, command, timeout_seconds? }`. `command` is one JSON object in the command format of MongoDB, with the command name as its first key: `{"find": "orders", "filter": {"status": "open"}, "limit": 10}`. Types such as `ObjectId` and dates are written in Extended JSON (`{"$oid": "..."}`).
- **How the call is run.** `mongosh` can run JavaScript with access to the machine, so the agent's document is never given to it as code. `ksproxy start` always runs `mongosh --nodb --quiet --norc --eval` with one fixed script, and passes the connection string, the database and the document in the program's environment as data. `HOME` of `mongosh` is the call's empty private folder, which is removed when the call ends: the log that `mongosh` writes under `~/.mongodb/mongosh/` (it holds the commands it ran, with their filters and values) and the settings it reads from there stay in that folder and go away with it. Telemetry of `mongosh` is not switched off by ksproxy. `mongosh` collects anonymous usage data unless it is switched off, and because `HOME` is a new empty folder for each call, a setting kept in your own home folder does not reach it; check your installation's global configuration file (`mongosh.conf`).
- **Words and rules.** The words are the command name and, when its value is a string, the collection: `{"find": "orders", ...}` is `find orders`, and `{"listCollections": 1}` is `listCollections`. For `explain` the words are `explain` and the words of the command inside it (`explain find orders`). A rule sees only these words, not the filter, the pipeline or any other field. Rules:
  - `find orders` allows any `find` on `orders`, with any filter, and refuses `find customers`.
  - `count *` allows `count` on any one collection.
  - `regex(find (orders|customers))` allows `find` on those two collections.
- **Fixed refusals** (none is reviewed):
  - the reader: input that is not one JSON object, a document larger than 64 KiB or nested deeper than 20 levels, a key `__proto__`, a key with a NUL character, an empty document, a command name that is not a letter followed by up to 63 letters, digits and `_`, a collection name with spaces or control characters, and an unknown argument besides `command`;
  - the keys `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$code` and `$scope` at any depth;
  - the stages `$currentOp`, `$listSessions`, `$listLocalSessions` and `$changeStream` at any depth of the document, also inside a `$lookup` or `$unionWith` pipeline, and an `aggregate` whose pipeline is not a list of one-key objects;
  - unless the target has `"joins": true`: the stages `$lookup`, `$graphLookup` and `$unionWith` at any depth. Under the rule `aggregate orders`, a pipeline with `{"$unionWith": {"coll": "users"}}` would otherwise read `users`;
  - unless the target has `"joins": true`: `create` with `viewOn` or `pipeline`. Under the rules `create *` and `find *`, `{"create": "v", "viewOn": "users"}` followed by `{"find": "v"}` would otherwise read `users`;
  - a top-level key that starts with `$` (such as `$db` or `$readPreference`), and the top-level keys `lsid`, `txnNumber`, `autocommit` and `startTransaction`: the client sets the database, the session and the transaction itself;
  - these commands, compared without regard to letter case, and every command that starts with `replSet`: `eval`, `mapReduce`, `shutdown`, `fsync`, `createUser`, `updateUser`, `dropUser`, `dropAllUsersFromDatabase`, `grantRolesToUser`, `revokeRolesFromUser`, `createRole`, `updateRole`, `dropRole`, `dropAllRolesFromDatabase`, `grantPrivilegesToRole`, `revokePrivilegesFromRole`, `setParameter`, `getParameter`, `setFeatureCompatibilityVersion`, `dropDatabase`, `killOp`, `killSessions`, `killAllSessions`, `killCursors`, `getMore`, `logRotate`, `compact`, `repairDatabase`, `copydb`, `clone`, `applyOps`, `getLog`, `getCmdLineOpts`, `connPoolSync`, `authenticate`, `logout`, `saslStart`, `saslContinue`;
  - any command outside the read list (`find`, `aggregate`, `count`, `distinct`, `listCollections`, `listIndexes`, `listDatabases`, `collStats`, `dbStats`, `serverStatus`, `ping`, `hello`, `isMaster`, `buildInfo`, `connectionStatus`, `hostInfo`, `whatsmyuri`, `explain`) on a target without `"writes": true`. `dataSize` is not on the read list, because it takes a full name such as `admin.system.users` and so reaches other databases;
  - on a target with `"writes": true`, any command that is neither on the read list nor one of the commands that change data: `insert`, `update`, `delete`, `findAndModify`, `createIndexes`, `dropIndexes`, `create` and `drop`. So `usersInfo`, `currentOp`, `profile`, `renameCollection` and the other administration commands are refused there too. A command that changes data still runs only when a rule allows it.
- **Never reviewed.** A command that changes data, and, on a target with `joins`, a command that uses `$lookup`, `$graphLookup` or `$unionWith`, because those read other collections than the rules see. A rule may still allow them.
- **Installed on the machine.** `mongosh`, found on the `PATH` of `ksproxy start`. `KSPROXY_MONGOSH` may name another program.
- **Limits.** Before the call is sent, the document is read and judged again and then bounded. `find` returns one batch of at most 100 documents (a smaller `limit` is kept), and `aggregate` returns its first batch of at most 100. `find`, `aggregate`, `count`, `distinct`, `listCollections`, `collStats` and `dbStats` get a `maxTimeMS` of the call's time limit minus one second (a smaller `maxTimeMS` that the agent wrote is kept). The command inside `explain` is bounded the same way, since `explain` with `executionStats` runs it. The fixed script closes a cursor that the reply leaves open and notes on standard error that more results exist. The connection string, its password (the user information ends at the last `@` before the first `?` or `#`, so a password may hold a raw `/`), the value of every option whose name ends in `password`, such as `tlsCertificateKeyFilePassword`, and the value of every `authMechanismProperties` entry whose name ends in `TOKEN` or `PASSWORD`, such as `AWS_SESSION_TOKEN`, each as written and decoded, are replaced by `[hidden]`. The audit entry keeps only the command name and the collection. `ksproxy check mongo NAME DOCUMENT` takes the document as one JSON argument. The connection string and its passwords are also hidden as extended JSON writes them inside a string.

## kafka

The Kafka command-line clients that you installed. ksproxy does not speak the Kafka protocol, and it does not produce or consume messages.

```json
{
  "kafka": [
    {
      "name": "kafka-prod",
      "bootstrap": "kafka.internal.example:9093",
      "clientConfig": "~/secrets/kafka-client.properties",
      "binDir": "/opt/kafka/bin",
      "writes": false,
      "description": "production cluster, read only",
      "allow": ["topics --list", "topics --describe --topic *", "groups --list", "groups --describe --group *"]
    }
  ]
}
```

`bootstrap` is one or more `host:port` joined by commas. `clientConfig` is a file of client settings (optional, absolute or after `~/`); ksproxy never reads or prints it, and local targets are refused access to it. `binDir` is the folder of the client programs (optional; the `PATH` of `ksproxy start` is used when it is left out). `writes` is `false` unless you write `true`.

- **Flag and label.** `ksproxy start --kafka a,b`. Label `kfk`.
- **Tool.** `kafka_exec { target, command, timeout_seconds? }`.
- **Words and rules.** The first word picks the program from a fixed table: `topics` is `kafka-topics`, `groups` is `kafka-consumer-groups`, `configs` is `kafka-configs`, `acls` is `kafka-acls`, `log-dirs` is `kafka-log-dirs`, `broker-api-versions` is `kafka-broker-api-versions`. At open, each client is looked up as the bare name and then with `.sh`, in `binDir` or on the `PATH`. ksproxy adds `--bootstrap-server` and, when set, `--command-config` itself. The command is plain words as for the `command` kind, and the words after the first are given to the program. Rules:
  - `topics --list` allows exactly that and refuses `topics --list --bootstrap-server x`.
  - `topics --describe --topic *` allows `topics --describe --topic orders`.
  - `regex(groups --describe --group (billing|search))` allows those two groups.
  - A `*` or `...` never matches a word that starts with `-`, so each flag is written into the rule. A flag that no rule writes is refused, unless the target has `review` and the model approves it (a write flag is never reviewed).
  - A regex rule may not use a lookaround (`(?=`, `(?!`, `(?<=` or `(?<!`); such a rule is an inventory error. A flag counts as allowed when the pattern holds it, and a flag written inside a lookaround would count too, so ksproxy could not tell which flags the rule allows. A flag inside a group that a quantifier allows zero times (`?`, `*`, `{0}`, `{0,n}`) does not count.
- **Fixed refusals** (none can be lifted by a rule or a reviewer):
  - a first word that is not in the table above;
  - an option that changes the server or the client settings: any option whose name starts with `bootstrap-server`, `bootstrap-controller`, `command-config`, `config-file`, `zookeeper`, `zk-tls-config-file`, `admin.config`, `consumer.config`, `producer.config`, `consumer-property`, `producer-property`, `command-property`, `add-config-file`, `delete-config-file`, `offsets-file`, `from-file`, `reassignment-json-file`, `path-to-json-file`, `truststore` or `keystore`, and any other option whose name holds `file`, `config` or `propert`, except `entity-type`, `entity-name`, `entity-default`, `describe`, `all` and the write flags;
  - a word, or the value after `=` in a word, that points at a file: it holds a `/` and starts with `/`, `~` or `.`, or has a `..` part (a name after `--topic`, `--group`, `--entity-name` or `--principal` may hold a `/`);
  - a word that starts with `@`, which Kafka tools read as an argument file;
  - a write flag, unless `writes` is `true` and a rule matches the command: `--create`, `--delete`, `--alter`, `--add`, `--remove`, `--add-config`, `--delete-config`, `--reset-offsets`, `--delete-offsets`, `--execute`, `--partitions`, `--replication-factor`, `--replica-assignment`, `--force`, `--delete-records`, `--to-earliest`, `--to-latest`, `--to-offset`, `--to-datetime`, `--to-current`, `--shift-by`, `--by-duration`. An abbreviation of one of them, two characters or more after the dashes (`--del`, `--partit`), counts as that write flag. A command with a write flag that no rule matches is refused and is not sent to the reviewer;
  - a first word whose client program was not found when the target opened.
- **Never reviewed.** The refusals above, and a command with a write flag that no rule matches.
- **Installed on the machine.** The Kafka client programs you want to use. The target is skipped when none is found or when `clientConfig` is not an existing regular file, and a note is logged for each client that is missing.
- **Limits.** The same as for the `command` kind: an empty private folder, a small environment (no secret reaches the program, because the client configuration is passed as a file path), a stop when one stream grows past the output limit (256 KiB by default) plus a margin of 32 KiB (more when a secret of the target has more than 128 characters: 8 KiB more less 1 KiB for each 1024 characters of the longest one), and a stop at the time limit. The environment is only `PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`: `JAVA_HOME`, `KAFKA_OPTS` and `KAFKA_HEAP_OPTS` are not passed, so `java` must be found on the `PATH` of `ksproxy start`.

## What these kinds do not protect against

- **The rules do not understand what a request does.** They match words: a method and a path, a Redis command, a SQL statement, a MongoDB command name. A search body, a Redis argument, a SQL function that is not on the fixed list or a MongoDB filter is allowed when a rule matches and no fixed refusal applies. A hole (`*`) accepts any one word.
- **The rights of the account the target uses are the real boundary.** Give each target a database user, an API token or a broker user that can do only what you accept. Read-only sessions and the fixed refusals are a second lock, not the first.
- **Output is not searched for secrets that the service returns.** ksproxy hides the credentials it holds, but a table that holds a password, a document with a token or a configuration that a client prints reaches the agent as it is.
- **TLS is your choice for every kind and is never required.** With plain `http`, with a `postgres` or `mysql` target on `prefer` (the default), or with `redis` and `tls` false (the default), the credential and every answer can be read, and the connection changed, by anyone on the way. Turn TLS on wherever the server offers it.
- **A tunnel adds servers that can read the traffic.** With `tunnel`, every server on the route can read and change the traffic unless the target checks the certificate of the service, and a process on this machine can reach the loopback port of `postgres`, `mysql` and `mongodb` while a call runs (`redis`, `http`, `elasticsearch` and `rabbitmq` open no port). `start` warns for a target that does not check the certificate. See [TUNNELS.md](TUNNELS.md#who-can-read-the-traffic) and [SECURITY.md](../SECURITY.md#what-is-not-in-scope).
- **A rule is only as safe as the program it allows.** This holds for `command` and `kafka`: a flag you write into a rule that reads a file or starts another program is your choice.
- **A pattern can be slow.** A `regex(...)` rule with a repeat inside a repeat gets a warning and still runs. Every match stops after 100 ms and then counts as no match, so a slow rule refuses the call instead of holding up `ksproxy start`.
- **The unit tests use stand-ins; the end-to-end tests use real servers, but not yours.** `npm test` uses stand-ins that listen on the loopback address and replace the client programs. The end-to-end tests ("End-to-end tests" in [DEVELOPMENT.md](DEVELOPMENT.md)) run `http`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql` (MariaDB), `mongodb` and `kafka` against real servers in Docker, and `command` with a stand-in program in place of `gh`. Your server's version, settings and pooler can still differ: try each target once by hand, starting with an account that can only read, and check the log and the reply before you give the account more rights.
