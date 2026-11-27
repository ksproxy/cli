# The inventory and allowlist rules: exact reference

The README has the short version. This page lists every inventory field, every rule token, the Kubernetes command gate and how to test a rule. For a read-only and a read-and-write example of each kind, see [EXAMPLES.md](EXAMPLES.md).

**Contents**

- [Where the inventory lives](#where-the-inventory-lives)
- [The fields](#the-fields)
- [The state folder and the programs ksproxy runs](#the-state-folder-and-the-programs-ksproxy-runs)
- [Rule tokens](#rule-tokens)
- [Regex rules](#regex-rules)
- [How commands arrive](#how-commands-arrive)
- [The Kubernetes command gate](#the-kubernetes-command-gate)
- [Testing a rule](#testing-a-rule)

## Where the inventory lives

- `inventory.json` lives in `$KSPROXY_CONFIG_DIR`, else `$XDG_CONFIG_HOME/ksproxy`, else `~/.config/ksproxy`.
- The file of a project has the same format and lives in the `projects` folder there, as `projects/NAME.json` (see [PROJECTS.md](PROJECTS.md)).
- Any validation failure is an error that names the entry and the field.
- Unknown keys anywhere are errors, so a typo cannot silently drop a restriction.

```json
{
  "ssh": [
    {
      "name": "web1",
      "host": "web1.example.com",
      "description": "production web box",
      "allow": ["systemctl status *", "journalctl -u myapp ...", "df -h"]
    }
  ],
  "kubernetes": [
    {
      "name": "lab",
      "kubeconfig": "~/.kube/lab-agent.yaml",
      "proxyPort": 8001,
      "tunnel": { "host": "bastion.example.com", "localPort": 16443, "remote": "127.0.0.1:6443" },
      "manifestRoots": ["~/projects/lab/manifests"],
      "description": "lab cluster",
      "allow": ["get ...", "describe ...", "logs ...", "rollout status ...", "apply -f *"]
    }
  ],
  "local": [
    {
      "name": "infra",
      "cwd": "~/projects/infra",
      "description": "terraform repo",
      "allow": ["git status", "git log --oneline -n * ...", "terraform plan", "ls -l ..."]
    }
  ]
}
```

## The fields

| Field | Rule |
|---|---|
| top level | An object with optional `ssh`, `kubernetes`, `local` and service-kind arrays (see [SERVICES.md](SERVICES.md)), `mcp` (see [MCP-SERVERS.md](MCP-SERVERS.md)), and `reviewers`. |
| `reviewers`, `review` (optional) | Model review of commands no rule matches. See [MODEL-REVIEW.md](MODEL-REVIEW.md). |
| `name` | `^[a-z0-9][a-z0-9-]{0,30}$`, unique within its kind. |
| `ssh[].host` | An ssh destination your own ssh config resolves. `^[A-Za-z0-9][A-Za-z0-9._@-]*$`; it may not start with `-`. |
| `ssh[].jumps` (optional) | ssh targets only. 1 to 5 ssh commands that follow `host`, in order, for a server that only the first one can reach. Each is `ssh`, then any of `-i -p -l -J` or `-o Key=Value` (listed settings only) with a value as a separate word, then one server. `allow` must be a list, not `"any"`. See [JUMPS.md](JUMPS.md). |
| `kubernetes[].kubeconfig` | A path; `~/` is expanded. It is your real kubeconfig for that cluster and is read only by `kubectl proxy`. |
| `proxyPort`, `tunnel.localPort` | Integers 1024-65535, unique across the whole file, and not named in any other inventory file (see [PROJECTS.md](PROJECTS.md#what-two-projects-share)). |
| `tunnel` (optional) | `host` as above; `remote` is `host:port`. When present, point the kubeconfig's server at `https://127.0.0.1:<localPort>`; the tool does not verify this. |
| `manifestRoots` (optional) | Absolute or `~/` directories. The only places `-f` and `--patch-file` may read a single file from. |
| `local[].cwd` | The folder the commands run in. Required; absolute or `~/`. It is never shown to the agent. |
| `local[].protect` (optional) | Local targets only. Up to 50 files and folders inside `cwd` that no wildcard argument or argument sent to the model reviewer may name, enter or contain. Plain paths relative to `cwd`, no patterns. See [LOCAL-TARGETS.md](LOCAL-TARGETS.md#the-protect-field). |
| `local[].paths` (optional) | Local targets only. Up to 50 files, folders and patterns inside `cwd` that every path of a call must lie inside: a wildcard argument of a rule, a path of a listed program, a path of a reviewed command. See [LOCAL-TARGETS.md](LOCAL-TARGETS.md#listed-programs-inside-chosen-paths). |
| `local[].programs` (optional) | Local targets only. Up to 50 bare program names that may run with any arguments inside `paths`; it needs `paths`. |
| `description` (optional) | A string shown in the selection list and to the agent. |
| `maxOutputKiB` (optional) | Any kind of target. The output limit of each of the two streams of a call, in KiB: an integer from 256 to 4096. Without it the limit is 256 KiB. It only raises the limit for this target; `list_targets` and `AGENT.md` show it when it is not 256. The agent cannot ask for more. A cut stream says about how much was cut in a line right after the exit code, and a stream of an ssh, kubectl or local command, which is read to its end, also shows its last 16 KiB within the limit; see [SERVICES.md](SERVICES.md#what-every-service-kind-has-in-common) for the service kinds. |
| `allow` | An array of rule strings, or the string `"any"`. Missing means an empty list, which refuses everything. `start` warns for each selected target with an empty list; the warning is printed before the target is opened, even if the target is then skipped. `"any"` is an error for `local`, `command`, `postgres`, `mysql`, `mongodb`, `kafka` and `mcp` targets (and ssh targets with `jumps`); on ssh the command is sent as written. For a `local` target, list the commands, and every `local` rule must start with the program name (not `*` or `...`), or list programs with `programs` and `paths`. |

## The state folder and the programs ksproxy runs

- **State folder.** State is kept in `~/.ksproxy` (override: `KSPROXY_STATE_DIR`). Directories are created 0700 and files 0600. What is in it: [SESSION-AND-LOG.md](SESSION-AND-LOG.md).
- **Keep that path short.** Unix socket paths are limited in length. `start` fails with a clear message if one would exceed 100 bytes, or 83 bytes for the socket of an ssh connection or a cluster tunnel, because ssh first creates that socket under a name 17 bytes longer.
- **Programs.** `ssh` and `kubectl` are found on `PATH`; `KSPROXY_SSH` and `KSPROXY_KUBECTL` override them with absolute paths. `KSPROXY_PSQL`, `KSPROXY_MYSQL` and `KSPROXY_MONGOSH` do the same for the database clients.

## Rule tokens

A rule is whitespace-separated tokens, matched against the command's arguments.

| Token | Matches |
|---|---|
| a literal | an argument equal to it |
| `*` | exactly one argument that does not start with `-` (in a local rule: one plain name or relative path; in a `postgres` or `mysql` rule: one value, a number such as `-1` or `1.5` or one string in single quotes, never a name) |
| `...` | zero or more arguments of any shape; only legal as the last token (in a local, `command` or `kafka` rule: never a word that starts with `-`; in a local rule also only plain names and relative paths: write every flag into the rule) |
| `\*` | only the argument `*`, a literal star |
| `regex(...)`, as the whole rule | the whole command matches the pattern |

- An empty rule, or `...` anywhere but last, is an inventory error.
- For the service kinds the words are those of a request, a SQL statement, a Redis command and so on; see [SERVICES.md](SERVICES.md).
- In the inventory file a backslash is written twice, because JSON uses it too: `"get pods -l \\*"`, `"regex(\\./run\\.sh)"`.

| Rule | Allows | Does not allow |
|---|---|---|
| `df -h` | exactly `df -h` | `df`, `df -h /` |
| `systemctl status *` | `systemctl status nginx` | `systemctl status`, `systemctl status --all` |
| `journalctl -u myapp ...` | `journalctl -u myapp --since today -n 50` | `journalctl -u other` |
| `get ...` (Kubernetes) | `get pods -A` and any other `get` | |
| `apply -f *` (Kubernetes) | `apply -f <one path>`; the path must also sit inside `manifestRoots` | |
| `get pods -l \*` (Kubernetes) | `get pods -l *` and nothing else in that place | |
| `regex(systemctl status (nginx\|redis))` | `systemctl status nginx`, `systemctl status redis` | `systemctl status nginx --all` |

## Regex rules

- **How it matches.** A regex rule is tried on the command's words joined by single spaces and must match all of it, with or without `^` and `$`. It has no flags and is not tried on a command longer than 1000 characters. Kubernetes arguments can hold spaces; they are still joined by single spaces.
- **Words or one regex, never both.** `regex(` inside a word rule is an inventory error, and so is an empty pattern or one that does not compile.
- **The fixed checks run first.** The strict tokenizer and the fixed refusals run first, so a regex rule cannot allow what they refuse.
- **A regex can match an option.** A regex rule matches exactly what its pattern says, unlike `*`, which never matches an option. So `\S+` and `.*` also match an option such as `-delete`: `regex(find /srv/app \S+)` allows `find /srv/app -delete`. Write `[^-\s]\S*` for "one word that is not an option".
- **On `command` and `kafka` targets it is the other way round.** A regex rule allows a word that starts with `-` only when the pattern holds that exact word, so `\S+` never matches `-x` there.
- **On a local target** a regex rule must start with the program name, written literally (`\.` for a dot). When it matches, the first word must be that program, and every other word is checked like a word matched by `*`. So a regex rule there never allows a flag.
- **Slow patterns.** A pattern with a backreference, a repeat around a group that holds a repeat or `|`, such as `(a+)+`, or two repeats in a row that can match the same character, such as `.*.*` or `\S*\S*`, gets a warning from `ksproxy start` and `ksproxy check`: `allow[N]: this pattern can be very slow on some inputs`. The rule still works.
- **A time limit on every match.** Every match of a regex rule stops after 100 ms: a match that takes longer counts as no match, and the refusal says which rule took too long.

## How commands arrive

- **ssh commands** arrive as one string and are tokenised strictly: at most 4096 bytes, trimmed, split on runs of spaces or tabs, and the first token may not start with `-`. Every character of every token must be one of `A-Z a-z 0-9 _ @ % + = : , . / -`. Everything else is refused and named in the error: quotes, `; | & $ \` ( ) { } < > * ? [ ] ! # ~ \`, newlines, control characters and non-ASCII. The tokens are matched against the rules, and the remote command is the tokens joined by single spaces, so no shell syntax can be present.
- **`"allow": "any"` on an ssh target** skips tokenising and matching, and the command is sent as written, so pipes and redirects work. It must still be non-empty, at most 4096 bytes, free of control characters (a tab is allowed), and not start with `-`. On a Kubernetes target `"any"` still goes through the hard refusals of [the Kubernetes command gate](#the-kubernetes-command-gate).
- **Local commands** arrive as one string and go through the same strict tokeniser as ssh commands, then through the checks in [LOCAL-TARGETS.md](LOCAL-TARGETS.md).
- **Kubernetes arguments** arrive as an array and run locally without a shell. Each must be a non-empty string of at most 4096 bytes with no control characters. They are matched after the kubectl allowlist below.
- **A refusal names the target and lists its rules,** so the agent can adapt.

## The Kubernetes command gate

The kubectl gate is an allowlist: a verb, flag or spelling that is not on a built-in list is refused. It applies before your per-target `allow` rules, and also when `allow` is `"any"`.

- **Verbs.** The verb must be the first argument; flags go after it. The available verbs: `get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `api-versions`, `version`, `events`, `auth` (only `auth can-i` and `auth whoami`), `cluster-info`, `apply`, `create`, `delete`, `patch`, `replace`, `rollout`, `scale`, `autoscale`, `label`, `annotate`, `set`, `expose`, `wait`, `diff`, `cordon`, `uncordon`, `drain`, `taint`.
- **Refused verbs.** Anything else, including plugins and `exec`, `cp`, `port-forward`, `proxy`, `debug`, `config`, `edit`, `run`, `kustomize` and `completion`.
- **Flags.** Only flags on a built-in list are accepted; anything else is refused. That covers identity and target flags (`--kubeconfig`, `--context`, `--server`, `--token`, `--as`, ...), local-file flags (`--from-file`, `--from-env-file`, `--template`) and debugging flags (`-v`, `--profile`, `--cache-dir`, `--kuberc`). Underscore spellings (`--from_file`) are treated as their dash form. Write short flags separately (`-o json`, not `-ojson`); a bare `--` is refused.
- **Output formats.** `-o` and `--output` accept only `json`, `yaml`, `wide`, `name`, `jsonpath=...`, `jsonpath-as-json=...` and `custom-columns=...`. The `...-file` variants and Go templates are refused.
- **Manifest files.** The value of `-f`, `--filename` or `--patch-file` (as `flag value` or `flag=value`) must be one regular file whose real path is inside one of the target's `manifestRoots`. `-f` is not checked for `logs`, where it means follow.
  - URLs, `-` (stdin), `..` escapes, symlinks that leave the root, and any path when no `manifestRoots` is configured are refused.
  - Directories are refused, because kubectl would walk them and follow symlinks that leave the root, which the path check cannot see.
  - `-k` and `--kustomize` are not available, because kustomize can fetch remote bases with your git credentials and read outside the root.
  - `apply edit-last-applied` is refused, because it opens an editor.
- **Always refused.** `create token` (it would hand out a credential), `cluster-info dump`, and secret resources: any argument that, split on `,`, has a part matching `^secrets?([./]|$)` (case-insensitive), including after an `=`.
- **Arguments.** Every argument must be a non-empty single-line string of at most 4096 bytes with no control characters.
- **A second lock.** `kubectl proxy` itself also rejects the API paths for pod exec, attach, port-forward, secrets and service account tokens. Kubernetes RBAC on the identity behind your kubeconfig is the boundary.

## Testing a rule

`ksproxy check` says whether a call would be allowed, without opening anything:

```
ksproxy check ssh web1 systemctl status nginx     # ALLOWED by rule: systemctl status *   (exit 0)
ksproxy check ssh web1 rm -rf /                   # REFUSED: ...                            (exit 1)
ksproxy check kube lab get secrets                # REFUSED: secret resources are never allowed
ksproxy check local infra git status              # ALLOWED by rule: git status
```

- **Exit codes.** 0 is allowed, 1 is refused, 2 is a usage or inventory problem.
- **On a reviewed target,** for a command that no rule matches, `check` prints `NOT ON THE ALLOWLIST: a running session asks reviewer "<name>"` and exits 1. It never calls a model.
- **`command` and `kafka` targets need their programs.** For these targets `ksproxy check` first looks up the program, or the Kafka client programs and the `clientConfig` file, as it checks the folder of a `local` target, and refuses when they are missing. So their rules cannot be tried on a machine that does not have them.
- **A body is sent as `{}`.** For `http`, `elasticsearch` and `rabbitmq`, `check` sends `+body` as an empty JSON object `{}`. So a refusal that depends on the body, such as a key that holds `script` in an Elasticsearch body, cannot be shown with `check`.
- For the service kinds, the words of the call and the flag of each kind are in [SERVICES.md](SERVICES.md); for an `mcp` target, see [MCP-SERVERS.md](MCP-SERVERS.md#ksproxy-check-and-ksproxy-doctor).
