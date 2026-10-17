import { profiler } from './profiling.js';
import { performance } from 'node:perf_hooks';

// Bound initial snapshot bursts without starving order timers or HTTP. Receipt
// time stays the time of arrival, never the later time a queued book is parsed.
export class StreamQueue {
  private pending: { value: unknown; receivedAt: number; queuedMono: number; receivedMono: number }[] = [];
  private head = 0;
  private maximum = 0;
  private processed = 0;
  private timer: NodeJS.Immediate | undefined;
  private stopped = false;
  constructor(private readonly apply: (value: unknown, receivedAt: number, receivedMono: number) => void,
    private readonly onError: (error: unknown) => void, private readonly maxFrames = 2000) {}
  get stats() { return { pending: this.pending.length - this.head, maxPending: this.maximum, processed: this.processed,
    oldestMs: this.pending[this.head] ? Math.max(0, performance.now() - this.pending[this.head]!.queuedMono) : 0 }; }
  push(values: unknown[], receivedAt: number, receivedMono = profiler.start()): void {
    if (this.stopped) return;
    if (this.pending.length - this.head + values.length > this.maxFrames) { this.stop(); this.onError(new Error('Public stream processing backlog exceeded; resync required')); return; }
    const received = profiler.start();
    const queuedMono = performance.now();
    for (const value of values) this.pending.push({ value, receivedAt, queuedMono, receivedMono });
    this.maximum = Math.max(this.maximum, this.pending.length - this.head);
    profiler.end('receipt', received);
    if (!this.timer) this.timer = setImmediate(() => this.drain());
  }
  private drain(): void {
    this.timer = undefined; if (this.stopped) return;
    const started = performance.now(); let count = 0;
    try {
      while (this.head < this.pending.length && count++ < 128 && performance.now() - started < 5) {
        const item = this.pending[this.head++]!; profiler.end('stream-queue', item.queuedMono); profiler.measure('decode', () => this.apply(item.value, item.receivedAt, item.receivedMono)); this.processed++;
      }
    } catch (e) { this.stop(); this.onError(e); return; }
    if (this.head === this.pending.length) { this.pending = []; this.head = 0; }
    else { this.pending = this.pending.slice(this.head); this.head = 0; this.timer = setImmediate(() => this.drain()); }
  }
  stop(): void { this.stopped = true; this.pending = []; this.head = 0; if (this.timer) clearImmediate(this.timer); this.timer = undefined; }
}
