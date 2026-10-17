import { profiler } from '../profiling.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { ResearchRunner } from '../research.js';
import { PaperEngine, initialState } from '../paper/engine.js';
import { paperSettingsSchema } from '../paper/types.js';
import { DecisionScheduler } from '../decision-scheduler.js';
import { ExecutionRecorder } from './execution.js';
import { DiagnosticArchive } from './archive.js';

const run = promisify(execFile);
const settings = paperSettingsSchema.parse(JSON.parse(await readFile(process.env.DIAGNOSTICS_SETTINGS_FILE ?? 'diagnostic-settings.json', 'utf8')));
const minimum = Number(process.env.DIAGNOSTICS_MIN_SIGNALS ?? 30), hours = Number(process.env.DIAGNOSTICS_MAX_HOURS ?? 24);
if (!Number.isInteger(minimum) || minimum < 1 || minimum > 300 || !Number.isFinite(hours) || hours <= 0 || hours > 24) throw new Error('Invalid diagnostic limits');
const directory = path.resolve(process.env.DATA_DIR ?? './data/diagnostics');
await mkdir(directory, { recursive: true });
const reviews = path.join(directory, 'reviews.json');
try { await readFile(reviews); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; await writeFile(reviews, '[]\n', { mode: 0o600 }); }
const config = loadConfig({ ...process.env, DATA_DIR: path.join(directory, 'catalog'), LOG_LEVEL: 'silent', DATABASE_URL: '', STORAGE_POSTGRES: 'false',
  HORIZON_HOURS: String(settings.maxHoldingHours), MIN_HOURS_TO_END: '0', MAX_WATCH_PAIRS: '0', MAX_PAGES: '0',
  DISCOVERY_INTERVAL_SECONDS: '60', MAX_BOOK_AGE_MS: String(settings.maxQuoteAgeMs), MAX_BOOK_SKEW_MS: String(settings.maxQuoteSkewMs) });
const archive = new DiagnosticArchive(directory), previous = await archive.open();
const startedAt = typeof previous?.startedAt === 'string' ? previous.startedAt : new Date().toISOString();
const remainingMs = Math.max(0, hours * 3600000 - (Date.now() - Date.parse(startedAt)));
const deadline = performance.now() + remainingMs;
const recorder = new ExecutionRecorder();
const attempts = new Map<string, { count: number; last: number }>();
for (const c of archive.cases) {
  const old = attempts.get(c.pairId); attempts.set(c.pairId, { count: (old?.count ?? 0) + 1, last: performance.now() });
}
let stop = false, error: string | null = null, observerError: string | null = null, droppedSignals = 0, status = 'collecting';
let clock = { trusted: false, detail: 'not checked' };
async function checkClock() {
  try {
    const result = await run('timedatectl', ['show', '--property=NTPSynchronized', '--value'], { timeout: 5000 });
    clock = { trusted: result.stdout.trim() === 'yes', detail: result.stdout.trim() };
  } catch (e) { clock = { trusted: false, detail: String(e) }; }
  recorder.setClockTrusted(clock.trusted);
}
await checkClock();
let runner!: ResearchRunner;
const scheduler = new DecisionScheduler(async ids => {
  if (stop || performance.now() >= deadline || !clock.trusted) return;
  const snapshot = runner.snapshot(false), now = performance.now();
  if (!snapshot.ready || now - boot < 2000) return;
  const eligible = new Set(snapshot.pairs.filter(p => (!ids || ids.has(p.id)) && Date.parse(p.polymarket.endsAt) > Date.now() + settings.minSecondsToEnd * 1000).filter(p => {
    const prior = attempts.get(p.id); return !prior || prior.count < settings.maxAttemptsPerPair && now - prior.last >= settings.retryCooldownMs;
  }).map(p => p.id));
  if (!eligible.size) return;
  const engine = new PaperEngine(initialState('live', settings, snapshot.at), config);
  engine.state.running = true; engine.step(snapshot, eligible);
  for (const trade of engine.state.trades) {
    if (!recorder.start(trade, settings, snapshot)) { droppedSignals++; continue; }
    const prior = attempts.get(trade.pairId); attempts.set(trade.pairId, { count: (prior?.count ?? 0) + 1, last: now });
  }
}, e => { error = String(e); stop = true; });
runner = new ResearchRunner(config, pino({ level: 'silent' }), undefined, reviews, () => [], true, ids => scheduler.request(ids),
  { book: book => recorder.observe(book), invalidate: key => recorder.invalidate(key) });
const boot = performance.now();
const task = runner.run({ once: false }).catch(e => { observerError = String(e); stop = true; });
process.once('SIGTERM', () => { stop = true; status = 'interrupted'; });
process.once('SIGINT', () => { stop = true; status = 'interrupted'; });
const metadata = () => ({ profiling: profiler.report(), startedAt, deadlineAt: new Date(Date.parse(startedAt) + hours * 3600000).toISOString(), status, error, observerError,
  settings, clock, recorder: recorder.status, droppedSignals, host: process.env.DIAGNOSTICS_HOST_LABEL ?? 'collector',
  observationDurationMs: Math.round(performance.now() - boot), feed: runner.liveHealth() });
let reportAt = 0, clockAt = performance.now();
try {
  while (!stop && performance.now() < deadline) {
    for (const capture of recorder.finish(id => {
      const pair = runner.pair(id); return pair ? [pair.polymarket.rulesHash, pair.limitless.rulesHash] : undefined;
    })) if (!await archive.add(capture, config)) { status = 'archive-limit'; stop = true; }
    if (archive.cases.filter(c => c.results.some(r => r.verdict !== 'unknown')).length >= minimum) { status = 'complete'; break; }
    if (archive.cases.length >= 300) { status = 'case-limit'; break; }
    if (performance.now() - reportAt >= 5000) { await archive.report(metadata(), minimum); reportAt = performance.now(); }
    if (performance.now() - clockAt >= 30000) { await checkClock(); clockAt = performance.now(); }
    await delay(50);
  }
  if (status === 'collecting') status = error || observerError ? 'failed' : 'deadline';
} catch (e) { error = String(e); status = 'failed'; }
finally {
  stop = true; scheduler.stop(); await scheduler.drain(); runner.stop();
  for (const capture of recorder.finish(id => {
    const pair = runner.pair(id); return pair ? [pair.polymarket.rulesHash, pair.limitless.rulesHash] : undefined;
  }, true)) await archive.add(capture, config);
  await task; await archive.report(metadata(), minimum);
  if (error || observerError) process.exitCode = 1;
  console.log(JSON.stringify({ status, capturedSignals: archive.cases.length, error, observerError }));
}
