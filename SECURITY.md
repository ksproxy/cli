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
- Session files, sockets or the audit log created with wrong permissions, or connections and proxies left running after a clean shutdown.
- Log or output handling that lets target-supplied text forge or hide log lines.

## What the broker changes

The service kinds (databases, queues and HTTP APIs, see [docs/SERVICES.md](docs/SERVICES.md)) work differently from ssh and Kubernetes:

- The credentials of a service target live only in the memory of `ksproxy start`. It reads them from the environment, removes them from the environment of everything else it runs, and never writes them to the session folder, the log or an error text.
- `ksproxy mcp` only checks the shape of a call and forwards it to `ksproxy start` over a private Unix socket (`call-sock`, mode 0600) in the socket folder of the state folder. `ksproxy start` decides the call from its own list of open targets, never from `session.json`, so a rule added to the session file changes nothing.
- The Kafka client configuration file is read by the Kafka client program, not by ksproxy. Its contents are not hidden from output; ksproxy only keeps the agent from naming it and keeps local targets from reading it.
- Every failure on that path is a refusal with a fixed text: no socket, a time limit, a reply that is too large or malformed, a stopped session. No error text reaches the agent.

## What is not in scope

These are documented limits in the README, not vulnerabilities:

- The allowlist binds only the MCP path. An agent that also has an unrestricted local shell can use the sockets and proxy ports directly, or edit the inventory and session files.
- A process that runs as the same user and can inspect processes or read the user's files can read the credentials that `ksproxy start` holds: the environment `start` was started with stays visible to such a process (`ps -E`, `/proc/<pid>/environ`), exactly as the user's private keys and cluster configuration are. `ksproxy` keeps the Node inspector closed on `SIGUSR1` (Node runs with `--disable-sigusr1`, and the process also ignores the signal), which removes only the route through a debugger. The agent must therefore run without a shell of that user, inside a sandbox, or under another user.
- A project is not a wall between agents of the same user. It decides what each agent is offered, not what a process of that user can reach: any process of the user can run `ksproxy mcp --project NAME` for any project, and can read the state and configuration folders of every project.
- A rule is only as safe as the program it allows. Programs such as `find`, `awk`, `vim`, `less` and `sudo` can run other commands.
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
