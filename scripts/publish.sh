#!/usr/bin/env bash
# Publishes ./data to the `data` branch as a single commit (history is not kept: the files
# are snapshots, so there is nothing worth versioning and the repo stays small).
set -euo pipefail
cd data
rm -rf .git
git init -q -b data
git config user.name "pulsarc-indexer"
git config user.email "indexer@users.noreply.github.com"
git add -A
git commit -q -m "snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
git push -q --force origin data
