#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const rawArgs=process.argv.slice(2);
// SDK が使う --flag=value 形式も同じ CLI 引数として検証する。rawArgs は実際の argv を保持する。
const args=rawArgs.flatMap(arg=>{const match=arg.match(/^(--[^=]+)=(.*)$/s);return match?[match[1]!,match[2]!]:[arg]});
if(args.includes('--version')){console.log(`${process.env.FAKE_CLAUDE_VERSION??'2.1.292'} (Claude Code)`);process.exit(0)}
if(args[0]==='auth'){
 const method=process.env.FAKE_CLAUDE_AUTH??'claude.ai';
 if(method==='malformed'){console.log('invalid');process.exit(0)}
 console.log(JSON.stringify({loggedIn:method!=='none',authMethod:method,apiProvider:process.env.FAKE_CLAUDE_PROVIDER??'firstParty',email:'example@example.test',accountId:'fictional-account'}));process.exit(method==='none'?1:0);
}
let resultSent=false;
const send=(value:any)=>{
 if(value.type==='result')resultSent=true;
 process.stdout.write(JSON.stringify(value.type==='result'&&value.is_error?{errors:[],...value}:value)+'\n');
};
const queued:any[]=[];
let waiting:((value:IteratorResult<any>)=>void)|null=null;
let inputEnded=false;
let initialization:any=null;
const input=args.includes('--input-format')?{next:()=>queued.length?Promise.resolve({done:false,value:queued.shift()}):inputEnded?Promise.resolve({done:true,value:undefined}):new Promise<IteratorResult<any>>(resolve=>{waiting=resolve}),return:()=>{}}:null;
if(input)void(async()=>{
 for await(const line of createInterface({input:process.stdin})){
  const message=JSON.parse(line);
  if(message.type==='control_request'&&message.request.subtype==='initialize'){
   initialization=message.request;
   send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});continue;
  }
  if(message.type==='control_request'&&message.request.subtype==='interrupt'){
   send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});
   send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Interrupted']});process.exit(0);
  }
  if(message.type==='control_request'&&message.request.subtype==='get_context_usage'){
   const mode=process.env.FAKE_CLAUDE_CONTEXT_SUMMARY;
   if(mode==='silent')continue;
   const request_id=message.request_id;
   const response=mode&&resultSent&&message.request.detail==='summary'
    ?{subtype:'success',request_id,response:{totalTokens:mode==='invalid'?-1:24_000,maxTokens:170_000,rawMaxTokens:200_000}}
    :{subtype:'error',request_id,error:'Summary unavailable'};
   send({type:'control_response',response});
   continue;
  }
  const currentWaiting=waiting as ((value:IteratorResult<any>)=>void)|null;
  if(currentWaiting){waiting=null;currentWaiting({done:false,value:message})}else queued.push(message);
 }
 inputEnded=true;
 const finalWaiting=waiting as ((value:IteratorResult<any>)=>void)|null;
 if(finalWaiting){waiting=null;finalWaiting({done:true,value:undefined})}
})();
let prompt='';
if(input){
 while(true){const line=await input.next();if(line.done)process.exit(1);const message=line.value;
  if(message.type==='control_request'&&message.request.subtype==='initialize'){send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});continue}
  if(message.type==='user'){prompt=typeof message.message.content==='string'?message.message.content:message.message.content.map((block:any)=>block.text??'').join('');break}
 }
}else prompt=await Bun.stdin.text();
let action=prompt.split('\n\n')[0];
if(action==='stubborn'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000)}
const builtin=action.match(/^\/(context|usage|code-review|simplify|security-review|recap)(?: |$)/)?.[1];
const session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
if(process.env.FAKE_CLAUDE_LOG)appendFileSync(process.env.FAKE_CLAUDE_LOG,JSON.stringify({args,rawArgs,initialization,pid:process.pid,cwd:process.cwd(),prompt,session,subprocessEnvScrub:process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB})+'\n');
const tools=args[args.indexOf('--tools')+1]?.split(',')??[];
const settings=JSON.parse(args[args.indexOf('--settings')+1]??'{}');
if(tools.includes('Bash')&&process.env.FAKE_CLAUDE_SANDBOX_UNAVAILABLE==='1'&&settings.sandbox?.failIfUnavailable===true){console.error('Sandbox is required but unavailable');process.exit(1)}
const resumeMissing=process.env.FAKE_CLAUDE_RESUME_MISSING;
if(args.includes('--resume')&&resumeMissing){
 const diagnostic=`No conversation found with session ID: ${session}`;
 if(resumeMissing==='stderr'){console.error(diagnostic);process.exit(1)}
 if(resumeMissing==='after-init')send({type:'system',subtype:'init',session_id:session});
 send({type:'result',subtype:'error_during_execution',is_error:true,result:diagnostic});
 process.exit(1);
}
if(action==='disconnect'||action==='early exit')process.exit(1);
if(action==='malformed'){console.log('invalid');process.exit(1)}
if(action==='reject model'){send({type:'result',subtype:'error_during_execution',is_error:true,error:{code:'model_not_found'}});process.exit(1)}
if(action==='reject assistant model'){send({type:'assistant',error:'model_not_found',message:{id:'error',content:[]}});send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Request failed']});process.exit(1)}
if(action==='unknown model error'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['The selected model was not found']});process.exit(1)}
if(action==='reject'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Request failed']});process.exit(1)}
if(process.env.FAKE_CLAUDE_COMMAND!=='no-init')send({type:'system',subtype:'init',session_id:session,...(process.env.FAKE_CLAUDE_COMMAND==='not-listed'?{slash_commands:['compact']}:builtin?{slash_commands:[builtin]}:{})});
if(process.env.FAKE_CLAUDE_RATE_LIMIT)send({type:'rate_limit_event',session_id:session,rate_limit_info:{status:'allowed',...(process.env.FAKE_CLAUDE_RATE_LIMIT==='missing'?{}:{utilization:Number(process.env.FAKE_CLAUDE_RATE_LIMIT)}),rateLimitType:'seven_day',resetsAt:2_000_000_100}});
if(process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS)await Bun.sleep(Number(process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS));
if(action==='/compact'){
 const mode=process.env.FAKE_CLAUDE_COMPACT??'success';
 const result=(success:boolean,text='Compaction result')=>send({type:'result',subtype:success?'success':'error_during_execution',is_error:!success,result:text,session_id:session});
 if(args.includes('--disable-slash-commands')||mode==='unavailable'){result(true,"/compact isn't available in this environment.");process.exit(0)}
 if(mode==='not-needed'){result(true,'Not enough messages to compact.');process.exit(0)}
 if(mode==='unknown-reason'){result(true,'Private compaction failure details');process.exit(0)}
 if(mode==='known-failure'){result(false,'Not enough messages to compact.');process.exit(0)}
 if(mode==='wait'){
  process.on('SIGINT',()=>{result(false);process.exit(0)});setInterval(()=>{},1000);
 }else{
  if(mode==='disconnect')process.exit(1);
  // 圧縮時に通常の応答・ツール・result fallback を流さないことを検証する。
  send({type:'assistant',session_id:session,message:{id:'compact-summary',content:[{type:'text',text:'Private summary'},{type:'tool_use',id:'compact-tool',name:'Read',input:{}}]}});
  const boundary={type:'system',subtype:'compact_boundary',session_id:session,compact_metadata:{trigger:mode==='auto'?'auto':'manual',pre_tokens:100}};
  if(mode==='foreign-parent')send({...boundary,parent_tool_use_id:'foreign'});
  else if(mode==='foreign-session')send({...boundary,session_id:'20000000-0000-4000-8000-000000000002'});
  else if(!['no-boundary','failure'].includes(mode))send(boundary);
  if(mode==='disconnect-after-boundary')process.exit(1);
  if(mode==='wait-after-boundary'){
   process.on('SIGINT',()=>{result(false);process.exit(0)});setInterval(()=>{},1000);
  }else{result(!['failure','failure-after-boundary'].includes(mode));process.exit(0)}
 }
 await new Promise(()=>{});
}

if(builtin){
 const mode=process.env.FAKE_CLAUDE_COMMAND??'success';
 const result=(output:unknown,extra={})=>send({type:'result',subtype:'success',is_error:false,result:output,session_id:session,...extra});
 if(args.includes('--disable-slash-commands')||mode==='unavailable'){result(`/${builtin} isn't available in this environment.`);process.exit(0)}
 if(['context','usage'].includes(builtin)){
  if(mode==='wait'){process.on('SIGINT',()=>{send({type:'result',subtype:'error_during_execution',is_error:true,session_id:session});process.exit(0)});setInterval(()=>{},1000);await new Promise(()=>{})}
  if(mode==='disconnect')process.exit(1);
  if(mode==='fallback')send({type:'assistant',session_id:session,message:{id:'fallback',content:[{type:'text',text:'Model fallback must stay private'},{type:'tool_use',id:'private-tool',name:'Read',input:{}}]}});
  if(mode==='stream-fallback')send({type:'stream_event',session_id:session,event:{type:'content_block_start',index:0,content_block:{type:'text',text:'Private stream'}}});
  if(mode==='parent-noise'){
   send({type:'assistant',session_id:'20000000-0000-4000-8000-000000000002',parent_tool_use_id:'foreign',message:{id:'foreign',content:[{type:'text',text:'Private child response'}]}});
   result('Private child result',{parent_tool_use_id:'foreign'});
  }
  const output=['oversize','legacy-oversize'].includes(mode)?'x'.repeat(65537):mode==='multibyte-oversize'?'界'.repeat(21846):mode==='limit'?'x'.repeat(65536):mode==='empty'?'':mode==='non-text'?{}:`${builtin==='context'?'Context usage: 12%':'Usage: 3 fictional requests'}\n`;
  if(!mode.startsWith('legacy')){
   const synthetic:any={type:'assistant',session_id:session,parent_tool_use_id:null,local_command_run:{command:builtin,args:''},local_command_source:'<local-command-stdout>Raw fixture that must not be displayed</local-command-stdout>',message:{id:'local-result',role:'assistant',content:mode==='string-content'?output:[{type:'text',text:output}]},...(builtin==='usage'?{usage_report:{fictional:true}}:{context_usage:{fictional:true}})};
   if(builtin==='context'&&process.env.FAKE_CLAUDE_CONTEXT_REPORT){
    synthetic.context_usage={total_tokens:24_000,raw_max_tokens:200_000,percentage:12};
   }
   if (builtin === 'usage' && process.env.FAKE_CLAUDE_USAGE_REPORT && args.includes('--no-session-persistence')) {
    synthetic.usage_report = {rate_limits:{limits:[
     {kind:'session',group:'session',percent:0,resets_at:null},
     {kind:'weekly_all',group:'weekly',percent:45,resets_at:new Date(2_000_000_100_000).toISOString()},
    ]}};
   }
   if(mode==='text-blocks'&&typeof output==='string')synthetic.message.content=[{type:'text',text:output.slice(0,8)},{type:'text',text:output.slice(8)}];
   if(mode==='mixed-tool')synthetic.message.content.push({type:'tool_use',id:'private-tool',name:'Read',input:{}});
   if(mode==='invalid-content')synthetic.message.content={text:output};
   if(mode==='missing-source')delete synthetic.local_command_source;
   if(mode==='non-string-source')synthetic.local_command_source={text:'Raw private source'};
   if(mode==='different-command')synthetic.local_command_run.command=builtin==='usage'?'context':'usage';
   if(mode==='alias-command')synthetic.local_command_run.command='/'+builtin;
   if(mode==='nonempty-args')synthetic.local_command_run.args='extra';
   if(mode==='missing-args')delete synthetic.local_command_run.args;
   if(mode==='missing-session')delete synthetic.session_id;
   if(mode==='foreign-synthetic')synthetic.session_id='20000000-0000-4000-8000-000000000002';
   if(mode.startsWith('outcome-'))synthetic.local_command_outcome=mode==='outcome-null'?null:{kind:mode.slice('outcome-'.length)};
   if(mode==='parent-only')synthetic.parent_tool_use_id='foreign';
   if(mode==='empty-parent')synthetic.parent_tool_use_id='';
   send(synthetic);
   if(mode==='combined-oversize')send({...synthetic,message:{...synthetic.message,content:[{type:'text',text:'x'.repeat(65536)}]}});
   if(mode==='disconnect-after-synthetic')process.exit(1);
   if(mode==='wait-after-synthetic'){process.on('SIGINT',()=>{send({type:'result',subtype:'error_during_execution',is_error:true,session_id:session});process.exit(0)});setInterval(()=>{},1000);await new Promise(()=>{})}
  }
  result(mode.startsWith('legacy')||mode==='duplicate-result'?output:'',mode==='foreign-session'?{session_id:'20000000-0000-4000-8000-000000000002'}:mode==='failure'?{is_error:true,subtype:'error_during_execution'}:{});process.exit(mode==='failed-exit'?1:0);
 }
 // 組み込み生成コマンドも通常チャットと同じツール stream を返す。
 action='tools';
}
const stream=(event:unknown)=>send({type:'stream_event',event,session_id:session,parent_tool_use_id:null});
const start=(id:string)=>stream({type:'message_start',message:{id}});
const text=(index:number,value:string)=>{stream({type:'content_block_start',index,content_block:{type:'text',text:''}});stream({type:'content_block_delta',index,delta:{type:'text_delta',text:value}});stream({type:'content_block_stop',index})};
const complete=(id:string,content:unknown[])=>send({type:'assistant',message:{id,content},parent_tool_use_id:null});
if(action==='result only'){send({type:'result',subtype:'success',is_error:false,result:'Final only',session_id:session});process.exit(0)}
if(action==='discuss invalid model'){send({type:'result',subtype:'success',is_error:false,result:'This explains an invalid model error.',error:{code:'model_not_found'},session_id:session});process.exit(0)}
if(action==='event tools'||action==='early embedded tool'||process.env.FAKE_EMBEDDED_CALLS){
 if(!input)throw Error('Missing SDK stream');
 const range=prompt.match(/Beni project event review range: after (\d+), through (\d+)/);
 const calls=process.env.FAKE_EMBEDDED_CALLS?JSON.parse(process.env.FAKE_EMBEDDED_CALLS):[{tool:'list_events',arguments:{after:Number(range?.[1]??0),through:Number(range?.[2]??0),limit:1}},{tool:'acknowledge_events',arguments:{through:Number(range?.[2]??0)}}];
 const results=[];
 for(const [index,call] of calls.entries()){
  const id=`embedded:${index}`;
  if(action!=='early embedded tool'){start(id);stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id,name:`mcp__beni__${call.tool}`,input:call.arguments}});complete(id,[{type:'tool_use',id,name:`mcp__beni__${call.tool}`,input:call.arguments}])}
  send({type:'control_request',request_id:id,request:{subtype:'mcp_message',server_name:'beni',message:{jsonrpc:'2.0',id:index,method:'tools/call',params:{name:call.tool,arguments:call.arguments}}}});
  while(true){const line=await input.next();if(line.done)process.exit(1);const message=line.value;if(message.type!=='control_response'||message.response.request_id!==id)continue;const response=message.response.response?.mcp_response;const result=response?.result??{content:[{type:'text',text:JSON.stringify({error:'Embedded tool request rejected or unavailable'})}],isError:true};results.push(result);send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:result.content,is_error:result.isError}]}});break}
 }
 start('results');text(0,JSON.stringify(results));complete('results',[{type:'text',text:JSON.stringify(results)}]);
}else if(action==='run command'){
 const sandbox=settings.sandbox;
 if(!tools.includes('Bash')||sandbox?.enabled!==true||sandbox.failIfUnavailable!==true||sandbox.allowUnsandboxedCommands!==false||sandbox.network?.strictAllowlist!==true||!sandbox.network?.deniedDomains?.includes('*')){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Sandboxed Bash is not available']});process.exit(1)}
 start('command');stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'bash-1',name:'Bash',input:{}}});
 const input={command:'bun -e "console.log(\'verified\')"'};
 stream({type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}});stream({type:'content_block_stop',index:0});complete('command',[{type:'tool_use',id:'bash-1',name:'Bash',input}]);
 // 偽 CLI のみで無害な子プロセスを動かす。OS sandbox 自体を模倣した検証ではない。
 const result=spawnSync(process.execPath,['-e',"await Bun.write('command-result.txt','verified\\n'); console.log('verified')"],{cwd:process.cwd(),encoding:'utf8'});
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:result.stdout,is_error:result.status!==0}]}});
 start('command-result');text(0,'Command finished');complete('command-result',[{type:'text',text:'Command finished'}]);
}else if(action==='tools'){
 start('before');text(0,'Before tool');stream({type:'content_block_start',index:1,content_block:{type:'tool_use',id:'tool-1',name:'Read',input:{}}});stream({type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"file_path":"example.md"}'}});stream({type:'content_block_stop',index:1});
 complete('before',[{type:'text',text:'Before tool'},{type:'tool_use',id:'tool-1',name:'Read',input:{file_path:'example.md'}}]);
 send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'Example contents'}]}});
 start('after');text(0,'After tool');complete('after',[{type:'text',text:'After tool'}]);
}else if(action==='full only')complete('full',[{type:'text',text:'Full only'}]);
else if(action==='corrected text'){start('corrected');text(0,'Draft');complete('corrected',[{type:'text',text:'Final'}])}
else if(['test: claude split assistant blocks','test: claude repeated assistant text','test: claude full assistant blocks'].includes(action)){
 const id='split',thinking={type:'thinking',thinking:'Fictional reasoning.',signature:'fixture'};
 start(id);
 stream({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}});
 stream({type:'content_block_stop',index:0});
 const finalText='Split Claude response.';
 const reply={type:'text',text:finalText};
 if(action==='test: claude full assistant blocks'){
  text(1,finalText);
  text(2,'Draft');
  complete(id,[thinking,reply,reply]);
 }else{
  complete(id,[thinking]);
  text(1,finalText);
  complete(id,[reply]);
  if(action==='test: claude repeated assistant text'){
   stream({type:'content_block_start',index:2,content_block:{type:'text',text:''}});
   stream({type:'content_block_delta',index:2,delta:{type:'text_delta',text:'Draft'}});
   complete(id,[reply]);
   stream({type:'content_block_stop',index:2});
  }
 }
}
else{
 if(action==='write documents'){
  const tools=args[args.indexOf('--tools')+1];if(!tools.split(',').includes('Write')){send({type:'result',subtype:'error_during_execution',is_error:true});process.exit(1)}
  writeFileSync(join(process.cwd(),'requirements.md'),'# Updated requirements\n');
 }
 start('message-1');text(0,'Hello');complete('message-1',[{type:'text',text:'Hello'}]);
}
if(action==='wait'){
 process.on('SIGINT',()=>{send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Interrupted']});process.exit(0)});
 setInterval(()=>{},1000);
}else {send({type:'result',subtype:'success',is_error:false,result:'Hello',session_id:session});input?.return?.();}
