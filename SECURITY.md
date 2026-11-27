# Security policy

**Contents**

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Supported versions](#supported-versions)
- [What is in scope](#what-is-in-scope)
- [What the broker changes](#what-the-broker-changes)
- [What the MCP server changes](#what-the-mcp-server-changes)
- [What local listed programs and `ksproxy doctor` change](#what-local-listed-programs-and-ksproxy-doctor-change)
- [What the network listener changes](#what-the-network-listener-changes)
- [What is not in scope](#what-is-not-in-scope)
- [Hardening the agent](#hardening-the-agent)

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting:

1. Open https://github.com/ksproxy/cli.
2. Go to the **Security** tab.
3. Choose **Report a vulnerability** and describe the problem.

Please do not open a public issue for a suspected vulnerability. Include the version (`ksproxy --version`), the inventory rule or command involved, and the steps to reproduce. You will get a reply through the same private thread.

## Supported versions

Only the latest 0.x release is supported. Fixes are released as a new 0.x version.

## What is in scope

- A command or kubectl argument that the allowlist should refuse but runs.
- Shell syntax, option injection or a path check bypass that gets through the ssh tokeniser or the kubectl gate.
- A way for the agent, using only the MCP tools, to obtain a credential or to reach a target that was not selected.
- A request that reaches a project without a valid token, or before the `Origin`, `Host` and block checks of the network listener, or a way to read the token from ksproxy's files, output or log.
- Session files, sockets or the audit log created with wrong permissions, or connections and proxies left running after a clean shutdown.
- Log or output handling that lets target-supplied text forge or hide log lines.

## What the broker changes

The service kinds (databases, queues and HTTP APIs, see [docs/SERVICES.md](docs/SERVICES.md)) work differently from ssh and Kubernetes:

- The credentials of a service target live only in the memory of `ksproxy start`. It reads them from the environment, removes them from the environment of everything else it runs, and never writes them to the session folder, the log or an error text.
- `ksproxy mcp` only checks the shape of a call and forwards it to `ksproxy start` over a private Unix socket (`call-sock`, mode 0600) in the socket folder of the state folder. `ksproxy start` decides the call from its own list of open targets, never from `session.json`, so a rule added to the session file changes nothing.
- The Kafka client configuration file is read by the Kafka client program, not by ksproxy. Its contents are not hidden from output; ksproxy only keeps the agent from naming it and keeps local targets from reading it.
- The output of a service target has every secret value and every form of one replaced by `[hidden]` in the whole stream before anything is cut, and every rule that decides what to show reads the stream only after that, and counts its bytes before your own paths are removed from it. No rule looks at what the text ends with, neither for a piece of a secret nor for the start of one of your own folders. A stream that ended on its own drops nothing at its end. A stream that did not (the time limit, a broken reply, a program stopped at the read limit) loses its last 1 KiB at least, by count and never by what it holds, back to the end of a line, so a secret that its end cut shows no piece. That is 1 KiB while the longest secret of the target has at most 128 characters, and 8 KiB for each 1024 characters of it when it is longer; so how much is left out tells only whether the longest secret is over 128 characters, and then its length in steps of 1024 characters. The read limit grows by the same amount. A long stream shows its first bytes up to the output limit, counted before paths are removed, with a line that names that limit, not the raw size it was read to; a path that crosses the limit is left out whole. There is no end part.
- Every failure on that path is a refusal with a fixed text: no socket, a time limit, a reply that is too large or malformed, a stopped session. No error text reaches the agent.

## What the MCP server changes

An `mcp` target (see "MCP servers" in the README) runs or reaches an MCP server that holds the credential:

- **A local server is third-party code, run as you, without a sandbox.** It gets the credential it needs. No other variable of `ksproxy start` reaches it (it gets `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, some cache folders and the target's `env`), but it runs as your user, so it can read your files (`~/.ssh`, kubeconfigs, the secret files of other targets) and connect to the sockets and proxies of this session. ksproxy's rules check what the agent asks, not what the server's code does. Read what a server does before you add it, and give it an account with only the rights the agent needs.
- **Pinned versions.** A package run by `npx`, `bunx`, `uvx`, `pipx`, `docker run` or `podman run` must name an exact version or an image tag, so that the code does not change without you; an image tag can still be moved by whoever publishes it, and only a digest (`@sha256:...`) fixes it. `npm`, `pnpm`, `pnpx`, `yarn`, `bun`, `uv`, `deno`, `dnx`, `pixi`, `mise`, `corepack`, `python -m pipx` and `python -m uv` are refused as the program, because each can download and run a package in a way the check cannot read; `go run` of a module needs an exact version. This is a list of the runners ksproxy knows: any other program is yours and is not checked. A package's dependencies are not pinned by this; `uvx --exclude-newer DATE` fixes them to a date. `command` and `url` are not secret fields: put a key in `env` with `fromEnv`, or in `login`.
- **A server cannot make one answer or its list of tools grow past 16 MiB.** A message is read up to 16 MiB, the list of tools up to 16 MiB over all its pages, and answers to a local server that does not read its input are dropped past 1 MiB. Calls to a remote server run at the same time, so many large answers at once still use memory in proportion.
- **The server's stderr never reaches the agent or the audit log.** It can hold a token. Its last lines, cleaned and with secrets hidden, are shown only in the `start` terminal when a server fails or stops; the log gets a fixed text.
- **What the agent receives is cleaned.** Every text of the server that ksproxy shortens (an error message, a link, a MIME type, a description) has the target's secrets hidden first, with their JSON-escaped forms and the base64 of basic auth, and is then shortened. Nothing is dropped from it for being the start of a secret, since a server can repeat a guess of the agent and such a drop would tell whether the guess is right; an answer is cut only at its end, and the core then leaves out the end of it. The definitions of the exported tools are limited and cleaned (names, schemas, control and hidden characters), a tool whose schema holds a hidden character in a key or in a value the server checks is not exported, and each description says which server it comes from. Descriptions and answers come from the server and can try to steer the agent, as any output can.
- **A rule chooses tools and fixed values; it does not limit what a query reads.** A pattern on a JQL, CQL or search string can be passed by a query that reads more. The rights of the account are the boundary. Pinned `arguments`, an undeclared argument being refused and the refusal of `"allow": "any"` narrow what a rule allows, and nothing more.
- **A remote server** is reached over https (http only on loopback) with a token or basic login, without redirects. It sees what the agent sends and decides what it answers.
- **The agent's tool list comes only from the live session.** `ksproxy mcp` and the listener list the tools of `mcp-tools.json` only when its pid and start time are those of the live `session.json`, and each project only its own. A call of `TARGET__TOOL` becomes a call of `mcp_call` for a tool that `start` exported, which `start` decides again by its rules, so the direct names widen nothing.
- **The server is started by `ksproxy start`**, which holds the other credentials, so a server that runs as you can also reach the files and memory of that process, as any process of yours can (see "What is not in scope").

## What local listed programs and `ksproxy doctor` change

- A local target with a `programs` list and a `paths` list lets the agent run the programs you list, with any arguments, inside those paths, as you. This is trust in the agent with those programs inside those paths. ksproxy runs only a program word that is exactly one of the listed bare names, found on a clean `PATH`; checks every path that a command names (inside `cwd` and `paths`, not `protect`ed, not a secret-looking name, not ksproxy's files); refuses a best-effort list of options that run code or reach outside the paths (such as `find -exec`, `tar -P`, `tar -C`, `tar --to-command`, `cpio --insecure`, `sort --compress-program`, `split --filter`, an archive name with `:`, `unzip -:` and sed scripts with `e` or `w`); and checks every path of a reviewed command against `paths` too. No program is refused for being listed. A listed program that can run other code, reach the network, read other processes, use your saved logins or unpack archives (an interpreter, `ps`, `gh`, `aws`, `security`, `tar`) can act with your whole account, and `ksproxy start` and `ksproxy check` warn when you list one. ksproxy does not stop an argument that is not a path (a program can create or read a file named by a search word in `cwd`), what a program opens by itself, a file the agent wrote and another program then reads as instructions, archive members (an unpacked archive can hold links that point anywhere, so a program that follows links can then read any file of yours), or a secret in the output.
- `ksproxy doctor` opens every checked target with your credentials, the way `ksproxy start` does, and runs one fixed read-only check of its kind (a connection, `GET /version`, `select 1`, `PING`, and so on). The check is fixed by ksproxy, is not taken from the rules, and is not sent to the reviewer. It changes nothing on a target, uses a temporary socket folder that it removes (if doctor is killed first, the cluster proxies and ssh connections left in that folder run until the next `ksproxy doctor` or `ksproxy start` stops them and removes it), never writes `session.json`, the call socket or the audit log, and prints no secret value. It does contact each target and can show that a host or a credential exists. A project with a running session is reported and not opened.

## What the network listener changes

`ksproxy start --listen` serves the projects of that start over HTTP on loopback or private addresses of this machine (see "Network access" in the README):

- The listener runs as the user, like `ksproxy mcp`. It gives each call an environment without the credential variables of every project of this start, and brokered calls go to the call socket of each session as before. The separation is by environment, not by process: the listener runs inside the `start` process, which holds every credential in memory. Every rule, refusal, review and limit applies unchanged.
- One global token opens every project of that `start`. Only its SHA-256 is kept, in `listen/token.json` in the state folder (mode 0600, folder mode 0700), with the dates it was made, expires (one year later) and was revoked, and the time and address of its last use. The token is shown once, when it is made, and only on a terminal; ksproxy never writes it to a file, the log or an error text. It is compared as a digest in constant time, and the file is read on every request, so a revoke or a new token counts at once. A file that cannot be read refuses every request.
- Whoever holds the token can use every project of that `start`, with the rules of each target, until it is revoked or replaced. It is not one token per device or per project, and one device cannot be revoked alone.
- A request passes the address block, the `Origin` and `Host` checks and the token before its body is read. 10 wrong tokens in a minute block the address for a minute. Bodies over 256 KiB, more than 64 connections (or 16 from one address), a new call while 16 calls are running, a request that does not arrive within 10 seconds, and a connection that is idle for 60 seconds are refused or closed. A call goes on when its client leaves, and it counts toward the 16 until it ends.
- Plain HTTP is the default. Anyone who can record the traffic of that network can read the token and every answer, and can use the token. With `--tls-cert` and `--tls-key` (your own certificate) the traffic is encrypted, and an address that records traffic can no longer read it. TLS does not say who holds the token: the token still opens every project, and a certificate that the client does not check does not protect against a false server. Use TLS on a shared network. The TLS key file is added to the files that the local targets of this start can never reach; local targets of another `ksproxy start` do not know about it, and `ksproxy check` cannot know about it.
- A process of the same user can revoke the token, which only takes access away, and can read `token.json`, which holds a hash and no token. It can also replace `token.json` with the digest of a token it chose, as it can do anything the user can do; ksproxy itself offers no command that makes a token outside the `start` terminal. As before, a process of the same user can do what the user can do, such as stop `ksproxy start` or read the files it keeps.
- Private is about addresses, not about who is near. A private address on a VPN or overlay interface reaches every peer of that network, and a link-local address on an interface such as `awdl0` or `llw0` on macOS can reach nearby Apple devices that are not on your network. Each of them can try the token, so keep it secret and choose the listen addresses with care.
- `from` (the address) and `client` (the client name) in the log are information, not proof. The client name is what the client says in its own request. A local process that talks to the call socket itself could write other values.

## What is not in scope

These are documented limits, not vulnerabilities:

- The allowlist binds only the MCP path. An agent that also has an unrestricted local shell can use the sockets and proxy ports directly, or edit the inventory and session files.
- A process that runs as the same user and can inspect processes or read the user's files can read the credentials that `ksproxy start` holds: the environment `start` was started with stays visible to such a process (`ps -E`, `/proc/<pid>/environ`), exactly as the user's private keys and cluster configuration are. `ksproxy` keeps the Node inspector closed on `SIGUSR1` (Node runs with `--disable-sigusr1`, and the process also ignores the signal), which removes only the route through a debugger. The agent must therefore run without a shell of that user, inside a sandbox, or under another user.
- A project is not a wall between agents of the same user. It decides what each agent is offered, not what a process of that user can reach: any process of the user can run `ksproxy mcp --project NAME` for any project, and can read the state and configuration folders of every project.
- A rule is only as safe as the program it allows. Programs such as `find`, `awk`, `vim`, `less` and `sudo` can run other commands.
- The options refused for listed programs, and the list of programs that can act as you, are a best effort. A listed program can do more than its arguments say, and one that can act as you gives the agent your whole account.
- Command output is returned as-is. Replacing local paths and proxy addresses in the output is not redaction.
- The remote user's permissions and Kubernetes RBAC remain the boundary. Workloads the identity may create or change, such as a Pod that mounts a Secret or a service-account token, are not inspected.
- `"allow": "any"` on an ssh target sends the command as written.
- The secret checks of a local target look at arguments and names only. A program that reads files by itself, or a secret under an ordinary name, is not covered.
- Model review judges the words of a command, not what it does. An agent can try to word a harmful command so that it reads as harmless.
- A program that can write to ksproxy's state folder can impersonate the review service, as it can edit the session files there.
- For ssh, Kubernetes and local targets, `ksproxy mcp` reads the output limit of a target from `session.json`, so a session file edited by hand can raise it, but never past 4 MiB per stream, the largest value the inventory accepts; for a service target `ksproxy start` uses the limit of its own inventory.
- A reviewer on `localhost` is whatever program listens on that port. If your model server is not running, another local program can answer in its place and receives the key if `keyEnv` is set.
- Connections and proxies can outlive a process killed with SIGKILL until the next `ksproxy start`.
- `diff` runs the `diff` program found on `PATH`, and kubectl keeps a discovery cache under your home folder.
- A manifest can be swapped between the path check and kubectl opening it, by a process with local write access, which is already outside this tool's protection.
- Removing ports and paths from output is cosmetic: an agent with a local shell can find them anyway.
- The rights of the database or service account that a target uses are the real boundary. The fixed refusals and the read-only settings of the service kinds are a second lock.
- Secrets that a service returns in its own output, such as a password stored in a table, reach the agent as they are. Only the credentials that ksproxy holds are hidden.
- Hiding covers the exact value of each credential that ksproxy holds and the encoded forms a kind sends or shows, such as the base64 credential of basic auth or an escaped password. Also hidden: a value as the `mysql` client prints it in batch mode (a backslash, a tab, a newline and a NUL as a backslash and a letter); JSON as `JSON.stringify` writes it, with a slash escaped as PHP does, or with the signs less-than, greater-than and ampersand escaped as Go and Rails do; and, for the SQL kinds, a password inside a JSON text or an array of a row. Not covered, so shown: JSON inside a JSON string (escaped twice); other JSON writers (letters outside ASCII written as `\u` escapes, upper-case escapes, a quote as `\u0022`); a secret inside base64 or another binary form of a value (a MongoDB binary field, a PostgreSQL bytea); HTML entities and percent-encoding; a body that is not UTF-8; and the record form of PostgreSQL. It does not cover other encodings of a value, or output that the agent can shape to test a guess, which is why `ksproxy start` warns about a secret shorter than 8 characters.
- Four things are still open in the output of a service target. A stream that the read limit stopped, from which hiding takes more than 27 KiB (27648 bytes), is cut after a newline counted from an end that moves with the secret's length. Hiding takes the length of a secret less 8 bytes from each copy, so a secret of 16 characters must appear 3457 times or more in one stream. The Redis reader refuses a reply by its raw size at the read limit, secrets included, so whether a reply near that limit is shown at all can tell something of a secret's length. The mcp kind does the same with a message of the server over 16 MiB, counted in raw bytes: the call then fails as too large to read. Last, when a target hides a user name that the agent knows, beside the password: every place that either covers is hidden as one run, so output in which the agent's own text is followed by the password shows, in one call, whether the password starts with the last characters of the user name (or ends with its first ones). With a random password that tells almost nothing; do not build a password from its user name.
- Rules do not understand what a request does. They match the words of a request, a statement or a command, so a search body, a filter or a SQL function that is not on a fixed list is allowed when a rule matches.
- A `regex(...)` rule that can be very slow is only warned about, at `ksproxy start` and `ksproxy check`. It still runs, but every match stops after 100 ms and then counts as no match, so a slow rule refuses a call instead of stopping `ksproxy start`.
- Creating server users, sudoers rules, RBAC, tokens or kubeconfigs, file transfer, interactive shells, port forwarding for the agent, and Windows are out of scope for the tool.

## Hardening the agent

The allowlist binds the MCP path only, so what else the agent can run matters. The reliable setups:

- **No general shell:** the MCP tools are the only way the agent runs anything.
- **A sandboxed shell** that cannot read `~/.ksproxy` or `~/.config/ksproxy`, cannot reach local sockets and ports, and cannot see the other processes of your user.
- **A shell that runs as another user.**

Deny rules are best effort: `Bash(ssh *)` does not stop `/usr/bin/ssh` or `curl 127.0.0.1:<port>`, and `Read(...)` rules do not stop a shell command from reading a file. For Claude Code they still raise the bar. Put them in `.claude/settings.json` (one project) or `~/.claude/settings.json` (everywhere):

```json
{ "permissions": { "deny": [
  "Read(~/.ksproxy/**)", "Edit(~/.ksproxy/**)", "Read(~/.config/ksproxy/**)", "Edit(~/.config/ksproxy/**)",
  "Bash(ssh *)", "Bash(kubectl *)"
] } }
```
