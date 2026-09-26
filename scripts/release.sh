#!/bin/sh
# Build a stable release and publish it to GitHub Releases, where the app looks for updates.
# Bump app.version in electrobun.config.ts (and package.json) first.
set -eu
cd "$(dirname "$0")/.."

version=$(sed -n 's/^ *version: "\([^"]*\)".*/\1/p' electrobun.config.ts | head -1)
tag="v$version"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first." >&2
  exit 1
fi
git fetch --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]; then
  echo "Push (or pull) first: HEAD differs from its upstream." >&2
  exit 1
fi
if gh release view "$tag" >/dev/null 2>&1; then
  echo "Release $tag already exists. Bump app.version in electrobun.config.ts." >&2
  exit 1
fi

sh scripts/go.sh test ./...
# The build diffs against the release currently at release.baseUrl to make a patch,
# so it has to run before the new release is published.
rm -rf artifacts
hutch run build

gh release create "$tag" artifacts/* --target "$(git rev-parse HEAD)" --title "$tag" --generate-notes
echo "Published $tag"
