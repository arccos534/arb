import { describe, expect, it } from 'vitest';
import { EvaluationCache } from '../src/evaluation-cache.js';
import { BookCache } from '../src/books.js';
import { loadConfig } from '../src/config.js';
import { book, pair, now } from './fixtures.js';

describe('price evaluation cache invalidation', () => {
  it('reuses unchanged quotes but invalidates at freshness, review and expiry boundaries', () => {
    const cached = new EvaluationCache(), books = new BookCache(), p = pair(), config = loadConfig({});
    books.set(book()); books.set(book('limitless', 'no'));
    const first = cached.evaluate(p, books, config, now);
    expect(cached.evaluate(p, books, config, now + 1)).toBe(first);
    expect(cached.evaluate(p, books, config, now + 5001)[0]!.reasons).toContain('stale-or-future-book');
    p.review.validUntil = new Date(now + 500).toISOString();
    expect(cached.evaluate(p, books, config, now + 499)[0]!.reasons).not.toContain('review-expired');
    expect(cached.evaluate(p, books, config, now + 500)[0]!.reasons).toContain('review-expired');
    p.polymarket.endsAt = new Date(now + 600).toISOString();
    expect(cached.evaluate(p, books, config, now + 600)[0]!.reasons).toContain('market-ended');
  });
  it('invalidates when depth, fee, identity or settings change and on clock rollback', () => {
    const cached = new EvaluationCache(), books = new BookCache(), p = pair(), config = loadConfig({});
    const b = book(); books.set(b); books.set(book('limitless', 'no'));
    const first = cached.evaluate(p, books, config, now);
    b.asks = [{ price: '0.5', shares: '100' }];
    expect(cached.evaluate(p, books, config, now)).not.toBe(first);
    const changed = cached.evaluate(p, books, config, now);
    expect(cached.evaluate(p, books, { ...config, MIN_NET_ROI: '0.5' }, now)).not.toBe(changed);
    p.polymarket.fee = { kind: 'polymarket', rate: '0.07' };
    expect(cached.evaluate(p, books, config, now)[0]!.cost).not.toBe(changed[0]!.cost);
    p.limitless.externalSlug = 'another-market';
    expect(cached.evaluate(p, books, config, now)[0]!.roi).toBeNull();
    const beforeRollback = cached.evaluate(p, books, config, now);
    expect(cached.evaluate(p, books, config, now - 1)).not.toBe(beforeRollback);
  });
});
