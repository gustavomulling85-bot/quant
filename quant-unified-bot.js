
'use strict';

// AGENTE QUANT V4
// ROMPIMENTO 4H EXPERIMENTAL
// SOMENTE DINHEIRO FICTICIO

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
  start: '09:00',
  maxPositions: 1,
  stopPct: 1,
  targetPct: 2.5
};

const empty = () => ({
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
  lastSlot: null,
  lastError: null,
  openedToday: 0,
  diagnostic: 'Aguardando ativacao'
});

let st = empty();
let ready = false;
let busy = false;
let timer;

const FEE = 0.001;
const SLIP = 0.0003;
const ZONE = 'America/Sao_Paulo';

const stamp = () => new Date().toISOString();

const day = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);

const clock = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date());

const n = x => Number(Number(x).toFixed(6));

const equity = () =>
  st.cash +
  st.positions.reduce(
    (a, p) =>
      a + p.qty * (p.mark || p.entry) * (1 - FEE - SLIP),
    0
  );

const pnl = () => equity() - st.startEquity;

const losses = () =>
  st.trades.filter(
    t =>
      t.net < 0 &&
      day(new Date(t.closedAt)) === st.day
  ).length;

function log(text, type = 'info') {
  st.events.unshift({
    at: stamp(),
    text,
    type
  });

  st.events = st.events.slice(0, 120);
}

async function save() {
  await fs.writeFile(
    FILE + '.tmp',
    JSON.stringify(st),
    { mode: 0o600 }
  );

  await fs.rename(FILE + '.tmp', FILE);
}

function newDay() {
  const d = day();

  if (d !== st.day) {
    st.day = d;
    st.startEquity = equity();
    st.openedToday = 0;
    st.lastSlot = null;

    log('Novo dia ficticio: ' + d);
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
      throw Error('Invalid');
    }

    st = {
      ...empty(),
      ...old,
      settings: {
        ...DEFAULT,
        ...old.settings,
        enabled: false
      }
    };

    log(
      'Reinicio: desligado por seguranca',
      'warning'
    );
  } catch {
    st = empty();

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
  for (const f of [
    'quant-auto-state.json',
    'quant-scalp-state.json'
  ]) {
    try {
      const x = JSON.parse(
        await fs.readFile(
          path.join(__dirname, f),
          'utf8'
        )
      );

      if (x.settings?.enabled) {
        return f;
      }
    } catch {}
  }

  return null;
}

function block() {
  if (!st.settings.enabled) {
    return 'DESLIGADO';
  }

  if (clock() < st.settings.start) {
    return (
      'AGUARDANDO HORARIO ' +
      st.settings.start
    );
  }

  if (losses() >= st.settings.maxLosses) {
    return 'TRAVA: LOSSES';
  }

  if (pnl() >= st.settings.goal) {
    return 'META DIARIA';
  }

  if (pnl() <= -st.settings.lossLimit) {
    return 'LIMITE DE PERDA';
  }

  if (
    st.positions.length >=
    st.settings.maxPositions
  ) {
    return 'POSICAO ABERTA';
  }

  return null;
}

async function get(endpoint) {
  let err;

  for (const host of [
    'https://data-api.binance.vision',
    'https://api.binance.com'
  ]) {
    const ac = new AbortController();

    const t = setTimeout(
      () => ac.abort(),
      9000
    );

    try {
      const res = await fetch(
        host + '/api/v3/' + endpoint,
        {
          signal: ac.signal,
          cache: 'no-store'
        }
      );

      if (!res.ok) {
        throw Error(
          'Binance HTTP ' + res.status
        );
      }

      return await res.json();
    } catch (e) {
      err = e;
    } finally {
      clearTimeout(t);
    }
  }

  throw err || Error('Binance indisponivel');
}

async function book(sym) {
  const x = await get(
    'ticker/bookTicker?symbol=' +
    sym +
    'USDT'
  );

  if (
    !(Number(x.askPrice) > 0) ||
    !(Number(x.bidPrice) > 0)
  ) {
    throw Error(
      'Livro sem precos validos'
    );
  }

  return {
    ask: +x.askPrice,
    bid: +x.bidPrice
  };
}

async function bars4h(sym) {
  const q = new URLSearchParams({
    symbol: sym + 'USDT',
    interval: '4h',
    limit: '120'
  });

  const rows = await get(
    'klines?' + q
  );

  if (!Array.isArray(rows)) {
    throw Error('Klines invalido');
  }

  return rows
    .filter(x => +x[6] < Date.now())
    .map(x => ({
      t: +x[0],
      o: +x[1],
      h: +x[2],
      l: +x[3],
      c: +x[4],
      v: +x[5]
    }));
}

function analyze(bars) {
  if (bars.length < 60) {
    return {
      approved: false,
      score: 0,
      why: 'Historico 4h insuficiente'
    };
  }

  const c = bars.map(b => b.c);
  const N = c.length;

  function series(period) {
    const out = Array(N).fill(NaN);

    let e =
      c.slice(0, period).reduce(
        (a, b) => a + b,
        0
      ) / period;

    out[period - 1] = e;

    for (
      let i = period;
      i < N;
      i++
    ) {
      e +=
        (c[i] - e) *
        2 / (period + 1);

      out[i] = e;
    }

    return out;
  }

  const e20 = series(20);
  const e50 = series(50);

  const last = N - 1;
  const b = bars[last];

  const vol =
    bars
      .slice(last - 20, last)
      .reduce(
        (a, x) => a + x.v,
        0
      ) / 20;

  const high = Math.max(
    ...bars
      .slice(last - 20, last)
      .map(x => x.h)
  );

  const trend =
    e20[last] > e50[last] &&
    e20[last] > e20[last - 3] &&
    b.c > e50[last];

  const breakout =
    b.c > high &&
    b.c > b.o &&
    vol > 0 &&
    b.v >= 1.35 * vol;

  const trueRanges = bars.map(
    (x, i) =>
      i
        ? Math.max(
            x.h - x.l,
            Math.abs(
              x.h - bars[i - 1].c
            ),
            Math.abs(
              x.l - bars[i - 1].c
            )
          )
        : x.h - x.l
  );

  let atr =
    trueRanges
      .slice(1, 15)
      .reduce(
        (a, x) => a + x,
        0
      ) / 14;

  for (
    let i = 15;
    i < N;
    i++
  ) {
    atr =
      (atr * 13 + trueRanges[i]) /
      14;
  }

  const approved =
    trend &&
    breakout &&
    atr > 0 &&
    Number.isFinite(atr);

  return {
    approved,
    score: approved
      ? 100
      : (trend ? 50 : 0) +
        (breakout ? 40 : 0),

    why: approved
      ? 'Rompimento 4h confirmado (experimental)'
      : 'Sem EMA20/50 ascendente e/ou rompimento com volume 1,35x',

    atr: n(atr),
    setup: 'rompimento-4h',
    volumeRatio: n(
      b.v / (vol || 1)
    ),
    trendConfirmed: trend,
    breakout5: breakout,
    signalTime: b.t
  };
}

async function universe() {
  const [
    exchange,
    volumes,
    books
  ] = await Promise.all([
    get('exchangeInfo'),
    get('ticker/24hr'),
    get('ticker/bookTicker')
  ]);

  const allowed = new Set(
    exchange.symbols
      .filter(
        x =>
          x.status === 'TRADING' &&
          x.quoteAsset === 'USDT' &&
          x.isSpotTradingAllowed !==
            false
      )
      .map(x => x.symbol)
  );

  const v = new Map(
    volumes.map(
      x => [
        x.symbol,
        +x.quoteVolume
      ]
    )
  );

  const b = new Map(
    books.map(
      x => [
        x.symbol,
        {
          ask: +x.askPrice,
          bid: +x.bidPrice
        }
      ]
    )
  );

  return SYMBOLS.map(sym => {
    const key = sym + 'USDT';

    const q = b.get(key);

    const spread =
      q?.ask > 0 &&
      q?.bid > 0
        ? 100 *
          (q.ask - q.bid) /
          ((q.ask + q.bid) / 2)
        : Infinity;

    return {
      sym,
      quote: q,
      spread,
      eligible:
        allowed.has(key) &&
        (v.get(key) || 0) >=
          5000000 &&
        spread <= 0.10
    };
  });
}

async function closePosition(p) {
  const q = await book(p.sym);

  p.mark = q.bid;

  let reason = null;

  const stop =
    p.stopPrice ||
    p.entry *
      (1 -
        st.settings.stopPct /
          100);

  const target =
    p.targetPrice ||
    p.entry *
      (1 +
        st.settings.targetPct /
          100);

  if (q.bid <= stop) {
    reason = 'STOP';
  } else if (q.bid >= target) {
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

  const exit =
    q.bid * (1 - SLIP);

  const proceeds =
    p.qty *
    exit *
    (1 - FEE);

  const net =
    proceeds - p.cost;

  st.cash += proceeds;

  st.positions =
    st.positions.filter(
      x => x !== p
    );

  st.trades.unshift({
    symbol: p.sym,
    entry: p.entry,
    exit,
    stake: p.cost,
    net,
    openedAt: p.openedAt,
    closedAt: stamp(),
    reason,
    setup: p.setup
  });

  st.trades =
    st.trades.slice(0, 500);

  log(
    'VENDA FICTICIA ' +
      p.sym +
      ': ' +
      n(net) +
      ' USDT (' +
      reason +
      ')',
    net >= 0
      ? 'profit'
      : 'loss'
  );
}

async function monitor() {
  for (
    const p of [...st.positions]
  ) {
    try {
      await closePosition(p);
    } catch (e) {
      st.lastError =
        'Monitor ' +
        p.sym +
        ': ' +
        e.message;

      log(
        st.lastError,
        'warning'
      );
    }
  }
}

async function scan() {
  st.lastAttempt = stamp();

  st.diagnostic =
    'Analisando sinais 4h';

  const u = await universe();

  const out = [];

  for (
    let i = 0;
    i < u.length;
    i += 5
  ) {
    const group =
      u.slice(i, i + 5);

    const items =
      await Promise.allSettled(
        group.map(
          async x =>
            !x.eligible
              ? {
                  sym: x.sym,
                  approved: false,
                  why: 'Liquidez/spread'
                }
              : {
                  sym: x.sym,
                  ask: x.quote.ask,
                  spread: x.spread,
                  ...analyze(
                    await bars4h(x.sym)
                  )
                }
        )
      );

    group.forEach(
      (x, j) =>
        out.push(
          items[j].status ===
            'fulfilled'
            ? items[j].value
            : {
                sym: x.sym,
                approved: false,
                why:
                  'Falha Binance: ' +
                  String(
                    items[j].reason
                      ?.message ||
                      'desconhecida'
                  )
              }
        )
    );
  }

  st.lastResults = out;
  st.lastScan = stamp();

  const choices = out
    .filter(x => x.approved)
    .sort(
      (a, b) =>
        a.spread - b.spread
    );

  st.diagnostic =
    choices.length +
    ' rompimentos 4h aprovados / ' +
    out.length +
    ' ativos';

  log(
    'Analise concluida: ' +
      st.diagnostic,
    'scan'
  );

  if (
    !choices.length ||
    block()
  ) {
    return;
  }

  for (const pick of choices) {
    try {
      const q =
        await book(pick.sym);

      if (
        q.ask >
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

      const entry =
        q.ask * (1 + SLIP);

      const qty =
        stake / entry;

      const cost =
        stake * (1 + FEE);

      const stop =
        q.ask -
        1.5 * pick.atr;

      const target =
        q.ask +
        2.5 * pick.atr;

      if (
        !(
          stop > 0 &&
          stop < q.bid &&
          target > entry
        )
      ) {
        continue;
      }

      st.cash -= cost;

      st.positions.push({
        sym: pick.sym,
        entry,
        qty,
        cost,
        mark: q.bid,
        openedAt: stamp(),
        openedMs: Date.now(),
        setup:
          'rompimento-4h-experimental',
        stopPrice: stop,
        targetPrice: target,
        score: 100
      });

      st.openedToday++;

      st.diagnostic =
        'COMPRA FICTICIA ' +
        pick.sym +
        ' (4h)';

      log(
        st.diagnostic,
        'buy'
      );

      return;
    } catch (e) {
      st.lastError =
        String(e.message);
    }
  }

  st.diagnostic =
    'Sinais encontrados, entradas recusadas por preco/risco';
}

async function cycle() {
  if (
    !ready ||
    busy
  ) {
    return;
  }

  busy = true;

  try {
    newDay();

    await monitor();

    const blocked = block();

    if (blocked) {
      st.diagnostic =
        blocked;

      await save();
      return;
    }

    const prev =
      await legacy();

    if (prev) {
      st.diagnostic =
        'BLOQUEADO: desligue ' +
        prev;

      await save();
      return;
    }

    const slot = Math.floor(
      Date.now() /
        (4 * 3600000)
    );

    if (
      st.lastSlot !== slot
    ) {
      st.lastSlot = slot;

      await scan();
    }

    await save();
  } catch (e) {
    st.lastError =
      e.message;

    st.diagnostic =
      'ERRO: ' +
      e.message;

    log(
      st.diagnostic,
      'warning'
    );

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
    blocking: block(),
    clockBR: clock(),
    working: busy,
    simulation: true,
    realOrders: false,
    storage:
      'Arquivo temporario no Render',
    system:
      'Rompimento 4h experimental',
    scanInterval: '4h'
  };
}

function reply(
  res,
  status,
  obj
) {
  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',
      'Cache-Control':
        'no-store',
      'X-Content-Type-Options':
        'nosniff'
    }
  );

  res.end(
    JSON.stringify(obj)
  );
}

function valid(pin) {
  const secret =
    process.env
      .QUANT_ACCESS_PIN || '';

  if (
    !secret ||
    typeof pin !== 'string'
  ) {
    return false;
  }

  const a =
    Buffer.from(secret);

  const b =
    Buffer.from(pin);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function body(req) {
  let s = '';

  for await (
    const chunk of req
  ) {
    s += chunk;

    if (s.length > 2048) {
      throw Error(
        'Payload extenso'
      );
    }
  }

  return s
    ? JSON.parse(s)
    : {};
}

async function handle(
  req,
  res,
  u
) {
  if (
    !u.pathname.startsWith(
      '/api/quant-unified/'
    )
  ) {
    return false;
  }

  if (
    !valid(
      req.headers[
        'x-quant-pin'
      ]
    )
  ) {
    reply(
      res,
      401,
      {
        error:
          'PIN invalido'
      }
    );

    return true;
  }

  if (!ready) {
    reply(
      res,
      503,
      {
        error:
          'Inicializando'
      }
    );

    return true;
  }

  try {
    if (
      req.method === 'GET' &&
      u.pathname ===
        '/api/quant-unified/status'
    ) {
      reply(
        res,
        200,
        state()
      );

      return true;
    }

    if (
      req.method !== 'POST'
    ) {
      reply(
        res,
        405,
        {
          error:
            'Metodo invalido'
        }
      );

      return true;
    }

    const data =
      await body(req);

    if (
      u.pathname ===
      '/api/quant-unified/config'
    ) {
      if (
        !Number.isFinite(
          data.stake
        ) ||
        data.stake < 10 ||
        data.stake > 100 ||
        !Number.isFinite(
          data.goal
        ) ||
        data.goal <= 0 ||
        data.goal > 100 ||
        !Number.isFinite(
          data.lossLimit
        ) ||
        data.lossLimit < 1 ||
        data.lossLimit > 100 ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(
          data.start
        )
      ) {
        throw Error(
          'Parametros invalidos'
        );
      }

      Object.assign(
        st.settings,
        {
          stake: data.stake,
          goal: data.goal,
          lossLimit:
            data.lossLimit,
          start: data.start
        }
      );

      log(
        'Parametros salvos'
      );

      await save();

      reply(
        res,
        200,
        state()
      );

      return true;
    }

    if (
      u.pathname ===
      '/api/quant-unified/switch'
    ) {
      if (
        typeof data.enabled !==
        'boolean'
      ) {
        throw Error(
          'enabled invalido'
        );
      }

      if (data.enabled) {
        const old =
          await legacy();

        if (old) {
          throw Error(
            'Desligue ' +
            old +
            ' antes'
          );
        }
      }

      st.settings.enabled =
        data.enabled;

      log(
        data.enabled
          ? 'Executor 4h EXPERIMENTAL ATIVADO'
          : 'Executor 4h DESLIGADO',
        data.enabled
          ? 'buy'
          : 'warning'
      );

      await save();

      reply(
        res,
        200,
        state()
      );

      if (data.enabled) {
        queueMicrotask(
          () =>
            cycle().catch(
              () => {}
            )
        );
      }

      return true;
    }

    if (
      u.pathname ===
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

      const sym =
        SYMBOLS.includes(
          data.symbol
        )
          ? data.symbol
          : 'BTC';

      const a =
        await book(sym);

      const b =
        await book(sym);

      const entry =
        a.ask * (1 + SLIP);

      const qty =
        10 / entry;

      const cost =
        10 * (1 + FEE);

      const exit =
        b.bid * (1 - SLIP);

      const net =
        qty *
          exit *
          (1 - FEE) -
        cost;

      const test = {
        symbol: sym,
        entry,
        exit,
        stake: 10,
        cost,
        net,
        openedAt: stamp(),
        closedAt: stamp(),
        reason:
          'TESTE ISOLADO',
        test: true
      };

      st.testTrades.unshift(
        test
      );

      st.testTrades =
        st.testTrades.slice(
          0,
          30
        );

      log(
        'TESTE ISOLADO ' +
          sym +
          ' ' +
          n(net) +
          ' USDT'
      );

      await save();

      reply(
        res,
        200,
        {
          ...state(),
          test
        }
      );

      return true;
    }

    reply(
      res,
      404,
      {
        error:
          'Rota inexistente'
      }
    );

    return true;
  } catch (e) {
    reply(
      res,
      400,
      {
        error:
          e.message
      }
    );

    return true;
  }
}

function start() {
  load()
    .then(() => {
      timer = setInterval(
        () =>
          cycle().catch(
            e =>
              console.error(
                'UNIFIED',
                e.message
              )
          ),
        15000
      );

      timer.unref?.();

      log(
        'Motor de rompimento 4h experimental pronto; ativacao manual obrigatoria'
      );
    })
    .catch(
      e =>
        console.error(
          'UNIFIED_INIT',
          e.message
        )
    );
}

module.exports = {
  handle,
  start
};
