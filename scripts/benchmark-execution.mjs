import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { quoteBuy as before } from '../data/backups/20261017-profiling/dist/engine.js';
import { quoteBuy as after } from '../dist/engine.js';
import { profiler } from '../dist/profiling.js';

const book = { venue: 'limitless', slug: 'benchmark', outcome: 'yes', assetId: 'fixture', receivedAt: Date.now(), sourceTimestamp: null,
  asks: Array.from({ length: 20 }, (_, i) => ({ price: String(.50 + i * .005), shares: '1' })), bids: [] };
const fee = { kind: 'limitless-curve' };
assert.deepEqual(after(book, '10', fee), before(book, '10', fee));
const runs = { before: [], after: [], profiled: [] };
for (let round = 0; round < 8; round++) {
  for (const name of round % 2 ? ['profiled', 'after', 'before'] : ['before', 'after', 'profiled']) {
    profiler.enabled = name === 'profiled';
    const fn = name === 'before' ? before : after;
    for (let i = 0; i < 100; i++) fn(book, '10', fee);
    const start = performance.now();
    for (let i = 0; i < 2000; i++) fn(book, '10', fee);
    runs[name].push((performance.now() - start) / 2000);
  }
}
const summary = Object.fromEntries(Object.entries(runs).map(([key, values]) => {
  values.sort((a, b) => a - b); return [key, { medianMs: (values[3] + values[4]) / 2, rounds: values }];
}));
const result = { at: new Date().toISOString(), fixture: 'synthetic 20-level quote; not network latency or market execution', callsPerVersion: 16800, summary, profile: profiler.report() };
await mkdir('data/analysis', { recursive: true });
await writeFile('data/analysis/execution-benchmark.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(summary));
