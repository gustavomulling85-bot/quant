
'use strict';

/*
 QUANT V7 — IMPORTADOR HISTORICO

 Objetivo:
 - Buscar candles historicos da Binance
 - Armazenar dados completos no Supabase
 - Evitar duplicacoes
 - Registrar volume e negocios
 - Preservar dados existentes

 SOMENTE PESQUISA.
 Nao abre ou fecha operacoes.
 Nao modifica o motor atual.

 Execucao pelo servidor:
 node quant-v7-backfill.js BTC ETH SOL
*/

const { setTimeout: sleep } =
  require('node:timers/promises');

const API = process.env.SUPABASE_URL
  ?.replace(/\/$/, '');

const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const INTERVAL = '1m';

const MS = 60000;

const WINDOW_DAYS = 21;

const PAUSE_MS = 350;

if (!API || !KEY) {
  console.error(
    'Credenciais do Supabase ausentes.'
  );
  process.exit(1);
}

const coins = process.argv
  .slice(2)
  .map(s =>
    s.toUpperCase().replace(/USDT$/, '')
  )
  .filter(s =>
    /^[A-Z0-9]{2,15}$/.test(s)
  );

if (!coins.length) {
  console.error(
    'Uso: node quant-v7-backfill.js BTC ETH SOL'
  );
  process.exit(1);
}

async function request(
  url,
  options = {},
  retries = 5
) {
  for (
    let attempt = 0;
    attempt <= retries;
    attempt++
  ) {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(25000)
    });

    if (res.ok) return res;

    const retryable =
      res.status === 429 ||
      res.status === 418 ||
      res.status >= 500;

    if (retryable && attempt < retries) {
      const retry =
        Number(
          res.headers.get('retry-after')
        ) || 0;

      await sleep(
        Math.max(
          retry * 1000,
          1000 * 2 ** attempt
        )
      );

      continue;
    }

    throw Error(
      'HTTP ' +
      res.status +
      ' ' +
      (await res.text()).slice(0, 300)
    );
  }
}

async function save(rows) {
  const url =
    API +
    '/rest/v1/quant_v7_candles' +
    '?on_conflict=symbol,timeframe,open_time';

  const res = await request(url, {
    method: 'POST',

    headers: {
      apikey: KEY,

      Authorization:
        'Bearer ' + KEY,

      'Content-Type':
        'application/json',

      Prefer:
        'resolution=merge-duplicates,return=minimal'
    },

    body: JSON.stringify(rows)
  });

  return res.status;
}

function candle(k, symbol) {
  const t = Number(k[0]);

  // Somente velas encerradas
  if (
    !Number.isSafeInteger(t) ||
    Number(k[6]) >= Date.now()
  ) {
    return null;
  }

  const values = [
    k[1],
    k[2],
    k[3],
    k[4],
    k[5],
    k[7],
    k[10]
  ].map(Number);

  const [
    open,
    high,
    low,
    close,
    volume,
    quoteVolume,
    takerBuyQuoteVolume
  ] = values;

  if (
    values.slice(0, 5)
      .some(x => !Number.isFinite(x)) ||
    open <= 0 ||
    high < Math.max(open, close, low) ||
    low > Math.min(open, close, high)
  ) {
    return null;
  }

  return {
    symbol,

    timeframe: INTERVAL,

    open_time:
      new Date(t).toISOString(),

    open,
    high,
    low,
    close,
    volume,

    quote_volume: quoteVolume,

    trades: Number(k[8]),

    taker_buy_quote_volume:
      takerBuyQuoteVolume,

    source: 'binance_spot_api'
  };
}

async function run(sym) {
  const symbol = sym + 'USDT';

  const until =
    Math.floor(Date.now() / MS) * MS;

  const from =
    until - WINDOW_DAYS * 86400000;

  let at = from;

  let rowsTotal = 0;

  let last = -1;

  while (at < until) {
    const q = new URLSearchParams({
      symbol,

      interval: INTERVAL,

      startTime: String(at),

      endTime: String(until - 1),

      limit: '1000'
    });

    const url =
      'https://api.binance.com/api/v3/klines?' +
      q;

    const res = await request(url);

    const data = await res.json();

    if (
      !Array.isArray(data) ||
      !data.length
    ) {
      break;
    }

    const rows = data
      .map(k => candle(k, symbol))
      .filter(Boolean);

    if (rows.length) {
      await save(rows);
    }

    rowsTotal += rows.length;

    const newest =
      Number(data.at(-1)[0]);

    if (
      newest <= last ||
      newest < at
    ) {
      throw Error(
        'Cursor historico invalido: ' +
        symbol
      );
    }

    last = newest;

    at = newest + MS;

    await sleep(PAUSE_MS);
  }

  console.log(
    symbol +
    ': ' +
    rowsTotal +
    ' candles importados.'
  );
}

(async () => {
  for (const sym of [...new Set(coins)]) {
    try {
      await run(sym);
    } catch (e) {
      console.error(
        sym + ': ' + e.message
      );

      process.exitCode = 1;
    }
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
