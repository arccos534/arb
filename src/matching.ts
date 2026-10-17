import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Market, Pair } from './domain.js';

const approvalSchema = z.object({
  polymarketSlug: z.string().min(1), limitlessSlug: z.string().min(1),
  polymarketRulesHash: z.string().regex(/^[a-f0-9]{64}$/), limitlessRulesHash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewedBy: z.string().min(1), reviewedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  samePositiveOutcome: z.literal(true), resolutionSourceChecked: z.literal(true),
  observationTimeChecked: z.literal(true), thresholdAndEqualityChecked: z.literal(true),
  cancellationRulesChecked: z.literal(true), notes: z.string().min(20),
});
export type Approval = z.infer<typeof approvalSchema>;
export async function loadApprovals(path = 'config/pairs.json'): Promise<Approval[]> {
  return z.array(approvalSchema).parse(JSON.parse(await readFile(path, 'utf8')));
}

function words(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/bitcoin/g, 'btc').replace(/ethereum/g, 'eth').replace(/\b(yes|no|will|the|be|on|at|a|an)\b/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []);
}

export function similarity(left: string, right: string): number {
  const a = words(left), b = words(right);
  const intersection = [...a].filter(word => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function reviewPair(poly: Market, limitless: Market, approvals: Approval[], now = Date.now()): Pair['review'] {
  const approval = approvals.find(a => a.polymarketSlug === poly.slug && a.limitlessSlug === limitless.slug);
  if (!approval) return { approved: false, reasons: ['manual-rules-review-required'] };
  const reasons: string[] = [];
  if (approval.polymarketRulesHash !== poly.rulesHash || approval.limitlessRulesHash !== limitless.rulesHash) reasons.push('rules-changed-since-review');
  if (Date.parse(approval.validUntil) <= now) reasons.push('review-expired');
  if (Date.parse(approval.reviewedAt) > now || Date.parse(approval.validUntil) <= Date.parse(approval.reviewedAt)) reasons.push('invalid-review-dates');
  if (Date.parse(poly.endsAt) <= now || Date.parse(limitless.endsAt) <= now) reasons.push('market-ended');
  return { approved: reasons.length === 0, reasons, validUntil: approval.validUntil };
}

export function matchMarkets(poly: Market[], limitless: Market[], approvals: Approval[], now = Date.now()): Pair[] {
  const pairs: Pair[] = [];
  const bySlug = new Map(poly.map(m => [m.slug, m]));
  const byMinute = new Map<number, Market[]>();
  for (const m of poly) { const minute = Math.floor(Date.parse(m.endsAt) / 60000); const bucket = byMinute.get(minute) ?? []; bucket.push(m); byMinute.set(minute, bucket); }
  for (const lm of limitless) {
    const minute = Math.floor(Date.parse(lm.endsAt) / 60000);
    const candidates = lm.externalSlug ? [bySlug.get(lm.externalSlug)].filter((m): m is Market => Boolean(m))
      : [...new Map([
        ...[-1, 0, 1].flatMap(offset => byMinute.get(minute + offset) ?? []),
        ...approvals.filter(a => a.limitlessSlug === lm.slug).flatMap(a => bySlug.get(a.polymarketSlug) ?? []),
      ].map(m => [m.slug, m])).values()];
    for (const pm of candidates) {
    const external = lm.externalSlug === pm.slug;
    // An explicit provider mapping rules out every other fuzzy match.
    if (lm.externalSlug && !external) continue;
    const reviewed = approvals.some(a => a.polymarketSlug === pm.slug && a.limitlessSlug === lm.slug);
    const delta = Math.abs(Date.parse(pm.endsAt) - Date.parse(lm.endsAt));
    const score = similarity(pm.title, lm.title);
    if (!external && !reviewed && (delta > 60000 || score < 0.35)) continue;
    pairs.push({
      id: `${pm.slug}::${lm.slug}`, polymarket: pm, limitless: lm,
      score: external ? 1 : score,
      reasons: external ? ['platform-external-slug-hint-not-proof'] : ['title-and-expiry-candidate-not-proof'],
      review: reviewPair(pm, lm, approvals, now),
    });
    }
  }
  return pairs.sort((a, b) => Number(b.review.approved) - Number(a.review.approved) || b.score - a.score || Date.parse(a.polymarket.endsAt) - Date.parse(b.polymarket.endsAt));
}

// The global catalogue is still paginated in full. Keep only metadata that can
// participate in a pair with the current opposite-venue universe; this uses the
// same candidate conditions as matchMarkets, without a numerical market cap.
export function counterpartFilter(limitless: Market[], approvals: Approval[]): (market: Market) => boolean {
  const explicit = new Set([...limitless.flatMap(m => m.externalSlug ? [m.externalSlug] : []), ...approvals.map(a => a.polymarketSlug)]);
  const byMinute = new Map<number, Market[]>();
  for (const m of limitless) if (!m.externalSlug) { const key = Math.floor(Date.parse(m.endsAt) / 60000); const bucket = byMinute.get(key) ?? []; bucket.push(m); byMinute.set(key, bucket); }
  return market => {
    if (explicit.has(market.slug)) return true;
    const minute = Math.floor(Date.parse(market.endsAt) / 60000);
    return [-1, 0, 1].some(offset => (byMinute.get(minute + offset) ?? []).some(m => Math.abs(Date.parse(m.endsAt) - Date.parse(market.endsAt)) <= 60000 && similarity(market.title, m.title) >= .35));
  };
}

export function identityBlockers(pair: Pair): string[] {
  if (pair.limitless.externalSlug && pair.limitless.externalSlug !== pair.polymarket.slug) return ['conflicting-market-identity'];
  if (!pair.review.approved && Math.abs(Date.parse(pair.polymarket.endsAt) - Date.parse(pair.limitless.endsAt)) > 1000) return ['unverified-observation-window'];
  const labels = [pair.polymarket.positiveLabel, pair.polymarket.negativeLabel, pair.limitless.positiveLabel, pair.limitless.negativeLabel];
  if (!pair.review.approved && labels.some(v => !['yes', 'no', 'up', 'down'].includes(v.trim().toLowerCase()))) return ['named-outcome-review-required'];
  return [];
}
