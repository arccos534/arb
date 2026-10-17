import { afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionScheduler } from '../src/decision-scheduler.js';
import { BookCache } from '../src/books.js';
import { book } from './fixtures.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema } from '../src/paper/types.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.useRealTimers());
describe('event driven execution scheduling', () => {
  it('coalesces bursts and retains updates received during a durable commit', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const decide = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
    const scheduler = new DecisionScheduler(decide, error => { throw error; });
    scheduler.request(['a']); scheduler.request(['b']);
    await vi.advanceTimersByTimeAsync(5);
    expect([...decide.mock.calls[0]![0]]).toEqual(['a', 'b']);
    scheduler.request(['c']); scheduler.request(['d']);
    await vi.advanceTimersByTimeAsync(30); expect(decide).toHaveBeenCalledTimes(1);
    finish(); await scheduler.drain(); await vi.advanceTimersByTimeAsync(5);
    expect([...decide.mock.calls[1]![0]]).toEqual(['c', 'd']); scheduler.stop();
  });
  it('wakes at the order arrival instead of the next 250ms interval and cancels timers on stop', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const decide = vi.fn().mockResolvedValue(undefined);
    const scheduler = new DecisionScheduler(decide, error => { throw error; });
    scheduler.wakeAt(1400); await vi.advanceTimersByTimeAsync(404); expect(decide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(decide).toHaveBeenCalledTimes(1);
    expect([...decide.mock.calls[0]![0]]).toEqual([]);
    scheduler.request(['queued']); scheduler.wakeAt(1500); scheduler.stop();
    await vi.advanceTimersByTimeAsync(1000); expect(decide).toHaveBeenCalledTimes(1);
  });
  it('notifies only for accepted book updates, never for older arrivals or source timestamps', () => {
    const notify = vi.fn(), cache = new BookCache(notify), first = book();
    cache.set(first); cache.set({ ...first, receivedAt: first.receivedAt - 1 });
    cache.set({ ...first, receivedAt: first.receivedAt + 1, sourceTimestamp: first.sourceTimestamp! - 1 });
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it('captures a brief opportunity with the same 400ms simulated latency that periodic polling misses', async () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-17T06:44:04Z'); vi.setSystemTime(start);
    const settings = paperSettingsSchema.parse({ latencyMs: 400, rejectProbability: 0, partialProbability: 0 });
    const slow = new PaperEngine(initialState('demo', settings, start), loadConfig({}));
    const fast = new PaperEngine(initialState('demo', settings, start), loadConfig({}));
    const feed = new DemoFeed(); feed.start('normal', start);
    slow.setRunning(true, start); fast.setRunning(true, start);
    let latest = feed.snapshot(start);
    const id = latest.pairs[0]!.id;
    const makeExpensive = () => { latest.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!.asks = [{ price: '0.68', shares: '100' }]; };
    makeExpensive();
    let scheduler!: DecisionScheduler;
    scheduler = new DecisionScheduler(async ids => {
      fast.step({ ...latest, at: Date.now() }, ids);
      const pending = fast.state.trades.find(t => t.status === 'SCHEDULED');
      scheduler.wakeAt(pending && pending.executeAfter > Date.now() ? pending.executeAfter : null);
    }, error => { throw error; });
    const poll = setInterval(() => slow.step({ ...latest, at: Date.now() }), 250);
    for (const at of [30, 440, 480, 700]) setTimeout(() => {
      latest = feed.snapshot(Date.now()); if (at >= 480) makeExpensive();
      scheduler.request([id]);
    }, at);
    await vi.advanceTimersByTimeAsync(800);
    expect(fast.state.trades[0]?.status).toBe('OPEN');
    expect(fast.state.trades[0]!.filledAt! - fast.state.trades[0]!.signalAt).toBeLessThanOrEqual(415);
    expect(slow.state.trades[0]?.status).toBe('CANCELLED');
    expect(slow.state.cash).toEqual({ polymarket: '100', limitless: '100', bybit: '0' });
    clearInterval(poll); scheduler.stop();
  });
});
