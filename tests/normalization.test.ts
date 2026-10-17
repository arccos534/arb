import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { BookCache, limitlessBooks, polyBook } from '../src/books.js';
import { limitlessMarket, polyMarket } from '../src/markets.js';
import { PolyStreamState, LimitlessStreamState, PublicStreams } from '../src/streams.js';
import { market, now } from './fixtures.js';

describe('venue normalization', () => {
  it('converts Limitless micro-contract sizes and derives NO from YES bids', () => {
    const [yes, no] = limitlessBooks({ tokenId: 'limitless-yes', asks: [{ price: 0.65, size: 12000000 }], bids: [{ price: 0.6, size: 150000000 }], minSize: '50000000' }, market('limitless'));
    expect(yes?.asks[0]).toEqual({ price: '0.65', shares: '12' });
    expect(no?.asks[0]).toEqual({ price: '0.4', shares: '150' });
    expect(no?.minOrderShares).toBeNull(); // LP threshold must not reject small real orders.
  });
  it('sorts Polymarket reversed books and rejects a wrong asset', () => {
    const raw = { asset_id: 'polymarket-yes', bids: [], asks: [{ price: '0.8', size: '10' }, { price: '0.2', size: '4' }] };
    expect(polyBook(raw, market(), 'yes').asks[0]?.price).toBe('0.2');
    expect(() => polyBook(raw, market(), 'no')).toThrow('mismatch');
  });
  it('keeps rules hashes stable under volume changes but changes them for rule changes', () => {
    const raw = { active: true, acceptingOrders: true, enableOrderBook: true, closed: false, outcomes: '["Yes","No"]', clobTokenIds: '["1","2"]', endDate: '2026-10-17T12:00:00Z', description: 'rules', events: [{ description: 'event rules', volume: 100 }], feesEnabled: false };
    const a = polyMarket(raw)!;
    const b = polyMarket({ ...raw, volume: 500, events: [{ description: 'event rules', volume: 500 }] })!;
    expect(a.rulesHash).toBe(b.rulesHash);
    expect(polyMarket({ ...raw, description: 'new rules' })!.rulesHash).not.toBe(a.rulesHash);
  });
  it('does not assume missing fee metadata means zero fees', () => {
    const raw = { active: true, acceptingOrders: true, enableOrderBook: true, outcomes: ['No', 'Yes'], clobTokenIds: ['no', 'yes'] };
    const m = polyMarket(raw)!;
    expect(m.fee.kind).toBe('unknown'); expect(m.yesToken).toBe('yes');
  });
  it('skips AMM Limitless markets', () => {
    expect(limitlessMarket({ tradeType: 'amm' }, '0.03')).toBeNull();
  });
});

describe('stream state', () => {
  it('partitions large subscriptions without dropping any markets', () => {
    vi.useFakeTimers();
    const prototype=PublicStreams.prototype as unknown as {connectPoly:()=>void;connectLimitless:()=>void};
    const poly=vi.spyOn(prototype,'connectPoly').mockImplementation(()=>{});
    const lm=vi.spyOn(prototype,'connectLimitless').mockImplementation(()=>{});
    const markets=Array.from({length:305},(_,i)=>({...market(),slug:`m-${i}`}));
    const stream=new PublicStreams(markets,[],new BookCache(),pino({level:'silent'}));
    try {
      stream.start();vi.runAllTimers();expect(poly).toHaveBeenCalledTimes(4);
      const chunks=poly.mock.contexts as unknown as {poly:{slug:string}[]}[];
      expect(chunks.every(c=>c.poly.length<=100)).toBe(true);
      expect(new Set(chunks.flatMap(c=>c.poly.map(m=>m.slug))).size).toBe(305);
      expect(lm).not.toHaveBeenCalled();
    } finally {stream.stop();poly.mockRestore();lm.mockRestore();vi.useRealTimers();}
  });
  it('applies absolute Poly deltas and removes size-zero levels', () => {
    const cache = new BookCache(), m = market(), stream = new PolyStreamState([m], cache);
    stream.apply({ event_type: 'book', asset_id: m.yesToken, bids: [], asks: [{ price: '0.5', size: '10' }], timestamp: now }, now);
    stream.apply({ event_type: 'price_change', timestamp: now + 1, price_changes: [{ asset_id: m.yesToken, side: 'SELL', price: '0.5', size: '0' }, { asset_id: m.yesToken, side: 'SELL', price: '0.6', size: '20' }] }, now + 1);
    expect(cache.get('polymarket', m.slug, 'yes')?.asks).toEqual([{ price: '0.6', shares: '20' }]);
  });
  it('drops out-of-order Poly deltas and invalidates on tick changes', () => {
    const cache = new BookCache(), m = market(), stream = new PolyStreamState([m], cache);
    stream.apply({ event_type: 'book', asset_id: m.yesToken, bids: [], asks: [{ price: '0.5', size: '10' }], timestamp: now }, now);
    stream.apply({ event_type: 'price_change', timestamp: now - 1, price_changes: [{ asset_id: m.yesToken, side: 'SELL', price: '0.5', size: '0' }] }, now + 1);
    expect(cache.get('polymarket', m.slug, 'yes')?.asks).toHaveLength(1);
    stream.apply({ event_type: 'tick_size_change', asset_id: m.yesToken, new_tick_size: '0.001', timestamp: now + 2 });
    expect(cache.get('polymarket', m.slug, 'yes')).toBeUndefined();
    stream.apply({ event_type: 'book', asset_id: m.yesToken, bids: [], asks: [{ price: '0.626', size: '80' }], timestamp: now + 1 }, now + 3);
    expect(cache.get('polymarket', m.slug, 'yes')).toBeUndefined();
    stream.apply({ event_type: 'book', asset_id: m.yesToken, bids: [], asks: [{ price: '0.626', size: '80' }], timestamp: now + 3 }, now + 3);
    expect(cache.get('polymarket', m.slug, 'yes')?.tickSize).toBe('0.001');
  });
  it('keeps prior snapshots immutable and inserts canonical delta prices in the right order', () => {
    const cache = new BookCache(), m = market(), stream = new PolyStreamState([m], cache);
    stream.apply({ event_type: 'book', asset_id: m.yesToken, tick_size: '0.01', min_order_size: '5', bids: [{price:'0.3',size:'5'}], asks: [{ price: '0.5', size: '10' },{price:'0.7',size:'5'}], timestamp: now }, now);
    const first = cache.get('polymarket', m.slug, 'yes')!;
    stream.apply({ event_type: 'price_change', timestamp: now + 1, price_changes: [
      {asset_id:m.yesToken,side:'SELL',price:'0.50',size:'20'}, {asset_id:m.yesToken,side:'SELL',price:'0.6',size:'8'},
      {asset_id:m.yesToken,side:'BUY',price:'0.4',size:'9'},
    ]},now+1);
    const next=cache.get('polymarket',m.slug,'yes')!;
    expect(first.asks).toEqual([{price:'0.5',shares:'10'},{price:'0.7',shares:'5'}]);
    expect(next.asks.map(l=>l.price)).toEqual(['0.5','0.6','0.7']);expect(next.asks[0]!.shares).toBe('20');
    expect(next.bids.map(l=>l.price)).toEqual(['0.4','0.3']);expect(next.tickSize).toBe('0.01');expect(next.minOrderShares).toBe('5');
  });
  it('ignores Limitless older versions, accepts a fresh snapshot after reconnect', () => {
    const cache = new BookCache(), m = market('limitless');
    const state = new LimitlessStreamState([m], cache);
    const frame = (version: number, price: number) => ({ marketSlug: m.slug, version, timestamp: now + version, orderbook: { bids: [], asks: [{ price, size: 10000000 }] } });
    state.apply(frame(5, 0.5), now + 5); state.apply(frame(4, 0.4), now + 6);
    expect(cache.get('limitless', m.slug, 'yes')?.asks[0]?.price).toBe('0.5');
    cache.clearVenue('limitless');
    new LimitlessStreamState([m], cache).apply(frame(0, 0.3), now + 7);
    expect(cache.get('limitless', m.slug, 'yes')?.asks[0]?.price).toBe('0.3');
  });
});
