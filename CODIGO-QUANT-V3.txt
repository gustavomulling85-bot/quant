/* Quant V3 — módulo independente de inteligência externa TinyFish.
   Não altera notas técnicas, stops, ordens ou backtests. */
(() => {
  'use strict';
  const allowed = ['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA'];
  const $ = id => document.getElementById(id);
  const css = document.createElement('style');
  css.textContent = `.qi-card{background:#15202e;border:1px solid #25354a;border-radius:12px;padding:12px;margin:12px 0;color:#e8edf3}.qi-card h2{margin:0 0 8px;font-size:17px}.qi-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px}.qi-controls label{font-size:12px;color:#9eb0c3}.qi-controls select,.qi-controls input{width:100%;box-sizing:border-box;border:1px solid #34465c;border-radius:8px;background:#0d1520;color:#fff;padding:9px;font:inherit}.qi-actions{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}.qi-actions button,.qi-per-coin{border:0;border-radius:9px;padding:10px;background:#f0b90b;color:#211900;font:600 14px system-ui}.qi-actions button:disabled{opacity:.5}.qi-note{font-size:12px;color:#9eb0c3}.qi-result{margin-top:10px;border-top:1px solid #334355;padding-top:10px;overflow-wrap:anywhere}.qi-result a{color:#f0b90b}.qi-result small{display:block;color:#9eb0c3}.qi-status{margin-top:8px;color:#9eb0c3;font-size:13px}.qi-positive{color:#2fd28c}.qi-caution{color:#ffbd45}`;
  document.head.appendChild(css);
  const section = document.createElement('section');
  section.className='qi-card';
  section.id='qi-panel';
  section.innerHTML=`<h2>Inteligência de mercado — TinyFish</h2>
  <p class="qi-note">Consulta notícias e fontes externas. A nota do Quant continua independente. Os resultados não são um sinal de compra e não bloqueiam operações automaticamente.</p>
  <div class="qi-controls">
    <label>Ativo<select id="qi-asset">${allowed.map(s=>`<option value="${s}">${s}/USDT</option>`).join('')}</select></label>
    <label>PIN do Quant<input id="qi-pin" type="password" autocomplete="off" placeholder="PIN privado" maxlength="128"></label>
  </div>
  <div class="qi-actions"><button id="qi-run" type="button">Pesquisar contexto</button><button id="qi-clear" type="button" style="background:#25354a;color:#fff">Limpar resultado</button></div>
  <p id="qi-status" class="qi-status" role="status">A pesquisa exige o PIN configurado no Render. Não informe a chave da API neste campo.</p>
  <div id="qi-technical"></div><div id="qi-results"></div>`;
  const anchor=$('resumo');
  if(!anchor){console.warn('Quant Intelligence: painel principal indisponível');return;}
  anchor.insertAdjacentElement('afterend',section);
  const state={busy:false};
  function txt(tag,value,parent,cls){const e=document.createElement(tag);e.textContent=value||'';if(cls)e.className=cls;parent.append(e);return e;}
  function technical(sym){const el=$('qi-technical');el.replaceChildren();const a=typeof LASTA!=='undefined' ? LASTA[sym+'USDT'] : undefined;
    if(!a){txt('p','Nota técnica: execute Analisar no Quant para consultar a leitura mais recente.',el,'qi-note');return;}
    const p=document.createElement('p');p.className='qi-note';p.textContent=`Quant técnico: ${a.score}/100 · ${a.veto?'Veto EMA200 ativo':a.ver[1]} · ${a.ver[2]}`;el.append(p);
  }
  async function run(){if(state.busy)return;
    const symbol=$('qi-asset').value, pin=$('qi-pin').value;
    if(!allowed.includes(symbol))return;
    if(!pin){$('qi-status').textContent='Informe o PIN de acesso do Quant para pesquisar.';return;}
    state.busy=true;$('qi-run').disabled=true;$('qi-results').replaceChildren();technical(symbol);
    $('qi-status').textContent=`Pesquisando fontes públicas sobre ${symbol}…`;
    try{
      const resp=await fetch('/api/tinyfish/context',{method:'POST',headers:{'Content-Type':'application/json','X-Quant-Pin':pin},body:JSON.stringify({symbol}),cache:'no-store'});
      const data=await resp.json();
      if(!resp.ok)throw new Error(data.error||`Falha HTTP ${resp.status}`);
      const results=Array.isArray(data.results)?data.results:[];
      $('qi-status').textContent=`${symbol}: ${results.length} fonte(s) · consulta ${new Date(data.consultedAt).toLocaleString('pt-BR')}${data.cached?' (em cache)':''}.`;
      const box=$('qi-results');
      txt('p','Confira se cada notícia realmente se refere ao ativo e se foi publicada recentemente. Notícias antigas ou sem data não validam entradas.',box,'qi-note');
      if(!results.length)txt('p','Não foram encontradas fontes. Contexto externo inconclusivo.',box,'qi-note');
      for(const item of results){
        const card=document.createElement('div');card.className='qi-result';box.append(card);
        if(typeof item.url==='string' && /^https:\/\//i.test(item.url)){
          const a=document.createElement('a');a.href=item.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=item.title||item.url;card.append(a);
        }else txt('b',item.title||'Fonte sem link',card);
        if(item.snippet)txt('p',item.snippet,card);
        txt('small',item.date?`Data informada: ${item.date}`:'Sem data confirmada',card);
      }
    }catch(e){$('qi-status').textContent=`Pesquisa não concluída: ${e.message}`;}
    finally{$('qi-pin').value='';state.busy=false;$('qi-run').disabled=false;}
  }
  $('qi-run').addEventListener('click',run);
  $('qi-clear').addEventListener('click',()=>{$('qi-results').replaceChildren();$('qi-pin').value='';$('qi-status').textContent='Resultado limpo.';});
  $('qi-asset').addEventListener('change',()=>technical($('qi-asset').value));
  technical('BTC');
})();
