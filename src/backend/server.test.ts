import { test, expect } from 'bun:test';
// Bun supports headers in its client constructor; DOM types expose only protocols.
const Socket = globalThis.WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
import { generateId, validProjectId, validTaskId } from '../shared/ids';
import { Store } from './store/index';
import { ChatService } from './chat';
import { createHandler, createServerOptions, dataPaths } from './server';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

test('project, task, chat and initial document flow', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-project-'));
 const store = new Store(':memory:'); const handle = createHandler(store);
 const post = (path: string, data: unknown) => handle(new Request(`http://127.0.0.1:3210${path}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try {
  const p=await post('/api/projects',{name:'Example',folder});expect(p.status).toBe(201);const project=await p.json();
  const t=await post('/api/tasks',{projectId:project.id,name:'Sample'});expect(t.status).toBe(201);const task=await t.json();
  expect(validProjectId(project.id)).toBe(true);expect(validTaskId(task.id)).toBe(true);
  expect((await post(`/api/tasks/${task.id}/messages`,{content:'  原文\n'})).status).toBe(404);
  const detail=await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();
  expect(detail.messages).toBeUndefined();expect(detail.documents[0].content).toBe('# Sample\n');
  const metadataPath=join(folder,'.beni','tasks',task.id,'task.json');const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
  expect(task.createdAt).toBe(metadata.createdAt);expect(detail.task.createdAt).toBe(metadata.createdAt);
  expect(task.updatedAt).toBe(metadata.updatedAt);expect(detail.task.updatedAt).toBe(metadata.updatedAt);
  metadata.createdAt=null;metadata.updatedAt=null;await writeFile(metadataPath,JSON.stringify(metadata));
  const state=await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json();expect(state.tasks[0].createdAt).toBeNull();expect(state.tasks[0].updatedAt).toBeNull();
  expect((await handle(new Request('http://127.0.0.1:3210/api/tasks',{method:'POST',headers:{origin:'https://example.com','content-type':'application/json'},body:'{}'}))).status).toBe(403);
  expect((await handle(new Request('http://example.com/api/state'))).status).toBe(403);
  expect((await post('/api/projects',{name:'x'.repeat(70000),folder:'/tmp/example'})).status).toBe(413);
 } finally {store.close();await rm(folder,{recursive:true,force:true})}
});

test('serves the compiled Solid app and locally generated stylesheet', async () => {
 const store = new Store(':memory:');
 try {
  const handle = createHandler(store);
  const page = await handle(new Request('http://127.0.0.1:3210/'));
  expect(page.headers.get('Content-Security-Policy')).toBe("default-src 'self'; img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  expect(await page.text()).toContain('/ui/build/app.js');
  const js = await handle(new Request('http://127.0.0.1:3210/ui/build/app.js'));
  expect(js.status).toBe(200);
  expect((await js.text()).length).toBeGreaterThan(1000);
  const css = await handle(new Request('http://127.0.0.1:3210/ui/generated.css'));
  expect(css.status).toBe(200);
  const stylesheet = await css.text();
  expect(stylesheet).toContain('.btn-primary');
  expect(stylesheet).toContain('.chat-bubble');
  expect(stylesheet).toContain('data:image/svg+xml');
  expect(stylesheet).toContain('.aura');
 } finally { store.close(); }
});

test('serves SPA entry for supported direct URLs without intercepting API or other paths', async () => {
 const store = new Store(':memory:');
 try {
  const handle = createHandler(store);
  for (const path of ['/settings', `/project/${generateId('project')}`, `/project/${generateId('project')}?task=${generateId('task')}`]) {
   const response = await handle(new Request(`http://127.0.0.1:3210${path}`));
   expect(response.status).toBe(200);
   expect(await response.text()).toContain('/ui/build/app.js');
  }
  for (const path of ['/project', '/project/0', '/project/1', `/project/${generateId('task')}`, '/settings/extra', '/api/missing']) {
   expect((await handle(new Request(`http://127.0.0.1:3210${path}`))).status).toBe(404);
  }
 } finally { store.close(); }
});

test('folder picker lists direct real folders, resolves paths safely and rejects cross-origin or invalid input', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-picker-test-'));
 const store = new Store(':memory:');
 try {
  const canonicalRoot = await realpath(root);
  await mkdir(join(root, 'beta'));
  await mkdir(join(root, 'alpha'));
  await mkdir(join(root, 'alpha', 'nested'));
  await writeFile(join(root, 'private.txt'), 'contents should not be returned');
  await symlink(join(root, 'alpha'), join(root, 'link'));
  const handle = createHandler(store, root);
  const post = (data: unknown, origin = 'http://127.0.0.1:3210') => handle(new Request('http://127.0.0.1:3210/api/folders/list', {
   method:'POST', headers:{origin,'content-type':'application/json'}, body:JSON.stringify(data),
  }));
  const initial = await post({});
  expect(initial.status).toBe(200);
  const result = await initial.json();
  expect(result.path).toBe(canonicalRoot);
  expect(result.directories).toEqual([
   {name:'alpha',path:join(canonicalRoot,'alpha')},
   {name:'beta',path:join(canonicalRoot,'beta')},
  ]);
  expect(result.truncated).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private.txt');
  expect(JSON.stringify(result)).not.toContain('nested');
  const linked = await (await post({path:join(root, 'link')})).json();
  expect(linked.path).toBe(join(canonicalRoot,'alpha'));
  expect(linked.directories).toEqual([{name:'nested',path:join(canonicalRoot,'alpha','nested')}]);
  expect(linked.parent).toBe(canonicalRoot);
  expect((await post({}, 'https://example.com')).status).toBe(403);
  for (const path of ['', 'relative', null, 0, join(root, 'private.txt'), join(root, 'not-present')]) {
   const response = await post({path});
   expect(response.status).toBe(400);
   expect(await response.text()).not.toContain(root);
  }
 } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});

test('folder picker bounds a directory listing', async () => {
 const root = await mkdtemp(join(tmpdir(), 'beni-picker-limit-test-'));
 const store = new Store(':memory:');
 try {
  await Promise.all(Array.from({length:501}, (_, index) => mkdir(join(root, `dir-${index}`))));
  const handle = createHandler(store, root);
  const response = await handle(new Request('http://127.0.0.1:3210/api/folders/list', {
   method:'POST', headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'}, body:'{}',
  }));
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.directories.length).toBe(500);
  expect(result.truncated).toBe(true);
 } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});


test('creates task Markdown and previews real file updates as the authoritative documents', async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-documents-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(path:string,data:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 const detail=async(id:string)=>(await handle(new Request(`http://127.0.0.1:3210/api/tasks/${id}`))).json();
 try{
  const project=await (await post('/api/projects',{name:'Example',folder})).json();
  const task=await (await post('/api/tasks',{name:'New task',projectId:project.id})).json();
  const base=join(folder,'.beni','tasks',String(task.id));
  expect(await readFile(join(base,'requirements.md'),'utf8')).toBe('# New task\n');
  expect(await readFile(join(base,'implementation-plan.md'),'utf8')).toContain('# Implementation plan');
  await writeFile(join(base,'requirements.md'),'# Actual file\n');
  expect((await detail(task.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Actual file\n');
  const second=store.createTask(project.id,'Second');
  expect((await detail(second.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Second\n');
  expect((await detail(task.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Actual file\n');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('refuses symlink-managed paths without writing outside and without registering failed projects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-document-links-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(data:unknown)=>handle(new Request('http://127.0.0.1:3210/api/projects',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try{
  const outside=join(root,'outside');await mkdir(outside);const project=join(root,'project');await mkdir(project);await symlink(outside,join(project,'.beni'));
  expect((await post({name:'Blocked',folder:project})).status).toBe(400);expect(store.projects()).toHaveLength(0);
  const {projectDocuments,taskDocuments,readTaskDocuments}=await import('./documents');
  const folder=join(root,'safe');await mkdir(folder);const tasks=projectDocuments(folder);
  const first=generateId('task'),second=generateId('task');
  await symlink(outside,join(tasks,first));expect(()=>taskDocuments(folder,first,{requirements:'no'})).toThrow();
  await mkdir(join(tasks,second));await writeFile(join(outside,'requirements.md'),'untouched');await symlink(join(outside,'requirements.md'),join(tasks,second,'requirements.md'));
  expect(()=>taskDocuments(folder,second,{requirements:'no'})).toThrow();
  expect(()=>readTaskDocuments(join(tasks,second))).toThrow();
  expect(await readFile(join(outside,'requirements.md'),'utf8')).toBe('untouched');
  const another=join(root,'another');await mkdir(another);await mkdir(join(another,'.beni'));await symlink(outside,join(another,'.beni','tasks'));
  expect(()=>projectDocuments(another)).toThrow();
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('recovers orphan document folders and creates new tasks without overwriting their content',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-document-collision-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(path:string,data:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try{
  const project=await (await post('/api/projects',{name:'Example',folder})).json();
  const existing=join(folder,'.beni','tasks','1');await mkdir(existing);await writeFile(join(existing,'requirements.md'),'preserve');
  const recovered=await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json();
  expect(recovered.tasks).toHaveLength(1);expect(recovered.tasks[0].name).toBe('Unknown');
  expect(await readFile(join(folder,'.beni','tasks',recovered.tasks[0].id,'requirements.md'),'utf8')).toBe('preserve');
  expect((await post('/api/tasks',{name:'New',projectId:project.id})).status).toBe(201);
  expect(store.tasks()).toHaveLength(2);
  expect(await readFile(join(folder,'.beni','tasks',recovered.tasks[0].id,'requirements.md'),'utf8')).toBe('preserve');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});


function socketMessages(ws:WebSocket){const messages:any[]=[];ws.addEventListener('message',event=>messages.push(JSON.parse(String(event.data))));return {messages,async next(){for(let i=0;i<150;i++){if(messages.length)return messages.shift();await Bun.sleep(10)}throw Error('Missing WebSocket message')}}}
async function opened(ws:WebSocket){if(ws.readyState===1)return;await new Promise<void>((resolve,reject)=>{ws.addEventListener('open',()=>resolve(),{once:true});ws.addEventListener('error',()=>reject(Error('WebSocket failed')),{once:true})})}
test('shared WebSocket validates handshake/scopes, streams document changes and releases subscriptions',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-ws-'));const store=new Store(':memory:');const otherFolder=join(folder,'other');await mkdir(otherFolder);const project=store.createProject('Example',folder);const other=store.createProject('Other',otherFolder);const task=store.createTask(project.id,'Task');
 const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store)});const origin=`http://127.0.0.1:${server.port}`;const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});const inbox=socketMessages(ws);
 try{
  expect((await fetch(origin+'/api/ws')).status).toBe(403);
  await opened(ws);ws.send(JSON.stringify({type:'subscribe',subscriptionId:'before',topic:'chat',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({type:'error',code:'NOT_READY'});
  ws.send('{');expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});
  ws.send(JSON.stringify({type:'hello',version:1}));expect(await inbox.next()).toEqual({type:'ready',version:1});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'swapped-id',topic:'chat',scope:{projectId:task.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'bad',topic:'documents',scope:{projectId:other.id,taskId:task.id}}));expect(await inbox.next()).toMatchObject({code:'NOT_FOUND',subscriptionId:'bad'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toEqual({type:'subscribed',subscriptionId:'doc'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc-two',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toEqual({type:'subscribed',subscriptionId:'doc-two'});
  const path=join(folder,'.beni','tasks',String(task.id));await writeFile(join(path,'replacement.tmp'),'# Atomic replacement');await rename(join(path,'replacement.tmp'),join(path,'requirements.md'));
  const updates=[await inbox.next(),await inbox.next()];expect(updates.map(message=>message.subscriptionId).sort()).toEqual(['doc','doc-two']);expect(updates.every(message=>message.name==='documents.changed')).toBe(true);
  const timestamp=store.task(task.id)!.updatedAt;expect(timestamp).not.toBe(task.updatedAt);
  await writeFile(join(path,'ignored.tmp'),'ignored');await Bun.sleep(200);expect(inbox.messages).toHaveLength(0);expect(store.task(task.id)!.updatedAt).toBe(timestamp);
  ws.send(JSON.stringify({type:'unsubscribe',subscriptionId:'doc-two'}));expect(await inbox.next()).toEqual({type:'unsubscribed',subscriptionId:'doc-two'});
  ws.send(JSON.stringify({type:'unsubscribe',subscriptionId:'doc'}));expect(await inbox.next()).toEqual({type:'unsubscribed',subscriptionId:'doc'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toMatchObject({code:'SUBSCRIPTION_CONFLICT'});
  await writeFile(join(path,'requirements.md'),'# Disconnected');await Bun.sleep(120);expect(inbox.messages).toHaveLength(0);
  const detail=await (await fetch(origin+`/api/tasks/${task.id}`)).json();expect(detail.documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Disconnected');
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'unknown',topic:'unknown-topic',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'UNKNOWN_TOPIC'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'general-documents',topic:'documents',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'NOT_FOUND',subscriptionId:'general-documents'});
 }finally{ws.close();server.stop(true);store.close();await rm(folder,{recursive:true,force:true})}
});
test('unsupported WebSocket protocol reports error and closes',async()=>{
 const store=new Store(':memory:');const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store)});const origin=`http://127.0.0.1:${server.port}`;const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});const inbox=socketMessages(ws);
 try{await opened(ws);const closed=new Promise<number>(resolve=>ws.addEventListener('close',event=>resolve(event.code),{once:true}));ws.send(JSON.stringify({type:'hello',version:2}));expect(await inbox.next()).toMatchObject({code:'UNSUPPORTED_VERSION'});expect(await closed).toBe(1002)}finally{ws.close();server.stop(true);store.close()}
});

test('uses app-root data storage independently of the working directory',()=>{
 const dataDirectory=fileURLToPath(new URL('../../data',import.meta.url));
 const expected={dataDirectory,database:join(dataDirectory,'beni.sqlite'),chatDirectory:join(dataDirectory,'chat')};
 expect(dataPaths({},'/tmp/one')).toEqual(expected);
 expect(dataPaths({},'/tmp/two')).toEqual(expected);
 expect(dataPaths({BENI_DATA_DIR:''},'/tmp/one')).toEqual(expected);
});

test('resolves configured data directories with a shared data root',()=>{
 expect(dataPaths({BENI_DATA_DIR:'/tmp/another-data'},'/tmp/one')).toEqual({dataDirectory:'/tmp/another-data',database:'/tmp/another-data/beni.sqlite',chatDirectory:'/tmp/another-data/chat'});
 expect(dataPaths({BENI_DATA_DIR:'local-data'},'/tmp/one')).toEqual({dataDirectory:'/tmp/one/local-data',database:'/tmp/one/local-data/beni.sqlite',chatDirectory:'/tmp/one/local-data/chat'});
 expect(dataPaths({BENI_DATA_DIR:'/tmp/beni-data'},'/tmp/one')).toEqual({dataDirectory:'/tmp/beni-data',database:'/tmp/beni-data/beni.sqlite',chatDirectory:'/tmp/beni-data/chat'});
});

test('server initializes an empty data directory before opening the database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-data-start-'));
 const dataDirectory=join(root,'nested','data');
 const env:Record<string,string|undefined>={...process.env,BENI_DATA_DIR:dataDirectory,BENI_PORT:'0'};
 const child=Bun.spawn([process.execPath,fileURLToPath(new URL('./server.ts',import.meta.url))],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
 const reader=child.stdout.getReader();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const output=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Server did not start')),5000)})]);
  const address=new TextDecoder().decode(output.value).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  expect(address).toBeDefined();
  expect((await stat(join(dataDirectory,'beni.sqlite'))).isFile()).toBe(true);
  expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
  const response=await fetch(`${address}/api/state`);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({projects:[],tasks:[]});
 }finally{clearTimeout(timer);child.kill();await child.exited;reader.releaseLock();await rm(root,{recursive:true,force:true})}
});


test('explicit HTTPS public origin permits proxy HTTP and WebSocket requests with matching host and origin',async()=>{
 const store=new Store(':memory:');
 const publicOrigin='https://example-node.example-tailnet.ts.net';
 const proxyOrigin='http://example-node.example-tailnet.ts.net';
 const options=createServerOptions(store,undefined,undefined,publicOrigin);
 let upgraded=0;
 const server={upgrade(){upgraded++;return true}} as unknown as Parameters<typeof options.fetch>[1];
 const request=(origin:string,path:string,method='GET',headers:Record<string,string>={})=>new Request(origin+path,{method,headers:{...headers,...(method==='POST'?{'content-type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
 try{
  expect((await options.fetch(request(proxyOrigin,'/api/state'),server))?.status).toBe(200);
  // This operation needs no external API or filesystem access.
  expect((await options.fetch(request(proxyOrigin,'/api/tasks','POST',{origin:publicOrigin}),server))?.status).toBe(400);
  expect(await options.fetch(request(proxyOrigin,'/api/ws','GET',{origin:publicOrigin}),server)).toBeUndefined();
  expect(upgraded).toBe(1);
  for(const origin of ['https://other.example.com',proxyOrigin,'https://example-node.example-tailnet.ts.net:8443']){
   expect((await options.fetch(request(proxyOrigin,'/api/tasks','POST',{origin}),server))?.status).toBe(403);
   expect((await options.fetch(request(proxyOrigin,'/api/ws','GET',{origin}),server))?.status).toBe(403);
  }
  for(const host of ['http://other.example.com','http://example-node.example-tailnet.ts.net.evil.example','http://example-node.example-tailnet.ts.net:8443']){
   expect((await options.fetch(request(host,'/api/state'),server))?.status).toBe(403);
   expect((await options.fetch(request(host,'/api/tasks','POST',{origin:publicOrigin}),server))?.status).toBe(403);
   expect((await options.fetch(request(host,'/api/ws','GET',{origin:publicOrigin}),server))?.status).toBe(403);
  }
  expect((await options.fetch(request('http://127.0.0.1:3210','/api/tasks','POST',{origin:publicOrigin}),server))?.status).toBe(403);
  expect((await options.fetch(request('http://other.example.com','/api/state','GET',{'x-forwarded-host':'example-node.example-tailnet.ts.net','x-forwarded-proto':'https'}),server))?.status).toBe(403);
  expect((await createHandler(store)(request(proxyOrigin,'/api/state'))).status).toBe(403);
  expect(upgraded).toBe(1);
 }finally{store.close()}
});

test('public origin configuration requires an exact HTTPS origin',()=>{
 const store=new Store(':memory:');
 try{
  for(const origin of ['', 'http://example.com','https://example.com/','https://example.com/path','https://user:password@example.com','https://example.com?query=1']){
   expect(()=>createHandler(store,undefined,undefined,origin)).toThrow();
   expect(()=>createServerOptions(store,undefined,undefined,origin)).toThrow();
  }
 }finally{store.close()}
});


test('HTTP scopes accept kind-correct IDs and reject numeric or swapped identifiers',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-http-ids-'));const store=new Store(':memory:');
 try{
  const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
  const handle=createHandler(store,folder,new ChatService(()=>folder,()=>null));
  const get=(path:string)=>handle(new Request('http://127.0.0.1:3210'+path));
  const post=(path:string,input:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(input)}));
  for(const suffix of [`projectId=${project.id}`,`projectId=${project.id}&taskId=${task.id}`]){
   const result=await get('/api/chat?'+suffix);expect(result.status).toBe(200);
   expect((await result.json()).projectId).toBe(project.id);
  }
  for(const suffix of ['projectId=1',`projectId=${task.id}`,`projectId=${project.id}&taskId=1`,`projectId=${project.id}&taskId=${project.id}`])expect((await get('/api/chat?'+suffix)).status).toBe(404);
  expect((await get('/api/tasks/'+project.id)).status).toBe(404);
  expect((await get('/api/tasks/1')).status).toBe(404);
  expect((await post('/api/tasks',{projectId:task.id,name:'Wrong kind'})).status).toBe(400);
  expect((await post('/api/chat/send',{projectId:project.id,taskId:project.id,content:'test',model:null})).status).toBe(404);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('HTTP task chat records activity while GET recovery and general chat preserve task dates', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-activity-'));const store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>join(import.meta.dir,'test/fake-codex.ts'));
 const handle=createHandler(store,'/tmp',chat);
 const post=(taskId:string|null,content:string)=>handle(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,taskId,content,model:null})}));
 try{
  const path=join(folder,'.beni','tasks',task.id,'task.json');const value=JSON.parse(await readFile(path,'utf8'));value.createdAt=null;value.updatedAt=null;await writeFile(path,JSON.stringify(value));
  expect((await post(null,'hello')).status).toBe(202);
  for(let i=0;i<100&&(await chat.get(project.id,null)).messages[1]?.status!=='completed';i++)await Bun.sleep(20);
  expect(store.task(task.id)!.updatedAt).toBeNull();
  expect((await post(task.id,'hello')).status).toBe(202);
  for(let i=0;i<100&&(await chat.get(project.id,task.id)).messages[1]?.status!=='completed';i++)await Bun.sleep(20);
  const completed=store.task(task.id)!;expect(completed.createdAt).toBeNull();expect(completed.updatedAt).not.toBeNull();
  await handle(new Request(`http://127.0.0.1:3210/api/chat?projectId=${project.id}&taskId=${task.id}`));
  await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`));
  expect(store.task(task.id)!.updatedAt).toBe(completed.updatedAt);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});
