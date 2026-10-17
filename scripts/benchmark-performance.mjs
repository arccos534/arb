import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cpus, platform } from 'node:os';
import { BookCache } from '../dist/books.js';
import { PolyStreamState, LimitlessStreamState } from '../dist/streams.js';
import { PaperEngine, initialState } from '../dist/paper/engine.js';
import { DemoFeed } from '../dist/paper/demo.js';
import { paperSettingsSchema } from '../dist/paper/types.js';
import { loadConfig } from '../dist/config.js';
import { profiler } from '../dist/profiling.js';

profiler.enabled = false;
const now = Date.now(), demo = new DemoFeed(); demo.start('normal', now);
const original = demo.snapshot(now), template = original.pairs[0], results = [];
function measure(label, fn, count = 2000) {
  for (let i = 0; i < 200; i++) fn(i);
  const samples = [];
  for (let i = 200; i < count + 200; i++) { const start = performance.now(); fn(i); samples.push(performance.now() - start); }
  samples.sort((a,b) => a-b);
  results.push({ label, samples: count, p50Ms: samples[Math.ceil(count * .5)-1], p95Ms: samples[Math.ceil(count * .95)-1],
    p99Ms: samples[Math.ceil(count * .99)-1], meanMs: samples.reduce((a,b) => a+b,0)/count });
}
for (const depth of [20,100]) {
  const asks = Array.from({ length: depth }, (_,i) => ({ price: (.55+i*.001).toFixed(3), size: '100' }));
  const bids = Array.from({ length: depth }, (_,i) => ({ price: (.45-i*.001).toFixed(3), size: '100' }));
  const poly = template.polymarket, lm = template.limitless;
  const body = JSON.stringify({ event_type:'book', asset_id:poly.yesToken, asks,bids, timestamp:now, tick_size:'0.001', min_order_size:'1' });
  measure(`JSON.parse Poly full ${depth}+${depth} levels`, () => JSON.parse(body));
  const state = new PolyStreamState([poly],new BookCache());
  measure(`Poly full JSON+normalize+cache ${depth}+${depth} levels`, () => state.apply(JSON.parse(body),now));
  const delta = JSON.stringify({ event_type:'price_change', timestamp:now, price_changes:[{ asset_id:poly.yesToken, side:'SELL', price:'0.55', size:'101' }] });
  measure(`Poly delta JSON+update+cache ${depth} asks`, () => state.apply(JSON.parse(delta),now));
  const lmBody = JSON.stringify({ marketSlug:lm.slug, orderbook:{ tokenId:lm.yesToken, asks:asks.map(r=>({...r,size:100000000})), bids:bids.map(r=>({...r,size:100000000})) }, version:0,timestamp:now });
  const lmState = new LimitlessStreamState([lm],new BookCache());
  measure(`Limitless full JSON+normalize YES/NO+cache ${depth}+${depth} levels`, i => { const raw=JSON.parse(lmBody); raw.version=i; lmState.apply(raw,now); });
}
const pairs = [], books = [], bookCache = new BookCache();
for (let i = 0; i < 1000; i++) {
  const p = structuredClone(template); p.id += `-${i}`;
  for (const venue of ['polymarket','limitless']) p[venue].slug += `-${i}`;
  p.limitless.externalSlug = p.polymarket.slug; pairs.push(p);
  books.push(...original.books.map(b=>({...b,slug:`${b.slug}-${i}`})));
}
books.forEach(b=>bookCache.set(b));
// Old engines ignore bookCache and use books. New engines use lazy overlays.
const feed = { at:now,pairs,books,bookCache,ready:true };
const makeEngine = () => {
  const state = initialState('demo',paperSettingsSchema.parse({maxPositions:1,rejectProbability:0,partialProbability:0}),now);
  state.running = true; return new PaperEngine(state,loadConfig({}));
};
const warm = makeEngine();
measure('PaperEngine full scan 1000 pairs; unchanged books, warm cache',()=>{warm.state.trades=[];warm.step(feed);},100);
const changed = makeEngine();
measure('PaperEngine full scan 1000 pairs; all book arrays changed',()=>{
  changed.state.trades=[];for(const b of books){b.asks=b.asks.map(l=>({...l}));b.bids=b.bids.map(l=>({...l}));}changed.step(feed);
},60);
const sparse = makeEngine(), ids = new Set([pairs[0].id]);
measure('PaperEngine one changed pair; feed still contains 1000 pairs',()=>{
  sparse.state.trades=[];for(const b of books.slice(0,4)){b.asks=b.asks.map(l=>({...l}));b.bids=b.bids.map(l=>({...l}));}sparse.step(feed,ids);
},100);
const result = { at:new Date().toISOString(),node:process.version,cpu:cpus()[0]?.model,platform:platform(),
  scope:'Synthetic CPU timings, 200 warmups. No network, queue waits, UI, persistence or exchange execution. Changed-array case includes allocation; not production throughput.',results };
if(process.argv[2]) { await mkdir(path.dirname(process.argv[2]),{recursive:true});await writeFile(process.argv[2],JSON.stringify(result,null,2)); }
for(const row of results) console.log(JSON.stringify({label:row.label,p50Ms:+row.p50Ms.toFixed(4),p95Ms:+row.p95Ms.toFixed(4),p99Ms:+row.p99Ms.toFixed(4)}));
