import { mkdirSync } from 'node:fs';
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChatService} from './chat';
const projectFolder=(root:string,id:string)=>{const folder=join(root,id);mkdirSync(folder,{recursive:true});return folder};
const fake=join(import.meta.dir,'test/fake-codex.ts');
async function waitFor(fn:()=>Promise<boolean>){for(let i=0;i<100;i++){if(await fn())return;await Bun.sleep(20)}throw Error('timed out')}
test('streams, persists, resumes, isolates scopes, and interrupts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{
  const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);const status=await chat.status();expect(status).toMatchObject({installed:true,path:fake,version:'1.2.3',auth:'chatgpt',models:[{id:'model-a',name:'Model A'}],usage:'unknown'});expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  await chat.send('019a0000-0000-7000-8000-000000000001',null,'hello','model-a','/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');
  let c=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(c.messages[1].content).toBe('Hello');expect(c.threadId).toBe('thread-1');expect(c.sessionId).toBe('session-1');expect(c.messages[0].sessionId).toBe('session-1');expect(JSON.parse(await readFile(join(dir,'019a0000-0000-7000-8000-000000000001','.beni','chat','general.json'),'utf8')).messages).toHaveLength(2);
  expect((await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000002')).messages).toHaveLength(0);await chat.send('019a0000-0000-7000-8000-000000000001',null,'wait','model-a','/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[3].status==='streaming');await expect(chat.send('019a0000-0000-7000-8000-000000000001',null,'duplicate','model-a','/tmp')).rejects.toThrow('busy');await chat.interrupt('019a0000-0000-7000-8000-000000000001',null);await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[3].status==='interrupted');
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('distinguishes rejected and uncertain requests, and recovers abandoned requests',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);await chat.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','reject',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[1].status==='failed');await chat.send('019a0000-0000-7000-8000-000000000002',null,'disconnect',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000002',null)).messages[1].status==='unknown');
 const missing=new ChatService(p=>projectFolder(dir,p),()=>null);expect((await missing.status()).installed).toBe(false);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('reports authentication and refuses non-subscription sending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{process.env.FAKE_AUTH='apiKey';const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);expect((await chat.status()).auth).toBe('apiKey');await expect(chat.send('019a0000-0000-7000-8000-000000000001',null,'hello',null,'/tmp')).rejects.toThrow('unavailable');expect((await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages).toHaveLength(0)}finally{delete process.env.FAKE_AUTH;await rm(dir,{recursive:true,force:true})}
});
test('marks unfinished saved requests unknown after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'beni-chat-'));try{const chat=new ChatService(p=>projectFolder(dir,p),()=>fake);await chat.send('019a0000-0000-7000-8000-000000000001',null,'wait',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='streaming');const restarted=new ChatService(p=>projectFolder(dir,p),()=>fake);expect((await restarted.get('019a0000-0000-7000-8000-000000000001',null)).messages.map(m=>m.status)).toEqual(['unknown','unknown']);await chat.interrupt('019a0000-0000-7000-8000-000000000001',null)}finally{await Bun.sleep(50);await rm(dir,{recursive:true,force:true})}
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
  const {packHash}=await import('../shared/communication');const chat=new ChatService(p=>projectFolder(root,p),()=>fake);const events:any[]=[];chat.subscribe('019a0000-0000-7000-8000-000000000001',null,event=>events.push(event));
  await chat.send('019a0000-0000-7000-8000-000000000001',null,'tools','model-a','/tmp');
  await waitFor(async()=>events.some(e=>e.name==='chat.pack.closed'&&e.data.header.role==='assistant'&&e.data.header.kind==='text'));
  const during=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(during.messages[1].status).toBe('streaming');const before=during.packs.find(p=>p.content==='Before tool')!;expect(before.state).toBe('closed');
  const stored=JSON.parse(await readFile(join(root,'019a0000-0000-7000-8000-000000000001','.beni','chat','general.json'),'utf8'));expect(stored.packs.find((p:any)=>p.packId===before.packId)).toEqual(before);
  expect(await chat.ack('019a0000-0000-7000-8000-000000000001',null,before.packId,await packHash(before))).toEqual({matched:true});expect(await chat.ack('019a0000-0000-7000-8000-000000000001',null,before.packId,'0'.repeat(64))).toEqual({matched:false,pack:before});
  const generating=during.packs.find(p=>p.kind==='tool')!;expect(generating.state).toBe('streaming');await expect(chat.pack('019a0000-0000-7000-8000-000000000001',null,generating.packId)).rejects.toThrow('not closed');
  await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');const after=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(after.packs.map(p=>[p.role,p.kind,p.state])).toEqual([['user','text','closed'],['assistant','text','closed'],['assistant','tool','closed'],['assistant','text','closed']]);
  expect(after.packs[2].tool).toEqual({name:'command',input:'echo example',output:'example\n'});expect(after.packs.find(p=>p.packId===before.packId)).toEqual(before);
  expect((await chat.packs('019a0000-0000-7000-8000-000000000001',null,before.packId)).packs.map(p=>p.packId)).toEqual(after.packs.slice(2).map(p=>p.packId));await expect(chat.packs('019a0000-0000-7000-8000-000000000001',null,'missing')).rejects.toThrow('not found');await expect(chat.pack('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000002',before.packId)).rejects.toThrow('not found');
  const closed=events.findIndex(e=>e.name==='chat.pack.closed'&&e.data.packId===before.packId);expect(events.slice(closed+1).some(e=>e.name==='chat.pack.delta'&&e.data.packId===before.packId)).toBe(false);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('failure, rejection and interrupted packs remain visible and recover on restart before direct send',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-pack-recovery-'));try{
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);await chat.send('019a0000-0000-7000-8000-000000000001',null,'reject',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='failed');expect((await chat.get('019a0000-0000-7000-8000-000000000001',null)).packs.at(-1)).toMatchObject({role:'assistant',content:'',state:'closed',status:'failed'});
  await chat.send('019a0000-0000-7000-8000-000000000002',null,'fail',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000002',null)).messages[1].status==='failed');expect((await chat.get('019a0000-0000-7000-8000-000000000002',null)).packs.at(-1)).toMatchObject({content:'Hello',status:'failed',state:'closed'});
  await chat.send('019a0000-0000-7000-8000-000000000003',null,'wait',null,'/tmp');await waitFor(async()=>(await chat.get('019a0000-0000-7000-8000-000000000003',null)).messages[1].status==='streaming');const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);await restarted.send('019a0000-0000-7000-8000-000000000003',null,'hello',null,'/tmp');await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000003',null)).messages[3].status==='completed');const packs=(await restarted.get('019a0000-0000-7000-8000-000000000003',null)).packs;expect(packs[1]).toMatchObject({status:'unknown',state:'closed'});expect(packs.every(p=>p.state==='closed')).toBe(true);await chat.interrupt('019a0000-0000-7000-8000-000000000003',null);await Bun.sleep(30);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('パックのない旧履歴は変換せず拒否する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-old-packs-')),p='019a0000-0000-7000-8000-000000000001';
 try{
  const {writeFile,mkdir}=await import('node:fs/promises'),folder=join(root,'.beni','chat'),path=join(folder,'general.json');await mkdir(folder,{recursive:true});
  const bytes=JSON.stringify({version:1,id:'conversation',projectId:p,taskId:null,threadId:null,sessionId:null,messages:[]});await writeFile(path,bytes);
  const chat=new ChatService(()=>root,()=>fake);await expect(chat.get(p,null)).rejects.toThrow('Invalid history');expect(await readFile(path,'utf8')).toBe(bytes);
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
  expect(JSON.parse(await readFile(join(folder,'.beni','chat',t,'requirements.json'),'utf8'))).toEqual(saved);
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
  await mkdir(join(root,'.beni','chat'),{recursive:true});const path=join(root,'.beni','chat','general.json');
  const future=JSON.stringify({version:99,projectId:p,taskId:null,messages:[]});await writeFile(path,future);
  await expect(chat.get(p,null)).rejects.toThrow('Invalid history');expect(await readFile(path,'utf8')).toBe(future);await rm(path);
  const target=join(root,'outside.json');await writeFile(target,future);await symlink(target,path);await expect(chat.get(p,null)).rejects.toThrow('Invalid metadata file');await rm(path);
  await link(target,path);await expect(chat.get(p,null)).rejects.toThrow('Invalid metadata file');expect(await readFile(target,'utf8')).toBe(future);await rm(path);
  await rm(join(root,'.beni','chat'),{recursive:true});const other=join(root,'outside');await mkdir(other);await symlink(other,join(root,'.beni','chat'));await expect(chat.get(p,null)).rejects.toThrow('Invalid managed directory');
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

test('旧タスク会話は移行せず、フェーズ別会話を独立して保存する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-old-chat-'));const p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const {mkdir,writeFile}=await import('node:fs/promises');const folder=join(root,'.beni','chat');
 try{
  await mkdir(folder,{recursive:true});const old=join(folder,`${t}.json`),bytes=JSON.stringify({version:1,id:'old',projectId:p,taskId:t,threadId:'old-thread',sessionId:'old-session',messages:[],packs:[]});await writeFile(old,bytes);
  const chat=new ChatService(()=>root,()=>fake);for(const phase of ['requirements','documents','implementation','execution','retrospective'] as const)expect((await chat.get(p,t,phase)).messages).toEqual([]);
  await chat.send(p,t,'hello',null,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  expect(await readFile(old,'utf8')).toBe(bytes);expect(JSON.parse(await readFile(join(folder,t,'requirements.json'),'utf8')).messages).toHaveLength(2);
  for(const phase of ['implementation','execution'] as const){
   await chat.send(p,t,phase,null,root,undefined,phase);await waitFor(async()=>(await chat.get(p,t,phase)).messages.at(-1)?.status==='completed');
   expect(JSON.parse(await readFile(join(folder,t,`${phase}.json`),'utf8'))).toMatchObject({phase,messages:[{content:phase},{content:'Hello'}]});
  }
  expect((await chat.get(p,t,'implementation')).messages[0].content).toBe('implementation');
  expect((await chat.get(p,t,'execution')).messages[0].content).toBe('execution');
 }finally{await rm(root,{recursive:true,force:true})}
});

test('引継ぎは上限だけ渡し、ツールの確認完了で進め、未確認範囲を再送する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-phase-cursor-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'rpc.jsonl');process.env.FAKE_CODEX_LOG=log;let tail=3;
 const chat=new ChatService(()=>root,()=>fake);chat.setTaskEvents({capture:()=>{},events:(_p,_t,after,through=tail,limit=100)=>{const next=Math.min(after+limit,through);return {events:next>after?[{id:next,type:'document.updated',path:'requirements.md',secret:'never-injected'}]:[],lastEventId:next,nextCursor:next,through,hasMore:next<through}}});
 try{
  await chat.send(p,t,'reject',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='failed');expect((await chat.get(p,t)).lastEventId).toBe(0);
  await chat.send(p,t,'hello',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(0);
  await chat.send(p,t,'event tools',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(3);
  tail=4;await chat.send(p,t,'event tools',null,root,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');expect((await chat.get(p,t)).lastEventId).toBe(4);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),turns=records.filter(event=>event.method==='turn/start');expect(turns[0].params.input[1].text).toContain('after 0, through 3');expect(turns[1].params.input[1].text).toContain('after 0, through 3');expect(turns[3].params.input[1].text).toContain('after 3, through 4');expect(JSON.stringify(turns)).not.toContain('never-injected');expect(records.find(event=>event.method==='thread/start').params.dynamicTools.map((tool:any)=>tool.name)).toContain('acknowledge_events');expect(records.find(event=>event.method==='thread/resume').params.dynamicTools).toBeUndefined();
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
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);
  await chat.send(p,t,'hello','model-a',root);
  await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const status=await chat.status();chat.status=async()=>({...status,models:[...status.models!,{id:'model-b',name:'Model B'}]});
  await chat.send(p,t,'hello','model-b',root);
  await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);
  expect((await restarted.get(p,t)).selectedModel).toEqual({id:'model-b',name:'Model B'});
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

test('接続先を往復しても他 CLI のセッションを再開せず、本文の履歴だけ引き継ぐ',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-provider-switch-')),p='019a0000-0000-7000-8000-000000000001',claudeLog=join(root,'claude.jsonl'),codexLog=join(root,'codex.jsonl');
 process.env.FAKE_CLAUDE_LOG=claudeLog;process.env.FAKE_CODEX_LOG=codexLog;
 try{
  const chat=new ChatService(()=>root,()=>fake,()=>fakeClaude);
  await chat.send(p,null,'Codex context','model-a',root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  await chat.send(p,null,'Claude question',null,root,undefined,null,false,'claude','editor');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const claude=await chat.get(p,null);expect(claude.threadId).not.toBe('thread-1');expect(claude.selectedModel?.id).toBe('sonnet');
  const invocation=JSON.parse((await readFile(claudeLog,'utf8')).trim());expect(invocation.args).toContain('--session-id');expect(invocation.args).not.toContain('--resume');expect(invocation.prompt).toContain('Codex context');expect(invocation.prompt).toContain('Hello');
  await chat.send(p,null,'Codex returns',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  const result=await chat.get(p,null);expect(result.messages.map(m=>m.provider)).toEqual(['codex','codex','claude','claude','codex','codex']);expect(result.messages[0]?.model).toBe('model-a');expect(result.messages[2]?.model).toBe('sonnet');
  const records=(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(records.filter(record=>record.method==='thread/resume')).toHaveLength(0);expect(records.filter(record=>record.method==='thread/start')).toHaveLength(2);
  const turn=records.filter(record=>record.method==='turn/start').at(-1);expect(turn.params.input[1].text).toContain('Claude question');expect(turn.params.input[1].text).not.toContain('sessionId');
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CODEX_LOG;await rm(root,{recursive:true,force:true})}
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
 expect(validPack({...pack,provider:'claude'})).toBe(true);expect(validPack({...pack,provider:'other'})).toBe(false);
 expect(await packHash({...pack,provider:'codex'})).toBe(await packHash(pack));expect(await packHash({...pack,provider:'claude'})).not.toBe(await packHash(pack));
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

test('Claude の存在しない再開セッションは明示失敗として残し、カーソルを進めない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-claude-missing-resume-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',log=join(root,'claude.jsonl');
 process.env.FAKE_CLAUDE_LOG=log;
 try{
  const chat=new ChatService(()=>root,()=>null,()=>fakeClaude);let through=1;
  chat.setTaskEvents({capture:()=>{},events:(_p,_t,after)=>({events:after<through?[{id:through,type:'document.updated'}]:[],lastEventId:through,through,hasMore:false})});
  await chat.send(p,t,'event tools','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const accepted=await chat.get(p,t);through=2;process.env.FAKE_CLAUDE_RESUME_MISSING='1';
  await chat.send(p,t,'Next question','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='failed');
  expect(await chat.get(p,t)).toMatchObject({threadId:null,sessionId:null,lastEventId:1});expect((await chat.get(p,t)).messages).toHaveLength(4);
  await Bun.sleep(30);const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(records).toHaveLength(2);expect(records[1].args).toContain('--resume');expect(records[1].session).toBe(accepted.sessionId);expect(records[1].prompt).toContain('after 1, through 2');
  delete process.env.FAKE_CLAUDE_RESUME_MISSING;await chat.send(p,t,'event tools','sonnet',root,undefined,'requirements',false,'claude');await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  const retried=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).at(-1);expect(retried.args).toContain('--session-id');expect(retried.args).not.toContain('--resume');expect(retried.session).not.toBe(accepted.sessionId);expect(retried.prompt).toContain('Next question');expect(retried.prompt).toContain('after 1, through 2');expect((await chat.get(p,t)).lastEventId).toBe(2);
 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CLAUDE_RESUME_MISSING;await rm(root,{recursive:true,force:true})}
});

test('両接続先の埋め込みツールは同一プロジェクトだけを参照し、確認範囲と入力を検証する',async()=>{
 for(const provider of ['codex','claude'] as const){
  const root=await mkdtemp(join(tmpdir(),'beni-embedded-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001',other='019a0000-0000-7100-8000-000000000002';
  const chat=new ChatService(()=>root,()=>fake,()=>fakeClaude),lookups:any[]=[];
  chat.setTaskEvents({capture:()=>{},events:(project,task,after,through=6,limit=100)=>{lookups.push([project,task,after,through]);const next=Math.min(after+limit,through);return {events:next>after?[{id:next,type:'document.updated',taskId:other}]:[],lastEventId:next,nextCursor:next,through,hasMore:next<through}},event:(project,id)=>{lookups.push([project,id]);return {id,taskId:other}},change:(_project,id)=>({eventId:id,patch:'recorded patch'}),version:(_project,path,id)=>({path,changeId:id,content:'recorded version'})});
  const calls=[
   {tool:'list_events',arguments:{after:0,through:6,limit:1,task_id:other,kind:'tool.finished'}},
   {tool:'get_event',arguments:{event_id:2}},
   {tool:'get_file_change',arguments:{event_id:3}},
   {tool:'get_file_version',arguments:{path:`.beni/tasks/${other}/requirements.md`,change_id:3}},
   {tool:'acknowledge_events',arguments:{through:6}},
   {tool:'acknowledge_events',arguments:{through:4}},
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
   expect(c.lastEventId).toBe(6);expect(results.slice(0,6).every((result:any)=>result.success)).toBe(true);expect(results.slice(6).every((result:any)=>!result.success)).toBe(true);
   expect(results[0].value).toMatchObject({events:[],nextCursor:1,hasMore:true});expect(results[1].value.taskId).toBe(other);expect(results[3].value.content).toBe('recorded version');expect(results[5].value.through).toBe(6);expect(lookups.every(value=>value[0]===p)).toBe(true);
   delete process.env.FAKE_EMBEDDED_CALLS;
   await chat.send(p,null,'event tools',null,root,undefined,null,false,provider);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');expect((await chat.get(p,null)).lastEventId).toBe(6);
  }finally{delete process.env.FAKE_EMBEDDED_CALLS;await rm(root,{recursive:true,force:true})}
 }
});

test('操作イベントは出力を重複せず、他タスクのパック参照と削除済み出力を取得する',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-output-events-')),p='019a0000-0000-7000-8000-000000000001',t='019a0000-0000-7100-8000-000000000001';
 const chat=new ChatService(()=>root,()=>fake),records:any[]=[];let captures=0;
 chat.setTaskEvents({capture:()=>{captures++},events:(_p,_t,after,through=records.length,limit=100)=>{const events=records.filter(event=>event.id>after&&event.id<=through).slice(0,limit),next=events.at(-1)?.id??through;return {events,lastEventId:next,nextCursor:next,through,hasMore:next<through}},append:(_p,input)=>{const event={id:records.length+1,...input};records.push(event);return event}});
 try{
  await chat.send(p,t,'tools',null,root);await waitFor(async()=>(await chat.get(p,t)).messages.at(-1)?.status==='completed');
  expect(records).toHaveLength(2);expect(records.map(event=>event.type)).toEqual(['tool.started','tool.finished']);expect(records[1].details).toEqual({toolName:'command',targetPaths:[],result:'completed',exitCode:0});expect(records[1].packId).toBe((await chat.get(p,t)).packs.find(pack=>pack.kind==='tool')?.packId);expect(JSON.stringify(records)).not.toContain('echo example');expect(JSON.stringify(records)).not.toContain('example\\n');expect(captures).toBeGreaterThanOrEqual(3);
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'get_execution_output',arguments:{operation_id:records[0].operationId}}]);
  await chat.send(p,null,'event tools',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  let result=JSON.parse(JSON.parse((await chat.get(p,null)).messages.at(-1)!.content)[0].contentItems[0].text);expect(result).toMatchObject({deleted:false,output:'example\n',status:'completed'});
  await rm(join(root,'.beni','chat',t),{recursive:true});
  await chat.send(p,null,'event tools',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  result=JSON.parse(JSON.parse((await chat.get(p,null)).messages.at(-1)!.content)[0].contentItems[0].text);expect(result.deleted).toBe(true);await expect(readFile(join(root,'.beni','chat',t,'requirements.json'),'utf8')).rejects.toThrow();
 }finally{delete process.env.FAKE_EMBEDDED_CALLS;await rm(root,{recursive:true,force:true})}
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
 const {Store}=await import('./store/index');const {Database}=await import('bun:sqlite');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-instructions-')),path=join(root,'app.sqlite');
 const store=new Store(path),db=new Database(path),p=store.createProject('Example',root);
 const codexLog=join(root,'codex.jsonl'),claudeLog=join(root,'claude.jsonl');
 process.env.FAKE_CODEX_LOG=codexLog;process.env.FAKE_CLAUDE_LOG=claudeLog;
 try {
  db.query('UPDATE instructions SET content=? WHERE key=?').run('Saved common {{project_directory}}','common');
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
  db.query('UPDATE instructions SET content=? WHERE key=?').run('Saved phase {{task_id}} at {{task_directory}}','requirements');
  const taskDirectory=store.taskDocumentFolder(p.id,task.id);
  await chat.send(p.id,task.id,'hello','model-a',root,taskDirectory,'requirements');
  await waitFor(async()=>(await chat.get(p.id,task.id,'requirements')).messages[1].status==='completed');
  const taskEvents=(await readFile(codexLog,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  expect(taskEvents.filter(event=>event.method==='thread/start').at(-1).params.developerInstructions).toBe('Saved common '+root+'\n\nSaved phase '+task.id+' at '+taskDirectory);
  db.query('UPDATE instructions SET content=? WHERE key=?').run('{{unknown}}','common');
  await expect(chat.send(p.id,null,'hello','model-a',root)).rejects.toThrow('未知のインストラクション変数: unknown');
  expect((await chat.get(p.id,null)).messages).toHaveLength(4);
 } finally {delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_CLAUDE_LOG;db.close();store.close();await rm(root,{recursive:true,force:true})}
});

test('instruction editor uses isolated readonly scope, validates updates and persists history',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-editor-')),store=new Store(join(root,'app.sqlite')),log=join(root,'rpc.jsonl');
 const chat=new ChatService(()=>{throw Error('must not resolve project')},()=>fake),handle=createHandler(store,'/tmp',chat);
 const post=(data:unknown)=>handle(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try{
  const previous=store.instructions()[0]!.content;let changes=0;chat.subscribe('instructions',null,event=>{if(event.name==='chat.changed')changes++});
  process.env.FAKE_CODEX_LOG=log;process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'update_instruction',arguments:{key:'common',content:'# Updated {{working_directory}} {{project_directory}} {{working_directory}}',expected_content:previous}},{tool:'update_instruction',arguments:{key:'common',content:'# stale',expected_content:previous}},{tool:'update_instruction',arguments:{key:'common',content:'{{task_id}}',expected_content:'# Updated {{working_directory}} {{project_directory}} {{working_directory}}'}}]);
  expect((await post({projectId:'instructions',taskId:null,instructionFocus:'common',content:'save',model:'model-a'})).status).toBe(202);
  await waitFor(async()=>(await chat.get('instructions',null)).messages[1]?.status==='completed');
  expect(store.instructions()[0]!.content).toBe('# Updated {{working_directory}} {{project_directory}} {{working_directory}}');expect(changes).toBeGreaterThan(2);
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));const start=records.find(item=>item.method==='thread/start');
  expect(start.params.sandbox).toBe('read-only');expect(start.params.cwd).toBe(join(root,'instruction-editor'));expect(start.params.dynamicTools.map((item:any)=>item.name)).toEqual(['list_instructions','get_instruction','update_instruction']);
  expect(start.params.developerInstructions).toContain('get_instruction');expect(start.params.developerInstructions).not.toContain(previous);
  const toolResponses=records.filter(item=>item.id?.startsWith?.('embedded:')).map(item=>item.result);
  expect(toolResponses.map(item=>item.success)).toEqual([true,false,false]);
  expect(JSON.parse(toolResponses[0].contentItems[0].text)).toEqual({key:'common',content:'# Updated {{working_directory}} {{project_directory}} {{working_directory}}',variables:{working_directory:[{line:1,column:11},{line:1,column:55}],project_directory:[{line:1,column:33}]}});
  expect(JSON.parse(await readFile(join(root,'chat/instructions.json'),'utf8')).messages).toHaveLength(2);
  const restarted=new ChatService(()=>{throw Error('must not resolve project')});createHandler(store,'/tmp',restarted);expect((await restarted.get('instructions',null)).messages).toHaveLength(2);
  expect((await post({projectId:'instructions',taskId:null,phase:null,content:'bad',model:null})).status).toBe(400);
  expect((await handle(new Request('http://127.0.0.1:3210/api/terminals?projectId=instructions'))).status).toBe(404);
  for(const [key,content] of [['missing','# x'],['common',''],['common','x'.repeat(65537)],['requirements','{{execution_chat_path}}']])expect(()=>store.updateInstruction(key,content,previous)).toThrow();
  const editor=store.instructions().find(item=>item.key==='editor')!;store.updateInstruction('editor','自由な {{custom}}',editor.content);
  delete process.env.FAKE_CODEX_LOG;
  const claudeLog=join(root,'claude.jsonl');process.env.FAKE_CLAUDE_LOG=claudeLog;
  const claude=new ChatService(()=>{throw Error('must not resolve project')},()=>fake,()=>join(import.meta.dir,'test/fake-claude.ts'));createHandler(store,'/tmp',claude);
  process.env.FAKE_EMBEDDED_CALLS=JSON.stringify([{tool:'update_instruction',arguments:{key:'editor',content:'# Claude saved {{project_directory}} {{custom}} {{project_directory}}',expected_content:'自由な {{custom}}'}}]);
  await claude.send('instructions',null,'save','sonnet','/tmp',undefined,null,false,'claude','editor');
  await waitFor(async()=>(await claude.get('instructions',null)).messages.at(-1)?.status==='completed');
  expect(store.instructions().find(item=>item.key==='editor')!.content).toBe('# Claude saved {{project_directory}} {{custom}} {{project_directory}}');
  const editorResult=JSON.parse(JSON.parse((await claude.get('instructions',null)).messages.at(-1)!.content)[0].content[0].text);
  expect(editorResult).toEqual({key:'editor',content:'# Claude saved {{project_directory}} {{custom}} {{project_directory}}',variables:{}});
  const claudeArgs=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n')[0]!).args;
  expect(claudeArgs[claudeArgs.indexOf('--tools')+1]).toBe('');expect(claudeArgs[claudeArgs.indexOf('--allowedTools')+1]).toContain('mcp__beni__update_instruction');
  expect(claudeArgs[claudeArgs.indexOf('--append-system-prompt')+1]).toContain(editor.content);
  const claudeRecord=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n')[0]!);expect(claudeRecord.prompt).toContain('現在ユーザーが注目しているインストラクション: editor');
  expect((await claude.get('instructions',null)).lastInstructionFocus).toBe('editor');
  delete process.env.FAKE_EMBEDDED_CALLS;
  await claude.send('instructions',null,'hello','sonnet','/tmp',undefined,null,false,'claude','editor');
  await waitFor(async()=>(await claude.get('instructions',null)).messages.at(-1)?.status==='completed');
  const continued=JSON.parse((await readFile(claudeLog,'utf8')).trim().split('\n').at(-1)!);expect(continued.prompt).toContain('現在ユーザーが注目しているインストラクション');expect(continued.prompt).toContain('# Claude saved');

 }finally{delete process.env.FAKE_CLAUDE_LOG;delete process.env.FAKE_CODEX_LOG;delete process.env.FAKE_EMBEDDED_CALLS;store.close();await rm(root,{recursive:true,force:true})}
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
  const restarted=new ChatService(()=>{throw Error('must not resolve project')},()=>fake);createHandler(store,'/tmp',restarted);
  expect((await restarted.get('instructions',null)).lastInstructionFocus).toBe('editor');
  await restarted.send('instructions',null,'hello','model-a','/tmp',undefined,null,false,'codex','editor');
  await waitFor(async()=>(await restarted.get('instructions',null)).messages.at(-1)?.status==='completed');
  expect((await inputs()).at(-1)).toHaveLength(1);
  expect((await restarted.get('instructions',null)).messages.filter(item=>item.role==='user').every(item=>item.content==='hello'||item.content==='reject')).toBe(true);
 }finally{delete process.env.FAKE_CODEX_LOG;store.close();await rm(root,{recursive:true,force:true})}
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
  const archiveDir=join(root,'chat/instruction-history');await import('node:fs/promises').then(fs=>fs.symlink('/tmp',archiveDir));
  expect((await apply('NEW EDITOR PROMPT')).status).toBe(500);expect((await chat.get('instructions',null)).id).toBe(before.id);await rm(archiveDir);
  expect((await apply('stale')).status).toBe(409);expect((await apply('NEW EDITOR PROMPT','https://other.example')).status).toBe(403);expect((await apply(null)).status).toBe(400);
  await chat.send('instructions',null,'wait','model-a','/tmp',undefined,null,false,'codex','common');
  expect((await apply('NEW EDITOR PROMPT')).status).toBe(409);
  await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='streaming');await chat.interrupt('instructions',null);await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='interrupted');
  const previous=await chat.get('instructions',null);let changed=0;chat.subscribe('instructions',null,event=>{if(event.name==='chat.changed')changed++});
  expect(await (await apply('NEW EDITOR PROMPT')).json()).toEqual({editorState:{pending:false,busy:false}});
  const current=await chat.get('instructions',null);expect(current.id).not.toBe(before.id);expect(current.messages).toEqual([]);expect(current.threadId).toBeNull();expect(current.selectedModel).toEqual(previous.selectedModel);expect(current.lastInstructionFocus).toBeUndefined();expect(current.lastInstructionFocusHash).toBeUndefined();expect(changed).toBe(1);
  expect(JSON.parse(await readFile(join(root,'chat/instruction-history',`${before.id}.json`),'utf8'))).toEqual(previous);
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
   const editor=store.instructions().find(item=>item.key==='editor')!;await chat.get('instructions',null);store.updateInstruction('editor','# pending raw {{custom}}',editor.content);
   const calls=[{tool:'list_instructions',arguments:{}},{tool:'get_instruction',arguments:{key:'editor'}},...[
    ['list_instructions',{key:'common'}],['list_instructions',null],['get_instruction',{}],['get_instruction',{key:'missing'}],['get_instruction',{key:'common',extra:true}],['get_instruction',[]],['update_instruction',{key:'common',content:'x'}]
   ].map(([tool,args])=>({tool,arguments:args}))];
   process.env.FAKE_EMBEDDED_CALLS=JSON.stringify(calls);process.env[provider==='codex'?'FAKE_CODEX_LOG':'FAKE_CLAUDE_LOG']=log;
   await chat.send('instructions',null,'read',provider==='codex'?'model-a':'sonnet','/tmp',undefined,null,false,provider,'common');
   await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');
   const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   const results=provider==='codex'?records.filter(item=>item.id?.startsWith?.('embedded:')).map(item=>item.result):JSON.parse((await chat.get('instructions',null)).messages.at(-1)!.content).map((item:any)=>({success:!item.isError,contentItems:item.content}));
   expect(results.map((item:any)=>item.success)).toEqual([true,true,false,false,false,false,false,false,false]);
   const list=JSON.parse(results[0].contentItems[0].text);expect(list.instructions).toHaveLength(7);expect(list.instructions.every((item:any)=>Object.keys(item).sort().join(',')==='key,name')).toBe(true);
   expect(JSON.parse(results[1].contentItems[0].text)).toEqual({key:'editor',content:'# pending raw {{custom}}'});
   const system=provider==='codex'?records.find(item=>item.method==='thread/start').params.developerInstructions:records[0].args[records[0].args.indexOf('--append-system-prompt')+1];
   expect(system).toContain(editor.content);expect(system).not.toContain('# pending raw');expect(system).not.toContain(store.instructions()[1]!.content);
   delete process.env.FAKE_EMBEDDED_CALLS;
   // 古いセッションは履歴を維持してツール登録済みの新規セッションに切り替える。
   const path=join(root,'chat/instructions.json');const saved=JSON.parse(await readFile(path,'utf8'));delete saved.instructionToolsVersion;await writeFile(path,JSON.stringify(saved));
   await chat.send('instructions',null,'resume',provider==='codex'?'model-a':'sonnet','/tmp',undefined,null,false,provider,'common');await waitFor(async()=>(await chat.get('instructions',null)).messages.at(-1)?.status==='completed');
   const latest=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
   if(provider==='codex'){expect(latest.filter(item=>item.method==='thread/start')).toHaveLength(2);expect(latest.filter(item=>item.method==='turn/start').at(-1).params.input.some((item:any)=>item.text.includes('reference conversation history'))).toBe(true)}
   else expect(latest.at(-1).args[latest.at(-1).args.indexOf('--allowedTools')+1]).toContain('mcp__beni__get_instruction');
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
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');
  for(const [action,status] of [['early','completed'],['unrelated','completed'],['reject','failed'],['fail','failed'],['disconnect','unknown'],['disconnect-before-ack','unknown'],['missing-boundary','unknown'],['boundary-failure','failed'],['boundary-interrupt','interrupted'],['boundary-disconnect','unknown']] as const){
   process.env.FAKE_CODEX_COMPACT_ACTION=action;await chat.command(p,null,'compact',root);if(action==='early'||action==='unrelated'){await Bun.sleep(30);expect((await chat.get(p,null)).command?.status).toBe('running')}
   await waitFor(async()=>(await chat.get(p,null)).command?.status===status);
  }
  process.env.FAKE_CODEX_COMPACT_ACTION='wait';await chat.command(p,null,'compact',root);await Bun.sleep(30);await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  await chat.command(p,null,'compact',root);await Bun.sleep(30);const restarted=new ChatService(()=>root,()=>fake);expect((await restarted.get(p,null)).command?.status).toBe('unknown');await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  process.env.FAKE_CODEX_COMPACT_ACTION='no-turn';await chat.command(p,null,'compact',root);await Bun.sleep(30);await chat.interrupt(p,null);expect((await chat.get(p,null)).command?.status).toBe('unknown');
  expect((await chat.get(p,null)).messages).toHaveLength(2);
 }finally{delete process.env.FAKE_CODEX_COMPACT_ACTION;await rm(root,{recursive:true,force:true})}
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

test('コマンド候補は接続先と別名を解決し、未選択では共通の画面操作だけを返す',async()=>{
 const {commandsForProvider,findChatCommand}=await import('../shared/chat-commands');
 expect(commandsForProvider(undefined).every(command=>command.kind==='client')).toBe(true);
 expect(commandsForProvider('codex').map(command=>command.name)).not.toContain('context');
 expect(findChatCommand('stats','claude')?.name).toBe('usage');expect(findChatCommand('cost','codex')).toBeUndefined();
 expect(findChatCommand('new','codex')?.name).toBe('clear');expect(findChatCommand('reset','claude')?.name).toBe('clear');
});

test('clear は元のJSONを保存して会話IDとセッションを切り替え、失敗時は元の会話を保つ',async()=>{
 const {symlink}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'beni-clear-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>fake);
 try{
  await chat.send(p,null,'hello',null,root);await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  let changed=0;const unsubscribe=chat.subscribe(p,null,event=>{if(event.name==='chat.changed')changed++});
  await chat.command(p,null,'clear',root,undefined,null,{provider:'claude',model:'sonnet'});unsubscribe();const after=await chat.get(p,null);
  expect(after.id).not.toBe(before.id);expect(after).toMatchObject({lastEventId:0,messages:[],packs:[],threadId:null,sessionId:null,command:{name:'clear',status:'completed'},selectedModel:before.selectedModel});expect(after.sessionProvider).toBeUndefined();expect(changed).toBe(1);
  expect(JSON.parse(await readFile(join(root,'.beni/chat/history',`${before.id}.json`),'utf8'))).toEqual(before);
  await chat.command(p,null,'clear',root);const empty=await chat.get(p,null);expect(empty.id).not.toBe(after.id);
  const archive=join(root,'.beni/chat/history',`${empty.id}.json`),outside=join(root,'outside.json');await writeFile(outside,'{}');await symlink(outside,archive);
  await expect(chat.command(p,null,'clear',root)).rejects.toThrow('Invalid metadata file');expect(await chat.get(p,null)).toEqual(empty);expect(await readFile(outside,'utf8')).toBe('{}');
  await rm(archive);await rm(join(root,'.beni/chat/history'),{recursive:true});await symlink(root,join(root,'.beni/chat/history'));
  await expect(chat.command(p,null,'clear',root)).rejects.toThrow('Invalid managed directory');expect(await chat.get(p,null)).toEqual(empty);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('clear 後の履歴は通常のタスク削除に含まれ、不正な履歴リンクは拒否する',async()=>{
 const {Store}=await import('./store/index');const {symlink}=await import('node:fs/promises');const {validateChatDirectory}=await import('./data');
 const root=await mkdtemp(join(tmpdir(),'beni-clear-delete-')),store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},task=store.createTask(project.id,'Example task') as {id:string},chat=new ChatService(()=>root,()=>fake);
 try{
  const taskDirectory=join(root,'.beni/chat',task.id);await chat.command(project.id,task.id,'clear',root);validateChatDirectory(taskDirectory);
  const linked=join(taskDirectory,'history','019a0000-0000-4000-8000-000000000001.json'),outside=join(root,'outside.json');await writeFile(outside,'{}');await symlink(outside,linked);
  expect(()=>validateChatDirectory(taskDirectory)).toThrow('Invalid metadata file');expect(()=>store.deleteTask(project.id,task.id)).toThrow('Invalid metadata file');
  await rm(linked);store.deleteTask(project.id,task.id);await expect(readFile(join(taskDirectory,'requirements.json'),'utf8')).rejects.toThrow();expect(store.task(task.id)).toBeNull();expect(await readFile(outside,'utf8')).toBe('{}');
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('選択中の接続先がセッションと違う操作や未対応操作は実行せず、clear の排他とフェーズ制約も保つ',async()=>{
 const {Store}=await import('./store/index');const {createHandler}=await import('./server');
 const root=await mkdtemp(join(tmpdir(),'beni-provider-command-')),store=new Store(':memory:'),project=store.createProject('Example',root) as {id:string},task=store.createTask(project.id,'Example task') as {id:string},chat=new ChatService(()=>root,()=>fake),handler=createHandler(store,'/tmp',chat);
 const post=(data:unknown)=>handler(new Request('http://127.0.0.1:3210/api/chat/commands',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 const base={projectId:project.id,taskId:task.id,phase:'requirements'};
 try{
  await chat.send(project.id,task.id,'hello',null,root);await waitFor(async()=>(await chat.get(project.id,task.id)).messages.at(-1)?.status==='completed');const before=await chat.get(project.id,task.id);
  for(const command of ['compact','context','usage']){const result=await post({...base,command,provider:'claude'});expect(result.status).toBe(409);expect(await result.json()).toMatchObject({error:expect.stringContaining('接続先')})}
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

test('Claude context と usage は成功した操作出力だけを保存し、会話本文とパックを変更しない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-local-output-')),p='019a0000-0000-7000-8000-000000000001',chat=new ChatService(()=>root,()=>null,()=>fakeClaude);
 try{
  await chat.send(p,null,'hello','sonnet',root,undefined,null,false,'claude');await waitFor(async()=>(await chat.get(p,null)).messages.at(-1)?.status==='completed');const before=await chat.get(p,null);
  for(const [command,output] of [['context','Context usage: 12%\n'],['usage','Usage: 3 fictional requests\n']] as const){
   await chat.command(p,null,command,root,undefined,null,{provider:'claude',model:'sonnet'});await waitFor(async()=>(await chat.get(p,null)).command?.status==='completed');const current=await chat.get(p,null);expect(current.command?.output).toBe(output);expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(current.threadId).toBe(before.threadId);
  }
  for(const [action,status] of [['failure','failed'],['unavailable','failed'],['fallback','failed'],['oversize','failed'],['disconnect','unknown'],['foreign-session','unknown']] as const){process.env.FAKE_CLAUDE_COMMAND=action;await chat.command(p,null,'context',root);await waitFor(async()=>(await chat.get(p,null)).command?.status===status);const current=await chat.get(p,null);expect(current.command?.output).toBeUndefined();expect(current.command?.error).toBeString();expect(current.messages).toEqual(before.messages);expect(current.packs).toEqual(before.packs);expect(JSON.stringify(current)).not.toContain('Private')}
  process.env.FAKE_CLAUDE_COMMAND='limit';await chat.command(p,null,'context',root);await waitFor(async()=>(await chat.get(p,null)).command?.status==='completed');expect(Buffer.byteLength((await chat.get(p,null)).command!.output!)).toBe(65536);
  process.env.FAKE_CLAUDE_COMMAND='wait';await chat.command(p,null,'usage',root);await Bun.sleep(50);await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');expect((await chat.get(p,null)).command?.output).toBeUndefined();
  await chat.command(p,null,'context',root);await Bun.sleep(50);const restarted=new ChatService(()=>root,()=>null,()=>fakeClaude);expect((await restarted.get(p,null)).command?.status).toBe('unknown');await chat.interrupt(p,null);await waitFor(async()=>(await chat.get(p,null)).command?.status==='interrupted');
  await expect(chat.command(p,null,'context',root,undefined,null,{args:'extra'})).rejects.toThrow('invalid command');
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
  for(const provider of ['codex','claude'] as const)for(const content of ['/review','/recap'])await expect(chat.send('instructions',null,content,null,root,undefined,null,false,provider,'common')).rejects.toThrow('chat command');
  await chat.command('instructions',null,'clear',root);const after=await chat.get('instructions',null);expect(after.id).not.toBe(before.id);expect(after.appliedEditorContent).toBe(original);expect(after.lastInstructionFocus).toBeUndefined();expect(after.instructionToolsVersion).toBeUndefined();expect(after.lastEventId).toBe(0);expect(await chat.instructionEditorState()).toEqual({pending:true,busy:false});expect(JSON.parse(await readFile(join(root,'chat/history',`${before.id}.json`),'utf8'))).toEqual(before);
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});
