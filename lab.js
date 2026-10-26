'use strict';

// Strategy lab (backtest + live auto-trader) and computer-controlled bot traders.
// Uses globals from app.js at call time only.

const BOTS_KEY = 'capitalsim-bots';
const PERIODS_PER_YEAR = { '1m': 525600, '5m': 105120, '1h': 8760, '1d': 365 };
const BOT_COLORS = ['#f59e0b', '#a855f7', '#ec4899', '#14b8a6'];
const BOT_DEFS = [
  { id: 'momo', name: 'Mo Mentum', strat: 'sma_cross', params: { fast: 5, slow: 20, band: 0.1 } },
  { id: 'mean', name: 'Mia Reverts', strat: 'rsi_revert', params: { n: 14, lo: 35, hi: 55 } },
  { id: 'rand', name: 'Randy Random', strat: 'random', params: { p: 0.01 } },
  { id: 'hodl', name: 'Hank HODL', strat: 'hodl', params: {} },
];

const STRATS = () => Strategies.STRATEGIES;
const pct = (x, d = 2) => (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
const sameBar = c => (c ? (c.t ?? null) : null);

// ---------- strategy lab ----------
const lab = { key: 'sma_cross', bars: 500, bt: null };

function renderParams() {
  const st = STRATS()[lab.key];
  $('stratDesc').textContent = st.desc;
  $('stratParams').innerHTML = st.params.map(p => `<label>${p.label}<input data-p="${p.k}" type="number" step="${p.step || 1}" value="${p.v}"></label>`).join('');
}

function readParams() {
  const out = {};
  STRATS()[lab.key].params.forEach(p => { out[p.k] = p.v; });
  document.querySelectorAll('#stratParams [data-p]').forEach(i => {
    const v = parseFloat(i.value);
    if (isFinite(v)) out[i.dataset.p] = v;
  });
  return out;
}

async function labCandles(s) {
  if (mode === 'live') {
    const rows = await get(`/klines?symbol=${s.pair.toUpperCase()}&interval=${tf}&limit=${lab.bars}`);
    const cs = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    cs.pop(); // the newest candle is still forming
    return cs;
  }
  return s.candles.slice();
}

async function runBacktest() {
  const s = stockOf(selected), myGen = gen;
  $('runBt').disabled = true;
  $('btStats').textContent = 'Loading history…';
  try {
    const cs = await labCandles(s);
    if (myGen !== gen) return;
    if (cs.length < 40) { $('btStats').textContent = `Only ${cs.length} candles available so far — let the market run a little, or use Live crypto mode for deep history.`; return; }
    const res = Strategies.backtest(cs, lab.key, readParams(), { cash: START_CASH, fee: COMMISSION, slip: 0.0005, periodsPerYear: mode === 'live' ? PERIODS_PER_YEAR[tf] : 252 });
    lab.bt = { ...res, sym: s.sym, key: lab.key, n: cs.length, tf: mode === 'live' ? tf : 'tick-built' };
    marks = { sym: s.sym, list: res.trades.map(t => ({ t: t.t, side: t.side })) };
    renderBtStats();
    drawBt();
    if (ready) drawChart(s);
  } catch (e) {
    $('btStats').textContent = 'Backtest failed: ' + e.message;
  } finally {
    $('runBt').disabled = false;
  }
}

function renderBtStats() {
  const b = lab.bt;
  if (!b) { $('btStats').textContent = 'Run a backtest to compare the strategy with buy & hold on real history.'; return; }
  const st = b.stats, tile = (label, val, c) => `<div><span>${label}</span><b class="${c || ''}">${val}</b></div>`;
  $('btStats').innerHTML =
    `<div class="btnote">${esc(STRATS()[b.key].name)} on ${esc(b.sym)} · ${b.n} candles (${b.tf}) · 0.05% fee + 0.05% slippage per trade · markers shown on the main chart</div>` +
    '<div class="tiles">' +
    tile('Strategy return', pct(st.ret), cls(st.ret)) + tile('Buy & hold', pct(st.bhRet), cls(st.bhRet)) +
    tile('Max drawdown', pct(st.maxDD), 'down') + tile('B&H drawdown', pct(st.bhDD), 'down') +
    tile('Sharpe (ann.)', st.sharpe.toFixed(2)) + tile('Trades', st.trades) +
    tile('Win rate', st.winRate == null ? '–' : (st.winRate * 100).toFixed(0) + '%') + tile('Time in market', (st.exposure * 100).toFixed(0) + '%') +
    '</div>';
}

function drawBt() {
  const cv = $('btchart');
  if (!cv) return;
  const { g, w, h } = fitCanvas(cv);
  const b = lab.bt;
  if (!b) return;
  const n = b.eq.length, base = b.eq[0] > 0 ? START_CASH : 1;
  const a = b.eq.map(v => v / base - 1), c = b.bh.map(v => v / base - 1);
  const hi = Math.max(...a, ...c, 0), lo = Math.min(...a, ...c, 0), rng = (hi - lo) || 1;
  const y = v => 8 + (h - 24) * (1 - (v - lo) / rng), x = i => 40 + (w - 48) * i / Math.max(1, n - 1);
  g.font = '11px system-ui'; g.lineWidth = 1; g.strokeStyle = C.line; g.fillStyle = C.mute;
  g.setLineDash([4, 4]); g.beginPath(); g.moveTo(40, y(0)); g.lineTo(w - 8, y(0)); g.stroke(); g.setLineDash([]);
  [hi, 0, lo].forEach(v => g.fillText((v * 100).toFixed(0) + '%', 2, y(v) + 4));
  const line = (arr, col, width) => { g.strokeStyle = col; g.lineWidth = width; g.beginPath(); arr.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke(); };
  line(c, C.mute, 1.5); line(a, C.accent, 2);
  g.fillStyle = C.accent; g.fillText('Strategy', 46, h - 4);
  g.fillStyle = C.mute; g.fillText('Buy & hold', 110, h - 4);
}

// ---------- live auto-trader (runs the selected strategy on the player's paper account) ----------
const auto = { on: false, sym: null, key: null, params: null, alloc: 50, lastKey: null };

function autoLog(text) {
  const el = $('autolog');
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}\n` + el.textContent.split('\n').slice(0, 7).join('\n');
}

function stopAuto() {
  auto.on = false;
  const cb = $('autoOn');
  if (cb) cb.checked = false;
}

function startAuto() {
  const s = stockOf(selected);
  Object.assign(auto, { on: true, sym: s.sym, key: lab.key, params: readParams(), alloc: clamp(parseFloat($('alloc').value) || 50, 1, 100), lastKey: null });
  $('autolog').textContent = '';
  autoLog(`armed: ${STRATS()[auto.key].name} on ${s.sym}, ${auto.alloc}% of equity per entry`);
}

// Spend `frac` of equity (capped by cash) on one market buy; returns the order result or null
function buyFraction(a, s, frac) {
  const spend = Math.min(a.cash * 0.98, equityOf(a) * frac), ask = bestAsk(s);
  const qty = s.live ? rq(spend / ask) : Math.floor(spend / ask);
  if (!(qty > 0)) return null;
  return submitOrder(a, s.sym, 'buy', 'market', qty);
}
function sellAll(a, s) {
  const p = a.positions[s.sym];
  if (!p || !(p.qty > 0)) return null;
  return submitOrder(a, s.sym, 'sell', 'market', rq(p.qty - reservedShares(a, s.sym)));
}

// evaluated once per newly closed candle
function autoStep() {
  if (!auto.on) return;
  const s = stockOf(auto.sym);
  if (!s) { stopAuto(); return; }
  const cs = s.candles;
  if (!cs.length) return;
  const key = sameBar(cs[cs.length - 1]) ?? cs.length;
  if (key === auto.lastKey) return;
  auto.lastKey = key;
  const p = account.positions[s.sym], held = !!p && p.qty > 0;
  const sig = STRATS()[auto.key].signal(cs, auto.params, held);
  if (sig === 1 && !held) {
    const r = buyFraction(account, s, auto.alloc / 100);
    autoLog(r ? (r.ok ? 'BUY  ' : 'buy rejected: ') + r.msg : 'buy signal, but not enough cash');
  } else if (sig === 0 && held) {
    const r = sellAll(account, s);
    autoLog(r ? (r.ok ? 'SELL ' : 'sell rejected: ') + r.msg : 'sell signal, nothing to sell');
  }
}

// ---------- bots ----------
let bots = [], botsOn = true;
try { botsOn = localStorage.getItem(BOTS_KEY) !== 'off'; } catch (e) { /* ignore */ }

function initBots(saved) {
  bots = BOT_DEFS.map(d => {
    const s = saved && saved.find(x => x.id === d.id);
    return { ...d, acct: s && s.acct ? s.acct : newAccount(), cool: {} };
  });
}
const botsPayload = () => bots.map(b => ({ id: b.id, acct: b.acct }));

function botStep() {
  if (!botsOn) return;
  for (const b of bots) {
    for (const s of stocks) {
      if (!s.price || (b.cool[s.sym] || 0) > tickCount || !s.book.bids.length) continue;
      const cs = chartCandles(s);
      if (cs.length < 3) continue;
      const p = b.acct.positions[s.sym], held = !!p && p.qty > 0;
      const sig = STRATS()[b.strat].signal(cs, b.params, held);
      let r = null;
      if (sig === 1 && !held) r = buyFraction(b.acct, s, 0.2);
      else if (sig === 0 && held) r = sellAll(b.acct, s);
      if (r && r.ok) {
        b.cool[s.sym] = tickCount + 5;
        if (mode === 'sim') { // in the simulated market, big bot orders nudge the price
          const last = b.acct.history[0], impact = Math.min(0.002, last.qty * last.price / 1e7);
          s.price *= last.side === 'buy' ? 1 + impact : 1 - impact;
        }
      }
    }
  }
}

function botRecord() {
  bots.forEach(b => {
    b.acct.equityCurve.push(equityOf(b.acct));
    if (b.acct.equityCurve.length > 300) b.acct.equityCurve.shift();
  });
}

// when a stock leaves the watchlist, bots holding it are closed out at the last price
function liquidateBots(sym) {
  const s = stockOf(sym);
  bots.forEach(b => {
    const p = b.acct.positions[sym];
    if (p && p.qty > 0 && s) execute(b.acct, sym, 'sell', p.qty, s.price, 'liquidation');
    delete b.acct.positions[sym];
  });
}

function leaderboardRows() {
  const me = { name: 'You', strat: auto.on ? `Human + ${STRATS()[auto.key].name}` : 'Human', acct: account, color: C.text };
  return [me, ...bots.map((b, i) => ({ name: b.name, strat: STRATS()[b.strat].name, acct: b.acct, color: BOT_COLORS[i % BOT_COLORS.length] }))]
    .map(r => ({ ...r, eq: equityOf(r.acct) }))
    .map(r => ({ ...r, ret: r.eq / r.acct.startEquity - 1 }))
    .sort((a, b) => b.eq - a.eq);
}

function renderBots() {
  const rows = leaderboardRows();
  $('leader').innerHTML = '<tr><th>#</th><th>Trader</th><th>Strategy</th><th>Equity</th><th>Return</th><th>Trades</th></tr>' +
    rows.map((r, i) => `<tr><td>${i + 1}</td><td><span class="swatch" style="background:${r.color}"></span>${esc(r.name)}</td><td>${esc(r.strat)}</td><td>${money(r.eq)}</td><td class="${cls(r.ret)}">${pct(r.ret)}</td><td>${r.acct.nTrades || 0}</td></tr>`).join('');
  $('botsState').textContent = botsOn ? '' : 'bots paused';
  drawRace(rows);
}

function drawRace(rows) {
  const cv = $('race');
  if (!cv) return;
  const { g, w, h } = fitCanvas(cv);
  const series = rows.map(r => ({ color: r.color, d: r.acct.equityCurve.map(v => v / r.acct.startEquity - 1) }));
  const len = Math.max(...series.map(s => s.d.length));
  const all = series.flatMap(s => s.d);
  const hi = Math.max(...all, 0.001), lo = Math.min(...all, -0.001), rng = (hi - lo) || 1;
  const y = v => 8 + (h - 16) * (1 - (v - lo) / rng), x = i => 40 + (w - 48) * i / Math.max(1, len - 1);
  g.font = '11px system-ui'; g.lineWidth = 1; g.strokeStyle = C.line; g.fillStyle = C.mute;
  g.setLineDash([4, 4]); g.beginPath(); g.moveTo(40, y(0)); g.lineTo(w - 8, y(0)); g.stroke(); g.setLineDash([]);
  [hi, 0, lo].forEach(v => g.fillText((v * 100).toFixed(2) + '%', 2, y(v) + 4));
  series.forEach(s => {
    g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath();
    const off = len - s.d.length; // curves are right-aligned (newest on the right)
    s.d.forEach((v, i) => (i ? g.lineTo(x(i + off), y(v)) : g.moveTo(x(i + off), y(v))));
    g.stroke();
  });
}

function bindLab() {
  $('strat').innerHTML = Object.entries(STRATS()).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join('');
  $('strat').value = lab.key;
  renderParams();
  renderBtStats();
  $('strat').addEventListener('change', e => { lab.key = e.target.value; renderParams(); });
  $('labBars').addEventListener('change', e => { lab.bars = +e.target.value; });
  $('runBt').addEventListener('click', runBacktest);
  $('autoOn').addEventListener('change', e => { if (e.target.checked) startAuto(); else { auto.on = false; autoLog('stopped'); } });
  $('botsOn').checked = botsOn;
  $('botsOn').addEventListener('change', e => {
    botsOn = e.target.checked;
    try { localStorage.setItem(BOTS_KEY, botsOn ? 'on' : 'off'); } catch (err) { /* ignore */ }
    if (ready) renderBots();
  });
}
