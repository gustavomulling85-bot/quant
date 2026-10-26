
'use strict';
(() => {
 const $ = id => document.getElementById(id);
 const root = document.createElement('section');
 root.id = 'quant-unified-panel';
 root.style.cssText='background:#15202e;color:#e8eef6;padding:18px;border:1px solid #2c4057;border-radius:18px;margin:16px 0;overflow-wrap:anywhere';
 root.innerHTML=`<h2>🤖 Motor Unificado V3 — SOMENTE SIMULAÇÃO</h2>
 <p>Analisa 20 moedas em 1m/5m/15m/1h. Seleção por pontuação e confirmação de tendência. Compra e venda automáticas somente com sinais aprovados. Desligue os dois robôs antigos antes de ativar.</p>
 <div style="display:flex;gap:12px;flex-wrap:wrap"><label>Entrada USDT<br><input id="quStake" type="number" min="10" max="100" value="10" style="width:110px"></label><label>Meta USDT<br><input id="quGoal" type="number" min="1" max="100" value="50" style="width:110px"></label><label>Perda máxima USDT<br><input id="quLoss" type="number" min="1" max="100" value="20" style="width:110px"></label><label>Início Brasília<br><input id="quStart" type="time" value="09:00"></label></div>
 <div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0"><button id="quSave" type="button">Salvar parâmetros</button><button id="quSwitch" type="button">Ativar executor VIRTUAL</button><button id="quRefresh" type="button">Atualizar operações</button><button id="quTest" type="button">Testar compra e venda fictícias</button></div>
 <p id="quMsg">Informe o PIN na seção TinyFish.</p><div id="quSummary" style="background:#08131f;padding:12px;border-radius:10px">Aguardando status...</div><p id="quDiag"></p>
 <h3>Teste isolado — não altera a carteira</h3><div id="quTestResult">Nenhum teste realizado.</div>
 <h3>Compras abertas</h3><div id="quPositions"></div><h3>Compras e vendas concluídas</h3><div id="quTrades"></div><h3>Validação das 20 moedas</h3><div id="quScans"></div><h3>Atividade do executor</h3><div id="quEvents"></div>
 <p style="color:#a9bad0">Somente dinheiro fictício. Estratégia experimental; sem garantia de lucro. Estado em arquivo temporário do Render, sujeito a perda em reinicializações.</p>`;
 const anchor = $('central-operacoes') || $('radar'); if(anchor)anchor.before(root);else document.body.append(root);
 const money = v => Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:4})+' USDT';
 const pin = () => $('pin')?.value || '';
 function line(parent,value){const p=document.createElement('p');p.textContent=value;p.style.cssText='padding:8px 0;margin:0;border-bottom:1px solid #304359';parent.append(p)}
 async function api(route,payload){if(!pin())throw Error('Informe o PIN na seção TinyFish');const r=await fetch('/api/quant-unified/'+route,{method:payload?'POST':'GET',headers:{'X-Quant-Pin':pin(),...(payload?{'Content-Type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,cache:'no-store'});const d=await r.json();if(!r.ok)throw Error(d.error||'HTTP '+r.status);return d}
 function render(d){
  $('quSwitch').textContent=d.settings.enabled?'Desligar executor VIRTUAL':'Ativar executor VIRTUAL';
  if(document.activeElement?.tagName!=='INPUT')for(const [id,key] of [['quStake','stake'],['quGoal','goal'],['quLoss','lossLimit'],['quStart','start']])$(id).value=d.settings[key];
  $('quSummary').textContent='Estado: '+(d.blocking||'ATIVO')+' | Saldo: '+money(d.cash)+' | Patrimônio: '+money(d.equity)+' | Resultado hoje: '+money(d.netToday)+' | Entradas: '+d.openedToday+' | Losses: '+d.lossesToday+'/3 | Última análise: '+(d.lastScan?new Date(d.lastScan).toLocaleString('pt-BR'):'nenhuma');
  $('quDiag').textContent='Diagnóstico: '+(d.diagnostic||'aguardando');
  const t=d.testTrades?.[0];if(t)$('quTestResult').textContent='TESTE '+t.symbol+' | Compra: '+Number(t.entry).toFixed(6)+' | Venda: '+Number(t.exit).toFixed(6)+' | Resultado simulado: '+money(t.net)+' | Não contabilizado na carteira';
  const sections=[['quPositions',d.positions||[],x=>x.sym+' | compra '+x.entry+' | atual '+x.mark+' | score '+(x.score??'—')],['quTrades',d.trades||[],x=>x.symbol+' | Compra '+x.entry+' | Venda '+x.exit+' | '+money(x.net)+' | '+x.reason],['quScans',d.lastResults||[],x=>x.sym+' | Nota: '+(x.score??'—')+'/100 | '+(x.approved?'APROVADO':'AGUARDANDO')+' | '+x.why],['quEvents',d.events||[],x=>new Date(x.at).toLocaleTimeString('pt-BR')+' | '+x.text]];
  for(const [id,items,fmt] of sections){const e=$(id);e.replaceChildren();if(!items.length)line(e,'Nenhum registro');for(const x of items.slice(0,id==='quScans'?20:30))line(e,fmt(x))}
 }
 let busy=false;
 async function action(f){if(busy)return;busy=true;try{const d=await f();render(d);$('quMsg').textContent='Conectado às '+new Date().toLocaleTimeString('pt-BR')}catch(e){$('quMsg').textContent='Erro: '+e.message}finally{busy=false}}
 const refresh=()=>{if(pin())action(()=>api('status'))};
 $('quRefresh').onclick=refresh;
 $('quSave').onclick=()=>action(()=>api('config',{stake:Number($('quStake').value),goal:Number($('quGoal').value),lossLimit:Number($('quLoss').value),start:$('quStart').value}));
 $('quSwitch').onclick=()=>action(async()=>{const d=await api('status');return api('switch',{enabled:!d.settings.enabled})});
 $('quTest').onclick=()=>action(()=>api('test-trade',{symbol:'BTC'}));
 setInterval(refresh,15000);refresh();
})();
