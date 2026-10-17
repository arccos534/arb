import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('local paper-only HTTP application',()=>{
  it('serves UI, validates local commands, rejects cross-origin writes and never accepts credentials',async()=>{
    const dir=await mkdtemp(path.join(tmpdir(),'mvp-http-'));
    const instance=await startServer({config:loadConfig({DATA_DIR:dir,LOG_LEVEL:'silent'}),port:0,startObserver:false,lock:false});
    try{
      expect((await fetch(instance.url)).status).toBe(200);
      const noDiagnostics = await (await fetch(instance.url+'/api/diagnostics/execution')).json() as {available:boolean};
      expect(noDiagnostics.available).toBe(false);
      expect(await (await fetch(instance.url+'/api/diagnostics/profile')).json()).toMatchObject({schemaVersion:1,clock:'monotonic',stages:expect.any(Array)});
      await mkdir(path.join(dir,'diagnostics'));
      await writeFile(path.join(dir,'diagnostics/execution-latest.json'),JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),status:'collecting',cases:[],table:[],insufficientData:true}));
      expect(await (await fetch(instance.url+'/api/diagnostics/execution')).json()).toMatchObject({available:true,insufficientData:true});
      const csvDiagnostics=await fetch(instance.url+'/api/diagnostics/execution?format=csv');
      expect(csvDiagnostics.headers.get('content-type')).toContain('text/csv');
      expect(await csvDiagnostics.text()).toContain('latencyMs');
      const state=await (await fetch(instance.url+'/api/state?source=demo')).json() as {csrf:string;paperOnly:boolean;state:{running:boolean}};
      expect(state.paperOnly).toBe(true);expect(state.state.running).toBe(false);
      const post=(body:unknown,headers:Record<string,string>={})=>fetch(instance.url+'/api/command',{method:'POST',headers:{'content-type':'application/json','x-local-token':state.csrf,...headers},body:JSON.stringify(body)});
      expect((await post({source:'demo',action:'start'},{origin:'https://untrusted.invalid'})).status).toBe(403);
      expect((await post({source:'demo',action:'start'},{'x-local-token':'wrong'})).status).toBe(403);
      expect((await post({source:'demo',action:'start',apiKey:'never-store'})).status).toBe(400);
      expect((await post({source:'demo',action:'review-mode',payload:{enabled:'true'}})).status).toBe(400);
      expect((await post({source:'demo',action:'review-mode',payload:{enabled:true}})).status).toBe(200);
      expect(instance.app.engines.demo.settings.skipManualReview).toBe(true);
      expect(instance.app.engines.live.settings.skipManualReview).toBe(false);
      expect((await post({source:'demo',action:'review-mode',payload:{enabled:false}})).status).toBe(200);
      expect((await post({source:'demo',action:'demo',payload:{scenario:'normal'}})).status).toBe(200);
      const live=await (await fetch(instance.url+'/api/state?source=live')).json() as {state:{trades:unknown[];running:boolean}};
      expect(live.state.trades).toHaveLength(0);expect(live.state.running).toBe(false);
      expect((await fetch(instance.url+'/api/withdraw',{method:'POST',headers:{'content-type':'application/json','x-local-token':state.csrf},body:'{}'})).status).toBe(404);
      const exported=await (await fetch(instance.url+'/api/export?source=demo')).json() as {paperOnly:boolean;state:unknown};expect(exported.paperOnly).toBe(true);
      expect((await fetch(instance.url+'/api/logs/download?name=../../.env')).status).toBe(404);
    }finally{await instance.close();await rm(dir,{recursive:true,force:true});}
  },20000);
});
