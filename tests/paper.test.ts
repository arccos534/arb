import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { loadConfig } from '../src/config.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema, type FeedSnapshot } from '../src/paper/types.js';

const start = Date.parse('2026-10-17T00:00:00+10:00');
function setup(scenario: 'normal' | 'partial' | 'rejection' | 'delayed' | 'mismatch' = 'normal') {
  const settings = paperSettingsSchema.parse({ rejectProbability: 0, partialProbability: 0 });
  const engine = new PaperEngine(initialState('demo', settings, start), loadConfig({}));
  const feed = new DemoFeed(); feed.start(scenario, start); engine.setRunning(true, start);
  engine.step(feed.snapshot(start));
  engine.state.trades.forEach(t => t.notes.push(`scenario:${scenario}`));
  return { engine, feed };
}
const totalCash = (engine: PaperEngine) => Object.values(engine.state.cash).reduce((s, v) => s.plus(v), new Decimal(0));

describe('paper trading lifecycle', () => {
  it('reserves both sides once and executes against a later snapshot', () => {
    const {engine,feed} = setup();
    expect(engine.state.trades).toHaveLength(1); expect(engine.state.trades[0]?.status).toBe('SCHEDULED');
    expect(totalCash(engine).toString()).toBe('200'); expect(engine.available('polymarket').lt(100)).toBe(true);
    engine.step(feed.snapshot(start+200)); expect(engine.state.trades[0]?.status).toBe('SCHEDULED');
    engine.step(feed.snapshot(start+500)); expect(engine.state.trades[0]?.status).toBe('OPEN');
    expect(engine.state.trades[0]?.orders.every(o=>new Decimal(o.heldShares).gte(10))).toBe(true);
    for(let i=1;i<10;i++)engine.step(feed.snapshot(start+500+i*500));
    expect(engine.state.trades).toHaveLength(1);
    expect(totalCash(engine).lt(200)).toBe(true);
  });
  it('does not fill from the snapshot that existed before simulated arrival', () => {
    const {engine,feed} = setup(); const snapshot=feed.snapshot(start); snapshot.at=start+500;
    engine.step(snapshot); expect(engine.state.trades[0]?.status).toBe('SCHEDULED'); expect(totalCash(engine).toString()).toBe('200');
    snapshot.at=start+11000; engine.step(snapshot); expect(engine.state.trades[0]?.status).toBe('CANCELLED'); expect(totalCash(engine).toString()).toBe('200');
  });
  it('waits for final independent venue outcomes and never double-pays', () => {
    const {engine,feed}=setup(); engine.step(feed.snapshot(start+500)); engine.step(feed.snapshot(start+13000));
    expect(engine.state.trades[0]?.status).toBe('WAITING_RESOLUTION'); expect(engine.state.realizedPnl).toBe('0');
    const resolutions=feed.resolutions(start+17000);
    engine.resolve(resolutions[0]!); expect(engine.state.trades[0]?.status).toBe('WAITING_RESOLUTION');
    engine.resolve(resolutions[1]!); expect(engine.state.trades[0]?.status).toBe('SETTLED');
    const bank=totalCash(engine).toString(); resolutions.forEach(r=>engine.resolve(r)); expect(totalCash(engine).toString()).toBe(bank);
    expect(new Decimal(engine.state.realizedPnl).gt(0)).toBe(true);
    expect(totalCash(engine).minus(200).toString()).toBe(engine.state.realizedPnl);
  });
  it('records a loss when two purported hedges settle incompatibly', () => {
    const {engine,feed}=setup('mismatch'); engine.step(feed.snapshot(start+500)); feed.resolutions(start+17000).forEach(r=>engine.resolve(r));
    expect(engine.state.trades[0]?.status).toBe('SETTLED'); expect(new Decimal(engine.state.realizedPnl).lt(-9)).toBe(true);
    expect(totalCash(engine).minus(200).toString()).toBe(engine.state.realizedPnl);
  });
  it.each(['partial','rejection'] as const)('unwinds unmatched fills in the %s scenario with actual bid-side loss', scenario => {
    const {engine,feed}=setup(scenario); engine.step(feed.snapshot(start+500));
    expect(engine.state.trades[0]?.status).toBe('CLOSED');
    expect(engine.state.trades[0]?.orders.every(o=>o.heldShares==='0')).toBe(true);
    expect(new Decimal(engine.state.realizedPnl).lt(0)).toBe(true);
    expect(totalCash(engine).minus(200).toString()).toBe(engine.state.realizedPnl);
  });
  it('cancels before buying when known exit liquidity is missing', () => {
    const {engine,feed}=setup('rejection'); const snap=feed.snapshot(start+500); snap.books.forEach(b=>b.bids=[]);engine.step(snap);
    expect(engine.state.trades[0]?.status).toBe('CANCELLED');expect(engine.state.trades[0]?.orders.every(o=>o.heldShares==='0')).toBe(true);
    expect(engine.metrics(snap).positionsValue).toBe('0');
  });
  it('does not invent a payout when the resolution is delayed', () => {
    const {engine,feed}=setup('delayed'); engine.step(feed.snapshot(start+500)); engine.step(feed.snapshot(start+20000));
    expect(feed.resolutions(start+20000)).toHaveLength(0);expect(engine.state.trades[0]?.status).toBe('WAITING_RESOLUTION');expect(engine.state.realizedPnl).toBe('0');
  });
  it('cancels pending orders and releases reservations on pause', () => {
    const {engine}=setup();engine.setRunning(false,start+100);expect(engine.state.trades[0]?.status).toBe('CANCELLED');expect(engine.available('polymarket').toString()).toBe('100');
  });
  it('rejects a material rule change between signal and execution', () => {
    const {engine,feed}=setup();const snap=feed.snapshot(start+500);snap.pairs[0]!.polymarket.rulesHash='changed';engine.step(snap);
    expect(engine.state.trades[0]?.status).toBe('CANCELLED');expect(totalCash(engine).toString()).toBe('200');
  });
  it('does not use unreviewed pairs', () => {
    const {engine,feed}=setup();engine.state.trades=[];const snap=feed.snapshot(start);snap.pairs[0]!.review.approved=false;engine.step(snap);expect(engine.state.trades).toHaveLength(0);
  });
  it('allows unreviewed virtual entries only with explicit test override, including execution', () => {
    const {engine,feed}=setup(); engine.state.trades=[];
    engine.state.settings.skipManualReview=true;
    const snap=feed.snapshot(start); snap.pairs[0]!.review={approved:false,reasons:['manual-rules-review-required']};
    engine.step(snap);
    expect(engine.state.trades).toHaveLength(1);
    expect(engine.state.trades[0]?.notes).toContain('paper-only:manual-review-bypassed');
    expect(new Decimal(engine.state.trades[0]!.expectedRoi!).gt(0)).toBe(true);
    engine.step(feed.snapshot(start+500));
    expect(engine.state.trades[0]?.status).toBe('OPEN');
    expect(snap.pairs[0]?.review.approved).toBe(false);
  });
  it('keeps freshness, minimum ROI and rule-change checks with the override', () => {
    const {engine,feed}=setup(); engine.state.trades=[]; engine.state.settings.skipManualReview=true;
    const stale=feed.snapshot(start); stale.pairs[0]!.review.approved=false; stale.at=start+10000;
    engine.step(stale); expect(engine.state.trades).toHaveLength(0);
    engine.state.settings.minRoi=0.99;
    engine.step(feed.snapshot(start)); expect(engine.state.trades).toHaveLength(0);
    engine.state.settings.minRoi=0;
    engine.step(feed.snapshot(start)); expect(engine.state.trades).toHaveLength(1);
    const changed=feed.snapshot(start+500); changed.pairs[0]!.limitless.rulesHash='changed';
    engine.step(changed); expect(engine.state.trades[0]?.status).toBe('CANCELLED');
  });
  it('schedules the highest percentage opportunity first when slots are limited', () => {
    const {engine,feed}=setup(); engine.state.trades=[]; engine.state.settings.maxPositions=1;
    const snap=feed.snapshot(start), higher=structuredClone(snap.pairs[0]!);
    higher.id='higher-roi'; higher.polymarket.slug+='-high'; higher.limitless.slug+='-high';
    higher.limitless.externalSlug=higher.polymarket.slug;
    snap.pairs.push(higher);
    const books=snap.books.map(b=>({...structuredClone(b),slug:b.slug+'-high'}));
    books.find(b=>b.venue==='polymarket'&&b.outcome==='yes')!.asks=[{price:'0.4',shares:'100'}];
    books.find(b=>b.venue==='limitless'&&b.outcome==='no')!.asks=[{price:'0.4',shares:'100'}];
    books.filter(b=>(b.venue==='polymarket'&&b.outcome==='yes')||(b.venue==='limitless'&&b.outcome==='no')).forEach(b=>b.bids=[{price:'0.39',shares:'100'}]);
    snap.books.push(...books); engine.step(snap);
    expect(engine.state.trades).toHaveLength(1);
    expect(engine.state.trades[0]?.pairId).toBe('higher-roi');
  });
  it('limits scheduled positions and never over-reserves a small account', () => {
    const {engine,feed}=setup();engine.state.settings.maxPositions=1;
    const snapshot=feed.snapshot(start+100),second=structuredClone(snapshot.pairs[0]!);second.id='different-event';snapshot.pairs.push(second);engine.step(snapshot);
    expect(engine.state.trades).toHaveLength(1);expect(engine.available('polymarket').gte(0)).toBe(true);
    engine.state.trades=[];engine.state.cash.polymarket='5';engine.step(feed.snapshot(start+200));expect(engine.state.trades).toHaveLength(0);
  });
  it('waits for execution quotes instead of rejecting before a new snapshot arrives', () => {
    const {engine,feed}=setup(); const old=feed.snapshot(start); old.at=start+500;
    engine.step(old); expect(engine.state.trades[0]?.status).toBe('SCHEDULED');
    expect(totalCash(engine).toString()).toBe('200');
    engine.step(feed.snapshot(start+1000));
    expect(engine.state.trades[0]?.status).toBe('OPEN');
  });
  it('does not consume the observed live book when simulating fills', () => {
    const {engine,feed}=setup();const snapshot=feed.snapshot(start+500);
    const original=JSON.stringify(snapshot.books);engine.step(snapshot);
    expect(engine.state.trades[0]?.status).toBe('OPEN');
    expect(JSON.stringify(snapshot.books)).toBe(original);
  });
  it('bulk closes filled positions, cancels pending orders and pauses new entries', () => {
    const {engine,feed}=setup();engine.step(feed.snapshot(start+500));
    const pending=structuredClone(engine.state.trades[0]!);pending.id='pending';pending.status='SCHEDULED';
    pending.orders.forEach(o=>{o.status='PENDING';o.heldShares='0';o.reserve='1';});engine.state.trades.push(pending);
    expect(engine.closeAll(feed.snapshot(start+1000))).toEqual({requested:2,closed:1,cancelled:1,remaining:0});
    expect(engine.state.running).toBe(false);
    expect(engine.state.trades.every(t=>['CLOSED','CANCELLED'].includes(t.status))).toBe(true);
    expect(engine.available('polymarket').toString()).toBe(engine.state.cash.polymarket);
    expect(engine.closeAll(feed.snapshot(start+1500)).requested).toBe(0);
  });
  it('reports remaining positions when bulk exit has no liquidity', () => {
    const {engine,feed}=setup();engine.step(feed.snapshot(start+500));
    const snapshot=feed.snapshot(start+1000);snapshot.books.forEach(b=>b.bids=[]);
    expect(engine.closeAll(snapshot)).toEqual({requested:1,closed:0,cancelled:0,remaining:1});
    expect(engine.state.trades[0]?.orders.every(o=>new Decimal(o.heldShares).gt(0))).toBe(true);
    expect(engine.state.running).toBe(false);
  });
  it('halts new entries at the configured loss limit', () => {
    const {engine,feed}=setup('mismatch');engine.state.settings.lossLimit='1';engine.step(feed.snapshot(start+500));feed.resolutions(start+17000).forEach(r=>engine.resolve(r));engine.step(feed.snapshot(start+17500));
    expect(engine.state.running).toBe(false);expect(engine.state.haltReason).toContain('лимит');
  });
  it('tracks in-transit money and charges the modeled rebalance fee exactly once', () => {
    const {engine,feed}=setup();engine.step(feed.snapshot(start+500));feed.resolutions(start+17000).forEach(r=>engine.resolve(r));engine.setRunning(false,start+17000);
    const before=totalCash(engine);engine.rebalance(start+18000);expect(totalCash(engine).lt(before)).toBe(true);
    expect(new Decimal(String(engine.metrics(feed.snapshot(start+18000)).inTransit)).gt(0)).toBe(true);
    engine.step(feed.snapshot(start+22000));expect(new Decimal(engine.state.cash.bybit).gt(0)).toBe(true);
    engine.step(feed.snapshot(start+26000));expect(engine.state.transfers[0]?.status).toBe('COMPLETED');expect(engine.state.cash.bybit).toBe('0');
    expect(totalCash(engine).toString()).toBe(before.minus(engine.settings.rebalanceFee).toString());
    const after=totalCash(engine);engine.step(feed.snapshot(start+30000));expect(totalCash(engine).toString()).toBe(after.toString());
  });
  it('keeps stale liquidation values separate from realized P&L', () => {
    const {engine,feed}=setup();engine.step(feed.snapshot(start+500));const snapshot:FeedSnapshot=feed.snapshot(start+500);snapshot.at=start+10000;
    expect(engine.metrics(snapshot).positionsValue).toBe('0');expect(engine.state.realizedPnl).toBe('0');
  });
});
