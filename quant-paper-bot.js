'use strict';
// Simulação somente. Não conecta conta nem envia ordens reais.
// Módulo independente para o Agente Quant V3.
const SYMBOLS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA'];
const MAX_TRADES_PER_DAY=3;
const TARGET_DAILY=0.005; // +0,5% do saldo virtual inicial do dia
const LOSS_DAILY=0.01; // -1% do saldo virtual inicial do dia
const CAPITAL_PER_TRADE=0.10; // 10% do saldo simulado
const FEE=0.001; // 0,1% por lado
const initial=1000;
let balance=initial, day='', opening=initial, trades=0, positions=[], history=[], lastCheck=null;
const getDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const makeJson=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
function resetDay(){const d=getDate();if(day!==d){day=d;opening=balance;trades=0;}}
function pnl(){return (balance-opening)/opening;}
async function candles(symbol){
 const url='https://data-api.binance.vision/api/v3/klines?'+new URLSearchParams({symbol:symbol+'USDT',interval:'1d',limit:'230'});
 const r=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw new Error('Falha Binance '+r.status);
 const k=await r.json(); if(!Array.isArray(k)||k.length<221)throw new Error('Histórico insuficiente');
 // Exclui candle ainda aberto.
 return k.slice(0,-1).map(x=>({t:Number(x[0]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),v:Number(x[5])}));
}
function ema(prices,n){let x=prices.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<prices.length;i++)x=prices[i]*(2/(n+1))+x*(1-2/(n+1));return x;}
function eligibility(k){const a=k.at(-1),px=k.map(x=>x.c),e200=ema(px,200),e50=ema(px,50),high20=Math.max(...k.slice(-21,-1).map(x=>x.h));const avg=k.slice(-21,-1).reduce((s,x)=>s+x.v,0)/20;
 return {ok:a.c>e200&&e50>e200&&a.c>high20&&a.c<=high20*1.03&&a.v>avg,price:a.c,candle:a.t};}
async function contextCheck(symbol,pin,origin){
 // Reutiliza a rota já existente e NÃO trata notícias como autorização de compra.
 const r=await fetch(origin+'/api/tinyfish/context',{method:'POST',headers:{'Content-Type':'application/json','X-Quant-Pin':pin},body:JSON.stringify({symbol}),signal:AbortSignal.timeout(20000)});
 if(!r.ok)throw new Error('Contexto indisponível ('+r.status+')');
 const data=await r.json();const now=Date.now();const sources=(data.results||[]).filter(x=>x.date&&Number.isFinite(Date.parse(x.date))&&Date.parse(x.date)<=now&&now-Date.parse(x.date)<72*3600e3&&/^https:\/\//.test(x.url||''));
 return {count:sources.length,status:'REVISÃO MANUAL'}; // NÃO autoriza trade mesmo com notícias recentes.
}
async function inspect({pin,origin}){
 resetDay();const records=[];
 for(const symbol of SYMBOLS){
  try{const k=await candles(symbol),sig=eligibility(k);if(!sig.ok){records.push({symbol,status:'SEM SINAL'});continue;}
   const ctx=await contextCheck(symbol,pin,origin);
   // Somente SINAL PENDENTE: para liberar simulação o usuário confirma via rota específica.
   records.push({symbol,status:'PENDENTE DE REVISÃO',price:sig.price,candle:sig.candle,context:ctx});
  }catch(e){records.push({symbol,status:'INDISPONÍVEL',reason:e.message});}
 }
 lastCheck={at:new Date().toISOString(),records};return lastCheck;
}
function simulateConfirmed(symbol,price){
 resetDay();if(!SYMBOLS.includes(symbol)||!Number.isFinite(price)||price<=0)throw Error('Entrada inválida');
 if(pnl()>=TARGET_DAILY||pnl()<=-LOSS_DAILY)throw Error('Limite diário atingido');
 if(trades>=MAX_TRADES_PER_DAY)throw Error('Máximo de operações do dia');
 if(positions.some(p=>p.symbol===symbol))throw Error('Já existe posição no ativo');
 const candidate=lastCheck?.records?.find(x=>x.symbol===symbol&&x.status==='PENDENTE DE REVISÃO'&&Date.now()-Date.parse(lastCheck.at)<30*60e3);
 if(!candidate)throw Error('Candidato sem revisão recente');
 const budget=Math.min(opening*CAPITAL_PER_TRADE,balance);const qty=budget/price;
 balance-=budget*(1+FEE);positions.push({symbol,entry:price,qty,feeEntry:budget*FEE,stop:price*0.99,take:price*1.015,opened:new Date().toISOString()});trades++;
 return {symbol,simulation:true,entry:price,qty,stop:price*.99,take:price*1.015};
}
function settle(symbol,price){
 const idx=positions.findIndex(p=>p.symbol===symbol);if(idx<0)throw Error('Sem posição simulada');const p=positions[idx];if(!Number.isFinite(price)||price<=0)throw Error('Preço inválido');
 const gross=p.qty*price,fee=gross*FEE;balance+=gross-fee;const result=gross-fee-p.qty*p.entry-p.feeEntry;
 positions.splice(idx,1);history.unshift({symbol,simulation:true,result,at:new Date().toISOString()});return {result,balance};
}
function snapshot(){resetDay();return {mode:'PAPER_ONLY',day,balance,opening,dayPnl:pnl(),dailyProfitStop:TARGET_DAILY,dailyLossStop:LOSS_DAILY,maxTrades:MAX_TRADES_PER_DAY,trades,positions,history:history.slice(0,20),lastCheck};}
module.exports={inspect,simulateConfirmed,settle,snapshot};
