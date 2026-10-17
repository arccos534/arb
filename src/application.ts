import { profiler } from './profiling.js';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pino } from 'pino';
import { createHash } from 'node:crypto';
import { cpus, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { DecisionScheduler } from './decision-scheduler.js';
import type { Config } from './config.js';
import type { Pair } from './domain.js';
import { AuditJournal } from './audit.js';
import { ResearchRunner } from './research.js';
import { PublicHttp, mapLimit } from './http.js';
import { BookCache } from './books.js';
import { loadApprovals, identityBlockers } from './matching.js';
import { PaperEngine, initialState } from './paper/engine.js';
import { PaperRepository } from './paper/repository.js';
import { DemoFeed } from './paper/demo.js';
import { strategyProfile } from './paper/profiles.js';
import { fetchResolution } from './paper/resolution.js';
import { paperSettingsSchema, type DemoScenario, type FeedSnapshot, type PaperState, type Source } from './paper/types.js';

export class Application {
  readonly audit: AuditJournal;
  readonly engines = {} as Record<Source, PaperEngine>;
  readonly repositories: Record<Source, PaperRepository>;
  readonly demo = new DemoFeed();
  readonly reviewsPath: string;
  readonly dataDir: string;
  observer: ResearchRunner | undefined;
  observerError: string | null = null;
  private observerTask: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private scheduler: DecisionScheduler | undefined;
  private stopped = false;
  private checkpointAt = 0;
  private resolutionAt = 0;
  private resolving = false;
  private readonly executionRefreshes = new Map<string, Promise<void>>();
  private lastTickAt = 0;
  private readonly runtime = { lastEngineMs: 0, maxEngineMs: 0, lastTickLagMs: 0, maxTickLagMs: 0 };
  private readonly http: PublicHttp;

  constructor(readonly config: Config) {
    this.dataDir = path.resolve(config.DATA_DIR);
    this.reviewsPath = path.join(this.dataDir, 'paper-reviews.json');
    this.audit = new AuditJournal(path.join(this.dataDir, 'audit'), Number(process.env.AUDIT_MAX_MB ?? 2048) * 1024 ** 2, error => {
      for (const engine of Object.values(this.engines)) { engine.state.running = false; engine.state.haltReason = error; }
      this.observer?.stop(); this.observerError = error;
    });
    this.repositories = { live: new PaperRepository(path.join(this.dataDir, 'paper-live'), 'live'), demo: new PaperRepository(path.join(this.dataDir, 'paper-demo'), 'demo') };
    this.http = new PublicHttp(config.REQUEST_TIMEOUT_MS, (category, payload) => this.audit.record(category, 'live', payload));
  }
  async open(startObserver = true): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.audit.open();
    try { await readFile(this.reviewsPath); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await writeFile(this.reviewsPath, '[]\n'); }
    for (const source of ['live', 'demo'] as const) {
      const state = await this.repositories[source].open();
      this.engines[source] = new PaperEngine(state, this.config);
      if (!this.audit.error && state.haltReason?.startsWith('Audit queue exceeded')) {
        const previous = state.haltReason; state.haltReason = null;
        this.engines[source].event('diagnostics-recovered', 'Запись диагностики восстановлена после перезапуска; новые входы остаются на паузе', { previous });
      }
      this.engines[source].setRunning(false);
      await this.persist(source);
    }
    const demoTrade = this.engines.demo.state.trades.at(-1);
    if (demoTrade) this.demo.restore(demoTrade.pair, demoTrade.signalAt, (demoTrade.notes.find(n => n.startsWith('scenario:'))?.slice(9) ?? 'normal') as DemoScenario);
    let dependencyHash: string | null = null;
    try { dependencyHash = createHash('sha256').update(await readFile('package-lock.json')).digest('hex'); } catch { /* optional deployment manifest */ }
    this.audit.record('application-started', 'system', { version: '0.2.0', node: process.version, platform: platform(), cpuThreads: cpus().length, dependencyHash, pid: process.pid, config: { ...this.config, DATABASE_URL: this.config.DATABASE_URL ? '[CONFIGURED]' : '' } });
    this.scheduler = new DecisionScheduler(ids => this.tick(ids), error => this.fail(error));
    if (startObserver) this.startObserver();
    this.timer = setInterval(() => {
      const arrivedAt = Date.now();
      this.runtime.lastTickLagMs = this.lastTickAt ? Math.max(0, arrivedAt - this.lastTickAt - 250) : 0;
      this.runtime.maxTickLagMs = Math.max(this.runtime.maxTickLagMs, this.runtime.lastTickLagMs); this.lastTickAt = arrivedAt;
      if (this.stopped) return;
      this.scheduler?.request();
      if (!this.resolving && Date.now() - this.resolutionAt > 15000) void this.pollResolutions();
    }, 250);
  }
  private tick(changedPairIds?: ReadonlySet<string>): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
        for (const source of ['live', 'demo'] as const) {
          if (this.audit.error || (source === 'demo' && changedPairIds !== undefined)) continue;
          const engine = this.engines[source];
          if (!engine.state.running && !engine.state.trades.some(t => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status)) && !engine.state.transfers.some(t => t.status !== 'COMPLETED')) continue;
          const feed = this.feed(source);
          const began = performance.now();
          engine.step(feed, source === 'live' ? changedPairIds : undefined);
          this.runtime.lastEngineMs = performance.now() - began;
          this.runtime.maxEngineMs = Math.max(this.runtime.maxEngineMs, this.runtime.lastEngineMs);
          if (source === 'demo') {
            for (const t of engine.state.trades) if (t.status === 'SCHEDULED' && !t.notes.some(n => n.startsWith('scenario:'))) t.notes.push(`scenario:${this.demo.currentScenario}`);
            for (const resolution of this.demo.resolutions()) engine.resolve(resolution);
          }
          if (source === 'live') this.armExecutionWake();
          this.refreshDueExecutionBooks();
          if (engine.dirty) await this.persist(source);
        }
        if (changedPairIds === undefined && Date.now() - this.checkpointAt > 10000) {
          for (const source of ['live', 'demo'] as const) {
            await this.repositories[source].checkpoint(this.engines[source].state);
          }
          this.checkpointAt = Date.now();
        }
    });
  }
  private armExecutionWake(): void {
    const now = Date.now();
    const times = this.engines.live.state.trades.filter(t => t.status === 'SCHEDULED').map(t =>
      t.executeAfter > now ? t.executeAfter : t.executeAfter + this.engines.live.settings.maxExecutionWaitMs + 1);
    this.scheduler?.wakeAt(times.length ? Math.min(...times) : null);
  }
  private refreshDueExecutionBooks(): void {
    if (!this.observer || this.audit.error || this.stopped) return;
    const due = this.engines.live.state.trades.filter(t => t.status === 'SCHEDULED' && t.executeAfter <= Date.now());
    for (const trade of due) {
      if (this.executionRefreshes.has(trade.id)) continue;
      const task = this.observer.refreshExecutionBooks([trade.pair], trade.orders.map(o => ({ venue: o.venue, slug: o.slug, outcome: o.outcome, assetId: o.assetId, after: trade.executeAfter })), this.engines.live.settings.maxQuoteAgeMs)
        .catch(error => this.audit.record('execution-book-refresh-error', 'live', { tradeId: trade.id, error: String(error) }))
        .finally(() => { this.executionRefreshes.delete(trade.id); this.scheduler?.request([trade.pairId]); });
      this.executionRefreshes.set(trade.id, task);
    }
  }
  private onBookUpdate(ids: ReadonlySet<string>): void {
    if (this.stopped || this.audit.error) return;
    const engine = this.engines.live, now = Date.now();
    const active = new Set(engine.state.trades.filter(t => ['SCHEDULED', 'UNHEDGED'].includes(t.status)).map(t => t.pairId));
    const relevant = [...ids].filter(id => {
      if (active.has(id)) return true;
      const pair = this.observer?.pair(id);
      return engine.state.running && pair && !engine.entryBlockers(pair, now).length && (pair.review.approved || engine.settings.skipManualReview);
    });
    if (relevant.length) this.scheduler?.request(relevant);
  }
  private startObserver(): void {
    const logger = pino({ level: this.config.LOG_LEVEL });
    this.observer = new ResearchRunner(this.config, logger, (category, payload) => this.audit.record(category, 'live', payload), this.reviewsPath,
      () => this.engines.live.state.trades.filter(t => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status)).map(t => t.pair), true, ids => this.onBookUpdate(ids));
    this.observerTask = this.observer.run({ once: false }).catch(e => { if (!this.stopped) {
      this.observerError = String(e); this.engines.live.state.running = false;
      this.audit.record('observer-error', 'live', { error: String(e) });
    } });
  }
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn);
    this.chain = result.catch(() => {});
    return result;
  }
  private fail(error: unknown): void {
    this.observerError = String(error);
    for (const engine of Object.values(this.engines)) { engine.state.running = false; engine.state.haltReason = String(error); }
    this.audit.record('application-error', 'system', { error: String(error), stack: error instanceof Error ? error.stack : null });
  }
  private async persist(source: Source): Promise<void> {
    const profileStart = profiler.start();
    try {
    const engine = this.engines[source];
    const lastSeq = engine.state.sequence;
    const events = engine.state.events.filter(e => (e as unknown as { committed?: boolean }).committed !== true);
    for (const event of events) this.audit.record(event.type, source, event);
    try { await this.repositories[source].commit(engine.state, events); }
    catch (e) { this.fail(e); this.observer?.stop(); throw e; }
    for (const event of engine.state.events) (event as unknown as { committed: boolean }).committed = true;
    engine.dirty = false;
    this.audit.record('paper-transaction', source, { sessionId: engine.state.sessionId, previousSequence: lastSeq, sequence: engine.state.sequence, cash: engine.state.cash, realizedPnl: engine.state.realizedPnl });
    } finally { profiler.end('persistence', profileStart); }
  }
  feed(source: Source, copyBooks = false): FeedSnapshot { return source === 'demo' ? this.demo.snapshot() : this.observer?.snapshot(copyBooks) ?? { at: Date.now(), pairs: [], books: [], ready: false }; }
  async command(source: Source, action: string, payload: unknown): Promise<unknown> {
    return this.enqueue(async () => {
      if (this.audit.error && !['pause'].includes(action)) throw new Error(this.audit.error);
      const engine = this.engines[source];
      const before = structuredClone(engine.state);
      try {
        let result: unknown;
        if (action === 'start') engine.setRunning(true);
        else if (action === 'pause') engine.setRunning(false);
        else if (action === 'review-mode') {
          engine.state.settings.skipManualReview = (payload as { enabled: boolean }).enabled;
          engine.event('manual-review-mode-changed', 'Режим ручной проверки виртуальных входов изменён', { skipManualReview: engine.settings.skipManualReview, paperOnly: true });
        }
        else if (action === 'settings') engine.configure(paperSettingsSchema.parse(payload));
        else if (action === 'close') engine.close(String((payload as { tradeId: string }).tradeId), this.feed(source));
        else if (action === 'close-all') {
          const pending = engine.state.trades.filter(t => ['OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status));
          if (source === 'live' && this.observer && pending.length) await this.observer.refreshExecutionBooks(pending.map(t => t.pair));
          result = engine.closeAll(this.feed(source));
        }
        else if (action === 'rebalance') engine.rebalance();
        else if (action === 'reset') {
          if (engine.state.running || engine.state.trades.some(t => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status)) || engine.state.transfers.some(t => t.status !== 'COMPLETED')) throw new Error('Pause and close/settle positions and finish transfers before starting a new session');
          await this.repositories[source].archive(engine.state);
          engine.state = initialState(source, engine.settings); engine.state.sequence = before.sequence;
          engine.event('session-reset', 'Создана новая виртуальная сессия; предыдущая сохранена в архиве', { previousSessionId: before.sessionId });
        } else if (action === 'demo') {
          if (source !== 'demo') throw new Error('Synthetic scenarios are isolated from live quotes');
          if (engine.state.trades.some(t => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status))) throw new Error('Finish the current scenario first');
          const scenario = (payload as { scenario: DemoScenario }).scenario;
          this.demo.start(scenario);
          engine.state.settings.rejectProbability = 0; engine.state.settings.partialProbability = 0;
          engine.setRunning(true);
          engine.event('demo-started', 'Запущен отдельный синтетический сценарий', { scenario });
        } else throw new Error('Unsupported action');
        if (engine.dirty) await this.persist(source);
        return result;
      } catch (e) {
        engine.state = before;
        this.audit.record('command-rejected', source, { action, error: String(e) });
        throw e;
      }
    });
  }
  async review(pairId: string, body: { notes: string; checks: boolean[] }): Promise<void> {
    await this.enqueue(async () => {
      const pair = this.observer?.allPairs().find(p => p.id === pairId);
      if (!pair || body.checks.length !== 5 || !body.checks.every(Boolean) || body.notes.trim().length < 20) throw new Error('Review all five criteria and explain equivalence (20+ characters)');
      const reviews = await loadApprovals(this.reviewsPath);
      const now = Date.now(), validUntil = Math.min(Date.parse(pair.polymarket.endsAt), Date.parse(pair.limitless.endsAt), now + 86400000);
      if (validUntil <= now) throw new Error('Market already ended');
      const approval = {
        polymarketSlug: pair.polymarket.slug, limitlessSlug: pair.limitless.slug, polymarketRulesHash: pair.polymarket.rulesHash, limitlessRulesHash: pair.limitless.rulesHash,
        reviewedBy: 'local-paper-user', reviewedAt: new Date(now).toISOString(), validUntil: new Date(validUntil).toISOString(),
        samePositiveOutcome: true, resolutionSourceChecked: true, observationTimeChecked: true, thresholdAndEqualityChecked: true, cancellationRulesChecked: true, notes: body.notes,
      };
      const next = [...reviews.filter(a => a.polymarketSlug !== pair.polymarket.slug || a.limitlessSlug !== pair.limitless.slug), approval];
      await writeFile(`${this.reviewsPath}.tmp`, JSON.stringify(next, null, 2)); await rename(`${this.reviewsPath}.tmp`, this.reviewsPath);
      this.audit.record('pair-reviewed', 'live', { pairId, approval });
      this.observer?.requestDiscovery();
    });
  }
  async rescan(): Promise<void> { this.observer?.requestDiscovery(); this.audit.record('rescan-requested', 'live', {}); }
  async view(source: Source): Promise<unknown> {
    const engine = this.engines[source], feed = this.feed(source, false), cache = new BookCache(); feed.books.forEach(b => cache.set(b));
    const pairs = source === 'demo' ? feed.pairs : this.observer?.allPairs() ?? [];
    const watchedIds = new Set(feed.pairs.map(p => p.id));
    const openCount = engine.state.trades.filter(t => ['SCHEDULED', 'OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status)).length;
    const candidates = pairs.map(pair => {
      const evaluation = engine.evaluate(pair, cache, feed.at);
      const best = [...evaluation].filter(e => e.profit !== null).sort((a, b) => Number(b.profit) - Number(a.profit))[0];
      const watched = watchedIds.has(pair.id);
      const entryReasons = [...(best?.reasons ?? [])];
      if (best?.status === 'research-positive') entryReasons.push(...engine.entryAssessment(pair, best.direction, cache, feed.at).reasons);
      if (best?.profit !== null && best?.profit !== undefined && Number(best.profit) < Number(engine.settings.minProfitUsd)) entryReasons.push('expected-profit-below-minimum');
      if (!engine.state.running) entryReasons.push('simulation-paused');
      entryReasons.push(...engine.entryBlockers(pair, feed.at));
      if (openCount >= engine.settings.maxPositions) entryReasons.push('open-position-limit');
      const quoteReasons = evaluation.flatMap(e => e.reasons).filter(r => !['manual-rules-review-required', 'rules-changed-since-review', 'review-expired', 'invalid-review-dates'].includes(r));
      return { id: pair.id, title: pair.polymarket.title, limitlessTitle: pair.limitless.title, endsAt: pair.polymarket.endsAt, score: pair.score, review: pair.review, watched,
        entryReasons, quoteReason: best ? null : !watched ? 'outside-watch-limit' : quoteReasons.find(r => r !== 'missing-book') ?? 'missing-book',
        profit: best?.profit ?? null, roi: best?.roi ?? null, direction: best?.direction ?? null, reasons: best?.reasons ?? ['missing-book'],
        evaluations: evaluation.map(({ legs: _legs, assumptions: _assumptions, ...summary }) => summary) };
    }).sort((a, b) => a.roi === null ? b.roi === null ? a.id.localeCompare(b.id) : 1 : b.roi === null ? -1 : Number(b.roi) - Number(a.roi));
    let health: unknown = null;
    try { health = JSON.parse(await readFile(path.join(this.dataDir, 'health-latest.json'), 'utf8')); } catch { /* starting */ }
    const liveHealth = source === 'live' ? this.observer?.liveHealth() : undefined;
    if (liveHealth) health = { ...(health && typeof health === 'object' ? health : {}), ...liveHealth };
    const state = engine.state;
    return {
      at: Date.now(), source, paperOnly: true, runtime: { ...this.runtime, decisions: this.scheduler?.stats }, state: { ...state, trades: state.trades.map(({ pair, ...trade }) => ({ ...trade, identityWarning: identityBlockers(pair).includes('conflicting-market-identity') })), ledger: state.ledger.slice(-100), events: state.events.slice(-100) },
      metrics: engine.metrics(feed), strategyProfiles: { '200': strategyProfile(200), '500': strategyProfile(500) }, candidates, feed: { ready: feed.ready, books: feed.books.length,
        observerError: source === 'live' ? this.observerError : null,
        discoveryError: source === 'live' ? this.observer?.lastDiscoveryError ?? liveHealth?.linkedRefreshError ?? null : null,
        discoveryRetrying: liveHealth?.catalogRetrying ?? false, health,
        coverage: { total: pairs.length, subscribed: feed.pairs.length, calculated: candidates.filter(p => p.roi !== null).length,
          freshCalculated: candidates.filter(p => p.evaluations.some(e => e.roi !== null && !e.reasons.some(r => ['stale-or-future-book', 'stale-or-future-source-timestamp', 'book-time-skew', 'crossed-book'].includes(r)))).length,
          watchLimit: this.config.MAX_WATCH_PAIRS },
        catalog: source === 'live' && this.observer ? { ...this.observer.catalogProgress, coverage: this.observer.catalogCoverage,
          horizonHours: this.config.HORIZON_HOURS, minHoursToEnd: this.config.MIN_HOURS_TO_END, maxPages: this.config.MAX_PAGES } : null }, audit: this.audit.status(),
      balances: { polymarket: { cash: state.cash.polymarket, available: engine.available('polymarket').toString() }, limitless: { cash: state.cash.limitless, available: engine.available('limitless').toString() }, bybit: { cash: state.cash.bybit, available: state.cash.bybit } },
      additionalSources: source === 'live' ? this.observer?.additionalSources.sources ?? [] : [],
      venueRoutes: source === 'live' ? this.observer?.additionalSources.routes() ?? [] : [],
      recentLogs: this.audit.recent.filter(e => e.source === source || e.source === 'system').slice(-100),
      connections: [ { id: 'polymarket', name: 'Polymarket', status: 'public-only' }, { id: 'limitless', name: 'Limitless', status: 'public-only' }, { id: 'bybit', name: 'Bybit', status: 'stub' }, { id: 'rpc', name: 'Polygon / Base RPC', status: 'stub' } ],
    };
  }
  pair(id: string): Pair | null { return this.observer?.allPairs().find(p => p.id === id) ?? null; }
  exportState(source: Source): PaperState { return structuredClone(this.engines[source].state); }
  async auditFiles(): Promise<string[]> { return (await readdir(this.audit.directory)).filter(n => /^audit-[\d-]+\.jsonl\.gz$/.test(n)).sort().reverse(); }
  private async pollResolutions(): Promise<void> {
    this.resolving = true; this.resolutionAt = Date.now();
    try {
      const legs = this.engines.live.state.trades.filter(t => ['OPEN', 'UNHEDGED', 'WAITING_RESOLUTION'].includes(t.status) && t.endsAt <= Date.now()).flatMap(t => t.orders).filter(o => !o.resolved);
      const unique = [...new Map(legs.map(o => [`${o.venue}:${o.slug}`, o])).values()];
      await mapLimit(unique, 2, async o => {
        try {
          const resolution = await fetchResolution(this.http, o.venue, o.slug);
          if (resolution) await this.enqueue(async () => { this.engines.live.resolve(resolution); if (this.engines.live.dirty) await this.persist('live'); });
        } catch (e) { this.audit.record('resolution-error', 'live', { venue: o.venue, slug: o.slug, error: String(e) }); }
      });
    } finally { this.resolving = false; }
  }
  async close(): Promise<void> {
    this.stopped = true; if (this.timer) clearInterval(this.timer);
    this.scheduler?.stop(); await this.scheduler?.drain();
    this.observer?.stop();
    await this.observerTask;
    await Promise.all(this.executionRefreshes.values());
    await this.chain;
    for (const source of ['live', 'demo'] as const) {
      this.engines[source].setRunning(false);
      await this.persist(source);
    }
    this.audit.record('application-stopped', 'system', {}); await this.audit.flush();
  }
}
