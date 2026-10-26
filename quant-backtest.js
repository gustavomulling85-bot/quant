'use strict';
/**
 * AGENTE QUANT | Auditoria historica reproduzivel, sem ordens reais.
 * Node >=20. Binance Spot public klines, candles 4h, ~730 dias.
 * Instalar no repositorio e rodar: node quant-backtest.js
 * Teste interno: node quant-backtest.js --selftest
 * Nao depende de PIN, chaves nem altera saldos dos robos.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA','DOGE','SUI','NEAR','LTC','TRX','UNI','BCH','DOT','APT','ARB','AAVE','XLM'];
const INTERVAL_MS=4*60*60*1000;
const DAYS=730;
const TRAIN_RATIO=.70;
const FEE=.001; // 0.1% each side
const SLIPPAGE=.0003; // 0.03% each side
const SPREAD=.0004; // full spread 0.04%, modeled as half on each side
const COST=FEE+SLIPPAGE+SPREAD/2;
const initialCapital=1000,tradeStake=10;
const endTime=Math.floor((Date.now()-INTERVAL_MS)/86400000)*86400000;
const startTime=endTime-DAYS*86400000;
const cacheDir=path.join(__dirname,'quant-backtest-cache');
const output=path.join(__dirname,'quant-backtest-report.json');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function emaAt(values,n){
 const out=Array(values.length).fill(null);if(values.length<n)return out;
 let e=values.slice(0,n).reduce((a,b)=>a+b,0)/n;out[n-1]=e;
 for(let i=n;i<values.length;i++){e+=(values[i]-e)*2/(n+1);out[i]=e}return out;
}
function atrAt(c,n=14){
 const tr=c.map((x,i)=>i===0?x.h-x.l:Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)));
 const out=Array(c.length).fill(null);if(c.length<=n)return out;
 let avg=tr.slice(1,n+1).reduce((a,b)=>a+b,0)/n;out[n]=avg;
 for(let i=n+1;i<c.length;i++){avg=(avg*(n-1)+tr[i])/n;out[i]=avg}return out;
}
async function getJSON(url){
 let error;for(let attempt=0;attempt<3;attempt++){
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),16000);
  try{
   const response=await fetch(url,{signal:abort.signal});
   if(response.status===429||response.status===418){await sleep(1000*(attempt+2));continue}
   if(!response.ok)throw Error('HTTP '+response.status);
   return await response.json();
  }catch(e){error=e;await sleep((attempt+1)*400)}finally{clearTimeout(timer)}
 }throw error||Error('Binance indisponivel');
}
async function fetchCandles(sym){
 await fs.mkdir(cacheDir,{recursive:true});
 const filename=path.join(cacheDir,sym+'USDT-4h-'+Math.floor(startTime/86400000)+'.json');
 try{const saved=JSON.parse(await fs.readFile(filename,'utf8'));if(saved.startTime===startTime && saved.endTime===endTime && saved.rows.length>1000)return saved.rows}catch{}
 let cursor=startTime;const candles=[];
 while(cursor<endTime){
  const query=new URLSearchParams({symbol:sym+'USDT',interval:'4h',startTime:String(cursor),endTime:String(endTime),limit:'1000'});
  let json;let error;
  for(const origin of ['https://data-api.binance.vision','https://api.binance.com']){
   try{json=await getJSON(origin+'/api/v3/klines?'+query);break}catch(e){error=e}
  }
  if(!Array.isArray(json))throw error||Error('Resposta de candles invalida');
  if(json.length===0)break;
  for(const x of json){if(Number(x[6])>=endTime)continue;candles.push({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]})}
  const next=Number(json.at(-1)[0])+INTERVAL_MS;if(next<=cursor)break;cursor=next;
  await sleep(100);
 }
 const unique=[...new Map(candles.map(c=>[c.t,c])).values()].sort((a,b)=>a.t-b.t);
 await fs.writeFile(filename,JSON.stringify({startTime,endTime,rows:unique}));
 return unique;
}
function signals(bars,strategy){
 const close=bars.map(x=>x.c),ema20=emaAt(close,20),ema50=emaAt(close,50),atr=atrAt(bars),out=[];
 for(let i=55;i<bars.length-1;i++){
  const bar=bars[i],prior=bars[i-1],a=atr[i];if(!a||a<=0||!ema20[i]||!ema50[i])continue;
  const vol=bars.slice(i-20,i).reduce((s,x)=>s+x.v,0)/20;
  const up=ema20[i]>ema50[i]&&ema20[i]>ema20[i-3]&&bar.c>ema50[i];
  const priorHigh=Math.max(...bars.slice(i-20,i).map(x=>x.h));
  const pullback=up&&prior.l<=ema20[i-1]*1.003&&bar.c>ema20[i]&&bar.c>bar.o&&bar.c>prior.c;
  const breakout=up&&bar.c>priorHigh&&vol>0&&bar.v>=1.35*vol&&bar.c>bar.o;
  const hit=strategy==='recuo'?pullback:breakout;
  if(hit)out.push({signalAt:i,enterAt:i+1,atr:a});
 }
 return out;
}
function simulate(bars,strategy,from,to){
 const found=signals(bars,strategy);let nextFree=from,capital=initialCapital,peak=initialCapital,maxDrawdown=0;
 let wins=0,losses=0,grossProfit=0,grossLoss=0,totalNet=0;const trades=[];
 for(const sig of found){
  const i=sig.enterAt;if(i<from||i>=to||i<nextFree)continue;
  const open=bars[i].o;if(!(open>0))continue;
  const buy=open*(1+COST),qty=tradeStake/buy;
  // Entry at following bar's open. ATR known only from completed signal candle.
  const stop=open-1.5*sig.atr,target=open+2.5*sig.atr;
  if(!(stop>0))continue;
  let exitAt=Math.min(i+12,to-1),reason='TEMPO',rawExit=bars[exitAt].c;
  for(let j=i;j<=Math.min(i+12,to-1);j++){
   const b=bars[j];
   if(b.l<=stop){rawExit=Math.min(stop,b.o);exitAt=j;reason='STOP';break}
   // Conservative same-candle resolution: if stop and target hit, STOP always wins.
   if(b.h>=target){rawExit=j===i?Math.max(target,b.o):target;exitAt=j;reason='ALVO';break}
  }
  const sell=rawExit*(1-COST),net=qty*sell-tradeStake;
  capital+=net;peak=Math.max(peak,capital);maxDrawdown=Math.max(maxDrawdown,(peak-capital)/peak*100);
  net>=0?(wins++,grossProfit+=net):(losses++,grossLoss+=-net);
  totalNet+=net;trades.push({sym:bars.sym,strategy,at:new Date(bars[i].t).toISOString(),end:new Date(bars[exitAt].t).toISOString(),entry:buy,exit:sell,net:Number(net.toFixed(5)),reason});
  nextFree=exitAt+1;
 }
 return {trades:trades.length,wins,losses,winRate:trades.length?wins/trades.length:0,net:Number(totalNet.toFixed(4)),avgNet:trades.length?totalNet/trades.length:0,profitFactor:grossLoss>0?grossProfit/grossLoss:(grossProfit>0?null:0),drawdownPct:Number(maxDrawdown.toFixed(3)),details:trades};
}
function summary(results,segment){
 let total=0,wins=0,losses=0,net=0,positive=0,dd=0;
 for(const x of results){const r=x[segment];total+=r.trades;wins+=r.wins;losses+=r.losses;net+=r.net;if(r.net>0)positive++;dd=Math.max(dd,r.drawdownPct)}
 return {coins:results.length,positiveCoins:positive,trades:total,wins,losses,winRate:total?wins/total:0,totalNetUSDT:+net.toFixed(4),avgNetPerTrade:total?+(net/total).toFixed(5):0,worstPerCoinDrawdownPct:dd};
}
async function run(){
 const all=[];for(const sym of ASSETS){
  process.stdout.write('Consultando '+sym+' ... ');
  try{
   const bars=await fetchCandles(sym);if(bars.length<900){console.log('dados insuficientes: '+bars.length);continue}
   const cut=Math.floor(bars.length*TRAIN_RATIO);
   const entry={sym,bars:bars.length,start:new Date(bars[0].t).toISOString(),end:new Date(bars.at(-1).t).toISOString(),coverageDays:(bars.at(-1).t-bars[0].t)/86400000,strategies:{}};
   for(const strategy of ['recuo','rompimento'])entry.strategies[strategy]={train:simulate(bars,strategy,56,cut),validation:simulate(bars,strategy,cut,bars.length)};
   all.push(entry);console.log(bars.length+' candles');
  }catch(e){console.log('ERRO '+e.message)}
 }
 const comparisons={};for(const strategy of ['recuo','rompimento']){
  const r=all.map(x=>x.strategies[strategy]);comparisons[strategy]={train:summary(r,'train'),validation:summary(r,'validation')};
 }
 // Strict preliminary gate; a positive backtest is not proof of future profits.
 const eligible=Object.entries(comparisons).filter(([_,r])=>r.validation.trades>=60&&r.validation.totalNetUSDT>0&&r.validation.positiveCoins>=Math.ceil(r.validation.coins*.6)&&r.validation.avgNetPerTrade>0.015);
 const preferred=eligible.sort((a,b)=>b[1].validation.totalNetUSDT-a[1].validation.totalNetUSDT)[0]?.[0]||null;
 const report={version:'research-1',generatedAt:new Date().toISOString(),interval:'4h',daysRequested:DAYS,trainRatio:TRAIN_RATIO,feePerSide:FEE,slippagePerSide:SLIPPAGE,fullSpread:SPREAD,stake:tradeStake,notes:['Sem alavancagem ou ordens reais','Entrada no proximo candle; mesmo candle desfavoravel no conflito stop/alvo','Testes por moeda, sem simular concorrencia entre moedas nem liquidez efetiva','Janela final usada somente para validacao; parametros escolhidos previamente','Arquivos publicos da Binance; historico salvo em cache local temporario'],comparisons,preferred,coins:all};
 await fs.writeFile(output,JSON.stringify(report,null,2));
 console.log('\nCOMPARACAO:',JSON.stringify(comparisons,null,2));
 console.log('\nESTRATEGIA PRELIMINAR:',preferred||'NENHUMA VALIDADA');
 console.log('Relatorio:',output);
}
function selftest(){
 const N=150,up=Array.from({length:N},(_,i)=>({t:i*INTERVAL_MS,o:100+i*.1,h:100+i*.1+1,l:100+i*.1-.5,c:100+i*.1+.2,v:100+i%10}));
 const e=emaAt(up.map(x=>x.c),20),a=atrAt(up),s=signals(up,'recuo'),r=simulate(up,'recuo',56,150);
 if(e.length!==N||!Number.isFinite(e.at(-1))||!Number.isFinite(a.at(-1))||!Array.isArray(s)||!Number.isFinite(r.net))throw Error('Selftest falhou');
 console.log('SELFTEST OK',JSON.stringify({ema:e.at(-1),atr:a.at(-1),signals:s.length,trades:r.trades}));
}
if(require.main===module){if(process.argv.includes('--selftest'))selftest();else run().catch(e=>{console.error(e);process.exitCode=1})}
module.exports={emaAt,atrAt,signals,simulate,summary};
