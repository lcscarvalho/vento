#!/bin/sh
# Stamps a new build version on every CSS/JS reference (index.html and the
# ES module imports), so browsers never mix cached files from an older deploy
# with new ones. Run before every commit that changes css/ or js/.
set -e
cd "$(dirname "$0")/.."
V=$(date -u +%Y%m%d%H%M)
for f in index.html js/*.js; do
  sed -i.bak -E "s/\?v=[0-9a-z]+/?v=$V/g" "$f" && rm -f "$f.bak"
done
echo "build $V"
