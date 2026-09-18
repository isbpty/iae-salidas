import { createHmac, timingSafeEqual } from 'node:crypto';
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
export function sessionToken(userId,secret,ttlSeconds=8*3600){const payload=encode({userId,exp:Math.floor(Date.now()/1000)+ttlSeconds});const sig=createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${sig}`}
export function verifySession(token,secret){try{const [payload,sig]=String(token||'').split('.');const expected=createHmac('sha256',secret).update(payload).digest('base64url');if(!sig||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;const value=JSON.parse(Buffer.from(payload,'base64url'));return value.exp>Math.floor(Date.now()/1000)?value:null}catch{return null}}
export function cookieValue(header,name){for(const part of String(header||'').split(';')){const [key,...rest]=part.trim().split('=');if(key===name)return decodeURIComponent(rest.join('='))}return null}
