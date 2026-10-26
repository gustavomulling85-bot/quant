
'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;

const PAPER = require('./quant-paper-bot');
const AUTO = require('./quant-auto-bot');
const SCALP = require('./quant-scalp-bot');

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

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    // Robô automático de 5 minutos
    if (await AUTO.handle(req, res, u)) return;

    // Scalping virtual de 1 minuto
    if (await SCALP.handle(req, res, u)) return;

    // Verificação de funcionamento
    if (
      u.pathname === '/api/health' &&
      req.method === 'GET'
    ) {
      return json(res, 200, {
        status: 'ok',
        service: 'agente-quant-v3'
      });
    }

    // Status TinyFish
    if (
      u.pathname === '/api/tinyfish/status' &&
      req.method === 'GET'
    ) {
      return json(res, 200, {
        configured: Boolean(process.env.TINYFISH_API_KEY),
        pinConfigured: Boolean(process.env.QUANT_ACCESS_PIN)
      });
    }

    // Consulta contextual TinyFish
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

      let requestBody = '';

      for await (const chunk of req) {
        requestBody += chunk;

        if (requestBody.length > 2048) {
          return json(res, 413, {
            error: 'Requisição extensa demais.'
          });
        }
      }

      let symbol;

      try {
        symbol = JSON.parse(requestBody).symbol;
      } catch {
        return json(res, 400, {
          error: 'JSON inválido.'
        });
      }

      if (!SYMBOLS.has(symbol)) {
        return json(res, 400, {
          error: 'Ativo não permitido.'
        });
      }

      const now = Date.now();
      const cached = CACHE.get(symbol);

      if (cached && now - cached.at < 15 * 60 * 1000) {
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
              'X-API-Key': process.env.TINYFISH_API_KEY,
              Accept: 'application/json'
            },
            signal: controller.signal
          }
        );

        if (!response.ok) {
          return json(res, 502, {
            error: `TinyFish retornou HTTP ${response.status}.`
          });
        }

        const data = await response.json();

        const records = Array.isArray(data.results)
          ? data.results
          : [];

        const result = {
          symbol,
          consultedAt: new Date().toISOString(),
          results: records.slice(0, 10).map(x => ({
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

    // API de simulação já existente
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
        return json(res, 200, await PAPER.refresh());
      }

      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Método inválido.'
        });
      }

      let requestBody = '';

      for await (const chunk of req) {
        requestBody += chunk;

        if (requestBody.length > 1024) {
          return json(res, 413, {
            error: 'Requisição extensa.'
          });
        }
      }

      let body = {};

      try {
        body = requestBody
          ? JSON.parse(requestBody)
          : {};
      } catch {
        return json(res, 400, {
          error: 'JSON inválido.'
        });
      }

      if (u.pathname === '/api/paper/pause') {
        return json(res, 200, PAPER.pause(body.paused));
      }

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
                  'X-API-Key': process.env.TINYFISH_API_KEY,
                  Accept: 'application/json'
                },
                signal: ctrl.signal
              }
            );

            if (!response.ok) {
              throw new Error('TinyFish indisponível');
            }

            const raw = await response.json();
            const now = Date.now();

            const recent = (
              Array.isArray(raw.results)
                ? raw.results
                : []
            ).filter(x => {
              const date = Date.parse(x.date || '');

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
              reason: 'TinyFish sem contexto verificável'
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

      if (u.pathname === '/api/paper/enter') {
        if (typeof body.symbol !== 'string') {
          return json(res, 400, {
            error: 'Ativo obrigatório.'
          });
        }

        try {
          return json(
            res,
            200,
            await PAPER.enter(body.symbol)
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

    // Servir somente arquivos públicos
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
        : decodeURIComponent(u.pathname).replace(/^\/+/, '');

    const full = path.resolve(ROOT, requested);

    if (!full.startsWith(ROOT + path.sep)) {
      return json(res, 403, {
        error: 'Acesso negado.'
      });
    }

    // Proteger motores internos, estados e segredos
    const privateFile =
      /(^|\/)\./.test(requested) ||
      /\.(env|lock|md)$/i.test(requested) ||
      /^(server\.js|package\.json|quant-auto-bot\.js|quant-paper-bot\.js|quant-scalp-bot\.js|quant-(?:auto|paper|scalp)-state\.json(?:\.tmp)?)$/i.test(requested);

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
    console.error('SERVER_ERROR', error.message);

    return json(res, 500, {
      error: 'Erro interno.'
    });
  }
});

// Iniciar servidor
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Agente Quant V3 ativo na porta ${PORT}`
  );
});

// Iniciar robô de 5 minutos
AUTO.start();

// Iniciar Scalping de 1 minuto
SCALP.start();
