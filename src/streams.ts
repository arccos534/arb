import WebSocket from 'ws';
import { io, type Socket } from 'socket.io-client';
import { Decimal } from 'decimal.js';
import type { Logger } from 'pino';
import type { Book, Market } from './domain.js';
import { BookCache, limitlessBooks, polyBook, timestamp } from './books.js';
import { array, record } from './http.js';
import { StreamQueue } from './stream-queue.js';

export interface StreamHealth { connected: boolean; frames: number; parseErrors: number; reconnects: number; lastFrameAt: string | null }

export class PolyStreamState {
  private readonly snapshots = new Map<string, Book>();
  private readonly ticks = new Map<string, { size: string; at: number | null }>();
  private readonly assets: Map<string, { market: Market; outcome: 'yes' | 'no' }>;
  constructor(markets: Market[], private readonly cache: BookCache) {
    this.assets = new Map<string, { market: Market; outcome: 'yes' | 'no' }>(markets.flatMap(m => [
      [m.yesToken, { market: m, outcome: 'yes' as const }] as const,
      [m.noToken, { market: m, outcome: 'no' as const }] as const,
    ]));
  }

  apply(message: unknown, now = Date.now()): void {
    if (Array.isArray(message)) { message.forEach(m => this.apply(m, now)); return; }
    const raw = record(message);
    const type = raw.event_type;
    if (type === 'price_change') {
      // Apply all deltas for an asset before publishing the resulting book.
      const changed = new Map<string, Book>();
      for (const item of array(raw.price_changes)) {
        const change = record(item), id = String(change.asset_id);
        const snapshot = changed.get(id) ?? this.snapshots.get(id);
        if (!snapshot) continue;
        const oldTime = snapshot.sourceTimestamp, newTime = timestamp(raw.timestamp);
        if (oldTime && newTime && newTime < oldTime) continue;
        const side = change.side === 'BUY' ? 'bids' : change.side === 'SELL' ? 'asks' : null;
        if (!side) throw new Error('Unsupported price-change side');
        const price = new Decimal(String(change.price)), size = new Decimal(String(change.size));
        if (!price.isFinite() || !size.isFinite() || price.lte(0) || price.gte(1) || size.lt(0)) throw new Error('Invalid stream delta');
        const rows = snapshot[side].slice(), canonical = price.toString();
        const index = rows.findIndex(l => l.price === canonical);
        if (index >= 0) {
          if (size.isZero()) rows.splice(index, 1);
          else rows[index] = { price: canonical, shares: size.toString() };
        } else if (size.gt(0)) {
          let left = 0, right = rows.length;
          while (left < right) {
            const middle = (left + right) >>> 1, order = new Decimal(rows[middle]!.price).comparedTo(price);
            if (side === 'asks' ? order < 0 : order > 0) left = middle + 1; else right = middle;
          }
          rows.splice(left, 0, { price: canonical, shares: size.toString() });
        }
        changed.set(id, { ...snapshot, [side]: rows, receivedAt: now, sourceTimestamp: newTime });
      }
      for (const [id, book] of changed) { this.snapshots.set(id, book); this.cache.set(book); }
      return;
    }
    const id = String(raw.asset_id), asset = this.assets.get(id);
    if (!asset) return;
    if (type === 'book') {
      const previous = this.snapshots.get(id);
      const oldTime = previous?.sourceTimestamp, newTime = timestamp(raw.timestamp);
      if (oldTime && newTime && newTime < oldTime) return;
      const tick = this.ticks.get(id);
      if (tick?.at && newTime && newTime < tick.at) return;
      const book = polyBook({
        ...raw, tick_size: raw.tick_size ?? tick?.size ?? asset.market.raw.orderPriceMinTickSize,
        min_order_size: raw.min_order_size ?? asset.market.raw.orderMinSize,
      }, asset.market, asset.outcome, 'websocket', now);
      this.snapshots.set(id, book); this.cache.set(book);
    } else if (type === 'tick_size_change') {
      const size = new Decimal(String(raw.new_tick_size));
      if (!size.isFinite() || size.lte(0) || size.gte(1)) throw new Error('Invalid tick-size change');
      const at = timestamp(raw.timestamp), previous = this.ticks.get(id);
      if (at && previous?.at && at < previous.at) return;
      this.ticks.set(id, { size: size.toString(), at });
      // Require a fresh complete snapshot after a tick-size change.
      this.snapshots.delete(id);
      this.cache.delete('polymarket', asset.market.slug, asset.outcome);
    }
  }

}

export class LimitlessStreamState {
  private readonly versions = new Map<string, number>();
  private readonly markets: Map<string, Market>;
  constructor(markets: Market[], private readonly cache: BookCache) { this.markets = new Map(markets.map(m => [m.slug, m])); }
  apply(value: unknown, now = Date.now()): void {
    const raw = record(value), slug = String(raw.marketSlug), market = this.markets.get(slug);
    if (!market) return;
    const version = Number(raw.version);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Missing or invalid Limitless version');
    const previous = this.versions.get(slug);
    if (previous !== undefined && version <= previous) return;
    const books = limitlessBooks(raw.orderbook, market, 'websocket', now, raw.timestamp);
    this.versions.set(slug, version);
    books.forEach(book => this.cache.set(book));
  }
}

function health(): StreamHealth { return { connected: false, frames: 0, parseErrors: 0, reconnects: 0, lastFrameAt: null }; }

export class PublicStreams {
  private readonly localHealth = { polymarket: health(), limitless: health() };
  private readonly children: PublicStreams[] = [];
  private readonly startTimers: NodeJS.Timeout[] = [];
  get health(): { polymarket: StreamHealth; limitless: StreamHealth } {
    if (!this.children.length) return this.localHealth;
    const sum = (venue: 'polymarket' | 'limitless'): StreamHealth => {
      const states = this.children.filter(c => (venue === 'polymarket' ? c.poly : c.limitless).length).map(c => c.health[venue]);
      return { connected: states.length > 0 && states.every(s => s.connected), frames: states.reduce((n,s)=>n+s.frames,0),
        parseErrors: states.reduce((n,s)=>n+s.parseErrors,0), reconnects: states.reduce((n,s)=>n+s.reconnects,0),
        lastFrameAt: states.map(s=>s.lastFrameAt).filter((v): v is string=>v!==null).sort().at(-1)??null };
    };
    return { polymarket: sum('polymarket'), limitless: sum('limitless') };
  }
  private polySocket: WebSocket | undefined;
  private lmSocket: Socket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private stopped = false;
  private polyQueue: StreamQueue | undefined;
  private lmQueue: StreamQueue | undefined;
  private lmReconnectTimer: NodeJS.Timeout | undefined;
  private attempts = 0;

  constructor(private readonly poly: Market[], private readonly limitless: Market[], private readonly cache: BookCache, private readonly logger: Logger, private readonly diagnostic?: (category: string, payload: unknown) => void) {}

  start(): void {
    // Bound initial snapshot frames and per-connection subscription size while
    // retaining every market. Staggering avoids a simultaneous snapshot burst.
    if (this.poly.length > 100 || this.limitless.length > 100) {
      const groups = Math.ceil(Math.max(this.poly.length, this.limitless.length) / 100);
      for (let i=0;i<groups;i++) {
        const child = new PublicStreams(this.poly.slice(i*100,(i+1)*100),this.limitless.slice(i*100,(i+1)*100),this.cache,this.logger,this.diagnostic);
        this.children.push(child);
        this.startTimers.push(setTimeout(()=>{if(!this.stopped)child.start();},i*1000));
      }
      return;
    }
    if (this.poly.length) this.connectPoly();
    if (this.limitless.length) this.connectLimitless();
  }

  private connectPoly(): void {
    if (this.stopped) return;
    const state = new PolyStreamState(this.poly, this.cache);
    const socket = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', { handshakeTimeout: 10000 });
    this.polySocket = socket;
    const rejected = (error: unknown) => {
      queue.stop(); this.health.polymarket.parseErrors++;
      this.cache.clearMarkets('polymarket', this.poly.map(m => m.slug)); socket.terminate();
      this.logger.warn({ err: String(error) }, 'Polymarket stream rejected; resync required');
    };
    const queue = new StreamQueue((value, receivedAt) => {
      if (!this.stopped && socket === this.polySocket && socket.readyState === WebSocket.OPEN) state.apply(value, receivedAt);
    }, rejected);
    this.polyQueue = queue;
    let lastMessage = Date.now();
    socket.on('open', () => {
      this.health.polymarket.connected = true;
      this.attempts = 0;
      socket.send(JSON.stringify({ type: 'market', assets_ids: this.poly.flatMap(m => [m.yesToken, m.noToken]) }));
      this.diagnostic?.('raw-websocket-subscribe', { venue: 'polymarket', assets_ids: this.poly.flatMap(m => [m.yesToken, m.noToken]) });
      this.heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 30000) { socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) socket.send('PING');
      }, 10000);
    });
    socket.on('message', bytes => {
      lastMessage = Date.now();
      if (this.stopped) return;
      const body = bytes.toString();
      this.diagnostic?.('raw-websocket-polymarket', { receivedAt: Date.now(), body });
      if (body === 'PONG') return;
      this.health.polymarket.frames++;
      this.health.polymarket.lastFrameAt = new Date().toISOString();
      try {
        const parsed: unknown = JSON.parse(body);
        const frames = (Array.isArray(parsed) ? parsed : [parsed]).filter(value => {
          const type = value && typeof value === 'object' ? (value as Record<string, unknown>).event_type : null;
          return ['book', 'price_change', 'tick_size_change'].includes(String(type));
        });
        queue.push(frames, lastMessage);
      }
      catch (e) { rejected(e); }
    });
    socket.on('error', e => this.logger.warn({ err: e.message }, 'Polymarket WebSocket error'));
    socket.on('close', () => {
      queue.stop();
      this.diagnostic?.('stream-disconnected', { venue: 'polymarket', stopped: this.stopped });
      this.health.polymarket.connected = false;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (!this.stopped) this.cache.clearMarkets('polymarket', this.poly.map(m => m.slug));
      if (!this.stopped) {
        this.health.polymarket.reconnects++;
        this.reconnectTimer = setTimeout(() => this.connectPoly(), Math.min(30000, 1000 * 2 ** this.attempts++));
      }
    });
  }

  private connectLimitless(): void {
    let state = new LimitlessStreamState(this.limitless, this.cache);
    let queue: StreamQueue | undefined;
    const socket = io('wss://ws.limitless.exchange/markets', { transports: ['websocket'], reconnectionDelayMax: 30000, timeout: 10000 });
    this.lmSocket = socket;
    socket.onAny((event, ...payload) => { this.diagnostic?.('raw-websocket-limitless', { receivedAt: Date.now(), event, payload }); });
    socket.on('connect', () => {
      if (this.stopped) return;
      state = new LimitlessStreamState(this.limitless, this.cache);
      queue?.stop();
      queue = new StreamQueue((value, receivedAt) => { if (!this.stopped && socket.connected) state.apply(value, receivedAt); }, error => {
        this.health.limitless.parseErrors++; this.cache.clearMarkets('limitless', this.limitless.map(m => m.slug));
        this.logger.warn({ err: String(error) }, 'Limitless stream rejected; resync required');
        socket.disconnect(); if (!this.stopped) this.lmReconnectTimer = setTimeout(() => { if (!this.stopped) socket.connect(); }, 1000);
      });
      this.lmQueue = queue;
      this.health.limitless.connected = true;
      socket.emit('subscribe_market_prices', { marketSlugs: this.limitless.map(m => m.slug) });
      this.diagnostic?.('raw-websocket-subscribe', { venue: 'limitless', marketSlugs: this.limitless.map(m => m.slug) });
    });
    socket.on('orderbookUpdate', value => {
      if (this.stopped) return;
      this.health.limitless.frames++;
      this.health.limitless.lastFrameAt = new Date().toISOString();
      queue?.push([value], Date.now());
    });
    socket.on('disconnect', reason => { queue?.stop(); this.diagnostic?.('stream-disconnected', { venue: 'limitless', reason }); this.health.limitless.connected = false; if (!this.stopped) this.cache.clearMarkets('limitless', this.limitless.map(m => m.slug)); });
    socket.io.on('reconnect_attempt', () => { this.health.limitless.reconnects++; });
    socket.on('connect_error', e => this.logger.warn({ err: e.message }, 'Limitless WebSocket error'));
    for (const event of ['exception', 'error']) socket.on(event, value => this.logger.warn({ event, value }, 'Limitless subscription error'));
  }

  stop(): void {
    this.stopped = true;
    this.startTimers.forEach(timer=>clearTimeout(timer));
    this.children.forEach(child=>child.stop());
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.lmReconnectTimer) clearTimeout(this.lmReconnectTimer);
    this.polyQueue?.stop(); this.lmQueue?.stop();
    this.polySocket?.close();
    this.lmSocket?.disconnect();
  }
}
