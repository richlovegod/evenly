#!/usr/bin/env bash
# Deploy the Worker, which serves both the web app (dist/, Workers Static Assets) and the API.
#   bash scripts/deploy.sh staging       -> https://evenly-api-staging.richlovegod.workers.dev/
#   bash scripts/deploy.sh production    -> https://split.ginochang.com/ (the custom domain) and
#                                           https://evenly-api.richlovegod.workers.dev/
# Steps: build the app (scripts/build-web.sh), stop if the D1 database has migrations that are not
# applied yet (MIGRATE=1 applies them first), wrangler deploy, then smoke checks against the
# deployed site. Production refuses uncommitted changes unless ALLOW_DIRTY=1.
# SMOKE_URLS="https://a/ https://b/" replaces the sites the smoke checks visit.
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash on Windows would turn paths like /api/health into Windows paths without this.
export MSYS_NO_PATHCONV=1

target="${1:-}"
case "$target" in
  staging)
    db=evenly-db-staging
    envflag=(--env staging)
    sites="${SMOKE_URLS:-https://evenly-api-staging.richlovegod.workers.dev/}"
    ;;
  production)
    db=evenly-db
    envflag=()
    sites="${SMOKE_URLS:-https://split.ginochang.com/ https://evenly-api.richlovegod.workers.dev/}"
    ;;
  *)
    echo "usage: bash scripts/deploy.sh staging|production" >&2
    exit 2
    ;;
esac

fail() {
  echo "deploy: $*" >&2
  exit 1
}

if [ "$target" = production ] && [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY:-}" != 1 ]; then
  fail "uncommitted changes; production ships a commit (commit first, or ALLOW_DIRTY=1)"
fi

# 1. Build. [assets] uploads whatever is in dist/, so it is always rebuilt here.
bash scripts/build-web.sh
commit="$(git rev-parse HEAD)"

# 2. Migrations: the new code may need tables the database does not have yet.
echo "Checking D1 migrations on $db ..."
# D1 answers a transient 7403 ("not authorized") now and then: try a few times.
list=""
for attempt in 1 2 3 4; do
  if list="$(npx wrangler d1 migrations list "$db" --remote ${envflag[@]+"${envflag[@]}"} 2>&1)"; then break; fi
  [ "$attempt" -lt 4 ] || fail "could not list migrations: $list"
  echo "  (D1 did not answer, trying again)"
  sleep 10
done
if grep -q 'No migrations to apply' <<<"$list"; then
  echo "No pending migrations."
elif grep -q 'Migrations to be applied' <<<"$list"; then
  echo "$list"
  [ "${MIGRATE:-}" = 1 ] || fail "$db has pending migrations; run again with MIGRATE=1 to apply them first"
  npx wrangler d1 migrations apply "$db" --remote ${envflag[@]+"${envflag[@]}"}
else
  fail "unexpected answer from wrangler d1 migrations list: $list"
fi

# 3. Deploy the Worker together with dist/.
npx wrangler deploy ${envflag[@]+"${envflag[@]}"}

# 4. Smoke checks on the deployed site. A new version can take a few seconds to reach every
# location, so each check gets a few tries.
fails=0
check() {
  local name="$1"
  shift
  local try
  for try in 1 2 3 4 5; do
    if "$@"; then
      echo "  ok   $name"
      return 0
    fi
    [ "$try" -lt 5 ] && sleep 3
  done
  echo "  FAIL $name"
  fails=$((fails + 1))
}
health_env() { curl -fsS "$1api/health" | grep -q "\"env\":\"$target\""; }
version_commit() { curl -fsS "$1version.json?t=$(date +%s)" | grep -q "\"commit\":\"$commit\""; }
# The status line and headers of an answer (the body is read and dropped). Not curl -o /dev/null:
# with MSYS_NO_PATHCONV=1, curl on Windows cannot open /dev/null.
head_of() { curl -sS -D - -o - "$@" | sed -n '1,/^\r*$/p'; }
# A page load (Sec-Fetch-Mode: navigate) of /api must still reach the Worker, not index.html.
navigate_json() { head_of -H 'Sec-Fetch-Mode: navigate' -H 'Accept: text/html' "$1api/health" | grep -qi '^content-type: application/json'; }
app_page() { curl -fsS "$1" | grep -q 'id="root"'; }
# A file that does not exist is a 404 from the Worker, never index.html (which a missing
# /assets/*.js would otherwise get, with the year-long immutable header).
missing_asset_404() { head_of "${1}assets/missing-$(date +%s).js" | head -n 1 | grep -q ' 404'; }
# The pages the iOS app and the App Store listing link to.
static_page() {
  local h
  h="$(head_of "$1$2")"
  grep -q ' 200' <<<"$(head -n 1 <<<"$h")" && grep -qi '^content-type: text/html' <<<"$h"
}

for site in $sites; do
  site="${site%/}/"
  echo "Smoke checks on $site"
  check "/api/health says $target" health_env "$site"
  check "/version.json is commit ${commit:0:7}" version_commit "$site"
  check "/api/health opened as a page is JSON" navigate_json "$site"
  check "/ is the app" app_page "$site"
  check "a missing /assets/ file is 404" missing_asset_404 "$site"
  check "/privacy/ is a page" static_page "$site" privacy/
  check "/support/ is a page" static_page "$site" support/
done
[ "$fails" -eq 0 ] || fail "$fails smoke check(s) failed"
echo "Deployed $target (commit ${commit:0:7})."
