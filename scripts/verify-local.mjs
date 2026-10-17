import { mkdir, writeFile } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://127.0.0.1:4317';
async function get(route) {
  const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response.json();
}
try {
  const health = await get('/api/health');
  const [live,demo,profile] = await Promise.all([get('/api/state?source=live'),get('/api/state?source=demo'),get('/api/diagnostics/profile')]);
  const summarize = state => ({ sessionId:state.state.sessionId,running:state.state.running,trades:state.state.trades.length,
    cash:state.state.cash,realizedPnl:state.state.realizedPnl,latencyMs:state.state.settings.latencyMs,skipManualReview:state.state.settings.skipManualReview });
  const failure = !health.ok || Boolean(health.auditError || health.observerError || live.marketDatabase?.error) || live.candidates.length>10;
  const connected = health.feed?.streams?.polymarket?.connected && health.feed?.streams?.limitless?.connected;
  const result = { at:new Date().toISOString(),status:failure?'error':!health.feed?.ready?'starting':connected?'collecting':'reconnecting',
    url:base,pid:health.pid,paperOnly:health.paperOnly,auditError:health.auditError,observerError:health.observerError,
    feed:{ready:health.feed?.ready,phase:health.feed?.phase,complete:live.feed.catalog?.complete,coverage:live.feed.coverage,
      discoveryError:live.feed.discoveryError,streams:health.feed?.streams},sessions:{live:summarize(live),demo:summarize(demo)},
    marketDatabase:live.marketDatabase,displayedMarkets:live.candidates.length,
    profile:{enabled:profile.enabled,runtime:profile.runtime,stages:profile.stages.filter(s=>['json-decode','decode','stream-queue','quote-to-decision','decision-complete','ui','wal'].includes(s.stage))} };
  await mkdir('data/analysis',{recursive:true});
  await writeFile('data/analysis/local-validation-latest.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  if(failure)process.exitCode=1;
} catch(error) { console.error(error.message);process.exitCode=1; }
