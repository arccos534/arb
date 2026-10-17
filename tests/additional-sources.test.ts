import { describe, expect, it, vi } from 'vitest';
import { AdditionalSources, hedgeCatalog } from '../src/additional-sources.js';
import { PublicHttp } from '../src/http.js';

describe('additional public venue monitoring', () => {
  const html = '<a href="/versus/solana/1299"><img alt="Will ETH &amp; BTC rise?"></a>';
  it('deduplicates SSR links, decodes titles, and never invents quotes', () => {
    expect(hedgeCatalog(html + html)).toEqual([{ id: '/versus/solana/1299', title: 'Will ETH & BTC rise?', url: 'https://www.hedgehog.markets/versus/solana/1299' }]);
    expect(hedgeCatalog('<a href="https://other.test"><img alt="test"></a>')).toEqual([]);
  });
  it('isolates a failed Drift probe and blocks all five unimplemented routes', async () => {
    const http = new PublicHttp(100);
    vi.spyOn(http, 'get').mockRejectedValue(new Error('DNS unavailable'));
    vi.spyOn(http, 'getText').mockResolvedValue(html);
    const log = vi.fn(), monitor = new AdditionalSources(http, log);
    await monitor.refresh();
    expect(monitor.sources[0]?.status).toBe('unavailable');
    expect(monitor.sources[1]?.status).toBe('catalog-only');
    expect(monitor.sources.every(s => !s.executable && s.checkedAt !== null)).toBe(true);
    expect(monitor.routes()).toHaveLength(6);
    expect(monitor.routes().filter(r => r.enabled)).toEqual([expect.objectContaining({left:'polymarket',right:'limitless'})]);
    expect(log).toHaveBeenCalledWith('additional-sources-status', expect.any(Object));
  });
  it('clears old catalog data when the feed fails or changes format', async () => {
    const http = new PublicHttp(100);
    vi.spyOn(http, 'get').mockResolvedValue({});
    const fetch = vi.spyOn(http, 'getText').mockResolvedValueOnce(html).mockResolvedValueOnce('<html></html>');
    const monitor = new AdditionalSources(http);
    await monitor.refresh(); await monitor.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(monitor.sources[1]?.catalog).toEqual([]);
    expect(monitor.sources[1]?.status).toBe('unavailable');
    expect(monitor.routes().filter(r=>r.enabled)).toHaveLength(1);
  });
  it('distinguishes a reachable client-rendered site from a usable catalogue', async () => {
    const http = new PublicHttp(100);
    vi.spyOn(http, 'get').mockRejectedValue(new Error('offline'));
    vi.spyOn(http, 'getText').mockResolvedValue('<title>Hedgehog Markets</title>');
    const monitor = new AdditionalSources(http); await monitor.refresh();
    expect(monitor.sources[1]?.status).toBe('catalog-only');
    expect(monitor.sources[1]?.catalog).toEqual([]);
    expect(monitor.sources[1]?.executable).toBe(false);
  });
});
