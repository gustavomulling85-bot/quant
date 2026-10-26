'use strict';
// Agente Quant - executor unico; exclusivamente simulacao, nenhuma ordem real.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const STATE=path.join(__dirname,'quant-unified-state.json');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA','DOGE','SUI','NEAR','LTC','TRX','UNI','BCH','DOT','APT','ARB','AAVE','XLM'];
const CFG={enabled:false,stake:10,goal:50,lossLimit:20,maxLosses:3,start:'09:00',maxPositions:1,stopPct:1,targetPct:2.5};
const blank=()=>({settings:{...CFG},cash:1000,day:'',startEquity:1000,positions:[],trades:[],events:[],lastScan:null,lastResults:[],lastSlot:null,lastError:null,openedToday:0});
let st=blank(),ready=false,busy=false,timer;
const fee=.001,slippage=.0003,TZ='America/Sao_Paulo';
const stamp=()=>new Date().toISOString();
const dateBR=(dt=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(dt);
const clock=()=>new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
const round=n=>Number(n.toFixed(6));
const equity=()=>st.cash+st.positions.reduce((sum,p)=>sum+p.qty*(p.mark||p.entry)*(1-fee-slippage),0);
const pnl=()=>equity()-st.startEquity;
const losses=()=>st.trades.filter(t=>t.net<0&&dateBR(new Date(t.closedAt))===st.day).length;
function event(message,type='info'){st.events.unshift({at:stamp(),text:message,type});st.events=st.events.slice(0,100)}
async function save(){const tmp=STATE+'.tmp';await fs.writeFile(tmp,JSON.stringify(st),{mode:0o600});await fs.rename(tmp,STATE)}
function newDay(){const d=dateBR();if(st.day!==d){st.day=d;st.startEquity=equity();st.openedToday=0;st.lastSlot=null;event('Novo dia da carteira unificada '+d)}}
async function load(){try{const old=JSON.parse(await fs.readFile(STATE,'utf8'));if(!Number.isFinite(old.cash)||!Array.isArray(old.trades)||!Array.isArray(old.positions))throw Error('Estado invalido');st={...blank(),...old,settings:{...CFG,...old.settings,enabled:false}};event('Reinicio: executor desativado por seguranca','warning')}catch{st=blank();event('Carteira unificada criada com 1000 USDT ficticios','warning')}ready=true;newDay();await save()}
async function legacyRunning(){for(const filename of ['quant-auto-state.json','quant-scalp-state.json']){try{const x=JSON.parse(await fs.readFile(path.join(__dirname,filename),'utf8'));if(x.settings?.enabled)return filename}catch{}}return null}
function block(){if(!st.settings.enabled)return 'DESLIGADO';if(clock()<st.settings.start)return 'AGUARDANDO HORARIO '+st.settings.start;if(losses()>=st.settings.maxLosses)return 'TRAVA 3 LOSSES';if(pnl()>=st.settings.goal)return 'META DIARIA';if(pnl()<=-st.settings.lossLimit)return 'LIMITE DIARIO DE PERDA';if(st.positions.length>=st.settings.maxPositions)return 'POSICAO ABERTA';return null}
async function binance(endpoint){let failure;for(const origin of ['https://data-api.binance.vision','https://api.binance.com']){const ctl=new AbortController(),t=setTimeout(()=>ctl.abort(),9500);try{const r=await fetch(origin+'/api/v3/'+endpoint,{signal:ctl.signal,cache:'no-store'});if(!r.ok)throw Error('Binance HTTP '+r.status);return r.json()}catch(e){failure=e}finally{clearTimeout(t)}}throw failure||Error('Binance indisponivel')}
async function candles(symbol,interval,limit=110){const q=new URLSearchParams({symbol:symbol+'USDT',interval,limit:String(limit)});const rows=await binance('klines?'+q);if(!Array.isArray(rows))throw Error('Velas invalidas');return rows.filter(x=>+x[6]<Date.now()).map(x=>({open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+x[5]}))}
function ema(a,n){let value=a.slice(0,n).reduce((x,y)=>x+y,0)/n;for(let j=n;j<a.length;j++)value+=(2/(n+1))*(a[j]-value);return value}
function rsi(a){let up=0,down=0;for(let j=a.length-14;j<a.length;j++){const d=a[j]-a[j-1];up+=Math.max(0,d);down+=Math.max(0,-d)}return down===0?100:100-100/(1+up/down)}
function analyze(ks1,ks5,ks15,ks60){if([ks1,ks5,ks15,ks60].some(a=>a.length<35))return {approved:false,why:'Historico insuficiente'};
 const trend=arr=>{const c=arr.map(x=>x.close);return ema(c.slice(-35),9)>ema(c.slice(-35),21)};
 const a=ks1.at(-1),b=ks5.at(-1),prev1=ks1.slice(-21,-1),prev5=ks5.slice(-21,-1);
 const close1=ks1.map(x=>x.close),r=rsi(close1),vol1=prev1.reduce((s,x)=>s+x.volume,0)/20;
 const break5=b.close>Math.max(...prev5.map(x=>x.high));
 const confirmation=trend(ks60)&&trend(ks15)&&trend(ks5);
 const timing=trend(ks1)&&a.close>a.open&&r>=52&&r<=70&&a.volume>=1.25*vol1;
 const approved=confirmation&&break5&&timing;
 const why=approved?'Sinal 5m + timing 1m aprovado':[
  !confirmation?'Tendencia 5m/15m/1h':'',!break5?'Sem rompimento confirmado 5m':'',!timing?'Timing 1m/RSI/volume nao aprovado':''
 ].filter(Boolean).join('; ');
 return {approved,why,rsi:round(r),volumeRatio:round(a.volume/(vol1||1)),trendConfirmed:confirmation,breakout5:break5,timing1:timing};}
async function universe(){const [meta,volumes,books]=await Promise.all([binance('exchangeInfo'),binance('ticker/24hr'),binance('ticker/bookTicker')]);const enabled=new Set(meta.symbols.filter(x=>x.status==='TRADING'&&x.quoteAsset==='USDT'&&x.isSpotTradingAllowed!==false).map(x=>x.symbol));const volume=new Map(volumes.map(x=>[x.symbol,+x.quoteVolume]));const book=new Map(books.map(x=>[x.symbol,{bid:+x.bidPrice,ask:+x.askPrice}]));return ASSETS.map(sym=>{const name=sym+'USDT',b=book.get(name),spread=b?.ask>0&&b?.bid>0?100*(b.ask-b.bid)/((b.ask+b.bid)/2):Infinity;return {sym,book:b,spread,eligible:enabled.has(name)&&(volume.get(name)||0)>=5e6&&spread<=.15}})}
async function exitPosition(p,book){const bid=+book.bidPrice;if(!(bid>0))throw Error('Preco de venda indisponivel');p.mark=bid;const sale=bid*(1-slippage),net=p.qty*sale*(1-fee)-p.cost;
 let reason=null;if(bid<=p.entry*(1-st.settings.stopPct/100))reason='STOP';else if(bid>=p.entry*(1+st.settings.targetPct/100))reason='ALVO';else if(Date.now()-p.openedMs>=5*60*1000){const bars=await candles(p.sym,'1m',40),c=bars.map(x=>x.close);if(ema(c.slice(-30),9)<ema(c.slice(-30),21))reason='REVERSAO 1M'}
 if(!reason)return;st.cash+=p.qty*sale*(1-fee);st.positions=st.positions.filter(x=>x!==p);st.trades.unshift({symbol:p.sym,entry:p.entry,exit:sale,stake:p.cost,net,openedAt:p.openedAt,closedAt:stamp(),reason});st.trades=st.trades.slice(0,500);event('VENDA VIRTUAL '+p.sym+' '+round(net)+' USDT ('+reason+')',net<0?'loss':'profit')}
async function monitor(){for(const p of [...st.positions]){try{const b=await binance('ticker/bookTicker?symbol='+p.sym+'USDT');await exitPosition(p,b)}catch(e){st.lastError='Monitor '+p.sym+': '+e.message;event(st.lastError,'warning')}}}
async function scan(){event('Motor unificado: analisando 20 criptomoedas com 5m + 1m','scan');const assets=await universe(),results=[];
 for(let i=0;i<assets.length;i+=4){const group=assets.slice(i,i+4);const batch=await Promise.allSettled(group.map(async a=>{if(!a.eligible)return {sym:a.sym,approved:false,why:'Liquidez ou spread inadequados'};const [m1,m5,m15,h1]=await Promise.all(['1m','5m','15m','1h'].map(k=>candles(a.sym,k)));return {sym:a.sym,spread:a.spread,ask:a.book.ask,...analyze(m1,m5,m15,h1)}}));group.forEach((a,j)=>results.push(batch[j].status==='fulfilled'?batch[j].value:{sym:a.sym,approved:false,why:'Erro: '+String(batch[j].reason?.message||'consulta')}))}
 st.lastResults=results;st.lastScan=stamp();const matches=results.filter(x=>x.approved).sort((a,b)=>a.spread-b.spread);event('Motor unificado: '+matches.length+' sinais aprovados','scan');if(!matches.length||block())return;
 const best=matches[0],q=await binance('ticker/bookTicker?symbol='+best.sym+'USDT'),ask=+q.askPrice;if(!(ask>0)||ask>best.ask*1.002)return;
 const invest=Math.min(st.settings.stake,st.cash/(1+fee+slippage));if(invest<10)return;
 const entry=ask*(1+slippage),qty=invest/entry,cost=invest*(1+fee);st.cash-=cost;st.positions.push({sym:best.sym,entry,qty,cost,mark:ask,openedAt:stamp(),openedMs:Date.now()});st.openedToday++;event('COMPRA VIRTUAL '+best.sym+' '+round(invest)+' USDT (confirmacao 5m + entrada 1m)','buy')}
async function cycle(){if(!ready||busy)return;busy=true;try{newDay();await monitor();if(!block() && !(await legacyRunning())){const slot=Math.floor(Date.now()/60000);if(st.lastSlot!==slot){st.lastSlot=slot;await scan()}}await save()}catch(e){st.lastError=e.message;event('Falha no ciclo: '+e.message,'warning');try{await save()}catch{}}finally{busy=false}}
function state(){newDay();return {...st,lossesToday:losses(),netToday:pnl(),equity:equity(),blocking:block(),clockBR:clock(),simulation:true,realOrders:false,working:busy,storage:'Temporario no Render',system:'Unified Paper 5m+1m'}}
function respond(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function valid(pin){const secret=process.env.QUANT_ACCESS_PIN||'';if(!secret||typeof pin!=='string')return false;const a=Buffer.from(pin),b=Buffer.from(secret);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
async function readBody(req){let str='';for await(const chunk of req){str+=chunk;if(str.length>2048)throw Error('Payload muito grande')}return str?JSON.parse(str):{}}
async function handle(req,res,u){if(!u.pathname.startsWith('/api/quant-unified/'))return false;if(!valid(req.headers['x-quant-pin'])){respond(res,401,{error:'PIN invalido'});return true}if(!ready){respond(res,503,{error:'Motor inicializando'});return true}
 try{if(u.pathname==='/api/quant-unified/status'&&req.method==='GET'){respond(res,200,state());return true}if(req.method!=='POST'){respond(res,405,{error:'Metodo invalido'});return true}const body=await readBody(req);
 if(u.pathname==='/api/quant-unified/config'){if(!Number.isFinite(body.stake)||body.stake<10||body.stake>100||!Number.isFinite(body.goal)||body.goal<=0||body.goal>100||!Number.isFinite(body.lossLimit)||body.lossLimit<1||body.lossLimit>100||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.start))throw Error('Configuracao invalida');st.settings={...st.settings,stake:body.stake,goal:body.goal,lossLimit:body.lossLimit,start:body.start};await save();respond(res,200,state());return true}
 if(u.pathname==='/api/quant-unified/switch'){if(typeof body.enabled!=='boolean')throw Error('enabled invalido');if(body.enabled){const legacy=await legacyRunning();if(legacy)throw Error('Desligue primeiro o robo antigo: '+legacy)}st.settings.enabled=body.enabled;event(body.enabled?'Executor unificado ATIVADO':'Executor unificado DESLIGADO',body.enabled?'buy':'warning');await save();respond(res,200,state());if(body.enabled)queueMicrotask(()=>cycle().catch(()=>{}));return true}
 respond(res,404,{error:'Rota desconhecida'});return true}catch(e){respond(res,400,{error:e.message});return true}}
function start(){load().then(()=>{timer=setInterval(()=>cycle().catch(e=>console.error('UNIFIED',e.message)),15000);timer.unref?.();event('Executor unificado pronto; ativacao manual necessaria')}).catch(e=>console.error('UNIFIED_INIT',e.message))}
module.exports={start,handle};
