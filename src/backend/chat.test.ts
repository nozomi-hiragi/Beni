import { mkdirSync } from 'node:fs';
import {test,expect} from 'bun:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
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
  expect((await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${other.id}&taskId=${task.id}`))).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:other.id,taskId:task.id,content:'hello',model:null})).status).toBe(404);
  expect((await post('/api/chat/send',{projectId:p.id,taskId:task.id,content:'hello',model:null})).status).toBe(202);
  await waitFor(async()=>{const res=await handler(new Request(`http://127.0.0.1:3210/api/chat?projectId=${p.id}&taskId=${task.id}`));return (await res.json()).messages[1].status==='completed'});
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
  expect(await readFile(join(documentDirectory,'implementation-plan.md'),'utf8')).toBe('# Updated plan\n');
  expect(await readFile(join(other,'requirements.md'),'utf8')).toBe('# Other task\n');
  const restarted=new ChatService(p=>projectFolder(root,p),()=>fake);
  await restarted.send('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001','hello','model-a',root,documentDirectory);await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001','019a0000-0000-7100-8000-000000000001')).messages[3].status==='completed');
  await restarted.send('019a0000-0000-7000-8000-000000000001',null,'hello','model-a',root);await waitFor(async()=>(await restarted.get('019a0000-0000-7000-8000-000000000001',null)).messages[1].status==='completed');
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
test('legacy saved histories gain stable persisted packs without losing text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-pack-legacy-'));try{
  const {writeFile,mkdir}=await import('node:fs/promises');await mkdir(join(projectFolder(root,'019a0000-0000-7000-8000-000000000001'),'.beni','chat'),{recursive:true});const message={id:'legacy-message',sendId:'legacy-send',role:'assistant' as const,content:'Previous history',provider:'codex' as const,model:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',status:'completed' as const,threadId:null,sessionId:null};await writeFile(join(root,'019a0000-0000-7000-8000-000000000001','.beni','chat','general.json'),JSON.stringify({version:1,id:'conversation',projectId:'019a0000-0000-7000-8000-000000000001',taskId:null,threadId:null,sessionId:null,messages:[message]}));
  const chat=new ChatService(p=>projectFolder(root,p),()=>fake);const c=await chat.get('019a0000-0000-7000-8000-000000000001',null);expect(c.messages).toEqual([message]);expect(c.packs[0]).toMatchObject({packId:'legacy-message:legacy',content:'Previous history',state:'closed'});expect(JSON.parse(await readFile(join(root,'019a0000-0000-7000-8000-000000000001','.beni','chat','general.json'),'utf8')).packs).toEqual(c.packs);expect((await new ChatService(p=>projectFolder(root,p),()=>fake).get('019a0000-0000-7000-8000-000000000001',null)).packs).toEqual(c.packs);
  const {Store}=await import('./store/index');const {createHandler}=await import('./server');const {packHash}=await import('../shared/communication');const store=new Store(':memory:');const {writeJson,newMetadata}=await import('./data');writeJson(join(projectFolder(root,'019a0000-0000-7000-8000-000000000001'),'.beni','project.json'),{...newMetadata('project','Example'),id:'019a0000-0000-7000-8000-000000000001'});store.createProject('Example',projectFolder(root,'019a0000-0000-7000-8000-000000000001'));const handle=createHandler(store,'/tmp',chat);const id=encodeURIComponent(c.packs[0].packId);try{const response=await handle(new Request(`http://127.0.0.1:3210/api/chat/packs/${id}?projectId=019a0000-0000-7000-8000-000000000001`));expect(response.status).toBe(200);expect((await response.json()).pack).toEqual(c.packs[0]);const ack=await handle(new Request(`http://127.0.0.1:3210/api/chat/packs/${id}/ack`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:'019a0000-0000-7000-8000-000000000001',taskId:null,hash:await packHash(c.packs[0])})}));expect(await ack.json()).toEqual({matched:true});expect((await handle(new Request('http://127.0.0.1:3210/api/chat/packs/%XX?projectId=019a0000-0000-7000-8000-000000000001'))).status).toBe(400)}finally{store.close()}

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
  expect(JSON.parse(await readFile(join(folder,'.beni','chat',`${t}.json`),'utf8'))).toEqual(saved);
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
