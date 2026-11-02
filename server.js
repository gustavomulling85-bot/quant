
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

// MOTORES EXISTENTES E MOTOR UNIFICADO
const PAPER = require('./quant-paper-bot');
const AUTO = require('./quant-auto-bot');
const SCALP = require('./quant-scalp-bot');
const UNIFIED = require('./quant-unified-bot');

const PORT = Number(process.env.PORT || 3000);

const SYMBOLS = new Set([
  'BTC', 'ETH', 'SOL', 'BNB',
  'XRP', 'LINK', 'AVAX', 'ADA',
  'DOGE', 'SUI', 'NEAR', 'LTC',
  'TRX', 'UNI', 'BCH', 'DOT',
  'APT', 'ARB', 'AAVE', 'XLM'
]);

const CACHE = new Map();
const lastCalls = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  res.end(JSON.stringify(data));
}

function pinValid(candidate) {
  const pin = process.env.QUANT_ACCESS_PIN || '';

  if (!pin || typeof candidate !== 'string') {
    return false;
  }

  const a = Buffer.from(pin);
  const b = Buffer.from(candidate);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function readBody(req, maxLength = 2048) {
  let requestBody = '';

  for await (const chunk of req) {
    requestBody += chunk;

    if (requestBody.length > maxLength) {
      throw Error('Requisição extensa demais.');
    }
  }

  try {
    return requestBody
      ? JSON.parse(requestBody)
      : {};
  } catch {
    throw Error('JSON inválido.');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    // ======================================
    // ROTAS DOS MOTORES DE SIMULACAO
    // ======================================

    // Robô automático de 5 minutos
    if (await AUTO.handle(req, res, u)) {
      return;
    }

    // Scalping virtual de 1 minuto
    if (await SCALP.handle(req, res, u)) {
      return;
    }

    // NOVO MOTOR UNIFICADO
    if (await UNIFIED.handle(req, res, u)) {
      return;
    }

       // QUANT V7.2 — Pesquisa privada, sem ordens.
    if (u.pathname === '/api/quant-v72/validate' && req.method === 'POST') {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, { error: 'PIN invalido' });
      }
      const input = await readBody(req, 1024);
      const symbol = String(input.symbol || '').toUpperCase();
      const side = String(input.side || '').toUpperCase();
      const stop = Number(input.stop_pct);
      const target = Number(input.target_pct);
      const cost = Number(input.cost_usdt);
      if (!SYMBOLS.has(symbol) || !['LONG','SHORT'].includes(side) ||
          !Number.isFinite(stop) || stop < 0.05 || stop > 10 ||
          !Number.isFinite(target) || target < 0.05 || target > 20 ||
          !Number.isFinite(cost) || cost < 0 || cost > 2) {
        return json(res, 400, { error: 'Parametros invalidos' });
      }
      const base = process.env.SUPABASE_URL?.replace(/\/$/, '');
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!base || !key) return json(res, 503, { error: 'Banco indisponivel' });
      try {
        const result = await fetch(base + '/rest/v1/rpc/quant_v72_validate', {
          method: 'POST',
          headers: {
            apikey: key, Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json', Accept: 'application/json'
          },
          body: JSON.stringify({
            p_symbol: symbol + 'USDT', p_side: side,
            p_stop_pct: stop, p_target_pct: target, p_cost_usdt: cost
          }),
          signal: AbortSignal.timeout(30000)
        });
        if (!result.ok) {
          return json(res, 502, {
            error: 'Falha na pesquisa V7.2 (HTTP ' + result.status + ')'
          });
        }
        return json(res, 200, {
          module: 'QUANT_V72', mode: 'RESEARCH_ONLY',
          realOrders: false, symbol, side,
          results: await result.json()
        });
      } catch {
        return json(res, 502, { error: 'Pesquisa indisponivel' });
      }
    }
    // QUANT V7.1 - VALIDACAO HISTORICA
    // Pesquisa privada, sem compras ou vendas.

    if (
      u.pathname === '/api/quant-v71/validate' &&
      req.method === 'POST'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN invalido'
        });
      }

      const input = await readBody(req, 1024);
      const symbol = String(input.symbol || '')
        .toUpperCase();
      const cost = Number(input.cost_usdt ?? 0.16);

      if (
        !SYMBOLS.has(symbol) ||
        !Number.isFinite(cost) ||
        cost < 0 ||
        cost > 2
      ) {
        return json(res, 400, {
          error: 'Parametros invalidos'
        });
      }

      const base = process.env.SUPABASE_URL
        ?.replace(/\/$/, '');

      const key =
        process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!base || !key) {
        return json(res, 503, {
          error: 'Banco indisponivel'
        });
      }

      try {
        const response = await fetch(
          base + '/rest/v1/rpc/quant_v71_validate',
          {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: 'Bearer ' + key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              p_symbol: symbol + 'USDT',
              p_cost_usdt: cost
            }),
            signal: AbortSignal.timeout(30000)
          }
        );

        if (!response.ok) {
          return json(res, 502, {
            error: 'Falha na validacao historica',
            status: response.status
          });
        }

        return json(res, 200, {
          module: 'QUANT_V71',
          mode: 'RESEARCH_ONLY',
          symbol,
          results: await response.json(),
          realOrders: false
        });

      } catch (error) {
        return json(res, 502, {
          error: 'Consulta indisponivel'
        });
      }
    }

    // QUANT V7 — LABORATORIO HISTORICO
    // Somente pesquisa. Nao executa compras.

    if (
      u.pathname === '/api/quant-v7/lab-assess' &&
      req.method === 'POST'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN invalido'
        });
      }

      const input = await readBody(req, 1024);
      const symbol = String(
        input.symbol || ''
      ).toUpperCase();

      const ratio = Number(input.volume_ratio);

      if (
        !SYMBOLS.has(symbol) ||
        !Number.isFinite(ratio) ||
        ratio < 0.1 ||
        ratio > 20 ||
        typeof input.trend5 !== 'boolean' ||
        typeof input.breakout !== 'boolean'
      ) {
        return json(res, 400, {
          error: 'Parametros invalidos'
        });
      }

      const base = process.env.SUPABASE_URL
        ?.replace(/\/$/, '');

      const key =
        process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!base || !key) {
        return json(res, 503, {
          error: 'Supabase indisponivel'
        });
      }

      try {
        const response = await fetch(
          base +
          '/rest/v1/rpc/quant_v7_pattern_assess',
          {
            method: 'POST',
            headers: {
              apikey: key,
              Authorization: 'Bearer ' + key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              p_symbol: symbol + 'USDT',
              p_volume_ratio: ratio,
              p_trend5: input.trend5,
              p_breakout: input.breakout
            }),
            signal: AbortSignal.timeout(25000)
          }
        );

        if (!response.ok) {
          return json(res, 502, {
            error: 'Falha na pesquisa historica',
            status: response.status
          });
        }

        const rows = await response.json();

        return json(res, 200, {
          mode: 'RESEARCH_ONLY',
          symbol,
          evaluation: rows[0] || null,
          holdingMinutes: 12,
          estimatedCostUSDT: 0.16,
          realOrders: false
        });

      } catch (error) {
        return json(res, 502, {
          error: 'Consulta indisponivel'
        });
      }
    }
 // ======================================
    // QUANT — MEMORIA ESTRATEGICA
    // Consulta privada, somente leitura
    // ======================================

    if (
      u.pathname === '/api/quant/research' &&
      req.method === 'GET'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'Acesso nao autorizado.'
        });
      }

      const base = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

      if (!base || !key) {
        return json(res, 503, {
          error: 'Memoria nao configurada no Render.'
        });
      }

      try {
        const url =
          base.replace(/\/$/, '') +
          '/rest/v1/quant_research_summary' +
          '?select=*' +
          '&order=coin.asc,strategy.asc';

        const response = await fetch(url, {
          headers: {
            apikey: key,
            Authorization: 'Bearer ' + key,
            Accept: 'application/json'
          },
          signal: AbortSignal.timeout(15000)
        });

        if (!response.ok) {
          return json(res, 502, {
            error: 'Falha ao consultar o Supabase.',
            status: response.status
          });
        }

        const records = await response.json();

        return json(res, 200, {
          module: 'quant-strategic-memory',
          mode: 'RESEARCH_ONLY',
          liveTradingModified: false,
          consultedAt: new Date().toISOString(),
          total: records.length,
          records
        });

      } catch (error) {
        return json(res, 502, {
          error: 'Consulta indisponivel.'
        });
      }
    }


    // ======================================
    // QUANT V7 - IMPORTACAO CONTROLADA
    // Um lote por solicitacao, somente pesquisa
    // ======================================

    if (
      u.pathname === '/api/quant-v7/import-one' &&
      req.method === 'POST'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN invalido.'
        });
      }

      if (server.v7ImportBusy) {
        return json(res, 409, {
          error: 'Importacao em andamento.'
        });
      }

      server.v7ImportBusy = true;

      try {
        const data = await readBody(req, 512);
        const sym = String(
          data.symbol || ''
        ).toUpperCase();

        if (!SYMBOLS.has(sym)) {
          return json(res, 400, {
            error: 'Moeda nao permitida.'
          });
        }

        const base = process.env.SUPABASE_URL
          ?.replace(/\/$/, '');

        const key =
          process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!base || !key) {
          return json(res, 503, {
            error: 'Supabase indisponivel.'
          });
        }

        const symbol = sym + 'USDT';

        const headers = {
          apikey: key,
          Authorization: 'Bearer ' + key,
          Accept: 'application/json'
        };

        const lastUrl =
          base +
          '/rest/v1/quant_v7_candles' +
          '?select=open_time' +
          '&symbol=eq.' + symbol +
          '&timeframe=eq.1m' +
          '&order=open_time.desc' +
          '&limit=1';

        const lastRes = await fetch(lastUrl, {
          headers,
          signal: AbortSignal.timeout(15000)
        });

        if (!lastRes.ok) {
          return json(res, 502, {
            error: 'Falha ao consultar a memoria.',
            status: lastRes.status
          });
        }

        const last = await lastRes.json();

        const until =
          Math.floor(Date.now() / 60000) *
          60000;

        const start = last.length
          ? Date.parse(last[0].open_time) + 60000
          : until - 21 * 86400000;

        if (start >= until) {
          return json(res, 200, {
            symbol,
            imported: 0,
            complete: true
          });
        }

        const params = new URLSearchParams({
          symbol,
          interval: '1m',
          startTime: String(start),
          endTime: String(until - 1),
          limit: '1000'
        });

        const source =
          
'https://data-api.binance.vision/api/v3/klines?' +
          params;

        const candlesRes = await fetch(source, {
          signal: AbortSignal.timeout(15000)
        });

        if (!candlesRes.ok) {
          return json(res, 502, {
            error: 'Binance indisponivel.',
            status: candlesRes.status
          });
        }

        const raw = await candlesRes.json();

        if (!Array.isArray(raw)) {
          throw Error('Resposta inesperada.');
        }

        const rows = raw
          .filter(k => Number(k[6]) < Date.now())
          .map(k => ({
            symbol,
            timeframe: '1m',

            open_time:
              new Date(Number(k[0]))
                .toISOString(),

            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),

            volume: Number(k[5]),

            quote_volume: Number(k[7]),

            trades: Number(k[8]),

            taker_buy_quote_volume:
              Number(k[10]),

            source: 'binance_spot_api'
          }));

        if (rows.length) {
          const saved = await fetch(
            base +
            '/rest/v1/quant_v7_candles' +
            '?on_conflict=symbol,timeframe,open_time',
            {
              method: 'POST',

              headers: {
                ...headers,

                'Content-Type':
                  'application/json',

                Prefer:
                  'resolution=merge-duplicates,return=minimal'
              },

              body: JSON.stringify(rows),

              signal:
                AbortSignal.timeout(25000)
            }
          );

          if (!saved.ok) {
            return json(res, 502, {
              error: 'Falha ao salvar velas.',
              status: saved.status
            });
          }
        }

        return json(res, 200, {
          symbol,
          imported: rows.length,

          lastCandle:
            rows.at(-1)?.open_time || null,

          complete: rows.length < 1000
        });

      } catch (error) {
        return json(res, 502, {
          error: 'Importacao falhou: ' +
            error.message
        });

      } finally {
        server.v7ImportBusy = false;
      }
    }





    
    // ======================================
    // QUANT V7 - IMPORTADOR AUTOMATICO
    // Somente pesquisa, sem ordens
    // ======================================

    if (
      u.pathname === '/api/quant-v7/auto-status' &&
      req.method === 'GET'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN invalido'
        });
      }

      return json(res, 200, server.v7Job || {
        running: false,
        message: 'Nenhuma importacao iniciada'
      });
    }

    if (
      u.pathname === '/api/quant-v7/auto-start' &&
      req.method === 'POST'
    ) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN invalido'
        });
      }

      if (server.v7Job?.running) {
        return json(res, 409, {
          error: 'Ja existe importacao ativa'
        });
      }

      let data;

      try {
        data = await readBody(req, 512);
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }

      const scope = data.scope;

      if (scope !== 'BTC' && scope !== 'ALL') {
        return json(res, 400, {
          error: 'Use BTC ou ALL'
        });
      }

      const coins = scope === 'BTC'
        ? ['BTC']
        : [...SYMBOLS];

      const job = {
        running: true,
        scope,
        startedAt: new Date().toISOString(),
        symbol: null,
        batches: 0,
        imported: 0,
        finishedCoins: [],
        error: null
      };

      server.v7Job = job;

      json(res, 202, job);

      setImmediate(async () => {
        try {
          for (const symbol of coins) {
            job.symbol = symbol;

            let finished = false;

            for (let batch = 0; batch < 40; batch++) {
              const response = await fetch(
                'http://127.0.0.1:' + PORT +
                '/api/quant-v7/import-one',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-quant-pin':
                      process.env.QUANT_ACCESS_PIN
                  },
                  body: JSON.stringify({ symbol }),
                  signal: AbortSignal.timeout(90000)
                }
              );

              const result = await response.json();

              if (!response.ok) {
                throw Error(
                  symbol + ': ' +
                  (result.error || response.status)
                );
              }

              job.batches++;
              job.imported += result.imported || 0;

              if (result.complete) {
                finished = true;
                break;
              }

              await new Promise(resolve =>
                setTimeout(resolve, 1500)
              );
            }

            if (!finished) {
              throw Error(
                symbol + ': limite de lotes atingido'
              );
            }

            job.finishedCoins.push(symbol);
          }

        } catch (error) {
          job.error = error.message;

        } finally {
          job.running = false;
          job.finishedAt =
            new Date().toISOString();
        }
      });

      return;
    }

    // ======================================
    // VERIFICACAO DO SERVIDOR
    // ======================================

    if (
      u.pathname === '/api/health' &&
      req.method === 'GET'
    ) {
      return json(res, 200, {
        status: 'ok',
        service: 'agente-quant-v3',
        unifiedModule: true,
        realOrders: false
      });
    }

    // ======================================
    // STATUS TINYFISH
    // ======================================

    if (
      u.pathname === '/api/tinyfish/status' &&
      req.method === 'GET'
    ) {
      return json(res, 200, {
        configured: Boolean(
          process.env.TINYFISH_API_KEY
        ),
        pinConfigured: Boolean(
          process.env.QUANT_ACCESS_PIN
        )
      });
    }

    // ======================================
    // CONSULTA CONTEXTUAL TINYFISH
    // ======================================

    if (
      u.pathname === '/api/tinyfish/context' &&
      req.method === 'POST'
    ) {
      if (
        !process.env.QUANT_ACCESS_PIN ||
        !process.env.TINYFISH_API_KEY
      ) {
        return json(res, 503, {
          error: 'Configuração de servidor incompleta.'
        });
      }

      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN inválido.'
        });
      }

      let data;

      try {
        data = await readBody(req, 2048);
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }

      const symbol = data.symbol;

      if (!SYMBOLS.has(symbol)) {
        return json(res, 400, {
          error: 'Ativo não permitido.'
        });
      }

      const now = Date.now();
      const cached = CACHE.get(symbol);

      if (
        cached &&
        now - cached.at < 15 * 60 * 1000
      ) {
        return json(res, 200, {
          ...cached.result,
          cached: true
        });
      }

      const previousCall = lastCalls.get(symbol) || 0;

      if (now - previousCall < 60 * 1000) {
        return json(res, 429, {
          error: 'Aguarde antes de repetir a consulta.'
        });
      }

      lastCalls.set(symbol, now);

      const query =
        `${symbol} cryptocurrency latest market news ` +
        'regulation exchange security announcement';

      const controller = new AbortController();

      const timeout = setTimeout(
        () => controller.abort(),
        18000
      );

      try {
        const response = await fetch(
          'https://api.search.tinyfish.ai/?' +
          new URLSearchParams({
            query,
            language: 'en'
          }),
          {
            headers: {
              'X-API-Key':
                process.env.TINYFISH_API_KEY,
              Accept: 'application/json'
            },
            signal: controller.signal
          }
        );

        if (!response.ok) {
          return json(res, 502, {
            error:
              'TinyFish retornou HTTP ' +
              response.status
          });
        }

        const resultData = await response.json();

        const records = Array.isArray(resultData.results)
          ? resultData.results
          : [];

        const result = {
          symbol,
          consultedAt: new Date().toISOString(),

          results: records
            .slice(0, 10)
            .map(x => ({
              title: String(x.title || ''),
              snippet: String(x.snippet || ''),

              url:
                typeof x.url === 'string' &&
                /^https?:\/\//.test(x.url)
                  ? x.url
                  : null,

              date: x.date || null
            }))
        };

        CACHE.set(symbol, {
          at: now,
          result
        });

        return json(res, 200, result);

      } catch (error) {
        return json(res, 502, {
          error:
            error.name === 'AbortError'
              ? 'Tempo de consulta esgotado.'
              : 'Não foi possível consultar o TinyFish.'
        });

      } finally {
        clearTimeout(timeout);
      }
    }

    // ======================================
    // API ORIGINAL DE OPERACOES FICTICIAS
    // ======================================

    if (u.pathname.startsWith('/api/paper/')) {
      if (!pinValid(req.headers['x-quant-pin'])) {
        return json(res, 401, {
          error: 'PIN inválido.'
        });
      }

      if (
        u.pathname === '/api/paper/status' &&
        req.method === 'GET'
      ) {
        return json(
          res,
          200,
          await PAPER.refresh()
        );
      }

      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Método inválido.'
        });
      }

      let data;

      try {
        data = await readBody(req, 1024);
      } catch (error) {
        return json(res, 400, {
          error: error.message
        });
      }

      // Pausar simulador anterior
      if (u.pathname === '/api/paper/pause') {
        return json(
          res,
          200,
          PAPER.pause(data.paused)
        );
      }

      // Radar original
      if (u.pathname === '/api/paper/scan') {
        const context = async sym => {
          if (!process.env.TINYFISH_API_KEY) {
            return {
              status: 'INCONCLUSIVO',
              reason: 'TinyFish não configurado'
            };
          }

          const ctrl = new AbortController();

          const timeout = setTimeout(
            () => ctrl.abort(),
            14000
          );

          try {
            const response = await fetch(
              'https://api.search.tinyfish.ai/?' +
              new URLSearchParams({
                query:
                  sym +
                  ' crypto latest 72 hours market risk news',
                language: 'en'
              }),
              {
                headers: {
                  'X-API-Key':
                    process.env.TINYFISH_API_KEY,
                  Accept: 'application/json'
                },
                signal: ctrl.signal
              }
            );

            if (!response.ok) {
              throw Error('TinyFish indisponível');
            }

            const raw = await response.json();
            const now = Date.now();

            const recent = (
              Array.isArray(raw.results)
                ? raw.results
                : []
            ).filter(x => {
              const date = Date.parse(
                x.date || ''
              );

              return (
                Number.isFinite(date) &&
                date <= now &&
                now - date <= 72 * 3600000
              );
            });

            return {
              status: 'REVISÃO_HUMANA',
              recentCount: recent.length,
              reason: 'Notícias não autorizam operações'
            };

          } catch {
            return {
              status: 'INCONCLUSIVO',
              reason:
                'TinyFish sem contexto verificável'
            };

          } finally {
            clearTimeout(timeout);
          }
        };

        return json(
          res,
          200,
          await PAPER.scan(context)
        );
      }

      // Entrada virtual original
      if (u.pathname === '/api/paper/enter') {
        if (typeof data.symbol !== 'string') {
          return json(res, 400, {
            error: 'Ativo obrigatório.'
          });
        }

        try {
          return json(
            res,
            200,
            await PAPER.enter(data.symbol)
          );

        } catch (error) {
          return json(res, 409, {
            error: error.message
          });
        }
      }

      return json(res, 404, {
        error: 'Rota desconhecida.'
      });
    }

    // ======================================
    // ARQUIVOS PUBLICOS
    // ======================================

    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD'
    ) {
      return json(res, 405, {
        error: 'Método não permitido.'
      });
    }

    const requested =
      u.pathname === '/'
        ? 'index.html'
        : decodeURIComponent(u.pathname)
            .replace(/^\/+/, '');

    const full = path.resolve(
      ROOT,
      requested
    );

    // Impedir navegação fora do projeto
    if (!full.startsWith(ROOT + path.sep)) {
      return json(res, 403, {
        error: 'Acesso negado.'
      });
    }

    // ======================================
    // PROTECAO DE CODIGO E DADOS INTERNOS
    // ======================================

    const privateFile =
      /(^|\/)\./.test(requested) ||
      /\.(env|lock|md)$/i.test(requested) ||
      /^(server\.js|package\.json|quant-(?:auto|paper|scalp|unified)-bot\.js)$/i.test(requested) ||
      /^(quant-(?:auto|paper|scalp|unified)-state\.json(?:\.tmp)?)$/i.test(requested);

    if (privateFile) {
      return json(res, 403, {
        error: 'Acesso negado.'
      });
    }

    try {
      const file = await fs.readFile(full);

      res.writeHead(200, {
        'Content-Type':
          TYPES[path.extname(full).toLowerCase()] ||
          'application/octet-stream',

        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache'
      });

      res.end(
        req.method === 'HEAD'
          ? undefined
          : file
      );

    } catch {
      return json(res, 404, {
        error: 'Arquivo não encontrado.'
      });
    }

  } catch (error) {
    console.error(
      'SERVER_ERROR',
      error.message
    );

    return json(res, 500, {
      error: 'Erro interno.'
    });
  }
});

// ======================================
// INICIAR SERVIDOR
// ======================================

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    'Agente Quant ativo na porta ' + PORT
  );
});

// ======================================
// INICIAR MOTORES
// ======================================

// Robô de 5 minutos
AUTO.start();

// Scalping de 1 minuto
SCALP.start();

// NOVO MOTOR UNIFICADO
UNIFIED.start();
