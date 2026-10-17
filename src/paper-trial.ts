import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { startServer } from './server.js';
import { loadConfig } from './config.js';
import { profiler } from './profiling.js';
import { paperSettingsSchema } from './paper/types.js';
import { atomicWriteFile } from './atomic-file.js';

// A new directory is mandatory. Never opens or resumes the main repository.
const durationMs = Number(process.env.PAPER_TRIAL_MS ?? 600000);
if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 86400000) throw new Error('Trial must be between 1 second and 24 hours');
const sourceDirectory = path.resolve('data');
const directory = path.join(sourceDirectory, 'paper-trials', `${Date.now()}-${randomUUID()}`);
const source = JSON.parse(await readFile(path.join(sourceDirectory, 'paper-live/state.json'), 'utf8'));
const settings = paperSettingsSchema.parse({ ...source.settings, initialPerVenue: '100', skipManualReview: false });
await mkdir(directory, { recursive: true });
await copyFile(path.join(sourceDirectory, 'paper-reviews.json'), path.join(directory, 'paper-reviews.json'));
const startedAt = new Date().toISOString(), began = performance.now();
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ startedAt, durationMs, sourceSession: source.sessionId,
  sourceSettingsHash: createHash('sha256').update(JSON.stringify(source.settings)).digest('hex'), settings,
  differences: 'Separate $200 paper bankroll; manual equivalence review required even if main session bypasses it.' }, null, 2));
profiler.enabled = true;
const instance = await startServer({ config: loadConfig({ DATA_DIR: directory, LOG_LEVEL: 'warn' }), port: 4318 });
await instance.app.command('live', 'settings', settings);
await instance.app.command('live', 'start', undefined);
console.log(JSON.stringify({ directory, url: instance.url, startedAt, durationMs }));
let status = 'running', samples = 0;
const observedReasons: Record<string, number> = {};
async function report() {
  const app = instance.app, state = app.engines.live.state, feed = app.feed('live');
  const reviewed = feed.pairs.filter(p => p.review.approved && (!p.review.validUntil || Date.parse(p.review.validUntil) > feed.at));
  samples++; observedReasons['manual-review-required'] = (observedReasons['manual-review-required'] ?? 0) + feed.pairs.length - reviewed.length;
  await atomicWriteFile(path.join(directory, 'report.json'), JSON.stringify({ schemaVersion: 1, startedAt, updatedAt: new Date().toISOString(), status,
    elapsedMs: performance.now() - began, samples, reasonUnit: 'pair observations at 30-second sampling; not unique signals', observedReasons,
    cataloguePairs: feed.pairs.length, reviewedPairs: reviewed.length, books: feed.books.length, feed: app.observer?.liveHealth(),
    trades: state.trades.length, statuses: state.trades.reduce<Record<string, number>>((r, t) => { r[t.status] = (r[t.status] ?? 0) + 1; return r; }, {}),
    cash: state.cash, realizedPnl: state.realizedPnl, blockedSignals: state.entryDiagnostics, profiling: profiler.report() }));
}
try {
  while (performance.now() - began < durationMs && !instance.app.engines.live.state.haltReason) {
    await report(); await new Promise(resolve => setTimeout(resolve, Math.min(30000, Math.max(1, durationMs - (performance.now() - began)))));
  }
  status = instance.app.engines.live.state.haltReason ? 'risk-halt' : 'completed-window';
} finally {
  await instance.app.command('live', 'pause', undefined);
  await report(); await instance.close();
}
