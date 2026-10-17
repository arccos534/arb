import { profiler } from './profiling.js';
import { performance } from 'node:perf_hooks';

// Bound initial snapshot bursts without starving order timers or HTTP. Receipt
// time stays the time of arrival, never the later time a queued book is parsed.
export class StreamQueue {
  private pending: { value: unknown; receivedAt: number; queuedMono: number }[] = [];
  private timer: NodeJS.Immediate | undefined;
  private stopped = false;
  constructor(private readonly apply: (value: unknown, receivedAt: number) => void,
    private readonly onError: (error: unknown) => void, private readonly maxFrames = 2000) {}
  push(values: unknown[], receivedAt: number): void {
    if (this.stopped) return;
    if (this.pending.length + values.length > this.maxFrames) { this.stop(); this.onError(new Error('Public stream processing backlog exceeded; resync required')); return; }
    const received = profiler.start();
    this.pending.push(...values.map(value => ({ value, receivedAt, queuedMono: profiler.start() })));
    profiler.end('receipt', received);
    if (!this.timer) this.timer = setImmediate(() => this.drain());
  }
  private drain(): void {
    this.timer = undefined; if (this.stopped) return;
    const started = performance.now(); let count = 0;
    try {
      while (this.pending.length && count++ < 128 && performance.now() - started < 5) {
        const item = this.pending.shift()!; profiler.end('stream-queue', item.queuedMono); profiler.measure('decode', () => this.apply(item.value, item.receivedAt));
      }
    } catch (e) { this.stop(); this.onError(e); return; }
    if (this.pending.length) this.timer = setImmediate(() => this.drain());
  }
  stop(): void { this.stopped = true; this.pending = []; if (this.timer) clearImmediate(this.timer); this.timer = undefined; }
}
