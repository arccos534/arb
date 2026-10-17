import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import type { Config } from './config.js';
import { atomicWriteFile } from './atomic-file.js';

export class ResearchStorage {
  private pool: Pool | undefined;
  private totalBytes = 0;
  private readonly latestWrites = new Map<string, Promise<void>>();
  private readonly directory: string;
  constructor(private readonly config: Config, private readonly historyEnabled = true) { this.directory = path.resolve(config.DATA_DIR); }

  async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const name of await readdir(this.directory)) {
      if (/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) this.totalBytes += (await stat(path.join(this.directory, name))).size;
    }
    if (this.config.DATABASE_URL || this.config.STORAGE_POSTGRES) {
      const options = { max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 };
      this.pool = new Pool(this.config.DATABASE_URL ? { ...options, connectionString: this.config.DATABASE_URL } : options);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS research_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind TEXT NOT NULL,
        payload JSONB NOT NULL
      )`);
      await this.pool.query('CREATE INDEX IF NOT EXISTS research_events_kind_time ON research_events (kind, observed_at)');
    }
  }

  async event(kind: string, payload: unknown): Promise<void> {
    if (!this.historyEnabled) return;
    const line = JSON.stringify({ at: new Date().toISOString(), kind, payload }) + '\n';
    const filename = path.join(this.directory, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
    let size = 0;
    try { size = (await stat(filename)).size; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (size + Buffer.byteLength(line) > this.config.MAX_JOURNAL_MB * 1024 * 1024) throw new Error('Daily journal limit reached. Archive observations or increase MAX_JOURNAL_MB.');
    if (this.totalBytes + Buffer.byteLength(line) > this.config.MAX_TOTAL_JOURNAL_MB * 1024 * 1024) throw new Error('Total journal limit reached. Archive observations or increase MAX_TOTAL_JOURNAL_MB.');
    await appendFile(filename, line, { mode: 0o600 });
    this.totalBytes += Buffer.byteLength(line);
    if (this.pool) await this.pool.query('INSERT INTO research_events (kind, payload) VALUES ($1, $2::jsonb)', [kind, JSON.stringify(payload)]);
  }

  async latest(name: string, payload: unknown): Promise<void> {
    if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid report name');
    const task = (this.latestWrites.get(name) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const filename = path.join(this.directory, `${name}-latest.json`);
      await atomicWriteFile(filename, JSON.stringify(payload, null, 2) + '\n');
    });
    this.latestWrites.set(name, task);
    try { await task; } finally { if (this.latestWrites.get(name) === task) this.latestWrites.delete(name); }
  }

  async readLatest(name: string): Promise<unknown> {
    if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid report name');
    return JSON.parse(await readFile(path.join(this.directory, `${name}-latest.json`), 'utf8'));
  }
  async close(): Promise<void> { await Promise.all(this.latestWrites.values()); await this.pool?.end(); }
}
