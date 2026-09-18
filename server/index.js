import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { connectedSeed } from './seed.js';
import { checkout, createRequest, decideRequest } from './domain.js';
import { simulateInbound } from './simulator.js';
import { cookieValue, sessionToken, verifySession } from './session.js';
import { qrAction } from './qr-worker.js';
import { retryDelivery } from './delivery.js';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const store=new Store(process.env.DATA_FILE||join(ROOT,'data','pilot.json'));await store.load(connectedSeed());
const secret=process.env.SESSION_SECRET||'development-only-change-me';const pilotPin=process.env.PILOT_PIN||'2468';
const clients=new Set();const publish=payload=>{const line=`data: ${JSON.stringify(payload)}\n\n`;for(const res of clients)res.write(line)};
const json=(res,status,value,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});res.end(JSON.stringify(value))};
const body=async req=>{let raw='';for await(const c of req){raw+=c;if(raw.length>1e6)throw Object.assign(new Error('too_large'),{status:413})}return raw?JSON.parse(raw):{}};
const actor=req=>{const session=verifySession(cookieValue(req.headers.cookie,'iae_session'),secret);return session?store.state.users.find(x=>x.id===session.userId):null};
const safeState=(state,user)=>({school:state.school,currentUser:{id:user.id,name:user.name,role:user.role},students:state.students,authorizedPickups:state.authorizedPickups,requests:state.requests,notifications:state.notifications.filter(n=>user.role==='admin'||n.userId===user.id),audit:['admin','reception'].includes(user.role)?state.audit:[],deliveryAttempts:['admin','reception'].includes(user.role)?state.deliveryAttempts:[],transports:state.transports});
async function api(req,res,url){
 if(url.pathname==='/api/health')return json(res,200,{ok:true,mode:'connected-pilot',transport:store.state.transports});
 if(url.pathname==='/api/auth/options')return json(res,200,store.state.users.map(({phone,studentIds,...u})=>u));
 if(url.pathname==='/api/auth/login'&&req.method==='POST'){const input=await body(req);const user=store.state.users.find(x=>x.id===input.userId);if(!user||String(input.pin)!==pilotPin)return json(res,401,{error:'invalid_credentials'});return json(res,200,{user:{id:user.id,name:user.name,role:user.role}},{'set-cookie':`iae_session=${sessionToken(user.id,secret)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`})}
 if(url.pathname==='/api/auth/logout'&&req.method==='POST')return json(res,200,{ok:true},{'set-cookie':'iae_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
 const user=actor(req);if(!user)return json(res,401,{error:'authentication_required'});
 if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,safeState(store.state,user));
 if(url.pathname==='/api/events'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});res.write(`data: ${JSON.stringify({type:'connected'})}\n\n`);clients.add(res);req.on('close',()=>clients.delete(res));return}
 let result;
 if(url.pathname==='/api/requests'&&req.method==='POST'){const input=await body(req);result=await store.mutate(s=>createRequest(s,user,input))}
 else if(/^\/api\/requests\/[^/]+\/decision$/.test(url.pathname)&&req.method==='POST'){const input=await body(req);result=await store.mutate(s=>decideRequest(s,user,url.pathname.split('/')[3],input))}
 else if(/^\/api\/requests\/[^/]+\/checkout$/.test(url.pathname)&&req.method==='POST'){const input=await body(req);result=await store.mutate(s=>checkout(s,user,url.pathname.split('/')[3],input.code))}
 else if(url.pathname==='/api/simulator/messages'&&req.method==='POST'){const input=await body(req);result=await store.mutate(s=>simulateInbound(s,user,input.text||''))}
 else if(url.pathname==='/api/admin/whatsapp-qr'&&req.method==='POST'){const input=await body(req);result=await store.mutate(s=>qrAction(s,user,input.action))}
 else if(/^\/api\/deliveries\/[^/]+\/retry$/.test(url.pathname)&&req.method==='POST')result=await store.mutate(s=>retryDelivery(s,user,url.pathname.split('/')[3]));
 else return json(res,404,{error:'not_found'});publish({type:'state.changed',actorId:user.id});return json(res,200,result)
}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/api/'))return await api(req,res,url);const rel=url.pathname==='/'?'index.html':url.pathname.slice(1);const file=join(ROOT,normalize(rel));if(!file.startsWith(ROOT))return json(res,403,{error:'forbidden'});const data=await readFile(file);res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream'});res.end(data)}catch(e){json(res,e.status||500,{error:e.message})}}).listen(Number(process.env.PORT||3000),()=>console.log(`IAE connected pilot on http://localhost:${process.env.PORT||3000}`));
