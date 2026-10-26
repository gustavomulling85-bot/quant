
'use strict';
// AGENTE QUANT UNIFICADO V2. SOMENTE PAPER TRADING. NAO ENVIA ORDENS REAIS.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const STATE=path.join(__dirname,'quant-unified-state.json');
const ASSETS=['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA','DOGE','SUI','NEAR','LTC','TRX','UNI','BCH','DOT','APT','ARB','AAVE','XLM'];
const DEFAULT={enabled:false,stake:10,goal:50,lossLimit:20,maxLosses:3,start:'09:00',maxPositions:1,stopPct:1,targetPct:2.5};
const empty=()=>({settings:{...DEFAULT},cash:1000,day:'',startEquity:1000,positions:[],trades:[],events:[],lastScan:null,lastAttempt:null,lastResults:[],lastSlot:null,lastError:null,openedToday:0,diagnostic:'Aguardando ativacao'});
let st=empty(),ready=false,busy=false,timer;
const fee=.001,slip=.0003,TZ='America/Sao_Paulo';
const now=()=>new Date().toISOString();
const dayBR=(d=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const timeBR=()=>new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date());
const num=x=>Number(Number(x).toFixed(6));
const equity=()=>st.cash+st.positions.reduce((a,p)=>a+p.qty*(p.mark||p.entry)*(1-fee-slip),0);
const pnl=()=>equity()-st.startEquity;
const losses=()=>st.trades.filter(x=>x.net<0&&dayBR(new Date(x.closedAt))===st.day).length;

function log(text,type='info'){
 st.events.unshift({at:now(),text,type});
 st.events=st.events.slice(0,150);
}

async function save(){
 const file=STATE+'.tmp';
 await fs.writeFile(file,JSON.stringify(st),{mode:0o600});
 await fs.rename(file,STATE);
}

function newDay(){
 const d=dayBR();
 if(st.day!==d){
  st.day=d;
  st.startEquity=equity();
  st.openedToday=0;
  st.lastSlot=null;
  log('Novo dia ficticio: '+d);
 }
}

async function load(){
 try{
  const d=JSON.parse(await fs.readFile(STATE,'utf8'));
  if(!Number.isFinite(d.cash)||!Array.isArray(d.positions)||!Array.isArray(d.trades))throw Error('Estado invalido');
  st={...empty(),...d,settings:{...DEFAULT,...d.settings,enabled:false}};
  log('Reinicio do servidor: executor desligado por seguranca','warning');
 }catch{
  st=empty();
  log('Carteira ficticia inicializada: 1000 USDT','warning');
 }
 newDay();
 ready=true;
 await save();
}

async function legacy(){
 for(const f of ['quant-auto-state.json','quant-scalp-state.json']){
  try{
   const x=JSON.parse(await fs.readFile(path.join(__dirname,f),'utf8'));
   if(x.settings?.enabled)return f;
  }catch{}
 }
 return null;
}

function blocking(){
 if(!st.settings.enabled)return 'DESLIGADO';
 if(timeBR()<st.settings.start)return 'AGUARDANDO HORARIO '+st.settings.start;
 if(losses()>=3)return 'TRAVA: 3 LOSSES';
 if(pnl()>=st.settings.goal)return 'META DIARIA';
 if(pnl()<=-st.settings.lossLimit)return 'LIMITE DE PERDA';
 if(st.positions.length>=st.settings.maxPositions)return 'POSICAO ABERTA';
 return null;
}

async function binance(e){
 let last;
 for(const host of ['https://data-api.binance.vision','https://api.binance.com']){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8500);
  try{
   const res=await fetch(host+'/api/v3/'+e,{signal:controller.signal,cache:'no-store'});
   if(!res.ok)throw Error('Binance HTTP '+res.status);
   return await res.json();
  }catch(err){
   last=err;
  }finally{
   clearTimeout(timeout);
  }
 }
 throw last||Error('Binance indisponivel');
}

async function candles(sym,interval,limit=110){
 const q=new URLSearchParams({symbol:sym+'USDT',interval,limit:String(limit)});
 const raw=await binance('klines?'+q);
 if(!Array.isArray(raw))throw Error('Candles invalidos');
 return raw.filter(x=>+x[6]<Date.now()).map(x=>({
  o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]
 }));
}

function ema(arr,n){
 if(arr.length<n)return NaN;
 let x=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
 for(let i=n;i<arr.length;i++)x+=2/(n+1)*(arr[i]-x);
 return x;
}

function rsi(arr){
 if(arr.length<16)return NaN;
 let g=0,l=0;
 for(let i=arr.length-14;i<arr.length;i++){
  const d=arr[i]-arr[i-1];
  g+=Math.max(0,d);
  l+=Math.max(0,-d);
 }
 return l===0?(g===0?50:100):100-100/(1+g/l);
}

function analyze(one,five,fifteen,hour){
 if([one,five,fifteen,hour].some(x=>x.length<40))
  return {approved:false,why:'Historico insuficiente'};

 const trend=a=>{
  const c=a.map(x=>x.c);
  return ema(c.slice(-40),9)>ema(c.slice(-40),21);
 };

 const a=one.at(-1);
 const b=five.at(-1);
 const r=rsi(one.map(x=>x.c));
 const v=one.slice(-21,-1).reduce((sum,x)=>sum+x.v,0)/20;

 const strongTrend=trend(hour)&&trend(fifteen)&&trend(five);
 const m1Trend=trend(one);
 const recentHigh=Math.max(...five.slice(-21,-1).map(x=>x.h));

 const breakout=b.c>recentHigh&&b.c>b.o;

 const pullback=
  b.c>b.o&&
  b.c>=ema(five.slice(-40).map(x=>x.c),21)&&
  b.l<=ema(five.slice(-40).map(x=>x.c),9)*1.004;

 const timing=
  m1Trend&&
  a.c>a.o&&
  r>=48&&r<=72&&
  v>0&&
  a.v>=v*.9;

 const approved=strongTrend&&timing&&(breakout||pullback);

 const why=approved
  ?(breakout?'Rompimento confirmado':'Recuo em tendencia confirmado')
  :[
    !strongTrend?'Tendencia 5m/15m/1h nao alinhada':'',
    !timing?'Momento 1m/RSI/volume nao aprovado':'',
    !(breakout||pullback)?'Sem rompimento nem recuo favoravel':''
   ].filter(Boolean).join('; ');

 return {
  approved,why,
  setup:breakout?'rompimento':pullback?'recuo':'nenhum',
  rsi:num(r),
  volumeRatio:num(a.v/(v||1)),
  trendConfirmed:strongTrend,
  timing1:timing,
  breakout5:breakout,
  pullback5:pullback
 };
}

async function universe(){
 const [ex,vol,books]=await Promise.all([
  binance('exchangeInfo'),
  binance('ticker/24hr'),
  binance('ticker/bookTicker')
 ]);

 const allowed=new Set(
  ex.symbols.filter(x=>
   x.status==='TRADING'&&
   x.quoteAsset==='USDT'&&
   x.isSpotTradingAllowed!==false
  ).map(x=>x.symbol)
 );

 const volumes=new Map(vol.map(x=>[x.symbol,+x.quoteVolume]));
 const quotes=new Map(books.map(x=>[
  x.symbol,{ask:+x.askPrice,bid:+x.bidPrice}
 ]));

 return ASSETS.map(sym=>{
  const k=sym+'USDT';
  const book=quotes.get(k);
  const spread=book?.ask>0&&book?.bid>0
   ?100*(book.ask-book.bid)/((book.ask+book.bid)/2)
   :Infinity;

  return {
   sym,book,spread,
   eligible:allowed.has(k)&&
    (volumes.get(k)||0)>=5000000&&
    spread<=.15
  };
 });
}

async function closeIfNeeded(p){
 const book=await binance('ticker/bookTicker?symbol='+p.sym+'USDT');
 const bid=+book.bidPrice;
 if(!(bid>0))throw Error('Cotacao de venda invalida');

 p.mark=bid;
 let reason=null;

 if(bid<=p.entry*(1-st.settings.stopPct/100))
  reason='STOP';
 else if(bid>=p.entry*(1+st.settings.targetPct/100))
  reason='ALVO';
 else if(Date.now()-p.openedMs>=5*60000){
  const a=await candles(p.sym,'1m',45);
  const c=a.map(x=>x.c);
  if(ema(c.slice(-35),9)<ema(c.slice(-35),21))
   reason='REVERSAO 1M';
 }

 if(!reason)return;

 const exit=bid*(1-slip);
 const proceeds=p.qty*exit*(1-fee);
 const net=proceeds-p.cost;

 st.cash+=proceeds;
 st.positions=st.positions.filter(x=>x!==p);

 st.trades.unshift({
  symbol:p.sym,
  entry:p.entry,
  exit,
  stake:p.cost,
  net,
  openedAt:p.openedAt,
  closedAt:now(),
  reason
 });

 st.trades=st.trades.slice(0,500);

 log(
  'VENDA FICTICIA '+p.sym+' '+num(net)+' USDT ('+reason+')',
  net>=0?'profit':'loss'
 );
}

async function monitor(){
 for(const p of [...st.positions]){
  try{
   await closeIfNeeded(p);
  }catch(e){
   st.lastError='Falha monitor '+p.sym+': '+e.message;
   log(st.lastError,'warning');
  }
 }
}

async function scan(){
 st.lastAttempt=now();
 st.diagnostic='Analisando cotacoes';
 log('Analise conjunta de 20 moedas iniciada','scan');

 const assets=await universe();
 const results=[];

 for(let i=0;i<assets.length;i+=4){
  const group=assets.slice(i,i+4);

  const data=await Promise.allSettled(
   group.map(async a=>{
    if(!a.eligible)
     return {
      sym:a.sym,
      approved:false,
      why:'Liquidez ou spread fora do limite'
     };

    const [m1,m5,m15,h1]=await Promise.all(
     ['1m','5m','15m','1h'].map(k=>candles(a.sym,k))
    );

    return {
     sym:a.sym,
     ask:a.book.ask,
     spread:a.spread,
     ...analyze(m1,m5,m15,h1)
    };
   })
  );

  group.forEach((a,j)=>results.push(
   data[j].status==='fulfilled'
    ?data[j].value
    :{
      sym:a.sym,
      approved:false,
      why:'Erro na cotacao: '+
       String(data[j].reason?.message||'desconhecido')
     }
  ));
 }

 st.lastResults=results;
 st.lastScan=now();

 const matches=results.filter(x=>x.approved)
  .sort((a,b)=>a.spread-b.spread);

 const errors=results.filter(x=>x.why?.startsWith('Erro')).length;

 st.diagnostic=
  matches.length+' sinais aprovados / '+
  errors+' erros de cotacao / 20 moedas';

 log('Analise concluida: '+st.diagnostic,'scan');

 if(!matches.length||blocking())return;

 const best=matches[0];
 const q=await binance('ticker/bookTicker?symbol='+best.sym+'USDT');
 const ask=+q.askPrice;

 if(!(ask>0)||ask>best.ask*1.002){
  st.diagnostic='Oportunidade expirou: '+best.sym;
  return;
 }

 const invest=Math.min(
  st.settings.stake,
  st.cash/(1+fee+slip)
 );

 if(invest<10){
  st.diagnostic='Saldo insuficiente';
  return;
 }

 const entry=ask*(1+slip);
 const qty=invest/entry;
 const cost=invest*(1+fee);

 st.cash-=cost;

 st.positions.push({
  sym:best.sym,
  entry,qty,cost,
  mark:ask,
  openedAt:now(),
  openedMs:Date.now(),
  setup:best.setup
 });

 st.openedToday++;
 st.diagnostic='Compra ficticia registrada: '+best.sym;

 log(
  'COMPRA FICTICIA '+best.sym+' '+num(invest)+
  ' USDT por '+best.setup,
  'buy'
 );
}

async function cycle(){
 if(!ready||busy)return;

 busy=true;

 try{
  newDay();
  await monitor();

  const currentBlock=blocking();

  if(currentBlock){
   st.diagnostic=currentBlock;
   await save();
   return;
  }

  const prev=await legacy();

  if(prev){
   st.diagnostic=
    'BLOQUEADO: desligue '+prev+
    ' para evitar duplicacao';

   if(!st.events[0]?.text?.includes(prev))
    log(st.diagnostic,'warning');

   await save();
   return;
  }

  const slot=Math.floor(Date.now()/60000);

  if(st.lastSlot!==slot){
   st.lastSlot=slot;
   await scan();
  }

  await save();

 }catch(e){
  st.lastError=e.message;
  st.diagnostic='ERRO: '+e.message;
  log(st.diagnostic,'warning');

  try{
   await save();
  }catch{}

 }finally{
  busy=false;
 }
}

function state(){
 newDay();

 return {
  ...st,
  lossesToday:losses(),
  netToday:pnl(),
  equity:equity(),
  blocking:blocking(),
  clockBR:timeBR(),
  working:busy,
  simulation:true,
  realOrders:false,
  storage:'Arquivo temporario no Render',
  system:'Unified Paper V2',
  scanInterval:'1m'
 };
}

const response=(res,status,data)=>{
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff'
 });
 res.end(JSON.stringify(data));
};

function valid(pin){
 const secret=process.env.QUANT_ACCESS_PIN||'';
 if(!secret||typeof pin!=='string')return false;

 const a=Buffer.from(pin);
 const b=Buffer.from(secret);

 return a.length===b.length&&
  crypto.timingSafeEqual(a,b);
}

async function body(req){
 let s='';
 for await(const chunk of req){
  s+=chunk;
  if(s.length>2048)throw Error('Payload extenso');
 }
 return s?JSON.parse(s):{};
}

async function handle(req,res,u){
 if(!u.pathname.startsWith('/api/quant-unified/'))
  return false;

 if(!valid(req.headers['x-quant-pin'])){
  response(res,401,{error:'PIN invalido'});
  return true;
 }

 if(!ready){
  response(res,503,{error:'Motor inicializando'});
  return true;
 }

 try{
  if(
   req.method==='GET'&&
   u.pathname==='/api/quant-unified/status'
  ){
   response(res,200,state());
   return true;
  }

  if(req.method!=='POST'){
   response(res,405,{error:'Metodo invalido'});
   return true;
  }

  const d=await body(req);

  if(u.pathname==='/api/quant-unified/config'){
   if(
    !Number.isFinite(d.stake)||
    d.stake<10||d.stake>100||
    !Number.isFinite(d.goal)||
    d.goal<=0||d.goal>100||
    !Number.isFinite(d.lossLimit)||
    d.lossLimit<1||d.lossLimit>100||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.start)
   )throw Error('Configuracao invalida');

   st.settings={
    ...st.settings,
    stake:d.stake,
    goal:d.goal,
    lossLimit:d.lossLimit,
    start:d.start
   };

   log('Parametros atualizados');
   await save();
   response(res,200,state());
   return true;
  }

  if(u.pathname==='/api/quant-unified/switch'){
   if(typeof d.enabled!=='boolean')
    throw Error('enabled invalido');

   if(d.enabled){
    const prev=await legacy();
    if(prev)throw Error('Desligue antes '+prev);
   }

   st.settings.enabled=d.enabled;

   log(
    d.enabled?'Executor V2 ATIVADO':'Executor V2 DESLIGADO',
    d.enabled?'buy':'warning'
   );

   await save();
   response(res,200,state());

   if(d.enabled)
    queueMicrotask(()=>cycle().catch(()=>{}));

   return true;
  }

  response(res,404,{error:'Rota inexistente'});
  return true;

 }catch(e){
  response(res,400,{error:e.message});
  return true;
 }
}

function start(){
 load().then(()=>{
  timer=setInterval(
   ()=>cycle().catch(e=>
    console.error('UNIFIED',e.message)
   ),
   15000
  );

  timer.unref?.();

  log('Motor unificado V2 pronto, requer ativacao manual');

 }).catch(e=>
  console.error('UNIFIED_INIT',e.message)
 );
}

module.exports={handle,start};
