'use strict';

/* SPX Gamma 曝險區塊。
 *
 * lightweight-charts 的橫軸是時間軸，但下面兩張圖的橫軸是「履約價」。做法是把
 * 履約價單調映射成時間戳（每 5 點 = 1 天），再用 tickMarkFormatter 與
 * timeFormatter 把標籤顯示回履約價。這樣十字準線、軸標籤都能直接用。
 */
(() => {
  const LWC = LightweightCharts;
  const DAY = 86400;
  const BASE = 1_000_000_000;   // 任意的時間錨點，只要讓時間戳為正
  const STRIKE_STEP = 5;
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  /* 造市商持倉無法觀察。這裡只讓你看結論對假設有多敏感 —— 權重是任意的，
     所以畫面上報的是「區間」而不是單一數字。 */
  const SCENARIOS = [
    { key: 'A', label: 'A 標準', wc: 1, wp: -1, color: '#2563eb', width: 2, on: true },
    { key: 'B', label: 'B 反向', wc: -1, wp: 1, color: '#2563eb', width: 1, on: true, dashed: true },
    { key: 'E', label: 'E 空Put減半', wc: 1, wp: -0.5, color: '#7c3aed', width: 2, on: true },
    { key: 'F', label: 'F 多Call減半', wc: 0.5, wp: -1, color: '#0891b2', width: 2, on: true },
    { key: 'C', label: 'C 空Call空Put', wc: -1, wp: -1, color: '#ea580c', width: 1, on: false },
    { key: 'D', label: 'D 多Call多Put', wc: 1, wp: 1, color: '#16a34a', width: 1, on: false },
  ];

  const state = { data: null, bucket: '30d', charts: [], visible: new Set(SCENARIOS.filter((s) => s.on).map((s) => s.key)) };

  const strikeToTime = (strike) => BASE + Math.round(strike / STRIKE_STEP) * DAY;
  const timeToStrike = (time) => Math.round((time - BASE) / DAY) * STRIKE_STEP;

  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
      border: v('--border'), text: v('--text'), muted: v('--muted'),
      panel: v('--panel-2'), up: v('--up'), down: v('--down'),
    };
  }

  function baseOptions(p, extra = {}) {
    return Object.assign({
      autoSize: true,
      layout: {
        background: { type: LWC.ColorType.Solid, color: 'rgba(0,0,0,0)' },
        textColor: p.muted, fontSize: 10, fontFamily: MONO,
      },
      grid: {
        vertLines: { color: p.border },
        horzLines: { color: p.border },
      },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: p.muted, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: p.text },
        horzLine: { color: p.muted, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: p.text },
      },
      /* 這一頁是拿來捲動的，圖表不能搶走滾輪 */
      handleScroll: false,
      handleScale: false,
    }, extra);
  }

  /* 圖表建立時 autoSize 還沒排好版，此時指定範圍會被覆蓋掉（範圍變成錯的，
     K 棒細到看不見），所以尺寸一變就重設一次。
     另外，分頁若是在背景開啟，ResizeObserver 的回呼不會執行（它跟
     requestAnimationFrame 一樣屬於渲染階段），圖表會停在沒尺寸的狀態，
     因此分頁一變成可見就再套一次。 */
  const fitters = [];

  function dropFitter(chart) {
    for (let i = fitters.length - 1; i >= 0; i -= 1) {
      if (fitters[i].chart === chart) fitters.splice(i, 1);
    }
  }

  function refitAll() {
    for (const { chart, count } of fitters) {
      try {
        chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: count - 0.5 });
      } catch (err) {
        /* 圖表已經被換掉 */
      }
    }
  }

  function fitAll(chart, count) {
    const apply = () => chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: count - 0.5 });
    apply();
    chart.timeScale().subscribeSizeChange(apply);
    fitters.push({ chart, count });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestAnimationFrame(refitAll);
  });

  const strikeTickFormatter = (time) => String(timeToStrike(time));

  /* ---------- 各履約價 GEX ---------- */

  function buildStrikeChart(el, panel, spot, p) {
    const chart = LWC.createChart(el, baseOptions(p, {
      localization: { timeFormatter: strikeTickFormatter },
      timeScale: {
        borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: strikeTickFormatter,
      },
    }));

    const data = panel.strikes;

    const callSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
      base: 0,
    });
    callSeries.setData(data.map(([k, call]) => ({ time: strikeToTime(k), value: call, color: p.up })));

    const putSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
      base: 0,
    });
    putSeries.setData(data.map(([k, , put]) => ({ time: strikeToTime(k), value: put, color: p.down })));

    const netSeries = chart.addSeries(LWC.LineSeries, {
      color: p.text, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    netSeries.setData(data.map(([k, , , net]) => ({ time: strikeToTime(k), value: net })));

    LWC.createSeriesMarkers(netSeries, [{
      time: strikeToTime(Math.round(spot / STRIKE_STEP) * STRIKE_STEP),
      position: 'aboveBar', color: p.text, shape: 'arrowDown', text: '現價',
    }]);

    fitAll(chart, data.length);
    return chart;
  }

  /* ---------- 淨 GEX 曲線 ---------- */

  function curveValue(curve, i, wc, wp) {
    return wc * curve.call[i] + wp * curve.put[i];
  }

  function crossings(net, prices) {
    const out = [];
    for (let i = 1; i < net.length; i += 1) {
      if (net[i - 1] === 0) continue;
      if (net[i - 1] * net[i] < 0) {
        const span = net[i] - net[i - 1];
        out.push(prices[i] - net[i] * (prices[i] - prices[i - 1]) / span);
      }
    }
    return out;
  }

  function buildCurveChart(el, p) {
    const { prices, ...byBucket } = state.data.curve;
    const curve = byBucket[state.bucket];
    const spot = state.data.snapshot.spot;

    const chart = LWC.createChart(el, baseOptions(p, {
      timeScale: {
        borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true, timeVisible: false,
      },
    }));

    /* 橫軸一樣是「假設價格」，只是這裡本來就是價格，所以不需要轉換 */
    const series = new Map();
    for (const s of SCENARIOS) {
      const line = chart.addSeries(LWC.LineSeries, {
        color: s.color, lineWidth: s.width,
        lineStyle: s.dashed ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        visible: state.visible.has(s.key),
      });
      line.setData(prices.map((price, i) => ({ time: BASE + i * DAY, value: curveValue(curve, i, s.wc, s.wp) })));
      line.createPriceLine({ price: 0, color: p.muted, lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: false, title: '' });
      series.set(s.key, line);
    }

    /* 標準假設的 Flip 位置標出來，省去用眼睛找穿零點 */
    const standard = SCENARIOS[0];
    const net = prices.map((_, i) => curveValue(curve, i, standard.wc, standard.wp));
    const marks = crossings(net, prices).map((price) => {
      const idx = Math.max(0, Math.min(prices.length - 1, Math.round((price - prices[0]) / (prices[1] - prices[0]))));
      return { time: BASE + idx * DAY, position: 'belowBar', color: standard.color, shape: 'circle', text: `Flip ${Math.round(price).toLocaleString()}` };
    });
    LWC.createSeriesMarkers(series.get('A'), [...marks, {
      time: BASE + Math.round((spot - prices[0]) / (prices[1] - prices[0])) * DAY,
      position: 'aboveBar', color: p.text, shape: 'arrowDown', text: `現價 ${spot.toFixed(0)}`,
    }]);

    fitAll(chart, prices.length);

    /* 橫軸刻度要顯示價格，不是日期 */
    chart.timeScale().applyOptions({
      tickMarkFormatter: (time) => Math.round(prices[0] + ((time - BASE) / DAY) * (prices[1] - prices[0])).toLocaleString(),
    });
    chart.applyOptions({
      localization: {
        timeFormatter: (time) => Math.round(prices[0] + ((time - BASE) / DAY) * (prices[1] - prices[0])).toLocaleString(),
      },
    });

    return { chart, series };
  }

  /* ---------- 統計磚 ---------- */

  function tile(label, value, extra, cls) {
    return `<div class="stat"><span class="k">${label}</span>`
      + `<span class="v${cls ? ' ' + cls : ''}">${value}${extra ? ` <small>${extra}</small>` : ''}</span></div>`;
  }

  function renderStats() {
    const { metrics, snapshot, session, updated } = state.data;
    const m = metrics.buckets;
    const fmt = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString());
    const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}B`;

    const flips = Object.values(metrics.flipStandard).filter((v) => v !== null);
    const flipLow = Math.min(...flips);
    const flipHigh = Math.max(...flips);
    const sigmas = Object.values(metrics.sigmaDistance);

    const sec = m['30d'];
    const all = m.all;
    const tiles = [
      tile('現價', snapshot.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        `iv30 ${snapshot.iv30}%`, null),
      tile('Gamma Flip（標準假設）', flips.length > 1 ? `${fmt(flipLow)} – ${fmt(flipHigh)}` : fmt(flips[0]),
        sigmas.length ? `現價高於 ${Math.min(...sigmas).toFixed(1)}–${Math.max(...sigmas).toFixed(1)}σ` : '', null),
      tile('淨 GEX · 30天內', signed(sec.netGex.A), '十億美元 / 1%', sec.netGex.A > 0 ? 'up' : 'down'),
      tile('淨 GEX · 全部', signed(all.netGex.A), '十億美元 / 1%', all.netGex.A > 0 ? 'up' : 'down'),
      tile('Call Wall（價外）', sec.callWall ? fmt(sec.callWall[0]) : '—', sec.callWall ? `${sec.callWall[1].toFixed(1)}B` : '', null),
      tile('Put Wall（價外）', sec.putWall ? fmt(sec.putWall[0]) : '—', sec.putWall ? `${sec.putWall[1].toFixed(1)}B` : '', null),
      tile('Gamma 集中度', `${(sec.concentration.topShare * 100).toFixed(0)}%`,
        `前5大履約價占 30天內 |GEX|`, null),
      tile('扣掉前5大後的 Flip', fmt(sec.flipExTop5.A),
        `原為 ${fmt(sec.flip.A)}`, null),
    ];

    const box = document.getElementById('gexStats');
    box.innerHTML = tiles.join('');

    const top = sec.concentration.strikes.slice(0, 3)
      .map(([k, v]) => `${Math.round(k).toLocaleString()} (${v.toFixed(1)}B)`).join('、');

    document.getElementById('gexNote').innerHTML =
      `<b>怎麼讀：</b>造市商持倉無法觀察，整張圖都建立在假設上 —— 切換情境鈕看的是<b>範圍</b>，不是哪一條才對。`
      + `標準假設下 30 天內的 Gamma Flip 是 ${fmt(sec.flip.A)}，現價只高出 ${Math.max(...sigmas).toFixed(1)} 個單日標準差（1σ ≈ ${session.sigma1d} 點），`
      + `意思是<b>一個普通交易日的跌幅就會把它跌破</b>，「在正 Gamma 區所以波動被壓抑」這個說法並不牢靠。`
      + `30 天內 |GEX| 有 ${(sec.concentration.topShare * 100).toFixed(0)}% 集中在 5 個履約價上（${top}），`
      + `但扣掉這 5 個之後 Flip 只移動 ${Math.abs(sec.flipExTop5.A - sec.flip.A).toFixed(0)} 點，所以位置本身是穩的。`
      + `<br><b>限制：</b>未平倉量是前一交易日結算的數字，不含盤中新增的部位；情境的權重是任意的；`
      + `沒有回測，所以無法證明這些價位過去有預測力。資料為 ${snapshot.timestamp} 的快照，計算基準 ${session.valuation} 開盤。`
      + `這<b>不是買賣建議</b>。`;

    document.getElementById('gexSub').textContent =
      `${snapshot.contracts.toLocaleString()} / ${snapshot.contractsTotal.toLocaleString()} 個合約有 OI 與 IV`
      + ` · 基準 ${session.valuation} 開盤 · 月選到期 ${session.opex}`
      + ` · carry ${(session.carry * 100).toFixed(2)}%`;
  }

  /* ---------- 控件 ---------- */

  function renderScenarioControls() {
    const host = document.getElementById('gexScenarios');
    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.dataset.key = s.key;
      btn.className = state.visible.has(s.key) ? 'on' : '';
      btn.innerHTML = `<span class="scenario-key" style="background:${s.color}"></span>${s.label}`;
      btn.addEventListener('click', () => {
        if (state.visible.has(s.key)) state.visible.delete(s.key);
        else state.visible.add(s.key);
        btn.classList.toggle('on');
        for (const [key, series] of state.curveSeries) {
          series.applyOptions({ visible: state.visible.has(key) });
        }
      });
      host.append(btn);
    }
  }

  function rebuildCurve() {
    if (state.curveChart) {
      dropFitter(state.curveChart);
      state.curveChart.remove();
    }
    const el = document.getElementById('gexCurve');
    const built = buildCurveChart(el, palette());
    state.curveChart = built.chart;
    state.curveSeries = built.series;
  }

  function renderBucketControls() {
    for (const btn of document.querySelectorAll('#gexBucket button')) {
      btn.classList.toggle('on', btn.dataset.bucket === state.bucket);
      btn.addEventListener('click', () => {
        state.bucket = btn.dataset.bucket;
        for (const other of document.querySelectorAll('#gexBucket button')) {
          other.classList.toggle('on', other.dataset.bucket === state.bucket);
        }
        rebuildCurve();
      });
    }
  }

  /* ---------- 主題 ---------- */

  function applyTheme() {
    if (!state.data) return;
    /* 只有三張圖，直接重畫比逐一改選項簡單也不會漏掉綁在資料上的顏色 */
    fitters.length = 0;   // 三張圖都會重建，舊的登記一併清掉
    for (const chart of state.charts) chart.remove();
    if (state.curveChart) {
      state.curveChart.remove();
      state.curveChart = null;
    }
    const p = palette();
    state.charts = [
      buildStrikeChart(document.getElementById('gexStrikes30d'), state.data.panels['30d'], state.data.snapshot.spot, p),
      buildStrikeChart(document.getElementById('gexStrikesAll'), state.data.panels.all, state.data.snapshot.spot, p),
    ];
    rebuildCurve();
  }

  /* ---------- 啟動 ---------- */

  async function boot() {
    let data;
    try {
      const res = await fetch('data/gex.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (err) {
      return;   // 沒有 GEX 資料就整塊不顯示，股票清單照常運作
    }
    if (!data.ok || !data.metrics) return;

    state.data = data;
    const p = palette();

    renderStats();
    renderScenarioControls();
    renderBucketControls();

    state.charts = [
      buildStrikeChart(document.getElementById('gexStrikes30d'), data.panels['30d'], data.snapshot.spot, p),
      buildStrikeChart(document.getElementById('gexStrikesAll'), data.panels.all, data.snapshot.spot, p),
    ];
    rebuildCurve();

    document.getElementById('gex').hidden = false;
    document.addEventListener('themechange', applyTheme);
  }

  boot();
})();
