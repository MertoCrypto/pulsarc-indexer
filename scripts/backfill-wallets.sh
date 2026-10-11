#!/usr/bin/env bash
# One-off history backfill of the wallet index (log-based "lite" records) up to the block where the live
# wallet index started. Usage: scripts/backfill-wallets.sh <net>      (env: FROM_BLOCK, WALLETS_REMOTE, DATA_DIR)
# - reads startBlock from data/<net>/wallets-pending.json (written by run.mjs when WALLET_INDEX=1 started)
# - resumes from the branch `wallets-<net>` (meta.json `through`), so a rerun after a timeout continues
# - force-pushes ONE commit to `wallets-<net>` at the end AND when the time budget runs out
# - never run it while the daily publish for the same network is enabled (WALLET_PUBLISH_<NET> must be unset)
# Only the complete UTC days before the day of startBlock are covered; the part of that day before
# startBlock is not (run it right after 00:00 UTC to keep that gap to minutes).
set -euo pipefail
NET="${1:?usage: backfill-wallets.sh <testnet|mainnet>}"
BRANCH="wallets-${NET}"
DATA_DIR="${DATA_DIR:-data}"
PENDING="${DATA_DIR}/${NET}/wallets-pending.json"
FROM_BLOCK="${FROM_BLOCK:-0}"
BUDGET_MIN="${BUDGET_MIN:-330}"
REMOTE="${WALLETS_REMOTE:-https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"

[ -f "$PENDING" ] || { echo "backfill: no pending file at $PENDING (wallet index not started)" >&2; exit 1; }
START=$(jq -r '.startBlock // empty' "$PENDING")
[ -n "$START" ] || { echo "backfill: pending file has no startBlock" >&2; exit 1; }
echo "backfill: live index started at block ${START}; scanning blocks ${FROM_BLOCK}..$((START-1))"

rm -rf wallets-out
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  git -c gc.auto=0 -c maintenance.auto=false clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" wallets-out
  rm -rf wallets-out/.git
else
  mkdir -p wallets-out
fi

push() {
  [ -f wallets-out/meta.json ] || { echo "backfill: nothing to push yet"; return 0; }
  ( cd wallets-out
    rm -rf pending .git
    git init -q -b "$BRANCH"
    git config user.name "pulsarc-indexer"; git config user.email "indexer@users.noreply.github.com"; git config gc.auto 0; git config maintenance.auto false
    git add -A
    git commit -q -m "wallet index ${NET} backfill through day $(jq -r .through meta.json)"
    git remote add origin "$REMOTE"
    git push -q --force origin "$BRANCH" )
  echo "backfill: pushed to ${BRANCH} (through day $(jq -r .through wallets-out/meta.json))"
}

set +e
TMO="$(command -v timeout || command -v gtimeout || true)"   # GNU timeout on the runner; optional on a Mac
NET="$NET" ${TMO:+$TMO "${BUDGET_MIN}m"} node src/wallets-backfill.mjs --out wallets-out --from-block "$FROM_BLOCK" --until-block "$START" --no-partial
code=$?
set -e
push
if [ "$code" -eq 124 ]; then echo "backfill: time budget reached, run it again to continue"; exit 0; fi
exit "$code"
