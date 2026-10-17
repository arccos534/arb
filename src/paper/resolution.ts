import { Decimal } from 'decimal.js';
import { PublicHttp, array, record } from '../http.js';
import type { Resolution } from './types.js';
import { binaryOutcomeIndices } from '../markets.js';

export function parsePolyResolution(value: unknown, slug: string, now = Date.now()): Resolution | null {
  const raw = record(value);
  let statuses: unknown[] = [];
  try { statuses = array(raw.umaResolutionStatuses ?? []); } catch { /* unknown status is not final */ }
  const finalStatus = typeof raw.umaResolutionStatus === 'string' ? raw.umaResolutionStatus === 'resolved' : raw.resolved === true || statuses.at(-1) === 'resolved';
  const final = raw.closed === true && finalStatus;
  if (!final) return null;
  const outcomes = array(raw.outcomes).map(v => String(v).toLowerCase());
  const prices = array(raw.outcomePrices).map(v => String(v));
  const side = binaryOutcomeIndices(outcomes);
  if (!side || prices.length !== 2) return null;
  const yi = side.yes, ni = side.no;
  const yes = new Decimal(prices[yi]!), no = new Decimal(prices[ni]!);
  if (yes.lt(0) || yes.gt(1) || no.lt(0) || no.gt(1) || !yes.plus(no).eq(1)) return null;
  if (![yes.toString(), no.toString()].every(v => ['0', '0.5', '1'].includes(v))) return null;
  return { venue: 'polymarket', slug, yesPayout: yes.toString(), noPayout: no.toString(), evidence: raw, at: now };
}
export function parseLimitlessResolution(value: unknown, slug: string, now = Date.now()): Resolution | null {
  const raw = record(value);
  if (raw.status !== 'RESOLVED' || ![0, 1].includes(raw.winningOutcomeIndex as number)) return null;
  return { venue: 'limitless', slug, yesPayout: raw.winningOutcomeIndex === 0 ? '1' : '0', noPayout: raw.winningOutcomeIndex === 0 ? '0' : '1', evidence: raw, at: now };
}
export async function fetchResolution(http: PublicHttp, venue: 'polymarket' | 'limitless', slug: string): Promise<Resolution | null> {
  if (venue === 'polymarket') {
    const rows = array(await http.get(`https://gamma-api.polymarket.com/markets?${new URLSearchParams({ slug })}`));
    return rows.length === 1 ? parsePolyResolution(rows[0], slug) : null;
  }
  return parseLimitlessResolution(await http.get(`https://api.limitless.exchange/markets/${encodeURIComponent(slug)}`), slug);
}
