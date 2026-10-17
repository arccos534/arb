import { describe, expect, it } from 'vitest';
import { StreamQueue } from '../src/stream-queue.js';

describe('bounded stream snapshot processing', () => {
  it('preserves order and receipt time while yielding between chunks', async () => {
    const result: { value: unknown; at: number }[] = [], errors: unknown[] = [];
    const queue = new StreamQueue((value, at) => result.push({ value, at }), error => errors.push(error));
    queue.push(Array.from({ length: 300 }, (_, i) => i), 123);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(result.length).toBeGreaterThan(0); expect(result.length).toBeLessThan(300);
    for (let i = 0; i < 10 && result.length < 300; i++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(result.map(r => r.value)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    expect(result.every(r => r.at === 123)).toBe(true); expect(errors).toEqual([]); queue.stop();
  });
  it('discards pending frames on disconnect or overflow without publishing stale state', async () => {
    const result: unknown[] = [], errors: unknown[] = [];
    const queue = new StreamQueue(value => result.push(value), error => errors.push(error), 2);
    queue.push([1], 1); queue.push([2, 3], 2);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(result).toEqual([]); expect(errors).toHaveLength(1);
    const stopped = new StreamQueue(value => result.push(value), error => errors.push(error));
    stopped.push([4], 4); stopped.stop(); await new Promise<void>(resolve => setImmediate(resolve)); expect(result).toEqual([]);
  });
});
