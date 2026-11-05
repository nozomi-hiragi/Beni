import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { randomUUID } from 'node:crypto';
import { directory, projectRoot, readJson, writeJson, pathExists } from './data';
import { validProjectId, validTaskId } from '../shared/ids';
import { packHash, packHeader, validPack, type Pack, type TopicEvent } from '../shared/communication';

type State = 'pending'|'streaming'|'completed'|'failed'|'interrupted'|'unknown';
type Message = {id:string;sendId:string;role:'user'|'assistant';content:string;provider:'codex';model:string|null;createdAt:string;updatedAt:string;status:State;threadId:string|null;sessionId:string|null};
type Conversation = {phase:TaskPhase|null;lastEventId:number;packs:Pack[];version:1;id:string;projectId:string;taskId:string|null;threadId:string|null;sessionId:string|null;messages:Message[]};
type Status = {installed:boolean;path:string|null;version:string|null;checkedAt:string;auth:'chatgpt'|'apiKey'|'other'|'none'|'unknown';models:{id:string;name:string}[]|null;usage:'unknown'};
const key = (p:string,t:string|null) => {if(!validProjectId(p)||(t!==null&&!validTaskId(t)))throw Error('Invalid chat scope');return JSON.stringify([p,t])};
const conversationKey = (p:string,t:string|null,phase:TaskPhase|null) => {key(p,t);if(t===null?phase!==null:!isTaskPhase(phase))throw Error('Invalid chat phase');return JSON.stringify([p,t,phase])};
export type TaskEventsProvider = {capture:(p:string,t:string)=>unknown;events:(p:string,t:string,after:number,through?:number,limit?:number)=>{events:unknown[];lastEventId:number;through:number;hasMore:boolean}};
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
 private listeners=new Map<string,Set<(event:TopicEvent)=>void>>();
 subscribe(p:string,t:string|null,changed:(event:TopicEvent)=>void,phase:TaskPhase|null=t===null?null:'requirements'){const k=conversationKey(p,t,phase);let listeners=this.listeners.get(k);if(!listeners){listeners=new Set();this.listeners.set(k,listeners)}listeners.add(changed);return ()=>{listeners!.delete(changed);if(!listeners!.size)this.listeners.delete(k)}}
 private emit(c:Conversation,event:TopicEvent){for(const listener of this.listeners.get(conversationKey(c.projectId,c.taskId,c.phase))??[])listener(event)}
 private newPack(c:Conversation,m:Message,kind:'text'|'tool'='text'):Pack {const pack:Pack={packId:randomUUID(),sequence:(c.packs.at(-1)?.sequence??0)+1,messageId:m.id,sendId:m.sendId,role:m.role,kind,content:'',tool:null,model:m.model,createdAt:now(),status:'streaming',state:'streaming'};c.packs.push(pack);return pack}
 private closePack(pack:Pack,status:State,events:TopicEvent[]){if(pack.state==='closed')return;pack.status=status;pack.state='closed';events.push({name:'chat.pack.closed',data:{packId:pack.packId,header:packHeader(pack)}})}
 private locks=new Map<string,Promise<unknown>>();
 private preparing=new Set<string>();
 private taskEvents?:TaskEventsProvider;
 setTaskEvents(provider:TaskEventsProvider){this.taskEvents=provider}
 private busy(p:string,t:string|null){const k=key(p,t);return this.preparing.has(k)||[...this.active.keys()].some(value=>{const [project,task]=JSON.parse(value);return project===p&&task===t})}
 private active=new Map<string,{rpc:Rpc;threadId:string|null;turnId:string|null}>();
 withIdleTask<T>(p:string,t:string,change:()=>T):T{key(p,t);if(this.busy(p,t)||[...this.locks.keys()].some(value=>{const [project,task]=JSON.parse(value);return project===p&&task===t}))throw Error('busy');return change();}
 deleteTask(p:string,t:string,remove:()=>void){this.withIdleTask(p,t,remove)}
 private activity:(projectId:string,taskId:string)=>void=()=>{};
 constructor(private resolveProjectFolder:(projectId:string)=>string,private executable=()=>Bun.which('codex')) {}
 setTaskActivity(activity:(projectId:string,taskId:string)=>void){this.activity=activity}
 private async locked<T>(k:string,fn:()=>Promise<T>):Promise<T>{const prior=this.locks.get(k)??Promise.resolve();const job=prior.catch(()=>{}).then(fn);this.locks.set(k,job);try{return await job}finally{if(this.locks.get(k)===job)this.locks.delete(k)}}
 private path(p:string,t:string|null,phase:TaskPhase|null){conversationKey(p,t,phase);const root=directory(join(projectRoot(this.resolveProjectFolder(p)),'chat'));return t===null?join(root,'general.json'):join(directory(join(root,t)),`${phase}.json`)}
 private async save(c:Conversation,activity=false){writeJson(this.path(c.projectId,c.taskId,c.phase),c);if(activity&&c.taskId!==null)this.activity(c.projectId,c.taskId)}
 private validateHistory(value:unknown,p:string,t:string|null,phase:TaskPhase|null,legacy=false):Conversation {
  const c=value as Conversation;
  if(c.version!==1||c.projectId!==p||c.taskId!==t||!Array.isArray(c.messages)||(c.phase!==undefined&&c.phase!==phase)||(!legacy&&t!==null&&c.phase===undefined)||(c.lastEventId!==undefined&&(!Number.isSafeInteger(c.lastEventId)||c.lastEventId<0)))throw Error('Invalid history');
  c.phase=phase;c.lastEventId??=0;
  if(c.packs===undefined)c.packs=c.messages.map((m,i)=>({packId:m.id+':legacy',sequence:i+1,messageId:m.id,sendId:m.sendId,role:m.role,kind:'text',content:m.content,tool:null,model:m.model,createdAt:m.createdAt,status:m.role==='user'?'completed':m.status,state:m.status==='pending'||m.status==='streaming'?'streaming':'closed'}));
  if(!Array.isArray(c.packs)||c.packs.some((pack,i)=>!validPack(pack)||pack.sequence!==i+1)||new Set(c.packs.map(pack=>pack.packId)).size!==c.packs.length)throw Error('Invalid history');
  return c;
 }
 private async load(p:string,t:string|null,phase:TaskPhase|null):Promise<Conversation>{
  const path=this.path(p,t,phase);
  if(t!==null){
   const destination=this.path(p,t,'requirements');
   const old=join(projectRoot(this.resolveProjectFolder(p)),'chat',`${t}.json`);
   if(pathExists(old)){
    const migrated=this.validateHistory(readJson(old),p,t,'requirements',true);
    if(pathExists(destination)){if(!isDeepStrictEqual(this.validateHistory(readJson(destination),p,t,'requirements'),migrated))throw Error('Chat migration conflict')}
    else writeJson(destination,migrated);
    // 両方の検証と保存を終えてから旧ファイルを除去する。失敗時は次回照合する。
    if(!isDeepStrictEqual(this.validateHistory(readJson(destination),p,t,'requirements'),migrated))throw Error('Chat migration conflict');
    rmSync(old);
   }
  }
  try {const raw=readJson(path);const needsSave=raw.packs===undefined||raw.phase===undefined||raw.lastEventId===undefined;const c=this.validateHistory(raw,p,t,phase,t===null);if(needsSave)await this.save(c);return c}
  catch(e:any){if(e.code!=='ENOENT')throw e;return {version:1,id:randomUUID(),projectId:p,taskId:t,phase,lastEventId:0,threadId:null,sessionId:null,messages:[],packs:[]}}
 }
 async get(p:string,t:string|null,phase:TaskPhase|null=t===null?null:'requirements'){const k=conversationKey(p,t,phase);return this.locked(k,async()=>{const c=await this.load(p,t,phase);if(!this.active.has(k)){let changed=false;const events:TopicEvent[]=[];for(const m of c.messages)if(m.status==='pending'||m.status==='streaming'){m.status='unknown';m.updatedAt=now();changed=true}for(const pack of c.packs)if(pack.state==='streaming'){this.closePack(pack,pack.role==='user'?'completed':'unknown',events);changed=true}if(changed){await this.save(c);for(const event of events)this.emit(c,event);this.emit(c,{name:'chat.changed',data:{}})}}return c})}
 async packs(p:string,t:string|null,after?:string,phase:TaskPhase|null=t===null?null:'requirements'){const c=await this.get(p,t,phase);const index=after===undefined?-1:c.packs.findIndex(pack=>pack.packId===after);if(after!==undefined&&index<0)throw Error('not found');return {packs:c.packs.slice(index+1).map(({packId,state})=>({packId,state}))}}
 async pack(p:string,t:string|null,id:string,phase:TaskPhase|null=t===null?null:'requirements'){const c=await this.get(p,t,phase);const pack=c.packs.find(pack=>pack.packId===id);if(!pack)throw Error('not found');if(pack.state!=='closed')throw Error('not closed');return {pack}}
 async ack(p:string,t:string|null,id:string,hash:string,phase:TaskPhase|null=t===null?null:'requirements'){const {pack}=await this.pack(p,t,id,phase);return await packHash(pack)===hash?{matched:true as const}:{matched:false as const,pack}}
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
 async send(p:string,t:string|null,content:string,model:string|null,cwd:string,documentDirectory?:string,phase:TaskPhase|null=t===null?null:'requirements'){
  const taskKey=key(p,t);
  if(this.busy(p,t))throw Error('busy');
  this.preparing.add(taskKey);
  try{const workingDirectory=documentDirectory&&phase==='implementation'?cwd:documentDirectory??cwd;const k=conversationKey(p,t,phase);return await this.locked(k,async()=>{if(this.active.has(k))throw Error('busy');const history=t===null?undefined:await this.pendingTaskEvents(p,t,phase);const executable=this.executable();if(!executable)throw Error('unavailable');const status=await this.status();if(status.auth!=='chatgpt')throw Error('unavailable');const probe=new Rpc(executable,true);let servers:string[];try{await probe.init();const config=(await probe.request('config/read',{cwd:workingDirectory})).config;servers=Object.keys(config.mcp_servers??{});if(!servers.every(name=>/^[A-Za-z0-9_-]+$/.test(name)))throw Error('unsafe configuration')}finally{probe.close()}const rpc=new Rpc(executable,true,servers,!!documentDirectory);try{await rpc.init();const config=(await rpc.request('config/read',{cwd:workingDirectory})).config;if((config.model_provider!=null&&config.model_provider!=='openai')||Object.values(config.mcp_servers??{}).some((server:any)=>server?.enabled!==false)||config.features?.shell_tool!==!!documentDirectory||config.features?.apps!==false||config.features?.plugins!==false||config.features?.multi_agent!==false||config.features?.browser_use!==false||config.features?.computer_use!==false||config.features?.code_mode_host!==!!documentDirectory||config.features?.hooks!==false||config.features?.skill_mcp_dependency_install!==false||config.web_search!=='disabled')throw Error('unsafe configuration')}catch(error){rpc.close();throw error}let c:Conversation;try{c=await this.load(p,t,phase)}catch(error){rpc.close();throw error}if(c.messages.some(m=>m.status==='pending'||m.status==='streaming')){for(const m of c.messages)if(m.status==='pending'||m.status==='streaming')m.status='unknown'}const recovery:TopicEvent[]=[];for(const pack of c.packs)if(pack.state==='streaming')this.closePack(pack,pack.role==='user'?'completed':'unknown',recovery);const sendId=randomUUID(),time=now();c.messages.push({id:randomUUID(),sendId,role:'user',content,provider:'codex',model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId},{id:randomUUID(),sendId,role:'assistant',content:'',provider:'codex',model,createdAt:time,updatedAt:time,status:'pending',threadId:c.threadId,sessionId:c.sessionId});const user=c.messages.at(-2)!;const userPack=this.newPack(c,user);userPack.content=user.content;userPack.state='closed';userPack.status='completed';try{await this.save(c,true)}catch(error){rpc.close();throw error}for(const event of recovery)this.emit(c,event);this.emit(c,{name:'chat.pack.closed',data:{packId:userPack.packId,header:packHeader(userPack)}});this.emit(c,{name:'chat.changed',data:{}});const active={rpc,threadId:c.threadId,turnId:null as string|null};this.active.set(k,active);void this.run(k,c,sendId,content,model,cwd,active,documentDirectory,phase,history);return c})}finally{this.preparing.delete(taskKey)}
 }
 private async run(k:string,c:Conversation,sendId:string,content:string,model:string|null,cwd:string,active:{rpc:Rpc;threadId:string|null;turnId:string|null},documentDirectory?:string,phase:TaskPhase|null=null,history?:{events:unknown[];through:number}){
  let dispatched=false,finished=false;let eventQueue=Promise.resolve();
  const itemPacks=new Map<string,string>();let textPackId:string|undefined;
  const update=async(fn:(messages:Message[],current:Conversation,events:TopicEvent[])=>void,changed=false)=>this.locked(k,async()=>{const current=await this.load(c.projectId,c.taskId,c.phase);const events:TopicEvent[]=[];fn(current.messages.filter(m=>m.sendId===sendId),current,events);current.threadId=active.threadId;current.sessionId=c.sessionId;for(const m of current.messages.filter(m=>m.sendId===sendId)){m.threadId=active.threadId;m.sessionId=c.sessionId}await this.save(current,events.length>0||changed);for(const event of events)this.emit(current,event);if(changed)this.emit(current,{name:'chat.changed',data:{}})});
  const finish=async(status:State)=>{if(finished)return;finished=true;try{await update((ms,current,events)=>{ms.forEach(m=>{m.status=status;m.updatedAt=now()});if(!current.packs.some(pack=>pack.sendId===sendId&&pack.role==='assistant')){const a=ms.find(m=>m.role==='assistant');if(a)this.newPack(current,a)}for(const pack of current.packs)if(pack.sendId===sendId)this.closePack(pack,status,events)},true)}finally{if(this.active.get(k)===active)this.active.delete(k);active.rpc.close()}};
  const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','functionCallOutput','webSearch','imageView','imageGeneration']);
  const toolData=(item:any)=>{const name=item.type==='commandExecution'?'command':typeof item.tool==='string'?item.tool:typeof item.name==='string'?item.name:item.type;const input=item.command??item.arguments??item.changes??null;const output=item.aggregatedOutput??item.contentItems??item.output??item.result??item.error??null;const encode=(v:unknown)=>typeof v==='string'?v:JSON.stringify(v);return {name,input:encode(input),output:encode(output)}};
  active.rpc.onEvent=(method,params)=>{eventQueue=eventQueue.then(async()=>{if(finished||params?.threadId!==active.threadId)return;if(method==='turn/started'&&typeof params.turn?.id==='string')active.turnId=params.turn.id;if(params.turnId&&active.turnId&&params.turnId!==active.turnId)return;
   if(method==='item/agentMessage/delta'&&typeof params.delta==='string'){
    const existing=(await this.load(c.projectId,c.taskId,c.phase)).packs.find(p=>p.packId===textPackId);if((existing?.content.length??0)+params.delta.length>1048576){await finish('failed');return}
    await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;let pack=current.packs.find(p=>p.packId===textPackId&&p.state==='streaming');if(!pack){pack=this.newPack(current,a);textPackId=pack.packId}if(typeof params.itemId==='string')itemPacks.set(params.itemId,pack.packId);pack.content+=params.delta;a.content+=params.delta;a.status='streaming';a.updatedAt=now();for(let start=0;start<params.delta.length;){let end=Math.min(start+4096,params.delta.length);const last=params.delta.charCodeAt(end-1);if(end<params.delta.length&&last>=0xd800&&last<=0xdbff)end--;const delta=params.delta.slice(start,end);events.push({name:'chat.pack.delta',data:{packId:pack.packId,delta,header:packHeader(pack)}});start=end}})
   }
   if((method==='item/started'||method==='item/completed')&&params.item&&typeof params.item.id==='string'){const item=params.item;if(toolTypes.has(item.type)){await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;const preceding=current.packs.find(p=>p.packId===textPackId);if(preceding)this.closePack(preceding,'completed',events);textPackId=undefined;let pack=current.packs.find(p=>p.packId===itemPacks.get(item.id));if(!pack){pack=this.newPack(current,a,'tool');itemPacks.set(item.id,pack.packId)}if(pack.state==='closed')return;const tool=toolData(item);if(JSON.stringify(tool).length>1048576)throw Error('Tool result too large');pack.tool=tool;pack.content=JSON.stringify(pack.tool);a.status='streaming';if(method==='item/completed')this.closePack(pack,item.status==='failed'?'failed':'completed',events)})}else if(item.type==='agentMessage'&&method==='item/completed'){if(typeof item.text==='string'&&item.text.length>1048576){await finish('failed');return}await update((ms,current,events)=>{const a=ms.find(m=>m.role==='assistant');if(!a)return;let pack=current.packs.find(p=>p.packId===itemPacks.get(item.id));if(!pack){pack=this.newPack(current,a);itemPacks.set(item.id,pack.packId);pack.content=typeof item.text==='string'?item.text:'';a.content+=pack.content}if(pack.state==='closed')return;if(typeof item.text==='string'&&item.text!==pack.content){a.content=a.content.slice(0,Math.max(0,a.content.length-pack.content.length))+item.text;pack.content=item.text}this.closePack(pack,'completed',events);if(textPackId===pack.packId)textPackId=undefined})}}
   if(method==='turn/completed'&&(!active.turnId||params.turn?.id===active.turnId)){const state=params.turn?.status;await finish(state==='completed'?'completed':state==='interrupted'?'interrupted':state==='failed'?'failed':'unknown')}
  }).catch(()=>{active.rpc.close()})};
  active.rpc.onClose=()=>{if(!finished)void eventQueue.then(()=>finish(dispatched?'unknown':'failed')).catch(()=>{}).finally(()=>{if(this.active.get(k)===active)this.active.delete(k)})};
  const implementation = !!documentDirectory && phase === 'implementation';
  const workingDirectory = implementation ? cwd : documentDirectory ?? cwd;
  try {
   const instructions = documentDirectory ? [
    `This is Beni task ${c.taskId}. Project reference directory: ${cwd}. Current phase: ${phase}.`,
    `Your working and writable directory is ${workingDirectory}. Task documents are in ${documentDirectory}.`,
    'Beni manages task.json, .history metadata, chat metadata, sessions and event cursors. Never modify these files directly. Files under .history/versions are read-only historical references.',
    'Read existing Markdown before changing it. Keep requirements.md updated from this task conversation, preserving user decisions, constraints and unresolved questions.',
    'Use documents.md as the specification organization index, with separate Japanese headings ## 資料 and ## 仕様 and relative Markdown links to additional task documents.',
    'Classify every additional document under exactly one heading: 資料 for research and alternatives kept within this task, or 仕様 for accepted behavior written for repository readers without conversation context.',
    'Use implementation-plan.md for implementation steps and verification, and English kebab-case .md filenames for additional task documents.',
    'The intended phase order is 要件定義, 仕様整理, 実装手順, 実装中.',
    implementation
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
   await update(()=>{});
   dispatched=true;
   const turn = await active.rpc.request('turn/start', {
    threadId: active.threadId, model, cwd: workingDirectory, approvalPolicy: 'never',
    sandboxPolicy: documentDirectory
     ? {type:'workspaceWrite', writableRoots:[workingDirectory], networkAccess:false, excludeTmpdirEnvVar:true, excludeSlashTmp:true}
     : {type:'readOnly', networkAccess:false},
    input: [{type:'text', text:content, text_elements:[]},...(history?.events.length?[{type:'text',text:`Beni task events through ${history.through}:\n${JSON.stringify(history.events)}\nDocument versions are available at ${documentDirectory}/.history/versions/<version>.md. Read referenced versions when needed.`,text_elements:[]}]:[])]
   });
   active.turnId=turn.turn.id;
   if(history)await update((_ms,current)=>{current.lastEventId=history.through});
   await eventQueue;
  }catch (error) {await eventQueue.catch(()=>{});await finish(dispatched && !(error instanceof Rejected)?'unknown':'failed').catch(()=>{});active.rpc.close();this.active.delete(k);return}
  // Completion arrives asynchronously after turn/start; the process remains open until then.
 }
 async interrupt(p:string,t:string|null,phase:TaskPhase|null=t===null?null:'requirements'){const active=this.active.get(conversationKey(p,t,phase));if(!active?.threadId||!active.turnId)throw Error('not running');await active.rpc.request('turn/interrupt',{threadId:active.threadId,turnId:active.turnId});}
}
