'use strict';

// Technical indicators. Every function takes an array of numbers and returns an
// array of the same length, with null where there is not enough history yet.
const Indicators = (() => {
  const blank = n => new Array(n).fill(null);

  function sma(v, n) {
    const out = blank(v.length);
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i];
      if (i >= n) sum -= v[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(v, n) {
    const out = blank(v.length);
    if (v.length < n) return out;
    const k = 2 / (n + 1);
    let prev = 0;
    for (let i = 0; i < n; i++) prev += v[i];
    prev /= n;
    out[n - 1] = prev;
    for (let i = n; i < v.length; i++) {
      prev = v[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // Wilder's RSI
  function rsi(c, n = 14) {
    const out = blank(c.length);
    if (c.length <= n) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = c[i] - c[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= n; loss /= n;
    const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
    out[n] = val();
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      gain = (gain * (n - 1) + (d > 0 ? d : 0)) / n;
      loss = (loss * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = val();
    }
    return out;
  }

  function macd(c, fast = 12, slow = 26, signal = 9) {
    const ef = ema(c, fast), es = ema(c, slow);
    const line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const sig = blank(c.length);
    const first = line.findIndex(x => x != null);
    if (first >= 0) ema(line.slice(first), signal).forEach((x, i) => { sig[first + i] = x; });
    const hist = line.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null));
    return { macd: line, signal: sig, hist };
  }

  function bollinger(c, n = 20, k = 2) {
    const mid = sma(c, n), upper = blank(c.length), lower = blank(c.length);
    for (let i = n - 1; i < c.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
    }
    return { mid, upper, lower };
  }

  return { sma, ema, rsi, macd, bollinger };
})();

if (typeof module !== 'undefined') module.exports = Indicators;
