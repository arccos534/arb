import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BookCache, limitlessBooks } from '../src/books.js';
import { LimitlessStreamState, PublicStreams } from '../src/streams.js';
import { ResearchRunner } from '../src/research.js';
import { loadConfig } from '../src/config.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema } from '../src/paper/types.js';
import { book, market, pair, now } from './fixtures.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Application } from '../src/application.js';

describe('incremental market processing', () => {
  it('serves only ten cached rows from a large catalogue without evaluating it during HTTP reads', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'arb-view-fairness-'));
    const app = new Application(loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'silent' }));
    const runner = new ResearchRunner(app.config, pino({ level: 'silent' }));
    const demo = new DemoFeed(); demo.start('normal'); const feed = demo.snapshot();
    const pairs = Array.from({ length: 1000 }, (_, i) => ({ ...feed.pairs[0]!, id: `ui-${i}` }));
    vi.spyOn(runner, 'allPairs').mockReturnValue(pairs);
    vi.spyOn(runner, 'decisionSnapshot').mockReturnValue({ ...feed, pairs });
    try {
      await app.open(false); app.observer = runner;
      app.marketDatabase.catalog(pairs);await app.marketDatabase.settle();
      const evaluate=vi.spyOn(app.engines.live,'evaluate');
      let callbackRan = false; setImmediate(() => { callbackRan = true; });
      const view = await app.view('live') as { candidates: unknown[] };
      expect(callbackRan).toBe(true); expect(view.candidates).toHaveLength(10);expect(evaluate).not.toHaveBeenCalled();
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); }
  });
  it('derives sorted complementary books from unordered raw levels without sharing mutable arrays', () => {
    const [yes, no] = limitlessBooks({ asks: [{ price: '0.7', size: 2000000 }, { price: '0.6', size: 1500000 }, { price: '0.8', size: 0 }], bids: [{ price: '0.3', size: 3000000 }, { price: '0.4', size: 4000000 }] }, market('limitless'));
    expect(yes!.asks).toEqual([{ price: '0.6', shares: '1.5' }, { price: '0.7', shares: '2' }]);
    expect(no!.bids).toEqual([{ price: '0.4', shares: '1.5' }, { price: '0.3', shares: '2' }]);
    expect(no!.asks.map(l => l.price)).toEqual(['0.6', '0.7']);
    yes!.asks = [];
    expect(no!.bids).toHaveLength(2);
    expect(() => limitlessBooks({ asks: [{ price: '0.5', size: '1.1' }], bids: [] }, market('limitless'))).toThrow('Non-integer');
  });
  it('lazily copies only accessed book wrappers and isolates virtual liquidity consumption', () => {
    const parent = new BookCache();
    for (let i = 0; i < 1000; i++) parent.set({ ...book(), slug: `market-${i}` });
    const local = parent.fork(); expect(local.size).toBe(0);
    local.get('polymarket', 'market-9', 'yes')!.asks = [];
    expect(local.size).toBe(1); expect(parent.get('polymarket', 'market-9', 'yes')!.asks).toHaveLength(1);
    local.delete('polymarket', 'market-10', 'yes'); expect(local.get('polymarket', 'market-10', 'yes')).toBeUndefined();
    expect(parent.get('polymarket', 'market-10', 'yes')).toBeDefined();
  });
  it('builds a targeted decision feed without traversing any book, retaining active pairs', () => {
    const active = { ...pair(), id: 'active' }, changed = { ...pair(), id: 'changed' };
    const runner = new ResearchRunner(loadConfig({}), pino({ level: 'silent' }), undefined, 'unused', () => [active]);
    const internals = runner as unknown as { pairIndex: Map<string, ReturnType<typeof pair>>; cache: BookCache; discoveryReady: boolean };
    internals.pairIndex.set(active.id, active); internals.pairIndex.set(changed.id, changed); internals.discoveryReady = true;
    const read = vi.spyOn(internals.cache, 'get');
    const snapshot = runner.decisionSnapshot(new Set([changed.id]));
    expect(snapshot.pairs.map(p => p.id)).toEqual(['changed', 'active']); expect(snapshot.books).toEqual([]);
    expect(snapshot.bookCache).toBe(internals.cache); expect(read).not.toHaveBeenCalled();
  });
  it('executes identically with shared public books while keeping the public feed intact', () => {
    const demo = new DemoFeed(); demo.start('normal', now);
    const settings = paperSettingsSchema.parse({ minSecondsToEnd: 0, rejectProbability: 0, partialProbability: 0 });
    const standard = new PaperEngine(initialState('demo', settings, now), loadConfig({}));
    const incremental = new PaperEngine(initialState('demo', settings, now), loadConfig({}));
    standard.setRunning(true, now); incremental.setRunning(true, now);
    for (const at of [now, now + 500]) {
      const snapshot = demo.snapshot(at), cache = new BookCache(); snapshot.books.forEach(b => cache.set(b));
      const original = JSON.stringify(snapshot.books);
      standard.step(snapshot); incremental.step({ ...snapshot, books: [], bookCache: cache });
      expect(JSON.stringify(snapshot.books)).toBe(original);
    }
    expect(incremental.state.cash).toEqual(standard.state.cash);
    expect(incremental.state.trades[0]!.status).toBe('OPEN');
    const summarize = (engine: PaperEngine) => engine.state.trades[0]!.orders.map(o => ({ cost: o.cost, shares: o.netShares, fee: o.cashFee, limit: o.limitPrice }));
    expect(summarize(incremental)).toEqual(summarize(standard));
  });
  it('invalidates a restarted Limitless publisher and accepts a resynchronized snapshot', () => {
    const cache = new BookCache(), m = market('limitless'), state = new LimitlessStreamState([m], cache);
    const frame = (version: number, at: number, price = '0.5') => ({ marketSlug: m.slug, version, timestamp: at, orderbook: { bids: [], asks: [{ price, size: 10000000 }] } });
    state.apply(frame(100, now), now);
    state.apply(frame(99, now - 1), now + 1); expect(cache.get('limitless', m.slug, 'yes')).toBeDefined();
    state.apply(frame(0, now + 1), now + 1); expect(cache.get('limitless', m.slug, 'yes')).toBeDefined();
    expect(() => state.apply(frame(1, now + 2), now + 2)).toThrow('resync required');
    expect(cache.get('limitless', m.slug, 'yes')).toBeUndefined();
    new LimitlessStreamState([m], cache).apply(frame(1, now + 3, '0.4'), now + 3);
    expect(cache.get('limitless', m.slug, 'yes')!.asks[0]!.price).toBe('0.4');
  });
  it('keeps unaffected stream connections and cached books when the catalogue expands', () => {
    vi.useFakeTimers();
    const prototype = PublicStreams.prototype as unknown as { connectPoly: () => void; connectLimitless: () => void };
    const connect = vi.spyOn(prototype, 'connectPoly').mockImplementation(() => {});
    vi.spyOn(prototype, 'connectLimitless').mockImplementation(() => {});
    const markets = Array.from({ length: 205 }, (_, i) => ({ ...market(), slug: `market-${i}` }));
    const cache = new BookCache(), stream = new PublicStreams(markets, [], cache, pino({ level: 'silent' }));
    try {
      stream.start(); vi.runAllTimers(); expect(connect).toHaveBeenCalledTimes(3);
      const first = connect.mock.contexts[0]; cache.set({ ...book(), slug: 'market-0' });
      stream.update([...markets, { ...market(), slug: 'new-market' }], []); vi.runAllTimers();
      expect(connect).toHaveBeenCalledTimes(4); expect(connect.mock.contexts[0]).toBe(first);
      expect(cache.get('polymarket', 'market-0', 'yes')).toBeDefined();
      stream.update(markets.map(m => m.slug === 'market-0' ? { ...m, rulesHash: 'changed' } : m), []); vi.runAllTimers();
      expect(cache.get('polymarket', 'market-0', 'yes')).toBeUndefined();
    } finally { stream.stop(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });
});
