import {expect,test} from 'bun:test';
import {mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeRpc,ClaudeRejected,claudeModels,claudeStatus} from './claude';
import {eventTools,toolResult} from './embedded-tools';

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
  expect(events.map(event=>event.method)).toEqual(['turn/started','item/agentMessage/delta','item/completed','item/started','item/completed','item/agentMessage/delta','item/completed','turn/completed']);
  expect(events.find(event=>event.method==='item/completed'&&event.params.item.type==='dynamicToolCall')?.params.item).toMatchObject({id:'tool-1',name:'Read',arguments:{file_path:'example.md'},output:'Example contents',status:'completed'});
  expect(events.at(-1)?.params).toMatchObject({threadId:run.thread,turn:{id:run.turn,status:'completed'}});
 }finally{run.rpc.close()}
});
test('Claude accepts complete assistant messages and final-only output',async()=>{
 for(const [prompt,text] of [['full only','Full only'],['result only','Final only']]){const run=await begin(prompt);try{await until(run.closed);expect(run.events.filter(event=>event.method==='item/agentMessage/delta').map(event=>event.params.delta).join('')).toBe(text);expect(run.events.at(-1)?.params.turn.status).toBe('completed')}finally{run.rpc.close()}}
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
  expect(JSON.parse(args[args.indexOf('--mcp-config')+1])).toEqual({mcpServers:{beni:{type:'sdk',name:'beni'}}});expect(args[args.indexOf('--allowedTools')+1].split(',')).toEqual(['Read','Glob','Grep',...eventTools.map(tool=>`mcp__beni__${tool.name}`)]);
  expect(JSON.parse(args[args.indexOf('--settings')+1]).disableAllHooks).toBe(true);
 }finally{rpc.close();delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});
