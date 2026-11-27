# Releasing ksproxy

**Contents**

- [One-time setup](#one-time-setup)
- [First release (by hand)](#first-release-by-hand)
- [Later releases](#later-releases)
- [Pinned actions](#pinned-actions)
- [Why the workflows look the way they do](#why-the-workflows-look-the-way-they-do)
  - [All workflows](#all-workflows)
  - [ci.yml](#ciyml)
  - [release.yml](#releaseyml)
  - [pages.yml](#pagesyml)
  - [e2e.yml](#e2eyml)

## One-time setup

1. Create the GitHub repository `ksproxy/cli` and push `main`.
2. In the repository settings, open **Pages** and set the source to **GitHub Actions**. The `pages` workflow then publishes `site/` to https://ksproxy.github.io/cli/.
3. Publish the first version by hand (next section).
4. After the package exists on npm, open the package settings for `@ksproxy/cli` and add a **Trusted Publisher**: provider GitHub Actions, owner `ksproxy`, repository `cli`, workflow file `release.yml`. No environment name.

## First release (by hand)

From a clean checkout of `main` with `package.json` at the version to publish and a matching CHANGELOG entry, once the remote is added (`git remote add origin git@github.com:ksproxy/cli.git`) and you are logged in to npm (`npm login`):

```
scripts/release.sh --dry-run
scripts/release.sh
```

The dry run performs every check and prints the package contents without changing anything. The real run repeats the checks, asks you to type the version, then publishes to npm, creates the tag if it does not exist, and pushes `main` with the tag. It refuses to continue when the working tree is not clean, the branch is not `main`, the remote does not match `repository.url`, the CHANGELOG has no entry, the checkout is behind the remote, the tests fail, or the package would contain anything other than `bin/`, `src/`, the README, the licence and the changelog. If the version is already on npm it skips publishing and only tags and pushes, so it is safe to run again after a failed push.

What it does, by hand:

```
npm test
npm pack --dry-run
npm publish --access public
git tag -a v0.1.0 -m "v0.1.0"
git push origin main --follow-tags
```

The tag is pushed together with `main`, so the `release` workflow also starts for `v0.1.0`. It asks npm whether that version is already published; because you just published it by hand, it skips its own publish step and only creates the GitHub release. The same check makes re-running the workflow for an existing tag harmless.

## Later releases

1. Bump `version` in `package.json`.
2. Add a CHANGELOG entry for the version and update the link at the bottom.
3. Commit and push to `main`.
4. Tag and push the tag:

   ```
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

The `release` workflow then runs the tests, checks that the tag equals `v` plus the version in `package.json`, publishes to npm with provenance through Trusted Publishing (no token is stored in the repository), and creates the GitHub release with generated notes.

## Pinned actions

Every `uses:` in the workflows is pinned to a full commit SHA. Look the tag up again and update both the workflow files and this table when bumping.

| Action | Tag | Commit SHA |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/configure-pages` | v6.0.0 | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` |
| `actions/upload-pages-artifact` | v5.0.0 | `fc324d3547104276b827a68afc52ff2a11cc49c9` |
| `actions/deploy-pages` | v5.0.1 | `368f82528645a54fb793d4d04e342629a3f51346` |

Resolved from the public GitHub API on 2026-11-20 (latest release of each action; all tags pointed directly at commits).

## Why the workflows look the way they do

The workflow files carry no comments; the reasoning is here.

### All workflows

- Top-level `permissions: contents: read`. The default token is read-only; a job widens it only for what it needs.
- No `pull_request_target`. Nothing here needs to run with write access on code from a fork.
- `persist-credentials: false` on checkout, so the token is not left in the git config of the runner.
- Actions are pinned to commit SHAs because tags can be moved.
- Event data such as the tag name is never interpolated into a `run:` script. It is passed through `env:` and read as a shell variable, which prevents script injection.

### ci.yml

- Triggers on push to `main` and on pull requests. Pull requests from forks run with a read-only token. A change that touches only `site/**` does not start it; the `pages` workflow covers the homepage.
- It is kept small on purpose, to cost as few Actions minutes as possible: one job on `ubuntu-latest`. Minutes are rounded up per job, and a macOS runner counts ten times in a private repository, so there is no matrix and no macOS job.
- It runs on Node 24, the minimum in `package.json`, with the coverage gate (`npm test`, which fails below 100% lines, branches and functions).
- `npm run test:plain` runs the same tests without the gate. Use it on a newer Node version, because coverage accounting differs slightly between versions and a counting difference should not fail a correct build.
- macOS is not tested on GitHub. It is tested on your own machine: `scripts/release.sh` runs `npm test` before every publish, and two tests exist only for macOS.
- The concurrency group is per workflow and ref and cancels superseded runs.
- There is no install step because the package has no dependencies.

### release.yml

- Triggers only on tags matching `v*`.
- The job holds `contents: write` (to create the GitHub release) and `id-token: write` (so npm can exchange the workflow's OIDC identity for a short-lived publish credential; this is what Trusted Publishing and provenance need).
- Trusted Publishing needs a recent npm, so the job installs `npm@latest` before publishing.
- The tag must equal `v` plus the `package.json` version, so a mistyped tag cannot publish the wrong version.
- Tests run before publishing. `npm publish --provenance --access public` attaches a provenance statement linking the package to this workflow run.
- `gh release create` uses `GH_TOKEN` from `github.token`, with `--verify-tag` and generated notes.

### pages.yml

- Triggers on push to `main` that touches `site/**` or the workflow itself, and by hand with `workflow_dispatch`.
- Permissions are `pages: write` and `id-token: write` (both required by `deploy-pages`) plus `contents: read`.
- The concurrency group `pages` does not cancel a deployment in progress, so a half-finished deploy is never interrupted.
- The `github-pages` environment carries the deployed URL, shown on the workflow run.

### e2e.yml

- Starts by hand only (`workflow_dispatch`): a run builds Docker images and downloads packages, which costs more Actions minutes than `ci.yml`.
- One job on `ubuntu-latest`, which has Docker with the compose plugin: it checks out and runs `scripts/e2e.sh`. Node runs inside the containers, so there is no `setup-node` step.
- When the run fails, a last step prints the logs that `scripts/e2e.sh` saved in `e2e/logs/`. Every secret in them was made for that run only.
- Those logs hold output of third-party code (the MCP server from npm, PostgreSQL), so workflow commands are paused with `::stop-commands::` and a random token while they are printed: a line in a log cannot set an output, a mask or a file.
