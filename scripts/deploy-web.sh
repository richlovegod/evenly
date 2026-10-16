#!/usr/bin/env bash
# Build the web app and publish it to the gh-pages branch of richlovegod/evenly
# (GitHub Pages serves it at https://richlovegod.github.io/evenly/).
#   bash scripts/deploy-web.sh
# Later, on a custom domain: BASE_PATH=/ bash scripts/deploy-web.sh  (and add a CNAME file).
set -euo pipefail
cd "$(dirname "$0")/.."
# Git Bash on Windows would turn BASE_PATH=/evenly/ into a Windows path without this.
export MSYS_NO_PATHCONV=1

export BASE_PATH="${BASE_PATH:-/evenly/}"
export VITE_API_BASE="${VITE_API_BASE:-https://evenly-api.richlovegod.workers.dev}"
REPO_URL="${REPO_URL:-https://github.com/richlovegod/evenly.git}"

# Build into its own folder so a local preview of dist/ (pointed at staging) is left alone.
OUT="${OUT:-dist-pages}"
npx vite build --outDir "$OUT" --emptyOutDir
touch "$OUT/.nojekyll"
if [ -n "${CNAME:-}" ]; then printf '%s\n' "$CNAME" > "$OUT/CNAME"; fi

WORK="$(mktemp -d)"
cp -r "$OUT"/. "$WORK/"
cd "$WORK"
git init -q -b gh-pages
git config user.name "Gino Chang"
git config user.email "266420019+richlovegod@users.noreply.github.com"
git config core.autocrlf false
git add -A
git commit -q -m "Deploy web app $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q -f "$REPO_URL" gh-pages
echo "Published to gh-pages ($BASE_PATH, API $VITE_API_BASE)"
