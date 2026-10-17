import { describe, expect, it } from 'vitest';
import { matchMarkets, reviewPair, counterpartFilter, type Approval } from '../src/matching.js';
import { market, now } from './fixtures.js';

function approval(): Approval {
  return {
    polymarketSlug: 'btc-test', limitlessSlug: 'btc-other', polymarketRulesHash: 'a'.repeat(64), limitlessRulesHash: 'a'.repeat(64),
    reviewedBy: 'tester', reviewedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 1000).toISOString(),
    samePositiveOutcome: true, resolutionSourceChecked: true, observationTimeChecked: true,
    thresholdAndEqualityChecked: true, cancellationRulesChecked: true, notes: 'Source, observation, threshold and fallback rules reviewed.',
  };
}

describe('contract review', () => {
  it('retains every possible counterpart without keeping unrelated global market metadata', () => {
    const pm = market(), linked = market('limitless'); linked.externalSlug = pm.slug;
    const fuzzy = { ...market('limitless'), slug: 'fuzzy' };
    const irrelevant = { ...market(), slug: 'unrelated', title: 'Completely different sports result', endsAt: new Date(now + 7200000).toISOString() };
    const candidates = [pm, irrelevant], keep = counterpartFilter([linked, fuzzy], []);
    expect(keep(irrelevant)).toBe(false);
    const all = matchMarkets(candidates, [linked, fuzzy], [], now);
    expect(matchMarkets(candidates.filter(keep), [linked, fuzzy], [], now).map(p => p.id)).toEqual(all.map(p => p.id));
    expect(counterpartFilter([], [approval()])(pm)).toBe(true);
  });
  it('treats an external slug as a hint, not approval', () => {
    const lm = market('limitless'); lm.externalSlug = 'btc-test';
    const matches = matchMarkets([market()], [lm], [], now);
    expect(matches).toHaveLength(1); expect(matches[0]?.review.approved).toBe(false);
  });
  it('requires a review of the exact current rules and an unexpired review', () => {
    const pm = market(), lm = market('limitless');
    expect(reviewPair(pm, lm, [approval()], now).approved).toBe(true);
    pm.rulesHash = 'b'.repeat(64);
    expect(reviewPair(pm, lm, [approval()], now).reasons).toContain('rules-changed-since-review');
    expect(reviewPair(market(), lm, [approval()], now + 2000).reasons).toContain('review-expired');
  });
  it('keeps similar wording with a different close time out of fuzzy candidates', () => {
    const lm = market('limitless'); lm.endsAt = new Date(now + 7200000).toISOString();
    expect(matchMarkets([market()], [lm], [], now)).toHaveLength(0);
  });
  it('never pairs ETH or a daily market against a conflicting explicit provider mapping', () => {
    const pm=market(); pm.slug='ethereum-daily'; pm.title='Ethereum Up or Down on October 16?';
    const lm=market('limitless'); lm.title='BTC Up or Down Daily'; lm.externalSlug='bitcoin-daily';
    expect(matchMarkets([pm],[lm],[],now)).toHaveLength(0);
    lm.title='ETH Up or Down Hourly'; lm.externalSlug='ethereum-hourly';
    expect(matchMarkets([pm],[lm],[],now)).toHaveLength(0);
    lm.externalSlug=pm.slug;
    expect(matchMarkets([pm],[lm],[],now)).toHaveLength(1);
  });
});
