
'use strict';

// AGENTE QUANT - PAINEL UNIFICADO V5.2
// Central de operacoes conectada ao executor
// Apenas dinheiro ficticio

(() => {
  const $ = id => document.getElementById(id);

  const money = value =>
    Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4
    }) + ' USDT';

  const price = value =>
    Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    });

  const dateTime = value => {
    if (!value) return 'Nenhuma';

    const date = new Date(value);

    return Number.isNaN(date.getTime())
      ? 'Data indisponivel'
      : date.toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo'
        });
  };

  const pin = () => $('pin')?.value || '';

  // =========================================
  // PAINEL DO MOTOR UNIFICADO
  // =========================================

  const root = document.createElement('section');

  root.id = 'quant-unified-panel';

  root.style.cssText = [
    'background:#15202e',
    'color:#e8eef6',
    'padding:18px',
    'border:1px solid #2c4057',
    'border-radius:18px',
    'margin:16px 0',
    'overflow-wrap:anywhere'
  ].join(';');

  root.innerHTML = `
    <h2>🤖 Agente Quant V5.2 — Scalping</h2>

    <p>
      Executor automático exclusivamente fictício.
      Analisa 20 criptomoedas, procura sinais de
      scalping de 1 e 5 minutos e acompanha as
      posições abertas a cada 5 segundos.
    </p>

    <div style="
      display:flex;
      flex-wrap:wrap;
      gap:12px;
      margin:15px 0
    ">
      <label>
        Entrada USDT
        <input
          id="quStake"
          type="number"
          value="50"
          readonly
          style="display:block;width:105px"
        >
      </label>

      <label>
        Meta diária USDT
        <input
          id="quGoal"
          type="number"
          value="30"
          readonly
          style="display:block;width:105px"
        >
      </label>

      <label>
        Perda máxima USDT
        <input
          id="quLoss"
          type="number"
          value="20"
          readonly
          style="display:block;width:105px"
        >
      </label>

      <label>
        Início Brasília
        <input
          id="quStart"
          type="time"
          value="09:00"
          style="display:block"
        >
      </label>
    </div>

    <div style="
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin:12px 0
    ">
      <button id="quSave" type="button">
        Salvar parâmetros
      </button>

      <button id="quSwitch" type="button">
        Ativar executor VIRTUAL
      </button>

      <button id="quRefresh" type="button">
        Atualizar operações
      </button>

      <button id="quTest" type="button">
        Testar compra e venda fictícias
      </button>
    </div>

    <p id="quMsg">
      Informe o PIN na seção TinyFish.
    </p>

    <div
      id="quSummary"
      style="
        background:#08131f;
        padding:14px;
        border-radius:12px
      "
    >
      Aguardando dados do executor...
    </div>

    <p id="quDiag"></p>

    <h3>Teste isolado — não altera a carteira</h3>
    <div id="quTestResult">
      Nenhum teste realizado.
    </div>

    <h3>Compras abertas</h3>
    <div id="quPositions"></div>

    <h3>Compras e vendas concluídas</h3>
    <div id="quTrades"></div>

    <h3>Validação das 20 moedas</h3>
    <div id="quScans"></div>

    <h3>Atividade do executor</h3>
    <div id="quEvents"></div>

    <p style="color:#a9bad0">
      Somente simulação. A estratégia é
      experimental e não garante lucro.
    </p>
  `;

  const anchor = $('central-operacoes') || $('radar');

  if (anchor) {
    anchor.before(root);
  } else {
    document.body.append(root);
  }

  // =========================================
  // CENTRAL DE OPERACOES V5.2
  // =========================================

  const central = document.createElement('section');

  central.id = 'quant-unified-central';

  central.style.cssText = [
    'background:#15202e',
    'color:#e8eef6',
    'padding:18px',
    'border:1px solid #2c4057',
    'border-radius:18px',
    'margin:16px 0',
    'overflow-wrap:anywhere'
  ].join(';');

  central.innerHTML = `
    <h2>📊 Central de Operações — Agente Quant</h2>

    <p style="color:#a9bad0">
      Compras, vendas, ganhos e perdas do
      Motor Unificado V5.2.
      Somente dinheiro fictício.
    </p>

    <div
      id="quCentralCards"
      style="
        display:grid;
        grid-template-columns:
          repeat(auto-fit,minmax(135px,1fr));
        gap:10px;
      "
    ></div>

    <h3>🟡 Compras em andamento</h3>
    <div id="quCentralOpen"></div>

    <h3>🟢 Ganhos e 🔴 Perdas</h3>
    <div id="quCentralClosed"></div>

    <p id="quCentralInfo" style="color:#a9bad0">
      Aguardando dados do executor...
    </p>

    <button id="quCentralRefresh" type="button">
      Atualizar operações
    </button>

    <p style="color:#a9bad0">
      Atualização automática da tela a cada
      15 segundos. Valores líquidos simulados.
    </p>
  `;

  root.after(central);

  // Oculta a central antiga, que consultava
  // somente os robos de 1 e 5 minutos.
  const oldCentral = $('central-operacoes');

  if (oldCentral) {
    oldCentral.style.display = 'none';
  }

  // Mantem o atalho "Operacoes" funcionando.
  document
    .querySelectorAll('a[href="#central-operacoes"]')
    .forEach(link => {
      link.href = '#quant-unified-central';
    });

  // =========================================
  // COMUNICACAO COM O EXECUTOR
  // =========================================

  async function api(route, payload) {
    if (!pin()) {
      throw Error('Informe o PIN na seção TinyFish');
    }

    const options = {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        'X-Quant-Pin': pin()
      },
      cache: 'no-store'
    };

    if (payload !== undefined) {
      options.headers['Content-Type'] =
        'application/json';

      options.body = JSON.stringify(payload);
    }

    const response = await fetch(
      '/api/quant-unified/' + route,
      options
    );

    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error || 'HTTP ' + response.status);
    }

    return data;
  }

  function line(parent, value, color) {
    const item = document.createElement('div');

    item.textContent = value;

    item.style.cssText = [
      'padding:10px 0',
      'border-bottom:1px solid #304359',
      'line-height:1.65',
      color ? 'color:' + color : ''
    ].join(';');

    parent.append(item);
  }

  function card(parent, label, value, color) {
    const el = document.createElement('div');

    el.style.cssText = [
      'background:#08131f',
      'border-radius:12px',
      'padding:14px',
      'min-width:0'
    ].join(';');

    const title = document.createElement('small');

    title.textContent = label;
    title.style.cssText =
      'display:block;color:#a9bad0;margin-bottom:7px';

    const amount = document.createElement('strong');

    amount.textContent = String(value);
    amount.style.cssText = [
      'display:block',
      'font-size:20px',
      'overflow-wrap:anywhere',
      color ? 'color:' + color : ''
    ].join(';');

    el.append(title, amount);
    parent.append(el);
  }

  function localDay(value) {
    const d = new Date(value);

    if (Number.isNaN(d.getTime())) {
      return '';
    }

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d);

    const v = key =>
      parts.find(x => x.type === key)?.value || '';

    return v('year') + '-' + v('month') + '-' + v('day');
  }

  function renderCentral(data) {
    const cards = $('quCentralCards');
    const open = $('quCentralOpen');
    const closed = $('quCentralClosed');

    cards.replaceChildren();
    open.replaceChildren();
    closed.replaceChildren();

    const positions = data.positions || [];
    const trades = data.trades || [];

    const todayTrades = trades.filter(t =>
      localDay(t.closedAt) === data.day
    );

    const gains = todayTrades
      .filter(t => Number(t.net) > 0)
      .reduce((sum, t) =>
        sum + Number(t.net), 0);

    const lossesAmount = todayTrades
      .filter(t => Number(t.net) < 0)
      .reduce((sum, t) =>
        sum + Number(t.net), 0);

    const result = Number(data.netToday || 0);

    const resultColor =
      result < 0 ? '#ff7777' :
      result > 0 ? '#86e3a0' : '';

    card(cards, 'Saldo fictício',
      money(data.cash));

    card(cards, 'Patrimônio',
      money(data.equity));

    card(cards, 'Resultado diário',
      money(result),
      resultColor);

    card(cards, 'Meta do dia',
      money(data.settings?.goal || 30));

    card(cards, 'Entradas hoje',
      data.openedToday || 0);

    card(cards, 'Operações encerradas hoje',
      todayTrades.length);

    card(cards, 'Losses hoje',
      (data.lossesToday || 0) + '/3');

    card(cards, 'Ganhos realizados hoje',
      money(gains),
      '#86e3a0');

    card(cards, 'Perdas realizadas hoje',
      money(lossesAmount),
      '#ff7777');

    if (!positions.length) {
      line(open, 'Nenhuma compra aberta.');
    }

    for (const p of positions) {
      const mark = Number(p.mark || p.entry);
      const estimated =
        Number(p.qty || 0) *
        mark *
        (1 - 0.001 - 0.0003) -
        Number(p.cost || 0);

      line(
        open,
        (p.sym || p.symbol) +
        ' | Compra: ' + price(p.entry) +
        ' | Atual: ' + price(mark) +
        ' | Resultado estimado: ' +
        money(estimated),
        estimated < 0 ? '#ff7777' : '#86e3a0'
      );
    }

    if (!trades.length) {
      line(closed, 'Nenhuma venda concluída ainda.');
    }

    const sorted = [...trades].sort((a, b) =>
      Date.parse(b.closedAt) -
      Date.parse(a.closedAt)
    );

    for (const t of sorted.slice(0, 50)) {
      const net = Number(t.net || 0);

      line(
        closed,
        (net >= 0 ? '🟢 GANHO' : '🔴 PERDA') +
        ' | ' + (t.symbol || t.sym) +
        ' | ' + money(net) +
        ' | Compra: ' + price(t.entry) +
        ' | Venda: ' + price(t.exit) +
        ' | ' + (t.reason || 'Encerrada') +
        ' | ' + dateTime(t.closedAt),
        net >= 0 ? '#86e3a0' : '#ff7777'
      );
    }

    $('quCentralInfo').textContent =
      'Executor: ' +
      (data.system || 'Motor Unificado') +
      ' | Estado: ' +
      (data.blocking || 'ATIVO') +
      ' | Última análise: ' +
      dateTime(data.lastScan);
  }

  function render(data) {
    $('quSwitch').textContent =
      data.settings.enabled
        ? 'Desligar executor VIRTUAL'
        : 'Ativar executor VIRTUAL';

    $('quStake').value =
      data.settings.stake;

    $('quGoal').value =
      data.settings.goal;

    $('quLoss').value =
      data.settings.lossLimit;

    if (
      document.activeElement !== $('quStart')
    ) {
      $('quStart').value =
        data.settings.start;
    }

    $('quSummary').textContent =
      'Estado: ' +
      (data.blocking || 'ATIVO') +
      ' | Saldo: ' +
      money(data.cash) +
      ' | Patrimônio: ' +
      money(data.equity) +
      ' | Resultado hoje: ' +
      money(data.netToday) +
      ' | Entradas: ' +
      (data.openedToday || 0) +
      ' | Losses: ' +
      (data.lossesToday || 0) +
      '/3 | Última análise: ' +
      dateTime(data.lastScan);

    $('quDiag').textContent =
      'Diagnóstico: ' +
      (data.diagnostic || 'Aguardando');

    const test = data.testTrades?.[0];

    if (test) {
      $('quTestResult').textContent =
        'TESTE ' + test.symbol +
        ' | Compra: ' + price(test.entry) +
        ' | Venda: ' + price(test.exit) +
        ' | Resultado: ' + money(test.net) +
        ' | Não contabilizado na carteira';
    }

    const sections = [
      [
        'quPositions',
        data.positions || [],
        p =>
          p.sym +
          ' | Compra: ' + price(p.entry) +
          ' | Atual: ' + price(p.mark) +
          ' | Nota: ' + (p.score ?? '—')
      ],
      [
        'quTrades',
        data.trades || [],
        t =>
          t.symbol +
          ' | Compra: ' + price(t.entry) +
          ' | Venda: ' + price(t.exit) +
          ' | Resultado: ' + money(t.net) +
          ' | ' + t.reason
      ],
      [
        'quScans',
        data.lastResults || [],
        x =>
          x.sym +
          ' | Nota: ' +
          (x.score ?? '—') +
          '/100 | ' +
          (x.approved ? 'APROVADO' : 'AGUARDANDO') +
          ' | ' + x.why
      ],
      [
        'quEvents',
        data.events || [],
        e =>
          dateTime(e.at) +
          ' | ' + e.text
      ]
    ];

    for (const [id, items, format] of sections) {
      const el = $(id);

      el.replaceChildren();

      if (!items.length) {
        line(el, 'Nenhum registro.');
        continue;
      }

      for (const item of items.slice(
        0,
        id === 'quScans' ? 20 : 30
      )) {
        line(el, format(item));
      }
    }

    renderCentral(data);
  }

  // =========================================
  // ATUALIZACAO AUTOMATICA
  // =========================================

  let busy = false;

  async function action(callback) {
    if (busy) return;

    busy = true;

    try {
      const data = await callback();

      render(data);

      $('quMsg').textContent =
        'Conectado às ' +
        new Date().toLocaleTimeString('pt-BR');

    } catch (error) {
      $('quMsg').textContent =
        'Erro: ' + error.message;

      $('quCentralInfo').textContent =
        'Erro ao atualizar: ' + error.message;

    } finally {
      busy = false;
    }
  }

  function refresh() {
    if (!pin()) return;

    action(() => api('status'));
  }

  $('quRefresh').onclick = refresh;
  $('quCentralRefresh').onclick = refresh;

  $('quSave').onclick = () =>
    action(() =>
      api('config', {
        stake: 50,
        goal: 30,
        lossLimit: 20,
        start: $('quStart').value
      })
    );

  $('quSwitch').onclick = () =>
    action(async () => {
      const status = await api('status');

      return api('switch', {
        enabled: !status.settings.enabled
      });
    });

  $('quTest').onclick = () =>
    action(() =>
      api('test-trade', {
        symbol: 'BTC'
      })
    );

  setInterval(refresh, 15000);

  refresh();
})();
