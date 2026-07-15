#!/usr/bin/env bash
# Ship = commit + push. Wire GitHub Actions for CF deploy when ready.
set -euo pipefail
cd "$(dirname "$0")/.."
MSG="${1:-chore: ship xpro-howtomovetheneedle}"

if [ ! -d .git ]; then
  git init
  git branch -M main
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -m "$MSG"
else
  echo "Nothing to commit."
fi

if git remote get-url origin >/dev/null 2>&1; then
  git push -u origin HEAD
  echo "Pushed origin."
else
  echo "No origin yet. Create github.com/drake/X-Pro-Setup and:"
  echo "  git remote add origin git@github.com:drake/X-Pro-Setup.git"
  echo "  git push -u origin main"
fi
