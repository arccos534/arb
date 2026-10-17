import { performance } from 'node:perf_hooks';
import { BookCache, bookKey } from '../books.js';
import type { Book } from '../domain.js';
import type { Config } from '../config.js';
import { PaperEngine, initialState } from '../paper/engine.js';
import type { FeedSnapshot, PaperSettings, PaperTrade } from '../paper/types.js';

export const LATENCIES = [50, 100, 200, 400] as const;
export type EvidenceMode = 'post-arrival' | 'at-arrival';
export interface CapturedFrame {
  at: number; key: string; book: Book | null; asksComplete: boolean; bidsComplete: boolean;
}
export interface ExecutionCase {
  version: 1; id: string; signalMono: number; signalAt: number; settings: PaperSettings;
  trade: PaperTrade; frames: CapturedFrame[]; incomplete: boolean; incompleteReasons?: string[]; clockIssue: boolean; rulesChanged: boolean;
}
export interface ReplayResult {
  latencyMs: number; mode: EvidenceMode; verdict: 'supported' | 'possible' | 'unavailable' | 'unknown';
  reasons: string[]; profit: string | null; roi: string | null; checkedAfterMs: number | null;
}
export interface CaseSummary {
  id: string; title: string; pairId: string; signalAt: number; signalProfit: string; reviewed: boolean;
  incomplete: boolean; incompleteReasons?: string[]; results: ReplayResult[];
  pricingPolicy?: 'pair-budget-v1' | 'legacy-leg-limits';
}

export function category(reason: string): string {
  if (reason === 'pair-price-budget-exceeded') return 'pair-price-budget-exceeded';
  if (reason.includes('price-above-limit')) return 'price-above-limit';
  if (reason.includes('insufficient-depth') || reason.includes('below-minimum-order')) return 'insufficient-volume';
  if (reason.includes('stale') || reason.includes('future')) return 'stale-data';
  if (reason.includes('time-skew')) return 'time-skew';
  if (reason.includes('profit') || reason.includes('roi')) return 'profit-below-threshold';
  if (reason.includes('budget') || reason.includes('loss-limit') || reason.includes('exposure') || reason.includes('exit-depth')) return 'risk-limit';
  return reason;
}

// Read-only comparison. No RNG, purchases, cash movements or resolutions occur.
export function replayExecution(capture: ExecutionCase, config: Config): ReplayResult[] {
  return LATENCIES.flatMap(latencyMs => (['post-arrival', 'at-arrival'] as EvidenceMode[]).map(mode => {
    const base = { latencyMs, mode, profit: null, roi: null, checkedAfterMs: null };
    if (capture.clockIssue || capture.incomplete || capture.rulesChanged) return { ...base, verdict: 'unknown' as const,
      reasons: [capture.clockIssue ? 'clock-uncertain' : capture.rulesChanged ? 'rules-changed' : 'capture-truncated'] };
    const engine = new PaperEngine(initialState('live', capture.settings, capture.signalAt), config);
    const trade = structuredClone(capture.trade); trade.executeAfter = capture.signalAt + latencyMs;
    engine.state.trades = [trade];
    const arrival = capture.signalMono + latencyMs, cache = new BookCache();
    const depth = new Map<string, { asksComplete: boolean; bidsComplete: boolean }>();
    const frames = [...capture.frames].sort((a, b) => a.at - b.at);
    const apply = (frame: CapturedFrame) => {
      if (frame.book) { cache.set(frame.book); depth.set(frame.key, frame); }
      else {
        const order = trade.orders.find(o => bookKey(o.venue, o.slug, o.outcome) === frame.key);
        if (order) cache.delete(order.venue, order.slug, order.outcome);
        depth.delete(frame.key);
      }
    };
    let checkedAt: number | null = null;
    if (mode === 'at-arrival') {
      for (const frame of frames) if (frame.at <= arrival) apply(frame);
      checkedAt = capture.signalAt + latencyMs;
    } else {
      for (const frame of frames) {
        if (frame.at > arrival + capture.settings.maxExecutionWaitMs) break;
        apply(frame);
        if (frame.at < arrival) continue;
        const now = capture.signalAt + frame.at - capture.signalMono;
        const ready = trade.orders.every(o => {
          const b = cache.get(o.venue, o.slug, o.outcome);
          return b && b.receivedAt >= trade.executeAfter && now - b.receivedAt <= capture.settings.maxQuoteAgeMs;
        });
        if (ready) { checkedAt = now; break; }
      }
    }
    if (checkedAt === null) return { ...base, verdict: 'unknown' as const, reasons: ['missing-confirmation'] };
    if (trade.orders.some(o => !cache.get(o.venue, o.slug, o.outcome))) return { ...base, verdict: 'unknown' as const, reasons: ['missing-book-or-disconnected'] };
    const check = engine.assessExecution(trade, trade.pair, cache, checkedAt, mode === 'post-arrival');
    const missingDepth = check.reasons.some(reason => {
      const side = trade.orders.find(o => reason.startsWith(`${o.venue}:`));
      if (!side) return false;
      const recorded = depth.get(bookKey(side.venue, side.slug, side.outcome));
      return reason.includes('insufficient-depth') && recorded?.asksComplete === false
        || reason.includes('insufficient-emergency-exit-depth') && recorded?.bidsComplete === false;
    });
    const reasons = [...new Set(check.reasons.map(category))];
    const uncertain = missingDepth || reasons.some(r => ['stale-data', 'time-skew', 'missing-book', 'book-asset-mismatch', 'execution-asset-mismatch'].some(x => r.includes(x)));
    return { latencyMs, mode, verdict: missingDepth || uncertain ? 'unknown' as const : check.passed ? (mode === 'at-arrival' ? 'possible' as const : 'supported' as const) : 'unavailable' as const,
      reasons: missingDepth ? ['depth-not-recorded'] : reasons, profit: check.executionProfit, roi: check.executionRoi,
      checkedAfterMs: Math.round(checkedAt - capture.signalAt) };
  }));
}

interface StoredFrame { at: number; key: string; data: Buffer; bytes: number }
interface Pending { trade: PaperTrade; settings: PaperSettings; at: number; clockIssue: boolean; incompleteReasons: Set<string> }
export class ExecutionRecorder {
  private readonly frames: StoredFrame[] = [];
  private readonly pending: Pending[] = [];
  private bytes = 0;
  private previous: { mono: number; wall: number } | undefined;
  private clockTrusted = true;
  droppedFrames = 0;
  constructor(private readonly memoryLimit = 64 * 1024 ** 2, private readonly depthLimit = 20,
    private readonly mono = () => performance.now(), private readonly wall = () => Date.now(),
    private readonly caseLimit = 8 * 1024 ** 2) {}
  get status() { return { bufferBytes: this.bytes, limitBytes: this.memoryLimit, caseLimitBytes: this.caseLimit, frames: this.frames.length, pending: this.pending.length, droppedFrames: this.droppedFrames, clockTrusted: this.clockTrusted }; }
  setClockTrusted(trusted: boolean): void { this.clockTrusted = trusted; if (!trusted) this.pending.forEach(p => { p.clockIssue = true; }); }
  observe(book: Book): void {
    this.push({ at: this.mono(), key: bookKey(book.venue, book.slug, book.outcome),
      book: { ...book, asks: book.asks.slice(0, this.depthLimit), bids: book.bids.slice(0, this.depthLimit) },
      asksComplete: book.asks.length <= this.depthLimit, bidsComplete: book.bids.length <= this.depthLimit });
  }
  invalidate(key: string): void { this.push({ at: this.mono(), key, book: null, asksComplete: true, bidsComplete: true }); }
  private push(frame: CapturedFrame): void {
    const wall = this.wall();
    if (this.previous && Math.abs(wall - this.previous.wall - (frame.at - this.previous.mono)) > 250) {
      this.pending.forEach(p => { p.clockIssue = true; }); this.clockTrusted = false;
    }
    this.previous = { mono: frame.at, wall };
    const data = Buffer.from(JSON.stringify(frame));
    const stored = { at: frame.at, key: frame.key, data, bytes: data.byteLength + 256 };
    this.frames.push(stored); this.bytes += stored.bytes;
    this.prune(frame.at);
    while (this.bytes > this.memoryLimit && this.frames.length) {
      const lost = this.frames.shift()!; this.bytes -= lost.bytes; this.droppedFrames++;
      for (const pending of this.pending) if (lost.at >= pending.at - 2000) pending.incompleteReasons.add('buffer-evicted');
    }
  }
  private prune(now: number): void {
    const earliest = Math.min(now - 2000, ...this.pending.map(p => p.at - 2000));
    while (this.frames[0] && this.frames[0].at < earliest) this.bytes -= this.frames.shift()!.bytes;
  }
  start(trade: PaperTrade, settings: PaperSettings, feed: FeedSnapshot): boolean {
    if (this.pending.length >= 32) return false;
    const at = this.mono() - Math.max(0, this.wall() - trade.signalAt);
    const clean = structuredClone(trade); clean.pair.polymarket.raw = {}; clean.pair.limitless.raw = {};
    this.pending.push({ trade: clean, settings: structuredClone(settings), at, clockIssue: !this.clockTrusted, incompleteReasons: new Set() });
    // Baselines retain quiet books, but keep their original receipt timestamps.
    for (const order of trade.orders) {
      const book = feed.books.find(b => b.venue === order.venue && b.slug === order.slug && b.outcome === order.outcome);
      if (book) this.observe(book);
    }
    return true;
  }
  finish(rules: (pairId: string) => string[] | undefined, force = false): ExecutionCase[] {
    const now = this.mono(), ready: ExecutionCase[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i]!;
      if (!force && now < p.at + 3000) continue;
      this.pending.splice(i, 1);
      const keys = new Set(p.trade.orders.map(o => bookKey(o.venue, o.slug, o.outcome)));
      const current = rules(p.trade.pairId);
      const retained = this.frames.filter(f => keys.has(f.key) && f.at >= p.at - 2000 && f.at <= p.at + 3000);
      let size = 0;
      const frames: CapturedFrame[] = [];
      for (const f of retained) {
        size += f.bytes; if (size > this.caseLimit) { p.incompleteReasons.add('case-byte-limit'); break; }
        frames.push(JSON.parse(f.data.toString()) as CapturedFrame);
      }
      if (now < p.at + 3000) p.incompleteReasons.add('window-not-finished');
      ready.push({ version: 1, id: p.trade.id, signalMono: p.at, signalAt: p.trade.signalAt, trade: p.trade, settings: p.settings,
        frames, incomplete: p.incompleteReasons.size > 0, incompleteReasons: [...p.incompleteReasons], clockIssue: p.clockIssue,
        rulesChanged: !current || current.some((hash, index) => hash !== p.trade.rulesHashes[index]) });
    }
    this.prune(now); return ready.reverse();
  }
}

export function summarize(capture: ExecutionCase, config: Config): CaseSummary {
  return { id: capture.id, title: capture.trade.title, pairId: capture.trade.pairId, signalAt: capture.signalAt,
    signalProfit: capture.trade.expectedProfit, reviewed: capture.trade.pair.review.approved,
    pricingPolicy: capture.trade.initialCost !== undefined ? 'pair-budget-v1' : 'legacy-leg-limits',
    incomplete: capture.incomplete, ...(capture.incompleteReasons ? { incompleteReasons: capture.incompleteReasons } : {}), results: replayExecution(capture, config) };
}
export function comparisonTable(cases: CaseSummary[]) {
  return LATENCIES.flatMap(latencyMs => (['post-arrival', 'at-arrival'] as EvidenceMode[]).map(mode => {
    const results = cases.flatMap(c => c.results.filter(r => r.latencyMs === latencyMs && r.mode === mode));
    const available = results.filter(r => ['supported', 'possible'].includes(r.verdict));
    const reasons: Record<string, number> = {};
    for (const r of results) for (const reason of r.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
    return { latencyMs, mode, available: available.length, unavailable: results.filter(r => r.verdict === 'unavailable').length,
      unknown: results.filter(r => r.verdict === 'unknown').length,
      independentHypotheticalProfit: available.reduce((sum, r) => sum + Number(r.profit ?? 0), 0).toFixed(6), reasons };
  }));
}
export function diagnosticsCsv(report: { cases?: CaseSummary[] }): string {
  const cell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;
  return '\uFEFF' + [['id', 'title', 'signalAt', 'reviewed', 'latencyMs', 'mode', 'verdict', 'profit', 'roi', 'checkedAfterMs', 'reasons', 'pricingPolicy'],
    ...(report.cases ?? []).flatMap(c => c.results.map(r => [c.id, c.title, new Date(c.signalAt).toISOString(), c.reviewed, r.latencyMs, r.mode, r.verdict, r.profit, r.roi, r.checkedAfterMs, r.reasons.join('; '), c.pricingPolicy ?? 'legacy-leg-limits']))]
    .map(row => row.map(cell).join(',')).join('\r\n');
}
