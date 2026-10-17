import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { ResearchRunner } from '../src/research.js';
import { PublicAdapters, type Discovery } from '../src/adapters.js';
import { AdditionalSources } from '../src/additional-sources.js';
import { loadConfig } from '../src/config.js';
import { market, book } from './fixtures.js';
import { BookCache } from '../src/books.js';

afterEach(() => vi.restoreAllMocks());
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out waiting for observer progress'); await new Promise(r => setTimeout(r, 25)); }
}

describe('background catalogue and independent quote maintenance', () => {
  it('keeps newer WS quotes when a slow REST request fails and retains the successful opposite outcome', async () => {
    const runner = new ResearchRunner(loadConfig({ USE_WEBSOCKETS: 'false' }), pino({ level: 'silent' }), undefined, '', () => [], true);
    const cache = (runner as unknown as { cache: BookCache }).cache;
    const pm = market(), lm = market('limitless');
    const pair = { id: 'test', polymarket: pm, limitless: lm, score: 1, reasons: [], review: { approved: true, reasons: [] } };
    const original = book('polymarket', 'yes'); cache.set(original);
    let reject!: (reason: unknown) => void;
    const newer = { ...original, receivedAt: original.receivedAt + 10, sourceTimestamp: original.sourceTimestamp! + 10, transport: 'websocket' as const };
    vi.spyOn(PublicAdapters.prototype, 'polyBook').mockImplementation(async (_market, side) => {
      if (side === 'yes') return new Promise((_resolve, fail) => { reject = fail; });
      return book('polymarket', 'no');
    });
    vi.spyOn(PublicAdapters.prototype, 'limitlessBooks').mockResolvedValue([book('limitless', 'yes'), book('limitless', 'no')]);
    const refresh = runner.refreshExecutionBooks([pair]);
    cache.set(newer); reject(new TypeError('fetch failed'));
    await refresh;
    expect(cache.get('polymarket', pm.slug, 'yes')).toBe(newer);
    expect(cache.get('polymarket', pm.slug, 'no')).toBeDefined();
    runner.stop();
  });
  it('retries after an internet outage and clears the old error before the long global scan finishes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-network-recovery-')), reviewFile = path.join(dir, 'reviews.json');
    await writeFile(reviewFile, '[]');
    const pm = market(), lm = market('limitless');
    pm.endsAt = lm.endsAt = new Date(Date.now() + 3600000).toISOString(); lm.externalSlug = pm.slug;
    const found = { markets: [lm], pages: 1, truncated: false, skipped: 0, errors: [] };
    vi.spyOn(PublicAdapters.prototype, 'discoverLimitless').mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue(found);
    vi.spyOn(PublicAdapters.prototype, 'fillExternalMatches').mockResolvedValue({ markets: [pm], errors: [] });
    let release!: (value: Discovery) => void;
    vi.spyOn(PublicAdapters.prototype, 'discoverPoly').mockReturnValue(new Promise(resolve => { release = resolve; }));
    vi.spyOn(AdditionalSources.prototype, 'refresh').mockResolvedValue();
    vi.spyOn(PublicAdapters.prototype, 'polyBook').mockImplementation(async (_m, side) => ({ ...book('polymarket', side), receivedAt: Date.now(), sourceTimestamp: Date.now() }));
    vi.spyOn(PublicAdapters.prototype, 'limitlessBooks').mockImplementation(async () => ['yes', 'no'].map(side => ({ ...book('limitless', side as 'yes' | 'no'), receivedAt: Date.now(), sourceTimestamp: Date.now() })));
    const runner = new ResearchRunner(loadConfig({ DATA_DIR: dir, USE_WEBSOCKETS: 'false', LOG_LEVEL: 'silent' }), pino({ level: 'silent' }), undefined, reviewFile, () => [], true);
    let ended = false;
    const task = runner.run({ once: false }).finally(() => { ended = true; });
    try {
      await until(() => runner.lastDiscoveryError?.includes('fetch failed') === true);
      expect(runner.snapshot().ready).toBe(false); expect(ended).toBe(false);
      // Fast-forward the normal retry wait with the same manual wake used by UI.
      runner.requestDiscovery();
      await until(() => runner.catalogProgress.phase === 'polymarket');
      expect(runner.snapshot().ready).toBe(true); expect(runner.catalogProgress.complete).toBe(false);
      expect(runner.lastDiscoveryError).toBeNull(); expect(runner.liveHealth().catalogError).toBeNull();
      await until(() => runner.snapshot().books.length === 4);
      expect(ended).toBe(false);
    } finally {
      runner.stop(); release({ markets: [pm], pages: 1, truncated: false, skipped: 0, errors: [] });
      await task; await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
  it('refreshes books and reviews while the full global catalogue remains pending', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-background-')), reviewFile = path.join(dir, 'reviews.json');
    await writeFile(reviewFile, '[]');
    const pm = market(), lm = market('limitless'); pm.endsAt = lm.endsAt = new Date(Date.now() + 3600000).toISOString(); lm.externalSlug = pm.slug;
    const found = { markets: [lm], pages: 1, truncated: false, skipped: 0, errors: [] };
    const lmDiscovery = vi.spyOn(PublicAdapters.prototype, 'discoverLimitless').mockResolvedValue(found);
    const pm2 = { ...pm, slug: 'new-short-market' }, lm2 = { ...lm, slug: 'new-linked-market', externalSlug: pm2.slug };
    vi.spyOn(PublicAdapters.prototype, 'fillExternalMatches').mockResolvedValue({ markets: [pm, pm2], errors: [] });
    let release!: (value: Discovery) => void;
    vi.spyOn(PublicAdapters.prototype, 'discoverPoly').mockReturnValue(new Promise(resolve => { release = resolve; }));
    vi.spyOn(AdditionalSources.prototype, 'refresh').mockResolvedValue();
    const poly = vi.spyOn(PublicAdapters.prototype, 'polyBook').mockImplementation(async (_m, side) => ({ ...book('polymarket', side), receivedAt: Date.now(), sourceTimestamp: Date.now() }));
    vi.spyOn(PublicAdapters.prototype, 'limitlessBooks').mockImplementation(async () => ['yes', 'no'].map(side => ({ ...book('limitless', side as 'yes' | 'no'), receivedAt: Date.now(), sourceTimestamp: Date.now() })));
    const runner = new ResearchRunner(loadConfig({ DATA_DIR: dir, USE_WEBSOCKETS: 'false', LOG_LEVEL: 'silent', MAX_BOOK_AGE_MS: '250' }), pino({ level: 'silent' }), undefined, reviewFile, () => [], true);
    const task = runner.run({ once: false });
    try {
      await until(() => runner.catalogProgress.phase === 'polymarket');
      expect(runner.snapshot().ready).toBe(true); expect(runner.catalogProgress.complete).toBe(false);
      await writeFile(path.join(dir, 'stop-request.txt'), String(process.pid));
      await writeFile(reviewFile, JSON.stringify([{
        polymarketSlug: pm.slug, limitlessSlug: lm.slug, polymarketRulesHash: pm.rulesHash, limitlessRulesHash: lm.rulesHash,
        reviewedBy: 'test', reviewedAt: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 60000).toISOString(),
        samePositiveOutcome: true, resolutionSourceChecked: true, observationTimeChecked: true,
        thresholdAndEqualityChecked: true, cancellationRulesChecked: true, notes: 'Verified equivalence in this isolated test fixture.',
      }]));
      await until(() => runner.allPairs()[0]?.review.approved === true);
      await until(() => poly.mock.calls.length >= 4);
      expect(runner.catalogProgress.phase).toBe('polymarket'); expect(runner.snapshot().books).toHaveLength(4);
      expect(await readFile(path.join(dir, 'stop-request.txt'), 'utf8')).toBe(String(process.pid));
      lmDiscovery.mockResolvedValue({ ...found, markets: [lm, lm2] }); runner.requestDiscovery();
      await until(() => runner.allPairs().length === 2);
      expect(runner.catalogProgress.phase).toBe('polymarket');
      expect(runner.allPairs().some(p => p.polymarket.slug === pm2.slug)).toBe(true);
    } finally {
      runner.stop(); release({ markets: [pm], pages: 1, truncated: false, skipped: 0, errors: [] });
      await task; await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it('clears only the affected subscription group and removes obsolete token books', () => {
    const cache = new BookCache(), first = book(), second = { ...book(), slug: 'other-market', assetId: 'other-token' };
    cache.set(first); cache.set(second); cache.clearMarkets('polymarket', [first.slug]);
    expect(cache.get('polymarket', second.slug, 'yes')).toBe(second);
    cache.retainMarkets([{ ...market(), slug: second.slug, yesToken: 'changed-token' }]);
    expect(cache.get('polymarket', second.slug, 'yes')).toBeUndefined();
  });
});
