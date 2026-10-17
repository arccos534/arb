import { BookCache } from '../books.js';
import type { Book, Market, Pair } from '../domain.js';
import type { DemoScenario, FeedSnapshot, Resolution } from './types.js';

export class DemoFeed {
  private scenario: DemoScenario = 'normal';
  private started = 0;
  private pair: Pair | null = null;
  start(scenario: DemoScenario, now = Date.now()): void {
    this.scenario = scenario; this.started = now;
    const build = (venue: Market['venue']): Market => ({
      venue, id: `demo-${now}`, slug: `demo-${venue}-${now}`, title: 'Тестовый BTC · полный цикл',
      description: 'Синтетический контракт для проверки программы. Не является рыночной возможностью. YES означает рост; равенство считается YES. Обе стороны имеют один тестовый источник.',
      resolutionSource: 'synthetic-demo-fixture', endsAt: new Date(now + 12000).toISOString(), yesToken: `${venue}-${now}-yes`, noToken: `${venue}-${now}-no`,
      positiveLabel: 'YES', negativeLabel: 'NO', rulesHash: 'd'.repeat(64), externalSlug: null,
      fee: venue === 'polymarket' ? { kind: 'polymarket', rate: '0.07' } : { kind: 'limitless-curve', model: 'published-table-linear-v1' }, raw: { synthetic: true },
    });
    this.pair = { id: `demo-${now}`, polymarket: build('polymarket'), limitless: build('limitless'), score: 1, reasons: ['synthetic-fixture'], review: { approved: true, reasons: [] } };
    this.pair.limitless.externalSlug = this.pair.polymarket.slug;
  }
  get currentScenario(): DemoScenario { return this.scenario; }
  restore(pair: Pair, started: number, scenario: DemoScenario): void { this.pair = structuredClone(pair); this.started = started; this.scenario = scenario; }
  snapshot(now = Date.now()): FeedSnapshot {
    if (!this.pair) return { at: now, ready: false, pairs: [], books: [] };
    const books: Book[] = [];
    for (const market of [this.pair.polymarket, this.pair.limitless]) for (const outcome of ['yes', 'no'] as const) {
      const ask = market.venue === 'polymarket' ? outcome === 'yes' ? '0.43' : '0.59' : outcome === 'yes' ? '0.60' : '0.48';
      const bid = market.venue === 'polymarket' ? outcome === 'yes' ? '0.41' : '0.57' : outcome === 'yes' ? '0.58' : '0.46';
      books.push({ venue: market.venue, slug: market.slug, outcome, assetId: outcome === 'yes' ? market.yesToken : market.noToken,
        asks: [{ price: ask, shares: '100' }], bids: [{ price: bid, shares: '100' }], receivedAt: now, sourceTimestamp: now, transport: 'rest', tickSize: '0.01', minOrderShares: '1' });
    }
    return { at: now, ready: true, pairs: [this.pair], books };
  }
  resolutions(now = Date.now()): Resolution[] {
    if (!this.pair || now - this.started < (this.scenario === 'delayed' ? 45000 : 16000)) return [];
    return [this.pair.polymarket, this.pair.limitless].map(m => ({ venue: m.venue, slug: m.slug,
      yesPayout: this.scenario === 'mismatch' && m.venue === 'polymarket' ? '0' : '1',
      noPayout: this.scenario === 'mismatch' && m.venue === 'polymarket' ? '1' : '0',
      evidence: { synthetic: true, scenario: this.scenario, settlementDelayMs: now - this.started }, at: now }));
  }
  cache(now = Date.now()): BookCache { const c = new BookCache(); this.snapshot(now).books.forEach(b => c.set(b)); return c; }
}
