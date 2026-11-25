# Local targets: the exact rules

The README has the short version. This page is the full reference: every check, limit and refusal message.

A `local` target lets the agent run allowlisted commands on this machine, in the folder named by `cwd`, through the `local_exec` tool. It is the riskiest kind: the command runs as you, on the machine that holds your keys. Every call goes through these steps, in this order, and the first one that fails refuses the call:

1. **Plain words only.** The command is tokenised exactly as for ssh: at most 4096 bytes, split on spaces and tabs, every character one of `A-Z a-z 0-9 _ @ % + = : , . / -`, and the first token may not start with `-`. No quotes, `~`, `$`, pipes, redirects or other shell syntax can get through. The program is started directly with an argument list; no shell is ever involved.
2. **A wildcard matches plain names and paths only, never a flag.** Both `*` and `...` match arguments that are a plain name or relative path: letters, digits and `_ . / -`, not starting with `-` (`a.txt`, `sub/b.txt`, `main..dev`, `20`, `.`). Everything else is refused with `not a plain argument`: every flag (`-l`, `--oneline`, `--since=2.days`, `-C`, `--upload-pack=sh`), an absolute path, `@`, `%`, `+`, `:`, `,` or `=` inside a positional, `--`, `-`, a `file:` URL. A flag is how a program is told to do something else (`git -C sub` changes the folder that later arguments resolve against; `--upload-pack=sh` names a program to run), so every flag the agent may use must be written literally into the rule: `ls -l ...`, `git log --oneline -n * ...`. A literal token is your own choice and is not checked (a rule such as `curl -d@/etc/hosts *` allows exactly what it says).
3. **Every plain value is checked.** The plain argument may not contain a `..` segment. Empty and `.` segments are dropped first (`a/./b` and `a//b` mean `a/b`; a trailing slash disappears, so `link/` is judged as `link`, not as a missing path under it; `.` and `./` name the folder itself). A plain argument longer than 512 bytes is refused (`argument too long`) before anything is joined. The result is joined to the real path of `cwd` (a folder is at most 400 bytes, see below), so the path the checks examine is never longer than the path the program opens; a joined path above 1000 bytes is refused with the same message as a backstop. The joined path is resolved so that links are followed in the order the system follows them (an existing path by its real path; a missing one by its nearest existing parent). A path that cannot be resolved is refused as `unresolvable link` (a dangling link, a loop or too many links), and one that cannot be examined is refused as `cannot be examined` (a name too long for the system, a folder you may not search). Only "does not exist" and "a file is in the way" let the check look at the nearest existing parent instead. A path that goes through a symbolic link into `/proc`, `/dev` or `/sys` is refused (`system link`), because such a link can resolve differently in ksproxy and in the command it starts. Neither the path nor its real path may be, contain or lie inside a protected location (`ksproxy files`): the ksproxy state folder, its configuration folder (each as recorded by `ksproxy start`, as written and by real path, letter case ignored on macOS and Windows) or any kubeconfig or Kafka client file named in any of your inventory files (the default `inventory.json` and every project file). The real path must also be inside the real path of `cwd`; there is no switch that allows paths outside it. To let the agent read one file outside the folder, write it literally into a rule (`cat /etc/hosts`), which allows exactly that command. On macOS a real path is compared without a leading `/System/Volumes/Data` component, so both spellings of one file are the same file. When several rules match loosely, the refusal the agent sees is the most informative one, not `not a plain argument` when another reason exists. Two more checks come last, after the folder check:
   - **Protected path.** For each `protect` entry, taken as `<real cwd>/<entry>` and by its real path: the argument (as resolved, or by real path) may not be that path, lie inside it or contain it. Refusal: `the argument <value> is, lies inside or contains a path this target protects` (short `protected path`).
   - **Secret-looking name.** No part of the argument as written, and no part of its real path relative to the real `cwd`, may be a name that usually holds secrets. Refusal: `the argument <value> names a file or folder that usually holds secrets` (short `secret file`).
4. **The program names itself.** The first token is the program. Every allow rule of a local target must start with a literal program name (never `*` or `...`), so the program is always chosen by you and is exempt from the path checks: `venv/bin/python`, a link to a system interpreter, keeps working.
5. **The allowlist.** The tokens must match one of the target's rules, as described under "Allowlist rules", in order. The first rule that matches and whose wildcard arguments pass the checks above allows the call; if a rule matches but its wildcard arguments are refused, the next rule is tried, and when none allows it the most useful refusal is reported (a specific reason rather than `not a plain argument`). `"any"` is refused here too, in case a session file was edited. A call that no rule allows and whose program is in the target's `programs` list is checked as described in "Listed programs inside chosen paths".

Folders that cannot be a local target: when `start` opens the target (and in `ksproxy check local`, and again on every call, against the protected locations recorded by `start`) the real path of `cwd` must not be the filesystem root, your home directory or a parent of it (`folder is too broad: pick a project folder, not <cwd>`), nor equal, contain or lie inside ksproxy's state folder or configuration folder (`folder overlaps ksproxy's own files`), nor contain any kubeconfig or Kafka client file named in any of your inventory files, the default and every project file (`folder contains a kubeconfig named in the inventory`), it must be resolvable and may not go through a link into `/proc`, `/dev` or `/sys` (`folder cannot be resolved`), and its real path may be at most 400 bytes (`folder path is too long`). Such a target is `SKIPPED`, with those messages, or with `folder not found` or `not a directory`. The other inventory files are read as JSON without being checked; when one of them cannot be read or is not valid JSON, the files it names are not known, so every local target is `SKIPPED` with `cannot read <file> to protect the files it names`, before any of the checks above. The agent is not told which of them applies, only that the folder is not acceptable and that you can run `ksproxy check local <name>`, or `ksproxy check --project NAME local <name>` for a target of a project; that command, like `start`, shows you the detailed message. `ksproxy check local` applies the same checks and the same protected kubeconfigs as a live session.

The program runs with `cwd` as its working folder and with only the minimal environment (`PATH`, `HOME`, `LANG`, `LC_ALL` and `TMPDIR`). Its `PATH` is built from the `PATH` that `ksproxy start` had, keeping only the absolute entries that are not inside the folder of any local target of the session: relative and empty entries (which would resolve against the folder), and entries that lie in a local target's folder or that a link leads into one, are dropped; if nothing is left it is `/usr/bin:/bin`. So a file named `git` in the folder is never the `git` that runs, but a rule that names a program with a slash (`./run.sh`, `venv/bin/python`) runs exactly that file. No `KSPROXY_*` variable and nothing else from your environment reaches the program. The folder and the state folder are replaced in the output by `<folder>` and `<ksproxy>`, as configured, as resolved and as the system spells it, and on macOS and Windows whatever the letter case; a path is replaced only where no letter, digit, `_`, `.` or `-` follows it (a folder `/work/app` is not replaced inside `/work/apple` or `/work/app.log`); a path is replaced whole even where the output limit (256 KiB, or the `maxOutputKiB` of the target) cuts the text. `list_targets` never shows `cwd`. If the folder disappears the health check logs `DOWN` with `folder is gone`, and `UP` with `folder is back` when it returns.

## Listed programs inside chosen paths

A `programs` list lets the agent run the programs you name, with any flags and arguments, as long as every path the command names stays inside the `paths` you chose. You name programs, not command patterns. This is "trust the agent with these programs inside these paths": a program can do more than its arguments say, and the agent can write a file and have a program read it as instructions. The checks below limit what a command names, not what a program does.

```json
{
  "name": "docs",
  "cwd": "~/projects/shop",
  "programs": ["cat", "grep", "sed", "ls", "head", "wc"],
  "allow": ["git status", "git diff ..."],
  "paths": ["docs", "README.md", "assets/*.png"],
  "protect": ["docs/private"]
}
```

### The inventory rules

| Field | Rule |
|---|---|
| `programs` | Local targets only. A list of 1 to 50 bare program names: letters, digits and `_ . + -`, not starting with `-`, and no `/`. No name may be listed twice. It needs `paths`. |
| `paths` | Local targets only. A list of 1 to 50 entries. Needed with `programs`; allowed without it (see below). |
| each `paths` entry | A string of 1 to 512 bytes without control characters. Relative to `cwd`: no leading `/` or `~`, no `..` part. Cleaned like a `protect` entry. A part may use `*` (any characters inside one folder or file name, names that start with a dot included) and `**` (any number of folders, as a whole part only). `.` means the whole folder. |
| `review` | Allowed with `programs`. See "Review" below. |
| `allow` | As before. `"allow": "any"` is still an error for a local target, and so is every rule that starts with `*` or `...`, `* ...` included. |

The errors read, with `local "docs"` before each:

| Error | When |
|---|---|
| `programs: must be a list of 1 to 50 program names, for example ["cat", "grep"]` | `programs` is not a list, is empty or has more than 50 entries |
| `programs[N]: must be a bare program name: letters, digits and _ . + -, not starting with "-", and no "/"` | an entry is not such a name, for example `./run.sh` or `/usr/bin/cat` |
| `programs[N]: NAME is listed twice` | a repeat |
| `programs: needs "paths", the files and folders its commands may name` | `programs` without `paths` |
| `allow[N]: a local rule must start with the program name` | a rule that starts with `*` or `...` |

Without `programs`, `paths` limits the wildcard arguments of the listed rules (below). A target with listed rules and no `paths` or `programs` works exactly as before.

### Which checks apply

The rules of `allow` are tried first, in order, as in steps 1 to 5 above. A call that a rule allows is checked exactly as before, and when `paths` is given, every wildcard argument of that rule that is a path must also be inside `paths`. So `git status` is allowed by its own rule even when `git` is not in `programs`.

A call that no rule allows, and whose first word is exactly one of `programs`, goes through these steps. The first failure refuses the call with a short reason in the log:

1. The plain words check of step 1.
2. **The program** is the first word, written exactly as listed (`CAT` is not `cat`). It is found on the clean `PATH` described above, so a file in the folder never replaces it. A program given as a path (`./run.sh`, `/usr/bin/cat`) is never taken from `programs`, because a name in the list holds no `/`.
3. **No option of the program may be on the refused list** below.
4. **Every argument that is a path** passes the checks of step 3 (no `..`, the length limits, resolving, no system link, not ksproxy's files, inside the real `cwd`, not `protect`ed, not a secret-looking name), is a plain relative path (letters, digits and `_ . / -`, not starting with `/` or `-`), and then is inside `paths`.

A call whose program is in `programs` and that these steps refuse is never sent to the reviewer. A call that no rule allows and whose program is not in `programs` is refused as before, and the reason also names the programs: `not on the allowlist for this target. Allowed: git status; git diff ...; the program wc is not one of its programs: cat, grep, sed, ls, head`.

No program is refused for being listed: you chose it. When a listed program can act as you, ksproxy warns (see "What the owner and the agent are told").

### When a path is inside `paths`

A path is inside when it, or one of the folders above it up to `cwd`, matches an entry. `docs` covers everything under `docs`; `docs/*` covers everything under each entry of `docs`, `docs/.cache` included; `**/*.md` covers the Markdown files at any depth and what is under them. The match is made on the path relative to the real `cwd`, after the resolving of step 3 (links followed, the result inside `cwd`), without regard to letter case on macOS and Windows.

### Which arguments are paths

- Each positional argument, the value after `=` of a long flag (`--output=out/x`), and every tail of a short flag from its third character on (`-oout` gives `out`, `ut` and `t`). After `--` every word is checked whole and also as a flag would be, because `--` can be the value of the flag before it: `sort -T -- -onotes` takes `--` as its folder for temporary files and writes `notes`.
- Such a word is a path when it contains `/`, or when the whole word or any part of it after `=`, `:`, `@`, `,`, `+` or `%` starts with `.` or names an existing entry of `cwd`. So `prod+creds` is a path when an entry of that name exists, although neither `prod` nor `creds` does, and it is then refused as not a plain path.
- Every other word (a search word, a number, a name that does not exist yet) is free.

So give a path as its own word: `-o out/x` is checked as one path, while `-oout/x` is checked with every tail, and a tail that is outside `paths` refuses the call.

### Options that are always refused

These options are refused for a listed program, whatever you list. This list is a best effort, like the list of programs that can act as you: a program can have other options that run code or reach outside the paths, and ksproxy does not know every program. A long option is refused under any shortened form (`--to-com=x`), because GNU programs accept any start of a long option, with its value after `=` or as the next word. An exact option of the same program that only shares a start with a refused one is not refused: `tar --checkpoint=1`, `tar --file=docs/a.tar`, `sort --check` and `install --strip` work. A refused short letter is refused anywhere in a group of short flags (`-xPf`), also in a value glued to the group (`-fdocs/T.tar`), and for `tar` also in its first argument without a dash (`tar xPf`). `gtar`, `gnutar`, `bsdtar`, `gfind`, `gsed`, `gsort`, `gsplit`, `ginstall` and the like follow the rules of their program.

| Program | Refused |
|---|---|
| `find` | `-exec`, `-execdir`, `-ok`, `-okdir` |
| `tar` | `-I`, `-F`, `-P`, `-C`, `-T`, `--to-command`, `--use-compress-program`, `--checkpoint-action`, `--info-script`, `--new-volume-script`, `--rsh-command`, `--rmt-command`, `--absolute-names`, `--absolute-paths`, `--directory`, `--cd`, `--files-from`, `--insecure`, and every argument that holds `:` |
| `cpio` | `--insecure`, `--rsh-command`, and every argument that holds `:` |
| `pax` | every argument that holds `:` |
| `zip` | `-TT`, `--unzip-command` |
| `unzip` | `-:` |
| `sort` | `--compress-program` |
| `split` | `--filter` |
| `install` | `--strip-program` |
| `sdiff`, `diff3` | `--diff-program` |
| `sed` | a script whose command is `e`, `w`, `W`, `r` or `R`, or an `s` command with the flag `e` or `w`; a script read from a file with `-f` or `--file` |

`tar`, `cpio` and `pax` read an archive name with `:` as a remote archive (`HOST:FILE`) that they reach through another program. ksproxy cannot tell the archive name apart from the other words, so every argument with `:` is refused for these programs. `-P`, `--absolute-names`, `--absolute-paths` and `--insecure` let tar write outside `cwd`, and `--insecure` lets cpio do the same; `sort --compress-program`, `split --filter`, `install --strip-program` and `--diff-program` name a program that the program runs; `-C`, `--directory` and `--cd` change the folder that later names resolve against; `-T` and `--files-from` read names from a file. sed scripts are read both as GNU sed and as BSD sed read their arguments. Write a sed script with another separator than `/` (`s,a,b,`), since a word with `/` is a path.

The refusals read `the option OPTION of PROGRAM can run other code or reach outside the paths, so it is always refused` (short `option refused`), `the argument VALUE holds ":", which PROGRAM can read as a remote archive (HOST:FILE), so it is always refused` (`remote archive`), `the sed script SCRIPT runs a command, or writes or reads a file of its own, so it is always refused` and `a sed script read from a file cannot be checked, so -f and --file are always refused` (`sed script refused`), `the argument VALUE is not a plain relative path: a path is made of letters, digits and _ . / - and does not start with / or -` (`not a plain path`), and `the argument VALUE is outside the paths this target allows: PATHS` (`outside paths`).

### Programs that can act as you

These programs can run other code, reach the network, read other processes or your data, or use your saved logins. Listing one is allowed, but `ksproxy start` and `ksproxy check` print a warning that names each one you listed. A name is compared by its base name in lower case, also without a version at its end (`python3.12`, `node20`, `gawk-5.1`) and without a leading `g`, `gnu` or `bsd` (`gnumake`, `gm4`), except that `gzip` and `gunzip` keep their `g`. Each of these names is also compared by its part before the first `-`, so `docker-buildx` counts as `docker` and `aws-sso` as `aws`.

| Kind | Programs |
|---|---|
| Shells | `sh`, `bash`, `rbash`, `zsh`, `dash`, `ksh`, `mksh`, `fish`, `csh`, `tcsh`, `pwsh`, `busybox`, `toybox` |
| Interpreters | `python`, `perl`, `php`, `lua` and every name that starts with one of them, `node`, `nodejs`, `deno`, `bun`, `ruby`, `irb`, `erb`, `tclsh`, `wish`, `expect`, `osascript`, `awk`, `gawk`, `mawk`, `nawk`, `R`, `Rscript`, `julia`, `java`, `jshell`, `groovy`, `scala`, `kotlin`, `swift`, `dotnet`, `ghci`, `runghc`, `erl`, `elixir`, `iex`, `guile`, `racket`, `sbcl`, `m4`, `dc`, `sqlite3`, `duckdb` |
| Programs that run other programs | `env`, `xargs`, `exec`, `command`, `nohup`, `nice`, `timeout`, `time`, `watch`, `stdbuf`, `setsid`, `script`, `parallel`, `flock`, `taskset`, `ionice`, `chrt`, `caffeinate`, `arch`, `sandbox-exec`, `open`, `xdg-open`, `xcrun`, `tmux`, `screen`, `entr`, `ssh-agent`, `crontab`, `at`, `batch`, `launchctl`, `systemctl`, `systemd-run`, `taskpolicy`, `lockf`, `prlimit`, `shortcuts`, `automator` |
| Privileges | `sudo`, `doas`, `su`, `pkexec`, `chroot`, `unshare`, `nsenter`, `runuser`, `setpriv`, `capsh`, `sg`, `newgrp`, `fakeroot` |
| Network clients | `curl`, `wget`, `nc`, `ncat`, `netcat`, `socat`, `ssh`, `scp`, `sftp`, `rsync`, `ftp`, `lftp`, `telnet`, `openssl`, `http`, `xh`, `aria2c`, `rclone`, `dig`, `nslookup`, `host`, `mail`, `mailx`, `sendmail`, `mutt`, `psql`, `mysql`, `mongosh`, `redis-cli`, `pg_dump`, `pg_dumpall`, `mysqldump` |
| Editors and pagers | `vi`, `vim`, `nvim`, `view`, `ex`, `ed`, `nano`, `pico`, `emacs`, `mg`, `micro`, `code`, `less`, `more`, `most`, `man` |
| Debuggers | `lldb`, `gdb`, `strace`, `ltrace`, `dtrace`, `dtruss`, `valgrind`, `perf` |
| Build tools and compilers | `make`, `cmake`, `ninja`, `bazel`, `meson`, `scons`, `gradle`, `mvn`, `ant`, `rake`, `cargo`, `go`, `cc`, `gcc`, `g++`, `c++`, `clang`, `clang++`, `javac`, `xcodebuild` |
| Package managers | `npm`, `npx`, `yarn`, `pnpm`, `corepack`, `pip` and every name that starts with it, `uv`, `uvx`, `poetry`, `conda`, `mamba`, `gem`, `bundle`, `bundler`, `composer`, `rustup`, `brew`, `port`, `apt`, `apt-get`, `dpkg`, `yum`, `dnf`, `rpm`, `apk`, `pacman`, `nix`, `nix-env`, `nix-shell`, `snap`, `flatpak`, `asdf`, `mise` |
| Document tools, which run filters or commands, or read any file | `pandoc`, `latexmk`, `tex`, `latex`, `pdftex`, `pdflatex`, `xetex`, `xelatex`, `luatex`, `lualatex`, `groff`, `troff`, `nroff` |
| Archive programs: an unpacked member can have an absolute name, or be a link that points anywhere, which a program that follows links then reads | `tar`, `unzip`, `zip`, `cpio`, `pax`, `ditto` |
| Other processes, your data and saved logins | `ps`, `pgrep`, `pkill`, `kill`, `killall`, `lsof`, `top`, `htop`, `security`, `defaults`, `pbpaste`, `pbcopy`, `log`, `dscl`, `gpg`, `ssh-add`, `op`, `vault`, `pass`, `gh`, `glab`, `aws`, `gcloud`, `gsutil`, `az`, `doctl`, `heroku`, `flyctl`, `vercel`, `terraform`, `pulumi`, `ansible`, `helm`, `kubectl`, `docker`, `podman`, `nerdctl`, `minikube`, `git`, `svn`, `hg`, `ksproxy`, `ssh-keygen`, `oc`, `k9s`, `stern`, `kubectx`, `kubens`, `argocd`, `flux`, `istioctl`, `docker-compose`, `aws-vault`, `sops`, `bw`, `tofu`, `terragrunt`, `ansible-playbook`, `mdfind`, `screencapture` |

The list is a best effort. A program that is not on it can still act as you in ways ksproxy does not know.

### Review

`review` may be used with `programs`. A call that no rule allows and whose program is not in `programs` goes to the reviewer as before, after the fixed checks of a reviewed command. On a target with `paths`, those fixed checks also refuse every path of the reviewed command that is outside `paths`, by the test of "Which arguments are paths" for the plain arguments and for the tail of a simple flag that names an existing entry. The model cannot approve such a path. A call of a listed program that a check refuses is never reviewed.

### What the owner and the agent are told

When the target opens, `ksproxy start` logs a `WARN` line after its `UP` line that names the programs and the paths in full:

```text
14:02:11 loc  docs       WARN     programs cat, grep, sed may run with any arguments inside docs, README.md, assets/*.png
```

When a listed program can act as you, `ksproxy start` also logs a `WARN` line before the `OPENING` line, and `ksproxy check` prints it as `WARNING: local "docs": ...`:

```text
14:02:11 loc  docs       WARN     programs that can act as you: python3, ps; the agent can use them with your whole account
```

`AGENT.md` and the tool notes tell the agent the listed programs, that they take any flags, that every path must be inside the `paths` shown, to give a path as its own word (a value glued to a short flag is checked whole), the options that are always refused, and that the other checks apply as before. `ksproxy check local NAME COMMAND` explains a refusal as it does for every local target, and prints `ALLOWED by rule: programs: cat` for a call that a listed program allows. The log shows the same rule.

### Limits of this mode

- A listed program runs with your environment's `HOME`, like every local command. A program that reads saved logins (the table above) can use them.
- Words that are not paths by the test above are free. A program can still create or read a file named by such a word in `cwd`: `touch notes` creates `cwd/notes` when `notes` does not exist yet. A flag value given as its own word that starts with `-` (`sort -o -notes`) is taken as a flag and is not checked.
- Archive members are not checked. An archive unpacked inside `paths` can hold names that land elsewhere inside `cwd`, and `cpio` and `pax` can also unpack a member with an absolute name where it says, anywhere you can write. An unpacked archive can also hold links that point anywhere, so a program that follows links (`grep -R`, `cp -RL`, `zip -r`) can then read any file of yours through them. This is why `tar`, `unzip`, `zip`, `cpio`, `pax` and `ditto` are in the table above. Leave them out of `programs` if that matters.
- A recursive command reads everything below a path inside `paths`, and a command with no path argument works on the whole folder (`grep -r word`).
- Output is not scrubbed beyond the folder replacement described above.
- There is no sandbox. ksproxy does not follow what a program opens by itself. Paths outside `cwd`, any program (`* ...`), and `"allow": "any"` are not supported.

## Protected paths and secret-looking names

The two checks at the end of step 3 run on every argument that a wildcard matches, on every plain argument of a command sent to the model reviewer, and on every path of a listed program. No rule and no model answer can override them. Only a path written literally into a rule is exempt.

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

`"any"` is refused for local targets on purpose; list the commands, or list programs with `programs` and `paths`. The limits of that mode are in "Listed programs inside chosen paths".
