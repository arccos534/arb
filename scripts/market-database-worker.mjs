import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync(workerData.filename, { timeout: 5000 });
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
 CREATE TABLE IF NOT EXISTS market_latest(id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, roi REAL, fresh_until INTEGER NOT NULL, payload TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS market_latest_roi ON market_latest(roi DESC);
 CREATE INDEX IF NOT EXISTS market_latest_freshness ON market_latest(fresh_until);`);
const upsert = db.prepare('INSERT INTO market_latest VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,roi=excluded.roi,fresh_until=excluded.fresh_until,payload=excluded.payload');
const rows = new Map(), pending = new Map();
let version = 0, updatedAt = 0, persistedAt = 0, storageError = null;
const existingRows = db.prepare('SELECT count(*) AS count FROM market_latest').get().count;
if(!existingRows){
  let cached;try{cached=JSON.parse(readFileSync(path.join(path.dirname(workerData.filename),'candidates-latest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  if(Array.isArray(cached?.candidates)){
    db.exec('BEGIN');try{for(const p of cached.candidates){
      const row={id:p.id,title:p.polymarket.title,limitlessTitle:p.limitless.title,endsAt:p.polymarket.endsAt,score:p.score,review:p.review,watched:false,roi:null,profit:null,direction:null,reasons:['missing-book'],entryReasons:['missing-book'],quoteReason:'missing-book',evaluations:[],updatedAt:Date.parse(cached.at)||0,freshUntil:0,strategyEligible:false,entryReady:false};
      upsert.run(row.id,row.updatedAt,null,0,JSON.stringify(row));
    }db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
  }
}
for(const saved of db.prepare('SELECT payload FROM market_latest').all()){
  const row=JSON.parse(saved.payload);row.freshUntil=0;row.entryReady=false;row.strategyEligible=false;row.searchText=`${row.title} ${row.limitlessTitle}`.toLowerCase();rows.set(row.id,row);
}
function flush() {
  if (!pending.size) return;
  db.exec('BEGIN');
  try { for (const row of pending.values()) upsert.run(row.id,row.updatedAt,row.roi===null?null:Number(row.roi),row.freshUntil,JSON.stringify(row)); db.exec('COMMIT'); pending.clear();persistedAt=Date.now();storageError=null; }
  catch(error) { db.exec('ROLLBACK');storageError=String(error); throw error; }
}
const timer = setInterval(() => { try { flush(); } catch(error) { parentPort.postMessage({warning:String(error)}); } },500);
parentPort.on('message', message => {
  const {id,type}=message;
  try {
    let value;
    if(type==='upsert') { for(const row of message.rows){row.searchText=`${row.title} ${row.limitlessTitle}`.toLowerCase();rows.set(row.id,row);pending.set(row.id,row);}updatedAt=Date.now();version++;value=true; }
    else if(type==='catalog') {
      if(message.complete){const allowed=new Set(message.ids);for(const key of rows.keys())if(!allowed.has(key)){rows.delete(key);pending.delete(key);}
        db.prepare('DELETE FROM market_latest WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(message.ids));}version++;value=true;
    } else if(type==='query') {
      const now=Date.now(),query=message.query??{},search=String(query.search??'').toLowerCase(),top=[];
      let calculated=0,freshCalculated=0,positive=0,eligible=0,ready=0,matched=0;
      for(const row of rows.values()) {
        if(row.roi!==null)calculated++;
        const fresh=row.roi!==null&&row.freshUntil>now;
        if(fresh){freshCalculated++;if(Number(row.roi)>0)positive++;if(row.entryReady)ready++;}
        if(row.strategyEligible)eligible++;
        if(query.filter==='reviewed'&&!row.review.approved||query.filter==='watching'&&!row.watched||query.filter==='strategy'&&!row.strategyEligible||search&&!row.searchText.includes(search))continue;
        if(!fresh)continue;matched++;
        let i=0;while(i<top.length&&(Number(top[i].roi)>Number(row.roi)||Number(top[i].roi)===Number(row.roi)&&top[i].id.localeCompare(row.id)<0))i++;
        if(i<10){top.splice(i,0,row);if(top.length>10)top.pop();}
      }
      value={candidates:top.map(({searchText,...row})=>row),database:{status:storageError?'storage-error':'live',error:storageError,total:rows.size,storedAtStartup:existingRows,calculated,freshCalculated,positive,eligible,ready,matched,version,updatedAt,persistedAt,pendingWrites:pending.size,limit:10}};
    } else if(type==='close'){clearInterval(timer);flush();db.close();value=true;}
    else throw new Error('Unknown market database command');
    parentPort.postMessage({id,value});if(type==='close')parentPort.close();
  }catch(error){parentPort.postMessage({id,error:String(error)});}
});
parentPort.postMessage({ready:true});
