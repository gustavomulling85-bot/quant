
'use strict';

// QUANT V9 - Motor de sinais.
// Somente BUY/HOLD no mercado spot simulado.
// A pontuacao NAO representa probabilidade
// estatistica comprovada de acerto.

const HOLD = reason => ({
  action: 'HOLD',
  confidence_score: 0,
  reason,
  entry_price: 0,
  take_profit: 0,
  stop_loss: 0,
  risk_reward_ratio: 0
});

const last = a => a[a.length - 1];

const finite = n =>
  Number.isFinite(n) && n > 0;

const round = n =>
  Number(n.toFixed(8));

function ema(values, n) {
  if (
    values.length < n ||
    values.some(v => !Number.isFinite(v))
  ) return NaN;

  let v = values.slice(0, n)
    .reduce((a, b) => a + b, 0) / n;

  for (let i = n; i < values.length; i++) {
    v += (values[i] - v) * 2 / (n + 1);
  }

  return v;
}

function rsi(values, n = 14) {
  if (values.length < n + 1) return NaN;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }

  gain /= n;
  loss /= n;

  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    gain = (
      gain * (n - 1) + Math.max(d, 0)
    ) / n;

    loss = (
      loss * (n - 1) + Math.max(-d, 0)
    ) / n;
  }

  if (!loss) return gain ? 100 : 50;

  return 100 - 100 / (1 + gain / loss);
}

function trueRanges(c) {
  return c.map((v, i) =>
    i === 0
      ? v.h - v.l
      : Math.max(
          v.h - v.l,
          Math.abs(v.h - c[i - 1].c),
          Math.abs(v.l - c[i - 1].c)
        )
  );
}

function atr(c, n = 14) {
  const tr = trueRanges(c);

  return tr.length < n
    ? NaN
    : ema(tr, n);
}

function adx(c, n = 14) {
  if (c.length < n * 3 + 1) return NaN;

  const tr = [];
  const plus = [];
  const minus = [];

  for (let i = 1; i < c.length; i++) {
    const up = c[i].h - c[i - 1].h;
    const down = c[i - 1].l - c[i].l;

    tr.push(Math.max(
      c[i].h - c[i].l,
      Math.abs(c[i].h - c[i - 1].c),
      Math.abs(c[i].l - c[i - 1].c)
    ));

    plus.push(
      up > down && up > 0 ? up : 0
    );

    minus.push(
      down > up && down > 0 ? down : 0
    );
  }

  let ts = tr.slice(0, n)
    .reduce((a, b) => a + b, 0);

  let ps = plus.slice(0, n)
    .reduce((a, b) => a + b, 0);

  let ms = minus.slice(0, n)
    .reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = n - 1; i < tr.length; i++) {
    if (i >= n) {
      ts = ts - ts / n + tr[i];
      ps = ps - ps / n + plus[i];
      ms = ms - ms / n + minus[i];
    }

    const p = ts ? 100 * ps / ts : 0;
    const m = ts ? 100 * ms / ts : 0;

    dx.push(
      p + m
        ? 100 * Math.abs(p - m) / (p + m)
        : 0
    );
  }

  if (dx.length < n) return NaN;

  let a = dx.slice(0, n)
    .reduce((x, y) => x + y, 0) / n;

  for (let i = n; i < dx.length; i++) {
    a = (a * (n - 1) + dx[i]) / n;
  }

  return a;
}

function avg(a) {
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : NaN;
}

function analyze(one, five, fifteen, hour, quote = {}) {
  try {

    // FILTRO 1 - CONTEXTO MACRO 15M E 1H

    if (
      ![one, five, fifteen, hour].every(Array.isArray) ||
      one.length < 35 ||
      five.length < 75 ||
      fifteen.length < 215 ||
      hour.length < 215
    ) {
      return HOLD(
        'Historico insuficiente para EMA200'
      );
    }

    const valid = c => c.every(x =>
      finite(x.o) &&
      finite(x.h) &&
      finite(x.l) &&
      finite(x.c) &&
      x.h >= x.l &&
      x.v >= 0
    );

    if (
      ![one, five, fifteen, hour].every(valid)
    ) {
      return HOLD('Vela invalida');
    }

    const c15 = fifteen.map(x => x.c);
    const c1h = hour.map(x => x.c);

    const ema20015 = ema(c15, 200);
    const ema2001h = ema(c1h, 200);
    const ema501h = ema(c1h, 50);

    const rsi15 = rsi(c15);
    const adx15 = adx(fifteen);

    if (!(
      last(c15) > ema20015 &&
      rsi15 >= 45 &&
      rsi15 <= 65 &&
      adx15 >= 20 &&
      last(c1h) > ema2001h &&
      ema501h > ema2001h
    )) {
      return HOLD(
        'Macro 15m/1h nao confirma LONG'
      );
    }

    // FILTRO 2 - LIQUIDEZ E EXAUSTAO 5M

    const prev = five.at(-2);
    const rev = last(five);

    const c5 = five.map(x => x.c);

    const ema50Prev = ema(
      c5.slice(0, -1), 50
    );

    const past = five.slice(-15, -2);

    const priorLow = Math.min(
      ...past.map(x => x.l)
    );

    const sweep =
      prev.l < priorLow &&
      prev.c > priorLow;

    const emaTouch =
      prev.l <= ema50Prev &&
      prev.c >= ema50Prev * 0.996;

    const rsiLow = rsi(
      c5.slice(0, -1)
    );

    const rsiTurn =
      rsi(c5) > rsiLow;

    const volAverage = avg(
      five.slice(-22, -2).map(x => x.v)
    );

    const climax =
      prev.v > 2 * volAverage;

    const body = Math.abs(
      rev.c - rev.o
    );

    const range = Math.max(
      rev.h - rev.l, 1e-12
    );

    const lowerWick =
      Math.min(rev.o, rev.c) - rev.l;

    const reversal =
      rev.c > rev.o &&
      rev.c > prev.c &&
      lowerWick / range >= 0.35 &&
      lowerWick >= body * 0.75 &&
      (rev.h - rev.c) / range < 0.4;

    const atrNow = atr(five);

    const atrPrior = atr(
      five.slice(0, -1)
    );

    const volExpansion =
      atrNow > atrPrior &&
      atrNow > 0;

    if (!(
      (sweep || emaTouch) &&
      rsiLow < 32 &&
      rsiTurn &&
      climax &&
      reversal &&
      volExpansion
    )) {
      return HOLD(
        '5m sem sweep, exaustao, climax ou reversao'
      );
    }

    // FILTRO 3 - CONFIRMACAO CIRURGICA 1M

    const b = last(one);
    const p = one.at(-2);

    const c1 = one.map(x => x.c);

    const fast = ema(c1, 9);
    const slow = ema(c1, 21);

    const fastPrev = ema(
      c1.slice(0, -1), 9
    );

    const slowPrev = ema(
      c1.slice(0, -1), 21
    );

    const mss =
      b.c > p.h &&
      b.c > b.o &&
      b.c > b.o + (b.h - b.l) * 0.5;

    const cross =
      fastPrev <= slowPrev &&
      fast > slow;

    const imbalance = one
      .slice(-11, -1)
      .map(x => Number(x.takerBuyQuote));

    if (
      imbalance.some(x => !Number.isFinite(x)) ||
      !Number.isFinite(b.takerBuyQuote) ||
      !Number.isFinite(b.quoteVolume)
    ) {
      return HOLD(
        'Faltam dados de taker buy e volume'
      );
    }

    const buyAvg = avg(imbalance);

    const sellQuote =
      b.quoteVolume - b.takerBuyQuote;

    const delta =
      b.takerBuyQuote - sellQuote;

    const deltaConfirm =
      b.takerBuyQuote > buyAvg &&
      delta > 0;

    if (!(mss && cross && deltaConfirm)) {
      return HOLD(
        '1m sem MSS, cruzamento EMA ou delta comprador'
      );
    }

    // FILTRO 4 - RISCO, ALVO E CUSTOS

    const ask = Number(quote.ask);
    const bid = Number(quote.bid);

    if (
      !finite(ask) ||
      !finite(bid) ||
      ask < bid
    ) {
      return HOLD(
        'Cotacao bid/ask ausente'
      );
    }

    const spread =
      (ask - bid) / ((ask + bid) / 2);

    if (spread > 0.0008) {
      return HOLD('Spread alto');
    }

    const fee = 0.001;
    const slip = 0.0003;

    const entry =
      ask * (1 + slip);

    const feeBreakevenBid =
      entry * (1 + fee) /
      ((1 - fee) * (1 - slip));

    const stop =
      Math.min(prev.l, rev.l) -
      atrNow * 0.20;

    const riskPct =
      (entry - stop) / entry;

    const tp =
      entry * 1.0075;

    const reward =
      (
        tp * (1 - fee) * (1 - slip) -
        entry * (1 + fee)
      ) / entry;

    if (!(
      riskPct > 0 &&
      riskPct <= 0.015 &&
      reward > 0.001 &&
      stop < entry &&
      tp > feeBreakevenBid
    )) {
      return HOLD(
        'Risco ou alvo nao compensam custos'
      );
    }

    const rr =
      reward / (riskPct + fee + slip);

    if (rr < 0.35) {
      return HOLD(
        'Risco retorno liquido insuficiente'
      );
    }

    // SCORE DE CONFLUENCIA
    // NAO representa taxa real de acerto.

    const score = 90;

    if (score < 85) {
      return HOLD(
        'Pontuacao inferior a 85'
      );
    }

    return {
      action: 'BUY',
      confidence_score: score,

      reason:
        'V9 LONG: 15m RSI ' +
        rsi15.toFixed(1) +
        ' ADX ' +
        adx15.toFixed(1) +
        '; 1h EMA200; 5m ' +
        (sweep ? 'sweep' : 'EMA50') +
        ' + climax/reversao; ' +
        '1m MSS+EMA9/21+delta; RR ' +
        rr.toFixed(2) +
        ' (score nao probabilistico)',

      entry_price: round(entry),
      take_profit: round(tp),
      stop_loss: round(stop),
      risk_reward_ratio: round(rr)
    };

  } catch (e) {
    return HOLD(
      'Erro V9: ' +
      String(e.message).slice(0, 100)
    );
  }
}

module.exports = { analyze };
