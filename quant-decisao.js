/* Quant V3: revisão externa assistiva, sem envio de ordens.
   Requer endpoint /api/tinyfish/context existente. Não altera score ou backtest.
   Consulta durante a análise, somente para candidatos elegíveis.
   Em caso de falha ou fontes insuficientes, exige revisão manual. */
(() => {
 'use strict';
 const $=id=>document.getElementById(id);
 const DAYS=72*3600*1000;
 const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA'];
 const sec=document.createElement('section');sec.className='card';sec.id='quant-decisao';
 sec.innerHTML='<h2>Validação externa da decisão</h2><p class="mut">Somente observação e alertas manuais. A análise externa não altera a nota técnica.</p><label class="mut">PIN do Quant (apenas nesta sessão)</label><input id="qd-pin" type="password" autocomplete="off" style="width:100%;padding:10px;background:#0d1520;border:1px solid #25354a;color:#fff;border-radius:8px"><p id="qd-info" class="mut">Preencha o PIN antes de Analisar. Não informe a chave da API.</p><div id="qd-results"></div>';
 const anchor=$('resumo');if(!anchor)return;anchor.insertAdjacentElement('afterend',sec);
 let scanning=false;
 const safe=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function dateParse(s){if(!s)return null;const t=Date.parse(s);return Number.isFinite(t)?t:null;}
 function assess(data,symbol){
  const now=Date.now();const items=(Array.isArray(data.results)?data.results:[]).filter(x=>{
   const d=dateParse(x.date);return d&&d<=now&&now-d<=DAYS&&typeof x.url==='string'&&/^https:\/\//i.test(x.url)&& /(?:ethereum|ether|eth\b)/i.test(symbol==='ETH' ? ((x.title||'')+' '+(x.snippet||'')) : '');
  });
  // Não inferimos sentimento por palavras-chave: fontes recentes não implicam notícia positiva.
  return {status:'REVISAR', count:items.length, message:items.length?'Há notícias recentes relacionadas ao ativo, mas seu impacto requer verificação.':'Nenhuma evidência recente suficiente; contexto inconclusivo.'};
 }
 async function lookup(sym,pin){
  const r=await fetch('/api/tinyfish/context',{method:'POST',headers:{'Content-Type':'application/json','X-Quant-Pin':pin},body:JSON.stringify({symbol:sym}),cache:'no-store'});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return assess(data,sym);
 }
 async function review(){if(scanning)return;scanning=true;
  const out=$('qd-results'),info=$('qd-info');out.replaceChildren();
  const pin=$('qd-pin').value;
  if(!pin){info.textContent='Sem PIN: não há validação externa; não considere sinal algum liberado por este módulo.';scanning=false;return;}
  const eligible=Object.entries(typeof LASTA!=='undefined'?LASTA:{}).filter(([sym,a])=>ASSETS.includes(sym.slice(0,-4))&&a.score>=CFG.scoreMin&&!a.veto&&a.ver?.[0]==='ok'&&a.p);
  if(!eligible.length){info.textContent='Sem candidatos técnicos válidos. TinyFish não foi acionado.';scanning=false;return;}
  info.textContent='Verificando contexto dos candidatos técnicos…';
  for(const [sym,a] of eligible){const label=document.createElement('div');label.style='border-top:1px solid #25354a;padding:10px 0';out.append(label);
   try{const x=await lookup(sym.slice(0,-4),pin);label.innerHTML=`<b>${safe(sym)}</b> — <span style="color:#ffbd45">REVISÃO MANUAL OBRIGATÓRIA</span><div class="mut">${safe(x.message)} Fontes relevantes recentes: ${x.count}. Nota técnica: ${a.score}/100.</div>`;}
   catch(e){label.innerHTML=`<b>${safe(sym)}</b> — <span style="color:#ff5a6e">CONTEXTO INDISPONÍVEL</span><div class="mut">${safe(e.message)}. Não liberar automaticamente.</div>`;}
  }
  info.textContent='Concluído. Nenhum contexto é tratado como autorização automática de entrada.';
  scanning=false;
 }
 // Observa quando o usuário aciona Analisar e a varredura técnica termina.
 $('go')?.addEventListener('click',()=>{
  const started=Date.now();const poll=setInterval(()=>{
   if(!$('go')?.disabled && Date.now()-started>250){clearInterval(poll);review();}
   if(Date.now()-started>90000)clearInterval(poll);
  },400);
 });
 // Executa uma primeira revisão quando a varredura de inicialização terminar, se houver PIN.
 $('qd-pin').addEventListener('change',()=>{if(Object.keys(typeof LASTA!=='undefined'?LASTA:{}).length)review();});
})();
