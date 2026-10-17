import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { loadConfig } from '../src/config.js';
import { quoteBuy, evaluate } from '../src/engine.js';
import { BookCache } from '../src/books.js';
import { book, now, pair } from './fixtures.js';

describe('executable-depth quotes', () => {
  it('uses depth rather than multiplying the best ask', () => {
    const b = book(); b.asks = [{ price: '0.6', shares: '8' }, { price: '0.4', shares: '2' }];
    expect(quoteBuy(b, '10', { kind: 'none' }).cost).toBe('5.6');
  });
  it('buys extra gross contracts to cover a fee charged in contracts', () => {
    const quote = quoteBuy(book(), '10', { kind: 'contracts-bound', rate: '0.03' });
    expect(quote.grossShares).toBe('10.309279');
    expect(new Decimal(quote.netShares).gte(10)).toBe(true);
    expect(new Decimal(quote.cost).gt(4)).toBe(true);
  });
  it('includes Polymarket price-dependent fees', () => {
    const quote = quoteBuy(book('polymarket', 'yes', '0.5'), '10', { kind: 'polymarket', rate: '0.07' });
    expect(quote.cashFee).toBe('0.175');
    expect(quote.cost).toBe('5.175');
  });
  it('rejects unknown fees, shallow books, minimum size and off-tick prices', () => {
    expect(() => quoteBuy(book(), '10', { kind: 'unknown', reason: 'missing' })).toThrow('unknown-fee');
    expect(() => quoteBuy(book(), '101', { kind: 'none' })).toThrow('insufficient-depth');
    expect(() => quoteBuy(book(), '1', { kind: 'none' })).toThrow('minimum');
    expect(() => quoteBuy(book('polymarket', 'yes', '0.405'), '10', { kind: 'none' })).toThrow('off-tick');
  });
});

describe('pair evaluation', () => {
  const config = loadConfig({ REBALANCE_COST_PER_PAIR_USD: '0', EXECUTION_BUFFER_USD: '0' });
  it('never displays an arbitrage ROI for contradictory identities even when review is bypassed', () => {
    const p=pair(false); p.limitless.externalSlug='a-different-market';
    const results=evaluate(p,new BookCache(),config,now,{skipManualReview:true});
    expect(results.every(r=>r.roi===null&&r.reasons.includes('conflicting-market-identity'))).toBe(true);
  });
  function cache(): BookCache {
    const c = new BookCache();
    c.set(book('polymarket', 'yes', '0.60'));
    c.set(book('limitless', 'no', '0.36'));
    c.set(book('polymarket', 'no', '0.40'));
    c.set(book('limitless', 'yes', '0.65'));
    return c;
  }
  it('hedges equal net shares, not equal dollar budgets', () => {
    const [a, b] = evaluate(pair(), cache(), config, now);
    expect(a?.cost).toBe('9.6'); expect(a?.profit).toBe('0.4');
    expect(a?.status).toBe('research-positive');
    expect(b?.status).toBe('rejected'); expect(b?.reasons).toContain('position-budget-exceeded');
  });
  it('never promotes an unreviewed pair even when prices look profitable', () => {
    const [result] = evaluate(pair(false), cache(), config, now);
    expect(result?.status).toBe('rejected'); expect(result?.profit).toBe('0.4');
  });
  it('rejects stale books and stale source timestamps', () => {
    expect(evaluate(pair(), cache(), config, now + 6000)[0]?.reasons).toContain('stale-or-future-book');
    const c = cache(), b = book('limitless', 'no', '0.36'); b.sourceTimestamp = now - 6000; c.delete('limitless', b.slug, 'no'); c.set(b);
    expect(evaluate(pair(), c, config, now)[0]?.reasons).toContain('stale-or-future-source-timestamp');
  });
  it('rejects wrong token IDs and source-time skew even when arrival timestamps agree', () => {
    const c = cache(), wrong = book('limitless', 'no', '0.36'); wrong.assetId = 'wrong'; c.set(wrong);
    expect(evaluate(pair(), c, config, now)[0]?.reasons).toContain('book-asset-mismatch');
    const d = cache(), old = book('limitless', 'no', '0.36'); old.sourceTimestamp = now - 2500; d.delete('limitless', old.slug, old.outcome); d.set(old);
    expect(evaluate(pair(), d, config, now)[0]?.reasons).toContain('source-time-skew');
  });
  it('rejects book skew and crossed books', () => {
    const c = cache(), b = book('limitless', 'no', '0.36'); b.receivedAt += 3000; b.sourceTimestamp! += 3000; c.set(b);
    expect(evaluate(pair(), c, config, now + 3000)[0]?.reasons).toContain('book-time-skew');
    const d = cache(), crossed = book('limitless', 'no', '0.36'); crossed.bids[0]!.price = '0.40'; d.set(crossed);
    expect(evaluate(pair(), d, config, now)[0]?.reasons).toContain('crossed-book');
  });
  it('deducts the configured rebalance and execution reserves', () => {
    const cfg = loadConfig({ REBALANCE_COST_PER_PAIR_USD: '0.2', EXECUTION_BUFFER_USD: '0.2' });
    const [result] = evaluate(pair(), cache(), cfg, now);
    expect(result?.profit).toBe('0'); expect(result?.status).toBe('research-negative');
  });
  it('does not evaluate an already ended pair', () => {
    const p = pair(); p.limitless.endsAt = new Date(now).toISOString();
    expect(evaluate(p, cache(), config, now)[0]?.reasons).toContain('market-ended');
  });
});
