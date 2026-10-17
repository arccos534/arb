import { performance } from 'node:perf_hooks';
import { profiler } from './profiling.js';
import type { Logger } from 'pino';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { PublicAdapters, type Discovery } from './adapters.js';
import { BookCache } from './books.js';
import { evaluate } from './engine.js';
import { PublicHttp, mapLimit } from './http.js';
import { loadApprovals, matchMarkets, reviewPair, counterpartFilter } from './matching.js';
import type { Book, Evaluation, Market, Pair } from './domain.js';
import { ResearchStorage } from './storage.js';
import { PublicStreams } from './streams.js';
import type { FeedSnapshot } from './paper/types.js';
import { AdditionalSources } from './additional-sources.js';

export class ResearchRunner {
  private readonly bookRequests = new Map<string, Promise<void>>();
  private readonly bookRequestAt = new Map<string, number>();
  readonly catalogProgress = { phase: 'starting', complete: false,
    polymarket: { pages: 0, scanned: 0, eligible: 0 }, limitless: { pages: 0, scanned: 0, eligible: 0 } };
  catalogCoverage: Record<string, unknown> | null = null;
  lastDiscoveryError: string | null = null;
  readonly additionalSources: AdditionalSources;
  private readonly http: PublicHttp;
  private readonly adapters: PublicAdapters;
  private readonly cache: BookCache;
  private readonly pairIndex = new Map<string, Pair>();
  private readonly marketPairs = new Map<string, Set<string>>();
  private readonly store: ResearchStorage;
  private streams: PublicStreams | undefined;
  private pairs: Pair[] = [];
  private watch: Pair[] = [];
  private stopped = false;
  private nextDiscovery = 0;
  private nextRest = 0;
  private wake: (() => void) | undefined;
  private cycles = 0;
  private nextSnapshot = 0;
  private restCursor = 0;
  private discoveryReady = false;
  private discoveryTask: Promise<void> | undefined;
  private restTask: Promise<void> | undefined;
  private linkedRefreshTask: Promise<void> | undefined;
  private nextLinkedRefresh = 0;
  private latestLimitless: Discovery | undefined;
  private publication: Promise<void> = Promise.resolve();
  private linkedRefreshAt: string | null = null;
  private linkedRefreshError: string | null = null;
  private rescanRequested = false;
  private backgroundError: unknown;
  private readonly savedMarketRules = new Set<string>();
  private readonly startedAt = new Date().toISOString();

  constructor(private readonly config: Config, private readonly logger: Logger, private readonly diagnostic?: (category: string, payload: unknown) => void, private readonly reviewsPath = 'config/pairs.json', private readonly pinnedPairs: () => Pair[] = () => [], private readonly tradesOnlyLogging = false, onBookUpdate?: (pairs: ReadonlySet<string>, receivedMono?: number) => void, private readonly hooks?: { book?: (book: Book) => void; invalidate?: (key: string) => void; catalog?: (pairs:Pair[],complete:boolean)=>void }) {
    this.cache = new BookCache(book => {
      hooks?.book?.(book);
      const pairs = this.marketPairs.get(`${book.venue}:${book.slug}`);
      if (pairs?.size) onBookUpdate?.(pairs, book.receivedMono);
    }, key => { hooks?.invalidate?.(key); const ids=this.marketPairs.get(key.slice(0,key.lastIndexOf(':'))); if(ids?.size)onBookUpdate?.(ids); });
    this.http = new PublicHttp(config.REQUEST_TIMEOUT_MS, diagnostic, config.MIN_HTTP_INTERVAL_MS);
    this.additionalSources = new AdditionalSources(this.http, diagnostic);
    this.adapters = new PublicAdapters(this.http, config, (venue, progress) => { this.catalogProgress[venue] = progress; }, () => this.stopped);
    this.store = new ResearchStorage(config, !tradesOnlyLogging);
  }

  stop(): void { this.stopped = true; this.streams?.stop(); this.wake?.(); }
  requestDiscovery(): void { this.nextDiscovery = 0; this.nextLinkedRefresh = 0; if (this.discoveryTask) this.rescanRequested = true; this.wake?.(); }
  snapshot(copyBooks = true): FeedSnapshot {
    const profileStart = profiler.start();
    try {
    const books: Book[] = [];
    const seen = new Set<string>();
    for (const pair of this.watch) for (const market of [pair.polymarket, pair.limitless]) for (const outcome of ['yes', 'no']) {
      const key = `${market.venue}:${market.slug}:${outcome}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const book = this.cache.get(market.venue, market.slug, outcome);
      if (book) books.push(copyBooks ? structuredClone(book) : book);
    }
    return { at: Date.now(), pairs: this.watch, books, ready: this.discoveryReady };
    } finally { profiler.end('snapshot', profileStart); }
  }
  allPairs(): Pair[] { return this.pairs; }
  decisionSnapshot(changedPairIds?: ReadonlySet<string>): FeedSnapshot {
    let pairs = this.watch;
    if (changedPairIds) {
      const ids = new Set(changedPairIds);
      for (const pair of this.pinnedPairs()) ids.add(pair.id);
      pairs = [...ids].map(id => this.pairIndex.get(id)).filter((pair): pair is Pair => pair !== undefined);
    }
    return { at: Date.now(), pairs, books: [], ready: this.discoveryReady, bookCache: this.cache, bookCount: this.cache.size };
  }
  pair(id: string): Pair | undefined { return this.pairIndex.get(id); }
  liveHealth() { return { ready: this.discoveryReady, phase: this.catalogProgress.phase, cycles: this.cycles,
    catalogRetrying: Boolean(this.discoveryTask || this.linkedRefreshTask), catalogError: this.lastDiscoveryError,
    linkedRefreshAt: this.linkedRefreshAt, linkedRefreshError: this.linkedRefreshError,
    streams: this.streams?.health ?? null, discoveredPairs: this.pairs.length, watchedPairs: this.watch.length }; }
  async refreshExecutionBooks(pairs: Pair[], requirements?: { venue: string; slug: string; outcome: 'yes' | 'no'; assetId: string; after: number }[], maxAgeMs = this.config.MAX_BOOK_AGE_MS): Promise<void> {
    if (this.stopped) return;
    const markets = [...new Map(pairs.flatMap(p => [p.polymarket, p.limitless]).map(m => [`${m.venue}:${m.slug}`, m])).values()];
    const now = Date.now();
    await mapLimit(markets, 2, async market => {
      const needed = (['yes', 'no'] as const).filter(side => {
        const required = requirements?.filter(r => r.venue === market.venue && r.slug === market.slug && r.outcome === side);
        if (required && !required.length) return false;
        const b = this.cache.get(market.venue, market.slug, side);
        return !b || b.assetId !== (side === 'yes' ? market.yesToken : market.noToken) ||
          required?.some(r => b.assetId !== r.assetId || b.receivedAt < r.after) ||
          now - b.receivedAt > maxAgeMs || b.receivedAt > now + 1000 ||
          (b.sourceTimestamp !== null && (now - b.sourceTimestamp > maxAgeMs || b.sourceTimestamp > now + 1000));
      });
      if (!needed.length) return;
      await this.refreshBooks([market], needed);
    });
  }

  async run(options: { once: boolean; durationSeconds?: number }): Promise<void> {
    const deadline = options.durationSeconds === undefined ? Infinity : Date.now() + options.durationSeconds * 1000;
    try {
      await this.store.open();
      await this.store.event('run-started', { mode: 'research', websocket: this.config.USE_WEBSOCKETS, pid: process.pid });
      await this.store.latest('health', { at: this.startedAt, startedAt: this.startedAt, pid: process.pid, ready: false, mode: 'research', phase: 'initial-discovery' });
      while (!this.stopped && Date.now() < deadline) {
        // The HTTP server owns the application's stop file. A background
        // observer must not consume it and leave the server running forever.
        if (!this.tradesOnlyLogging && await this.localStopRequested()) break;
        if (this.backgroundError) throw this.backgroundError;
        if (!this.discoveryTask && Date.now() >= this.nextDiscovery) {
          this.discoveryTask = (async () => {
          let discoveryOk = true;
          try { await this.discover(); this.lastDiscoveryError = null; }
          catch (e) {
            if (this.stopped) return;
            discoveryOk = false;
            this.lastDiscoveryError = String(e);
            this.catalogProgress.phase = 'failed'; this.catalogProgress.complete = false;
            // A failed full catalogue walk must not erase already discovered
            // provider-linked pairs. Their own freshness and expiry checks apply.
            if (!this.watch.length) {
              this.discoveryReady = false;
              this.streams?.stop(); this.streams = undefined;
              this.cache.clear(); this.pairs = []; this.watch = [];
            }
            this.logger.error({ err: String(e), retainedPairs: this.watch.length }, 'Catalogue incomplete; existing feeds retained when available');
            await this.store.event('discovery-error', { error: String(e) });
          }
          this.nextDiscovery = this.rescanRequested ? 0 : Date.now() + (discoveryOk ? this.config.DISCOVERY_INTERVAL_SECONDS * 1000 : this.lastDiscoveryError?.includes('429') ? 60000 : 30000);
          this.rescanRequested = false;
          })().catch(error => { this.backgroundError = error; }).finally(() => { this.discoveryTask = undefined; });
          if (options.once) await this.discoveryTask;
        }
        if (this.stopped) break;
        if (!options.once && this.discoveryTask && this.catalogProgress.phase === 'polymarket' && !this.linkedRefreshTask && Date.now() >= this.nextLinkedRefresh) {
          this.linkedRefreshTask = this.refreshLinked().catch(error => {
            if (!this.stopped) this.linkedRefreshError = String(error);
          }).finally(() => { this.nextLinkedRefresh = Date.now() + Math.min(60000, this.config.DISCOVERY_INTERVAL_SECONDS * 1000); this.linkedRefreshTask = undefined; });
        }
        if (!this.restTask && Date.now() >= this.nextRest) {
          this.restTask = this.refreshBooks().catch(error => { this.backgroundError = error; }).finally(() => {
            this.nextRest = Date.now() + Math.min(this.config.REST_REFRESH_SECONDS * 1000, this.config.MAX_BOOK_AGE_MS); this.restTask = undefined;
          });
          if (options.once) await this.restTask;
        }
        // Reload reviews every cycle, and fail closed if the file becomes invalid.
        const approvals = await loadApprovals(this.reviewsPath);
        this.pairs = this.pairs.map(p => ({ ...p, review: reviewPair(p.polymarket, p.limitless, approvals) }));
        const currentPairs = new Map(this.pairs.map(p => [p.id, p]));
        this.watch = this.watch.map(p => currentPairs.get(p.id) ?? { ...p, review: reviewPair(p.polymarket, p.limitless, approvals) });
        for (const pair of this.watch) this.pairIndex.set(pair.id, pair);
        const evaluations = this.tradesOnlyLogging ? [] : this.watch.flatMap(p => evaluate(p, this.cache, this.config));
        this.diagnostic?.('research-evaluations', { at: Date.now(), evaluations });
        const snapshots: Book[] = [];
        const seen = new Set<string>();
        for (const pair of this.watch) for (const market of [pair.polymarket, pair.limitless]) for (const outcome of ['yes', 'no']) {
          const key = `${market.venue}:${market.slug}:${outcome}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const book = this.cache.get(market.venue, market.slug, outcome);
          if (book) snapshots.push(book);
        }
        const at = new Date().toISOString();
        const includeSnapshots = Date.now() >= this.nextSnapshot;
        await this.store.event('observation', {
          at, evaluations,
          // Bounded depth and sampling keep research data practical on a 30 GB VPS.
          snapshotDepthLimit: 20,
          snapshots: includeSnapshots ? snapshots.map(b => ({ ...b, asks: b.asks.slice(0, 20), bids: b.bids.slice(0, 20) })) : [],
        });
        if (includeSnapshots) this.nextSnapshot = Date.now() + this.config.SNAPSHOT_INTERVAL_SECONDS * 1000;
        await this.store.latest('evaluations', { at, mode: 'research', evaluations });
        const counts = this.counts(evaluations);
        await this.store.latest('health', {
          at, startedAt: this.startedAt, pid: process.pid, mode: 'research', ready: this.discoveryReady, cycles: ++this.cycles, discoveredPairs: this.pairs.length, watchedPairs: this.watch.length,
          memoryRssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          ...counts, streams: this.streams?.health ?? null, requests: this.http.metrics.slice(-100),
          note: 'No order, wallet, or withdrawal code is present. Observations do not represent executed trades.',
        });
        if (!this.tradesOnlyLogging) this.logger.info({ watchedPairs: this.watch.length, ...counts }, 'Research observation saved');
        if (options.once) {
          if (this.lastDiscoveryError || this.backgroundError) throw new Error(`Scan failed: ${String(this.lastDiscoveryError ?? this.backgroundError)}`);
          break;
        }
        await this.pause(Math.min(this.tradesOnlyLogging ? 1000 : 5000, Math.max(0, deadline - Date.now())));
      }
    } finally {
      this.stopped = true; this.discoveryReady = false;
      this.streams?.stop();
      await Promise.allSettled([this.discoveryTask, this.restTask, this.linkedRefreshTask].filter((task): task is Promise<void> => Boolean(task)));
      await this.store.close();
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }

  private async localStopRequested(): Promise<boolean> {
    const filename = path.resolve(this.config.DATA_DIR, 'stop-request.txt');
    try {
      const pid = (await readFile(filename, 'utf8')).trim();
      if (pid !== String(process.pid)) return false;
      await unlink(filename);
      this.logger.info('Local stop requested');
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  private async discover(): Promise<void> {
    await this.linkedRefreshTask;
    if (this.stopped) return;
    this.catalogProgress.complete = false; this.catalogProgress.phase = 'limitless';
    const approvals = await loadApprovals(this.reviewsPath);
    const results = await Promise.allSettled([this.adapters.discoverLimitless(), this.additionalSources.refresh()]);
    const lmResult = results[0]!;
    if (lmResult.status === 'rejected') {
      throw new Error(results.filter(r => r.status === 'rejected').map(r => String(r.reason)).join('; '));
    }
    const lm = lmResult.value;
    this.latestLimitless = lm;
    // Bring verified provider-linked candidates online before the potentially
    // long full Polymarket catalogue walk. UI explicitly marks this as partial.
    this.catalogProgress.phase = 'linked-lookups';
    const seeded = await this.adapters.fillExternalMatches([], lm.markets);
    if (this.stopped) return;
    await this.publishDiscovery({ markets: [], pages: 0, truncated: true, skipped: 0, errors: [] }, lm, seeded, approvals);
    // A successful fresh linked catalogue proves that discovery has recovered.
    // Do not keep an old outage banner for the entire global Polymarket walk;
    // completeness of that walk is reported independently in catalogProgress.
    if (!seeded.errors.length) this.lastDiscoveryError = null;
    this.linkedRefreshAt = new Date().toISOString(); this.linkedRefreshError = null;
    this.nextLinkedRefresh = Date.now() + Math.min(60000, this.config.DISCOVERY_INTERVAL_SECONDS * 1000);
    if (!this.config.USE_WEBSOCKETS) await this.refreshBooks();
    this.catalogProgress.phase = 'polymarket';
    const poly = await this.adapters.discoverPoly(Date.now(), counterpartFilter(lm.markets, approvals));
    if (this.stopped) return;
    const latest = this.latestLimitless ?? lm;
    const filled = await this.adapters.fillExternalMatches(poly.markets, latest.markets);
    await this.publishDiscovery(poly, latest, filled, await loadApprovals(this.reviewsPath));
  }

  private async refreshLinked(): Promise<void> {
    // A long global walk must not postpone newly created short-duration markets.
    // Independent adapters preserve the global scan's progress counters.
    const adapters = new PublicAdapters(this.http, this.config, undefined, () => this.stopped);
    const lm = await adapters.discoverLimitless();
    const filled = await adapters.fillExternalMatches([], lm.markets);
    if (this.stopped) return;
    this.latestLimitless = lm;
    await this.publishDiscovery({ markets: [], pages: 0, truncated: true, skipped: 0, errors: [] }, lm, filled, await loadApprovals(this.reviewsPath), true);
    this.linkedRefreshAt = new Date().toISOString(); this.linkedRefreshError = null;
  }

  private publishDiscovery(poly: Discovery, lm: Discovery, filled: { markets: Market[]; errors: string[] }, approvals: Awaited<ReturnType<typeof loadApprovals>>, preserveProgress = false): Promise<void> {
    const task = this.publication.then(() => this.performPublication(poly, lm, filled, approvals, preserveProgress));
    this.publication = task.catch(() => {}); return task;
  }

  private async performPublication(poly: Discovery, lm: Discovery, filled: { markets: Market[]; errors: string[] }, approvals: Awaited<ReturnType<typeof loadApprovals>>, preserveProgress: boolean): Promise<void> {
    if (this.stopped) return;
    const partial = poly.pages === 0 && poly.truncated;
    const known = partial ? [...new Map([
      ...this.pairs.filter(p => !p.limitless.externalSlug).map(p => p.polymarket), ...filled.markets,
    ].map(m => [m.slug, m])).values()] : filled.markets;
    const found = matchMarkets(known, lm.markets, approvals);
    const activeLimitless = new Set(lm.markets.map(m => m.slug));
    const pairs = partial && filled.errors.length ? [...new Map([
      ...this.pairs.filter(p => activeLimitless.has(p.limitless.slug) && Math.max(Date.parse(p.polymarket.endsAt), Date.parse(p.limitless.endsAt)) > Date.now()), ...found,
    ].map(p => [p.id, p])).values()] : found;
    // Reviewed and strongest matches are already sorted first. Cover every
    // candidate up to the configured budget, including shared-market pairs.
    // Open paper positions retain their feed subscriptions across catalog rotations.
    const watched: Pair[] = this.pinnedPairs().filter(p => Math.max(Date.parse(p.polymarket.endsAt), Date.parse(p.limitless.endsAt)) > Date.now()).map(p => pairs.find(current => current.id === p.id) ?? p);
    const ids = new Set(watched.map(p => p.id));
    for (const pair of pairs) {
      if (this.config.MAX_WATCH_PAIRS > 0 && watched.length >= this.config.MAX_WATCH_PAIRS) break;
      if (ids.has(pair.id)) continue;
      watched.push(pair); ids.add(pair.id);
    }
    const at = new Date().toISOString();
    const coverage = {
      polymarket: { markets: filled.markets.length, pages: poly.pages, scanned: poly.scanned ?? 0, truncated: poly.truncated, skipped: poly.skipped, filtered: poly.filtered ?? {}, parseErrors: poly.errors },
      limitless: { markets: lm.markets.length, pages: lm.pages, scanned: lm.scanned ?? 0, truncated: lm.truncated, skipped: lm.skipped, filtered: lm.filtered ?? {}, parseErrors: lm.errors },
      lookupErrors: filled.errors,
      unmatched: lm.markets.filter(m => !pairs.some(p => p.limitless.slug === m.slug)).map(m => ({ title: m.title, slug: m.slug, reason: m.externalSlug ? 'linked-market-not-tradable-or-not-found' : 'no-compatible-counterpart' })),
    };
    this.catalogCoverage = preserveProgress && this.catalogCoverage ? { ...this.catalogCoverage, limitless: coverage.limitless, unmatched: coverage.unmatched, lookupErrors: coverage.lookupErrors } : coverage;
    if (!preserveProgress) {
      this.catalogProgress.complete = !poly.truncated && !lm.truncated && !poly.errors.length && !lm.errors.length && !filled.errors.length;
      if (this.catalogProgress.complete) this.catalogProgress.phase = 'complete';
      else if (poly.pages > 0 && (poly.truncated || lm.truncated)) this.catalogProgress.phase = 'limited';
    }
    const withoutRaw = ({ raw: _raw, ...market }: Market) => market;
    const report = {
      at, horizonHours: this.config.HORIZON_HOURS,
      coverage,
      candidates: pairs.map(p => ({ ...p, polymarket: withoutRaw(p.polymarket), limitless: withoutRaw(p.limitless) })),
      watchedPairIds: watched.map(p => p.id),
    };
    await this.store.latest('markets', { at, polymarket: filled.markets, limitless: lm.markets });
    await this.store.latest('candidates', report);
    // Standalone research records normalized rules only for paired markets.
    // In the MVP, ResearchStorage history is disabled entirely.
    const changedMarkets = [...new Map(pairs.flatMap(p => [p.polymarket, p.limitless]).map(m => [`${m.venue}:${m.slug}`, m])).values()].filter(m => !this.savedMarketRules.has(`${m.venue}:${m.slug}:${m.rulesHash}`));
    if (changedMarkets.length) {
      await this.store.event('market-rules', changedMarkets.map(withoutRaw));
      for (const m of changedMarkets) this.savedMarketRules.add(`${m.venue}:${m.slug}:${m.rulesHash}`);
    }
    await this.store.event('discovery', {
      at, coverage, watchedPairIds: report.watchedPairIds,
      candidates: pairs.map(p => ({ id: p.id, score: p.score, review: p.review, polymarketRulesHash: p.polymarket.rulesHash, limitlessRulesHash: p.limitless.rulesHash })),
    });
    const signature = (items: Pair[]) => [...new Set(items.flatMap(p => [p.polymarket, p.limitless]).map(m => `${m.venue}:${m.slug}:${m.yesToken}:${m.noToken}:${m.rulesHash}`))].sort().join('|');
    const changed = signature(watched) !== signature(this.watch);
    this.cache.retainMarkets(watched.flatMap(p => [p.polymarket, p.limitless]));
    this.pairs = pairs; this.watch = watched;
    this.pairIndex.clear(); this.marketPairs.clear();
    for (const pair of watched) {
      this.pairIndex.set(pair.id, pair);
      for (const market of [pair.polymarket, pair.limitless]) {
        const key = `${market.venue}:${market.slug}`, ids = this.marketPairs.get(key) ?? new Set<string>();
        ids.add(pair.id); this.marketPairs.set(key, ids);
      }
    }
    this.discoveryReady = true;
    this.hooks?.catalog?.(this.pairs,this.catalogProgress.complete);
    this.nextRest = 0;
    if (this.config.USE_WEBSOCKETS && !this.stopped && watched.length && (changed || !this.streams)) {
      const unique = (markets: Market[]) => [...new Map(markets.map(m => [m.slug, m])).values()];
      const polyMarkets = unique(watched.map(p => p.polymarket)), lmMarkets = unique(watched.map(p => p.limitless));
      if (this.streams) this.streams.update(polyMarkets, lmMarkets);
      else { this.streams = new PublicStreams(polyMarkets, lmMarkets, this.cache, this.logger, this.diagnostic); this.streams.start(); }
    }
    if (!watched.length && this.streams) { this.streams.stop(); this.streams = undefined; }
    this.logger.info({ polyMarkets: filled.markets.length, limitlessMarkets: lm.markets.length, candidates: pairs.length, watched: watched.length, truncated: poly.truncated || lm.truncated }, 'Market discovery saved');
  }

  private async refreshBooks(selected?: Market[], sides: readonly ('yes' | 'no')[] = ['yes', 'no']): Promise<void> {
    const all = selected ?? [...new Map(this.watch.flatMap(p => [p.polymarket, p.limitless]).map(m => [`${m.venue}:${m.slug}`, m])).values()];
    // All matched markets remain subscribed over WS. Rotate REST confirmation
    // through stale/missing books rather than burst-fetching thousands at once.
    const markets: Market[] = [];
    if (selected) markets.push(...selected);
    else for (let visited = 0; visited < all.length && markets.length < 20; visited++) {
      const market = all[this.restCursor++ % all.length]!;
      if (['yes', 'no'].every(side => { const b = this.cache.get(market.venue, market.slug, side); return b && Date.now() - b.receivedAt < this.config.MAX_BOOK_AGE_MS; })) continue;
      markets.push(market);
    }
    const errors = await mapLimit(markets, 2, async market => {
      if (this.stopped) return null;
      if (this.stopped) return null;
      const before = ['yes', 'no'].map(side => this.cache.get(market.venue, market.slug, side));
      const invalidate = (side: 'yes' | 'no', index: number) => {
        // A slow failed REST request must not erase a newer WS observation.
        if (this.cache.get(market.venue, market.slug, side) === before[index]) this.cache.delete(market.venue, market.slug, side);
      };
      try {
        if (market.venue === 'polymarket') {
          const results = await Promise.allSettled(sides.map(side => this.bookRequest(`${market.venue}:${market.slug}:${side}`, async () => {
            try { this.cache.set(await this.adapters.polyBook(market, side, selected !== undefined)); }
            catch (error) { invalidate(side, side === 'yes' ? 0 : 1); throw error; }
          })));
          const failures = results.filter(r => r.status === 'rejected');
          if (failures.length) throw new Error(failures.map(r => String(r.reason)).join('; '));
        } else await this.bookRequest(`${market.venue}:${market.slug}`, async () => {
          try { (await this.adapters.limitlessBooks(market, selected !== undefined)).forEach(b => this.cache.set(b)); }
          catch (error) { invalidate('yes', 0); invalidate('no', 1); throw error; }
        });
        return null;
      } catch (e) {
        return { venue: market.venue, slug: market.slug, error: String(e) };
      }
    });
    const failed = errors.filter(e => e !== null);
    if (failed.length) { this.logger.warn({ failures: failed }, 'Some books unavailable'); await this.store.event('book-errors', failed); }
  }

  private bookRequest(key: string, fetchBook: () => Promise<void>): Promise<void> {
    const pending = this.bookRequests.get(key);
    if (pending) return pending;
    // Bound retries while a provider keeps returning an old snapshot. WS is never delayed.
    const now = performance.now();
    if (now - (this.bookRequestAt.get(key) ?? -Infinity) < 500) return Promise.resolve();
    if (this.bookRequestAt.size >= 2000) this.bookRequestAt.delete(this.bookRequestAt.keys().next().value!);
    this.bookRequestAt.set(key, now);
    const task = fetchBook().finally(() => this.bookRequests.delete(key));
    this.bookRequests.set(key, task); return task;
  }

  private counts(evaluations: Evaluation[]): Record<string, number> {
    const counts: Record<string, number> = { rejected: 0, researchPositive: 0, researchNegative: 0 };
    for (const e of evaluations) {
      const key = e.status === 'research-positive' ? 'researchPositive' : e.status === 'research-negative' ? 'researchNegative' : 'rejected';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }
}
