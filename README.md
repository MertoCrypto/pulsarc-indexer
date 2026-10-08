# pulsarc-indexer

A small, free indexer for [Pulsarc](https://github.com/MertoCrypto/pulsarc). It reads Arc blocks from the public RPC every few minutes and keeps hourly aggregates — transactions, failures, fees, distinct wallets and the busiest contracts — for Arc Mainnet and Testnet.

Only aggregates are stored. Raw transactions are not kept; use [ArcScan](https://explorer.testnet.arc.io) for those.

## How it works

1. A scheduled GitHub Action restores the previous snapshot from the `data` branch.
2. `src/run.mjs` resumes from the saved block cursor and reads receipts for every new block, within a time budget. A fresh run backfills the last 24 hours and catches up over the following runs.
3. `src/summarize.mjs` builds `latest.json` (1h / 24h / 7d windows, top contracts, hourly series).
4. `scripts/publish.sh` publishes `data/` back to the `data` branch as a single commit, so the repository does not grow.

## Reading the data

```
https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/data/mainnet/latest.json
https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/data/testnet/latest.json
```

`walletHours` is the sum of distinct wallets per hour in a window. It is an upper bound on distinct wallets, not an exact count.

## Run it yourself

```bash
NET=mainnet BACKFILL_HOURS=1 BUDGET_SECONDS=60 node src/run.mjs
NET=mainnet node src/summarize.mjs
```

Requires Node 20+. No dependencies.

## Notes

- Data is about 5–10 minutes behind the chain.
- GitHub pauses scheduled workflows after 60 days without repository activity.

## License

MIT
