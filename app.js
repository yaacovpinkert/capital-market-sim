'use strict';

const START_CASH = 100000;
const COMMISSION = 0.0005; // 0.05% per fill
const TICKS_PER_CANDLE = 6;
const MAX_CANDLES = 80;
const SAVE_KEY = 'capitalsim-v1';

const $ = id => document.getElementById(id);
const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cls = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// ---------- Market model ----------
const UNIVERSE = [
  { sym: 'NOVA', name: 'Nova Semiconductors', price: 182.4, sigma: 0.004, drift: 0.0001 },
  { sym: 'ARBL', name: 'Arbel Bank', price: 54.2, sigma: 0.0022, drift: 0.00005 },
  { sym: 'TERA', name: 'Terra Energy', price: 76.9, sigma: 0.0035, drift: 0 },
  { sym: 'MEDI', name: 'MediCore Health', price: 121.0, sigma: 0.0028, drift: 0.00008 },
  { sym: 'ZIPY', name: 'Zippy Logistics', price: 23.75, sigma: 0.006, drift: 0 },
  { sym: 'AURM', name: 'Aurum Gold Trust', price: 199.5, sigma: 0.0015, drift: 0.00003 },
];

const NEWS = [
  { text: 'beats earnings expectations', shock: 0.04, vol: 1.6 },
  { text: 'misses earnings expectations', shock: -0.045, vol: 1.6 },
  { text: 'announces a major buyback', shock: 0.025, vol: 1.2 },
  { text: 'faces a regulatory investigation', shock: -0.06, vol: 2 },
  { text: 'wins a big contract', shock: 0.035, vol: 1.3 },
  { text: 'CEO resigns unexpectedly', shock: -0.05, vol: 1.8 },
];

let stocks, account, selected, nextOrderId, tickCount, timer;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const r2 = x => Math.round(x * 100) / 100;

function newGame() {
  stocks = UNIVERSE.map(u => {
    const s = { ...u, open: u.price, volMult: 1, candles: [], cur: null, book: { bids: [], asks: [] } };
    // pre-generate history so the chart isn't empty
    for (let i = 0; i < 40 * TICKS_PER_CANDLE; i++) stepPrice(s);
    s.open = s.price;
    return s;
  });
  account = { cash: START_CASH, positions: {}, orders: [], history: [], realized: 0, equityCurve: [START_CASH], startEquity: START_CASH };
  selected = 'NOVA';
  nextOrderId = 1;
  tickCount = 0;
  stocks.forEach(buildBook);
}

function stepPrice(s) {
  const sig = s.sigma * s.volMult;
  s.price = Math.max(0.5, s.price * Math.exp(s.drift - 0.5 * sig * sig + sig * gauss()));
  s.volMult = 1 + (s.volMult - 1) * 0.97; // volatility decays back to normal
  const p = r2(s.price);
  if (!s.cur) s.cur = { o: p, h: p, l: p, c: p, n: 0 };
  s.cur.h = Math.max(s.cur.h, p);
  s.cur.l = Math.min(s.cur.l, p);
  s.cur.c = p;
  if (++s.cur.n >= TICKS_PER_CANDLE) {
    s.candles.push(s.cur);
    if (s.candles.length > MAX_CANDLES) s.candles.shift();
    s.cur = null;
  }
}

function buildBook(s) {
  const spread = Math.max(0.01, r2(s.price * 0.0008));
  const step = Math.max(0.01, r2(s.price * 0.0006));
  s.book.bids = []; s.book.asks = [];
  for (let i = 0; i < 7; i++) {
    const size = Math.round(40 + Math.random() * 400 * (1 + (i % 3) * 0.3));
    s.book.bids.push({ p: r2(s.price - spread / 2 - i * step), q: size });
    s.book.asks.push({ p: r2(s.price + spread / 2 + i * step), q: Math.round(40 + Math.random() * 400 * (1 + (i % 3) * 0.3)) });
  }
}
const bestBid = s => s.book.bids[0].p;
const bestAsk = s => s.book.asks[0].p;

// Walk the book to fill a market order; beyond the visible depth price keeps stepping away.
function marketFill(s, side, qty) {
  const levels = side === 'buy' ? s.book.asks : s.book.bids;
  const step = Math.max(0.01, r2(s.price * 0.0006));
  let left = qty, cost = 0, last = levels[levels.length - 1].p;
  for (const lv of levels) {
    const take = Math.min(left, lv.q);
    cost += take * lv.p; left -= take;
    if (!left) break;
  }
  while (left > 0) {
    last = r2(last + (side === 'buy' ? step : -step));
    const take = Math.min(left, 500);
    cost += take * last; left -= take;
  }
  return cost / qty;
}

// ---------- Account ----------
const pos = sym => account.positions[sym] || (account.positions[sym] = { qty: 0, avg: 0 });
const stockOf = sym => stocks.find(s => s.sym === sym);
const reservedCash = () => account.orders.filter(o => o.side === 'buy').reduce((a, o) => a + o.qty * (o.type === 'limit' ? o.price : bestAsk(stockOf(o.sym)) * 1.02), 0);
const reservedShares = sym => account.orders.filter(o => o.side === 'sell' && o.sym === sym).reduce((a, o) => a + o.qty, 0);

function equity() {
  return account.cash + Object.entries(account.positions).reduce((a, [sym, p]) => a + p.qty * stockOf(sym).price, 0);
}

function execute(sym, side, qty, price, kind) {
  const p = pos(sym);
  const fee = r2(qty * price * COMMISSION);
  let realized = 0;
  if (side === 'buy') {
    account.cash -= qty * price + fee;
    p.avg = (p.avg * p.qty + price * qty) / (p.qty + qty);
    p.qty += qty;
  } else {
    account.cash += qty * price - fee;
    realized = (price - p.avg) * qty - fee;
    p.qty -= qty;
    if (!p.qty) p.avg = 0;
    account.realized += realized;
  }
  account.history.unshift({ t: new Date().toLocaleTimeString(), sym, side, qty, price, kind, fee, realized: side === 'sell' ? realized : null });
  account.history = account.history.slice(0, 100);
}

function placeOrder(sym, side, type, qty, price) {
  const s = stockOf(sym);
  if (!Number.isInteger(qty) || qty < 1) return err('Quantity must be a whole number ≥ 1.');
  if (type !== 'market' && !(price > 0)) return err('Enter a valid price.');
  if (side === 'sell' && qty > pos(sym).qty - reservedShares(sym)) return err('Not enough shares available to sell (short selling is disabled).');
  if (side === 'buy') {
    const est = qty * (type === 'market' ? marketFill(s, 'buy', qty) : type === 'limit' ? price : Math.max(price, bestAsk(s)));
    if (est * (1 + COMMISSION) > account.cash - reservedCash()) return err('Insufficient buying power.');
  }
  if (type === 'market') {
    const px = r2(marketFill(s, side, qty));
    execute(sym, side, qty, px, 'market');
    return ok(`Filled ${side} ${qty} ${sym} @ ${money(px)} (avg, incl. slippage)`);
  }
  if (type === 'limit' && ((side === 'buy' && price >= bestAsk(s)) || (side === 'sell' && price <= bestBid(s)))) {
    const px = side === 'buy' ? bestAsk(s) : bestBid(s);
    execute(sym, side, qty, px, 'limit');
    return ok(`Limit marketable: filled ${qty} ${sym} @ ${money(px)}`);
  }
  if (type === 'stop' && ((side === 'buy' && price <= s.price) || (side === 'sell' && price >= s.price)))
    return err(side === 'sell' ? 'Sell stop must be below the current price.' : 'Buy stop must be above the current price.');
  account.orders.push({ id: nextOrderId++, sym, side, type, qty, price });
  return ok(`${type} ${side} order placed: ${qty} ${sym} @ ${money(price)}`);
}

function processOrders() {
  for (const o of [...account.orders]) {
    const s = stockOf(o.sym);
    let fill = null;
    if (o.type === 'limit') {
      if (o.side === 'buy' && bestAsk(s) <= o.price) fill = bestAsk(s);
      if (o.side === 'sell' && bestBid(s) >= o.price) fill = bestBid(s);
    } else if (o.type === 'stop') {
      if (o.side === 'sell' && s.price <= o.price) fill = r2(marketFill(s, 'sell', o.qty));
      if (o.side === 'buy' && s.price >= o.price) fill = r2(marketFill(s, 'buy', o.qty));
    }
    if (fill === null) continue;
    account.orders = account.orders.filter(x => x !== o);
    if (o.side === 'buy' && o.qty * fill * (1 + COMMISSION) > account.cash) { flash(`Order #${o.id} rejected: insufficient cash.`, true); continue; }
    execute(o.sym, o.side, o.qty, fill, o.type);
    flash(`${o.type} order #${o.id} filled: ${o.side} ${o.qty} ${o.sym} @ ${money(fill)}`);
  }
}

// ---------- Simulation loop ----------
function tick() {
  tickCount++;
  for (const s of stocks) {
    if (Math.random() < 0.004) {
      const n = NEWS[Math.floor(Math.random() * NEWS.length)];
      s.price *= 1 + n.shock; s.volMult = n.vol;
      $('news').innerHTML = `<b>NEWS:</b> ${s.name} (${s.sym}) ${n.text}.`;
    }
    stepPrice(s);
    buildBook(s);
  }
  processOrders();
  account.equityCurve.push(equity());
  if (account.equityCurve.length > 300) account.equityCurve.shift();
  render();
  if (tickCount % 10 === 0) save();
}

function setSpeed(ms) {
  clearInterval(timer);
  if (ms > 0) timer = setInterval(tick, ms);
}

// ---------- Rendering ----------
function flash(text, bad) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (bad ? 'err' : 'ok');
}
const err = t => (flash(t, true), false);
const ok = t => (flash(t, false), true);

function render() {
  const s = stockOf(selected);
  const eq = equity();
  $('eq').textContent = money(eq);
  $('cash').textContent = money(account.cash);
  const pnl = eq - account.startEquity;
  $('pnl').textContent = money(pnl) + ' (' + (pnl / account.startEquity * 100).toFixed(2) + '%)';
  $('pnl').className = cls(pnl);
  $('rpnl').textContent = money(account.realized);
  $('rpnl').className = cls(account.realized);

  $('ticker').innerHTML = stocks.map(x => {
    const ch = (x.price / x.open - 1) * 100;
    return `<div class="tick ${x.sym === selected ? 'sel' : ''}" data-sym="${x.sym}"><b>${x.sym}</b>${money(x.price)}<br><small class="${cls(ch)}">${ch >= 0 ? '▲' : '▼'} ${ch.toFixed(2)}%</small></div>`;
  }).join('');

  $('chartTitle').textContent = `${s.sym} · ${s.name}`;
  $('chartPrice').innerHTML = `<span class="${cls(s.price - s.open)}">${money(s.price)}</span>`;
  drawChart(s);

  const maxQ = Math.max(...s.book.bids.map(l => l.q), ...s.book.asks.map(l => l.q));
  const row = (l, c) => `<tr><td class="${c}">${l.p.toFixed(2)}</td><td>${l.q}</td><td style="width:40%"><div style="height:8px;border-radius:2px;background:var(--${c});opacity:.55;width:${l.q / maxQ * 100}%"></div></td></tr>`;
  $('book').innerHTML = '<tr><th>Price</th><th>Size</th><th></th></tr>' +
    [...s.book.asks].reverse().map(l => row(l, 'down')).join('') +
    `<tr><td colspan="3" style="text-align:center;color:var(--mute)">spread ${(bestAsk(s) - bestBid(s)).toFixed(2)}</td></tr>` +
    s.book.bids.map(l => row(l, 'up')).join('');

  const held = Object.entries(account.positions).filter(([, p]) => p.qty > 0);
  $('positions').innerHTML = '<tr><th>Sym</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&amp;L</th></tr>' +
    (held.map(([sym, p]) => {
      const u = (stockOf(sym).price - p.avg) * p.qty;
      return `<tr><td>${sym}</td><td>${p.qty}</td><td>${p.avg.toFixed(2)}</td><td>${stockOf(sym).price.toFixed(2)}</td><td class="${cls(u)}">${money(u)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--mute)">No positions</td></tr>');

  $('orders').innerHTML = '<tr><th>#</th><th>Order</th><th>Price</th><th></th></tr>' +
    (account.orders.map(o => `<tr><td>${o.id}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side} ${o.qty} ${o.sym} (${o.type})</td><td>${o.price.toFixed(2)}</td><td><button class="x" data-cancel="${o.id}">✕</button></td></tr>`).join('') ||
      '<tr><td colspan="4" style="color:var(--mute)">No open orders</td></tr>');

  $('history').innerHTML = '<tr><th>Time</th><th>Sym</th><th>Side</th><th>Qty</th><th>Price</th><th>Type</th><th>Fee</th><th>Realized</th></tr>' +
    (account.history.slice(0, 12).map(h => `<tr><td>${h.t}</td><td>${h.sym}</td><td class="${h.side === 'buy' ? 'up' : 'down'}">${h.side}</td><td>${h.qty}</td><td>${h.price.toFixed(2)}</td><td>${h.kind}</td><td>${h.fee.toFixed(2)}</td><td class="${cls(h.realized)}">${h.realized == null ? '–' : money(h.realized)}</td></tr>`).join('') ||
      '<tr><td colspan="8" style="color:var(--mute)">No trades yet</td></tr>');

  drawEquity();
  updateEstimate();
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawChart(s) {
  const { g, w, h } = fitCanvas($('chart'));
  const cs = s.cur ? [...s.candles, s.cur] : s.candles;
  const padR = 52, padB = 4;
  const hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l));
  const rng = (hi - lo) || 1, top = hi + rng * 0.05, bot = lo - rng * 0.05;
  const y = v => (h - padB) * (1 - (v - bot) / (top - bot));
  const cw = (w - padR) / MAX_CANDLES;
  g.font = '11px system-ui'; g.fillStyle = '#8b98a9'; g.strokeStyle = '#263040'; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = bot + (top - bot) * i / 4, yy = y(v);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(w - padR, yy); g.stroke();
    g.fillText(v.toFixed(2), w - padR + 6, yy + 4);
  }
  cs.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c.c >= c.o;
    g.strokeStyle = g.fillStyle = up ? '#26a69a' : '#ef5350';
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const yt = y(Math.max(c.o, c.c)), hh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    g.fillRect(x - cw * 0.35, yt, cw * 0.7, hh);
  });
  // 10-period moving average
  g.strokeStyle = '#f0b429'; g.lineWidth = 1.5; g.beginPath();
  cs.forEach((c, i) => {
    if (i < 9) return;
    const m = cs.slice(i - 9, i + 1).reduce((a, k) => a + k.c, 0) / 10;
    i === 9 ? g.moveTo(i * cw + cw / 2, y(m)) : g.lineTo(i * cw + cw / 2, y(m));
  });
  g.stroke();
  // position avg price + open orders
  const p = account.positions[s.sym];
  const line = (v, col, label) => {
    if (v < bot || v > top) return;
    g.strokeStyle = col; g.setLineDash([5, 4]); g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w - padR, y(v)); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.fillText(label, 6, y(v) - 3);
  };
  if (p && p.qty > 0) line(p.avg, '#3b82f6', `avg cost ${p.avg.toFixed(2)}`);
  account.orders.filter(o => o.sym === s.sym).forEach(o => line(o.price, '#b388ff', `${o.type} ${o.side} #${o.id}`));
  g.lineWidth = 1;
}

function drawEquity() {
  const { g, w, h } = fitCanvas($('eqchart'));
  const d = account.equityCurve;
  const hi = Math.max(...d, account.startEquity), lo = Math.min(...d, account.startEquity), rng = (hi - lo) || 1;
  const y = v => h - 4 - (h - 8) * (v - lo) / rng;
  g.strokeStyle = '#263040'; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(0, y(account.startEquity)); g.lineTo(w, y(account.startEquity)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = d[d.length - 1] >= account.startEquity ? '#26a69a' : '#ef5350'; g.lineWidth = 2; g.beginPath();
  d.forEach((v, i) => { const x = i / Math.max(1, d.length - 1) * w; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
  g.stroke();
}

// ---------- Ticket ----------
let side = 'buy';
function updateEstimate() {
  const s = stockOf(selected), qty = parseInt($('qty').value, 10) || 0, type = $('otype').value;
  $('priceRow').hidden = type === 'market';
  if (document.activeElement !== $('oprice') && type !== 'market' && !$('oprice').dataset.touched)
    $('oprice').value = (side === 'buy' ? bestBid(s) : bestAsk(s)).toFixed(2);
  const px = type === 'market' ? (qty > 0 ? marketFill(s, side, qty) : s.price) : parseFloat($('oprice').value) || 0;
  $('est').textContent = qty > 0 ? `Est. ${type === 'market' ? 'value' : 'at limit'}: ${money(px * qty)} · fee ≈ ${money(px * qty * COMMISSION)}` : '';
  $('submit').textContent = `Place ${side} order · ${selected}`;
}

function bind() {
  $('ticker').addEventListener('click', e => {
    const t = e.target.closest('[data-sym]');
    if (t) { selected = t.dataset.sym; delete $('oprice').dataset.touched; render(); }
  });
  $('sideSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    side = b.dataset.side;
    document.querySelectorAll('#sideSeg button').forEach(x => x.classList.toggle('on', x === b));
    $('submit').className = 'primary ' + side;
    delete $('oprice').dataset.touched;
    updateEstimate();
  });
  $('oprice').addEventListener('input', () => { $('oprice').dataset.touched = 1; });
  $('otype').addEventListener('change', () => { delete $('oprice').dataset.touched; updateEstimate(); });
  $('qty').addEventListener('input', updateEstimate);
  $('submit').addEventListener('click', () => {
    placeOrder(selected, side, $('otype').value, parseInt($('qty').value, 10), parseFloat($('oprice').value));
    render(); save();
  });
  $('orders').addEventListener('click', e => {
    const id = e.target.dataset.cancel;
    if (id) { account.orders = account.orders.filter(o => o.id != id); flash(`Order #${id} cancelled.`); render(); save(); }
  });
  $('speed').addEventListener('change', e => setSpeed(+e.target.value));
  $('reset').addEventListener('click', () => {
    if (confirm('Reset account and market?')) { newGame(); save(); render(); }
  });
  window.addEventListener('resize', render);
}

// ---------- Persistence ----------
function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ stocks, account, selected, nextOrderId })); } catch (e) { /* storage unavailable */ }
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!d || !d.stocks || !d.account) return false;
    ({ stocks, account, selected, nextOrderId } = d);
    tickCount = 0;
    return true;
  } catch (e) { return false; }
}

if (!load()) newGame();
bind();
render();
setSpeed(+$('speed').value);
