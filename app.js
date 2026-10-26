'use strict';

const START_CASH = 100000;
const COMMISSION = 0.0005; // 0.05% per fill
const TICKS_PER_CANDLE = 6;
const MAX_CANDLES = 80;
const SAVE_KEY = 'capitalsim-sim-v2';
const LIVE_KEY = 'capitalsim-live-v1';
const MODE_KEY = 'capitalsim-mode';
const THEME_KEY = 'capitalsim-theme';
const US_KEY = 'capitalsim-us-v1';
const FH_KEY = 'capitalsim-finnhub-key';
const API = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/stream';
const MIN_NOTIONAL = 10; // live mode: minimum order value in $

const $ = id => document.getElementById(id);
const rq = x => Math.round(x * 1e6) / 1e6; // quantities: 6 decimals
const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fq = (q, d = 6) => (Number.isInteger(q) ? String(q) : q.toFixed(d).replace(/0+$/, '').replace(/\.$/, ''));
const money = n => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fp = (s, x) => x.toFixed(s.dp);          // price with the symbol's decimals
const mp = (s, x) => '$' + fp(s, x);
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

const LIVE_UNIVERSE = [
  { sym: 'BTC', pair: 'btcusdt', name: 'Bitcoin', dp: 2 },
  { sym: 'ETH', pair: 'ethusdt', name: 'Ethereum', dp: 2 },
  { sym: 'SOL', pair: 'solusdt', name: 'Solana', dp: 2 },
  { sym: 'BNB', pair: 'bnbusdt', name: 'BNB', dp: 2 },
  { sym: 'XRP', pair: 'xrpusdt', name: 'XRP', dp: 4 },
  { sym: 'DOGE', pair: 'dogeusdt', name: 'Dogecoin', dp: 5 },
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
let mode = 'live', ready = false, gen = 0, ws = null, wsTimer = null, wsState = 'connecting';

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const r2 = x => Math.round(x * 100) / 100;

const newAccount = () => ({ cash: START_CASH, positions: {}, orders: [], history: [], realized: 0, equityCurve: [START_CASH], startEquity: START_CASH });

function newGame() {
  stocks = UNIVERSE.map(u => {
    const s = { ...u, dp: 2, live: false, open: u.price, volMult: 1, candles: [], cur: null, book: { bids: [], asks: [] } };
    // pre-generate history so the chart isn't empty
    for (let i = 0; i < 40 * TICKS_PER_CANDLE; i++) stepPrice(s);
    s.open = s.price;
    return s;
  });
  account = newAccount();
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
  const tickSz = Math.pow(10, -s.dp);
  const step = Math.max(tickSz, Number((s.price * 0.0006).toFixed(s.dp)));
  const chunk = levels.reduce((a, l) => a + l.q, 0) / levels.length;
  let left = qty, cost = 0, last = levels[levels.length - 1].p;
  for (const lv of levels) {
    const take = Math.min(left, lv.q);
    cost += take * lv.p; left -= take;
    if (!left) break;
  }
  while (left > 0) {
    last = Number((last + (side === 'buy' ? step : -step)).toFixed(s.dp));
    const take = Math.min(left, chunk);
    cost += take * last; left -= take;
  }
  return cost / qty;
}

// ---------- Account ----------
const pos = sym => account.positions[sym] || (account.positions[sym] = { qty: 0, avg: 0 });
const stockOf = sym => stocks.find(s => s.sym === sym);
const reservedCash = () => account.orders.filter(o => o.side === 'buy').reduce((a, o) => a + o.qty * (o.type === 'limit' ? o.price : bestAsk(stockOf(o.sym)) * 1.02), 0);
const reservedShares = sym => rq(account.orders.filter(o => o.side === 'sell' && o.sym === sym).reduce((a, o) => a + o.qty, 0));

function equity() {
  return account.cash + Object.entries(account.positions).reduce((a, [sym, p]) => a + (p.qty && stockOf(sym) ? p.qty * stockOf(sym).price : 0), 0);
}

function execute(sym, side, qty, price, kind) {
  const p = pos(sym);
  const fee = r2(qty * price * COMMISSION);
  let realized = 0;
  if (side === 'buy') {
    account.cash -= qty * price + fee;
    p.avg = (p.avg * p.qty + price * qty) / (p.qty + qty);
    p.qty = rq(p.qty + qty);
  } else {
    account.cash += qty * price - fee;
    realized = (price - p.avg) * qty - fee;
    p.qty = rq(p.qty - qty);
    if (!p.qty) p.avg = 0;
    account.realized += realized;
  }
  account.history.unshift({ t: new Date().toLocaleTimeString(), sym, side, qty, price, kind, fee, realized: side === 'sell' ? realized : null });
  account.history = account.history.slice(0, 100);
}

function placeOrder(sym, side, type, qty, price) {
  const s = stockOf(sym);
  qty = rq(qty);
  if (s.live) {
    if (!(qty > 0)) return err('Enter a quantity greater than 0.');
    if (qty * s.price < MIN_NOTIONAL) return err(`Minimum order value is $${MIN_NOTIONAL}.`);
  } else if (!Number.isInteger(qty) || qty < 1) return err('Quantity must be a whole number ≥ 1.');
  if (type !== 'market' && !(price > 0)) return err('Enter a valid price.');
  if (side === 'sell' && qty > rq(pos(sym).qty - reservedShares(sym))) return err('Not enough shares available to sell (short selling is disabled).');
  if (side === 'buy') {
    const est = qty * (type === 'market' ? marketFill(s, 'buy', qty) : type === 'limit' ? price : Math.max(price, bestAsk(s)));
    if (est * (1 + COMMISSION) > account.cash - reservedCash()) return err('Insufficient buying power.');
  }
  if (type === 'market') {
    const px = Number(marketFill(s, side, qty).toFixed(s.dp));
    execute(sym, side, qty, px, 'market');
    return ok(`Filled ${side} ${fq(qty)} ${sym} @ ${mp(s, px)} (avg, incl. slippage)`);
  }
  if (type === 'limit' && ((side === 'buy' && price >= bestAsk(s)) || (side === 'sell' && price <= bestBid(s)))) {
    const px = side === 'buy' ? bestAsk(s) : bestBid(s);
    execute(sym, side, qty, px, 'limit');
    return ok(`Limit marketable: filled ${fq(qty)} ${sym} @ ${mp(s, px)}`);
  }
  if (type === 'stop' && ((side === 'buy' && price <= s.price) || (side === 'sell' && price >= s.price)))
    return err(side === 'sell' ? 'Sell stop must be below the current price.' : 'Buy stop must be above the current price.');
  account.orders.push({ id: nextOrderId++, sym, side, type, qty, price });
  return ok(`${type} ${side} order placed: ${fq(qty)} ${sym} @ ${mp(s, price)}`);
}

function processOrders() {
  for (const o of [...account.orders]) {
    const s = stockOf(o.sym);
    let fill = null;
    if (o.type === 'limit') {
      if (o.side === 'buy' && bestAsk(s) <= o.price) fill = bestAsk(s);
      if (o.side === 'sell' && bestBid(s) >= o.price) fill = bestBid(s);
    } else if (o.type === 'stop') {
      if (o.side === 'sell' && s.price <= o.price) fill = Number(marketFill(s, 'sell', o.qty).toFixed(s.dp));
      if (o.side === 'buy' && s.price >= o.price) fill = Number(marketFill(s, 'buy', o.qty).toFixed(s.dp));
    }
    if (fill === null) continue;
    account.orders = account.orders.filter(x => x !== o);
    if (o.side === 'buy' && o.qty * fill * (1 + COMMISSION) > account.cash) { flash(`Order #${o.id} rejected: insufficient cash.`, true); continue; }
    execute(o.sym, o.side, o.qty, fill, o.type);
    flash(`${o.type} order #${o.id} filled: ${o.side} ${fq(o.qty)} ${o.sym} @ ${mp(s, fill)}`);
  }
}

// ---------- Simulation loop ----------
function tick() {
  if (!ready) return;
  tickCount++;
  if (mode === 'sim') {
    for (const s of stocks) {
      if (Math.random() < 0.004) {
        const n = NEWS[Math.floor(Math.random() * NEWS.length)];
        s.price *= 1 + n.shock; s.volMult = n.vol;
        $('news').innerHTML = `<b>NEWS:</b> ${s.name} (${s.sym}) ${n.text}.`;
      }
      stepPrice(s);
      buildBook(s);
    }
  }
  if (mode === 'us') pollUs();
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

// ---------- Theme ----------
let C = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  C = { mute: v('--mute'), line: v('--line'), up: v('--up'), down: v('--down'), ma: v('--ma'), accent: v('--accent'), order: v('--order') };
}
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
  $('theme').textContent = t === 'dark' ? '☀ Light mode' : '🌙 Dark mode';
  readTheme();
  if (ready) render();
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
  if (!ready) return;
  if (mode === 'live') $('news').innerHTML = `<b>LIVE</b> Binance public market data · ${wsState} · orders are paper-traded against the real order book`;
  if (mode === 'us' && fhKey) $('news').innerHTML = `<b>LIVE</b> US stock quotes via Finnhub (real prices, depth is synthesised)${usStatus ? ` · <span class="down">${usStatus}</span>` : ''}${marketNote(stockOf(selected))}`;
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
    return `<div class="tick ${x.sym === selected ? 'sel' : ''}" data-sym="${x.sym}">${mode === 'us' ? `<button class="x rm" data-rm="${x.sym}" title="Remove">✕</button>` : ''}<b>${x.sym}</b>${mp(x, x.price)}<br><small class="${cls(ch)}">${ch >= 0 ? '▲' : '▼'} ${ch.toFixed(2)}%</small></div>`;
  }).join('');

  $('chartTitle').textContent = `${s.sym} · ${s.name}`;
  $('chartPrice').innerHTML = `<span class="${cls(s.price - s.open)}">${mp(s, s.price)}</span>`;
  drawChart(s);

  const maxQ = Math.max(...s.book.bids.map(l => l.q), ...s.book.asks.map(l => l.q));
  const row = (l, c) => `<tr><td class="${c}">${fp(s, l.p)}</td><td>${fq(l.q, 4)}</td><td style="width:40%"><div style="height:8px;border-radius:2px;background:var(--${c});opacity:.55;width:${l.q / maxQ * 100}%"></div></td></tr>`;
  $('book').innerHTML = '<tr><th>Price</th><th>Size</th><th></th></tr>' +
    [...s.book.asks].reverse().map(l => row(l, 'down')).join('') +
    `<tr><td colspan="3" style="text-align:center;color:var(--mute)">spread ${fp(s, bestAsk(s) - bestBid(s))}</td></tr>` +
    s.book.bids.map(l => row(l, 'up')).join('');

  const held = Object.entries(account.positions).filter(([, p]) => p.qty > 0);
  $('positions').innerHTML = '<tr><th>Sym</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&amp;L</th></tr>' +
    (held.map(([sym, p]) => {
      const st = stockOf(sym), u = (st.price - p.avg) * p.qty;
      return `<tr><td>${sym}</td><td>${fq(p.qty)}</td><td>${fp(st, p.avg)}</td><td>${fp(st, st.price)}</td><td class="${cls(u)}">${money(u)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--mute)">No positions</td></tr>');

  $('orders').innerHTML = '<tr><th>#</th><th>Order</th><th>Price</th><th></th></tr>' +
    (account.orders.map(o => `<tr><td>${o.id}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side} ${fq(o.qty)} ${o.sym} (${o.type})</td><td>${fp(stockOf(o.sym), o.price)}</td><td><button class="x" data-cancel="${o.id}">✕</button></td></tr>`).join('') ||
      '<tr><td colspan="4" style="color:var(--mute)">No open orders</td></tr>');

  $('history').innerHTML = '<tr><th>Time</th><th>Sym</th><th>Side</th><th>Qty</th><th>Price</th><th>Type</th><th>Fee</th><th>Realized</th></tr>' +
    (account.history.slice(0, 12).map(h => `<tr><td>${h.t}</td><td>${h.sym}</td><td class="${h.side === 'buy' ? 'up' : 'down'}">${h.side}</td><td>${fq(h.qty)}</td><td>${fp(stockOf(h.sym), h.price)}</td><td>${h.kind}</td><td>${h.fee.toFixed(2)}</td><td class="${cls(h.realized)}">${h.realized == null ? '–' : money(h.realized)}</td></tr>`).join('') ||
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
  g.font = '11px system-ui'; g.fillStyle = C.mute; g.strokeStyle = C.line; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = bot + (top - bot) * i / 4, yy = y(v);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(w - padR, yy); g.stroke();
    g.fillText(v.toFixed(s.dp), w - padR + 6, yy + 4);
  }
  cs.forEach((c, i) => {
    const x = i * cw + cw / 2, up = c.c >= c.o;
    g.strokeStyle = g.fillStyle = up ? C.up : C.down;
    g.beginPath(); g.moveTo(x, y(c.h)); g.lineTo(x, y(c.l)); g.stroke();
    const yt = y(Math.max(c.o, c.c)), hh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    g.fillRect(x - cw * 0.35, yt, cw * 0.7, hh);
  });
  // 10-period moving average
  g.strokeStyle = C.ma; g.lineWidth = 1.5; g.beginPath();
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
  if (p && p.qty > 0) line(p.avg, C.accent, `avg cost ${fp(s, p.avg)}`);
  account.orders.filter(o => o.sym === s.sym).forEach(o => line(o.price, C.order, `${o.type} ${o.side} #${o.id}`));
  g.lineWidth = 1;
}

function drawEquity() {
  const { g, w, h } = fitCanvas($('eqchart'));
  const d = account.equityCurve;
  const hi = Math.max(...d, account.startEquity), lo = Math.min(...d, account.startEquity), rng = (hi - lo) || 1;
  const y = v => h - 4 - (h - 8) * (v - lo) / rng;
  g.strokeStyle = C.line; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(0, y(account.startEquity)); g.lineTo(w, y(account.startEquity)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = d[d.length - 1] >= account.startEquity ? C.up : C.down; g.lineWidth = 2; g.beginPath();
  d.forEach((v, i) => { const x = i / Math.max(1, d.length - 1) * w; i ? g.lineTo(x, y(v)) : g.moveTo(x, y(v)); });
  g.stroke();
}

// ---------- Ticket ----------
let side = 'buy';
function updateEstimate() {
  const s = stockOf(selected), qty = parseInt($('qty').value, 10) || 0, type = $('otype').value;
  $('priceRow').hidden = type === 'market';
  $('oprice').step = Math.pow(10, -s.dp);
  if (document.activeElement !== $('oprice') && type !== 'market' && !$('oprice').dataset.touched)
    $('oprice').value = fp(s, side === 'buy' ? bestBid(s) : bestAsk(s));
  const px = type === 'market' ? (qty > 0 ? marketFill(s, side, qty) : s.price) : parseFloat($('oprice').value) || 0;
  $('est').textContent = qty > 0 ? `Est. ${type === 'market' ? 'value' : 'at limit'}: ${money(px * qty)} · fee ≈ ${money(px * qty * COMMISSION)}` : '';
  $('submit').textContent = `Place ${side} order · ${selected}`;
}

function bind() {
  $('ticker').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) return removeTicker(rm.dataset.rm);
    const t = e.target.closest('[data-sym]');
    if (t) { selected = t.dataset.sym; delete $('oprice').dataset.touched; setDefaultQty(); render(); }
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
  $('mode').addEventListener('change', e => startMode(e.target.value));
  $('theme').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('keysave').addEventListener('click', async () => {
    const k = $('keyinput').value.trim();
    if (!k) return;
    const old = fhKey; fhKey = k;
    try {
      await fhQuote('AAPL');
      try { localStorage.setItem(FH_KEY, k); } catch (e) { /* ignore */ }
      startMode('us');
    } catch (e) { fhKey = old; $('keymsg').textContent = e.message; }
  });
  const sbox = $('search'), sres = $('results');
  const showResults = () => {
    const hits = searchTickers(sbox.value);
    sres.hidden = !sbox.value.trim();
    sres.innerHTML = !tickerDb ? '<div class="hit">Loading symbol list…</div>' : hits.length ? hits.map(h => `<div class="hit" data-add="${esc(h.s)}" data-name="${esc(h.n)}"><b>${esc(h.s)}</b> <small>${h.x}</small> ${esc(h.n)}</div>`).join('') : '<div class="hit">No matches</div>';
  };
  sbox.addEventListener('focus', () => loadTickers().then(showResults).catch(e => { sres.hidden = false; sres.innerHTML = `<div class="hit">Could not load symbol list (${e.message})</div>`; }));
  sbox.addEventListener('input', showResults);
  sres.addEventListener('click', e => {
    const h = e.target.closest('[data-add]');
    if (!h) return;
    sres.hidden = true; sbox.value = '';
    addTicker(h.dataset.add, h.dataset.name);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) sres.hidden = true; });
  $('reset').addEventListener('click', () => {
    if (!confirm('Reset this account?')) return;
    if (mode === 'sim') newGame(); else { account = newAccount(); nextOrderId = 1; }
    save(); render();
  });
  window.addEventListener('resize', render);
}

// ---------- US stocks: ticker search (GitHub-hosted lists) + Finnhub quotes (your own free key) ----------
const TICKER_LISTS = ['nasdaq', 'nyse', 'amex'].map(x => `https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/${x}/${x}_full_tickers.json`);
const FH = 'https://finnhub.io/api/v1';
const DEFAULT_WATCH = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY'];
let tickerDb = null, tickerLoad = null, fhKey = '';
try { fhKey = localStorage.getItem(FH_KEY) || ''; } catch (e) { /* ignore */ }

function loadTickers() {
  if (tickerDb) return Promise.resolve(tickerDb);
  if (!tickerLoad) tickerLoad = Promise.all(TICKER_LISTS.map((u, i) => fetch(u).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(rows => rows.map(r => ({ s: r.symbol.trim(), n: r.name, x: ['NASDAQ', 'NYSE', 'AMEX'][i] })))))
    .then(parts => (tickerDb = parts.flat().filter(t => /^[A-Z.\/-]{1,6}$/.test(t.s))))
    .catch(e => { tickerLoad = null; throw e; });
  return tickerLoad;
}

function searchTickers(q) {
  q = q.trim().toLowerCase();
  if (!q || !tickerDb) return [];
  const score = t => {
    const sy = t.s.toLowerCase();
    if (sy === q) return 0;
    if (sy.startsWith(q)) return 1;
    if (t.n.toLowerCase().startsWith(q)) return 2;
    return t.n.toLowerCase().includes(q) ? 3 : 9;
  };
  return tickerDb.map(t => [score(t), t]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || a[1].s.length - b[1].s.length).slice(0, 8).map(x => x[1]);
}

const fhSym = sym => sym.replace('/', '.');
async function fhQuote(sym) {
  const r = await fetch(`${FH}/quote?symbol=${encodeURIComponent(fhSym(sym))}&token=${encodeURIComponent(fhKey)}`);
  if (r.status === 401 || r.status === 403) throw new Error('Invalid or unauthorised Finnhub key');
  if (r.status === 429) throw new Error('Finnhub rate limit reached, slowing down');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function makeUsStock(sym, name) {
  return { sym, name: name || sym, dp: 2, live: false, price: 0, open: 0, lastPoll: 0, quoteT: 0, candles: [], cur: null, book: { bids: [], asks: [] } };
}

const CANDLE_MS = 30000; // candles are built from the quotes seen while this page is open
function applyQuote(s, q) {
  if (!(q.c > 0)) return false;
  s.price = q.c;
  s.open = q.pc > 0 ? q.pc : q.c;
  s.quoteT = (q.t || 0) * 1000;
  s.dp = q.c < 1 ? 4 : 2;
  const bucket = Math.floor(Date.now() / CANDLE_MS);
  if (s.cur && s.cur.t !== bucket) { s.candles.push(s.cur); s.cur = null; }
  if (!s.cur) s.cur = { t: bucket, o: q.c, h: q.c, l: q.c, c: q.c };
  s.cur.h = Math.max(s.cur.h, q.c); s.cur.l = Math.min(s.cur.l, q.c); s.cur.c = q.c;
  while (s.candles.length > MAX_CANDLES) s.candles.shift();
  buildUsBook(s);
  return true;
}

// Free feeds have no Level 2 data, so depth is synthesised around the last real price.
function buildUsBook(s) {
  const spread = Math.max(0.01, Number((s.price * 0.0004).toFixed(s.dp)));
  const step = Math.max(Math.pow(10, -s.dp), Number((s.price * 0.0003).toFixed(s.dp)));
  s.book = { bids: [], asks: [] };
  for (let i = 0; i < 7; i++) {
    s.book.bids.push({ p: Number((s.price - spread / 2 - i * step).toFixed(s.dp)), q: Math.round(100 + Math.random() * 900) });
    s.book.asks.push({ p: Number((s.price + spread / 2 + i * step).toFixed(s.dp)), q: Math.round(100 + Math.random() * 900) });
  }
}

let usStatus = '';
let usBusy = false;
async function pollUs() {
  if (usBusy || !fhKey) return;
  const now = Date.now();
  const due = stocks.map(s => ({ s, over: (now - s.lastPoll) / (s.sym === selected ? 5000 : 20000) })).filter(x => x.over >= 1).sort((a, b) => b.over - a.over)[0];
  if (!due) return;
  const myGen = gen;
  usBusy = true; due.s.lastPoll = now;
  try {
    const ok = applyQuote(due.s, await fhQuote(due.s.sym));
    if (myGen === gen) usStatus = ok ? '' : `No quote data for ${due.s.sym}.`;
  } catch (e) { if (myGen === gen) usStatus = e.message; }
  usBusy = false;
}

async function addTicker(sym, name) {
  if (stocks.some(s => s.sym === sym)) { selected = sym; setDefaultQty(); render(); return; }
  const s = makeUsStock(sym, name);
  try {
    if (!applyQuote(s, await fhQuote(sym))) return flash(`No quote data for ${sym}.`, true);
  } catch (e) { return flash(e.message, true); }
  s.lastPoll = Date.now();
  stocks.push(s); selected = sym;
  setDefaultQty(); save(); render();
}

function removeTicker(sym) {
  if (stocks.length <= 1) return;
  if ((account.positions[sym] && account.positions[sym].qty > 0) || account.orders.some(o => o.sym === sym)) return flash(`Close ${sym} positions and orders before removing it.`, true);
  stocks = stocks.filter(s => s.sym !== sym);
  delete account.positions[sym];
  if (selected === sym) selected = stocks[0].sym;
  save(); render();
}

function marketNote(s) {
  if (!s.quoteT) return '';
  const age = Date.now() - s.quoteT;
  return age > 15 * 60000 ? ` · market closed? last trade ${new Date(s.quoteT).toLocaleString()}` : '';
}

function showKeyPrompt(show) { $('keybox').hidden = !show; }

// ---------- Persistence ----------
function save() {
  if (!ready) return;
  try {
    if (mode === 'sim') localStorage.setItem(SAVE_KEY, JSON.stringify({ stocks, account, selected, nextOrderId }));
    else if (mode === 'us') localStorage.setItem(US_KEY, JSON.stringify({ account, selected, nextOrderId, watch: stocks.map(x => [x.sym, x.name]) }));
    else localStorage.setItem(LIVE_KEY, JSON.stringify({ account, selected, nextOrderId }));
  } catch (e) { /* storage unavailable */ }
}
function readSave(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

// ---------- Live data (Binance public market data: no key, no backend) ----------
async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
const levels = rows => rows.slice(0, 8).map(([p, q]) => ({ p: +p, q: +q }));

async function snapshot(s) {
  const sym = s.pair.toUpperCase();
  const [k, d, t] = await Promise.all([
    get(`/klines?symbol=${sym}&interval=1m&limit=${MAX_CANDLES}`),
    get(`/depth?symbol=${sym}&limit=10`),
    get(`/ticker/24hr?symbol=${sym}`),
  ]);
  const cs = k.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
  s.cur = cs.pop();            // the newest 1m candle is still forming
  s.candles = cs;
  s.book = { bids: levels(d.bids), asks: levels(d.asks) };
  s.price = (bestBid(s) + bestAsk(s)) / 2;
  s.open = +t.openPrice;
}

function applyDepth(s, d) {
  if (!d.bids.length || !d.asks.length) return;
  s.book = { bids: levels(d.bids), asks: levels(d.asks) };
  s.price = (bestBid(s) + bestAsk(s)) / 2;
}

function applyKline(s, k) {
  const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c };
  if (s.cur && s.cur.t !== c.t) s.candles.push(s.cur);
  s.cur = k.x ? null : c;
  if (k.x) s.candles.push(c);
  while (s.candles.length > MAX_CANDLES) s.candles.shift();
}

function closeSocket() {
  clearTimeout(wsTimer);
  if (ws) { ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null; ws.close(); ws = null; }
}

function openSocket(myGen) {
  closeSocket();
  wsState = 'connecting…';
  const streams = stocks.flatMap(s => [`${s.pair}@depth10@1000ms`, `${s.pair}@kline_1m`]).join('/');
  ws = new WebSocket(`${WS}?streams=${streams}`);
  ws.onopen = () => { wsState = 'connected'; };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const s = stocks.find(x => m.stream.startsWith(x.pair + '@'));
    if (!s) return;
    if (m.stream.includes('@depth')) applyDepth(s, m.data); else applyKline(s, m.data.k);
  };
  ws.onclose = () => {
    if (myGen !== gen) return;
    wsState = 'disconnected, retrying…';
    wsTimer = setTimeout(() => openSocket(myGen), 3000);
  };
}

function setDefaultQty() {
  const s = stockOf(selected);
  if (!s.live) { $('qty').value = 10; return; }
  const raw = 1000 / s.price, mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1); // ≈ $1000, 2 significant digits
  $('qty').value = rq(Math.round(raw / mag) * mag);
}

async function startMode(m, persist = true) {
  const myGen = ++gen;
  ready = false;
  clearInterval(timer); closeSocket();
  mode = m;
  if (persist) try { localStorage.setItem(MODE_KEY, m); } catch (e) { /* ignore */ }
  $('mode').value = m;
  $('speed').disabled = m !== 'sim';
  $('qty').step = m === 'live' ? '0.0001' : '1';
  $('qty').min = m === 'live' ? '0' : '1';
  $('searchwrap').hidden = m !== 'us';
  showKeyPrompt(false);
  usStatus = '';
  tickCount = 0;
  if (m === 'sim') {
    const d = readSave(SAVE_KEY);
    if (d && d.stocks && d.account) ({ stocks, account, selected, nextOrderId } = d); else newGame();
    $('news').textContent = 'Markets open. Good luck.';
  } else if (m === 'us') {
    const d = readSave(US_KEY);
    const watch = d && d.watch && d.watch.length ? d.watch : DEFAULT_WATCH.map(x => [x, x]);
    stocks = watch.map(([sym, name]) => makeUsStock(sym, name));
    if (d && d.account) ({ account, nextOrderId } = d); else { account = newAccount(); nextOrderId = 1; }
    selected = d && stockOf(d.selected) ? d.selected : stocks[0].sym;
    if (!fhKey) {
      $('news').textContent = 'US stocks need a free Finnhub API key (it stays in this browser).';
      showKeyPrompt(true);
      ready = false;
      return;
    }
    $('news').textContent = 'Fetching US stock quotes…';
    try {
      await Promise.all(stocks.map(async s => { applyQuote(s, await fhQuote(s.sym)); s.lastPoll = Date.now(); }));
    } catch (e) {
      if (myGen !== gen) return;
      showKeyPrompt(true); $('keymsg').textContent = e.message;
      $('news').textContent = 'Could not load quotes: ' + e.message;
      return;
    }
    if (myGen !== gen) return;
  } else {
    $('news').textContent = 'Connecting to Binance market data…';
    stocks = LIVE_UNIVERSE.map(u => ({ ...u, live: true, price: 0, open: 0, candles: [], cur: null, book: { bids: [], asks: [] } }));
    const d = readSave(LIVE_KEY);
    if (d && d.account) ({ account, selected, nextOrderId } = d); else { account = newAccount(); selected = 'BTC'; nextOrderId = 1; }
    if (!stockOf(selected)) selected = 'BTC';
    try {
      await Promise.all(stocks.map(snapshot));
    } catch (e) {
      if (myGen !== gen) return;
      alert('Could not reach Binance market data (' + e.message + '). Falling back to the simulated market.');
      return startMode('sim', false);
    }
    if (myGen !== gen) return;
    openSocket(myGen);
  }
  ready = true;
  setDefaultQty();
  render();
  setSpeed(m === 'sim' ? +$('speed').value : 1000);
}

bind();
let savedMode = 'live';
try { const m = localStorage.getItem(MODE_KEY); if (m === 'sim' || m === 'us') savedMode = m; } catch (e) { /* ignore */ }
let savedTheme = 'dark';
try { if (localStorage.getItem(THEME_KEY) === 'light') savedTheme = 'light'; } catch (e) { /* ignore */ }
applyTheme(savedTheme);
startMode(savedMode);
