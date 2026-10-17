import { performance } from 'node:perf_hooks';

export const stages = ['receipt', 'decode', 'book-update', 'search', 'quote', 'fees', 'liquidity', 'risk', 'schedule', 'artificial-delay', 'recheck', 'execute', 'stream-queue', 'decision-queue', 'persistence', 'snapshot', 'http', 'snapshot-wait'] as const;
export type Stage = typeof stages[number];
type Bucket = { count: number; totalMs: number; maxMs: number; rejected: number; networkRequests: number; samples: number[] };
/** Bounded recent samples; totals cover this process lifetime. Nested spans overlap. */
export class Profiler {
  private readonly buckets = new Map<Stage, Bucket>();
  constructor(public enabled = false, private readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4096) throw new Error('Invalid profile capacity');
  }
  start(): number { return this.enabled ? performance.now() : 0; }
  end(stage: Stage, started: number, rejected = false, networkRequests = 0): void {
    if (this.enabled) this.record(stage, performance.now() - started, rejected, networkRequests);
  }
  record(stage: Stage, ms: number, rejected = false, networkRequests = 0): void {
    if (!this.enabled || !Number.isFinite(ms) || ms < 0) return;
    let b = this.buckets.get(stage);
    if (!b) { b = { count: 0, totalMs: 0, maxMs: 0, rejected: 0, networkRequests: 0, samples: [] }; this.buckets.set(stage, b); }
    b.samples[b.count % this.capacity] = ms; b.count++; b.totalMs += ms;
    b.maxMs = Math.max(b.maxMs, ms); b.rejected += Number(rejected); b.networkRequests += networkRequests;
  }
  measure<T>(stage: Stage, fn: () => T): T {
    if (!this.enabled) return fn();
    const start = this.start(); let rejected = false;
    try { return fn(); } catch (error) { rejected = true; throw error; }
    finally { this.end(stage, start, rejected); }
  }
  report() {
    return { schemaVersion: 1, enabled: this.enabled, updatedAt: new Date().toISOString(),
      clock: 'monotonic', percentileWindow: this.capacity, scope: 'process; nested spans overlap; HTTP is RTT, not one-way delivery',
      stages: stages.map(stage => {
        const b = this.buckets.get(stage), sorted = b?.samples.slice().sort((a, c) => a - c) ?? [];
        const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
        return { stage, count: b?.count ?? 0, totalMs: b?.totalMs ?? 0, maxMs: b?.maxMs ?? null,
          rejected: b?.rejected ?? 0, networkRequests: b?.networkRequests ?? 0, sampleCount: sorted.length,
          p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
      }) };
  }
}
export const profiler = new Profiler(process.env.EXECUTION_PROFILE === 'true');
