'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const SYMBOLS = new Set(['BTC','ETH','SOL','BNB','XRP','LINK','AVAX','ADA']);
const CACHE = new Map();
const lastCalls = new Map();
const TYPES = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
function pinValid(candidate){const pin=process.env.QUANT_ACCESS_PIN || '';if(!pin || typeof candidate !== 'string')return false;const a=Buffer.from(pin),b=Buffer.from(candidate);return a.length===b.length && crypto.timingSafeEqual(a,b);}
const server=http.createServer(async(req,res)=>{
  try {
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/api/health' && req.method==='GET')return json(res,200,{status:'ok',service:'agente-quant-v3'});
    if(u.pathname==='/api/tinyfish/status' && req.method==='GET')return json(res,200,{configured:Boolean(process.env.TINYFISH_API_KEY),pinConfigured:Boolean(process.env.QUANT_ACCESS_PIN)});
    if(u.pathname==='/api/tinyfish/context' && req.method==='POST'){
      if(!process.env.QUANT_ACCESS_PIN || !process.env.TINYFISH_API_KEY)return json(res,503,{error:'Configuração de servidor incompleta.'});
      if(!pinValid(req.headers['x-quant-pin']))return json(res,401,{error:'PIN inválido.'});
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2048)return json(res,413,{error:'Requisição extensa demais.'});}
      let symbol;try{symbol=JSON.parse(body).symbol}catch{return json(res,400,{error:'JSON inválido.'});}
      if(!SYMBOLS.has(symbol))return json(res,400,{error:'Ativo não permitido.'});
      const now=Date.now(),cached=CACHE.get(symbol);
      if(cached && now-cached.at < 15*60*1000)return json(res,200,{...cached.result,cached:true});
      const prev=lastCalls.get(symbol)||0;
      if(now-prev<60*1000)return json(res,429,{error:'Aguarde antes de repetir a consulta.'});
      lastCalls.set(symbol,now);
      const query=`${symbol} cryptocurrency latest market news regulation exchange security announcement`;
      const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),18000);
      try{
        const response=await fetch('https://api.search.tinyfish.ai/?'+new URLSearchParams({query,language:'en'}),{headers:{'X-API-Key':process.env.TINYFISH_API_KEY,'Accept':'application/json'},signal:controller.signal});
        if(!response.ok)return json(res,502,{error:`TinyFish retornou HTTP ${response.status}.`});
        const data=await response.json();
        const records=Array.isArray(data.results)?data.results:[];
        const result={symbol,consultedAt:new Date().toISOString(),results:records.slice(0,10).map(x=>({title:String(x.title||''),snippet:String(x.snippet||''),url:typeof x.url==='string'&&/^https?:\/\//.test(x.url)?x.url:null,date:x.date||null}))};
        CACHE.set(symbol,{at:now,result});return json(res,200,result);
      }catch(error){return json(res,502,{error:error.name==='AbortError'?'Tempo de consulta esgotado.':'Não foi possível consultar o TinyFish.'});}
      finally{clearTimeout(timeout);}
    }
    if(req.method!=='GET'&&req.method!=='HEAD')return json(res,405,{error:'Método não permitido.'});
    const requested=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const full=path.resolve(ROOT,requested);
    if(!full.startsWith(ROOT+path.sep))return json(res,403,{error:'Acesso negado.'});
    if(/(^|\/)\.|\.(env|lock|md)$|^(server\.js|package\.json)$/i.test(requested))return json(res,403,{error:'Acesso negado.'});
    try{const file=await fs.readFile(full);res.writeHead(200,{'Content-Type':TYPES[path.extname(full).toLowerCase()]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:file)}catch{return json(res,404,{error:'Arquivo não encontrado.'});}
  }catch{return json(res,500,{error:'Erro interno.'});}
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Agente Quant V3 ativo na porta ${PORT}`));
