#!/usr/bin/env bash
# Publish the version in package.json to npm and push it to GitHub.
#
#   scripts/release.sh             run every check, show what will be published, ask, then publish and push
#   scripts/release.sh --dry-run   run every check and show the package contents; change nothing
#
# Order matters: npm first, then the push. The pushed tag starts the release
# workflow, which sees the version is already on npm, skips its own publish and
# creates the GitHub release.
#
# Nothing here stores or prints a credential. npm asks for your one-time code
# itself, and git uses whatever access you already have to the remote.
#
# REMOTE=<name> picks a remote other than origin.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

REMOTE=${REMOTE:-origin}
BRANCH=main
DRY=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY=1 ;;
  *) echo "usage: scripts/release.sh [--dry-run]" >&2; exit 2 ;;
esac

die() { echo "release: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

for tool in git node npm; do
  command -v "$tool" >/dev/null || die "$tool not found"
done

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
REPO_URL=$(node -p "(require('./package.json').repository || {}).url || ''")
TAG="v$VERSION"

step "Checking the repository"
[ "$(node -p "require('./package.json').private === true")" = "false" ] || die "package.json is marked private"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "not on $BRANCH"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted or untracked changes"
REMOTE_URL=$(git remote get-url "$REMOTE" 2>/dev/null) \
  || die "no remote named $REMOTE. Add it first, for example: git remote add $REMOTE git@github.com:ksproxy/cli.git"
SLUG=$(printf '%s' "$REPO_URL" | sed -E 's#^git\+##; s#\.git$##; s#^.*github\.com[:/]##')
[ -n "$SLUG" ] || die "package.json has no repository.url"
case "$REMOTE_URL" in
  *"$SLUG"|*"$SLUG.git") ;;
  *) die "remote $REMOTE is $REMOTE_URL, but package.json says the repository is $SLUG" ;;
esac
grep -q "^## \[$VERSION\]" CHANGELOG.md || die "CHANGELOG.md has no entry for $VERSION"

if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  git fetch --quiet "$REMOTE" "$BRANCH"
  git merge-base --is-ancestor "$REMOTE/$BRANCH" HEAD \
    || die "$REMOTE/$BRANCH has commits this checkout does not have; pull or rebase first"
else
  echo "$REMOTE has no $BRANCH branch yet: this will be the first push"
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  [ "$(git rev-list -n1 "$TAG")" = "$(git rev-parse HEAD)" ] \
    || die "tag $TAG already exists and does not point at this commit"
  TAG_EXISTS=1
else
  TAG_EXISTS=0
fi
echo "$NAME $VERSION, tag $TAG, remote $REMOTE ($REMOTE_URL)"

step "Checking npm"
if npm view "$NAME@$VERSION" version >/dev/null 2>&1; then
  PUBLISHED=1
  echo "$NAME@$VERSION is already on npm: the publish step will be skipped"
else
  PUBLISHED=0
  if NPM_USER=$(npm whoami 2>/dev/null); then
    echo "logged in to npm as $NPM_USER"
  elif [ "$DRY" = 1 ]; then
    echo "not logged in to npm (run: npm login) — ignored in a dry run"
  else
    die "not logged in to npm. Run: npm login"
  fi
fi

step "Running the tests"
npm test >/dev/null 2>&1 || die "npm test failed; run it to see why"
echo "tests pass"

step "Package contents"
npm pack --dry-run --json 2>/dev/null > "${TMPDIR:-/tmp}/ksproxy-pack.$$.json" \
  || die "npm pack --dry-run failed"
node -e '
  const pack = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0];
  const files = pack.files.map((f) => f.path).sort();
  for (const f of files) console.log("  " + f);
  console.log(`${files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed, ${(pack.unpackedSize / 1024).toFixed(1)} kB unpacked`);
  const allowed = /^(bin\/|src\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/;
  const extra = files.filter((f) => !allowed.test(f));
  if (extra.length > 0) {
    console.error("release: unexpected files in the package: " + extra.join(", "));
    process.exit(1);
  }
' "${TMPDIR:-/tmp}/ksproxy-pack.$$.json" || { rm -f "${TMPDIR:-/tmp}/ksproxy-pack.$$.json"; exit 1; }
rm -f "${TMPDIR:-/tmp}/ksproxy-pack.$$.json"

if [ "$DRY" = 1 ]; then
  step "Dry run: nothing was published, tagged or pushed"
  exit 0
fi

step "Confirm"
if [ "$PUBLISHED" = 1 ]; then
  echo "This will tag $TAG and push $BRANCH to $REMOTE_URL."
else
  echo "This will publish $NAME@$VERSION to npm for everyone, then tag $TAG and push $BRANCH to $REMOTE_URL."
  echo "A published version cannot be replaced, only deprecated."
fi
printf 'Type the version (%s) to continue: ' "$VERSION"
read -r answer
[ "$answer" = "$VERSION" ] || die "aborted"

if [ "$PUBLISHED" = 0 ]; then
  step "Publishing to npm"
  npm publish --access public
fi

step "Tagging and pushing"
[ "$TAG_EXISTS" = 1 ] || git tag -a "$TAG" -m "$TAG"
git push "$REMOTE" "$BRANCH" --follow-tags

step "Done"
echo "npm:     https://www.npmjs.com/package/$NAME/v/$VERSION"
echo "GitHub:  https://github.com/$SLUG/releases/tag/$TAG"
echo "The release workflow creates the GitHub release; the pages workflow publishes the homepage."
