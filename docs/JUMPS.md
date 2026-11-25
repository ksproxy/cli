# A server behind another server: exact rules and limits

The README has the short version. This page lists every rule and every limit of `jumps`.

Some servers are only reachable from another server, with a key that is stored there. By hand you connect to the first server and type a second ssh command. `jumps` lists those further ssh commands, in order:

```json
{
  "name": "app1",
  "host": "bastion1",
  "jumps": ["ssh -i .ssh/app_key -o LogLevel=ERROR opsuser@192.0.2.10"],
  "allow": ["uptime", "systemctl status *"]
}
```

**Contents**

- [What is sent](#what-is-sent)
- [How a jump must be written](#how-a-jump-must-be-written)
- [What ksproxy guarantees](#what-ksproxy-guarantees)
- [What it depends on](#what-it-depends-on)
- [Limits](#limits)

## What is sent

`ksproxy start` opens the connection to `host`. For the call `uptime`, ksproxy sends exactly this over it:

```text
ssh -T -o BatchMode=yes -i .ssh/app_key -o LogLevel=ERROR -o ConnectTimeout=10 opsuser@192.0.2.10 -- uptime
```

ksproxy adds `-T`, `-o BatchMode=yes`, `-o ConnectTimeout=10` and the `--`. The rest is your text.

With a second jump `ssh -i .ssh/inner_rsa deploy@10.0.0.5`, each ssh command is nested after the `--` of the one before it:

```text
ssh -T -o BatchMode=yes -i .ssh/app_key -o LogLevel=ERROR -o ConnectTimeout=10 opsuser@192.0.2.10 -- ssh -T -o BatchMode=yes -i .ssh/inner_rsa -o ConnectTimeout=10 deploy@10.0.0.5 -- uptime
```

`ksproxy check ssh app1 uptime` prints the string that would be sent, so you can compare it with what you type by hand.

## How a jump must be written

| Rule | Detail |
|---|---|
| Count | 1 to 5 jumps on an ssh target. |
| Characters | Plain words only: letters, digits and `_ @ % + = : , . / -`. No quotes and no `~`. |
| First word | `ssh`. |
| Options | `-i`, `-p`, `-l`, `-o` and `-J`, each followed by its value as a separate word. `-p2222` and other flags are refused. |
| `-o` settings | `Port`, `User`, `IdentityFile`, `IdentitiesOnly`, `StrictHostKeyChecking`, `UserKnownHostsFile`, `HostKeyAlias`, `ConnectTimeout`, `AddressFamily`, `LogLevel`, `ServerAliveInterval`, `ServerAliveCountMax`, `ProxyJump`, `Compression`, `HostKeyAlgorithms`, `PubkeyAcceptedAlgorithms`, `KexAlgorithms`, `Ciphers`, `MACs`, `PreferredAuthentications`. Written as `-o Key=Value`. |
| Server | One word after the options, such as `opsuser@192.0.2.10`. Nothing may follow it. |
| Rules | The target needs a list of rules. `"allow": "any"` is an error. |

Settings that run a program or open a port on that server, such as `ProxyCommand`, `LocalCommand` and `RemoteForward`, are refused.

## What ksproxy guarantees

- Through the ksproxy tools, the only command ksproxy sends to the first server is the fixed jump followed by an allowed command.
- The agent's words come after `--`. They cannot become options of that ssh, and they cannot start another command, because no shell syntax gets through.
- A command sent to the model reviewer and approved runs with the same fixed jump.
- `"allow": "any"` is refused, in the inventory and again on every call.
- The tools never show the jump text: not in `list_targets`, the agent notes, a refusal or a log entry of a call.

## What it depends on

- **The first server's own setup is trusted.** Its shell start-up files, an alias for `ssh`, its ssh configuration and its `PATH` decide what `ssh` does there.
- **Do not also list the first server as a target**, unless you want the agent to run commands on it.
- **A last server that can connect back to the first one** can run things there.

## Limits

- The key must work without a prompt: no passphrase, and the host key already known on the server before the jump.
- An `-i` path is read on the server before that jump. A path without a leading `/` starts in that login's home folder.
- IPv6 literal addresses are not accepted. Use a name from that server's ssh configuration.
- A word that starts with `=`, or contains `==` or `:=`, is refused in a command for such a target. zsh may rewrite such words.
- Each hop gives up connecting after 10 seconds, unless you set `-o ConnectTimeout=...` yourself.
- A call that times out can leave the inner ssh and its command running on the servers until they end or next write output.
- The health check only sees the first server. An inner server that is down shows as a failed command.
- ssh's own messages and a server banner can name the inner address. `-o LogLevel=ERROR` hides most of them.
- `ksproxy start` does not try the jumps. A wrong key or address shows on the first call.
- The checks were made for sh, bash and zsh as login shells, and for the OpenSSH client.
