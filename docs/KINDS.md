# Kinds of target

A kind of target is one folder under `src/kinds/`. ksproxy has thirteen: `ssh`, `kubernetes` and `local`, and ten brokered kinds that reach a service: the custom kinds `http` and `command`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql`, `mongodb` and `kafka`, and `mcp`, which reaches an MCP server. The core (the files in `src/`) walks the list of kinds and calls the same functions on each one. It does not branch on which kind it is talking to, with the exceptions listed under "What the core still names".

Kinds are files in this repository. Nothing loads a kind from the inventory, from an environment variable or from another package. To add a kind you add a folder and one line to `src/kinds/index.js`, and you build ksproxy again.

This page describes the interface as the code implements it. `test/kind-contract.js` holds the checks that every kind must pass, `test/kinds-contract.test.js` runs them for the kinds in the list, and `test/kinds-echo.test.js` takes a test-only kind (`test/fixtures/kind-echo.js`) through the whole core. A kind may also be brokered: carried out inside `ksproxy start`; see "Brokered kinds".

**Contents**

- [Layout](#layout)
- [The list and the order](#the-list-and-the-order)
- [The interface](#the-interface)
- [Brokered kinds](#brokered-kinds)
- [The engines and the service kinds](#the-engines-and-the-service-kinds)
- [The http engine and the custom http kind](#the-http-engine-and-the-custom-http-kind)
- [The elasticsearch and rabbitmq kinds](#the-elasticsearch-and-rabbitmq-kinds)
- [The command engine and the custom command kind](#the-command-engine-and-the-custom-command-kind)
- [The resp engine and the redis kind](#the-resp-engine-and-the-redis-kind)
- [The SQL reader](#the-sql-reader)
- [The postgres and mysql kinds](#the-postgres-and-mysql-kinds)
- [The mongodb kind](#the-mongodb-kind)
- [The kafka kind](#the-kafka-kind)
- [The mcp kind and its client engine](#the-mcp-kind-and-its-client-engine)
- [What a kind may import](#what-a-kind-may-import)
- [Adding a kind](#adding-a-kind)
- [What a new kind must watch for](#what-a-new-kind-must-watch-for)
- [What the core still names](#what-the-core-still-names)

## Layout

```text
src/kinds/index.js                  the list (KINDS) and the lookups
src/kinds/shared.js                 text that the kinds share (REVIEWED)

src/kinds/ssh/index.js              the kind object
src/kinds/ssh/master.js             its mechanics: the control master, the ssh arguments, the jumps
src/kinds/kubernetes/index.js
src/kinds/kubernetes/cluster.js
src/kinds/local/index.js
src/kinds/local/folder.js

src/kinds/engines/http.js           the http engine: the strict reader, the words, sending one request
src/kinds/engines/http-service.js   what elasticsearch and rabbitmq share: url and auth fields, the session, the decision
src/kinds/engines/command.js        the command engine: running one client program without a shell
src/kinds/engines/resp.js           the resp engine: the Redis protocol over TCP or TLS
src/kinds/engines/sql.js            the SQL reader: one statement into words, the refusals of what it cannot judge
src/kinds/engines/sql-service.js    what postgres and mysql share: the fields, the session, the decision, running the client
src/kinds/engines/mcp-client.js     the MCP client: the protocol of both eras over a transport, and the stdio transport

src/kinds/http/index.js             the custom http kind (brokered, on the http engine)
src/kinds/command/index.js          the custom command kind (brokered, on the command engine)
src/kinds/elasticsearch/index.js    the elasticsearch kind (brokered): its fixed refusals and notes
src/kinds/rabbitmq/index.js         the rabbitmq kind (brokered): its fixed refusals and notes
src/kinds/redis/index.js            the redis kind (brokered, on the resp engine)
src/kinds/redis/words.js            the redis words: the reader and the fixed refusals
src/kinds/postgres/index.js         the postgres kind (brokered, on the SQL engine)
src/kinds/mysql/index.js            the mysql kind (brokered, on the SQL engine, also MariaDB)
src/kinds/mongodb/index.js          the mongodb kind (brokered, on the command engine)
src/kinds/mongodb/document.js       the mongodb command document: the reader, the words and the fixed refusals
src/kinds/mongodb/script.js         the one fixed script that mongosh runs
src/kinds/kafka/index.js            the kafka kind (brokered, on the command engine)
src/kinds/mcp/index.js              the mcp kind (brokered, no flag, on the MCP client engine)
src/kinds/mcp/rules.js              its rules on tools and arguments, and the pinned arguments
src/kinds/mcp/pin.js                the pinned-version check of a local server's command
src/kinds/mcp/export.js             what the agent's tool list gets, and mcp-tools.json
src/kinds/mcp/answer.js             the answer of one tools/call as the result of perform

src/checks.js                       inventory checks that the kinds share
```

An engine under `src/kinds/engines/` holds what several kinds share. It is not a kind and is not in the list; it imports only `src/checks.js`, `src/allowlist.js`, `src/text.js` and the like, never the core. There are seven, listed under "The engines and the service kinds".

A kind is a plain object, the default export of `src/kinds/<name>/index.js`. There is no class and no registration call. The mechanics of a kind sit beside its object and are not part of the interface.

## The list and the order

`src/kinds/index.js` exports `KINDS`, an array in a fixed order: `ssh`, `kubernetes`, `local`, `http`, `command`, `elasticsearch`, `rabbitmq`, `redis`, `postgres`, `mysql`, `mongodb`, `kafka`, `mcp`. A new kind is appended. The order is observable, so it is never sorted:

- targets are opened in list order, and the session file, `AGENT.md`, `tools/list` and the menu follow it;
- the clean-up after a killed run goes in reverse list order, so the cluster proxies are stopped before the sockets are closed.

The core reads `KINDS` when a function is called, never when a module is loaded, so nothing is cached from it. A test can push a kind onto the array in its own process.

The lookups return the kind or `undefined`: `kindByKey(key)`, `kindByFlag(flag)` (never a kind without a flag), `kindByTool(name)` and `kindByCliName(name)`, which finds a kind by `cliName(kind)`, the name that `ksproxy check` takes: the flag, or the key of a kind without a flag. `flaggedKinds()` gives the kinds that have a flag, in list order. `secretFilesOf(inventory)` collects the `secretFiles` of every kind over every inventory entry. `start` and `ksproxy check` add to them the `secretFiles` of every other inventory file (`everySecretFile` in `src/projects.js`), so a local target of one project never reaches a file that another project's file names.

## The interface

A field marked required must be there. A field marked optional may be left out; the core checks `!== undefined` before it calls it.

### Names and the tool

| Field | Required | Type | Used for |
|---|---|---|---|
| `key` | yes | string | The inventory key, `kind` in the session file and in a review request, the key of the selection. Example: `kubernetes`. |
| `flag` | no | string | `--<flag> a,b` on `ksproxy start` and `ksproxy doctor`, `ksproxy check <flag> ...`, the key in the start options, `unknown <flag> target` in a start error. Example: `kube`. A kind may leave it out; see "A kind without a flag". |
| `label` | yes | string | The kind column of a log line and `kind` in audit entries. The column is padded to 4 characters. Example: `kube`, `loc`. |
| `word` | yes | string | `REFUSED (<word> <name>): ...`. |
| `noun` | yes | string | `unknown <noun> "x". Open targets: ...`. Example: `cluster`. |
| `countNoun` | yes | string | The menu hint `2 <countNoun>`. Example: `cluster(s)`. |
| `tool` | yes | object | The MCP tool of the kind, below. |
| `toolBullet` | yes | string | The line for the tool in the Tools list of `AGENT.md`. It must contain `tool.name`. |

The names `key`, `label`, `word`, `noun` and `countNoun`, and `flag` when the kind has one, are non-empty strings, and each is unique across kinds. The rules for the names are these:

- `key`, `flag` and `label` match `/^[a-z][a-z0-9-]*$/`.
- `label` is at most 4 characters, because the log column is 4 wide.
- `flag` is not `all`, `verbose`, `help` or `version`.
- The name on the command line, `cliName(kind)`, is unique across kinds: the key of a kind without a flag is never the flag of another kind, because `ksproxy check` takes either.
- No value that one kind uses as a `key`, a `label` or a tool name equals a `key`, a `label` or a tool name of another kind. The log finds the kind of an entry by those three, so `loc` could not be another kind's key.

`test/kind-contract.js` checks all of this.

#### A kind without a flag

A kind may have no `flag`, so that adding it adds no option to `ksproxy start` (the owner's rule: no new flag). The core then works by the kind key wherever it chose or named kinds by flag:

- `ksproxy start` and `ksproxy doctor` read the kind flags of `flaggedKinds()` only, so no argument (`--undefined`, `--<key>`) names such a kind, and the check that kind flags need a single project never names it. Its targets are chosen with `--all` or the picker, which lists every kind that has targets, by key. `ksproxy doctor` also finds them by their target names.
- The options of `start` hold the names of the kind flags under each flag, as before. `startMany` hands the picks of each project, and `doctor` its target names, to `chooseTargets` by kind key in `named`; `namesByKind(options)` of `src/start.js` reads either form by kind key.
- The usage shows no flag for it on the `start` lines; the `check` lines name it by its key. The error of `ksproxy start` without a terminal names no flag for it.
- `ksproxy check <key> NAME ...` finds its target: `kindByCliName` takes the flag of a kind, or the key of a kind without one.

`test/fixtures/kind-live.js` (the kind `live`, and `liveKind(key)` for more such kinds) is a brokered kind without a flag; `test/kind-live.test.js` and `test/kind-live-projects.test.js` take it through the command line, `start` with one and with several projects, the picker, `check` and `doctor`.

`tool` has these fields:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | The tool name, unique across kinds. |
| `nameKey` | string | The argument that names the target. It must be a property of the input schema. |
| `detailKey` | string | The argument that holds the call, and the field of the audit entry that records it. It must be a property of the input schema. |
| `detailIsArray` | boolean | `true`: the call is a non-empty array of strings (`args`). `false`: it is a string (`command`), or an object with `detailShape`. |
| `detailShape` | `'object'` or left out | `'object'`: the call is an object made of every argument except `nameKey` and `timeout_seconds` (for `http_request`: `method`, `path`, `query`, `body`, and anything else the agent sends, which the kind's reader refuses). `detailIsArray` is then `false`, and `detailKey` is not an argument: it only names the field of the audit entry. Left out: the call is the one argument `detailKey`. |
| `auditedDetail(call)` | function, only with `detailShape` | What the audit entry keeps of an object call, under `detailKey`. For `http_request`: `{ method, path, query, body }`, `query` the encoded query clipped to 1024 characters and only when one was given, `body` a boolean; never the body or a header. |
| `detailText(recorded)` | function, only with `detailShape` | The text of the call in a log line, from what `auditedDetail` recorded. It must accept any value, since the log can be edited. |
| `definition` | object | The entry in `tools/list`. `definition.name` equals `name`. `timeout_seconds` is handled by the core. |
| `listed` | `false` or left out | `false`: the tool is never in `tools/list`, whatever the inventory holds, though `callTool` still answers it. Only `mcp_call` sets it: the agent sees the tools of an MCP server under their own names. |

### Inventory and selection

| Field | Required | Arguments | Returns |
|---|---|---|---|
| `sample` | yes | none (an array) | The entries of this kind that `ksproxy init` writes. |
| `freeSample(taken)` | no | a `Set` of the ports that other inventory files and live sessions use | The entries that `ksproxy init` writes instead of `sample`: the sample with each of its ports moved up to the first one that `taken` does not hold. It must not change `taken`. |
| `ports(entries)` | no | entries of this kind: validated targets, the entries of another inventory file read as JSON and not checked (objects only), or the targets of another live session | An array of the ports on this machine that the entries listen on. It must not throw on a missing or odd field; the core keeps only the integers. A target of this start whose port another inventory file or live session names is `SKIPPED` before `open` (see "A session"). |
| `hint(target)` | yes | a validated target | The text beside the name in the menu. Without a description it must still be non-empty. |
| `validate(entry, where, ctx)` | yes | the raw entry, the label used in messages (for example `echo "x"`), `ctx = { reviewers, seenPorts }` | The validated target, which carries `kind: <key>`. Throws `InventoryError` with a message that starts with `where`. The core checks `maxOutputKiB` before and takes it out of the entry, so `validate` never sees it; `start` adds it to the record of the target. |
| `secretFiles(targets)` | no | every inventory entry of this kind: the validated targets of this inventory, and the entries of every other inventory file read as JSON and not checked (objects only) | An array of files that hold credentials. It must not throw on a missing or odd field of an entry of another file; of those, the core keeps only the texts that are absolute paths once a leading `~` is expanded. The core gives the combined list of all kinds and all files to `open`, `record` and `forCheck`, so a kind never reads another kind's entries. |

The core runs `checkCommon` first (the name, a duplicate name, the description), then `validate`. `ctx.seenPorts` is shared by all kinds, so a port is unique across the inventory. A kind that supports review calls `checkReview(entry, where, reviewers, allow, { programs })` from `src/checks.js`.

### A session

| Field | Required | Arguments | Returns |
|---|---|---|---|
| `reapStale(ctx)` | no | `{ socketDir, env }` | A promise of an array of lines to print after the kind cleaned up what a killed run left. |
| `prepare(targets, ctx)` | no | the selected targets of this kind, `{ env }` | A `Map` from target name to data that `open` gets as `ctx.prepared`. Throws an `Error` when a path is too long; the first error in list order stops the start. |
| `openingMessage(target)` | yes | an inventory target | The text of the `OPENING` line. |
| `open(target, ctx)` | yes | an inventory target, `{ env, sessionDir, secretFiles, secretFilesProblem, prepared, secrets, signal, say }` | `{ ok: true, extras, warn?, notes? }` or `{ ok: false, error }`, directly or as a promise. The core always waits for the result. `secrets` is `{}` for a kind without `secrets`; see "Brokered kinds". `secretFilesProblem` is `null`, or the text `cannot read <file> to protect the files it names` when another inventory file could not be read: a kind that uses `secretFiles` must then refuse with that text, as the local kind does. `signal` and `say` are described under "ctx.signal and ctx.say". |
| `close(opened, ctx)` | no | the opened entry, `{ env }` | A promise. |
| `closeLimit` | with `close` | string | The name under which a test may override the time limit for `close` through `host.limits` of `start`. Today `sshCloseMs` and `kubeCloseMs`. |
| `closeMs` | with `close` | positive integer | The time limit for `close` in milliseconds: 15000 for ssh and 20000 for kubernetes. The core uses `limits[closeLimit] ?? closeMs`. A kind without `close` has none of `closeLimit`, `closeMs` and `onCloseTimeout`. |
| `onCloseTimeout(opened)` | no | the opened entry | Nothing. Called once when `close` passed its limit (the kubernetes kind kills the proxy). |
| `record(opened, ctx)` | yes | the opened entry, `{ env, selected, secretFiles, reviewed }` | The target as written to `session.json`. |
| `sessionFiles(opened, ctx)` | no | the opened entries of this kind (possibly none), `{ env }` | An array of `{ name, text }`, written to the session folder even when the array is empty. |
| `state(sessionTarget, env)` | yes, and none for a brokered kind | a target of `session.json` | A promise of `'up'`, or any other string. Used by `list_targets`, `ksproxy status` and the health check. |
| `downMessage(sessionTarget, state, opened)` | yes | the target, the state that is not `up`, the opened entry | The text of the `DOWN` line. |
| `backMessage` | yes | string | The text of the `UP` line when the target is back. |
| `doctor(opened, ctx)` | no | the opened entry, `{ env, secrets, timeoutMs, signal }` | A promise of `{ ok, detail }`: `ok` a boolean, `detail` a short text. The one fixed, read-only check of `ksproxy doctor` for an opened target; see "The doctor hook" below. |

Notes on these functions:

- `extras` of an `open` result are copied into the opened entry, which is `{ kind: <key>, target, ...extras }`, with `target` the inventory target. `close`, `record`, `sessionFiles`, `downMessage` and the `doctor` hook receive it, and so do `perform` and `probe` of a brokered kind, as `ctx.opened`. It lives in the memory of `start` only: the core never writes it, or anything of the extras, to `session.json`, `AGENT.md`, the audit log or any other file; only what `record` and `sessionFiles` return is written. So `extras` may hold a live object, such as a connection or a child process, and each target reaches its own: two projects in one `start`, each with a target of the same name, keep two opened entries. `warn` replaces the `UP` line with a `WARN` line, and each of `notes` adds a `WARN` line after it.
- `selected` in the `record` context is every selected target of this kind, including the ones that were skipped. `reviewed` is `true` when the review service runs for this target; write `review: true` into the recorded target then.
- A recorded target must have `kind`, `name`, `description`, `allow` and `state`, because the core reads them for `list_targets`, `AGENT.md` and the health check.
- The kind that has `close` is closed again when a stop arrives while it opens. A kind without `close` has nothing to hold open, and a stop cannot leave anything behind.

#### ctx.signal and ctx.say

`open` gets two more fields in its context, in `start` and in `ksproxy doctor` alike:

- `signal` is an `AbortSignal` of this target alone. It fires when a stop is asked while the target opens: Ctrl-C, `SIGTERM` or `SIGHUP`, a closed output, a fatal error, or another project of the same `start` that stops. An `open` that waits (for a server to start, for a login) listens to it and returns at once, usually `{ ok: false, error }`, which gives a `SKIPPED` line. It also fires at a later stop, so a kind may keep it.
- `say(text)` writes one line about this target. In `start` it goes to the terminal's stderr (with the `[NAME] ` prefix of a project when `start` runs several), with the time, kind and target columns of the other lines of the target, empty status and duration columns, then the text (`formatSaidLine` of `src/audit.js`). The text is cleaned: a control character, such as a newline or an escape, is written as `\uXXXX`, so it stays one line. It is not clipped to the width of the terminal, and it is never written to the audit log, so it suits a text the owner must see whole but the log must not keep (the last lines a server wrote to its stderr, or a URL to open). `start` does not hide secrets in it: the kind hides what it must before it calls `say`. The kind may keep `say` and call it later, for example when its server stops; a line written after the output closed is dropped. In `ksproxy doctor` the line goes to stdout among the other lines of the project, with every value that doctor hides in its lines replaced by `[hidden]`.

A kind that does not need them ignores them.

The core keeps what is the same for every kind: the stop checks, the warning for an empty allow list, the order of the log lines (`target_warn`, `target_opening`, then `target_up`, `target_warn` or `target_skipped`, then the notes, then a `target_warn` for each secret shorter than 8 characters), the review service, `AGENT.md`, `mcp.json` and `session.json` (written last), the follower and the health loop.

The core also keeps the ports apart. Before any target opens, `start` reads every other inventory file (the default `inventory.json` and each `projects/NAME.json`) as JSON and the session file of every other live session, and collects the `ports` of each kind that has them (`usedPorts` in `src/projects.js`). A target of a kind with `ports` is then `SKIPPED` after its `OPENING` line, and `open` is not called, when one of its ports is named there (`port N is also used by project ops; give each project its own port`, or `the default inventory` in place of `project ops`), or when another inventory file cannot be read or is not JSON (`cannot read <file> to check its ports`).

#### The doctor hook

`ksproxy doctor` (`src/doctor.js`) opens each target that `start` would open with the same arguments, through the same code (`openTarget` of `src/start.js`, with `ctx.signal` and `ctx.say`), checks it, and closes it again, one target after another. The check is `await kind.doctor(opened, ctx)`, called only after `open` succeeded and before the target is closed:

- `opened` is the entry `start` keeps for an opened target: `{ kind: <key>, target, ...extras }`, with the `extras` that `open` returned.
- `ctx` is `{ env, secrets, timeoutMs, signal }`. `env` is the environment `start` would give the kind, without any credential variable; its state folder is a temporary one (the sockets of the target are there), while the root state and configuration folders are the real ones. `secrets` holds the target's secret values as `open` got them. `timeoutMs` is 30000. `signal` is an `AbortSignal` that fires at Ctrl-C or when the time limit passes.
- It returns a promise of `{ ok: boolean, detail: string }`. `ok: true` gives an `OK` line, `ok: false` a `FAIL` line, both with `detail`. Keep the detail short: it is cut at 200 characters, and every secret value of the target, and every form of one that `hiddenForms` gives, is replaced by `[hidden]` before it is shown.
- A hook that throws, or gives anything but a boolean `ok` and a text `detail`, gives `FAIL` with `the check failed`. A hook that has not answered when the time limit passes gives `FAIL` with `the check did not finish within 30 seconds`.
- A kind without `doctor` is `OK` with the detail `opened` once it opens.

The check is fixed by the kind and read-only: the lightest request that proves the credential works (for example `GET /version` through the opened cluster proxy, or `select 1`). It is never taken from the target's rules, never sent to a reviewer, and it changes nothing on the target. It goes through the kind's own engine, the same way `perform` reaches the service. `ksproxy doctor` writes nothing to the audit log, and no agent can reach a target while it is open for a check.

### A call

| Field | Required | Arguments | Returns |
|---|---|---|---|
| `decide(target, input, env)` | yes | in a live call the target as recorded in the session; in `ksproxy check` the inventory target, or the one that `forCheck` returns. The call (a string, or an array when `detailIsArray`), the environment | The decision, below. |
| `command(sessionTarget, decision, ctx)` | yes, and none for a brokered kind | the target, an allowed decision, `{ dir, env, session, input }` | `{ program, args, options }`: the one process to start. `dir` is the session folder, `input` is the call as given, `options` goes to `run` in `src/exec.js` (`env`, `cwd`). |
| `wordsNotForReview(argv)` | no | the words of a refused call | A string that says why they are not sent to the reviewer, or `null`. Runs after the checks that apply to every kind. |
| `notForReview(argv)` | no | the words | A string or `null`. Runs after `wordsNotForReview`. |
| `reviewServerCheck(entry, subject)` | no | the review entry, the request | `false` when the review service must refuse on its own knowledge. |
| `scrubDirs(sessionTargets)` | no | the session targets of this kind | An array of `{ dir, label }`: folders to hide in output. |
| `scrubText(text, sessionTargets)` | no | the output, the session targets of this kind | The output with this kind's rewrites applied. |
| `forCheck(target, ctx)` | no | the inventory target, `{ env, secretFiles, secretFilesProblem }`, as for `open` | `{ target }` (the target as `decide` needs it) or `{ refusal }` (a text that `ksproxy check` prints as `REFUSED: ...`). |
| `checkExtra(target, decision)` | no | the inventory target, an allowed decision | An array of extra lines for `ksproxy check`. |
| `checkInput(words)` | no | the words after the name on `ksproxy check` | The call as the tool would get it. Without it the words are the call (an array) or joined by spaces (a string). `http` makes `METHOD PATH [+body]` into `{ method, path, body? }`. |
| `ruleWarnings(target)` | no | the inventory target | An array of warning texts, usually `allow[N]: ...`. `ksproxy start` and `ksproxy check` print these instead of `allowWarnings(target.allow)` (the warning for a `regex(...)` rule that can be very slow). The two SQL kinds use it to add the warning for a bare `*` and for a regex rule that can match more than one word. The local kind adds one line that names the programs of its `programs` list that can act as you. |

A decision is an object. An allowed one has `allowed: true` and `rule`. A refused one has `allowed: false`, `reason` and `short` (the short text for the log). A refused decision may carry:

- `unmatched: true`, when no rule matched and a reviewer may be asked;
- `argv`, the words to send to the reviewer; and
- `notReviewed`, a text that says why the words are not sent.

The order of the checks inside `decide` is the behaviour: it decides which refusal a caller sees first. `command` gets the decision after a reviewer approved it, with `rule: 'review'`.

The core keeps argument checks, finding the target, the review round trip, the time limit, the output limit, the audit entry and the result text.

### Notes

| Field | Required | Arguments | Returns |
|---|---|---|---|
| `agentSection(sessionTarget)` | yes | a target of the session | The section of `AGENT.md` for that target. Add the `REVIEWED` line from `src/kinds/shared.js` when `review` is true. |
| `listFields(sessionTarget)` | no | a target of the session | An object whose fields are added to that target's entry in `list_targets`. Only `mcp` has it: `tools`, the names of its exported tools as `TARGET__TOOL`. |
| `cutHint` | no | a string of one line | How to narrow a call whose output was cut. The answer shows `narrow it: <cutHint>` after its cut lines, and `AGENT.md` lists it under "When output is cut", once for each text, after the tools of the kinds that give it. It only suggests: say nothing that promises a call is allowed. Every kind has one, for example `tail -n 200, head -n 200, grep -m 50 PATTERN, or wc -l first` for `ssh` and `local`. |

#### When output is cut

The core shapes the output of every kind the same way; a kind gives only its `cutHint` above. Short answers do not change. A cut stream gets one line right after the first line of the answer, before the first section, so that a client that cuts a long answer from its end still shows it:

- **A stream of `ssh`, `kubernetes` or `local`**, which `run` reads to its end: `[stdout cut: showing 256 KiB of 9.4 MiB]`, then the stream shows its first part, `[... 9.1 MiB cut here ...]` and its last 16 KiB, all within the visible limit. Its end is where the program ended, or where the time limit or a stop ended it.
- **A stream of a brokered call** never has an end part. Every secret value and every form of one is hidden in the whole stream first, and every count after that is made in the hidden text.
  - A stream that ended on its own and is longer than the visible limit once hidden shows its first 256 KiB (the visible limit of the target) and the line `[stdout cut at 256 KiB: the rest was left out]`. The 256 KiB are counted before paths are removed, so such an answer with removed paths in it can show a little less than 256 KiB; a path that crosses the place of the cut is left out whole.
  - A stream that did not end on its own (the time limit, `cutOff`, `truncated`, or raw bytes at the read limit; the flags are per result, so both streams of such a call) loses its end: its last 1 KiB is left out, or 8 KiB for each 1024 characters of the longest hidden text, begun ones counted, when that text has more than 128 characters (129 to 1024 characters: 8 KiB; 1025 to 2048: 16 KiB). It is left out by count, never by what it holds. When the rest is still the visible limit and 4 KiB or more, it shows its first 256 KiB with the same line. Else it is cut after its last newline before the bytes left out (nothing is shown when there is none), and the line is `[stdout cut: the stream did not end on its own, so its end was left out]`. An empty stream has no line, unless a reader stopped it: stdout when the result says `truncated` and neither stream reached the read limit.
  - When the halving of a large answer leaves less of it, the line ends in `; showing 128 KiB`; a whole stream that the halving cuts says `[stdout cut: showing 128 KiB of 200 KiB]`.
- Then `narrow it: <cutHint>` when the kind has a hint. The same for stderr.

No size in a cut line changes with the length of a secret: the line of a cut brokered stream names the visible limit, the same for every call on the target, a whole brokered stream is measured once hidden and scrubbed, and sizes in bytes appear only when the short forms would look the same. For `ssh`, `kubernetes` and `local` the total is what the program wrote, so those sizes are only ever rounded (`under 1 KiB` below 1 KiB); an agent that moves its output across a rounding edge over repeated calls can still find the length of a scrubbed path, which is accepted, since removing paths from output is cosmetic (SECURITY.md). The sizes are close, not exact.

How much of the end is left out is the one count that depends on the secrets: it tells only whether the longest hidden text of the target has more than 128 characters, and then its length in steps of 1024 characters. The read limit grows by the same amount (see `maxBytes` below), so a stream that the read limit stopped still shows its first 256 KiB while hiding takes at most 27 KiB out of it.

The cost of the brokered rules: a call that did not end on its own loses its last 1 KiB at least, back to the end of a line, so a short output of a call that timed out is not shown at all. Make such a call end on its own. A start of a secret at the end of a stream that ended on its own is shown as it is, as anywhere else: it is what the program wrote.

The end part of `ssh`, `kubernetes` and `local` goes through the same scrub as the rest. `run` keeps the last 52 KiB of each stream; they are scrubbed as one text, so that a path cut by the end of the stream is dropped whole, and the end part is the last 16 KiB of it, well past where a path cut by the start of the kept bytes could be; it is left out when the scrub takes more than 4 KiB out of the kept bytes. An end part never ends in white space, and a stream whose last 16 KiB are all white space has none. A stream of these three kinds that did not end on its own (the time limit, a stop, a broken body: `cutOff`, a program stopped at the limit, a stream that `run` closed at the end of its grace period) loses a last piece that is the start of a folder that the scrub hides, whether it was cut or not: such a stream that ends in `/` loses that `/`. See "fitBrokered: a stream of a brokered call" and "The cut line, the end part and the hint" in docs/LOGIC.md.

## Brokered kinds

ssh and Kubernetes work because `ksproxy start` opens something that `ksproxy mcp` can reuse without a credential: a control socket, a local proxy. A database or an HTTP API has nothing like that, since whoever sends the request needs the password. A brokered kind is therefore decided and carried out inside `ksproxy start`, which holds the credential in memory. `ksproxy mcp` only checks the shape of the call and forwards it over a private Unix socket, the call socket.

```text
agent -> ksproxy mcp -> call-sock -> ksproxy start -> perform()
         shape only                  decide, review, run, clean, audit
```

`test/fixtures/kind-brokered.js` (the kind `vault`) is the smallest complete brokered kind, and `test/broker-start.test.js` takes it through the whole core.

### The fields

| Field | Required | Arguments | Returns |
|---|---|---|---|
| `brokered` | yes, for this sort of kind | `true` | Any other value is a contract error. A brokered kind has no `command` and no `state`; every other kind has both and has neither `perform` nor `probe`. |
| `perform(target, decision, ctx)` | yes | the target as `record` gave it, held in the memory of `start`; an allowed decision (`rule: 'review'` after a reviewer approved it); `ctx = { env, secrets, timeoutMs, maxBytes, signal, input, opened }` | A promise of `{ exitCode, stdout, stderr, timedOut?, truncated?, cutOff?, ownStderr? }`. `exitCode` is an integer or `null`, `stdout` and `stderr` are strings. `truncated: true` says that a reader stopped at the read limit (the program was stopped, the body or the reply was not read further, the texts were cut): the streams did not end on their own, and stdout gets a cut line even when it is empty if neither stream reached the limit (see "When output is cut"). `cutOff: true` says that the output ended before the service finished it (a body whose stream broke); the http engine sets it. With either, or `timedOut`, the stream did not end on its own. `ownStderr: true` says that stderr is a text the kind wrote itself, whole, to say why the call stopped (`the reply was cut off`, `the reply is larger than the output limit and was cut off`, `the MCP server did not answer within N seconds`): the core then fits stderr as a stream that ended on its own, so the note is shown whole even when stdout loses its end. Set it only for such a text, never for a stream that holds output of the service; the http engine (`send`, for every result whose body was read), the Redis exchange (a reply over the limit) and the mcp kind (a server that did not answer in time) set it. |
| `secrets(target)` | no | an inventory target | `{ env: string[], files: string[], users?: string[] }`: the names of the environment variables and the paths of the files that hold the target's credentials. Both arrays are always present. `users`, when given, names the variables of `env` that hold only a user name (redis `userEnv`, the user of basic auth): the short-secret warning leaves them out. Any kind may have it; today only a brokered kind needs it. |
| `probe(target, ctx)` | no | the recorded target, `ctx = { env, secrets, opened }` | A promise of `'up'` or any other string, for the health loop of `start`. |
| `hiddenForms(target, secrets)` | no | the recorded target and its secrets, as `perform` gets them | An array of strings: the forms of the secrets that the kind sends or that the service shows, and that are not a secret value as it is (the base64 credential of basic auth, a password decoded or as JSON or a client writes it with a backslash, a quote or a control character; `jsonForms` and `jsonBodyForms` in `src/kinds/shared.js` give the JSON forms). The core calls it before `perform` and hides these texts with the secret values. They are used only for hiding: they never reach the agent, the audit log or the answer line. A `perform` does not hide anything itself. |

Two optional fields of "A call" matter most to brokered kinds. `forCheck(target, ctx)` lets `ksproxy check` do what `open` does for a target that needs it (the `command` and `kafka` kinds look up their programs there; `ksproxy check` has no session). `ruleWarnings(target)` replaces the default warnings of `start` and `check`.

In `ctx`, `env` is the environment of `start` without any credential variable, `secrets` is a plain object from each variable name and each file path that `secrets` named to its value, `timeoutMs` is the call's time limit, `maxBytes` the read limit per stream (the bytes the agent sees, 262144 or the `maxOutputKiB` of the target times 1024, at most 4 MiB, plus a margin of 32768 bytes for a path cut by the read limit, plus what the core leaves out of the end of a stream that did not end on its own over 1 KiB: 294912 bytes by default, and more for a target whose longest hidden text has more than 128 characters. It is the same for every call on a target; see `readLimit` under "The output limit" in docs/LOGIC.md), `signal` an `AbortSignal` that fires at the time limit or when the session stops, `input` the call exactly as `decide` got it, and `opened` the opened entry of the target, with the `extras` its `open` returned (in `probe` too), so the kind reaches the live object it keeps there. A kind must honour any `maxBytes` it is given and keep no limit of its own on bytes; a limit on documents or rows may stay. A decision after review keeps only the words, so a kind whose call carries more than its words (the query and the body of an http request) reads `input` again in `perform`.

### What the core does for a brokered kind

- **Reading the secrets.** Right after the inventory is read, `start` collects the key variables of the reviewers and the `env` names of `secrets` for every inventory entry of every kind that has `secrets`, selected or not, reads their values once and goes on with a copy of the environment without them. Nothing `start` runs later (ssh, the cluster proxies, the health checks, `perform`) receives them through its environment. When a target is opened, after its `OPENING` line, its values are taken from what was read and its files are read (one trailing newline is dropped). A variable that is unset or empty gives `SKIPPED` with `<VAR> is not set`, an unreadable file `<path> cannot be read`, an empty one `<path> is empty`, and the target is not opened. When the target opens, a value shorter than 8 characters gives a `WARN` line, `<VAR> holds a secret shorter than 8 characters: hiding it in output can give it away` (or the path of the file), because hiding so short a value also hides ordinary text that happens to match it; the line never shows the value or its length. A variable that `secrets` names in `users` holds only a user name, which is not a secret, and gets no such line. A form from `hiddenForms` shorter than 8 characters (a password inside a connection string, as written or decoded) gives `<VAR> holds a secret with a part shorter than 8 characters: hiding it in output can give it away`, naming the variable whose value the form comes from (the one without which the form is gone), unless that variable is already named or holds a user name. The values of the opened targets stay in memory; the others are dropped once every target is opened. They reach only `open`, `perform` and `probe` of their own target.
- **The call socket.** When any selected target is brokered, the path `call-sock` in the socket folder is checked with the other socket paths. After the targets are open and recorded, and before `session.json` is written, `start` listens on it (mode 0600 in the 0700 socket folder) when at least one opened target is brokered. If it cannot listen, each brokered target gets `WARN calls are off: could not start the call service` and stays unreachable. Every way of stopping closes the server and removes the socket before the targets are closed; a call in flight ends as a refusal and does not hold the stop back. The clean-up after a killed run skips `call-sock`.
- **On the mcp side**, `execTool` does the argument checks of today and finds the target in `session.json` to give the usual answers to a bad call or an unknown target, and audits those refusals itself, as for every kind, so the user sees them in the log. A call socket path that cannot be used is refused and audited there too. A call that is sent on is audited by `start` only, so no call is audited twice. It then sends `{ kind, name, input, timeoutSeconds }` to the call socket and returns the answer as it is. `list_targets` and `ksproxy status` report the recorded state while the call socket accepts a connection, else `down`.
- **Inside start**, the handler finds the target in its own list of opened targets, never in `session.json`: a target added to the session file, or a rule widened there, changes nothing. It checks the type of the call again, calls `decide`, asks the review service in the same process when no rule matched and the target is reviewed (same cache, budget, verdicts and checks on the words as for the socket), then `perform` within the time limit, replaces every secret value of the target and every form of one that `hiddenForms` gives in both streams by `[hidden]` (so a program that prints its own environment gives nothing away), leaves out the end of a stream that did not end on its own (where a secret can be cut by the read limit, the time limit or a broken stream), cleans the output with `scrubOutput`, cuts each stream to the visible limit of the target (262144 bytes unless the inventory raised it), and answers with the text of today, with a cut line for each cut stream and the hint of the kind (see "When output is cut"). The audit entry, with the fields of today, is written before the streams are fitted: if the hiding or the scrub throws, the call is still audited as run, and the agent gets the first line of the answer and `the output could not be shown`, without any output.
- **The health loop** asks `probe` with the target's secrets when the kind has it, else the state above.
- **What the agent is shown.** `tools/list` always lists `list_targets` and the tool of every kind that is not brokered. The tool of a brokered kind is listed when the inventory holds a target of that kind; `ksproxy mcp` reads the inventory for this (it holds no credential, and nothing else is read). No inventory file counts as an inventory without targets; a file that cannot be read or is not valid lists every tool. A tool that is not listed still answers when called; a tool with `listed: false` (`mcp_call`) is never listed. While a session with an `mcp` target runs, the tools of its servers follow, as `TARGET__TOOL` (see "The mcp kind and its client engine"). `AGENT.md` lists the same tools for the kinds of the session. The usage text puts the flags of the brokered kinds on lines of their own after `--all` and `-v`, and the error of `ksproxy start` without a terminal names the flag of a brokered kind only when the inventory holds a target of it. A kind without a flag is named in neither.

### The protocol and its failures

One request per connection: a JSON line of at most 256 KiB, then one JSON line `{ text, isError }` of at most 16 MiB (the handler keeps it within 4 times the visible limit of the target, so 1 MiB by default), then the server closes the connection without waiting for the client to close its side (a client that does not read the answer is dropped 5 seconds later). The server drops a client that has not sent its whole line within 5 seconds of connecting, and takes at most 64 connections at once. The client waits the call's time limit plus 75 seconds (for the review and the grace after the limit). Inside `start`, a `perform` still busy one second after the time limit counts as timed out.

Every failure is a refusal with one of the fixed texts in `CALL_FAILED` of `src/broker.js`; nothing of an error object reaches the agent or the audit log:

| Text | When |
|---|---|
| `the session did not answer` | no socket, a connection error, the connection closed without an answer, the session stopped |
| `the session did not answer in time` | the client's time limit passed |
| `the call could not be sent` | the request is over 256 KiB or cannot be written as JSON |
| `the answer is too large` | the answer is over 16 MiB; the handler inside `start` keeps less of the output instead, so a call that ran is never reported this way |
| `the answer could not be read` | the answer is not `{ text, isError }` |
| `the call could not be read` | the server got a request of the wrong shape |
| `the call failed inside the session` | `decide`, `hiddenForms` or `perform` threw, or `perform` gave a result of the wrong shape |
| `this target is not open in the session` | the handler does not hold that target |

A refusal of the client or of the handler names the target as `REFUSED (<word> <name>): ...` and the handler audits its own. A refusal for which no brokered kind is known (a request of the wrong shape, a handler that failed outright, an answer that is too large, a kind that is not brokered) is `REFUSED: ...` and is not audited.

The end of `## Adding a kind` applies too; in addition, a brokered kind that reads files through `secrets` should list them in `secretFiles`, so that local targets refuse to read them.

## The engines and the service kinds

An engine knows how to talk to a service or how to read a call; a kind knows one service: its inventory fields, its fixed refusals and its notes for the agent. A custom kind (`http`, `command`) is an engine used directly from the inventory. The seven engines are these:

| Engine | What it does | Used by |
|---|---|---|
| `http.js` | The strict reader of a request, its words for the rules, and sending one request. | `http`, and through `http-service.js` `elasticsearch` and `rabbitmq` |
| `http-service.js` | Builds a whole kind on `http.js` from names, a sample, notes and `fixedRefusal(request)`. | `elasticsearch`, `rabbitmq` |
| `command.js` | Runs one client program without a shell, in an empty folder, with a small environment. | `command`, `postgres`, `mysql`, `mongodb`, `kafka` |
| `resp.js` | Speaks the Redis protocol over TCP or TLS. | `redis` |
| `sql.js` | Turns one SQL statement into words and refuses what it cannot judge. | `postgres`, `mysql` |
| `sql-service.js` | Builds a whole kind on `sql.js` and `command.js` from names, a dialect, fixed refusals and the way the client is called. | `postgres`, `mysql` |
| `mcp-client.js` | Speaks MCP to one server, in both protocol eras: `connectStdio` runs a local server as a program, `connectHttp` reaches a remote one. | `mcp` |

## The http engine and the custom http kind

`src/kinds/engines/http.js` is shared by the kinds that speak HTTP: the custom `http` kind, `elasticsearch` and `rabbitmq`. It exports:

| Name | What it does |
|---|---|
| `readRequest(input, { vhostSegment })` | The strict reader. `input` is `{ method, path, query?, body? }` and nothing else. Returns `{ method, segments, query, body }`: the method upper-cased, the path segments as written, the query as a list of name and value strings, the body as the JSON text to send or `undefined`. A query name `_method`, `x-http-method-override`, `x-method-override` or `x-http-method`, in any letter case, is refused. Throws `AllowError(reason, short)` for everything it refuses; the list with the short texts is in `docs/LOGIC.md`. `vhostSegment`, off by default, accepts a segment that is exactly `%2F` or `%2f`; only `rabbitmq` turns it on. |
| `requestWords(request)` | The words the rules see: the method, one word per segment with its leading slash, then `+body` when a body is sent. `GET /_cat/indices` gives `GET`, `/_cat`, `/indices`. A segment `%2F` or `%2f` gives the word `/%2F`. |
| `reviewWords(request)` | The words a reviewer sees, which a kind returns as `argv`: `requestWords`, then one word per query name, `?` and the name and value encoded as they are sent (`?q=a+b`). The rules never see these words. |
| `splitRule(rule, { vhostSegment })` | A word rule written as a request line (`GET /api/dashboards/uid/*`, `POST /*/_search +body`) split the same way: `{ words, body }`, or `null` when the rule has another form. A segment that is exactly `%2F` or `%2f` is a form only with `vhostSegment`. |
| `matchRequestRule(words, rule, options)` | Whether one rule matches; given to `decide` of `src/allowlist.js`; `options` go to `splitRule`. A `*` segment is one segment, `...` as the last segment is the rest, `\*` is a literal star segment, and a star inside a segment (`/logs-*`) is literal. A word rule allows a body only when it ends in `+body`, and such a rule needs one. A `regex(...)` rule is tried on the words joined by single spaces, `+body` included: `regex(GET /api /v[12] /users)`. |
| `validateBaseUrl(value, where)` | `checkServiceUrl` of `src/checks.js` (the reviewer URL check: https, or http on the loopback names; no user, password, query or fragment), with a trailing slash. |
| `authVariables(auth)`, `authSecrets(auth)`, `authHeader(auth, secrets)`, `authProblem(auth, secrets)`, `headerNameProblem(name)` | The three auth forms: the variables they name, what `secrets(target)` returns for them (the user of basic auth also in `users`), the one header they make, the check that a secret value cannot split a header, and the header names the header form may not use. |
| `encodedForms(auth, secrets)` | The base64 credential of basic auth (nothing for the other auth forms), then `jsonBodyForms` of the secret values and of that credential: each as JSON.stringify writes it, with a slash escaped (PHP) and with the signs less-than, greater-than and ampersand escaped (Go, Rails), where that is not the value itself. What the kinds on this engine return from `hiddenForms`. |
| `buildUrl(baseUrl, segments, query)` | The base's origin and path, the segments, the query from `URLSearchParams`; refused unless the result keeps the base's origin and path and has no fragment. |
| `send(options)` | One `fetch` with `redirect: 'manual'`, the time limit and the call's signal. `{ exitCode, stdout, stderr, timedOut?, truncated? }`: `exitCode` 0 for a 2xx status and 1 otherwise, `stdout` `HTTP <status>`, the content type, an empty line and the body as text, cut at `maxBytes`. A redirect is an error and is not followed; no reply header but the content type is shown. |
| `hideSecrets(text, values)` | Every place of the text that a value covers becomes `[hidden]`: each run of covered characters one, also where two values overlap; a `[hidden]` put in is never looked at again. The core uses it on the output of every brokered call. |

The kind `http` (`src/kinds/http/index.js`) takes `name`, `baseUrl`, `auth`, `description`, `allow` and `review`; `auth` is `{ "bearerEnv": NAME }`, `{ "basicUserEnv": NAME, "basicPasswordEnv": NAME }`, `{ "headerName": HEADER, "headerEnv": NAME }` or absent. Its tool `http_request { target, method, path, query?, body?, timeout_seconds? }` has `detailShape: 'object'`. Host, port and scheme come from `baseUrl` only; the agent sets no header. The query is not matched against the rules, but a reviewer sees it in `argv` and the audit entry keeps it. A refused request with a body is never sent to the reviewer, who cannot see the body. A secret value that holds a character that could split a header skips the target at open, and every secret value, and the basic credential in base64, is hidden in the reply by the core.

## The elasticsearch and rabbitmq kinds

`elasticsearch` (flag `es`, label `es`, tool `elasticsearch_request`) and `rabbitmq` (flag `mq`, label `mq`, tool `rabbitmq_request`) are brokered kinds on the http engine. Each is a few lines of names, a sample, its agent notes and one function, `fixedRefusal(request)`, handed to `httpServiceKind` in `src/kinds/engines/http-service.js`, which gives the inventory checks (`url`, and `userEnv` with `passwordEnv`, or `apiKeyEnv` for elasticsearch only; both forms together is an error), the session functions, `decide` and `perform`. `decide` runs `fixedRefusal` right after the strict reader and before any rule, and a refusal it returns has no `unmatched`, so no rule, no `regex(...)`, no reviewer and no `ksproxy check` can get past it. The refusals are listed in `docs/LOGIC.md` under each kind. To add a kind of this sort, call `httpServiceKind` with the same fields.

RabbitMQ's management API writes the default virtual host, named `/`, as the path segment `%2F`: `GET /api/queues/%2F/orders`. `rabbitmq` sets `vhostSegment: true` (with `vhostNote` for the agent notes), so its reader accepts a segment that is exactly `%2F` or `%2f` and nothing more: `a%2Fb`, `%2F%2F`, `%2Fetc` and every other encoded slash, backslash, dot, percent sign or control character are still refused. The segment is sent as written, neither decoded nor encoded again. Its word in the rules is `/%2F` whichever case the agent wrote, so a rule may name it (`GET /api/queues/%2F/*`), and `*` and `...` match it like any other segment. The fixed refusals read it as a lone slash, which hides none of them: `POST /api/queues/%2F/q/get` is still a queue get. `elasticsearch` does not set it, and refuses `%2F` in a path and in a rule, as the custom `http` kind does.

## The command engine and the custom command kind

`src/kinds/engines/command.js` runs one client program for a brokered kind: the custom `command` kind, `postgres`, `mysql`, `mongodb` and `kafka`. It exports:

| Name | What it does |
|---|---|
| `runClient({ program, fixedArgs, words, env, childEnv, folderPaths, homeInWorkFolder, timeoutMs, maxBytes, signal })` | A promise of `{ exitCode, stdout, stderr, timedOut, truncated }`, the shape `perform` returns. `program` is an absolute path the kind has resolved. The child gets `[...fixedArgs, ...words]` as its argument array, with no shell. Each word is one argument, so a SQL statement passed as one word stays one argument. `env` is the environment of `start`; the child gets `minimalEnv(env, childEnv, { own: false })`, which is `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR` and the entries of `childEnv` (secrets and plain values alike), and nothing else. `folderPaths` maps more variable names to file names: each variable gets the path of that file inside the call's working folder, and the file is not created. With `homeInWorkFolder: true`, `HOME` of the child is the working folder itself. The working folder is a new empty folder `run/cmd-XXXXXX` under the state folder, with mode 0700. It is removed when the call ends, whatever the outcome. The child's process group is killed when a stream passes `maxBytes` (`truncated: true`; a huge result does not keep the service busy until the time limit), and when `signal` fires (`timedOut: true`; the signal fires at the call's time limit and when the session stops). A program that cannot be started gives `exitCode: null` and `could not start the program: ...` on stderr. If the working folder cannot be made, it throws, and `start` refuses the call. |
| `workRoot(env)` | The folder `run` under the state folder, created with mode 0700. It throws when that path is a link or a file. |
| `WORK_FOLDER` | `run`. The command kind's `reapStale` removes this folder when a session starts, so whatever a killed run left there is cleaned up. |

`run` of `src/exec.js` does the spawning. It has two options for the engine: `signal` kills the group at once, and `stopAtLimit` kills it as soon as a stream passes `maxBytes`. Without them it behaves as before.

How the other kinds call it:

- **postgres**: `runClient({ program: <psql>, fixedArgs: ['--no-psqlrc', '--quiet', '--no-align', '--set', 'ON_ERROR_STOP=1', '--set', 'FETCH_COUNT=1000', '--pset', 'footer=off', '--single-transaction', '--host', host, '--port', String(port), '--dbname', database, '--username', user, '--no-password', '--command', 'SET TRANSACTION READ ONLY', '--command', 'SET LOCAL statement_timeout = <ms>', '--command', 'SET LOCAL standard_conforming_strings = on', '--command'], words: [statement], childEnv: { PGPASSWORD: password, PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'ksproxy', PGOPTIONS: <the options>, PGSSLMODE: <verify-full, require or prefer>, PGSSLROOTCERT: <caFile or system, for verify only> }, ... })`. `PGOPTIONS` holds `-c default_transaction_read_only=on` (left out when the target has `readOnly: false`), `-c statement_timeout=<the call's time limit in milliseconds>` and `-c standard_conforming_strings=on`. The same settings are set again inside the one transaction that `--single-transaction` wraps around every `--command` (the read-only one left out when the target has `readOnly: false`). The statement is the one word after the last `--command`, and the password is only in the child's environment.
- **mysql**: `runClient({ program: <mysql or mariadb>, fixedArgs: ['--no-defaults', '--batch', '--quick', '--default-character-set=utf8mb4', '--local-infile=0', '--connect-timeout=10', '--host=H', '--port=P', '--database=D', '--user=U', ...<the TLS options>, '--init-command=<SQL>'], words: ['--execute=' + statement], childEnv: { MYSQL_PWD: password }, folderPaths: { MYSQL_TEST_LOGIN_FILE: 'no-login-file.cnf' }, ... })`. The TLS options depend on `tls` and on the client the version names: `--ssl-mode=VERIFY_IDENTITY` or `--ssl-mode=REQUIRED` for the MySQL client, `--ssl --ssl-verify-server-cert` for the MariaDB client, then `--ssl-ca=FILE` for `caFile`, and none for `prefer`. The statement is glued to `--execute=` and stays one argument. The init command sets `sql_select_limit` to 1000 and, unless the target has `readOnly: false`, `SET SESSION TRANSACTION READ ONLY`.
- **mongodb**: `runClient({ program: <mongosh>, fixedArgs: ['--nodb', '--quiet', '--norc', '--eval', FIXED_SCRIPT], words: [], childEnv: { MGO_URI: secrets[uriEnv], MGO_DOC: JSON.stringify(document), MGO_DB: database }, homeInWorkFolder: true, ... })`. The document travels as data in the environment, and the fixed script is the only code. The log and settings `mongosh` keeps under its home folder go into the working folder and are removed with it.
- **kafka**: `runClient({ program: <the client script the first word picks>, fixedArgs: ['--bootstrap-server', server, '--command-config', configFile], words: rest, ... })`. The kind refuses the flags that would change the server or the config file before it calls the engine.

The kind `command` (`src/kinds/command/index.js`) takes `name`, `program`, `args`, `env`, `description`, `allow` and `review`:

```json
{ "command": [{ "name": "disk-report", "program": "/usr/local/bin/report", "args": ["--format", "text"],
                "env": { "REPORT_TOKEN": { "fromEnv": "REPORT_TOKEN" } },
                "allow": ["usage *", "summary", "regex(usage (daily|weekly))"] }] }
```

- `program` is an absolute path, a path that starts with `~/`, or a plain name made of letters, digits and `_ . + -`. A plain name is looked up once, when the target opens, on the absolute entries of the `PATH` that `ksproxy start` has. A program that cannot be found, that is not an executable file, or that lies inside ksproxy's state or configuration folders (as written or through a link) skips the target. `ksproxy check` applies the same check. The agent never names a program.
- `args`: at most 50 strings, each at most 1024 bytes and without control characters. A leading `~/` is expanded; everything else is passed exactly as written.
- `env`: each child variable maps to `{ "fromEnv": NAME }`, a variable of `ksproxy start` that is read as a secret, like any other kind's secret, and removed from everything else the session runs. The child name may differ from the source name. Both names go through `checkSecretVariable`, which refuses, among others, `PATH`, `HOME`, `NODE_OPTIONS` and the `KSPROXY_` prefix. A child name that starts with `LD_` or `DYLD_` is refused as well. Nothing else from the user's environment reaches the child.
- `allow` is a list; `"any"` is refused. The agent's words go through `tokenizeSshCommand`: plain words, no shell syntax, and the first word may not start with `-`. In a word rule, `*` and `...` never match a word that starts with `-`, so every flag the agent may use is written into a rule. A `regex(...)` rule is tried on the words joined by single spaces. When it matches, each word that starts with `-` must also appear in the pattern text as a whole word. Before it must come the start, a space, `(`, `(?:`, `|` or `^`; after it, the end, a space, `)`, `|` or `$`. It must also not stand inside a group that a quantifier allows zero times (`?`, `*`, `{0}`, `{0,n}`), as the match can skip such a group. So `regex(r -[a-z])`, `regex(r \S+)` and `regex(r( -x)?( \S+)*)` never allow `r -x`, while `regex(stats|stats --json)` allows `stats --json`. A regex rule with a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`) is an inventory error, because a flag written inside one would count as written in the pattern. A word that starts with `-` and equals one of the fixed arguments is refused with `repeats a fixed option`, before the rules and without review.
- The tool is `command_exec { target, command, timeout_seconds? }`, with the label `cmd`. An unlisted command goes to the reviewer when the target has `review`.

What ksproxy cannot promise here (the agent notes state the first point):

- ksproxy does not know the program. A flag written into a rule that reads a file, writes one or starts another program is the user's choice, as for local targets.
- A secret goes into `env`, never into `args`: an argument is visible in the process list to every user of the machine.
- Every secret value of the target is hidden from the reply before the output is cut, so a secret printed at the cut never shows in part. A secret that the end of the output cuts, at the read limit, at the time limit or where the stream broke, is never shown in part: the end of a stream that did not end on its own is left out, 1 KiB at least, back to the end of a line, whatever it holds. A stream that ended on its own loses nothing. Nothing else in the output is searched for secrets.

## The resp engine and the redis kind

`src/kinds/engines/resp.js` speaks the Redis protocol itself over TCP or TLS, so nothing has to be installed. `encodeCommand(words)` writes one command as an array of bulk strings, each length in bytes, so no word can end the command or start another; the inline form is never written. `ReplyReader` (and `readReply(buffer)` for one reply) reads simple strings, errors, integers, bulk strings, null, nested arrays, and the RESP3 doubles, booleans, big numbers, verbatim strings, bulk errors, maps, sets and pushes; it reads each byte once however the reply is split, refuses an unknown type byte (attributes included), a negative or malformed length and a nesting deeper than `MAX_DEPTH` (32), and stops at the output limit with `ReplyError` (`overflow: true`). `formatReply(value, maxBytes)` prints a reply as the usual client does, every byte outside printable ASCII escaped (`escapeText` gives that form of a text), and stops at the first line that passes `maxBytes`, so the text is the start of the whole text and the caller cuts it. `exchange(options)` makes one call: connect (TLS with the certificate checked against the host name, and no option to turn that off; `connect` is a test-only hook), `AUTH` when a password is set, `SELECT` when `db` is not 0, then the command, each sent after the answer to the one before; a refused `AUTH` or `SELECT` is a fixed text that never repeats the server's answer; one timer covers connect and reply; the socket is destroyed on every path.

The kind `redis` (`src/kinds/redis/index.js`, label `rds`, flag `redis`) takes `name`, `host`, `port` (6379), `tls` (false), `db` (0), `userEnv` and `passwordEnv` (both optional; a user needs a password), `description`, `allow` and `review`. Its tool `redis_command { target, command, timeout_seconds? }` takes one command as plain words (`src/kinds/redis/words.js`: at most 4096 bytes and 64 words of ASCII letters, digits and `_ @ % + = : , . / - * ? [ ] { } ! ~ ^ $ # & ( ) < > |`; values with spaces, quotes or backslashes cannot be sent in this version). The fixed refusals (scripts and functions, `MODULE`, `DEBUG`, server-wide commands, blocking commands and `XREAD`/`XREADGROUP` with `BLOCK`, connection commands, `CLUSTER`, `CONFIG`, `ACL` and `CLIENT` except their read-only forms, and `CONFIG GET` with a pattern or with a name that holds `pass`, `auth` or `masteruser`) run before any rule, are never reviewed, and are checked again in `perform`. The command name, and the subcommand of a command that has subcommands, are upper-cased in the command and in each word rule before matching; a `regex(...)` rule sees that upper-cased form, so it writes the command name in capitals. The user name and the password, raw and escaped (`hiddenForms`), are hidden in every reply by the core.

## The SQL reader

`src/kinds/engines/sql.js` turns one SQL statement into words and refuses what it cannot judge, before any rule. `readStatement(text, dialect)` (`dialect` is `postgres` or `mysql`) gives the words: unquoted words lower-cased, a quoted string (`'...'`, and `"..."` for mysql) or a quoted name (`"..."` for postgres, `` `...` `` for mysql) as one word kept as written, with a doubled quote as the only escape, and each punctuation mark as its own word; one trailing `;` is dropped. It throws `AllowError` for a second statement, a comment, a backslash anywhere, inside a quoted text too, `$`, an escape or prefixed string, an unterminated quote, a control character, a statement over 16 KiB, an empty statement, any other character outside a quote, and for mysql a first word that the mysql client takes as its own command. `splitRule(rule, dialect)` splits a word rule the same way, where `*` is one value, `\*` the SQL star and `...` the rest, only as the last word; matching is `matchSqlWords` on these words, where a `*` takes one value (`valueLength`: a number with an optional sign, digits and an optional fraction, the longest that fits, or one single-quoted string; never a name), and a `regex(...)` rule is tried on the words joined by single spaces. Every other kind keeps `matchWords` of `src/allowlist.js`, where `*` is one word. `starWarning` and `sqlRuleWarnings` give the warning `allow[N]: "*" matches one value here (a number or a quoted string); write \* for the SQL star` for a bare `*` right after `select` or `(`, and `nameHole` the warning that a `*` right after `from`, `join`, `into`, `update`, `table` or `describe` can never match. The two SQL kinds give `starWarning` to `start` and `check` through the optional `ruleWarnings(target)` (see "A call").

## The postgres and mysql kinds

`postgres` (flag `pg`, label `pg`, tool `postgres_query { target, query, timeout_seconds? }`) and `mysql` (flag `mysql`, label `my`, tool `mysql_query`, which covers MariaDB through `"client": "mariadb"`) are brokered kinds built by `sqlServiceKind` in `src/kinds/engines/sql-service.js`. A target has `host`, `port` (default 5432 or 3306), `database`, `user`, `passwordEnv`, `readOnly` (on unless `false`), `tls` (`verify`, `require` or `prefer`; `verify` unless the host is this machine), `caFile` (a CA file for `verify`, kept out of reach of local targets through `secretFiles`), `description`, `allow` (a list; `"any"` is refused) and `review`, and for mysql `client`. For `verify` and `require`, `open` checks TLS with one `select 1` through the client, after `clientFamily` of the mysql kind reads the client's version, and skips the target on a TLS failure. `decide` runs the reader, then the kind's fixed refusals (`postgresRefusal`, `mysqlRefusal`: files and programs on the server, server objects, roles and the read-only setting, transaction control, listed functions), then on a read-only target the refusal of a statement that writes, then the rules; none of these refusals is reviewed. `perform` runs `psql` (`psqlBin`) or the client (`mysqlBin`) through `runClient` with fixed options, the statement as one argument and the password only in the child's environment (`PGPASSWORD`, `MYSQL_PWD`); postgres gets `PGOPTIONS` with the read-only option, the statement timeout and `standard_conforming_strings=on`, mysql gets `sql_select_limit=1000` and, when read-only, `SET SESSION TRANSACTION READ ONLY` through `--init-command`. A spec has `printedForms(password)`, the forms in which a reply of the client can show the password when that is not the password itself; the kind always has `hiddenForms` (those forms), and the doctor check hides them too. `mysql` gives `batchForms` (the password, and the password inside a JSON text, as batch mode prints them: a backslash, a tab, a newline and a NUL as a backslash and a letter); `postgres` gives `jsonForms` of the password, because `psql` prints a text value as it is but the server writes a json, jsonb or array value with a quote and a backslash escaped. The database user's rights are the real boundary; the lists are in `docs/LOGIC.md`.

## The mongodb kind

`mongodb` (flag `mongo`, label `mgo`, tool `mongodb_command { target, command, timeout_seconds? }`) is a brokered kind on the command engine. Its inventory fields are `name`, `uriEnv` (the variable that holds the connection string, read as a secret), `database`, `writes` (default `false`), `joins` (default `false`), `description`, `allow` (`"any"` is refused) and `review`. `command` is one JSON document in MongoDB's command format; the tool has `detailShape: 'object'`, and the audit entry records under `request` only the command name and the collection. `mongosh` runs JavaScript with full access to the machine, so the agent's document never reaches it as code: `perform` always runs `mongosh --nodb --quiet --norc --eval FIXED_SCRIPT` (`src/kinds/mongodb/script.js`, one constant text), and the connection string, the database and the document travel in the child's environment as `MGO_URI`, `MGO_DB` and `MGO_DOC`. At open the connection string must start with `mongodb://` or `mongodb+srv://`, and the program is `mongoshBin` of `src/paths.js` looked up like a command program. The connection string, each password inside it as written and decoded, and the string and the passwords as JSON writes them inside a string (`hiddenForms`; the fixed script prints extended JSON), are hidden in every reply by the core.

`src/kinds/mongodb/document.js` holds the strict reader (one plain object, at most 64 KiB and 20 levels, no `__proto__` key, the command name as the first key), the words for the rules (`find orders`, `listCollections`, `explain find orders`) and the fixed refusals that no rule, reviewer or `ksproxy check` can lift: the keys `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$code` and `$scope` at any depth, a list of never-allowed commands, a command outside the read list unless the target has `writes`, the command is one of the eight commands that change data and a rule names it (such a write is never sent to the reviewer), four pipeline stages at any depth, and the top-level keys that the client sets itself (`$db` and every other key that starts with `$`, `lsid`, `txnNumber`, `autocommit`, `startTransaction`). A document that uses `$lookup`, `$graphLookup` or `$unionWith` reads other collections than the rules see; it is refused unless the target sets `"joins": true`, and then a rule may allow it, but it is never sent to the reviewer. `create` with `viewOn` or `pipeline` makes a view over another collection and is refused the same way unless the target sets `"joins": true`. After the decision `perform` reads and judges the same input again and bounds that copy: `find` gets one batch of at most 100 documents, `aggregate` a first batch of 100, and find, aggregate, count, distinct, listCollections, collStats and dbStats a `maxTimeMS` just under the call's limit, as does the command inside `explain`; the fixed script closes any cursor the reply leaves open. The lists are in `docs/LOGIC.md`. `ksproxy check mongo NAME DOCUMENT` takes the document as one JSON argument.

## The kafka kind

`kafka` (`src/kinds/kafka/index.js`, flag `kafka`, label `kfk`, tool `kafka_exec { target, command, timeout_seconds? }`) is a brokered kind on the command engine that runs the Kafka command-line clients the user installed. The first word of a call picks the program from a fixed table (`topics` is `kafka-topics`, `groups` is `kafka-consumer-groups`, `configs`, `acls`, `log-dirs`, `broker-api-versions`), looked up in the target's `binDir` or on the `PATH` of `ksproxy start` as the bare name and then with `.sh`, when the target opens; the agent never names a program or a path. The kind adds `--bootstrap-server` and, when set, `--command-config` itself, so options that change the server or the client configuration, any option whose name holds `file`, `config` or `propert`, words that point at a local file and `@` argument files are refused, and the write flags (an abbreviation of two characters or more counts as the flag) need `"writes": true` and a rule that allows the command; rules are matched with `matchCommandRule` of the command kind, and a regex rule with a lookaround is an inventory error there too; none of these can be overruled by a rule, a `regex(...)` rule or a reviewer. `clientConfig` is a secret file: `secretFiles` returns it, so local targets cannot reach it, and ksproxy never reads or prints it.

## The mcp kind and its client engine

`mcp` (`src/kinds/mcp/index.js`, label `mcp`, word `mcp`, noun `MCP server`, no flag (see "A kind without a flag"), tool `mcp_call { target, tool, arguments, timeout_seconds? }` with `listed: false`) is a brokered kind that reaches an MCP server: a local one that `start` runs (`command`, a list of words, over stdio through `connectStdio` of `src/kinds/engines/mcp-client.js`) or a remote one (`url`, over Streamable HTTP, with `login` `none`, `token` and `tokenEnv`, or `basic` and `userEnv` with `tokenEnv`). Its targets are chosen with the picker or `--all`, and `ksproxy check mcp NAME TOOL [JSON]` takes the tool and its arguments as one JSON object.

- **Inventory.** `name`, `description`, `allow`, `arguments` (pinned: added to every call of a tool that declares them, a call with another value refused), `timeoutSeconds` (1 to 600, default 60), and `command` with `env`, or `url` with `login`, `tokenEnv` and `userEnv`. `review` and `"allow": "any"` are refused. A value of `env` is a text, or `{ "fromEnv": NAME }` for a variable `start` reads as a secret; names starting `LD_` or `DYLD_` are refused, and a text whose name looks like a secret gives a warning. `command` and `url` are not secret fields: a `url` query name, a `command` word with a user and password in a URL, an option that gives a secret (`--token`, `--api-key` and the like), a setting `NAME=VALUE` or a header `NAME: VALUE` whose name looks like a secret gives a warning too, naming the field and never the value. `command[0]` is checked as the command kind checks its program, and a runner that downloads a package (`npx`, `bunx`, `uvx`, `pipx run`, `docker run`, `podman run`) must pin it exactly (`nerdctl` and `finch` as `docker`, `go run` with `path@vX.Y.Z`), and `npm`, `pnpm`, `pnpx`, `yarn`, `bun`, `uv`, `deno`, `dnx`, `pixi`, `mise`, `corepack`, `python -m pipx` and `python -m uv` are refused; the program is compared in lower case, and the table is in `docs/LOGIC.md` under `src/kinds/mcp/pin.js`. It does not pin the package's own dependencies.
- **Rules.** A tool name, or `{ "tool": NAME, "arguments": { NAME: VALUE } }` where a value is equal JSON, `"*"` (present), `"\\*"` (the text `*`) or `"regex(...)"` (the whole text of the value). Arguments a rule does not name are free; an argument the tool's schema does not declare is refused before the call is sent. A rule on a query argument (JQL, CQL, a search text) cannot limit what the query reads.
- **Open.** A local server runs without a shell, in an empty private folder `run/mcp-XXXXXX` of the state folder (removed at close), with `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, the cache folders `XDG_CACHE_HOME`, `UV_CACHE_DIR` and `npm_config_cache` when `start` has them, and its `env`: no other variable of `start`. It runs as the user, so it can read what the user can. Starting and listing the tools take at most 120 seconds (30 for a remote server), and Ctrl-C ends the wait through `ctx.signal`. A failure gives a fixed `SKIPPED` text in the log, and the reason and the last 20 lines of the server's stderr, every secret of the target hidden, on the terminal only through `ctx.say`. A server that stops later makes the target `DOWN` and says its last lines the same way; it is not restarted.
- **The agent's tools.** Only a tool a rule names is exported, as `TARGET__TOOL`, when its name and schema are safe (rules in `docs/LOGIC.md` under `src/kinds/mcp/export.js`), at most 200 a target and 1 MiB of definitions a session; `sessionFiles` writes them to `mcp-tools.json` in the session folder, with the pid and start time of the process, every secret hidden. A session without an `mcp` target writes no such file. `ksproxy mcp` and the listener read it (`src/session-tools.js`) only when its pid and start time are those of the live `session.json`, list its tools after the fixed tools, and route a call of `TARGET__TOOL` to `mcp_call` with the agent's arguments whole (an argument named `timeout_seconds` included) and the target's `timeoutSeconds` as the time limit; a name not in that list is an unknown tool. On stdio, `ksproxy mcp` declares `tools.listChanged` when the inventory holds an `mcp` target or cannot be read, and then checks every 2 seconds (the `stat` of the two files and `kill(pid, 0)`) whether the list changed, sending `notifications/tools/list_changed` only when it did. The listener declares nothing and pushes nothing.
- **Calls.** `decide` checks the rule and refuses a pinned argument with another value, or arguments of more than 192 KiB of JSON. `perform` reaches the live client through `ctx.opened`, refuses an argument the tool's schema does not declare (the call is not sent, exit code 1), adds the pinned values the tool declares (when it leaves one out, it matches the rules again on the arguments really sent and refuses the call when none matches), and calls within the smaller of the call's limit and `timeoutSeconds`. Text parts of an answer are joined, and the answer is cut only at its end; an image, audio or binary part is one line that names it; an error is a fixed text or the server's message. Every server text that is shortened goes through `shownText` of the engine first: the target's secrets and their forms hidden, cleaned, hidden again, then clipped. Nothing is dropped from such a text for being a start of a secret, at its end or at the clip: a server can repeat the agent's guess in an error message or a link, and such a drop would tell whether the guess starts a secret. The core hides every secret of the target, its JSON-escaped forms and the base64 credential of basic auth.
- **Probe and doctor.** A local target is `down` once its program has ended. A remote server is pinged at most every 5 minutes, each ping within 10 seconds; an answer of `429` counts as up. The `doctor` hook reports what `open` listed and exported and never calls a tool; for a local server it adds that the credential is checked only by a call.

**The engine.** `src/kinds/engines/mcp-client.js` is one client for one MCP server. The protocol layer (ids, the era, one request at a time, paging, answers to the server, limits) knows nothing of the transport; a transport writes one message line and hands back each message it reads.

- *Eras.* Over stdio the client sends `initialize` first, asking `2025-11-25`, then `notifications/initialized`. Only a JSON-RPC error to `initialize` leads to `server/discover` in the `2026-07-28` form; a server that answers it is a modern server, and each later request carries the protocol version, the client and empty capabilities in `_meta`. Over HTTP the order and the session id rules are those of the HTTP transport (see its section of `docs/LOGIC.md`).
- *Transports.* `connectStdio` runs a local server as a program, without a shell, in its own process group, with exactly the environment it is given: JSON lines on stdin and stdout, stderr kept in a ring of 64 KiB. Stopping closes stdin, sends `SIGTERM` to the group after 2 seconds and `SIGKILL` after 2 more; `close()` returns a promise. `connectHttp` reaches a remote server over Streamable HTTP, follows no redirect, never reads the body of an HTTP error, and runs its requests at the same time.
- *One call at a time over stdio.* Requests are queued and run one by one; a `ping` does not queue. Over HTTP each request has its own answer, so nothing is queued. A call that is no longer waited for gets `notifications/cancelled`.
- *Everything the server sends is hostile.* Every stdout line is capped at 16 MiB (`MAX_MESSAGE_BYTES`) and a longer line is discarded to its newline; a line that is not JSON ends the call in flight; every request of the server is answered with the error `-32601` (a `ping` gets `{}`) and never ends a call; notifications are dropped; an answer to a request of a local server is dropped while more than 1 MiB waits on its stdin; stdin and child errors stop the server; nothing can reject a promise that nobody waits for, because an unhandled rejection would stop every target.
- *Limits.* At most 2,000 tools and 16 MiB (`MAX_LIST_BYTES`, the option `maxListBytes`) over all pages of `tools/list`; starting a local server and listing its tools 120 seconds, connecting to a remote one 30 seconds; the texts of an answer share the output limit. `callTool` gives the answer of the server, `{ inputRequired: true }` for a modern `input_required` result, or a plain sentence for the failure. The client reports `serverInfo` (name and version, secrets hidden, cleaned), and `onEnd` tells when the server stopped. Both `connectStdio` and `connectHttp` take `hidden`, the texts to hide in every server text they shorten (the kind gives its secrets and their forms).

## What a kind may import

A kind object and its mechanics may import `src/checks.js`, `src/allowlist.js`, `src/paths.js`, `src/exec.js`, `src/text.js`, `src/session.js` and the files of kinds that do not import the core. The kubernetes mechanics import the ssh mechanics for the tunnel; the other direction does not exist, and `local` imports neither. A kind never imports a core file that imports the list (`start.js`, `tools.js`, `inventory.js`, `cli.js`, `agent-md.js`, `audit.js`, `review.js`, `mcp.js`), because that would make a loop of imports.

A session target whose kind is in no kind's key, which only a hand-edited session file can hold, is in the state `error`, and `ksproxy status` prints it with the label `--`.

A kind does not read another kind's entries. When one kind needs something from another, the core collects it: `secretFiles` is the example.

## Adding a kind

`test/fixtures/kind-echo.js` is the smallest complete kind. Copy its shape.

1. Create `src/kinds/<name>/index.js` with the object above and put the mechanics in files beside it.
2. Import it in `src/kinds/index.js` and append it to `KINDS`.
3. Choose the names so that none is used by another kind: five, or six with a `flag`. Leave `flag` out unless the owner asks for one; the kind is then chosen with the picker or `--all`. Keep `label` to 4 characters or the log columns shift.
4. If the kind has `close`, give it `closeLimit` (a name for a test override) and `closeMs` (the limit in milliseconds). `src/start.js` needs no change.
5. Write the tests and keep line, branch and function coverage at 100%.
6. Add a `## src/kinds/<name>/...` section with a Mermaid diagram for each new file in `docs/LOGIC.md`; `test/logic-docs.test.js` fails without them.
7. Update what lists the kinds on purpose: the order check at the top of `test/kinds-contract.test.js`, the sentences listed below, and the files under `test/golden/` that record every kind (look at the difference, then regenerate with `UPDATE_GOLDEN=1`).

## What a new kind must watch for

- Paths under the state folder. A session can be a project, whose state folder is `<state>/p/NAME/`, so a kind uses the path functions of `src/paths.js` (`stateDir`, `sessionDir`, `socketDir`, `socketPath`, `logDir` and the others) for every path it needs, and never builds one under the state folder itself. The guards against ksproxy's own files use `rootStateDir` and `configDir`, which are the folders of every project, never `stateDir`; a kind that adds such a guard must use them too.
- Files in the shared socket folder. After a killed run, every file there that is not a `*.pid` file, the review socket (`review-sock`) or the call socket (`call-sock`) is closed as an ssh connection, and every `*.pid` file is treated as a cluster proxy. A kind that keeps files there needs its own naming and its own `reapStale`, and the two existing reapers would have to learn to skip those files.
- The message `folder contains a kubeconfig named in the inventory` is used for the `secretFiles` of every kind, whatever the kind.
- The fixed sentences that name the kinds are not built from the list: the MCP server instructions and the `list_targets` description name the three original kinds and the service targets as one group (databases, queues and HTTP APIs); the intro and "Off limits" of the agent notes and the reviewer's instructions name the three original kinds. A new kind that fits none of these has to be added to each by hand.
- `echo` does not exercise `close`, `prepare`, `reapStale`, `sessionFiles`, `secretFiles`, the review hooks, `scrubDirs`, `scrubText`, `forCheck` or `checkExtra`. A kind that uses them needs its own tests.
- A real kind also needs its line in `src/kinds/index.js`, its sections in `docs/LOGIC.md` and, if it changes shared outputs, new snapshot files.

## What the core still names

These places write a kind's name and are not generated from the list (the `start` and `check` lines of the usage, the usage error of `ksproxy check` and the error of `ksproxy start` without a terminal are built from it):

- the sentence of the MCP server instructions in `src/mcp.js`, the description of `list_targets` in `src/tools.js`, the intro and the "Off limits" text of `AGENT.md` in `src/agent-md.js`, and the reviewer's instructions in `src/review.js`;
- `DEFAULT_CALL_KIND` in `src/audit.js`: an old audit entry with no kind is shown as `ssh`;
- `sshBin` and `kubectlBin` in `src/paths.js`, and the `tun` prefix of the tunnel socket there;
- `HOST_RE` in `src/checks.js`;
- two messages in `src/checks.js` that say "local targets" and a third that says "a local rule", and the environment variable names that `checkSecretVariable` in `src/checks.js` refuses for a reviewer's `keyEnv` and for every field of a kind that names a variable holding a secret. A kind that names such a variable calls `checkSecretVariable`; it does not keep its own check.

These fixed sentences are written by hand, and a change to them changes the snapshot files under `test/golden/`. A later change can build them from the list.
