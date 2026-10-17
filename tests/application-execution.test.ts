import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application.js';
import { ResearchRunner } from '../src/research.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema } from '../src/paper/types.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Execution did not progress');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
describe('application quote to paper execution path', () => {
  it('responds to quote changes before polling and executes from WS without waiting for slow REST', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-fast-execution-'));
    const config = loadConfig({ DATA_DIR: dir, LOG_LEVEL: 'silent' });
    const app = new Application(config);
    let release!: () => void;
    const restPending = new Promise<void>(resolve => { release = resolve; });
    const feed = new DemoFeed(); feed.start('normal'); let latest = feed.snapshot();
    const pair = latest.pairs[0]!;
    const runner = new ResearchRunner(config, pino({ level: 'silent' }));
    vi.spyOn(runner, 'pair').mockReturnValue(pair);
    vi.spyOn(runner, 'decisionSnapshot').mockImplementation(() => ({ ...latest, at: Date.now() }));
    const rest = vi.spyOn(runner, 'refreshExecutionBooks').mockReturnValue(restPending);
    try {
      await app.open(false); app.observer = runner;
      app.engines.live.configure(paperSettingsSchema.parse({ minSecondsToEnd: 0, rejectProbability: 0, partialProbability: 0 }));
      app.engines.live.setRunning(true);
      const update = () => (app as unknown as { onBookUpdate: (ids: ReadonlySet<string>) => void }).onBookUpdate(new Set([pair.id]));
      const began = Date.now(); latest = feed.snapshot(); update();
      await until(() => app.engines.live.state.trades.length > 0);
      const trade = app.engines.live.state.trades[0]!;
      expect(trade.signalAt - began).toBeLessThan(200);
      // Keep the pre-arrival book unchanged: REST starts at arrival, but cannot
      // finish until after WS has already provided both post-arrival books.
      await until(() => rest.mock.calls.length > 0);
      expect(Date.now() - trade.executeAfter).toBeLessThan(180);
      latest = feed.snapshot();
      const poly = latest.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
      poly.asks = [{ price: '0.40', shares: '100' }]; poly.bids = [{ price: '0.39', shares: '100' }];
      const lm = latest.books.find(b => b.venue === 'limitless' && b.outcome === 'no')!;
      lm.asks = [{ price: '0.50', shares: '100' }]; lm.bids = [{ price: '0.48', shares: '100' }];
      update();
      await until(() => trade.status === 'OPEN');
      expect(trade.orders.map(o => o.limitPrice)).toEqual(['0.4', '0.5']);
      expect(rest).toHaveBeenCalledTimes(1);
      expect(trade.filledAt! - trade.executeAfter).toBeLessThan(180);
      const scheduled = app.engines.live.state.events.find(e => e.type === 'orders-scheduled');
      expect(scheduled?.details).toMatchObject({ configuredLatencyMs: 400, signalBooks: [{ receiptAgeMs: expect.any(Number) }, { receiptAgeMs: expect.any(Number) }] });
    } finally {
      release(); await app.close(); await rm(dir, { recursive: true, force: true });
    }
  }, 10000);
});
