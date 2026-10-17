import { PublicHttp } from './http.js';

export interface AdditionalSource {
  id: 'drift' | 'hedgehog'; name: string; checkedAt: string | null;
  status: 'checking' | 'unavailable' | 'catalog-only';
  executable: false; reason: string; error: string | null;
  catalog: { id: string; title: string; url: string }[];
}

export function hedgeCatalog(html: string): AdditionalSource['catalog'] {
  // Public SSR catalogue only. Titles/links never become executable quotes.
  const entries = new Map<string, AdditionalSource['catalog'][number]>();
  for (const match of html.matchAll(/<a\b[^>]*href="(\/versus\/(?:solana|eclipse)\/\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const title = /<img\b[^>]*alt="([^"]+)"/.exec(match[2]!)?.[1];
    if (!title) continue;
    const text = title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    entries.set(match[1]!, { id: match[1]!, title: text, url: `https://www.hedgehog.markets${match[1]}` });
  }
  return [...entries.values()];
}

export class AdditionalSources {
  sources: AdditionalSource[] = [
    { id: 'drift', name: 'Drift Protocol / BET', checkedAt: null, status: 'checking', executable: false, reason: 'Активные рынки прогнозов и исполнимые котировки не подтверждены.', error: null, catalog: [] },
    { id: 'hedgehog', name: 'Hedgehog Markets', checkedAt: null, status: 'checking', executable: false, reason: 'Проверяем публичный каталог; для расчёта нужны исполнимые P2P-предложения и комиссии.', error: null, catalog: [] },
  ];
  constructor(private readonly http: PublicHttp, private readonly diagnostic?: (category: string, payload: unknown) => void) {}
  async refresh(): Promise<void> {
    // Optional sources fail independently and never invalidate working feeds.
    const results = await Promise.allSettled(this.sources.map(async source => {
      if (source.id === 'drift') {
        await this.http.get('https://data.api.drift.trade/stats/markets');
        return { ...source, status: 'catalog-only' as const, error: null, reason: 'API ответил. Активные BET-контракты, комиссии и котировки требуют отдельной проверки; фьючерсы не эквивалентны YES/NO.' };
      }
      const html = await this.http.getText('https://www.hedgehog.markets/');
      const catalog = hedgeCatalog(html);
      if (!catalog.length && !/<title>Hedgehog Markets<\/title>/i.test(html)) throw new Error('Hedgehog page format changed or wrong response');
      return { ...source, status: 'catalog-only' as const, error: null, catalog, reason: catalog.length
        ? 'Каталог доступен. P2P-предложения, комиссии и фиксированная выплата не подключены; цены для арбитража отсутствуют.'
        : 'Сайт доступен. Каталог загружается динамически; публичный API предложений не подтверждён. Исполнимых котировок нет.' };
    }));
    this.sources = results.map((r, i) => ({ ...(r.status === 'fulfilled' ? r.value : { ...this.sources[i]!, status: 'unavailable' as const, catalog: [], error: String(r.reason) }), checkedAt: new Date().toISOString() }));
    this.diagnostic?.('additional-sources-status', { sources: this.sources, routes: this.routes() });
  }
  routes() {
    const ids = ['polymarket', 'limitless', 'drift', 'hedgehog'];
    return ids.flatMap((left, i) => ids.slice(i + 1).map(right => ({ left, right,
      enabled: left === 'polymarket' && right === 'limitless',
      reason: left === 'polymarket' && right === 'limitless' ? 'Public order books; pair rules review required' : 'Additional venue executable quotes unavailable',
    })));
  }
}
