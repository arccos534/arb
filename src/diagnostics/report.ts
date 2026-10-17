import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CaseSummary } from './execution.js';

export async function executionReport(dataDirectory: string) {
  const filename = path.join(dataDirectory, 'diagnostics', 'execution-latest.json');
  try {
    if ((await stat(filename)).size > 2 * 1024 ** 2) throw new Error('Diagnostic report exceeds 2 MiB');
    const report = JSON.parse(await readFile(filename, 'utf8')) as { schemaVersion: number; updatedAt: string; status: string; cases: CaseSummary[]; table: unknown[] };
    if (report.schemaVersion !== 1 || !Array.isArray(report.cases) || !Array.isArray(report.table) || !Number.isFinite(Date.parse(report.updatedAt))) throw new Error('Invalid diagnostic report');
    return { ...report, available: true, stale: report.status === 'collecting' && Date.now() - Date.parse(report.updatedAt) > 120000 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { available: false, status: 'not-started', insufficientData: true, cases: [] as CaseSummary[], table: [], stale: false };
  }
}
