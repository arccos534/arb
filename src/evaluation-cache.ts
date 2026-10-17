import type { Book, Evaluation, Pair } from './domain.js';
import type { BookCache } from './books.js';
import type { Config } from './config.js';
import { evaluate } from './engine.js';

interface Entry { metadata: unknown[]; books: (Book | undefined)[]; at: number; expiresAt: number; result: Evaluation[] }
// Price levels are immutable in the public feed. Both parsers and simulated
// depth consumption replace arrays. Time boundaries invalidate quiet books.
export class EvaluationCache {
  private readonly entries = new Map<string, Entry>();
  evaluate(pair: Pair, cache: BookCache, config: Config, now: number, skipManualReview = false): Evaluation[] {
    const books = [cache.get('polymarket', pair.polymarket.slug, 'yes'), cache.get('polymarket', pair.polymarket.slug, 'no'),
      cache.get('limitless', pair.limitless.slug, 'yes'), cache.get('limitless', pair.limitless.slug, 'no')];
    const metadata = [pair.review.approved, pair.review.validUntil, pair.review.reasons.length, ...pair.review.reasons, pair.limitless.externalSlug,
      ...[pair.polymarket, pair.limitless].flatMap(m => [m.rulesHash, m.endsAt, m.yesToken, m.noToken, m.positiveLabel, m.negativeLabel,
        m.fee.kind, 'rate' in m.fee ? m.fee.rate : undefined, 'model' in m.fee ? m.fee.model : undefined, 'reason' in m.fee ? m.fee.reason : undefined]),
      skipManualReview, config.TARGET_NET_SHARES, config.MAX_POSITION_COST_USD, config.MIN_NET_ROI,
      config.REBALANCE_COST_PER_PAIR_USD, config.EXECUTION_BUFFER_USD, config.MAX_BOOK_AGE_MS, config.MAX_BOOK_SKEW_MS];
    const old = this.entries.get(pair.id);
    if (old && old.metadata.length === metadata.length && metadata.every((value, i) => value === old.metadata[i]) && now >= old.at && now < old.expiresAt && books.every((b, i) => {
      const previous = old.books[i];
      return !b ? !previous : previous && b.asks === previous.asks && b.bids === previous.bids && b.assetId === previous.assetId && b.receivedAt === previous.receivedAt && b.sourceTimestamp === previous.sourceTimestamp && b.tickSize === previous.tickSize && b.minOrderShares === previous.minOrderShares;
    })) return old.result;
    const boundaries = [Date.parse(pair.polymarket.endsAt), Date.parse(pair.limitless.endsAt)];
    if (pair.review.validUntil) boundaries.push(Date.parse(pair.review.validUntil));
    for (const b of books) if (b) for (const time of [b.receivedAt, b.sourceTimestamp]) if (time !== null) boundaries.push(time + config.MAX_BOOK_AGE_MS + 1, time - 1000);
    const result = evaluate(pair, cache, config, now, { skipManualReview });
    const entry = { metadata, books: books.map(b => b ? { ...b } : undefined), at: now, expiresAt: Math.min(...boundaries.filter(t => t > now)), result };
    if (this.entries.size >= 5000 && !this.entries.has(pair.id)) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(pair.id, entry); return result;
  }
}
