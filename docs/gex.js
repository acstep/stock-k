'use strict';

/* SPX Gamma 曝險區塊。
 *
 * lightweight-charts 的橫軸是時間軸，但下面兩張圖的橫軸是「履約價」。做法是把
 * 履約價單調映射成時間戳（每 5 點 = 1 天），再用 tickFormatter 把標籤顯示回履約價。
 *
 * 造市商持倉無法觀察，所以六種情境是「假設」。情境鈕是單選，選中的那一個會套用到
 * 整區 —— 兩張長條圖、數字磚、曲線圖全部跟著換，按下去馬上看得到差別。
 */
(() => {
  const LWC = LightweightCharts;
  const DAY = 86400;
  const BASE = 1_000_000_000;   // 任意的時間錨點，只要讓時間戳為正
  const STRIKE_STEP = 5;
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

  /* wc / wp 是 Call 與 Put 的權重，只有正負號有意義，倍數是任意的。
     資料裡的 call / put 是未加權的絕對值，權重在這裡才套上去。 */
  const SCENARIOS = [
    { key: 'A', label: 'A 標準', note: '造市商多 Call、空 Put', wc: 1, wp: -1, color: '#2563eb' },
    { key: 'B', label: 'B 反向', note: '造市商空 Call、多 Put', wc: -1, wp: 1, color: '#60a5fa' },
    { key: 'E', label: 'E 空Put減半', note: '多 Call、空 Put 減半', wc: 1, wp: -0.5, color: '#7c3aed' },
    { key: 'F', label: 'F 多Call減半', note: '多 Call 減半、空 Put', wc: 0.5, wp: -1, color: '#0891b2' },
    { key: 'C', label: 'C 兩邊都空', note: '空 Call + 空 Put', wc: -1, wp: -1, color: '#ea580c' },
    { key: 'D', label: 'D 兩邊都多', note: '多 Call + 多 Put', wc: 1, wp: 1, color: '#16a34a' },
  ];

  const state = {
    data: null, peers: null, backtest: null, bucket: '30d', scenario: 'A',
    range: { from: null, to: null },          // null = 用預設（現價 ±2.5%）
    charts: [], curveChart: null,
  };

  const strikeToTime = (strike) => BASE + Math.round(strike / STRIKE_STEP) * DAY;
  const timeToStrike = (time) => Math.round((time - BASE) / DAY) * STRIKE_STEP;
  const scenarioOf = (key) => SCENARIOS.find((s) => s.key === key) || SCENARIOS[0];
  const roundOr = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

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
      grid: { vertLines: { color: p.border }, horzLines: { color: p.border } },
      rightPriceScale: { borderColor: p.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: p.muted, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: p.text },
        horzLine: { color: p.muted, width: 1, style: LWC.LineStyle.Dotted, labelBackgroundColor: p.text },
      },
      handleScroll: false,   // 這一頁是拿來捲動的，圖表不能搶走滾輪
      handleScale: false,
    }, extra);
  }

  /* 圖表建立時 autoSize 還沒排好版，此時指定範圍會被覆蓋掉（範圍變成錯的，
     長條細到看不見），所以尺寸一變就重設。分頁若在背景開啟，ResizeObserver
     的回呼不會執行，圖表會停在沒尺寸的狀態，因此分頁一可見就再套一次。 */
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

  /* 履約價範圍。資料本身帶 ±12%，預設只顯示現價 ±2.5% —— 一年份的 GEX 幾乎都擠在
     現價附近，全畫出來旁邊那些沒數字的履約價只是把長條壓扁。 */
  function strikeBounds() {
    const all = state.data.panels['30d'].strikes;
    return { lo: all[0][0], hi: all[all.length - 1][0] };
  }

  function defaultRange() {
    const spot = state.data.snapshot.spot;
    const step = STRIKE_STEP;
    return {
      from: Math.round(spot * 0.975 / step) * step,
      to: Math.round(spot * 1.025 / step) * step,
    };
  }

  function strikeRange() {
    const { lo, hi } = strikeBounds();
    const fallback = defaultRange();
    const clamp = (v, d) => Math.max(lo, Math.min(hi, Math.round((v ?? d) / STRIKE_STEP) * STRIKE_STEP));
    const a = clamp(state.range.from, fallback.from);
    const b = clamp(state.range.to, fallback.to);
    return { from: Math.min(a, b), to: Math.max(a, b), lo, hi };
  }

  /* ---------- 各履約價 GEX ---------- */

  function buildStrikeChart(el, panel, spot, p, s) {
    const chart = LWC.createChart(el, baseOptions(p, {
      localization: { timeFormatter: strikeTickFormatter },
      timeScale: {
        borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: strikeTickFormatter,
      },
    }));

    const bounds = strikeRange();
    const data = panel.strikes.filter(([k]) => k >= bounds.from && k <= bounds.to);
    const colorOf = (value) => (value >= 0 ? p.up : p.down);
    const point = (k, value) => ({ time: strikeToTime(k), value, color: colorOf(value) });

    const callSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, base: 0,
    });
    callSeries.setData(data.map(([k, call]) => point(k, s.wc * call)));

    const putSeries = chart.addSeries(LWC.HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, base: 0,
    });
    putSeries.setData(data.map(([k, , put]) => point(k, s.wp * put)));

    const netSeries = chart.addSeries(LWC.LineSeries, {
      color: p.text, lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    netSeries.setData(data.map(([k, call, put]) => ({ time: strikeToTime(k), value: s.wc * call + s.wp * put })));

    LWC.createSeriesMarkers(netSeries, [{
      time: strikeToTime(Math.round(spot / STRIKE_STEP) * STRIKE_STEP),
      position: 'aboveBar', color: p.text, shape: 'arrowDown', text: '現價',
    }]);

    fitAll(chart, data.length);
    return chart;
  }

  /* ---------- 淨 GEX 曲線 ---------- */

  const netAt = (curve, i, s) => s.wc * curve.call[i] + s.wp * curve.put[i];

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
    const active = scenarioOf(state.scenario);

    const chart = LWC.createChart(el, baseOptions(p, {
      timeScale: { borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true, timeVisible: false },
    }));

    /* 橫軸本來就是價格，不需要轉換 */
    const priceFormatter = (time) =>
      Math.round(prices[0] + ((time - BASE) / DAY) * (prices[1] - prices[0])).toLocaleString();

    /* 六種情境全畫；選中的那一條加粗，其餘淡化當參考 */
    const lines = [];
    for (const s of SCENARIOS) {
      const on = s.key === active.key;
      const line = chart.addSeries(LWC.LineSeries, {
        color: on ? s.color : s.color + '80',
        lineWidth: on ? 2 : 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      line.setData(prices.map((price, i) => ({ time: BASE + i * DAY, value: netAt(curve, i, s) })));
      line.createPriceLine({
        price: 0, color: p.muted, lineWidth: 1, lineStyle: LWC.LineStyle.Solid,
        axisLabelVisible: false, title: '',
      });
      lines.push(line);
    }

    /* 把選中情境的穿零點標出來，省去用眼睛找 */
    const net = prices.map((_, i) => netAt(curve, i, active));
    const marks = crossings(net, prices).map((price) => {
      const idx = Math.max(0, Math.min(prices.length - 1, Math.round((price - prices[0]) / (prices[1] - prices[0]))));
      return { time: BASE + idx * DAY, position: 'belowBar', color: active.color, shape: 'circle',
               text: `Flip ${Math.round(price).toLocaleString()}` };
    });
    marks.push({
      time: BASE + Math.round((spot - prices[0]) / (prices[1] - prices[0])) * DAY,
      position: 'aboveBar', color: p.text, shape: 'arrowDown', text: `現價 ${spot.toFixed(0)}`,
    });
    LWC.createSeriesMarkers(lines[SCENARIOS.findIndex((x) => x.key === active.key)], marks);

    chart.applyOptions({
      localization: { timeFormatter: priceFormatter },
      timeScale: {
        borderColor: p.border, fixLeftEdge: true, lockVisibleTimeRangeOnResize: true, timeVisible: false,
        tickMarkFormatter: priceFormatter,
      },
    });

    fitAll(chart, prices.length);
    return chart;
  }

  /* ---------- 數字磚 ---------- */

  function tile(label, value, extra, cls) {
    return `<div class="stat"><span class="k">${label}</span>`
      + `<span class="v${cls ? ' ' + cls : ''}">${value}${extra ? ` <small>${extra}</small>` : ''}</span></div>`;
  }

  function renderStats() {
    const { metrics, snapshot, session } = state.data;
    const s = scenarioOf(state.scenario);
    const bucket = metrics.buckets[state.bucket];
    const fmt = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString());
    const signed = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}B`;

    const flip = bucket.flip[s.key];
    const flipTrim = bucket.flipExTop5[s.key];
    const sigma = flip === null ? null : (snapshot.spot - flip) / session.sigma1d;

    /* Wall 的位置與情境無關（取絕對值最大的履約價），只有正負號跟著權重走。
       Python 存的 put 值是負的（空 Put），所以換算時要再乘一次 wp。 */
    const callWall = bucket.callWall ? [bucket.callWall[0], s.wc * bucket.callWall[1]] : null;
    const putWall = bucket.putWall ? [bucket.putWall[0], -s.wp * bucket.putWall[1]] : null;

    document.getElementById('gexStats').innerHTML = [
      tile('套用情境', `${s.key}　${s.note.split('、')[0]}`, '', ''),
      tile('現價', snapshot.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        `iv30 ${snapshot.iv30}%　1σ ≈ ${session.sigma1d} 點`, ''),
      tile('Gamma Flip', fmt(flip),
        sigma === null ? '沒有穿零點' : `現價高於 ${sigma.toFixed(1)}σ`, ''),
      tile(`淨 GEX · ${bucket.title}`, signed(bucket.netGex[s.key]), '十億美元 / 1%',
        bucket.netGex[s.key] > 0 ? 'up' : 'down'),
      tile('Call Wall（價外）', callWall ? fmt(callWall[0]) : '—',
        callWall ? `${callWall[1].toFixed(1)}B` : '', ''),
      tile('Put Wall（價外）', putWall ? fmt(putWall[0]) : '—',
        putWall ? `${putWall[1].toFixed(1)}B` : '', ''),
      tile('扣掉前5大後的 Flip', fmt(flipTrim),
        flipTrim === null || flip === null ? '' : `原為 ${fmt(flip)}`, ''),
      tile('Gamma 集中度', `${(bucket.concentration.topShare * 100).toFixed(0)}%`,
        '前5大履約價占比', ''),
    ].join('');

    const top = bucket.concentration.strikes.slice(0, 3)
      .map(([k, v]) => `${Math.round(k).toLocaleString()} (${v.toFixed(1)}B)`).join('、');
    const dist = sigma === null ? '' :
      `，現價高出 ${Math.abs(sigma).toFixed(1)} 個單日標準差（1σ ≈ ${session.sigma1d} 點），`
      + `意思是<b>一個普通交易日的波動就能讓現價穿過它</b>，「正 Gamma 區所以波動被壓抑」這個說法並不牢靠。`;

    document.getElementById('gexNote').innerHTML =
      `<b>怎麼讀：</b>造市商持倉無法觀察，整張圖建立在假設上 —— 按上面的情境鈕切換，`
      + `看的是<b>不同假設下結論差多少</b>，而不是哪一條才對。`
      + `目前 <b>情境 ${s.key}（${s.note}）</b>下，${bucket.title}的 Gamma Flip `
      + (flip === null ? '不存在（淨 GEX 沒有穿過 0）' : `是 ${fmt(flip)}`) + dist
      + `30 天內 |GEX| 有 ${(metrics.buckets['30d'].concentration.topShare * 100).toFixed(0)}% 集中在 5 個履約價上（${top}），`
      + `但扣掉這 5 個之後 Flip 只移動 ${Math.abs(metrics.buckets['30d'].flipExTop5.A - metrics.buckets['30d'].flip.A).toFixed(0)} 點，所以位置本身是穩的。`
      + `<br><b>限制：</b>未平倉量是前一交易日結算的數字，不含盤中新增部位；情境的權重是任意的（只有正負號有意義）；`
      + `沒有回測，無法證明這些價位過去有預測力。快照 ${snapshot.timestamp}，計算基準 ${session.valuation} 開盤。`
      + `<b>這不是買賣建議。</b>`;

    document.getElementById('gexSub').textContent =
      `${snapshot.contracts.toLocaleString()} / ${snapshot.contractsTotal.toLocaleString()} 個合約有 OI 與 IV`
      + ` · 基準 ${session.valuation} 開盤 · 月選到期 ${session.opex} · carry ${(session.carry * 100).toFixed(2)}%`;
  }

  /* ---------- 外站參考 ---------- */

  function renderPeers() {
    const { metrics, session } = state.data;
    const s = scenarioOf(state.scenario);
    const bucket = metrics.buckets[state.bucket];

    const dash = '<span class="na">—</span>';
    const px = (v, d = 0) => (v === null || v === undefined ? dash
      : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
    const gex = (v) => (v === null || v === undefined ? dash : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}B`);

    /* Wall 的位置與情境無關，只有正負號跟著權重走（同 renderStats） */
    const callWall = bucket.callWall ? bucket.callWall[0] : null;
    const putWall = bucket.putWall ? bucket.putWall[0] : null;

    const rows = [
      '<thead><tr><th>來源</th><th>Zero Gamma</th><th>Call Wall</th><th>Put Wall</th>'
      + '<th>淨 GEX</th><th>資料日</th></tr></thead><tbody>',
      `<tr class="mine"><td class="name">本站 · 情境 ${s.key}</td>`
      + `<td>${px(bucket.flip[s.key], 2)}</td><td>${px(callWall)}</td><td>${px(putWall)}</td>`
      + `<td>${gex(bucket.netGex[s.key])}</td><td class="asof">${session.valuation}</td></tr>`,
    ];

    for (const peer of (state.peers && state.peers.peers) || []) {
      const label = `<a href="${peer.url}" target="_blank" rel="noopener">${peer.name}</a>`;
      if (peer.ok) {
        const when = peer.stale
          ? `<span class="note">沿用 ${peer.asOf || peer.fetchedAt || '前次'}</span>`
          : (peer.asOf || peer.fetchedAt || '—');
        rows.push(`<tr${peer.stale ? ' class="stale"' : ''}><td class="name">${label}</td>`
          + `<td>${px(peer.zeroGamma, 2)}</td><td>${px(peer.callWall)}</td><td>${px(peer.putWall)}</td>`
          + `<td>${gex(peer.netGex)}</td><td class="asof">${when}</td></tr>`);
      } else {
        rows.push(`<tr><td class="name">${label}</td><td>${dash}</td><td>${dash}</td><td>${dash}</td>`
          + `<td>${dash}</td><td class="note">抓取失敗</td></tr>`);
      }
    }
    rows.push('</tbody>');
    document.getElementById('gexPeerTable').innerHTML = rows.join('');

    /* 這張表最容易被誤讀的地方：Wall 各家的定義不一樣，數字當然不同。 */
    const oi = bucket.putWallOI;
    const oiCall = bucket.callWallOI;
    const flips = [bucket.flip.A, ...((state.peers && state.peers.peers) || [])
      .filter((p) => p.ok && p.zeroGamma).map((p) => p.zeroGamma)]
      .filter((v) => v !== null && v !== undefined);
    const flipSpread = flips.length > 1
      ? `${px(Math.min(...flips))} ～ ${px(Math.max(...flips))}`
      : px(bucket.flip.A);
    document.getElementById('gexPeerNote').innerHTML =
      '<b>為什麼 Wall 差這麼多：</b>「Wall」沒有統一定義。本站和 FlashAlpha 取 <b>gamma 曝險</b>最大的履約價；'
      + 'SquawkFlow 和 InsiderFinance 取 <b>未平倉量</b>最大的。同一份資料、同樣只看價外：'
      + `Put Wall 用 gamma 是 ${px(putWall)}、用未平倉量是 ${oi ? px(oi[0]) : dash}；`
      + `Call Wall 用 gamma 是 ${px(callWall)}、用未平倉量是 ${oiCall ? px(oiCall[0]) : dash}。`
      + '兩個都對，量的是不同東西 —— gamma 集中在現價附近，未平倉量集中在整數關卡。'
      + `同理，Zero Gamma 落在 ${flipSpread} 這一帶，也是假設與到期日範圍不同造成的。`;
  }

  /* ---------- 重畫 ---------- */

  function dropCharts() {
    fitters.length = 0;
    for (const chart of state.charts) chart.remove();
    if (state.curveChart) state.curveChart.remove();
    state.charts = [];
    state.curveChart = null;
  }

  function renderCharts() {
    dropCharts();
    const p = palette();
    const s = scenarioOf(state.scenario);
    const { panels, snapshot } = state.data;

    state.charts = [
      buildStrikeChart(document.getElementById('gexStrikes30d'), panels['30d'], snapshot.spot, p, s),
      buildStrikeChart(document.getElementById('gexStrikesAll'), panels.all, snapshot.spot, p, s),
    ];
    state.curveChart = buildCurveChart(document.getElementById('gexCurve'), p);

    document.getElementById('gexCap30d').textContent = `${panels['30d'].title} · 情境 ${s.key}`;
    document.getElementById('gexCapAll').textContent = `${panels.all.title} · 情境 ${s.key}`;
  }

  function renderAll() {
    renderStats();
    renderPeers();
    renderRangeBar();
    renderCharts();
  }

  function renderRangeBar() {
    const r = strikeRange();
    document.getElementById('gexFrom').value = r.from;
    document.getElementById('gexTo').value = r.to;
    const shown = state.data.panels['30d'].strikes.filter(([k]) => k >= r.from && k <= r.to).length;
    document.getElementById('gexRangeInfo').textContent =
      `共 ${shown} 個履約價 · 資料涵蓋 ${r.lo.toLocaleString()}～${r.hi.toLocaleString()}`;
  }

  function renderRangeControls() {
    const apply = () => {
      const from = parseFloat(document.getElementById('gexFrom').value);
      const to = parseFloat(document.getElementById('gexTo').value);
      state.range.from = Number.isFinite(from) ? from : null;
      state.range.to = Number.isFinite(to) ? to : null;
      renderRangeBar();
      renderCharts();
    };
    for (const id of ['gexFrom', 'gexTo']) {
      const input = document.getElementById(id);
      input.addEventListener('change', apply);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); apply(); }
      });
    }
    document.getElementById('gexRangeReset').addEventListener('click', () => {
      state.range = { from: null, to: null };
      renderRangeBar();
      renderCharts();
    });
  }

  /* ---------- 控件 ---------- */

  function renderControls() {
    const host = document.getElementById('gexScenarios');
    for (const s of SCENARIOS) {
      const btn = document.createElement('button');
      btn.dataset.key = s.key;
      btn.title = s.note;
      btn.className = s.key === state.scenario ? 'on' : '';
      btn.innerHTML = `<span class="scenario-key" style="background:${s.color}"></span>${s.label}`;
      btn.addEventListener('click', () => {
        state.scenario = s.key;
        for (const other of host.querySelectorAll('button')) {
          other.classList.toggle('on', other.dataset.key === state.scenario);
        }
        renderAll();
      });
      host.append(btn);
    }

    for (const btn of document.querySelectorAll('#gexBucket button')) {
      btn.addEventListener('click', () => {
        state.bucket = btn.dataset.bucket;
        for (const other of document.querySelectorAll('#gexBucket button')) {
          other.classList.toggle('on', other.dataset.bucket === state.bucket);
        }
        renderAll();
      });
    }
  }

  /* ---------- 回測 ---------- */

  function renderBacktest() {
    const bt = state.backtest;
    const el = document.getElementById('gexBacktest');
    if (!bt) {
      el.innerHTML = '<span class="na">回測資料未取得</span>';
      return;
    }
    const label = { positive: '正 gamma', negative: '負 gamma', neutral: '中性' };
    const st = bt.signTest;
    const w = bt.walls;
    const pct = (v) => `${v.toFixed(3)}%`;

    el.innerHTML =
      `<div class="bt-meta">樣本 <b>${bt.window.days}</b> 個交易日（${bt.window.from} ~ ${bt.window.to}）`
      + ` · 關卡用前一日收盤計算，無未來資訊 · 來源 <a href="${bt.source.url}" target="_blank" rel="noopener">${bt.source.name}</a>`
      + ` <a href="${bt.source.licenseUrl}" target="_blank" rel="noopener">${bt.source.license}</a>，由本站分析</div>`
      + '<table class="gex-peer bt-table"><thead><tr><th>Gamma 狀態</th><th>天數</th>'
      + '<th>隔日振幅</th><th>前一日振幅</th><th>當日報酬</th></tr></thead><tbody>'
      + bt.regime.map((g) => `<tr><td class="name">${label[g.key] || g.key}</td>`
        + `<td>${g.days}</td><td>${pct(g.range)}</td><td class="asof">${pct(g.prevRange)}</td>`
        + `<td>${g.ret > 0 ? '+' : ''}${pct(g.ret)}</td></tr>`).join('')
      + '</tbody></table>'
      + `<p class="bt-line">正 gamma 與負 gamma 的隔日振幅差 <b>${st.diff.toFixed(3)}%</b>，`
      + `<b>p = ${st.p}</b> —— 不顯著。現價在 Flip 上方／下方的振幅差 p = ${bt.flipTest.p}，距離遠近與振幅的相關 ${bt.distanceTest.corr}（p = ${bt.distanceTest.p}），也都沒有。</p>`
      + `<p class="bt-warn"><b>但「測不到」不等於「沒有」。</b>這個樣本要達到顯著，兩組振幅得差 <b>${st.needed.toFixed(3)}%</b>`
      + `（基準的 ${Math.round(st.needed / bt.regime[0].range * 100)}%）。若真實差異是 0.3%，檢定力只有 <b>${Math.round((st.power['0.3'] || 0) * 100)}%</b> ——`
      + `中等效果很容易被埋掉。加上只有 ${bt.regime.find((g) => g.key === 'negative')?.days ?? 0} 天是負 gamma，`
      + `且現價距 Flip 的中位數只有 ${bt.medianDistToFlip}%，狀態本身長期貼在翻轉點上。</p>`
      + `<p class="bt-line"><b>牆的表現：</b>Call Wall 觸及 ${w.callTouched} 天、守住 ${w.callHeld} 天；`
      + `Put Wall <b>${w.putTouched} 天一次都沒觸及</b>（平均在現價下方 ${w.putDistAvg}%，這期間的跌勢根本沒到那裡）。</p>`
      + `<p class="bt-line bt-concl">結論：這 ${bt.window.days} 天看不出 gamma 狀態與隔日波動的關係，`
      + `但也沒有足夠樣本否定它。要真正分出「標準／反向／減半」哪一個對，需要數倍長的樣本，`
      + `而且公開資料只有標準權重一種 —— 本站從今天起每天自己存一列六種情境的結果，累積中。</p>`;

    document.getElementById('gexBtHead').textContent =
      `回測 · Gamma 狀態有沒有預測力？（近 ${bt.window.days} 個交易日）`;
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

    /* 外站資料拿不到不影響本站的圖，只是那幾格顯示 — */
    for (const [file, key] of [['data/gex-peers.json', 'peers'], ['data/gex-backtest.json', 'backtest']]) {
      try {
        const res = await fetch(file, { cache: 'no-cache' });
        if (res.ok) state[key] = await res.json();
      } catch (err) {
        /* 略過 */
      }
    }

    renderControls();
    renderRangeControls();
    renderAll();
    renderBacktest();
    document.getElementById('gex').hidden = false;

    document.addEventListener('themechange', renderAll);
  }

  boot();
})();
