import {expect,test} from 'bun:test';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeRpc,ClaudeRejected,claudeModels,claudeStatus} from './claude';
import {eventTools,toolResult} from './embedded-tools';
import {ClaudeAgent} from './agents/claude';
import type {AgentEvent,AgentRequest} from './agents/agent';

const fake=join(import.meta.dir,'test/fake-claude.ts');
async function until(fn:()=>boolean){for(let i=0;i<100;i++){if(fn())return;await Bun.sleep(10)}throw Error('Timed out')}
async function prepare(prompt:string,cwd=tmpdir(),writable=false,resume?:string){
 const rpc=new ClaudeRpc(fake),events:{method:string;params:any}[]=[];let closed=false;
 rpc.onEvent=(method,params)=>events.push({method,params});rpc.onClose=()=>{closed=true};await rpc.init();
 const thread=await rpc.request(resume?'thread/resume':'thread/start',{cwd,model:'sonnet',sandbox:writable?'workspace-write':'read-only',developerInstructions:'Keep task documents current.',...(resume?{threadId:resume}:{})});
 const started=rpc.request('turn/start',{threadId:thread.thread.id,model:'sonnet',input:[{type:'text',text:prompt}]});void started.catch(()=>{});
 return {rpc,events,thread:thread.thread.id,started,closed:()=>closed};
}
async function begin(prompt:string,cwd=tmpdir(),writable=false,resume?:string){const run=await prepare(prompt,cwd,writable,resume);const turn=await run.started;return {...run,turn:turn.turn.id}}

test('Claude status discards account details and distinguishes subscription, API and unknown auth',async()=>{
 try{
  expect(await claudeStatus(null)).toMatchObject({installed:false,path:null,auth:'unknown',models:null});
  const status=await claudeStatus(fake);expect(status).toMatchObject({installed:true,version:'2.1.292',auth:'claude',models:claudeModels});expect(JSON.stringify(status)).not.toContain('example@example.test');expect(JSON.stringify(status)).not.toContain('fictional-account');
  for(const [auth,result] of [['none','none'],['api_key','apiKey'],['api_key_helper','apiKey'],['third_party','other'],['malformed','unknown']] as const){process.env.FAKE_CLAUDE_AUTH=auth;expect((await claudeStatus(fake)).auth).toBe(result)}
  delete process.env.FAKE_CLAUDE_AUTH;process.env.FAKE_CLAUDE_PROVIDER='bedrock';expect((await claudeStatus(fake)).auth).toBe('other');delete process.env.FAKE_CLAUDE_PROVIDER;
  process.env.FAKE_CLAUDE_VERSION='2.1.1';expect(await claudeStatus(fake)).toMatchObject({version:'2.1.1',auth:'unknown',models:null});
 }finally{delete process.env.FAKE_CLAUDE_AUTH;delete process.env.FAKE_CLAUDE_PROVIDER;delete process.env.FAKE_CLAUDE_VERSION}
});
test('Claude rejects environment API credentials and alternate providers',async()=>{
 try{process.env.ANTHROPIC_API_KEY='fictional-key';expect((await claudeStatus(fake)).auth).toBe('apiKey');await expect(begin('hello')).rejects.toBeInstanceOf(ClaudeRejected);delete process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_BASE_URL='https://example.test';expect((await claudeStatus(fake)).auth).toBe('other')}
 finally{delete process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_BASE_URL}
});
test('Claude normalizes partial text, tool boundaries, results and completion without duplicating text',async()=>{
 const run=await begin('tools');try{
  await until(run.closed);const events=run.events;
  expect(events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('')).toBe('Before toolAfter tool');
  expect(events.map(event=>event.method)).toEqual(['turn/started','item/started','item/agentMessage/delta','item/completed','item/started','item/completed','item/started','item/agentMessage/delta','item/completed','turn/completed']);
  const textStarts=events.filter(event=>event.method==='item/started'&&event.params.item.type==='agentMessage').map(event=>event.params.item.id);
  expect(textStarts).toEqual(events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.itemId));
  expect(events.find(event=>event.method==='item/completed'&&event.params.item.type==='dynamicToolCall')?.params.item).toMatchObject({id:'tool-1',name:'Read',arguments:{file_path:'example.md'},output:'Example contents',status:'completed'});
  expect(events.at(-1)?.params).toMatchObject({threadId:run.thread,turn:{id:run.turn,status:'completed'}});
 }finally{run.rpc.close()}
});
test('Claude accepts complete assistant messages and final-only output',async()=>{
 for(const [prompt,text] of [['full only','Full only'],['result only','Final only']]){const run=await begin(prompt);try{await until(run.closed);expect(run.events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('')).toBe(text);expect(run.events.at(-1)?.params.turn.status).toBe('completed')}finally{run.rpc.close()}}
});
test('Claude requests only the SDK context summary after the turn and tolerates missing data',async()=>{
 const agent=new ClaudeAgent(()=>fake);
 const request:AgentRequest={
  sendId:'test-send',target:{mode:'new'},modelId:'sonnet',cwd:tmpdir(),access:'read-only',
  builtInTools:'disabled',instructions:'',references:[],tools:[],operation:{kind:'send',text:'hello'},
 };
 try{
  for(const mode of ['valid','invalid','silent']){
   process.env.FAKE_CLAUDE_CONTEXT_SUMMARY=mode;
   const events:AgentEvent[]=[];
   const outcome=await agent.run(request,{
    signal:new AbortController().signal,emit:async event=>{events.push(event)},callTool:async()=>{throw Error('Unexpected tool call')},
   });
   expect(outcome.status).toBe('completed');
   expect(events[0].type).toBe('accepted');
   expect(events.filter(event=>event.type==='context.usage')).toEqual(mode==='valid'?
    [{type:'context.usage',data:{usedTokens:24_000,maxTokens:200_000}}]:[]);
  }
 }finally{delete process.env.FAKE_CLAUDE_CONTEXT_SUMMARY}
});
test('Claude never infers model unavailability from successful discussion or unknown failure text',async()=>{
 for(const prompt of ['discuss invalid model','unknown model error']){
  const run=await prepare(prompt);try{if(prompt==='unknown model error')await expect(run.started).rejects.toBeInstanceOf(ClaudeRejected);else await run.started;await until(run.closed);const turn=run.events.find(event=>event.method==='turn/completed')?.params.turn;expect(turn.status).toBe(prompt==='discuss invalid model'?'completed':'failed');expect(turn.error).toBeUndefined();if(prompt==='discuss invalid model')expect(run.events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('')).toBe('This explains an invalid model error.')}finally{run.rpc.close()}
 }
});
test('Claude reports model errors, generic errors, malformed output and unexpected disconnect',async()=>{
 for(const prompt of ['reject model','reject assistant model','reject','malformed','disconnect']){const run=await prepare(prompt);try{const error=await run.started.catch(error=>error);expect(error).toBeInstanceOf(Error);if(prompt.startsWith('reject'))expect(error).toBeInstanceOf(ClaudeRejected);else expect(error instanceof ClaudeRejected).toBe(false);await until(run.closed);const finish=run.events.find(event=>event.method==='turn/completed');if(prompt==='reject model'||prompt==='reject assistant model'){expect(error.modelUnavailable).toBe(true);expect(finish?.params.turn).toMatchObject({status:'failed',error:{code:'model_not_found'}})}else if(prompt==='reject')expect(finish?.params.turn.status).toBe('failed');else expect(finish).toBeUndefined();expect(run.events.some(event=>event.method==='item/agentMessage/delta')).toBe(false)}finally{run.rpc.close()}}
});
test('Claude waits for a response after init and permits interrupt before acceptance',async()=>{
 process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS='300';
 try{
  const run=await prepare('hello');let settled=false;void run.started.then(()=>{settled=true},()=>{settled=true});
  try{await until(()=>run.events.some(event=>event.method==='turn/started'));await Bun.sleep(50);expect(settled).toBe(false);const turn=run.events.find(event=>event.method==='turn/started')!.params.turn.id;await run.rpc.request('turn/interrupt',{threadId:run.thread,turnId:turn});const error=await run.started.catch(error=>error);expect(error).toBeInstanceOf(ClaudeRejected);expect(error.interrupted).toBe(true);await until(run.closed);expect(run.events.at(-1)?.params.turn.status).toBe('interrupted')}
  finally{run.rpc.close()}
 }finally{delete process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS}
});
test('Claude rejects an explicitly missing resume session before acceptance',async()=>{
 process.env.FAKE_CLAUDE_RESUME_MISSING='1';
 const run=await prepare('hello',tmpdir(),false,'10000000-0000-4000-8000-000000000001');
 try{await expect(run.started).rejects.toBeInstanceOf(ClaudeRejected);await until(run.closed);expect(run.events.some(event=>event.method==='item/agentMessage/delta')).toBe(false)}finally{delete process.env.FAKE_CLAUDE_RESUME_MISSING;run.rpc.close()}
});
test('Claude interrupts a running turn and closes its process',async()=>{
 const run=await begin('wait');try{await until(()=>run.events.some(event=>event.method==='item/agentMessage/delta'));await run.rpc.request('turn/interrupt',{threadId:run.thread,turnId:run.turn});await until(run.closed);expect(run.events.at(-1)?.params.turn.status).toBe('interrupted')}finally{run.rpc.close()}
});
test('Claude task commands require sandbox isolation and stream Bash results; general stays read-only',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-claude-command-'))),log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 try{
  const general=await prepare('run command',root);try{await expect(general.started).rejects.toBeInstanceOf(ClaudeRejected);await until(general.closed);await expect(readFile(join(root,'command-result.txt'),'utf8')).rejects.toThrow()}finally{general.rpc.close()}
  const task=await begin('run command',root,true);try{await until(task.closed);expect(await readFile(join(root,'command-result.txt'),'utf8')).toBe('verified\n');expect(task.events.find(event=>event.method==='item/completed'&&event.params.item.name==='Bash')?.params.item).toMatchObject({type:'dynamicToolCall',status:'completed',output:'verified\n'});expect(task.events.at(-1)?.params.turn.status).toBe('completed')}finally{task.rpc.close()}
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(calls[0].args[calls[0].args.indexOf('--tools')+1]).not.toContain('Bash');
  const call=calls[1],settings=JSON.parse(call.args[call.args.indexOf('--settings')+1]);
  expect(call.args[call.args.indexOf('--allowedTools')+1]).toContain('Bash');expect(call.subprocessEnvScrub).toBe('1');
  expect(settings.sandbox).toEqual({enabled:true,failIfUnavailable:true,autoAllowBashIfSandboxed:true,allowUnsandboxedCommands:false,excludedCommands:[],enableWeakerNestedSandbox:false,enableWeakerNetworkIsolation:false,allowAppleEvents:false,filesystem:{disabled:false,allowWrite:[]},network:{strictAllowlist:true,allowedDomains:[],deniedDomains:['*'],allowUnixSockets:[],allowAllUnixSockets:false,allowLocalBinding:false,allowMachLookup:[]}});
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});
test('Claude does not accept task execution when the required sandbox is unavailable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-no-sandbox-'));process.env.FAKE_CLAUDE_SANDBOX_UNAVAILABLE='1';
 try{const run=await prepare('run command',root,true);try{const error=await run.started.catch(error=>error);expect(error).toBeInstanceOf(Error);await until(run.closed);expect(run.events.some(event=>event.method==='item/started')).toBe(false);await expect(readFile(join(root,'command-result.txt'),'utf8')).rejects.toThrow()}finally{run.rpc.close()}}
 finally{delete process.env.FAKE_CLAUDE_SANDBOX_UNAVAILABLE;await rm(root,{recursive:true,force:true})}
});
test('Claude persists distinct session IDs, resumes the selected session and limits file tools to the phase directory',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-claude-')));const log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 try{
  const first=await begin('write documents',root,true);await until(first.closed);expect(await readFile(join(root,'requirements.md'),'utf8')).toBe('# Updated requirements\n');
  const resumed=await begin('hello',root,true,first.thread);await until(resumed.closed);expect(resumed.thread).toBe(first.thread);
  const general=await begin('hello',root);await until(general.closed);expect(general.thread).not.toBe(first.thread);
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  for(const call of calls){for(const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-chrome','--disable-slash-commands'])expect(call.args).toContain(flag);expect(call.args[call.args.indexOf('--permission-mode')+1]).toBe('dontAsk');expect(call.args[call.args.indexOf('--permission-prompts')+1]).toBe('none');expect(call.args).not.toContain('--dangerously-skip-permissions');expect(call.args).toContain('Keep task documents current.');expect(call.cwd).toBe(root)}
  expect(calls[0].args[calls[0].args.indexOf('--tools')+1]).toBe('Read,Glob,Grep,Write,Edit,Bash');expect(calls[1].args).toContain('--resume');expect(calls[2].args[calls[2].args.indexOf('--tools')+1]).toBe('Read,Glob,Grep');
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

test('Claude 内部ツールだけを明示許可し、外部設定とコード実行の制限を維持する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-embedded-')),log=join(root,'calls.jsonl'),rpc=new ClaudeRpc(fake);process.env.FAKE_CLAUDE_LOG=log;let done=false;const calls:any[]=[];
 try{
  rpc.onClose=()=>{done=true};rpc.onToolCall=async params=>{calls.push(params);return toolResult({through:0})};
  const thread=await rpc.request('thread/start',{cwd:root,model:'sonnet',sandbox:'read-only',dynamicTools:eventTools});
  await rpc.request('turn/start',{threadId:thread.thread.id,model:'sonnet',input:[{type:'text',text:'event tools'}]});await until(()=>done);
  expect(calls.map(call=>call.tool)).toEqual(['list_events','acknowledge_events']);expect(calls.every(call=>call.threadId===thread.thread.id)).toBe(true);
  const invocation=JSON.parse((await readFile(log,'utf8')).trim()),args=invocation.args;
  for(const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-chrome','--disable-slash-commands'])expect(args).toContain(flag);
  expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--permission-prompts')+1]).toBe('none');expect(args[args.indexOf('--tools')+1]).toBe('Read,Glob,Grep');expect(args[args.indexOf('--input-format')+1]).toBe('stream-json');
  expect(args).not.toContain('--mcp-config');expect(invocation.initialization.sdkMcpServers).toEqual(['beni']);expect(invocation.initialization.sdkMcpServerManifests.beni.toolsListResult.tools).toEqual(eventTools.map(({name,description,inputSchema})=>({name,description,inputSchema})));expect(args[args.indexOf('--allowedTools')+1].split(',')).toEqual(['Read','Glob','Grep',...eventTools.map(tool=>`mcp__beni__${tool.name}`)]);
  expect(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks).toBe(true);
 }finally{rpc.close();delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

const compactSession='10000000-0000-4000-8000-000000000001';

test('Claude reads resumed SDK context usage without sending a user message',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'beni-claude-context-')),log=join(cwd,'calls.jsonl');
 const agent=new ClaudeAgent(()=>fake);
 const request={session:{agentId:'claude' as const,id:compactSession},modelId:'sonnet',cwd};
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  for(const mode of ['valid','invalid','unsupported']){
   process.env.FAKE_CLAUDE_CONTEXT_PROBE=mode;
   const result=await agent.getContextUsage(request,new AbortController().signal);
   expect(result).toEqual(mode==='valid'?{usedTokens:24_000,maxTokens:200_000}:undefined);
  }
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(calls).toHaveLength(3);
  for(const call of calls){
   expect(call).toMatchObject({cwd:await realpath(cwd),session:compactSession,initialized:true,detail:'summary'});
   expect(call).not.toHaveProperty('prompt');
   for(const flag of ['--resume','--no-session-persistence','--restricted','--safe-mode','--disable-slash-commands','--strict-mcp-config'])expect(call.args).toContain(flag);
  }
 }finally{
  delete process.env.FAKE_CLAUDE_CONTEXT_PROBE;
  delete process.env.FAKE_CLAUDE_LOG;
  await rm(cwd,{recursive:true,force:true});
 }
});

test('Claude cancels an unanswered SDK context probe',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'beni-claude-context-')),log=join(cwd,'calls.jsonl');
 const agent=new ClaudeAgent(()=>fake),controller=new AbortController();
 process.env.FAKE_CLAUDE_LOG=log;
 process.env.FAKE_CLAUDE_CONTEXT_PROBE='silent';
 const result=agent.getContextUsage({session:{agentId:'claude',id:compactSession},modelId:'sonnet',cwd},controller.signal);
 try{
  await until(()=>existsSync(log));
  controller.abort();
  expect(await result).toBeUndefined();
  const {pid}=JSON.parse((await readFile(log,'utf8')).trim());
  await until(()=>{try{process.kill(pid,0);return false}catch{return true}});
 }finally{
  controller.abort();
  await result;
  delete process.env.FAKE_CLAUDE_CONTEXT_PROBE;
  delete process.env.FAKE_CLAUDE_LOG;
  await rm(cwd,{recursive:true,force:true});
 }
});
test('Claude の偽CLIも slash command 無効時は成功resultを返して圧縮境界を出さない',async()=>{
 const child=Bun.spawn([fake,'--settings','{}','--tools','','--session-id',compactSession,'--disable-slash-commands'],{stdin:new Blob(['/compact']),stdout:'pipe',stderr:'pipe'});
 const messages=(await new Response(child.stdout).text()).trim().split('\n').map(line=>JSON.parse(line));
 expect(await child.exited).toBe(0);expect(messages.some(message=>message.subtype==='compact_boundary')).toBe(false);
 expect(messages.at(-1)).toMatchObject({type:'result',subtype:'success',is_error:false,result:"/compact isn't available in this environment."});
});
async function prepareCompact(cwd=tmpdir(),sandbox:'read-only'|'workspace-write'='read-only'){
 const rpc=new ClaudeRpc(fake),events:{method:string;params:any}[]=[];let closed=false;
 rpc.onEvent=(method,params)=>events.push({method,params});rpc.onClose=()=>{closed=true};
 await rpc.request('thread/resume',{threadId:compactSession,cwd,model:'sonnet',sandbox,builtinTools:false,dynamicTools:eventTools});
 const started=rpc.request('thread/compact/start',{threadId:compactSession});void started.catch(()=>{});
 return {rpc,events,started,closed:()=>closed};
}
test('Claude 圧縮は保存済みセッションだけを再開し、安全設定と内部固定コマンドを使う',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-compact-')),log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 try{
  const invalid=new ClaudeRpc(fake);const thread=await invalid.request('thread/start',{cwd:root,model:'sonnet',sandbox:'read-only'});
  try{await expect(invalid.request('thread/compact/start',{threadId:thread.thread.id})).rejects.toBeInstanceOf(ClaudeRejected)}finally{invalid.close()}
  for(const sandbox of ['read-only','workspace-write'] as const){
   const run=await prepareCompact(root,sandbox);
   try{
    expect(await run.started).toEqual({});await until(run.closed);
    expect(run.events.map(event=>event.method)).toEqual(['turn/started','item/started','item/completed','turn/completed']);
    expect(run.events[1].params.item.type).toBe('contextCompaction');expect(run.events[2].params.item).toEqual(run.events[1].params.item);
    expect(run.events.at(-1)?.params.turn.status).toBe('completed');expect(run.events.every(event=>event.params.threadId===compactSession)).toBe(true);
   }finally{run.rpc.close()}
  }
  const invocations=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  for(const invocation of invocations){
   const args=invocation.args;expect(invocation.prompt).toBe('/compact');expect(invocation.session).toBe(compactSession);expect(args[args.indexOf('--resume')+1]).toBe(compactSession);
   for(const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-chrome'])expect(args).toContain(flag);
   expect(args).not.toContain('--disable-slash-commands');
   expect(args[args.indexOf('--tools')+1]).toBe('');expect(args[args.indexOf('--allowedTools')+1]).toBe('');expect(args[args.indexOf('--disallowedTools')+1]).toBe('mcp__*');
   expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--permission-mode')+1]).toBe('dontAsk');expect(args[args.indexOf('--permission-prompts')+1]).toBe('none');
   expect(JSON.parse(args[args.indexOf('--mcp-config')+1])).toEqual({mcpServers:{}});expect(args).not.toContain('--input-format');expect(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks).toBe(true);
  }
  const settings=JSON.parse(invocations[1].args[invocations[1].args.indexOf('--settings')+1]);expect(settings.sandbox.failIfUnavailable).toBe(true);expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);expect(invocations[1].subprocessEnvScrub).toBe('1');
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});
test('Claude 圧縮は境界のない成功resultの既知理由だけを安全なコードに変換する',async()=>{
 try{
  for(const [mode,code] of [['unavailable','COMPACTION_UNAVAILABLE'],['not-needed','COMPACTION_NOT_NEEDED'],['unknown-reason','COMPACTION_NOT_PERFORMED'],['known-failure','COMPACTION_NOT_PERFORMED']] as const){
   process.env.FAKE_CLAUDE_COMPACT=mode;const run=await prepareCompact();
   try{
    await run.started;await until(run.closed);
    expect(run.events.map(event=>event.method)).toEqual(['turn/started','turn/completed']);
    expect(run.events.at(-1)?.params.turn).toMatchObject({status:'failed',error:{code}});
    expect(JSON.stringify(run.events)).not.toContain('Private compaction failure details');
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMPACT}
});
test('Claude 圧縮は手動境界と成功resultが必要で、本文や他セッションの境界を配信しない',async()=>{
 try{
  for(const mode of ['no-boundary','auto','foreign-parent','foreign-session','failure','disconnect','failure-after-boundary','disconnect-after-boundary']){
   process.env.FAKE_CLAUDE_COMPACT=mode;const run=await prepareCompact();
   try{
    await run.started.catch(()=>{});await until(run.closed);
    const disconnected=mode.includes('disconnect')||mode==='foreign-session';
    const expected=['turn/started',...(mode.endsWith('after-boundary')?['item/started','item/completed']:[]),...(!disconnected?['turn/completed']:[])];
    expect(run.events.map(event=>event.method)).toEqual(expected);
    if(!disconnected)expect(run.events.at(-1)?.params.turn).toMatchObject({status:'failed',error:{code:'COMPACTION_NOT_PERFORMED'}});
    else expect(run.events.some(event=>event.method==='turn/completed')).toBe(false);
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMPACT}
});
test('Claude 圧縮は受理後も中断でき、結果が返るまで完了扱いにしない',async()=>{
 try{
  for(const mode of ['wait','wait-after-boundary']){
   process.env.FAKE_CLAUDE_COMPACT=mode;const run=await prepareCompact();try{
    expect(await run.started).toEqual({});
    if(mode==='wait-after-boundary')await until(()=>run.events.some(event=>event.method==='item/completed'));
    expect(run.events.some(event=>event.method==='turn/completed')).toBe(false);
    const turn=run.events[0].params.turn.id;await run.rpc.request('turn/interrupt',{threadId:compactSession,turnId:turn});await until(run.closed);
    expect(run.events.at(-1)?.params.turn.status).toBe('interrupted');
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMPACT}
});

async function prepareCommand(command='usage',options:{cwd?:string;sandbox?:'read-only'|'workspace-write';resume?:boolean}={}){
 const rpc=new ClaudeRpc(fake),events:{method:string;params:any}[]=[];let closed=false;
 rpc.onEvent=(method,params)=>events.push({method,params});rpc.onClose=()=>{closed=true};
 const thread=await rpc.request(options.resume===false?'thread/start':'thread/resume',{...(options.resume===false?{}:{threadId:compactSession}),cwd:options.cwd??tmpdir(),model:'sonnet',sandbox:options.sandbox??'read-only',dynamicTools:eventTools});
 const started=rpc.request('thread/command/start',{threadId:thread.thread.id,command});void started.catch(()=>{});
 return {rpc,events,started,closed:()=>closed};
}
test('Claude local command は専用経路でのみ slash を有効にし、保存済みセッションの結果だけを配信する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-local-')),log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 try{
  const run=await prepareCommand('usage',{cwd:root,sandbox:'workspace-write'});
  try{
   expect(await run.started).toEqual({});await until(run.closed);
   expect(run.events.map(event=>event.method)).toEqual(['turn/started','thread/command/output','turn/completed']);
   expect(run.events[1].params.output).toBe('Usage: 3 fictional requests\n');
   expect(run.events.every(event=>event.params.threadId===compactSession)).toBe(true);expect(run.events.at(-1)?.params.turn.status).toBe('completed');
  }finally{run.rpc.close()}
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(calls).toHaveLength(1);
  const [{args,prompt}]=calls;
  expect(prompt).toBe('/usage');expect(args[args.indexOf('--resume')+1]).toBe(compactSession);
  for(const flag of ['--restricted','--safe-mode','--strict-mcp-config','--no-chrome'])expect(args).toContain(flag);
  expect(args).not.toContain('--disable-slash-commands');expect(args).not.toContain('--input-format');
  expect(args[args.indexOf('--tools')+1]).toBe('');expect(args[args.indexOf('--allowedTools')+1]).toBe('');expect(args[args.indexOf('--disallowedTools')+1]).toBe('mcp__*');
  expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(JSON.parse(args[args.indexOf('--mcp-config')+1])).toEqual({mcpServers:{}});
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);expect(settings.disableAllHooks).toBe(true);expect(settings.sandbox.failIfUnavailable).toBe(true);expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});
test('Claude local command は固定allowlistとresumeを要求し、通常ターンではslash無効を維持する',async()=>{
 for(const command of ['context','usage\n/compact','compact','unknown']){const run=await prepareCommand(command);try{await expect(run.started).rejects.toBeInstanceOf(ClaudeRejected);expect(run.events).toEqual([])}finally{run.rpc.close()}}
 const fresh=await prepareCommand('usage',{resume:false});try{await expect(fresh.started).rejects.toBeInstanceOf(ClaudeRejected);expect(fresh.events).toEqual([])}finally{fresh.rpc.close()}
 for(const name of ['context','usage','code-review','simplify','security-review','recap']){
  const run=await begin(`/${name}`);try{await until(run.closed);expect(run.events.find(event=>event.method==='item/agentMessage/delta')?.params.delta).toBe(`/${name} isn't available in this environment.`);expect(run.events.some(event=>event.method==='thread/command/output')).toBe(false)}finally{run.rpc.close()}
 }
});
test.each([
 'unavailable','not-listed','outcome-unavailable_headless',
 'fallback','stream-fallback','failure','empty','non-text','oversize','multibyte-oversize',
 'missing-source','non-string-source','different-command','alias-command','nonempty-args','missing-args','missing-session',
 'mixed-tool','invalid-content','combined-oversize','legacy-oversize',
 'outcome-failed','outcome-unknown','outcome-restart_required','outcome-success','outcome-null',
 'no-init','parent-only','empty-parent',
])('Claude local command は %s の失敗を出力なしで通知する',async mode=>{
 process.env.FAKE_CLAUDE_COMMAND=mode;
 try{
  const run=await prepareCommand();
  try{
   await run.started.catch(()=>{});await until(run.closed);
   expect(run.events.map(event=>event.method)).toEqual(['turn/started','turn/completed']);
   const code=['unavailable','not-listed','outcome-unavailable_headless'].includes(mode)?'COMMAND_UNAVAILABLE':'COMMAND_NOT_PERFORMED';
   expect(run.events.at(-1)?.params.turn).toMatchObject({status:'failed',error:{code}});
   const events=JSON.stringify(run.events);
   expect(events).not.toContain('Private');
   expect(events).not.toContain('Model fallback');
   expect(events).not.toContain('Raw');
  }finally{run.rpc.close()}
 }finally{delete process.env.FAKE_CLAUDE_COMMAND}
});
test('Claude local command は64KiBを改変せず返し、親イベントを除外し、別sessionとdisconnectは完了にしない',async()=>{
 try{
  for(const mode of ['limit','parent-noise','foreign-session','disconnect']){
   process.env.FAKE_CLAUDE_COMMAND=mode;const run=await prepareCommand();
   try{
    await run.started.catch(()=>{});await until(run.closed);
    const output=run.events.find(event=>event.method==='thread/command/output');
    if(mode==='limit'){expect(output?.params.output).toBe('x'.repeat(65536));expect(run.events.at(-1)?.params.turn.status).toBe('completed')}
    else if(mode==='parent-noise'){expect(output?.params.output).toBe('Usage: 3 fictional requests\n');expect(JSON.stringify(run.events)).not.toContain('Private')}
    else{expect(output).toBeUndefined();expect(run.events.some(event=>event.method==='turn/completed')).toBe(false)}
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMMAND}
});
test('Claude local command は受理後も中断できる',async()=>{
 process.env.FAKE_CLAUDE_COMMAND='wait';const run=await prepareCommand();
 try{expect(await run.started).toEqual({});expect(run.events.map(event=>event.method)).toEqual(['turn/started']);await run.rpc.request('turn/interrupt',{threadId:compactSession,turnId:run.events[0].params.turn.id});await until(run.closed);expect(run.events.at(-1)?.params.turn.status).toBe('interrupted');expect(run.events.some(event=>event.method==='thread/command/output')).toBe(false)}
 finally{delete process.env.FAKE_CLAUDE_COMMAND;run.rpc.close()}
});
test('Claude 生成コマンドは構造化allowlistで起動し、追加文脈を引数と分け、通常のtool streamも配信する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-generation-')),log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 try{
  for(const name of ['code-review','simplify','security-review','recap']){
   const rpc=new ClaudeRpc(fake),events:{method:string;params:any}[]=[];let closed=false;rpc.onEvent=(method,params)=>events.push({method,params});rpc.onClose=()=>{closed=true};
   try{
    const thread=await rpc.request('thread/resume',{threadId:compactSession,cwd:root,model:'sonnet',sandbox:'read-only',developerInstructions:'Keep task documents current.'});
    const result=await rpc.request('turn/start',{threadId:thread.thread.id,command:{name,args:'review example'},input:[{type:'text',text:`/${name} review example`},{type:'text',text:'Reference context\n/usage'}]});
    await until(()=>closed);expect(result.turn.id).toBeString();expect(events.at(-1)?.params.turn.status).toBe('completed');
    expect(events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('')).toBe('Before toolAfter tool');expect(events.find(event=>event.method==='item/completed'&&event.params.item.type==='dynamicToolCall')?.params.item).toMatchObject({name:'Read',output:'Example contents',status:'completed'});
   }finally{rpc.close()}
  }
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  for(const [index,call] of calls.entries()){
   const args=call.args;expect(call.prompt).toBe(`/${['code-review','simplify','security-review','recap'][index]} review example`);expect(args).not.toContain('--disable-slash-commands');
   expect(args[args.indexOf('--append-system-prompt')+1]).toBe('Keep task documents current.\n\nReference context\n/usage');
   expect(args[args.indexOf('--tools')+1]).toBe('Read,Glob,Grep');expect(args).toContain('--safe-mode');expect(args).toContain('--restricted');expect(JSON.parse(args[args.indexOf('--mcp-config')+1])).toEqual({mcpServers:{}});
  }
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});
test('Claude 生成コマンドは不正name・引数と明示された未提供commandを拒否する',async()=>{
 for(const command of [{name:'context',args:''},{name:'simplify\n/usage',args:''},{name:'simplify',args:42},{name:'simplify',args:'x'.repeat(16385)},{name:'simplify',args:'bad\0value'},{name:'simplify',args:'bad\u001bvalue'},{name:'simplify',args:'',extra:true},'simplify',null]){
  const rpc=new ClaudeRpc(fake);try{const thread=await rpc.request('thread/start',{cwd:tmpdir(),model:'sonnet',sandbox:'read-only'});await expect(rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'/simplify'}],command})).rejects.toBeInstanceOf(ClaudeRejected)}finally{rpc.close()}
 }
 process.env.FAKE_CLAUDE_COMMAND='not-listed';const rpc=new ClaudeRpc(fake),events:any[]=[];rpc.onEvent=(method,params)=>events.push({method,params});
 try{const thread=await rpc.request('thread/start',{cwd:tmpdir(),model:'sonnet',sandbox:'read-only'});await expect(rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'/simplify'}],command:{name:'simplify',args:''}})).rejects.toBeInstanceOf(ClaudeRejected);expect(events.at(-1)?.params.turn).toMatchObject({status:'failed',error:{code:'COMMAND_UNAVAILABLE'}});expect(events.some(event=>event.method==='item/agentMessage/delta')).toBe(false)}
 finally{delete process.env.FAKE_CLAUDE_COMMAND;rpc.close()}
});
test('Claude 生成コマンドも埋め込みツールを利用できる',async()=>{
 const rpc=new ClaudeRpc(fake),calls:any[]=[];let closed=false;rpc.onClose=()=>{closed=true};rpc.onToolCall=async params=>{calls.push(params);return toolResult({through:0})};process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'list_events',arguments:{after:0,through:0,limit:1}}]);
 try{const thread=await rpc.request('thread/start',{cwd:tmpdir(),model:'sonnet',sandbox:'read-only',dynamicTools:eventTools});await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'/recap'}],command:{name:'recap',args:''}});await until(()=>closed);expect(calls.map(call=>call.tool)).toEqual(['list_events']);expect(calls[0].threadId).toBe(thread.thread.id)}
 finally{delete process.env.FAKE_EMBEDDED_CALLS;rpc.close()}
});

test('Claude code-review はチャット外へ実行する引数を固定codeで拒否する',async()=>{
 for(const args of ['ultra','review ultra now','--post','--comment=details','review "--post"']){
  const rpc=new ClaudeRpc(fake),events:any[]=[];rpc.onEvent=(method,params)=>events.push({method,params});
  try{const thread=await rpc.request('thread/start',{cwd:tmpdir(),model:'sonnet',sandbox:'read-only'});const error=await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:`/code-review ${args}`}],command:{name:'code-review',args}}).catch(error=>error);expect(error).toBeInstanceOf(ClaudeRejected);expect(error.code).toBe('COMMAND_ARGUMENTS_UNSUPPORTED');expect(error.modelUnavailable).toBe(false);expect(events).toEqual([])}
  finally{rpc.close()}
 }
});

test('Claude local command はsynthetic本文を使い、raw sourceとresultの重複を配信しない',async()=>{
 try{
  for(const mode of ['success','string-content','text-blocks','duplicate-result','legacy']){
   process.env.FAKE_CLAUDE_COMMAND=mode;const run=await prepareCommand();
   try{
    expect(await run.started).toEqual({});await until(run.closed);
    expect(run.events.map(event=>event.method)).toEqual(['turn/started','thread/command/output','turn/completed']);
    expect(run.events[1].params.output).toBe('Usage: 3 fictional requests\n');
    expect(run.events.at(-1)?.params.turn.status).toBe('completed');expect(JSON.stringify(run.events)).not.toContain('Raw fixture');
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMMAND}
});
test('Claude local synthetic だけでは完了せず、中断・切断・別sessionの本文を配信しない',async()=>{
 try{
  for(const mode of ['wait-after-synthetic','disconnect-after-synthetic','foreign-synthetic']){
   process.env.FAKE_CLAUDE_COMMAND=mode;const run=await prepareCommand('usage');
   try{
    await run.started.catch(()=>{});
    if(mode==='wait-after-synthetic'){
     await Bun.sleep(30);expect(run.events.map(event=>event.method)).toEqual(['turn/started']);
     await run.rpc.request('turn/interrupt',{threadId:compactSession,turnId:run.events[0].params.turn.id});
    }
    await until(run.closed);expect(run.events.some(event=>event.method==='thread/command/output')).toBe(false);
    if(mode==='wait-after-synthetic')expect(run.events.at(-1)?.params.turn.status).toBe('interrupted');
    else expect(run.events.map(event=>event.method)).toEqual(['turn/started']);
   }finally{run.rpc.close()}
  }
 }finally{delete process.env.FAKE_CLAUDE_COMMAND}
});


test('Claude SDK は検出したCLIで安全フラグと既定プロンプトを保ち、終了しない子も回収する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-sdk-exit-')),log=join(root,'calls.jsonl');process.env.FAKE_CLAUDE_LOG=log;
 const run=await begin('stubborn',root);
 try{
  const call=JSON.parse((await readFile(log,'utf8')).trim());
  expect(call.rawArgs).toContain(`--session-id=${run.thread}`);expect(call.rawArgs).toContain('--setting-sources=');
  for(const flag of ['--print','--input-format','--include-partial-messages','--restricted','--safe-mode','--strict-mcp-config','--no-chrome'])expect(call.rawArgs).toContain(flag);
  expect(call.initialization.systemPrompt).toBeUndefined();expect(call.initialization.systemPromptSnapshot).toBe(false);expect(call.initialization.hooks).toBeUndefined();
  expect(call.rawArgs).not.toContain('--system-prompt');expect(call.rawArgs).toContain('Keep task documents current.');
  for(let i=0;i<600&&!run.closed();i++)await Bun.sleep(10);
  expect(run.closed()).toBe(true);expect(()=>process.kill(call.pid,0)).toThrow();
  expect(run.events.at(-1)?.params.turn.status).toBe('completed');
 }finally{run.rpc.close();delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
},10000);

const agent = new ClaudeAgent(() => fake);
const agentRequest = (text: string): AgentRequest => ({
 sendId: 'send', target: {mode:'new'}, modelId: 'sonnet', cwd: tmpdir(), access: 'read-only',
 builtInTools: 'disabled', instructions: '', references: [], tools: [], operation: {kind:'send', text},
});

test('ClaudeAgent confirms split and full assistant frames on their original stream items', async () => {
 const text = 'Split Claude response.';
 const firstStream: AgentEvent[] = [{type:'text.started', itemId:'split:1'}, {type:'text.delta', itemId:'split:1', delta:text}];
 const secondStream: AgentEvent[] = [{type:'text.started', itemId:'split:2'}, {type:'text.delta', itemId:'split:2', delta:'Draft'}];
 const first: AgentEvent = {type:'text.completed', itemId:'split:1', text};
 const second: AgentEvent = {type:'text.completed', itemId:'split:2', text};
 const cases: [string, AgentEvent[]][] = [
  ['test: claude split assistant blocks', [...firstStream, first]],
  ['test: claude repeated assistant text', [...firstStream, first, ...secondStream, second]],
  ['test: claude full assistant blocks', [...firstStream, ...secondStream, first, second]],
 ];
 for (const [prompt, expected] of cases) {
  const events: AgentEvent[] = [];
  const result = await agent.run(agentRequest(prompt), {
   signal: new AbortController().signal,
   emit: async event => { events.push(event); },
   callTool: async () => { throw Error('Unexpected tool'); },
  });
  expect(result).toEqual({status:'completed'});
  expect(events.filter(event => event.type.startsWith('text.'))).toEqual(expected);
 }
});

test('ClaudeAgent delivers usage before acceptance and confirms authoritative text in order', async () => {
 process.env.FAKE_CLAUDE_RATE_LIMIT = '0.42';
 try {
  const events: AgentEvent[] = [];
  const result = await agent.run(agentRequest('corrected text'), {
   signal: new AbortController().signal,
   emit: async event => { await Bun.sleep(5); events.push(event); },
   callTool: async () => { throw Error('Unexpected tool'); },
  });
  const {accountKey} = await agent.getStatus();
  expect(result).toEqual({status:'completed'});
  expect(events).toMatchObject([
   {type:'usage', data:{accountKey, kind:'window-update', usage:{windows:[{usedPercent:42}]}}},
   {type:'accepted', session:{agentId:'claude', id:expect.any(String), legacySessionId:expect.any(String)}},
   {type:'text.started', itemId:'corrected:0'},
   {type:'text.delta', itemId:'corrected:0', delta:'Draft'},
   {type:'text.completed', itemId:'corrected:0', text:'Final'},
  ]);
 } finally { delete process.env.FAKE_CLAUDE_RATE_LIMIT; }
});

test('ClaudeAgent persists acceptance before dispatching an embedded tool that arrives ahead of text', async () => {
 let accepted = false;
 const calls: string[] = [];
 const result = await agent.run({...agentRequest('early embedded tool'), tools:eventTools}, {
  signal: new AbortController().signal,
  emit: async event => {
   if (event.type === 'accepted') { await Bun.sleep(5); accepted = true; }
  },
  callTool: async ({name}) => {
   expect(accepted).toBe(true);
   calls.push(name);
   return {ok:true,text:'{}'};
  },
 });
 expect(result).toEqual({status:'completed'});
 expect(calls).toEqual(['list_events','acknowledge_events']);
});

test('ClaudeAgent waits for process cleanup on abort or rejected event delivery', async () => {
 const cwd = await mkdtemp(join(tmpdir(), 'beni-claude-agent-stop-'));
 const log = join(cwd, 'calls.jsonl');
 process.env.FAKE_CLAUDE_LOG = log;
 try {
  for (const fail of [false, true]) {
   const controller = new AbortController();
   const result = await agent.run({...agentRequest('wait'), cwd}, {
    signal: controller.signal,
    emit: async event => {
     if (event.type !== 'accepted') return;
     if (fail) throw Error('Save failed');
     controller.abort();
    },
    callTool: async () => { throw Error('Unexpected tool'); },
   });
   const records = (await readFile(log, 'utf8')).trim().split('\n');
   const {pid} = JSON.parse(records.at(-1)!);
   expect(() => process.kill(pid, 0)).toThrow();
   expect(result).toEqual({status:fail ? 'unknown' : 'interrupted'});
  }
 } finally {
  delete process.env.FAKE_CLAUDE_LOG;
  await rm(cwd, {recursive:true, force:true});
 }
});

test('ClaudeAgent requires a successful CLI exit for maintenance and prefers structured usage', async () => {
 const host = {
  signal: new AbortController().signal,
  emit: async () => {},
  callTool: async () => { throw Error('Unexpected tool'); },
 };
 try {
  const request: AgentRequest = {...agentRequest(''), target:{mode:'resume',session:{agentId:'claude',id:compactSession}},
   operation:{kind:'command',name:'usage',args:''}};
  expect(await agent.run(request, host)).toEqual({status:'completed',output:'Usage: 3 fictional requests\n'});
  process.env.FAKE_CLAUDE_COMMAND = 'failed-exit';
  expect(await agent.run(request, host)).toEqual({status:'unknown'});
  delete process.env.FAKE_CLAUDE_COMMAND;

  process.env.FAKE_CLAUDE_USAGE_REPORT = '1';
  process.env.FAKE_CLAUDE_RATE_LIMIT = '0.42';
  expect(await agent.getUsage()).toMatchObject({kind:'snapshot',usage:{windows:[{usedPercent:0},{usedPercent:45}]}});
  delete process.env.FAKE_CLAUDE_USAGE_REPORT;
  expect(await agent.getUsage()).toMatchObject({kind:'window-update',usage:{windows:[{usedPercent:42}]}});
 } finally {
  delete process.env.FAKE_CLAUDE_COMMAND;
  delete process.env.FAKE_CLAUDE_USAGE_REPORT;
  delete process.env.FAKE_CLAUDE_RATE_LIMIT;
 }
});
