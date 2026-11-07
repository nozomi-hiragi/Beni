import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createSdkMcpServer, query, type Query, type Options as SdkOptions, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { contextUsageFromCounts, type ContextUsage } from '../shared/agent';
import { type EmbeddedTool, type EmbeddedToolResult, toolResult } from './embedded-tools';
import type { RateLimitUsage } from './rate-limits';

// 安全性に関わるフラグの組み合わせを確認した CLI 以降だけを使用する。
export const CLAUDE_MIN_VERSION = '2.1.292';
export const claudeModels = [{id:'sonnet',name:'Sonnet'},{id:'opus',name:'Opus'},{id:'haiku',name:'Haiku'}];
export type ClaudeStatus = {installed:boolean;path:string|null;version:string|null;checkedAt:string;auth:'claude'|'apiKey'|'other'|'none'|'unknown';models:{id:string;name:string}[]|null;usage:RateLimitUsage};
export class ClaudeRejected extends Error { constructor(public modelUnavailable=false,public interrupted=false,public code?:string) { super('Request rejected'); } }

export class ClaudeSessionMissing extends ClaudeRejected {}

const versionSupported=(version:string)=>{const actual=version.split('.').map(Number),minimum=CLAUDE_MIN_VERSION.split('.').map(Number);for(let i=0;i<3;i++){if(actual[i]!==minimum[i])return actual[i]>minimum[i]}return true};
const foreignAuth=():ClaudeStatus['auth']|null=>{
 if(process.env.ANTHROPIC_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN)return 'apiKey';
 if(process.env.ANTHROPIC_BASE_URL||['CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY'].some(key=>process.env[key]&&process.env[key]!=='0'&&process.env[key]!=='false'))return 'other';
 return null;
};
const command=(executable:string,args:string[],allowFailure=false)=>new Promise<string>((resolve,reject)=>execFile(executable,args,{timeout:5000,maxBuffer:65536},(error,stdout)=>error&&!(allowFailure&&stdout)?reject(Error('Claude status unavailable')):resolve(stdout)));
export async function claudeStatus(executable:string|null, onAccount?:(identity:string)=>void):Promise<ClaudeStatus>{
 const status:ClaudeStatus={installed:!!executable,path:executable,version:null,checkedAt:new Date().toISOString(),auth:'unknown',models:null,usage:'unknown'};
 if(!executable)return status;
 try{const match=(await command(executable,['--version'])).match(/^(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\s+\(Claude Code\)/m);status.version=match?.[1]??null}catch{}
 if(!status.version||!versionSupported(status.version))return status;
 status.models=claudeModels.map(model=>({...model}));
 const override=foreignAuth();if(override){status.auth=override;return status}
 try{
  // アカウント識別子・メールアドレスなどは保存・返却しない。
  const auth=JSON.parse(await command(executable,['auth','status','--json'],true));
  status.auth=auth.loggedIn===false?'none':auth.loggedIn===true&&auth.authMethod==='claude.ai'&&auth.apiProvider==='firstParty'?'claude':['api_key','api_key_helper'].includes(auth.authMethod)?'apiKey':auth.loggedIn===true?'other':'unknown';
  if(status.auth==='claude'&&onAccount){
   const identity = [auth.accountId, auth.email, auth.orgId].map(value => typeof value === 'string' ? value : null);
   if(identity[0]||identity[1])onAccount(createHash('sha256').update(JSON.stringify(identity)).digest('hex'));
  }
 }catch{}
 return status;
}

type Options={builtinTools?:false;ephemeral?:true;authoritativeText?:true;cwd:string;model:string|null;sandbox:'read-only'|'workspace-write';developerInstructions?:string;dynamicTools?:EmbeddedTool[]};
const generationCommands=['code-review','simplify','security-review','recap'] as const;
const localCommands=['context','usage'] as const;
const modelError=(error:any)=>['model_not_found','model_not_supported','model_not_available','unsupported_model'].includes(typeof error==='string'?error:error?.code);
export const claudeGenerationArgumentsAllowed=(name:string,args:string)=>
 args.length<=16384&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(args)&&
 (name!=='code-review'||!/(?:^|[\s"'`])(?:ultra|--(?:post|comment))(?:$|[\s="'`])/i.test(args));
const maxCommandOutput=64*1024;
const contextUsageTimeoutMs=1000;
type Block={id:string;type:'text'|'tool_use';text:string;name?:string;input?:unknown;partial?:string;complete:boolean};

// SDK のメッセージを内部通知へ変換する。ローカル保守コマンドだけ CLI を直接起動する。
export class ClaudeRpc {
 onEvent:(method:string,params:any)=>void=()=>{};
 onAccepted:()=>void=()=>{};
 onClose:(exitCode:number|null)=>void=()=>{};
 onToolCall:(params:any)=>Promise<EmbeddedToolResult>=async()=>toolResult({error:'Unsupported tool'},false);
 waitForEvents:()=>void|Promise<void>=()=>{};
 private child:ChildProcessWithoutNullStreams|null=null;
 private sdkQuery:Query|null=null;
 private sdkResultReceived=false;
 private endPrompt:(()=>void)|undefined;
 private session:string|null=null;
 private resumed=false;
 private options:Options|null=null;
 private turn:string|null=null;
 private interrupted=false;
 private completed=false;
 private closed=false;
 private closing=false;
 private termination:ReturnType<typeof setTimeout>|null=null;
 private blocks=new Map<string,Block>();
 private currentMessage='';
 private partials=new Map<number,Block>();
 private streamedTextByMessage=new Map<string,{blocks:Block[];nextCompletion:number}>();
 private sawText=false;
 private initialized=false;
 private sawWork=false;
 private earlyToolCall=false;
 private compacting=false;
 private compactBoundary=false;
 private localCommand:'context'|'usage'|null=null;
 private commandFallback=false;
 private commandOutput:string|null=null;
 private usageReport:unknown;
 private commandContextUsage:ContextUsage|undefined;
 private commandUnavailable=false;
 private generationCommand:string|null=null;
 private pending:{resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null;
 private acceptance:Promise<void>|null=null;
 constructor(private executable:string){}
 async init(){}
 async request(method:string,params:any):Promise<any>{
  if(this.closed||this.closing)throw Error('Connection closed');
  if(method==='config/read')return {config:{mcp_servers:{},web_search:'disabled',features:{shell_tool:false,apps:false,plugins:false,multi_agent:false,browser_use:false,computer_use:false,code_mode_host:false,hooks:false,skill_mcp_dependency_install:false}}};
  if(method==='thread/start'||method==='thread/resume'){
   if(this.session)throw new ClaudeRejected();
   if(!params||typeof params.cwd!=='string'||!['read-only','workspace-write'].includes(params.sandbox))throw new ClaudeRejected();
   if(method==='thread/resume'&&(typeof params.threadId!=='string'||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(params.threadId)))throw new ClaudeRejected();
   this.session=method==='thread/resume'?params.threadId:randomUUID();this.resumed=method==='thread/resume';this.options=params;
   return {thread:{id:this.session,sessionId:this.session}};
  }
  if(method==='turn/start'||method==='thread/compact/start'||method==='thread/command/start'){
   const compacting=method==='thread/compact/start',local=method==='thread/command/start',maintenance=compacting||local;
   if(!params||typeof params!=='object')throw new ClaudeRejected();
   if(local&&!localCommands.includes(params.command))throw new ClaudeRejected();
   const generation=!maintenance&&params.command!==undefined?params.command:null;
   if(!maintenance&&params.command!==undefined&&(!generation||typeof generation!=='object'||Array.isArray(generation)||!generationCommands.includes(generation.name)||typeof generation.args!=='string'||Object.keys(generation).some(key=>key!=='name'&&key!=='args')))throw new ClaudeRejected();
   if(generation&&!claudeGenerationArgumentsAllowed(generation.name,generation.args))throw new ClaudeRejected(false,false,'COMMAND_ARGUMENTS_UNSUPPORTED');
   if(!this.session||!this.options||this.child||params.threadId!==this.session)throw new ClaudeRejected();
   if(maintenance&&!this.resumed&&!(local&&params.command==='usage'&&this.options.ephemeral))throw new ClaudeRejected();
   const model=params.model??this.options.model;
   if(!claudeModels.some(candidate=>candidate.id===model))throw new ClaudeRejected(true);
   if(foreignAuth())throw new ClaudeRejected();
   if(!maintenance&&(!Array.isArray(params.input)||params.input.some((item:any)=>!item||item.type!=='text'||typeof item.text!=='string')))throw new ClaudeRejected();
   if(generation&&params.input.length===0)throw new ClaudeRejected();
   this.compacting=compacting;this.localCommand=local?params.command:null;this.generationCommand=generation?.name??null;
   this.turn=randomUUID();
   const writable=this.options.sandbox==='workspace-write';
   const tools=maintenance||this.options.builtinTools===false?'':writable?'Read,Glob,Grep,Write,Edit,Bash':'Read,Glob,Grep';
   // Bash の許可は CLI の必須 sandbox と組み合わせ、隔離外への再試行を許可しない。
   // 管理者ポリシーが優先され、CLI 既定の一時領域・worktree の共有 .git は書込可能。
   const settings={disableAllHooks:true,...(writable?{sandbox:{enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,excludedCommands:[],enableWeakerNestedSandbox:false,enableWeakerNetworkIsolation:false,allowAppleEvents:false,filesystem:{disabled:false,allowWrite:[]},network:{strictAllowlist:true,allowedDomains:[],deniedDomains:['*'],allowUnixSockets:[],allowAllUnixSockets:false,allowLocalBinding:false,allowMachLookup:[]}}}:{})};
   // 追加文脈は slash の引数に連結せず、通常のシステム文脈として別送する。
   const context=generation?params.input.slice(1).map((item:any)=>item.text).join('\n\n'):'';
   const instructions=[this.options.developerInstructions,context].filter(Boolean).join('\n\n');
   const prompt=compacting?'/compact':local?`/${this.localCommand}`:generation?`/${generation.name}${generation.args?' '+generation.args:''}`:params.input.map((item:any)=>item.text).join('\n\n');
   const acceptance=this.acceptance=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.rejectPending(Error('Claude acceptance timed out'));this.close()},60000);timer.unref();this.pending={resolve,reject,timer}});
   // spawn 失敗時にも acceptance の rejection を未処理にしない。
   void acceptance.catch(()=>{});
   if(!maintenance){
    this.startQuery(prompt,model,tools,settings,instructions,writable);
    await acceptance;
    return {turn:{id:this.turn}};
   }
   // /compact・/context・/usage は CLI 固有のローカル結果を厳密に識別する保守経路。
   const args=['--print','--output-format','stream-json','--verbose','--include-partial-messages','--restricted','--safe-mode','--setting-sources','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--permission-mode','dontAsk','--permission-prompts','none','--tools','','--allowedTools','','--disallowedTools','mcp__*','--settings',JSON.stringify(settings),'--system-prompt-snapshot','off','--model',model,this.resumed?'--resume':'--session-id',this.session];
   if(this.options.ephemeral)args.push('--no-session-persistence');
   if(instructions)args.push('--append-system-prompt',instructions);
   const child=spawn(this.executable,args,{cwd:this.options.cwd,env:{...process.env,...(writable?{CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:'1'}:{})},stdio:['pipe','pipe','pipe']});this.child=child;
   // stderr を公開せず、再開対象を明示した既知の診断だけを照合する。
   let stderr='';
   child.stderr.setEncoding('utf8');
   child.stderr.on('data',chunk=>{if(stderr.length<=4096)stderr+=String(chunk).slice(0,4097-stderr.length)});
   const lines=createInterface({input:child.stdout});lines.on('line',line=>{
    if(this.closed||this.closing||this.completed)return;
    if(this.canRetryMissingSession()&&this.missingSessionDiagnostic(line)){this.rejectPending(new ClaudeSessionMissing());this.close();return}
    try{this.receive(JSON.parse(line))}catch{this.close()}
   });
   child.once('close',()=>{if(this.termination)clearTimeout(this.termination);this.termination=null;this.rejectPending(this.interrupted?new ClaudeRejected(false,true):this.canRetryMissingSession()&&this.missingSessionDiagnostic(stderr.trim())?new ClaudeSessionMissing():Error('Claude closed before acceptance'));if(this.interrupted&&!this.completed)this.finish('interrupted');this.signalClose()});
   child.once('error',()=>{this.rejectPending(Error('Claude unavailable'));this.signalClose()});
   child.stdin.on('error',()=>{});
   await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(Error('Claude unavailable')))});
   this.emit('turn/started',{turn:{id:this.turn}});
   child.stdin.end(this.interrupted?undefined:prompt);
   await acceptance;
   return maintenance?{}:{turn:{id:this.turn}};
  }
  if(method==='turn/interrupt'){
   if(!this.child||params.threadId!==this.session||params.turnId!==this.turn)throw new ClaudeRejected();
   if(this.sdkResultReceived)return {};
   this.interrupted=true;
   if(this.sdkQuery)void this.sdkQuery.interrupt().catch(()=>this.close());
   else this.child.kill('SIGINT');
   this.termination=setTimeout(()=>this.child?.kill('SIGKILL'),3000);this.termination.unref();
   return {};
  }
  throw new ClaudeRejected();
 }
 private emit(method:string,params:Record<string,unknown>){this.onEvent(method,{threadId:this.session,turnId:this.turn,...params})}
 private accept(){if(!this.initialized||!this.pending||this.interrupted)return;const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.resolve();this.onAccepted()}
 private rejectPending(error:Error){if(!this.pending)return;const pending=this.pending;this.pending=null;clearTimeout(pending.timer);pending.reject(error)}
 private text(block:Block,text:string){if(!text)return;this.sawText=true;block.text+=text;this.emit('item/agentMessage/delta',{itemId:block.id,delta:text})}
 private item(block:Block){let input=block.input??{};if(block.partial){try{input=JSON.parse(block.partial)}catch{input=block.partial}}return {id:block.id,type:'dynamicToolCall',name:block.name,arguments:input,status:'inProgress'}}
 private completeText(block:Block){if(block.complete)return;block.complete=true;this.emit('item/completed',{item:{id:block.id,type:'agentMessage',text:block.text}})}
 private finish(status:'completed'|'failed'|'interrupted',modelUnavailable=false,errorCode?:string){if(this.completed)return;this.completed=true;this.child?.stdin.end();for(const block of this.blocks.values())if(block.type==='text')this.completeText(block);this.emit('turn/completed',{turn:{id:this.turn,status,...(modelUnavailable||errorCode?{error:{code:modelUnavailable?'model_not_found':errorCode}}:{})}})}
 private canRetryMissingSession(){
  return this.resumed&&!this.compacting&&!this.localCommand&&!this.initialized&&!this.sawWork&&!this.interrupted;
 }
 private missingSessionDiagnostic(text:unknown){return text===`No conversation found with session ID: ${this.session}`}
 private receive(message:any,contextUsage?:ContextUsage){
  if(message.type==='assistant'||message.type==='stream_event'||message.type==='user'||message.type==='control_request'&&message.request?.message?.method==='tools/call')this.sawWork=true;
  if(message.type==='result'&&message.is_error===true&&this.canRetryMissingSession()&&
   (message.session_id===undefined||message.session_id===this.session)&&
   [message.error,message.result,...(Array.isArray(message.errors)?message.errors:[])].some(error=>
    error?.code==='session_not_found'||this.missingSessionDiagnostic(error))){
   this.rejectPending(new ClaudeSessionMissing());
   this.close();
   return;
  }
  if(message.type==='rate_limit_event'){
   if(message.session_id===this.session&&message.parent_tool_use_id==null)this.onEvent('account/rateLimits/updated',message.rate_limit_info);
   return;
  }
  if(this.compacting||this.localCommand){
   if(message.type==='control_request'){
    // 保守コマンドからの対話要求は受け付けない。
    this.child?.stdin.write(JSON.stringify({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'Unsupported control request'}})+'\n');return;
   }
   if(message.parent_tool_use_id)return;
   if(message.session_id!==undefined&&message.session_id!==this.session){this.rejectPending(new ClaudeRejected());this.close();return}
  }
  if(message.parent_tool_use_id)return;
  if(message.type==='system'&&message.subtype==='init'){
   if(message.session_id!==this.session){this.rejectPending(new ClaudeRejected());this.close();return}
   this.initialized=true;
   const requestedCommand=this.localCommand??this.generationCommand;
   if(requestedCommand&&Array.isArray(message.slash_commands)&&!message.slash_commands.includes(requestedCommand)){
    this.rejectPending(new ClaudeRejected());this.finish('failed',false,'COMMAND_UNAVAILABLE');this.close();return;
   }
   if(this.compacting||this.localCommand||this.earlyToolCall)this.accept();
  }
  if(this.localCommand){
   // CLI が生成するローカル結果だけを収集し、モデル応答やツールには変換しない。
   if(message.type==='assistant'){
    const content=message.message?.content;
    const text=typeof content==='string'?content:Array.isArray(content)&&content.every((block:any)=>block?.type==='text'&&typeof block.text==='string')?content.map((block:any)=>block.text).join(''):null;
    const local=this.initialized&&message.session_id===this.session&&message.parent_tool_use_id==null&&message.local_command_run?.command===this.localCommand&&message.local_command_run?.args===''&&typeof message.local_command_source==='string'&&!('local_command_outcome' in message);
    if(message.local_command_outcome?.kind==='unavailable_headless')this.commandUnavailable=true;
    if(!local||text===null||!text.trim()||Buffer.byteLength((this.commandOutput??'')+text,'utf8')>maxCommandOutput)this.commandFallback=true;
    else {
     this.commandOutput=(this.commandOutput??'')+text;
     if(this.localCommand==='usage'&&this.options?.ephemeral&&message.usage_report!==undefined)this.usageReport=message.usage_report;
     if(this.localCommand==='context')this.commandContextUsage=contextUsageFromCounts(message.context_usage?.total_tokens,message.context_usage?.raw_max_tokens);
    }
   }
   if(message.type==='stream_event')this.commandFallback=true;
   if(message.type==='result'){
    // synthetic 本文がある場合は result の重複本文を使わない。旧 CLI の result-only 形式も受ける。
    const output=this.commandOutput??message.result;
    const unavailable=this.commandUnavailable||typeof message.result==='string'&&[
     `/${this.localCommand} isn't available in this environment.`,
     `Unknown slash command: /${this.localCommand}`,
     `Unknown command: /${this.localCommand}`,
    ].includes(message.result.trim());
    const failed=message.session_id!==this.session||!this.initialized||message.is_error===true||message.subtype!=='success'||unavailable||this.commandFallback||typeof output!=='string'||!output.trim()||Buffer.byteLength(output,'utf8')>maxCommandOutput;
    if(failed)this.rejectPending(new ClaudeRejected(false,this.interrupted));
    else{
     this.accept();
     if(!this.interrupted){
      if(this.usageReport!==undefined)this.emit('account/usage/report',{report:this.usageReport});
      if(this.commandContextUsage)this.emit('thread/context/usage',{usage:this.commandContextUsage});
      this.emit('thread/command/output',{output});
     }
    }
    this.finish(this.interrupted?'interrupted':failed?'failed':'completed',false,failed?(unavailable?'COMMAND_UNAVAILABLE':'COMMAND_NOT_PERFORMED'):undefined);
   }
   return;
  }
  if(this.compacting){
   // /compact の本文や要約は通常の応答として保存しない。手動圧縮境界と最終結果の両方が必要。
   if(message.type==='system'&&message.subtype==='compact_boundary'&&message.session_id===this.session&&this.initialized&&message.compact_metadata?.trigger==='manual'&&!this.compactBoundary){
    this.compactBoundary=true;const item={id:randomUUID(),type:'contextCompaction'};
    this.emit('item/started',{item});this.emit('item/completed',{item});
   }
   if(message.type==='result'){
    const failed=message.session_id!==this.session||!this.initialized||message.is_error===true||message.subtype!=='success'||!this.compactBoundary;
    // 既知の圧縮拒否だけをコードに変換し、CLI の自由記述本文は外へ渡さない。
    const reason=!this.compactBoundary&&message.is_error!==true&&message.subtype==='success'?message.result:undefined;
    const errorCode=reason==="/compact isn't available in this environment."?'COMPACTION_UNAVAILABLE':reason==='Not enough messages to compact.'?'COMPACTION_NOT_NEEDED':'COMPACTION_NOT_PERFORMED';
    if(failed)this.rejectPending(new ClaudeRejected(false,this.interrupted));else this.accept();
    this.finish(this.interrupted?'interrupted':failed?'failed':'completed',false,failed?errorCode:undefined);
   }
   return;
  }
  if(message.session_id!==undefined&&message.session_id!==this.session)return;
  if(message.type==='stream_event'){
   const event=message.event;
   if(event?.type==='message_start'||event?.type==='content_block_start'||event?.type==='content_block_delta')this.accept();
   if(event?.type==='message_start'){this.currentMessage=event.message?.id??randomUUID();this.partials.clear()}
   if(event?.type==='content_block_start'){
    const content=event.content_block;if(content?.type!=='text'&&content?.type!=='tool_use')return;
    const block:Block={id:content.type==='tool_use'?content.id:`${this.currentMessage}:${event.index}`,type:content.type,text:'',name:content.name,input:content.input,complete:false};
    this.blocks.set(block.id,block);this.partials.set(event.index,block);
    if(block.type==='text'){
     let streamed=this.streamedTextByMessage.get(this.currentMessage);
     if(!streamed){
      streamed={blocks:[],nextCompletion:0};
      this.streamedTextByMessage.set(this.currentMessage,streamed);
     }
     streamed.blocks.push(block);
     this.emit('item/started',{item:{id:block.id,type:'agentMessage'}});
     this.text(block,content.text??'');
    }else this.emit('item/started',{item:this.item(block)});
   }
   if(event?.type==='content_block_delta'){
    const block=this.partials.get(event.index);if(!block)return;
    if(block.type==='text'&&event.delta?.type==='text_delta')this.text(block,event.delta.text??'');
    if(block.type==='tool_use'&&event.delta?.type==='input_json_delta')block.partial=(block.partial??'')+(event.delta.partial_json??'');
   }
   if(event?.type==='content_block_stop'&&!this.options?.authoritativeText){const block=this.partials.get(event.index);if(block?.type==='text')this.completeText(block)}
  }
  if(message.type==='assistant'){
   if(message.error){const modelUnavailable=modelError(message.error);this.rejectPending(new ClaudeRejected(modelUnavailable,this.interrupted));this.finish(this.interrupted?'interrupted':'failed',modelUnavailable);return}
   this.accept();
   const streamed=this.streamedTextByMessage.get(message.message?.id);
   // SDK は同じ message.id の確定ブロックを一つずつ送るため、本文を受信順に対応づける。
   for(const content of message.message?.content??[]){
    if(content.type==='text'){
     let block:Block|undefined;
     if(streamed){
      block=streamed.blocks[streamed.nextCompletion];
      streamed.nextCompletion++;
     }
     if(!block){
      block={id:randomUUID(),type:'text',text:'',complete:false};
      this.blocks.set(block.id,block);
      this.text(block,content.text??'');
     }
     else if(this.options?.authoritativeText&&typeof content.text==='string'){block.text=content.text;this.sawText||=!!content.text}
     this.completeText(block);
    }else if(content.type==='tool_use'){
     let block=this.blocks.get(content.id);if(!block){block={id:content.id,type:'tool_use',text:'',name:content.name,input:content.input,complete:false};this.blocks.set(block.id,block);this.emit('item/started',{item:this.item(block)})}else{block.input=content.input;block.partial=undefined}
    }
   }
  }
  if(message.type==='user')for(const content of message.message?.content??[]){
   if(content.type!=='tool_result')continue;const block=this.blocks.get(content.tool_use_id);if(!block||block.complete)continue;
   block.complete=true;this.emit('item/completed',{item:{...this.item(block),output:content.content,status:content.is_error?'failed':'completed'}});
  }
  if(message.type==='result'){
   const failed=message.is_error===true||message.subtype!=='success';
   // 成功本文や自由記述の失敗文からモデル利用可否を推測しない。
   const errors=[message.error,...(Array.isArray(message.errors)?message.errors:[])];
   const modelUnavailable=failed&&errors.some(modelError);
   if(failed)this.rejectPending(new ClaudeRejected(modelUnavailable,this.interrupted));else this.accept();
   if(!failed&&!this.sawText&&typeof message.result==='string'&&message.result){const block:Block={id:randomUUID(),type:'text',text:'',complete:false};this.blocks.set(block.id,block);this.text(block,message.result)}
   if(contextUsage)this.emit('thread/context/usage',{usage:contextUsage});
   this.finish(this.interrupted?'interrupted':failed?'failed':'completed',modelUnavailable);
  }
 }
 private startQuery(prompt:string,model:string,tools:string,settings:SdkOptions['settings'],instructions:string,writable:boolean){
  let stderr='';
  const dynamicTools=this.options!.dynamicTools??[];
  const servers:NonNullable<SdkOptions['mcpServers']>={};
  if(dynamicTools.length){
   const server=createSdkMcpServer({name:'beni',version:'1.0.0'});
   // JSON Schema とアプリ側の入力検証を維持し、SDK に MCP transport の処理を任せる。
   server.instance.server.registerCapabilities({tools:{}});
   server.instance.server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:dynamicTools.map(({name,description,inputSchema})=>({name,description,inputSchema}))}));
   server.instance.server.setRequestHandler(CallToolRequestSchema,async request=>{
    const available=()=>!this.closed&&!this.closing&&!this.completed&&!this.interrupted;
    const rejected={content:[{type:'text' as const,text:JSON.stringify({error:'Embedded tool request rejected or unavailable'})}],isError:true};
    if(!available()||!dynamicTools.some(tool=>tool.name===request.params.name))return rejected;
    this.sawWork=this.earlyToolCall=true;
    this.accept();
    try{
     await this.acceptance;
     if(!available())return rejected;
     const output=await this.onToolCall({threadId:this.session,turnId:this.turn,callId:randomUUID(),tool:request.params.name,arguments:request.params.arguments??{}});
     return available()?{content:output.contentItems.map(item=>({type:'text',text:item.text})),isError:!output.success}:rejected;
    }catch{return rejected}
   });
   servers.beni=server;
  }
  try{
   this.sdkQuery=query({prompt:this.options!.ephemeral?prompt:this.streamPrompt(prompt),options:{
    pathToClaudeCodeExecutable:this.executable,cwd:this.options!.cwd,model,
    ...(this.resumed?{resume:this.session!}:{sessionId:this.session!}),
    persistSession:!this.options!.ephemeral,
    tools:tools?tools.split(','):[],allowedTools:[...(tools?tools.split(','):[]),...dynamicTools.map(tool=>`mcp__beni__${tool.name}`)],
    ...(!dynamicTools.length?{disallowedTools:['mcp__*']}:{}),
    permissionMode:'dontAsk',permissionPrompts:'none',settingSources:[],strictMcpConfig:true,mcpServers:servers,
    settings,includePartialMessages:true,systemPrompt:{type:'preset',preset:'claude_code',snapshot:false},
    env:{...process.env,...(writable?{CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:'1'}:{})},
    extraArgs:{print:null,restricted:null,'safe-mode':null,'no-chrome':null,'system-prompt-snapshot':'off',
     ...(!this.generationCommand?{'disable-slash-commands':null}:{}),
     ...(!dynamicTools.length?{'mcp-config':'{"mcpServers":{}}'}:{}),
     ...(instructions?{'append-system-prompt':instructions}:{})},
    spawnClaudeCodeProcess:options=>{
     const child=spawn(options.command,options.args,{cwd:options.cwd,env:options.env,signal:options.signal,stdio:['pipe','pipe','pipe']});
     this.child=child;
     child.stderr.setEncoding('utf8');
     child.stderr.on('data',chunk=>{if(stderr.length<=4096)stderr+=String(chunk).slice(0,4097-stderr.length)});
     child.once('spawn',()=>this.emit('turn/started',{turn:{id:this.turn}}));
     child.once('close',()=>{if(this.termination)clearTimeout(this.termination);this.termination=null;if(this.closing)this.signalClose()});
     return child;
    }
   }});
   void this.consumeQuery(this.sdkQuery,()=>stderr);
  }catch{this.rejectPending(Error('Claude unavailable'));this.close()}
 }
 private async *streamPrompt(prompt:string):AsyncGenerator<SDKUserMessage>{
  // A string prompt closes SDK input on result. Keep the control channel open for the summary.
  const ended=Promise.withResolvers<void>();
  this.endPrompt=ended.resolve;
  yield {type:'user',session_id:'',message:{role:'user',content:[{type:'text',text:prompt}]},parent_tool_use_id:null};
  await ended.promise;
 }
 private async readContextUsage(stream:Query):Promise<ContextUsage|undefined>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const usage=await Promise.race([
    stream.getContextUsage({detail:'summary'}),
    new Promise<undefined>(resolve=>{timer=setTimeout(()=>resolve(undefined),contextUsageTimeoutMs)}),
   ]);
   return contextUsageFromCounts(usage?.totalTokens,usage?.rawMaxTokens);
  }catch{
   // Unavailable on older CLIs. A missing report does not affect the turn result.
  }finally{clearTimeout(timer)}
 }
 private async consumeQuery(stream:Query,stderr:()=>string){
  try{
   for await(const message of stream){
    if(this.closed||this.closing||this.completed)break;
    let usage:ContextUsage|undefined;
    if(message.type==='result'&&message.session_id===this.session&&
     !('parent_tool_use_id' in message&&message.parent_tool_use_id)){
     this.sdkResultReceived=true;
     if(this.initialized&&!this.interrupted&&!this.options?.ephemeral&&!message.is_error&&message.subtype==='success'){
      usage=await this.readContextUsage(stream);
     }
    }
    if(this.closed||this.closing)break;
    this.receive(message,usage);
    await this.waitForEvents();
    if(this.completed){this.close();break}
   }
  }catch{
   // SDK の例外には CLI stderr が含まれるため外へ渡さず、finally で既知の欠落診断だけを照合する。
  }finally{
   this.rejectPending(this.interrupted?new ClaudeRejected(false,true):this.canRetryMissingSession()&&this.missingSessionDiagnostic(stderr().trim())?new ClaudeSessionMissing():Error('Claude closed before acceptance'));
   if(this.interrupted&&!this.completed)this.finish('interrupted');
   stream.close();
   this.close();
  }
 }
 private signalClose(){if(this.closed)return;if((this.compacting||this.localCommand)&&this.interrupted&&!this.completed)this.finish('interrupted');this.closed=true;setImmediate(()=>this.onClose(this.child?.exitCode??null))}
 close(){if(this.closing||this.closed)return;this.closing=true;this.endPrompt?.();this.sdkQuery?.close();this.rejectPending(this.interrupted?new ClaudeRejected(false,true):Error('Connection closed'));if(this.termination)clearTimeout(this.termination);this.termination=null;if(this.child&&this.child.exitCode===null&&this.child.signalCode===null){this.child.kill('SIGTERM');this.termination=setTimeout(()=>this.child?.kill('SIGKILL'),3000);this.termination.unref()}else this.signalClose()}
}
