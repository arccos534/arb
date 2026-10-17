import { performance } from 'node:perf_hooks';

// One scheduler per origin. Urgent execution refreshes go before catalogue work;
// no request bypasses spacing or a server-requested cooldown.
export class RequestLimiter {
  private readonly urgent: (() => void)[] = [];
  private readonly normal: (() => void)[] = [];
  private nextAt = 0;
  private timer: NodeJS.Timeout | undefined;
  constructor(readonly intervalMs = 100, private readonly clock = () => performance.now()) {}
  wait(urgent = false): Promise<void> {
    return new Promise(resolve => { (urgent ? this.urgent : this.normal).push(resolve); this.arm(); });
  }
  cooldown(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.clock() + ms);
    if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.arm();
  }
  private arm(): void {
    if (this.timer || !this.urgent.length && !this.normal.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const resolve = this.urgent.shift() ?? this.normal.shift();
      this.nextAt = this.clock() + this.intervalMs; resolve?.(); this.arm();
    }, Math.max(0, Math.ceil(this.nextAt - this.clock())));
  }
}
