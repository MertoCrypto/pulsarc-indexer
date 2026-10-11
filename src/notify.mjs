// Telegram alerts and an RSS feed for the anomalies Pulsarc already computes.
//
// planNotifications(anomalies, prev, opts) is pure: it decides which anomaly items are new,
// builds the message text and returns the next state. The caller sends and writes files.
// State (data/<net>/notified.json): { sent: ['<hour>:<app>:<kind>'], feed: [{ id, title, link, date }] }.

export const CFG = {
  maxPerRun: 3,     // never more than this many messages for one hour
  keepSent: 200,    // dedupe memory
  keepFeed: 50,     // RSS items
  site: 'https://pulsarc.vercel.app',
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const num = (n) => Number(n).toLocaleString('en-US')

export function describe(item, network) {
  const net = network === 'mainnet' ? 'Arc' : 'Arc Testnet'
  if (item.kind === 'spike') {
    return `${item.app} on ${net}: ${item.ratio}x its usual activity. ${num(item.txs)} transactions in the last hour, the 24h median is ${num(item.baseline)}.`
  }
  const pct = Math.round((1 - item.ratio) * 100)
  return `${item.app} on ${net}: down ${pct}% from its usual activity. ${num(item.txs)} transactions in the last hour, the 24h median is ${num(item.baseline)}.`
}

export function planNotifications(anomalies, prev = {}, opts = {}) {
  const cfg = { ...CFG, ...opts }
  const sent = Array.isArray(prev.sent) ? prev.sent : []
  const feed = Array.isArray(prev.feed) ? prev.feed : []
  const out = { messages: [], state: { sent, feed } }
  if (!anomalies || anomalies.status !== 'ok' || !anomalies.hour || !Array.isArray(anomalies.items)) return out

  const seen = new Set(sent)
  const fresh = []
  for (const item of anomalies.items) {
    if (!/^[a-z0-9-]{1,40}$/.test(item.app ?? '')) continue // app ids come from our own list; anything else is dropped
    const id = `${anomalies.hour}:${item.app}:${item.kind}`
    if (seen.has(id)) continue
    fresh.push({ id, item })
    if (fresh.length >= cfg.maxPerRun) break
  }
  if (!fresh.length) return out

  const network = anomalies.network === 'testnet' ? 'testnet' : 'mainnet'
  const date = new Date(Date.parse(`${anomalies.hour}:00:00Z`) + 3_600_000).toISOString()
  const entries = fresh.map(({ id, item }) => {
    const link = `${cfg.site}/dapp/${item.app}`
    return { id, title: describe(item, network), link, date }
  })
  out.messages = entries.map((e) => `${e.title}\n${e.link}`)
  out.state = {
    sent: [...sent, ...entries.map((e) => e.id)].slice(-cfg.keepSent),
    feed: [...entries.reverse(), ...feed].slice(0, cfg.keepFeed),
  }
  return out
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
