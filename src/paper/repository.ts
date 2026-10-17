import { appendFile, mkdir, readFile, rename, stat, writeFile, truncate, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import { paperSettingsSchema, type PaperState, type Source } from './types.js';
import { initialState } from './engine.js';
import { atomicWriteFile } from '../atomic-file.js';
import { profiler } from '../profiling.js';

type SavedState = Record<string, unknown>;
interface PatchRecord { schemaVersion: 2; sequence: number; baseSequence: number; sessionId: string; set: SavedState; arrays: Record<string, { length: number; items: [number, unknown][] }> }
function applyRecord(value: unknown, current: PaperState | null, source: Source): PaperState {
  if (!value || typeof value !== 'object') throw new Error('Invalid transaction');
  const record = value as { state?: PaperState } & Partial<PatchRecord>;
  if (record.state) return !current || record.state.sessionId !== current.sessionId || record.state.sequence > current.sequence ? validateState(record.state, source) : current;
  if (record.schemaVersion !== 2 || !Number.isSafeInteger(record.sequence)) throw new Error('Unknown transaction format');
  if (current && record.sequence! <= current.sequence) return current;
  if (!current || record.baseSequence !== current.sequence || record.sequence !== current.sequence + 1 || record.sessionId !== current.sessionId) throw new Error('Transaction sequence/session gap');
  if (!record.set || !record.arrays || typeof record.set !== 'object' || typeof record.arrays !== 'object') throw new Error('Invalid transaction patch');
  const next = { ...current } as unknown as SavedState;
  for (const [key, field] of Object.entries(record.set)) {
    if (!Object.hasOwn(current, key) && key !== 'entryDiagnostics') throw new Error('Unknown state field');
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid state field');
    next[key] = field;
  }
  for (const [key, change] of Object.entries(record.arrays)) {
    if (!Object.hasOwn(current, key) || !Array.isArray(next[key]) || !Number.isSafeInteger(change.length) || change.length < 0 || !Array.isArray(change.items)) throw new Error('Invalid array patch');
    const rows = (next[key] as unknown[]).slice(0, change.length);
    for (const [index, item] of change.items) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= change.length) throw new Error('Invalid array index');
      rows[index] = item;
    }
    if (rows.length !== change.length || Array.from({ length: rows.length }, (_, i) => i).some(i => !Object.hasOwn(rows, i))) throw new Error('Incomplete array patch');
    next[key] = rows;
  }
  if (next.sequence !== record.sequence || next.sessionId !== current.sessionId || next.source !== source || next.version !== current.version) throw new Error('Invalid patched state identity');
  return validateState(next, source);
}

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
  private previous: SavedState | undefined;
  private walBytes = 0;
  private failure: unknown;
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
          state = applyRecord(JSON.parse(line), state, this.source);
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
    try { this.walBytes = (await stat(this.wal)).size; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    this.previous = undefined;
    return state;
  }
  async commit(state: PaperState, events: unknown[]): Promise<void> {
    if (this.failure) throw new Error(`Repository halted after a write failure; reopen and recover before writing: ${String(this.failure)}`);
    try {
    state.sequence++;
    const snapshot = JSON.parse(JSON.stringify(state)) as SavedState;
    let transaction: unknown = { sequence: state.sequence, at: new Date().toISOString(), events, state: snapshot };
    const previous = this.previous;
    if (previous && previous.sessionId === state.sessionId && Object.keys(previous).every(key => Object.hasOwn(snapshot, key))) {
      const set: SavedState = {}, arrays: PatchRecord['arrays'] = {};
      for (const [key, value] of Object.entries(snapshot)) {
        const old = previous[key];
        if (Array.isArray(value) && Array.isArray(old)) {
          const items: [number, unknown][] = [];
          value.forEach((item, i) => { if (JSON.stringify(item) !== JSON.stringify(old[i])) items.push([i, item]); });
          if (value.length !== old.length || items.length) arrays[key] = { length: value.length, items };
        } else if (JSON.stringify(value) !== JSON.stringify(old)) set[key] = value;
      }
      transaction = { schemaVersion: 2, sequence: state.sequence, baseSequence: previous.sequence, sessionId: state.sessionId, set, arrays, events };
    }
    const line = JSON.stringify(transaction) + '\n', bytes = Buffer.byteLength(line);
    if (this.walBytes + bytes > 256 * 1024 ** 2) throw new Error('Paper transaction journal reached 256 MB; archive session before continuing');
    const started = profiler.start();
    try { await appendFile(this.wal, line, { mode: 0o600, flush: true }); } finally { profiler.end('wal', started); }
    this.previous = snapshot; this.walBytes += bytes;
    // Rotate only after the committed state has a complete atomic checkpoint.
    // Recovery reads the active WAL; older history stays available separately.
    if (this.walBytes >= this.rotationBytes) {
      await this.checkpoint(state);
      const archive = path.join(this.directory, 'transactions-archive'); await mkdir(archive, { recursive: true });
      await rename(this.wal, path.join(archive, `transactions-${state.sequence}-${Date.now()}.jsonl`));
      this.previous = undefined; this.walBytes = 0;
    }
    } catch (error) { this.failure = error; throw error; }
  }
  async checkpoint(state: PaperState): Promise<void> {
    if (this.failure) throw new Error('Repository halted; checkpoint would overwrite recovery evidence');
    const started = profiler.start();
    try { await atomicWriteFile(path.join(this.directory, 'state.json'), JSON.stringify(state), true); }
    finally { profiler.end('checkpoint', started); }
  }
  async archive(state: PaperState): Promise<void> {
    await mkdir(path.join(this.directory, 'sessions'), { recursive: true });
    await writeFile(path.join(this.directory, 'sessions', `${state.sessionId}.json`), JSON.stringify(state, null, 2), { mode: 0o600 });
  }
}
