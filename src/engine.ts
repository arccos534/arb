import { profiler } from './profiling.js';
import { Decimal } from 'decimal.js';
import type { Config } from './config.js';
import type { Book, Evaluation, FeeModel, Pair } from './domain.js';
import type { BookCache } from './books.js';
import { limitlessFeeRate, limitlessFeeAssumption } from './limitless-fees.js';
import { identityBlockers } from './matching.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface BuyQuote {
  grossShares: string;
  netShares: string;
  principal: string;
  cashFee: string;
  contractFee: string;
  cost: string;
  averagePrice: string;
  worstPrice: string;
  feeEstimate: boolean;
  feeLevels: { price: string; grossShares: string; rate: string; contractFee: string }[];
}

export function quoteBuy(book: Book, targetNet: string, fee: FeeModel): BuyQuote {
  const profileStart = profiler.start(); let quoteFailed = false;
  try {
  if (fee.kind === 'unknown') throw new Error('unknown-fee-model');
  const target = new Decimal(targetNet);
  if (!target.isFinite() || target.lte(0)) throw new Error('invalid-size');
  let remaining = target;
  let gross = new Decimal(0), contractFee = new Decimal(0);
  let principal = new Decimal(0), cashFee = new Decimal(0), worst = new Decimal(0);
  const feeLevels: BuyQuote['feeLevels'] = [];
  for (const level of [...book.asks].sort((a, b) => new Decimal(a.price).comparedTo(b.price))) {
    const price = new Decimal(level.price);
    const rate = fee.kind === 'limitless-curve' ? limitlessFeeRate('buy', price) : fee.kind === 'contracts-bound' ? new Decimal(fee.rate) : new Decimal(0);
    const retention = new Decimal(1).minus(rate);
    if (!retention.isFinite() || retention.lte(0) || retention.gt(1)) throw new Error('invalid-fee');
    const take = Decimal.min(level.shares, remaining.div(retention).toDecimalPlaces(6, Decimal.ROUND_UP));
    if (take.lte(0)) continue;
    const charged = take.mul(rate).toDecimalPlaces(6, Decimal.ROUND_UP);
    gross = gross.plus(take); contractFee = contractFee.plus(charged);
    feeLevels.push({ price: price.toString(), grossShares: take.toString(), rate: rate.toString(), contractFee: charged.toString() });
    if (book.tickSize && !price.mod(book.tickSize).isZero()) throw new Error('off-tick-price');
    principal = principal.plus(take.mul(price));
    // Conservative upper rounding per consumed price level; rebates are excluded.
    if (fee.kind === 'polymarket') cashFee = cashFee.plus(take.mul(fee.rate).mul(price).mul(new Decimal(1).minus(price)).toDecimalPlaces(5, Decimal.ROUND_UP));
    remaining = remaining.minus(take.minus(charged));
    worst = price;
    if (remaining.lte(0)) break;
  }
  if (remaining.gt(0)) throw new Error('insufficient-depth');
  if (book.minOrderShares && gross.lt(book.minOrderShares)) throw new Error('below-minimum-order');
  const net = gross.minus(contractFee);
  if (net.lt(target)) throw new Error('net-share-rounding-shortfall');
  return {
    grossShares: gross.toString(), netShares: net.toString(), principal: principal.toString(), cashFee: cashFee.toString(),
    contractFee: contractFee.toString(), cost: principal.plus(cashFee).toDecimalPlaces(6, Decimal.ROUND_UP).toString(),
    averagePrice: principal.div(gross).toString(), worstPrice: worst.toString(),
    feeEstimate: fee.kind === 'limitless-curve' || fee.kind === 'contracts-bound', feeLevels,
  };
  } catch (error) { quoteFailed = true; throw error; }
  finally { profiler.end('quote', profileStart, quoteFailed); profiler.end('liquidity', profileStart, quoteFailed); }
}

export function evaluate(pair: Pair, cache: BookCache, config: Config, now = Date.now(), options: { skipManualReview?: boolean } = {}): Evaluation[] {
  const profileStart = profiler.start();
  try {
  return (['yes', 'no'] as const).map(polySide => {
    const lmSide = polySide === 'yes' ? 'no' : 'yes';
    const result: Evaluation = {
      pairId: pair.id, direction: polySide === 'yes' ? 'poly-yes-limitless-no' : 'poly-no-limitless-yes',
      observedAt: new Date(now).toISOString(), status: 'rejected', reasons: [],
      targetNetShares: config.TARGET_NET_SHARES, payout: null, cost: null, profit: null, roi: null, legs: [],
      assumptions: ['read-only indicative quote, not a fill or backtest', limitlessFeeAssumption, 'rebalance and execution buffers are configured assumptions', 'settlement-source equivalence requires current manual review', 'Limitless executable minimum and intra-level per-order fee rounding are not verified', 'REST response time alone does not prove exchange freshness'],
    };
    if (options.skipManualReview) result.assumptions.push('Manual settlement-equivalence review bypassed for paper testing; apparent profit can reflect different outcomes');
    const identity = identityBlockers(pair);
    if (options.skipManualReview && !pair.review.approved && pair.limitless.externalSlug !== pair.polymarket.slug) identity.push('unverified-market-identity');
    if (identity.length) { result.reasons.push(...identity); return result; }
    if (!pair.review.approved && !options.skipManualReview) result.reasons.push(...(pair.review.reasons.length ? pair.review.reasons : ['manual-rules-review-required']));
    if (!options.skipManualReview && pair.review.validUntil && Date.parse(pair.review.validUntil) <= now) result.reasons.push('review-expired');
    if (Date.parse(pair.polymarket.endsAt) <= now || Date.parse(pair.limitless.endsAt) <= now) result.reasons.push('market-ended');
    const books = [cache.get('polymarket', pair.polymarket.slug, polySide), cache.get('limitless', pair.limitless.slug, lmSide)];
    if (!books[0] || !books[1]) { result.reasons.push('missing-book'); return result; }
    for (const [index, book] of (books as Book[]).entries()) {
      const market = index === 0 ? pair.polymarket : pair.limitless;
      const expected = book.outcome === 'yes' ? market.yesToken : market.noToken;
      if (book.assetId !== expected) result.reasons.push('book-asset-mismatch');
      if (now - book.receivedAt > config.MAX_BOOK_AGE_MS || book.receivedAt > now + 1000) result.reasons.push('stale-or-future-book');
      if (book.sourceTimestamp !== null && (now - book.sourceTimestamp > config.MAX_BOOK_AGE_MS || book.sourceTimestamp > now + 1000)) result.reasons.push('stale-or-future-source-timestamp');
      if (book.bids[0] && book.asks[0] && new Decimal(book.bids[0].price).gte(book.asks[0].price)) result.reasons.push('crossed-book');
    }
    if (Math.abs(books[0].receivedAt - books[1].receivedAt) > config.MAX_BOOK_SKEW_MS) result.reasons.push('book-time-skew');
    if (books[0].sourceTimestamp !== null && books[1].sourceTimestamp !== null && Math.abs(books[0].sourceTimestamp - books[1].sourceTimestamp) > config.MAX_BOOK_SKEW_MS) result.reasons.push('source-time-skew');
    try {
      const a = quoteBuy(books[0], config.TARGET_NET_SHARES, pair.polymarket.fee);
      const b = quoteBuy(books[1], config.TARGET_NET_SHARES, pair.limitless.fee);
      const payout = Decimal.min(a.netShares, b.netShares);
      const cost = new Decimal(a.cost).plus(b.cost).plus(config.REBALANCE_COST_PER_PAIR_USD).plus(config.EXECUTION_BUFFER_USD);
      const profit = payout.minus(cost);
      const roi = profit.div(cost);
      result.legs = [{ venue: 'polymarket', outcome: polySide, ...a }, { venue: 'limitless', outcome: lmSide, ...b }];
      result.payout = payout.toString(); result.cost = cost.toString(); result.profit = profit.toString(); result.roi = roi.toString();
      if (cost.gt(config.MAX_POSITION_COST_USD)) result.reasons.push('position-budget-exceeded');
      result.reasons = [...new Set(result.reasons)];
      if (result.reasons.length === 0) result.status = profit.gt(0) && roi.gte(config.MIN_NET_ROI) ? 'research-positive' : 'research-negative';
    } catch (e) { result.reasons.push(e instanceof Error ? e.message : String(e)); }
    return result;
  });
  } finally { profiler.end('search', profileStart); }
}
