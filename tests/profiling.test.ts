import { describe, expect, it } from 'vitest';
import { Profiler } from '../src/profiling.js';

describe('bounded monotonic profiling', () => {
  it('retains lifetime counts with bounded recent quantiles and failures', () => {
    const p = new Profiler(true, 3);
    for (let i = 1; i <= 10; i++) p.record('http', i, i === 10, 1);
    const row = p.report().stages.find(s => s.stage === 'http')!;
    expect(row).toMatchObject({ count: 10, totalMs: 55, sampleCount: 3, p50: 9, p99: 10, rejected: 1, networkRequests: 10 });
    p.enabled = false; p.record('http', 100);
    expect(p.report().stages.find(s => s.stage === 'http')!.count).toBe(10);
  });
  it('records thrown work and leaves results/errors unchanged', () => {
    const p = new Profiler(true);
    expect(p.measure('quote', () => 42)).toBe(42);
    expect(() => p.measure('quote', () => { throw new Error('depth'); })).toThrow('depth');
    expect(p.report().stages.find(s => s.stage === 'quote')).toMatchObject({ count: 2, rejected: 1 });
  });
});
