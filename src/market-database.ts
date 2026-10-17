import { Worker } from 'node:worker_threads';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Pair } from './domain.js';

export interface MarketCandidate {
  id: string; title: string; limitlessTitle: string; endsAt: string; score: number;
  review: Pair['review']; watched: boolean; entryReasons: string[]; quoteReason: string | null;
  profit: string | null; roi: string | null; direction: string | null; reasons: string[];
  evaluations: { roi: string | null; reasons: string[] }[];
  updatedAt: number; freshUntil: number; strategyEligible: boolean; entryReady: boolean;
}
export interface MarketQuery { filter?: 'all' | 'reviewed' | 'watching' | 'strategy'; search?: string }
export interface MarketResult { candidates: MarketCandidate[]; database: {status: string;total: number;calculated: number;freshCalculated: number;positive: number;eligible: number;ready: number;matched: number;version: number;updatedAt: number;persistedAt: number;pendingWrites: number;limit: number;error?: string | null} }

/** Materialized live index. CPU work is bounded per turn; SQLite lives on its
 * own thread. Only latest rows are retained, never the raw quote stream. */
export class MarketDatabase {
  readonly filename: string;
  error: string | null = null;
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly requests = new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  private readonly pairs = new Map<string,Pair>();
  private readonly dirty = new Set<string>();
  private readonly writes = new Map<string,MarketCandidate>();
  private timer: NodeJS.Timeout | undefined;
  private immediate: NodeJS.Timeout | undefined;
  private busy = false;
  private stopped = false;
  constructor(directory: string,private readonly evaluate: (pair:Pair)=>MarketCandidate) { this.filename=path.join(directory,'markets.sqlite'); }
  async open(): Promise<void> {
    await mkdir(path.dirname(this.filename),{recursive:true});
    const worker=new Worker(new URL('../scripts/market-database-worker.mjs',import.meta.url),{workerData:{filename:this.filename}});this.worker=worker;
    await new Promise<void>((resolve,reject)=>{
      worker.on('message',message=>{
        if(message.ready){resolve();return;}
        if(message.warning){this.error=message.warning;return;}
        const pending=this.requests.get(message.id);if(!pending)return;this.requests.delete(message.id);
        if(message.error){this.error=message.error;pending.reject(new Error(message.error));}else{this.error=null;pending.resolve(message.value);}
      });
      worker.on('error',error=>{this.error=String(error);reject(error);for(const p of this.requests.values())p.reject(error);this.requests.clear();});
      worker.on('exit',code=>{if(!this.stopped){const error=new Error(`Market database worker exited: ${code}`);this.error=error.message;reject(error);for(const p of this.requests.values())p.reject(error);this.requests.clear();}});
    });
    this.timer=setInterval(()=>{void this.flush().catch(error=>{this.error=String(error);});},150);
  }
  private request(type:string,fields:Record<string,unknown>={}):Promise<unknown>{
    if(!this.worker)return Promise.reject(new Error('Market database is not open'));
    const id=++this.sequence;return new Promise((resolve,reject)=>{this.requests.set(id,{resolve,reject});this.worker!.postMessage({id,type,...fields});});
  }
  catalog(pairs:Pair[],complete=true):void {
    this.pairs.clear();for(const pair of pairs)this.pairs.set(pair.id,pair);
    for(const id of this.dirty)if(!this.pairs.has(id))this.dirty.delete(id);
    for(const id of this.writes.keys())if(!this.pairs.has(id))this.writes.delete(id);
    void this.request('catalog',{ids:[...this.pairs.keys()],complete}).catch(error=>{this.error=String(error);});this.mark(this.pairs.keys());
  }
  mark(ids:Iterable<string>):void {if(this.stopped)return;for(const id of ids)if(this.pairs.has(id))this.dirty.add(id);this.arm();}
  invalidate():void {this.mark(this.pairs.keys());}
  private arm():void {
    if(this.immediate||this.stopped||!this.dirty.size)return;
    this.immediate=setTimeout(()=>{
      this.immediate=undefined;const start=performance.now();
      for(const id of this.dirty){this.dirty.delete(id);const pair=this.pairs.get(id);if(pair)try{this.writes.set(id,this.evaluate(pair));}catch(error){this.error=String(error);}
        if(performance.now()-start>=3)break;
      }
      this.arm();
    },10);
  }
  private async flush():Promise<void>{
    if(this.busy||!this.writes.size||this.stopped)return;this.busy=true;
    const rows=[...this.writes.values()];this.writes.clear();
    try{await this.request('upsert',{rows});}catch(error){for(const row of rows)if(!this.writes.has(row.id)&&this.pairs.has(row.id))this.writes.set(row.id,row);throw error;}finally{this.busy=false;}
  }
  async query(query:MarketQuery={}):Promise<MarketResult>{
    const result=await this.request('query',{query}) as MarketResult;result.database.error=this.error??result.database.error??null;return result;
  }
  async settle():Promise<void>{
    const deadline=Date.now()+20000;
    while(this.dirty.size||this.busy){if(Date.now()>deadline)throw new Error('Market index did not settle');await new Promise(resolve=>setTimeout(resolve,5));}
    await this.flush();
  }
  async close():Promise<void>{
    if(!this.worker)return;if(this.timer)clearInterval(this.timer);if(this.immediate)clearTimeout(this.immediate);
    while(this.busy)await new Promise(resolve=>setTimeout(resolve,5));
    await this.flush();this.stopped=true;await this.request('close');await this.worker.terminate();this.worker=undefined;
  }
}
