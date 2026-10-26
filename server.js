
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
