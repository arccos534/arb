import { describe, expect, it, vi } from 'vitest';
import { RequestLimiter } from '../src/request-limiter.js';

describe('shared HTTP request scheduling', () => {
  it('spaces requests and prioritizes execution refreshes without bypassing cooldown', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RequestLimiter(100, () => Date.now()), order: string[] = [];
      const a = limiter.wait().then(() => order.push('first')); await vi.advanceTimersByTimeAsync(1);
      const b = limiter.wait().then(() => order.push('catalogue'));
      const c = limiter.wait(true).then(() => order.push('execution'));
      await vi.advanceTimersByTimeAsync(100); expect(order).toEqual(['first', 'execution']);
      limiter.cooldown(1000); await vi.advanceTimersByTimeAsync(999); expect(order).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1); await Promise.all([a, b, c]); expect(order).toEqual(['first', 'execution', 'catalogue']);
    } finally { vi.useRealTimers(); }
  });
});
