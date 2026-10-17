import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { strategyProfile } from '../src/paper/profiles.js';
import { loadConfig } from '../src/config.js';
import { paperSettingsSchema, type PaperSettings } from '../src/paper/types.js';

const start = Date.parse('2026-10-17T07:00:00Z');
function setup(settings: Partial<PaperSettings> = {}) {
  const feed = new DemoFeed(); feed.start('normal', start);
  for (const market of [feed.snapshot(start).pairs[0]!.polymarket, feed.snapshot(start).pairs[0]!.limitless]) market.endsAt = new Date(start + 3600000).toISOString();
  const engine = new PaperEngine(initialState('demo', paperSettingsSchema.parse({ rejectProbability: 0, partialProbability: 0, ...settings }), start), loadConfig({}));
  engine.setRunning(true, start); engine.step(feed.snapshot(start)); return { engine, feed };
}

describe('capital and execution risk controls', () => {
  it('retries cancelled zero-cost attempts after cooldown with a bounded attempt count', () => {
    const { engine, feed } = setup();
    const cancel = (at: number) => { const snap = feed.snapshot(at); snap.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!.asks = []; engine.step(snap); };
    cancel(start + 500); engine.step(feed.snapshot(start + 1000)); expect(engine.state.trades).toHaveLength(1);
    engine.step(feed.snapshot(start + 15000)); expect(engine.state.trades).toHaveLength(2); cancel(start + 15500);
    engine.step(feed.snapshot(start + 30000)); expect(engine.state.trades).toHaveLength(3); cancel(start + 30500);
    engine.step(feed.snapshot(start + 45000)); expect(engine.state.trades).toHaveLength(3); expect(engine.state.ledger).toHaveLength(0);
  });
  it('never re-enters a funded event even after it was closed with a loss', () => {
    const { engine, feed } = setup(); engine.state.trades[0]!.notes.push('scenario:rejection');
    engine.step(feed.snapshot(start + 500)); expect(engine.state.trades[0]!.status).toBe('CLOSED');
    engine.step(feed.snapshot(start + 20000)); expect(engine.state.trades).toHaveLength(1);
    expect(engine.entryBlockers(feed.snapshot().pairs[0]!, start + 20000)).toContain('already-entered-session');
  });
  it('respects the aggregate exposure limit even with a free position slot', () => {
    const { engine } = setup({ maxTotalExposureUsd: '9' }); expect(engine.state.trades).toHaveLength(0);
  });
  it('cancels a late opportunity instead of filling it from newly arrived prices', () => {
    const { engine, feed } = setup(); engine.step(feed.snapshot(start + 2000));
    expect(engine.state.trades[0]!.status).toBe('CANCELLED'); expect(engine.state.ledger).toHaveLength(0);
  });
  it('refuses a profitable pair whose known emergency exit exceeds the loss allowance', () => {
    const { engine, feed } = setup(); const snapshot = feed.snapshot(start + 500);
    snapshot.books.forEach(b => b.bids = [{ price: '0.01', shares: '100' }]); engine.step(snapshot);
    expect(engine.state.trades[0]!.status).toBe('CANCELLED'); expect(engine.state.ledger).toHaveLength(0);
    expect(JSON.stringify(engine.state.events.find(e => e.type === 'execution-preflight')!.details)).toContain('unhedged-loss-limit');
  });
  it('subtracts modeled failure costs before the absolute profit gate', () => {
    const { engine, feed } = setup({ rejectProbability: 0.5, minProfitUsd: '0.4' });
    engine.step(feed.snapshot(start + 500)); expect(engine.state.trades).toHaveLength(0);
    expect(engine.state.entryDiagnostics?.blockedSignals).toBe(1);
    expect(engine.state.entryDiagnostics?.recent[0]?.reasons).toContain('risk-adjusted-profit-below-minimum');
    expect(engine.state.ledger).toHaveLength(0);
  });
  it('does not reuse shared bid depth in valuation or bulk liquidation', () => {
    const { engine, feed } = setup(); engine.step(feed.snapshot(start + 500));
    const second = structuredClone(engine.state.trades[0]!); second.id = 'another-position';
    for (const order of second.orders) engine.state.cash[order.venue] = new Decimal(engine.state.cash[order.venue]).minus(order.cost).toString();
    engine.state.trades.push(second);
    const snapshot = feed.snapshot(start + 1000); snapshot.books.forEach(b => b.bids = [{ price: b.bids[0]!.price, shares: '15' }]);
    const original = JSON.stringify(snapshot.books); expect(engine.metrics(snapshot).valuationComplete).toBe(false);
    expect(engine.closeAll(snapshot)).toEqual({ requested: 2, closed: 1, cancelled: 0, remaining: 1 });
    expect(second.orders.every(o => new Decimal(o.heldShares).gte(5))).toBe(true);
    expect(JSON.stringify(snapshot.books)).toBe(original);
  });
  it.each([200, 500] as const)('keeps the $%i profile coherent and supports the profitable synthetic lifecycle', bank => {
    const profile = strategyProfile(bank);
    expect(Number(profile.initialPerVenue) * 2).toBe(bank); expect(profile.skipManualReview).toBe(false);
    expect(Number(profile.maxTotalExposureUsd)).toBe(bank * .2); expect(Number(profile.lossLimit)).toBe(bank * .03);
    const { engine, feed } = setup(profile); engine.step(feed.snapshot(start + 500));
    expect(engine.state.trades[0]!.status).toBe('OPEN'); feed.resolutions(start + 17000).forEach(r => engine.resolve(r));
    expect(engine.state.trades[0]!.status).toBe('SETTLED'); expect(Number(engine.state.realizedPnl)).toBeGreaterThan(0);
  });
  it('applies a changed RNG seed when settings are saved', () => {
    const { engine } = setup(); engine.setRunning(false, start + 100);
    engine.configure({ ...engine.settings, seed: 123 }); expect(engine.state.rng).toBe(123);
  });
});
