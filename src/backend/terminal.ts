import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { Subprocess } from 'bun';
import type { Scope, TerminalAction, TerminalSession, TopicEvent } from '../shared/communication';
import type { Subscription } from './events';
import { validProjectId } from '../shared/ids';

const MAX_SESSIONS = 64, MAX_PROJECT_SESSIONS = 8, MAX_QUEUE = 2 * 1024 * 1024;
const CHUNK = 4096;
type Viewer = {id:string;emit:(event:TopicEvent)=>void;ready:boolean};
type Session = {info:TerminalSession;screen:Terminal;serialize:SerializeAddon;process?:Subprocess;decoder:TextDecoder;queue:Promise<void>;queued:number;sequence:number;viewers:Map<string,Viewer>;owner?:string;generation:number;token:string|null;stopping?:Promise<void>;finalized?:Promise<void>;closing?:boolean;inputBudget:number;inputAt:number;inputPending:number};
export class TerminalError extends Error {constructor(public status:number,message:string){super(message)}}

/** Shells outlive subscriptions. No terminal data is written to disk or logs. */
export class TerminalService {
 private sessions = new Map<string,Session>();
 private changes = new Map<string,Set<(event:TopicEvent)=>void>>();
 private requests = new Map<string,string>();
 private shuttingDown = false;
 constructor(private shell=process.env.SHELL || '/bin/sh') {}
 list(projectId:string) {return [...this.sessions.values()].filter(s=>s.info.projectId===projectId).map(s=>({...s.info}))}
 projectBusy(projectId:string) {return [...this.sessions.values()].some(session=>session.info.projectId===projectId&&(session.info.status==='running'||session.closing||session.process?.exitCode===null))}
 has(projectId:string,id:string) {return this.sessions.get(id)?.info.projectId===projectId}
 private changed(projectId:string) {const event:TopicEvent={name:'terminal.changed',data:{sessions:this.list(projectId)}};for(const emit of this.changes.get(projectId)??[])emit(event)}
 create(projectId:string,folder:string,requestId:string):TerminalSession {
  if(!validProjectId(projectId))throw new TerminalError(400,'不正なプロジェクトIDです');
  const key=JSON.stringify([projectId,requestId]);const existing=this.requests.get(key);
  if(existing){const s=this.sessions.get(existing);if(!s)throw new TerminalError(409,'この作成依頼のターミナルは終了済みです');return {...s.info}}
  if(this.shuttingDown)throw new TerminalError(503,'サーバーを終了しています');
  if(this.sessions.size>=MAX_SESSIONS||this.list(projectId).length>=MAX_PROJECT_SESSIONS||this.requests.size>=4096)throw new TerminalError(409,'ターミナル数の上限です');
  const screen=new Terminal({cols:80,rows:24,scrollback:200,allowProposedApi:true});const serialize=new SerializeAddon();screen.loadAddon(serialize);
  const session:Session={info:{id:crypto.randomUUID(),projectId,requestId,status:'running',exitCode:null,cols:80,rows:24},screen,serialize,decoder:new TextDecoder(),queue:Promise.resolve(),queued:0,sequence:0,viewers:new Map(),generation:0,token:null,inputBudget:16384,inputAt:Date.now(),inputPending:0};
  this.sessions.set(session.info.id,session);this.requests.set(key,session.info.id);
  screen.onData(data=>{if(session.info.status==='running'&&!session.viewers.get(session.owner??'')?.ready&&session.inputPending+data.length<=65536){session.inputPending+=data.length;session.process?.terminal?.write(data)}});
  let finishStream!:()=>void;const streamEnded=new Promise<void>(resolve=>{finishStream=resolve});
  try {
   session.process=Bun.spawn([this.shell,'-i'],{cwd:folder,env:{...process.env,TERM:'xterm-256color'},terminal:{cols:80,rows:24,name:'xterm-256color',data:(_terminal,bytes)=>this.output(session,bytes),drain:()=>{session.inputPending=0},exit:()=>finishStream()}});
   session.finalized=session.process.exited.then(async code=>{
    // Process exit and PTY EOF are separate. Drain trailing output before the
    // exit notification, but do not wait forever for inherited descriptors.
    let timeout:ReturnType<typeof setTimeout>|undefined;await Promise.race([streamEnded,new Promise<void>(resolve=>{timeout=setTimeout(resolve,250)})]);clearTimeout(timeout);
    await this.enqueue(session,()=>{const tail=session.decoder.decode();if(tail)return this.write(session,tail);});
    await this.enqueue(session,()=>{if(session.info.status==='running'){session.info.status='exited';session.info.exitCode=code}session.process?.terminal?.close();this.state(session);this.changed(projectId)});
   });
  } catch {session.info.status='failed';session.process?.terminal?.close()}
  this.changed(projectId);return {...session.info};
 }
 private enqueue(session:Session,work:()=>void|Promise<void>) {session.queue=session.queue.then(work).catch(()=>{this.fail(session)});return session.queue}
 private output(session:Session,bytes:Uint8Array) {
  if(session.info.status!=='running')return;
  if(session.queued+bytes.length>MAX_QUEUE){this.fail(session);return}
  const data=session.decoder.decode(bytes,{stream:true});session.queued+=bytes.length;
  void this.enqueue(session,async()=>{try{for(let at=0;at<data.length;){let end=Math.min(at+CHUNK,data.length);if(end<data.length&&data.charCodeAt(end-1)>=0xd800&&data.charCodeAt(end-1)<=0xdbff)end--;const chunk=data.slice(at,end);await this.write(session,chunk);at=end}}finally{session.queued-=bytes.length}});
 }
 private write(session:Session,data:string):Promise<void> {return new Promise(resolve=>session.screen.write(data,()=>{this.broadcast(session,{name:'terminal.output',data:{sequence:++session.sequence,data}});resolve()}))}
 private fail(session:Session) {if(session.info.status!=='running')return;session.info.status='failed';this.state(session);this.changed(session.info.projectId);void this.terminate(session).catch(()=>{})}
 private broadcast(session:Session,event:TopicEvent) {for(const viewer of session.viewers.values())if(viewer.ready)viewer.emit(event)}
 private state(session:Session) {for(const viewer of session.viewers.values())if(viewer.ready)this.stateFor(session,viewer)}
 private stateFor(session:Session,viewer:Viewer) {viewer.emit({name:'terminal.state',data:{session:{...session.info},owner:session.owner===viewer.id,generation:session.generation,controlToken:session.owner===viewer.id?session.token:null}})}
 private grant(session:Session,id?:string) {session.owner=id;session.generation++;session.token=id?crypto.randomUUID():null;this.state(session)}
 subscribe(scope:Scope,emit:(event:TopicEvent)=>void):Subscription {
  if(!scope.terminalId){const listeners=this.changes.get(scope.projectId)??new Set();this.changes.set(scope.projectId,listeners);return {start:()=>{listeners.add(emit);emit({name:'terminal.changed',data:{sessions:this.list(scope.projectId)}})},stop:()=>{listeners.delete(emit);if(!listeners.size)this.changes.delete(scope.projectId)}}}
  const session=this.sessions.get(scope.terminalId)!;const viewer:Viewer={id:crypto.randomUUID(),emit,ready:false};session.viewers.set(viewer.id,viewer);
  if(!session.owner&&!session.closing)this.grant(session,viewer.id);
  let stopped=false;
  return {start:()=>{void this.enqueue(session,async()=>{
   if(stopped)return;
   // Serialize complete emulator state, never a tail cut through escape sequences.
   let snapshot=session.serialize.serialize({scrollback:200});
   const fits=()=>new TextEncoder().encode(JSON.stringify(snapshot)).length<=262144;
   if(!fits())snapshot=session.serialize.serialize({scrollback:0});
   if(!fits()){session.screen.reset();snapshot='表示の上限を超えたためターミナルを終了しました。';await this.write(session,snapshot);this.fail(session)}
   emit({name:'terminal.sync.begin',data:{sequence:session.sequence,cols:session.info.cols,rows:session.info.rows}});
   for(let at=0;at<snapshot.length;){let end=Math.min(at+CHUNK,snapshot.length);if(end<snapshot.length&&snapshot.charCodeAt(end-1)>=0xd800&&snapshot.charCodeAt(end-1)<=0xdbff)end--;emit({name:'terminal.sync.chunk',data:{data:snapshot.slice(at,end)}});at=end}
   emit({name:'terminal.sync.end',data:{sequence:session.sequence}});viewer.ready=true;this.stateFor(session,viewer);
  })},stop:()=>{stopped=true;session.viewers.delete(viewer.id);if(session.owner===viewer.id)this.grant(session)},message:action=>{
   if(stopped||!viewer.ready)throw new TerminalError(409,'ターミナルを同期しています');
   if(action.type==='terminal.takeover'){if(action.generation!==session.generation||session.closing)throw new TerminalError(409,'操作権を確認してください');this.grant(session,viewer.id);return}
   if(session.owner!==viewer.id||action.generation!==session.generation||session.closing)throw new TerminalError(403,'操作権がありません');
   if(session.info.status!=='running')throw new TerminalError(409,'シェルは終了しています');
   if(action.type==='terminal.input'){
    const now=Date.now();session.inputBudget=Math.min(16384,session.inputBudget+(now-session.inputAt)*16);session.inputAt=now;
    const bytes=new TextEncoder().encode(action.data).length;
    if(bytes>session.inputBudget||session.inputPending+bytes>65536)throw new TerminalError(429,'入力が多すぎます');
    session.inputBudget-=bytes;session.inputPending+=bytes;session.process!.terminal!.write(action.data);
   }else{
    // Resize ordering shares the parser queue with snapshots and output.
    void this.enqueue(session,()=>{if(session.owner!==viewer.id||action.generation!==session.generation||session.closing||session.info.status!=='running')return;session.process!.terminal!.resize(action.cols,action.rows);session.screen.resize(action.cols,action.rows);session.info.cols=action.cols;session.info.rows=action.rows;this.broadcast(session,{name:'terminal.resized',data:{sequence:++session.sequence,cols:action.cols,rows:action.rows}})});
   }
  }};
 }
 async close(projectId:string,id:string,token:string) {
  const session=this.sessions.get(id);if(!session||session.info.projectId!==projectId)throw new TerminalError(404,'ターミナルが見つかりません');
  if(!session.owner||session.token!==token)throw new TerminalError(403,'操作権がありません');
  // Revoke synchronously before awaiting signals; takeover cannot race closing.
  session.closing=true;const closing=this.terminate(session);this.grant(session);try{await closing}catch(error){session.closing=false;session.stopping=undefined;throw error}
  await session.finalized;await session.queue;for(const viewer of session.viewers.values())viewer.ready=false;session.screen.dispose();this.sessions.delete(id);this.changed(projectId);
 }
 private terminate(session:Session):Promise<void> {
  if(session.stopping)return session.stopping;
  session.stopping=this.killTree(session);return session.stopping;
 }
 private async killTree(session:Session) {
  const child=session.process;if(!child||child.exitCode!==null)return;
  // PTY shells are session leaders. Job-control commands get distinct process
  // groups, so collect every member of the session as well as descendants.
  const members=new Set<number>([child.pid]);const groups=new Set<number>([child.pid]);
  const collect=()=>{
   const result=Bun.spawnSync(['/bin/ps','-axo','pid=,ppid=,pgid=,sid='],{stdout:'pipe',stderr:'ignore',maxBuffer:4*1024*1024});
   // macOS calls the POSIX session ID "sess" and prints it as a pointer; use
   // process descendants there, and preserve discovered groups across reparenting.
   const fallback=result.exitCode!==0?Bun.spawnSync(['/bin/ps','-axo','pid=,ppid=,pgid='],{stdout:'pipe',stderr:'ignore',maxBuffer:4*1024*1024}):result;
   if(fallback.exitCode!==0)throw new TerminalError(500,'プロセスを確認できませんでした');
   const entries=fallback.stdout.toString().trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
   let changed=true;while(changed){changed=false;for(const [pid,ppid,pgid,sid] of entries)if(pid>1&&(members.has(ppid)||sid===child.pid||groups.has(pgid))&&!members.has(pid)){members.add(pid);groups.add(pgid);changed=true}}
  };
  collect();
  const signal=(name:'SIGTERM'|'SIGKILL')=>{for(const group of groups)try{process.kill(-group,name)}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}for(const pid of members)try{process.kill(pid,name)}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e}};
  signal('SIGTERM');await new Promise(resolve=>setTimeout(resolve,250));collect();signal('SIGKILL');await child.exited;child.terminal?.close();
 }
 async dispose() {this.shuttingDown=true;for(const s of this.sessions.values()){s.closing=true;this.grant(s)}await Promise.all([...this.sessions.values()].map(s=>this.terminate(s)));for(const s of this.sessions.values()){await s.finalized;await s.queue;s.screen.dispose()}this.sessions.clear();this.changes.clear()}
}
