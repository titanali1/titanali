import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceMarketFeed } from '../market-data.js';

test('market feed selects over 50 liquid USDT spot markets and ingests BTC ticker snapshots', async () => {
  const symbols = Array.from({ length: 70 }, (_, index) => `COIN${String(index).padStart(3, '0')}USDT`);
  symbols.push('BTCUSDT', 'FAKEBUSD');
  const exchangeInfo = { symbols: symbols.map(symbol => ({ symbol, status: 'TRADING', quoteAsset: symbol.endsWith('BUSD') ? 'BUSD' : 'USDT', isSpotTradingAllowed: true })) };
  const tickers = symbols.map((symbol, index) => ({ symbol, quoteVolume: symbol === 'BTCUSDT' ? '0' : String(index + 1) }));
  const feed = new BinanceMarketFeed({ marketLimit: 60, fetchJson: async url => url.endsWith('/exchangeInfo') ? exchangeInfo : tickers });
  const selected = await feed.discoverSymbols();
  assert.equal(selected.length, 60);
  assert.ok(selected.includes('BTCUSDT'), 'BTC is always included even if it falls outside the volume-ranked page');
  assert.ok(selected.every(symbol => symbol.endsWith('USDT')));

  feed.symbols = selected;
  const now = Date.now();
  feed.handleMessage(Buffer.from(JSON.stringify({ stream: 'btcusdt@ticker', data: {
    s: 'BTCUSDT', E: now, c: '67890.12', b: '67889.9', a: '67890.2', P: '1.25', q: '123456789'
  } })));
  const snapshot = feed.getSnapshot();
  assert.equal(snapshot.marketCount, 60);
  assert.equal(snapshot.syncIntervalMs, 1000);
  assert.equal(snapshot.btc.price, 67890.12);
  assert.equal(snapshot.btc.symbol, 'BTCUSDT');
  feed.stop();
});
