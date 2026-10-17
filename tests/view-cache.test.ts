import { describe, expect, it } from 'vitest';
import { JsonViewCache } from '../src/view-cache.js';

describe('serialized UI snapshots', () => {
  it('coalesces concurrent viewers and freezes a snapshot independently of mutable state', async () => {
    const cache = new JsonViewCache(), state = { cash: '100' }; let builds = 0;
    const build = async () => { builds++; return state; };
    const [a, b] = await Promise.all([cache.get('live', build), cache.get('live', build)]);
    state.cash = '99'; expect(builds).toBe(1); expect(a).toBe(b); expect(JSON.parse(await cache.get('live', build)).cash).toBe('100');
    cache.invalidate(); expect(JSON.parse(await cache.get('live', build)).cash).toBe('99');
  });
  it('prevents an invalidated in-flight build from overwriting a post-command snapshot', async () => {
    const cache = new JsonViewCache(); let release!: (value: unknown) => void;
    const old = cache.get('live', () => new Promise(resolve => { release = resolve; }));
    cache.invalidate(); const current = await cache.get('live', async () => ({ running: true }));
    release({ running: false }); await old;
    expect(await cache.get('live', async () => { throw new Error('should be cached'); })).toBe(current);
  });
});
