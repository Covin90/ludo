#!/usr/bin/env bash
# Cut a release: bump both package.json versions, tag, push, and let CI build.
#
# The tag is the trigger AND the contract — .github/workflows/release.yml fails
# the build if the tag disagrees with either package.json, and the in-app
# updater selects releases by the asset names derived from those versions. This
# script does the bump and the checks in one place so a mistake is caught before
# the tag exists, not after (a pushed tag is far more annoying to unwind).
#
# Usage:
#   scripts/release.sh 1.0.0-beta.8      # bump, tag, push
#   scripts/release.sh 1.0.0-beta.8 --dry-run
#   scripts/release.sh --check           # pre-flight only, no changes
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

DECKY_PKG="decky_plugin/package.json"
DESK_PKG="desktop/package.json"
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"

die() { echo "error: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

pkg_version() { node -p "require('./$1').version"; }

# ── Pre-flight ───────────────────────────────────────────────────────────────
# Everything here is cheap and local. It exists because each failure it catches
# would otherwise surface as a red CI run on an already-published tag.
preflight() {
  local strict="${1:-}"

  have node || die "node is required"
  have gh   || die "gh (GitHub CLI) is required"
  gh auth status >/dev/null 2>&1 || die "gh is not authenticated (gh auth login)"

  [ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"

  local branch; branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "$RELEASE_BRANCH" ]; then
    if [ "$strict" = "strict" ]; then
      die "on '$branch', expected '$RELEASE_BRANCH' (set RELEASE_BRANCH= to override)"
    fi
    echo "note: on '$branch', not '$RELEASE_BRANCH'"
  fi

  git fetch --quiet --tags origin
  local local_head remote_head
  local_head="$(git rev-parse HEAD)"
  remote_head="$(git rev-parse "origin/$branch" 2>/dev/null || echo "$local_head")"
  [ "$local_head" = "$remote_head" ] || die "HEAD differs from origin/$branch; push or pull first"

  echo "current: decky=$(pkg_version "$DECKY_PKG") desktop=$(pkg_version "$DESK_PKG")"
}

# Rewrite only the top-level "version" field, leaving the rest of the file
# byte-identical — a full JSON.stringify would reformat and produce a noisy diff.
set_version() {
  local file="$1" version="$2"
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    const out = src.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
    if (out === src) { console.error(`no version field replaced in ${file}`); process.exit(1); }
    fs.writeFileSync(file, out);
  ' "$file" "$version"
}

if [ "${1:-}" = "--check" ]; then
  preflight
  echo "pre-flight OK"
  exit 0
fi

VERSION="${1:-}"
[ -n "$VERSION" ] || die "usage: scripts/release.sh <version> [--dry-run]"
VERSION="${VERSION#v}"
DRY_RUN=""
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

# Semver with an optional pre-release. The updater's _version_key parses this
# shape; anything else compares in ways nobody intends.
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] \
  || die "'$VERSION' is not semver (1.2.3 or 1.2.3-beta.4)"

preflight strict

# The updater offers the semver-highest release that carries the right asset —
# not the newest by date. A version that does not exceed what is already
# published would be published successfully and then be invisible forever.
#
# Ranking uses main.py's own _version_key rather than `sort -V`, which disagrees
# with semver on pre-releases (it ranks 1.0.0-beta.8 above 1.0.0). Borrowing the
# shipping comparator means this check and the updater can never disagree.
if TAGS="$(gh release list --limit 100 --json tagName -q '.[].tagName' 2>/dev/null)" \
   && [ -n "$TAGS" ]; then
  VERSION="$VERSION" TAGS="$TAGS" python3 - <<'PY' || exit 1
import os, sys
sys.path.insert(0, 'decky_plugin')
from main import _version_key

version = os.environ['VERSION']
tags = [t.lstrip('v') for t in os.environ['TAGS'].split() if t.strip()]
highest = max(tags, key=_version_key)
print(f'highest published: {highest}')
if _version_key(version) <= _version_key(highest):
    sys.exit(f'error: {version} does not exceed the published {highest}; '
             'the updater would never offer it')
PY
fi

git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null \
  && die "tag v$VERSION already exists; pick a new version (never re-tag a release)"

case "$VERSION" in
  *-*) echo "channel: beta (prerelease — stable users will not be offered this)" ;;
  *)   echo "channel: stable (offered to every user)" ;;
esac

if [ -n "$DRY_RUN" ]; then
  echo "dry run: would bump to $VERSION, commit, tag v$VERSION, and push"
  exit 0
fi

set_version "$DECKY_PKG" "$VERSION"
set_version "$DESK_PKG"  "$VERSION"

# Re-read rather than trusting the write: CI compares these to the tag, and a
# silent mismatch here becomes a failed build on a tag that already exists.
[ "$(pkg_version "$DECKY_PKG")" = "$VERSION" ] || die "$DECKY_PKG did not take the bump"
[ "$(pkg_version "$DESK_PKG")"  = "$VERSION" ] || die "$DESK_PKG did not take the bump"

git add "$DECKY_PKG" "$DESK_PKG"
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"

# Push the commit first: the tag is what triggers the build, and CI checks out
# the tag, so it must resolve to a commit the remote already has.
git push origin HEAD
git push origin "v$VERSION"

echo
echo "tagged v$VERSION and pushed. CI is building both artifacts."
echo "  watch:  gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
echo "  verify: scripts/verify-release.sh $VERSION"
