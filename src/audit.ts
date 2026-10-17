import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface AuditEntry { schemaVersion: 1; id: string; at: string; category: string; source: string; payload: unknown }
const sensitive = /^(api[-_]?key|api[-_]?secret|secret|password|private[-_]?key|seed|mnemonic|authorization|cookie|set-cookie|csrf)$/i;
// Only decisions and operations relevant to paper trading reach disk. Filtering
// precedes redaction/serialization so market streams cost no logging memory.
const tradingEvents = new Set([
  'session-started', 'session-paused', 'session-reset', 'settings-updated',
  'manual-review-mode-changed', 'pair-reviewed', 'demo-started', 'risk-halt',
  'orders-scheduled', 'orders-cancelled', 'order-rejected', 'order-filled', 'execution-preflight',
  'trade-status', 'positions-close-all', 'position-sold', 'waiting-resolution',
  'leg-settled', 'trade-settled', 'transfer-started', 'transfer-deposit', 'transfer-completed',
  'application-error', 'observer-error', 'command-rejected', 'resolution-error',
  'execution-book-refresh-error', 'diagnostics-recovered',
]);
export function isTradingAuditEvent(category: string): boolean { return tradingEvents.has(category); }
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) && !(k === 'seed' && typeof v === 'number') ? '[REDACTED]' : redact(v)]));
  return value;
}

// Concatenated gzip members: each complete line is independently compressed.
// A crash cannot corrupt the previous complete members. gzip/zcat read all members.
export class AuditJournal {
  readonly recent: AuditEntry[] = [];
  error: string | null = null;
  bytes = 0;
  records = 0;
  private pending = 0;
  private chain: Promise<void> = Promise.resolve();
  private opened = false;
  private segment = 1;
  private segmentBytes = 0;
  private day = '';
  private queue: { json: string; length: number; at: string }[] = [];
  private draining = false;
  private readonly queueLimitBytes = 128 * 1024 ** 2;
  constructor(readonly directory: string, private readonly maxBytes = 2 * 1024 ** 3, private readonly onFailure: (error: string) => void = () => {}) {}

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) if (/^audit-.*\.jsonl\.gz$/.test(name)) this.bytes += (await stat(path.join(this.directory, name))).size;
    this.day = new Date().toISOString().slice(0, 10);
    while (true) {
      try { this.segmentBytes = (await stat(this.filename())).size; this.segment++; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.segmentBytes = 0; break; }
    }
    this.opened = true;
  }
  private filename(): string { return path.join(this.directory, `audit-${this.day}-${String(this.segment).padStart(4, '0')}.jsonl.gz`); }

  record(category: string, source: string, payload: unknown): void {
    if (this.error || !this.opened || !isTradingAuditEvent(category)) return;
    const entry: AuditEntry = { schemaVersion: 1, id: randomUUID(), at: new Date().toISOString(), category, source, payload: redact(payload) };
    const json = JSON.stringify(entry) + '\n';
    const length = Buffer.byteLength(json);
    if (this.pending + length > this.queueLimitBytes) { this.fail('Audit queue exceeded 128 MB; paper trading stopped to avoid unrecorded operations.'); return; }
    if (!category.startsWith('raw-')) {
      this.recent.push(entry);
      if (this.recent.length > 300) this.recent.splice(0, this.recent.length - 300);
    }
    this.pending += length;
    this.queue.push({ json, length, at: entry.at });
    if (this.draining) return;
    this.draining = true;
    this.chain = this.chain.then(async () => {
      while (this.queue.length) {
        const batch = this.queue.splice(0, 128);
        let chunks: Buffer[] = [], buffered = 0, count = 0;
        const write = async () => {
          if (!chunks.length) return;
          await appendFile(this.filename(), Buffer.concat(chunks), { mode: 0o600 });
          this.bytes += buffered; this.segmentBytes += buffered; this.records += count;
          chunks = []; buffered = 0; count = 0;
        };
        for (const item of batch) {
          const compressed = gzipSync(item.json, { level: 1 });
          if (this.bytes + buffered + compressed.length > this.maxBytes) throw new Error('Audit disk limit reached; archive logs before resuming.');
          const day = item.at.slice(0, 10);
          if (this.day !== day) { await write(); this.day = day; this.segment = 1; this.segmentBytes = 0; }
          if (this.segmentBytes + buffered + compressed.length > 16 * 1024 ** 2) { await write(); this.segment++; this.segmentBytes = 0; }
          chunks.push(compressed); buffered += compressed.length; count++;
        }
        await write();
        this.pending -= batch.reduce((sum, item) => sum + item.length, 0);
      }
    }).catch(e => { this.fail(String(e)); this.queue = []; this.pending = 0; }).finally(() => { this.draining = false; });
  }
  private fail(error: string): void { if (!this.error) { this.error = error; this.onFailure(error); } }
  async flush(): Promise<void> { await this.chain; }
  async snapshot(name: string): Promise<Buffer> {
    if (!/^audit-[\d-]+\.jsonl\.gz$/.test(name)) throw new Error('Invalid audit filename');
    // Read between queued appends, ensuring the download ends on a complete gzip member.
    const result = this.chain.then(() => readFile(path.join(this.directory, name)));
    this.chain = result.then(() => {}, () => {});
    return result;
  }
  status(): unknown { return { bytes: this.bytes, records: this.records, queuedBytes: this.pending, queueLimitBytes: this.queueLimitBytes, limitBytes: this.maxBytes, error: this.error, mode: 'trades-only', format: 'gzip JSONL: paper trade decisions, fills, fees, settlements, settings and critical errors; no continuous REST/WS or equity samples' }; }
}
