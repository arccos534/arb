import { profiler } from './profiling.js';
// Coalesce bursts, retain updates during an async commit, and wake orders at
// their arrival time instead of waiting for the next polling interval.
export class DecisionScheduler {
  private pending = false;
  private full = false;
  private readonly pairs = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private arrival: NodeJS.Timeout | undefined;
  private arrivalAt: number | null = null;
  private task: Promise<void> | undefined;
  private stopped = false;
  private queuedAt = 0;
  private queuedMono = 0;
  readonly stats = { decisions: 0, lastDispatchLagMs: 0, maxDispatchLagMs: 0 };
  constructor(private readonly decide: (pairs: ReadonlySet<string> | undefined) => Promise<void>,
    private readonly onError: (error: unknown) => void, private readonly coalesceMs = 5) {}
  request(pairs?: Iterable<string>): void {
    if (this.stopped) return;
    if (!this.pending) { this.queuedAt = Date.now(); this.queuedMono = profiler.start(); }
    this.pending = true;
    if (pairs === undefined) this.full = true;
    else for (const id of pairs) this.pairs.add(id);
    this.schedule();
  }
  wakeAt(at: number | null): void {
    if (this.stopped || this.arrivalAt === at) return;
    if (this.arrival) clearTimeout(this.arrival);
    this.arrivalAt = at; this.arrival = undefined;
    if (at !== null) this.arrival = setTimeout(() => {
      this.arrival = undefined; this.arrivalAt = null;
      this.request([]);
    }, Math.max(0, at - Date.now()));
  }
  private schedule(): void {
    if (!this.stopped && this.pending && !this.timer && !this.task) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.coalesceMs);
    }
  }
  private flush(): void {
    if (this.stopped || !this.pending || this.task) return;
    const pairs = this.full ? undefined : new Set(this.pairs);
    this.pending = false; this.full = false; this.pairs.clear();
    this.stats.lastDispatchLagMs = Math.max(0, Date.now() - this.queuedAt);
    this.stats.maxDispatchLagMs = Math.max(this.stats.maxDispatchLagMs, this.stats.lastDispatchLagMs);
    this.stats.decisions++;
    profiler.end('decision-queue', this.queuedMono);
    this.task = Promise.resolve().then(() => this.decide(pairs)).catch(this.onError).finally(() => {
      this.task = undefined; this.schedule();
    });
  }
  stop(): void {
    this.stopped = true; this.pending = false; this.pairs.clear();
    if (this.timer) clearTimeout(this.timer);
    if (this.arrival) clearTimeout(this.arrival);
    this.timer = undefined; this.arrival = undefined;
  }
  async drain(): Promise<void> { await this.task; }
}
