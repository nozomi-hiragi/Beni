import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatService} from './chat';
const fake=join(import.meta.dir,'test/fake-codex.ts');
async function waitFor(fn:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await fn())return;await Bun.sleep(20)}throw Error('timed out')}
test('streams, persists, resumes, isolates scopes, and interrupts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{
  const chat=new ChatService(dir,()=>fake);const status=await chat.status();expect(status).toMatchObject({installed:true,path:fake,version:'1.2.3',auth:'chatgpt',models:[{id:'model-a',name:'Model A'}],usage:'unknown'});expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  await chat.send(1,null,'hello','model-a','/tmp');await waitFor(async()=>(await chat.get(1,null)).messages[1].status==='completed');
  let c=await chat.get(1,null);expect(c.messages[1].content).toBe('Hello');expect(c.threadId).toBe('thread-1');expect(c.sessionId).toBe('session-1');expect(c.messages[0].sessionId).toBe('session-1');expect(JSON.parse(await readFile(join(dir,'1-general.json'),'utf8')).messages).toHaveLength(2);
  expect((await chat.get(1,2)).messages).toHaveLength(0);await chat.send(1,null,'wait','model-a','/tmp');await waitFor(async()=>(await chat.get(1,null)).messages[3].status==='streaming');await expect(chat.send(1,null,'duplicate','model-a','/tmp')).rejects.toThrow('busy');await chat.interrupt(1,null);await waitFor(async()=>(await chat.get(1,null)).messages[3].status==='interrupted');
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('distinguishes rejected and uncertain requests, and recovers abandoned requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(dir,()=>fake);await chat.send(1,1,'reject',null,'/tmp');await waitFor(async()=>(await chat.get(1,1)).messages[1].status==='failed');await chat.send(2,null,'disconnect',null,'/tmp');await waitFor(async()=>(await chat.get(2,null)).messages[1].status==='unknown');
 const missing=new ChatService(dir,()=>null);expect((await missing.status()).installed).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('reports authentication and refuses non-subscription sending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{process.env.FAKE_AUTH='apiKey';const chat=new ChatService(dir,()=>fake);expect((await chat.status()).auth).toBe('apiKey');await expect(chat.send(1,null,'hello',null,'/tmp')).rejects.toThrow('unavailable');expect((await chat.get(1,null)).messages).toHaveLength(0)}finally{delete process.env.FAKE_AUTH;await rm(dir,{recursive:true,force:true})}
});
test('marks unfinished saved requests unknown after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(dir,()=>fake);await chat.send(1,null,'wait',null,'/tmp');await waitFor(async()=>(await chat.get(1,null)).messages[1].status==='streaming');const restarted=new ChatService(dir,()=>fake);expect((await restarted.get(1,null)).messages.map(m=>m.status)).toEqual(['unknown','unknown']);await chat.interrupt(1,null)}finally{await Bun.sleep(50);await rm(dir,{recursive:true,force:true})}
});
test('HTTP chat scope validates project and task ownership',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');const store=new Store(':memory:');const projectRoot=await mkdtemp(join(tmpdir(),'beni-project-'));const p=store.createProject('One',projectRoot) as {id:number};const other=store.createProject('Two','/tmp') as {id:number};const task=store.createTask(p.id,'Task') as {id:number};const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));const handler=createHandler(store,'/tmp',new ChatService(dir,()=>fake));const post=(path:string,data:unknown)=>handler(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));try{
  expect((await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${other.id}&taskId=${task.id}`))).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:other.id,taskId:task.id,content:'hello',model:null})).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:p.id,taskId:task.id,content:'hello',model:null})).status).toBe(202);
  await waitFor(async()=>{const res=await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${p.id}&taskId=${task.id}`));return (await res.json()).messages[1].status==='completed'});
 }finally{store.close();await rm(dir,{recursive:true,force:true});await rm(projectRoot,{recursive:true,force:true})}
});

test('rejects server requests with string IDs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(dir,()=>fake);await chat.send(1,null,'approval',null,'/tmp');await waitFor(async()=>(await chat.get(1,null)).messages[1].status==='completed');expect((await chat.get(1,null)).messages[1].content).toContain('denied')}finally{await rm(dir,{recursive:true,force:true})}
});

test('isolates explicitly configured database chat storage',async()=>{
 const {chatDataDirectory}=await import('./server');expect(chatDataDirectory(undefined,undefined,'/tmp/one')).not.toBe(chatDataDirectory(undefined,undefined,'/tmp/two'));expect(chatDataDirectory(undefined,undefined,'/tmp/one')).toBe(chatDataDirectory('beni.sqlite',undefined,'/tmp/one'));  expect(chatDataDirectory('/tmp/one.sqlite',undefined)).toBe('/tmp/one.sqlite.chat');expect(chatDataDirectory('/tmp/one.sqlite','/tmp/explicit')).toBe('/tmp/explicit');
});


test('task conversations write and resume in their document sandbox; general stays read-only',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-task-chat-'));
 const {taskDocuments}=await import('./documents');
 const documentDirectory=taskDocuments(root,1,{requirements:'# Initial\n'});const other=taskDocuments(root,2,{requirements:'# Other task\n'});
 const log=join(root,'rpc.jsonl');process.env.FAKE_CODEX_LOG=log;
 try{
  const chat=new ChatService(join(root,'history'),()=>fake);
  await chat.send(1,1,'write documents','model-a',root,documentDirectory);
  await waitFor(async()=>(await chat.get(1,1)).messages[1].status==='completed');
  expect(await readFile(join(documentDirectory,'requirements.md'),'utf8')).toBe('# Updated requirements\n');
  expect(await readFile(join(documentDirectory,'implementation-plan.md'),'utf8')).toBe('# Updated plan\n');
  expect(await readFile(join(other,'requirements.md'),'utf8')).toBe('# Other task\n');
  const restarted=new ChatService(join(root,'history'),()=>fake);
  await restarted.send(1,1,'hello','model-a',root,documentDirectory);await waitFor(async()=>(await restarted.get(1,1)).messages[3].status==='completed');
  await restarted.send(1,null,'hello','model-a',root);await waitFor(async()=>(await restarted.get(1,null)).messages[1].status==='completed');
  const events=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const start=events.find(event=>event.method==='thread/start');const resume=events.find(event=>event.method==='thread/resume');
  for(const event of [start,resume]){
   expect(event.params.cwd).toBe(documentDirectory);expect(event.params.sandbox).toBe('workspace-write');expect(event.params.developerInstructions).toContain('requirements.md');expect(event.params.developerInstructions).toContain(root);
  }
  const turns=events.filter(event=>event.method==='turn/start');
  for(const turn of turns.slice(0,2))expect(turn.params).toMatchObject({cwd:documentDirectory,approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[documentDirectory],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
  expect(turns[2].params).toMatchObject({cwd:root,sandboxPolicy:{type:'readOnly',networkAccess:false}});
 }finally{delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
});


test('conversation notifications are scope-specific and removable',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-events-'));try{
  const chat=new ChatService(root,()=>fake);let taskChanges=0,generalChanges=0,otherChanges=0;
  const stopTask=chat.subscribe(1,1,()=>taskChanges++),stopGeneral=chat.subscribe(1,null,()=>generalChanges++),stopOther=chat.subscribe(2,1,()=>otherChanges++);
  await chat.send(1,1,'hello',null,root);await waitFor(async()=>(await chat.get(1,1)).messages[1].status==='completed');
  expect(taskChanges).toBeGreaterThan(0);expect(generalChanges).toBe(0);expect(otherChanges).toBe(0);
  stopTask();const previous=taskChanges;await chat.send(1,1,'hello',null,root);await waitFor(async()=>(await chat.get(1,1)).messages[3].status==='completed');expect(taskChanges).toBe(previous);stopGeneral();stopOther();
 }finally{await rm(root,{recursive:true,force:true})}
});
