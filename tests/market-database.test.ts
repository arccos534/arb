import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {describe,it,expect} from 'vitest';
import {MarketDatabase,type MarketCandidate} from '../src/market-database.js';
import {pair} from './fixtures.js';

describe('persistent live top-ten index',()=>{
  it('sorts the whole catalogue, filters before limiting, updates and expires rows, then restores only stale metadata',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'arb-market-index-'));
    const values=new Map<string,number>();let expiresAt=Date.now()+10000;
    const build=(p:ReturnType<typeof pair>):MarketCandidate=>({id:p.id,title:p.id,limitlessTitle:'reference',endsAt:p.polymarket.endsAt,score:1,review:{approved:Number(p.id.slice(1))%2===0,reasons:[]},watched:true,
      roi:String(values.get(p.id)??Number(p.id.slice(1))/10000),profit:'0.2',direction:'poly-yes-limitless-no',reasons:[],entryReasons:[],quoteReason:null,evaluations:[],updatedAt:Date.now(),freshUntil:expiresAt,strategyEligible:true,entryReady:true});
    const db=new MarketDatabase(directory,build);await db.open();
    try{
      const pairs=Array.from({length:1000},(_,i)=>({...pair(),id:`p${i}`}));db.catalog(pairs);await db.settle();
      const first=await db.query();expect(first.candidates).toHaveLength(10);expect(first.candidates[0]!.id).toBe('p999');expect(first.database.total).toBe(1000);
      const filtered=await db.query({filter:'reviewed'});expect(filtered.candidates[0]!.id).toBe('p998');expect(filtered.candidates.every(p=>p.review.approved)).toBe(true);
      expect((await db.query({search:'p3'})).candidates[0]!.id).toBe('p399');
      values.set('p1',1);db.mark(['p1']);await db.settle();expect((await db.query()).candidates[0]!.id).toBe('p1');
      expiresAt=Date.now()-1;db.invalidate();await db.settle();const expired=await db.query();expect(expired.candidates).toEqual([]);expect(expired.database.freshCalculated).toBe(0);
    }finally{await db.close();}
    const restored=new MarketDatabase(directory,build);await restored.open();
    try{const snapshot=await restored.query();expect(snapshot.database.total).toBe(1000);expect(snapshot.database.freshCalculated).toBe(0);expect(snapshot.candidates).toEqual([]);}
    finally{await restored.close();await rm(directory,{recursive:true,force:true});}
  });
  it('keeps negative results negative and removes markets absent from the new catalogue',async()=>{
    const directory=await mkdtemp(path.join(tmpdir(),'arb-market-negative-'));
    const db=new MarketDatabase(directory,p=>({id:p.id,title:p.id,limitlessTitle:'x',endsAt:p.polymarket.endsAt,score:1,review:p.review,watched:true,roi:'-0.02',profit:'-0.2',direction:null,reasons:[],entryReasons:[],quoteReason:null,evaluations:[],updatedAt:Date.now(),freshUntil:Date.now()+10000,strategyEligible:true,entryReady:false}));
    await db.open();try{db.catalog([{...pair(),id:'one'},{...pair(),id:'two'}]);await db.settle();let result=await db.query();expect(result.database.positive).toBe(0);expect(result.candidates.every(row=>Number(row.roi)<0)).toBe(true);
      db.catalog([{...pair(),id:'two'}]);await db.settle();result=await db.query();expect(result.candidates.map(p=>p.id)).toEqual(['two']);}
    finally{await db.close();await rm(directory,{recursive:true,force:true});}
  });
});
