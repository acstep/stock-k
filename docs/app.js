'use strict';

const LWC = LightweightCharts;

/* 兩套主題。漲跌一律美式綠漲紅跌；深色底用亮一階的綠紅以免糊掉。 */
const THEMES = {
  light: {
    chart: {
      text: '#5b6472',
      grid: 'rgba(15,23,42,0.055)',
      border: 'rgba(15,23,42,0.10)',
      crosshair: 'rgba(15,23,42,0.35)',
      crosshairLabel: '#334155',
    },
    candle: { up: '#16a34a', down: '#dc2626' },
    ma: {
      5: '#f59e0b', 10: '#a855f7', 20: '#0ea5e9',
      60: '#f97316', 120: '#ec4899', 200: '#334155',
    },
    range: { high: '#64748b', low: '#94a3b8' },
  },
  dark: {
    chart: {
      text: '#7d8699',
      grid: 'rgba(255,255,255,0.045)',
      border: 'rgba(255,255,255,0.08)',
      crosshair: 'rgba(255,255,255,0.28)',
      crosshairLabel: '#2a3040',
    },
    candle: { up: '#22c55e', down: '#ef4444' },
    ma: {
      5: '#f0b90b', 10: '#c084fc', 20: '#38bdf8',
      60: '#fb923c', 120: '#f472b6', 200: '#94a3b8',
    },
    range: { high: '#94a3b8', low: '#64748b' },
  },
};

const THEMES_UI = [['light', '白底'], ['dark', '黑底']];
const THEME_KEY = 'stock-k-theme';

const MA_PERIODS = [5, 10, 20, 60, 120, 200];

const theme = () => THEMES[state.theme] || THEMES.light;

const RECENT_DAILY_BARS = 63; // 近三個月約 63 個交易日
const MONTH_DAYS = 30;

const YAHOO_QUOTE = 'https://finance.yahoo.com/quote/';

/* 排序選項；key 對應 applySort() 的分支 */
const SORTS = [
  { key: 'default', label: '預設順序' },
  { key: 'gain', label: '近一月漲幅' },
  { key: 'loss', label: '近一月跌幅' },
];

const state = {
  ma: new Set([20, 60]),
  volume: new Set(),   // 已開啟成交量的 ticker
  daily: new Map(),    // ticker -> Bar[]
  hourly: new Map(),   // ticker -> Bar[] 或進行中的 Promise
  panes: new Map(),    // ticker -> { left, right }
  rows: new Map(),     // ticker -> <section.row>
  names: {},           // ticker -> 中文公司名
  month: new Map(),    // ticker -> 近一個月漲跌 %
  order: [],           // 資料原始順序
  errors: new Set(),   // 日線沿用前次資料的 ticker
  sort: 'default',
  theme: 'light',
};

/* ---------- 資料 ---------- */

const toBar = ([time, open, high, low, close, volume]) =>
  ({ time, open, high, low, close, volume });

const monospace = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function volumeColor(bar, alpha) {
  const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
  const { up, down } = theme().candle;
  return (bar.close >= bar.open ? up : down) + hex;
}

async function loadHourly(symbol) {
  if (!state.hourly.has(symbol)) {
    /* no-cache：GitHub Pages 送 max-age=600，不重新驗證的話改完清單會看到
       最多 10 分鐘前的舊資料 */
    const request = fetch(`data/hourly/${symbol}.json`, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.status))))
      .then((payload) => payload.bars.map(toBar))
      .catch(() => null);
    state.hourly.set(symbol, request);
  }
  return state.hourly.get(symbol);
}

/* ---------- 指標 ---------- */

function simpleMA(bars, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

function yearRange(bars) {
  let high = -Infinity;
  let low = Infinity;
  for (const bar of bars) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  return { high, low };
}

/* 近一個月漲跌 %：基準是最後一根往前推 30 個日曆天當天或之前的那根收盤價 */
function monthChange(bars) {
  const last = bars[bars.length - 1];
  const cutoff = new Date(`${last.time}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - MONTH_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  let base = bars[0];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].time <= cutoffDate) {
      base = bars[i];
      break;
    }
  }
  return base.close ? ((last.close - base.close) / base.close) * 100 : 0;
}

/* ---------- 圖表 ---------- */

function chartOptions(intraday) {
  const t = theme().chart;
  return {
    autoSize: true,
    layout: {
      background: { type: LWC.ColorType.Solid, color: 'rgba(0,0,0,0)' },
      textColor: t.text,
      fontSize: 10,
      fontFamily: monospace,
    },
    grid: {
      vertLines: { color: t.grid },
      horzLines: { color: t.grid },
    },
    rightPriceScale: {
      borderColor: t.border,
      entireTextOnly: true,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: t.border,
      rightOffset: 1,
      fixLeftEdge: true,
      timeVisible: intraday,
      secondsVisible: false,
    },
    crosshair: {
      mode: LWC.CrosshairMode.Normal,
      vertLine: {
        color: t.crosshair, width: 1,
        style: LWC.LineStyle.Dotted, labelBackgroundColor: t.crosshairLabel,
      },
      horzLine: {
        color: t.crosshair, width: 1,
        style: LWC.LineStyle.Dotted, labelBackgroundColor: t.crosshairLabel,
      },
    },
    /* 41 列頁面裡，圖表不能搶走滾輪 */
    handleScroll: false,
    handleScale: false,
  };
}

/* lightweight-charts 不會自動把所有資料塞進可視範圍 —— 預設只顯示最近 40 餘根，
   所以一年 251 根只會看到約兩個月。每次設定資料後要自己指定範圍。
   資料量真的太大時（期貨 60 分 K 有 1485 根）函式庫會自己停在下限。 */
function showAllBars(chart, bars) {
  chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: bars.length - 0.5 });
}

function buildChart(el, bars, symbol, intraday) {
  const t = theme();
  const chart = LWC.createChart(el, chartOptions(intraday));

  const candles = chart.addSeries(LWC.CandlestickSeries, {
    upColor: t.candle.up, downColor: t.candle.down,
    borderUpColor: t.candle.up, borderDownColor: t.candle.down,
    wickUpColor: t.candle.up, wickDownColor: t.candle.down,
    priceLineVisible: false,
  });
  candles.setData(bars);
  showAllBars(chart, bars);
  /* 容器尺寸一變就重設範圍。跨過桌機/手機斷點時 lightweight-charts 會把可視
     範圍往右滑並在右邊留白，左圖就看不到完整一年。 */
  chart.timeScale().subscribeSizeChange(() => showAllBars(chart, bars));

  const group = { el, chart, candles, bars, symbol, ma: new Map(), volume: null, priceLines: [] };

  /* 52 週高低以日線為準，60 分 K 圖上當作水平參考 */
  const yearly = state.daily.get(symbol);
  if (yearly) {
    const { high, low } = yearRange(yearly);
    for (const [price, key, title] of [
      [high, 'high', '52週高'],
      [low, 'low', '52週低'],
    ]) {
      if (!Number.isFinite(price)) continue;
      group.priceLines.push({
        key,
        line: candles.createPriceLine({
          price, color: t.range[key], title, lineWidth: 1,
          lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true,
        }),
      });
    }
  }

  syncMA(group);
  syncVolume(group);
  return group;
}

function syncMA(group) {
  for (const period of MA_PERIODS) {
    const wanted = state.ma.has(period);
    const existing = group.ma.get(period);
    if (wanted && !existing) {
      const line = group.chart.addSeries(LWC.LineSeries, {
        color: theme().ma[period], lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(simpleMA(group.bars, period));
      group.ma.set(period, line);
    } else if (!wanted && existing) {
      group.chart.removeSeries(existing);
      group.ma.delete(period);
    }
  }
}

function syncVolume(group) {
  const wanted = state.volume.has(group.symbol);
  if (wanted && !group.volume) {
    const series = group.chart.addSeries(LWC.HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    group.chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    group.volume = series;
    group.volume.setData(group.bars.map((bar) => ({
      time: bar.time, value: bar.volume, color: volumeColor(bar, 0.45),
    })));
  } else if (!wanted && group.volume) {
    group.chart.removeSeries(group.volume);
    group.volume = null;
  }
}

const destroyGroup = (group) => group && group.chart.remove();

/* ---------- 列的 DOM ---------- */

function formatChange(diff, pct) {
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
}

const changeClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'flat');

function buildSymbolCell(symbol, bars) {
  const cell = document.createElement('div');
  cell.className = 'sym';

  const name = state.names[symbol] || symbol;

  const ticker = document.createElement('a');
  ticker.className = 'ticker';
  ticker.href = `${YAHOO_QUOTE}${encodeURIComponent(symbol)}`;
  ticker.target = '_blank';
  ticker.rel = 'noopener';
  ticker.textContent = symbol;
  ticker.title = `在 Yahoo Finance 看 ${symbol}（${name}）`;

  const company = document.createElement('div');
  company.className = 'company';
  company.textContent = name;
  company.title = name;

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2] || last;
  const diff = last.close - prev.close;
  const pct = prev.close ? (diff / prev.close) * 100 : 0;

  const price = document.createElement('div');
  price.className = 'price';
  price.textContent = last.close.toFixed(2);

  const chg = document.createElement('div');
  chg.className = `chg ${changeClass(diff)}`;
  chg.textContent = formatChange(diff, pct);

  const change = state.month.get(symbol) ?? 0;
  const month = document.createElement('div');
  month.className = `month ${changeClass(change)}`;
  month.textContent = `1月 ${change > 0 ? '+' : ''}${change.toFixed(2)}%`;

  const volBtn = document.createElement('button');
  volBtn.className = `vol-btn${state.volume.has(symbol) ? ' on' : ''}`;
  volBtn.textContent = '量';
  volBtn.title = '顯示／隱藏成交量';
  volBtn.addEventListener('click', () => {
    if (state.volume.has(symbol)) state.volume.delete(symbol);
    else state.volume.add(symbol);
    volBtn.classList.toggle('on');
    for (const group of Object.values(state.panes.get(symbol) || {})) {
      if (group) syncVolume(group);
    }
  });

  cell.append(ticker, company, price, chg, month, volBtn);
  return cell;
}

function buildPane(label, extraClass, symbol) {
  const pane = document.createElement('figure');
  pane.className = `pane ${extraClass}`;

  const cap = document.createElement('figcaption');
  cap.className = 'cap';
  cap.append(document.createTextNode(label));
  if (state.errors.has(symbol)) {
    const badge = document.createElement('span');
    badge.className = 'err-badge';
    badge.textContent = '資料異常';
    cap.append(badge);
  }

  const chart = document.createElement('div');
  chart.className = 'chart';

  pane.append(cap, chart);
  return { pane, chart };
}

function buildRow(symbol) {
  const bars = state.daily.get(symbol);
  const row = document.createElement('section');
  row.className = 'row';
  row.dataset.ticker = symbol;

  if (!bars || !bars.length) {
    const empty = document.createElement('div');
    empty.className = 'sym';
    const label = document.createElement('div');
    label.className = 'ticker';
    label.textContent = symbol;
    const badge = document.createElement('span');
    badge.className = 'err-badge';
    badge.textContent = '無資料';
    empty.append(label, badge);
    row.append(empty);
    return row;
  }

  const left = buildPane('近一年 · 日K', 'left', symbol);
  const right = buildPane('近三個月 ·', 'right', symbol);

  const seg = document.createElement('span');
  seg.className = 'seg';
  const buttons = {};
  for (const [tf, text] of [['1d', '日K'], ['1h', '60分K']]) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.className = tf === '1d' ? 'on' : '';
    btn.addEventListener('click', () => {
      for (const [key, other] of Object.entries(buttons)) {
        other.classList.toggle('on', key === tf);
      }
      selectTimeframe(symbol, tf);
    });
    buttons[tf] = btn;
    seg.append(btn);
  }
  right.pane.querySelector('.cap').append(seg);

  row.append(buildSymbolCell(symbol, bars), left.pane, right.pane);
  return row;
}

/* ---------- 切換近三個月的週期 ---------- */

async function selectTimeframe(symbol, timeframe) {
  const panes = state.panes.get(symbol);
  if (!panes) return;

  const daily = state.daily.get(symbol);
  const bars = timeframe === '1h'
    ? await loadHourly(symbol)
    : daily.slice(-RECENT_DAILY_BARS);

  if (!bars || !bars.length) return;

  destroyGroup(panes.right);
  panes.right = buildChart(panes.right.el, bars, symbol, timeframe === '1h');
}

/* ---------- 建立頁面 ---------- */

function renderUpdated(iso) {
  const when = new Date(iso);
  const text = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(when);

  const el = document.getElementById('updated');
  el.textContent = `資料時間 ${text} 台北`;
  if (Date.now() - when.getTime() > 30 * 3600 * 1000) {
    el.textContent += ' · 已逾 30 小時';
    el.style.color = '#b45309';
  }
}

function renderMAControls() {
  const host = document.getElementById('maControls');
  for (const period of MA_PERIODS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.ma.has(period);
    input.addEventListener('change', () => {
      if (input.checked) state.ma.add(period);
      else state.ma.delete(period);
      for (const panes of state.panes.values()) {
        for (const group of Object.values(panes)) {
          if (group) syncMA(group);
        }
      }
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.color = theme().ma[period];

    label.append(input, swatch, document.createTextNode(`MA${period}`));
    host.append(label);
  }
}

/* ---------- 主題 ---------- */

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored && stored in THEMES) return stored;
  } catch (err) {
    /* 無痕模式會擋 localStorage，用預設值就好 */
  }
  return 'light';
}

/* 只更新既有圖表，不重建 —— 重建會讓 60 分 K 的狀態和捲動位置跑掉 */
function applyThemeToCharts() {
  const t = theme();

  for (const panes of state.panes.values()) {
    for (const group of Object.values(panes)) {
      if (!group) continue;

      group.chart.applyOptions({
        layout: { textColor: t.chart.text },
        grid: {
          vertLines: { color: t.chart.grid },
          horzLines: { color: t.chart.grid },
        },
        rightPriceScale: { borderColor: t.chart.border },
        timeScale: { borderColor: t.chart.border },
        crosshair: {
          vertLine: { color: t.chart.crosshair, labelBackgroundColor: t.chart.crosshairLabel },
          horzLine: { color: t.chart.crosshair, labelBackgroundColor: t.chart.crosshairLabel },
        },
      });

      group.candles.applyOptions({
        upColor: t.candle.up, downColor: t.candle.down,
        borderUpColor: t.candle.up, borderDownColor: t.candle.down,
        wickUpColor: t.candle.up, wickDownColor: t.candle.down,
      });

      for (const [period, series] of group.ma) {
        series.applyOptions({ color: t.ma[period] });
      }

      for (const { key, line } of group.priceLines) {
        line.applyOptions({ color: t.range[key] });
      }

      /* 成交量顏色綁在每一根資料上，換色要整份重設 */
      if (group.volume) {
        group.volume.setData(group.bars.map((bar) => ({
          time: bar.time, value: bar.volume, color: volumeColor(bar, 0.45),
        })));
      }
    }
  }

  /* 均線勾選鈕上的小圓點 */
  document.querySelectorAll('#maControls label').forEach((label, index) => {
    label.querySelector('.swatch').style.color = t.ma[MA_PERIODS[index]];
  });
}

function setTheme(name) {
  state.theme = name in THEMES ? name : 'light';
  document.documentElement.dataset.theme = state.theme;
  try {
    localStorage.setItem(THEME_KEY, state.theme);
  } catch (err) {
    /* 記不住沒關係，這次切換仍然有效 */
  }
  for (const button of document.querySelectorAll('#themes button')) {
    button.classList.toggle('on', button.dataset.theme === state.theme);
  }
  applyThemeToCharts();
  document.dispatchEvent(new CustomEvent('themechange'));
}

function renderThemeControls() {
  const host = document.getElementById('themes');
  for (const [name, label] of THEMES_UI) {
    const button = document.createElement('button');
    button.dataset.theme = name;
    button.textContent = label;
    button.className = name === state.theme ? 'on' : '';
    button.addEventListener('click', () => setTheme(name));
    host.append(button);
  }
}

/* ---------- 排序 ---------- */

function applySort(key) {
  state.sort = key;
  const order = [...state.order];

  if (key === 'gain') {
    order.sort((a, b) => (state.month.get(b) ?? 0) - (state.month.get(a) ?? 0));
  } else if (key === 'loss') {
    order.sort((a, b) => (state.month.get(a) ?? 0) - (state.month.get(b) ?? 0));
  }

  /* append 會搬移既有節點，圖表實例跟著版面一起移動，不需重建 */
  const list = document.getElementById('list');
  for (const symbol of order) {
    const row = state.rows.get(symbol);
    if (row) list.append(row);
  }

  for (const button of document.querySelectorAll('#sorts button')) {
    button.classList.toggle('on', button.dataset.sort === key);
  }
}

function renderSortControls() {
  const host = document.getElementById('sorts');
  for (const { key, label } of SORTS) {
    const button = document.createElement('button');
    button.className = key === state.sort ? 'on' : '';
    button.dataset.sort = key;
    button.textContent = label;
    button.addEventListener('click', () => applySort(key));
    host.append(button);
  }
}

function observeRows() {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const symbol = entry.target.dataset.ticker;
      observer.unobserve(entry.target);
      if (state.panes.has(symbol) || !state.daily.has(symbol)) continue;

      const leftEl = entry.target.querySelector('.pane.left .chart');
      const rightEl = entry.target.querySelector('.pane.right .chart');
      if (!leftEl || !rightEl) continue;

      const daily = state.daily.get(symbol);
      state.panes.set(symbol, {
        left: buildChart(leftEl, daily, symbol, false),
        right: buildChart(rightEl, daily.slice(-RECENT_DAILY_BARS), symbol, false),
      });
    }
  }, { rootMargin: '600px 0px' });

  for (const row of document.querySelectorAll('.row')) observer.observe(row);
}

async function boot() {
  state.theme = readStoredTheme();
  document.documentElement.dataset.theme = state.theme;

  renderThemeControls();
  renderMAControls();

  let payload;
  try {
    const res = await fetch('data/daily.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    payload = await res.json();
  } catch (err) {
    document.getElementById('updated').textContent = `資料載入失敗：${err.message}`;
    return;
  }

  renderUpdated(payload.updated);

  /* 日線失敗的 key 是 ticker，小時線失敗的是 "TICKER:1h" */
  const errorKeys = Object.keys(payload.errors || {});
  const dailyFailed = errorKeys.filter((key) => !key.includes(':'));
  const hourlyFailed = errorKeys.length - dailyFailed.length;
  state.errors = new Set(dailyFailed);

  if (errorKeys.length) {
    const parts = [];
    if (dailyFailed.length) parts.push(`${dailyFailed.length} 檔沿用前次資料`);
    if (hourlyFailed) parts.push(`${hourlyFailed} 檔 60 分 K 缺漏`);
    document.getElementById('warnings').textContent = `· ${parts.join('、')}`;
  }

  state.names = payload.names || {};
  state.order = payload.order;
  document.title = `STOCK-K · ${payload.order.length} 檔 K 線`;

  const list = document.getElementById('list');
  const fragment = document.createDocumentFragment();
  for (const symbol of payload.order) {
    const bars = (payload.tickers[symbol]?.bars || []).map(toBar);
    state.daily.set(symbol, bars);
    state.month.set(symbol, bars.length ? monthChange(bars) : 0);

    const row = buildRow(symbol);
    state.rows.set(symbol, row);
    fragment.append(row);
  }
  list.append(fragment);

  renderSortControls();
  observeRows();
}

boot();
