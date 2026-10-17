import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { ResearchRunner } from '../src/research.js';
import { PublicAdapters } from '../src/adapters.js';
import { BookCache } from '../src/books.js';
import { DemoFeed } from '../src/paper/demo.js';
import { loadConfig } from '../src/config.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const runner = new ResearchRunner(loadConfig({}), pino({ level: 'silent' }));
  const internals = runner as unknown as { cache: BookCache; adapters: PublicAdapters };
  const demo = new DemoFeed(); demo.start('normal'); const feed = demo.snapshot();
  feed.books.forEach(b => internals.cache.set(b));
  return { runner, ...internals, feed, pair: feed.pairs[0]! };
}
describe('execution REST selection', () => {
  it('uses fresh WS without any REST and refreshes only the missing Poly outcome', async () => {
    const { runner, adapters, cache, feed, pair } = fixture();
    const poly = vi.spyOn(adapters, 'polyBook').mockImplementation(async (_m, side) => feed.books.find(b => b.venue === 'polymarket' && b.outcome === side)!);
    const lm = vi.spyOn(adapters, 'limitlessBooks').mockResolvedValue([]);
    await runner.refreshExecutionBooks([pair]);
    expect(poly).not.toHaveBeenCalled(); expect(lm).not.toHaveBeenCalled();
    cache.delete('polymarket', pair.polymarket.slug, 'yes');
    await runner.refreshExecutionBooks([pair]);
    expect(poly).toHaveBeenCalledTimes(1); expect(poly.mock.calls[0]![1]).toBe('yes'); expect(lm).not.toHaveBeenCalled();
  });
  it('shares requests and bounds retries when REST returns a pre-arrival snapshot', async () => {
    const { runner, adapters, feed, pair } = fixture();
    const book = feed.books.find(b => b.venue === 'polymarket' && b.outcome === 'yes')!;
    const poly = vi.spyOn(adapters, 'polyBook').mockResolvedValue(book);
    const required = [{ venue: book.venue, slug: book.slug, outcome: book.outcome, assetId: book.assetId, after: book.receivedAt + 1 }];
    await Promise.all([runner.refreshExecutionBooks([pair], required), runner.refreshExecutionBooks([pair], required)]);
    await runner.refreshExecutionBooks([pair], required);
    expect(poly).toHaveBeenCalledTimes(1);
  });
});
