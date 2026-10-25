'use strict';
// QUANT PAPER ONLY: nunca conecta a contas ou envia ordens reais.
const fs=require('node:fs');
const path=require('node:path');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA'];
const START=1000,FEE=.001,MAX_TRADES=3,ALLOC=.10,GOAL=.005,LOSS=.01;
const FILE=process.env.QUANT_PAPER_STATE_FILE||path.join(__dirname,'.quant-paper-state.json');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const empty=()=>({cash:START,positions:[],trades:[],day:today(),dayStart:START,openedToday:0,candidates:[],scanAt:null,paused:false});
let st;try{st=JSON.parse(fs.readFileSync(FILE,'utf8'));if(!Number.isFinite(st.cash)||!Array.isArray(st.positions))throw 0;}catch{st=empty();}
const save=()=>{try{const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(st));fs.renameSync(tmp,FILE)}catch(e){console.warn('Paper persistence unavailable:',e.message)}};
function resetDay(){const d=today();if(st.day!==d){st.day=d;st.dayStart=equity();st.openedToday=0;st.candidates=[];st.scanAt=null;save()}}
function equity(){return st.cash+st.positions.reduce((s,p)=>s+p.qty*p.mark,0)}
function pnl(){return st.dayStart>0?(equity()-st.dayStart)/st.dayStart:0}
function blocked(){return st.paused?'PAUSADO':pnl()>=GOAL?'META DIÁRIA':pnl()<=-LOSS?'LIMITE DE PERDA':st.openedToday>=MAX_TRADES?'LIMITE DE OPERAÇÕES':null}
async function market(sym){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{let r=await fetch('https://data-api.binance.vision/api/v3/klines?'+new URLSearchParams({symbol:sym+'USDT',interval:'1d',limit:'240'}),{signal:controller.signal});if(!r.ok)throw Error('Binance HTTP '+r.status);let data=await r.json();if(!Array.isArray(data)||data.length<220)throw Error('Dados insuficientes');return data.map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]}))}finally{clearTimeout(timer)}}
function ema(p,n){let x=p.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<p.length;i++)x=p[i]*(2/(n+1))+x*(1-2/(n+1));return x}
function technical(kl){const k=kl.slice(0,-1),c=k.map(x=>x.c),last=k.at(-1),ema50=ema(c,50),ema200=ema(c,200),hi=Math.max(...k.slice(-21,-1).map(x=>x.h)),v=k.slice(-21,-1).reduce((a,x)=>a+x.v,0)/20;
 return {ok:last.c>ema200&&ema50>ema200&&last.c>hi&&last.c<=hi*1.03&&last.v>v,price:last.c,candle:last.t};}
async function refresh(){resetDay();const results=await Promise.allSettled(st.positions.map(async p=>{const k=await market(p.symbol);return {p,k,mark:k.at(-1).c}}));for(const r of results){if(r.status!=='fulfilled')continue;const {p,mark,k}=r.value;p.mark=mark;const bar=k.at(-1);if(bar.t>Date.parse(p.openedAt) && (bar.l<=p.stop||bar.h>=p.take)){ // pessimista se ambos tocam no mesmo candle
  const exit=bar.l<=p.stop?p.stop:p.take;close(p.symbol,exit,'STOP/ALVO SIMULADO');}}
 resetDay();save();return snapshot();}
function close(sym,exit,reason){const i=st.positions.findIndex(x=>x.symbol===sym);if(i<0)throw Error('Posição não encontrada');const p=st.positions[i],proceeds=p.qty*exit*(1-FEE);st.cash+=proceeds;st.trades.unshift({symbol:sym,entry:p.entry,exit,net:proceeds-p.cost,reason,closedAt:new Date().toISOString()});st.positions.splice(i,1);save();}
function snapshot(){resetDay();return {mode:'PAPER_ONLY',cash:st.cash,equity:equity(),dayPnl:pnl(),dailyGoal:GOAL,dailyLoss:LOSS,day:st.day,openedToday:st.openedToday,maxTrades:MAX_TRADES,paused:st.paused,blockReason:blocked(),positions:st.positions,trades:st.trades.slice(0,20),candidates:st.candidates,scanAt:st.scanAt,persistence:'FILE_EPHEMERAL_ON_RENDER'}}
async function scan(context){
 await refresh();
 const out=[];
 for(const sym of ASSETS){
  try{
   const k=await market(sym),t=technical(k);
   if(!t.ok){out.push({symbol:sym,status:'SEM_SINAL'});continue;}
   let ctx;
   try{ctx=await context(sym);}catch(e){ctx={status:'INCONCLUSIVO',reason:'Consulta externa falhou'};}
   out.push({symbol:sym,status:'REVISAR',price:t.price,candle:t.candle,context:ctx});
  }catch(e){out.push({symbol:sym,status:'ERRO',reason:e.message});}
 }
 st.candidates=out;st.scanAt=new Date().toISOString();save();return snapshot();
}
async function enter(sym){await refresh();if(!ASSETS.includes(sym))throw Error('Ativo inválido');const why=blocked();if(why)throw Error(why);if(st.positions.some(p=>p.symbol===sym))throw Error('Posição já aberta');const c=st.candidates.find(x=>x.symbol===sym&&x.status==='REVISAR'&&x.price>0);if(!c||!st.scanAt||Date.now()-Date.parse(st.scanAt)>30*60e3)throw Error('Candidato não revisado recentemente');const k=await market(sym),price=k.at(-1).c;if(Math.abs(price-c.price)/c.price>.02)throw Error('Preço variou: refaça análise');const budget=Math.min(st.dayStart*ALLOC,st.cash/(1+FEE));if(budget<1)throw Error('Saldo virtual insuficiente');const qty=budget/price,cost=budget*(1+FEE);st.cash-=cost;st.positions.push({symbol:sym,qty,entry:price,mark:price,cost,stop:price*.99,take:price*1.015,openedAt:new Date().toISOString()});st.openedToday++;st.candidates=st.candidates.filter(x=>x.symbol!==sym);save();return snapshot();}
function pause(flag){st.paused=Boolean(flag);save();return snapshot()}
module.exports={snapshot,refresh,scan,enter,pause};
