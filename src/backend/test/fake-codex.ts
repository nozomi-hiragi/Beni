#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 1.2.3');process.exit(0)}
const send=(x:unknown)=>process.stdout.write(JSON.stringify(x)+'\n');
let turn='turn-1';
let embedded:{calls:{tool:string;arguments:unknown}[];results:unknown[];index:number}|null=null;
const embeddedEvent=(method:string,item:unknown)=>send({method,params:{threadId:'thread-1',turnId:turn,item}});
const nextEmbedded=()=>{
 if(!embedded)return;
 const call=embedded.calls[embedded.index];
 if(!call){send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,itemId:'message-1',delta:JSON.stringify(embedded.results)}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'completed'}}});embedded=null;return}
 const id=`embedded:${embedded.index}`;embeddedEvent('item/started',{type:'dynamicToolCall',id,tool:call.tool,arguments:call.arguments,status:'inProgress'});send({id,method:'item/tool/call',params:{threadId:'thread-1',turnId:turn,callId:id,...call}});
};
for await (const line of createInterface({input:process.stdin})) {
 if(embedded){const response=JSON.parse(line);if(typeof response.id==='string'&&response.id.startsWith('embedded:')){if(process.env.FAKE_CODEX_LOG)appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify(response)+'\n');const call=embedded.calls[embedded.index];embedded.results.push(response.result);embeddedEvent('item/completed',{type:'dynamicToolCall',id:response.id,tool:call.tool,arguments:call.arguments,contentItems:response.result?.contentItems,status:response.result?.success?'completed':'failed'});embedded.index++;nextEmbedded();continue}}
 const msg=JSON.parse(line);if(process.env.FAKE_CODEX_LOG)appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify(msg)+'\n');if(msg.id==='approval-test'){if(msg.error?.code===-32601)send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,itemId:'message-1',delta:' denied'}});continue}if(!msg.id)continue;
 if(msg.method==='initialize')send({id:msg.id,result:{}});
 else if(msg.method==='account/read')send({id:msg.id,result:{account:{type:process.env.FAKE_AUTH??'chatgpt'}}});
 else if(msg.method==='config/read')send({id:msg.id,result:{config:{web_search:'disabled',mcp_servers:{},features:{shell_tool:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='shell_tool'),apps:false,plugins:false,multi_agent:false,browser_use:false,computer_use:false,code_mode_host:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='code_mode_host'),hooks:false,skill_mcp_dependency_install:false}}}});
 else if(msg.method==='model/list')send({id:msg.id,result:{data:[{model:'model-a',displayName:'Model A'}],nextCursor:null}});
 else if(msg.method==='thread/start'||msg.method==='thread/resume')send({id:msg.id,result:{thread:{id:msg.params.threadId??'thread-1',sessionId:'session-1'}}});
 else if(msg.method==='thread/compact/start'){
  const action=process.env.FAKE_CODEX_COMPACT_ACTION??'complete';
  if(action==='reject'){send({id:msg.id,error:{code:-32600,message:'rejected'}});continue}
  if(action==='disconnect-before-ack')process.exit(0);
  const threadId=msg.params.threadId;
  const event=(method:string,extra:Record<string,unknown>)=>send({method,params:{threadId,turnId:turn,...extra}});
  if(action!=='no-turn')event('turn/started',{turn:{id:turn}});
  const complete=()=>{event('item/completed',{item:{id:'compact-1',type:'contextCompaction'}});if(action==='boundary-disconnect'){setTimeout(()=>process.exit(0),10);return}event('turn/completed',{turn:{id:turn,status:action==='boundary-failure'?'failed':action==='boundary-interrupt'?'interrupted':'completed'}})};
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
  if(text==='write documents'&&!['shell_tool','code_mode_host'].every(feature=>process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]===feature))){send({id:msg.id,error:{code:-32600,message:'Required tools disabled'}});continue}
  if(text==='write documents'){writeFileSync(join(msg.params.cwd,'requirements.md'),'# Updated requirements\n');writeFileSync(join(msg.params.cwd,'implementation.md'),'# Updated plan\n')}
  if(text==='disconnect')process.exit(0);
  if(text==='reject model'){send({id:msg.id,error:{code:-32600,data:{code:'model_not_found'},message:'Model unavailable'}});continue}
  if(text==='reject'){send({id:msg.id,error:{code:-32600,message:'rejected'}});continue}
  if(text==='event tools'||process.env.FAKE_EMBEDDED_CALLS){
   const range=msg.params.input.find((input:any)=>input.text.startsWith('Beni project event review range:'))?.text.match(/after (\d+), through (\d+)/);
   embedded={calls:process.env.FAKE_EMBEDDED_CALLS?JSON.parse(process.env.FAKE_EMBEDDED_CALLS):[{tool:'list_events',arguments:{after:Number(range?.[1]??0),through:Number(range?.[2]??0),limit:1}},{tool:'acknowledge_events',arguments:{through:Number(range?.[2]??0)}}],results:[],index:0};
   send({method:'turn/started',params:{threadId:'thread-1',turn:{id:turn}}});send({id:msg.id,result:{turn:{id:turn}}});nextEmbedded();continue;
  }
  if(['tools','unfinished tools','duplicate tools','failed tools','large tools'].includes(text)){
   if(process.env.FAKE_CODEX_WRITE_KNOWLEDGE==='1')writeFileSync(join(msg.params.cwd,'knowledge.md'),'# プロジェクトの学び\n\n- テストは専用の入力を使う。\n');
   send({method:'turn/started',params:{threadId:'thread-1',turn:{id:turn}}});
   const event=(method:string,extra:Record<string,unknown>)=>send({method,params:{threadId:'thread-1',turnId:turn,...extra}});
   event('item/started',{item:{type:'agentMessage',id:'before',text:''}});event('item/agentMessage/delta',{itemId:'before',delta:'Before tool'});
   event('item/started',{item:{type:'commandExecution',id:'command-1',command:'echo example',aggregatedOutput:null,status:'inProgress'}});
   send({id:msg.id,result:{turn:{id:turn}}});
   if(text==='unfinished tools'){setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'failed'}}}),30);continue}
   if(text==='duplicate tools')event('item/started',{item:{type:'commandExecution',id:'command-1',command:'echo example',status:'inProgress'}});
   const large=text==='large tools';
   const command=large?'🛠"\\'.repeat(220_000):'echo example';
   const output=large?'TOOL_OUTPUT_PRIVATE\u0001🧪"\\'.repeat(100_000)+'OUTPUT_TAIL':'example\n';
   setTimeout(()=>{event('item/completed',{item:{type:'commandExecution',id:'command-1',command,aggregatedOutput:output,exitCode:text==='failed tools'?7:0,status:text==='failed tools'?'failed':'completed'}});if(text==='duplicate tools')event('item/completed',{item:{type:'commandExecution',id:'command-1',command:'echo example',aggregatedOutput:'example\n',status:'completed'}});event('item/agentMessage/delta',{itemId:'after',delta:'After tool'});event('item/completed',{item:{type:'agentMessage',id:'after',text:'After tool'}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'completed'}}})},150);continue
  }
  if(text==='approval')send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{}});
  send({method:'turn/started',params:{threadId:'thread-1',turn:{id:turn}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,itemId:'message-1',delta:'Hello'}});
  send({id:msg.id,result:{turn:{id:turn}}});
  if(text!=='wait')setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:text==='fail'?'failed':'completed'}}}),30);
 } else if(msg.method==='turn/interrupt') {send({id:msg.id,result:{}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'interrupted'}}})}
}
