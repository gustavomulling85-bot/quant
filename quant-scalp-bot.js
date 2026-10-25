'use strict';
// Escalping experimental, SOMENTE SIMULACAO. Nenhuma ordem real.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const FILE=path.join(__dirname,'quant-scalp-state.json');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA','DOGE','SUI','NEAR','LTC','TRX','UNI','BCH','DOT','APT','ARB','AAVE','XLM'];
const SET={enabled:false,stake:10,goal:50,lossLimit:20,maxLosses:3,start:'09:00'};
const fresh=()=>({settings:{...SET},cash:1000,day:'',startEquity:1000,position:null,trades:[],events:[],lastScan:null,lastResults:[],lastSlot:null,lastError:null,openedToday:0});
let st=fresh(),ready=false,busy=false,tm;
const TZ='America/Sao_Paulo',fee=.001,extraSlip=.0003;
const dateBR=(d=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const hourBR=()=>new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
const stamp=()=>new Date().toISOString();
const equity=()=>st.cash+(st.position?st.position.qty*st.position.mark*(1-fee-extraSlip):0);
const pnl=()=>equity()-st.startEquity;
const losses=()=>st.trades.filter(x=>x.net<0 && dateBR(new Date(x.closedAt))===st.day).length;
function ev(msg,type='info'){st.events.unshift({at:stamp(),text:msg,type});st.events=st.events.slice(0,120)}
async function save(){let tmp=FILE+'.tmp';await fs.writeFile(tmp,JSON.stringify(st),{mode:0o600});await fs.rename(tmp,FILE)}
async function load(){try{const s=JSON.parse(await fs.readFile(FILE,'utf8'));if(!Number.isFinite(s.cash)||!Array.isArray(s.trades))throw Error('arquivo invalido');st={...fresh(),...s,settings:{...SET,...s.settings,enabled:false}};ev('Servidor reiniciado: scalping desativado por seguranca.','warning')}catch{st=fresh();ev('Carteira SCALPING ficticia criada (separada do robo 5m).','warning')}ready=true;newDay();await save()}
function newDay(){const d=dateBR();if(d!==st.day){st.day=d;st.startEquity=equity();st.openedToday=0;st.lastSlot=null;ev('Novo dia de simulacao: '+d)}}
function reason(){if(!st.settings.enabled)return 'DESLIGADO';if(hourBR()<st.settings.start)return 'AGUARDANDO HORARIO '+st.settings.start;if(losses()>=3)return 'TRAVA: 3 LOSSES';if(pnl()>=st.settings.goal)return 'META ATINGIDA';if(pnl()<=-st.settings.lossLimit)return 'LIMITE DE PERDA';if(st.position)return 'OPERACAO ABERTA';return null}
async function binance(endpoint){let error;for(const origin of ['https://data-api.binance.vision','https://api.binance.com']){const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),9000);try{const r=await fetch(origin+'/api/v3/'+endpoint,{signal:ac.signal,cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);return await r.json()}catch(e){error=e}finally{clearTimeout(tm)}}throw error||Error('Binance indisponivel')}
const candles=async(sym,limit=300)=>{const data=await binance('klines?'+new URLSearchParams({symbol:sym+'USDT',interval:'1m',limit:String(limit)}));if(!Array.isArray(data))throw Error('Candles invalidos');return data.filter(x=>+x[6]<Date.now()).map(x=>({t:+x[0],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]}))};
const ema=(values,n)=>{let v=values.slice(0,n).reduce((a,b)=>a+b,0)/n;for(let i=n;i<values.length;i++)v+=2/(n+1)*(values[i]-v);return v};
const rsi=values=>{let g=0,l=0;for(let j=values.length-14;j<values.length;j++){const d=values[j]-values[j-1];g+=Math.max(d,0);l+=Math.max(-d,0)}return l?100-100/(1+g/l):100};
function features(a,i){if(i<30)return null;const x=a[i],prev=a.slice(i-20,i),closes=a.slice(i-30,i+1).map(v=>v.c),avg=prev.reduce((s,v)=>s+v.v,0)/20;
 const fast=ema(closes,9),slow=ema(closes,21),rs=rsi(closes);
 return {up:x.c>x.o,trend:fast>slow, rsi:rs, ratio:avg>0?x.v/avg:0, move:(x.c/x.o-1)*100,
  approved:x.c>x.o&&fast>slow&&rs>=52&&rs<=70&&avg>0&&x.v>=avg*1.2&&x.c<x.o*1.01};}
function estimate(a){const current=features(a,a.length-1);if(!current)return null;let wins=0,total=0,sum=0;
 // Historico usado somente ate o candle anterior ao sinal corrente. Nao e validacao fora da amostra.
 for(let i=40;i<a.length-2;i++){const f=features(a,i);if(!f?.approved)continue;const change=a[i+1].c/a[i].c-1;const netPct=100*(change-2*fee-2*extraSlip);total++;sum+=netPct;if(netPct>0)wins++}
 return {...current,samples:total,winRate:total?wins/total:0,avgNetPct:total?sum/total:0};}
async function universe(){const [ex,day,books]=await Promise.all([binance('exchangeInfo'),binance('ticker/24hr'),binance('ticker/bookTicker')]);const allowed=new Set(ex.symbols.filter(x=>x.status==='TRADING'&&x.quoteAsset==='USDT'&&x.isSpotTradingAllowed!==false).map(x=>x.symbol));const vol=new Map(day.map(x=>[x.symbol,+x.quoteVolume]));const quotes=new Map(books.map(x=>[x.symbol,{bid:+x.bidPrice,ask:+x.askPrice}]));return ASSETS.map(sym=>{const key=sym+'USDT',q=quotes.get(key),v=vol.get(key),sp=q&&q.bid>0?100*(q.ask-q.bid)/((q.ask+q.bid)/2):Infinity;return {sym,eligible:allowed.has(key)&&v>=5000000&&sp<=.15,spread:sp,volume24h:v,book:q}})}
async function settle(){if(!st.position)return;const p=st.position;try{const book=await binance('ticker/bookTicker?symbol='+p.sym+'USDT'),bid=+book.bidPrice;if(!(bid>0))throw Error('Sem bid');p.mark=bid;if(Date.now()<p.expireMs && bid>p.entry*.99)return;
 const price=bid*(1-extraSlip);const proceeds=p.qty*price*(1-fee);const net=proceeds-p.cost;st.cash+=proceeds;st.trades.unshift({symbol:p.sym,entry:p.entry,exit:price,net,openedAt:p.openedAt,closedAt:stamp(),elapsedSeconds:Math.round((Date.now()-p.openedMs)/1000),reason:Date.now()>=p.expireMs?'PRAZO DE 60S':'STOP EMERGENCIAL 1%'});st.trades=st.trades.slice(0,500);st.position=null;ev('SAIDA scalp '+p.sym+' '+net.toFixed(4)+' USDT | '+Math.round((Date.now()-p.openedMs)/1000)+'s',net<0?'loss':'profit');
 }catch(e){st.lastError='Erro cotacao posicao: '+e.message;ev(st.lastError,'warning')}}
async function scan(){ev('Scalping: verificando 20 moedas e historico de 1 minuto.','scan');let all=await universe(),results=[];
 for(let i=0;i<all.length;i+=4){const batch=all.slice(i,i+4);const data=await Promise.allSettled(batch.map(async a=>{if(!a.eligible)return {sym:a.sym,status:'LIQUIDEZ/SPREAD',spreadPct:a.spread};const arr=await candles(a.sym);const e=estimate(arr);if(!e)return {sym:a.sym,status:'SEM HISTORICO'};
 const passed=e.approved&&e.samples>=8&&e.winRate>=.65&&e.avgNetPct>0.03;
 return {sym:a.sym,status:passed?'SINAL EXPERIMENTAL':'AGUARDANDO',score:passed?e.avgNetPct*e.winRate:0,approved:passed,rsi:e.rsi,volumeRatio:e.ratio,samples:e.samples,winRate:e.winRate,avgNetPct:e.avgNetPct,candle:arr.at(-1).t,spreadPct:a.spread,ask:a.book.ask};}));batch.forEach((a,j)=>results.push(data[j].status==='fulfilled'?data[j].value:{sym:a.sym,status:'ERRO',reason:String(data[j].reason?.message||'Indisponivel')}))}
 st.lastResults=results;st.lastScan=stamp();const matches=results.filter(x=>x.approved).sort((a,b)=>b.score-a.score);ev('Scalping: '+matches.length+' sinais selecionados entre 20 moedas.','scan');
 if(!matches.length||reason())return;const best=matches[0];const book=await binance('ticker/bookTicker?symbol='+best.sym+'USDT'),ask=+book.askPrice;if(!(ask>0)||ask>best.ask*1.002){ev('Sinal '+best.sym+' expirou antes da entrada.','warning');return}if(reason())return;
 const invest=Math.min(st.settings.stake,st.cash/(1+fee+extraSlip));if(invest<10)return;const entry=ask*(1+extraSlip),qty=invest/entry,cost=invest*(1+fee);st.cash-=cost;const openedMs=Date.now();st.position={sym:best.sym,entry,qty,cost,mark:ask,openedMs,expireMs:openedMs+60000,openedAt:stamp(),estimatedWinRate:best.winRate,samples:best.samples};st.openedToday++;ev('ENTRADA SCALP ficticia '+best.sym+' '+invest.toFixed(2)+' USDT; saida prevista em 60 segundos.','buy');}
async function cycle(){if(!ready||busy)return;busy=true;try{newDay();await settle();if(!reason()){const slot=Math.floor(Date.now()/60000);if(st.lastSlot!==slot){st.lastSlot=slot;await scan()}}await save()}catch(e){st.lastError=e.message;ev('Falha no scalping: '+e.message,'warning');try{await save()}catch{}}finally{busy=false}}
function status(){newDay();return {...st,lossesToday:losses(),netToday:pnl(),equity:equity(),blocking:reason(),clockBR:hourBR(),working:busy,realOrders:false,simulation:true,scanInterval:'1m',holdSeconds:60,storage:'Arquivo temporario Render; separado da carteira do robo 5m'}}
const authorized=pin=>{const secret=process.env.QUANT_ACCESS_PIN||'';if(!secret||typeof pin!=='string')return false;const a=Buffer.from(secret),b=Buffer.from(pin);return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const respond=(res,code,obj)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(obj))};
async function body(req){let str='';for await(const x of req){str+=x;if(str.length>2048)throw Error('Payload extenso')}return str?JSON.parse(str):{}}
async function handle(req,res,u){if(!u.pathname.startsWith('/api/quant-scalp/'))return false;if(!authorized(req.headers['x-quant-pin'])){respond(res,401,{error:'PIN invalido'});return true}if(!ready){respond(res,503,{error:'Iniciando scalping'});return true}try{if(u.pathname==='/api/quant-scalp/status'&&req.method==='GET'){respond(res,200,status());return true}if(req.method!=='POST'){respond(res,405,{error:'Metodo invalido'});return true}const d=await body(req);
 if(u.pathname==='/api/quant-scalp/config'){if(!Number.isFinite(d.stake)||d.stake<10||d.stake>500||!Number.isFinite(d.goal)||d.goal<=0||d.goal>100||!Number.isFinite(d.lossLimit)||d.lossLimit<=0||d.lossLimit>100||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start))throw Error('Parametros invalidos');st.settings={...st.settings,stake:d.stake,goal:d.goal,lossLimit:d.lossLimit,start:d.start,maxLosses:3};ev('Parametros scalping atualizados');await save();respond(res,200,status());return true}
 if(u.pathname==='/api/quant-scalp/switch'){if(typeof d.enabled!=='boolean')throw Error('enabled invalido');st.settings.enabled=d.enabled;ev(d.enabled?'SCALPING 1M ATIVADO':'SCALPING 1M DESLIGADO',d.enabled?'buy':'warning');await save();respond(res,200,status());if(d.enabled)queueMicrotask(()=>cycle().catch(()=>{}));return true}
 respond(res,404,{error:'Rota ausente'});return true}catch(e){respond(res,400,{error:e.message});return true}}
function start(){load().then(()=>{tm=setInterval(()=>cycle().catch(e=>console.error('QUANT_SCALP',e.message)),10000);tm.unref?.();ev('Scalping 1 minuto pronto para ativacao manual.')}).catch(e=>console.error('QUANT_SCALP_INIT',e.message))}
module.exports={handle,start};
