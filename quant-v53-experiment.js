
'use strict';

// Laboratório V5.3 — simulação independente.
// Não executa compras nem modifica a carteira.

function simulateExit({
  entryCost,
  qty,
  candles,
  fee = 0.001,
  slippage = 0.0003,
  maxMinutes = 12,
  targetNet = 0.22,
  stopNet = 0.50,
  armNet = 0.08,
  givebackNet = 0.035,
  floorNet = 0.02
}) {
  if (!(entryCost > 0 && qty > 0) ||
      !Array.isArray(candles) ||
      !candles.length) {
    throw Error('Entrada e candles obrigatorios');
  }

  let peakNet = -Infinity;
  const trail = [];
  let exit = null;

  const count = Math.min(maxMinutes, candles.length);

  for (let i = 0; i < count; i++) {
    const bid = Number(candles[i].close);

    if (!(bid > 0)) {
      throw Error('Candle invalido: ' + i);
    }

    const sellPrice = bid * (1 - slippage);
    const net = qty * sellPrice * (1 - fee) - entryCost;

    peakNet = Math.max(peakNet, net);

    let reason = null;

    if (net >= targetNet) {
      reason = 'ALVO';
    } else if (net <= -stopNet) {
      reason = 'STOP';
    } else if (
      peakNet >= armNet &&
      net > floorNet &&
      peakNet - net >= givebackNet
    ) {
      reason = 'PROTECAO_LUCRO';
    } else if (i === count - 1) {
      reason = 'TEMPO';
    }

    const record = {
      minute: i + 1,
      net: Number(net.toFixed(6)),
      peakNet: Number(peakNet.toFixed(6)),
      reason
    };

    trail.push(record);

    if (reason) {
      exit = { ...record, exitPrice: sellPrice };
      break;
    }
  }

  return { exit, trail };
}

function compareExits(trades, configs) {
  return configs.map(config => {
    const runs = trades.map(trade =>
      simulateExit({ ...trade, ...config })
    );

    const net = runs.reduce(
      (total, result) => total + result.exit.net, 0
    );

    return {
      name: config.name || 'cenario',
      trades: runs.length,
      wins: runs.filter(r => r.exit.net > 0).length,
      losses: runs.filter(r => r.exit.net <= 0).length,
      net: Number(net.toFixed(6)),
      runs
    };
  });
}

module.exports = { simulateExit, compareExits };
