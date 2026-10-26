'use strict';

const START_CASH = 100000;
const COMMISSION = 0.0005; // 0.05% per fill
const TICKS_PER_CANDLE = 6;
const MAX_CANDLES = 500;
const SAVE_KEY = 'capitalsim-sim-v2';
const LIVE_KEY = 'capitalsim-live-v1';
const MODE_KEY = 'capitalsim-mode';
const THEME_KEY = 'capitalsim-theme';
const US_KEY = 'capitalsim-us-v1';
const FH_KEY = 'capitalsim-finnhub-key';
const API = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/stream';
const MIN_NOTIONAL = 10; // live mode: minimum order value in $
const MAX_TRACKED = 20;  // most symbols one watchlist can hold

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

// extra fictional companies that can be added to the simulated watchlist
const SIM_POOL = [
  { sym: 'KOLO', name: 'Kolo Telecom', price: 41.3, sigma: 0.0025, drift: 0.00004 },
  { sym: 'BRNA', name: 'Berna Foods', price: 88.1, sigma: 0.0018, drift: 0.00003 },
  { sym: 'PLZA', name: 'Plaza Real Estate', price: 64.7, sigma: 0.0026, drift: 0.00002 },
  { sym: 'QNTM', name: 'Quantum Computing Co.', price: 142.0, sigma: 0.0055, drift: 0.0001 },
  { sym: 'SOLR', name: 'Solaria Energy', price: 33.9, sigma: 0.0045, drift: 0.00005 },
  { sym: 'WAVE', name: 'Wave Media', price: 17.2, sigma: 0.0048, drift: 0 },
  { sym: 'ORCH', name: 'Orchard Agriculture', price: 29.4, sigma: 0.002, drift: 0.00002 },
  { sym: 'FLUX', name: 'Flux Electric Vehicles', price: 96.5, sigma: 0.0058, drift: 0.00006 },
  { sym: 'NIMB', name: 'Nimbus Cloud', price: 215.0, sigma: 0.0042, drift: 0.00009 },
  { sym: 'VRTX', name: 'Vertex Biotech', price: 58.3, sigma: 0.0065, drift: 0.00002 },
];

const CRYPTO_NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', DOGE: 'Dogecoin', ADA: 'Cardano', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot', LTC: 'Litecoin', TRX: 'TRON', MATIC: 'Polygon', SHIB: 'Shiba Inu', PEPE: 'Pepe', TON: 'Toncoin', UNI: 'Uniswap', ATOM: 'Cosmos', NEAR: 'NEAR Protocol', ARB: 'Arbitrum', OP: 'Optimism', SUI: 'Sui', APT: 'Aptos', FIL: 'Filecoin', XLM: 'Stellar', BCH: 'Bitcoin Cash', ETC: 'Ethereum Classic', AAVE: 'Aave', INJ: 'Injective', HBAR: 'Hedera' };
const dpFor = p => (p >= 100 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : p >= 0.1 ? 5 : p >= 0.01 ? 6 : 8); // display decimals by price magnitude

const LIVE_UNIVERSE = [
  { sym: 'BTC', pair: 'btcusdt', name: 'Bitcoin', dp: 2 },
  { sym: 'ETH', pair: 'ethusdt', name: 'Ethereum', dp: 2 },
  { sym: 'SOL', pair: 'solusdt', name: 'Solana', dp: 2 },
  { sym: 'BNB', pair: 'bnbusdt', name: 'BNB', dp: 2 },
  { sym: 'XRP', pair: 'xrpusdt', name: 'XRP', dp: 4 },
  { sym: 'DOGE', pair: 'dogeusdt', name: 'Dogecoin', dp: 5 },
];

const NEWS = [ // text lives in i18n.js as news.0 ... news.5
  { shock: 0.04, vol: 1.6 },
  { shock: -0.045, vol: 1.6 },
  { shock: 0.025, vol: 1.2 },
  { shock: -0.06, vol: 2 },
  { shock: 0.035, vol: 1.3 },
  { shock: -0.05, vol: 1.8 },
];

let stocks, account, selected, nextOrderId, tickCount, timer;
let mode = 'live', tfBusy = false, ready = false, gen = 0, ws = null, wsTimer = null, wsState = 'connecting', wsTf = '1m';
let lastNews = null, newsState = { key: 'news.initial' }, searchDb = null;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const r2 = x => Math.round(x * 100) / 100;

const newAccount = () => ({ cash: START_CASH, positions: {}, orders: [], history: [], realized: 0, equityCurve: [START_CASH], startEquity: START_CASH });

function makeSimStock(u) {
  const s = { ...u, dp: 2, live: false, open: u.price, volMult: 1, candles: [], cur: null, book: { bids: [], asks: [] } };
  // pre-generate history so the chart isn't empty
  for (let i = 0; i < 120 * TICKS_PER_CANDLE; i++) stepPrice(s);
  s.open = s.price;
  buildBook(s);
  return s;
}

function newGame() {
  stocks = UNIVERSE.map(makeSimStock);
  lastNews = null;
  account = newAccount();
  selected = 'NOVA';
  nextOrderId = 1;
  tickCount = 0;
  stocks.forEach(buildBook);
}

function stepPrice(s) {
  const sig = s.sigma * s.volMult, prev = s.price;
  s.price = Math.max(0.5, s.price * Math.exp(s.drift - 0.5 * sig * sig + sig * gauss()));
  s.volMult = 1 + (s.volMult - 1) * 0.97; // volatility decays back to normal
  const p = r2(s.price);
  if (!s.cur) s.cur = { t: (s.seq = (s.seq || 0) + 1), o: p, h: p, l: p, c: p, n: 0, v: 0 };
  s.cur.v = (s.cur.v || 0) + Math.round(50 + Math.random() * 200 + Math.abs(Math.log(s.price / prev)) * 1e5);
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
// Every function takes the account explicitly, so the player and the bots share one order engine.
const stockOf = sym => stocks.find(s => s.sym === sym);
const pos = (a, sym) => a.positions[sym] || (a.positions[sym] = { qty: 0, avg: 0 });
const reservedCash = a => a.orders.filter(o => o.side === 'buy').reduce((t, o) => t + o.qty * (o.type === 'limit' ? o.price : bestAsk(stockOf(o.sym)) * 1.02), 0);
const reservedShares = (a, sym) => rq(a.orders.filter(o => o.side === 'sell' && o.sym === sym).reduce((t, o) => t + o.qty, 0));

function equityOf(a) {
  return a.cash + Object.entries(a.positions).reduce((t, [sym, p]) => t + (p.qty && stockOf(sym) ? p.qty * stockOf(sym).price : 0), 0);
}
const equity = () => equityOf(account);

function execute(a, sym, side, qty, price, kind) {
  const p = pos(a, sym);
  const fee = r2(qty * price * COMMISSION);
  let realized = 0;
  if (side === 'buy') {
    a.cash -= qty * price + fee;
    p.avg = (p.avg * p.qty + price * qty) / (p.qty + qty);
    p.qty = rq(p.qty + qty);
  } else {
    a.cash += qty * price - fee;
    realized = (price - p.avg) * qty - fee;
    p.qty = rq(p.qty - qty);
    if (!p.qty) p.avg = 0;
    a.realized += realized;
  }
  a.nTrades = (a.nTrades || 0) + 1;
  a.history.unshift({ ts: Date.now(), sym, side, qty, price, kind, fee, realized: side === 'sell' ? realized : null });
  a.history = a.history.slice(0, 100);
}

const fail = msg => ({ ok: false, msg });
const done = msg => ({ ok: true, msg });

function submitOrder(a, sym, side, type, qty, price) {
  const s = stockOf(sym);
  qty = rq(qty);
  if (s.live) {
    if (!(qty > 0)) return fail(t('err.qtyPositive'));
    if (qty * s.price < MIN_NOTIONAL) return fail(t('err.minNotional', { n: MIN_NOTIONAL }));
  } else if (!Number.isInteger(qty) || qty < 1) return fail(t('err.qtyWhole'));
  if (type !== 'market' && !(price > 0)) return fail(t('err.price'));
  if (side === 'sell' && qty > rq(pos(a, sym).qty - reservedShares(a, sym))) return fail(t('err.noShares'));
  if (side === 'buy') {
    const est = qty * (type === 'market' ? marketFill(s, 'buy', qty) : type === 'limit' ? price : Math.max(price, bestAsk(s)));
    if (est * (1 + COMMISSION) > a.cash - reservedCash(a)) return fail(t('err.buyingPower'));
  }
  if (type === 'market') {
    const px = Number(marketFill(s, side, qty).toFixed(s.dp));
    execute(a, sym, side, qty, px, 'market');
    return done(t('msg.filled', { side: t('side.' + side), qty: fq(qty), sym, price: mp(s, px) }));
  }
  if (type === 'limit' && ((side === 'buy' && price >= bestAsk(s)) || (side === 'sell' && price <= bestBid(s)))) {
    const px = side === 'buy' ? bestAsk(s) : bestBid(s);
    execute(a, sym, side, qty, px, 'limit');
    return done(t('msg.limitFilled', { qty: fq(qty), sym, price: mp(s, px) }));
  }
  if (type === 'stop' && ((side === 'buy' && price <= s.price) || (side === 'sell' && price >= s.price)))
    return fail(t(side === 'sell' ? 'err.sellStop' : 'err.buyStop'));
  a.orders.push({ id: nextOrderId++, sym, side, type, qty, price });
  return done(t('msg.placed', { type: t('type.' + type), side: t('side.' + side), qty: fq(qty), sym, price: mp(s, price) }));
}

// UI wrapper for the player's account: shows the result in the ticket
function placeOrder(sym, side, type, qty, price) {
  const r = submitOrder(account, sym, side, type, qty, price);
  flash(r.msg, !r.ok);
  return r.ok;
}

function processOrders(a) {
  for (const o of [...a.orders]) {
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
    a.orders = a.orders.filter(x => x !== o);
    if (o.side === 'buy' && o.qty * fill * (1 + COMMISSION) > a.cash) { flash(t('msg.orderRejected', { id: o.id }), true); continue; }
    execute(a, o.sym, o.side, o.qty, fill, o.type);
    flash(t('msg.orderFilled', { type: t('type.' + o.type), id: o.id, side: t('side.' + o.side), qty: fq(o.qty), sym: o.sym, price: mp(s, fill) }));
  }
}

// ---------- Simulation loop ----------
function tick() {
  if (!ready) return;
  tickCount++;
  if (mode === 'sim') {
    for (const s of stocks) {
      if (Math.random() < 0.004) {
        const i = Math.floor(Math.random() * NEWS.length), n = NEWS[i];
        s.price *= 1 + n.shock; s.volMult = n.vol;
        lastNews = { i, sym: s.sym };
      }
      stepPrice(s);
      buildBook(s);
    }
  }
  if (mode === 'us') { pollUs(); if (tickCount % 60 === 0) refreshMarket(); }
  autoStep();
  botStep();
  processOrders(account);
  account.equityCurve.push(equity());
  if (account.equityCurve.length > 300) account.equityCurve.shift();
  botRecord();
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
  C = { text: v('--text'), panel: v('--panel'), mute: v('--mute'), line: v('--line'), up: v('--up'), down: v('--down'), ma: v('--ma'), accent: v('--accent'), order: v('--order') };
}
const syncThemeBtn = () => { $('theme').textContent = t(document.documentElement.dataset.theme === 'dark' ? 'theme.toLight' : 'theme.toDark'); };
function applyTheme(th) {
  document.documentElement.dataset.theme = th;
  try { localStorage.setItem(THEME_KEY, th); } catch (e) { /* ignore */ }
  syncThemeBtn();
  readTheme();
  if (ready) render();
}

// ---------- Language ----------
function setNews(key, params) {
  newsState = { key, params };
  $('news').textContent = t(key, params);
}

function syncSearchUi() {
  $('search').placeholder = t('search.' + mode);
  $('searchwrap').hidden = mode === 'us' && !fhKey;
  $('forgetKeys').hidden = mode !== 'us';
}

function onLangChange() {
  syncThemeBtn();
  syncSearchUi();
  renderLabStatic();
  renderBtStats();
  if (ready) render(); else setNews(newsState.key, newsState.params);
}

// ---------- Rendering ----------
function flash(text, bad) {
  const m = $('msg');
  m.textContent = text;
  m.className = 'msg ' + (bad ? 'err' : 'ok');
}

function render() {
  if (!ready) return;
  if (mode === 'live') $('news').innerHTML = t('banner.live', { state: t('ws.' + wsState, { tf: wsTf }) });
  if (mode === 'sim') {
    const ns = lastNews && stockOf(lastNews.sym);
    $('news').innerHTML = ns ? t('news.item', { name: esc(nameOf(ns)), sym: ns.sym, text: t('news.' + lastNews.i) }) : t('news.initial');
  }
  if (mode === 'us' && fhKey) $('news').innerHTML = usBanner();
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
    return `<div class="tick ${x.sym === selected ? 'sel' : ''}" data-sym="${esc(x.sym)}"><button class="x rm" data-rm="${esc(x.sym)}" title="${esc(t('tick.remove'))}">✕</button><b>${esc(x.sym)}</b>${mp(x, x.price)}<br><small class="${cls(ch)}">${ch >= 0 ? '▲' : '▼'} ${ch.toFixed(2)}%</small></div>`;
  }).join('');

  $('chartTitle').textContent = `${s.sym} · ${nameOf(s)}`;
  $('chartPrice').innerHTML = `<span class="${cls(s.price - s.open)}">${mp(s, s.price)}</span>`;
  drawChart(s);

  const maxQ = Math.max(...s.book.bids.map(l => l.q), ...s.book.asks.map(l => l.q));
  const row = (l, c) => `<tr><td class="${c}">${fp(s, l.p)}</td><td>${fq(l.q, 4)}</td><td style="width:40%"><div style="height:8px;border-radius:2px;background:var(--${c});opacity:.55;width:${l.q / maxQ * 100}%"></div></td></tr>`;
  $('book').innerHTML = `<tr><th>${t('book.price')}</th><th>${t('book.size')}</th><th></th></tr>` +
    [...s.book.asks].reverse().map(l => row(l, 'down')).join('') +
    `<tr><td colspan="3" style="text-align:center;color:var(--mute)">${esc(t('book.spread', { v: fp(s, bestAsk(s) - bestBid(s)) }))}</td></tr>` +
    s.book.bids.map(l => row(l, 'up')).join('');

  const held = Object.entries(account.positions).filter(([, p]) => p.qty > 0);
  $('positions').innerHTML = `<tr><th>${t('pos.sym')}</th><th>${t('pos.qty')}</th><th>${t('pos.avg')}</th><th>${t('pos.last')}</th><th>${t('pos.pnl')}</th></tr>` +
    (held.map(([sym, p]) => {
      const st = stockOf(sym), u = (st.price - p.avg) * p.qty;
      return `<tr><td>${esc(sym)}</td><td>${fq(p.qty)}</td><td>${fp(st, p.avg)}</td><td>${fp(st, st.price)}</td><td class="${cls(u)}">${money(u)}</td></tr>`;
    }).join('') || `<tr><td colspan="5" style="color:var(--mute)">${t('pos.none')}</td></tr>`);

  $('orders').innerHTML = `<tr><th>#</th><th>${t('ord.order')}</th><th>${t('ord.price')}</th><th></th></tr>` +
    (account.orders.map(o => `<tr><td>${o.id}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${esc(t('ord.line', { side: t('side.' + o.side), qty: fq(o.qty), sym: o.sym, type: t('type.' + o.type) }))}</td><td>${fp(stockOf(o.sym), o.price)}</td><td><button class="x" data-cancel="${o.id}">✕</button></td></tr>`).join('') ||
      `<tr><td colspan="4" style="color:var(--mute)">${t('ord.none')}</td></tr>`);

  $('history').innerHTML = `<tr><th>${t('hist.time')}</th><th>${t('hist.sym')}</th><th>${t('hist.side')}</th><th>${t('hist.qty')}</th><th>${t('hist.price')}</th><th>${t('hist.type')}</th><th>${t('hist.fee')}</th><th>${t('hist.realized')}</th></tr>` +
    (account.history.slice(0, 12).map(h => `<tr><td>${h.ts ? new Date(h.ts).toLocaleTimeString(locale()) : h.t}</td><td>${esc(h.sym)}</td><td class="${h.side === 'buy' ? 'up' : 'down'}">${t('side.' + h.side)}</td><td>${fq(h.qty)}</td><td>${stockOf(h.sym) ? fp(stockOf(h.sym), h.price) : h.price}</td><td>${t('type.' + h.kind)}</td><td>${h.fee.toFixed(2)}</td><td class="${cls(h.realized)}">${h.realized == null ? '–' : money(h.realized)}</td></tr>`).join('') ||
      `<tr><td colspan="8" style="color:var(--mute)">${t('hist.none')}</td></tr>`);

  drawEquity();
  renderBots();
  drawBt();
  updateEstimate();
}

function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.direction = lang === 'he' ? 'rtl' : 'ltr';
  return { g, w, h };
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
  const s = stockOf(selected), qty = parseFloat($('qty').value) || 0, type = $('otype').value;
  $('priceRow').hidden = type === 'market';
  $('oprice').step = Math.pow(10, -s.dp);
  if (document.activeElement !== $('oprice') && type !== 'market' && !$('oprice').dataset.touched)
    $('oprice').value = fp(s, side === 'buy' ? bestBid(s) : bestAsk(s));
  const px = type === 'market' ? (qty > 0 ? marketFill(s, side, qty) : s.price) : parseFloat($('oprice').value) || 0;
  $('est').textContent = qty > 0 ? t(type === 'market' ? 'ticket.estValue' : 'ticket.estLimit', { v: money(px * qty), fee: money(px * qty * COMMISSION) }) : '';
  $('submit').textContent = t(side === 'buy' ? 'ticket.submitBuy' : 'ticket.submitSell', { sym: selected });
}

function bind() {
  $('ticker').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) return removeTicker(rm.dataset.rm);
    const tile = e.target.closest('[data-sym]');
    if (tile) { selected = tile.dataset.sym; delete $('oprice').dataset.touched; resetView(); setDefaultQty(); render(); if (mode === 'us') loadUsHistory(stockOf(selected)).then(() => ready && render()); }
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
    placeOrder(selected, side, $('otype').value, parseFloat($('qty').value), parseFloat($('oprice').value));
    render(); save();
  });
  $('orders').addEventListener('click', e => {
    const id = e.target.dataset.cancel;
    if (id) { account.orders = account.orders.filter(o => o.id != id); flash(t('msg.cancelled', { id })); render(); save(); }
  });
  $('speed').addEventListener('change', e => setSpeed(+e.target.value));
  $('mode').addEventListener('change', e => startMode(e.target.value));
  $('tdsave').addEventListener('click', async () => {
    const k = $('tdinput').value.trim();
    if (!k) return;
    try {
      await tdSeries('AAPL', '1d', 1, k);
      tdKey = k; tdStatus = '';
      try { localStorage.setItem(TD_KEY, k); } catch (e) { /* ignore */ }
      $('tdinput').value = ''; $('tdmsg').textContent = '';
      syncToolbar();
      await loadUsHistory(stockOf(selected), true);
      render();
    } catch (e) { $('tdmsg').textContent = e.message; }
  });
  $('forgetKeys').addEventListener('click', () => {
    if (!confirm(t('confirm.forget'))) return;
    try { localStorage.removeItem(FH_KEY); localStorage.removeItem(TD_KEY); } catch (e) { /* ignore */ }
    fhKey = ''; tdKey = ''; tdStatus = '';
    startMode('us');
  });
  $('lang').addEventListener('click', () => setLang(lang === 'he' ? 'en' : 'he'));
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
    const q = sbox.value;
    sres.hidden = !q.trim();
    if (!q.trim()) return;
    const hits = searchList(q, searchDb);
    sres.innerHTML = !searchDb ? `<div class="hit">${t('search.loading')}</div>`
      : hits.length ? hits.map(h => `<div class="hit" data-add="${esc(h.s)}" data-name="${esc(h.n)}"><b>${esc(h.s)}</b> <small>${esc(h.x)}</small> ${esc(h.n)}${stockOf(h.s) ? ` <small>✓ ${t('search.tracked')}</small>` : ''}</div>`).join('')
      : `<div class="hit">${t('search.none')}</div>`;
  };
  sbox.addEventListener('focus', () => loadSearchDb().then(showResults).catch(e => { sres.hidden = false; sres.innerHTML = `<div class="hit">${esc(t('search.failed', { e: e.message }))}</div>`; }));
  sbox.addEventListener('input', showResults);
  sres.addEventListener('click', e => {
    const h = e.target.closest('[data-add]');
    if (!h) return;
    sres.hidden = true; sbox.value = '';
    addTracked(h.dataset.add, h.dataset.name);
  });
  document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) sres.hidden = true; });
  $('reset').addEventListener('click', () => {
    if (!confirm(t('confirm.reset'))) return;
    if (mode === 'sim') newGame(); else { account = newAccount(); nextOrderId = 1; }
    initBots(null); stopAuto();
    save(); render();
  });
  $('tfseg').addEventListener('click', e => { const b = e.target.closest('[data-tf]'); if (b) setTimeframe(b.dataset.tf); });
  bindChart();
  bindLab();
  window.addEventListener('resize', render);
}

// ---------- US stocks: ticker search (GitHub-hosted lists) + Finnhub quotes (your own free key) ----------
const TICKER_LISTS = ['nasdaq', 'nyse', 'amex'].map(x => `https://raw.githubusercontent.com/rreichel3/US-Stock-Symbols/main/${x}/${x}_full_tickers.json`);
const FH = 'https://finnhub.io/api/v1';
const DEFAULT_WATCH = [['AAPL', 'Apple Inc.'], ['MSFT', 'Microsoft Corp.'], ['NVDA', 'NVIDIA Corp.'], ['TSLA', 'Tesla Inc.'], ['AMZN', 'Amazon.com Inc.'], ['SPY', 'SPDR S&P 500 ETF']];
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

// rank by exact symbol, symbol prefix, name prefix, name substring (names: current language + original)
function searchList(q, db) {
  q = q.trim().toLowerCase();
  if (!q || !db) return [];
  const score = it => {
    const sy = it.s.toLowerCase(), names = [it.n, it.alt].filter(Boolean).map(x => x.toLowerCase());
    if (sy === q) return 0;
    if (sy.startsWith(q)) return 1;
    if (names.some(n => n.startsWith(q))) return 2;
    return names.some(n => n.includes(q)) ? 3 : 9;
  };
  return db.map(it => [score(it), it]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || a[1].s.length - b[1].s.length).slice(0, 8).map(x => x[1]);
}
const searchTickers = q => searchList(q, tickerDb);

let cryptoDb = null, cryptoLoad = null;
function loadCryptoPairs() {
  if (cryptoDb) return Promise.resolve(cryptoDb);
  if (!cryptoLoad) cryptoLoad = get('/ticker/price').then(rows => (cryptoDb = rows
    .filter(r => /^[A-Z0-9]{2,12}USDT$/.test(r.symbol) && +r.price > 0)
    .map(r => { const b = r.symbol.slice(0, -4); return { s: b, n: CRYPTO_NAMES[b] || '', x: 'Binance', dp: dpFor(+r.price) }; })
    .filter(x => CRYPTO_NAMES[x.s] || !/^[A-Z0-9]{2,6}(UP|DOWN|BULL|BEAR)$/.test(x.s))))
    .catch(e => { cryptoLoad = null; throw e; });
  return cryptoLoad;
}

// the symbols the search box offers depend on the data mode
function loadSearchDb() {
  const m = mode;
  const p = m === 'us' ? loadTickers() : m === 'live' ? loadCryptoPairs()
    : Promise.resolve(SIM_POOL.concat(UNIVERSE).map(u => ({ s: u.sym, n: nameOf(u), alt: u.name, x: 'SIM' })));
  return p.then(db => (m === mode ? (searchDb = db) : searchDb));
}

// start tracking a symbol (watchlist), whatever the mode
async function addTracked(sym, name) {
  if (stockOf(sym)) { selected = sym; resetView(); setDefaultQty(); render(); return; }
  if (stocks.length >= MAX_TRACKED) return flash(t('msg.maxTracked', { n: MAX_TRACKED }), true);
  if (mode === 'us') return addTicker(sym, name);
  if (mode === 'live') return addCrypto(sym, name);
  addSim(sym);
}

function addSim(sym) {
  const u = SIM_POOL.find(x => x.sym === sym);
  if (!u) return;
  stocks.push(makeSimStock(u));
  selected = sym; resetView(); setDefaultQty(); save(); render();
  flash(t('msg.added', { sym }));
}

async function addCrypto(sym, name) {
  const info = cryptoDb && cryptoDb.find(x => x.s === sym);
  const s = makeLiveStock(sym, name || (info && info.n), info ? info.dp : 4);
  const myGen = gen;
  try { await snapshot(s); } catch (e) { return flash(t('msg.addFailed', { sym, e: e.message }), true); }
  if (myGen !== gen || stockOf(sym)) return;
  s.dp = dpFor(s.price);
  stocks.push(s); selected = sym;
  resetView(); setDefaultQty(); openSocket(myGen); save(); render();
  flash(t('msg.added', { sym }));
}

const makeLiveStock = (sym, name, dp) => ({ sym, pair: sym.toLowerCase() + 'usdt', name: name || sym, dp, live: true, price: 0, open: 0, candles: [], cur: null, book: { bids: [], asks: [] } });

const fhSym = sym => sym.replace('/', '.');
async function fhQuote(sym) {
  const r = await fetch(`${FH}/quote?symbol=${encodeURIComponent(fhSym(sym))}&token=${encodeURIComponent(fhKey)}`);
  if (r.status === 401 || r.status === 403) throw new Error(t('e.badKey'));
  if (r.status === 429) throw new Error(t('e.rateFh'));
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function makeUsStock(sym, name) {
  return { sym, name: name || sym, dp: 2, live: false, price: 0, open: 0, lastPoll: 0, quoteT: 0, histTf: null, histAt: 0, candles: [], cur: null, book: { bids: [], asks: [] } };
}

// ---- time helpers (US market runs on New York time) ----
const TD = 'https://api.twelvedata.com';
const TD_KEY = 'capitalsim-twelvedata-key';
const TD_INTERVAL = { '1m': '1min', '5m': '5min', '1h': '1h', '1d': '1day' };
const TF_MS = { '1m': 60000, '5m': 300000, '1h': 3600000, '1d': 86400000 };
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function nyParts(t) {
  const o = {};
  nyFmt.formatToParts(new Date(t)).forEach(p => { o[p.type] = p.value; });
  return o;
}
// start of the candle containing time t, aligned like Twelve Data's (hourly candles start at :30 = the 9:30 open)
function bucketOf(t, interval) {
  if (interval === '1d') { const p = nyParts(t); return Date.UTC(+p.year, +p.month - 1, +p.day); }
  const ms = TF_MS[interval], off = interval === '1h' ? 1800000 : 0;
  return Math.floor((t - off) / ms) * ms + off;
}
function isRegularSession(t) {
  const p = nyParts(t);
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false;
  const m = +p.hour * 60 + +p.minute;
  return m >= 570 && m < 960; // 09:30-16:00 (holidays are not tracked locally)
}
function msToNextOpen(now = Date.now()) {
  if (isRegularSession(now)) return 0;
  for (let t = Math.ceil(now / 900000) * 900000, i = 0; i < 5 * 96; i++, t += 900000) if (isRegularSession(t)) return t - now;
  return null;
}
const fmtDur = ms => { const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return (d ? d + t('dur.d') + ' ' : '') + (d || h ? h + t('dur.h') + ' ' : '') + (m % 60) + t('dur.m'); };

// Candles are built from the trades' own timestamps, so a closed market (same last trade) adds nothing.
function applyQuote(s, q) {
  if (!(q.c > 0)) return false;
  s.price = q.c;
  s.open = q.pc > 0 ? q.pc : q.c;
  s.dp = q.c < 1 ? 4 : 2;
  s.q = { o: q.o, h: q.h, l: q.l, pc: q.pc };
  const t = (q.t || 0) * 1000;
  if (t > s.quoteT || (t === s.quoteT && s.cur && q.c !== s.cur.c)) { // new trade (timestamps have 1s resolution, so also accept a new price)
    s.quoteT = t;
    const b = bucketOf(t, tf);
    if (!s.cur) s.cur = { t: b, o: q.c, h: q.c, l: q.c, c: q.c };
    else if (b > s.cur.t) {
      // open continues from the previous close only for adjacent candles; after a gap (overnight, weekend) it is the first trade
      const o = b - s.cur.t <= TF_MS[tf] * 1.5 ? s.cur.c : q.c;
      s.candles.push(s.cur);
      s.cur = { t: b, o, h: Math.max(o, q.c), l: Math.min(o, q.c), c: q.c };
    }
    else if (b === s.cur.t) { s.cur.h = Math.max(s.cur.h, q.c); s.cur.l = Math.min(s.cur.l, q.c); s.cur.c = q.c; }
    while (s.candles.length > MAX_CANDLES) s.candles.shift();
  }
  buildUsBook(s);
  return true;
}

// ---- market status ----
let usMarket = null;
async function refreshMarket() {
  try {
    const r = await fetch(`${FH}/stock/market-status?exchange=US&token=${encodeURIComponent(fhKey)}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    usMarket = { isOpen: !!j.isOpen, session: j.session || '', holiday: j.holiday || '' };
  } catch (e) {
    usMarket = { isOpen: isRegularSession(Date.now()), session: '', holiday: '', local: true };
  }
}

function usBanner() {
  const m = usMarket || { isOpen: isRegularSession(Date.now()) }, st = stockOf(selected);
  let h = t('us.head') + ' · ';
  if (m.isOpen) h += `<span class="up">${t('us.open')}</span>`;
  else {
    const d = msToNextOpen(), sess = m.session && (I18N.en['sess.' + m.session] ? t('sess.' + m.session) : m.session);
    h += `<span class="down">${t('us.closed')}</span>${sess ? ` (${esc(sess)})` : ''}${m.holiday ? ` · ${esc(t('us.holiday', { h: m.holiday }))}` : ''} — ${t('us.frozen')}${d ? `; ${t('us.opensIn', { d: fmtDur(d) })}` : ''}. <i>${t('us.crypto')}</i>`;
  }
  if (st && st.quoteT) h += ` · ${esc(t('us.lastTrade', { time: new Date(st.quoteT).toLocaleString(locale()) }))}`;
  if (usStatus) h += ` · <span class="down">${esc(usStatus)}</span>`;
  if (tdStatus) h += ` · <span class="down">${esc(t('us.history', { e: tdStatus }))}</span>`;
  return h + ' · ' + t('us.synth');
}

// ---- real candle history (optional Twelve Data key) ----
let tdKey = '', tdStatus = '', histToken = 0;
try { tdKey = localStorage.getItem(TD_KEY) || ''; } catch (e) { /* ignore */ }

async function tdSeries(sym, interval, size = MAX_CANDLES, key = tdKey) {
  const r = await fetch(`${TD}/time_series?symbol=${encodeURIComponent(fhSym(sym))}&interval=${TD_INTERVAL[interval]}&outputsize=${size}&timezone=UTC&order=asc&apikey=${encodeURIComponent(key)}`);
  const j = await r.json().catch(() => ({}));
  if (j.status === 'error' || !Array.isArray(j.values)) {
    throw new Error(r.status === 429 || j.code === 429 ? t('e.rateTd') : String(j.message || 'HTTP ' + r.status).replace(/\*\*/g, '').slice(0, 110));
  }
  return j.values.map(v => ({ t: Date.parse(v.datetime.length > 10 ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z'), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume }));
}

async function loadUsHistory(s, force) {
  if (!tdKey || !s) return;
  if (!force && s.histTf === tf && Date.now() - s.histAt < 10 * 60000) return;
  const token = s.histReq = ++histToken, myGen = gen, want = tf;
  try {
    const cs = await tdSeries(s.sym, want);
    if (myGen !== gen || token !== s.histReq) return;
    s.cur = cs.pop() || null; s.candles = cs; s.histTf = want; s.histAt = Date.now();
    tdStatus = '';
  } catch (e) {
    if (myGen === gen) tdStatus = e.message;
  }
}

function chartEmptyMessage(s) {
  if (mode !== 'us') return null;
  const lines = [];
  if (!tdKey) lines.push(t('empty.noKey1'), t('empty.noKey2'));
  else if (tdStatus) lines.push(t('empty.err', { e: tdStatus }));
  else lines.push(t('empty.loading'));
  if (usMarket && !usMarket.isOpen) lines.push(t('empty.closed'));
  if (s.q && s.q.o) { const f = v => (+v).toFixed(s.dp); lines.push(t('empty.session', { o: f(s.q.o), h: f(s.q.h), l: f(s.q.l), c: f(s.price), pc: f(s.q.pc) })); }
  return lines;
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
    if (myGen === gen) usStatus = ok ? '' : t('msg.noQuote', { sym: due.s.sym });
  } catch (e) { if (myGen === gen) usStatus = e.message; }
  usBusy = false;
}

async function addTicker(sym, name) {
  if (stocks.some(s => s.sym === sym)) { selected = sym; setDefaultQty(); render(); return; }
  const s = makeUsStock(sym, name);
  try {
    if (!applyQuote(s, await fhQuote(sym))) return flash(t('msg.noQuote', { sym }), true);
  } catch (e) { return flash(e.message, true); }
  s.lastPoll = Date.now();
  stocks.push(s); selected = sym;
  setDefaultQty(); save(); render();
  flash(t('msg.added', { sym }));
  loadUsHistory(s).then(() => ready && render());
}

function removeTicker(sym) {
  if (stocks.length <= 1) return;
  if ((account.positions[sym] && account.positions[sym].qty > 0) || account.orders.some(o => o.sym === sym)) return flash(t('msg.closeFirst', { sym }), true);
  liquidateBots(sym);
  stocks = stocks.filter(s => s.sym !== sym);
  delete account.positions[sym];
  if (selected === sym) selected = stocks[0].sym;
  if (mode === 'live') openSocket(gen);
  save(); render();
}

function showKeyPrompt(show) { $('keybox').hidden = !show; }

// ---------- Persistence ----------
function save() {
  if (!ready) return;
  try {
    if (mode === 'sim') localStorage.setItem(SAVE_KEY, JSON.stringify({ stocks, account, selected, nextOrderId, bots: botsPayload() }));
    else if (mode === 'us') localStorage.setItem(US_KEY, JSON.stringify({ account, selected, nextOrderId, bots: botsPayload(), watch: stocks.map(x => [x.sym, x.name]) }));
    else localStorage.setItem(LIVE_KEY, JSON.stringify({ account, selected, nextOrderId, bots: botsPayload(), watch: stocks.map(x => [x.sym, x.name, x.dp]) }));
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

async function fetchCandles(s, interval) {
  const rows = await get(`/klines?symbol=${s.pair.toUpperCase()}&interval=${interval}&limit=${MAX_CANDLES}`);
  const cs = rows.map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
  return { cur: cs.pop(), candles: cs }; // the newest candle is still forming
}

async function snapshot(s) {
  const sym = s.pair.toUpperCase();
  const [k, d, t] = await Promise.all([
    fetchCandles(s, tf),
    get(`/depth?symbol=${sym}&limit=10`),
    get(`/ticker/24hr?symbol=${sym}`),
  ]);
  Object.assign(s, k);
  s.book = { bids: levels(d.bids), asks: levels(d.asks) };
  s.price = (bestBid(s) + bestAsk(s)) / 2;
  s.open = +t.openPrice;
}

async function setTimeframe(iv) {
  if (iv === tf || !ready || tfBusy) return;
  if (mode === 'us' && tdKey) {
    tf = iv;
    try { localStorage.setItem(TF_KEY, iv); } catch (e) { /* ignore */ }
    resetView(); syncToolbar();
    await loadUsHistory(stockOf(selected), true);
    render();
    return;
  }
  if (mode !== 'live') return;
  const myGen = gen;
  tfBusy = true;
  closeSocket(); // stop old-interval candles arriving while we swap histories
  wsState = 'loading'; wsTf = iv;
  try {
    const loaded = await Promise.all(stocks.map(s => fetchCandles(s, iv)));
    if (myGen !== gen) return;
    stocks.forEach((s, i) => Object.assign(s, loaded[i]));
    tf = iv;
    try { localStorage.setItem(TF_KEY, iv); } catch (e) { /* ignore */ }
    resetView();
  } catch (e) {
    if (myGen === gen) flash(t('msg.tfFailed', { tf: iv, e: e.message }), true);
  } finally {
    tfBusy = false;
  }
  if (myGen !== gen) return;
  syncToolbar();
  openSocket(myGen);
  render();
}

function syncToolbar() {
  $('tfseg').hidden = !(mode === 'live' || (mode === 'us' && !!tdKey));
  $('tdbox').hidden = !(mode === 'us' && !!fhKey && !tdKey);
  document.querySelectorAll('#tfseg button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf));
}

function applyDepth(s, d) {
  if (!d.bids.length || !d.asks.length) return;
  s.book = { bids: levels(d.bids), asks: levels(d.asks) };
  s.price = (bestBid(s) + bestAsk(s)) / 2;
}

function applyKline(s, k) {
  const c = { t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v };
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
  wsState = 'connecting';
  const streams = stocks.flatMap(s => [`${s.pair}@depth10@1000ms`, `${s.pair}@kline_${tf}`]).join('/');
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
    wsState = 'retry';
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
  searchDb = null;
  syncSearchUi();
  showKeyPrompt(false);
  usStatus = '';
  tickCount = 0;
  stopAuto(); resetView(); marks = { sym: null, list: [] }; lab.bt = null; renderBtStats();
  let savedBots = null;
  if (m === 'sim') {
    const d = readSave(SAVE_KEY);
    if (d && d.stocks && d.account) { ({ stocks, account, selected, nextOrderId } = d); savedBots = d.bots; lastNews = null; } else newGame();
    setNews('news.initial');
  } else if (m === 'us') {
    const d = readSave(US_KEY);
    const watch = d && d.watch && d.watch.length ? d.watch : DEFAULT_WATCH;
    stocks = watch.map(([sym, name]) => makeUsStock(sym, name));
    if (d && d.account) { ({ account, nextOrderId } = d); savedBots = d.bots; } else { account = newAccount(); nextOrderId = 1; }
    selected = d && stockOf(d.selected) ? d.selected : stocks[0].sym;
    if (!fhKey) {
      setNews('news.needKey');
      showKeyPrompt(true);
      ready = false;
      return;
    }
    setNews('news.fetching');
    try {
      await Promise.all(stocks.map(async s => { applyQuote(s, await fhQuote(s.sym)); s.lastPoll = Date.now(); }));
    } catch (e) {
      if (myGen !== gen) return;
      showKeyPrompt(true); $('keymsg').textContent = e.message;
      setNews('news.quotesFailed', { e: e.message });
      return;
    }
    if (myGen !== gen) return;
  } else {
    setNews('news.connecting');
    const d = readSave(LIVE_KEY);
    const watch = d && d.watch && d.watch.length ? d.watch : LIVE_UNIVERSE.map(u => [u.sym, u.name, u.dp]);
    stocks = watch.map(([sym, name, dp]) => makeLiveStock(sym, name, dp));
    if (d && d.account) { ({ account, selected, nextOrderId } = d); savedBots = d.bots; } else { account = newAccount(); selected = 'BTC'; nextOrderId = 1; }
    const res = await Promise.allSettled(stocks.map(snapshot)); // one delisted pair must not take the others down
    if (myGen !== gen) return;
    stocks = stocks.filter((x, i) => res[i].status === 'fulfilled');
    if (!stocks.length) {
      alert(t('alert.binance', { e: res[0].reason && res[0].reason.message }));
      return startMode('sim', false);
    }
    if (!stockOf(selected)) selected = stocks[0].sym;
    openSocket(myGen);
  }
  initBots(savedBots);
  syncToolbar();
  ready = true;
  setDefaultQty();
  render();
  setSpeed(m === 'sim' ? +$('speed').value : 1000);
  if (m === 'us') {
    refreshMarket().then(() => ready && render());
    loadUsHistory(stockOf(selected)).then(() => ready && render());
  }
}

bind();
applyI18n();
let savedMode = 'live';
try { const m = localStorage.getItem(MODE_KEY); if (m === 'sim' || m === 'us') savedMode = m; } catch (e) { /* ignore */ }
let savedTheme = 'dark';
try { if (localStorage.getItem(THEME_KEY) === 'light') savedTheme = 'light'; } catch (e) { /* ignore */ }
applyTheme(savedTheme);
startMode(savedMode);
