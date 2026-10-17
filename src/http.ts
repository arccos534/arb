import { profiler } from './profiling.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export interface RequestMetric {
  url: string;
  at: string;
  durationMs: number;
  status: number | null;
  ok: boolean;
}

export class HttpError extends Error {
  constructor(public readonly status: number, url: string, public readonly retryAfterMs: number | null = null) {
    super(`HTTP ${status}: ${url}`);
  }
}

// GET only. No signing, proxying, credentials, or trading endpoints in this stage.
export class PublicHttp {
  readonly metrics: RequestMetric[] = [];
  constructor(private readonly timeoutMs: number, private readonly diagnostic?: (category: string, payload: unknown) => void) {}

  async get(url: string): Promise<unknown> {
    return JSON.parse(await this.getText(url));
  }

  async getText(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.getTextOnce(url); }
      catch (error) {
        const retryable = error instanceof HttpError ? error.status === 429 || error.status >= 500 : error instanceof TypeError || (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name));
        if (!retryable || attempt >= 2) throw error;
        await delay(error instanceof HttpError && error.retryAfterMs !== null ? error.retryAfterMs : 1000 * (attempt + 1));
      }
    }
  }

  private async getTextOnce(url: string): Promise<string> {
    const started = performance.now();
    let status: number | null = null;
    let ok = false;
    const requestId = crypto.randomUUID();
    this.diagnostic?.('raw-http-request', { requestId, method: 'GET', url, startedAt: new Date().toISOString() });
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'arbitrage-research/0.1' },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
      status = response.status;
      const text = await response.text();
      this.diagnostic?.('raw-http-response', { requestId, url, status, durationMs: performance.now() - started, headers: Object.fromEntries(response.headers), body: text });
      if (!response.ok) {
        const retry = response.headers.get('retry-after');
        const parsed = retry === null ? null : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
        throw new HttpError(status, url, parsed !== null && Number.isFinite(parsed) ? Math.max(1000, parsed) : null);
      }
      ok = true;
      return text;
    } catch (e) {
      this.diagnostic?.('http-error', { requestId, url, status, durationMs: performance.now() - started, error: String(e) });
      throw e;
    } finally {
      profiler.end('http', started, !ok, 1);
      this.metrics.push({ url, at: new Date().toISOString(), durationMs: performance.now() - started, status, ok });
      if (this.metrics.length > 2000) this.metrics.splice(0, 1000);
    }
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (typeof value === 'string') return array(JSON.parse(value));
  if (!Array.isArray(value)) throw new Error('Expected array');
  return value;
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await fn(items[index]!);
    }
  }));
  return result;
}
