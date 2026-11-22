# Local targets: the exact rules

The README has the short version. This page is the full reference: every check, limit and refusal message.

A `local` target lets the agent run allowlisted commands on this machine, in the folder named by `cwd`, through the `local_exec` tool. It is the riskiest kind: the command runs as you, on the machine that holds your keys. Every call goes through these steps, in this order, and the first one that fails refuses the call:

1. **Plain words only.** The command is tokenised exactly as for ssh: at most 4096 bytes, split on spaces and tabs, every character one of `A-Z a-z 0-9 _ @ % + = : , . / -`, and the first token may not start with `-`. No quotes, `~`, `$`, pipes, redirects or other shell syntax can get through. The program is started directly with an argument list; no shell is ever involved.
2. **A wildcard matches plain names and paths only, never a flag.** Both `*` and `...` match arguments that are a plain name or relative path: letters, digits and `_ . / -`, not starting with `-` (`a.txt`, `sub/b.txt`, `main..dev`, `20`, `.`). Everything else is refused with `not a plain argument`: every flag (`-l`, `--oneline`, `--since=2.days`, `-C`, `--upload-pack=sh`), an absolute path, `@`, `%`, `+`, `:`, `,` or `=` inside a positional, `--`, `-`, a `file:` URL. A flag is how a program is told to do something else (`git -C sub` changes the folder that later arguments resolve against; `--upload-pack=sh` names a program to run), so every flag the agent may use must be written literally into the rule: `ls -l ...`, `git log --oneline -n * ...`. A literal token is your own choice and is not checked (a rule such as `curl -d@/etc/hosts *` allows exactly what it says).
3. **Every plain value is checked.** The plain argument may not contain a `..` segment. Empty and `.` segments are dropped first (`a/./b` and `a//b` mean `a/b`; a trailing slash disappears, so `link/` is judged as `link`, not as a missing path under it; `.` and `./` name the folder itself). A plain argument longer than 512 bytes is refused (`argument too long`) before anything is joined. The result is joined to the real path of `cwd` (a folder is at most 400 bytes, see below), so the path the checks examine is never longer than the path the program opens; a joined path above 1000 bytes is refused with the same message as a backstop. The joined path is resolved so that links are followed in the order the system follows them (an existing path by its real path; a missing one by its nearest existing parent). A path that cannot be resolved is refused as `unresolvable link` (a dangling link, a loop or too many links), and one that cannot be examined is refused as `cannot be examined` (a name too long for the system, a folder you may not search). Only "does not exist" and "a file is in the way" let the check look at the nearest existing parent instead. A path that goes through a symbolic link into `/proc`, `/dev` or `/sys` is refused (`system link`), because such a link can resolve differently in ksproxy and in the command it starts. Neither the path nor its real path may be, contain or lie inside a protected location (`ksproxy files`): the ksproxy state folder, its configuration folder (each as recorded by `ksproxy start`, as written and by real path, letter case ignored on macOS and Windows) or any kubeconfig or Kafka client file named in any of your inventory files (the default `inventory.json` and every project file). The real path must also be inside the real path of `cwd`; there is no switch that allows paths outside it. To let the agent read one file outside the folder, write it literally into a rule (`cat /etc/hosts`), which allows exactly that command. On macOS a real path is compared without a leading `/System/Volumes/Data` component, so both spellings of one file are the same file. When several rules match loosely, the refusal the agent sees is the most informative one, not `not a plain argument` when another reason exists. Two more checks come last, after the folder check:
   - **Protected path.** For each `protect` entry, taken as `<real cwd>/<entry>` and by its real path: the argument (as resolved, or by real path) may not be that path, lie inside it or contain it. Refusal: `the argument <value> is, lies inside or contains a path this target protects` (short `protected path`).
   - **Secret-looking name.** No part of the argument as written, and no part of its real path relative to the real `cwd`, may be a name that usually holds secrets. Refusal: `the argument <value> names a file or folder that usually holds secrets` (short `secret file`).
4. **The program names itself.** The first token is the program. Every allow rule of a local target must start with a literal program name (never `*` or `...`), so the program is always chosen by you and is exempt from the path checks: `venv/bin/python`, a link to a system interpreter, keeps working.
5. **The allowlist.** The tokens must match one of the target's rules, as described under "Allowlist rules", in order. The first rule that matches and whose wildcard arguments pass the checks above allows the call; if a rule matches but its wildcard arguments are refused, the next rule is tried, and when none allows it the most useful refusal is reported (a specific reason rather than `not a plain argument`). `"any"` is refused here too, in case a session file was edited.

Folders that cannot be a local target: when `start` opens the target (and in `ksproxy check local`, and again on every call, against the protected locations recorded by `start`) the real path of `cwd` must not be the filesystem root, your home directory or a parent of it (`folder is too broad: pick a project folder, not <cwd>`), nor equal, contain or lie inside ksproxy's state folder or configuration folder (`folder overlaps ksproxy's own files`), nor contain any kubeconfig or Kafka client file named in any of your inventory files, the default and every project file (`folder contains a kubeconfig named in the inventory`), it must be resolvable and may not go through a link into `/proc`, `/dev` or `/sys` (`folder cannot be resolved`), and its real path may be at most 400 bytes (`folder path is too long`). Such a target is `SKIPPED`, with those messages, or with `folder not found` or `not a directory`. The other inventory files are read as JSON without being checked; when one of them cannot be read or is not valid JSON, the files it names are not known, so every local target is `SKIPPED` with `cannot read <file> to protect the files it names`, before any of the checks above. The agent is not told which of them applies, only that the folder is not acceptable and that you can run `ksproxy check local <name>`, or `ksproxy check --project NAME local <name>` for a target of a project; that command, like `start`, shows you the detailed message. `ksproxy check local` applies the same checks and the same protected kubeconfigs as a live session.

The program runs with `cwd` as its working folder and with only the minimal environment (`PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`). Its `PATH` is built from the `PATH` that `ksproxy start` had, keeping only the absolute entries that are not inside the folder of any local target of the session: relative and empty entries (which would resolve against the folder), and entries that lie in a local target's folder or that a link leads into one, are dropped; if nothing is left it is `/usr/bin:/bin`. So a file named `git` in the folder is never the `git` that runs, but a rule that names a program with a slash (`./run.sh`, `venv/bin/python`) runs exactly that file. No `KSPROXY_*` variable and nothing else from your environment reaches the program. The folder and the state folder are replaced in the output by `<folder>` and `<ksproxy>`, as configured, as resolved and as the system spells it, and on macOS and Windows whatever the letter case; a path is replaced only where no letter, digit, `_`, `.` or `-` follows it (a folder `/work/app` is not replaced inside `/work/apple` or `/work/app.log`); a path is replaced whole even where the output limit (256 KiB, or the `maxOutputKiB` of the target) cuts the text. `list_targets` never shows `cwd`. If the folder disappears the health check logs `DOWN` with `folder is gone`, and `UP` with `folder is back` when it returns.

## Protected paths and secret-looking names

The two checks at the end of step 3 run on every argument that a wildcard matches, and on every plain argument of a command sent to the model reviewer. No rule and no model answer can override them. Only a path written literally into a rule is exempt.

For a command sent to the model reviewer, a value glued to a flag (`-oout`) is checked when its tail (`out`) names an existing entry in the folder or a `protect` entry.

### The `protect` field

```json
{
  "name": "infra",
  "cwd": "~/projects/infra",
  "allow": ["cat *", "grep -r * *", "ls ..."],
  "protect": ["secrets", "deploy/key.txt"]
}
```

| Field | Rule |
|---|---|
| `protect` | Local targets only. Optional. A list of 1 to 50 paths. On an ssh or Kubernetes target it is an error (unknown key). |
| each entry | A string of 1 to 512 bytes without control characters. Relative to `cwd`: no leading `/` or `~`, no `..` part. Empty and `.` parts are dropped (`./a//b` is `a/b`). It may not name the folder itself. No repeats after that clean-up. |

- With `"protect": ["secrets"]`, `cat secrets/token`, `ls secrets` and `grep -r x .` are refused. `grep -r x src` works.
- An entry is a plain path, not a pattern. `*` and `**` are not special.
- The path does not have to exist. An entry for a file that appears later protects it from then on.
- A protected path is compared without regard to letter case on every system, because a Linux folder can sit on a case-insensitive mount. With `"protect": ["secrets"]`, `cat SECRETS/token` is refused everywhere.

### Names that usually hold secrets

The check judges each part of a path by its name, without regard to letter case on every system.

| Kind | Names |
|---|---|
| Exact | `.env`, `.envrc`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.my.cnf`, `.git-credentials`, `.htpasswd`, `.dev.vars`, `.vault-token`, `.s3cfg`, `.terraformrc`, `credentials`, `credentials.json`, `kubeconfig`, `secrets.toml`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `id_ecdsa_sk`, `id_ed25519_sk` |
| Folders (exact) | `.ssh`, `.aws`, `.gnupg`, `.kube`, `.azure` |
| Starts with `.env.` | Secret-looking, unless the name ends with `.example`, `.sample`, `.template` or `.dist` |
| Ends with | `.env` (as in `prod.env`), `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`, `.kubeconfig`, `.tfstate`, `.tfstate.backup`, `.tfvars`, `.tfvars.json` |

`.env.example` and its siblings are not secret-looking, also with a part in between (`.env.local.example`). Public key files such as `id_rsa.pub` are not either. Names such as `credentials.md` and `mykubeconfig.txt` are not. The list is fixed and has no switch.

### The warning at start

The name check does not look below a folder that you pass. So `ksproxy start` lists the names at the top of each local folder. It logs one `WARN` line for each local target, not one for each name. The line names up to three of the names that look secret and are not an entry of `protect`, then `and N more`:

```text
14:02:11 loc  infra      WARN     holds .env, server.pem: list them in "protect" to also refuse commands given the whole folder
```

A folder that cannot be listed gives no line.

### To open one file

Write the path into a rule as it is: `cat .env.production` allows exactly that command. This is your own written choice. The same holds for a path in `protect`.

### What the agent sees

`AGENT.md` has one fixed line for every local target: files that usually hold secrets and paths the user protected are refused unless an allowed command names the file exactly. The refusal names the agent's own argument and the kind of refusal. The `protect` list is not shown in refusals or in `list_targets`. `ksproxy check local <name> <command>` prints the same refusals. The log shows `[protected path]` or `[secret file]`.

## The honest limits

- **The check sees arguments, not what a program opens by itself.** A program can still read other files through its own configuration, includes, environment variables (including `HOME`) or a file whose content names another file. Allow only programs you would run on that folder yourself.
- **A flag you write into a rule is your choice**, including one that runs a command or changes directory. Allow only programs and flags you would run on that folder yourself.
- **A recursive program reads everything in the folder.** `grep -r`, `ls -R` and the like, given the folder or a directory, walk all of it; only the argument is checked, not what the program finds below it. A recursive program that follows links (`grep -R`, `ls -L`, `find -L`) also leaves the folder through links inside it.
- **Letter case on macOS.** The folder check treats names that differ only in letter case as the same, as on the default case-insensitive volume; on a case-sensitive volume this can make it refuse a path that is really elsewhere, or treat two different names as one.
- **Hard links inside the folder cannot be detected.** A hard link to a file elsewhere looks like any other file in the folder.
- **A file can change between the check and the program opening it** if something else with local write access is racing it; such a process is already outside this tool's protection.
- **A literal in a rule is exempt**, so a rule such as `curl -d@/etc/hosts *` allows exactly what it says.
- **Some programs execute code they find in the folder or in your home configuration.** `git` runs configured helpers and hooks, `terraform plan` runs external data sources, and `make`, `npm` and similar run scripts. Allowing such a program lets whatever is in the folder run as you.
- **A rule that lets the agent write files in the folder, combined with a rule that runs something from the folder, lets the agent run its own code.** For example `tee ...` plus `./run.sh`, or a `git` rule plus a writable `.git/hooks`.
- **A program that detaches from its process group (`setsid`) survives the timeout kill.** The timeout stops the program and its children in the same group, not one that left it.
- **A secret-looking name below a folder you pass is not seen.** `grep -r x apps` reads `apps/api/.env` when it exists. Only a `protect` entry gets the "contains" check. List such files in `protect`.
- **A program that reads files without being told the name is not stopped.** `git diff`, `git log -p` and `git grep` print a tracked secret without it appearing as an argument.
- **A secret under an ordinary name is not known.** A `notes.txt` with a password in it is refused only when you list it in `protect`.
- **A word that looks like a secret name is refused even when it is not a path.** A search term such as `grep id_rsa src` is refused as `secret file`. Write the command into a rule if you need it.
- **The built-in list is a guess at common names**, not a guarantee.
- **Output is not scrubbed.** A secret that a program prints reaches the agent.
- **Hard links cannot be detected**, also for `protect` entries.
- **ssh and Kubernetes targets are not covered.** A server has no folder here; only the rules decide.
- **An agent that can edit the session files can remove `protect` there**, as it can widen `allow`.
- **Protected locations are those recorded by `ksproxy start`**, not whatever the agent host's environment says: ksproxy's own state and configuration folders and every kubeconfig of the inventory. If you later move one of these, start a new session.

`"any"` is refused for local targets on purpose; list the commands.
