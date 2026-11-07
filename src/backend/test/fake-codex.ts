#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 1.2.3');process.exit(0)}
const send=(x:unknown)=>process.stdout.write(JSON.stringify(x)+'\n');
const configArg=(key:string)=>{
 const entry=process.argv.find((arg,index)=>process.argv[index-1]==='-c'&&arg.startsWith(key+'='));
 return entry===undefined?undefined:JSON.parse(entry.slice(key.length+1));
};
let turn='turn-1';
let threadId='thread-1';
type Call={tool:string;arguments:Record<string,unknown>};
type ToolReply={success:boolean;contentItems?:{text:string}[]};
let developerInstructions='';
let embedded:{script:Generator<Call,void,ToolReply>;call?:Call;results:unknown[];index:number;workflow:boolean}|null=null;
const embeddedEvent=(method:string,item:unknown)=>send({method,params:{threadId,turnId:turn,item}});
const nextEmbedded=(reply?:ToolReply)=>{
 if(!embedded)return;
 const step=embedded.script.next(reply!);
 if(step.done){send({method:'item/agentMessage/delta',params:{threadId,turnId:turn,itemId:'message-1',delta:embedded.workflow?'文書の確認が完了しました。':JSON.stringify(embedded.results)}});send({method:'turn/completed',params:{threadId,turn:{id:turn,status:'completed'}}});embedded=null;return}
 const call=embedded.call=step.value;
 const id=`embedded:${embedded.index}`;embeddedEvent('item/started',{type:'dynamicToolCall',id,tool:call.tool,arguments:call.arguments,status:'inProgress'});send({id,method:'item/tool/call',params:{threadId,turnId:turn,callId:id,...call}});
};
function* invoke(tool:string,args:Record<string,unknown>={},expectSuccess=true):Generator<Call,any,ToolReply>{
 const reply=yield {tool,arguments:args};
 if(reply.success!==expectSuccess)throw Error('Unexpected workflow tool result: '+tool);
 return JSON.parse(reply.contentItems![0]!.text);
}
function* lastDocumentItem(name:string):Generator<Call,any,ToolReply>{
 let result=yield* invoke('read_document',{name});
 while(result.next!==null)result=yield* invoke('read_document',{name,...result.next});
 return result;
}
function* workflow(text:string):Generator<Call,void,ToolReply>{
 if(developerInstructions.startsWith('完成した knowledge.md')){
  const knowledge=yield* lastDocumentItem('knowledge.md');
  const common=yield* invoke('read_document',{name:'common'});
  yield* invoke('edit_document',{name:'common',revision:common.revision,update_id:'instruction',edits:[{
   text:'- 検証の根拠を記録する。',reason:'再利用できる学びを反映する',sources:[{...knowledge.item.source,text:knowledge.item.text}]
  }]});
  yield* invoke('finish_instruction_update',{reason:'根拠の記録を共通化する'});
 }else if(developerInstructions.includes('# 終了')){
  if(process.env.FAKE_CODEX_WORKFLOW==='without-finish')return;
  const review=yield* lastDocumentItem('retrospective.md');
  const knowledge=yield* invoke('read_document',{name:'knowledge.md'});
  const version=yield* invoke('edit_document',{name:'knowledge.md',revision:knowledge.revision,update_id:'knowledge',edits:[{
   text:'検証の根拠を保つ。',reason:'反省会の学びを記録する',sources:[{...review.item.source,text:review.item.text}]
  }]});
  yield* invoke('finish_knowledge',{revision:version.revision,reason:'検証の根拠を保つため'});
 }else if(text.startsWith('全フェーズの資料')){
  let documented=false;
  while(true){
   let entry=yield* invoke('review_next');
   if(entry.done)break;
   if(!documented&&entry.source&&entry.text.trim()){
    const review=yield* invoke('read_document',{name:'retrospective.md'});
    yield* invoke('edit_document',{name:'retrospective.md',revision:review.revision,update_id:'review',edits:[{
     text:'検証の根拠を見直す。',reason:'全件精査で確認した根拠',sources:[{...entry.source,text:entry.text}]
    }]});
    documented=true;
   }
   while(entry.next!==null)entry=yield* invoke('review_next',{offset:entry.next});
   yield* invoke('record_review',{id:entry.id,finding:'確認済み'});
  }
 }else if(developerInstructions.includes('# 仕様整理')||developerInstructions.includes('# 実装手順')){
  const specifications=developerInstructions.includes('# 仕様整理');
  const source=yield* lastDocumentItem(specifications?'requirements.md':'documents.md');
  const target=specifications?'documents.md':'implementation.md';
  const document=yield* invoke('read_document',{name:target});
  yield* invoke('edit_document',{name:target,revision:document.revision,update_id:target,edits:[{
   text:specifications?'入力を検証する仕様。':'1. 入力を検証してテストする。',reason:'先行フェーズで合意した内容',sources:[{...source.item.source,text:source.item.text}]
  }]});
 }else if(developerInstructions.includes('# 実装中')){
  yield* lastDocumentItem('implementation.md');
  yield* invoke('finish_execution',{outcome:'completed',reason:'実装と検証を確認した'});
 }else if(developerInstructions.includes('# 要件定義')){
  const current=yield* invoke('read_document',{name:'requirements.md'});
  const listed=yield* invoke('list_chat_sources',{phase:'requirements'});
  const source=listed.sources.find((item:any)=>item.excerpt===text);
  const original=yield* invoke('read_source',{kind:source.kind,id:source.id});
  const sources=[{kind:source.kind,id:source.id,text:original.text}];
  const heading='\n## 入力の検証\n\n';
  yield* invoke('edit_document',{name:'requirements.md',revision:current.revision,update_id:'heading-without-source',edits:[{text:heading}]},false);
  const args={name:'requirements.md',revision:current.revision,update_id:'requirement',edits:[{
   text:heading,reason:'入力検証の要件をまとめる',sources
  },{
   text:'入力値を検証する。',reason:'ユーザーの依頼を整理する',sources
  }]};
  yield* invoke('edit_document',{...args,edits:[{...args.edits[0],sources:[{kind:source.kind,id:source.id,text:'存在しない引用'}]}]},false);
  yield* invoke('edit_document',args);
 }
}
for await (const line of createInterface({input:process.stdin})) {
 if(embedded){const response=JSON.parse(line);if(typeof response.id==='string'&&response.id.startsWith('embedded:')){if(process.env.FAKE_CODEX_LOG)appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify(response)+'\n');const call=embedded.call!;if(!embedded.workflow)embedded.results.push(response.result);embeddedEvent('item/completed',{type:'dynamicToolCall',id:response.id,tool:call.tool,arguments:call.arguments,contentItems:response.result?.contentItems,status:response.result?.success?'completed':'failed'});embedded.index++;nextEmbedded(response.result);continue}}
 const msg=JSON.parse(line);if(process.env.FAKE_CODEX_LOG)appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify(msg)+'\n');if(msg.id==='approval-test'){if(msg.error?.code===-32601)send({method:'item/agentMessage/delta',params:{threadId,turnId:turn,itemId:'message-1',delta:' denied'}});continue}if(!msg.id)continue;
 if(msg.method==='initialize')send({id:msg.id,result:{}});
 else if(msg.method==='account/read')send({id:msg.id,result:{account:{type:process.env.FAKE_AUTH??'chatgpt',email:process.env.FAKE_CODEX_EMAIL??'example@example.test'}}});
 else if(msg.method==='account/rateLimits/read')send({id:msg.id,result:{rateLimits:process.env.FAKE_CODEX_RATE_LIMIT ? {primary:{usedPercent:Number(process.env.FAKE_CODEX_RATE_LIMIT),windowDurationMins:300}} : null}});
 else if(msg.method==='config/read')send({id:msg.id,result:{config:{
  web_search:'disabled',mcp_servers:{},sandbox_mode:configArg('sandbox_mode'),
  sandbox_workspace_write:{
   network_access:process.env.FAKE_CODEX_UNSAFE_SANDBOX==='1'||configArg('sandbox_workspace_write.network_access'),
   exclude_slash_tmp:configArg('sandbox_workspace_write.exclude_slash_tmp'),
   exclude_tmpdir_env_var:configArg('sandbox_workspace_write.exclude_tmpdir_env_var'),
   writable_roots:configArg('sandbox_workspace_write.writable_roots'),
  },
  features:{shell_tool:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='shell_tool'),apps:false,plugins:false,multi_agent:false,browser_use:false,computer_use:false,code_mode_host:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='code_mode_host'),hooks:false,skill_mcp_dependency_install:false},
 }}});
 else if(msg.method==='model/list')send({id:msg.id,result:{data:[{model:'model-a',displayName:'Model A'}],nextCursor:null}});
 else if(msg.method==='thread/start'||msg.method==='thread/resume'){
  const mode=process.env.FAKE_CODEX_RESUME;
  if(msg.method==='thread/resume'&&mode==='missing'&&msg.params.threadId==='thread-1'){
   send({id:msg.id,error:{code:-32600,message:`no rollout found for thread id ${msg.params.threadId}`}});continue;
  }
  if(msg.method==='thread/resume'&&mode==='reject'){
   send({id:msg.id,error:{code:-32600,message:'Invalid model configuration'}});continue;
  }
  threadId=msg.params.threadId??(mode==='missing'?'thread-replacement':'thread-1');
  developerInstructions=msg.params.developerInstructions??'';
  send({id:msg.id,result:{thread:{id:threadId,sessionId:threadId==='thread-1'?'session-1':'session-replacement',ephemeral:msg.params.ephemeral===true}}});
 }
 else if(msg.method==='thread/compact/start'){
  const action=process.env.FAKE_CODEX_COMPACT_ACTION??'complete';
  if(action==='reject'){send({id:msg.id,error:{code:-32600,message:'rejected'}});continue}
  if(action==='disconnect-before-ack')process.exit(0);
  const threadId=msg.params.threadId;
  const event=(method:string,extra:Record<string,unknown>)=>send({method,params:{threadId,turnId:turn,...extra}});
  if(action!=='no-turn')event('turn/started',{turn:{id:turn}});
  const contextUsage=(totalTokens:number)=>event('thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens},modelContextWindow:100_000}});
  const complete=()=>{
   if(process.env.FAKE_CODEX_CONTEXT)contextUsage(80_000);
   event('item/completed',{item:{id:'compact-1',type:'contextCompaction'}});
   if(process.env.FAKE_CODEX_CONTEXT==='fresh')contextUsage(10_000);
   if(action==='boundary-disconnect'){setTimeout(()=>process.exit(0),10);return}
   event('turn/completed',{turn:{id:turn,status:action==='boundary-failure'?'failed':action==='boundary-interrupt'?'interrupted':'completed'}});
  };
  if(action==='early'){complete();setTimeout(()=>send({id:msg.id,result:{}}),100);continue}
  send({id:msg.id,result:{}});
  if(action==='disconnect'){setTimeout(()=>process.exit(0),20);continue}
  if(action==='wait'||action==='no-turn')continue;
  if(action==='unrelated'){
   send({method:'item/completed',params:{threadId:'wrong-thread',turnId:turn,item:{id:'wrong-thread',type:'contextCompaction'}}});
   event('item/completed',{turnId:'wrong-turn',item:{id:'wrong-turn',type:'contextCompaction'}});
  }
  event('item/started',{item:{id:'compact-1',type:'contextCompaction'}});
  setTimeout(()=>{if(action==='fail')event('turn/completed',{turn:{id:turn,status:'failed'}});else if(action==='missing-boundary')event('turn/completed',{turn:{id:turn,status:'completed'}});else complete()},120);
 }
 else if(msg.method==='turn/start'||msg.method==='review/start'){
  const text=process.env.FAKE_CODEX_TURN_ACTION??(msg.method==='review/start'?'review':msg.params.input[0].text);
  if(process.env.FAKE_CODEX_RATE_LIMIT)send({method:'account/rateLimits/updated',params:{rateLimits:{primary:{usedPercent:Number(process.env.FAKE_CODEX_RATE_LIMIT),windowDurationMins:300,resetsAt:2_000_000_000}}}});
  if(text==='write documents'&&!['shell_tool','code_mode_host'].every(feature=>process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]===feature))){send({id:msg.id,error:{code:-32600,message:'Required tools disabled'}});continue}
  if(text==='write documents'){writeFileSync(join(msg.params.cwd,'requirements.md'),'# Updated requirements\n');writeFileSync(join(msg.params.cwd,'implementation.md'),'# Updated plan\n')}
  if(text==='disconnect')process.exit(0);
  if(text==='reject model'){send({id:msg.id,error:{code:-32600,data:{code:'model_not_found'},message:'Model unavailable'}});continue}
  if(text==='reject'){send({id:msg.id,error:{code:-32600,message:'rejected'}});continue}
  if(text==='event tools'||process.env.FAKE_EMBEDDED_CALLS||process.env.FAKE_CODEX_WORKFLOW){
   const range=msg.params.input.find((input:any)=>input.text.startsWith('Beni project event review range:'))?.text.match(/after (\d+), through (\d+)/);
   const calls:Call[]=process.env.FAKE_EMBEDDED_CALLS?JSON.parse(process.env.FAKE_EMBEDDED_CALLS):[{tool:'list_events',arguments:{after:Number(range?.[1]??0),through:Number(range?.[2]??0),limit:1}},{tool:'acknowledge_events',arguments:{through:Number(range?.[2]??0)}}];
   const workflowMode=!!process.env.FAKE_CODEX_WORKFLOW;
   embedded={script:workflowMode?workflow(text):(function*(){yield* calls})(),results:[],index:0,workflow:workflowMode};
   send({method:'turn/started',params:{threadId,turn:{id:turn}}});nextEmbedded();send({id:msg.id,result:{turn:{id:turn}}});continue;
  }
  if(['tools','unfinished tools','duplicate tools','failed tools','large tools'].includes(text)){
   if(process.env.FAKE_CODEX_WRITE_KNOWLEDGE==='1')writeFileSync(join(msg.params.cwd,'knowledge.md'),'# プロジェクトの学び\n\n- テストは専用の入力を使う。\n');
   send({method:'turn/started',params:{threadId,turn:{id:turn}}});
   const event=(method:string,extra:Record<string,unknown>)=>send({method,params:{threadId,turnId:turn,...extra}});
   event('item/started',{item:{type:'agentMessage',id:'before',text:''}});event('item/agentMessage/delta',{itemId:'before',delta:'Before tool'});
   event('item/completed',{item:{type:'agentMessage',id:'before',text:'Before tool'}});
   event('item/started',{item:{type:'commandExecution',id:'command-1',command:'echo example',aggregatedOutput:null,status:'inProgress'}});
   send({id:msg.id,result:{turn:{id:turn}}});
   if(text==='unfinished tools'){setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:turn,status:'failed'}}}),30);continue}
   if(text==='duplicate tools')event('item/started',{item:{type:'commandExecution',id:'command-1',command:'echo example',status:'inProgress'}});
   const large=text==='large tools';
   const command=large?'🛠"\\'.repeat(220_000):'echo example';
   const output=large?'TOOL_OUTPUT_PRIVATE\u0001🧪"\\'.repeat(100_000)+'OUTPUT_TAIL':'example\n';
   setTimeout(()=>{event('item/completed',{item:{type:'commandExecution',id:'command-1',command,aggregatedOutput:output,exitCode:text==='failed tools'?7:0,status:text==='failed tools'?'failed':'completed'}});if(text==='duplicate tools')event('item/completed',{item:{type:'commandExecution',id:'command-1',command:'echo example',aggregatedOutput:'example\n',status:'completed'}});event('item/agentMessage/delta',{itemId:'after',delta:'After tool'});event('item/completed',{item:{type:'agentMessage',id:'after',text:'After tool'}});send({method:'turn/completed',params:{threadId,turn:{id:turn,status:'completed'}}})},150);continue
  }
  if(text==='approval')send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{}});
  if(msg.method==='review/start'&&process.env.FAKE_CODEX_REVIEW){
   const review='確認した差分に指摘はありません。';
   send({method:'turn/started',params:{threadId,turn:{id:turn}}});
   if(process.env.FAKE_CODEX_REVIEW==='streamed')send({method:'item/agentMessage/delta',params:{threadId,turnId:turn,itemId:'review-message',delta:review}});
   embeddedEvent('item/started',{type:'exitedReviewMode',id:turn,review});
   embeddedEvent('item/completed',{type:'exitedReviewMode',id:turn,review});
   send({method:'turn/completed',params:{threadId,turn:{id:turn,status:'completed'}}});
   send({id:msg.id,result:{turn:{id:turn},reviewThreadId:threadId}});
   continue;
  }
  send({method:'turn/started',params:{threadId,turn:{id:turn}}});
  send({method:'item/agentMessage/delta',params:{threadId,turnId:turn,itemId:'message-1',delta:'Hello'}});
  if(process.env.FAKE_CODEX_CONTEXT){
   const usage=(extra:Record<string,unknown>)=>send({method:'thread/tokenUsage/updated',params:{
    threadId,turnId:turn,tokenUsage:{last:{totalTokens:22_000},total:{totalTokens:330_000},modelContextWindow:100_000},...extra,
   }});
   usage(process.env.FAKE_CODEX_CONTEXT==='missing-window'?{tokenUsage:{last:{totalTokens:22_000},modelContextWindow:null}}:{});
   usage({threadId:'wrong-thread',tokenUsage:{last:{totalTokens:90_000},modelContextWindow:100_000}});
   usage({turnId:'wrong-turn',tokenUsage:{last:{totalTokens:80_000},modelContextWindow:100_000}});
  }
  send({id:msg.id,result:{turn:{id:turn}}});
  if(text!=='wait')setTimeout(()=>send({method:'turn/completed',params:{threadId,turn:{id:turn,status:text==='fail'?'failed':'completed'}}}),30);
 } else if(msg.method==='turn/interrupt') {send({id:msg.id,result:{}});send({method:'turn/completed',params:{threadId,turn:{id:turn,status:'interrupted'}}})}
}
