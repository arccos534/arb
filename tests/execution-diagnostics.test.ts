import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { PaperEngine, initialState } from '../src/paper/engine.js';
import { DemoFeed } from '../src/paper/demo.js';
import { paperSettingsSchema } from '../src/paper/types.js';
import { bookKey } from '../src/books.js';
import { ExecutionRecorder, replayExecution, summarize, comparisonTable, diagnosticsCsv, type ExecutionCase, type CapturedFrame } from '../src/diagnostics/execution.js';
import { DiagnosticArchive } from '../src/diagnostics/archive.js';
import { executionReport } from '../src/diagnostics/report.js';

const start = Date.parse('2026-10-17T10:00:00Z'), config = loadConfig({});
function fixture() {
  const settings = paperSettingsSchema.parse({ rejectProbability: 0, partialProbability: 0 });
  const engine = new PaperEngine(initialState('demo', settings, start), config), feed = new DemoFeed();
  feed.start('normal', start); engine.setRunning(true, start); engine.step(feed.snapshot(start));
  const trade = structuredClone(engine.state.trades[0]!);
  const frames = (at: number): CapturedFrame[] => feed.snapshot(start + at).books.filter(b => trade.orders.some(o => o.venue === b.venue && o.outcome === b.outcome)).map(book => ({
    at, key: bookKey(book.venue, book.slug, book.outcome), book, asksComplete: true, bidsComplete: true,
  }));
  const capture: ExecutionCase = { version: 1, id: trade.id, signalMono: 0, signalAt: start, settings, trade, frames: [...frames(0), ...frames(500)], incomplete: false, clockIssue: false, rulesChanged: false };
  return { capture, feed, frames };
}
describe('execution diagnostic replay', () => {
  it('compares four latencies using the same fees and budgets without changing the account or settings', () => {
    const { capture } = fixture(), original = JSON.stringify(capture);
    const result = replayExecution(capture, config);
    expect(result).toHaveLength(8); expect(result.filter(r => r.verdict === 'supported')).toHaveLength(4);
    expect(result.filter(r => r.verdict === 'possible')).toHaveLength(4);
    expect(result.every(r => Number(r.profit) > 0)).toBe(true);
    expect(JSON.stringify(capture)).toBe(original); expect(capture.settings.latencyMs).toBe(400);
  });
  it('treats a quiet unchanged book as a possible entry, without pretending to confirm a fill', () => {
    const { capture, frames } = fixture(); capture.frames = frames(0);
    const result = replayExecution(capture, config);
    expect(result.filter(r => r.mode === 'post-arrival').every(r => r.verdict === 'unknown' && r.reasons.includes('missing-confirmation'))).toBe(true);
    expect(result.filter(r => r.mode === 'at-arrival').every(r => r.verdict === 'possible')).toBe(true);
  });
  it('shows the same short quote available at 50ms and unavailable at 400ms', () => {
    const { capture, frames } = fixture(), changed = frames(100);
    changed.find(f => f.book?.venue === 'limitless')!.book!.asks = [{ price: '0.9', shares: '100' }];
    capture.frames = [...frames(0), ...changed];
    const result = replayExecution(capture, config);
    expect(result.find(r => r.mode === 'at-arrival' && r.latencyMs === 50)?.verdict).toBe('possible');
    expect(result.find(r => r.mode === 'at-arrival' && r.latencyMs === 400)).toMatchObject({ verdict: 'unavailable', reasons: expect.arrayContaining(['pair-price-budget-exceeded']) });
  });
  it('distinguishes a known small volume from unrecorded depth', () => {
    const { capture } = fixture();
    for (const frame of capture.frames) if (frame.book?.venue === 'limitless') frame.book.asks = [{ price: '0.48', shares: '1' }];
    expect(replayExecution(capture, config).every(r => r.verdict === 'unavailable' && r.reasons.includes('insufficient-volume'))).toBe(true);
    for (const frame of capture.frames) if (frame.book?.venue === 'limitless') frame.asksComplete = false;
    expect(replayExecution(capture, config).every(r => r.verdict === 'unknown' && r.reasons.includes('depth-not-recorded'))).toBe(true);
  });
  it('invalidates books after a disconnect rather than carrying them forward', () => {
    const { capture, frames } = fixture(), initial = frames(0);
    capture.frames = [...initial, { ...initial[1]!, at: 25, book: null }];
    const result = replayExecution(capture, config);
    expect(result.every(r => r.verdict === 'unknown')).toBe(true);
  });
  it.each(['clockIssue', 'incomplete', 'rulesChanged'] as const)('does not turn %s into fabricated executions', field => {
    const { capture } = fixture(); capture[field] = true;
    expect(replayExecution(capture, config).every(r => r.verdict === 'unknown')).toBe(true);
  });
  it('reports incompatible exchange times as unknown evidence', () => {
    const { capture } = fixture();
    for (const frame of capture.frames) if (frame.book?.venue === 'limitless') frame.book.sourceTimestamp = start - 1000;
    expect(replayExecution(capture, config).filter(r => r.mode === 'post-arrival').every(r => r.verdict === 'unknown' && r.reasons.includes('time-skew'))).toBe(true);
  });
  it('does not weaken the exit risk limit to create entries', () => {
    const { capture } = fixture(); capture.settings.maxUnhedgedLossUsd = '0.01';
    expect(replayExecution(capture, config).every(r => r.verdict === 'unavailable' && r.reasons.includes('risk-limit'))).toBe(true);
  });
  it('summarizes independent scenarios and emits spreadsheet-safe CSV', () => {
    const { capture } = fixture(); capture.trade.title = '=HYPERLINK("bad")';
    const summary = summarize(capture, config); expect(comparisonTable([summary])[0]?.available).toBe(1);
    const csv = diagnosticsCsv({ cases: [summary] }); expect(csv).toContain("'=HYPERLINK"); expect(csv.split('\r\n')).toHaveLength(9);
  });
});
describe('bounded event windows', () => {
  it('preserves two seconds before and three seconds after the signal, including invalidation', () => {
    const { capture, feed } = fixture(); let mono = 0;
    const recorder = new ExecutionRecorder(64 * 1024 ** 2, 20, () => mono, () => start + mono);
    const original = feed.snapshot(start).books[0]!; recorder.observe(original);
    mono = 2000; const trade = { ...capture.trade, signalAt: start + mono };
    recorder.start(trade, capture.settings, feed.snapshot(start + mono));
    mono = 3000; recorder.invalidate(bookKey(original.venue, original.slug, original.outcome));
    expect(recorder.finish(() => trade.rulesHashes)).toEqual([]);
    mono = 5000; const [window] = recorder.finish(() => trade.rulesHashes);
    expect(window?.frames.some(f => f.at === 0)).toBe(true); expect(window?.frames.some(f => f.book === null)).toBe(true);
    expect(window?.incomplete).toBe(false); expect(recorder.status.pending).toBe(0);
  });
  it('bounds memory and marks a window incomplete on eviction', () => {
    const { capture, feed } = fixture(); let mono = 0;
    const recorder = new ExecutionRecorder(1500, 20, () => mono, () => start + mono);
    recorder.start(capture.trade, capture.settings, feed.snapshot(start));
    for (mono = 1; mono < 50; mono++) recorder.observe(feed.snapshot(start + mono).books[0]!);
    expect(recorder.status.bufferBytes).toBeLessThanOrEqual(1500); expect(recorder.droppedFrames).toBeGreaterThan(0);
    mono = 3100;
    expect(recorder.finish(() => capture.trade.rulesHashes)[0]).toMatchObject({ incomplete: true, incompleteReasons: ['buffer-evicted'] });
  });
  it('detects a wall-clock step with monotonic durations intact', () => {
    const { capture, feed } = fixture(); let mono = 0, jump = 0;
    const recorder = new ExecutionRecorder(undefined, 20, () => mono, () => start + mono + jump);
    recorder.start(capture.trade, capture.settings, feed.snapshot(start));
    mono = 100; jump = 1000; recorder.observe(feed.snapshot(start + mono).books[0]!);
    mono = 3100; expect(recorder.finish(() => capture.trade.rulesHashes)[0]?.clockIssue).toBe(true);
  });
  it('retains a busy full window larger than the former 2 MiB limit', () => {
    const { capture, feed } = fixture(); let mono = 0;
    const recorder = new ExecutionRecorder(undefined, 20, () => mono, () => start + mono);
    recorder.start(capture.trade, capture.settings, feed.snapshot(start));
    for (mono = 1; mono <= 3000; mono++) {
      for (const book of feed.snapshot(start + mono).books.filter(b => capture.trade.orders.some(o => o.venue === b.venue && o.slug === b.slug && o.outcome === b.outcome))) recorder.observe(book);
    }
    expect(recorder.status.bufferBytes).toBeGreaterThan(2 * 1024 ** 2);
    const window = recorder.finish(() => capture.trade.rulesHashes)[0]!;
    expect(window.incomplete).toBe(false);
    expect(window.frames.at(-1)?.at).toBe(3000);
    expect(replayExecution(window, config).every(r => r.verdict !== 'unknown')).toBe(true);
  });
  it('reports the case byte limit and preserves unknown verdicts on truncation', () => {
    const { capture, feed } = fixture(); let mono = 0;
    const recorder = new ExecutionRecorder(undefined, 20, () => mono, () => start + mono, 1500);
    recorder.start(capture.trade, capture.settings, feed.snapshot(start));
    for (mono = 1; mono < 10; mono++) recorder.observe(feed.snapshot(start + mono).books[0]!);
    mono = 3000;
    const window = recorder.finish(() => capture.trade.rulesHashes)[0]!;
    expect(window.incompleteReasons).toContain('case-byte-limit');
    expect(summarize(window, config).incompleteReasons).toContain('case-byte-limit');
    expect(replayExecution(window, config).every(r => r.verdict === 'unknown')).toBe(true);
  });
  it('reports an unfinished window on forced shutdown', () => {
    const { capture, feed } = fixture(); let mono = 0;
    const recorder = new ExecutionRecorder(undefined, 20, () => mono, () => start + mono);
    recorder.start(capture.trade, capture.settings, feed.snapshot(start)); mono = 100;
    expect(recorder.finish(() => capture.trade.rulesHashes, true)[0]).toMatchObject({ incomplete: true, incompleteReasons: ['window-not-finished'] });
  });
});
describe('diagnostic archive and report', () => {
  it('recovers durable cases even when a crash leaves the summary behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-case-'));
    try {
      const a = new DiagnosticArchive(dir); await a.open(); const { capture } = fixture();
      await a.add(capture, config);
      const b = new DiagnosticArchive(dir); await b.open(); expect(b.cases).toHaveLength(1);
      await b.report({ startedAt: new Date().toISOString(), status: 'collecting' }, 30);
      const report = JSON.parse(await readFile(path.join(dir, 'execution-latest.json'), 'utf8'));
      expect(report.insufficientData).toBe(true); expect(report.usableSignals).toBe(1);
      expect(report.table).toHaveLength(8); expect((await readdir(dir)).some(n => n.endsWith('.tmp'))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps legacy and pair-budget replay cohorts separate without rewriting old cases', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-pricing-cohorts-'));
    try {
      const archive = new DiagnosticArchive(dir); await archive.open();
      const { capture } = fixture(), legacy = structuredClone(capture);
      legacy.id = 'old-case'; delete legacy.trade.initialCost; delete legacy.trade.maxExecutionCost;
      await archive.add(legacy, config); await archive.add(capture, config);
      await archive.report({}, 30);
      const report = JSON.parse(await readFile(path.join(dir, 'execution-latest.json'), 'utf8'));
      expect(report.pricingCohorts.map((c: { pricingPolicy: string; capturedSignals: number }) => [c.pricingPolicy, c.capturedSignals])).toEqual([['legacy-leg-limits', 1], ['pair-budget-v1', 1]]);
      expect(diagnosticsCsv(report)).toContain('pricingPolicy');
      expect(archive.cases[0]!.pricingPolicy).toBe('legacy-leg-limits');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('stops before exhausting the archive budget', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-case-limit-'));
    try {
      const archive = new DiagnosticArchive(dir, 100); await archive.open();
      expect(await archive.add(fixture().capture, config)).toBe(false); expect(archive.limited).toBe(true);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('marks a stale replica and returns a clear missing state', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-report-'));
    try {
      expect(await executionReport(dir)).toMatchObject({ available: false });
      await mkdir(path.join(dir, 'diagnostics'));
      await writeFile(path.join(dir, 'diagnostics/execution-latest.json'), JSON.stringify({ schemaVersion: 1, updatedAt: new Date(Date.now() - 180000).toISOString(), status: 'collecting', cases: [], table: [] }));
      expect(await executionReport(dir)).toMatchObject({ available: true, stale: true });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
