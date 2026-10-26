
'use strict';

// AGENTE QUANT V5.1
// SCALPING AUTOMATICO EXPERIMENTAL
// SOMENTE SIMULACAO - SEM ORDENS REAIS
// Entrada: 50 USDT
// Meta diaria: 30 USDT
// Perda diaria: 20 USDT
// Maximo: 3 perdas
// Analise: 60 segundos
// Monitoramento: 5 segundos

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = path.join(
  __dirname,
  'quant-unified-state.json'
);

const ASSETS = [
  'BTC','ETH','SOL','BNB','XRP',
  'LINK','AVAX','ADA','DOGE','SUI',
  'NEAR','LTC','TRX','UNI','BCH',
  'DOT','APT','ARB','AAVE','XLM'
];

const DEFAULT = {
  enabled: false,
  stake: 50,
  goal: 30,
  lossLimit: 20,
  maxLosses: 3,
  maxPositions: 1,
  start: '09:00',
  stopPct: 1,
  targetPct: 0.7
};

const FEE = 0.001;
const SLIP = 0.0003;

const SCAN_MS = 60000;
const MONITOR_MS = 5000;
const SIGNAL_MAX_AGE = 120000;
const MAX_HOLD_MS = 12 * 60000;

const TARGET_NET = 0.22;
const STOP_NET = 0.50;

const now = () => new Date().toISOString();
const round = x => Number(Number(x).toFixed(6));

function day(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(date);

  const part = type =>
    parts.find(x => x.type === type)?.value;

  return (
    part('year') + '-' +
    part('month') + '-' +
    part('day')
  );
}

function clock() {
  return new Intl.DateTimeFormat(
    'en-GB',
    {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }
  ).format(new Date());
}

function blank() {
  return {
    settings: { ...DEFAULT },
    cash: 1000,
    day: '',
    startEquity: 1000,
    positions: [],
    trades: [],
    testTrades: [],
    events: [],
    lastScan: null,
    lastAttempt: null,
    lastResults: [],
    lastError: null,
    lastSlot: null,
    lastScanMs: 0,
    openedToday: 0,
    diagnostic: 'Aguardando ativacao',
    usedSignals: {},
    stats: {
      scans: 0,
      signals: 0,
      rejected: 0
    }
  };
}

let st = blank();
let ready = false;
let busy = false;
let pendingSave = Promise.resolve();

function equity() {
  return st.cash + st.positions.reduce(
    (sum, p) =>
      sum +
      p.qty *
      (p.mark || p.entry) *
      (1 - FEE - SLIP),
    0
  );
}

function pnl() {
  return equity() - st.startEquity;
}

function losses() {
  return st.trades.filter(t =>
    t.net < 0 &&
    day(new Date(t.closedAt)) === st.day
  ).length;
}

function log(text, type = 'info') {
  st.events.unshift({
    at: now(),
    text,
    type
  });

  st.events = st.events.slice(0, 120);
}

function save() {
  // Evita gravacoes simultaneas.
  pendingSave = pendingSave
    .catch(() => {})
    .then(async () => {
      const tmp = FILE + '.tmp';

      await fs.writeFile(
        tmp,
        JSON.stringify(st),
        { mode: 0o600 }
      );

      await fs.rename(tmp, FILE);
    });

  return pendingSave;
}

function newDay() {
  const today = day();

  if (today !== st.day) {
    st.day = today;
    st.startEquity = equity();
    st.openedToday = 0;

    log('Novo dia ficticio: ' + today);
  }
}

async function load() {
  try {
    const old = JSON.parse(
      await fs.readFile(FILE, 'utf8')
    );

    if (
      !Number.isFinite(old.cash) ||
      !Array.isArray(old.positions) ||
      !Array.isArray(old.trades)
    ) {
      throw Error('Estado anterior invalido');
    }

    st = {
      ...blank(),
      ...old,
      settings: {
        ...DEFAULT,
        ...old.settings,
        enabled: false,
        stake: 50,
        goal: 30,
        lossLimit: 20,
        maxLosses: 3,
        maxPositions: 1
      },
      usedSignals: old.usedSignals || {},
      stats: {
        scans: 0,
        signals: 0,
        rejected: 0
      },
      lastScanMs: 0
    };

    log('V5.1 carregada; ativacao manual');

  } catch {
    st = blank();

    log(
      'Carteira ficticia inicializada',
      'warning'
    );
  }

  newDay();
  ready = true;
  await save();
}

async function legacy() {
  for (const file of [
    'quant-auto-state.json',
    'quant-scalp-state.json'
  ]) {
    try {
      const data = JSON.parse(
        await fs.readFile(
          path.join(__dirname, file),
          'utf8'
        )
      );

      if (data.settings?.enabled) {
        return file;
      }
    } catch {}
  }

  return null;
}

function blocking() {
  if (!st.settings.enabled) {
    return 'DESLIGADO';
  }

  if (clock() < st.settings.start) {
    return 'AGUARDANDO HORARIO';
  }

  if (losses() >= st.settings.maxLosses) {
    return 'TRAVA: 3 LOSSES';
  }

  if (pnl() <= -st.settings.lossLimit) {
    return 'LIMITE DIARIO DE PERDA';
  }

  if (pnl() >= st.settings.goal) {
    return 'META DIARIA ATINGIDA';
  }

  if (st.positions.length >= 1) {
    return 'POSICAO ABERTA';
  }

  return null;
}

async function binance(endpoint) {
  let failure;

  for (const host of [
    'https://data-api.binance.vision',
    'https://api.binance.com'
  ]) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      8000
    );

    try {
      const response = await fetch(
        host + '/api/v3/' + endpoint,
        {
          signal: controller.signal,
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        throw Error(
          'Binance HTTP ' + response.status
        );
      }

      return await response.json();

    } catch (error) {
      failure = error;

    } finally {
      clearTimeout(timer);
    }
  }

  throw failure || Error('Binance indisponivel');
}

async function book(sym) {
  const data = await binance(
    'ticker/bookTicker?symbol=' +
    sym + 'USDT'
  );

  const ask = Number(data.askPrice);
  const bid = Number(data.bidPrice);

  if (!(ask > 0 && bid > 0)) {
    throw Error('Cotacao invalida');
  }

  return { ask, bid };
}

async function candles(sym, interval) {
  const query = new URLSearchParams({
    symbol: sym + 'USDT',
    interval,
    limit: '75'
  });

  const rows = await binance(
    'klines?' + query
  );

  if (!Array.isArray(rows)) {
    throw Error('Candles invalidos');
  }

  return rows
    .filter(x => Number(x[6]) < Date.now())
    .map(x => ({
      t: Number(x[0]),
      end: Number(x[6]),
      o: Number(x[1]),
      h: Number(x[2]),
      l: Number(x[3]),
      c: Number(x[4]),
      v: Number(x[5])
    }));
}

function ema(values, period) {
  if (values.length < period) {
    return NaN;
  }

  let value = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    value +=
      (values[i] - value) *
      2 / (period + 1);
  }

  return value;
}

function rsi(values) {
  const data = values.slice(-15);

  if (data.length < 15) {
    return 50;
  }

  let gains = 0;
  let lossesValue = 0;

  for (let i = 1; i < data.length; i++) {
    const delta = data[i] - data[i - 1];

    gains += Math.max(delta, 0);
    lossesValue += Math.max(-delta, 0);
  }

  if (!lossesValue) {
    return gains ? 100 : 50;
  }

  return 100 -
    100 / (1 + gains / lossesValue);
}

function analyze(one, five) {
  if (one.length < 45 || five.length < 45) {
    return {
      approved: false,
      score: 0,
      why: 'Historico insuficiente',
      checks: {}
    };
  }

  const b = one.at(-1);
  const previous = one.at(-2);

  const c1 = one.map(x => x.c);
  const c5 = five.map(x => x.c);

  const ema9m1 = ema(c1, 9);
  const ema21m1 = ema(c1, 21);

  const ema9m5 = ema(c5, 9);
  const ema21m5 = ema(c5, 21);

  const avgVolume =
    one.slice(-21, -1).reduce(
      (sum, x) => sum + x.v,
      0
    ) / 20;

  const volumeRatio =
    b.v / (avgVolume || 1);

  const priorHigh = Math.max(
    ...one.slice(-7, -1).map(x => x.h)
  );

  const strength = rsi(c1);

  const checks = {
    trend5:
      ema9m5 > ema21m5 &&
      c5.at(-1) > ema21m5,

    trend1:
      ema9m1 > ema21m1 &&
      b.c > ema9m1,

    breakout:
      b.c > b.o &&
      b.c > previous.c &&
      b.c > priorHigh,

    volume:
      volumeRatio >= 1.10,

    rsi:
      strength >= 52 &&
      strength <= 76
  };

  const score =
    (checks.trend5 ? 30 : 0) +
    (checks.trend1 ? 25 : 0) +
    (checks.breakout ? 25 : 0) +
    (checks.volume ? 10 : 0) +
    (checks.rsi ? 10 : 0);

  const age = Date.now() - b.end;

  const fresh =
    age >= 0 &&
    age <= SIGNAL_MAX_AGE;

  const approved =
    Object.values(checks).every(Boolean) &&
    fresh;

  const missing = [];

  if (!checks.trend5) {
    missing.push('tendencia 5m');
  }

  if (!checks.trend1) {
    missing.push('tendencia 1m');
  }

  if (!checks.breakout) {
    missing.push('rompimento 1m');
  }

  if (!checks.volume) {
    missing.push('volume');
  }

  if (!checks.rsi) {
    missing.push('RSI');
  }

  if (!fresh) {
    missing.push('sinal antigo');
  }

  return {
    approved,
    score,
    why: approved
      ? 'TODOS OS FILTROS APROVADOS'
      : 'Falta: ' + missing.join(', '),
    setup: 'scalping-1m-5m',
    signalTime: b.t,
    signalCloseTime: b.end,
    signalAgeMs: age,
    checks,
    rsi: round(strength),
    volumeRatio: round(volumeRatio),
    trendConfirmed:
      checks.trend5 && checks.trend1,
    timing1: checks.breakout,
    breakout5: checks.breakout
  };
}

async function universe() {
  const [exchange, volumes, books] =
    await Promise.all([
      binance('exchangeInfo'),
      binance('ticker/24hr'),
      binance('ticker/bookTicker')
    ]);

  const allowed = new Set(
    exchange.symbols
      .filter(x =>
        x.status === 'TRADING' &&
        x.quoteAsset === 'USDT' &&
        x.isSpotTradingAllowed !== false
      )
      .map(x => x.symbol)
  );

  const volMap = new Map(
    volumes.map(x => [
      x.symbol,
      Number(x.quoteVolume)
    ])
  );

  const bookMap = new Map(
    books.map(x => [
      x.symbol,
      {
        ask: Number(x.askPrice),
        bid: Number(x.bidPrice)
      }
    ])
  );

  return ASSETS.map(sym => {
    const key = sym + 'USDT';
    const quote = bookMap.get(key);

    const spread =
      quote?.ask > 0 &&
      quote?.bid > 0
        ? 100 *
          (quote.ask - quote.bid) /
          ((quote.ask + quote.bid) / 2)
        : Infinity;

    return {
      sym,
      quote,
      spread,
      eligible:
        allowed.has(key) &&
        (volMap.get(key) || 0) >=
          5000000 &&
        spread <= 0.08
    };
  });
}

async function closePosition(p) {
  const quote = await book(p.sym);

  p.mark = quote.bid;

  const exit = quote.bid * (1 - SLIP);

  const proceeds =
    p.qty * exit * (1 - FEE);

  const net = proceeds - p.cost;

  const openedAtMs =
    Number.isFinite(p.openedMs)
      ? p.openedMs
      : Date.parse(p.openedAt);

  const age =
    Date.now() -
    (Number.isFinite(openedAtMs)
      ? openedAtMs
      : Date.now());

  let reason = null;

  if (p.setup === 'scalping-1m-5m') {
    if (net >= (p.targetNet ?? TARGET_NET)) {
      reason = 'LUCRO_LIQUIDO';
    } else if (net <= -(p.stopNet ?? STOP_NET)) {
      reason = 'STOP';
    } else if (age >= MAX_HOLD_MS) {
      reason = 'TEMPO_12M';
    }
  } else {
    const stop = p.stopPrice ||
      p.entry *
      (1 - st.settings.stopPct / 100);

    const target = p.targetPrice ||
      p.entry *
      (1 + st.settings.targetPct / 100);

    if (quote.bid <= stop) {
      reason = 'STOP_ANTIGO';
    } else if (quote.bid >= target) {
      reason = 'ALVO_ANTIGO';
    } else if (age >= 48 * 3600000) {
      reason = 'TEMPO_48H';
    }
  }

  if (!reason) {
    return;
  }

  st.cash += proceeds;

  st.positions = st.positions.filter(
    x => x !== p
  );

  st.trades.unshift({
    symbol: p.sym,
    entry: p.entry,
    exit,
    stake: p.cost,
    net,
    openedAt: p.openedAt,
    closedAt: now(),
    reason,
    setup: p.setup
  });

  st.trades = st.trades.slice(0, 500);

  log(
    'VENDA FICTICIA ' +
    p.sym + ': ' +
    round(net) + ' USDT (' +
    reason + ')',
    net >= 0 ? 'profit' : 'loss'
  );
}

async function monitor() {
  for (const p of [...st.positions]) {
    try {
      await closePosition(p);
    } catch (error) {
      st.lastError =
        'Monitor ' +
        p.sym + ': ' +
        error.message;

      log(st.lastError, 'warning');
    }
  }
}

async function scan() {
  st.lastAttempt = now();
  st.diagnostic =
    'Analisando oportunidades 1m/5m';

  const assets = await universe();
  const results = [];

  for (
    let i = 0;
    i < assets.length;
    i += 5
  ) {
    const group = assets.slice(i, i + 5);

    const settled = await Promise.allSettled(
      group.map(async asset => {
        if (!asset.eligible) {
          return {
            sym: asset.sym,
            approved: false,
            score: 0,
            why: 'Liquidez ou spread',
            checks: {}
          };
        }

        const [one, five] = await Promise.all([
          candles(asset.sym, '1m'),
          candles(asset.sym, '5m')
        ]);

        return {
          sym: asset.sym,
          ask: asset.quote.ask,
          spread: asset.spread,
          ...analyze(one, five)
        };
      })
    );

    group.forEach((asset, j) => {
      results.push(
        settled[j].status === 'fulfilled'
          ? settled[j].value
          : {
              sym: asset.sym,
              approved: false,
              score: 0,
              why:
                'ERRO: ' +
                String(
                  settled[j].reason?.message ||
                  'desconhecido'
                ),
              checks: {}
            }
      );
    });
  }

  st.lastResults = results;
  st.lastScan = now();

  st.stats.scans++;

  const approved = results
    .filter(x => x.approved)
    .sort((a, b) =>
      b.score - a.score ||
      a.spread - b.spread
    );

  const candidates = approved.filter(x =>
    st.usedSignals[x.sym] !== x.signalTime
  );

  st.stats.signals += approved.length;
  st.stats.rejected +=
    results.length - approved.length;

  const best = [...results]
    .sort((a, b) =>
      (b.score || 0) -
      (a.score || 0)
    )
    .slice(0, 3);

  const leaders = best.map(x =>
    x.sym + ':' + (x.score || 0)
  ).join(' | ');

  st.diagnostic =
    candidates.length +
    ' oportunidades / 20 moedas' +
    ' | Destaques: ' +
    leaders;

  // Manter diagnostico completo por moeda,
  // sem liberar entradas reprovadas.
  if (approved.length) {
    log(
      'SINAIS APROVADOS: ' +
      approved.map(x => x.sym).join(', '),
      'scan'
    );
  } else {
    log(
      'ANALISE 1M: ' + st.diagnostic,
      'scan'
    );
  }

  if (!candidates.length || blocking()) {
    return;
  }

  for (const pick of candidates) {
    try {
      if (
        st.usedSignals[pick.sym] ===
        pick.signalTime
      ) {
        continue;
      }

      if (
        Date.now() -
        pick.signalCloseTime >
        SIGNAL_MAX_AGE
      ) {
        continue;
      }

      const quote = await book(pick.sym);

      if (quote.ask > pick.ask * 1.001) {
        continue;
      }

      const stake = 50;

      const entry =
        quote.ask * (1 + SLIP);

      const qty = stake / entry;
      const cost = stake * (1 + FEE);

      if (st.cash < cost) {
        st.diagnostic =
          'Saldo ficticio insuficiente';
        return;
      }

      st.cash -= cost;

      st.positions.push({
        sym: pick.sym,
        entry,
        qty,
        cost,
        mark: quote.bid,
        openedAt: now(),
        openedMs: Date.now(),
        setup: 'scalping-1m-5m',
        targetNet: TARGET_NET,
        stopNet: STOP_NET,
        signalTime: pick.signalTime,
        score: pick.score
      });

      st.usedSignals[pick.sym] =
        pick.signalTime;

      st.openedToday++;

      st.diagnostic =
        'COMPRA FICTICIA ' +
        pick.sym + ' - 50 USDT';

      log(st.diagnostic, 'buy');

      return;
    } catch (error) {
      st.lastError = error.message;

      log(
        'Entrada recusada: ' +
        error.message,
        'warning'
      );
    }
  }
}

async function cycle() {
  if (!ready || busy) {
    return;
  }

  busy = true;

  try {
    newDay();

    await monitor();

    const reason = blocking();

    if (reason) {
      st.diagnostic = reason;
      await save();
      return;
    }

    const old = await legacy();

    if (old) {
      st.diagnostic =
        'BLOQUEADO: desligue ' + old;
      await save();
      return;
    }

    if (
      Date.now() - st.lastScanMs >= SCAN_MS
    ) {
      st.lastScanMs = Date.now();

      st.lastSlot = Math.floor(
        Date.now() / SCAN_MS
      );

      await scan();
    }

    await save();
  } catch (error) {
    st.lastError = error.message;
    st.diagnostic =
      'ERRO: ' + error.message;

    log(st.diagnostic, 'warning');

    try {
      await save();
    } catch {}
  } finally {
    busy = false;
  }
}

function state() {
  newDay();

  return {
    ...st,
    lossesToday: losses(),
    netToday: pnl(),
    equity: equity(),
    blocking: blocking(),
    clockBR: clock(),
    working: busy,
    simulation: true,
    realOrders: false,
    storage:
      'Arquivo temporario no Render',
    system:
      'Agente Quant V5.1 - Diagnostico',
    scanInterval: '1m',
    monitorInterval: '5s',
    strategyTimeframe: '1m + 5m',
    profitTargetUSDT: TARGET_NET,
    stopUSDT: STOP_NET
  };
}

function reply(res, status, data) {
  res.writeHead(status, {
    'Content-Type':
      'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

function valid(pin) {
  const secret =
    process.env.QUANT_ACCESS_PIN || '';

  if (
    !secret ||
    typeof pin !== 'string'
  ) {
    return false;
  }

  const a = Buffer.from(secret);
  const b = Buffer.from(pin);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function body(req) {
  let text = '';

  for await (const chunk of req) {
    text += chunk;

    if (text.length > 2048) {
      throw Error('Payload extenso');
    }
  }

  return text ? JSON.parse(text) : {};
}

async function handle(req, res, url) {
  if (
    !url.pathname.startsWith(
      '/api/quant-unified/'
    )
  ) {
    return false;
  }

  if (
    !valid(req.headers['x-quant-pin'])
  ) {
    reply(res, 401, {
      error: 'PIN invalido'
    });

    return true;
  }

  if (!ready) {
    reply(res, 503, {
      error: 'Motor inicializando'
    });

    return true;
  }

  try {
    if (
      req.method === 'GET' &&
      url.pathname ===
        '/api/quant-unified/status'
    ) {
      reply(res, 200, state());
      return true;
    }

    if (req.method !== 'POST') {
      reply(res, 405, {
        error: 'Metodo invalido'
      });

      return true;
    }

    const data = await body(req);

    if (
      url.pathname ===
      '/api/quant-unified/config'
    ) {
      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(
          data.start
        )
      ) {
        throw Error('Horario invalido');
      }

      st.settings.stake = 50;
      st.settings.goal = 30;
      st.settings.lossLimit = 20;
      st.settings.maxLosses = 3;
      st.settings.maxPositions = 1;
      st.settings.start = data.start;

      log('Parametros V5.1 salvos');

      await save();

      reply(res, 200, state());
      return true;
    }

    if (
      url.pathname ===
      '/api/quant-unified/switch'
    ) {
      if (
        typeof data.enabled !== 'boolean'
      ) {
        throw Error('Comando invalido');
      }

      if (data.enabled) {
        const old = await legacy();

        if (old) {
          throw Error(
            'Desligue ' + old
          );
        }
      }

      st.settings.enabled = data.enabled;

      if (data.enabled) {
        st.lastScanMs = 0;
      }

      log(
        data.enabled
          ? 'SCALPING V5.1 ATIVADO'
          : 'SCALPING V5.1 DESLIGADO'
      );

      await save();

      reply(res, 200, state());

      if (data.enabled) {
        queueMicrotask(() =>
          cycle().catch(() => {})
        );
      }

      return true;
    }

    if (
      url.pathname ===
      '/api/quant-unified/test-trade'
    ) {
      if (
        busy ||
        st.positions.length
      ) {
        throw Error(
          'Motor ocupado ou posicao aberta'
        );
      }

      const sym = ASSETS.includes(data.symbol)
        ? data.symbol
        : 'BTC';

      const first = await book(sym);
      const second = await book(sym);

      const stake = 50;
      const entry =
        first.ask * (1 + SLIP);

      const qty = stake / entry;
      const cost = stake * (1 + FEE);

      const exit =
        second.bid * (1 - SLIP);

      const net =
        qty * exit * (1 - FEE) -
        cost;

      const test = {
        symbol: sym,
        entry,
        exit,
        stake,
        cost,
        net,
        openedAt: now(),
        closedAt: now(),
        reason: 'TESTE ISOLADO',
        test: true
      };

      st.testTrades.unshift(test);

      st.testTrades =
        st.testTrades.slice(0, 30);

      log(
        'TESTE ISOLADO ' +
        sym + ' ' +
        round(net) + ' USDT'
      );

      await save();

      reply(res, 200, {
        ...state(),
        test
      });

      return true;
    }

    reply(res, 404, {
      error: 'Rota inexistente'
    });

    return true;

  } catch (error) {
    reply(res, 400, {
      error: error.message
    });

    return true;
  }
}

function start() {
  load()
    .then(() => {
      const timer = setInterval(
        () =>
          cycle().catch(error =>
            console.error(
              'QUANT_V5_1',
              error.message
            )
          ),
        MONITOR_MS
      );

      timer.unref?.();

      log(
        'V5.1 pronto: diagnostico completo, ' +
        'entrada 50, meta 30'
      );
    })
    .catch(error =>
      console.error(
        'QUANT_V5_1_INIT',
        error.message
      )
    );
}

module.exports = {
  handle,
  start
};
