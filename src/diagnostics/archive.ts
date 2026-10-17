import { mkdir, readdir, stat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from '../atomic-file.js';
import type { Config } from '../config.js';
import { summarize, comparisonTable, type ExecutionCase, type CaseSummary } from './execution.js';

const compress = promisify(gzip);
export class DiagnosticArchive {
  readonly cases: CaseSummary[] = [];
  bytes = 0;
  limited = false;
  constructor(readonly directory: string, private readonly limit = 256 * 1024 ** 2) {}
  async open(): Promise<Record<string, unknown> | null> {
    await mkdir(this.directory, { recursive: true });
    let previous: Record<string, unknown> | null = null;
    try { previous = JSON.parse(await readFile(path.join(this.directory, 'execution-latest.json'), 'utf8')) as Record<string, unknown>; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    // Completed case files are the durable source of truth after a crash between
    // writing a case and replacing the summary. Stream them one file at a time.
    for (const name of await readdir(this.directory)) {
      if (!/^case-[a-f\d-]+\.json\.gz$/.test(name)) continue;
      this.bytes += (await stat(path.join(this.directory, name))).size;
    }
    if (previous && Array.isArray(previous.cases)) this.cases.push(...previous.cases as CaseSummary[]);
    const { gunzip } = await import('node:zlib'); const decompress = promisify(gunzip);
    const ids = new Set(this.cases.map(c => c.id));
    for (const name of await readdir(this.directory)) if (/^case-[a-f\d-]+\.json\.gz$/.test(name)) {
      const id = name.slice(5, -8); if (ids.has(id)) continue;
      const value = JSON.parse((await decompress(await readFile(path.join(this.directory, name)))).toString()) as { summary: CaseSummary };
      this.cases.push(value.summary); ids.add(value.summary.id);
    }
    this.cases.sort((a, b) => a.signalAt - b.signalAt); return previous;
  }
  async add(capture: ExecutionCase, config: Config): Promise<boolean> {
    if (this.cases.some(c => c.id === capture.id)) return true;
    const summary = summarize(capture, config);
    const payload = await compress(JSON.stringify({ capture, summary }));
    // Reserve 2 MiB for the replaceable report and replica metadata.
    if (this.bytes + payload.byteLength + 2 * 1024 ** 2 > this.limit) { this.limited = true; return false; }
    const target = path.join(this.directory, `case-${capture.id}.json.gz`), temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, payload, { mode: 0o600, flush: true }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
    this.bytes += payload.byteLength; this.cases.push(summary); return true;
  }
  async report(metadata: Record<string, unknown>, minimumSignals: number): Promise<void> {
    const usableSignals = this.cases.filter(c => c.results.some(r => r.verdict !== 'unknown')).length;
    await atomicWriteFile(path.join(this.directory, 'execution-latest.json'), JSON.stringify({ schemaVersion: 1,
      ...metadata, updatedAt: new Date().toISOString(), minimumSignals, capturedSignals: this.cases.length, usableSignals,
      insufficientData: usableSignals < minimumSignals, archiveBytes: this.bytes, archiveLimitBytes: this.limit, archiveLimited: this.limited,
      evidence: 'Public observations only. Possible/supported entries are not exchange fills. Cases are independent, not portfolio P&L.',
      pricingCohorts: ['legacy-leg-limits', 'pair-budget-v1'].map(pricingPolicy => {
        const cases = this.cases.filter(c => (c.pricingPolicy ?? 'legacy-leg-limits') === pricingPolicy);
        return { pricingPolicy, capturedSignals: cases.length, table: comparisonTable(cases) };
      }), table: comparisonTable(this.cases), cases: this.cases }) + '\n');
  }
}
