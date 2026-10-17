import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { PaperEngine, initialState } from '../dist/paper/engine.js';
import { DemoFeed } from '../dist/paper/demo.js';
import { paperSettingsSchema } from '../dist/paper/types.js';
import { loadConfig } from '../dist/config.js';

const now = Date.now(), demo = new DemoFeed(); demo.start('normal', now);
const original = demo.snapshot(now), pairs = [], books = [];
for (let i = 0; i < 1000; i++) {
  const pair = structuredClone(original.pairs[0]); pair.id += `-${i}`;
  for (const venue of ['polymarket', 'limitless']) pair[venue].slug += `-${i}`;
  pair.limitless.externalSlug = pair.polymarket.slug; pairs.push(pair);
  books.push(...original.books.map(book => ({ ...book, slug: `${book.slug}-${i}` })));
}
const feed = { at: now, pairs, books, ready: true };
const state = initialState('demo', paperSettingsSchema.parse({ maxPositions: 1, rejectProbability: 0, partialProbability: 0 }), now);
state.running = true; const engine = new PaperEngine(state, loadConfig({}));
const samples = [];
for (let i = 0; i < 23; i++) {
  state.trades = []; // Exercise the scan with a free slot on every iteration.
  const started = performance.now(); engine.step(feed); const duration = performance.now() - started;
  if (i >= 3) samples.push(duration);
}
samples.sort((a,b) => a-b);
const result = { at: new Date().toISOString(), node: process.version, pairs: pairs.length,
  description: 'Synthetic 1000-pair scan, unchanged snapshots; warmup excluded. CPU timing, not exchange execution latency.',
  medianMs: samples[Math.ceil(samples.length * .5)-1], p95Ms: samples[Math.ceil(samples.length * .95)-1], samples };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
