'use strict';
// AGENTE QUANT: SOMENTE PAPER TRADING. Nunca envia ordens à Binance.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const FILE=path.join(__dirname,'quant-auto-state.json');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA','DOGE','SUI','NEAR','LTC','TRX','UNI','BCH','DOT','APT','ARB','AAVE','XLM'];
const NAMES={BTC:'bitcoin',ETH:'ethereum',SOL:'solana',BNB:'binance coin',XRP:'ripple',LINK:'chainlink',AVAX:'avalanche',ADA:'cardano',DOGE:'dogecoin',SUI:'sui',NEAR:'near protocol',LTC:'litecoin',TRX:'tron',UNI:'uniswap',BCH:'bitcoin cash',DOT:'polkadot',APT:'aptos',ARB:'arbitrum',AAVE:'aave',XLM:'stellar'};
const DEFAULTS={stake:10,goal:50,lossLimit:20,maxLosses:3,start:'09:00',targetPct:2.5,stopPct:1,enabled:false};
const blank=()=>({settings:{...DEFAULTS},cash:1000,positions:[],trades:[],opened:0,day:'',startEquity:1000,lastEntryCandle:{},events:[],lastCycle:null,lastError:null,lastScanSlot:null,assetReports:[],universeAt:null});
let st=blank(),ready=false,processing=false,timer;
const fee=.001, MIN_DAILY_QUOTE=5000000, MAX_SPREAD_PCT=.35;
const dateBR=(d=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const clockBR=()=>new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
const equity=()=>st.cash+st.positions.reduce((a,p)=>a+p.qty*p.mark,0);
const pnl=()=>equity()-st.startEquity;
const lossesToday=()=>st.trades.filter(t=>Number(t.net)<0&&t.closedAt&&dateBR(new Date(t.closedAt))===st.day).length;
function log(text,kind='info'){st.events.unshift({at:new Date().toISOString(),text,kind});st.events=st.events.slice(0,150)}
async function save(){const f=FILE+'.tmp';await fs.writeFile(f,JSON.stringify(st),{mode:0o600});await fs.rename(f,FILE)}
async function load(){try{const s=JSON.parse(await fs.readFile(FILE,'utf8'));if(!Number.isFinite(s.cash)||!Array.isArray(s.trades)||!Array.isArray(s.positions))throw Error('Estado inválido');st={...blank(),...s,settings:{...DEFAULTS,...s.settings,enabled:false,maxLosses:3},assetReports:Array.isArray(s.assetReports)?s.assetReports:[]};delete st.settings.maxEntries;log('Servidor reiniciado: simulação pausada para segurança.','warning')}catch{st=blank();log('Carteira virtual iniciada. Arquivo do Render NÃO é persistente.','warning')}ready=true;newDay();await save()}
function newDay(){let today=dateBR();if(today!==st.day){st.day=today;st.opened=0;st.startEquity=equity();st.lastScanSlot=null;log('Novo dia virtual: '+today)}}
function block(){if(!st.settings.enabled)return 'DESLIGADO';if(clockBR()<st.settings.start)return 'AGUARDANDO '+st.settings.start;if(st.positions.some(p=>p.stale))return 'PREÇO DESATUALIZADO';if(lossesToday()>=3)return 'TRAVA: 3 LOSSES NO DIA';if(pnl()>=st.settings.goal)return 'META ATINGIDA';if(pnl()<=-st.settings.lossLimit)return 'LIMITE DE PERDA';if(st.positions.length>=3)return 'AGUARDANDO SAÍDA DE POSIÇÕES';return null}
async function market(endpoint){let error;for(const host of ['https://data-api.binance.vision','https://api.binance.com']){const ac=new AbortController(),t=setTimeout(()=>ac.abort(),10000);try{const r=await fetch(host+'/api/v3/'+endpoint,{signal:ac.signal,cache:'no-store'});if(!r.ok)throw Error('Binance HTTP '+r.status);return await r.json()}catch(e){error=e}finally{clearTimeout(t)}}throw error||Error('Sem dados Binance')}
async function bars(sym,interval='5m',limit=140){const a=await market('klines?'+new URLSearchParams({symbol:sym+'USDT',interval,limit:String(limit)}));if(!Array.isArray(a))throw Error('Candles inválidos');const b=a.filter(x=>Number(x[6])<Date.now()).map(x=>({t:+x[0],end:+x[6],o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]}));if(b.length<70)throw Error('Candles fechados insuficientes');return b}
async function ticker(sym){const x=Number((await market('ticker/price?symbol='+sym+'USDT')).price);if(!(x>0))throw Error('Preço indisponível');return x}
function ema(a,n){let x=a.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<a.length;i++)x=2/(n+1)*a[i]+(1-2/(n+1))*x;return x}
function rsi(a,n=14){let g=0,l=0;for(let i=1;i<=n;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}g/=n;l/=n;for(let i=n+1;i<a.length;i++){const d=a[i]-a[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n}return l?100-100/(1+g/l):100}
function report(sym,status,reason,extra={}){return {sym,status,reason,...extra}}
async function eligibleUniverse(){
 const [exchange,stats,quotes]=await Promise.all([market('exchangeInfo'),market('ticker/24hr'),market('ticker/bookTicker')]);
 const tradable=new Set((exchange.symbols||[]).filter(x=>x.status==='TRADING'&&x.isSpotTradingAllowed!==false&&x.quoteAsset==='USDT').map(x=>x.symbol));
 const volume=new Map((Array.isArray(stats)?stats:[]).map(x=>[x.symbol,Number(x.quoteVolume)]));
 const spread=new Map((Array.isArray(quotes)?quotes:[]).map(x=>{const b=Number(x.bidPrice),a=Number(x.askPrice);return [x.symbol,b>0&&a>=b?100*(a-b)/((a+b)/2):Infinity]}));
 const accepted=[],rejected=[];
 for(const sym of ASSETS){const s=sym+'USDT',v=volume.get(s),sp=spread.get(s);
  if(!tradable.has(s)){rejected.push(report(sym,'INDISPONÍVEL','Par Spot USDT não negociável'));continue}
  if(!Number.isFinite(v)||v<MIN_DAILY_QUOTE){rejected.push(report(sym,'LIQUIDEZ','Volume USDT em 24h abaixo de 5 milhões',{volume24h:v??null}));continue}
  if(!Number.isFinite(sp)||sp>MAX_SPREAD_PCT){rejected.push(report(sym,'SPREAD','Spread acima de 0,35%',{spreadPct:Number.isFinite(sp)?sp:null}));continue}
  accepted.push(sym)
 }
 return {accepted,rejected};
}
async function inspect(sym){const [a,m,h]=await Promise.all([bars(sym,'5m',180),bars(sym,'15m',140),bars(sym,'1h',140)]);
 const x=a.at(-1),prev=a.slice(-21,-1),high=Math.max(...prev.map(y=>y.h)),avg=prev.reduce((s,y)=>s+y.v,0)/20;
 const hclose=h.map(y=>y.c),mclose=m.map(y=>y.c),trend1h=hclose.at(-1)>ema(hclose,50)&&ema(hclose,20)>ema(hclose,50),trend15m=mclose.at(-1)>ema(mclose,50)&&ema(mclose,20)>ema(mclose,50);
 const breakout=x.c>high&&x.c<=high*1.015,vr=avg>0?x.v/avg:0,volume=vr>=1.25,rs=rsi(a.map(y=>y.c)),rsiOk=rs>=50&&rs<=75;
 const missing=[!trend1h?'Tendência 1h':null,!trend15m?'Tendência 15m':null,!breakout?'Rompimento 5m':null,!volume?'Volume 5m':null,!rsiOk?'RSI fora de 50–75':null].filter(Boolean);
 return report(sym,missing.length?'AGUARDANDO':'CANDIDATO',missing.length?'Falta: '+missing.join(', '):'Critérios técnicos aprovados',{candle:x.t,close:x.c,volumeRatio:vr,rsi:rs,approved:!missing.length});
}
async function contextGate(sym){if(!process.env.TINYFISH_API_KEY)return {ok:false,reason:'TinyFish não configurado'};const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),14000);try{
 const q=`${NAMES[sym]} ${sym} cryptocurrency news security regulation last 72 hours`,r=await fetch('https://api.search.tinyfish.ai/?'+new URLSearchParams({query:q,language:'en'}),{headers:{'X-API-Key':process.env.TINYFISH_API_KEY,Accept:'application/json'},signal:ac.signal});if(!r.ok)throw Error('TinyFish HTTP '+r.status);
 const data=await r.json(),now=Date.now(),arr=Array.isArray(data.results)?data.results:[],escaped=sym.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const re=new RegExp('\\b'+escaped+'\\b|'+NAMES[sym].replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
 const recent=arr.filter(x=>{const d=Date.parse(x.date||'');return Number.isFinite(d)&&d<=now&&now-d<=72*3600000&&re.test(String(x.title||'')+' '+String(x.snippet||''))});
 if(!recent.length)return {ok:false,reason:'Sem notícias recentes relevantes verificáveis'};
 if(recent.some(x=>/hack|exploit|fraud|scam|bankrupt|insolven|delist|lawsuit|outage|attack|suspend|breach|investigation|liquidation/i.test(String(x.title||'')+' '+String(x.snippet||''))))return {ok:false,reason:'Alerta de risco nas notícias'};
 return {ok:true,reason:'Sem alertas explícitos detectados (não garante segurança)'}
 }catch(e){return {ok:false,reason:'Falha TinyFish: '+e.message}}finally{clearTimeout(tm)}}
function closePosition(p,price,why){const proceeds=p.qty*price*(1-fee),net=proceeds-p.cost;st.cash+=proceeds;st.trades.unshift({symbol:p.sym,entry:p.entry,exit:price,net,reason:why,openedAt:p.openedAt,closedAt:new Date().toISOString()});st.positions=st.positions.filter(x=>x!==p);log('SAÍDA virtual '+p.sym+': '+net.toFixed(2)+' USDT | '+why,net<0?'loss':'profit');if(net<0)log('Losses hoje: '+lossesToday()+'/3',lossesToday()>=3?'warning':'info')}
async function refreshPositions(){for(const p of [...st.positions]){try{const [k,px]=await Promise.all([bars(p.sym,'1m',180),ticker(p.sym)]);p.mark=px;p.stale=false;let exit=null;for(const x of k.filter(x=>x.end>=p.openedMs)){if(x.l<=p.stop){exit={price:p.stop,why:'STOP simulado'};break}if(x.h>=p.take){exit={price:p.take,why:'ALVO simulado'};break}}if(!exit&&px<=p.stop)exit={price:px,why:'STOP consultado'};if(!exit&&px>=p.take)exit={price:px,why:'ALVO consultado'};if(exit)closePosition(p,exit.price,exit.why)}catch(e){p.stale=true;st.lastError='Preço '+p.sym+': '+e.message;log(st.lastError,'warning')}}}
const slot5=()=>Math.floor(Date.now()/300000);
async function cycle(){if(!ready||processing)return;processing=true;try{newDay();await refreshPositions();const b=block();if(b){st.lastCycle={at:new Date().toISOString(),status:b};await save();return}const slot=slot5();if(st.lastScanSlot===slot){st.lastCycle={at:new Date().toISOString(),status:'Monitorando posições; próxima análise na próxima vela 5m'};await save();return}st.lastScanSlot=slot;
 log('Verificando disponibilidade, liquidez e spread das 20 moedas…','scan');let universe;try{universe=await eligibleUniverse()}catch(e){st.lastError='Triagem Binance indisponível: '+e.message;log(st.lastError,'warning');st.lastScanSlot=null;await save();return}
 const results=[...universe.rejected];log('Universo: '+universe.accepted.length+' elegíveis; '+universe.rejected.length+' reprovadas na triagem.','scan');
 // Concorrência limitada: evita rajadas de 60 chamadas simultâneas.
 for(let i=0;i<universe.accepted.length;i+=4){const group=universe.accepted.slice(i,i+4);const batch=await Promise.allSettled(group.map(inspect));for(let j=0;j<group.length;j++){const b=batch[j];results.push(b.status==='fulfilled'?b.value:report(group[j],'ERRO','Falha ao consultar candles: '+b.reason.message))}}
 st.assetReports=ASSETS.map(sym=>results.find(r=>r.sym===sym)||report(sym,'ERRO','Sem avaliação'));st.universeAt=new Date().toISOString();
 let candidates=st.assetReports.filter(x=>x.approved&&!st.positions.some(p=>p.sym===x.sym)&&st.lastEntryCandle[x.sym]!==x.candle).sort((a,b)=>b.volumeRatio-a.volumeRatio);log('Análise de 20: '+candidates.length+' candidato(s) técnicos; '+st.assetReports.filter(x=>x.status==='ERRO').length+' erro(s).','scan');
 for(const x of candidates){if(block())break;log('Candidato '+x.sym+': triagem de notícias TinyFish.','scan');const gate=await contextGate(x.sym);if(!gate.ok){x.status='NOTÍCIAS';x.reason=gate.reason;log(x.sym+': '+gate.reason,'warning');continue}
 const check=await inspect(x.sym);if(!check.approved||check.candle!==x.candle){x.status='EXPIRADO';x.reason='Sinal mudou antes de entrada';continue}
 const price=await ticker(x.sym);if(Math.abs(price/x.close-1)>.005){x.status='PREÇO';x.reason='Preço afastou-se do fechamento';continue}
 if(block())break;const spend=Math.min(st.settings.stake,st.cash/(1+fee));if(spend<10)break;const qty=spend/price,cost=spend*(1+fee);st.cash-=cost;
 st.positions.push({sym:x.sym,qty,entry:price,cost,mark:price,stop:price*(1-st.settings.stopPct/100),take:price*(1+st.settings.targetPct/100),openedAt:new Date().toISOString(),openedMs:Date.now(),stale:false});st.opened++;st.lastEntryCandle[x.sym]=x.candle;x.status='ENTRADA';x.reason='Compra fictícia aprovada';log('ENTRADA virtual '+x.sym+' | '+spend.toFixed(2)+' USDT | '+price,'buy');break}
 st.lastCycle={at:new Date().toISOString(),status:candidates.length?candidates.length+' candidatos analisados':'20 moedas verificadas; nenhum sinal aprovado'};await save()
 }catch(e){st.lastError=e.message;log('Erro no ciclo: '+e.message,'warning');try{await save()}catch{}}finally{processing=false}}
function status(){newDay();return {...st,lossesToday:lossesToday(),maxLosses:3,netToday:pnl(),equity:equity(),blocking:block(),nowBrasilia:clockBR(),working:processing,assetCount:ASSETS.length,realOrders:false,storage:'Temporário no Render: estado pode desaparecer em restart/deploy'}}
async function body(req){let s='';for await(const c of req){s+=c;if(s.length>4096)throw Error('Requisição grande demais')}return s?JSON.parse(s):{}}
function reply(res,code,data){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data))}
function authorized(pin){const p=process.env.QUANT_ACCESS_PIN||'';if(!p||typeof pin!=='string')return false;const a=Buffer.from(p),b=Buffer.from(pin);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
async function handle(req,res,u){if(!u.pathname.startsWith('/api/quant-auto/'))return false;if(!authorized(req.headers['x-quant-pin'])){reply(res,401,{error:'PIN inválido'});return true}if(!ready){reply(res,503,{error:'Inicializando'});return true}try{
 if(req.method==='GET'&&u.pathname==='/api/quant-auto/status'){reply(res,200,status());return true}
 if(req.method!=='POST'){reply(res,405,{error:'Método inválido'});return true}const d=await body(req);
 if(u.pathname==='/api/quant-auto/config'){if(!Number.isFinite(d.stake)||d.stake<10||d.stake>500||!Number.isFinite(d.goal)||d.goal<=0||d.goal>100||!Number.isFinite(d.lossLimit)||d.lossLimit<=0||d.lossLimit>100||!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start)){reply(res,400,{error:'Parâmetros inválidos'});return true}st.settings={...st.settings,stake:d.stake,goal:d.goal,lossLimit:d.lossLimit,start:d.start,maxLosses:3};delete st.settings.maxEntries;log('Configuração salva: início '+d.start+', meta '+d.goal+', entrada '+d.stake+', limite '+d.lossLimit+', 3 losses.');await save();reply(res,200,status());return true}
 if(u.pathname==='/api/quant-auto/switch'){if(typeof d.enabled!=='boolean')throw Error('enabled inválido');st.settings.enabled=d.enabled;log(d.enabled?'ROBÔ VIRTUAL ATIVADO':'ROBÔ VIRTUAL PAUSADO',d.enabled?'buy':'warning');await save();reply(res,200,status());if(d.enabled)queueMicrotask(()=>cycle().catch(()=>{}));return true}
 if(u.pathname==='/api/quant-auto/run'){await cycle();reply(res,200,status());return true}
 reply(res,404,{error:'Rota ausente'});return true
 }catch(e){reply(res,400,{error:e.message});return true}}
function start(){load().then(()=>{timer=setInterval(()=>cycle().catch(e=>console.error('QUANT_AUTO',e.message)),60000);timer.unref?.();log('Rotina de 20 ativos pronta; requer ativação manual.')}).catch(e=>console.error('QUANT_AUTO_START',e.message))}
module.exports={handle,start};
