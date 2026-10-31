import WebSocket from 'ws';
import { analyzeTicker, detectPricePatterns } from './market-analysis.js';

const BINANCE_REST = 'https://api.binance.com/api/v3';
const BINANCE_STREAM = 'wss://stream.binance.com:443/stream?streams=';
const MIN_MARKETS = 51;
const HISTORY_SIZE = 60;
const REFRESH_UNIVERSE_MS = 30 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 1_000;
const MAX_CLIENTS = 40;

function readMarketLimit(raw) {
  const value = Number(raw || 100);
  if (!Number.isInteger(value) || value < MIN_MARKETS || value > 200) {
    throw new Error('XSAYATRADE_MARKET_SCAN_LIMIT must be an integer between 51 and 200.');
  }
  return value;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'XsayaTrade-market-scanner/1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Binance REST returned HTTP ${response.status}.`);
  return response.json();
}

export class BinanceMarketFeed {
  constructor({ enabled = true, marketLimit = process.env.XSAYATRADE_MARKET_SCAN_LIMIT, WebSocketClass = WebSocket, fetchJson = getJson } = {}) {
    this.enabled = enabled;
    this.marketLimit = readMarketLimit(marketLimit);
    this.WebSocketClass = WebSocketClass;
    this.fetchJson = fetchJson;
    this.status = enabled ? 'idle' : 'disabled';
    this.statusMessage = enabled ? 'در انتظار اتصال به Binance' : 'دادهٔ بازار در تنظیمات سرور خاموش است';
    this.symbols = [];
    this.marketData = new Map();
    this.clients = new Set();
    this.socket = null;
    this.running = false;
    this.retryTimer = null;
    this.refreshTimer = null;
    this.snapshotTimer = null;
    this.pingTimer = null;
    this.retryDelay = 1_000;
    this.lastMessageAt = null;
    this.universeFetchedAt = 0;
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref?.();
    void this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.refreshTimer);
    clearInterval(this.snapshotTimer);
    clearInterval(this.pingTimer);
    this.retryTimer = this.refreshTimer = this.snapshotTimer = this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < this.WebSocketClass.CLOSING) socket.close(1000, 'server shutdown');
    for (const client of this.clients) {
      clearInterval(client.heartbeat);
      if (!client.response.writableEnded) client.response.end();
    }
    this.clients.clear();
  }

  async discoverSymbols() {
    const [exchangeInfo, tickers] = await Promise.all([
      this.fetchJson(`${BINANCE_REST}/exchangeInfo`),
      this.fetchJson(`${BINANCE_REST}/ticker/24hr`)
    ]);
    const eligible = new Set((exchangeInfo.symbols || [])
      .filter(item => item.status === 'TRADING' && item.quoteAsset === 'USDT' && item.isSpotTradingAllowed !== false)
      .map(item => item.symbol));
    const ranked = (Array.isArray(tickers) ? tickers : [])
      .filter(item => eligible.has(item.symbol) && Number.isFinite(Number(item.quoteVolume)))
      .sort((left, right) => Number(right.quoteVolume) - Number(left.quoteVolume))
      .map(item => item.symbol);
    const chosen = ranked.slice(0, this.marketLimit);
    if (!chosen.includes('BTCUSDT')) {
      chosen.pop();
      chosen.push('BTCUSDT');
    }
    const unique = [...new Set(chosen)];
    if (unique.length < MIN_MARKETS) throw new Error(`Binance returned only ${unique.length} eligible USDT spot markets; at least ${MIN_MARKETS} are required.`);
    this.universeFetchedAt = Date.now();
    return unique;
  }

  async connect() {
    if (!this.running) return;
    this.setStatus('discovering', 'در حال دریافت فهرست بازارهای فعال Binance');
    try {
      if (Date.now() - this.universeFetchedAt > REFRESH_UNIVERSE_MS || this.symbols.length < MIN_MARKETS) {
        this.symbols = await this.discoverSymbols();
      }
    } catch (error) {
      if (this.symbols.length < MIN_MARKETS) {
        this.setStatus('offline', `فهرست بازارهای Binance دریافت نشد: ${error.message}`);
        this.scheduleReconnect();
        return;
      }
      this.setStatus('degraded', `فهرست فعلی استفاده می‌شود؛ تازه‌سازی ناموفق بود: ${error.message}`);
    }
    if (!this.running) return;

    const streams = this.symbols.map(symbol => `${symbol.toLowerCase()}@ticker`).join('/');
    let socket;
    try {
      socket = new this.WebSocketClass(`${BINANCE_STREAM}${streams}`, {
        handshakeTimeout: 12_000,
        maxPayload: 1_048_576,
        perMessageDeflate: false
      });
    } catch (error) {
      this.setStatus('offline', `اتصال WebSocket ساخته نشد: ${error.message}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    let alive = true;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.retryDelay = 1_000;
      this.setStatus('connected', `Binance Spot · پایش هم‌زمان ${this.symbols.length} بازار`);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (socket.readyState !== this.WebSocketClass.OPEN) return;
        if (!alive) return socket.terminate();
        alive = false;
        socket.ping();
      }, 25_000);
      this.pingTimer.unref?.();
      this.scheduleUniverseRefresh(socket);
    });
    socket.on('pong', () => { alive = true; });
    socket.on('message', payload => this.handleMessage(payload));
    socket.on('error', error => {
      if (this.socket === socket) this.setStatus('degraded', `اتصال Binance ناپایدار است: ${error.message}`);
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.running) {
        this.setStatus('reconnecting', `اتصال Binance قطع شد (${code})؛ تلاش مجدد در حال انجام است`);
        this.scheduleReconnect();
      }
    });
  }

  scheduleUniverseRefresh(socket) {
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      if (!this.running || this.socket !== socket) return;
      try {
        const updated = await this.discoverSymbols();
        const oldKey = this.symbols.join(',');
        const newKey = updated.join(',');
        if (oldKey !== newKey) {
          this.symbols = updated;
          socket.close(1012, 'market universe refreshed');
        }
      } catch (error) {
        this.setStatus('degraded', `بازارها فعال‌اند؛ تازه‌سازی فهرست با خطا روبه‌رو شد: ${error.message}`);
      }
    }, REFRESH_UNIVERSE_MS);
    this.refreshTimer.unref?.();
  }

  scheduleReconnect() {
    if (!this.running || this.retryTimer) return;
    const wait = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }

  handleMessage(payload) {
    let frame;
    try { frame = JSON.parse(payload.toString()); } catch { return; }
    const tick = frame?.data || frame;
    const symbol = String(tick?.s || '').toUpperCase();
    if (!this.symbols.includes(symbol)) return;
    const previous = this.marketData.get(symbol);
    const value = analyzeTicker(tick, previous, Date.now());
    if (!value.symbol) return;
    const history = previous?.history || [];
    if (value.price && value.quality !== 'error' && value.eventTime > (history.at(-1)?.timestamp || 0)) {
      history.push({ timestamp: value.eventTime, price: value.price });
      if (history.length > HISTORY_SIZE) history.splice(0, history.length - HISTORY_SIZE);
    }
    const detected = detectPricePatterns(history);
    this.marketData.set(symbol, { ...value, history, patterns: detected.patterns, patternSamples: detected.sampleCount, patternReady: detected.ready });
    this.lastMessageAt = Date.now();
  }

  setStatus(status, message) {
    this.status = status;
    this.statusMessage = message;
    this.broadcast('status', { status, message, at: Date.now() });
  }

  publicMarket(value, now, includeHistory = false) {
    if (!value) return null;
    const flags = [...value.flags];
    if (now - value.eventTime > 5_000 && !flags.includes('stale_tick')) flags.push('stale_tick');
    const blocking = flags.some(flag => ['invalid_price', 'invalid_book', 'invalid_timestamp', 'crossed_book', 'stale_tick', 'future_tick'].includes(flag));
    const quality = blocking ? 'error' : flags.length ? 'warning' : 'ok';
    return {
      symbol: value.symbol,
      price: value.price,
      bid: value.bid,
      ask: value.ask,
      spreadPct: value.spreadPct,
      changePct24h: value.changePct24h,
      quoteVolume24h: value.quoteVolume24h,
      eventTime: value.eventTime,
      ageMs: Math.max(0, now - value.eventTime),
      quality,
      flags,
      patterns: value.patterns,
      patternReady: value.patternReady,
      patternSamples: value.patternSamples,
      ...(includeHistory ? { history: value.history } : {})
    };
  }

  snapshot() {
    const now = Date.now();
    const markets = this.symbols.map(symbol => {
      const value = this.marketData.get(symbol);
      if (!value) return { symbol, price: null, bid: null, ask: null, spreadPct: null, changePct24h: null, quoteVolume24h: null, eventTime: null, ageMs: null, quality: 'pending', flags: [], patterns: [], patternReady: false, patternSamples: 0 };
      return this.publicMarket(value, now);
    });
    const anomalyCount = markets.filter(market => market.flags.length > 0).length;
    const btc = this.publicMarket(this.marketData.get('BTCUSDT'), now, true);
    return {
      provider: 'Binance Spot',
      status: this.status,
      message: this.statusMessage,
      marketCount: this.symbols.length,
      requiredMarketCount: MIN_MARKETS,
      configuredMarketCount: this.marketLimit,
      syncIntervalMs: SNAPSHOT_INTERVAL_MS,
      syncedAt: this.lastMessageAt,
      generatedAt: now,
      clientCount: this.clients.size,
      anomalyCount,
      btc,
      markets
    };
  }

  getSnapshot() { return this.snapshot(); }

  writeEvent(response, event, data) {
    if (response.destroyed || response.writableEnded) return false;
    if (response.writableLength > 512 * 1024) return false;
    return response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event, data) {
    for (const client of this.clients) {
      if (!this.writeEvent(client.response, event, data)) {
        clearInterval(client.heartbeat);
        this.clients.delete(client);
        client.response.destroy();
      }
    }
  }

  broadcastSnapshot() {
    if (!this.clients.size) return;
    this.broadcast('snapshot', this.snapshot());
  }

  subscribe(response) {
    if (!this.enabled) {
      response.write('event: status\ndata: {"status":"disabled","message":"دادهٔ بازار در تنظیمات سرور خاموش است"}\n\n');
      response.end();
      return false;
    }
    if (this.clients.size >= MAX_CLIENTS) {
      response.write('event: status\ndata: {"status":"busy","message":"ظرفیت اتصال زنده تکمیل است؛ بعداً دوباره تلاش کنید"}\n\n');
      response.end();
      return false;
    }
    const client = { response, heartbeat: null };
    this.clients.add(client);
    client.heartbeat = setInterval(() => this.writeEvent(response, 'ping', { at: Date.now() }), 15_000);
    client.heartbeat.unref?.();
    response.once('close', () => {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
    });
    this.writeEvent(response, 'snapshot', this.snapshot());
    if (!this.running) this.start();
    return true;
  }
}

export const marketFeedConstants = Object.freeze({ MIN_MARKETS, HISTORY_SIZE, REFRESH_UNIVERSE_MS, SNAPSHOT_INTERVAL_MS, MAX_CLIENTS });
