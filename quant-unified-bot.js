
'use strict';

// AGENTE QUANT V5.2
// SCALPING 70 PONTOS - SOMENTE SIMULACAO
// 50 USDT POR ENTRADA | META DIARIA 30 USDT
// 20 USDT PERDA DIARIA | ATE 3 LOSSES

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE = path.join(__dirname, 'quant-unified-state.json');

// QUANT_SUPABASE_PERSISTENCE_V1
const Q_URL = (process.env.SUPABASE_URL || '')
  .replace(/\/$/, '');
const Q_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let qDatabaseReady = false;

async function qRequest(method, route, payload) {
  if (!Q_URL || !Q_KEY) {
    throw Error('Variaveis Supabase ausentes');
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(), 12000
  );

  try {
    const response = await fetch(
      Q_URL + '/rest/v1/' + route,
      {
        method,
        signal: controller.signal,
        headers: {
          apikey: Q_KEY,
          Authorization: 'Bearer ' + Q_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        ...(payload === undefined
          ? {}
          : {body: JSON.stringify(payload)})
      }
    );

    const body = await response.text();

    if (!response.ok) {
      throw Error(
        'Supabase HTTP ' + response.status +
        ': ' + body.slice(0, 200)
      );
    }

    return body ? JSON.parse(body) : null;
  } finally {
    clearTimeout(timer);
  }
}

async function qRestore() {
  const rows = await qRequest(
    'GET',
    'quant_runtime?select=state&id=eq.principal&limit=1'
  );
  return rows?.[0]?.state || null;
}

async function qPersist(snapshot) {
  await qRequest(
    'POST',
    'quant_runtime?on_conflict=id',
    [{
      id: 'principal',
      state: snapshot,
      updated_at: new Date().toISOString()
    }]
  );
}

const ASSETS = [
  'BTC','ETH','SOL','BNB','XRP',
  'LINK','AVAX','ADA','DOGE','SUI',
  'NEAR','LTC','TRX','UNI','BCH',
  'DOT','APT','ARB','AAVE','XLM'
];

const DEFAULT = {
  enabled:false,
  stake:50,
  goal:30,
  lossLimit:20,
  maxLosses:3,
  maxPositions:1,
  start:'09:00',
  stopPct:1,
  targetPct:0.7
};

const FEE = 0.001;
const SLIP = 0.0003;
const SCAN_MS = 60000;
const MONITOR_MS = 5000;
const SIGNAL_AGE = 120000;
const TARGET_NET = 0.22;
const STOP_NET = 0.50;
const HOLD_MS = 12 * 60000;
const COOLDOWN_MS = 2 * 60000;
const ZONE = 'America/Sao_Paulo';

const now = () => new Date().toISOString();
const rnd = x => Number(Number(x).toFixed(6));

function brParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone:ZONE,
    year:'numeric',
    month:'2-digit',
    day:'2-digit',
    hour:'2-digit',
    minute:'2-digit',
    hourCycle:'h23'
  }).formatToParts(d);

  const value = name =>
    p.find(x => x.type === name)?.value || '00';

  return {
    day:value('year')+'-'+value('month')+'-'+value('day'),
    time:value('hour')+':'+value('minute')
  };
}

const today = () => brParts().day;
const clock = () => brParts().time;

function blank() {
  return {
    settings:{...DEFAULT},
    cash:1000,
    day:'',
    startEquity:1000,
    positions:[],
    trades:[],
    testTrades:[],
    events:[],
    lastScan:null,
    lastAttempt:null,
    lastResults:[],
    lastError:null,
    lastSlot:null,
    lastScanMs:0,
    openedToday:0,
    diagnostic:'Aguardando ativacao',
    usedSignals:{},
    cooldowns:{},
    stats:{scans:0,signals:0,rejected:0}
  };
}

let st = blank();
let ready = false;
let busy = false;
let saveQueue = Promise.resolve();

function equity() {
  return st.cash + st.positions.reduce(
    (v,p) => v+p.qty*(p.mark||p.entry)*(1-FEE-SLIP),
    0
  );
}

const pnl = () => equity()-st.startEquity;

function losses() {
  return st.trades.filter(t =>
    t.net<0 &&
    brParts(new Date(t.closedAt)).day===st.day
  ).length;
}

function log(text,type='info') {
  st.events.unshift({at:now(),text,type});
  st.events=st.events.slice(0,120);
}


function save() {
  const snapshot = JSON.parse(JSON.stringify(st));

  saveQueue = saveQueue
    .catch(e => {
      console.error('QUANT_PREVIOUS_SAVE', e.message);
    })
    .then(async () => {
      if (!qDatabaseReady) {
        throw Error('Supabase nao validado');
      }

      try {
        await qPersist(snapshot);
      } catch (e) {
        qDatabaseReady = false;
        st.settings.enabled = false;
        throw e;
      }

      try {
        const tmp = FILE + '.tmp';
        await fs.writeFile(
          tmp,
          JSON.stringify(snapshot),
          {mode: 0o600}
        );
        await fs.rename(tmp, FILE);
      } catch (e) {
        console.error('QUANT_CACHE', e.message);
      }
    });

  return saveQueue;
}

function newDay() {
  const d=today();
  if(d!==st.day) {
    st.day=d;
    st.startEquity=equity();
    st.openedToday=0;
    log('Novo dia de simulacao: '+d);
  }
}


async function load() {
  try {
    let old = await qRestore();

    if (!old) {
      try {
        old = JSON.parse(
          await fs.readFile(FILE, 'utf8')
        );
      } catch {
        old = null;
      }
    }

    if (old) {
      if (
        !Number.isFinite(old.cash) ||
        !Array.isArray(old.positions) ||
        !Array.isArray(old.trades)
      ) {
        throw Error('Carteira armazenada invalida');
      }

      st = {
        ...blank(),
        ...old,
        settings: {
          ...DEFAULT,
          ...old.settings,
          enabled: false,
          stake: 50,
          goal: 30,
          lossLimit: 20,
          maxLosses: 3,
          maxPositions: 1
        },
        usedSignals: old.usedSignals || {},
        cooldowns: old.cooldowns || {},
        stats: old.stats || {
          scans: 0,
          signals: 0,
          rejected: 0
        },
        lastScanMs: 0
      };

      log(
        'Carteira recuperada; ativacao manual necessaria'
      );
    } else {
      st = blank();
      log('Carteira inicial: 1000 USDT');
    }

    qDatabaseReady = true;
    newDay();
    await save();
    ready = true;
    log('Persistencia Supabase conectada');

  } catch (e) {
    ready = false;
    qDatabaseReady = false;
    st.settings.enabled = false;
    st.diagnostic =
      'ERRO DE PERSISTENCIA: ' + e.message;

    console.error(
      'QUANT_SUPABASE_STARTUP',
      e.message
    );
  }
}

async function legacy() {
  for(const name of [
    'quant-auto-state.json',
    'quant-scalp-state.json'
  ]) {
    try {
      const data=JSON.parse(
        await fs.readFile(path.join(__dirname,name),'utf8')
      );
      if(data.settings?.enabled) return name;
    } catch {}
  }
  return null;
}

function blocking() {
  if(!st.settings.enabled) return 'DESLIGADO';
  if(clock()<st.settings.start) return 'AGUARDANDO HORARIO';
  if(losses()>=3) return 'TRAVA: 3 LOSSES';
  if(pnl()<=-20) return 'LIMITE DE PERDA DIARIA';
  if(pnl()>=30) return 'META DIARIA ATINGIDA';
  if(st.positions.length>=1) return 'POSICAO ABERTA';
  return null;
}

async function binance(endpoint) {
  let failure;
  for(const host of [
    'https://data-api.binance.vision',
    'https://api.binance.com'
  ]) {
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),8000);
    try {
      const res=await fetch(host+'/api/v3/'+endpoint,{
        signal:controller.signal,cache:'no-store'
      });
      if(!res.ok) throw Error('Binance HTTP '+res.status);
      return await res.json();
    } catch(e) {
      failure=e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw failure||Error('Binance indisponivel');
}

async function book(sym) {
  const x=await binance('ticker/bookTicker?symbol='+sym+'USDT');
  const ask=+x.askPrice,bid=+x.bidPrice;
  if(!(ask>0&&bid>0)) throw Error('Cotacao invalida');
  return {ask,bid};
}

async function candles(sym,interval) {
  const q=new URLSearchParams({
    symbol:sym+'USDT',
    interval,
    limit:'75'
  });
  const rows=await binance('klines?'+q);
  if(!Array.isArray(rows)) throw Error('Candles invalidos');
  return rows.filter(x=>+x[6]<Date.now()).map(x=>({
    t:+x[0],end:+x[6],
    o:+x[1],h:+x[2],l:+x[3],c:+x[4],v:+x[5]
  }));
}

function ema(arr,period) {
  if(arr.length<period) return NaN;
  let e=arr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<arr.length;i++)
    e+=(arr[i]-e)*2/(period+1);
  return e;
}

function rsi(arr) {
  const a=arr.slice(-15);
  if(a.length<15) return 50;
  let gains=0,lossesValue=0;
  for(let i=1;i<a.length;i++) {
    const delta=a[i]-a[i-1];
    gains+=Math.max(delta,0);
    lossesValue+=Math.max(-delta,0);
  }
  if(!lossesValue) return gains?100:50;
  return 100-100/(1+gains/lossesValue);
}

function analyze(one,five) {
  if(one.length<45||five.length<45) {
    return {approved:false,score:0,
      why:'Historico insuficiente',checks:{}};
  }

  const b=one.at(-1);
  const c1=one.map(x=>x.c);
  const c5=five.map(x=>x.c);

  const e1fast=ema(c1,9);
  const e1slow=ema(c1,21);
  const e5fast=ema(c5,9);
  const e5slow=ema(c5,21);
  const priorHigh=Math.max(...one.slice(-7,-1).map(x=>x.h));
  const avgVolume=one.slice(-21,-1)
    .reduce((s,x)=>s+x.v,0)/20;
  const volumeRatio=b.v/(avgVolume||1);
  const strength=rsi(c1);

  const checks={
    trend5:e5fast>e5slow&&c5.at(-1)>e5slow,
    trend1:e1fast>e1slow&&b.c>e1fast,
    breakout:b.c>b.o&&b.c>one.at(-2).c&&b.c>priorHigh,
    volume:volumeRatio>=1.10,
    rsi:strength>=52&&strength<=76
  };

  const score=
    (checks.trend5?30:0)+
    (checks.trend1?25:0)+
    (checks.breakout?25:0)+
    (checks.volume?10:0)+
    (checks.rsi?10:0);

  const age=Date.now()-b.end;
  const fresh=age>=0&&age<=SIGNAL_AGE;

  // CALIBRACAO V5.2:
  // 70 pontos sao suficientes SOMENTE com os
  // quatro filtros curtos confirmados.
  // Nao exigir tendencia de 5m.
  const approved=
    score>=70 &&
    checks.trend1 &&
    checks.breakout &&
    checks.volume &&
    checks.rsi &&
    fresh;

  const missing=[];
  if(!checks.trend5) missing.push('tendencia 5m');
  if(!checks.trend1) missing.push('tendencia 1m');
  if(!checks.breakout) missing.push('rompimento 1m');
  if(!checks.volume) missing.push('volume');
  if(!checks.rsi) missing.push('RSI');
  if(!fresh) missing.push('sinal antigo');

  const why=approved
    ? (checks.trend5
      ? 'ENTRADA PREMIUM: 100/100'
      : 'ENTRADA EXPERIMENTAL: 70/100 sem tendencia 5m')
    : 'Falta: '+missing.join(', ');

  return {
    approved,score,why,checks,
    setup:'scalping-1m-5m',
    signalTime:b.t,
    signalCloseTime:b.end,
    signalAgeMs:age,
    rsi:rnd(strength),
    volumeRatio:rnd(volumeRatio),
    trendConfirmed:checks.trend5&&checks.trend1,
    timing1:checks.breakout,
    breakout5:checks.breakout
  };
}

async function universe() {
  const [exchange,volumes,books]=await Promise.all([
    binance('exchangeInfo'),
    binance('ticker/24hr'),
    binance('ticker/bookTicker')
  ]);

  const allowed=new Set(exchange.symbols.filter(x=>
    x.status==='TRADING'&&x.quoteAsset==='USDT'&&
    x.isSpotTradingAllowed!==false
  ).map(x=>x.symbol));

  const vol=new Map(volumes.map(x=>[x.symbol,+x.quoteVolume]));
  const quotes=new Map(books.map(x=>[
    x.symbol,{ask:+x.askPrice,bid:+x.bidPrice}
  ]));

  return ASSETS.map(sym=>{
    const key=sym+'USDT',quote=quotes.get(key);
    const spread=quote?.ask>0&&quote?.bid>0
      ? 100*(quote.ask-quote.bid)/((quote.ask+quote.bid)/2)
      : Infinity;

    return {
      sym,quote,spread,
      eligible:allowed.has(key)&&
        (vol.get(key)||0)>=5000000&&spread<=0.08
    };
  });
}

async function closePosition(p) {
  const q=await book(p.sym);
  p.mark=q.bid;
  const exit=q.bid*(1-SLIP);
  const proceeds=p.qty*exit*(1-FEE);
  const net=proceeds-p.cost;
  const opening=Number.isFinite(p.openedMs)
    ?p.openedMs:Date.parse(p.openedAt);
  const age=Date.now()-(Number.isFinite(opening)?opening:Date.now());

  let reason=null;
  if(p.setup==='scalping-1m-5m') {
    if(net>=(p.targetNet??TARGET_NET))
      reason='LUCRO_LIQUIDO';
    else if(net<=-(p.stopNet??STOP_NET))
      reason='STOP';
    else if(age>=HOLD_MS)
      reason='TEMPO_12M';
  } else {
    const stop=p.stopPrice||
      p.entry*(1-st.settings.stopPct/100);
    const target=p.targetPrice||
      p.entry*(1+st.settings.targetPct/100);
    if(q.bid<=stop) reason='STOP_ANTIGO';
    else if(q.bid>=target) reason='ALVO_ANTIGO';
    else if(age>=48*3600000) reason='TEMPO_48H';
  }

  if(!reason) return;

  st.cash+=proceeds;
  st.positions=st.positions.filter(x=>x!==p);
  st.cooldowns[p.sym]=Date.now();

  st.trades.unshift({
    symbol:p.sym,
    entry:p.entry,
    exit,stake:p.cost,net,
    openedAt:p.openedAt,
    closedAt:now(),
    reason,setup:p.setup,
    score:p.score
  });
  st.trades=st.trades.slice(0,500);

  log('VENDA FICTICIA '+p.sym+' '+rnd(net)+
    ' USDT ('+reason+')',net>=0?'profit':'loss');
  await save();
}

async function monitor() {
  for(const p of [...st.positions]) {
    try {
      await closePosition(p);
    } catch(e) {
      st.lastError='Monitor '+p.sym+': '+e.message;
      log(st.lastError,'warning');
    }
  }
}

async function scan() {
  st.lastAttempt=now();
  st.diagnostic='Analisando scalping 70+';
  const assets=await universe();
  const results=[];

  for(let i=0;i<assets.length;i+=5) {
    const group=assets.slice(i,i+5);
    const settled=await Promise.allSettled(
      group.map(async a=>{
        if(!a.eligible)
          return {sym:a.sym,approved:false,score:0,
            why:'Liquidez ou spread',checks:{}};

        const [one,five]=await Promise.all([
          candles(a.sym,'1m'),
          candles(a.sym,'5m')
        ]);

        return {
          sym:a.sym,
          ask:a.quote.ask,
          spread:a.spread,
          ...analyze(one,five)
        };
      })
    );

    group.forEach((a,j)=>{
      results.push(settled[j].status==='fulfilled'
        ?settled[j].value
        :{sym:a.sym,approved:false,score:0,
          why:'ERRO: '+String(
            settled[j].reason?.message||'desconhecido'
          ),checks:{}}
      );
    });
  }

  st.lastResults=results;
  st.lastScan=now();
  st.stats.scans++;

  const approved=results.filter(x=>x.approved)
    .sort((a,b)=>b.score-a.score||a.spread-b.spread);

  const candidates=approved.filter(x=>
    st.usedSignals[x.sym]!==x.signalTime&&
    Date.now()-(st.cooldowns[x.sym]||0)>=COOLDOWN_MS
  );

  st.stats.signals+=approved.length;
  st.stats.rejected+=results.length-approved.length;

  const highlights=[...results]
    .sort((a,b)=>(b.score||0)-(a.score||0))
    .slice(0,3)
    .map(x=>x.sym+':'+(x.score||0))
    .join(' | ');

  st.diagnostic=candidates.length+
    ' entradas elegiveis / 20 moedas | '+
    'Destaques: '+highlights;

  if(approved.length) {
    log('SINAIS 70+: '+approved
      .map(x=>x.sym+' '+x.score).join(', '),'scan');
  } else {
    log('ANALISE: '+st.diagnostic,'scan');
  }

  if(!candidates.length||blocking()) return;

  for(const pick of candidates) {
    try {
      // Protecao contra o mesmo candle.
      if(st.usedSignals[pick.sym]===pick.signalTime)
        continue;

      if(Date.now()-pick.signalCloseTime>SIGNAL_AGE)
        continue;

      if(Date.now()-(st.cooldowns[pick.sym]||0)<COOLDOWN_MS)
        continue;

      const q=await book(pick.sym);
      if(q.ask>pick.ask*1.001) continue;

      // Verifica o spread na cotacao atual.
      const spread=100*(q.ask-q.bid)/((q.ask+q.bid)/2);
      if(spread>0.08) continue;

      const stake=50;
      const entry=q.ask*(1+SLIP);
      const qty=stake/entry;
      const cost=stake*(1+FEE);

      if(st.cash<cost) {
        st.diagnostic='Saldo ficticio insuficiente';
        return;
      }

      await save();
        st.cash-=cost;
      st.positions.push({
        sym:pick.sym,entry,qty,cost,
        mark:q.bid,
        openedAt:now(),
        openedMs:Date.now(),
        setup:'scalping-1m-5m',
        targetNet:TARGET_NET,
        stopNet:STOP_NET,
        signalTime:pick.signalTime,
        score:pick.score
      });

      st.usedSignals[pick.sym]=pick.signalTime;
      st.openedToday++;
      st.diagnostic='COMPRA FICTICIA '+pick.sym+
        ' 50 USDT | Nota '+pick.score;

      log(st.diagnostic,'buy');
      await save();
      return;
    } catch(e) {
      st.lastError=e.message;
      log('Entrada recusada: '+e.message,'warning');
    }
  }
}

async function cycle() {
  if(!ready||busy) return;
  busy=true;
  try {
    newDay();
    if (!qDatabaseReady) {
      throw Error('Supabase indisponivel');
    }
    await monitor();
    await save();

    const reason=blocking();
    if(reason) {
      st.diagnostic=reason;
      await save();
      return;
    }

    const old=await legacy();
    if(old) {
      st.diagnostic='Desligue primeiro: '+old;
      await save();
      return;
    }

    if(Date.now()-st.lastScanMs>=SCAN_MS) {
      st.lastScanMs=Date.now();
      st.lastSlot=Math.floor(Date.now()/SCAN_MS);
      await scan();
    }
    await save();
  } catch(e) {
    st.lastError=e.message;
    st.diagnostic='ERRO: '+e.message;
    log(st.diagnostic,'warning');
    try {await save();} catch {}
  } finally {
    busy=false;
  }
}

function state() {
  newDay();
  return {
    ...st,
    lossesToday:losses(),
    netToday:pnl(),
    equity:equity(),
    blocking:blocking(),
    clockBR:clock(),
    working:busy,
    simulation:true,
    realOrders:false,
    storage:'Supabase permanente + cache Render',
    system:'Agente Quant V5.2 - Scalping 70+',
    scanInterval:'1m',
    monitorInterval:'5s',
    strategyTimeframe:'1m + 5m',
    minScore:70,
    profitTargetUSDT:TARGET_NET,
    stopUSDT:STOP_NET
  };
}

function reply(res,status,data) {
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'
  });
  res.end(JSON.stringify(data));
}

function valid(pin) {
  const secret=process.env.QUANT_ACCESS_PIN||'';
  if(!secret||typeof pin!=='string') return false;
  const a=Buffer.from(secret),b=Buffer.from(pin);
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

async function body(req) {
  let text='';
  for await(const part of req) {
    text+=part;
    if(text.length>2048) throw Error('Payload extenso');
  }
  return text?JSON.parse(text):{};
}

async function handle(req,res,url) {
  if(!url.pathname.startsWith('/api/quant-unified/'))
    return false;

  if(!valid(req.headers['x-quant-pin'])) {
    reply(res,401,{error:'PIN invalido'});
    return true;
  }

  if(!ready) {
    reply(res,503,{error:'Motor inicializando'});
    return true;
  }

  try {
    if(req.method==='GET'&&
       url.pathname==='/api/quant-unified/status') {
      reply(res,200,state());
      return true;
    }

    if(req.method!=='POST') {
      reply(res,405,{error:'Metodo invalido'});
      return true;
    }

    const data=await body(req);

    if(url.pathname==='/api/quant-unified/config') {
      if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.start))
        throw Error('Horario invalido');

      st.settings.stake=50;
      st.settings.goal=30;
      st.settings.lossLimit=20;
      st.settings.maxLosses=3;
      st.settings.maxPositions=1;
      st.settings.start=data.start;

      log('Parametros V5.2 salvos');
      await save();
      reply(res,200,state());
      return true;
    }

    if(url.pathname==='/api/quant-unified/switch') {
      if(typeof data.enabled!=='boolean')
        throw Error('Comando invalido');

      if(data.enabled) {
        const old=await legacy();
        if(old) throw Error('Desligue '+old);
      }

      st.settings.enabled=data.enabled;
      if(data.enabled) st.lastScanMs=0;

      log(data.enabled
        ?'SCALPING V5.2 ATIVADO'
        :'SCALPING V5.2 DESLIGADO');

      await save();
      reply(res,200,state());

      if(data.enabled)
        queueMicrotask(()=>cycle().catch(()=>{}));
      return true;
    }

    if(url.pathname==='/api/quant-unified/test-trade') {
      if(busy||st.positions.length)
        throw Error('Motor ocupado ou posicao aberta');

      const sym=ASSETS.includes(data.symbol)
        ?data.symbol:'BTC';

      const first=await book(sym);
      const second=await book(sym);

      const stake=50;
      const entry=first.ask*(1+SLIP);
      const qty=stake/entry;
      const cost=stake*(1+FEE);
      const exit=second.bid*(1-SLIP);
      const net=qty*exit*(1-FEE)-cost;

      const test={
        symbol:sym,entry,exit,stake,cost,net,
        openedAt:now(),closedAt:now(),
        reason:'TESTE ISOLADO',test:true
      };

      st.testTrades.unshift(test);
      st.testTrades=st.testTrades.slice(0,30);
      log('TESTE ISOLADO '+sym+' '+rnd(net)+' USDT');
      await save();

      reply(res,200,{...state(),test});
      return true;
    }

    reply(res,404,{error:'Rota inexistente'});
    return true;
  } catch(e) {
    reply(res,400,{error:e.message});
    return true;
  }
}

function start() {
  load().then(()=>{
    const timer=setInterval(
      ()=>cycle().catch(e=>
        console.error('QUANT_V5_2',e.message)
      ),
      MONITOR_MS
    );
    timer.unref?.();
    log('V5.2 pronta: minimo 70 pontos, entrada 50 USDT');
  }).catch(e=>console.error('QUANT_INIT',e.message));
}

module.exports={handle,start};
