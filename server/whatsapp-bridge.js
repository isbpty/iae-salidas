import { EventEmitter } from 'node:events';
export class WhatsAppBridge extends EventEmitter {
 constructor({mode='simulator',sessionPath='/data/whatsapp-session'}={}){super();this.mode=mode;this.sessionPath=sessionPath;this.client=null}
 async start(){if(this.mode!=='qr-web')return{status:'simulator'};let mod;try{mod=await import('whatsapp-web.js')}catch{throw Object.assign(new Error('whatsapp_qr_driver_not_installed'),{code:'DRIVER_MISSING'})}const{Client,LocalAuth}=mod;this.client=new Client({authStrategy:new LocalAuth({dataPath:this.sessionPath}),puppeteer:{headless:true,args:['--no-sandbox','--disable-setuid-sandbox']}});this.client.on('qr',qr=>this.emit('qr',qr));this.client.on('ready',()=>this.emit('ready'));this.client.on('disconnected',reason=>this.emit('disconnected',reason));this.client.on('message',message=>this.emit('message',{id:message.id?._serialized,from:message.from,text:message.body,at:Date.now()}));await this.client.initialize();return{status:'starting'}}
 async send(to,text){if(!this.client)throw new Error('whatsapp_not_connected');return this.client.sendMessage(to,text)}
 async stop(){if(this.client){await this.client.destroy();this.client=null}}
}
