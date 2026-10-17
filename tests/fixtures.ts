import type { Book, Market, Pair } from '../src/domain.js';

export const now = Date.parse('2026-10-16T12:00:00Z');
export function market(venue: Market['venue'] = 'polymarket'): Market {
  return {
    venue, id: '123', slug: venue === 'polymarket' ? 'btc-test' : 'btc-other', title: 'BTC above 95000?',
    description: 'Uses source X at time Y; equal counts as YES.', resolutionSource: 'source-X',
    endsAt: new Date(now + 3600000).toISOString(), yesToken: `${venue}-yes`, noToken: `${venue}-no`,
    positiveLabel: 'YES', negativeLabel: 'NO', rulesHash: 'a'.repeat(64), externalSlug: null,
    fee: { kind: 'none' }, raw: {},
  };
}
export function pair(approved = true): Pair {
  return { id: 'pair-1', polymarket: market(), limitless: market('limitless'), score: 1, reasons: [], review: { approved, reasons: approved ? [] : ['manual-rules-review-required'] } };
}
export function book(venue: Book['venue'] = 'polymarket', outcome: Book['outcome'] = 'yes', price = '0.4'): Book {
  const m = market(venue);
  return {
    venue, slug: m.slug, outcome, assetId: outcome === 'yes' ? m.yesToken : m.noToken,
    asks: [{ price, shares: '100' }], bids: [{ price: '0.1', shares: '100' }],
    receivedAt: now, sourceTimestamp: now, transport: 'rest', tickSize: '0.01', minOrderShares: '5',
  };
}
