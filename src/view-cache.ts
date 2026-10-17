import { performance } from 'node:perf_hooks';

// Cache an immutable serialized read model, never a mutable engine state.
// Concurrent viewers share one build; commands invalidate in-flight builds too.
export class JsonViewCache {
  private readonly entries = new Map<string, { until: number; version: number; value?: string; pending?: Promise<string> }>();
  private version = 0;
  constructor(private readonly ttlMs = 250) {}
  invalidate(): void { this.version++; this.entries.clear(); }
  async get(key: string, build: () => Promise<unknown>): Promise<string> {
    const old = this.entries.get(key);
    if (old?.pending) return old.pending;
    if (old?.value !== undefined && old.until > performance.now()) return old.value;
    const entry: { until: number; version: number; value?: string; pending?: Promise<string> } = { until: 0, version: this.version };
    const task = build().then(value => {
      const encoded = JSON.stringify(value);
      if (this.version === entry.version && this.entries.get(key) === entry) { entry.value = encoded; entry.until = performance.now() + this.ttlMs; delete entry.pending; }
      return encoded;
    }).catch(error => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; });
    entry.pending = task;
    if(this.entries.size>=64&&!this.entries.has(key))this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry); return task;
  }
}
