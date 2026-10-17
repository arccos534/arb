import { appendFile, mkdir, readFile, rename, stat, writeFile, truncate, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { paperSettingsSchema, type PaperState, type Source } from './types.js';
import { initialState } from './engine.js';

export function validateState(value: unknown, source: Source): PaperState {
  const state = value as PaperState;
  if (!state || state.version !== 1 || state.source !== source || !Number.isSafeInteger(state.sequence) || !Array.isArray(state.trades) || !Array.isArray(state.ledger)) throw new Error('Invalid saved paper state');
  state.settings = paperSettingsSchema.parse(state.settings);
  for (const v of Object.values(state.cash)) if (!new Decimal(v).isFinite() || new Decimal(v).lt(0)) throw new Error('Invalid saved cash balance');
  if (new Set(state.trades.map(t => t.id)).size !== state.trades.length) throw new Error('Duplicate saved trade');
  for (const t of state.trades) {
    if ((t.initialCost === undefined) !== (t.maxExecutionCost === undefined)) throw new Error('Incomplete saved pair budget');
    for (const v of [t.initialCost, t.maxExecutionCost]) if (v !== undefined && (!new Decimal(v).isFinite() || new Decimal(v).lte(0))) throw new Error('Invalid saved pair budget');
  }
  for (const t of state.trades) for (const o of t.orders) for (const v of [o.heldShares, o.costBasis, o.cost, o.reserve]) if (!new Decimal(v).isFinite() || new Decimal(v).lt(0)) throw new Error('Invalid saved order');
  return state;
}

export class PaperRepository {
  readonly directory: string;
  constructor(directory: string, readonly source: Source, private readonly rotationBytes = 16 * 1024 ** 2) { this.directory = path.resolve(directory); }
  private get wal(): string { return path.join(this.directory, 'transactions.jsonl'); }
  async open(): Promise<PaperState> {
    await mkdir(this.directory, { recursive: true });
    let state: PaperState | null = null;
    try { state = validateState(JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8')), this.source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const journals = [this.wal];
    if (!state) {
      const archive = path.join(this.directory, 'transactions-archive');
      try {
        const latest = (await readdir(archive)).filter(n => /^transactions-\d+-\d+\.jsonl$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))[0];
        if (latest) journals.unshift(path.join(archive, latest));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    for (const journal of journals) try {
      let goodBytes = 0, pending = '';
      const recover = (line: string) => {
        if (!line.trim()) return;
          const transaction = JSON.parse(line) as { state: PaperState };
          if (!state || transaction.state.sequence > state.sequence) state = validateState(transaction.state, this.source);
      };
      for await (const chunk of createReadStream(journal, { encoding: 'utf8' })) {
        pending += chunk;
        let boundary: number;
        while ((boundary = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, boundary);
          try { recover(line); } catch (e) { throw new Error(`Corrupt paper transaction at byte ${goodBytes}: ${String(e)}`); }
          goodBytes += Buffer.byteLength(line + '\n'); pending = pending.slice(boundary + 1);
        }
      }
      if (pending) {
        if (journal !== this.wal) throw new Error('Incomplete archived transaction journal');
        try { recover(pending); await appendFile(this.wal, '\n', { flush: true }); }
        catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          await writeFile(path.join(this.directory, `incomplete-tail-${Date.now()}.txt`), pending, { mode: 0o600 });
          await truncate(this.wal, goodBytes);
        }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!state) state = initialState(this.source);
    state.running = false;
    await this.checkpoint(state);
    return state;
  }
  async commit(state: PaperState, events: unknown[]): Promise<void> {
    state.sequence++;
    let size = 0;
    try { size = (await stat(this.wal)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const line = JSON.stringify({ sequence: state.sequence, at: new Date().toISOString(), events, state }) + '\n';
    if (size + Buffer.byteLength(line) > 256 * 1024 ** 2) throw new Error('Paper transaction journal reached 256 MB; archive session before continuing');
    await appendFile(this.wal, line, { mode: 0o600, flush: true });
    await this.checkpoint(state);
    // Rotate only after the committed state has a complete atomic checkpoint.
    // Recovery reads the active WAL; older history stays available separately.
    if (size + Buffer.byteLength(line) >= this.rotationBytes) {
      const archive = path.join(this.directory, 'transactions-archive'); await mkdir(archive, { recursive: true });
      await rename(this.wal, path.join(archive, `transactions-${state.sequence}-${Date.now()}.jsonl`));
    }
  }
  async checkpoint(state: PaperState): Promise<void> {
    const file = path.join(this.directory, 'state.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { mode: 0o600, flush: true });
    await rename(tmp, file);
  }
  async archive(state: PaperState): Promise<void> {
    await mkdir(path.join(this.directory, 'sessions'), { recursive: true });
    await writeFile(path.join(this.directory, 'sessions', `${state.sessionId}.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
