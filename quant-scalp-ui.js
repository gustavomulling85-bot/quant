(()=>{'use strict';
const $=id=>document.getElementById(id);if($('quantScalpPanel'))return;
const anchor=$('quantAutoPanel')||$('radar');if(!anchor)return;
const section=document.createElement('section');section.id='quantScalpPanel';
section.innerHTML=`<h2>⚡ Scalping 1 minuto — SOMENTE SIMULAÇÃO</h2>
<p class="mut tight">Estratégia experimental separada do robô de 5 minutos. Analisa candles fechados de 1 minuto das 20 moedas e procura sinais com tendência, RSI, volume e amostras históricas com resultado líquido positivo. Uma operação por vez; tenta encerrar cerca de 60 segundos após a compra. Taxas e spread podem transformar vela verde em prejuízo. Probabilidades históricas NÃO são previsão.</p>
<div class="grid"><label>Valor por entrada (USDT)<input id="qsStake" type="number" min="10" max="500" value="10"></label><label>Meta diária (USDT)<input id="qsGoal" type="number" min="0.01" max="100" value="50"></label><label>Perda diária máxima (USDT)<input id="qsLoss" type="number" min="0.01" max="100" value="20"></label><label>Hora inicial (Brasília)<input id="qsStart" type="time" value="09:00"></label></div>
<p class="mut tight">Trava: 3 operações com prejuízo no dia, meta diária ou perda de 20 USDT. Entrada a mercado fictícia pelo ask + slippage simulado; saída pelo bid − slippage e taxas de 0,1% por lado. A carteira SCALPING começa com 1.000 USDT fictícios e NÃO compartilha saldo ou limites com o robô de 5 minutos.</p>
<div class="row"><button id="qsSave" class="secondary">Salvar scalping</button><button id="qsToggle">Ativar scalping VIRTUAL</button><button id="qsRefresh" class="secondary">Atualizar scalping</button></div>
<p id="qsMessage" class="mut" role="status">Informe seu PIN na seção TinyFish.</p><div id="qsStatus" class="tile">Aguardando leitura.</div>
<h3 style="margin-top:15px">Sinais de 1 minuto — 20 moedas</h3><div id="qsSignals" class="tile">Aguardando leitura.</div>
<h3 style="margin-top:15px">Entradas e saídas do scalping</h3><div id="qsTrades" class="tile">Sem operações.</div><h3 style="margin-top:15px">Atividade scalping</h3><div id="qsEvents" class="tile">Sem eventos.</div>
<p class="mut tight">O servidor precisa permanecer ativo. Estado salvo em arquivo temporário do Render, sujeito a perda após reinícios/deploys. Esta estratégia NÃO passou por backtest fora da amostra, nem demonstra uma vantagem comprovada.</p>`;
anchor.after(section);const nav=document.querySelector('.nav');if(nav){const a=document.createElement('a');a.href='#quantScalpPanel';a.textContent='Scalping 1m';nav.append(a)}
let busy=false,editing=false,polling=false;
function msg(s){$('qsMessage').textContent=s}
function add(el,value,className){const p=document.createElement('p');p.textContent=value;p.className='tight '+(className||'');el.append(p)}
function pin(){const p=$('pin')?.value;if(!p)throw Error('Digite o PIN na secao TinyFish');return p}
async function api(route,payload){const r=await fetch('/api/quant-scalp/'+route,{method:payload?'POST':'GET',headers:{'X-Quant-Pin':pin(),...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{}),cache:'no-store'});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'HTTP '+r.status);return data}
function display(d,force=false){const s=d.settings||{};if(force||!editing){$('qsStake').value=s.stake??10;$('qsGoal').value=s.goal??50;$('qsLoss').value=s.lossLimit??20;$('qsStart').value=s.start??'09:00'}$('qsToggle').textContent=s.enabled?'Desligar scalping VIRTUAL':'Ativar scalping VIRTUAL';
const st=$('qsStatus');st.replaceChildren();[['Estado',d.blocking||'ATIVO'],['Horario Brasilia',d.clockBR],['Inicio',s.start],['Saldo SCALPING',Number(d.cash).toFixed(2)+' USDT'],['Patrimonio simulado',Number(d.equity).toFixed(2)+' USDT'],['Resultado diario',Number(d.netToday).toFixed(4)+' USDT'],['Losses no dia',String(d.lossesToday||0)+'/3'],['Entradas no dia',String(d.openedToday||0)],['Ultima analise',d.lastScan?new Date(d.lastScan).toLocaleString('pt-BR'):'Ainda nao analisou']].forEach(([k,v])=>add(st,k+': '+v));if(d.position){const p=d.position;add(st,'POSIÇÃO ABERTA '+p.sym+' · preco '+p.entry.toFixed(6)+' · saida prevista '+new Date(p.expireMs).toLocaleTimeString('pt-BR'),'ok')}
const sig=$('qsSignals');sig.replaceChildren();for(const v of d.lastResults||[]){let summary=v.sym+' — '+v.status;if(v.samples!==undefined)summary+=' · '+v.samples+' amostras · acertos historicos '+(v.winRate*100).toFixed(1)+'% · media liquida '+v.avgNetPct.toFixed(3)+'%';if(v.reason)summary+=' · '+v.reason;add(sig,summary,v.approved?'ok':'')}if(!sig.children.length)add(sig,'Ainda nao ha analise registrada.');
const tr=$('qsTrades');tr.replaceChildren();for(const t of (d.trades||[]).slice(0,25))add(tr,t.symbol+' · '+t.elapsedSeconds+'s · '+(t.net>=0?'+':'')+t.net.toFixed(4)+' USDT · '+new Date(t.closedAt).toLocaleString('pt-BR'),t.net<0?'bad':'ok');if(!tr.children.length)add(tr,'Nenhuma operacao concluida.');
const ev=$('qsEvents');ev.replaceChildren();for(const e of (d.events||[]).slice(0,25))add(ev,new Date(e.at).toLocaleString('pt-BR')+' — '+e.text,e.type==='loss'||e.type==='warning'?'bad':e.type==='buy'||e.type==='profit'?'ok':'');}
async function action(fn,ok){if(busy)return;busy=true;section.querySelectorAll('button').forEach(x=>x.disabled=true);try{display(await fn(),true);editing=false;msg(ok)}catch(e){msg('Erro: '+e.message)}finally{busy=false;section.querySelectorAll('button').forEach(x=>x.disabled=false)}}
for(const k of ['qsStake','qsGoal','qsLoss','qsStart'])$(k).addEventListener('input',()=>editing=true);
$('qsSave').onclick=()=>action(()=>api('config',{stake:Number($('qsStake').value),goal:Number($('qsGoal').value),lossLimit:Number($('qsLoss').value),start:$('qsStart').value}),'Configuracao salva.');
$('qsToggle').onclick=()=>action(async()=>{const x=await api('status');return api('switch',{enabled:!x.settings.enabled})},'Estado do scalping atualizado.');
$('qsRefresh').onclick=()=>action(()=>api('status'),'Scalping atualizado.');
async function poll(){if(polling||busy||!$('pin')?.value)return;polling=true;try{display(await api('status'));if(!editing)msg('Conectado: '+new Date().toLocaleTimeString('pt-BR'))}catch(e){msg('Falha de leitura: '+e.message)}finally{polling=false}}
setInterval(poll,10000);poll();
})();
