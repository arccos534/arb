import { setTimeout } from 'node:timers/promises';
import type { Config } from './config.js';
import { PublicHttp } from './http.js';
import { ResearchStorage } from './storage.js';

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

export async function benchmark(config: Config, samples: number): Promise<unknown> {
  const http = new PublicHttp(config.REQUEST_TIMEOUT_MS, undefined, config.MIN_HTTP_INTERVAL_MS);
  const urls = [
    'https://gamma-api.polymarket.com/markets?limit=1&closed=false',
    'https://clob.polymarket.com/time',
    'https://api.limitless.exchange/markets/active?limit=1',
    'https://api.bybit.com/v5/market/time',
  ];
  // Warm each endpoint separately; this measures public HTTP response time,
  // not exchange execution latency and not physical distance to the matching engine.
  for (let i = 0; i < samples + 1; i++) {
    await Promise.allSettled(urls.map(url => http.get(url)));
    if (i < samples) await setTimeout(250);
  }
  const result = {
    at: new Date().toISOString(), samples,
    description: 'Public GET latency incl. response body; warm-up excluded. CDN/cache/routes affect results. No order execution is measured.',
    endpoints: urls.map(url => {
      const requests = http.metrics.filter(m => m.url === url).slice(1);
      const durations = requests.filter(m => m.ok).map(m => m.durationMs);
      return { url, successful: durations.length, failed: requests.length - durations.length, medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99), requests };
    }),
  };
  const store = new ResearchStorage(config);
  try { await store.open(); await store.latest('benchmark', result); await store.event('benchmark', result); }
  finally { await store.close(); }
  return result;
}
