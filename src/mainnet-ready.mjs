/**
 * mainnet-ready.mjs
 * Read-only readiness checker for the Pulsarc indexer.
 * Node 22 ESM, no dependencies, only fetch.
 *
 * Pure exports: checkFile, checkFreshness, checkWalletMeta, summarize
 * CLI entry guarded by import.meta.url check.
 */

import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL =
  'https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/data/mainnet';

const DEFAULT_WALLETS_BASE_URL =
  'https://raw.githubusercontent.com/MertoCrypto/pulsarc-indexer/wallets-mainnet';

/** Files that must exist and parse as JSON. */
const DATA_FILES = [
  'latest.json',
  'supply.json',
  'balances.json',
  'agents.json',
  'agents-activity.json',
  'apps-latest.json',
  'anomalies.json',
  'digest-latest.json',
  'state.json',
];

/** Files that get a tight 30-minute freshness window (FAIL if stale). */
const TIGHT_FILES = new Set(['latest.json', 'state.json']);

/** Loose freshness window for all other files: 3 hours (WARN if stale). */
const LOOSE_WINDOW_MS = 3 * 60 * 60 * 1000;
const TIGHT_WINDOW_MS = 30 * 60 * 1000;

/** Day-0 epoch for the wallet index "through" counter (2026-01-01 UTC). */
const DAY0_MS = Date.UTC(2026, 0, 1); // Jan 1 2026

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/** @typedef {'PASS'|'WARN'|'FAIL'} Status */

/**
 * @param {Status} status
 * @param {string} label
 * @param {string} detail
 * @returns {{ status: Status, label: string, detail: string }}
 */
function result(status, label, detail) {
  return { status, label, detail };
}

// ---------------------------------------------------------------------------
// Pure check functions
// ---------------------------------------------------------------------------

/**
 * Check that a URL returns HTTP 200 and parseable JSON.
 *
 * @param {string} url          Full URL to fetch.
 * @param {string} label        Display name for the check.
 * @param {typeof fetch} fetchFn Injectable fetch implementation.
 * @returns {Promise<{ status: Status, label: string, detail: string, body: unknown }>}
 */
export async function checkFile(url, label, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(url);
  } catch (err) {
    return { ...result('FAIL', label, `network error: ${err.message}`), body: null };
  }

  if (res.status === 404) {
    return { ...result('FAIL', label, 'HTTP 404 – file missing'), body: null };
  }
  if (!res.ok) {
    return { ...result('FAIL', label, `HTTP ${res.status}`), body: null };
  }

  let body;
  try {
    body = await res.json();
  } catch {
    return { ...result('FAIL', label, 'response is not valid JSON'), body: null };
  }

  return { ...result('PASS', label, 'HTTP 200, valid JSON'), body };
}

/**
 * Check freshness of a parsed JSON body.
 * Looks for `generatedAt` first, then `updatedAt`.
 *
 * @param {unknown}  body          Parsed JSON object.
 * @param {string}   label         Display name for the check.
 * @param {boolean}  tight         true → 30-min FAIL window; false → 3-h WARN window.
 * @param {number}   [nowMs]       Override for Date.now() in tests.
 * @returns {{ status: Status, label: string, detail: string }}
 */
export function checkFreshness(body, label, tight, nowMs = Date.now()) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return result('WARN', `${label} freshness`, 'body is not an object – cannot check timestamp');
  }

  const raw = body.generatedAt ?? body.updatedAt;
  if (raw === undefined || raw === null) {
    return result('WARN', `${label} freshness`, 'no generatedAt/updatedAt field');
  }

  const ts = typeof raw === 'number' ? raw : Date.parse(raw);
  if (!Number.isFinite(ts)) {
    return result('WARN', `${label} freshness`, `unparseable timestamp: ${JSON.stringify(raw)}`);
  }

  const ageMs = nowMs - ts;
  const windowMs = tight ? TIGHT_WINDOW_MS : LOOSE_WINDOW_MS;

  if (ageMs < 0) {
    return result('WARN', `${label} freshness`, `timestamp is in the future (${new Date(ts).toISOString()})`);
  }

  const ageMins = Math.round(ageMs / 60_000);
  const ageStr = ageMins < 120 ? `${ageMins} min` : `${Math.round(ageMins / 60)} h`;

  if (tight && ageMs > windowMs) {
    return result(
      'FAIL',
      `${label} freshness`,
      `stale by ${ageStr} (limit 30 min)`,
    );
  }
  if (!tight && ageMs > windowMs) {
    return result(
      'WARN',
      `${label} freshness`,
      `stale by ${ageStr} (limit 3 h)`,
    );
  }

  return result('PASS', `${label} freshness`, `age: ${ageStr}`);
}

/**
 * Check the wallet index meta.json and optional dist.json.
 *
 * @param {string}        walletsBase  Base URL for wallets branch.
 * @param {typeof fetch}  fetchFn      Injectable fetch.
 * @param {number}        [nowMs]      Override for Date.now() in tests.
 * @returns {Promise<Array<{ status: Status, label: string, detail: string }>>}
 */
export async function checkWalletMeta(
  walletsBase = DEFAULT_WALLETS_BASE_URL,
  fetchFn = fetch,
  nowMs = Date.now(),
) {
  const results = [];

  // --- meta.json ---
  const metaUrl = `${walletsBase}/meta.json`;
  let metaRes;
  try {
    metaRes = await fetchFn(metaUrl);
  } catch (err) {
    results.push(result('FAIL', 'wallet meta.json', `network error: ${err.message}`));
    return results;
  }

  if (!metaRes.ok) {
    results.push(result('FAIL', 'wallet meta.json', `HTTP ${metaRes.status} – file missing`));
    return results;
  }

  let meta;
  try {
    meta = await metaRes.json();
  } catch {
    results.push(result('FAIL', 'wallet meta.json', 'not valid JSON'));
    return results;
  }

  const { since, through, gaps, walletCount } = meta;

  // Format the "through" field as a human-readable date offset from day-0
  const throughDay = typeof through === 'number' ? through : NaN;
  const throughMs = Number.isFinite(throughDay)
    ? DAY0_MS + throughDay * 24 * 60 * 60 * 1000
    : NaN;
  const throughDate = Number.isFinite(throughMs)
    ? new Date(throughMs).toISOString().slice(0, 10)
    : String(through);

  const detail =
    `since=${JSON.stringify(since)}, through=${throughDay} (${throughDate}), ` +
    `gaps=${JSON.stringify(gaps)}, walletCount=${walletCount}`;

  const gapsNonEmpty = Array.isArray(gaps) && gaps.length > 0;

  // "through" more than 2 days behind today
  const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
  const throughStale = Number.isFinite(throughMs) && nowMs - throughMs > twoDaysMs;

  if (gapsNonEmpty || throughStale) {
    const reasons = [];
    if (gapsNonEmpty) reasons.push(`gaps not empty: ${JSON.stringify(gaps)}`);
    if (throughStale) reasons.push(`through (${throughDate}) is >2 days behind today`);
    results.push(result('WARN', 'wallet meta.json', `${detail} | ${reasons.join('; ')}`));
  } else {
    results.push(result('PASS', 'wallet meta.json', detail));
  }

  // --- dist.json (optional) ---
  const distUrl = `${walletsBase}/dist.json`;
  let distRes;
  try {
    distRes = await fetchFn(distUrl);
  } catch (err) {
    results.push(result('WARN', 'wallet dist.json', `network error: ${err.message}`));
    return results;
  }

  if (distRes.status === 404) {
    results.push(result('WARN', 'wallet dist.json', 'HTTP 404 – file not yet published (optional)'));
  } else if (!distRes.ok) {
    results.push(result('WARN', 'wallet dist.json', `HTTP ${distRes.status}`));
  } else {
    results.push(result('PASS', 'wallet dist.json', `HTTP ${distRes.status}`));
  }

  return results;
}

/**
 * Derive the final verdict from an array of check results.
 *
 * @param {Array<{ status: Status }>} checks
 * @returns {{ verdict: 'PASS'|'WARN'|'FAIL', exitCode: 0|1 }}
 */
export function summarize(checks) {
  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const verdict = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';
  return { verdict, exitCode: hasFail ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// Formatting helpers (CLI only)
// ---------------------------------------------------------------------------

const COLORS = {
  PASS: '\x1b[32m', // green
  WARN: '\x1b[33m', // yellow
  FAIL: '\x1b[31m', // red
  RESET: '\x1b[0m',
};

function colorize(status, text) {
  return `${COLORS[status] ?? ''}${text}${COLORS.RESET}`;
}

function printResult({ status, label, detail }) {
  console.log(`${colorize(status, `[${status}]`)} ${label}: ${detail}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const allResults = [];

  console.log('Pulsarc Indexer – Mainnet Readiness Check');
  console.log('==========================================\n');

  // --- Check 1 + 2: data files ---
  console.log('Data files:');
  for (const filename of DATA_FILES) {
    const url = `${DEFAULT_BASE_URL}/${filename}`;
    const fileResult = await checkFile(url, filename);
    printResult(fileResult);
    allResults.push(fileResult);

    if (fileResult.body !== null) {
      const tight = TIGHT_FILES.has(filename);
      const freshResult = checkFreshness(fileResult.body, filename, tight);
      printResult(freshResult);
      allResults.push(freshResult);
    }
  }

  console.log('\nWallet index:');
  // --- Check 3 + 4: wallet index ---
  const walletResults = await checkWalletMeta(DEFAULT_WALLETS_BASE_URL, fetch, Date.now());
  for (const r of walletResults) {
    printResult(r);
    allResults.push(r);
  }

  // --- Verdict ---
  const { verdict, exitCode } = summarize(allResults);
  console.log(`\n${colorize(verdict, `Verdict: ${verdict}`)}`);
  process.exit(exitCode);
}
