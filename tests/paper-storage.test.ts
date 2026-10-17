import { mkdtemp, readFile, rm, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PaperRepository } from '../src/paper/repository.js';
import { AuditJournal } from '../src/audit.js';
import { parsePolyResolution, parseLimitlessResolution } from '../src/paper/resolution.js';

const directories:string[]=[];
async function directory(){const dir=await mkdtemp(path.join(tmpdir(),'paper-mvp-'));directories.push(dir);return dir;}
afterEach(async()=>{for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});});
describe('paper persistence',()=>{
  it('rotates a committed WAL after checkpointing and recovers without scanning the archived history',async()=>{
    const dir=await directory(),repo=new PaperRepository(dir,'live',1),state=await repo.open();
    state.cash.polymarket='103';state.realizedPnl='3';await repo.commit(state,[]);
    expect((await readdir(path.join(dir,'transactions-archive'))).length).toBe(1);
    expect((await new PaperRepository(dir,'live').open()).cash.polymarket).toBe('103');
    await rm(path.join(dir,'state.json'));
    expect((await new PaperRepository(dir,'live').open()).cash.polymarket).toBe('103');
  });
  it('repairs a complete JSON tail missing its newline before appending the next transaction',async()=>{
    const dir=await directory(),repo=new PaperRepository(dir,'demo'),state=await repo.open();await repo.commit(state,[]);
    const wal=path.join(dir,'transactions.jsonl');await writeFile(wal,(await readFile(wal,'utf8')).trimEnd());
    const restored=new PaperRepository(dir,'demo'),next=await restored.open();await restored.commit(next,[]);
    expect((await new PaperRepository(dir,'demo').open()).sequence).toBe(2);
  });
  it('recovers a committed transaction newer than the checkpoint and pauses entries',async()=>{
    const dir=await directory(),repo=new PaperRepository(dir,'live');const state=await repo.open();const old=JSON.stringify(state);
    state.cash.polymarket='101';state.realizedPnl='1';state.running=true;await repo.commit(state,[]);await writeFile(path.join(dir,'state.json'),old);
    const recovered=await new PaperRepository(dir,'live').open();expect(recovered.cash.polymarket).toBe('101');expect(recovered.running).toBe(false);expect(recovered.sequence).toBe(1);
  });
  it('preserves and repairs a partial final WAL record without losing committed balances',async()=>{
    const dir=await directory(),repo=new PaperRepository(dir,'demo'),state=await repo.open();await repo.commit(state,[]);await appendFile(path.join(dir,'transactions.jsonl'),'{"partial":');
    const restored=await new PaperRepository(dir,'demo').open();expect(restored.sessionId).toBe(state.sessionId);expect((await readFile(path.join(dir,'transactions.jsonl'),'utf8')).endsWith('\n')).toBe(true);
  });
});
describe('diagnostic archive',()=>{
  it('discards continuous market data before serialization while retaining trading events',async()=>{
    const audit=new AuditJournal(await directory());await audit.open();
    const payload={toJSON(){throw new Error('Market data must never be serialized');}};
    for(const category of ['raw-http-response','raw-websocket-polymarket','raw-websocket-limitless','research-evaluations','equity-sample','paper-transaction']) audit.record(category,'live',payload);
    await audit.flush();expect(audit.records).toBe(0);expect(audit.bytes).toBe(0);expect(audit.recent).toEqual([]);
    audit.record('orders-scheduled','live',{tradeId:'test'});await audit.flush();
    expect(audit.records).toBe(1);expect(audit.recent[0]?.category).toBe('orders-scheduled');
  });

  it('persists a burst beyond the former 32 MB queue without losing records',async()=>{
    const dir=await directory(),audit=new AuditJournal(dir);await audit.open();
    for(let i=0;i<1100;i++)audit.record('order-filled','live',{index:i,body:'x'.repeat(32768)});
    await audit.flush();expect(audit.error).toBeNull();expect(audit.records).toBe(1100);
    const {readdir}=await import('node:fs/promises');const names=await readdir(dir);
    const text=gunzipSync(await readFile(path.join(dir,names[0]!))).toString();
    expect(text.trim().split('\n')).toHaveLength(1100);expect(text).toContain('"index":1099');
  });
  it('records trade execution evidence and redacts nested secrets',async()=>{
    const dir=await directory(),audit=new AuditJournal(dir);await audit.open();audit.record('order-filled','live',{book:{asks:[{price:'0.42',size:'100'}]},apiKey:'do-not-record',nested:{secret:'never-log'}});await audit.flush();
    const {readdir}=await import('node:fs/promises');const names=await readdir(dir);const text=gunzipSync(await readFile(path.join(dir,names[0]!))).toString();expect(text).toContain('0.42');expect(text).not.toContain('do-not-record');expect(text).not.toContain('never-log');expect(text).toContain('[REDACTED]');
    audit.record('trade-settled','live',{seed:123});const captured=gunzipSync(await audit.snapshot(names[0]!)).toString();expect(captured).toContain('trade-settled');expect(captured).toContain('"seed":123');
  });
  it('reports a hard logging limit instead of silently continuing',async()=>{
    const audit=new AuditJournal(await directory(),1);await audit.open();audit.record('order-filled','demo',{anything:true});await audit.flush();expect(audit.error).toContain('limit');
  });
});
describe('independent final resolution parsing',()=>{
  it('does not treat merely closed trading as final settlement',()=>{
    expect(parsePolyResolution({closed:true,outcomes:['Yes','No'],outcomePrices:['1','0']},'test')).toBeNull();
    expect(parseLimitlessResolution({expired:true,winningOutcomeIndex:0,status:'FUNDED'},'test')).toBeNull();
    expect(parsePolyResolution({closed:true,umaResolutionStatus:'disputed',umaResolutionStatuses:['resolved'],outcomes:['Yes','No'],outcomePrices:['1','0']},'test')).toBeNull();
  });
  it('supports explicit final results and Poly 50/50 refund outcomes',()=>{
    expect(parsePolyResolution({closed:true,umaResolutionStatus:'resolved',outcomes:['Up','Down'],outcomePrices:['0.5','0.5']},'test')?.yesPayout).toBe('0.5');
    expect(parseLimitlessResolution({status:'RESOLVED',winningOutcomeIndex:1},'test')?.noPayout).toBe('1');
    expect(parsePolyResolution({closed:true,umaResolutionStatus:'resolved',outcomes:['Mike Malott','Joaquin Buckley'],outcomePrices:['1','0']},'test')?.yesPayout).toBe('1');
  });
});
