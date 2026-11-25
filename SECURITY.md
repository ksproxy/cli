# Security policy

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
- Every failure on that path is a refusal with a fixed text: no socket, a time limit, a reply that is too large or malformed, a stopped session. No error text reaches the agent.

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

These are documented limits in the README, not vulnerabilities:

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
- The rights of the database or service account that a target uses are the real boundary. The fixed refusals and the read-only settings of the service kinds are a second lock.
- Secrets that a service returns in its own output, such as a password stored in a table, reach the agent as they are. Only the credentials that ksproxy holds are hidden.
- Hiding covers the exact value of each credential that ksproxy holds and the encoded forms a kind sends or shows, such as the base64 credential of basic auth or an escaped password. It does not cover other encodings of a value, or output that the agent can shape to test a guess, which is why `ksproxy start` warns about a secret shorter than 8 characters.
- Rules do not understand what a request does. They match the words of a request, a statement or a command, so a search body, a filter or a SQL function that is not on a fixed list is allowed when a rule matches.
- A `regex(...)` rule that can be very slow is only warned about, at `ksproxy start` and `ksproxy check`. It still runs, but every match stops after 100 ms and then counts as no match, so a slow rule refuses a call instead of stopping `ksproxy start`.
- Creating server users, sudoers rules, RBAC, tokens or kubeconfigs, file transfer, interactive shells, and Windows are out of scope for the tool.
