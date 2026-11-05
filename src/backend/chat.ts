import { projectKnowledge } from './documents';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { randomUUID } from 'node:crypto';
import { directory, projectRoot, readJson, writeJson } from './data';
import { validProjectId, validTaskId } from '../shared/ids';
import { packHash, packHeader, validPack, isProvider, type Provider, type Pack, type TopicEvent } from '../shared/communication';

import { ClaudeRpc, ClaudeRejected, claudeStatus } from './claude';

type ChatRpc = Pick<Rpc,'request'|'init'|'onEvent'|'onClose'|'close'>;
type State = 'pending'|'streaming'|'completed'|'failed'|'interrupted'|'unknown';
type Message = {errorCode?:'MODEL_UNAVAILABLE';id:string;sendId:string;role:'user'|'assistant';content:string;provider:Provider;model:string|null;createdAt:string;updatedAt:string;status:State;threadId:string|null;sessionId:string|null};
type Conversation = {sessionProvider?:Provider;selectedModel:{id:string;name:string;provider?:Provider}|null;phase:TaskPhase|null;lastEventId:number;packs:Pack[];version:1;id:string;projectId:string;taskId:string|null;threadId:string|null;sessionId:string|null;messages:Message[]};
type Status = {installed:boolean;path:string|null;version:string|null;checkedAt:string;auth:'chatgpt'|'apiKey'|'other'|'none'|'unknown';models:{id:string;name:string}[]|null;usage:'unknown'};
const key = (p:string,t:string|null) => {if(!validProjectId(p)||(t!==null&&!validTaskId(t)))throw Error('Invalid chat scope');return JSON.stringify([p,t])};
const conversationKey = (p:string,t:string|null,phase:TaskPhase|null) => {key(p,t);if(t===null?phase!==null:!isTaskPhase(phase))throw Error('Invalid chat phase');return JSON.stringify([p,t,phase])};
export type TaskEventsProvider = {capture:(p:string,t:string)=>unknown;events:(p:string,t:string,after:number,through?:number,limit?:number)=>{events:unknown[];lastEventId:number;through:number;hasMore:boolean}};
const now = () => new Date().toISOString();

export class ModelUnavailable extends Error { constructor() { super('model unavailable'); } }
const modelRejected = (error:any) => ['model_not_found','model_not_supported','model_not_available','unsupported_model'].includes(error?.data?.code) || ['model_not_found','model_not_supported','model_not_available','unsupported_model'].includes(error?.code);
class Rejected extends Error { constructor(public modelUnavailable = false) { super('Request rejected'); } }
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
   if (typeof msg.id==='number') {const p=this.pending.get(msg.id);if(!p)return;this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Rejected(modelRejected(msg.error))):p.resolve(msg.result);return}
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
 private listeners=new Map<string,Set<(event:TopicEvent)=>void>>();
 subscribe(p:string,t:string|null,changed:(event:TopicEvent)=>void,phase:TaskPhase|null=t===null?null:'requirements'){const k=conversationKey(p,t,phase);let listeners=this.listeners.get(k);if(!listeners){listeners=new Set();this.listeners.set(k,listeners)}listeners.add(changed);return ()=>{listeners!.delete(changed);if(!listeners!.size)this.listeners.delete(k)}}
 private emit(c:Conversation,event:TopicEvent){for(const listener of this.listeners.get(conversationKey(c.projectId,c.taskId,c.phase))??[])listener(event)}
 private newPack(c:Conversation,m:Message,kind:'text'|'tool'='text'):Pack {const pack:Pack={packId:randomUUID(),sequence:(c.packs.at(-1)?.sequence??0)+1,messageId:m.id,sendId:m.sendId,role:m.role,kind,content:'',tool:null,...(m.provider==='claude'?{provider:m.provider}:{}),model:m.model,createdAt:now(),status:'streaming',state:'streaming'};c.packs.push(pack);return pack}
 private closePack(pack:Pack,status:State,events:TopicEvent[]){if(pack.state==='closed')return;pack.status=status;pack.state='closed';events.push({name:'chat.pack.closed',data:{packId:pack.packId,header:packHeader(pack)}})}
 private locks=new Map<string,Promise<unknown>>();
 private preparing=new Set<string>();
 private stopping=new Set<string>();
 private explicitStops=new Set<string>();
 private startRollbacks=new Map<string,()=>void>();
 private implementationFinished:(p:string,t:string)=>void=()=>{};
 setImplementationFinished(callback:(p:string,t:string)=>void){this.implementationFinished=callback}
 private finishImplementation(p:string,t:string){if(!this.explicitStops.has(key(p,t)))this.implementationFinished(p,t)}
 private taskEvents?:TaskEventsProvider;
 setTaskEvents(provider:TaskEventsProvider){this.taskEvents=provider}
 private busy(p:string,t:string|null){const k=key(p,t);return this.preparing.has(k)||[...this.active.keys()].some(value=>{const [project,task]=JSON.parse(value);return project===p&&task===t})}
 private active=new Map<string,{rpc:ChatRpc;threadId:string|null;turnId:string|null}>();
 withIdleTask<T>(p:string,t:string,change:()=>T):T{key(p,t);if(this.stopping.has(key(p,t))||this.busy(p,t)||[...this.locks.keys()].some(value=>{const [project,task]=JSON.parse(value);return project===p&&task===t}))throw Error('busy');return change();}
 async startTask<T>(p:string,t:string,change:()=>T,rollback:()=>void,model:string|null,cwd:string,documents:string,provider:Provider='codex'):Promise<T>{
  const task=this.withIdleTask(p,t,change),taskKey=key(p,t);
  this.stopping.add(taskKey);
  this.startRollbacks.set(taskKey,rollback);
  try {
   await this.send(p,t,'実装手順に従って、ゴールに到達するまで実装と検証を完走してください。未達や実行できなかった検証は終了時に明記してください。仕様整理の「仕様」にリンクされた仕様は、既存の文書と整合させてリポジトリの docs に配置してください。',model,cwd,documents,'implementation',true,provider);
   return task;
  }catch(error){this.startRollbacks.delete(taskKey);rollback();throw error}finally{this.stopping.delete(taskKey)}
 }
 async stopTask<T>(p:string,t:string,change:()=>T,validate:()=>void=()=>{}):Promise<T>{
  const taskKey=key(p,t);
  if(this.stopping.has(taskKey))throw Error('busy');
  this.stopping.add(taskKey);
  this.explicitStops.add(taskKey);
  try {
   validate();
   // 送信準備と turn/start の完了も待ち、停止中の新しい送信を拒否する。
   const deadline=Date.now()+30000;
   const interrupted=new Set<object>();
   while(this.busy(p,t)||[...this.locks.keys()].some(value=>{const [project,task]=JSON.parse(value);return project===p&&task===t})){
    if(Date.now()>deadline)throw Error('stop timeout');
    for(const [conversation,active] of this.active){
     const [project,task]=JSON.parse(conversation);
     if(project===p&&task===t&&active.threadId&&active.turnId&&!interrupted.has(active)){
      await active.rpc.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});
      interrupted.add(active);
     }
    }
    await Bun.sleep(10);
   }
   return change();
  } finally {this.stopping.delete(taskKey);this.explicitStops.delete(taskKey)}
 }
 async recoverImplementation(p:string,t:string){if(this.stopping.has(key(p,t))||this.busy(p,t))return;await this.get(p,t,'implementation');if(!this.busy(p,t))this.finishImplementation(p,t)}
 deleteTask(p:string,t:string,remove:()=>void){this.withIdleTask(p,t,remove)}
 private activity:(projectId:string,taskId:string)=>void=()=>{};
 constructor(private resolveProjectFolder:(projectId:string)=>string,private executable=()=>Bun.which('codex'),private claudeExecutable=()=>Bun.which('claude')) {}
 setTaskActivity(activity:(projectId:string,taskId:string)=>void){this.activity=activity}
 private async locked<T>(k:string,fn:()=>Promise<T>):Promise<T>{const prior=this.locks.get(k)??Promise.resolve();const job=prior.catch(()=>{}).then(fn);this.locks.set(k,job);try{return await job}finally{if(this.locks.get(k)===job)this.locks.delete(k)}}
 private path(p:string,t:string|null,phase:TaskPhase|null){conversationKey(p,t,phase);const root=directory(join(projectRoot(this.resolveProjectFolder(p)),'chat'));return t===null?join(root,'general.json'):join(directory(join(root,t)),`${phase}.json`)}
 private async save(c:Conversation,activity=false){writeJson(this.path(c.projectId,c.taskId,c.phase),c);if(activity&&c.taskId!==null)this.activity(c.projectId,c.taskId)}
 private validateHistory(value:unknown,p:string,t:string|null,phase:TaskPhase|null):Conversation {
  const c=value as Conversation;
  if(c.version!==1||c.projectId!==p||c.taskId!==t||!Array.isArray(c.messages)||(c.phase!==undefined&&c.phase!==phase)||(t!==null&&c.phase===undefined)||(c.lastEventId!==undefined&&(!Number.isSafeInteger(c.lastEventId)||c.lastEventId<0)))throw Error('Invalid history');
  c.phase=phase;c.lastEventId??=0;c.selectedModel??=null;if(c.selectedModel!==null&&(typeof c.selectedModel.id!=='string'||!c.selectedModel.id||typeof c.selectedModel.name!=='string'||(c.selectedModel.provider!==undefined&&!isProvider(c.selectedModel.provider))))throw Error('Invalid history');
  if((c.sessionProvider!==undefined&&!isProvider(c.sessionProvider))||c.messages.some(m=>!isProvider(m.provider)))throw Error('Invalid history');
  if(!Array.isArray(c.packs)||c.packs.some((pack,i)=>!validPack(pack)||pack.sequence!==i+1)||new Set(c.packs.map(pack=>pack.packId)).size!==c.packs.length)throw Error('Invalid history');
  return c;
 }
 private async load(p:string,t:string|null,phase:TaskPhase|null):Promise<Conversation>{
  const path=this.path(p,t,phase);
  try {const raw=readJson(path);const needsSave=raw.phase===undefined||raw.lastEventId===undefined;const c=this.validateHistory(raw,p,t,phase);if(needsSave)await this.save(c);return c}
  catch(e:any){if(e.code!=='ENOENT')throw e;return {selectedModel:null,version:1,id:randomUUID(),projectId:p,taskId:t,phase,lastEventId:0,threadId:null,sessionId:null,messages:[],packs:[]}}
 }
 async get(p:string,t:string|null,phase:TaskPhase|null=t===null?null:'requirements'){const k=conversationKey(p,t,phase);return this.locked(k,async()=>{const c=await this.load(p,t,phase);if(!this.active.has(k)){let changed=false;const events:TopicEvent[]=[];for(const m of c.messages)if(m.status==='pending'||m.status==='streaming'){m.status='unknown';m.updatedAt=now();changed=true}for(const pack of c.packs)if(pack.state==='streaming'){this.closePack(pack,pack.role==='user'?'completed':'unknown',events);changed=true}if(changed){await this.save(c);if(t!==null&&phase==='implementation')this.finishImplementation(p,t);for(const event of events)this.emit(c,event);this.emit(c,{name:'chat.changed',data:{}})}}return c})}

 async packs(p:string,t:string|null,after?:string,phase:TaskPhase|null=t===null?null:'requirements'){const c=await this.get(p,t,phase);const index=after===undefined?-1:c.packs.findIndex(pack=>pack.packId===after);if(after!==undefined&&index<0)throw Error('not found');return {packs:c.packs.slice(index+1).map(({packId,state})=>({packId,state}))}}
 async pack(p:string,t:string|null,id:string,phase:TaskPhase|null=t===null?null:'requirements'){const c=await this.get(p,t,phase);const pack=c.packs.find(pack=>pack.packId===id);if(!pack)throw Error('not found');if(pack.state!=='closed')throw Error('not closed');return {pack}}
 async ack(p:string,t:string|null,id:string,hash:string,phase:TaskPhase|null=t===null?null:'requirements'){const {pack}=await this.pack(p,t,id,phase);return await packHash(pack)===hash?{matched:true as const}:{matched:false as const,pack}}
 async claudeStatus(){return claudeStatus(this.claudeExecutable())}
 async status():Promise<Status>{const executable=this.executable();const status:Status={installed:!!executable,path:executable,version:null,checkedAt:now(),auth:'unknown',models:null,usage:'unknown'};if(!executable)return status;status.version=await new Promise(resolve=>execFile(executable,['--version'],{timeout:5000,maxBuffer:4096},(error,stdout)=>{const match=!error&&stdout.match(/^codex-cli\s+([\w.+-]+)/m);resolve(match?match[1]:null)}));const rpc=new Rpc(executable);try{await rpc.init();const result=await rpc.request('account/read',{refreshToken:false});status.auth=result.account?.type==='chatgpt'?'chatgpt':result.account?.type==='apiKey'?'apiKey':result.account?'other':'none';let cursor:string|null=null;const models:{id:string;name:string}[]=[];do{const page=await rpc.request('model/list',{cursor});for(const m of page.data??[])if(typeof m.model==='string')models.push({id:m.model,name:typeof m.displayName==='string'?m.displayName:m.model});cursor=page.nextCursor??null}while(cursor);status.models=models}catch{}finally{rpc.close()}return status}
 private async pendingTaskEvents(p:string,t:string,phase:TaskPhase|null){
  if(!this.taskEvents)return undefined;
  this.taskEvents.capture(p,t);
  const conversation=await this.load(p,t,phase);
  const first=this.taskEvents.events(p,t,conversation.lastEventId);
  const history={events:[...first.events],through:first.through};
  let page=first;
  while(page.hasMore){
   const after=page.lastEventId;
   page=this.taskEvents.events(p,t,after,first.through);
   if(page.lastEventId<=after)throw Error('Invalid history page');
   history.events.push(...page.events);
  }
  return history;
 }
 async send(p:string,t:string|null,content:string,model:string|null,cwd:string,documentDirectory?:string,phase:TaskPhase|null=t===null?null:'requirements',reserved=false,provider:Provider='codex'){
  if(!isProvider(provider))throw Error('Invalid provider');
  const taskKey=key(p,t);
  if((this.stopping.has(taskKey)&&!reserved)||this.busy(p,t))throw Error('busy');
  this.preparing.add(taskKey);
  try {
   const workingDirectory=documentDirectory&&(phase==='implementation'||phase==='retrospective')?cwd:documentDirectory??cwd;
   const k=conversationKey(p,t,phase);
   return await this.locked(k,async()=>{
    if(this.active.has(k))throw Error('busy');
    const history=t===null?undefined:await this.pendingTaskEvents(p,t,phase);
    const executable=provider==='claude'?this.claudeExecutable():this.executable();
    if(!executable)throw Error('unavailable');
    const status=provider==='claude'?await this.claudeStatus():await this.status();
    if(status.auth!==(provider==='claude'?'claude':'chatgpt'))throw Error('unavailable');
    const saved=await this.load(p,t,phase);
    const selected=saved.selectedModel;
    model=model??((selected?.provider??'codex')===provider?selected?.id:undefined)??status.models?.[0]?.id??null;
    const available=status.models?.find(item=>item.id===model);
    if(!available)throw new ModelUnavailable();
    let rpc:ChatRpc;
    if(provider==='claude'){
     rpc=new ClaudeRpc(executable);await rpc.init();
    }else{
     const probe=new Rpc(executable,true);let servers:string[];
     try{await probe.init();const config=(await probe.request('config/read',{cwd:workingDirectory})).config;servers=Object.keys(config.mcp_servers??{});if(!servers.every(name=>/^[A-Za-z0-9_-]+$/.test(name)))throw Error('unsafe configuration')}finally{probe.close()}
     rpc=new Rpc(executable,true,servers,!!documentDirectory);
     try{await rpc.init();const config=(await rpc.request('config/read',{cwd:workingDirectory})).config;if((config.model_provider!=null&&config.model_provider!=='openai')||Object.values(config.mcp_servers??{}).some((server:any)=>server?.enabled!==false)||config.features?.shell_tool!==!!documentDirectory||config.features?.apps!==false||config.features?.plugins!==false||config.features?.multi_agent!==false||config.features?.browser_use!==false||config.features?.computer_use!==false||config.features?.code_mode_host!==!!documentDirectory||config.features?.hooks!==false||config.features?.skill_mcp_dependency_install!==false||config.web_search!=='disabled')throw Error('unsafe configuration')}catch(error){rpc.close();throw error}
    }
    let c:Conversation;try{c=await this.load(p,t,phase)}catch(error){rpc.close();throw error}
    if((c.sessionProvider??'codex')!==provider){c.threadId=null;c.sessionId=null}
    // 接続先の変更後は、別 CLI のセッション ID を使わず保存済み本文を参考にする。
    const referenceHistory=!c.threadId?c.messages.filter(m=>m.content).map(m=>({role:m.role,content:m.content})):[];
    c.sessionProvider=provider;
    if(c.messages.some(m=>m.status==='pending'||m.status==='streaming')){for(const m of c.messages)if(m.status==='pending'||m.status==='streaming')m.status='unknown'}
    const recovery:TopicEvent[]=[];
    for(const pack of c.packs)if(pack.state==='streaming')this.closePack(pack,pack.role==='user'?'completed':'unknown',recovery);
    c.selectedModel={id:available.id,name:available.name,...(provider==='claude'?{provider}:{})};
    const sendId=randomUUID(),time=now();
    c.messages.push({id:randomUUID(),sendId,role:'user',content,provider,model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId},{id:randomUUID(),sendId,role:'assistant',content:'',provider,model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId});
    const user=c.messages.at(-2)!,userPack=this.newPack(c,user);userPack.content=user.content;userPack.state='closed';userPack.status='completed';
    try{await this.save(c,true)}catch(error){rpc.close();throw error}
    for(const event of recovery)this.emit(c,event);
    this.emit(c,{name:'chat.pack.closed',data:{packId:userPack.packId,header:packHeader(userPack)}});this.emit(c,{name:'chat.changed',data:{}});
    const active={rpc,threadId:c.threadId,turnId:null as string|null};this.active.set(k,active);
    void this.run(k,c,sendId,content,model,cwd,active,documentDirectory,phase,history,referenceHistory);
    return c;
   });
  }finally{this.preparing.delete(taskKey)}
 }
 private async run(k:string,c:Conversation,sendId:string,content:string,model:string|null,cwd:string,active:{rpc:ChatRpc;threadId:string|null;turnId:string|null},documentDirectory?:string,phase:TaskPhase|null=null,history?:{events:unknown[];through:number},referenceHistory:{role:'user'|'assistant';content:string}[]=[]){
  let dispatched=false,rejectedStart=false,finished=false,claudePending=c.sessionProvider==='claude',closedWhilePending=false;
  const previousSession={threadId:active.threadId,sessionId:c.sessionId};
  let releaseEvents=()=>{};
  // Claude は OS の起動ではなく CLI の受理を確認してからセッションとイベントを保存する。
  let eventQueue=claudePending?new Promise<void>(resolve=>{releaseEvents=resolve}):Promise.resolve();
  const itemPacks=new Map<string,string>();let textPackId:string|undefined;
  const update=async(fn:(messages:Message[],current:Conversation,events:TopicEvent[])=>void,changed=false)=>this.locked(k,async()=>{const current=await this.load(c.projectId,c.taskId,c.phase);const events:TopicEvent[]=[];fn(current.messages.filter(m=>m.sendId===sendId),current,events);current.sessionProvider=c.sessionProvider;current.threadId=active.threadId;current.sessionId=c.sessionId;for(const m of current.messages.filter(m=>m.sendId===sendId)){m.threadId=active.threadId;m.sessionId=c.sessionId}await this.save(current,events.length>0||changed);for(const event of events)this.emit(current,event);if(changed)this.emit(current,{name:'chat.changed',data:{}})});
  const finish=async(status:State,errorCode?:'MODEL_UNAVAILABLE')=>{if(finished)return;finished=true;try{await update((ms,current,events)=>{ms.forEach(m=>{m.status=status;m.updatedAt=now();if(errorCode&&m.role==='assistant')m.errorCode=errorCode});if(!current.packs.some(pack=>pack.sendId===sendId&&pack.role==='assistant')){const a=ms.find(m=>m.role==='assistant');if(a)this.newPack(current,a)}for(const pack of current.packs)if(pack.sendId===sendId)this.closePack(pack,status,events)},true)}finally{if(this.active.get(k)===active)this.active.delete(k);active.rpc.close();if(phase==='implementation'&&c.taskId!==null){const taskKey=key(c.projectId,c.taskId),rollback=this.startRollbacks.get(taskKey);this.startRollbacks.delete(taskKey);if((!dispatched||rejectedStart)&&rollback&&!this.explicitStops.has(taskKey))rollback();else this.finishImplementation(c.projectId,c.taskId)}}};
  const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','functionCallOutput','webSearch','imageView','imageGeneration']);
  const toolData=(item:any)=>{const name=item.type==='commandExecution'?'command':typeof item.tool==='string'?item.tool:typeof item.name==='string'?item.name:item.type;const input=item.command??item.arguments??item.changes??null;const output=item.aggregatedOutput??item.contentItems??item.output??item.result??item.error??null;const encode=(v:unknown)=>typeof v==='string'?v:JSON.stringify(v);return {name,input:encode(input),output:encode(output)}};
  active.rpc.onEvent=(method,params)=>{if(claudePending&&method==='turn/started'&&params?.threadId===active.threadId&&typeof params.turn?.id==='string')active.turnId=params.turn.id;eventQueue=eventQueue.then(async()=>{if(finished||params?.threadId!==active.threadId)return;if(method==='turn/started'&&typeof params.turn?.id==='string')active.turnId=params.turn.id;if(params.turnId&&active.turnId&&params.turnId!==active.turnId)return;
   if(method==='item/agentMessage/delta'&&typeof params.delta==='string'){
    const existing=(await this.load(c.projectId,c.taskId,c.phase)).packs.find(p=>p.packId===textPackId);if((existing?.content.length??0)+params.delta.length>1048576){await finish('failed');return}
    await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;let pack=current.packs.find(p=>p.packId===textPackId&&p.state==='streaming');if(!pack){pack=this.newPack(current,a);textPackId=pack.packId}if(typeof params.itemId==='string')itemPacks.set(params.itemId,pack.packId);pack.content+=params.delta;a.content+=params.delta;a.status='streaming';a.updatedAt=now();for(let start=0;start<params.delta.length;){let end=Math.min(start+4096,params.delta.length);const last=params.delta.charCodeAt(end-1);if(end<params.delta.length&&last>=0xd800&&last<=0xdbff)end--;const delta=params.delta.slice(start,end);events.push({name:'chat.pack.delta',data:{packId:pack.packId,delta,header:packHeader(pack)}});start=end}})
   }
   if((method==='item/started'||method==='item/completed')&&params.item&&typeof params.item.id==='string'){const item=params.item;if(toolTypes.has(item.type)){await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;const preceding=current.packs.find(p=>p.packId===textPackId);if(preceding)this.closePack(preceding,'completed',events);textPackId=undefined;let pack=current.packs.find(p=>p.packId===itemPacks.get(item.id));if(!pack){pack=this.newPack(current,a,'tool');itemPacks.set(item.id,pack.packId)}if(pack.state==='closed')return;const tool=toolData(item);if(JSON.stringify(tool).length>1048576)throw Error('Tool result too large');pack.tool=tool;pack.content=JSON.stringify(pack.tool);a.status='streaming';if(method==='item/completed')this.closePack(pack,item.status==='failed'?'failed':'completed',events)})}else if(item.type==='agentMessage'&&method==='item/completed'){if(typeof item.text==='string'&&item.text.length>1048576){await finish('failed');return}await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;let pack=current.packs.find(p=>p.packId===itemPacks.get(item.id));if(!pack){pack=this.newPack(current,a);itemPacks.set(item.id,pack.packId);pack.content=typeof item.text==='string'?item.text:'';a.content+=pack.content}if(pack.state==='closed')return;if(typeof item.text==='string'&&item.text!==pack.content){a.content=a.content.slice(0,Math.max(0,a.content.length-pack.content.length))+item.text;pack.content=item.text}this.closePack(pack,'completed',events);if(textPackId===pack.packId)textPackId=undefined})}}
   if(method==='turn/completed'&&(!active.turnId||params.turn?.id===active.turnId)){const state=params.turn?.status;await finish(state==='completed'?'completed':state==='interrupted'?'interrupted':state==='failed'?'failed':'unknown',modelRejected(params.turn?.error)?'MODEL_UNAVAILABLE':undefined)}
  }).catch(()=>{active.rpc.close()})};
  active.rpc.onClose=()=>{if(claudePending){closedWhilePending=true;return}if(!finished)void eventQueue.then(()=>finish(dispatched?'unknown':'failed')).catch(()=>{}).finally(()=>{if(this.active.get(k)===active)this.active.delete(k)})};
  const implementation = !!documentDirectory && phase === 'implementation';
  const retrospective=!!documentDirectory&&phase==='retrospective';
  const workingDirectory = implementation||retrospective ? cwd : documentDirectory ?? cwd;
  try {
   const knowledge=documentDirectory?projectKnowledge(cwd):undefined;
   const knowledgeContent=knowledge?readFileSync(knowledge,'utf8'):undefined;
   const implementationHistory=retrospective&&c.taskId!==null?this.path(c.projectId,c.taskId,'implementation'):undefined;
   const instructions = documentDirectory ? [
    `This is Beni task ${c.taskId}. Project reference directory: ${cwd}. Current phase: ${phase}.`,
    `Your working and writable directory is ${workingDirectory}. Task documents are in ${documentDirectory}.`,
    'Beni manages task.json, .history metadata, chat metadata, sessions and event cursors. Never modify these files directly. Files under .history/versions are read-only historical references.',
    'Read existing Markdown before changing it. Keep requirements.md updated from this task conversation, preserving user decisions, constraints and unresolved questions.',
    'Use documents.md as the specification organization index, with separate Japanese headings ## 資料 and ## 仕様 and relative Markdown links to additional task documents.',
    'Classify every additional document under exactly one heading: 資料 for research and alternatives kept within this task, or 仕様 for accepted behavior written for repository readers without conversation context.',
    'Use implementation-plan.md for implementation steps and verification, and English kebab-case .md filenames for additional task documents.',
    'The intended phase order is 要件定義, 仕様整理, 実装手順, 実装中, 反省会.',
    `Project knowledge content: ${JSON.stringify(knowledgeContent)}. Read project knowledge at ${knowledge} before preparation or implementation. During retrospective, append only confirmed reusable lessons there; distinguish hypotheses and preserve existing content.`,
    retrospective ? `Read the implementation conversation and terminal message statuses at ${implementationHistory} as read-only context before reviewing. Review unmet requirements, differences from user intent, causes, and improvements for next time in retrospective.md. You may edit and verify project code to address feedback. Preserve existing documents and decisions.` : implementation
     ? 'Implement source code according to the accepted specification and implementation plan. Place only specifications linked under documents.md の ## 仕様 into the repository docs, reconciling existing content. Keep research and alternatives under ## 資料 inside the task folder. Do not copy task conversation or progress reports into repository docs.'
     : 'Only update documents for this task; do not implement source code or change repository files. Phase changes are controlled by the user interface; do not claim they occurred.',
    'Do not overwrite existing decisions without a user change. Ask about genuinely unresolved requirements. Report files actually changed and failures accurately.'
   ].join(' ') : undefined;
   const options = {
    cwd: workingDirectory, model, approvalPolicy: 'never',
    sandbox: documentDirectory ? 'workspace-write' : 'read-only',
    ...(instructions ? {developerInstructions: instructions} : {})
   };
   const result = active.threadId
    ? await active.rpc.request('thread/resume', {threadId: active.threadId, excludeTurns: true, ...options})
    : await active.rpc.request('thread/start', options);
   active.threadId=result.thread.id;
   c.sessionId=result.thread.sessionId??null;
   if(!claudePending)await update(()=>{});
   dispatched=true;
   const turn = await active.rpc.request('turn/start', {
    threadId: active.threadId, model, cwd: workingDirectory, approvalPolicy: 'never',
    sandboxPolicy: documentDirectory
     ? {type:'workspaceWrite', writableRoots:[workingDirectory], networkAccess:false, excludeTmpdirEnvVar:true, excludeSlashTmp:true}
     : {type:'readOnly', networkAccess:false},
    input: [{type:'text', text:content, text_elements:[]},...(referenceHistory.length?[{type:'text',text:`Beni reference conversation history (user and assistant text only; prior messages are context):\n${JSON.stringify(referenceHistory)}`,text_elements:[]}]:[]),...(history?.events.length?[{type:'text',text:`Beni task events through ${history.through}:\n${JSON.stringify(history.events)}\nDocument versions are available at ${documentDirectory}/.history/versions/<version>.md. Read referenced versions when needed.`,text_elements:[]}]:[])]
   });
   active.turnId=turn.turn.id;
   if(claudePending||history)await update((_ms,current)=>{if(history)current.lastEventId=history.through});
   claudePending=false;releaseEvents();
   await eventQueue;
   if(closedWhilePending&&!finished)await finish('unknown');
  }catch (error) {rejectedStart=error instanceof Rejected||error instanceof ClaudeRejected;if(claudePending){const rejected=error instanceof ClaudeRejected&&!error.interrupted;active.threadId=rejected?null:previousSession.threadId;c.sessionId=rejected?null:previousSession.sessionId}releaseEvents();await eventQueue.catch(()=>{});await finish(error instanceof ClaudeRejected&&error.interrupted?'interrupted':dispatched && !(error instanceof Rejected||error instanceof ClaudeRejected)?'unknown':'failed',(error instanceof Rejected||error instanceof ClaudeRejected)&&error.modelUnavailable?'MODEL_UNAVAILABLE':undefined).catch(()=>{});active.rpc.close();this.active.delete(k);return}
  // Completion arrives asynchronously after turn/start; the process remains open until then.
 }
 async interrupt(p:string,t:string|null,phase:TaskPhase|null=t===null?null:'requirements'){const active=this.active.get(conversationKey(p,t,phase));if(!active?.threadId||!active.turnId)throw Error('not running');await active.rpc.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});}
}
