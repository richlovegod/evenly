#!/usr/bin/env bash
# Build the web app for the Worker to serve (Workers Static Assets, wrangler.toml [assets]). The
# app and /api share an origin, so the app calls the API on its own site and the Worker keeps the
# sign-in in an HttpOnly cookie (docs/PLAN-push-scan-cookies.md section 1).
#   bash scripts/build-web.sh
# Writes dist/ (emptied first) plus dist/version.json {commit, dirty, builtAt}. The same build
# runs on staging and production: nothing in it names a host.
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash on Windows would turn BASE_PATH=/ into a Windows path without this.
export MSYS_NO_PATHCONV=1

export BASE_PATH=/
export VITE_API_BASE=same-origin

fail() {
  echo "build-web: $*" >&2
  exit 1
}

npx vite build --outDir dist --emptyOutDir

# privacy/ and support/ are the pages the iPhone app and its App Store listing link to
# (https://split.ginochang.com/privacy/ and /support/), copied from public/ as they are.
for f in index.html sw.js _headers privacy/index.html support/index.html; do
  [ -f "dist/$f" ] || fail "dist/$f is missing"
done
# A same-origin build calls /api on the site that serves it: an API address baked into the code
# would send production data elsewhere (or to staging).
baked="$(grep -l -E 'workers\.dev|127\.0\.0\.1' dist/assets/*.js || true)"
[ -z "$baked" ] || fail "an API address is baked into: $baked"

commit="$(git rev-parse HEAD)"
dirty=false
[ -z "$(git status --porcelain)" ] || dirty=true
node -e 'const [commit, dirty] = process.argv.slice(1); console.log(JSON.stringify({ commit, dirty: dirty === "true", builtAt: new Date().toISOString() }));' "$commit" "$dirty" > dist/version.json
echo "Built dist/ for the Worker (commit ${commit:0:7}$([ "$dirty" = true ] && echo ', uncommitted changes'))"
