// Telegram alerts and an RSS feed for the anomalies Pulsarc already computes.
//
// planNotifications(anomalies, prev, opts) is pure: it decides which anomaly items are new,
// builds the message text and returns the next state. The caller sends and writes files.
// State (data/<net>/notified.json): { sent: ['<hour>:<app>:<kind>'], feed: [{ id, title, link, date }] }.
//
// This module re-exports the backward-compatible API; the real logic lives in alerts.mjs.

export { SITE as CFG_SITE, fmtN } from './alerts.mjs'
import { planAlerts, SITE } from './alerts.mjs'

// Keep CFG for any callers that import it
export const CFG = {
  maxPerRun: 3,
  keepSent: 200,
  keepFeed: 50,
  site: SITE,
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function describe(item, network) {
  const net = network === 'mainnet' ? 'Arc' : 'Arc Testnet'
  if (item.kind === 'spike') {
    const num = (n) => Number(n).toLocaleString('en-US')
    return `${item.app} on ${net}: ${item.ratio}x its usual activity. ${num(item.txs)} transactions in the last hour, the 24h median is ${num(item.baseline)}.`
  }
  const num = (n) => Number(n).toLocaleString('en-US')
  const pct = Math.round((1 - item.ratio) * 100)
  return `${item.app} on ${net}: down ${pct}% from its usual activity. ${num(item.txs)} transactions in the last hour, the 24h median is ${num(item.baseline)}.`
}

/**
 * Backward-compatible wrapper: planNotifications(anomalies, prev, opts)
 * Delegates to planAlerts with only the anomaly kind enabled.
 */
export function planNotifications(anomalies, prev = {}, opts = {}) {
  const result = planAlerts(
    { anomalies, network: anomalies?.network ?? 'mainnet' },
    prev,
    { enabledKinds: new Set(['anomaly']), now: Date.now(), ...opts },
  )
  return { messages: result.messages, state: result.state }
}

export function renderRss(feed, network, opts = {}) {
  const cfg = { ...CFG, ...opts }
  const name = network === 'mainnet' ? 'Arc' : 'Arc Testnet'
  const items = (feed ?? []).map((e) => [
    '<item>',
    `<title>${esc(e.title)}</title>`,
    `<link>${esc(e.link)}</link>`,
    `<guid isPermaLink="false">${esc(e.id)}</guid>`,
    `<pubDate>${new Date(e.date).toUTCString()}</pubDate>`,
    '</item>',
  ].join('')).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>` +
    `<title>Pulsarc: moving now on ${name}</title><link>${cfg.site}</link>` +
    `<description>Apps whose hourly activity moved sharply against their 24h median.</description>${items}</channel></rss>`
}

// Plain text only (no parse_mode), so nothing in a message can be read as markup.
export async function sendTelegram(token, chatId, text, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`)
}
