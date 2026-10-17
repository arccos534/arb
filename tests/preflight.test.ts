import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { loadConfig } from '../src/config.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema, type PaperSettings, type FeedSnapshot } from '../src/paper/types.js';
import { BookCache } from '../src/books.js';
import { PaperRepository, validateState } from '../src/paper/repository.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const start = Date.parse('2026-10-17T06:44:04Z');
function setup(settings: Partial<PaperSettings> = {}, change?: (snapshot: FeedSnapshot) => void) {
  const engine = new PaperEngine(initialState('demo', paperSettingsSchema.parse({ rejectProbability: 0, partialProbability: 0, ...settings }), start), loadConfig({}));
  const feed = new DemoFeed(); feed.start('normal', start);
  const snapshot = feed.snapshot(start); change?.(snapshot);
  engine.setRunning(true, start); engine.step(snapshot);
  expect(engine.state.trades).toHaveLength(1);
  return { engine, feed };
}
function assertCancelledWithoutPurchase(engine: PaperEngine) {
  const trade = engine.state.trades[0]!;
  expect(trade.status).toBe('CANCELLED'); expect(trade.filledAt).toBeNull();
  expect(trade.orders.every(o => o.status === 'CANCELLED' && o.reserve === '0' && o.cost === '0')).toBe(true);
  expect(engine.state.cash).toEqual({ polymarket: '100', limitless: '100', bybit: '0' });
  expect(engine.state.realizedPnl).toBe('0'); expect(engine.state.ledger).toHaveLength(0);
  expect(engine.state.events.some(e => e.type === 'order-filled' || e.type === 'position-sold')).toBe(false);
  const check = engine.state.events.find(e => e.type === 'execution-preflight');
  if (check) expect(check.details).toMatchObject({ passed: false });
  else expect(trade.orders[0]!.error).toContain('Истекло время');
}

describe('two-leg execution preflight', () => {
  it('executes stable quotes at 400ms and stores a read-only assessment before committing reservations', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    expect(Number(trade.maxExecutionCost)).toBeCloseTo(Number(trade.initialCost) * 1.005, 5);
    const snapshot = feed.snapshot(start + 400), cache = new BookCache(); snapshot.books.forEach(b => cache.set(b));
    const before = JSON.stringify(engine.state);
    expect(engine.assessExecution(trade, trade.pair, cache, snapshot.at).passed).toBe(true);
    expect(JSON.stringify(engine.state)).toBe(before);
    engine.step(snapshot); expect(trade.status).toBe('OPEN');
    expect(trade.execution).toMatchObject({ purchaseCost: trade.initialCost, actualLatencyMs: 400, postArrivalWaitMs: 0, reasons: [] });
  });

  it('offsets a more expensive Limitless leg with a cheaper Polymarket leg atomically', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    const oldLimit = trade.orders[1]!.limitPrice;
    const snapshot = feed.snapshot(start + 500);
    const poly = snapshot.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
    poly.asks = [{ price: '0.40', shares: '100' }]; poly.bids = [{ price: '0.39', shares: '100' }];
    const lm = snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
    lm.asks = [{ price: '0.50', shares: '100' }]; lm.bids = [{ price: '0.48', shares: '100' }];
    engine.step(snapshot);
    expect(trade.status).toBe('OPEN'); expect(Number(trade.orders[1]!.limitPrice)).toBeGreaterThan(Number(oldLimit));
    expect(trade.orders.map(o => o.limitPrice)).toEqual(['0.4', '0.5']);
    expect(Number(trade.execution!.purchaseCost)).toBeLessThan(Number(trade.initialCost));
    expect(trade.orders.every(o => o.status === 'FILLED' && o.reserve === '0')).toBe(true);
    expect(engine.state.ledger.filter(e => e.kind === 'buy')).toHaveLength(2);
  });

  it('enforces the total slippage budget even if the pair still has positive profit', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    const oldLimits = trade.orders.map(o => o.limitPrice), rng = engine.state.rng;
    const snapshot = feed.snapshot(start + 500);
    snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!.asks = [{ price: '0.49', shares: '100' }];
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
    expect(trade.execution?.reasons).toContain('pair-price-budget-exceeded');
    expect(Number(trade.execution!.purchaseCost)).toBeGreaterThan(Number(trade.maxExecutionCost));
    expect(trade.orders.map(o => o.limitPrice)).toEqual(oldLimits); expect(engine.state.rng).toBe(rng);
    expect(engine.metrics(snapshot)).toMatchObject({ cancelledBeforePurchase: 1, executionErrors: 0 });
  });

  it('rechecks cash after releasing only this attempts reservations', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    engine.state.cash.limitless = '14';
    engine.step(feed.snapshot(start + 500));
    expect(trade.status).toBe('CANCELLED'); expect(trade.execution?.reasons).toContain('limitless:available-budget-exceeded');
    expect(engine.state.cash.limitless).toBe('14'); expect(engine.state.ledger).toHaveLength(0);
  });

  it('does not release another pending attempts cash or exposure during repricing', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    const other = structuredClone(trade); other.id = 'other-pending'; other.executeAfter = start + 10000;
    other.orders.forEach(o => { o.reserve = '90'; }); engine.state.trades.push(other);
    const snapshot = feed.snapshot(start + 500), cache = new BookCache(); snapshot.books.forEach(b => cache.set(b));
    const check = engine.assessExecution(trade, trade.pair, cache, snapshot.at);
    expect(check.passed).toBe(false);
    expect(check.reasons).toContain('total-exposure-limit');
    expect(check.reasons).toContain('limitless:available-budget-exceeded');
    expect(other.orders.every(o => o.reserve === '90')).toBe(true); expect(engine.state.ledger).toHaveLength(0);
  });

  it('blocks a known exit risk before creating a trade and bounds repeated blocked counts', () => {
    const feed = new DemoFeed(); feed.start('normal', start);
    const engine = new PaperEngine(initialState('demo', paperSettingsSchema.parse({}), start), loadConfig({})); engine.setRunning(true, start);
    const bad = (at: number) => { const snapshot = feed.snapshot(at); snapshot.books.forEach(b => b.bids = [{ price: '0.01', shares: '100' }]); return snapshot; };
    engine.step(bad(start)); engine.step(bad(start + 500));
    expect(engine.state.trades).toHaveLength(0); expect(engine.state.entryDiagnostics?.blockedSignals).toBe(1);
    expect(engine.state.entryDiagnostics?.recent[0]?.reasons.join()).toContain('unhedged-loss-limit');
    expect(engine.state.events.some(e => e.type === 'orders-cancelled')).toBe(false); expect(engine.state.ledger).toHaveLength(0);
    engine.step(feed.snapshot(start + 1000)); expect(engine.state.trades).toHaveLength(1);
  });

  it('keeps the original price limits for legacy pending attempts', () => {
    const { engine, feed } = setup(), trade = engine.state.trades[0]!;
    delete trade.initialCost; delete trade.maxExecutionCost;
    const snapshot = feed.snapshot(start + 500);
    const poly = snapshot.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
    poly.asks = [{ price: '0.40', shares: '100' }]; poly.bids = [{ price: '0.39', shares: '100' }];
    snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!.asks = [{ price: '0.50', shares: '100' }];
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
    expect(trade.execution?.reasons).toContain('limitless:price-above-limit');
  });

  it('restores pair budgets and execution evidence without migrating legacy attempts', async () => {
    const { engine, feed } = setup(); engine.step(feed.snapshot(start + 500));
    const directory = await mkdtemp(path.join(tmpdir(), 'arb-pair-budget-'));
    try {
      const repo = new PaperRepository(directory, 'demo'); await repo.commit(engine.state, []);
      const restored = await new PaperRepository(directory, 'demo').open();
      expect(restored.trades[0]).toEqual(engine.state.trades[0]);
      expect(restored.running).toBe(false);
      const legacy = structuredClone(restored); delete legacy.trades[0]!.initialCost; delete legacy.trades[0]!.maxExecutionCost;
      expect(validateState(legacy, 'demo').trades[0]!.initialCost).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('cancels the 10.51% scenario when Limitless moves beyond the limit before buying Polymarket', () => {
    const { engine, feed } = setup({ maxExecutionWaitMs: 2500 }, snapshot => {
      const poly = snapshot.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
      poly.asks = [{ price: '0.16', shares: '187.5' }]; poly.bids = [{ price: '0.15', shares: '18.99' }];
      const lm = snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
      lm.asks = [{ price: '0.71', shares: '100' }]; lm.bids = [{ price: '0.69', shares: '100' }]; lm.tickSize = null;
    });
    expect(Number(engine.state.trades[0]!.expectedRoi)).toBeCloseTo(0.1051, 3);
    const snapshot = feed.snapshot(start + 1952);
    const poly = snapshot.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
    poly.asks = [{ price: '0.16', shares: '187.5' }]; poly.bids = [{ price: '0.15', shares: '18.99' }];
    const lm = snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
    lm.asks = [{ price: '0.84', shares: '100' }]; lm.bids = [{ price: '0.829', shares: '19' }]; lm.tickSize = null;
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
    expect(engine.available('polymarket').toString()).toBe('100');
    expect(engine.available('limitless').toString()).toBe('100');
    const event = engine.state.events.find(e => e.type === 'execution-preflight')!;
    expect(JSON.stringify(event.details)).toContain('0.84');
    expect(JSON.stringify(event.details)).toContain('0.71355');
  });

  it.each(['missing', 'empty', 'thin', 'minimum', 'asset'] as const)('does not buy either leg with a known %s Limitless book failure', failure => {
    const { engine, feed } = setup(); const snapshot = feed.snapshot(start + 500);
    const lm = snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
    if (failure === 'missing') { snapshot.books = snapshot.books.filter(b => b !== lm); snapshot.at = start + 11000; }
    if (failure === 'empty') lm.asks = [];
    if (failure === 'thin') lm.asks = [{ price: '0.48', shares: '1' }];
    if (failure === 'minimum') lm.minOrderShares = '100';
    if (failure === 'asset') lm.assetId = 'wrong-token';
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
  });

  it.each(['negative', 'below-minimum'] as const)('rechecks %s combined profitability inside both price limits', scenario => {
    const { engine, feed } = setup({ maxSlippage: 0.1, maxPositionCost: '12', maxUnhedgedLossUsd: '2' });
    const snapshot = feed.snapshot(start + 500);
    snapshot.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!.asks = [{ price: '0.45', shares: '100' }];
    snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!.asks = [{ price: scenario === 'negative' ? '0.52' : '0.50', shares: '100' }];
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
    expect(JSON.stringify(engine.state.events.find(e => e.type === 'execution-preflight')!.details)).toContain(scenario === 'negative' ? 'non-positive-execution-profit' : 'execution-roi-below-minimum');
  });

  it('rejects incompatible execution timestamps even when each book is fresh', () => {
    const { engine, feed } = setup(); const snapshot = feed.snapshot(start + 1500);
    const lm = snapshot.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
    lm.receivedAt = start + 500; lm.sourceTimestamp = start + 500;
    engine.step(snapshot); assertCancelledWithoutPurchase(engine);
    expect(JSON.stringify(engine.state.events.find(e => e.type === 'execution-preflight')!.details)).toContain('book-time-skew');
  });

  it('checks reserve and cash before either purchase', () => {
    const { engine, feed } = setup(); engine.state.trades[0]!.orders[1]!.reserve = '0.01';
    // Legacy pending orders keep their original individual reservations.
    delete engine.state.trades[0]!.initialCost; delete engine.state.trades[0]!.maxExecutionCost;
    engine.step(feed.snapshot(start + 500)); assertCancelledWithoutPurchase(engine);
    expect(JSON.stringify(engine.state.events.find(e => e.type === 'execution-preflight')!.details)).toContain('reserved-budget-exceeded');
  });

  it('still opens both legs and settles profitably when the conditions survive', () => {
    const { engine, feed } = setup(); engine.step(feed.snapshot(start + 500));
    expect(engine.state.trades[0]!.status).toBe('OPEN');
    const scheduled = engine.state.events.find(e => e.type === 'orders-scheduled')!;
    expect((scheduled.details as { orders: { status: string }[] }).orders.every(o => o.status === 'PENDING')).toBe(true);
    expect(engine.state.events.find(e => e.type === 'execution-preflight')?.details).toMatchObject({ passed: true });
    feed.resolutions(start + 17000).forEach(r => engine.resolve(r));
    expect(engine.state.trades[0]!.status).toBe('SETTLED'); expect(new Decimal(engine.state.realizedPnl).gt(0)).toBe(true);
  });
});
