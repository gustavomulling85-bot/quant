
'use strict';

// AGENTE QUANT V4.1
// ANALISE A CADA MINUTO
// ESTRATEGIA EXPERIMENTAL ROMPIMENTO 4H
// SOMENTE OPERACOES FICTICIAS

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = path.join(__dirname, 'quant-unified-state.json');

const SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP',
  'LINK', 'AVAX', 'ADA', 'DOGE', 'SUI',
  'NEAR', 'LTC', 'TRX', 'UNI', 'BCH',
  'DOT', 'APT', 'ARB', 'AAVE', 'XLM'
];

const DEFAULT = {
  enabled: false,
  stake: 10,
  goal: 50,
  lossLimit: 20,
  maxLosses: 3,
  maxPositions: 1,
  start: '09:00',
  stopPct: 1,
  targetPct: 2.5
};

const FEE = 0.001;
const SLIP = 0.0003;
const ZONE = 'America/Sao_Paulo';
const SCAN_MS = 60000;
const MONITOR_MS = 15000;
const MAX_SIGNAL_AGE_MS = 15 * 60000;

const now = () => new Date().toISOString();
const num = x => Number(Number(x).toFixed(6));

function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function localTime() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());
}

function initialState() {
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
    openedToday: 0,
    diagnostic: 'Aguardando ativacao',
    usedSignals: {},
    lastScanMs: 0
  };
}

let st = initialState();
let ready = false;
let busy = false;
let timer = null;

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
  return st.trades.filter(
    t =>
      t.net < 0 &&
      localDay(new Date(t.closedAt)) === st.day
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

async function save() {
  const tmp = FILE + '.tmp';

  await fs.writeFile(
    tmp,
    JSON.stringify(st),
    { mode: 0o600 }
  );

  await fs.rename(tmp, FILE);
}

function newDay() {
  const today = localDay();

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
      ...initialState(),
      ...old,
      settings: {
        ...DEFAULT,
        ...old.settings,
        enabled: false
      },
      usedSignals: old.usedSignals || {},
      lastScanMs: 0
    };

    log('Reinicio: ativacao manual obrigatoria');
  } catch {
    st = initialState();

    log(
      'Carteira ficticia criada: 1000 USDT',
      'warning'
    );
  }

  newDay();
  ready = true;
  await save();
}

async function legacy() {
  const files = [
    'quant-auto-state.json',
    'quant-scalp-state.json'
  ];

  for (const name of files) {
    try {
      const data = JSON.parse(
        await fs.readFile(
          path.join(__dirname, name),
          'utf8'
        )
      );

      if (data.settings?.enabled) {
        return name;
      }
    } catch {}
  }

  return null;
}

function blocking() {
  if (!st.settings.enabled) {
    return 'DESLIGADO';
  }

  if (localTime() < st.settings.start) {
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

  if (
    st.positions.length >=
    st.settings.maxPositions
  ) {
    return 'POSICAO ABERTA';
  }

  return null;
}

async function binance(endpoint) {
  let lastError;

  for (const host of [
    'https://data-api.binance.vision',
    'https://api.binance.com'
  ]) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      9000
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
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || Error('Binance indisponivel');
}

async function orderBook(sym) {
  const data = await binance(
    'ticker/bookTicker?symbol=' + sym + 'USDT'
  );

  const ask = Number(data.askPrice);
  const bid = Number(data.bidPrice);

  if (!(ask > 0 && bid > 0)) {
    throw Error('Precos invalidos');
  }

  return { ask, bid };
}

async function candles4h(sym) {
  const query = new URLSearchParams({
    symbol: sym + 'USDT',
    interval: '4h',
    limit: '120'
  });

  const rows = await binance(
    'klines?' + query.toString()
  );

  if (!Array.isArray(rows)) {
    throw Error('Resposta de candles invalida');
  }

  // Nunca utilizar um candle ainda aberto.
  return rows
    .filter(row => Number(row[6]) < Date.now())
    .map(row => ({
      t: Number(row[0]),
      closeTime: Number(row[6]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: Number(row[5])
    }));
}

function emaSeries(closes, period) {
  const output = Array(closes.length).fill(NaN);

  if (closes.length < period) {
    return output;
  }

  let value =
    closes.slice(0, period).reduce(
      (sum, x) => sum + x,
      0
    ) / period;

  output[period - 1] = value;

  for (let i = period; i < closes.length; i++) {
    value +=
      (closes[i] - value) *
      (2 / (period + 1));

    output[i] = value;
  }

  return output;
}

function calculateATR(bars) {
  const tr = bars.map((b, i) => {
    if (!i) {
      return b.h - b.l;
    }

    return Math.max(
      b.h - b.l,
      Math.abs(b.h - bars[i - 1].c),
      Math.abs(b.l - bars[i - 1].c)
    );
  });

  let atr =
    tr.slice(1, 15).reduce(
      (sum, x) => sum + x,
      0
    ) / 14;

  for (let i = 15; i < tr.length; i++) {
    atr = (atr * 13 + tr[i]) / 14;
  }

  return atr;
}

function analyze(bars) {
  if (bars.length < 60) {
    return {
      approved: false,
      score: 0,
      why: 'Historico 4h insuficiente'
    };
  }

  const i = bars.length - 1;
  const bar = bars[i];
  const closes = bars.map(b => b.c);

  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);

  const avgVolume =
    bars.slice(i - 20, i).reduce(
      (sum, b) => sum + b.v,
      0
    ) / 20;

  const priorHigh = Math.max(
    ...bars.slice(i - 20, i).map(b => b.h)
  );

  const trend =
    e20[i] > e50[i] &&
    e20[i] > e20[i - 3] &&
    bar.c > e50[i];

  const breakout =
    bar.c > priorHigh &&
    bar.c > bar.o &&
    avgVolume > 0 &&
    bar.v >= 1.35 * avgVolume;

  const atr = calculateATR(bars);

  const approved =
    trend &&
    breakout &&
    Number.isFinite(atr) &&
    atr > 0;

  const ageMs =
    Date.now() - bar.closeTime;

  return {
    approved,
    score: approved
      ? 100
      : (trend ? 50 : 0) +
        (breakout ? 40 : 0),
    why: approved
      ? 'Rompimento 4h confirmado'
      : 'Aguardando tendencia e rompimento com volume',
    atr: num(atr),
    setup: 'rompimento-4h',
    signalTime: bar.t,
    signalCloseTime: bar.closeTime,
    ageMs,
    fresh: ageMs >= 0 &&
      ageMs <= MAX_SIGNAL_AGE_MS,
    volumeRatio: num(
      bar.v / (avgVolume || 1)
    ),
    trendConfirmed: trend,
    breakout5: breakout
  };
}

async function universe() {
  const [exchange, volumes, books] =
    await Promise.all([
      binance('exchangeInfo'),
      binance('ticker/24hr'),
      binance('ticker/bookTicker')
    ]);

  const tradable = new Set(
    exchange.symbols
      .filter(x =>
        x.status === 'TRADING' &&
        x.quoteAsset === 'USDT' &&
        x.isSpotTradingAllowed !== false
      )
      .map(x => x.symbol)
  );

  const volumeMap = new Map(
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

  return SYMBOLS.map(sym => {
    const key = sym + 'USDT';
    const quote = bookMap.get(key);

    const spread =
      quote?.ask > 0 && quote?.bid > 0
        ? 100 *
          (quote.ask - quote.bid) /
          ((quote.ask + quote.bid) / 2)
        : Infinity;

    return {
      sym,
      quote,
      spread,
      eligible:
        tradable.has(key) &&
        (volumeMap.get(key) || 0) >= 5000000 &&
        spread <= 0.10
    };
  });
}

async function closePosition(p) {
  const quote = await orderBook(p.sym);
  p.mark = quote.bid;

  const stop =
    p.stopPrice ||
    p.entry * (1 - st.settings.stopPct / 100);

  const target =
    p.targetPrice ||
    p.entry * (1 + st.settings.targetPct / 100);

  let reason = null;

  if (quote.bid <= stop) {
    reason = 'STOP';
  } else if (quote.bid >= target) {
    reason = 'ALVO';
  } else if (
    Date.now() -
    (p.openedMs || Date.now()) >=
    48 * 3600000
  ) {
    reason = 'TEMPO_48H';
  }

  if (!reason) {
    return;
  }

  const exit = quote.bid * (1 - SLIP);
  const proceeds = p.qty * exit * (1 - FEE);
  const net = proceeds - p.cost;

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
      num(net) + ' USDT (' + reason + ')',
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
  st.diagnostic = 'Analisando 20 moedas';

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
            why: 'Liquidez ou spread inadequado'
          };
        }

        return {
          sym: asset.sym,
          ask: asset.quote.ask,
          spread: asset.spread,
          ...analyze(
            await candles4h(asset.sym)
          )
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
              why:
                'Erro: ' +
                String(
                  settled[j].reason?.message ||
                  'desconhecido'
                )
            }
      );
    });
  }

  st.lastResults = results;
  st.lastScan = now();

  const approved = results.filter(
    x => x.approved
  );

  const candidates = approved
    .filter(x =>
      x.fresh &&
      st.usedSignals[x.sym] !== x.signalTime
    )
    .sort(
      (a, b) => a.spread - b.spread
    );

  st.diagnostic =
    approved.length +
    ' sinais 4h confirmados; ' +
    candidates.length +
    ' entradas recentes disponiveis / ' +
    results.length +
    ' moedas';

  log(
    'ANALISE 1 MINUTO: ' +
      st.diagnostic,
    'scan'
  );

  if (!candidates.length || blocking()) {
    return;
  }

  for (const pick of candidates) {
    try {
      const quote = await orderBook(pick.sym);

      if (
        quote.ask >
        pick.ask * 1.002
      ) {
        continue;
      }

      const stake = Math.min(
        st.settings.stake,
        st.cash / (1 + FEE)
      );

      if (stake < 10) {
        st.diagnostic =
          'Saldo insuficiente';
        return;
      }

      const stop =
        quote.ask - 1.5 * pick.atr;

      const target =
        quote.ask + 2.5 * pick.atr;

      const entry =
        quote.ask * (1 + SLIP);

      if (
        !(stop > 0 &&
          stop < quote.bid &&
          target > entry)
      ) {
        continue;
      }

      // Previne repetir um sinal ja negociado.
      if (
        st.usedSignals[pick.sym] ===
        pick.signalTime
      ) {
        continue;
      }

      const qty = stake / entry;
      const cost = stake * (1 + FEE);

      st.cash -= cost;

      st.positions.push({
        sym: pick.sym,
        entry,
        qty,
        cost,
        mark: quote.bid,
        openedAt: now(),
        openedMs: Date.now(),
        setup: 'rompimento-4h-experimental',
        stopPrice: stop,
        targetPrice: target,
        score: 100,
        signalTime: pick.signalTime
      });

      st.usedSignals[pick.sym] =
        pick.signalTime;

      st.openedToday++;

      st.diagnostic =
        'COMPRA FICTICIA ' +
        pick.sym +
        ' POR ROMPIMENTO 4H';

      log(st.diagnostic, 'buy');

      return;
    } catch (error) {
      st.lastError = error.message;
      log(
        'Entrada recusada: ' + error.message,
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

    // Posicoes continuam monitoradas
    // mesmo se o executor estiver desligado.
    await monitor();

    const blocker = blocking();

    if (blocker) {
      st.diagnostic = blocker;
      await save();
      return;
    }

    const oldBot = await legacy();

    if (oldBot) {
      st.diagnostic =
        'BLOQUEADO: desligue ' + oldBot;
      await save();
      return;
    }

    // VARREDURA A CADA 60 SEGUNDOS.
    // O monitor continua a cada 15 segundos.
    const elapsed =
      Date.now() - st.lastScanMs;

    if (elapsed >= SCAN_MS) {
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
    clockBR: localTime(),
    working: busy,
    simulation: true,
    realOrders: false,
    storage: 'Arquivo temporario no Render',
    system: 'Unified Paper V4.1',
    scanInterval: '1m',
    strategyTimeframe: '4h',
    monitorInterval: '15s'
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

async function handle(req, res, u) {
  if (
    !u.pathname.startsWith(
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
      u.pathname ===
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
      u.pathname ===
      '/api/quant-unified/config'
    ) {
      if (
        !Number.isFinite(data.stake) ||
        data.stake < 10 ||
        data.stake > 100 ||
        !Number.isFinite(data.goal) ||
        data.goal <= 0 ||
        data.goal > 100 ||
        !Number.isFinite(data.lossLimit) ||
        data.lossLimit < 1 ||
        data.lossLimit > 100 ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(
          data.start
        )
      ) {
        throw Error('Parametros invalidos');
      }

      Object.assign(st.settings, {
        stake: data.stake,
        goal: data.goal,
        lossLimit: data.lossLimit,
        start: data.start
      });

      log('Parametros salvos');
      await save();

      reply(res, 200, state());
      return true;
    }

    if (
      u.pathname ===
      '/api/quant-unified/switch'
    ) {
      if (
        typeof data.enabled !== 'boolean'
      ) {
        throw Error('enabled invalido');
      }

      if (data.enabled) {
        const oldBot = await legacy();

        if (oldBot) {
          throw Error(
            'Desligue ' + oldBot + ' antes'
          );
        }
      }

      st.settings.enabled = data.enabled;

      // Ao ativar, efetuar nova verificacao
      // sem esperar um bloco de quatro horas.
      if (data.enabled) {
        st.lastScanMs = 0;
      }

      log(
        data.enabled
          ? 'EXECUTOR V4.1 ATIVADO'
          : 'EXECUTOR DESLIGADO',
        data.enabled ? 'buy' : 'warning'
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
      u.pathname ===
      '/api/quant-unified/test-trade'
    ) {
      if (busy || st.positions.length) {
        throw Error(
          'Motor ocupado ou posicao aberta'
        );
      }

      const sym = SYMBOLS.includes(data.symbol)
        ? data.symbol
        : 'BTC';

      const buyQuote = await orderBook(sym);
      const sellQuote = await orderBook(sym);

      const entry =
        buyQuote.ask * (1 + SLIP);

      const qty = 10 / entry;
      const cost = 10 * (1 + FEE);

      const exit =
        sellQuote.bid * (1 - SLIP);

      const net =
        qty * exit * (1 - FEE) - cost;

      const test = {
        symbol: sym,
        entry,
        exit,
        stake: 10,
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
        sym + ': ' +
        num(net) + ' USDT'
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
      timer = setInterval(
        () =>
          cycle().catch(error =>
            console.error(
              'QUANT_V4_1',
              error.message
            )
          ),
        MONITOR_MS
      );

      timer.unref?.();

      log(
        'Agente Quant V4.1 pronto: ' +
        'analise 1m, estrategia 4h, ' +
        'monitor 15s'
      );
    })
    .catch(error =>
      console.error(
        'QUANT_INIT',
        error.message
      )
    );
}

module.exports = {
  handle,
  start
};
