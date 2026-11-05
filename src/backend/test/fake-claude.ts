#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const args=process.argv.slice(2);
if(args.includes('--version')){console.log(`${process.env.FAKE_CLAUDE_VERSION??'2.1.292'} (Claude Code)`);process.exit(0)}
if(args[0]==='auth'){
 const method=process.env.FAKE_CLAUDE_AUTH??'claude.ai';
 if(method==='malformed'){console.log('invalid');process.exit(0)}
 console.log(JSON.stringify({loggedIn:method!=='none',authMethod:method,apiProvider:process.env.FAKE_CLAUDE_PROVIDER??'firstParty',email:'example@example.test',accountId:'fictional-account'}));process.exit(method==='none'?1:0);
}
const send=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
const input=args.includes('--input-format')?createInterface({input:process.stdin})[Symbol.asyncIterator]():null;
let prompt='';
if(input){
 while(true){const line=await input.next();if(line.done)process.exit(1);const message=JSON.parse(line.value);
  if(message.type==='control_request'&&message.request.subtype==='initialize'){send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}});continue}
  if(message.type==='user'){prompt=message.message.content;break}
 }
}else prompt=await Bun.stdin.text();
const action=prompt.split('\n\n')[0];
const session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
if(process.env.FAKE_CLAUDE_LOG)appendFileSync(process.env.FAKE_CLAUDE_LOG,JSON.stringify({args,cwd:process.cwd(),prompt,session,subprocessEnvScrub:process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB})+'\n');
const tools=args[args.indexOf('--tools')+1]?.split(',')??[];
const settings=JSON.parse(args[args.indexOf('--settings')+1]??'{}');
if(tools.includes('Bash')&&process.env.FAKE_CLAUDE_SANDBOX_UNAVAILABLE==='1'&&settings.sandbox?.failIfUnavailable===true){console.error('Sandbox is required but unavailable');process.exit(1)}
if(process.env.FAKE_CLAUDE_RESUME_MISSING==='1'&&args.includes('--resume')){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Session does not exist']});process.exit(1)}
if(action==='disconnect'||action==='early exit')process.exit(1);
if(action==='malformed'){console.log('invalid');process.exit(1)}
if(action==='reject model'){send({type:'result',subtype:'error_during_execution',is_error:true,error:{code:'model_not_found'}});process.exit(1)}
if(action==='reject assistant model'){send({type:'assistant',error:'model_not_found',message:{id:'error',content:[]}});send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Request failed']});process.exit(1)}
if(action==='unknown model error'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['The selected model was not found']});process.exit(1)}
if(action==='reject'){send({type:'result',subtype:'error_during_execution',is_error:true,errors:['Request failed']});process.exit(1)}
send({type:'system',subtype:'init',session_id:session});
if(process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS)await Bun.sleep(Number(process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS));
const stream=(event:unknown)=>send({type:'stream_event',event,session_id:session,parent_tool_use_id:null});
const start=(id:string)=>stream({type:'message_start',message:{id}});
const text=(index:number,value:string)=>{stream({type:'content_block_start',index,content_block:{type:'text',text:''}});stream({type:'content_block_delta',index,delta:{type:'text_delta',text:value}});stream({type:'content_block_stop',index})};
const complete=(id:string,content:unknown[])=>send({type:'assistant',message:{id,content},parent_tool_use_id:null});
if(action==='result only'){send({type:'result',subtype:'success',is_error:false,result:'Final only',session_id:session});process.exit(0)}
if(action==='discuss invalid model'){send({type:'result',subtype:'success',is_error:false,result:'This explains an invalid model error.',error:{code:'model_not_found'},session_id:session});process.exit(0)}
if(action==='event tools'||process.env.FAKE_EMBEDDED_CALLS){
 if(!input)throw Error('Missing SDK stream');
 const range=prompt.match(/Beni project event review range: after (\d+), through (\d+)/);
 const calls=process.env.FAKE_EMBEDDED_CALLS?JSON.parse(process.env.FAKE_EMBEDDED_CALLS):[{tool:'list_events',arguments:{after:Number(range?.[1]??0),through:Number(range?.[2]??0),limit:1}},{tool:'acknowledge_events',arguments:{through:Number(range?.[2]??0)}}];
 const results=[];
 for(const [index,call] of calls.entries()){
  const id=`embedded:${index}`;start(id);stream({type:'content_block_start',index:0,content_block:{type:'tool_use',id,name:`mcp__beni__${call.tool}`,input:call.arguments}});complete(id,[{type:'tool_use',id,name:`mcp__beni__${call.tool}`,input:call.arguments}]);
  send({type:'control_request',request_id:id,request:{subtype:'mcp_message',server_name:'beni',message:{jsonrpc:'2.0',id:index,method:'tools/call',params:{name:call.tool,arguments:call.arguments}}}});
  while(true){const line=await input.next();if(line.done)process.exit(1);const message=JSON.parse(line.value);if(message.type!=='control_response'||message.response.request_id!==id)continue;const result=message.response.response.mcp_response.result;results.push(result);send({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:result.content,is_error:result.isError}]}});break}
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
