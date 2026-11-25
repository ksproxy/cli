# Model review: exact rules and limits

The README has the short version. This page lists every check and every limit.

Model review is optional. When no allow rule matches a command and the target has `review`, ksproxy asks a model whether the command fits your policy. Fixed refusals and allow rules always run first, and the model can never override them.

**Contents**

- [Setting it up](#setting-it-up)
- [How a command is handled](#how-a-command-is-handled)
- [What is checked before the model is asked](#what-is-checked-before-the-model-is-asked)
- [What the agent is told](#what-the-agent-is-told)
- [In the log](#in-the-log)
- [Answers, repeats and the call budget](#answers-repeats-and-the-call-budget)
- [The key and the policy](#the-key-and-the-policy)
- [What is sent to the provider](#what-is-sent-to-the-provider)
- [Limits](#limits)

## Setting it up

Any provider with an OpenAI-compatible chat API works. Review is off by default and set per target.

```json
{
  "reviewers": {
    "groq": {
      "baseUrl": "https://api.groq.com/openai/v1",
      "model": "<model id>",
      "keyEnv": "GROQ_API_KEY"
    }
  },
  "ssh": [
    {
      "name": "web1",
      "host": "web1.example.com",
      "allow": ["uptime", "df -h"],
      "review": {
        "reviewer": "groq",
        "policy": "read-only diagnostics, no restarts, no file contents",
        "accept": ["sure"]
      }
    }
  ],
  "local": [
    {
      "name": "infra",
      "cwd": "~/projects/infra",
      "allow": ["git status"],
      "review": { "reviewer": "groq", "policy": "read-only", "programs": ["ls", "wc"] }
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `reviewers.<name>.baseUrl` | `https://`, or `http://` for localhost only. |
| `reviewers.<name>.model` | The model id. |
| `reviewers.<name>.keyEnv` | Optional. The environment variable that holds the API key when you run `ksproxy start`. It may not be a variable the session needs (`PATH`, `HOME`, `SSH_*` and similar; the full list is under "The key and the policy" below). It is removed from the environment of every program the session starts. |
| `reviewers.<name>.timeoutSeconds`, `maxCalls` | Optional. Defaults 10 and 200 calls per session. Failed calls count. |
| `review.reviewer` | A name from `reviewers`. |
| `review.policy` | What the agent may do, in plain words. Up to 1000 characters. |
| `review.accept` | Optional. `sure`, `likely` or both. Default `["sure"]`. |
| `review.programs` | Local targets only, required there. The programs the model may approve. |

## How a command is handled

1. Fixed refusals and your `allow` rules run first. A match runs the command, and the model is not asked.
2. If no rule matches and the target has `review`, ksproxy checks that the command may be reviewed at all (the checks below). If not, it is refused, and the refusal says why it was not reviewed.
3. The model answers allow or refuse, and how certain it is: sure, likely or unsure. The command runs only on allow with a certainty listed in `accept`.
4. Anything else is a refusal: a timeout, a bad answer, a missing key, a spent call budget, a review service that does not answer.

A command that is never sent to the model can still be put on the allow list.

## What is checked before the model is asked

A command that fails one of these checks is refused like any unlisted command. The model is not asked.

| Target | Check |
|---|---|
| All | At most 64 words. Each word is at most 200 characters and has no space, control character or double quote. |
| ssh | The first word has no `=` (so `VAR=x uptime` is not reviewed). No word starts with `=`. A server's shell would read these as an assignment or expand them. |
| kubernetes | The verb is a read verb: `get`, `describe`, `logs`, `top`, `explain`, `api-resources`, `api-versions`, `version`, `events`, `cluster-info`. |
| local | The folder exists. |
| local | The first word is in `review.programs`. |
| local | A flag looks like `-x` or `--word-word`: letters, digits and `-` only. A flag with a value (`--format=x`), `--` and a lone `-` are refused. |
| local | Every other argument is a plain name or path that passes the folder checks: no `..`, links followed, inside `cwd`, not a ksproxy file, not a protected path and not a secret-looking name. See [LOCAL-TARGETS.md](LOCAL-TARGETS.md). |
| local | A value glued to a flag (`-oout`) passes the same folder checks when its tail (`out`) names an existing entry in the folder or a `protect` entry. |
| SQL kinds | A comma, a bracket and a dot are words of their own, and a quoted string or name is one word, so a statement with a quoted text that holds a space is refused instead of reviewed. See [SERVICES.md](SERVICES.md). |

## What the agent is told

The refusal ends with why the command was not reviewed. `ksproxy check` prints the same sentence.

```text
REFUSED (local repo): not on the allowlist for this target. Allowed: pwd. It was not sent to the reviewer: the argument ../x contains "..".
```

Other endings:

- `only read verbs are reviewed, and delete is not one`
- `a word contains a space, a control character or a double quote`
- `the first word sets an environment variable on the server`
- `this target's folder does not exist`

When the model was asked and did not approve, the agent only gets `The reviewer did not approve it.` The model's reason goes to your log, not into the reply.

## In the log

A reviewed call in the log shows the model's reason, or why the review failed:

```
14:02:11 ssh  web1       ok       0.4s journalctl -u k3s -n 50  (model: read-only log view)
14:02:40 ssh  web1       DENIED        systemctl restart k3s  [model refused: restarts a service]
14:03:30 ssh  web1       DENIED        ps aux  [review failed: reviewer timed out]
```

## Answers, repeats and the call budget

- The command runs only when the model answers allow with a certainty listed in `accept`. `unsure` is never accepted.
- Everything else is a refusal: a timeout, an HTTP error, a redirect, a bad or oversized answer, a missing key, a review service that does not answer.
- A real answer is kept until the session ends, so the same command gets the same answer.
- Identical commands asked at the same time share one model call.
- This saves cost. It is not a control: a reworded command gets a fresh answer.
- Each reviewer has `maxCalls` per session (default 200). Failed calls count. Past the limit, unlisted commands are refused with `review limit reached`.

## The key and the policy

- The key is read from the variable named by `keyEnv` when `ksproxy start` runs. It is never written to a file or a log.
- That variable is removed from the environment of every program the session starts.
- `keyEnv` may not name a variable the session needs: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `TERM`, `TMPDIR`, `LANG`, `LANGUAGE`, `TZ`, `DISPLAY`, `KUBECONFIG`, or a name starting with `LC_`, `SSH_`, `NODE_`, `NPM_`, `XDG_` or `KSPROXY_`.
- If the variable is missing or empty, the log says `review is off` and the target runs with its allow list only.
- The policy and the reviewer settings stay in the memory of `ksproxy start`. The session folder only records that review is on, and the `programs` of a local target.

## What is sent to the provider

The policy, the kind and name of the target, and the words of the command. Nothing else: no output, no host name, no description, no credentials.

## Limits

- The model judges the words of a command, not what it does. `cat notes.txt` looks harmless even when the file holds a password.
- The agent writes the command, so it can try to make a harmful one look harmless. Keep write commands on the allow list.
- On a local target the model decides which flags are fine. With a rule you write each flag yourself.
- Do not put a program in `programs` that starts other programs or writes outside the folder: `find`, `xargs`, `env`, `make`, `git`, interpreters.
- A word that names no existing file passes the folder checks. The checks say nothing about what a program does with that word.
- A glued value that names nothing yet (`-onew`) is not checked, unless it names a `protect` entry.
- The folder checks run before the model is asked, so the gap between the check and the run is a few seconds longer than for a rule.
- The model's reason is in the audit log. An agent that can read ksproxy's state folder can read it there.
- A reviewer on `localhost` is whatever program listens on that port. If your model server is not running, another local program can answer in its place, and it gets the key if `keyEnv` is set.
- The ssh word checks were made for sh, bash and zsh as the server's login shell.
- The review socket is as open as the ssh sockets and the proxy ports. An agent with an unrestricted local shell can use up the call budget, but it cannot make a command run that way.
- A program that can write to ksproxy's state folder can pretend to be the review service. That is the same power as editing the session files there.
- The Anthropic endpoint in this format is a compatibility layer. Check its current limits first.
