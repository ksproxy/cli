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

## What is not in scope

These are documented limits in the README, not vulnerabilities:

- The allowlist binds only the MCP path. An agent that also has an unrestricted local shell can use the sockets and proxy ports directly, or edit the inventory and session files.
- A rule is only as safe as the program it allows. Programs such as `find`, `awk`, `vim`, `less` and `sudo` can run other commands.
- Command output is returned as-is. Replacing local paths and proxy addresses in the output is not redaction.
- The remote user's permissions and Kubernetes RBAC remain the boundary. Workloads the identity may create or change, such as a Pod that mounts a Secret or a service-account token, are not inspected.
- `"allow": "any"` on an ssh target sends the command as written.
- Connections and proxies can outlive a process killed with SIGKILL until the next `ksproxy start`.
- Creating server users, sudoers rules, RBAC, tokens or kubeconfigs, file transfer, interactive shells, and Windows are out of scope for the tool.
