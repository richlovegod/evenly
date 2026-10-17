#!/usr/bin/env bash
# Retired 2026-10-17. The web app is no longer published to GitHub Pages: the Worker serves it
# together with the API on one origin (scripts/deploy.sh), so the sign-in can live in a cookie.
#
# Leave the gh-pages branch exactly as it is. Its CNAME file keeps the Pages custom domain set,
# which is what makes GitHub answer https://richlovegod.github.io/evenly/<path> with a 301 to
# https://split.ginochang.com/<path> (old links and Home Screen icons keep working). A new push
# without that file would drop the redirect and leave a stale app on github.io.
echo "scripts/deploy-web.sh is retired: GitHub Pages no longer hosts the app." >&2
echo "Deploy with: npm run deploy:staging  or  npm run deploy  (scripts/deploy.sh)." >&2
echo "Do not push to gh-pages: its CNAME file keeps the github.io redirect to split.ginochang.com." >&2
exit 1
