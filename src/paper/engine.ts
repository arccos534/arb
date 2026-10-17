import { profiler } from '../profiling.js';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Book, FeeModel, Pair, Venue } from '../domain.js';
import { BookCache } from '../books.js';
import { evaluate, quoteBuy } from '../engine.js';
import { limitlessFeeRate } from '../limitless-fees.js';
import { identityBlockers } from '../matching.js';
import { EvaluationCache } from '../evaluation-cache.js';
import type { Config } from '../config.js';
import { paperSettingsSchema, type DemoScenario, type FeedSnapshot, type PaperEvent, type PaperOrder, type PaperSettings, type PaperState, type PaperTrade, type Resolution, type Source } from './types.js';

const D = (value: Decimal.Value) => new Decimal(value);
const cash = (value: Decimal.Value) => D(value).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toString();
const active = (t: PaperTrade) => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status);

export function initialState(source: Source, settings = paperSettingsSchema.parse({}), now = Date.now()): PaperState {
  return {
    version: 1, sessionId: randomUUID(), source, createdAt: now, updatedAt: now, sequence: 0,
    running: false, settings, rng: settings.seed, cash: { polymarket: settings.initialPerVenue, limitless: settings.initialPerVenue, bybit: '0' },
    realizedPnl: '0', trades: [], transfers: [], ledger: [], events: [], equity: [],
    peakEquity: D(settings.initialPerVenue).mul(2).toString(), maxDrawdown: '0', haltReason: null,
  };
}

export function quoteSell(book: Book | undefined, held: string, fee: FeeModel): { shares: string; proceeds: string; fee: string; levels: unknown[] } {
  if (!book || fee.kind === 'unknown') return { shares: '0', proceeds: '0', fee: '0', levels: [] };
  let remaining = D(held), proceeds = D(0), fees = D(0);
  const levels: unknown[] = [];
  for (const level of [...book.bids].sort((a, b) => D(b.price).comparedTo(a.price))) {
    const quantity = Decimal.min(remaining, level.shares);
    if (quantity.lte(0)) continue;
    const price = D(level.price), gross = quantity.mul(price);
    const cost = fee.kind === 'polymarket' ? quantity.mul(fee.rate).mul(price).mul(D(1).minus(price)).toDecimalPlaces(5, Decimal.ROUND_UP)
      : fee.kind === 'limitless-curve' ? gross.mul(limitlessFeeRate('sell', price)).toDecimalPlaces(6, Decimal.ROUND_UP)
      : fee.kind === 'contracts-bound' ? gross.mul('0.015').toDecimalPlaces(6, Decimal.ROUND_UP) : D(0);
    fees = fees.plus(cost); proceeds = proceeds.plus(Decimal.max(0, gross.minus(cost))); remaining = remaining.minus(quantity);
    levels.push({ price: level.price, shares: quantity.toString(), fee: cost.toString() });
    if (remaining.isZero()) break;
  }
  return { shares: D(held).minus(remaining).toString(), proceeds: cash(proceeds), fee: cash(fees), levels };
}

export class PaperEngine {
  dirty = false;
  private readonly attemptClocks = new WeakMap<PaperTrade, number>();
  private readonly evaluations = new EvaluationCache();
  constructor(public state: PaperState, private readonly config: Config) {}
  get settings(): PaperSettings { return this.state.settings; }
  event(type: string, message: string, details: unknown = {}, tradeId: string | null = null, now = Date.now()): void {
    const event: PaperEvent = { id: randomUUID(), at: now, type, message, tradeId, details: structuredClone(details) };
    this.state.events.push(event);
    this.state.events = this.state.events.slice(-500);
    this.state.updatedAt = now; this.dirty = true;
  }
  private movement(venue: Venue | 'bybit', amount: Decimal.Value, kind: string, tradeId: string | null, now: number): void {
    const next = D(this.state.cash[venue]).plus(amount);
    if (next.lt(0)) throw new Error(`Insufficient virtual cash: ${venue}`);
    this.state.cash[venue] = cash(next);
    this.state.ledger.push({ id: randomUUID(), at: now, account: venue, amount: cash(amount), kind, tradeId });
    // Complete ledger is also persisted in the write-ahead log and audit archive.
    this.state.ledger = this.state.ledger.slice(-5000);
    this.dirty = true;
  }
  private pnl(trade: PaperTrade | null, amount: Decimal.Value): void {
    this.state.realizedPnl = cash(D(this.state.realizedPnl).plus(amount));
    if (trade) trade.realizedPnl = cash(D(trade.realizedPnl).plus(amount));
  }
  available(venue: Venue): Decimal {
    const reserved = this.state.trades.filter(t => t.status === 'SCHEDULED').flatMap(t => t.orders).filter(o => o.venue === venue).reduce((sum, o) => sum.plus(o.reserve), D(0));
    return D(this.state.cash[venue]).minus(reserved);
  }
  setRunning(value: boolean, now = Date.now()): void {
    if (value && this.state.haltReason) throw new Error(this.state.haltReason);
    this.state.running = value;
    if (!value) for (const t of this.state.trades.filter(t => t.status === 'SCHEDULED')) this.cancel(t, 'Paper trading paused', now);
    this.event(value ? 'session-started' : 'session-paused', value ? 'Виртуальная торговля запущена' : 'Новые сделки приостановлены; открытые позиции продолжают учитываться', {}, null, now);
  }
  configure(settings: PaperSettings, now = Date.now()): void {
    if (this.state.running || this.state.trades.some(active)) throw new Error('Pause trading and finish open positions before changing settings');
    if (settings.initialPerVenue !== this.settings.initialPerVenue && (this.state.trades.length || this.state.transfers.length || this.state.ledger.length)) throw new Error('Initial capital can only be changed by creating a new session');
    if (!this.state.trades.length && !this.state.transfers.length) {
      this.state.cash.polymarket = settings.initialPerVenue; this.state.cash.limitless = settings.initialPerVenue;
      this.state.peakEquity = D(settings.initialPerVenue).mul(2).toString(); this.state.equity = [];
    }
    if (settings.seed !== this.settings.seed) this.state.rng = settings.seed;
    this.state.settings = settings;
    this.event('settings-updated', 'Параметры симуляции сохранены', settings, null, now);
  }
  tradingConfig(): Config {
    return { ...this.config, TARGET_NET_SHARES: this.settings.targetNetShares, MAX_POSITION_COST_USD: this.settings.maxPositionCost,
      MIN_NET_ROI: String(this.settings.minRoi), MAX_BOOK_AGE_MS: this.settings.maxQuoteAgeMs, MAX_BOOK_SKEW_MS: this.settings.maxQuoteSkewMs,
      REBALANCE_COST_PER_PAIR_USD: this.settings.autoRebalance ? this.settings.rebalanceFee : this.config.REBALANCE_COST_PER_PAIR_USD };
  }
  evaluate(pair: Pair, cache: BookCache, now: number) { return this.evaluations.evaluate(pair, cache, this.tradingConfig(), now, this.settings.skipManualReview); }
  entryBlockers(pair: Pair, now: number): string[] {
    const attempts = this.state.trades.filter(t => t.pairId === pair.id);
    const reasons: string[] = [];
    if (attempts.some(t => active(t) || t.orders.some(o => D(o.cost).gt(0)))) reasons.push('already-entered-session');
    if (attempts.length >= this.settings.maxAttemptsPerPair) reasons.push('pair-attempt-limit');
    if (attempts.length && now - attempts.at(-1)!.signalAt < this.settings.retryCooldownMs) reasons.push('pair-retry-cooldown');
    if (this.state.source === 'live') {
      const earliest = Math.min(Date.parse(pair.polymarket.endsAt), Date.parse(pair.limitless.endsAt));
      const latest = Math.max(Date.parse(pair.polymarket.endsAt), Date.parse(pair.limitless.endsAt));
      if (earliest - now < this.settings.minSecondsToEnd * 1000) reasons.push('entry-too-near-expiry');
      if (latest - now > this.settings.maxHoldingHours * 3600000) reasons.push('holding-period-too-long');
    }
    return reasons;
  }
  private exposure(): Decimal { return this.state.trades.filter(active).reduce((sum, t) => sum.plus(t.orders.reduce((s, o) => s.plus(o.costBasis).plus(o.reserve), D(0))), D(0)); }
  private random(): number { let x = this.state.rng; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state.rng = x >>> 0; return this.state.rng / 4294967296; }
  private cache(feed: FeedSnapshot): BookCache {
    const cache = new BookCache();
    // Executions replace asks arrays; levels themselves remain read-only. Copy
    // just book wrappers, so fake depth consumption never changes the live feed.
    feed.books.forEach(b => cache.set({ ...b }));
    return cache;
  }
  private fresh(book: Book | undefined, now: number): book is Book {
    return Boolean(book && now >= book.receivedAt - 1000 && now - book.receivedAt <= this.settings.maxQuoteAgeMs && (book.sourceTimestamp === null || (now >= book.sourceTimestamp - 1000 && now - book.sourceTimestamp <= this.settings.maxQuoteAgeMs)));
  }

  step(feed: FeedSnapshot, changedPairIds?: ReadonlySet<string>): void {
    const now = feed.at, cache = this.cache(feed);
    this.advanceTransfers(now);
    for (const trade of this.state.trades) {
      if (trade.status === 'SCHEDULED' && trade.executeAfter <= now) {
        const confirmed = trade.orders.every(o => {
          const b = cache.get(o.venue, o.slug, o.outcome);
          return this.fresh(b, now) && b.receivedAt >= trade.executeAfter;
        });
        // Obtain a new public snapshot after simulated arrival; no price change
        // is required. Missing updates are not immediate exchange rejections.
        if (now > trade.executeAfter + this.settings.maxExecutionWaitMs) {
          const details = this.assessExecution(trade, trade.pair, cache, now);
          details.reasons.unshift('execution-timeout');
          this.rememberExecution(trade, details, now);
          this.cancel(trade, 'Истекло время ожидания исполнения — повторный вход возможен после паузы', now, details);
        }
        else if (confirmed) this.execute(trade, cache, feed, now);
      }
      if (trade.status === 'UNHEDGED' && trade.endsAt > now) this.closeWithCache(trade, cache, 'emergency', now);
      if (['OPEN', 'UNHEDGED'].includes(trade.status) && trade.endsAt <= now) {
        trade.status = 'WAITING_RESOLUTION'; this.event('waiting-resolution', 'Событие завершилось, ожидается отдельный расчёт каждой площадки', {}, trade.id, now);
      }
    }
    if (D(this.state.realizedPnl).lte(D(this.settings.lossLimit).negated()) && this.state.running) {
      this.state.running = false; this.state.haltReason = 'Достигнут лимит реализованного убытка. Создайте новую сессию после анализа.';
      for (const t of this.state.trades.filter(t => t.status === 'SCHEDULED')) this.cancel(t, 'Loss limit', now);
      this.event('risk-halt', this.state.haltReason, { realizedPnl: this.state.realizedPnl }, null, now);
    }
    if (this.state.running && feed.ready && !this.state.haltReason && this.state.trades.filter(active).length < this.settings.maxPositions) {
      const opportunities = feed.pairs.filter(pair => (!changedPairIds || changedPairIds.has(pair.id)) && !this.entryBlockers(pair, now).length).flatMap(pair => this.evaluate(pair, cache, now)
        .filter(e => e.status === 'research-positive').map(signal => ({ pair, signal })))
        .sort((a, b) => D(b.signal.roi!).comparedTo(a.signal.roi!) || D(b.signal.profit!).comparedTo(a.signal.profit!));
      for (const { pair, signal } of opportunities) {
        if (this.state.trades.filter(active).length >= this.settings.maxPositions || this.state.trades.length >= 1000) break;
        if (this.entryBlockers(pair, now).length) continue;
        this.schedule(pair, signal.direction, cache, now, signal.profit!, signal.roi!);
      }
      if (this.settings.autoRebalance && !this.state.transfers.some(t => t.status !== 'COMPLETED')) this.rebalance(now, false);
    }
    this.sampleEquity(feed);
  }

  private buildTrade(pair: Pair, direction: PaperTrade['direction'], cache: BookCache, now: number, expectedProfit: string, expectedRoi: string): PaperTrade {
    const orders: PaperOrder[] = [];
    let initialCost = D(0);
    for (const market of [pair.polymarket, pair.limitless]) {
      const outcome = market.venue === 'polymarket' ? (direction === 'poly-yes-limitless-no' ? 'yes' : 'no') : (direction === 'poly-yes-limitless-no' ? 'no' : 'yes');
      const book = cache.get(market.venue, market.slug, outcome)!;
      const quote = quoteBuy(book, this.settings.targetNetShares, market.fee);
      let limit = Decimal.min('0.9999', D(quote.worstPrice).mul(D(1).plus(this.settings.maxSlippage)));
      if (book.tickSize) limit = limit.div(book.tickSize).floor().mul(book.tickSize);
      const reserve = D(quote.cost);
      initialCost = initialCost.plus(quote.cost);
      orders.push({ id: randomUUID(), venue: market.venue, outcome, slug: market.slug, assetId: book.assetId, fee: market.fee,
        status: 'PENDING', targetNetShares: this.settings.targetNetShares, grossShares: '0', heldShares: '0', netShares: '0',
        limitPrice: limit.toString(), reserve: cash(reserve), cost: '0', costBasis: '0', averageFillPrice: '0', cashFee: '0', contractFee: '0', proceeds: '0', soldShares: '0', resolved: false, payoutPerShare: null, error: null });
    }
    return {
      id: randomUUID(), source: this.state.source, pairId: pair.id, title: pair.polymarket.title, status: 'SCHEDULED', direction,
      signalAt: now, executeAfter: now + this.settings.latencyMs, filledAt: null, closedAt: null,
      endsAt: Math.max(Date.parse(pair.polymarket.endsAt), Date.parse(pair.limitless.endsAt)), orders, expectedProfit, realizedPnl: '0',
      rulesHashes: [pair.polymarket.rulesHash, pair.limitless.rulesHash], notes: this.settings.skipManualReview ? ['paper-only:manual-review-bypassed'] : [], pair: structuredClone(pair), expectedRoi,
      initialCost: initialCost.toString(), maxExecutionCost: Decimal.min(this.settings.maxPositionCost, initialCost.mul(D(1).plus(this.settings.maxSlippage))).toDecimalPlaces(6, Decimal.ROUND_DOWN).toString(),
    };
  }

  entryAssessment(pair: Pair, direction: PaperTrade['direction'], cache: BookCache, now: number) {
    const signal = this.evaluate(pair, cache, now).find(e => e.direction === direction)!;
    if (signal.status !== 'research-positive') return { reasons: signal.reasons.length ? signal.reasons : ['non-positive-entry-signal'] };
    const trade = this.buildTrade(pair, direction, cache, now, signal.profit!, signal.roi!);
    return this.assessExecution(trade, pair, cache, now, false);
  }

  private schedule(pair: Pair, direction: PaperTrade['direction'], cache: BookCache, now: number, expectedProfit: string, expectedRoi: string): void {
    const profileStart = profiler.start();
    try {
    const trade = this.buildTrade(pair, direction, cache, now, expectedProfit, expectedRoi);
    const check = this.assessExecution(trade, pair, cache, now, false);
    if (!check.passed) {
      const diagnostics = this.state.entryDiagnostics ??= { blockedSignals: 0, recent: [] };
      const previous = diagnostics.recent.find(r => r.pairId === pair.id && r.direction === direction);
      // Count a blocked opportunity once per retry window, without a per-tick log.
      if (!previous || now - previous.at >= this.settings.retryCooldownMs) {
        diagnostics.blockedSignals++;
        diagnostics.recent = [...diagnostics.recent.filter(r => r !== previous), { pairId: pair.id, direction, at: now, reasons: check.reasons }].slice(-100);
        this.dirty = true;
      }
      return;
    }
    const orders = trade.orders;
    this.state.trades.push(trade);
    if (profiler.enabled) this.attemptClocks.set(trade, profiler.start());
    this.event('orders-scheduled', 'Две виртуальные заявки поставлены в очередь с задержкой исполнения', { orders, executeAfter: trade.executeAfter, expectedProfit,
      initialCost: trade.initialCost, maxExecutionCost: trade.maxExecutionCost, configuredLatencyMs: this.settings.latencyMs, signalBooks: orders.map(order => {
        const book = cache.get(order.venue, order.slug, order.outcome)!;
        return { venue: order.venue, outcome: order.outcome, receivedAt: book.receivedAt, sourceTimestamp: book.sourceTimestamp,
          receiptAgeMs: now - book.receivedAt, sourceAgeMs: book.sourceTimestamp === null ? null : now - book.sourceTimestamp,
          transport: book.transport, bestAsk: book.asks[0] ?? null, bestBid: book.bids[0] ?? null, limitPrice: order.limitPrice };
      }) }, trade.id, now);
    } finally { profiler.end('schedule', profileStart); }
  }

  private recordAttemptWait(trade: PaperTrade): void {
    const began = this.attemptClocks.get(trade);
    if (began === undefined) return;
    const elapsed = profiler.start() - began, delay = trade.executeAfter - trade.signalAt;
    profiler.record('artificial-delay', Math.min(delay, elapsed));
    profiler.record('snapshot-wait', Math.max(0, elapsed - delay));
    this.attemptClocks.delete(trade);
  }

  private cancel(trade: PaperTrade, reason: string, now: number, details: unknown = {}): void {
    this.recordAttemptWait(trade);
    trade.status = 'CANCELLED'; trade.closedAt = now;
    trade.orders.forEach(o => { o.status = 'CANCELLED'; o.reserve = '0'; o.error = reason; });
    this.event('orders-cancelled', reason, details, trade.id, now);
  }

  assessExecution(trade: PaperTrade, pair: Pair, cache: BookCache, now: number, requirePostArrival = true) {
    let profileRejected = false;
    const profileStart = profiler.start();
    try {
    const executable = new BookCache();
    const reasons: string[] = [];
    let worstLoss = D(0), totalRoundTripLoss = D(0);
    const owned = this.state.trades.find(t => t.id === trade.id && t.status === 'SCHEDULED');
    const ownedReserve = owned?.orders.reduce((sum, o) => sum.plus(o.reserve), D(0)) ?? D(0);
    const pairPricing = trade.initialCost !== undefined && trade.maxExecutionCost !== undefined;
    const proposedOrders: { id: string; limitPrice: string; reserve: string }[] = [];
    let purchaseCost = D(0), quotedLegs = 0;
    const legs = trade.orders.map(order => {
      const book = cache.get(order.venue, order.slug, order.outcome);
      const evidence = { venue: order.venue, outcome: order.outcome, limitPrice: order.limitPrice,
        receivedAt: book?.receivedAt ?? null, sourceTimestamp: book?.sourceTimestamp ?? null,
        receiptAgeMs: book ? now - book.receivedAt : null, sourceAgeMs: book?.sourceTimestamp ? now - book.sourceTimestamp : null,
        proposedLimitPrice: null as string | null,
        bestAsk: book?.asks[0] ?? null, bestBid: book?.bids[0] ?? null };
      if (!this.fresh(book, now) || (requirePostArrival && book.receivedAt < trade.executeAfter)) {
        reasons.push(`${order.venue}:stale-or-missing-execution-book`);
        return evidence;
      }
      if (book.assetId !== order.assetId) reasons.push(`${order.venue}:execution-asset-mismatch`);
      // Confirm the full target at the original limit, including executable
      // minimums. Never treat a known depth shortage as a random partial fill.
      const limited = pairPricing ? book : { ...book, asks: book.asks.filter(l => D(l.price).lte(order.limitPrice)) };
      if (!pairPricing && book.asks.length && !limited.asks.length) reasons.push(`${order.venue}:price-above-limit`);
      executable.set(limited);
      try {
        const quote = quoteBuy(limited, order.targetNetShares, order.fee);
        purchaseCost = purchaseCost.plus(quote.cost); quotedLegs++;
        if (!pairPricing && D(quote.cost).gt(order.reserve)) reasons.push(`${order.venue}:reserved-budget-exceeded`);
        const released = owned?.orders.filter(o => o.venue === order.venue).reduce((sum, o) => sum.plus(o.reserve), D(0)) ?? D(0);
        if (D(quote.cost).gt(this.available(order.venue).plus(released).minus(this.settings.cashReserve))) reasons.push(`${order.venue}:available-budget-exceeded`);
        if (pairPricing) proposedOrders.push({ id: order.id, limitPrice: quote.worstPrice, reserve: quote.cost });
        const stressed = { ...book, bids: book.bids.map(l => ({ ...l, price: D(l.price).mul(D(1).minus(this.settings.maxSlippage)).toString() })) };
        const exit = quoteSell(stressed, quote.netShares, order.fee);
        const loss = Decimal.max(0, D(quote.cost).minus(exit.proceeds));
        if (D(exit.shares).lt(quote.netShares)) reasons.push(`${order.venue}:insufficient-emergency-exit-depth`);
        if (loss.gt(this.settings.maxUnhedgedLossUsd)) reasons.push(`${order.venue}:unhedged-loss-limit`);
        worstLoss = Decimal.max(worstLoss, loss); totalRoundTripLoss = totalRoundTripLoss.plus(loss);
        return { ...evidence, proposedLimitPrice: pairPricing ? quote.worstPrice : order.limitPrice, quote, stressedExit: exit, unhedgedLoss: loss.toString() };
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        if (reason !== 'insufficient-depth' || limited.asks.length || !book.asks.length) reasons.push(`${order.venue}:${reason}`);
        return evidence;
      }
    });
    const evaluation = evaluate(pair, executable, this.tradingConfig(), now, { skipManualReview: this.settings.skipManualReview })
      .find(e => e.direction === trade.direction)!;
    reasons.push(...evaluation.reasons.filter(reason => reason !== 'insufficient-depth' || !reasons.some(r => /:(price-above-limit|insufficient-depth)$/.test(r))));
    if (evaluation.profit !== null && D(evaluation.profit).lte(0)) reasons.push('non-positive-execution-profit');
    if (evaluation.roi !== null && D(evaluation.roi).lt(this.settings.minRoi)) reasons.push('execution-roi-below-minimum');
    const failureProbability = D(this.settings.rejectProbability).plus(D(1).minus(this.settings.rejectProbability).mul(this.settings.partialProbability));
    const estimatedFailureCost = totalRoundTripLoss.mul(failureProbability);
    const adjustedProfit = evaluation.profit === null ? null : D(evaluation.profit).minus(estimatedFailureCost);
    if (adjustedProfit !== null && adjustedProfit.lt(this.settings.minProfitUsd)) reasons.push('risk-adjusted-profit-below-minimum');
    if (pairPricing && quotedLegs === trade.orders.length && purchaseCost.gt(trade.maxExecutionCost!)) reasons.push('pair-price-budget-exceeded');
    if (evaluation.cost !== null && this.exposure().minus(ownedReserve).plus(evaluation.cost).gt(this.settings.maxTotalExposureUsd)) reasons.push('total-exposure-limit');
    profileRejected = reasons.length > 0;
    const passed = reasons.length === 0 && evaluation.status === 'research-positive';
    return { passed, reasons: [...new Set(reasons)], signalRoi: trade.expectedRoi ?? null,
      signalProfit: trade.expectedProfit, executionRoi: evaluation.roi, executionProfit: evaluation.profit,
      executionCost: evaluation.cost, minRoi: this.settings.minRoi, minProfitUsd: this.settings.minProfitUsd,
      initialCost: trade.initialCost ?? null, maxExecutionCost: trade.maxExecutionCost ?? null,
      purchaseCost: quotedLegs === trade.orders.length ? purchaseCost.toString() : null, proposedOrders,
      worstUnhedgedLoss: worstLoss.toString(), estimatedFailureCost: estimatedFailureCost.toString(), riskAdjustedProfit: adjustedProfit?.toString() ?? null,
      actualLatencyMs: now - trade.signalAt, configuredLatencyMs: trade.executeAfter - trade.signalAt,
      postArrivalWaitMs: Math.max(0, now - trade.executeAfter), legs,
      scope: 'Both legs checked before simulated submission; later modeled rejections and partial fills remain possible' };
    } finally { profiler.end('risk', profileStart, profileRejected); }
  }

  private rememberExecution(trade: PaperTrade, details: ReturnType<PaperEngine['assessExecution']>, now: number): void {
    trade.execution = { checkedAt: now, purchaseCost: details.purchaseCost, executionCost: details.executionCost,
      reasons: details.reasons, actualLatencyMs: details.actualLatencyMs, postArrivalWaitMs: details.postArrivalWaitMs, legs: details.legs };
  }

  private preflight(trade: PaperTrade, pair: Pair, cache: BookCache, now: number): boolean {
    const profileStart = profiler.start();
    try {
    this.recordAttemptWait(trade);
    const details = this.assessExecution(trade, pair, cache, now);
    const { passed } = details;
    this.rememberExecution(trade, details, now);
    if (passed && details.proposedOrders.length) {
      // Both reservations change together after all cash, depth and risk checks.
      for (const proposed of details.proposedOrders) Object.assign(trade.orders.find(o => o.id === proposed.id)!, { limitPrice: proposed.limitPrice, reserve: proposed.reserve });
    }
    this.event('execution-preflight', passed ? 'Обе стороны повторно проверены перед покупкой' : 'Вход отменён: условия обеих сторон не прошли повторную проверку', details, trade.id, now);
    if (!passed) this.cancel(trade, `Отмена до покупки: ${details.reasons.join(', ') || 'execution-not-profitable'}`, now, details);
    return passed;
    } finally { profiler.end('recheck', profileStart, trade.status === 'CANCELLED'); }
  }

  private execute(trade: PaperTrade, cache: BookCache, feed: FeedSnapshot, now: number): void {
    const profileStart = profiler.start();
    try {
    const current = feed.pairs.find(p => p.id === trade.pairId);
    if (!current || identityBlockers(current).length || (!current.review.approved && !this.settings.skipManualReview) || (this.settings.skipManualReview && !current.review.approved && current.limitless.externalSlug !== current.polymarket.slug) || current.polymarket.rulesHash !== trade.rulesHashes[0] || current.limitless.rulesHash !== trade.rulesHashes[1] || now >= Math.min(Date.parse(current.polymarket.endsAt), Date.parse(current.limitless.endsAt))) {
      this.cancel(trade, 'Правила изменились, пара недоступна или событие завершилось', now); return;
    }
    // Synchronous, read-only gate for both legs before any cash/depth mutation
    // or random API outcome. A known failure must cancel the entire attempt.
    if (!this.preflight(trade, current, cache, now)) return;
    for (const order of trade.orders) {
      const original = cache.get(order.venue, order.slug, order.outcome);
      const roll = this.random(), partialRoll = this.random();
      const forced = this.state.source === 'demo' ? trade.notes.find(n => n.startsWith('scenario:'))?.slice(9) as DemoScenario | undefined : undefined;
      const rejected = forced === 'rejection' && order.venue === 'limitless' || roll < this.settings.rejectProbability;
      const partial = forced === 'partial' && order.venue === 'limitless' || partialRoll < this.settings.partialProbability;
      if (rejected || !this.fresh(original, now) || original.receivedAt < trade.executeAfter) {
        order.status = 'REJECTED'; order.error = rejected ? 'simulated-api-rejection' : 'stale-or-missing-execution-book'; order.reserve = '0';
        this.event('order-rejected', 'Виртуальная заявка отклонена', { orderId: order.id, venue: order.venue, reason: order.error, roll, partialRoll }, trade.id, now); continue;
      }
      const executionBook: Book = { ...original, minOrderShares: null, asks: original.asks.filter(l => D(l.price).lte(order.limitPrice)).map(l => ({ ...l })) };
      const availableNet = executionBook.asks.reduce((s, l) => {
        const rate = order.fee.kind === 'limitless-curve' ? limitlessFeeRate('buy', l.price)
          : order.fee.kind === 'contracts-bound' ? D(order.fee.rate) : D(0);
        return s.plus(D(l.shares).minus(D(l.shares).mul(rate).toDecimalPlaces(6, Decimal.ROUND_UP)));
      }, D(0)).toDecimalPlaces(6, Decimal.ROUND_DOWN);
      const wanted = partial ? D(order.targetNetShares).mul('0.5') : D(order.targetNetShares);
      const target = Decimal.min(wanted, availableNet).toDecimalPlaces(6, Decimal.ROUND_DOWN);
      try {
        if (target.lte(0)) throw new Error('price-limit-or-empty-book');
        const quote = quoteBuy(executionBook, target.toString(), order.fee);
        if (D(quote.cost).gt(order.reserve) || D(quote.cost).gt(this.state.cash[order.venue])) throw new Error('reserved-budget-exceeded');
        this.movement(order.venue, D(quote.cost).negated(), 'buy', trade.id, now);
        Object.assign(order, { status: D(quote.netShares).gte(order.targetNetShares) ? 'FILLED' : 'PARTIAL', grossShares: quote.grossShares,
          netShares: quote.netShares, heldShares: quote.netShares, cost: quote.cost, costBasis: quote.cost,
          cashFee: quote.cashFee, contractFee: quote.contractFee, averageFillPrice: quote.averagePrice, reserve: '0' });
        // Consume this tick's shared depth so another order cannot use the same units.
        let used = D(quote.grossShares);
        original.asks = original.asks.map(l => {
          if (D(l.price).gt(order.limitPrice)) return l;
          const take = Decimal.min(l.shares, used); used = used.minus(take);
          return { ...l, shares: D(l.shares).minus(take).toString() };
        }).filter(l => D(l.shares).gt(0));
        this.event('order-filled', order.status === 'PARTIAL' ? 'Частичное виртуальное исполнение; остаток отменён' : 'Виртуальная заявка исполнена', {
          order, feeCalculation: quote, book: executionBook, roll, partialRoll, actualLatencyMs: now - trade.signalAt, model: 'FAK against future observed snapshot; queue priority not modeled',
        }, trade.id, now);
      } catch (e) {
        order.status = 'REJECTED'; order.reserve = '0'; order.error = String(e);
        this.event('order-rejected', 'Виртуальная заявка не исполнена', { orderId: order.id, reason: order.error, book: executionBook }, trade.id, now);
      }
    }
    trade.filledAt = now;
    const [a, b] = trade.orders;
    if (a && b && D(a.heldShares).gt(0) && D(a.heldShares).minus(b.heldShares).abs().lte('0.000001')) trade.status = 'OPEN';
    else if (trade.orders.some(o => D(o.heldShares).gt(0))) trade.status = 'UNHEDGED';
    else { trade.status = 'FAILED'; trade.closedAt = now; }
    this.event('trade-status', `Состояние виртуальной сделки: ${trade.status}`, { status: trade.status }, trade.id, now);
    } finally { profiler.end('execute', profileStart); }
  }

  closeAll(feed: FeedSnapshot): { requested: number; closed: number; cancelled: number; remaining: number } {
    const targets = this.state.trades.filter(active);
    this.setRunning(false, feed.at);
    const cache = this.cache(feed);
    for (const trade of targets) if (active(trade)) this.closeWithCache(trade, cache, 'bulk', feed.at);
    const result = { requested: targets.length, closed: targets.filter(t => t.status === 'CLOSED').length,
      cancelled: targets.filter(t => t.status === 'CANCELLED').length, remaining: targets.filter(active).length };
    this.event('positions-close-all', 'Массовое закрытие виртуальных позиций', result, null, feed.at);
    return result;
  }

  close(tradeId: string, feed: FeedSnapshot, reason = 'manual', now = feed.at): void {
    const trade = this.state.trades.find(t => t.id === tradeId);
    if (!trade) throw new Error('Trade not found');
    if (trade.status === 'SCHEDULED') { this.cancel(trade, 'Отмена до исполнения', now); return; }
    if (!active(trade)) return;
    this.closeWithCache(trade, this.cache(feed), reason, now);
  }
  private closeWithCache(trade: PaperTrade, cache: BookCache, reason: string, now: number): void {
    let changed = false;
    for (const order of trade.orders) {
      if (D(order.heldShares).lte(0)) continue;
      const book = cache.get(order.venue, order.slug, order.outcome);
      if (!this.fresh(book, now) || book.assetId !== order.assetId || (book.asks[0] && book.bids[0] && D(book.bids[0].price).gte(book.asks[0].price))) continue;
      const quote = quoteSell(book, order.heldShares, order.fee);
      if (D(quote.shares).lte(0)) continue;
      const basis = D(order.costBasis).mul(quote.shares).div(order.heldShares);
      order.heldShares = cash(D(order.heldShares).minus(quote.shares)); order.soldShares = cash(D(order.soldShares).plus(quote.shares));
      order.costBasis = cash(D(order.costBasis).minus(basis)); order.proceeds = cash(D(order.proceeds).plus(quote.proceeds));
      order.cashFee = cash(D(order.cashFee).plus(quote.fee));
      this.movement(order.venue, quote.proceeds, 'sell', trade.id, now); this.pnl(trade, D(quote.proceeds).minus(basis));
      this.event('position-sold', reason === 'emergency' ? 'Аварийная продажа незакрытой экспозиции по доступным bid' : 'Позиция виртуально продана по доступным bid', { venue: order.venue, quote, reason, book }, trade.id, now);
      let used = D(quote.shares);
      book.bids = book.bids.map(level => { const take = Decimal.min(level.shares, used); used = used.minus(take); return { ...level, shares: D(level.shares).minus(take).toString() }; }).filter(level => D(level.shares).gt(0));
      changed = true;
    }
    if (trade.orders.every(o => D(o.heldShares).isZero())) { trade.status = 'CLOSED'; trade.closedAt = now; }
    else if (changed) trade.status = 'UNHEDGED';
    if (changed) this.event('trade-status', `Состояние виртуальной сделки: ${trade.status}`, { realizedPnl: trade.realizedPnl }, trade.id, now);
  }

  resolve(resolution: Resolution): void {
    for (const trade of this.state.trades.filter(active)) for (const order of trade.orders) {
      if (order.venue !== resolution.venue || order.slug !== resolution.slug || order.resolved || order.status === 'PENDING') continue;
      const payout = order.outcome === 'yes' ? resolution.yesPayout : resolution.noPayout;
      if (!D(payout).isFinite() || D(payout).lt(0) || D(payout).gt(1)) throw new Error('Invalid payout');
      const amount = D(order.heldShares).mul(payout);
      this.movement(order.venue, amount, 'settlement', trade.id, resolution.at);
      this.pnl(trade, amount.minus(order.costBasis));
      order.proceeds = cash(D(order.proceeds).plus(amount)); order.heldShares = '0'; order.costBasis = '0'; order.resolved = true; order.payoutPerShare = payout;
      this.event('leg-settled', 'Получена виртуальная выплата по отдельному результату площадки', { venue: order.venue, payout, amount: amount.toString(), evidence: resolution.evidence }, trade.id, resolution.at);
      if (trade.orders.every(o => o.resolved || D(o.netShares).isZero() || (D(o.heldShares).isZero() && D(o.soldShares).gt(0)))) {
        trade.status = 'SETTLED'; trade.closedAt = resolution.at;
        this.event('trade-settled', 'Сделка полностью рассчитана', { realizedPnl: trade.realizedPnl }, trade.id, resolution.at);
      } else trade.status = 'WAITING_RESOLUTION';
    }
  }

  rebalance(now = Date.now(), explicit = true): void {
    if (this.state.transfers.some(t => t.status !== 'COMPLETED')) { if (explicit) throw new Error('Transfer already in progress'); return; }
    const poly = this.available('polymarket'), lm = this.available('limitless');
    const from: Venue = poly.gt(lm) ? 'polymarket' : 'limitless', to: Venue = from === 'polymarket' ? 'limitless' : 'polymarket';
    if (!explicit && this.available(to).gte(this.settings.rebalanceThreshold)) return;
    const amount = this.available(from).minus(this.available(to)).div(2).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    if (amount.lte(this.settings.rebalanceFee) || this.available(from).minus(amount).lt(this.settings.cashReserve)) { if (explicit) throw new Error('No transferable excess above reserve and fee'); return; }
    this.movement(from, amount.negated(), 'virtual-deposit-sent', null, now);
    const transfer = { id: randomUUID(), from, to, amount: amount.toString(), fee: this.settings.rebalanceFee, status: 'DEPOSIT_PENDING' as const, createdAt: now, nextAt: now + this.settings.transferDelayMs, completedAt: null };
    this.state.transfers.push(transfer);
    this.event('transfer-started', 'Начат виртуальный перевод через Bybit', transfer, null, now);
  }
  private advanceTransfers(now: number): void {
    for (const transfer of this.state.transfers) {
      if (transfer.status === 'COMPLETED' || transfer.nextAt > now) continue;
      if (transfer.status === 'DEPOSIT_PENDING') {
        this.movement('bybit', transfer.amount, 'virtual-deposit-confirmed', null, now);
        transfer.status = 'WITHDRAW_PENDING'; transfer.nextAt = now + this.settings.transferDelayMs;
        this.event('transfer-deposit', 'Виртуальный депозит зачислен на Bybit', transfer, null, now);
      } else {
        this.movement('bybit', D(transfer.amount).negated(), 'virtual-withdrawal', null, now);
        this.movement(transfer.to, D(transfer.amount).minus(transfer.fee), 'virtual-withdrawal-confirmed', null, now);
        this.pnl(null, D(transfer.fee).negated()); transfer.status = 'COMPLETED'; transfer.completedAt = now;
        this.event('transfer-completed', 'Виртуальная балансировка завершена; комиссия учтена', transfer, null, now);
      }
    }
  }

  metrics(feed: FeedSnapshot): Record<string, unknown> {
    const cache = this.cache(feed);
    let liquidation = D(0), basis = D(0), reserved = D(0), cashFees = D(0), contractFeesValue = D(0), unpricedPositions = 0;
    for (const trade of this.state.trades) for (const order of trade.orders) {
      basis = basis.plus(order.costBasis); cashFees = cashFees.plus(order.cashFee);
      contractFeesValue = contractFeesValue.plus(D(order.contractFee).mul(order.averageFillPrice));
      if (trade.status === 'SCHEDULED') reserved = reserved.plus(order.reserve);
      const book = cache.get(order.venue, order.slug, order.outcome);
      if (D(order.heldShares).gt(0)) {
        if (this.fresh(book, feed.at) && book.assetId === order.assetId && !(book.bids[0] && book.asks[0] && D(book.bids[0].price).gte(book.asks[0].price))) {
          const quote = quoteSell(book, order.heldShares, order.fee); liquidation = liquidation.plus(quote.proceeds);
          if (D(quote.shares).lt(order.heldShares)) unpricedPositions++;
          let used = D(quote.shares);
          book.bids = book.bids.map(l => { const take = Decimal.min(l.shares, used); used = used.minus(take); return { ...l, shares: D(l.shares).minus(take).toString() }; }).filter(l => D(l.shares).gt(0));
        } else unpricedPositions++;
      }
    }
    const totalCash = Object.values(this.state.cash).reduce((s, v) => s.plus(v), D(0));
    const inTransit = this.state.transfers.filter(t => t.status === 'DEPOSIT_PENDING').reduce((s, t) => s.plus(t.amount), D(0));
    const equity = totalCash.plus(inTransit).plus(liquidation);
    const initial = D(this.settings.initialPerVenue).mul(2);
    const closed = this.state.trades.filter(t => ['SETTLED', 'CLOSED'].includes(t.status));
    return {
      equity: cash(equity), initialCapital: initial.toString(), cash: cash(totalCash), reserved: cash(reserved),
      inTransit: cash(inTransit), positionsValue: cash(liquidation), costBasis: cash(basis),
      realizedPnl: this.state.realizedPnl, unrealizedPnl: cash(liquidation.minus(basis)), totalPnl: cash(equity.minus(initial)),
      cashFees: cash(cashFees), contractFeesValue: cash(contractFeesValue), maxDrawdown: this.state.maxDrawdown,
      exposureUsd: this.exposure().toString(),
      openTrades: this.state.trades.filter(active).length, closedTrades: closed.length,
      blockedSignals: this.state.entryDiagnostics?.blockedSignals ?? 0,
      cancelledBeforePurchase: this.state.trades.filter(t => t.status === 'CANCELLED' && t.orders.every(o => D(o.cost).isZero())).length,
      executionErrors: this.state.trades.filter(t => t.status !== 'CANCELLED' && t.orders.some(o => o.status === 'REJECTED' || o.status === 'PARTIAL' || o.error !== null || D(o.cost).gt(0) && D(o.netShares).lt(o.targetNetShares))).length,
      winRate: closed.length ? closed.filter(t => D(t.realizedPnl).gt(0)).length / closed.length : null,
      unpricedPositions, valuationComplete: unpricedPositions === 0,
      valuation: 'Fresh bid depth less estimated sell fees; missing/stale/unexecutable remainder valued at zero',
    };
  }
  private sampleEquity(feed: FeedSnapshot): void {
    if (feed.at - (this.state.equity.at(-1)?.at ?? 0) < 1000) return;
    const metrics = this.metrics(feed);
    const equity = D(String(metrics.equity));
    if (metrics.valuationComplete && equity.gt(this.state.peakEquity)) this.state.peakEquity = equity.toString();
    const drawdown = D(this.state.peakEquity).minus(equity);
    if (metrics.valuationComplete && drawdown.gt(this.state.maxDrawdown)) this.state.maxDrawdown = cash(drawdown);
    this.state.equity.push({ at: feed.at, equity: String(metrics.equity), cash: String(metrics.cash), realized: this.state.realizedPnl, unrealized: String(metrics.unrealizedPnl) });
    this.state.equity = this.state.equity.slice(-2000);
  }
}
