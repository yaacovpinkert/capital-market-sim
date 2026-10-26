'use strict';

// Trading strategies and a backtester. Everything here is pure (no DOM, no globals),
// so the same signal functions drive the backtest, the live auto-trader and the bots.
//
// signal(candles, params, held, end) looks at candles[0..end) and returns
//   1 = go long, 0 = go flat, null = no change.
const Strategies = (() => {
  const I = typeof require !== 'undefined' ? require('./indicators.js') : Indicators;
  const closes = (cs, end, n) => cs.slice(Math.max(0, end - n), end).map(c => c.c);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

  const STRATEGIES = {
    sma_cross: {
      name: 'SMA crossover',
      desc: 'Long while the fast average is above the slow one (with a small dead band to avoid whipsaws).',
      params: [{ k: 'fast', label: 'Fast', v: 5 }, { k: 'slow', label: 'Slow', v: 20 }, { k: 'band', label: 'Band %', v: 0.05, step: 0.01 }],
      signal(cs, p, held, end = cs.length) {
        if (end < p.slow) return null;
        const f = mean(closes(cs, end, p.fast)), s = mean(closes(cs, end, p.slow)), b = p.band / 100;
        if (f > s * (1 + b)) return 1;
        if (f < s * (1 - b)) return 0;
        return null;
      },
    },
    rsi_revert: {
      name: 'RSI mean-reversion',
      desc: 'Buy when RSI drops below the low level (oversold), sell when it recovers above the high level.',
      params: [{ k: 'n', label: 'RSI period', v: 14 }, { k: 'lo', label: 'Buy below', v: 30 }, { k: 'hi', label: 'Sell above', v: 55 }],
      signal(cs, p, held, end = cs.length) {
        if (end <= p.n) return null;
        const r = I.rsi(closes(cs, end, p.n * 8), p.n), last = r[r.length - 1];
        if (last == null) return null;
        if (!held && last < p.lo) return 1;
        if (held && last > p.hi) return 0;
        return null;
      },
    },
    breakout: {
      name: 'Channel breakout',
      desc: 'Buy when price closes above the highest high of the last N candles, exit when it closes below the lowest low of the last M.',
      params: [{ k: 'n', label: 'Entry N', v: 20 }, { k: 'm', label: 'Exit M', v: 10 }],
      signal(cs, p, held, end = cs.length) {
        if (end <= p.n) return null;
        const c = cs[end - 1].c;
        if (!held) {
          let hh = -Infinity;
          for (let i = end - 1 - p.n; i < end - 1; i++) hh = Math.max(hh, cs[i].h);
          return c > hh ? 1 : null;
        }
        let ll = Infinity;
        for (let i = end - 1 - p.m; i < end - 1; i++) ll = Math.min(ll, cs[i].l);
        return c < ll ? 0 : null;
      },
    },
    random: {
      name: 'Random',
      desc: 'Flips a coin. A useful baseline: a good strategy should beat it.',
      params: [{ k: 'p', label: 'Flip chance', v: 0.04, step: 0.01 }],
      signal(cs, p, held) {
        if (Math.random() >= p.p) return null;
        return held ? 0 : 1;
      },
    },
    hodl: {
      name: 'Buy & hold',
      desc: 'Buys once and never sells.',
      params: [],
      signal(cs, p, held) { return held ? null : 1; },
    },
  };

  // Long-only, fully invested when long. A signal seen at the close of bar i is executed at the open of bar i+1.
  function backtest(candles, key, params, opt = {}) {
    const st = STRATEGIES[key];
    const cash0 = opt.cash || 100000, fee = opt.fee ?? 0.0005, slip = opt.slip ?? 0.0005, ppy = opt.periodsPerYear || 252;
    let cash = cash0, qty = 0, entryCost = 0, pending = null, barsLong = 0;
    const eq = [], trades = [];
    let wins = 0, sells = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (pending === 1 && qty === 0) {
        const px = c.o * (1 + slip);
        qty = cash / (px * (1 + fee));
        entryCost = cash; cash = 0;
        trades.push({ i, t: c.t, side: 'buy', price: px });
      } else if (pending === 0 && qty > 0) {
        const px = c.o * (1 - slip);
        cash = qty * px * (1 - fee);
        sells++; if (cash > entryCost) wins++;
        trades.push({ i, t: c.t, side: 'sell', price: px });
        qty = 0;
      }
      pending = null;
      if (qty > 0) barsLong++;
      eq.push(cash + qty * c.c);
      const sig = st.signal(candles, params, qty > 0, i + 1);
      if (sig === 1 || sig === 0) pending = sig;
    }
    const bh = candles.map(c => cash0 * c.c / candles[0].c);

    const rets = [];
    for (let i = 1; i < eq.length; i++) rets.push(eq[i] / eq[i - 1] - 1);
    const mu = rets.length ? mean(rets) : 0;
    const sd = rets.length ? Math.sqrt(mean(rets.map(r => (r - mu) ** 2))) : 0;
    let peak = -Infinity, maxDD = 0;
    for (const v of eq) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, v / peak - 1); }
    let bhPeak = -Infinity, bhDD = 0;
    for (const v of bh) { bhPeak = Math.max(bhPeak, v); bhDD = Math.min(bhDD, v / bhPeak - 1); }
    const stats = {
      ret: eq[eq.length - 1] / cash0 - 1,
      bhRet: bh[bh.length - 1] / cash0 - 1,
      maxDD, bhDD,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(ppy) : 0,
      trades: trades.length,
      winRate: sells ? wins / sells : null,
      exposure: barsLong / candles.length,
    };
    return { eq, bh, trades, stats };
  }

  return { STRATEGIES, backtest };
})();

if (typeof module !== 'undefined') module.exports = Strategies;
