import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { PublicHttp } from '../src/http.js';
import { PublicAdapters } from '../src/adapters.js';
import { now } from './fixtures.js';

describe('public discovery pagination', () => {
  it('uses keyset cursors without offset and reports complete coverage', async () => {
    const http = new PublicHttp(1000);
    const get = vi.spyOn(http, 'get').mockResolvedValueOnce({ markets: [], next_cursor: 'opaque+cursor' }).mockResolvedValueOnce({ markets: [] });
    const result = await new PublicAdapters(http, loadConfig({})).discoverPoly(now);
    expect(result.pages).toBe(2); expect(result.truncated).toBe(false);
    expect(get.mock.calls[0]![0]).toContain('/markets/keyset?');
    expect(get.mock.calls[1]![0]).toContain('after_cursor=opaque%2Bcursor');
    expect(get.mock.calls.every(call => !call[0].includes('offset='))).toBe(true);
  });
  it('reports truncated discovery instead of implying the entire market was scanned', async () => {
    const http = new PublicHttp(1000);
    vi.spyOn(http, 'get').mockResolvedValue({ markets: [], next_cursor: 'next-page' });
    const result = await new PublicAdapters(http, loadConfig({ MAX_PAGES: '1' })).discoverPoly(now);
    expect(result.truncated).toBe(true);
  });
  it('fails when the cursor stops advancing', async () => {
    const http = new PublicHttp(1000);
    vi.spyOn(http, 'get').mockResolvedValue({ markets: [], next_cursor: 'same' });
    await expect(new PublicAdapters(http, loadConfig({})).discoverPoly(now)).rejects.toThrow('cursor repeated');
  });
  it('caps Limitless page size and follows its total market count', async () => {
    const http = new PublicHttp(1000);
    const get = vi.spyOn(http, 'get').mockResolvedValueOnce({ data: Array(25).fill({ tradeType: 'amm' }), totalMarketsCount: 26 }).mockResolvedValueOnce({ data: [{ tradeType: 'amm' }], totalMarketsCount: 26 });
    const result = await new PublicAdapters(http, loadConfig({})).discoverLimitless(now);
    expect(result.pages).toBe(2); expect(result.truncated).toBe(false);
    expect(get.mock.calls[0]![0]).toContain('limit=25&page=1');
    expect(get.mock.calls[1]![0]).toContain('limit=25&page=2');
  });
});
