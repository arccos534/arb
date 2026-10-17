import { io } from 'socket.io-client';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { limitlessBooks } from '../dist/books.js';
import { quoteBuy } from '../dist/engine.js';

const durationMs = Number(process.env.COMPARE_DURATION_MS ?? 30000);
const state = await (await fetch('http://127.0.0.1:4317/api/state?source=live')).json();
const candidates = state.candidates.filter(p => /Bitcoin|Ethereum/i.test(p.title) && Date.parse(p.endsAt) > Date.now() + 60000 && Date.parse(p.endsAt) < Date.now() + 3600000)
  .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
const markets = [];
for (const candidate of candidates) {
  const pair = await (await fetch('http://127.0.0.1:4317/api/pair?id=' + encodeURIComponent(candidate.id))).json();
  if (!markets.some(m => m.slug === pair.limitless.slug)) markets.push(pair.limitless);
  if (markets.length === 3) break;
}
if (!markets.length) throw new Error('No current BTC/ETH counterpart markets available');
const history = new Map(markets.map(m => [m.slug, []]));
const summary = { startedAt: new Date().toISOString(), markets: markets.map(m => ({ slug: m.slug, title: m.title })),
  frames: 0, parseErrors: [], sequenceRegressions: 0, requests: [], comparisons: [], examples: [] };
const canonical = books => JSON.stringify(books.map(b => [b.outcome, b.asks, b.bids]));
const top = books => books.map(b => ({ outcome: b.outcome, ask: b.asks[0] ?? null, bid: b.bids[0] ?? null }));
const socket = io('wss://ws.limitless.exchange/markets', { transports: ['websocket'], reconnection: false, timeout: 10000 });
socket.on('connect', () => socket.emit('subscribe_market_prices', { marketSlugs: markets.map(m => m.slug) }));
socket.on('connect_error', e => summary.parseErrors.push(String(e)));
socket.on('orderbookUpdate', raw => {
  const market = markets.find(m => m.slug === raw.marketSlug); if (!market) return;
  try {
    const at = Date.now(), books = limitlessBooks(raw.orderbook, market, 'websocket', at, raw.timestamp);
    const list = history.get(market.slug), version = Number(raw.version);
    if (list.length && version < list.at(-1).version) summary.sequenceRegressions++;
    list.push({ at, version, sourceTimestamp: raw.timestamp, books, signature: canonical(books) });
    if (list.length > 1500) list.shift(); summary.frames++;
  } catch (error) { summary.parseErrors.push(String(error)); }
});
try {
  const initialDeadline = Date.now() + 15000;
  while (!markets.every(m => history.get(m.slug).length) && Date.now() < initialDeadline) await delay(50);
  if (!markets.every(m => history.get(m.slug).length)) throw new Error('Missing initial WS snapshots');
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    const batch = await Promise.all(markets.map(async market => {
      const start = Date.now();
      try {
        const response = await fetch('https://api.limitless.exchange/markets/' + encodeURIComponent(market.slug) + '/orderbook', { signal: AbortSignal.timeout(5000) });
        const raw = await response.json(), end = Date.now();
        summary.requests.push({ slug: market.slug, start, end, status: response.status,
          keys: Object.keys(raw), version: raw.version ?? null, timestamp: raw.timestamp ?? null,
          age: response.headers.get('age'), cache: response.headers.get('cf-cache-status'), date: response.headers.get('date') });
        if (!response.ok) return null;
        const books = limitlessBooks(raw, market, 'rest', end, raw.timestamp);
        return { market, start, end, books, signature: canonical(books) };
      } catch (error) { summary.requests.push({ slug: market.slug, start, error: String(error) }); return null; }
    }));
    // Include WS frames immediately after the response, to allow different
    // transport delivery order. Comparisons never assume atomic observation.
    await delay(500);
    for (const item of batch.filter(Boolean)) {
      const frames = history.get(item.market.slug);
      const before = frames.filter(f => f.at <= item.start).at(-1);
      const during = frames.filter(f => f.at >= item.start && f.at <= item.end + 500);
      const bracket = [...(before ? [before] : []), ...during];
      const matching = bracket.find(f => f.signature === item.signature);
      const latest = frames.filter(f => f.at <= item.end).at(-1);
      const comparison = { slug: item.market.slug, start: item.start, rttMs: item.end - item.start,
        exactMatchInBracket: Boolean(matching), matchingWsVersion: matching?.version ?? null,
        matchReceiveOffsetMs: matching ? matching.at - item.end : null,
        latestWsAgeAtResponseMs: latest ? item.end - latest.at : null,
        sameBestPrices: latest ? JSON.stringify(top(latest.books)) === JSON.stringify(top(item.books)) : null };
      summary.comparisons.push(comparison);
      if (!matching && summary.examples.length < 8) summary.examples.push({ ...comparison, rest: top(item.books), ws: latest ? top(latest.books) : null,
        wsVersion: latest?.version, wsSourceTimestamp: latest?.sourceTimestamp });
    }
    await delay(1500);
  }
} finally {
  socket.disconnect();
  summary.finishedAt = new Date().toISOString();
  const valid = summary.comparisons;
  const rtts = valid.map(c => c.rttMs).sort((a, b) => a - b);
  summary.result = { markets: markets.length, frames: summary.frames, comparisons: valid.length,
    exactMatchesInBracket: valid.filter(c => c.exactMatchInBracket).length,
    sameLatestBestPrices: valid.filter(c => c.sameBestPrices).length,
    medianRttMs: rtts[Math.floor(rtts.length / 2)] ?? null, parseErrors: summary.parseErrors.length,
    sequenceRegressions: summary.sequenceRegressions };
  await writeFile('data/analysis/limitless-ws-rest-comparison.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary.result, examples: summary.examples.slice(0, 3), requestMetadata: summary.requests[0] }, null, 2));
}
