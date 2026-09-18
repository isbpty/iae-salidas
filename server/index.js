import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { connectedSeed } from './seed.js';
import { checkout, createRequest, decideRequest } from './domain.js';
import { simulateInbound } from './simulator.js';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const store = new Store(process.env.DATA_FILE || join(ROOT, 'data', 'pilot.json'));
await store.load(connectedSeed());
const clients = new Set();
const publish = payload => { const line = `data: ${JSON.stringify(payload)}\n\n`; for (const res of clients) res.write(line); };
const json = (res, status, value) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify(value)); };
const body = async req => { let raw=''; for await (const c of req) { raw += c; if (raw.length > 1e6) throw Object.assign(new Error('too_large'),{status:413}); } return raw ? JSON.parse(raw) : {}; };
const actor = req => store.state.users.find(x => x.id === req.headers['x-demo-user']);
const safeState = (state, user) => ({ school:state.school, users:state.users.map(({phone,...u})=>u), students:state.students, authorizedPickups:state.authorizedPickups, requests:state.requests, notifications:state.notifications.filter(n=> user?.role === 'admin' || n.userId === user?.id), audit:['admin','reception'].includes(user?.role) ? state.audit : [], transports:state.transports });
const api = async (req,res,url) => {
  if (url.pathname === '/api/health') return json(res,200,{ok:true,mode:'connected-pilot',transport:store.state.transports});
  if (url.pathname === '/api/demo/users') return json(res,200,store.state.users.map(({phone,...x})=>x));
  const user=actor(req); if (!user) return json(res,401,{error:'Set x-demo-user to a pilot user id.'});
  if (url.pathname === '/api/state' && req.method === 'GET') return json(res,200,safeState(store.state,user));
  if (url.pathname === '/api/events' && req.method === 'GET') { res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'}); res.write(`data: ${JSON.stringify({type:'connected'})}\n\n`); clients.add(res); req.on('close',()=>clients.delete(res)); return; }
  let result;
  if (url.pathname === '/api/requests' && req.method === 'POST') { const input=await body(req); result=await store.mutate(s=>createRequest(s,user,input)); }
  else if (/^\/api\/requests\/[^/]+\/decision$/.test(url.pathname) && req.method === 'POST') { const id=url.pathname.split('/')[3]; const input=await body(req); result=await store.mutate(s=>decideRequest(s,user,id,input)); }
  else if (/^\/api\/requests\/[^/]+\/checkout$/.test(url.pathname) && req.method === 'POST') { const id=url.pathname.split('/')[3]; const input=await body(req); result=await store.mutate(s=>checkout(s,user,id,input.code)); }
  else if (url.pathname === '/api/simulator/messages' && req.method === 'POST') { const input=await body(req); result=await store.mutate(s=>simulateInbound(s,user,input.text||'')); }
  else return json(res,404,{error:'not_found'});
  publish({type:'state.changed',actorId:user.id}); return json(res,200,result);
};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer(async(req,res)=>{ try { const url=new URL(req.url,'http://localhost'); if(url.pathname.startsWith('/api/')) return await api(req,res,url); const rel=url.pathname==='/'?'pilot.html':url.pathname.slice(1); const file=join(ROOT,normalize(rel)); if(!file.startsWith(ROOT)) return json(res,403,{error:'forbidden'}); const data=await readFile(file); res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'}); res.end(data); } catch(e) { json(res,e.status||500,{error:e.message}); } });
server.listen(Number(process.env.PORT||3000),()=>console.log(`IAE connected pilot on http://localhost:${process.env.PORT||3000}`));
