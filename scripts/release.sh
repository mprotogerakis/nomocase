#!/bin/sh
# scripts/release.sh 1.0.1: sets the version, commits, tags v1.0.1 and pushes; the tag starts .github/workflows/release.yml
# (the whole suite, then the release that nomo-ops deploys).
set -eu
V=${1:?Version, z. B. 1.0.1}
cd "$(dirname "$0")/.."
git diff --quiet HEAD || { echo "Erst die offenen Änderungen committen" >&2; exit 1; }
npm version "$V" --no-git-tag-version >/dev/null
git commit -qam "Release $V"
git tag "v$V"
git push -q && git push -q origin "v$V"
echo "v$V getaggt: https://github.com/mprotogerakis/nomocase/actions"
