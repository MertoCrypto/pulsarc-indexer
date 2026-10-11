#!/usr/bin/env bash
# Daily wallet-index publish. Usage: scripts/publish-wallets.sh <testnet|mainnet>
# Merges every CLOSED UTC day from data/<net>/wallets-pending.json into the shard files and force-pushes
# them as ONE commit to the branch `wallets-<net>` (history is not kept, same idea as scripts/publish.sh).
# It does nothing (and clones nothing) while there is no closed day waiting.
# If the push fails, the pending file is restored so no day is lost; wallets-publish.mjs never merges a
# day twice (meta.json `through`), so a retry is safe.
set -euo pipefail
NET="${1:?usage: publish-wallets.sh <testnet|mainnet>}"
PENDING="data/${NET}/wallets-pending.json"
BRANCH="wallets-${NET}"
EPOCH=1767225600  # 2026-01-01T00:00:00Z, same as EPOCH_S in src/wallets.mjs

[ -f "$PENDING" ] || { echo "wallets: no pending file for ${NET}"; exit 0; }
TODAY=$(( ($(date -u +%s) - EPOCH) / 86400 ))
CLOSED=$(jq --argjson t "$TODAY" '[.days // {} | keys[] | tonumber | select(. < $t)] | length' "$PENDING" 2>/dev/null || echo 0)
if [ "${CLOSED}" -eq 0 ]; then echo "wallets: no closed day to publish for ${NET}"; exit 0; fi

REMOTE="${WALLETS_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
rm -rf wallets-out
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" wallets-out
  rm -rf wallets-out/.git
else
  mkdir -p wallets-out
fi

cp "$PENDING" "${PENDING}.bak"
NET="$NET" node src/wallets-publish.mjs wallets-out

cd wallets-out
git init -q -b "$BRANCH"
git config user.name "pulsarc-indexer"
git config user.email "indexer@users.noreply.github.com"
git add -A
git commit -q -m "wallet index ${NET} through day $(jq -r .through meta.json) ($(date -u +%Y-%m-%dT%H:%MZ))"
git remote add origin "$REMOTE"
if git push -q --force origin "$BRANCH"; then
  cd ..; rm -f "${PENDING}.bak"; echo "wallets: published ${NET}"
else
  cd ..; mv "${PENDING}.bak" "$PENDING"; echo "wallets: push failed, pending restored" >&2; exit 1
fi
