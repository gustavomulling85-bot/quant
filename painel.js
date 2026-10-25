(function(){
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),SIGS={},SL2={};

/* 1) guarda os sinais que o app desenha, para o painel saber o estado */
const _sig=sigHtml;sigHtml=function(s){SIGS[s.sym]=s;return _sig(s)};

/* 2) nunca perder uma análise agendada porque outra estava rodando;
      e esperar 10 s após o fechamento do candle para o dado estar final */
const _scan=scan;
scan=async function(pre){
 while(busy)await sleep(400);
 const off=Date.now()%DUR4;if(!pre&&off<1e4)await sleep(1e4-off);
 for(const k in SIGS)delete SIGS[k];
 await _scan(pre);renderStatus()};

/* 3) backtest com ~16 meses (3000 candles de 4H) em vez de ~5 */
const _h4=hist4;hist4=(sym,n)=>_h4(sym,Math.max(n,3000));
const bp=document.querySelector("#bt p");
if(bp)bp.textContent="Reproduz as regras V2 (só compra, 4H) no histórico da Binance (~16 meses, BTC e ETH): quantos sinais teria dado e como teriam se saído.";

/* 4) pré-aviso reavaliado a cada 5 min nos últimos 15 min do candle */
setInterval(()=>{const now=Date.now(),rem=DUR4-now%DUR4;
 if(rem<=9e5&&rem>6e4){const b=Math.floor(now/DUR4)+"-"+Math.floor(rem/3e5);if(!SL2[b]){SL2[b]=1;scan(true)}}},30000);

/* 5) painel de status no topo */
document.querySelector(".top").insertAdjacentHTML("afterend",'<div class="card" id="st"></div>');
function renderStatus(){const el=$("st");if(!el)return;
 const now=Date.now(),s=load(),bl=bloqueio(s),L=Object.values(SIGS),
  real=L.filter(x=>!x.pre),pr=L.filter(x=>x.pre),novos=real.filter(x=>now-x.fecha<18e5);
 const f=x=>`<b>${x.sym.slice(0,-4)}</b>: entrada ${fmt(x.p.e)} · stop ${fmt(x.p.stop)} · TP1 ${fmt(x.p.tp1)} · TP2 ${fmt(x.p.tp2)}`;
 let tit="AGUARDAR",cor="var(--mut)",sub="Nenhuma condição de entrada no momento.";
 if(bl){tit="PARADO";cor="var(--bad)";sub=bl}
 else if(novos.length){tit="ENTRAR AGORA — COMPRA";cor="var(--ok)";
  sub=novos.map(f).join("<br>")+`<br>Candle fechou às ${hm(novos[0].fecha)} (há ${Math.round((now-novos[0].fecha)/6e4)} min). Confira o preço ao vivo e o aviso de sinal envelhecido no card.`}
 else if(pr.length){tit="PREPARAR COMPRA";cor="var(--acc)";
  sub=pr.map(f).join("<br>")+`<br>O candle de 4H fecha às ${hm(pr[0].fecha)}. Só entre se o sinal se confirmar no fechamento.`}
 else if(real.length){tit="SINAL ANTIGO";cor="var(--bad)";sub="O último sinal tem mais de 30 minutos. Não entre atrasado."}
 const notas=[...document.querySelectorAll("#out .card")].map(c=>{const h=c.querySelector("h2"),n=c.querySelector(".num");
  return h&&n?`${h.textContent.split("/")[0]} ${n.textContent}`:""}).filter(Boolean).join(" · ");
 el.style.borderColor=cor;
 el.innerHTML=`<div style="font-size:18px;font-weight:700;color:${cor}">${tit}</div><div style="margin-top:6px;font-size:14px">${sub}</div><div class="mut" style="margin-top:8px">Notas agora: ${notas||"–"} (mínimo ${CFG.scoreMin}) · próximo fechamento 4H às <span id="st-h"></span> (<span id="st-t"></span>)</div>`;
 tick()}
function tick(){const now=Date.now(),f=Math.ceil((now+1)/DUR4)*DUR4,r=Math.max(0,f-now),
  h=Math.floor(r/36e5),m=Math.floor(r%36e5/6e4),s=Math.floor(r%6e4/1e3),a=$("st-h"),b=$("st-t");
 if(a)a.textContent=hm(f);if(b)b.textContent=`${h}h ${String(m).padStart(2,"0")}m ${String(s).padStart(2,"0")}s`}
setInterval(tick,1000);
renderStatus();setTimeout(()=>scan(false),1500);
})();
