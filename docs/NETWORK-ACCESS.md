# Network access: exact rules and limits

The README has the short version. This page lists every rule, limit and message of the network listener. What it changes for security is in "What the network listener changes" in [SECURITY.md](../SECURITY.md#what-the-network-listener-changes).

By default ksproxy opens no network port. With `--listen`, `ksproxy start` also serves its projects over HTTP, so that an agent on another device of your local network, or on this machine, can use them. Everything runs in one terminal:

```
ksproxy start --project shop,ops --all --listen 192.168.1.20:7443 --listen 127.0.0.1:7443
```

**Contents**

- [Addresses](#addresses)
- [URLs and clients](#urls-and-clients)
- [The token](#the-token)
- [Plain HTTP and TLS](#plain-http-and-tls)
- [What the listener refuses](#what-the-listener-refuses)
- [Seeing who is connected](#seeing-who-is-connected)
- [Stopping and running](#stopping-and-running)
- [The other way: ssh](#the-other-way-ssh)

## Addresses

- `--listen` may be given several times.
- The host must be an IP address (IPv6 in brackets, such as `[fd00::5]:7443`), never a name.
- It must be a loopback or private address of this machine. `0.0.0.0`, `::` and every other address are refused before anything opens.
- Only one `start` with `--listen` runs at a time.

**Private is about addresses, not about who is near.** A private address on a VPN or overlay interface reaches every peer of that network. A link-local address on an interface such as `awdl0` or `llw0` on macOS can reach nearby Apple devices that are not on your network. Choose the addresses with care, and keep the token secret in every case.

## URLs and clients

- `POST http://192.168.1.20:7443/p/shop/mcp` reaches the project `shop`; `/mcp` reaches the default project.
- A project that this `start` does not run answers `404`.
- Only Claude Code and other MCP clients that can send a token in a header are served, not the Claude app.

When `start` makes a token, it prints it once, with one line per project:

```
claude mcp add --transport http ksproxy-shop http://192.168.1.20:7443/p/shop/mcp --header "Authorization: Bearer ksp_…"
```

- The default project is `ksproxy-default`, with the URL `http://HOST:PORT/mcp`.
- Run the line on the machine of the agent. Any listen address works in it.

## The token

- **One token for every project** of that `start`. It is valid for one year, or until it is revoked or replaced.
- **Only its SHA-256 is kept,** in `listen/token.json` in the state folder.
- **`ksproxy token`** shows when it was made, when it expires, whether it is revoked, and when and from where it was last used, never the token.
- **`ksproxy token revoke`** revokes it at once from any terminal.
- **A new token is made, and shown, only when the output of `start` is a terminal:** type `new-token` and Enter, or start with `--new-token`.
  - If the output is a file or a pipe and a new token would be needed, `start` refuses before anything opens with `a new token is shown only on a terminal: run this start once with its output on a terminal`.
  - A typed `new-token` then prints `[listen] a new token is shown only on a terminal`.
- **The old token stops at once** when a new one is made.
- **A later `start`** prints only `token from 2026-11-22, expires 2027-11-22`. In the last 30 days `start` warns that the token expires.
- **If the token file cannot be read,** `start --listen` stops with `cannot read FILE: start with --new-token to replace it`.
- **Whoever holds the token can use every project of that `start`**, with the rules of each target, until you revoke or replace it. Keep it as you keep a password.

## Plain HTTP and TLS

- **Plain HTTP is the default.** Anyone who can record the traffic of that network can read the token and every answer.
- **On a shared network use TLS** with your own certificate: `--tls-cert FILE --tls-key FILE` (both or neither, only with `--listen`). The URLs then start with `https`.
- A pair that does not belong together is refused before anything opens with `--tls-cert and --tls-key cannot be used together: MESSAGE`.
- The key file is read once, and a local target can never reach it. `ksproxy check` cannot know about this file.

## What the listener refuses

| Request | Answer |
|---|---|
| A request with an `Origin` header | refused |
| A `Host` header that does not name the listen address | refused |
| A missing, wrong, revoked or expired token | `401` |
| An address with 10 wrong tokens in a minute | blocked for a minute (`429`) |
| A body over 256 KiB | refused |
| More than 64 open connections, or more than 16 from one address | refused |
| A new call while 16 calls are running | `503`, try again soon |
| A request that does not arrive within 10 seconds | refused |
| A connection that is idle for 60 seconds | closed |

Every rule, refusal, review and limit of `ksproxy mcp` applies to these calls unchanged.

## Seeing who is connected

- The `start` terminal prints `[listen] 192.168.1.31 claude-code 2.1 connected` when an address first sends a valid request, and `[listen] refused 3 wrong tokens from 192.168.1.50` after wrong tokens.
- The terminal shows at most 10 such lines a minute. Further addresses are summed up in one line, `[listen] refused 12 wrong tokens from 4 other addresses`.
- The lines `[listen] cannot listen: …` and `[listen] cannot make a new token: …` go to stderr.
- `ksproxy status` shows the listen addresses, the token and each client with its last call and number of calls.
- Every logged call from the network carries the address, shown as `from ADDRESS`. `ksproxy log --from 192.168.1.31` shows only those entries.
- The address and the client name are information, not proof (see [SECURITY.md](../SECURITY.md#what-the-network-listener-changes)).

## Stopping and running

- **Stopping.** Ctrl-C, or closing the terminal, ends every running call, including calls that came over the network: the listener stops their programs and waits at most 5 seconds for them.
- **Run it in the foreground.** `start --listen` must run in the foreground of a terminal. As a background job (`&`) it is stopped by the system when it reads the terminal for `new-token`.
- **Without a terminal.** Give it none on stdin (`ksproxy start --listen … < /dev/null`), and make the token first, in a terminal.

## The other way: ssh

An agent on another machine can also use a project of this machine over ssh, with a key that is limited to one command. That way needs no network port of ksproxy. See [PROJECTS.md](PROJECTS.md#from-another-machine-over-ssh).
