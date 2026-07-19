#!/bin/sh
# Rebuild soundbird and publish it. Safe to run repeatedly.
#   ./deploy.sh "what changed"
set -e
cd "$(dirname "$0")"
python3 src/build.py dist/sound-bird.html >/dev/null
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
else
  git commit -q -m "${1:-Update soundbird}"
fi
git push -q origin main
echo "pushed. live in a minute at https://riavi04.github.io/soundbird/"
