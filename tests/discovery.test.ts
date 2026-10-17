import { describe, expect, it, vi } from 'vitest';
import { PublicAdapters } from '../src/adapters.js';
import { PublicHttp } from '../src/http.js';
import { loadConfig } from '../src/config.js';
import { inHorizon, polyMarket } from '../src/markets.js';
import { now } from './fixtures.js';

const poly = (id: number) => ({ id, slug: `market-${id}`, question: 'Will test happen?', active: true, closed: false,
  acceptingOrders: true, enableOrderBook: true, outcomes: ['Yes','No'], clobTokenIds: [`${id}-yes`,`${id}-no`],
  feesEnabled: false, endDate: new Date(now+365*86400000).toISOString() });

describe('complete catalogue discovery', () => {
  it('reads past the former 30-page boundary and includes distant expiry dates', async () => {
    const http=new PublicHttp(100), urls:string[]=[]; let page=0;
    vi.spyOn(http,'get').mockImplementation(async url=>{urls.push(url);page++;return {markets:[poly(page)],next_cursor:page<33?`cursor-${page}`:null};});
    const result=await new PublicAdapters(http,loadConfig({})).discoverPoly(now);
    expect(result.pages).toBe(33);expect(result.markets).toHaveLength(33);expect(result.truncated).toBe(false);
    expect(urls.every(u=>!new URL(u).searchParams.has('end_date_max'))).toBe(true);
    expect(new URL(urls[32]!).searchParams.get('after_cursor')).toBe('cursor-32');
  });
  it('reports explicit optional page limits as incomplete and rejects repeated cursors', async () => {
    const http=new PublicHttp(100);vi.spyOn(http,'get').mockResolvedValue({markets:[poly(1)],next_cursor:'same'});
    expect((await new PublicAdapters(http,loadConfig({MAX_PAGES:'1'})).discoverPoly(now)).truncated).toBe(true);
    await expect(new PublicAdapters(http,loadConfig({})).discoverPoly(now)).rejects.toThrow('cursor repeated');
  });
  it('continues Limitless pagination until completion and does not loop on a repeated page', async () => {
    const http=new PublicHttp(100);let page=0;
    vi.spyOn(http,'get').mockImplementation(async()=>{page++;return {data:page<4?Array.from({length:25},(_,i)=>({id:page*25+i,slug:`lm-${page}-${i}`,title:'test',tradeType:'clob',status:'FUNDED',metadata:{fee:true},tokens:{yes:'1',no:'2'},expirationTimestamp:now+365*86400000})):[],totalMarketsCount:75};});
    const result=await new PublicAdapters(http,loadConfig({})).discoverLimitless(now);
    expect(result.pages).toBe(3);expect(result.markets).toHaveLength(75);expect(result.truncated).toBe(false);
    vi.mocked(http.get).mockResolvedValue({data:Array.from({length:25},(_,id)=>({id})),totalMarketsCount:100});
    await expect(new PublicAdapters(http,loadConfig({})).discoverLimitless(now)).rejects.toThrow('page repeated');
  });
  it('includes near and far active expiries without including ended markets', () => {
    const config=loadConfig({}), m=polyMarket(poly(1))!;
    expect(config.MAX_WATCH_PAIRS).toBe(0);expect(config.MAX_PAGES).toBe(0);
    expect(inHorizon(m,config,now)).toBe(true);
    m.endsAt=new Date(now+1000).toISOString();expect(inHorizon(m,config,now)).toBe(true);
    m.endsAt=new Date(now).toISOString();expect(inHorizon(m,config,now)).toBe(false);
    m.endsAt=new Date(now+72*3600000).toISOString();expect(inHorizon(m,loadConfig({HORIZON_HOURS:'48'}),now)).toBe(false);
  });
  it('preserves named binary outcomes instead of discarding sports markets', () => {
    const m=polyMarket({...poly(1),outcomes:['Mike Malott','Joaquin Buckley']})!;
    expect(m.positiveLabel).toBe('Mike Malott');expect(m.negativeLabel).toBe('Joaquin Buckley');
    expect(m.yesToken).toBe('1-yes');expect(polyMarket({...poly(1),outcomes:['a','b','c']})).toBeNull();
  });
  it('hydrates every external counterpart in batches of at most 100 identifiers', async () => {
    const http=new PublicHttp(100), sizes:number[]=[];
    vi.spyOn(http,'get').mockImplementation(async url=>{
      const slugs=new URL(url).searchParams.getAll('slug');sizes.push(slugs.length);
      return {markets:slugs.map(slug=>poly(Number(slug.replace('market-',''))))};
    });
    const counterparts=Array.from({length:251},(_,i)=>({...polyMarket(poly(i))!,venue:'limitless' as const,slug:`lm-${i}`,externalSlug:`market-${i}`}));
    const filled=await new PublicAdapters(http,loadConfig({})).fillExternalMatches([],counterparts,now);
    expect(filled.markets).toHaveLength(251);expect(filled.errors).toEqual([]);expect(sizes.sort((a,b)=>a-b)).toEqual([51,100,100]);
  });
});
