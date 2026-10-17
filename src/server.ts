import { profiler } from './profiling.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import { loadConfig, type Config } from './config.js';
import { Application } from './application.js';
import { executionReport } from './diagnostics/report.js';
import { diagnosticsCsv } from './diagnostics/execution.js';
import type { Source } from './paper/types.js';

const commandSchema = z.object({
  source: z.enum(['live', 'demo']), action: z.enum(['start', 'pause', 'reset', 'rebalance', 'close', 'close-all', 'settings', 'demo', 'review-mode']),
  payload: z.unknown().optional(),
}).strict();
const reviewSchema = z.object({ pairId: z.string().max(2000), notes: z.string().min(20).max(4000), checks: z.array(z.boolean()).length(5) }).strict();
const scenarioSchema = z.object({ scenario: z.enum(['normal', 'partial', 'rejection', 'delayed', 'mismatch']) }).strict();

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request body too large');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function csvCell(value: unknown): string {
  let str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  return `"${str.replaceAll('"', '""')}"`;
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

export async function startServer(options: { config?: Config; port?: number; startObserver?: boolean; lock?: boolean } = {}): Promise<{ url: string; app: Application; close: () => Promise<void> }> {
  const config = options.config ?? loadConfig();
  const app = new Application(config);
  const token = randomBytes(24).toString('hex');
  const port = options.port ?? Number(process.env.WEB_PORT ?? 4317);
  const bindHost = process.env.WEB_HOST === '0.0.0.0' && process.env.ALLOW_CONTAINER_BIND === 'true' ? '0.0.0.0' : '127.0.0.1';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WEB_PORT');
  const staticRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const lockPath = path.join(path.resolve(config.DATA_DIR), 'mvp-process.json');
  if (options.lock !== false) {
    await mkdir(path.dirname(lockPath), { recursive: true });
    try {
      const previous = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
      if (previous.pid !== process.pid) {
        let alive = false;
        try { process.kill(previous.pid, 0); alive = true; } catch { /* stale pid file */ }
        if (alive) throw new Error(`MVP already running (PID ${previous.pid})`);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }
  let opened = false, closing = false, localUrl = '';
  const server = createServer(async (request, response) => {
    const began = Date.now();
    const allowedHosts = new Set([`127.0.0.1:${(server.address() as { port: number })?.port}`, `localhost:${(server.address() as { port: number })?.port}`]);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!allowedHosts.has(request.headers.host ?? '')) { json(response, 403, { error: 'Local host required' }); return; }
    const url = new URL(request.url ?? '/', localUrl || 'http://127.0.0.1');
    try {
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${request.headers.host}`) { json(response, 403, { error: 'Origin rejected' }); return; }
        const supplied = Buffer.from(String(request.headers['x-local-token'] ?? ''));
        const expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { json(response, 403, { error: 'Local session token required' }); return; }
        if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) { json(response, 415, { error: 'JSON required' }); return; }
        if (url.pathname === '/api/command') {
          const command = commandSchema.parse(await readJson(request));
          if (command.action === 'demo') scenarioSchema.parse(command.payload);
          if (command.action === 'close') z.object({ tradeId: z.uuid() }).strict().parse(command.payload);
          if (command.action === 'review-mode') z.object({ enabled: z.boolean() }).strict().parse(command.payload);
          const result = await app.command(command.source, command.action, command.payload);
          json(response, 200, { ok: true, result });
        } else if (url.pathname === '/api/review') {
          const review = reviewSchema.parse(await readJson(request)); await app.review(review.pairId, review); json(response, 200, { ok: true });
        } else if (url.pathname === '/api/rescan') {
          z.object({}).strict().parse(await readJson(request)); await app.rescan(); json(response, 200, { ok: true });
        } else { json(response, 404, { error: 'No trading or credential endpoints exist in this MVP' }); }
        return;
      }
      if (request.method !== 'GET') { json(response, 405, { error: 'Method not allowed' }); return; }
      const source = z.enum(['live', 'demo']).parse(url.searchParams.get('source') ?? 'live') as Source;
      if (url.pathname === '/api/state') { json(response, 200, { csrf: token, ...await app.view(source) as object }); return; }
      if (url.pathname === '/api/diagnostics/profile') { json(response, 200, profiler.report()); return; }
      if (url.pathname === '/api/diagnostics/execution') {
        const report = await executionReport(app.dataDir);
        if (url.searchParams.get('format') === 'csv') {
          response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="execution-diagnostics.csv"' });
          response.end(diagnosticsCsv(report));
        } else json(response, 200, report);
        return;
      }
      if (url.pathname === '/api/pair') {
        const pair = app.pair(url.searchParams.get('id') ?? '');
        if (!pair) { json(response, 404, { error: 'Pair not found' }); return; }
        json(response, 200, { ...pair, polymarket: { ...pair.polymarket, raw: undefined }, limitless: { ...pair.limitless, raw: undefined } }); return;
      }
      if (url.pathname === '/api/export') {
        const state = app.exportState(source);
        const format = url.searchParams.get('format') ?? 'json';
        response.setHeader('content-disposition', `attachment; filename="arbitrage-${source}-${Date.now()}.${format === 'csv' ? 'csv' : 'json'}"`);
        if (format === 'csv') {
          const lines = [['id', 'source', 'title', 'status', 'signalAt', 'closedAt', 'cost', 'proceeds', 'realizedPnl', 'expectedRoi', 'expectedProfit', 'direction', 'filledAt', 'executionDelayMs', 'orderErrors'], ...state.trades.map(t => [t.id, source, t.title, t.status, new Date(t.signalAt).toISOString(), t.closedAt ? new Date(t.closedAt).toISOString() : '', t.orders.reduce((s, o) => s.plus(o.cost), new Decimal(0)).toString(), t.orders.reduce((s, o) => s.plus(o.proceeds), new Decimal(0)).toString(), t.realizedPnl, t.expectedRoi ?? '', t.expectedProfit, t.direction, t.filledAt ? new Date(t.filledAt).toISOString() : '', t.filledAt ? t.filledAt - t.signalAt : '', t.orders.map(o => o.error ? `${o.venue}: ${o.error}` : '').filter(Boolean).join('; ')])];
          response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' }); response.end('\uFEFF' + lines.map(row => row.map(csvCell).join(',')).join('\r\n'));
        } else json(response, 200, { exportedAt: new Date().toISOString(), paperOnly: true, state, diagnostics: app.audit.status(), assumptions: ['virtual money', 'future-snapshot FAK simulation', 'configured latency/rejections are model assumptions', 'no live exchange keys or order endpoints'] });
        return;
      }
      if (url.pathname === '/api/logs/files') { json(response, 200, { files: await app.auditFiles() }); return; }
      if (url.pathname === '/api/logs/download') {
        const name = url.searchParams.get('name') ?? '';
        if (!/^audit-[\d-]+\.jsonl\.gz$/.test(name) || !(await app.auditFiles()).includes(name)) { json(response, 404, { error: 'Log file not found' }); return; }
        const contents = await app.audit.snapshot(name);
        response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': contents.length, 'content-disposition': `attachment; filename="${name}"` });
        response.end(contents); return;
      }
      if (url.pathname === '/api/health') { json(response, 200, { ok: opened, paperOnly: true, auditError: app.audit.error }); return; }
      const files: Record<string, { name: string; mime: string }> = {
        '/': { name: 'index.html', mime: 'text/html; charset=utf-8' }, '/app.js': { name: 'app.js', mime: 'text/javascript; charset=utf-8' }, '/style.css': { name: 'style.css', mime: 'text/css; charset=utf-8' },
      };
      const file = files[url.pathname];
      if (!file) { json(response, 404, { error: 'Not found' }); return; }
      response.writeHead(200, { 'content-type': file.mime, 'cache-control': 'no-cache' }); response.end(await readFile(path.join(staticRoot, file.name)));
    } catch (e) {
      app.audit.record('api-error', 'system', { method: request.method, path: url.pathname, error: String(e) });
      if (!response.headersSent) json(response, e instanceof z.ZodError || e instanceof SyntaxError ? 400 : 409, { error: e instanceof Error ? e.message : String(e) });
      else response.end();
    } finally {
      if (request.method === 'POST') app.audit.record('ui-command', 'system', { method: request.method, path: url.pathname, status: response.statusCode, durationMs: Date.now() - began });
    }
  });
  try {
    await app.open(options.startObserver ?? process.env.OBSERVER_AUTOSTART !== 'false'); opened = true;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, bindHost, () => resolve()); });
    localUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  } catch (e) {
    if (opened) await app.close();
    if (options.lock !== false) await unlink(lockPath).catch(() => {});
    throw e;
  }
  const close = async () => {
    if (closing) return; closing = true;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
    await app.close(); if (options.lock !== false) await unlink(lockPath).catch(() => {});
  };
  return { url: localUrl, app, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await startServer();
  console.log(`Arbitrage Lab MVP: ${instance.url} (paper money only)`);
  const timer = setInterval(async () => {
    try {
      const pid = (await readFile(path.join(instance.app.dataDir, 'stop-request.txt'), 'utf8')).trim();
      if (pid === String(process.pid)) { await unlink(path.join(instance.app.dataDir, 'stop-request.txt')); clearInterval(timer); await instance.close(); }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(String(e)); }
  }, 1000);
  const stop = () => { clearInterval(timer); void instance.close().catch(e => { console.error(String(e)); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
