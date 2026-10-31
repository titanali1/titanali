import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTicker, detectPricePatterns } from '../market-analysis.js';

test('Binance ticker validation flags crossed books, stale ticks, and extreme jumps', () => {
  const now = 1_000_000;
  const previous = { price: 100, eventTime: now - 1_000 };
  const crossed = analyzeTicker({ s: 'BTCUSDT', c: '106', b: '107', a: '105', q: '10', P: '1', E: now }, previous, now);
  assert.equal(crossed.quality, 'error');
  assert.ok(crossed.flags.includes('crossed_book'));
  assert.ok(crossed.flags.includes('extreme_jump'));

  const stale = analyzeTicker({ s: 'BTCUSDT', c: '100', b: '99.9', a: '100.1', q: '10', P: '0', E: now - 10_000 }, null, now);
  assert.equal(stale.quality, 'error');
  assert.ok(stale.flags.includes('stale_tick'));
});

test('Binance ticker validation rejects non-positive prices and malformed books', () => {
  const result = analyzeTicker({ s: 'ETHUSDT', c: '0', b: '-1', a: 'x', q: '-2', P: 'NaN', E: 'invalid' }, null, 2_000);
  assert.equal(result.price, null);
  assert.ok(result.flags.includes('invalid_price'));
  assert.ok(result.flags.includes('invalid_book'));
  assert.ok(result.flags.includes('invalid_timestamp'));
  assert.ok(result.flags.includes('invalid_volume'));
});

test('pattern recognition reports short momentum, trend, and range breakout from real samples', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({ timestamp: index * 1_000, price: 100 + index * 0.1 }));
  const detected = detectPricePatterns(history);
  assert.equal(detected.ready, true);
  assert.ok(detected.patterns.some(pattern => pattern.key === 'momentum_up'));
  assert.ok(detected.patterns.some(pattern => pattern.key === 'short_trend_up'));
  assert.ok(detected.patterns.some(pattern => pattern.key === 'range_breakout_up'));
  assert.ok(detected.patterns.every(pattern => pattern.strength >= 0 && pattern.strength <= 99));
});
