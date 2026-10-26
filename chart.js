'use strict';

// Pro chart: candles + volume + indicator overlays/panes, crosshair, wheel-zoom and drag-pan.
// Uses globals from app.js at call time only (C, fitCanvas, fp, account, stockOf, selected, ready, $, MAX_CANDLES).

const TF_KEY = 'capitalsim-tf';
const IND_KEY = 'capitalsim-ind';
const TIMEFRAMES = ['1m', '5m', '1h', '1d'];
const SUB_H = 90; // height of each indicator pane (RSI, MACD)

let tf = '1m';
const IND = { sma: true, ema: false, bb: false, vol: true, rsi: false, macd: false };
try {
  const t = localStorage.getItem(TF_KEY);
  if (TIMEFRAMES.includes(t)) tf = t;
  Object.assign(IND, JSON.parse(localStorage.getItem(IND_KEY)) || {});
} catch (e) { /* ignore */ }

const view = { count: 80, off: 0 };      // visible candles, and how many candles back from the live edge
let mouse = null;                        // pointer position in canvas px, or null
let marks = { sym: null, list: [] };     // backtest trades to show on the chart: [{t, side}]

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const resetView = () => { view.count = 80; view.off = 0; };
const chartCandles = s => (s.cur ? [...s.candles, s.cur] : s.candles);
const compact = v => (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(v < 10 ? 3 : 1));

function timeLabel(t, interval) {
  const d = new Date(t), p = n => String(n).padStart(2, '0');
  return interval === '1d' ? `${d.getMonth() + 1}/${d.getDate()}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function drawChart(s) {
  const canvas = $('chart');
  const nSub = (IND.rsi ? 1 : 0) + (IND.macd ? 1 : 0);
  canvas.style.height = (420 + nSub * SUB_H) + 'px';
  const { g, w, h } = fitCanvas(canvas);
  const all = chartCandles(s);
  if (!all.length) return;

  // indicators are computed over the full history, then sliced to the viewport
  const closes = all.map(c => c.c);
  const ind = {
    sma: IND.sma ? Indicators.sma(closes, 20) : null,
    ema: IND.ema ? Indicators.ema(closes, 50) : null,
    bb: IND.bb ? Indicators.bollinger(closes, 20, 2) : null,
    rsi: IND.rsi ? Indicators.rsi(closes, 14) : null,
    macd: IND.macd ? Indicators.macd(closes) : null,
  };

  const count = Math.min(all.length, clamp(view.count, 10, MAX_CANDLES));
  view.off = clamp(view.off, 0, all.length - count);
  const end = all.length - view.off, start = end - count, vis = all.slice(start, end);
  const hasTime = vis[0].t > 1e11;
  const padR = 56, padB = hasTime ? 16 : 4;
  const mainH = h - padB - nSub * SUB_H;
  const cw = (w - padR) / count, xAt = i => i * cw + cw / 2;

  let hi = -Infinity, lo = Infinity;
  vis.forEach((c, i) => {
    hi = Math.max(hi, c.h); lo = Math.min(lo, c.l);
    if (ind.bb && ind.bb.upper[start + i] != null) { hi = Math.max(hi, ind.bb.upper[start + i]); lo = Math.min(lo, ind.bb.lower[start + i]); }
  });
  const rng = (hi - lo) || hi * 0.01 || 1, top = hi + rng * 0.05, bot = lo - rng * 0.05;
  const hasVol = IND.vol && vis.some(c => c.v > 0);
  const volH = hasVol ? mainH * 0.18 : 0, priceH = mainH - volH;
  const y = v => priceH * (1 - (v - bot) / (top - bot));

  g.font = '11px system-ui'; g.lineWidth = 1; g.textAlign = 'left';
  g.strokeStyle = C.line; g.fillStyle = C.mute;
  for (let i = 0; i <= 4; i++) {
    const v = bot + (top - bot) * i / 4, yy = y(v);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(w - padR, yy); g.stroke();
    g.fillText(v.toFixed(s.dp), w - padR + 6, yy + 4);
  }

  if (hasVol) {
    const vmax = Math.max(...vis.map(c => c.v || 0)) || 1;
    g.globalAlpha = 0.35;
    vis.forEach((c, i) => {
      g.fillStyle = c.c >= c.o ? C.up : C.down;
      const bh = (c.v || 0) / vmax * (volH - 4);
      g.fillRect(xAt(i) - cw * 0.35, mainH - bh, cw * 0.7, bh);
    });
    g.globalAlpha = 1;
  }

  // plots arr[start..end) as a line using ymap
  const plot = (arr, col, width, ymap, dash) => {
    g.strokeStyle = col; g.lineWidth = width; g.setLineDash(dash || []); g.beginPath();
    let pen = false;
    for (let i = 0; i < vis.length; i++) {
      const v = arr[start + i];
      if (v == null) { pen = false; continue; }
      if (pen) g.lineTo(xAt(i), ymap(v)); else g.moveTo(xAt(i), ymap(v));
      pen = true;
    }
    g.stroke(); g.setLineDash([]); g.lineWidth = 1;
  };

  if (ind.bb) {
    plot(ind.bb.upper, C.order, 1, y); plot(ind.bb.lower, C.order, 1, y); plot(ind.bb.mid, C.order, 1, y, [4, 3]);
  }

  vis.forEach((c, i) => {
    const x = xAt(i);
    g.strokeStyle = g.fillStyle = c.c >= c.o ? C.up : C.down;
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    g.fillRect(x - cw * 0.35, y(Math.max(c.o, c.c)), cw * 0.7, Math.max(1, Math.abs(y(c.o) - y(c.c))));
  });

  if (ind.sma) plot(ind.sma, C.ma, 1.5, y);
  if (ind.ema) plot(ind.ema, C.accent, 1.5, y);

  // position cost basis, open orders, last price
  const refLine = (v, col, label) => {
    if (v < bot || v > top) return;
    g.strokeStyle = col; g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w - padR, y(v)); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.fillText(label, 6, y(v) - 3);
  };
  const p = account.positions[s.sym];
  if (p && p.qty > 0) refLine(p.avg, C.accent, `avg cost ${fp(s, p.avg)}`);
  account.orders.filter(o => o.sym === s.sym).forEach(o => refLine(o.price, C.order, `${o.type} ${o.side} #${o.id}`));
  if (s.price >= bot && s.price <= top) {
    const yy = y(s.price), col = s.price >= s.open ? C.up : C.down;
    g.strokeStyle = col; g.globalAlpha = 0.6; g.setLineDash([2, 3]);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(w - padR, yy); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    g.fillStyle = col; g.fillRect(w - padR + 1, yy - 8, padR - 2, 16);
    g.fillStyle = '#fff'; g.fillText(s.price.toFixed(s.dp), w - padR + 4, yy + 4);
  }

  // backtest trade markers
  if (marks.sym === s.sym && marks.list.length) {
    const byT = new Map(marks.list.map(m => [m.t, m.side]));
    vis.forEach((c, i) => {
      const side = byT.get(c.t);
      if (!side) return;
      const x = xAt(i), sz = Math.min(7, cw * 0.5) + 2, buy = side === 'buy';
      const y0 = buy ? y(c.l) + 4 : y(c.h) - 4, dir = buy ? 1 : -1;
      g.fillStyle = buy ? C.up : C.down;
      g.beginPath(); g.moveTo(x, y0); g.lineTo(x - sz, y0 + dir * sz * 1.6); g.lineTo(x + sz, y0 + dir * sz * 1.6); g.closePath(); g.fill();
    });
  }

  // indicator panes
  let py = mainH;
  const pane = (label, draw) => {
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, py + 0.5); g.lineTo(w - padR, py + 0.5); g.stroke();
    g.fillStyle = C.mute; g.fillText(label, 6, py + 12);
    draw(py, py + SUB_H);
    py += SUB_H;
  };
  if (ind.rsi) pane('RSI 14', (y0, y1) => {
    const yy = v => y1 - 4 - (y1 - y0 - 8) * (v / 100);
    g.strokeStyle = C.line; g.setLineDash([3, 3]);
    [30, 70].forEach(l => { g.beginPath(); g.moveTo(0, yy(l)); g.lineTo(w - padR, yy(l)); g.stroke(); g.fillStyle = C.mute; g.fillText(l, w - padR + 6, yy(l) + 4); });
    g.setLineDash([]);
    plot(ind.rsi, C.accent, 1.5, yy);
  });
  if (ind.macd) pane('MACD 12/26/9', (y0, y1) => {
    const vals = [];
    for (let i = start; i < end; i++) [ind.macd.macd[i], ind.macd.signal[i], ind.macd.hist[i]].forEach(v => { if (v != null) vals.push(v); });
    const m = Math.max(1e-12, ...vals.map(Math.abs));
    const yy = v => (y0 + y1) / 2 - (v / m) * ((y1 - y0) / 2 - 6);
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(0, yy(0)); g.lineTo(w - padR, yy(0)); g.stroke();
    g.globalAlpha = 0.5;
    vis.forEach((c, i) => {
      const v = ind.macd.hist[start + i];
      if (v == null) return;
      g.fillStyle = v >= 0 ? C.up : C.down;
      g.fillRect(xAt(i) - cw * 0.35, Math.min(yy(0), yy(v)), cw * 0.7, Math.max(1, Math.abs(yy(v) - yy(0))));
    });
    g.globalAlpha = 1;
    plot(ind.macd.macd, C.accent, 1.5, yy); plot(ind.macd.signal, C.ma, 1.5, yy);
  });

  if (hasTime) {
    g.fillStyle = C.mute; g.textAlign = 'center';
    for (let k = 0; k < 5; k++) { const i = Math.round(k * (count - 1) / 4); g.fillText(timeLabel(vis[i].t, tf), clamp(xAt(i), 18, w - padR - 18), h - 3); }
    g.textAlign = 'left';
  }

  // crosshair + tooltip
  if (mouse && mouse.x >= 0 && mouse.x < w - padR && mouse.y >= 0 && mouse.y < h) {
    const i = clamp(Math.floor(mouse.x / cw), 0, vis.length - 1), c = vis[i], gi = start + i, x = xAt(i);
    g.strokeStyle = C.mute; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - padB); g.stroke();
    if (mouse.y < priceH) {
      g.beginPath(); g.moveTo(0, mouse.y); g.lineTo(w - padR, mouse.y); g.stroke();
      const pv = bot + (top - bot) * (1 - mouse.y / priceH);
      g.setLineDash([]); g.fillStyle = C.mute; g.fillRect(w - padR + 1, mouse.y - 8, padR - 2, 16);
      g.fillStyle = C.panel; g.fillText(pv.toFixed(s.dp), w - padR + 4, mouse.y + 4);
    }
    g.setLineDash([]);
    const parts = [hasTime ? new Date(c.t).toLocaleString() : `#${gi + 1}`, `O ${fp(s, c.o)}`, `H ${fp(s, c.h)}`, `L ${fp(s, c.l)}`, `C ${fp(s, c.c)}`];
    if (c.v != null) parts.push('V ' + compact(c.v));
    if (ind.sma && ind.sma[gi] != null) parts.push('SMA20 ' + fp(s, ind.sma[gi]));
    if (ind.ema && ind.ema[gi] != null) parts.push('EMA50 ' + fp(s, ind.ema[gi]));
    if (ind.rsi && ind.rsi[gi] != null) parts.push('RSI ' + ind.rsi[gi].toFixed(1));
    if (ind.macd && ind.macd.hist[gi] != null) parts.push('MACD ' + ind.macd.macd[gi].toFixed(3) + ' / ' + ind.macd.signal[gi].toFixed(3));
    const text = parts.join('   ');
    g.fillStyle = C.panel; g.globalAlpha = 0.92;
    g.fillRect(4, 2, Math.min(w - padR - 8, g.measureText(text).width + 12), 18);
    g.globalAlpha = 1; g.fillStyle = C.text; g.fillText(text, 10, 15);
  }
}

function bindChart() {
  const cv = $('chart');
  const redraw = () => { if (ready) drawChart(stockOf(selected)); };
  const at = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  let drag = null;
  cv.addEventListener('pointerdown', e => { drag = { x: e.clientX, off: view.off }; cv.setPointerCapture && cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    mouse = at(e);
    if (drag) view.off = Math.max(0, drag.off + Math.round((e.clientX - drag.x) / ((cv.clientWidth - 56) / Math.max(10, view.count))));
    redraw();
  });
  const stop = () => { drag = null; };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);
  cv.addEventListener('pointerleave', () => { mouse = null; redraw(); });
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    view.count = clamp(Math.round(view.count * (e.deltaY > 0 ? 1.15 : 1 / 1.15)), 10, MAX_CANDLES);
    redraw();
  }, { passive: false });
  cv.addEventListener('dblclick', () => { resetView(); redraw(); });

  document.querySelectorAll('[data-ind]').forEach(cb => {
    cb.checked = !!IND[cb.dataset.ind];
    cb.addEventListener('change', () => {
      IND[cb.dataset.ind] = cb.checked;
      try { localStorage.setItem(IND_KEY, JSON.stringify(IND)); } catch (e) { /* ignore */ }
      redraw();
    });
  });
}
