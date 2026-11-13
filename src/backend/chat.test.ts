import {Store} from './store';
import { mkdirSync } from 'node:fs';
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatService} from './chat';
import {encodeChatHistory} from './chat-history';
import {CodexAgent} from './agents/codex';
import {DummyAgent} from './test/dummy-agent';
import type {Agent, ContextUsage} from './agents/agent';
const projectFolder=(root:string,id:string)=>{const folder=join(root,id);mkdirSync(folder,{recursive:true});return folder};
const standaloneChatPath=(folder:string,id:string)=>join(folder,'.beni','chats',id+'.json');
async function migrateStandaloneChat(folder:string,projectId:string){
 const {migrateChatStorage}=await import('./chat-migration');
 const directory=join(folder,'.beni'),store=new Store(join(directory,'beni.sqlite'),{migration:true});
 try{return migrateChatStorage(store.chats,directory,[{projectId,directory}]);}
 finally{store.close();}
}
const fake=join(import.meta.dir,'test/fake-codex.ts');
async function waitFor(fn:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await fn())return;await Bun.sleep(20)}throw Error('timed out')}
test('コンテキスト使用量はモデルの再開セッションごとに保存し、圧縮成功後の値に更新する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-context-usage-')),p='019a0000-0000-7000-8000-000000000001';
 const models=[{id:'first',name:'First'},{id:'second',name:'Second'}];
 let usedTokens:number|undefined=200,fail=false;
 const agent=Object.assign(new DummyAgent({
  status:()=>({models}),
  commands:['compact'].map(name=>({name,description:name,kind:'maintenance',requiresSession:true})),
  scenario:async(_request,host,accept)=>{
   await accept();
   if(usedTokens!==undefined)await host.emit({type:'context.usage',data:{usedTokens,maxTokens:1000}});
   return fail?{status:'failed',code:'execution-failed'}:{status:'completed'};
  },
 }),{getContextUsage:async()=>usedTokens===undefined?undefined:{usedTokens,maxTokens:1000}});
 const createChat=()=>new ChatService(()=>root,[agent]);
 const completed=async(chat:ChatService)=>waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
 try{
  const chat=createChat();
  await chat.send(p,null,'First message','first',root);await completed(chat);
  usedTokens=500;
  const sent=await chat.send(p,null,'Second message','second',root);
  expect(sent.contextUsage).toBeUndefined();
  expect(sent.sessions?.['dummy/first']?.contextUsage).toEqual({usedTokens:200,maxTokens:1000});
  await completed(chat);
  const stored=JSON.parse(await readFile(standaloneChatPath(root,(await chat.get(p,null)).id),'utf8'));
  expect(stored).toMatchObject({version:3,providers:{dummy:{models:{
   first:{session:{contextUsage:{usedTokens:200,maxTokens:1000}}},
   second:{session:{contextUsage:{usedTokens:500,maxTokens:1000}}},
  }}}});

  const restarted=createChat();
  const command=async(name:string)=>{
   await restarted.command(p,null,name,root,undefined,null,{model:'first'});
   await waitFor(async()=>(await restarted.get(p,null)).command?.status!=='running');
   return restarted.get(p,null);
  };
  fail=true;usedTokens=100;
  let conversation=await command('compact');
  expect(conversation.command?.status).toBe('failed');
  expect(conversation.sessions?.['dummy/first']?.contextUsage?.usedTokens).toBe(200);
  fail=false;
  conversation=await command('compact');
  expect(conversation.sessions?.['dummy/first']?.contextUsage?.usedTokens).toBe(100);
  usedTokens=undefined;
  conversation=await command('compact');
  expect(conversation.sessions?.['dummy/first']?.contextUsage).toBeUndefined();
  expect(conversation.contextUsage?.usedTokens).toBe(500);
  usedTokens=50;
  expect(await restarted.getContextUsage(p,null,null,'dummy','first',root)).toEqual({usedTokens:50,maxTokens:1000});
  conversation=await restarted.get(p,null);
  expect(conversation.sessions?.['dummy/first']?.contextUsage?.usedTokens).toBe(50);
  expect(conversation.contextUsage?.usedTokens).toBe(500);

  const replacement=new ChatService(()=>root,[new DummyAgent({status:()=>({models})})]);
  await replacement.send(p,null,'Recover missing session','second',root);await completed(replacement);
  conversation=await replacement.get(p,null);
  expect(conversation.messages.at(-1)?.status).toBe('completed');
  expect(conversation.contextUsage).toBeUndefined();
  expect(conversation.sessions?.['dummy/first']?.contextUsage?.usedTokens).toBe(50);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('コンテキスト取得 API は保存済みセッションに限定し、並行取得とリセットを処理する',async()=>{
 const {Store}=await import('./store/index');
 const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-context-probe-')),store=new Store(':memory:');
 const project=store.createProject('Example',root) as {id:string};
 const task=store.createTask(project.id,'Example task') as {id:string};
 const requests:{id:string;model:string;resolve:(value:ContextUsage|undefined)=>void}[]=[];
 const getContextUsage:NonNullable<Agent['getContextUsage']>=({session,modelId})=>
  new Promise(resolve=>requests.push({id:session.id,model:modelId,resolve}));
 const agent=Object.assign(new DummyAgent({
  supportsEmbeddedTools:true,
  status:()=>({models:[{id:'first',name:'First'},{id:'second',name:'Second'}]}),
 }),{getContextUsage});
 const chat=new ChatService(()=>root,[agent]),handler=createHandler(store,'/tmp',chat);
 const post=(extra:Record<string,unknown>={})=>handler(new Request('http://127.0.0.1:3210/api/chat/context-usage',{
  method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},
  body:JSON.stringify({projectId:project.id,taskId:task.id,phase:'requirements',provider:'dummy',model:'first',...extra}),
 }));
 try{
  expect(await (await post()).json()).toEqual({});
  expect((await post({threadId:'client-thread'})).status).toBe(400);
  await chat.send(project.id,task.id,'Saved session','first',root);
  await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='completed');
  const before=await chat.get(project.id,task.id);
  expect(await (await post({model:'second'})).json()).toEqual({});
  expect(await (await post({phase:'implementation'})).json()).toEqual({});
  expect(requests).toHaveLength(0);

  const first=post(), concurrent=post();
  await waitFor(async()=>requests.length===1);
  expect(requests[0]).toMatchObject({id:before.threadId,model:'first'});
  expect(await chat.get(project.id,task.id)).toEqual(before);
  const contextUsage={usedTokens:100,maxTokens:1000};
  requests[0].resolve(contextUsage);
  expect(await (await first).json()).toEqual({contextUsage});
  expect(await (await concurrent).json()).toEqual({contextUsage});
  expect(await (await post()).json()).toEqual({contextUsage});
  expect(requests).toHaveLength(1);

  const unavailable=post({refresh:true});
  await waitFor(async()=>requests.length===2);
  requests[1].resolve(undefined);
  expect(await (await unavailable).json()).toEqual({});
  expect(await chat.get(project.id,task.id)).toEqual({...before,contextUsage});

  const updated=post({refresh:true});
  await waitFor(async()=>requests.length===3);
  const refreshedUsage={usedTokens:200,maxTokens:1000};
  requests[2].resolve(refreshedUsage);
  expect(await (await updated).json()).toEqual({contextUsage:refreshedUsage});
  expect(await chat.get(project.id,task.id)).toEqual({...before,contextUsage:refreshedUsage});

  const stale=post({refresh:true});
  await waitFor(async()=>requests.length===4);
  await chat.send(project.id,task.id,'Same session next turn','first',root);
  await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='completed');
  requests[3].resolve({usedTokens:700,maxTokens:1000});
  expect(await (await stale).json()).toEqual({});
  expect(await chat.get(project.id,task.id)).toMatchObject({threadId:before.threadId,contextUsage:refreshedUsage});

  const reset=post({refresh:true});
  await waitFor(async()=>requests.length===5);
  await chat.command(project.id,task.id,'clear',root);
  requests[4].resolve({usedTokens:800,maxTokens:1000});
  expect(await (await reset).json()).toEqual({});
  expect((await chat.get(project.id,task.id)).contextUsage).toBeUndefined();
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});
test('records subscription limits received during ordinary chats outside conversation history', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-rate-limits-'));
 const projectId = '019a0000-0000-7000-8000-000000000001';
 let usageStore = new Store(join(root, 'beni.sqlite'));
 const createChat = () => {
  const service = new ChatService(p => projectFolder(root, p), () => fake, () => join(import.meta.dir, 'test/fake-claude.ts'));
  service.setAgentStore(usageStore);
  return service;
 };
 const chat = createChat();
 try {
  process.env.FAKE_CODEX_RATE_LIMIT = '25';
  process.env.FAKE_CLAUDE_RATE_LIMIT = '0.4';
  expect((await chat.status()).usage).toBe('unknown');
  await chat.send(projectId, null, 'hello', 'model-a', root);
  await waitFor(async () => (await chat.get(projectId, null)).messages.at(-1)?.status === 'completed');
  const codexUsage = (await chat.status()).usage;
  expect(codexUsage).toMatchObject({windows:[{label:'5時間枠', usedPercent:25, resetsAt:2_000_000_000}]});
  expect((await chat.claudeStatus()).usage).toBe('unknown');
  await chat.send(projectId, null, 'hello', 'haiku', root, undefined, null, false, 'claude');
  await waitFor(async () => (await chat.get(projectId, null)).messages.at(-1)?.status === 'completed');
  const claudeUsage = (await chat.claudeStatus()).usage;
  expect(claudeUsage).toMatchObject({windows:[{label:'7日枠', usedPercent:40, resetsAt:2_000_000_100}]});
  expect(JSON.stringify(await chat.get(projectId, null))).not.toContain('resetsAt');
  usageStore.close();
  usageStore = new Store(join(root, 'beni.sqlite'));
  const restarted = createChat();
  expect((await restarted.status()).usage).toEqual(codexUsage);
  expect((await restarted.claudeStatus()).usage).toEqual(claudeUsage);
  process.env.FAKE_CODEX_EMAIL = 'other@example.test';
  usageStore.invalidateAgentStatus('codex');
  expect((await restarted.status()).usage).toBe('unknown');
  process.env.FAKE_CLAUDE_AUTH = 'none';
  usageStore.invalidateAgentStatus('claude');
  expect((await restarted.claudeStatus()).usage).toBe('unknown');
 } finally {
  usageStore.close();
  delete process.env.FAKE_CODEX_RATE_LIMIT;
  delete process.env.FAKE_CODEX_EMAIL;
  delete process.env.FAKE_CLAUDE_RATE_LIMIT;
  delete process.env.FAKE_CLAUDE_AUTH;
  await rm(root, {recursive:true, force:true});
 }
});
test('refreshes both subscription limits before any chat and shares concurrent probes', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-rate-limit-refresh-'));
 let usageStore = new Store(join(root, 'beni.sqlite'));
 const createChat = () => {
  const service = new ChatService(() => { throw Error('No project should be accessed'); }, () => fake, () => join(import.meta.dir, 'test/fake-claude.ts'));
  service.setAgentStore(usageStore);
  return service;
 };
 const chat = createChat();
 try {
  process.env.FAKE_CODEX_RATE_LIMIT = '23';
  process.env.FAKE_CLAUDE_RATE_LIMIT = '0.37';
  expect((await chat.status()).usage).toBe('unknown');
  expect((await chat.claudeStatus()).usage).toBe('unknown');
  const claude = chat.refreshUsage('claude');
  expect(chat.refreshUsage('claude')).toBe(claude);
  const [codexResult, claudeResult] = await Promise.all([chat.refreshUsage('codex'), claude]);
  expect(codexResult.usage).toMatchObject({windows:[{label:'5時間枠',usedPercent:23}]});
  expect(claudeResult.usage).toMatchObject({windows:[{label:'7日枠',usedPercent:37}]});
  usageStore.close();
  usageStore = new Store(join(root, 'beni.sqlite'));
  const restarted = createChat();
  expect((await restarted.status()).usage).toEqual(codexResult.usage);
  expect((await restarted.claudeStatus()).usage).toEqual(claudeResult.usage);
 } finally {
  usageStore.close();
  delete process.env.FAKE_CODEX_RATE_LIMIT;
  delete process.env.FAKE_CLAUDE_RATE_LIMIT;
  await rm(root, {recursive:true,force:true});
 }
});
test('Claude refresh prefers the structured usage report and retains the percentage for the same window', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-claude-usage-report-'));
 const projectId = '019a0000-0000-7000-8000-000000000001';
 const chat = new ChatService(p => projectFolder(root, p), () => fake, () => join(import.meta.dir, 'test/fake-claude.ts'));
 try {
  process.env.FAKE_CLAUDE_USAGE_REPORT = '1';
  process.env.FAKE_CLAUDE_RATE_LIMIT = 'missing';
  expect((await chat.refreshUsage('claude')).usage).toMatchObject({windows:[
   {label:'5時間枠',usedPercent:0},
   {label:'7日枠',usedPercent:45,resetsAt:2_000_000_100},
  ]});
  await chat.send(projectId, null, 'hello', 'haiku', root, undefined, null, false, 'claude');
  await waitFor(async () => (await chat.get(projectId, null)).messages.at(-1)?.status === 'completed');
  expect((await chat.claudeStatus()).usage).toMatchObject({windows:[
   {label:'5時間枠',usedPercent:0},
   {label:'7日枠',usedPercent:45,resetsAt:2_000_000_100,status:'allowed'},
  ]});
 } finally {
  delete process.env.FAKE_CLAUDE_USAGE_REPORT;
  delete process.env.FAKE_CLAUDE_RATE_LIMIT;
  await rm(root, {recursive:true,force:true});
 }
});
test('streams, persists, resumes, isolates scopes, and interrupts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{
  const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);const status=await chat.status();expect(status).toMatchObject({installed:true,path:fake,version:'1.2.3',auth:'chatgpt',models:[{id:'model-a',name:'Model A'}],usage:'unknown'});expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  await chat.send('019a0000-0000-7000-8000-000000000001',null,'hello','model-a','/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');
  let c=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(c.messages[1].content).toBe('Hello');expect(c.threadId).toBe('thread-1');expect(c.sessionId).toBe('session-1');expect(c.messages[0].sessionId).toBe('session-1');expect(JSON.parse(await readFile(standaloneChatPath(join(dir,'019a0000-0000-7000-8000-000000000001'),c.id),'utf8')).messages).toHaveLength(2);
  expect((await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000002')).messages).toHaveLength(0);await chat.send('019a0000-0000-7000-8000-000000000001',null,'wait','model-a','/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[3].status==='streaming');await expect(chat.send('019a0000-0000-7000-8000-000000000001',null,'duplicate','model-a','/tmp')).rejects.toThrow('busy');await chat.interrupt('019a0000-0000-7000-8000-000000000001',null);await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[3].status==='interrupted');
 }finally{await rm(dir,{recursive:true,force:true})}
});
test.each([
 {name:'task rejection before acceptance',taskId:'019a0000-0000-7100-8000-000000000001',prompt:'reject',status:'failed',content:''},
 {name:'general rejection before acceptance',taskId:null,prompt:'reject',status:'failed',content:''},
 {name:'failure after acceptance',taskId:null,prompt:'fail',status:'failed',content:'Hello'},
 {name:'disconnect before acknowledgement',taskId:null,prompt:'disconnect',status:'unknown',content:''},
])('closes the assistant pack after $name',async({taskId,prompt,status,content})=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-outcome-'));
 const projectId='019a0000-0000-7000-8000-000000000001';
 const chat=new ChatService(p=>projectFolder(root,p),()=>fake);
 try{
  await chat.send(projectId,taskId,prompt,null,root);
  await waitFor(async()=>(await chat.get(projectId,taskId)).messages[1]?.status===status);
  expect((await chat.get(projectId,taskId)).packs.at(-1)).toMatchObject({role:'assistant',content,state:'closed',status});
 }finally{await rm(root,{recursive:true,force:true})}
});
test('reports CLI availability and authentication and refuses non-subscription sending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-'));
 const projectId='019a0000-0000-7000-8000-000000000001';
 try{
  const missing=new ChatService(p=>projectFolder(root,p),()=>null);
  expect((await missing.status()).installed).toBe(false);
  process.env.FAKE_AUTH='apiKey';
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);
  expect((await chat.status()).auth).toBe('apiKey');
  await expect(chat.send(projectId,null,'hello',null,root)).rejects.toThrow('unavailable');
  expect((await chat.get(projectId,null)).messages).toHaveLength(0);
 }finally{delete process.env.FAKE_AUTH;await rm(root,{recursive:true,force:true})}
});
test.each(['initial read','direct send'])('recovers unfinished messages and packs after restart on %s',async entryPoint=>{
 const root=await mkdtemp(join(tmpdir(),'beni-pack-recovery-'));
 const projectId='019a0000-0000-7000-8000-000000000001';
 const chat=new ChatService(p=>projectFolder(root,p),()=>fake);
 try{
  await chat.send(projectId,null,'wait',null,root);
  try{
   await waitFor(async()=>(await chat.get(projectId,null)).messages[1]?.status==='streaming');
   const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);
   const recovered=entryPoint==='direct send'
    ? await restarted.send(projectId,null,'hello',null,root)
    : await restarted.get(projectId,null);
   expect(recovered.messages.slice(0,2).map(message=>message.status)).toEqual(['unknown','unknown']);
   expect(recovered.messages[1]?.diagnostic).toEqual({stage:'recovery',reason:'recovered'});
   expect(recovered.packs[1]).toMatchObject({role:'assistant',status:'unknown',state:'closed'});
   if(entryPoint==='direct send'){
    await waitFor(async()=>(await restarted.get(projectId,null)).messages[3]?.status==='completed');
   }
   expect((await restarted.get(projectId,null)).packs.every(pack=>pack.state==='closed')).toBe(true);
  }finally{await chat.interrupt(projectId,null)}
 }finally{await rm(root,{recursive:true,force:true})}
});
test('HTTP chat scope validates project and task ownership',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');const store=new Store(':memory:');const projectRoot=await mkdtemp(join(tmpdir(),'beni-project-'));const p=store.createProject('One',projectRoot) as {id:string};const other=store.createProject('Two',projectFolder(projectRoot,'other')) as {id:string};const task=store.createTask(p.id,'Task') as {id:string};const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));const handler=createHandler(store,'/tmp',new ChatService(p=>projectFolder(dir,p),()=>fake));const post=(path:string,data:unknown)=>handler(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));try{
  expect((await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${other.id}&taskId=${task.id}&phase=requirements`))).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:other.id,taskId:task.id,phase:'requirements',content:'hello',model:null})).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:p.id,taskId:task.id,phase:'requirements',content:'hello',model:null})).status).toBe(202);
  await waitFor(async()=>{const res=await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${p.id}&taskId=${task.id}&phase=requirements`));return (await res.json()).messages[1].status==='completed'});
 }finally{store.close();await rm(dir,{recursive:true,force:true});await rm(projectRoot,{recursive:true,force:true})}
});

test('rejects server requests with string IDs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);await chat.send('019a0000-0000-7000-8000-000000000001',null,'approval',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');expect((await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].content).toContain('denied')}finally{await rm(dir,{recursive:true,force:true})}
});

test('task conversations write and resume in their document sandbox; general stays read-only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-task-chat-'));
 const {taskDocuments}=await import('./documents');
 const documentDirectory=taskDocuments(root,'019a0000-0000-7100-8000-000000000001',{requirements:'# Initial\n'});const other=taskDocuments(root,'019a0000-0000-7100-8000-000000000002',{requirements:'# Other task\n'});
 const log=join(root,'rpc.jsonl');process.env.FAKE_CODEX_LOG=log;
 try{
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);
  await chat.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','write documents','model-a',root,documentDirectory);
  await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[1].status==='completed');
  expect(await readFile(join(documentDirectory,'requirements.md'),'utf8')).toBe('# Updated requirements\n');
  expect(await readFile(join(documentDirectory,'implementation.md'),'utf8')).toBe('# Updated plan\n');
  expect(await readFile(join(other,'requirements.md'),'utf8')).toBe('# Other task\n');
  const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);
  await restarted.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello','model-a',root,documentDirectory);await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[3].status==='completed');
  await restarted.send('019a0000-0000-7000-8000-000000000001',null,'hello','model-a',root);await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');
  await restarted.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello','model-a',root,documentDirectory,'execution');await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','execution')).messages[1].status==='completed');
  await restarted.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello','model-a',root,documentDirectory);await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[5].status==='completed');
  const events=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const start=events.find(event=>event.method==='thread/start');const resume=events.find(event=>event.method==='thread/resume');
  for(const event of [start,resume]){
   expect(event.params.cwd).toBe(documentDirectory);expect(event.params.sandbox).toBe('workspace-write');expect(event.params.developerInstructions).toContain('requirements.md');expect(event.params.developerInstructions).toContain(root);
  }
  const turns=events.filter(event=>event.method==='turn/start');
  for(const turn of turns.slice(0,2))expect(turn.params).toMatchObject({cwd:documentDirectory,approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[documentDirectory],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
  expect(turns[2].params).toMatchObject({cwd:root,sandboxPolicy:{type:'readOnly',networkAccess:false}});
  const executionResume=events.find(event=>event.method==='thread/start'&&event.params.cwd===root&&event.params.sandbox==='workspace-write');expect(executionResume.params.cwd).toBe(root);expect(executionResume.params.developerInstructions).toContain('ソースコードを実装する');expect(executionResume.params.developerInstructions).toContain('## 仕様');
  expect(turns[3].params).toMatchObject({cwd:root,sandboxPolicy:{type:'workspaceWrite',writableRoots:[root],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
  expect(turns[4].params).toMatchObject({cwd:documentDirectory,sandboxPolicy:{type:'workspaceWrite',writableRoots:[documentDirectory]}});
  expect(events.filter(event=>event.method==='thread/resume').at(-1).params.developerInstructions).toContain('直接変更しない');
 }finally{delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});


test('conversation notifications are scope-specific and removable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-events-'));try{
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);let taskChanges=0,generalChanges=0,otherChanges=0;
  const stopTask=chat.subscribe('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001',()=>taskChanges++),stopGeneral=chat.subscribe('019a0000-0000-7000-8000-000000000001',null,()=>generalChanges++),stopOther=chat.subscribe('019a0000-0000-7000-8000-000000000002','019a0000-0000-7100-8000-000000000001',()=>otherChanges++);
  await chat.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello',null,root);await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[1].status==='completed');
  expect(taskChanges).toBeGreaterThan(0);expect(generalChanges).toBe(0);expect(otherChanges).toBe(0);
  stopTask();const previous=taskChanges;await chat.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello',null,root);await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[3].status==='completed');expect(taskChanges).toBe(previous);stopGeneral();stopOther();
 }finally{await rm(root,{recursive:true,force:true})}
});

test('tool item boundary saves immutable text before turn completion; pack hashes and ordered suffix synchronize',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-packs-'));try{
  const {packHash,validPack}=await import('../shared/communication');const chat=new ChatService(p=>projectFolder(root,p),()=>fake);const events:any[]=[];chat.subscribe('019a0000-0000-7000-8000-000000000001',null,event=>events.push(event));
  await chat.send('019a0000-0000-7000-8000-000000000001',null,'tools','model-a','/tmp');
  await waitFor(async()=>events.some(e=>e.name==='chat.pack.closed'&&e.data.header.role==='assistant'&&e.data.header.kind==='text'));
  const during=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(during.messages[1].status).toBe('streaming');const before=during.packs.find(p=>p.content==='Before tool')!;expect(before.state).toBe('closed');
  expect(Date.parse(before.closedAt!)).toBeGreaterThanOrEqual(Date.parse(before.createdAt));
  expect(events.find(e=>e.name==='chat.pack.closed'&&e.data.packId===before.packId).data.header.closedAt).toBe(before.closedAt);
  const {closedAt,...legacy}=before;
  expect(validPack(legacy)).toBe(true);
  expect(validPack({...before,closedAt:'invalid'})).toBe(false);
  expect(validPack({...before,closedAt:'2000-01-01T00:00:00.000Z'})).toBe(false);
  expect(await packHash(before)).toBe(await packHash(legacy));
  const stored=JSON.parse(await readFile(standaloneChatPath(join(root,'019a0000-0000-7000-8000-000000000001'),during.id),'utf8'));
  expect(stored.version).toBe(3);
  expect(stored).not.toHaveProperty('packs');
  expect(stored.messages[1].parts[0]).toEqual({
   packId:before.packId,sequence:before.sequence,kind:'text',content:'Before tool',tool:null,
   createdAt:before.createdAt,closedAt:before.closedAt,status:before.status,state:'closed',
  });
  expect(await chat.ack('019a0000-0000-7000-8000-000000000001',null,before.packId,await packHash(before))).toEqual({matched:true});expect(await chat.ack('019a0000-0000-7000-8000-000000000001',null,before.packId,'0'.repeat(64))).toEqual({matched:false,pack:before});
  const generating=during.packs.find(p=>p.kind==='tool')!;expect(generating.state).toBe('streaming');await expect(chat.pack('019a0000-0000-7000-8000-000000000001',null,generating.packId)).rejects.toThrow('not closed');
  await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');const after=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(after.packs.map(p=>[p.role,p.kind,p.state])).toEqual([['user','text','closed'],['assistant','text','closed'],['assistant','tool','closed'],['assistant','text','closed']]);
  expect(after.packs[2].tool).toEqual({name:'command',input:'echo example',output:'example\n'});expect(Date.parse(after.packs[2].closedAt!)).toBeGreaterThan(Date.parse(after.packs[2].createdAt));expect(after.packs[0].closedAt).toBeUndefined();expect(after.packs.find(p=>p.packId===before.packId)).toEqual(before);
  expect((await chat.packs('019a0000-0000-7000-8000-000000000001',null,before.packId)).packs.map(p=>p.packId)).toEqual(after.packs.slice(2).map(p=>p.packId));await expect(chat.packs('019a0000-0000-7000-8000-000000000001',null,'missing')).rejects.toThrow('not found');await expect(chat.pack('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000002',before.packId)).rejects.toThrow('not found');
  const closed=events.findIndex(e=>e.name==='chat.pack.closed'&&e.data.packId===before.packId);expect(events.slice(closed+1).some(e=>e.name==='chat.pack.delta'&&e.data.packId===before.packId)).toBe(false);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('パックのない旧履歴は変換せず拒否する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-old-packs-')),p='019a0000-0000-7000-8000-000000000001';
 try{
  const chat=new ChatService(()=>root,()=>fake);await chat.command(p,null,'clear',root);
  const chatId=(await chat.get(p,null)).id,path=standaloneChatPath(root,chatId);
  const bytes=JSON.stringify({version:1,id:chatId,projectId:p,taskId:null,threadId:null,sessionId:null,messages:[]});await writeFile(path,bytes);
  await expect(chat.get(p,null)).rejects.toThrow('Invalid history');expect(await readFile(path,'utf8')).toBe(bytes);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('real shared socket sends only future chat deltas; HTTP closes reconnect gaps and validates pack endpoints',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-wire-'));const {Store}=await import('./store/index');const {createServerOptions}=await import('./server');const {packHash}=await import('../shared/communication');const store=new Store(':memory:');const project=store.createProject('Example',root) as {id:string};const other=store.createProject('Other',projectFolder(root,'other')) as {id:string};const chat=new ChatService(p=>projectFolder(root,p),()=>fake);const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,'/tmp',chat)});const origin=`http://127.0.0.1:${server.port}`;
 const Socket=globalThis.WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};const opened:WebSocket[]=[];
 const connect=async()=>{const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});opened.push(ws);const events:any[]=[];ws.addEventListener('message',event=>events.push(JSON.parse(String(event.data))));await new Promise<void>((resolve,reject)=>{ws.addEventListener('open',()=>resolve(),{once:true});ws.addEventListener('error',()=>reject(Error('Failed to connect')),{once:true})});const next=async()=>{await waitFor(async()=>events.length>0);return events.shift()};ws.send(JSON.stringify({type:'hello',version:1}));expect(await next()).toEqual({type:'ready',version:1});ws.send(JSON.stringify({type:'subscribe',subscriptionId:'chat',topic:'chat',scope:{projectId:project.id,taskId:null}}));expect(await next()).toEqual({type:'subscribed',subscriptionId:'chat'});return {ws,events,next}};
 const get=(path:string)=>fetch(origin+path);const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  const first=await connect();expect(first.events).toHaveLength(0);expect((await post('/api/chat/send',{projectId:project.id,taskId:null,content:'wait',model:null})).status).toBe(202);await waitFor(async()=>first.events.some(e=>e.name==='chat.pack.delta'));const delta=first.events.find(e=>e.name==='chat.pack.delta').data;expect(delta).toMatchObject({delta:'Hello',header:{state:'streaming',kind:'text'}});first.ws.close();
  const again=await connect();await Bun.sleep(30);expect(again.events).toHaveLength(0);const query=`projectId=${project.id}`;let list=await (await get('/api/chat/packs?'+query)).json();expect(list.packs.at(-1)).toEqual({packId:delta.packId,state:'streaming'});expect((await get(`/api/chat/packs/${delta.packId}?${query}`)).status).toBe(409);expect((await post(`/api/chat/packs/${delta.packId}/ack`,{projectId:project.id,taskId:null,hash:'0'.repeat(64)})).status).toBe(409);
  expect((await post('/api/chat/interrupt',{projectId:project.id,taskId:null})).status).toBe(200);await waitFor(async()=>again.events.some(e=>e.name==='chat.pack.closed'&&e.data.packId===delta.packId));const full=await (await get(`/api/chat/packs/${delta.packId}?${query}`)).json();expect(full.pack).toMatchObject({content:'Hello',state:'closed',status:'interrupted'});expect(await (await post(`/api/chat/packs/${delta.packId}/ack`,{projectId:project.id,taskId:null,hash:'0'.repeat(64)})).json()).toEqual({matched:false,pack:full.pack});expect(await (await post(`/api/chat/packs/${delta.packId}/ack`,{projectId:project.id,taskId:null,hash:await packHash(full.pack)})).json()).toEqual({matched:true});
  expect((await get(`/api/chat/packs/${delta.packId}?projectId=${other.id}`)).status).toBe(404);expect((await get(`/api/chat/packs?${query}&afterPackId=missing`)).status).toBe(404);expect((await post(`/api/chat/packs/${delta.packId}/ack`,{projectId:project.id,taskId:null,hash:'invalid'})).status).toBe(400);
  again.ws.close();await chat.send(project.id,null,'tools',null,'/tmp');await waitFor(async()=>(await chat.get(project.id,null)).messages.at(-1)?.status==='completed');const third=await connect();await Bun.sleep(25);expect(third.events).toHaveLength(0);list=await (await get(`/api/chat/packs?${query}&afterPackId=${delta.packId}`)).json();expect(list.packs).toHaveLength(4);expect(list.packs.every((p:any)=>p.state==='closed')).toBe(true);
 }finally{for(const ws of opened)ws.close();server.stop(true);store.close();await rm(root,{recursive:true,force:true})}
});
test('canonical tool hashing ignores object insertion order and rejects inconsistent WS headers',async()=>{
 const {packHash,validEvent}=await import('../shared/communication');
 const pack={packId:'pack',sequence:1,messageId:'message',sendId:'send',role:'assistant' as const,kind:'tool' as const,content:'result',tool:{name:'command',input:'echo example',output:'example'},model:null,createdAt:'2026-01-01',status:'completed' as const,state:'closed' as const};const reordered={...pack,tool:{output:'example',name:'command',input:'echo example'}};expect(await packHash(pack)).toBe(await packHash(reordered));expect(await packHash({...pack,tool:{...pack.tool,output:'changed'}})).not.toBe(await packHash(pack));const {content,tool,...header}=pack;expect(validEvent({name:'chat.pack.closed',data:{packId:'other',header}})).toBe(false);expect(validEvent({name:'chat.pack.delta',data:{packId:'pack',delta:'text',header}})).toBe(false);expect(validEvent({name:'chat.pack.closed',data:{packId:'pack',header}})).toBe(true);
});

test('project-local histories survive a folder move with unchanged packs and scope references',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-move-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';let folder=projectFolder(root,'source');
 try {
  const chat=new ChatService(()=>folder,()=>fake);await chat.send(p,t,'hello',null,folder);await waitFor(async()=>(await chat.get(p,t)).messages[1].status==='completed');const saved=await chat.get(p,t);
  const stored=JSON.parse(await readFile(standaloneChatPath(folder,saved.id),'utf8'));
  expect(stored).toMatchObject({version:3,chatId:saved.id,projectId:p,taskId:t});
  expect(stored).not.toHaveProperty('packs');
  expect(stored.messages).toMatchObject(saved.packs.map(({packId,sequence,content})=>({parts:[{packId,sequence,content}]})));
  const {rename}=await import('node:fs/promises');const moved=join(root,'moved');await rename(folder,moved);folder=moved;
  expect(await new ChatService(()=>folder,()=>fake).get(p,t)).toEqual(saved);
  expect((await new ChatService(()=>folder,()=>fake).get(p,null)).messages).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('rejects unsafe scope, linked chat files and future histories without modifying originals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-safety-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const {mkdir,writeFile,symlink,link}=await import('node:fs/promises');
 try {
  const chat=new ChatService(()=>root,()=>fake);
  await expect(chat.get(t,null)).rejects.toThrow('Invalid chat scope');await expect(chat.get(p,p)).rejects.toThrow('Invalid chat scope');await expect(chat.get(p,'../escape')).rejects.toThrow('Invalid chat scope');
  await chat.command(p,null,'clear',root);const path=standaloneChatPath(root,(await chat.get(p,null)).id);
  const future=JSON.stringify({version:99,projectId:p,taskId:null,messages:[]});await writeFile(path,future);
  await expect(chat.get(p,null)).rejects.toThrow('Invalid history');expect(await readFile(path,'utf8')).toBe(future);await rm(path);
  const target=join(root,'outside.json');await writeFile(target,future);await symlink(target,path);await expect(chat.get(p,null)).rejects.toThrow(/Invalid (chat|metadata) file/);await rm(path);
  await link(target,path);await expect(chat.get(p,null)).rejects.toThrow(/Invalid (chat|metadata) file/);expect(await readFile(target,'utf8')).toBe(future);await rm(path);
  await rm(join(root,'.beni'),{recursive:true});const other=join(root,'outside');await mkdir(other);await symlink(other,join(root,'.beni'));await expect(chat.get(p,null)).rejects.toThrow('Invalid managed directory');
 }finally{await rm(root,{recursive:true,force:true})}
});


test('an unavailable project folder fails without creating a blank chat or files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-unavailable-'));const folder=join(root,'missing');const chat=new ChatService(()=>folder,()=>fake);
 try {
  await expect(chat.get('019a0000-0000-7000-8000-000000000001',null)).rejects.toThrow();
  const {readdir}=await import('node:fs/promises');expect(await readdir(root)).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('フェーズ別の会話・パック・通知を分離し、タスク全体の同時送信を防ぐ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-phase-chat-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const chat=new ChatService(()=>root,()=>fake);let requirements=0,documents=0;
 const stop=chat.subscribe(p,t,()=>requirements++);const stopDocuments=chat.subscribe(p,t,()=>documents++,'documents');
 try{
  const sending=chat.send(p,t,'wait',null,root,undefined,'documents');
  await expect(chat.send(p,t,'hello',null,root)).rejects.toThrow('busy');expect(()=>chat.withIdleTask(p,t,()=>{})).toThrow('busy');await sending;
  await waitFor(async()=>(await chat.get(p,t,'documents')).messages[1].status==='streaming');
  expect((await chat.get(p,t)).messages).toEqual([]);expect(requirements).toBe(0);expect(documents).toBeGreaterThan(0);
  await expect(chat.interrupt(p,t)).rejects.toThrow('not running');await chat.interrupt(p,t,'documents');
  await waitFor(async()=>(await chat.get(p,t,'documents')).messages[1].status==='interrupted');
  const pack=(await chat.get(p,t,'documents')).packs[0];await expect(chat.pack(p,t,pack.packId)).rejects.toThrow('not found');
  await chat.send(p,t,'hello',null,root);await waitFor(async()=>(await chat.get(p,t)).messages[1].status==='completed');
  expect((await chat.get(p,t,'documents')).messages).toHaveLength(2);expect((await chat.get(p,t)).packs[0].sequence).toBe(1);
 }finally{stop();stopDocuments();await rm(root,{recursive:true,force:true})}
});

test('管理外の旧タスク会話を変更せず、フェーズ別会話を独立して保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-old-chat-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const {mkdir,writeFile}=await import('node:fs/promises');const folder=join(root,'.beni','chat');
 try{
  await mkdir(folder,{recursive:true});const old=join(folder,`${t}.json`),bytes=JSON.stringify({version:1,id:'old',projectId:p,taskId:t,threadId:'old-thread',sessionId:'old-session',messages:[],packs:[]});await writeFile(old,bytes);
  const chat=new ChatService(()=>root,()=>fake);for(const phase of ['requirements','documents','implementation','execution','retrospective'] as const)expect((await chat.get(p,t,phase)).messages).toEqual([]);
  await chat.send(p,t,'hello',null,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  expect(await readFile(old,'utf8')).toBe(bytes);expect(JSON.parse(await readFile(standaloneChatPath(root,(await chat.get(p,t)).id),'utf8')).messages).toHaveLength(2);
  for(const phase of ['implementation','execution'] as const){
   await chat.send(p,t,phase,null,root,undefined,phase);await waitFor(async()=>(await chat.get(p,t,phase)).messages.at(-1)?.status==='completed');
   expect(JSON.parse(await readFile(standaloneChatPath(root,(await chat.get(p,t,phase)).id),'utf8'))).toMatchObject({
    phase,messages:[{parts:[{content:phase}]},{parts:[{content:'Hello'}]}],
   });
  }
  expect((await chat.get(p,t,'implementation')).messages[0].content).toBe('implementation');
  expect((await chat.get(p,t,'execution')).messages[0].content).toBe('execution');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('終了はプロジェクト内で直列化し、受付前の失敗では前回の会話を保つ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-finalization-chat-'));
 const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',other='019a0000-0000-7100-8000-000000000002';
 const {taskDocuments}=await import('./documents');
 const documents=taskDocuments(root,t,{requirements:'# 要件\n'});
 const otherDocuments=taskDocuments(root,other,{requirements:'# 要件\n'});
 let executable:string|null=fake,finished=0,rollbacks=0;
 const chat=new ChatService(()=>root,()=>executable);
 chat.setFinalizationFinished(()=>{finished++});
 try{
  const started=chat.startFinalization(p,t,()=>true,()=>{rollbacks++},root,documents);
  await expect(chat.startFinalization(p,other,()=>true,()=>{},root,otherDocuments)).rejects.toThrow('busy');
  expect(await started).toBe(true);
  await waitFor(async()=>finished===1);
  const first=await chat.get(p,t,'finalization');
  const firstFile=JSON.parse(await readFile(standaloneChatPath(root,first.id),'utf8'));
  expect(first.messages).toHaveLength(2);
  expect(await Bun.file(join(root,'.beni','knowledge.md')).exists()).toBe(false);

  executable=null;
  await expect(chat.startFinalization(p,t,()=>true,()=>{rollbacks++},root,documents)).rejects.toThrow('unavailable');
  expect(rollbacks).toBe(1);
  expect(await chat.get(p,t,'finalization')).toEqual(first);

  executable=fake;
  await chat.startFinalization(p,t,()=>true,()=>{rollbacks++},root,documents);
  await waitFor(async()=>finished===2);
  const second=await chat.get(p,t,'finalization');
  expect(second.id).not.toBe(first.id);
  expect(second.messages).toHaveLength(2);
  expect(JSON.parse(await readFile(standaloneChatPath(root,first.id),'utf8'))).toEqual(firstFile);
  expect(chat.workflowSources(p,t,'finalization',first.id)).toEqual({chatId:first.id,messages:first.messages,packs:first.packs});
 }finally{await rm(root,{recursive:true,force:true})}
});

test('大きなツール出力を省略して完了し、実装と反省会の発言だけを次のフェーズに渡す',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-phase-reference-'));
 const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const log=join(root,'rpc.jsonl'),chat=new ChatService(()=>root,()=>fake),records:any[]=[];
 const {taskDocuments}=await import('./documents');
 const documents=taskDocuments(root,t,{requirements:'# 要件\n'});
 const waitForPhase=async(phase:'execution'|'retrospective'|'finalization')=>waitFor(async()=>(await chat.get(p,t,phase)).messages.at(-1)?.status==='completed');
 chat.setTaskEvents({capture:()=>{},events:()=>({events:[],lastEventId:records.length,through:records.length,hasMore:false}),append:(_p,input)=>records.push(input)});
 process.env.FAKE_CODEX_LOG=log;
 try{
  await chat.send(p,t,'large tools',null,root,documents,'execution');
  await waitForPhase('execution');
  const execution=await chat.get(p,t,'execution'),pack=execution.packs.find(pack=>pack.kind==='tool')!;
  expect(pack.status).toBe('completed');
  expect(pack.tool?.input).toContain('省略');
  expect(pack.tool?.output).toContain('省略');
  expect(pack.tool?.output.endsWith('OUTPUT_TAIL')).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThanOrEqual(1024*1024);
  expect(records.at(-1)?.details.result).toBe('completed');
  expect(execution.messages.at(-1)?.content).toContain('After tool');
  const executionFile=standaloneChatPath(root,execution.id);
  const storedExecution=JSON.parse(await readFile(executionFile,'utf8'));
  storedExecution.messages.at(-1).contentOverride='実装報告🧪"\\'.repeat(2_000)+'最終結論';
  await writeFile(executionFile,JSON.stringify(storedExecution));

  await chat.send(p,t,'反省会の質問',null,root,documents,'retrospective');
  await waitForPhase('retrospective');
  await chat.send(p,t,'反省会の続き',null,root,documents,'retrospective');
  await waitForPhase('retrospective');
  storedExecution.messages.at(-1).contentOverride='修正済みの実装報告';
  await writeFile(executionFile,JSON.stringify(storedExecution));
  await chat.send(p,t,'更新された報告を確認',null,root,documents,'retrospective');
  await waitForPhase('retrospective');
  await chat.startFinalization(p,t,()=>true,()=>{},root,documents);
  await waitForPhase('finalization');
  const turns=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.method==='turn/start');
  const inputs=turns.map(row=>row.params.input.map((input:{text:string})=>input.text));
  const excerpt=inputs[1].find((text:string)=>text.startsWith('実装の会話抜粋'));
  expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(16*1024);
  expect(excerpt).not.toContain('\ufffd');
  expect(excerpt).not.toContain('TOOL_OUTPUT_PRIVATE');
  expect(JSON.parse(excerpt.split('\n')[1])).toMatchObject({omitted:true,messages:[{role:'assistant',status:'completed'}]});
  expect(excerpt).toContain('最終結論');
  expect(inputs[2].some((text:string)=>text.startsWith('実装の会話抜粋'))).toBe(false);
  expect(inputs[3].find((text:string)=>text.startsWith('実装の会話抜粋'))).toContain('修正済みの実装報告');
  const finalExcerpt=inputs[4].find((text:string)=>text.startsWith('反省会の会話抜粋'));
  expect(JSON.parse(finalExcerpt.split('\n')[1])).toMatchObject({omitted:false,messages:[
   {role:'user',status:'completed',content:'反省会の質問'},{role:'assistant',status:'completed',content:'Hello'},
   {role:'user',status:'completed',content:'反省会の続き'},{role:'assistant',status:'completed',content:'Hello'},
   {role:'user',status:'completed',content:'更新された報告を確認'},{role:'assistant',status:'completed',content:'Hello'}
  ]});
  expect(inputs[4].some((text:string)=>text.startsWith('Beni project event review range:'))).toBe(false);
 }finally{delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('引継ぎは上限だけ渡し、ツールの確認完了で進め、未確認範囲を再送する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-phase-cursor-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'rpc.jsonl');process.env.FAKE_CODEX_LOG=log;let tail=3;
 const chat=new ChatService(()=>root,()=>fake);chat.setTaskEvents({capture:()=>{},events:(_p,_t,after,through=tail,limit=100)=>{const next=Math.min(after+limit,through);return {events:next>after?[{id:next,type:'document.updated',path:'requirements.md',secret:'never-injected'}]:[],lastEventId:next,nextCursor:next,through,hasMore:next<through}}});
 try{
  await chat.send(p,t,'reject',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='failed');expect((await chat.get(p,t)).lastEventId).toBe(0);
  await chat.send(p,t,'hello',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(0);
  await chat.send(p,t,'event tools',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(3);
  tail=4;await chat.send(p,t,'event tools',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(4);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),turns=records.filter(event=>event.method==='turn/start');expect(turns[0].params.input[1].text).toContain('after 0, through 3');expect(turns[1].params.input.map((item:{text:string})=>item.text).join('\n')).toContain('after 0, through 3');expect(turns[3].params.input[1].text).toContain('after 3, through 4');expect(JSON.stringify(turns)).not.toContain('never-injected');expect(records.find(event=>event.method==='thread/start').params.dynamicTools.map((tool:any)=>tool.name)).toContain('acknowledge_events');expect(records.find(event=>event.method==='thread/resume').params.dynamicTools).toBeUndefined();
 }finally{delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('受理不明の切断では引継ぎカーソルを進めず、読込中の削除を防ぐ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-cursor-unknown-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';const chat=new ChatService(()=>root,()=>fake);let delivered=0;
 chat.setTaskEvents({capture:()=>{},events:(_p,_t,after)=>{if(after===0)delivered++;return {events:after===0?[{id:1}]:[],through:1,lastEventId:1,hasMore:false}}});
 try{
  const reading=chat.get(p,t,'documents');expect(()=>chat.deleteTask(p,t,()=>{})).toThrow('busy');await reading;
  await chat.send(p,t,'disconnect',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='unknown');expect((await chat.get(p,t)).lastEventId).toBe(0);
  await chat.send(p,t,'event tools',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(1);expect(delivered).toBe(3);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('停止は送信準備と実行完了を待ち、新送信とphase変更を拒否する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-stop-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const chat=new ChatService(()=>root,()=>fake);
 try{
  const sending=chat.send(p,t,'wait',null,root,root,'documents');
  let changed=false;
  const stopping=chat.stopTask(p,t,()=>{changed=true});
  await expect(chat.send(p,t,'duplicate',null,root,root,'requirements')).rejects.toThrow('busy');
  expect(()=>chat.withIdleTask(p,t,()=>{})).toThrow('busy');
  await sending;await stopping;
  expect(changed).toBe(true);expect((await chat.get(p,t,'documents')).messages.at(-1)?.status).toBe('interrupted');
  expect(()=>chat.withIdleTask(p,t,()=>{})).not.toThrow();
  const again=chat.send(p,t,'wait',null,root,root,'documents');await again;
  await expect(chat.stopTask(p,t,()=>{},()=>{throw Error('phase conflict')})).rejects.toThrow('phase conflict');
  await waitFor(async()=>(await chat.get(p,t,'documents')).messages.at(-1)?.status==='streaming');
  await chat.stopTask(p,t,()=>{});
 }finally{await rm(root,{recursive:true,force:true})}
});

test('送信したモデルをフェーズごとに保存し、不在モデルでは履歴を追加しない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-models-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 try{
  const agent=new CodexAgent(()=>fake);
  const chat=new ChatService(p=>projectFolder(root,p),[agent]);
  await chat.send(p,t,'hello','model-a',root);
  await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const status=await agent.getStatus();
  agent.getStatus=async()=>({...status,models:[...status.models!,{id:'model-b',name:'Model B'}]});
  await chat.send(p,t,'hello','model-b',root);
  await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);
  expect((await restarted.get(p,t)).selectedModel).toEqual({id:'model-b',name:'Model B',provider:'codex'});
  expect((await restarted.get(p,t)).messages[0]!.model).toBe('model-a');
  expect((await restarted.get(p,t,'documents')).selectedModel).toBe(null);
  expect((await restarted.get(p,null)).selectedModel).toBe(null);
  await expect(restarted.send(p,t,'hello','missing',root)).rejects.toThrow('model unavailable');
  expect((await restarted.get(p,t)).messages).toHaveLength(4);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('モデル拒否と一般的な拒否を区別し、生成中の重複送信では選択を変えない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-model-reject-'));const p='019a0000-0000-7000-8000-000000000001';
 try{
  const chat=new ChatService(()=>root,()=>fake);
  await chat.send(p,null,'reject model','model-a',root);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');
  expect((await chat.get(p,null)).messages.at(-1)?.errorCode).toBe('MODEL_UNAVAILABLE');
  await chat.send(p,null,'reject','model-a',root);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');
  expect((await chat.get(p,null)).messages.at(-1)?.errorCode).toBeUndefined();
  await chat.send(p,null,'wait','model-a',root);
  await expect(chat.send(p,null,'hello','missing',root)).rejects.toThrow('busy');
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='streaming');
  await chat.interrupt(p,null);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='interrupted');
  expect((await chat.get(p,null)).selectedModel?.id).toBe('model-a');
 }finally{await rm(root,{recursive:true,force:true})}
});

const fakeClaude=join(import.meta.dir,'test/fake-claude.ts');
test('Claude の thinking に続く本文は一つの確定パックとして保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-split-'));
 const p='019a0000-0000-7000-8000-000000000001';
 const createChat=()=>new ChatService(()=>root,()=>null,()=>fakeClaude);
 try{
  const chat=createChat();
  await chat.send(p,null,'test: claude split assistant blocks','haiku',root,undefined,null,false,'claude');
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const saved=await createChat().get(p,null);
  const reply=saved.messages.at(-1)!;
  expect(reply.content).toBe('Split Claude response.');
  const replyPacks=saved.packs.filter(pack=>pack.messageId===reply.id);
  expect(replyPacks).toHaveLength(1);
  expect(replyPacks[0]).toMatchObject({kind:'text',state:'closed',content:'Split Claude response.'});
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Claude の送信・ツール・中断と同じ接続先の再開を保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-chat-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'claude.jsonl');
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude),events:any[]=[];chat.subscribe(p,null,event=>events.push(event));
  expect((await chat.claudeStatus()).auth).toBe('claude');
  await chat.send(p,null,'tools','opus',root,undefined,null,false,'claude','editor');
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const first=await chat.get(p,null),session=first.sessionId;
  expect(first.selectedModel).toEqual({id:'opus',name:'Opus',provider:'claude'});expect(first.sessionProvider).toBe('claude');
  expect(first.messages.every(m=>m.provider==='claude'&&m.model==='opus')).toBe(true);
  expect(first.packs.every(pack=>pack.provider==='claude')).toBe(true);
  expect(first.packs.find(pack=>pack.kind==='tool')?.tool).toMatchObject({name:'Read',output:'Example contents'});
  expect(events.some(event=>event.name==='chat.pack.delta')).toBe(true);
  const restarted=new ChatService(()=>root,()=>null,()=>fakeClaude);
  await restarted.send(p,null,'wait',null,root,undefined,null,false,'claude','editor');
  await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='streaming');
  await restarted.interrupt(p,null);await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='interrupted');
  expect((await restarted.get(p,null)).sessionId).toBe(session);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records[1].args).toContain('--resume');expect(records[1].session).toBe(session);expect(records[1].prompt).toBe('wait');
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

test('接続先を往復するとそれぞれのセッションを再開し、未添付の会話だけを引き継ぐ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-provider-switch-')),p='019a0000-0000-7000-8000-000000000001',claudeLog=join(root,'claude.jsonl'),codexLog=join(root,'codex.jsonl');
 process.env.FAKE_CLAUDE_LOG=claudeLog;process.env.FAKE_CODEX_LOG=codexLog;
 try{
  const chat=new ChatService(()=>root,()=>fake,()=>fakeClaude);
  await chat.send(p,null,'Codex context','model-a',root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const chatId=(await chat.get(p,null)).id;
  await chat.send(p,null,'Claude question',null,root,undefined,null,false,'claude','editor');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const claude=await chat.get(p,null);expect(claude.id).toBe(chatId);expect(claude.threadId).not.toBe('thread-1');expect(claude.selectedModel?.id).toBe('sonnet');
  const invocation=JSON.parse((await readFile(claudeLog,'utf8')).trim());expect(invocation.args).toContain('--session-id');expect(invocation.args).not.toContain('--resume');expect(invocation.prompt).toContain('Codex context');expect(invocation.prompt).toContain('Hello');
  const restarted=new ChatService(()=>root,()=>fake,()=>fakeClaude);
  await restarted.send(p,null,'Codex returns',null,root);await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='completed');
  const result=await restarted.get(p,null);expect(result.id).toBe(chatId);expect(result.messages.map(m=>m.provider)).toEqual(['codex','codex','claude','claude','codex','codex']);expect(result.messages[0]?.model).toBe('model-a');expect(result.messages[2]?.model).toBe('sonnet');
  expect(result.threadId).toBe('thread-1');
  const records=(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(record=>record.method==='thread/resume')).toHaveLength(1);expect(records.filter(record=>record.method==='thread/start')).toHaveLength(1);
  const turn=records.filter(record=>record.method==='turn/start').at(-1);expect(turn.params.input[1].text).toContain('Claude question');expect(turn.params.input[1].text).not.toContain('Codex context');
  await restarted.send(p,null,'Claude returns','sonnet',root,undefined,null,false,'claude');
  await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='completed');
  const resumed=(await readFile(claudeLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).at(-1);
  expect(resumed.args).toContain('--resume');expect(resumed.session).toBe(claude.sessionId);
  expect(resumed.prompt).toContain('Codex returns');expect(resumed.prompt).not.toContain('Codex context');expect(resumed.prompt).not.toContain('Claude question');
  await restarted.send(p,null,'Claude continues','sonnet',root,undefined,null,false,'claude');
  await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='completed');
  const continued=(await readFile(claudeLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).at(-1);
  expect(continued.prompt).toBe('Claude continues');expect(continued.session).toBe(claude.sessionId);
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('同じ接続先のモデルを往復すると保存済みのモデル別セッションを再開する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-model-switch-'));
 const projectId='019a0000-0000-7000-8000-000000000001';
 const log=join(root,'claude.jsonl');
 const createChat=()=>new ChatService(()=>root,()=>null,()=>fakeClaude);
 const send=async(chat:ChatService,model:string,content:string)=>{
  await chat.send(projectId,null,content,model,root,undefined,null,false,'claude');
  await waitFor(async()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
  return chat.get(projectId,null);
 };
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  const chat=createChat();
  const haiku=await send(chat,'haiku','Haiku question');
  const sonnet=await send(chat,'sonnet','Sonnet question');
  expect(haiku.sessionId).toBeTruthy();
  expect(sonnet.sessionId).toBeTruthy();
  expect(sonnet.sessionId).not.toBe(haiku.sessionId);

  const restarted=createChat();
  const resumed=await send(restarted,'haiku','Haiku follow-up');
  expect(resumed.version).toBe(1);
  expect(resumed.sessionId).toBe(haiku.sessionId);
  const invocations=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(invocations[0].args).toContain('--session-id');
  expect(invocations[1].args).toContain('--session-id');
  expect(invocations[2].args).toContain('--resume');
  expect(invocations[2].session).toBe(haiku.sessionId);
  expect(invocations[2].prompt).toContain('Sonnet question');
  expect(invocations[2].prompt).not.toContain('Haiku question');

  const stored=JSON.parse(await readFile(standaloneChatPath(root,resumed.id),'utf8'));
  expect(stored).toMatchObject({
   version:3,selectedModelId:'claude/haiku',
   providers:{claude:{name:'Claude',models:{
    haiku:{name:'Haiku',session:{resumeId:haiku.threadId,legacySessionId:haiku.sessionId,lastEventId:0}},
    sonnet:{name:'Sonnet',session:{resumeId:sonnet.threadId,legacySessionId:sonnet.sessionId,lastEventId:0}},
   }}},
  });
  expect(stored).not.toHaveProperty('packs');
  expect(stored).not.toHaveProperty('threadId');
  expect(stored).not.toHaveProperty('sessionId');
  expect(stored.providers.claude.models.haiku.messageData[haiku.messages[0]!.id]).toEqual({
   resumeId:haiku.threadId,legacySessionId:haiku.sessionId,
  });
  expect(stored.messages.map((message:{modelId:string})=>message.modelId)).toEqual([
   'claude/haiku','claude/haiku','claude/sonnet','claude/sonnet','claude/haiku','claude/haiku',
  ]);
  for(const message of stored.messages){
   expect(message).not.toHaveProperty('threadId');
   expect(message).not.toHaveProperty('sessionId');
   expect(message).not.toHaveProperty('model');
   expect(message).not.toHaveProperty('content');
   expect(message).not.toHaveProperty('contentOverride');
  }
  const reloaded=await createChat().get(projectId,null);
  expect(reloaded.messages).toEqual(resumed.messages);
  expect(reloaded.packs).toEqual(resumed.packs);

  process.env.FAKE_CLAUDE_CONTEXT_PROBE='valid';
  expect(await restarted.getContextUsage(projectId,null,null,'claude','opus',root)).toBeUndefined();
  expect(await restarted.getContextUsage(projectId,null,null,'claude','sonnet',root,{refresh:true})).toEqual({usedTokens:24_000,maxTokens:200_000});
  const probeInvocation=JSON.parse((await readFile(log,'utf8')).trim().split('\n').at(-1)!);
  expect(probeInvocation.args).toContain('--resume');
  expect(probeInvocation.session).toBe(sonnet.sessionId);
  expect((await restarted.get(projectId,null)).sessionId).toBe(haiku.sessionId);
 }finally{delete process.env.FAKE_CLAUDE_CONTEXT_PROBE;delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

test('v1 の接続先別セッションを対応する最新モデルに移し、既存のアーカイブを読み込む',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-legacy-chat-'));
 const projectId='019a0000-0000-7000-8000-000000000001';
 const id='019a0000-0000-4000-8000-000000000001';
 const legacyArchiveId='019a0000-0000-4000-8000-000000000002';
 const claudeSession='019a0000-0000-4000-8000-000000000003';
 const directory=join(root,'.beni');
 const log=join(root,'claude.jsonl'), chat=new ChatService(()=>root,()=>fake,()=>fakeClaude);
 const time='2026-01-01T00:00:00.000Z';
 const messages=['haiku','sonnet'].map((model,i)=>({
  id:`old-message-${i}`,sendId:`old-send-${i}`,role:'user' as const,content:`Old ${model}`,
  provider:'claude',model,createdAt:time,updatedAt:time,status:'completed' as const,
  threadId:claudeSession,sessionId:claudeSession,
 }));
 const legacy={
  version:1,id,projectId,taskId:null,phase:null,lastEventId:0,
  sessionProvider:'codex',threadId:'thread-1',sessionId:'session-1',
  selectedModel:{id:'model-a',name:'Model A',provider:'codex'},
  sessions:{claude:{threadId:claudeSession,sessionId:claudeSession,lastEventId:0,contextMessageCount:2}},
  messages,packs:[],
 };
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  const history=join(directory,'history');
  mkdirSync(history,{recursive:true});
  await writeFile(join(directory,'general.json'),JSON.stringify(legacy));
  const archived=JSON.stringify({...legacy,id:legacyArchiveId});
  await writeFile(join(history,`${legacyArchiveId}.json`),archived);
  await migrateStandaloneChat(root,projectId);
  const migratedCurrent=await chat.get(projectId,null),migratedArchive=chat.workflowSources(projectId,null,null,legacyArchiveId)!;
  expect(migratedCurrent.id).not.toBe(id);
  expect(migratedArchive.chatId).not.toBe(legacyArchiveId);
  expect(chat.workflowHistoryIds(projectId,null,null)).toEqual(expect.arrayContaining([migratedCurrent.id,migratedArchive.chatId]));
  expect(migratedArchive).toEqual({chatId:migratedArchive.chatId,messages,packs:[]});
  expect(migratedCurrent.messages).toEqual(messages);
  const file=standaloneChatPath(root,migratedCurrent.id),archive=standaloneChatPath(root,migratedArchive.chatId);
  const archivedBytes=await readFile(archive,'utf8');
  await expect(readFile(join(directory,'general.json'),'utf8')).rejects.toThrow();
  await expect(readFile(join(history,`${legacyArchiveId}.json`),'utf8')).rejects.toThrow();

  await chat.send(projectId,null,'Continue legacy Sonnet','sonnet',root,undefined,null,false,'claude');
  await waitFor(async()=>(await chat.get(projectId,null)).messages.at(-1)?.status==='completed');
  const invocation=JSON.parse((await readFile(log,'utf8')).trim());
  expect(invocation.args).toContain('--resume');
  expect(invocation.session).toBe(claudeSession);
  const current=await chat.get(projectId,null);
  expect(current.id).toBe(migratedCurrent.id);
  expect(current.messages.slice(0,messages.length)).toEqual(messages);

  const migrated=JSON.parse(await readFile(file,'utf8'));
  expect(migrated).toMatchObject({
   version:3,selectedModelId:'claude/sonnet',
   providers:{
    codex:{models:{'model-a':{name:'Model A',session:{resumeId:'thread-1',legacySessionId:'session-1'}}}},
    claude:{models:{sonnet:{session:{resumeId:claudeSession}}}},
   },
  });
  expect(migrated.messages.slice(0,messages.length)).toMatchObject(messages.map(({content})=>({contentOverride:content,parts:[]})));
  expect(migrated.providers.claude.models.haiku).not.toHaveProperty('session');
  expect(await readFile(archive,'utf8')).toBe(archivedBytes);
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

test('v2 の移行とアーカイブで旧本文とパックの順序・ハッシュを維持する',async()=>{
 const {packHash}=await import('../shared/communication');
 const root=await mkdtemp(join(tmpdir(),'beni-v2-chat-'));
 const projectId='019a0000-0000-7000-8000-000000000001',id='019a0000-0000-4000-8000-000000000001';
 const directory=join(root,'.beni'),file=join(directory,'general.chat.json');
 const createdAt='2026-01-01T00:00:00.000Z',closedAt='2026-01-01T00:00:01.000Z';
 const message={sendId:'send',createdAt,updatedAt:closedAt,status:'completed' as const};
 const packs=[
  {packId:'user',sequence:1,messageId:'question',role:'user' as const,kind:'text' as const,content:'Run example',tool:null,model:null},
  {packId:'text-before',sequence:2,messageId:'answer',role:'assistant' as const,kind:'text' as const,content:'Before. ',tool:null,model:'model-a'},
  {packId:'tool',sequence:3,messageId:'answer',role:'assistant' as const,kind:'tool' as const,content:'',tool:{name:'command',input:'echo example',output:'example\n'},provider:'claude',model:'sonnet'},
  {packId:'text-after',sequence:4,messageId:'answer',role:'assistant' as const,kind:'text' as const,content:'After.',tool:null,provider:'codex',model:'model-a'},
 ].map(pack=>({...pack,sendId:message.sendId,createdAt,closedAt,status:message.status,state:'closed' as const}));
 const legacy={
  version:2,id,projectId,taskId:null,phase:null,selectedModelId:'codex/model-a',
  providers:{codex:{name:'Codex',models:{'model-a':{name:'Model A'}}}},
  messages:[
   {...message,id:'question',role:'user',modelId:null,providerId:'codex',content:'Run example'},
   {...message,id:'answer',role:'assistant',modelId:'codex/model-a',content:'Original answer body'},
  ],
  packs,
 };
 try{
  mkdirSync(directory,{recursive:true});
  const bytes=JSON.stringify(legacy);
  await writeFile(file,bytes);
  await migrateStandaloneChat(root,projectId);
  const chat=new ChatService(()=>root,()=>fake);
  const before=await chat.get(projectId,null);
  expect(before.version).toBe(1);
  expect(before.messages.map(item=>item.content)).toEqual(legacy.messages.map(item=>item.content));
  expect(before.packs).toEqual(packs);
  await expect(readFile(file,'utf8')).rejects.toThrow();
  const archive=standaloneChatPath(root,before.id),archiveBytes=await readFile(archive,'utf8');

  await chat.command(projectId,null,'clear',root);
  expect(await readFile(archive,'utf8')).toBe(archiveBytes);
  expect(JSON.parse(archiveBytes)).toMatchObject({version:2,chatId:before.id,packs});
  const encoded=encodeChatHistory(before);
  expect(encoded.version).toBe(3);
  expect(encoded).not.toHaveProperty('packs');
  expect(encoded.messages).toMatchObject([
   {modelId:null,providerId:'codex',parts:[{packId:'user',sequence:1,provider:null}]},
   {contentOverride:'Original answer body',parts:[
    {packId:'text-before',sequence:2,provider:null},
    {packId:'tool',sequence:3,provider:'claude',model:'sonnet',tool:packs[2]!.tool},
    {packId:'text-after',sequence:4,content:'After.'},
   ]},
  ]);
  expect(encoded.messages[0]).not.toHaveProperty('contentOverride');
  for(const stored of encoded.messages)expect(stored).not.toHaveProperty('content');

  const restarted=new ChatService(()=>root,()=>fake);
  const recovered=restarted.workflowSources(projectId,null,null,id)!;
  expect(recovered).toEqual({chatId:before.id,messages:before.messages,packs});
  expect(await Promise.all(recovered.packs.map(packHash))).toEqual(await Promise.all(packs.map(packHash)));
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Claude のモデル拒否・切断を区別し、利用不可なら履歴を追加しない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-reject-')),p='019a0000-0000-7000-8000-000000000001';
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude);
  await expect(chat.send(p,null,'hello','missing',root,undefined,null,false,'claude')).rejects.toThrow('model unavailable');expect((await chat.get(p,null)).messages).toHaveLength(0);
  await chat.send(p,null,'reject model','sonnet',root,undefined,null,false,'claude','editor');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');expect((await chat.get(p,null)).messages.at(-1)?.errorCode).toBe('MODEL_UNAVAILABLE');
  await chat.send(p,null,'reject','sonnet',root,undefined,null,false,'claude','editor');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');expect((await chat.get(p,null)).messages.at(-1)?.errorCode).toBeUndefined();
  await chat.send(p,null,'disconnect','sonnet',root,undefined,null,false,'claude','editor');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='unknown');
  process.env.FAKE_CLAUDE_AUTH='api_key';await expect(chat.send(p,null,'hello','sonnet',root,undefined,null,false,'claude')).rejects.toThrow('unavailable');expect((await chat.get(p,null)).messages).toHaveLength(6);
 }finally{delete process.env.FAKE_CLAUDE_AUTH;await rm(root,{recursive:true,force:true})}
});

test('パックの接続先は検証とハッシュに反映し、既存 Codex ハッシュを変えない',async()=>{
 const {packHash,validPack}=await import('../shared/communication');const pack={packId:'pack',sequence:1,messageId:'message',sendId:'send',role:'user' as const,kind:'text' as const,content:'Example',tool:null,model:null,createdAt:'2026-01-01T00:00:00.000Z',status:'completed' as const,state:'closed' as const};
 expect(validPack({...pack,provider:'claude'})).toBe(true);expect(validPack({...pack,provider:'another-agent'})).toBe(true);expect(validPack({...pack,provider:'../invalid'})).toBe(false);
 expect(await packHash({...pack,provider:'codex'})).toBe(await packHash(pack));expect(await packHash({...pack,provider:'claude'})).not.toBe(await packHash(pack));expect(await packHash({...pack,provider:'another-agent'})).not.toBe(await packHash(pack));
});

test('Claude は受理前にセッションとカーソルを保存せず、中断しても自動再送しない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-accept-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'claude.jsonl');
 process.env.FAKE_CLAUDE_LOG=log;process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS='500';
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude);chat.setTaskEvents({capture:()=>{},events:()=>({events:[{id:1,type:'document.updated',path:'requirements.md'}],lastEventId:1,through:1,hasMore:false})});
  await chat.send(p,t,'event tools','sonnet',root,undefined,'requirements',false,'claude');
  await waitFor(async()=>{try{return (await readFile(log,'utf8')).includes('session')}catch{return false}});
  const pending=await chat.get(p,t);expect(pending).toMatchObject({threadId:null,sessionId:null,lastEventId:0});expect(pending.messages.every(message=>message.sessionId===null&&message.threadId===null)).toBe(true);
  await chat.interrupt(p,t);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='interrupted');
  expect(await chat.get(p,t)).toMatchObject({threadId:null,sessionId:null,lastEventId:0});
  await Bun.sleep(30);expect((await readFile(log,'utf8')).trim().split('\n')).toHaveLength(1);
  delete process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS;
  await chat.send(p,t,'event tools','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  expect((await chat.get(p,t)).lastEventId).toBe(1);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(records[1].args).toContain('--session-id');expect(records[1].args).not.toContain('--resume');expect(records[1].session).not.toBe(records[0].session);expect(records[1].prompt).toContain('after 0, through 1');
  const accepted=await chat.get(p,t);process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS='500';
  await chat.send(p,t,'Pending resume','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await readFile(log,'utf8')).trim().split('\n').length===3);
  await chat.interrupt(p,t);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='interrupted');expect(await chat.get(p,t)).toMatchObject({threadId:accepted.threadId,sessionId:accepted.sessionId,lastEventId:1});
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS;await rm(root,{recursive:true,force:true})}
});

test('Claude の受理前終了・モデル拒否では新規セッションや引継ぎ済みカーソルを残さない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-early-exit-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude);chat.setTaskEvents({capture:()=>{},events:()=>({events:[{id:1,type:'document.updated'}],lastEventId:1,through:1,hasMore:false})});
  await chat.send(p,t,'early exit','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='unknown');
  expect(await chat.get(p,t)).toMatchObject({threadId:null,sessionId:null,lastEventId:0});expect((await chat.get(p,t)).messages).toHaveLength(2);
  await chat.send(p,t,'reject model','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='failed');
  expect(await chat.get(p,t)).toMatchObject({threadId:null,sessionId:null,lastEventId:0});expect((await chat.get(p,t)).messages.at(-1)).toMatchObject({errorCode:'MODEL_UNAVAILABLE',sessionId:null,threadId:null});
  await chat.send(p,t,'event tools','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const accepted=await chat.get(p,t);expect(accepted.threadId).not.toBeNull();expect(accepted.lastEventId).toBe(1);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Claude の明示的な再開先欠落だけを一回再送し、受理済みのセッションを保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-missing-resume-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'claude.jsonl');
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude);let through=1;
  chat.setTaskEvents({capture:()=>{},events:(_p,_t,after)=>({events:after<through?[{id:through,type:'document.updated'}]:[],lastEventId:through,through,hasMore:false})});
  const send=async(content:string,status='completed')=>{
   await chat.send(p,t,content,'sonnet',root,undefined,'requirements',false,'claude');
   await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status===status);
   return chat.get(p,t);
  };
  const accepted=await send('event tools');through=2;
  process.env.FAKE_CLAUDE_RESUME_MISSING='after-init';
  expect((await send('Already initialized','failed')).sessionId).toBe(accepted.sessionId);
  delete process.env.FAKE_CLAUDE_RESUME_MISSING;
  expect((await send('reject','failed')).sessionId).toBe(accepted.sessionId);
  expect((await send('disconnect','unknown')).sessionId).toBe(accepted.sessionId);
  process.env.FAKE_CLAUDE_RESUME_MISSING='1';
  const replaced=await send('event tools');
  expect(replaced.sessionId).not.toBe(accepted.sessionId);
  expect(replaced.lastEventId).toBe(2);
  expect(replaced.messages).toHaveLength(10);
  expect(replaced.messages.slice(0,2)).toEqual(accepted.messages);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records).toHaveLength(6);
  expect(records.slice(1,5).every(record=>record.args.includes('--resume')&&record.session===accepted.sessionId)).toBe(true);
  expect(records[4].prompt).toContain('after 1, through 2');
  expect(records[5].args).toContain('--session-id');expect(records[5].session).toBe(replaced.sessionId);
  expect(records[5].prompt).toContain('after 0, through 2');
  expect(records[5].prompt).toContain('reference conversation history');
  process.env.FAKE_CLAUDE_RESUME_MISSING='stderr';
  expect((await send('wait','streaming')).sessionId).not.toBe(replaced.sessionId);
  await chat.interrupt(p,t);
  await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='interrupted');
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CLAUDE_RESUME_MISSING;await rm(root,{recursive:true,force:true})}
});

test('Codex は明示的なスレッド欠落だけを復旧し、保存済み会話を一度送信する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-codex-missing-resume-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'codex.jsonl');
 process.env.FAKE_CODEX_LOG=log;
 try{
  const chat=new ChatService(()=>root,()=>fake);
  const send=async(content:string,status='completed')=>{
   await chat.send(p,null,content,null,root);
   await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status===status);
   return chat.get(p,null);
  };
  const first=await send('Original question');
  process.env.FAKE_CODEX_RESUME='reject';
  expect((await send('Rejected before turn','failed')).threadId).toBe(first.threadId);
  process.env.FAKE_CODEX_RESUME='missing';
  const next=await send('Replacement question');
  expect(next.threadId).toBe('thread-replacement');expect(next.sessionId).toBe('session-replacement');
  expect(next.messages).toHaveLength(6);
  expect(next.messages.slice(0,2)).toEqual(first.messages);
  const last=await send('Resume replacement');
  expect(last.threadId).toBe(next.threadId);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(record=>record.method==='thread/start')).toHaveLength(2);
  expect(records.filter(record=>record.method==='thread/resume').map(record=>record.params.threadId)).toEqual(['thread-1','thread-1','thread-replacement']);
  const turns=records.filter(record=>record.method==='turn/start');
  expect(turns.map(record=>record.params.input[0].text)).toEqual(['Original question','Replacement question','Resume replacement']);
  expect(turns[1].params.input[1].text).toContain('Original question');
  expect(turns[2].params.input).toHaveLength(1);
 }finally{delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_CODEX_RESUME;await rm(root,{recursive:true,force:true})}
});

test('両接続先の埋め込みツールは同一プロジェクトだけを参照し、確認範囲と入力を検証する',async()=>{
 for(const provider of ['codex','claude'] as const){
  const root=await mkdtemp(join(tmpdir(),'beni-embedded-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',other='019a0000-0000-7100-8000-000000000002';
  const chat=new ChatService(()=>root,()=>fake,()=>fakeClaude),lookups:any[]=[];
  chat.setTaskEvents({capture:()=>{},events:(project,task,after,through=6,limit=100,types)=>{
   lookups.push([project,task,after,through,limit,types]);
   const data=[
    {id:1,type:'document.updated',taskId:t,path:'requirements.md',version:'latest',previousVersion:'previous',chatId:'hidden'},
    {id:2,type:'tool.finished',taskId:t,details:{result:'completed'}},
    {id:3,type:'tool.finished',taskId:other,details:{result:'completed'}}
   ];
   const matches=data.filter(event=>event.id>after&&event.id<=through&&(task===null||event.taskId===task)&&(!types||types.includes(event.type)));
   const events=matches.slice(0,limit),hasMore=matches.length>limit,next=hasMore?events.at(-1)!.id:through;
   return {events,lastEventId:next,nextCursor:next,through,hasMore};
  },event:(project,id)=>{lookups.push([project,id]);return {id,taskId:other}},change:(_project,id)=>({eventId:id,patch:'recorded patch'}),version:(_project,path,id)=>({path,changeId:id,content:'recorded version'})});
  const calls=[
   {tool:'list_events',arguments:{after:0,through:6,limit:1,task_id:other,kind:'tool.finished'}},
   {tool:'get_event',arguments:{event_id:2}},
   {tool:'get_file_change',arguments:{event_id:3}},
   {tool:'get_file_version',arguments:{path:`.beni/tasks/${other}/requirements.md`,change_id:3}},
   {tool:'acknowledge_events',arguments:{through:6}},
   {tool:'acknowledge_events',arguments:{through:4}},
   {tool:'list_events',arguments:{}},
   {tool:'list_events',arguments:{limit:101}},
   {tool:'list_events',arguments:{kind:'tool.*'}},
   {tool:'unknown_tool',arguments:{}},
   {tool:'get_event',arguments:{event_id:2,project_id:'another-project'}},
   {tool:'get_event',arguments:{event_id:-1}},
   {tool:'acknowledge_events',arguments:{through:7}},
   {tool:'get_file_version',arguments:{path:'../other/secret.md',change_id:3}},
   {tool:'get_event',arguments:{event_id:7}},
  ];
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify(calls);
  try{
   await chat.send(p,t,'event tools',null,root,undefined,'requirements',false,provider);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
   const c=await chat.get(p,t),results=JSON.parse(c.messages.at(-1)!.content).map((result:any)=>({success:provider==='codex'?result.success:!result.isError,value:JSON.parse(provider==='codex'?result.contentItems[0].text:result.content[0].text)}));
   expect(c.lastEventId).toBe(6);expect(results.slice(0,7).every((result:any)=>result.success)).toBe(true);expect(results.slice(7).every((result:any)=>!result.success)).toBe(true);
   expect(results[0].value).toMatchObject({events:[{id:3,type:'tool.finished',taskId:other}],nextCursor:6,hasMore:false});
   expect(results[1].value.taskId).toBe(other);expect(results[3].value.content).toBe('recorded version');expect(results[5].value.through).toBe(6);
   expect(results[6].value.events).toEqual([{id:1,type:'document.updated',taskId:t,path:'requirements.md',version:'latest',previousVersion:'previous'}]);
   expect(results[7].value.error).toContain('1〜100');
   expect(results[8].value.error).toContain('tool.finished');
   expect(lookups).toContainEqual([p,other,0,6,1,['tool.finished']]);
   expect(lookups.some(value=>value[1]===t&&value[4]===20&&value[5].includes('document.updated'))).toBe(true);
   expect(lookups.every(value=>value[0]===p)).toBe(true);
   delete process.env.FAKE_EMBEDDED_CALLS;
   await chat.send(p,null,'event tools',null,root,undefined,null,false,provider);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');expect((await chat.get(p,null)).lastEventId).toBe(6);
  }finally{delete process.env.FAKE_EMBEDDED_CALLS;await rm(root,{recursive:true,force:true})}
 }
});

test('操作イベントは出力を重複せず、他タスクのパック参照と削除済み出力を取得する',async()=>{
 const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-output-events-')),store=new Store(':memory:');
 const p=store.createProject('Example',root).id,t=store.createTask(p,'Task').id;
 const chat=new ChatService(()=>root,()=>fake),records:any[]=[];let captures=0;
 createHandler(store,root,chat);
 chat.setTaskEvents({capture:()=>{captures++},events:(_p,_t,after,through=records.length,limit=100)=>{const events=records.filter(event=>event.id>after&&event.id<=through).slice(0,limit),next=events.at(-1)?.id??through;return {events,lastEventId:next,nextCursor:next,through,hasMore:next<through}},append:(_p,input)=>{const event={id:records.length+1,...input};records.push(event);return event}});
 try{
  await chat.send(p,t,'tools',null,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  expect(records).toHaveLength(2);expect(records.map(event=>event.type)).toEqual(['tool.started','tool.finished']);expect(records[1].details).toEqual({toolName:'command',targetPaths:[],result:'completed',exitCode:0});expect(records[1].packId).toBe((await chat.get(p,t)).packs.find(pack=>pack.kind==='tool')?.packId);expect(JSON.stringify(records)).not.toContain('echo example');expect(JSON.stringify(records)).not.toContain('example\\n');expect(captures).toBeGreaterThanOrEqual(3);
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'get_execution_output',arguments:{operation_id:records[0].operationId}}]);
  await chat.send(p,null,'event tools',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  let result=JSON.parse(JSON.parse((await chat.get(p,null)).messages.at(-1)!.content)[0].contentItems[0].text);expect(result).toMatchObject({deleted:false,output:'example\n',status:'completed'});
  const originalChatId=(await chat.get(p,t)).id;
  await chat.command(p,t,'clear',root);
  expect((await chat.get(p,t)).id).not.toBe(originalChatId);
  await chat.send(p,null,'event tools',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  result=JSON.parse(JSON.parse((await chat.get(p,null)).messages.at(-1)!.content)[0].contentItems[0].text);expect(result).toMatchObject({deleted:false,output:'example\n',status:'completed'});
  store.deleteTask(p,t);
  await chat.send(p,null,'event tools',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  result=JSON.parse(JSON.parse((await chat.get(p,null)).messages.at(-1)!.content)[0].contentItems[0].text);expect(result.deleted).toBe(true);await expect(readFile(store.chats.path(originalChatId),'utf8')).rejects.toThrow();
 }finally{delete process.env.FAKE_EMBEDDED_CALLS;store.close();await rm(root,{recursive:true,force:true})}
});

test('終了時の履歴保存失敗でもチャットを失敗として閉じ、通知を残す',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-event-failure-')),p='019a0000-0000-7000-8000-000000000001';let captured=false;
 const chat=new ChatService(()=>root,()=>fake);chat.setTaskEvents({capture:()=>{if(captured)throw Error('fictional persistence failure');captured=true},events:()=>({events:[],lastEventId:0,through:0,hasMore:false})});
 try{await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');const c=await chat.get(p,null);expect(c.messages.at(-1)?.content).toContain('イベント履歴の保存に失敗しました。');expect(c.packs.every(pack=>pack.state==='closed')).toBe(true)}finally{await rm(root,{recursive:true,force:true})}
});

test('操作通知の再送を重複せず、終了未観測と失敗を成功にしない',async()=>{
 for(const [prompt,result] of [['duplicate tools','completed'],['unfinished tools','unknown'],['failed tools','failed']]){
  const root=await mkdtemp(join(tmpdir(),'beni-tool-lifecycle-')),p='019a0000-0000-7000-8000-000000000001',records:any[]=[];
  const chat=new ChatService(()=>root,()=>fake);chat.setTaskEvents({capture:()=>{},events:()=>({events:[],lastEventId:0,through:0,hasMore:false}),append:(_p,input)=>records.push(input)});
  try{await chat.send(p,null,prompt,null,root);await waitFor(async()=>['completed','failed'].includes((await chat.get(p,null)).messages.at(-1)?.status??''));expect(records).toHaveLength(2);expect(records[1].details.result).toBe(result);if(prompt==='failed tools')expect(records[1].details.exitCode).toBe(7);if(prompt==='unfinished tools')expect((await chat.get(p,null)).packs.find(pack=>pack.kind==='tool')?.status).toBe('failed')}
  finally{await rm(root,{recursive:true,force:true})}
 }
});

test('DB instruction templates reach both providers and invalid variables reject before dispatch',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-instructions-')),path=join(root,'app.sqlite');
 const store=new Store(path),p=store.createProject('Example',root);
 const codexLog=join(root,'codex.jsonl'),claudeLog=join(root,'claude.jsonl');
 process.env.FAKE_CODEX_LOG=codexLog;process.env.FAKE_CLAUDE_LOG=claudeLog;
 try {
  store.updateInstruction('common','Saved common {{project_directory}}',store.instructions().find(item=>item.key==='common')!.content);
  const chat=new ChatService(()=>root,()=>fake,()=>join(import.meta.dir,'test/fake-claude.ts'));
  const handler=createHandler(store,root,chat);
  const response=await handler(new Request('http://127.0.0.1:3210/api/instructions'));
  expect(response.status).toBe(200);expect((await response.json()).instructions[0]).toEqual({key:'common',content:'Saved common {{project_directory}}'});
  await chat.send(p.id,null,'hello','model-a',root);
  await waitFor(async()=>(await chat.get(p.id,null)).messages[1].status==='completed');
  const events=(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(events.find(event=>event.method==='thread/start').params.developerInstructions).toBe('Saved common '+root);
  await chat.send(p.id,null,'hello','sonnet',root,undefined,null,false,'claude','editor');
  await waitFor(async()=>(await chat.get(p.id,null)).messages[3].status==='completed');
  expect(JSON.parse((await readFile(claudeLog,'utf8')).trim()).args).toContain('Saved common '+root);
  const task=store.createTask(p.id,'Task');
  store.updateInstruction('requirements','Saved phase {{task_id}} at {{task_directory}}',store.instructions().find(item=>item.key==='requirements')!.content);
  await chat.send(p.id,task.id,'hello','model-a',root,undefined,'requirements');
  await waitFor(async()=>(await chat.get(p.id,task.id,'requirements')).messages[1].status==='completed');
  const taskEvents=(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(taskEvents.filter(event=>event.method==='thread/start').at(-1).params.developerInstructions).toContain('Saved common '+root+'\n\nSaved phase '+task.id+' at Beni のタスク文書');
  chat.setInstructions(()=>store.instructions().map(item=>item.key==='common'?{...item,content:'{{unknown}}'}:item));
  await expect(chat.send(p.id,null,'hello','model-a',root)).rejects.toThrow('未知のインストラクション変数: unknown');
  expect((await chat.get(p.id,null)).messages).toHaveLength(4);
 } finally {delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_CLAUDE_LOG;store.close();await rm(root,{recursive:true,force:true})}
});

test('instruction editor uses isolated readonly scope, validates updates and persists history',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-editor-')),store=new Store(join(root,'app.sqlite')),log=join(root,'rpc.jsonl');
 const chat=new ChatService(()=>{throw Error('must not resolve project')},()=>fake),handle=createHandler(store,'/tmp',chat);
 const post=(data:unknown)=>handle(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try{
  const common=store.instructionDocument('common')!,initial=common.items[0]!;
  const previous=store.writeInstructionDocument('common',common.revision,[...common.items,
   {text:'\n\n',reason:'',sources:[]},
   {text:'保持する方針',reason:'既存の方針を維持するため',sources:[{kind:'instruction',id:'common/'+initial.id,revision:common.revision,text:initial.text.slice(0,16),start:0}]},
  ],'fixture');
  let changes=0;chat.subscribe('instructions',null,event=>{if(event.name==='chat.changed')changes++});
  process.env.FAKE_CODEX_LOG=log;process.env.FAKE_CODEX_INSTRUCTION_EDITOR='1';
  const request='内容を保存',replacement='# Updated {{working_directory}} {{project_directory}} {{working_directory}}';
  expect((await post({projectId:'instructions',taskId:null,instructionFocus:'common',content:request,model:'model-a'})).status).toBe(202);
  await waitFor(async()=>(await chat.get('instructions',null)).messages[1]?.status==='completed');
  const conversation=await chat.get('instructions',null),saved=store.instructionDocument('common')!;
  const messageSource={kind:'message' as const,id:`instructions/${conversation.id}/${conversation.messages[0]!.id}`,start:2,text:request.slice(2)};
  expect(saved.content).toBe(replacement+'\n\n保持する方針');expect(changes).toBeGreaterThan(2);
  expect(saved.items[0]).toEqual({id:initial.id,text:replacement,reason:'採用理由を追記',sources:[messageSource,{
   kind:'instruction',id:'common/'+initial.id,revision:previous.revision,start:0,text:initial.text.slice(0,30),
  }]});
  expect(saved.items.slice(1)).toEqual(previous.items.slice(1));
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));const start=records.find(item=>item.method==='thread/start');
  expect(start.params.sandbox).toBe('read-only');expect(start.params.cwd).toBe(join(root,'instruction-editor'));expect(start.params.dynamicTools.map((item:any)=>item.name)).toEqual(['list_instructions','get_instruction','list_chat_sources','read_source','update_instruction']);
  expect(start.params.developerInstructions).toContain('get_instruction');expect(start.params.developerInstructions).not.toContain(previous.content);
  const toolResponses=records.filter(item=>item.id?.startsWith?.('embedded:')).map(item=>item.result);
  expect(toolResponses.map(item=>item.success)).toEqual([true,true,true,false,false,false,true,false,true,true,true,false,true]);
  const firstUpdate=JSON.parse(toolResponses[6].contentItems[0].text);
  expect(firstUpdate).toEqual({key:'common',revision:expect.any(String),variables:{working_directory:[{line:1,column:11},{line:1,column:55}],project_directory:[{line:1,column:33}]}});
  expect(store.instructionDocument('common',firstUpdate.revision)?.items[0]).toEqual({id:initial.id,text:replacement,reason:'ユーザーの希望を反映',sources:[messageSource]});
  expect(firstUpdate.revision).not.toBe(saved.revision);
  expect(JSON.parse(toolResponses[11].contentItems[0].text).error).toContain('最新の版');
  expect(JSON.parse(await readFile(store.chats.path((await chat.get('instructions',null)).id),'utf8')).messages).toHaveLength(2);
  const restarted=new ChatService(()=>{throw Error('must not resolve project')});createHandler(store,'/tmp',restarted);expect((await restarted.get('instructions',null)).messages).toHaveLength(2);
  expect((await post({projectId:'instructions',taskId:null,phase:null,content:'bad',model:null})).status).toBe(400);
  expect((await handle(new Request('http://127.0.0.1:3210/api/terminals?projectId=instructions'))).status).toBe(404);
  for(const [key,content] of [['missing','# x'],['common',''],['common','x'.repeat(65537)],['requirements','{{execution_chat_path}}']])expect(()=>store.updateInstruction(key,content,previous.content)).toThrow();
  const editor=store.instructions().find(item=>item.key==='editor')!;store.updateInstruction('editor','自由な {{custom}}',editor.content);
  delete process.env.FAKE_CODEX_INSTRUCTION_EDITOR;
  delete process.env.FAKE_CODEX_LOG;
  const claudeLog=join(root,'claude.jsonl');process.env.FAKE_CLAUDE_LOG=claudeLog;
  const claude=new ChatService(()=>{throw Error('must not resolve project')},()=>fake,()=>join(import.meta.dir,'test/fake-claude.ts'));createHandler(store,'/tmp',claude);
  const editorVersion=store.instructionDocument('editor')!,editorItem=editorVersion.items[0]!;
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'update_instruction',arguments:{key:'editor',revision:editorVersion.revision,edits:[{
   id:editorItem.id,text:'# Claude saved {{project_directory}} {{custom}} {{project_directory}}',reason:'編集方針を詳しくする',
   sources:[{kind:'instruction',id:'editor/'+editorItem.id,revision:editorVersion.revision,text:editorItem.text}],
  }]}}]);
  await claude.send('instructions',null,'save','sonnet','/tmp',undefined,null,false,'claude','editor');
  await waitFor(async()=>(await claude.get('instructions',null)).messages.at(-1)?.status==='completed');
  expect(store.instructions().find(item=>item.key==='editor')!.content).toBe('# Claude saved {{project_directory}} {{custom}} {{project_directory}}');
  const editorResult=JSON.parse(JSON.parse((await claude.get('instructions',null)).messages.at(-1)!.content)[0].content[0].text);
  expect(editorResult).toEqual({key:'editor',revision:store.instructionDocument('editor')!.revision,variables:{}});
  const claudeArgs=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n')[0]!).args;
  expect(claudeArgs[claudeArgs.indexOf('--tools')+1]).toBe('');expect(claudeArgs[claudeArgs.indexOf('--allowedTools')+1]).toContain('mcp__beni__update_instruction');
  expect(claudeArgs[claudeArgs.indexOf('--append-system-prompt')+1]).toContain(editor.content);
  const claudeRecord=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n')[0]!);expect(claudeRecord.prompt).toContain('現在ユーザーが注目しているインストラクション: editor');
  expect((await claude.get('instructions',null)).lastInstructionFocus).toBe('editor');
  delete process.env.FAKE_EMBEDDED_CALLS;
  await claude.send('instructions',null,'hello','sonnet','/tmp',undefined,null,false,'claude','editor');
  await waitFor(async()=>(await claude.get('instructions',null)).messages.at(-1)?.status==='completed');
  const continued=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n').at(-1)!);expect(continued.prompt).toContain('現在ユーザーが注目しているインストラクション');expect(continued.prompt).toContain('# Claude saved');

 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_EMBEDDED_CALLS;delete process.env.FAKE_CODEX_INSTRUCTION_EDITOR;store.close();await rm(root,{recursive:true,force:true})}
});

test('instruction focus is validated and delivered only when changed or starting a session',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-focus-')),store=new Store(join(root,'app.sqlite')),log=join(root,'rpc.jsonl');
 const chat=new ChatService(()=>{throw Error('must not resolve project')},()=>fake),handle=createHandler(store,'/tmp',chat);
 const post=(focus:unknown,content='hello',model:string|null='model-a')=>handle(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:'instructions',taskId:null,content,model,instructionFocus:focus})}));
 const done=()=>waitFor(async()=>['completed','failed'].includes((await chat.get('instructions',null)).messages.at(-1)?.status??''));
 const inputs=async()=> (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.method==='turn/start').map(item=>item.params.input);
 try{
  process.env.FAKE_CODEX_LOG=log;
  for(const focus of [undefined,null,'missing',{},1])expect((await post(focus)).status).toBe(400);
  expect((await chat.get('instructions',null)).messages).toHaveLength(0);
  expect((await post('common')).status).toBe(202);await done();
  expect((await inputs())[0]).toHaveLength(2);expect((await inputs())[0][1].text).toContain('common');
  expect((await chat.get('instructions',null)).lastInstructionFocus).toBe('common');
  expect((await post('common')).status).toBe(202);await done();expect((await inputs())[1]).toHaveLength(1);
  const acceptedHash=(await chat.get('instructions',null)).lastInstructionFocusHash;expect(acceptedHash).toMatch(/^[a-f0-9]{64}$/);
  store.updateInstruction('common','# changed',store.instructions()[0]!.content);
  expect((await post('common','reject')).status).toBe(202);await done();expect((await chat.get('instructions',null)).lastInstructionFocusHash).toBe(acceptedHash);
  expect((await post('common')).status).toBe(202);await done();expect((await inputs()).at(-1)[1].text).toContain('# changed');expect((await chat.get('instructions',null)).lastInstructionFocusHash).not.toBe(acceptedHash);
  expect((await post('editor','reject')).status).toBe(202);await done();expect((await chat.get('instructions',null)).lastInstructionFocus).toBe('common');
  expect((await post('editor','hello','missing')).status).toBe(400);expect((await chat.get('instructions',null)).lastInstructionFocus).toBe('common');
  expect((await post('editor')).status).toBe(202);await done();expect((await inputs()).at(-1)[1].text).toContain('editor');
  const workflow=store.instructionDocument('task.completed')!;
  const workflowContent='# 変更したタスク完了の方針 {{task_id}}';
  const workflowItem=workflow.items[0]!;
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'update_instruction',arguments:{key:'task.completed',revision:workflow.revision,edits:[{
   id:workflowItem.id,text:workflowContent,reason:'タスク完了の方針を明確にする',
   sources:[{kind:'instruction',id:'task.completed/'+workflowItem.id,revision:workflow.revision,text:workflowItem.text}],
  }]}}]);
  expect((await post('task.completed')).status).toBe(202);await done();
  expect((await inputs()).at(-1)[1].text).toContain(workflow.content);
  expect((await chat.get('instructions',null)).lastInstructionFocus).toBe('task.completed');
  expect(store.instructionDocument('task.completed')?.content).toBe(workflowContent);
  delete process.env.FAKE_EMBEDDED_CALLS;
  const restarted=new ChatService(()=>{throw Error('must not resolve project')},()=>fake);createHandler(store,'/tmp',restarted);
  expect((await restarted.get('instructions',null)).lastInstructionFocus).toBe('task.completed');
  await restarted.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','task.completed');
  await waitFor(async()=>(await restarted.get('instructions',null)).messages.at(-1)?.status==='completed');
  expect((await inputs()).at(-1)[1].text).toContain(workflowContent);
  await restarted.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','task.completed');
  await waitFor(async()=>(await restarted.get('instructions',null)).messages.at(-1)?.status==='completed');
  expect((await inputs()).at(-1)).toHaveLength(1);
  expect((await restarted.get('instructions',null)).messages.filter(item=>item.role==='user').every(item=>item.content==='hello'||item.content==='reject')).toBe(true);
 }finally{delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_EMBEDDED_CALLS;store.close();await rm(root,{recursive:true,force:true})}
});


test('instruction variable positions preserve every occurrence in saved Markdown',async()=>{
 const {instructionVariables}=await import('./instructions');
 expect(instructionVariables('common','日本😀 {{working_directory}}\r\n次😀{{project_directory}} {{working_directory}}\n{{project_directory}}')).toEqual({
  working_directory:[{line:1,column:5},{line:2,column:25}],
  project_directory:[{line:2,column:3},{line:3,column:1}],
 });
 expect(instructionVariables('common','# 変数なし 😀')).toEqual({});
 expect(instructionVariables('common','{{unknown}}')).toEqual({});
 expect(instructionVariables('editor','{{project_directory}} {{custom}}')).toEqual({});
});

test('editor apply pins prompts across restart and archives only on explicit idle apply',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-apply-')),store=new Store(join(root,'app.sqlite')),log=join(root,'rpc.jsonl');
 const chat=new ChatService(()=>{throw Error('project scope')},()=>fake),handle=createHandler(store,'/tmp',chat);
 const apply=(expected_content:unknown,origin='http://127.0.0.1:3210')=>handle(new Request('http://127.0.0.1:3210/api/instructions/apply',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({expected_content})}));
 const done=()=>waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');
 try{
  process.env.FAKE_CODEX_LOG=log;
  const original=store.instructions().find(item=>item.key==='editor')!.content;
  expect((await (await handle(new Request('http://127.0.0.1:3210/api/instructions'))).json()).editorState).toEqual({pending:false,busy:false});
  await chat.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','common');await done();
  const before=await chat.get('instructions',null);store.updateInstruction('editor','NEW EDITOR PROMPT',original);
  const restarted=new ChatService(()=>{throw Error('project scope')});createHandler(store,'/tmp',restarted);
  expect(await restarted.instructionEditorState()).toEqual({pending:true,busy:false});
  await chat.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','common');await done();
  const resumed=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.method==='thread/resume');
  expect(resumed.params.developerInstructions.startsWith(original)).toBe(true);expect(resumed.params.developerInstructions).not.toContain('NEW EDITOR PROMPT');
  const currentPath=store.chats.path(before.id), backup=currentPath+'.backup';
  const {rename,symlink}=await import('node:fs/promises');
  await rename(currentPath,backup);await symlink(backup,currentPath);
  expect((await apply('NEW EDITOR PROMPT')).status).toBe(500);
  await rm(currentPath);await rename(backup,currentPath);
  expect((await chat.get('instructions',null)).id).toBe(before.id);
  expect((await apply('stale')).status).toBe(409);expect((await apply('NEW EDITOR PROMPT','https://other.example')).status).toBe(403);expect((await apply(null)).status).toBe(400);
  await chat.send('instructions',null,'wait','model-a','/tmp',undefined,null,false,'codex','common');
  expect((await apply('NEW EDITOR PROMPT')).status).toBe(409);
  await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='streaming');await chat.interrupt('instructions',null);await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='interrupted');
  const previous=await chat.get('instructions',null);const previousFile=JSON.parse(await readFile(store.chats.path(previous.id),'utf8'));let changed=0;chat.subscribe('instructions',null,event=>{if(event.name==='chat.changed')changed++});
  expect(await (await apply('NEW EDITOR PROMPT')).json()).toEqual({editorState:{pending:false,busy:false}});
  const current=await chat.get('instructions',null);expect(current.id).not.toBe(before.id);expect(current.messages).toEqual([]);expect(current.threadId).toBeNull();expect(current.selectedModel).toEqual(previous.selectedModel);expect(current.lastInstructionFocus).toBeUndefined();expect(current.lastInstructionFocusHash).toBeUndefined();expect(changed).toBe(1);
  expect(JSON.parse(await readFile(store.chats.path(before.id),'utf8'))).toEqual(previousFile);
  expect((await apply('NEW EDITOR PROMPT')).status).toBe(200);expect((await chat.get('instructions',null)).id).toBe(current.id);expect(changed).toBe(1);
  await chat.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','common');await done();
  const starts=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(item=>item.method==='thread/start');expect(starts.at(-1).params.developerInstructions.startsWith('NEW EDITOR PROMPT')).toBe(true);
 }finally{delete process.env.FAKE_CODEX_LOG;store.close();await rm(root,{recursive:true,force:true})}
});


test('instruction read tools return latest raw data and strictly validate arguments for both providers',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 for(const provider of ['codex','claude'] as const){
  const root=await mkdtemp(join(tmpdir(),'beni-instruction-read-')),store=new Store(join(root,'app.sqlite')),log=join(root,'rpc.jsonl');
  const chat=new ChatService(()=>{throw Error('project scope')},()=>fake,()=>join(import.meta.dir,'test/fake-claude.ts'));createHandler(store,'/tmp',chat);
  try{
   const original=store.instructionDocument('editor')!;
   const editor=store.updateInstruction('editor','旧仕様では expected_content に本文を渡す。',original.content);
   await chat.get('instructions',null);store.updateInstruction('editor','# pending raw {{custom}}',editor.content);
   const calls=[{tool:'list_instructions',arguments:{}},{tool:'get_instruction',arguments:{key:'editor'}},...[
    ['list_instructions',{key:'common'}],['list_instructions',null],['get_instruction',{}],['get_instruction',{key:'missing'}],['get_instruction',{key:'common',extra:true}],['get_instruction',[]],['update_instruction',{key:'common',content:'x'}]
   ].map(([tool,args])=>({tool,arguments:args}))];
   process.env.FAKE_EMBEDDED_CALLS=JSON.stringify(calls);process.env[provider==='codex'?'FAKE_CODEX_LOG':'FAKE_CLAUDE_LOG']=log;
   await chat.send('instructions',null,'read',provider==='codex'?'model-a':'sonnet','/tmp',undefined,null,false,provider,'common');
   await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');
   const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   const results=provider==='codex'?records.filter(item=>item.id?.startsWith?.('embedded:')).map(item=>item.result):JSON.parse((await chat.get('instructions',null)).messages.at(-1)!.content).map((item:any)=>({success:!item.isError,contentItems:item.content}));
   expect(results.map((item:any)=>item.success)).toEqual([true,true,false,false,false,false,false,false,false]);
   const list=JSON.parse(results[0].contentItems[0].text);expect(list.instructions).toHaveLength(9);expect(list.instructions.every((item:any)=>Object.keys(item).sort().join(',')==='key,name')).toBe(true);
   expect(list.instructions).toContainEqual({key:'task.completed',name:'タスク完了'});
   const savedEditor=store.instructionDocument('editor')!;
   expect(JSON.parse(results[1].contentItems[0].text)).toMatchObject({key:'editor',revision:savedEditor.revision,
    item:{id:savedEditor.items[0]!.id,text:'# pending raw {{custom}}',source:{kind:'instruction',id:'editor/'+savedEditor.items[0]!.id,revision:savedEditor.revision}},
    next:null});
   const system=provider==='codex'?records.find(item=>item.method==='thread/start').params.developerInstructions:records[0].args[records[0].args.indexOf('--append-system-prompt')+1];
   expect(system).toContain(editor.content);expect(system).not.toContain('# pending raw');expect(system).not.toContain(store.instructions()[1]!.content);
   expect(system).toContain('以前のツール仕様が記載されている場合も、以下の仕様に従う');
   expect(system).toContain('update_instruction の key、revision、edits');
   delete process.env.FAKE_EMBEDDED_CALLS;
   // 古いセッションは履歴を維持してツール登録済みの新規セッションに切り替える。
   const path=store.chats.path((await chat.get('instructions',null)).id);const saved=JSON.parse(await readFile(path,'utf8'));
   saved.providers[provider].models[provider==='codex'?'model-a':'sonnet'].session.instructionToolsVersion=1;
   await writeFile(path,JSON.stringify(saved));
   await chat.send('instructions',null,'resume',provider==='codex'?'model-a':'sonnet','/tmp',undefined,null,false,provider,'common');await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');
   const latest=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   if(provider==='codex'){expect(latest.filter(item=>item.method==='thread/start')).toHaveLength(2);expect(latest.filter(item=>item.method==='turn/start').at(-1).params.input.some((item:any)=>item.text.includes('reference conversation history'))).toBe(true)}
   else expect(latest.at(-1).args[latest.at(-1).args.indexOf('--allowedTools')+1]).toContain('mcp__beni__list_chat_sources');
   expect((await chat.get('instructions',null)).instructionToolsVersion).toBe(2);
  }finally{delete process.env.FAKE_EMBEDDED_CALLS;delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_CLAUDE_LOG;store.close();await rm(root,{recursive:true,force:true})}
 }
});


test('スラッシュコマンドを本文から区別して、通常送信での誤送信を防ぐ',async()=>{
 const {parseChatCommand}=await import('../shared/chat-commands');
 expect(parseChatCommand('  /compact  ')).toEqual({name:'compact',args:''});expect(parseChatCommand('/unknown value')).toEqual({name:'unknown',args:'value'});
 for(const text of ['/tmp/example','/Users/example/file.ts','/compact.md','引用 /compact','> /compact'])expect(parseChatCommand(text)).toBeNull();
 const root=await mkdtemp(join(tmpdir(),'beni-command-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>fake);
 try{await expect(chat.send(p,null,' /compact ',null,root)).rejects.toThrow('chat command');expect((await chat.get(p,null)).messages).toEqual([]);await expect(chat.command(p,null,'compact',root)).rejects.toThrow('no thread')}
 finally{await rm(root,{recursive:true,force:true})}
});

test('圧縮は保存したスレッドを再開し、受付と完了を区別して履歴・パックを保持する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-compact-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'rpc.jsonl'),chat=new ChatService(()=>root,()=>fake);process.env.FAKE_CODEX_LOG=log;
 let changed=0;const unsubscribe=chat.subscribe(p,null,event=>{if(event.name==='chat.changed')changed++});
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  const result=await chat.command(p,null,'compact',root);expect(result.command.status).toBe('running');expect((await chat.get(p,null)).command?.status).toBe('running');
  await expect(chat.command(p,null,'compact',root)).rejects.toThrow('busy');await expect(chat.send(p,null,'hello',null,root)).rejects.toThrow('busy');
  await waitFor(async()=>(await chat.get(p,null)).command?.status==='completed');const after=await chat.get(p,null);expect(after.messages).toEqual(before.messages);expect(after.packs).toEqual(before.packs);expect(after.threadId).toBe(before.threadId);expect(changed).toBeGreaterThan(3);
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');expect((await chat.get(p,null)).messages).toHaveLength(4);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));const compact=records.findIndex(row=>row.method==='thread/compact/start');expect(records[compact].params).toEqual({threadId:'thread-1'});expect(records.slice(0,compact).at(-1)).toMatchObject({method:'thread/resume',params:{threadId:'thread-1',approvalPolicy:'never',sandbox:'read-only'}});expect(records.filter(row=>row.method==='turn/start')).toHaveLength(2);
 }finally{unsubscribe();delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('圧縮の先行イベント・別スレッドの通知・失敗・切断・再起動を区別する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-compact-states-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>fake);
 const log=join(root,'compact.jsonl');
 process.env.FAKE_CODEX_LOG=log;
 const dispatched=async()=> (await readFile(log,'utf8')).split('\n').filter(line=>line.includes('"method":"thread/compact/start"')).length;
 const compactAndWait=async()=>{const count=await dispatched();await chat.command(p,null,'compact',root);await waitFor(async()=>await dispatched()>count)};
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  for(const [action,status] of [['early','completed'],['unrelated','completed'],['reject','failed'],['fail','failed'],['disconnect','unknown'],['disconnect-before-ack','unknown'],['missing-boundary','unknown'],['boundary-failure','failed'],['boundary-interrupt','interrupted'],['boundary-disconnect','unknown']] as const){
   process.env.FAKE_CODEX_COMPACT_ACTION=action;await chat.command(p,null,'compact',root);if(action==='early'||action==='unrelated'){await Bun.sleep(30);expect((await chat.get(p,null)).command?.status).toBe('running')}
   await waitFor(async()=>(await chat.get(p,null)).command?.status===status);
   if(action==='reject'){
    const restarted=new ChatService(()=>root,()=>fake);
    expect((await restarted.get(p,null)).command?.diagnostic).toEqual({stage:'turn-start',reason:'rpc-rejected',failureCode:'rejected',rpcCode:-32600});
   }
  }
  process.env.FAKE_CODEX_COMPACT_ACTION='wait';await compactAndWait();await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  await compactAndWait();const restarted=new ChatService(()=>root,()=>fake);expect((await restarted.get(p,null)).command?.status).toBe('unknown');await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  process.env.FAKE_CODEX_COMPACT_ACTION='no-turn';await compactAndWait();await chat.interrupt(p,null);expect((await chat.get(p,null)).command?.status).toBe('unknown');
  expect((await chat.get(p,null)).messages).toHaveLength(2);
 }finally{delete process.env.FAKE_CODEX_COMPACT_ACTION;delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('コマンドAPIはscope・フェーズ・引数・タスク制約を検証して排他する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-command-api-'));const {Store}=await import('./store/index');const {createHandler}=await import('./server');const store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},other=store.createProject('Other',projectFolder(root,'other')) as {id:string},task=store.createTask(project.id,'Task') as {id:string},chat=new ChatService(()=>root,()=>fake),handler=createHandler(store,'/tmp',chat);
 const post=(data:unknown,path='/api/chat/commands',origin='http://127.0.0.1:3210')=>handler(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(data)}));const base={projectId:project.id,taskId:task.id,phase:'requirements',command:'compact'};
 try{
  expect((await post({...base,projectId:other.id})).status).toBe(404);expect((await post(base,undefined,'http://example.test')).status).toBe(403);expect((await post({...base,command:'unknown'})).status).toBe(400);expect((await post({...base,args:'x'})).status).toBe(400);expect((await post(base)).status).toBe(409);expect((await post({...base,phase:'documents'})).status).toBe(409);
  expect((await post({...base,content:'/compact',model:null},'/api/chat/send')).status).toBe(400);
  await chat.send(project.id,task.id,'hello',null,root);await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='completed');
  process.env.FAKE_CODEX_COMPACT_ACTION='wait';const res=await post(base);expect(res.status).toBe(202);expect(await res.json()).toMatchObject({command:{name:'compact',status:'running'}});expect(()=>chat.withIdleTask(project.id,task.id,()=>{})).toThrow('busy');expect((await post(base)).status).toBe(409);await Bun.sleep(30);expect((await post({...base},'/api/chat/interrupt')).status).toBe(200);await waitFor(async()=>(await chat.get(project.id,task.id)).command?.status==='interrupted');
  const view=await (await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${project.id}&taskId=${task.id}&phase=requirements`))).json();expect(view).toMatchObject({sessionProvider:'codex',command:{status:'interrupted'}});expect((await chat.get(project.id,task.id,'documents')).command).toBeUndefined();
  store.selectTaskPhase(project.id,task.id,'requirements','execution');expect((await post({...base,phase:'execution'})).status).toBe(409);store.selectTaskPhase(project.id,task.id,'execution','retrospective');store.setTaskCompleted(project.id,task.id,true);expect((await post({...base,phase:'retrospective'})).status).toBe(409);
 }finally{delete process.env.FAKE_CODEX_COMPACT_ACTION;store.close();await rm(root,{recursive:true,force:true})}
});

test('失敗診断は再読込と会話 API に残り、CLI のエラー原文とモデルへの引き継ぎから除外する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-diagnostic-')),store=new Store(join(root,'beni.sqlite'));
 const {createHandler}=await import('./server');
 const {id:p}=store.createProject('Example',root);
 const createChat=()=>new ChatService(()=>root,()=>fake);
 const chat=createChat();
 createHandler(store,root,chat);
 const log=join(root,'rpc.jsonl');
 process.env.FAKE_CODEX_LOG=log;
 try{
  await chat.send(p,null,'hello',null,root);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  process.env.FAKE_CODEX_RESUME='reject';
  await chat.send(p,null,'resume',null,root);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');
  const restarted=createChat(),handler=createHandler(store,root,restarted);
  const history=await restarted.get(p,null);
  const failed=history.messages.at(-1)!;
  const diagnostic={stage:'thread-resume',reason:'rpc-rejected',failureCode:'rejected',rpcCode:-32600};
  expect(failed).toMatchObject({role:'assistant',provider:'codex',model:'model-a',status:'failed',content:'',diagnostic});
  expect(history.messages.at(-2)?.diagnostic).toBeUndefined();
  const stored=await readFile(store.chats.path(history.id),'utf8');
  expect(JSON.parse(stored).messages.at(-1)).toMatchObject({sendId:failed.sendId,updatedAt:failed.updatedAt,diagnostic});
  expect(stored).not.toContain('fake-private-detail');
  const response=await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${p}`));
  expect(response.status).toBe(200);
  const body=await response.text();
  expect(JSON.parse(body).messages.at(-1)).toEqual(failed);
  expect(body).not.toContain('fake-private-detail');

  process.env.FAKE_CODEX_RESUME='missing';
  await restarted.send(p,null,'next',null,root);
  await waitFor(async()=>(await restarted.get(p,null)).messages.at(-1)?.status==='completed');
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const input=JSON.stringify(records.filter(row=>row.method==='turn/start').at(-1).params.input);
  expect(input).toContain('reference conversation history');
  expect(input).not.toContain('rpc-rejected');
 }finally{
  delete process.env.FAKE_CODEX_RESUME;
  delete process.env.FAKE_CODEX_LOG;
  store.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('Codex 会話が使用中でも自動で新しいセッションへ切り替えない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-active-writer-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'rpc.jsonl'),chat=new ChatService(()=>root,()=>fake);
 process.env.FAKE_CODEX_LOG=log;
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const original=await chat.get(p,null),threadId=original.threadId;
  process.env.FAKE_CODEX_RESUME='active-writer-prefix';
  await chat.send(p,null,'resume',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');
  expect(await chat.get(p,null)).toMatchObject({threadId,messages:[{}, {}, {}, {status:'failed',diagnostic:{
   stage:'thread-resume',reason:'thread-in-use',failureCode:'rejected',rpcCode:-32600,
  }}]});
  delete process.env.FAKE_CODEX_RESUME;
  await chat.send(p,null,'retry',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(row=>row.method==='thread/start')).toHaveLength(1);
  expect(records.filter(row=>row.method==='thread/resume').map(row=>row.params.threadId)).toEqual([threadId,threadId]);
 }finally{delete process.env.FAKE_CODEX_RESUME;delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});


test('診断の保存は固定値と範囲内の数値だけを受け入れる',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-diagnostic-fields-')),p='019a0000-0000-7000-8000-000000000001';
 const agent=new DummyAgent({scenario:async()=>({status:'failed',code:'unavailable',diagnostic:{
  stage:'config-validation',reason:'unsafe-config',configChecks:['workspace-network-disabled'],
  rpcCode:2**40,exitCode:-1,signal:65,message:'fake-private-diagnostic',
 }})});
 const chat=new ChatService(()=>root,[agent]);
 try{
  await chat.send(p,null,'hello',null,root);
  await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='failed');
  const history=await chat.get(p,null),path=standaloneChatPath(root,history.id);
  const stored=JSON.parse(await readFile(path,'utf8'));
  expect(stored.messages.at(-1).diagnostic).toEqual({stage:'config-validation',reason:'unsafe-config',
   failureCode:'unavailable',configChecks:['workspace-network-disabled']});
  stored.messages.at(-1).diagnostic={stage:'fake-private-diagnostic',reason:'unsafe-config'};
  await writeFile(path,JSON.stringify(stored));
  const reloaded=await new ChatService(()=>root,[agent]).get(p,null);
  expect(reloaded.messages.at(-1)?.status).toBe('failed');
  expect(reloaded.messages.at(-1)?.diagnostic).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true})}
});

test('Claude の圧縮も保存済み接続先を使い、手動境界と成功結果を確認して履歴を維持する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-compact-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'claude.jsonl'),chat=new ChatService(()=>root,()=>null,()=>fakeClaude);process.env.FAKE_CLAUDE_LOG=log;
 try{
  await chat.send(p,null,'hello','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  for(const [action,status] of [['success','completed'],['no-boundary','failed'],['failure','failed'],['foreign-session','unknown'],['disconnect','unknown'],['disconnect-after-boundary','unknown'],['failure-after-boundary','failed']] as const){process.env.FAKE_CLAUDE_COMPACT=action;await chat.command(p,null,'compact',root);await waitFor(async()=>(await chat.get(p,null)).command?.status===status);const current=await chat.get(p,null);expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(current.threadId).toBe(before.threadId)}
  for(const [index,action] of ['wait','wait-after-boundary'].entries()){
   process.env.FAKE_CLAUDE_COMPACT=action;await chat.command(p,null,'compact',root);
   await waitFor(async()=>(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.prompt==='/compact').length===8+index);
   await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  }
  const invocations=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));const compact=invocations.filter(row=>row.prompt==='/compact');expect(compact).toHaveLength(9);expect(compact.every(row=>row.session===before.threadId&&row.args.includes('--resume'))).toBe(true);expect(compact.every(row=>row.args[row.args.indexOf('--tools')+1]==='')).toBe(true);
  expect(invocations.filter(row=>row.prompt!=='/compact').every(row=>row.args.includes('--disable-slash-commands'))).toBe(true);expect(compact.every(row=>!row.args.includes('--disable-slash-commands'))).toBe(true);
  delete process.env.FAKE_CLAUDE_COMPACT;await chat.send(p,null,'after','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');expect((await chat.get(p,null)).messages).toHaveLength(4);
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CLAUDE_COMPACT;await rm(root,{recursive:true,force:true})}
});

test('Claude 圧縮の拒否理由は既知コードに対応する固定文言だけを保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-compact-reason-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>null,()=>fakeClaude);
 try{
  await chat.send(p,null,'hello','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  for(const [action,error] of [['unavailable','この環境では会話の圧縮を利用できません'],['not-needed','圧縮できる会話がまだありません'],['unknown-reason','会話の圧縮に失敗しました'],['known-failure','会話の圧縮に失敗しました']] as const){
   process.env.FAKE_CLAUDE_COMPACT=action;await chat.command(p,null,'compact',root);await waitFor(async()=>(await chat.get(p,null)).command?.status==='failed');const current=await chat.get(p,null);
   expect(current.command?.error).toBe(error);expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(current.threadId).toBe(before.threadId);
   expect(JSON.stringify(current)).not.toContain('Private compaction failure details');
  }
 }finally{delete process.env.FAKE_CLAUDE_COMPACT;await rm(root,{recursive:true,force:true})}
});

test('コマンド候補は渡された定義だけから名前と別名を解決する',async()=>{
 const {beniChatCommands,findChatCommand}=await import('../shared/chat-commands');
 const commands=[...beniChatCommands,{name:'inspect',command:'/inspect',description:'状態を調査',kind:'operation' as const,aliases:['check']}];
 expect(findChatCommand('inspect',commands)?.name).toBe('inspect');expect(findChatCommand('check',commands)?.name).toBe('inspect');
 expect(findChatCommand('new',commands)?.name).toBe('clear');expect(findChatCommand('reset',commands)?.name).toBe('clear');
 expect(findChatCommand('usage',commands)).toBeUndefined();expect(findChatCommand('review',commands)).toBeUndefined();
 expect(findChatCommand('clear',[])).toBeUndefined();expect(beniChatCommands.map(command=>command.name)).toEqual(['clear']);
});

test('clear は元のJSONを保存して会話IDとセッションを切り替え、失敗時は元の会話を保つ',async()=>{
 const {symlink}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'beni-clear-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>fake);
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  const beforeFile=JSON.parse(await readFile(standaloneChatPath(root,before.id),'utf8'));
  let changed=0;const unsubscribe=chat.subscribe(p,null,event=>{if(event.name==='chat.changed')changed++});
  await chat.command(p,null,'clear',root,undefined,null,{provider:'claude',model:'sonnet'});unsubscribe();const after=await chat.get(p,null);
  expect(after.id).not.toBe(before.id);expect(after).toMatchObject({lastEventId:0,messages:[],packs:[],threadId:null,sessionId:null,command:{name:'clear',status:'completed'},selectedModel:before.selectedModel});expect(after.sessionProvider).toBeUndefined();expect(changed).toBe(1);
  expect(JSON.parse(await readFile(standaloneChatPath(root,before.id),'utf8'))).toEqual(beforeFile);
  expect(chat.workflowSources(p,null,null,before.id)).toEqual({chatId:before.id,messages:before.messages,packs:before.packs});
  await chat.command(p,null,'clear',root);const empty=await chat.get(p,null);expect(empty.id).not.toBe(after.id);
  const {rename}=await import('node:fs/promises');
  const current=standaloneChatPath(root,empty.id),backup=current+'.backup',outside=join(root,'outside.json');
  await writeFile(outside,'{}');await rename(current,backup);await symlink(outside,current);
  await expect(chat.command(p,null,'clear',root)).rejects.toThrow(/Invalid (chat|metadata) file/);expect(await readFile(outside,'utf8')).toBe('{}');
  await rm(current);await rename(backup,current);expect(await chat.get(p,null)).toEqual(empty);
  const directory=join(root,'.beni','chats'),directoryBackup=directory+'.backup';
  await rename(directory,directoryBackup);await symlink(directoryBackup,directory);
  await expect(chat.command(p,null,'clear',root)).rejects.toThrow();
  await rm(directory);await rename(directoryBackup,directory);expect(await chat.get(p,null)).toEqual(empty);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('clear 後の履歴は通常のタスク削除に含まれ、不正な履歴リンクは拒否する',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');const {symlink,rename}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'beni-clear-delete-')),store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},task=store.createTask(project.id,'Example task') as {id:string},chat=new ChatService(()=>root,()=>fake);
 try{
  createHandler(store,root,chat);
  await chat.command(project.id,task.id,'clear',root);
  const archived=(await chat.get(project.id,task.id)).id;
  await chat.command(project.id,task.id,'clear',root);
  const current=(await chat.get(project.id,task.id)).id;
  const linked=store.chats.path(archived),backup=linked+'.backup',outside=join(root,'outside.json');
  await writeFile(outside,'{}');await rename(linked,backup);await symlink(outside,linked);
  expect(()=>store.deleteTask(project.id,task.id)).toThrow('Invalid metadata file');
  expect(store.task(task.id)).not.toBeNull();
  await rm(linked);await rename(backup,linked);store.deleteTask(project.id,task.id);
  for(const id of [archived,current]){
   await expect(readFile(store.chats.path(id),'utf8')).rejects.toThrow();
   expect(store.chats.ref(id)).toBeNull();
  }
  expect(store.task(task.id)).toBeNull();expect(await readFile(outside,'utf8')).toBe('{}');
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('選択中の接続先がセッションと違う操作や未対応操作は実行せず、clear の排他とフェーズ制約も保つ',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-provider-command-')),store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},task=store.createTask(project.id,'Example task') as {id:string},chat=new ChatService(()=>root,()=>fake),handler=createHandler(store,'/tmp',chat);
 const post=(data:unknown)=>handler(new Request('http://127.0.0.1:3210/api/chat/commands',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 const base={projectId:project.id,taskId:task.id,phase:'requirements'};
 try{
  await chat.send(project.id,task.id,'hello',null,root);await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='completed');const before=await chat.get(project.id,task.id);
  const compact=await post({...base,command:'compact',provider:'claude'});expect(compact.status).toBe(409);expect(await compact.json()).toMatchObject({error:expect.stringContaining('接続先')});
  expect((await post({...base,command:'context',provider:'claude'})).status).toBe(400);
  expect((await post({...base,command:'context',provider:'codex'})).status).toBe(400);expect((await post({...base,command:'help'})).status).toBe(400);expect(await chat.get(project.id,task.id)).toEqual(before);
  await chat.send(project.id,task.id,'wait',null,root);await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='streaming');expect((await post({...base,command:'clear'})).status).toBe(409);await chat.interrupt(project.id,task.id);await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='interrupted');
  expect((await post({...base,command:'reset',provider:'claude'})).status).toBe(202);
  store.selectTaskPhase(project.id,task.id,'requirements','execution');expect((await post({...base,phase:'execution',command:'clear'})).status).toBe(409);
  store.selectTaskPhase(project.id,task.id,'execution','retrospective');store.setTaskCompleted(project.id,task.id,true);expect((await post({...base,phase:'retrospective',command:'clear'})).status).toBe(409);
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('Codex review はネイティブAPIを使い、recap は固定要約指示に変換してパックには元本文を残す',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-native-commands-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'rpc.jsonl'),chat=new ChatService(()=>root,()=>fake);process.env.FAKE_CODEX_LOG=log;
 try{
  for(const content of ['/review','/review changes in example.ts','/recap decision focus','hello']){await chat.send(p,null,content,'model-a',root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed')}
  const c=await chat.get(p,null);expect(c.messages.filter(message=>message.role==='user').map(message=>message.content)).toEqual(['/review','/review changes in example.ts','/recap decision focus','hello']);expect(c.packs.filter(pack=>pack.role==='user').map(pack=>pack.content)).toEqual(['/review','/review changes in example.ts','/recap decision focus','hello']);
  const rows=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(rows.filter(row=>row.method==='review/start').map(row=>row.params)).toEqual([{threadId:'thread-1',target:{type:'uncommittedChanges'},delivery:'inline'},{threadId:'thread-1',target:{type:'custom',instructions:'changes in example.ts'},delivery:'inline'}]);
  const turns=rows.filter(row=>row.method==='turn/start');expect(turns).toHaveLength(2);expect(turns[0].params.input[0].text).toBe('会話のここまでの目的、決定事項、未解決事項、次の作業を簡潔に日本語で要約してください。\ndecision focus');expect(turns[1].params.input[0].text).toBe('hello');expect(rows.filter(row=>row.method==='thread/resume').every(row=>row.params.model==='model-a')).toBe(true);
  for(const content of ['/unknown','/context','/code-review','/help','/compact args'])await expect(chat.send(p,null,content,null,root)).rejects.toThrow('chat command');expect((await chat.get(p,null)).messages).toHaveLength(8);
 }finally{delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});

test('Claude usage は成功した操作出力だけを保存し、会話本文とパックを変更しない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-local-output-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>null,()=>fakeClaude);
 try{
  await chat.send(p,null,'hello','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  await chat.command(p,null,'usage',root,undefined,null,{provider:'claude',model:'sonnet'});await waitFor(async()=>(await chat.get(p,null)).command?.status==='completed');const current=await chat.get(p,null);expect(current.command?.output).toBe('Usage: 3 fictional requests\n');expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(current.threadId).toBe(before.threadId);
  for(const [action,status] of [['failure','failed'],['unavailable','failed'],['fallback','failed'],['oversize','failed'],['disconnect','unknown'],['foreign-session','unknown']] as const){process.env.FAKE_CLAUDE_COMMAND=action;await chat.command(p,null,'usage',root);await waitFor(async()=>(await chat.get(p,null)).command?.status===status);const current=await chat.get(p,null);expect(current.command?.output).toBeUndefined();expect(current.command?.error).toBeString();expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(JSON.stringify(current)).not.toContain('Private')}
  process.env.FAKE_CLAUDE_COMMAND='limit';await chat.command(p,null,'usage',root);await waitFor(async()=>(await chat.get(p,null)).command?.status==='completed');expect(Buffer.byteLength((await chat.get(p,null)).command!.output!)).toBe(65536);
  process.env.FAKE_CLAUDE_COMMAND='wait';await chat.command(p,null,'usage',root);await Bun.sleep(50);await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');expect((await chat.get(p,null)).command?.output).toBeUndefined();
  await chat.command(p,null,'usage',root);await Bun.sleep(50);const restarted=new ChatService(()=>root,()=>null,()=>fakeClaude);expect((await restarted.get(p,null)).command?.status).toBe('unknown');await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  await expect(chat.command(p,null,'usage',root,undefined,null,{args:'extra'})).rejects.toThrow('invalid command');
 }finally{delete process.env.FAKE_CLAUDE_COMMAND;await rm(root,{recursive:true,force:true})}
});

test('Claude 生成コマンドは別名と引数を構造化して送り、接続先変更時の参考履歴も保つ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-message-command-')),p='019a0000-0000-7000-8000-000000000001',log=join(root,'claude.jsonl'),chat=new ChatService(()=>root,()=>fake,()=>fakeClaude);process.env.FAKE_CLAUDE_LOG=log;
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  for(const content of ['/review example.ts','/code-review','/simplify','/security-review','/recap decisions']){await chat.send(p,null,content,'sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed')}
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(calls.map(call=>call.prompt)).toEqual(['/code-review example.ts','/code-review','/simplify','/security-review','/recap decisions']);
  const first=calls[0];expect(first.args).not.toContain('--disable-slash-commands');expect(first.args[first.args.indexOf('--append-system-prompt')+1]).toContain('Beni reference conversation history');expect(first.args[first.args.indexOf('--append-system-prompt')+1]).toContain('Hello');expect(first.args[first.args.indexOf('--tools')+1]).toBe('Read,Glob,Grep');
  const current=await chat.get(p,null);expect(current.messages.filter(message=>message.role==='user').map(message=>message.content)).toEqual(['hello','/review example.ts','/code-review','/simplify','/security-review','/recap decisions']);expect(current.packs.filter(pack=>pack.kind==='tool').length).toBeGreaterThan(0);
 }finally{delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
});

test('Claude review のクラウド実行と投稿引数はAPIで履歴追加前に拒否する',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');const root=await mkdtemp(join(tmpdir(),'beni-review-args-')),store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},chat=new ChatService(()=>root,()=>null,()=>fakeClaude),handler=createHandler(store,'/tmp',chat);
 try{
  for(const content of ['/review ultra','/code-review --post','/review --comment=yes','/review "ultra"','/review `--post`']){
   const result=await handler(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,taskId:null,model:'sonnet',provider:'claude',content})}));expect(result.status).toBe(400);expect(await result.json()).toEqual({error:'クラウド実行やコメント投稿の引数は利用できません'});expect((await chat.get(project.id,null)).messages).toEqual([]);
  }
  await chat.send(project.id,null,'/review feature/ultra-ui --fix','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(project.id,null)).messages.at(-1)?.status==='completed');expect((await chat.get(project.id,null)).messages).toHaveLength(2);
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('編集相談の clear は固定済みプロンプトを維持し、生成コマンドは受け付けない',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');const root=await mkdtemp(join(tmpdir(),'beni-editor-clear-')),store=new Store(join(root,'app.sqlite')),chat=new ChatService(()=>{throw Error('project scope')},()=>fake);createHandler(store,'/tmp',chat);
 try{
  await chat.send('instructions',null,'hello','model-a',root,undefined,null,false,'codex','common');await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');const before=await chat.get('instructions',null),original=store.instructions().find(item=>item.key==='editor')!.content;store.updateInstruction('editor','NEW EDITOR PROMPT',original);
  const beforeFile=JSON.parse(await readFile(store.chats.path(before.id),'utf8'));
  for(const provider of ['codex','claude'] as const)for(const content of ['/review','/recap'])await expect(chat.send('instructions',null,content,null,root,undefined,null,false,provider,'common')).rejects.toThrow('chat command');
  await chat.command('instructions',null,'clear',root);const after=await chat.get('instructions',null);expect(after.id).not.toBe(before.id);expect(after.appliedEditorContent).toBe(original);expect(after.lastInstructionFocus).toBeUndefined();expect(after.instructionToolsVersion).toBeUndefined();expect(after.lastEventId).toBe(0);expect(await chat.instructionEditorState()).toEqual({pending:true,busy:false});expect(JSON.parse(await readFile(store.chats.path(before.id),'utf8'))).toEqual(beforeFile);
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('保存済の確認位置が現在の履歴上限を超えていたら0に戻し、両接続先に通知して確認済み位置を更新する',async()=>{
 for(const provider of ['codex','claude'] as const){
  const root=await mkdtemp(join(tmpdir(),'beni-stale-event-cursor-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'calls.jsonl'),chat=new ChatService(()=>root,()=>fake,()=>fakeClaude);
  process.env.FAKE_CODEX_LOG=log;process.env.FAKE_CLAUDE_LOG=log;
  chat.setTaskEvents({capture:()=>{},events:(_p,_t,after,through=6,limit=100)=>{if(after>6)throw Error('Unknown event cursor');const next=Math.min(after+limit,through);return {events:next>after?[{id:next,type:'document.updated'}]:[],lastEventId:next,through,hasMore:next<through}}});
  try{
   await chat.send(p,t,'hello','sonnet',root,root,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');const before=await chat.get(p,t);
   const file=standaloneChatPath(root,before.id),stored=JSON.parse(await readFile(file,'utf8'));
   stored.providers.claude.models.sonnet.session.lastEventId=43;
   await writeFile(file,JSON.stringify(stored));
   await chat.send(p,t,'event tools',provider==='codex'?'model-a':'sonnet',root,root,'requirements',false,provider);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');const after=await chat.get(p,t);
   expect(after.lastEventId).toBe(6);expect(after.messages.slice(0,before.messages.length)).toEqual(before.messages);expect(after.packs.slice(0,before.packs.length)).toEqual(before.packs);expect(after.phase).toBe(before.phase);expect(after.selectedModel?.provider??'codex').toBe(provider);
   const rows=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   const notice=provider==='codex'?rows.find(row=>row.method==='turn/start')?.params.input.find((input:any)=>input.text.startsWith('Beni project event review range:'))?.text:rows.filter(row=>row.prompt).at(-1)?.prompt;
   expect(notice).toContain('after 0, through 6');expect(notice).toContain('保存済の確認位置が現在の履歴範囲外だったので無効化しました。必要な変更を調べる場合の起点は0です。');
   if(provider==='claude'){expect(after.threadId).toBe(before.threadId);expect(rows.filter(row=>row.prompt).at(-1).args).toContain('--resume')}
   const updated=JSON.parse(await readFile(file,'utf8'));
   updated.providers[provider].models[provider==='codex'?'model-a':'sonnet'].session.lastEventId=3;
   await writeFile(file,JSON.stringify(updated));
   await chat.send(p,t,'hello',provider==='codex'?'model-a':'sonnet',root,root,'requirements',false,provider);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(3);
   const lastRows=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),lastNotice=provider==='codex'?lastRows.filter(row=>row.method==='turn/start').at(-1)?.params.input.find((input:any)=>input.text.startsWith('Beni project event review range:'))?.text:lastRows.filter(row=>row.prompt).at(-1)?.prompt;
   expect(lastNotice).toContain('after 3, through 6');expect(lastNotice).not.toContain('無効化しました');
  }finally{delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_CLAUDE_LOG;await rm(root,{recursive:true,force:true})}
 }
});

test('確認位置のリセットは送信開始前に保存し、履歴取得の他の例外は握りつぶさない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-cursor-preflight-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',chat=new ChatService(()=>root,()=>fake);
 try{
  await chat.send(p,t,'hello',null,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');const before=await chat.get(p,t);
  const file=standaloneChatPath(root,before.id),stored=JSON.parse(await readFile(file,'utf8'));
  stored.providers.codex.models['model-a'].session.lastEventId=43;
  await writeFile(file,JSON.stringify(stored));
  chat.setTaskEvents({capture:()=>{},events:()=>({events:[],lastEventId:0,through:6,hasMore:false})});
  const unavailable=new ChatService(()=>root,()=>null);unavailable.setTaskEvents({capture:()=>{},events:()=>({events:[],lastEventId:0,through:6,hasMore:false})});
  await expect(unavailable.send(p,t,'must not send',null,root)).rejects.toThrow('unavailable');expect(await chat.get(p,t)).toEqual({...before,lastEventId:0});
  for(const stage of ['capture','events'] as const){
   await writeFile(file,JSON.stringify(stored));
   chat.setTaskEvents({capture:()=>{if(stage==='capture')throw Error('Invalid tracked document')},events:()=>{throw Error('Event database unavailable')}});
   await expect(chat.send(p,t,'must not send',null,root)).rejects.toThrow(stage==='capture'?'Invalid tracked document':'Event database unavailable');expect(await chat.get(p,t)).toEqual({...before,lastEventId:43});
  }
 }finally{await rm(root,{recursive:true,force:true})}
});
