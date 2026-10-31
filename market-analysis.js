const VALIDATION_FLAGS = new Set(['invalid_price', 'invalid_book', 'invalid_timestamp', 'crossed_book', 'stale_tick', 'future_tick']);

export function analyzeTicker(tick, previous = null, now = Date.now()) {
  const price = Number(tick?.c);
  const bid = Number(tick?.b);
  const ask = Number(tick?.a);
  const eventTime = Number(tick?.E);
  const quoteVolume = Number(tick?.q);
  const flags = [];

  if (!Number.isFinite(price) || price <= 0) flags.push('invalid_price');
  if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0) flags.push('invalid_book');
  if (!Number.isFinite(eventTime) || eventTime <= 0) flags.push('invalid_timestamp');
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && bid > ask) flags.push('crossed_book');
  if (Number.isFinite(eventTime) && now - eventTime > 5_000) flags.push('stale_tick');
  if (Number.isFinite(eventTime) && eventTime > now + 5_000) flags.push('future_tick');

  const midpoint = bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const spreadPct = midpoint ? ((ask - bid) / midpoint) * 100 : null;
  if (Number.isFinite(spreadPct) && spreadPct > 1) flags.push('wide_spread');
  if (Number.isFinite(price) && price > 0 && midpoint && spreadPct >= 0) {
    const distanceFromBookPct = Math.abs(price - midpoint) / midpoint * 100;
    if (distanceFromBookPct > Math.max(0.5, spreadPct * 5)) flags.push('last_outside_book');
  }

  const previousTime = Number(previous?.eventTime);
  const previousPrice = Number(previous?.price);
  if (Number.isFinite(price) && price > 0 && previousPrice > 0 && eventTime > previousTime) {
    const elapsed = eventTime - previousTime;
    const jumpPct = ((price / previousPrice) - 1) * 100;
    if (elapsed <= 3_000 && Math.abs(jumpPct) >= 5) flags.push('extreme_jump');
  }
  if (!Number.isFinite(quoteVolume) || quoteVolume < 0) flags.push('invalid_volume');

  const hasValidationError = flags.some(flag => VALIDATION_FLAGS.has(flag));
  const hasWarning = flags.length > 0;
  return {
    symbol: String(tick?.s || '').toUpperCase(),
    price: Number.isFinite(price) && price > 0 ? price : null,
    bid: Number.isFinite(bid) && bid > 0 ? bid : null,
    ask: Number.isFinite(ask) && ask > 0 ? ask : null,
    spreadPct: Number.isFinite(spreadPct) && spreadPct >= 0 ? spreadPct : null,
    changePct24h: Number.isFinite(Number(tick?.P)) ? Number(tick.P) : null,
    quoteVolume24h: Number.isFinite(quoteVolume) && quoteVolume >= 0 ? quoteVolume : null,
    eventTime: Number.isFinite(eventTime) ? eventTime : now,
    receivedAt: now,
    quality: hasValidationError ? 'error' : hasWarning ? 'warning' : 'ok',
    flags
  };
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

export function detectPricePatterns(history = []) {
  const prices = history.map(point => Number(point.price)).filter(price => Number.isFinite(price) && price > 0);
  const patterns = [];
  if (prices.length < 6) return { patterns, sampleCount: prices.length, ready: false };

  const recent = prices.at(-1);
  const fiveSecondReference = prices[Math.max(0, prices.length - 6)];
  const shortReturnPct = fiveSecondReference ? (recent / fiveSecondReference - 1) * 100 : 0;
  if (shortReturnPct >= 0.15) patterns.push({ key: 'momentum_up', strength: Math.min(99, Math.round(55 + shortReturnPct * 18)), valuePct: shortReturnPct });
  if (shortReturnPct <= -0.15) patterns.push({ key: 'momentum_down', strength: Math.min(99, Math.round(55 + Math.abs(shortReturnPct) * 18)), valuePct: shortReturnPct });

  if (prices.length >= 21) {
    const fast = average(prices.slice(-9));
    const slow = average(prices.slice(-21));
    const spread = (fast / slow - 1) * 100;
    if (spread >= 0.03) patterns.push({ key: 'short_trend_up', strength: Math.min(95, Math.round(55 + spread * 30)), valuePct: spread });
    if (spread <= -0.03) patterns.push({ key: 'short_trend_down', strength: Math.min(95, Math.round(55 + Math.abs(spread) * 30)), valuePct: spread });
  }

  if (prices.length >= 31) {
    const priorRange = prices.slice(-31, -1);
    const priorHigh = Math.max(...priorRange);
    const priorLow = Math.min(...priorRange);
    if (recent > priorHigh * 1.0005) patterns.push({ key: 'range_breakout_up', strength: 68, valuePct: (recent / priorHigh - 1) * 100 });
    if (recent < priorLow * 0.9995) patterns.push({ key: 'range_breakout_down', strength: 68, valuePct: (recent / priorLow - 1) * 100 });
  }
  return { patterns, sampleCount: prices.length, ready: prices.length >= 21 };
}

export function qualityFlagIsBlocking(flag) {
  return VALIDATION_FLAGS.has(flag);
}
