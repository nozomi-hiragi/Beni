import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

type State = 'pending'|'streaming'|'completed'|'failed'|'interrupted'|'unknown';
type Message = {id:string;sendId:string;role:'user'|'assistant';content:string;provider:'codex';model:string|null;createdAt:string;updatedAt:string;status:State;threadId:string|null;sessionId:string|null};
type Conversation = {version:1;id:string;projectId:number;taskId:number|null;threadId:string|null;sessionId:string|null;messages:Message[]};
type Status = {installed:boolean;path:string|null;version:string|null;checkedAt:string;auth:'chatgpt'|'apiKey'|'other'|'none'|'unknown';models:{id:string;name:string}[]|null;usage:'unknown'};
const key = (p:number,t:number|null) => `${p}-${t === null ? 'general' : t}`;
const now = () => new Date().toISOString();

class Rejected extends Error {}
class Rpc {
 private child:ChildProcessWithoutNullStreams;
 private next=0;
 private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 onEvent:(method:string,params:any)=>void = () => {};
 onClose:()=>void = () => {};
 constructor(executable:string, restricted=false, servers:string[]=[], writable=false) {
  const args=restricted?['-c','forced_login_method="chatgpt"',writable?'--enable':'--disable','shell_tool','--disable','apps','--disable','plugins','--disable','multi_agent','--disable','browser_use','--disable','computer_use',writable?'--enable':'--disable','code_mode_host','--disable','hooks','--disable','skill_mcp_dependency_install','-c','web_search="disabled"',...servers.flatMap(name=>['-c',`mcp_servers.${name}.enabled=false`]),'app-server']:['app-server'];
  this.child=spawn(executable,args,{stdio:['pipe','pipe','pipe']});
  this.child.stderr.resume();
  createInterface({input:this.child.stdout}).on('line',line=>{
   let msg:any; try {msg=JSON.parse(line)} catch {return}
   if ((typeof msg.id==='number'||typeof msg.id==='string') && typeof msg.method==='string') {
    // Refuse server-initiated requests rather than granting capabilities.
    this.child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Unsupported request'}})+'\n'); return;
   }
   if (typeof msg.id==='number') {const p=this.pending.get(msg.id);if(!p)return;this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Rejected('Request rejected')):p.resolve(msg.result);return}
   if(typeof msg.method==='string')this.onEvent(msg.method,msg.params);
  });
  const close=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Connection closed'))}this.pending.clear();this.onClose()};
  this.child.once('error',close);this.child.once('exit',close);
 }
 request(method:string,params:any,timeout=15000):Promise<any>{return new Promise((resolve,reject)=>{const id=++this.next;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Request timed out'))},timeout);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(Error('Connection closed'))}})})}
 notify(method:string,params:any){this.child.stdin.write(JSON.stringify({method,params})+'\n')}
 async init(){await this.request('initialize',{clientInfo:{name:'beni',title:'Beni',version:'0.2.0'}});this.notify('initialized',{})}
 close(){this.child.kill()}
}

export class ChatService {
 private listeners=new Map<string,Set<()=>void>>();
 subscribe(p:number,t:number|null,changed:()=>void){const k=key(p,t);let listeners=this.listeners.get(k);if(!listeners){listeners=new Set();this.listeners.set(k,listeners)}listeners.add(changed);return ()=>{listeners!.delete(changed);if(!listeners!.size)this.listeners.delete(k)}}
 private locks=new Map<string,Promise<unknown>>();
 private active=new Map<string,{rpc:Rpc;threadId:string|null;turnId:string|null}>();
 constructor(private directory:string,private executable=()=>Bun.which('codex')) {}
 private async locked<T>(k:string,fn:()=>Promise<T>):Promise<T>{const prior=this.locks.get(k)??Promise.resolve();const job=prior.catch(()=>{}).then(fn);this.locks.set(k,job);try{return await job}finally{if(this.locks.get(k)===job)this.locks.delete(k)}}
 private path(p:number,t:number|null){return join(this.directory,`${key(p,t)}.json`)}
 private async save(c:Conversation){await mkdir(this.directory,{recursive:true,mode:0o700});const path=this.path(c.projectId,c.taskId),tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(c,null,2)+'\n',{mode:0o600});await rename(tmp,path);for(const listener of this.listeners.get(key(c.projectId,c.taskId))??[])listener()}
 private async load(p:number,t:number|null):Promise<Conversation>{try {const c=JSON.parse(await readFile(this.path(p,t),'utf8')) as Conversation;if(c.version!==1||c.projectId!==p||c.taskId!==t||!Array.isArray(c.messages))throw Error('Invalid history');return c}catch(e:any){if(e.code!=='ENOENT')throw e;return {version:1,id:randomUUID(),projectId:p,taskId:t,threadId:null,sessionId:null,messages:[]}}}
 async get(p:number,t:number|null){const k=key(p,t);return this.locked(k,async()=>{const c=await this.load(p,t);if(!this.active.has(k)){let changed=false;for(const m of c.messages)if(m.status==='pending'||m.status==='streaming'){m.status='unknown';m.updatedAt=now();changed=true}if(changed)await this.save(c)}return c})}
 async status():Promise<Status>{const executable=this.executable();const status:Status={installed:!!executable,path:executable,version:null,checkedAt:now(),auth:'unknown',models:null,usage:'unknown'};if(!executable)return status;status.version=await new Promise(resolve=>execFile(executable,['--version'],{timeout:5000,maxBuffer:4096},(error,stdout)=>{const match=!error&&stdout.match(/^codex-cli\s+([\w.+-]+)/m);resolve(match?match[1]:null)}));const rpc=new Rpc(executable);try{await rpc.init();const result=await rpc.request('account/read',{refreshToken:false});status.auth=result.account?.type==='chatgpt'?'chatgpt':result.account?.type==='apiKey'?'apiKey':result.account?'other':'none';let cursor:string|null=null;const models:{id:string;name:string}[]=[];do{const page=await rpc.request('model/list',{cursor});for(const m of page.data??[])if(typeof m.model==='string')models.push({id:m.model,name:typeof m.displayName==='string'?m.displayName:m.model});cursor=page.nextCursor??null}while(cursor);status.models=models}catch{}finally{rpc.close()}return status}
 async send(p:number,t:number|null,content:string,model:string|null,cwd:string,documentDirectory?:string){const k=key(p,t);return this.locked(k,async()=>{if(this.active.has(k))throw Error('busy');const executable=this.executable();if(!executable)throw Error('unavailable');const status=await this.status();if(status.auth!=='chatgpt')throw Error('unavailable');const probe=new Rpc(executable,true);let servers:string[];try{await probe.init();const config=(await probe.request('config/read',{cwd:documentDirectory??cwd})).config;servers=Object.keys(config.mcp_servers??{});if(!servers.every(name=>/^[A-Za-z0-9_-]+$/.test(name)))throw Error('unsafe configuration')}finally{probe.close()}const rpc=new Rpc(executable,true,servers,!!documentDirectory);try{await rpc.init();const config=(await rpc.request('config/read',{cwd:documentDirectory??cwd})).config;if((config.model_provider!=null&&config.model_provider!=='openai')||Object.values(config.mcp_servers??{}).some((server:any)=>server?.enabled!==false)||config.features?.shell_tool!==!!documentDirectory||config.features?.apps!==false||config.features?.plugins!==false||config.features?.multi_agent!==false||config.features?.browser_use!==false||config.features?.computer_use!==false||config.features?.code_mode_host!==!!documentDirectory||config.features?.hooks!==false||config.features?.skill_mcp_dependency_install!==false||config.web_search!=='disabled')throw Error('unsafe configuration')}catch(error){rpc.close();throw error}let c:Conversation;try{c=await this.load(p,t)}catch(error){rpc.close();throw error}if(c.messages.some(m=>m.status==='pending'||m.status==='streaming')){for(const m of c.messages)if(m.status==='pending'||m.status==='streaming')m.status='unknown'}const sendId=randomUUID(),time=now();c.messages.push({id:randomUUID(),sendId,role:'user',content,provider:'codex',model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId},{id:randomUUID(),sendId,role:'assistant',content:'',provider:'codex',model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId});try{await this.save(c)}catch(error){rpc.close();throw error}const active={rpc,threadId:c.threadId,turnId:null as string|null};this.active.set(k,active);void this.run(k,c,sendId,content,model,cwd,active,documentDirectory);return c})}
 private async run(k:string,c:Conversation,sendId:string,content:string,model:string|null,cwd:string,active:{rpc:Rpc;threadId:string|null;turnId:string|null},documentDirectory?:string){
  let dispatched=false,finished=false;let eventQueue=Promise.resolve();
  const update=async(fn:(messages:Message[])=>void)=>this.locked(k,async()=>{const current=await this.load(c.projectId,c.taskId);fn(current.messages.filter(m=>m.sendId===sendId));current.threadId=active.threadId;current.sessionId=c.sessionId;for(const m of current.messages.filter(m=>m.sendId===sendId)){m.threadId=active.threadId;m.sessionId=c.sessionId}await this.save(current)});
  const finish=async(status:State)=>{if(finished)return;finished=true;try{await update(ms=>ms.forEach(m=>{m.status=status;m.updatedAt=now()}))}finally{if(this.active.get(k)===active)this.active.delete(k);active.rpc.close()}};
  active.rpc.onEvent=(method,params)=>{eventQueue=eventQueue.then(async()=>{if(finished||params?.threadId!==active.threadId)return;if(method==='turn/started'&&typeof params.turn?.id==='string')active.turnId=params.turn.id;if(method==='item/agentMessage/delta'&&typeof params.delta==='string'){if(active.turnId&&params.turnId!==active.turnId)return;await update(ms=>{const a=ms.find(m=>m.role==='assistant');if(a){a.content+=params.delta;a.status='streaming';a.updatedAt=now()}})}if(method==='turn/completed'&&(!active.turnId||params.turn?.id===active.turnId)){const state=params.turn?.status;await finish(state==='completed'?'completed':state==='interrupted'?'interrupted':state==='failed'?'failed':'unknown')}}).catch(()=>{active.rpc.close()})};
  active.rpc.onClose=()=>{if(!finished)void eventQueue.then(()=>finish(dispatched?'unknown':'failed')).catch(()=>{}).finally(()=>{if(this.active.get(k)===active)this.active.delete(k)})};
  try {const instructions=documentDirectory ? `This is Beni task ${c.taskId}. Project reference directory: ${cwd}. Your working and writable directory is ${documentDirectory}. Read existing Markdown before changing it. Keep requirements.md updated from this task conversation, preserving user decisions, constraints and unresolved questions. Use implementation-plan.md for implementation plans, and English kebab-case .md filenames for additional task documents. Only update documents for this task; do not implement source code or change other tasks. Do not overwrite existing decisions without a user change. Ask about genuinely unresolved requirements. Report files actually changed and failures accurately.` : undefined;const options={cwd:documentDirectory??cwd,model,approvalPolicy:'never',sandbox:documentDirectory?'workspace-write':'read-only',...(instructions?{developerInstructions:instructions}:{} )};const result=active.threadId?await active.rpc.request('thread/resume',{threadId:active.threadId,excludeTurns:true,...options}):await active.rpc.request('thread/start',options);active.threadId=result.thread.id;c.sessionId=result.thread.sessionId??null;await update(()=>{});dispatched=true;const turn=await active.rpc.request('turn/start',{threadId:active.threadId,model,cwd:documentDirectory??cwd,approvalPolicy:'never',sandboxPolicy:documentDirectory?{type:'workspaceWrite',writableRoots:[documentDirectory],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false},input:[{type:'text',text:content,text_elements:[]}]});active.turnId=turn.turn.id;await eventQueue;}catch (error) {await eventQueue.catch(()=>{});await finish(dispatched && !(error instanceof Rejected)?'unknown':'failed').catch(()=>{});active.rpc.close();this.active.delete(k);return}
  // Completion arrives asynchronously after turn/start; the process remains open until then.
 }
 async interrupt(p:number,t:number|null){const active=this.active.get(key(p,t));if(!active?.threadId||!active.turnId)throw Error('not running');await active.rpc.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});}
}
