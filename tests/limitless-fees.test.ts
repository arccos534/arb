import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { limitlessFeeRate } from '../src/limitless-fees.js';
import { quoteBuy } from '../src/engine.js';
import { quoteSell } from '../src/paper/engine.js';
import { limitlessMarket } from '../src/markets.js';
import { book } from './fixtures.js';
const fee = { kind: 'limitless-curve', model: 'published-table-linear-v1' } as const;

describe('Limitless published fee table estimates', () => {
  it('matches representative buy/sell points and interpolates intermediate prices', () => {
    expect(limitlessFeeRate('buy', '0.5').toString()).toBe('0.03');
    expect(limitlessFeeRate('buy', '0.95').toString()).toBe('0.0053');
    expect(limitlessFeeRate('buy', '0.999').toString()).toBe('0.004');
    expect(limitlessFeeRate('buy', '0.575').toString()).toBe('0.02325');
    expect(limitlessFeeRate('sell', '0.5').toString()).toBe('0.015');
    expect(limitlessFeeRate('sell', '0.99').toString()).toBe('0.0045');
    expect(() => limitlessFeeRate('buy', '1')).toThrow('invalid');
  });
  it('requires fewer gross contracts at high prices and labels the estimate', () => {
    const b = book('limitless', 'yes', '0.999'); b.tickSize = '0.001';
    const q = quoteBuy(b, '10', fee);
    expect(q.grossShares).toBe('10.040161');
    expect(q.netShares).toBe('10');
    expect(q.feeEstimate).toBe(true);
    expect(q.feeLevels[0]?.rate).toBe('0.004');
  });
  it('covers equal net shares across levels with different rates and rounded deductions', () => {
    const b = book('limitless');
    b.asks = [{ price: '0.5', shares: '5' }, { price: '0.95', shares: '100' }];
    const q = quoteBuy(b, '10', fee);
    expect(q.feeLevels.map(l => l.rate)).toEqual(['0.03', '0.0053']);
    expect(new Decimal(q.netShares).gte(10)).toBe(true);
    expect(new Decimal(q.grossShares).minus(q.contractFee).toString()).toBe(q.netShares);
    expect(new Decimal(q.principal).toString()).toBe(new Decimal(5).mul('.5').plus(new Decimal(q.grossShares).minus(5).mul('.95')).toString());
    expect(() => quoteBuy({ ...b, asks: [b.asks[0]!] }, '5', fee)).toThrow('insufficient-depth');
  });
  it('deducts sell fees from USDC instead of contracts', () => {
    const b = book('limitless'); b.bids = [{ price: '0.99', shares: '100' }];
    const q = quoteSell(b, '10', fee);
    expect(q.shares).toBe('10'); expect(q.fee).toBe('0.04455'); expect(q.proceeds).toBe('9.85545');
  });
  it('reads explicit fee-free markets and rejects missing fee metadata', () => {
    const raw = { id: 1, slug: 'test', title: 'test', tradeType: 'clob', status: 'FUNDED', tokens: { yes: '1', no: '2' }, expirationTimestamp: Date.now() + 3600000 };
    expect(limitlessMarket({ ...raw, metadata: { fee: true } })?.fee).toEqual(fee);
    expect(limitlessMarket({ ...raw, metadata: { fee: false } })?.fee.kind).toBe('none');
    expect(limitlessMarket(raw)?.fee.kind).toBe('unknown');
  });
});
