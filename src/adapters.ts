import type { Config } from './config.js';
import type { Book, Market, Outcome } from './domain.js';
import { PublicHttp, array, record, mapLimit } from './http.js';
import { inHorizon, limitlessMarket, polyMarket } from './markets.js';
import { limitlessBooks, polyBook } from './books.js';

export const endpoints = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  limitless: 'https://api.limitless.exchange',
};

export interface Discovery {
  markets: Market[];
  pages: number;
  truncated: boolean;
  skipped: number;
  errors: string[];
  scanned?: number;
  filtered?: Record<string, number>;
  eligible?: number;
}

export class PublicAdapters {
  constructor(readonly http: PublicHttp, private readonly config: Config,
    private readonly onProgress?: (venue: 'polymarket' | 'limitless', progress: { pages: number; scanned: number; eligible: number }) => void,
    private readonly stopped: () => boolean = () => false) {}

  async discoverPoly(now = Date.now(), retain: (market: Market) => boolean = () => true): Promise<Discovery> {
    const result: Discovery = { markets: [], pages: 0, truncated: true, skipped: 0, errors: [], scanned: 0, filtered: {} };
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (let page = 0; this.config.MAX_PAGES === 0 || page < this.config.MAX_PAGES; page++) {
      if (this.stopped()) throw new Error('Discovery stopped');
      const query = new URLSearchParams({
        active: 'true', closed: 'false', limit: '100',
        order: 'endDate', ascending: 'true',
        end_date_min: new Date(now + this.config.MIN_HOURS_TO_END * 3600000).toISOString(),
      });
      if (this.config.HORIZON_HOURS > 0) query.set('end_date_max', new Date(now + this.config.HORIZON_HOURS * 3600000).toISOString());
      if (cursor) query.set('after_cursor', cursor);
      const body = record(await this.http.get(`${endpoints.gamma}/markets/keyset?${query}`));
      const rows = array(body.markets);
      result.pages++;
      for (const row of rows) {
        result.scanned!++;
        try {
          const market = polyMarket(row);
          if (market && inHorizon(market, this.config, now)) {
            result.eligible = (result.eligible ?? 0) + 1;
            if (retain(market)) result.markets.push(market);
          }
          else { result.skipped++; const reason = market ? 'outside-time-window' : 'unsupported-or-inactive'; result.filtered![reason] = (result.filtered![reason] ?? 0) + 1; }
        } catch (e) { result.skipped++; result.errors.push(String(e)); }
      }
      this.onProgress?.('polymarket', { pages: result.pages, scanned: result.scanned!, eligible: result.eligible ?? 0 });
      if (typeof body.next_cursor !== 'string' || !body.next_cursor) { result.truncated = false; break; }
      if (seenCursors.has(body.next_cursor)) throw new Error('Polymarket cursor repeated');
      seenCursors.add(body.next_cursor);
      cursor = body.next_cursor;
    }
    result.markets = [...new Map(result.markets.map(m => [m.slug, m])).values()];
    return result;
  }

  async discoverLimitless(now = Date.now()): Promise<Discovery> {
    const result: Discovery = { markets: [], pages: 0, truncated: true, skipped: 0, errors: [], scanned: 0, filtered: {} };
    const seenPages = new Set<string>();
    for (let page = 1; this.config.MAX_PAGES === 0 || page <= this.config.MAX_PAGES; page++) {
      if (this.stopped()) throw new Error('Discovery stopped');
      if (this.stopped()) throw new Error('Discovery stopped');
      const body = record(await this.http.get(`${endpoints.limitless}/markets/active?limit=25&page=${page}&sortBy=ending_soon`));
      const rows = array(body.data);
      const signature = JSON.stringify(rows.map(v => { const r = record(v); return [r.id, r.slug]; }));
      if (rows.length && seenPages.has(signature)) throw new Error('Limitless page repeated');
      seenPages.add(signature);
      result.pages++;
      const visit = (row: unknown): void => {
        try {
          const raw = record(row);
          if (Array.isArray(raw.markets)) { raw.markets.forEach(visit); return; }
          result.scanned!++;
          const market = limitlessMarket(row);
          if (market && inHorizon(market, this.config, now)) result.markets.push(market);
          else { result.skipped++; const reason = market ? 'outside-time-window' : 'unsupported-or-inactive'; result.filtered![reason] = (result.filtered![reason] ?? 0) + 1; }
        } catch (e) { result.skipped++; result.errors.push(String(e)); }
      };
      rows.forEach(visit);
      this.onProgress?.('limitless', { pages: result.pages, scanned: result.scanned!, eligible: result.markets.length });
      if (rows.length < 25 || page * 25 >= Number(body.totalMarketsCount)) { result.truncated = false; break; }
    }
    result.markets = [...new Map(result.markets.map(m => [m.slug, m])).values()];
    return result;
  }

  async polyBySlug(slug: string): Promise<Market | null> {
    const rows = array(await this.http.get(`${endpoints.gamma}/markets?${new URLSearchParams({ slug })}`));
    return rows.length === 1 ? polyMarket(rows[0]) : null;
  }

  async fillExternalMatches(poly: Market[], limitless: Market[], now = Date.now()): Promise<{ markets: Market[]; errors: string[] }> {
    const known = new Map(poly.map(m => [m.slug, m]));
    const missing = [...new Set(limitless.flatMap(m => m.externalSlug && !known.has(m.externalSlug) ? [m.externalSlug] : []))];
    const errors: string[] = [];
    const batches = Array.from({ length: Math.ceil(missing.length / 100) }, (_, i) => missing.slice(i * 100, (i + 1) * 100));
    await mapLimit(batches, 3, async slugs => {
      if (this.stopped()) return;
      try {
        const query = new URLSearchParams({ limit: '100', closed: 'false' });
        slugs.forEach(slug => query.append('slug', slug));
        const seenCursors = new Set<string>();
        do {
          if (this.stopped()) return;
          const body = record(await this.http.get(`${endpoints.gamma}/markets/keyset?${query}`));
          for (const row of array(body.markets)) {
            const market = polyMarket(row);
            if (market && slugs.includes(market.slug) && inHorizon(market, this.config, now)) known.set(market.slug, market);
          }
          if (typeof body.next_cursor !== 'string' || !body.next_cursor) break;
          if (seenCursors.has(body.next_cursor)) throw new Error('Polymarket lookup cursor repeated');
          seenCursors.add(body.next_cursor); query.set('after_cursor', body.next_cursor);
        } while (true);
      } catch (e) { errors.push(`lookup batch (${slugs.length} markets, ${slugs[0]}): ${String(e)}`); }
    });
    return { markets: [...known.values()], errors };
  }

  async polyBook(market: Market, outcome: Outcome, urgent = false): Promise<Book> {
    const id = outcome === 'yes' ? market.yesToken : market.noToken;
    let startedAt = Date.now();
    const body = await this.http.get(`${endpoints.clob}/book?${new URLSearchParams({ token_id: id })}`, urgent, () => { startedAt = Date.now(); });
    // Request start is a conservative freshness bound; arrival alone hides a slow response.
    return polyBook(body, market, outcome, 'rest', startedAt);
  }

  async limitlessBooks(market: Market, urgent = false): Promise<Book[]> {
    let startedAt = Date.now();
    const body = await this.http.get(`${endpoints.limitless}/markets/${encodeURIComponent(market.slug)}/orderbook`, urgent, () => { startedAt = Date.now(); });
    return limitlessBooks(body, market, 'rest', startedAt);
  }
}
