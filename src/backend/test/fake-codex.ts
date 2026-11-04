#!/usr/bin/env bun
import {appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
if(process.argv.includes('--version')){console.log('codex-cli 1.2.3');process.exit(0)}
const send=(x:unknown)=>process.stdout.write(JSON.stringify(x)+'\n');
let turn='turn-1';
for await (const line of createInterface({input:process.stdin})) {
 const msg=JSON.parse(line);if(process.env.FAKE_CODEX_LOG)appendFileSync(process.env.FAKE_CODEX_LOG,JSON.stringify(msg)+'\n');if(msg.id==='approval-test'){if(msg.error?.code===-32601)send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,delta:' denied'}});continue}if(!msg.id)continue;
 if(msg.method==='initialize')send({id:msg.id,result:{}});
 else if(msg.method==='account/read')send({id:msg.id,result:{account:{type:process.env.FAKE_AUTH??'chatgpt'}}});
 else if(msg.method==='config/read')send({id:msg.id,result:{config:{web_search:'disabled',mcp_servers:{},features:{shell_tool:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='shell_tool'),apps:false,plugins:false,multi_agent:false,browser_use:false,computer_use:false,code_mode_host:process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]==='code_mode_host'),hooks:false,skill_mcp_dependency_install:false}}}});
 else if(msg.method==='model/list')send({id:msg.id,result:{data:[{model:'model-a',displayName:'Model A'}],nextCursor:null}});
 else if(msg.method==='thread/start'||msg.method==='thread/resume')send({id:msg.id,result:{thread:{id:msg.params.threadId??'thread-1',sessionId:'session-1'}}});
 else if(msg.method==='turn/start'){
  const text=msg.params.input[0].text;
  if(text==='write documents'&&!['shell_tool','code_mode_host'].every(feature=>process.argv.some((arg,index)=>arg==='--enable'&&process.argv[index+1]===feature))){send({id:msg.id,error:{code:-32600,message:'Required tools disabled'}});continue}
  if(text==='write documents'){writeFileSync(join(msg.params.cwd,'requirements.md'),'# Updated requirements\n');writeFileSync(join(msg.params.cwd,'implementation-plan.md'),'# Updated plan\n')}
  if(text==='disconnect')process.exit(0);
  if(text==='reject'){send({id:msg.id,error:{code:-32600,message:'rejected'}});continue}
  if(text==='approval')send({id:'approval-test',method:'item/commandExecution/requestApproval',params:{}});
  send({method:'turn/started',params:{threadId:'thread-1',turn:{id:turn}}});
  send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:turn,delta:'Hello'}});
  send({id:msg.id,result:{turn:{id:turn}}});
  if(text!=='wait')setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'completed'}}}),30);
 } else if(msg.method==='turn/interrupt') {send({id:msg.id,result:{}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:turn,status:'interrupted'}}})}
}
