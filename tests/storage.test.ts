import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ResearchStorage } from '../src/storage.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const dirs: string[] = [];
afterEach(async () => { vi.mocked(rename).mockClear(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('persistent research journal', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a temporary %s without exposing a partial report', async code => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-report-locked-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir }), false); await store.open();
    await store.latest('health', { cycles: 1 });
    const actualRename = vi.mocked(rename).getMockImplementation()!;
    let failures = 0;
    vi.mocked(rename).mockImplementationOnce(async () => {
      expect(await store.readLatest('health')).toEqual({ cycles: 1 });
      failures++;
      throw Object.assign(new Error('Report is temporarily locked'), { code });
    }).mockImplementationOnce(async (from, to) => {
      expect(await store.readLatest('health')).toEqual({ cycles: 1 });
      failures++;
      return actualRename(from, to);
    });
    // A concurrent report for the same name must remain behind the retry.
    await Promise.all([store.latest('health', { cycles: 2 }), store.latest('health', { cycles: 3 })]);
    expect(failures).toBe(2);
    expect(await store.readLatest('health')).toEqual({ cycles: 3 });
    expect(await readdir(dir)).toEqual(['health-latest.json']); await store.close();
  });
  it('bounds persistent lock retries, retains the old report and recovers on the next write', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-report-persistent-lock-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir }), false); await store.open();
    await store.latest('health', { ready: true });
    const actualRename = vi.mocked(rename).getMockImplementation()!;
    const error = Object.assign(new Error('File locked'), { code: 'EPERM' });
    vi.mocked(rename).mockClear().mockRejectedValue(error);
    try {
      await expect(store.latest('health', { ready: false })).rejects.toBe(error);
      expect(rename).toHaveBeenCalledTimes(12);
      expect(await store.readLatest('health')).toEqual({ ready: true });
      expect(await readdir(dir)).toEqual(['health-latest.json']);
    } finally { vi.mocked(rename).mockImplementation(actualRename); }
    await store.latest('health', { recovered: true });
    expect(await store.readLatest('health')).toEqual({ recovered: true }); await store.close();
  });
  it('does not retry unrelated filesystem errors or leave temporary reports behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-report-error-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir }), false); await store.open();
    const error = Object.assign(new Error('Invalid replacement'), { code: 'EINVAL' });
    vi.mocked(rename).mockRejectedValueOnce(error);
    await expect(store.latest('health', {})).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(1); expect(await readdir(dir)).toEqual([]); await store.close();
  });
  it('atomically handles concurrent replacements of the same current report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-report-race-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir }), false); await store.open();
    await Promise.all(Array.from({ length: 10 }, (_, value) => store.latest('health', { value })));
    expect((await store.readLatest('health') as { value: number }).value).toBeGreaterThanOrEqual(0); await store.close();
  });
  it('keeps only replaceable current reports when observation history is disabled', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-trades-only-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir }), false); await store.open();
    await store.event('observation', { toJSON() { throw new Error('Must not serialize observations'); } });
    await store.latest('health', { ready: true });
    expect(await store.readLatest('health')).toEqual({ ready: true });
    await expect(readFile(path.join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.close();
  });
  it('keeps observations and atomically replaces current reports across restarts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-research-')); dirs.push(dir);
    const config = loadConfig({ DATA_DIR: dir });
    const a = new ResearchStorage(config); await a.open();
    await a.event('test', { exactDecimal: '0.000001' });
    await a.latest('health', { cycles: 1 }); await a.latest('health', { cycles: 2 }); await a.close();
    const b = new ResearchStorage(config); await b.open();
    expect(await b.readLatest('health')).toEqual({ cycles: 2 });
    const line = await readFile(path.join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
    expect(JSON.parse(line).payload.exactDecimal).toBe('0.000001');
    await expect(b.latest('../outside', {})).rejects.toThrow('Invalid'); await b.close();
  });
  it('stops before exceeding the configured disk budget', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'arb-research-')); dirs.push(dir);
    const store = new ResearchStorage(loadConfig({ DATA_DIR: dir, MAX_JOURNAL_MB: '1' }));
    await store.open();
    await expect(store.event('large', 'x'.repeat(1024 * 1024))).rejects.toThrow('Daily journal limit');
    await store.close();
  });
});
