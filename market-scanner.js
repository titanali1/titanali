(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const pageSize = 25;
  $('.line-path')?.setAttribute('d', '');
  $('.area-path')?.setAttribute('d', '');
  $('.price-chart circle')?.setAttribute('opacity', '0');
  const numberFormat = new Intl.NumberFormat('fa-IR', { maximumSignificantDigits: 10 });
  const percentFormat = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 2, signDisplay: 'always' });
  const translations = {
    momentum_up: 'شتاب صعودی کوتاه', momentum_down: 'شتاب نزولی کوتاه',
    short_trend_up: 'روند کوتاه رو به بالا', short_trend_down: 'روند کوتاه رو به پایین',
    range_breakout_up: 'شکست سقف بازه', range_breakout_down: 'شکست کف بازه'
  };
  const qualityLabels = {
    invalid_price: 'قیمت نامعتبر', invalid_book: 'دفتر سفارش ناقص', invalid_timestamp: 'زمان نامعتبر', crossed_book: 'دفتر سفارش متقاطع',
    stale_tick: 'دادهٔ کهنه', future_tick: 'زمان غیرعادی', wide_spread: 'اسپرد گسترده',
    last_outside_book: 'آخرین قیمت خارج از دفتر', extreme_jump: 'جهش غیرعادی قیمت', invalid_volume: 'حجم نامعتبر'
  };
  let currentSnapshot = null;
  let currentPage = 0;
  let query = '';
  let lastStatus = 'connecting';

  function fmt(value, maxFraction = 8) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    return new Intl.NumberFormat('fa-IR', { maximumFractionDigits: maxFraction, maximumSignificantDigits: 10 }).format(n);
  }
  function tickerAge(ageMs) {
    if (!Number.isFinite(ageMs)) return 'هنوز تیکی نرسیده';
    if (ageMs < 1_000) return 'همین حالا';
    return `${fmt(ageMs / 1_000, 1)} ثانیه پیش`;
  }
  function hasUsableLivePrice(market) {
    return Boolean(market && ['connected', 'degraded'].includes(lastStatus) && typeof market.price === 'number' && Number.isFinite(market.price) && market.price > 0 && Number.isFinite(market.ageMs) && market.ageMs <= 5_000 && market.quality !== 'error');
  }
  function setFeedStatus(status, message) {
    lastStatus = status;
    const live = $('#scannerLiveState');
    const top = $('#marketFeedStatus');
    const connected = status === 'connected';
    const isError = ['offline', 'reconnecting', 'busy', 'disabled'].includes(status);
    const css = connected ? 'is-live' : isError ? 'is-error' : 'is-connecting';
    const label = connected ? 'اتصال زنده' : status === 'disabled' ? 'خاموش' : status === 'offline' || status === 'reconnecting' ? 'قطع / تلاش مجدد' : status === 'busy' ? 'ظرفیت پر' : status === 'degraded' ? 'اتصال ناپایدار' : 'در حال اتصال';
    live.classList.remove('is-live', 'is-error', 'is-connecting');
    live.classList.add(css);
    live.innerHTML = `<i></i> ${label}`;
    top.classList.remove('is-live', 'is-error', 'is-connecting');
    top.classList.add(css);
    top.innerHTML = `<i></i> ${connected ? 'Binance زنده' : isError ? 'Binance در دسترس نیست' : 'در حال اتصال به Binance…'}`;
    if (message) $('#scannerConnectionNote').textContent = message;
    if (isError) hideLiveValues();
  }

  function hideLiveValues() {
    $('#scannerBtcPrice').textContent = '—';
    $('#scannerBtcMeta').textContent = 'دادهٔ زنده پنهان شد تا اتصال برقرار شود';
    $('#scannedMarketsCount').textContent = `۰ / ${fmt(currentSnapshot?.marketCount || 0, 0)}`;
    $('#priceAnomalyCount').textContent = '—';
    updateChart(null);
    $('#chartSync').textContent = 'اتصال زنده قطع است؛ قیمت قدیمی به‌عنوان قیمت زنده نمایش داده نمی‌شود.';
    drawBtcChart([]);
    updatePattern(null);
    $$('.market-row[data-asset]').forEach(row => {
      if (row.dataset.asset === 'gold') return;
      row.children[1].textContent = '—';
      row.children[2].textContent = 'داده قطع';
      row.children[2].className = 'change live-flat';
    });
    $$('#liveMarketRows tr').forEach(row => {
      const price = $('.scanner-price', row); if (price) price.textContent = '—';
      const change = $('.scanner-change', row); if (change) change.textContent = '—';
      const pattern = $('.scanner-pattern', row); if (pattern) pattern.textContent = 'در انتظار داده';
      const quality = $('.quality-badge', row);
      if (quality) { quality.className = 'quality-badge pending'; quality.innerHTML = '<i></i>در انتظار تیک'; }
    });
  }

  function qualityCell(market) {
    const flags = market.flags || [];
    const state = market.quality || 'pending';
    if (state === 'pending') return '<span class="quality-badge pending"><i></i>در انتظار تیک</span>';
    if (!flags.length) return '<span class="quality-badge ok"><i></i>ساختار معتبر</span>';
    const label = state === 'error' ? 'دادهٔ مشکوک' : 'بررسی لازم';
    const title = flags.map(flag => qualityLabels[flag] || flag).join(' · ');
    return `<span class="quality-badge ${state === 'error' ? 'error' : 'warning'}" title="${title}"><i></i>${label} · ${fmt(flags.length, 0)}</span>`;
  }

  function patternCell(market) {
    const patterns = market.patterns || [];
    if (!market.patternReady) return `<span class="scanner-pattern neutral" title="${fmt(market.patternSamples || 0, 0)} تیک از حداقل ۲۱ تیک">در حال جمع‌آوری تاریخچه</span>`;
    if (!patterns.length) return '<span class="scanner-pattern neutral">الگوی برجسته‌ای نیست</span>';
    const pattern = [...patterns].sort((a, b) => b.strength - a.strength)[0];
    const direction = pattern.key.endsWith('_up') ? 'up' : pattern.key.endsWith('_down') ? 'down' : 'neutral';
    return `<span class="scanner-pattern ${direction}" title="قدرت قاعده ${fmt(pattern.strength, 0)}٪">${translations[pattern.key] || 'الگوی تکنیکال'}</span>`;
  }

  function renderRows() {
    if (!currentSnapshot) return;
    const rows = (currentSnapshot.markets || []).filter(market => /^[A-Z0-9]{2,24}$/.test(String(market.symbol || '')) && (!query || market.symbol.toLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    currentPage = Math.min(currentPage, pages - 1);
    const start = currentPage * pageSize;
    const visible = rows.slice(start, start + pageSize);
    const liveUnavailable = !['connected', 'degraded'].includes(lastStatus);
    $('#scannerPageLabel').textContent = `${fmt(rows.length ? start + 1 : 0, 0)}–${fmt(Math.min(start + pageSize, rows.length), 0)} / ${fmt(rows.length, 0)}`;
    $('#scannerPrev').disabled = currentPage <= 0;
    $('#scannerNext').disabled = currentPage >= pages - 1;
    const body = $('#liveMarketRows');
    if (!visible.length) {
      body.innerHTML = '<tr><td colspan="7" class="scanner-empty">بازاری با این نماد پیدا نشد.</td></tr>';
      return;
    }
    body.innerHTML = visible.map((market, offset) => {
      const symbol = String(market.symbol || '');
      const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
      const change = Number(market.changePct24h);
      const changeClass = !Number.isFinite(change) ? 'flat' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
      const price = liveUnavailable ? '—' : fmt(market.price);
      const changeValue = liveUnavailable ? '—' : Number.isFinite(change) ? `${percentFormat.format(change)}٪` : '—';
      const pattern = liveUnavailable ? '<span class="scanner-pattern neutral">در انتظار داده</span>' : patternCell(market);
      const quality = liveUnavailable ? '<span class="quality-badge pending"><i></i>در انتظار تیک</span>' : qualityCell(market);
      return `<tr data-symbol="${symbol}"><td>${fmt(start + offset + 1, 0)}</td><td><span class="scanner-market"><b>${base}</b><small>/ USDT</small></span></td><td class="scanner-price">${price}</td><td class="scanner-change ${liveUnavailable ? 'flat' : changeClass}">${changeValue}</td><td class="scanner-spread">${liveUnavailable ? '—' : Number.isFinite(Number(market.spreadPct)) ? `${fmt(market.spreadPct, 3)}٪` : '—'}</td><td>${pattern}</td><td>${quality}</td></tr>`;
    }).join('');
  }

  function updateChart(market) {
    const priceNode = $('#chartPrice');
    const changeNode = $('#chartChange');
    const syncNode = $('#chartSync');
    if (!hasUsableLivePrice(market)) {
      priceNode.textContent = '—';
      changeNode.textContent = '—';
      changeNode.className = 'change';
      syncNode.textContent = market ? `قیمت زنده پنهان شد · تیک ${tickerAge(market.ageMs)} یا مشکوک است` : 'برای این نماد تیک زنده دریافت نشده است';
      syncNode.classList.add('chart-sync-stale');
      $('.line-path')?.setAttribute('d', '');
      $('.area-path')?.setAttribute('d', '');
      $('.price-chart circle')?.setAttribute('opacity', '0');
      return;
    }
    priceNode.textContent = fmt(market.price);
    const change = Number(market.changePct24h);
    changeNode.textContent = Number.isFinite(change) ? `${percentFormat.format(change)}٪` : '—';
    changeNode.className = `change ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`;
    syncNode.textContent = `آخرین تیک Binance · ${tickerAge(market.ageMs)}`;
    syncNode.classList.toggle('chart-sync-stale', market.ageMs > 3_000);
  }

  function drawBtcChart(history = []) {
    const line = $('.line-path');
    const area = $('.area-path');
    const marker = $('.price-chart circle');
    if (!line || !area || history.length < 2) {
      line?.setAttribute('d', ''); area?.setAttribute('d', ''); marker?.setAttribute('opacity', '0');
      $$('.chart-y-labels span').forEach(node => { node.textContent = '—'; });
      return;
    }
    const values = history.map(point => Number(point.price)).filter(value => Number.isFinite(value) && value > 0);
    if (values.length < 2) return;
    const low = Math.min(...values); const high = Math.max(...values);
    const spread = Math.max(high - low, high * 0.0001);
    const coords = values.map((value, index) => ({
      x: index * 760 / (values.length - 1),
      y: 190 - ((value - low) / spread) * 160
    }));
    const linePath = coords.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');
    line.setAttribute('d', linePath);
    area.setAttribute('d', `${linePath} L760 220 L0 220 Z`);
    marker?.setAttribute('cx', coords.at(-1).x.toFixed(1));
    marker?.setAttribute('cy', coords.at(-1).y.toFixed(1));
    marker?.setAttribute('opacity', '1');
    const labels = $$('.chart-y-labels span');
    labels.forEach((node, index) => {
      const value = high - (high - low) * index / Math.max(labels.length - 1, 1);
      node.textContent = fmt(value, 2);
    });
  }

  function updatePattern(btc) {
    if (!hasUsableLivePrice(btc)) {
      $('#patternState').innerHTML = '<i></i> در انتظار';
      $('#patternLabel').textContent = 'تحلیل زنده موقتاً پنهان است';
      $('#patternDetail').textContent = btc ? `تیک BTC ${tickerAge(btc.ageMs)} یا مشکوک است؛ برای جلوگیری از نمایش تحلیل قدیمی منتظر دادهٔ معتبر می‌مانیم.` : 'اتصال سرور به Binance برقرار نشده است.';
      $('#patternStrength').innerHTML = '—<small></small>';
      $('#patternGauge')?.setAttribute('stroke-dasharray', '0 157');
      $('#patternInsight').textContent = 'پس از دریافت تیک تازه و معتبر، تحلیل قاعده‌محور دوباره نمایش داده می‌شود.';
      return;
    }
    const patterns = btc.patterns || [];
    const strongest = [...patterns].sort((a, b) => b.strength - a.strength)[0];
    $('#patternState').innerHTML = btc.patternReady ? '<i></i> در حال پایش' : '<i></i> گرم‌شدن';
    if (!strongest) {
      $('#patternLabel').textContent = btc.patternReady ? 'الگوی برجسته‌ای نیست' : 'در حال جمع‌آوری تاریخچه';
      $('#patternDetail').textContent = `${fmt(btc.patternSamples, 0)} تیک زنده دریافت شد؛ برای روند کوتاه حداقل ۲۱ نمونه لازم است.`;
      $('#patternStrength').innerHTML = '—<small></small>';
      $('#patternGauge')?.setAttribute('stroke-dasharray', '0 157');
      $('#patternInsight').textContent = 'قواعد مومنتوم، میانگین متحرک و شکست بازه بررسی می‌شوند؛ از یک الگو به‌تنهایی برای معامله استفاده نکن.';
      return;
    }
    const label = translations[strongest.key] || 'الگوی تکنیکال';
    const trend = strongest.key.endsWith('_up') ? 'حرکت مثبت' : 'حرکت منفی';
    $('#patternLabel').textContent = label;
    $('#patternDetail').textContent = `${trend} · تغییر محاسباتی ${percentFormat.format(strongest.valuePct || 0)}٪`;
    $('#patternStrength').innerHTML = `${fmt(strongest.strength, 0)}<small>٪</small>`;
    $('#patternGauge')?.setAttribute('stroke-dasharray', `${Math.round(157 * strongest.strength / 100)} 157`);
    $('#patternInsight').textContent = `از ${fmt(btc.patternSamples, 0)} تیک یک‌ثانیه‌ای BTC استفاده شده؛ این تشخیص قاعده‌محور است، نه پیش‌بینی قطعی یا توصیهٔ مالی.`;
  }

  function updatePopularRows(markets) {
    const bySymbol = new Map(markets.map(market => [market.symbol, market]));
    const aliases = { btc: 'BTCUSDT', eth: 'ETHUSDT', sol: 'SOLUSDT' };
    $$('.market-row[data-asset]').forEach(row => {
      const market = bySymbol.get(aliases[row.dataset.asset]);
      const priceCell = row.children[1];
      const changeCell = row.children[2];
      if (!market) {
        if (row.dataset.asset === 'gold') {
          priceCell.textContent = '—';
          changeCell.textContent = 'در Binance نیست';
          changeCell.className = 'change live-flat';
        }
        return;
      }
      if (!hasUsableLivePrice(market)) {
        priceCell.textContent = '—';
        changeCell.textContent = 'تیک کهنه/مشکوک';
        changeCell.className = 'change live-flat';
        return;
      }
      priceCell.textContent = fmt(market.price);
      priceCell.classList.add('live-price');
      const change = Number(market.changePct24h);
      changeCell.textContent = Number.isFinite(change) ? `${percentFormat.format(change)}٪` : '—';
      changeCell.className = `change ${change > 0 ? 'positive live-up' : change < 0 ? 'negative live-down' : 'live-flat'}`;
    });
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    currentSnapshot = snapshot;
    if (snapshot.status) setFeedStatus(snapshot.status, snapshot.message);
    const markets = snapshot.markets || [];
    const freshCount = markets.filter(hasUsableLivePrice).length;
    $('#scannedMarketsCount').textContent = `${fmt(freshCount, 0)} / ${fmt(snapshot.marketCount || 0, 0)}`;
    $('#priceAnomalyCount').textContent = ['connected', 'degraded'].includes(lastStatus) ? fmt(snapshot.anomalyCount || 0, 0) : '—';
    $('#lastSyncTime').textContent = snapshot.syncedAt ? `آخرین دریافت ${new Date(snapshot.syncedAt).toLocaleTimeString('fa-IR')}` : 'بدون تیک تازه';
    const btc = snapshot.btc;
    $('#scannerBtcPrice').textContent = hasUsableLivePrice(btc) ? `${fmt(btc.price)} USDT` : '—';
    $('#scannerBtcMeta').textContent = hasUsableLivePrice(btc) ? `BTCUSDT · ${tickerAge(btc.ageMs)}` : btc ? `قیمت پنهان شد · تیک ${tickerAge(btc.ageMs)} یا مشکوک است` : 'منتظر تیک Binance';
    const selectedPair = ($('#chartTicker')?.textContent || 'BTC / USDT').replaceAll(' ', '').replace('/', '').toUpperCase();
    const selectedMarket = markets.find(market => market.symbol === selectedPair) || (selectedPair === 'BTCUSDT' ? btc : null);
    updateChart(selectedMarket);
    drawBtcChart(selectedPair === 'BTCUSDT' && hasUsableLivePrice(btc) ? (btc.history || []) : []);
    updatePattern(btc);
    updatePopularRows(markets);
    renderRows();
  }

  $('#scannerSearch')?.addEventListener('input', event => { query = event.target.value.trim().toLowerCase(); currentPage = 0; renderRows(); });
  $('#scannerPrev')?.addEventListener('click', () => { currentPage = Math.max(0, currentPage - 1); renderRows(); });
  $('#scannerNext')?.addEventListener('click', () => { currentPage += 1; renderRows(); });

  // Existing chart controls can select a non-BTC pair; refresh the value from the live scanner after their handlers run.
  document.addEventListener('click', event => {
    if (event.target.closest('#assetPicker, .market-row')) setTimeout(() => { if (currentSnapshot) applySnapshot(currentSnapshot); }, 0);
  });
  if ($('#openAiAnalysis')) $('#openAiAnalysis').onclick = () => window.showToast?.('الگوها از دادهٔ Binance محاسبه می‌شوند؛ تا ۲۱ تیک برای تحلیل روند کوتاه لازم است.');

  async function initialSnapshot() {
    try {
      const response = await fetch('/api/market/scanner', { cache: 'no-store' });
      if (response.ok) applySnapshot(await response.json());
    } catch { /* SSE supplies the connection state when the stream opens. */ }
  }

  initialSnapshot();
  if ('EventSource' in window) {
    const stream = new EventSource('/api/market/stream');
    stream.addEventListener('snapshot', event => {
      try { applySnapshot(JSON.parse(event.data)); } catch { /* discard malformed server frames */ }
    });
    stream.addEventListener('status', event => {
      try { const value = JSON.parse(event.data); setFeedStatus(value.status, value.message); } catch { /* ignore */ }
    });
    stream.onerror = () => {
      if (lastStatus !== 'disabled') setFeedStatus('reconnecting', 'ارتباط زنده قطع شده؛ مرورگر برای اتصال مجدد تلاش می‌کند.');
    };
  } else {
    setFeedStatus('offline', 'مرورگر این دستگاه از EventSource پشتیبانی نمی‌کند.');
  }

  window.XsayaLiveMarkets = {
    get(symbol) { return currentSnapshot?.markets?.find(market => market.symbol === String(symbol).replace('/', '').toUpperCase()) || null; },
    snapshot() { return currentSnapshot; }
  };
})();
