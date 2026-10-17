import { profiler } from './profiling.js';
import { Decimal } from 'decimal.js';
import type { Book, Level, Market, Outcome } from './domain.js';
import { array, record } from './http.js';

function levels(value: unknown, rawUnits: boolean, invert = false): Level[] {
  return array(value).map(v => {
    const row = record(v);
    const price = new Decimal(String(row.price));
    const shares = new Decimal(String(row.size)).div(rawUnits ? 1000000 : 1);
    if (!price.isFinite() || !shares.isFinite() || price.lte(0) || price.gte(1) || shares.lt(0)) throw new Error('Invalid order-book level');
    if (rawUnits && !new Decimal(String(row.size)).isInteger()) throw new Error('Non-integer raw size');
    return { price: (invert ? new Decimal(1).minus(price) : price).toString(), shares: shares.toString() };
  }).filter(v => new Decimal(v.shares).gt(0));
}

function sort(values: Level[], asc: boolean): Level[] {
  return values.sort((a, b) => new Decimal(a.price).comparedTo(b.price) * (asc ? 1 : -1));
}

export function timestamp(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value) ? Date.parse(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function polyBook(value: unknown, market: Market, outcome: Outcome, transport: Book['transport'] = 'rest', now = Date.now()): Book {
  const raw = record(value);
  const expectedId = outcome === 'yes' ? market.yesToken : market.noToken;
  if (String(raw.asset_id) !== expectedId) throw new Error('Polymarket book asset mismatch');
  const tick = raw.tick_size === undefined ? null : String(raw.tick_size);
  const minimum = raw.min_order_size === undefined ? null : String(raw.min_order_size);
  if (tick !== null && (!new Decimal(tick).isFinite() || new Decimal(tick).lte(0))) throw new Error('Invalid tick');
  if (minimum !== null && (!new Decimal(minimum).isFinite() || new Decimal(minimum).lt(0))) throw new Error('Invalid minimum');
  return {
    venue: 'polymarket', slug: market.slug, outcome, assetId: expectedId,
    asks: sort(levels(raw.asks, false), true), bids: sort(levels(raw.bids, false), false),
    receivedAt: now, sourceTimestamp: timestamp(raw.timestamp), transport, tickSize: tick, minOrderShares: minimum,
  };
}

export function limitlessBooks(value: unknown, market: Market, transport: Book['transport'] = 'rest', now = Date.now(), sourceTime: unknown = null): Book[] {
  const raw = record(value);
  if (raw.tokenId !== undefined && String(raw.tokenId) !== market.yesToken) throw new Error('Limitless book asset mismatch');
  const base = { venue: 'limitless' as const, slug: market.slug, receivedAt: now, sourceTimestamp: timestamp(sourceTime), transport, tickSize: null, minOrderShares: null };
  // minSize is the LP rewards threshold, NOT the minimum executable order size.
  return [
    { ...base, outcome: 'yes', assetId: market.yesToken, asks: sort(levels(raw.asks, true), true), bids: sort(levels(raw.bids, true), false) },
    { ...base, outcome: 'no', assetId: market.noToken, asks: sort(levels(raw.bids, true, true), true), bids: sort(levels(raw.asks, true, true), false) },
  ];
}

export function bookKey(venue: string, slug: string, outcome: string): string {
  return `${venue}:${slug}:${outcome}`;
}

export class BookCache {
  private readonly books = new Map<string, Book>();
  constructor(private readonly onUpdate?: (book: Book) => void, private readonly onInvalidate?: (key: string) => void) {}
  set(book: Book): void {
    const profileStart = profiler.start();
    try {
    const key = bookKey(book.venue, book.slug, book.outcome);
    const previous = this.books.get(key);
    if (previous && previous.receivedAt > book.receivedAt) return;
    if (previous?.sourceTimestamp && book.sourceTimestamp && previous.sourceTimestamp > book.sourceTimestamp) return;
    this.books.set(key, book);
    this.onUpdate?.(book);
    } finally { profiler.end('book-update', profileStart); }
  }
  get(venue: string, slug: string, outcome: string): Book | undefined { return this.books.get(bookKey(venue, slug, outcome)); }
  delete(venue: string, slug: string, outcome: string): void { this.remove(bookKey(venue, slug, outcome)); }
  private remove(key: string): void { if (this.books.delete(key)) this.onInvalidate?.(key); }
  clearVenue(venue: string): void {
    for (const [key, book] of this.books) if (book.venue === venue) this.remove(key);
  }
  clearMarkets(venue: string, slugs: string[]): void {
    for (const slug of slugs) for (const outcome of ['yes', 'no']) this.delete(venue, slug, outcome);
  }
  retainMarkets(markets: Market[]): void {
    const allowed = new Map(markets.flatMap(m => [
      [bookKey(m.venue, m.slug, 'yes'), m.yesToken] as const, [bookKey(m.venue, m.slug, 'no'), m.noToken] as const,
    ]));
    for (const [key, book] of this.books) if (allowed.get(key) !== book.assetId) this.remove(key);
  }
  clear(): void { for (const key of this.books.keys()) this.remove(key); }
}
