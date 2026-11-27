# MCP servers: exact rules and limits

The README has the short version. This page lists every field, rule and limit of the `mcp` kind.

The `mcp` kind proxies an MCP server, local or remote, so that the agent uses the tools of that server without holding its credential. `ksproxy start` starts the server (or connects to it) with the credential it holds, and the allowed tools of the server appear in the agent's own tool list. Every call is checked against your rules (everything not allowed is refused), run, cleaned of secrets and written to the log, as for every other kind.

There is no new command and no new flag: choose `mcp` targets in the picker or with `--all`, like any target.

Before you add a local server, read "What the MCP server changes" in [SECURITY.md](../SECURITY.md#what-the-mcp-server-changes): it is third-party code that runs as you.

**Contents**

- [Adding a server](#adding-a-server)
  - [The server's environment](#the-servers-environment)
  - [`command` and `url` are not secret fields](#command-and-url-are-not-secret-fields)
- [Pinning](#pinning)
- [Rules](#rules)
  - [Pinned arguments](#pinned-arguments)
  - [A rule cannot limit what a query reads](#a-rule-cannot-limit-what-a-query-reads)
- [What the agent sees](#what-the-agent-sees)
- [What you see at `ksproxy start`](#what-you-see-at-ksproxy-start)
  - [`ksproxy check` and `ksproxy doctor`](#ksproxy-check-and-ksproxy-doctor)
- [Remote Atlassian server](#remote-atlassian-server)
- [What is not supported](#what-is-not-supported)
- [Two checks to make by hand](#two-checks-to-make-by-hand)

## Adding a server

```json
{
  "mcp": [
    {
      "name": "jira",
      "description": "Jira of jira.example.com",
      "command": ["uvx", "mcp-atlassian@0.24.8"],
      "env": {
        "JIRA_URL": "https://jira.example.com",
        "JIRA_USERNAME": "someone@example.com",
        "JIRA_API_TOKEN": { "fromEnv": "JIRA_TOKEN" }
      },
      "allow": [
        "jira_get_issue",
        "jira_search",
        { "tool": "jira_add_comment", "arguments": { "issue_key": "regex(SHOP-[0-9]+)" } }
      ]
    },
    {
      "name": "gh",
      "command": ["github-mcp-server", "stdio", "--read-only", "--toolsets", "issues"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": { "fromEnv": "GH_TOKEN" } },
      "allow": [{ "tool": "list_issues", "arguments": { "owner": "example", "repo": "shop" } }]
    },
    {
      "name": "ghremote",
      "url": "https://api.githubcopilot.com/mcp/x/issues/readonly",
      "login": "token",
      "tokenEnv": "GH_TOKEN",
      "allow": ["list_issues"]
    }
  ]
}
```

Each target has exactly one of `command` and `url`.

| Field | Rule |
|---|---|
| `command` | Runs a local server over stdio: a list of words, started without a shell, in an empty private folder. `uvx`, `npx`, `pipx`, `bunx`, `docker run -i --rm` and a program on your `PATH` all work. The program in `command[0]` is checked the way the `command` kind checks its program, and a package runner must be pinned (see [Pinning](#pinning)). |
| `url` | Connects to a remote server over HTTP. It must be `https`, or `http` on a loopback address only. It may not hold a user name or password. A query such as `?tools=all` is allowed. No redirect is followed. |
| `login` | With `url`: `none` (the default), `token` (`tokenEnv` names the variable that holds the token, sent as a bearer token) or `basic` (`userEnv` and `tokenEnv`). The OAuth login in a browser is not supported yet (see [What is not supported](#what-is-not-supported)). |
| `env` | With `command`: the server's environment variables. A value is a plain string, or `{ "fromEnv": "NAME" }` for a value that `ksproxy start` holds in its own environment; that value is treated as a secret and hidden everywhere. A name that starts with `LD_` or `DYLD_` is refused, as for the `command` kind. `start` warns when a plain value has a name that looks like a secret (it holds `TOKEN`, `PASSWORD`, `KEY` or `SECRET`): use `fromEnv` for it. |
| `arguments` (optional) | Pins arguments; see [Pinned arguments](#pinned-arguments). |
| `timeoutSeconds` (optional) | 1 to 600, default 60. The time limit of one call. A tool argument named `timeout_seconds` goes to the server unchanged. |
| `review` | Not available for `mcp` targets: it is an inventory error. |

### The server's environment

- The server gets a small environment: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TMPDIR`, the cache folders `XDG_CACHE_HOME`, `UV_CACHE_DIR` and `npm_config_cache` when set, and your `env`.
- No other variable of `ksproxy start` reaches it.
- Proxy and certificate variables reach the server only through `env`.

### `command` and `url` are not secret fields

- Both are written to `session.json`, and the `OPENING` line (the terminal and the log) shows the command and the URL without its query.
- Put a key in `env` with `fromEnv` for a local server, or use `login` for a remote one.
- `start` and `check` warn when a query name of `url` looks like a secret, and when a word of `command` does: an option such as `--token`, a setting such as `-e GH_TOKEN=...` (write `-e GH_TOKEN` and set it in `env` instead), a header such as `Authorization: Bearer ...`, or a URL with a password.
- A remote server that only takes its key in the URL cannot be given one safely.

## Pinning

A server run by a package runner downloads and runs code at every start, so the version must be exact. The check is made per runner, and an option it does not know is refused (so is a short option group such as `-it`):

| Runner | What is required | What is refused |
|---|---|---|
| `npx`, `bunx` | An exact version on every package, including every `-p` or `--package` value: `name@1.2.3`, `@scope/name@1.2.3`. | A package without an exact version (a range or a tag such as `@latest`); `npx -c` and `--call`. |
| `uvx` | The command word as `name@1.2.3`, or `--from` with an exact version (`name==1.2.3` or `name@1.2.3`); every `--with` exact too. | `@latest`, wildcards such as `==1.2.*`, git, URL and path specs, `--with-requirements`, `--with-editable`. |
| `pipx` | `pipx run`, with an exact version in `--spec` or in the package word (`name==1.2.3`). | Any other `pipx` command; `--pip-args`. |
| `docker run`, `podman run`, `nerdctl run`, `finch run` | An image with a tag other than `latest`, or a digest (`@sha256:...`), and the options `-i` and `--rm`. A tag can be moved by whoever publishes the image; only a digest fixes it. | Any other subcommand; an image with no tag or `latest`; `-t`, `--tty`, `-d`, `--detach`. |

- **How the runner is found.** By the base name of `command[0]`, in any letter case.
- **`go run`** of a module needs an exact version (`path@v1.2.3`).
- **Refused runners.** `npm`, `pnpm`, `pnpx`, `yarn`, `bun`, `uv`, `deno`, `dnx`, `pixi`, `mise` and `corepack` are refused whatever their words, and so are `python -m pipx` and `python -m uv`, because each can download and run a package in a way the check cannot read. Use `npx`, `bunx`, `uvx` or `pipx run` with a pin, or `node` or `python` for a script of your own.
- **Your own program.** Any other program (`github-mcp-server stdio`) is your own program and is not checked.
- An error says how to pin the package.

The pin fixes the package, **not its dependencies**. They are chosen when the package starts. For `uvx`, `--exclude-newer DATE` fixes them to a date: `["uvx", "--exclude-newer", "2026-11-01", "mcp-atlassian@0.24.8"]`.

## Rules

A rule is the name the server gives the tool (for example `jira_get_issue`, not `jira__jira_get_issue`). It is one of these:

- **a string:** allows that tool with any arguments;
- **an object** `{ "tool": NAME, "arguments": { ARG: VALUE, ... } }`: allows the tool only when every named top-level argument is present and matches. A `VALUE` is one of:
  - a JSON string, number or boolean that must be equal;
  - `"*"`: present, any value (`"\\*"` is a literal star);
  - `"regex(...)"`: must match the whole text of the value (a string as it is, anything else as compact JSON with sorted keys), at most 1,000 characters, stopped after 100 ms.

More about rules:

- Arguments a rule does not name are free.
- There is no regex over a whole rule and no dotted path.
- `"any"` is an error for `local`, `command`, `postgres`, `mysql`, `mongodb`, `kafka` and `mcp` targets (and ssh targets with `jumps`); on ssh the command is sent as written. For an `mcp` target, list the tools.
- When the server's schema lists its arguments, an argument the schema does not declare is refused, and a rule that names an argument the schema lacks gives a warning at start.

### Pinned arguments

With `"arguments": { "cloudId": "0123-example" }` on the target, ksproxy adds those values to every call of a tool whose schema declares them, and refuses a call whose own value differs.

- They are removed from the schema that the agent sees.
- Use it where one account reaches several sites or projects.
- A pin is sent only to a tool whose schema declares it. So a rule that names a pinned argument allows a tool that does not declare it no call at all: the call is refused, and `start` warns about such a rule.

### A rule cannot limit what a query reads

A regex on a query-language value (JQL, CQL, a search string) cannot say what the query reads: `project = SHOP OR project = HR` can pass a pattern meant for `SHOP`. Rules choose tools and fixed values. The rights of the account behind the credential limit the data, so give the server an account that has only the rights the agent needs, and read what a server does before you add it.

## What the agent sees

- **`TARGET__TOOL`.** Each allowed tool of a target is in the agent's tool list as `TARGET__TOOL` (for example `jira__jira_get_issue`), with the server's input schema. The description starts with `[from the MCP server "jira"]`, so the agent knows the text comes from the server. The whole name is at most 50 characters.
- **A tool is not listed** when:
  - its name has characters outside `A-Za-z0-9_-`;
  - its schema is not an object schema, or has a top-level `oneOf`, `anyOf` or `allOf`;
  - the server lists the name twice;
  - a key or a value of its schema (other than a description or a title) holds a hidden character (a control, format or variation selector character; a newline or a tab is fine);
  - the limits are passed: 200 tools per target, 64 KiB and 64 levels per schema, 1 MiB for all of a session.

  `start` warns for each.
- **Cleaned descriptions.** Descriptions are clipped to 1,000 characters and cleaned of control and hidden characters. `outputSchema` and `annotations` are never passed on.
- **When the tools exist.** The tools exist while a session of the project runs, listed after ksproxy's own tools. A call of one goes through the same rules, audit and answer as `mcp_call`, and is logged as `mcp_call`. The agent's arguments are sent as given (an argument named `timeout_seconds` belongs to the server); the time limit is the target's `timeoutSeconds`.
- **When the list changes.** Over the local `ksproxy mcp`, the agent is told within about 2 seconds when the tools appear or go (`list_changed`), when the inventory held an `mcp` target (or could not be read) as the agent connected. After you add your first `mcp` target, reconnect the agent's ksproxy server once (in Claude Code, `/mcp`). Over the network listener nothing is pushed, so a client sees the tools after it reconnects or asks for the list again.
- **`mcp_call`.** A fixed tool, `mcp_call` with `target`, `tool` and `arguments`, answers when it is called but is not in the tool list. It serves clients that cannot refresh their list.
- **`list_targets`** shows the target, its state and, in `tools`, the names of the exported tools. `AGENT.md` says which tools are exported and repeats the warning about queries.
- **Answers are text.** An image, audio or binary part becomes one line such as `[image, image/png, 41213 bytes, not shown]`. An answer that the server marks as an error is an error answer. The usual output limit applies.
- **Requests from the server.** A server that asks the client for something (sampling, elicitation, roots) is told it is not supported, and the call goes on. If the server then says it needs input, the call ends as an error.
- **One call at a time.** Calls to one local server run one at a time.

## What you see at `ksproxy start`

Starting a local server can take a while, because the first `uvx` run downloads the package. The wait is up to 120 seconds for a local server and 30 seconds for a remote one. Ctrl-C ends the wait. A server whose list of tools takes more than 16 MiB over all its pages is skipped.

```text
10:00:01 mcp  jira       OPENING         uvx mcp-atlassian@0.24.8, 3 variables
10:00:09 mcp  jira                       41 tools listed, 3 exported
10:00:09 mcp  jira       UP
```

- **Warnings.** `start` warns when a rule names a tool the server does not list, when a tool is not exported, and for the secret-looking plain values of `env`.
- **The server's stderr.** When a server fails to start or stops, its last lines on stderr (cleaned, with secrets hidden) are shown **in the `start` terminal only**. The audit log gets a fixed text, and the agent never sees the server's stderr, because it can hold a token.
- **A remote server that cannot be reached.** `start` and `doctor` say why, from a fixed list chosen by the error's code only (never its message, which could hold a secret), and a call that fails the same way says it in its answer. The reasons are: the server's certificate is not trusted (set `NODE_EXTRA_CA_CERTS` for `start` to its CA), the certificate has expired or is not valid yet, the certificate is for another host name, the connection was refused, the host name was not found, the connection timed out, and the connection was closed by the other side. Any other error gives no reason.
- **A server that stops** makes its target `down`. It is not restarted.

### `ksproxy check` and `ksproxy doctor`

- `ksproxy check mcp NAME TOOL` and `ksproxy check mcp NAME TOOL '{"issue_key":"SHOP-1"}'` answer from the rules alone (there is no session). `mcp` here is the kind word, not a flag.
- `ksproxy doctor` starts the server and lists its tools. For a local server it reports `N tools listed, M exported; the credential is checked only by a call`: doctor never calls a tool, so it cannot show that the token works. For a remote server the authenticated list of tools proves the token.

## Remote Atlassian server

For Atlassian's remote server:

- Add `?tools=all` to the `url` if you want its full tool list.
- Pin `cloudId` with `arguments`, so that a tool that takes `cloudId` cannot reach another site. A pin reaches only the tools whose schema declares it, so check that each tool you allow does.
- Find out first whether your organisation allows API tokens for it:

  ```sh
  curl -s -u someone@example.com:"$JIRA_TOKEN" https://<your-site>.atlassian.net/rest/api/3/myself
  ```

  If this shows your account, API tokens work. If it is refused, the remote server needs the OAuth login, which is not supported yet.

## What is not supported

- The OAuth login in a browser (a later phase).
- Model review of `mcp` calls.
- A whole-rule regex or dotted paths in rules.
- Following a change of the server's tools while the target is open: the list is taken once, when the target opens, and the next `start` takes the new one.
- Restarting a server that stopped.
- Resources, prompts, completions, sampling, elicitation, roots and subscriptions.
- The older HTTP+SSE transport.
- A sandbox for local servers.
- Images passed on as images.

## Two checks to make by hand

These depend on the agent program, not on ksproxy, so try them once in Claude Code:

- that its tool list refreshes during a session after `list_changed` (start the session, then `ksproxy start`);
- that a name with `__`, such as `jira__jira_get_issue`, works in its permission rules.

How the kind and its client are built is in "The mcp kind and its client engine" in [KINDS.md](KINDS.md#the-mcp-kind-and-its-client-engine).
