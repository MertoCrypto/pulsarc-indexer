/**
 * test/mainnet-ready.test.mjs
 * Unit tests for mainnet-ready.mjs using Node's built-in test runner.
 * No network access – all fetch calls are replaced with a fake.
 *
 * Run with:  node --test test/mainnet-ready.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Resolve the module under test relative to this file.
import { checkFile, checkFreshness, checkWalletMeta, summarize } from '../src/mainnet-ready.mjs';

// ---------------------------------------------------------------------------
// Fake fetch factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Response-like object.
 *
 * @param {number} status
 * @param {unknown} body  If null, .json() rejects.
 */
function makeResponse(status, body = null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (body === null) throw new Error('not JSON');
      return body;
    },
  };
}

/**
 * Fake fetch that maps URLs to responses.
 *
 * @param {Record<string, { status: number, body?: unknown }>} map
 * @returns {(url: string) => Promise<Response>}
 */
function fakeFetch(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) {
      // Default: 404 for unknown URLs
      return makeResponse(404, null);
    }
    return makeResponse(entry.status, entry.body ?? null);
  };
}

// ---------------------------------------------------------------------------
// Constants mirrored from the module (so tests do not import private state)
// ---------------------------------------------------------------------------
const BASE = 'https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/data/mainnet';
const WALLETS_BASE = 'https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/wallets-mainnet';

const NOW_MS = Date.UTC(2026, 9, 12); // 2026-10-12 (matches turn context "current date")

// ---------------------------------------------------------------------------
// checkFile
// ---------------------------------------------------------------------------

describe('checkFile', () => {
  it('returns FAIL when HTTP 404', async () => {
    const ff = fakeFetch({});               // unknown URL → 404
    const r = await checkFile(`${BASE}/latest.json`, 'latest.json', ff);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /404/);
    assert.equal(r.body, null);
  });

  it('returns FAIL on non-200 non-404 status', async () => {
    const ff = fakeFetch({ [`${BASE}/latest.json`]: { status: 500, body: null } });
    const r = await checkFile(`${BASE}/latest.json`, 'latest.json', ff);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /500/);
  });

  it('returns FAIL when body is not valid JSON', async () => {
    const ff = fakeFetch({ [`${BASE}/latest.json`]: { status: 200, body: null } }); // body:null → json() rejects
    const r = await checkFile(`${BASE}/latest.json`, 'latest.json', ff);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /not valid JSON/i);
  });

  it('returns PASS and the parsed body on HTTP 200 + valid JSON', async () => {
    const payload = { generatedAt: NOW_MS - 60_000 };
    const ff = fakeFetch({ [`${BASE}/latest.json`]: { status: 200, body: payload } });
    const r = await checkFile(`${BASE}/latest.json`, 'latest.json', ff);
    assert.equal(r.status, 'PASS');
    assert.deepEqual(r.body, payload);
  });

  it('returns FAIL on network error (fetch throws)', async () => {
    const ff = async () => { throw new Error('DNS failure'); };
    const r = await checkFile(`${BASE}/latest.json`, 'latest.json', ff);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /network error/i);
  });
});

// ---------------------------------------------------------------------------
// checkFreshness
// ---------------------------------------------------------------------------

describe('checkFreshness', () => {
  it('returns FAIL for stale latest.json (tight, >30 min)', () => {
    const staleTs = NOW_MS - 31 * 60_000; // 31 minutes ago
    const body = { generatedAt: staleTs };
    const r = checkFreshness(body, 'latest.json', /*tight=*/true, NOW_MS);
    assert.equal(r.status, 'FAIL');
    assert.match(r.detail, /stale/i);
  });

  it('returns PASS for fresh latest.json (tight, <30 min)', () => {
    const freshTs = NOW_MS - 5 * 60_000; // 5 minutes ago
    const body = { generatedAt: freshTs };
    const r = checkFreshness(body, 'latest.json', /*tight=*/true, NOW_MS);
    assert.equal(r.status, 'PASS');
  });

  it('returns WARN (not FAIL) for stale optional file (loose, >3 h)', () => {
    const staleTs = NOW_MS - 4 * 60 * 60_000; // 4 hours ago
    const body = { updatedAt: staleTs };
    const r = checkFreshness(body, 'supply.json', /*tight=*/false, NOW_MS);
    assert.equal(r.status, 'WARN');
    assert.match(r.detail, /stale/i);
  });

  it('returns PASS for a loose file within 3 h', () => {
    const freshTs = NOW_MS - 1 * 60 * 60_000; // 1 hour ago
    const body = { updatedAt: freshTs };
    const r = checkFreshness(body, 'supply.json', /*tight=*/false, NOW_MS);
    assert.equal(r.status, 'PASS');
  });

  it('returns WARN when no timestamp field present', () => {
    const r = checkFreshness({ foo: 'bar' }, 'supply.json', false, NOW_MS);
    assert.equal(r.status, 'WARN');
    assert.match(r.detail, /no generatedAt/i);
  });

  it('returns WARN for unparseable timestamp string', () => {
    const r = checkFreshness({ generatedAt: 'not-a-date' }, 'latest.json', true, NOW_MS);
    assert.equal(r.status, 'WARN');
    assert.match(r.detail, /unparseable/i);
  });

  it('returns WARN when body is null', () => {
    const r = checkFreshness(null, 'latest.json', true, NOW_MS);
    assert.equal(r.status, 'WARN');
    assert.match(r.detail, /not an object/i);
  });

  it('uses updatedAt as fallback when generatedAt is absent', () => {
    const ts = NOW_MS - 10 * 60_000;
    const r = checkFreshness({ updatedAt: ts }, 'apps.json', false, NOW_MS);
    assert.equal(r.status, 'PASS');
  });

  it('prefers generatedAt over updatedAt', () => {
    // generatedAt is stale (FAIL for tight), updatedAt would be fresh
    const staleTs = NOW_MS - 40 * 60_000;
    const freshTs = NOW_MS - 5 * 60_000;
    const r = checkFreshness(
      { generatedAt: staleTs, updatedAt: freshTs },
      'latest.json',
      /*tight=*/true,
      NOW_MS,
    );
    assert.equal(r.status, 'FAIL');
  });
});

// ---------------------------------------------------------------------------
// checkWalletMeta
// ---------------------------------------------------------------------------

// Day-0 = 2026-01-01; day 283 = 2026-10-11; today (2026-10-12) = day 284
const DAY_TODAY = 284; // days since 2026-01-01 on 2026-10-12

describe('checkWalletMeta', () => {
  it('returns FAIL when meta.json is 404', async () => {
    const ff = fakeFetch({});              // no URLs → 404 for everything
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.ok(results.length >= 1);
    assert.equal(results[0].status, 'FAIL');
    assert.match(results[0].detail, /404/);
  });

  it('returns FAIL on network error fetching meta.json', async () => {
    const ff = async () => { throw new Error('timeout'); };
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.equal(results[0].status, 'FAIL');
    assert.match(results[0].detail, /network error/i);
  });

  it('returns PASS for empty gaps and up-to-date through', async () => {
    const meta = { since: 0, through: DAY_TODAY, gaps: [], walletCount: 1000 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 200, body: {} },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.equal(results[0].status, 'PASS');
    assert.match(results[0].detail, /since=0/);
    assert.match(results[0].detail, /walletCount=1000/);
  });

  it('returns WARN when gaps is non-empty', async () => {
    const meta = { since: 0, through: DAY_TODAY, gaps: [10, 11], walletCount: 500 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 404, body: null },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.equal(results[0].status, 'WARN');
    assert.match(results[0].detail, /gaps not empty/i);
  });

  it('returns WARN when through is more than 2 days behind today', async () => {
    const staleThrough = DAY_TODAY - 3; // 3 days behind
    const meta = { since: 0, through: staleThrough, gaps: [], walletCount: 200 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 200, body: {} },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.equal(results[0].status, 'WARN');
    assert.match(results[0].detail, />2 days behind/i);
  });

  it('returns PASS when through is exactly 2 days behind (boundary)', async () => {
    const twoExact = DAY_TODAY - 2; // exactly 2 days → not *more* than 2 days
    const meta = { since: 0, through: twoExact, gaps: [], walletCount: 200 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 200, body: {} },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    assert.equal(results[0].status, 'PASS');
  });

  it('returns WARN for 404 dist.json (optional file)', async () => {
    const meta = { since: 0, through: DAY_TODAY, gaps: [], walletCount: 1 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      // dist.json absent → 404
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    const distResult = results.find((r) => r.label === 'wallet dist.json');
    assert.ok(distResult, 'dist.json result should be present');
    assert.equal(distResult.status, 'WARN');
    assert.match(distResult.detail, /404/i);
  });

  it('returns PASS for dist.json when it exists', async () => {
    const meta = { since: 0, through: DAY_TODAY, gaps: [], walletCount: 1 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 200, body: {} },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    const distResult = results.find((r) => r.label === 'wallet dist.json');
    assert.ok(distResult, 'dist.json result should be present');
    assert.equal(distResult.status, 'PASS');
  });

  it('prints since, through, gaps, walletCount in the detail string', async () => {
    const meta = { since: 5, through: DAY_TODAY, gaps: [7], walletCount: 42 };
    const ff = fakeFetch({
      [`${WALLETS_BASE}/meta.json`]: { status: 200, body: meta },
      [`${WALLETS_BASE}/dist.json`]: { status: 404, body: null },
    });
    const results = await checkWalletMeta(WALLETS_BASE, ff, NOW_MS);
    const detail = results[0].detail;
    assert.match(detail, /since=5/);
    assert.match(detail, /through=/);
    assert.match(detail, /gaps=/);
    assert.match(detail, /walletCount=42/);
  });
});

// ---------------------------------------------------------------------------
// summarize / exit-code logic
// ---------------------------------------------------------------------------

describe('summarize', () => {
  it('returns PASS and exitCode 0 when all checks pass', () => {
    const checks = [
      { status: 'PASS' },
      { status: 'PASS' },
    ];
    const { verdict, exitCode } = summarize(checks);
    assert.equal(verdict, 'PASS');
    assert.equal(exitCode, 0);
  });

  it('returns WARN and exitCode 0 when there are only WARNs (no FAILs)', () => {
    const checks = [
      { status: 'PASS' },
      { status: 'WARN' },
    ];
    const { verdict, exitCode } = summarize(checks);
    assert.equal(verdict, 'WARN');
    assert.equal(exitCode, 0);
  });

  it('returns FAIL and exitCode 1 when any check is FAIL', () => {
    const checks = [
      { status: 'PASS' },
      { status: 'WARN' },
      { status: 'FAIL' },
    ];
    const { verdict, exitCode } = summarize(checks);
    assert.equal(verdict, 'FAIL');
    assert.equal(exitCode, 1);
  });

  it('FAIL beats WARN: exitCode is 1', () => {
    const checks = [{ status: 'FAIL' }, { status: 'WARN' }];
    const { exitCode } = summarize(checks);
    assert.equal(exitCode, 1);
  });

  it('returns PASS and exitCode 0 for an empty check list', () => {
    const { verdict, exitCode } = summarize([]);
    assert.equal(verdict, 'PASS');
    assert.equal(exitCode, 0);
  });
});
