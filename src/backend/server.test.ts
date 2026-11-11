import { test, expect } from 'bun:test';
// Bun supports headers in its client constructor; DOM types expose only protocols.
const Socket = globalThis.WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
import { generateId, validProjectId, validTaskId, validChatId } from '../shared/ids';
import { INSTRUCTIONS_CHAT_ID } from '../shared/communication';
import { Store } from './store/index';
import { ChatService, type TaskEventsProvider } from './chat';
import { createHandler, createServerOptions, dataPaths } from './server';
import { withDatabase } from './project-events';
import { DummyAgent } from './test/dummy-agent';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const loopbackOrigin = 'http://127.0.0.1:3210';
function jsonPost(path:string, data:unknown, origin=loopbackOrigin) {
 return new Request(loopbackOrigin+path,{
  method:'POST',
  headers:{origin,'content-type':'application/json'},
  body:JSON.stringify(data),
 });
}

const fakeCodex=join(import.meta.dir,'test/fake-codex.ts');
const fixtureRequest='入力の形式を検証してください。';
const waitUntil=async(check:()=>boolean|Promise<boolean>)=>{
 for(let i=0;i<150;i++){if(await check())return;await Bun.sleep(20)}
 throw Error('条件を満たすまでに時間切れになりました');
};
const waitForFailedReview=(databasePath:string,t:string)=>waitUntil(()=>withDatabase(databasePath,db=>{
 if(!db.query("SELECT 1 FROM sqlite_schema WHERE name='document_review'").get())return false;
 const review=db.query('SELECT state FROM document_review WHERE task_id=?').get(t) as {state:string}|null;
 return review?.state==='failed';
}));
function writeTaskDocument(store:Store,p:string,t:string,name:string,text:string){
 const current=store.managedDocument(p,t,name)!;
 const sourceVersion=current.items.some(item=>item.text.trim())?current:
  store.managedDocumentHistory(p,t).find(doc=>doc.name===name&&doc.items.some(item=>item.text.trim()))!;
 const source=sourceVersion.items.find(item=>item.text.trim())!;
 return store.writeManagedDocument(p,t,name,current.revision,[{
  text,reason:'テストで確認する本文を設定する',
  sources:[{kind:'document',id:name+'/'+source.id,revision:sourceVersion.revision,text:source.text}]
 }],generateId('task'));
}
test('project, task, chat and initial document flow', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-project-'));
 const store = new Store(':memory:'); const handle = createHandler(store);
 const post = (path: string, data: unknown) => handle(jsonPost(path,data));
 try {
  const p=await post('/api/projects',{name:'Example',folder});expect(p.status).toBe(201);const project=await p.json();
  const t=await post('/api/tasks',{projectId:project.id,name:'Sample'});expect(t.status).toBe(201);const task=await t.json();
  expect(validProjectId(project.id)).toBe(true);expect(validTaskId(task.id)).toBe(true);
  expect((await post(`/api/tasks/${task.id}/messages`,{content:'  原文\n'})).status).toBe(404);
  await expect(stat(join(store.legacyProjectDirectory(project.id),'tasks',task.id))).rejects.toThrow();
  const detail=await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();
  expect(detail.messages).toBeUndefined();expect(detail.documents[0].content).toBe('# Sample\n');
  expect(detail.task.createdAt).toBe(task.createdAt);expect(detail.task.updatedAt).toBe(task.updatedAt);
  withDatabase(store.projectDatabasePath(project.id),db=>db.query('UPDATE tasks SET created_at=NULL,updated_at=NULL WHERE id=?').run(task.id));
  const state=await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json();expect(state.tasks[0].createdAt).toBeNull();expect(state.tasks[0].updatedAt).toBeNull();
  expect((await handle(jsonPost('/api/tasks',{},'https://example.com'))).status).toBe(403);
  expect((await handle(new Request('http://example.com/api/state'))).status).toBe(403);
  expect((await post('/api/projects',{name:'x'.repeat(70000),folder:'/tmp/example'})).status).toBe(413);
 } finally {store.close();await rm(folder,{recursive:true,force:true})}
});

test('文書の根拠は本文と同じ版の位置を返し、所有タスクとインストラクションの範囲に限定する', async () => {
 const folder = await mkdtemp(join(tmpdir(),'beni-provenance-'));
 const store = new Store(':memory:');
 try {
  const project = store.createProject('Example',folder);
  const task = store.createTask(project.id,'Task');
  const other = store.createTask(project.id,'Other');
  const chat = new ChatService(()=>folder,()=>null);
  const handle = createHandler(store,folder,chat);
  const get = (path:string) => handle(new Request('http://127.0.0.1:3210'+path));
  const lookup = (params:Record<string,string>) => get('/api/document-provenance?'+new URLSearchParams(params));
  const name = 'requirements.md';
  const original = store.managedDocument(project.id,task.id,name)!;
  const source = original.items[0]!;
  expect(source).toMatchObject({
   reason:'登録されたタスク名を最初の見出しに使った。',
   sources:[{kind:'template',id:name,text:'Task'}]
  });
  const prefix = '# 📝 要件\n\n';
  const body = '入力値を検証する。';
  const reason = '入力要件を明文化する。';
  const documentSource = {kind:'document' as const,id:name+'/'+source.id,revision:original.revision,text:source.text};
  const knowledge = store.writeManagedDocument(project.id,null,'knowledge.md',
   store.managedDocument(project.id,null,'knowledge.md')?.revision ?? null,
   [{text:'過去の知見',reason:'知見をまとめる。',sources:[documentSource]}],'knowledge-fixture');
  const sources = [
   documentSource,
   {kind:'document' as const,id:'knowledge.md/'+knowledge.items[0]!.id,revision:knowledge.revision,text:'過去の知見'}
  ];
  const version = store.writeManagedDocument(project.id,task.id,name,original.revision,[
   {text:prefix,reason:'要件の見出しを付ける。',sources},{text:body,reason,sources}
  ],'fixture');
  const itemId = version.items[1]!.id;
  const detail = await (await get('/api/tasks/'+task.id)).json();
  expect(detail.documents.find((doc:{name:string})=>doc.name===name)).toEqual({
   name,path:name,content:prefix+body,version:version.updatedAt,
   provenance:{revision:version.revision,items:[
    {id:version.items[0]!.id,start:0,end:prefix.length},{id:itemId,start:prefix.length,end:prefix.length+body.length}
   ]}
  });
  const params = {name,revision:version.revision,itemId,projectId:project.id,taskId:task.id};
  writeTaskDocument(store,project.id,task.id,name,'更新した本文。');
  const namedSources = [{...sources[0],projectName:'Example',taskName:'Task'}, {...sources[1],projectName:'Example'}];
  expect(await (await lookup(params)).json()).toEqual({reason,sources:namedSources});
  expect((await lookup({...params,taskId:other.id})).status).toBe(404);
  expect((await lookup({...params,projectId:generateId('project')})).status).toBe(404);
  expect((await lookup({...params,revision:original.revision})).status).toBe(404);
  expect(await (await lookup({...params,itemId:version.items[0]!.id})).json()).toEqual({reason:'要件の見出しを付ける。',sources:namedSources});
  expect((await lookup({...params,name:'../requirements.md'})).status).toBe(400);
  expect((await lookup({...params,itemId:'invalid'})).status).toBe(400);
  expect((await lookup({name,revision:version.revision,itemId,projectId:project.id})).status).toBe(400);
  expect((await lookup({name,revision:version.revision,itemId,taskId:task.id})).status).toBe(400);

  const before = store.instructionDocument('editor')!;
  store.updateInstruction('editor','エディタの指示を確認する。',before.content);
  const instruction = store.instructionDocument('editor')!;
  const entry = instruction.items[0]!;
  const instructions = await (await get('/api/instructions')).json();
  expect(instructions.instructions).toEqual(store.instructions());
  expect(instructions.editorState).toEqual(await chat.instructionEditorState());
  expect(instructions.provenance.editor).toEqual({
   revision:instruction.revision,items:[{id:entry.id,start:0,end:entry.text.length}]
  });
  const instructionParams = {name:'editor',revision:instruction.revision,itemId:entry.id};
  expect(await (await lookup(instructionParams)).json()).toEqual({reason:entry.reason,sources:entry.sources});
  expect((await lookup({...instructionParams,name:'common'})).status).toBe(404);
  expect((await lookup({...instructionParams,projectId:project.id,taskId:task.id})).status).toBe(400);
 } finally {
  store.close();
  await rm(folder,{recursive:true,force:true});
 }
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
  for (const path of ['/settings', '/instructions', '/data', `/project/${generateId('project')}`, `/project/${generateId('project')}?task=${generateId('task')}`]) {
   const response = await handle(new Request(`http://127.0.0.1:3210${path}`));
   expect(response.status).toBe(200);
   expect(await response.text()).toContain('/ui/build/app.js');
  }
  for (const path of ['/project', '/project/0', '/project/1', `/project/${generateId('task')}`, '/settings/extra', '/instructions/extra', '/api/missing']) {
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
  const post = (data: unknown, origin?: string) => handle(jsonPost('/api/folders/list',data,origin));
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
  const response = await handle(jsonPost('/api/folders/list',{}));
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.directories.length).toBe(500);
  expect(result.truncated).toBe(true);
 } finally { store.close(); await rm(root,{recursive:true,force:true}); }
});


test('新規タスク文書はDBを正本とし、後から置いたMarkdownを取り込まない', async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-documents-'));const store=new Store(':memory:');
 const handle=createHandler(store,folder,new ChatService(()=>folder,()=>null));
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'New task');
 const detail=async(id:string)=>(await handle(new Request(`http://127.0.0.1:3210/api/tasks/${id}`))).json();
 try{
  const base=join(store.legacyProjectDirectory(project.id),'tasks',task.id);
  const documents=(await detail(task.id)).documents;
  expect(documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# New task\n');
  expect(documents.find((doc:any)=>doc.name==='implementation.md').content).toContain('# Implementation plan');
  for(const name of ['requirements.md','documents.md','implementation.md'])expect(await Bun.file(join(base,name)).exists()).toBe(false);
  await mkdir(base,{recursive:true});
  await writeFile(join(base,'requirements.md'),'# 外部で置いたファイル\n');
  writeTaskDocument(store,project.id,task.id,'requirements.md','# DBの正本\n');
  const second=store.createTask(project.id,'Second');
  expect((await detail(second.id)).documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# Second\n');
  expect((await detail(task.id)).documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# DBの正本\n');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('refuses symlink-managed paths without writing outside and without registering failed projects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-document-links-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(data:unknown)=>handle(jsonPost('/api/projects',data));
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
 const post=(path:string,data:unknown)=>handle(jsonPost(path,data));
 try{
  const project=await (await post('/api/projects',{name:'Example',folder})).json();
  const existing=join(store.legacyProjectDirectory(project.id),'tasks','1');await mkdir(existing,{recursive:true});await writeFile(join(existing,'requirements.md'),'preserve');
  store.initializeStorage();
  const recovered=await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json();
  expect(recovered.tasks).toHaveLength(1);expect(recovered.tasks[0].name).toBe('Unknown');
  expect(await readFile(join(store.legacyProjectDirectory(project.id),'tasks',recovered.tasks[0].id,'requirements.md'),'utf8')).toBe('preserve');
  expect((await post('/api/tasks',{name:'New',projectId:project.id})).status).toBe(201);
  expect(store.tasks()).toHaveLength(2);
  expect(await readFile(join(store.legacyProjectDirectory(project.id),'tasks',recovered.tasks[0].id,'requirements.md'),'utf8')).toBe('preserve');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});


function socketMessages(ws:WebSocket){const messages:any[]=[];ws.addEventListener('message',event=>messages.push(JSON.parse(String(event.data))));return {messages,async next(){for(let i=0;i<150;i++){if(messages.length)return messages.shift();await Bun.sleep(10)}throw Error('Missing WebSocket message')}}}
async function opened(ws:WebSocket){if(ws.readyState===1)return;await new Promise<void>((resolve,reject)=>{ws.addEventListener('open',()=>resolve(),{once:true});ws.addEventListener('error',()=>reject(Error('WebSocket failed')),{once:true})})}
test('shared WebSocket validates handshake/scopes, streams document changes and releases subscriptions',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-ws-'));const store=new Store(':memory:');const otherFolder=join(folder,'other');await mkdir(otherFolder);const project=store.createProject('Example',folder);const other=store.createProject('Other',otherFolder);const task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>fakeCodex);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,folder,chat)});const origin=`http://127.0.0.1:${server.port}`;const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});const inbox=socketMessages(ws);
 process.env.FAKE_CODEX_WORKFLOW='enabled';
 try{
  expect((await fetch(origin+'/api/ws')).status).toBe(403);
  await opened(ws);ws.send(JSON.stringify({type:'subscribe',subscriptionId:'before',topic:'chat',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({type:'error',code:'NOT_READY'});
  ws.send('{');expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});
  ws.send(JSON.stringify({type:'hello',version:1}));expect(await inbox.next()).toEqual({type:'ready',version:1});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'swapped-id',topic:'chat',scope:{projectId:task.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'bad',topic:'documents',scope:{projectId:other.id,taskId:task.id}}));expect(await inbox.next()).toMatchObject({code:'NOT_FOUND',subscriptionId:'bad'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toEqual({type:'subscribed',subscriptionId:'doc'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc-two',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toEqual({type:'subscribed',subscriptionId:'doc-two'});
  const sent=await fetch(origin+'/api/chat/send',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({
   projectId:project.id,taskId:task.id,phase:'requirements',content:fixtureRequest,model:null
  })});
  expect(sent.status).toBe(202);
  const updates=[await inbox.next(),await inbox.next()];expect(updates.map(message=>message.subscriptionId).sort()).toEqual(['doc','doc-two']);expect(updates.every(message=>message.name==='documents.changed')).toBe(true);
  await waitUntil(async()=>(await chat.get(project.id,task.id,'requirements')).messages.at(-1)?.status==='completed');
  ws.send(JSON.stringify({type:'unsubscribe',subscriptionId:'doc-two'}));expect(await inbox.next()).toEqual({type:'unsubscribed',subscriptionId:'doc-two'});
  ws.send(JSON.stringify({type:'unsubscribe',subscriptionId:'doc'}));expect(await inbox.next()).toEqual({type:'unsubscribed',subscriptionId:'doc'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'doc',topic:'documents',scope:{projectId:project.id,taskId:task.id}}));expect(await inbox.next()).toMatchObject({code:'SUBSCRIPTION_CONFLICT'});
  writeTaskDocument(store,project.id,task.id,'requirements.md','# Disconnected');
  const detail=await (await fetch(origin+`/api/tasks/${task.id}`)).json();expect(detail.documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Disconnected');
  expect(inbox.messages).toHaveLength(0);
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'unknown',topic:'unknown-topic',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'UNKNOWN_TOPIC'});
  ws.send(JSON.stringify({type:'subscribe',subscriptionId:'general-documents',topic:'documents',scope:{projectId:project.id,taskId:null}}));expect(await inbox.next()).toMatchObject({code:'NOT_FOUND',subscriptionId:'general-documents'});
 }finally{delete process.env.FAKE_CODEX_WORKFLOW;ws.close();server.stop(true);store.close();await rm(folder,{recursive:true,force:true})}
});
test('unsupported WebSocket protocol reports error and closes',async()=>{
 const store=new Store(':memory:');const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store)});const origin=`http://127.0.0.1:${server.port}`;const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});const inbox=socketMessages(ws);
 try{await opened(ws);const closed=new Promise<number>(resolve=>ws.addEventListener('close',event=>resolve(event.code),{once:true}));ws.send(JSON.stringify({type:'hello',version:2}));expect(await inbox.next()).toMatchObject({code:'UNSUPPORTED_VERSION'});expect(await closed).toBe(1002)}finally{ws.close();server.stop(true);store.close()}
});

const defaultDataDirectory = fileURLToPath(new URL('../../data', import.meta.url));
test.each([
 {name:'default from /tmp/one', configured:undefined, cwd:'/tmp/one', dataDirectory:defaultDataDirectory},
 {name:'default from /tmp/two', configured:undefined, cwd:'/tmp/two', dataDirectory:defaultDataDirectory},
 {name:'empty configuration', configured:'', cwd:'/tmp/one', dataDirectory:defaultDataDirectory},
 {name:'absolute configuration', configured:'/tmp/another-data', cwd:'/tmp/one', dataDirectory:'/tmp/another-data'},
 {name:'relative configuration', configured:'local-data', cwd:'/tmp/one', dataDirectory:'/tmp/one/local-data'},
])('resolves a shared data root for $name', ({configured,cwd,dataDirectory})=>{
 const environment = configured === undefined ? {} : {BENI_DATA_DIR:configured};
 expect(dataPaths(environment,cwd)).toEqual({
  dataDirectory,
  database:join(dataDirectory,'beni.sqlite'),
  chatDirectory:join(dataDirectory,'chats'),
 });
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

test.each([
 {name:'empty', origin:''},
 {name:'HTTP', origin:'http://example.com'},
 {name:'trailing slash', origin:'https://example.com/'},
 {name:'path', origin:'https://example.com/path'},
 {name:'credentials', origin:'https://user:password@example.com'},
 {name:'query', origin:'https://example.com?query=1'},
])('rejects public origin configuration with $name', ({origin})=>{
 const store=new Store(':memory:');
 try{
  expect(()=>createHandler(store,undefined,undefined,origin)).toThrow();
  expect(()=>createServerOptions(store,undefined,undefined,origin)).toThrow();
 }finally{store.close()}
});


test('HTTP scopes accept kind-correct IDs and reject numeric or swapped identifiers',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-http-ids-'));const store=new Store(':memory:');
 try{
  const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
  const handle=createHandler(store,folder,new ChatService(()=>folder,()=>null));
  const get=(path:string)=>handle(new Request('http://127.0.0.1:3210'+path));
  const post=(path:string,input:unknown)=>handle(jsonPost(path,input));
  for(const suffix of [`projectId=${project.id}`,`projectId=${project.id}&taskId=${task.id}&phase=requirements`]){
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
 const post=(taskId:string|null,content:string)=>handle(jsonPost('/api/chat/send',{projectId:project.id,taskId,phase:taskId===null?null:'requirements',content,model:null}));
 try{
  withDatabase(store.projectDatabasePath(project.id),db=>db.query('UPDATE tasks SET created_at=NULL,updated_at=NULL WHERE id=?').run(task.id));
  expect((await post(null,'hello')).status).toBe(202);
  for(let i=0;i<100&&(await chat.get(project.id,null)).messages[1]?.status!=='completed';i++)await Bun.sleep(20);
  expect(store.task(task.id)!.updatedAt).toBeNull();
  expect((await post(task.id,'hello')).status).toBe(202);
  for(let i=0;i<100&&(await chat.get(project.id,task.id)).messages[1]?.status!=='completed';i++)await Bun.sleep(20);
  const completed=store.task(task.id)!;expect(completed.createdAt).toBeNull();expect(completed.updatedAt).not.toBeNull();
  await handle(new Request(`http://127.0.0.1:3210/api/chat?projectId=${project.id}&taskId=${task.id}&phase=requirements`));
  await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`));
  expect(store.task(task.id)!.updatedAt).toBe(completed.updatedAt);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('task rename validates scope and persists only name and activity metadata', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-rename-'));
 const store=new Store(':memory:');const handle=createHandler(store);
 const post=(path:string,data:unknown)=>handle(jsonPost(path,data));
 try {
  const project=store.createProject('Example',folder);const task=store.createTask(project.id,'Before');
  const readTask=()=>withDatabase(store.projectDatabasePath(project.id),db=>db.query<Record<string, unknown>, [string]>('SELECT id,name,created_at,updated_at,phase,status,document_baseline,pending_completion FROM tasks WHERE id=?').get(task.id)!);
  const before=readTask();withDatabase(store.projectDatabasePath(project.id),db=>db.query('UPDATE tasks SET updated_at=NULL WHERE id=?').run(task.id));
  for(const name of ['', '  ', 42, null]) expect((await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name})).status).toBe(400);
  expect((await post(`/api/tasks/${task.id}/rename`,{projectId:generateId('project'),name:'After'})).status).toBe(404);
  expect((await post('/api/tasks/invalid/rename',{projectId:project.id,name:'After'})).status).toBe(404);
  expect(readTask()).toMatchObject({...before,updated_at:null});
  const response=await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name:'  After  '});expect(response.status).toBe(200);
  const result=await response.json();expect(result.name).toBe('After');expect(result.id).toBe(task.id);expect(result.updatedAt).toBeTruthy();
  const after=readTask();expect(after).toMatchObject({...before,name:'After',updated_at:result.updatedAt});
  expect((await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name:' After '})).status).toBe(200);
  expect(readTask()).toEqual(after);
  const state=await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json();expect(state.tasks[0].name).toBe('After');
  expect((await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json()).task.name).toBe('After');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('task deletion API enforces origin and project scope and blocks send initialization', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-delete-')),store=new Store(':memory:');
 try {
  const p=store.createProject('Demo',folder),t=store.createTask(p.id,'Target');
  let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve});
  const chat=new ChatService(()=>folder,()=>'/fake');chat.status=async()=>{await waiting;return {auth:'none'} as any};
  const handle=createHandler(store,folder,chat);
  const post=(projectId:unknown,origin?:string)=>handle(jsonPost(`/api/tasks/${t.id}/delete`,{projectId},origin));
  expect((await post(p.id,'https://example.com')).status).toBe(403);expect((await post(generateId('project'))).status).toBe(404);
  const sending=chat.send(p.id,t.id,'hello',null,folder).catch(()=>{});
  expect((await post(p.id)).status).toBe(409);expect(store.task(t.id)).not.toBeNull();
  release();await sending;expect((await post(p.id)).status).toBe(200);expect((await post(p.id)).status).toBe(404);
  expect((await (await handle(new Request('http://127.0.0.1:3210/api/state'))).json()).tasks).toEqual([]);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('phase advances once per expected phase and rejects busy preparations and active turns', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-phase-'));const store=new Store(':memory:');
 const project=store.createProject('Example',folder);const task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>join(import.meta.dir,'test/fake-codex.ts'));const handle=createHandler(store,folder,chat);
 const post=(path:string,data:unknown)=>handle(jsonPost(path,data));
 const advance=(phase:unknown,projectId=project.id)=>post(`/api/tasks/${task.id}/phase`,{projectId,phase,target:phase==='requirements'?'documents':phase==='documents'?'implementation':'requirements'});
 try {
  expect((await advance('unknown')).status).toBe(400);
  expect((await advance('requirements',generateId('project'))).status).toBe(404);
  const preparing=post('/api/chat/send',{projectId:project.id,taskId:task.id,phase:'requirements',content:'wait',model:null});
  // Let the request reserve its conversation before the provider status probe completes.
  await Bun.sleep(5);
  expect((await advance('requirements')).status).toBe(409);expect((await preparing).status).toBe(202);
  expect((await advance('requirements')).status).toBe(409);
  for(let i=0;i<100;i++){try{await chat.interrupt(project.id,task.id);break}catch{await Bun.sleep(20)}}
  let response:Response|undefined;
  for(let i=0;i<100;i++){response=await advance('requirements');if(response.status!==409)break;await Bun.sleep(20)}
  expect(response!.status).toBe(200);const updated=await response!.json();expect(updated.phase).toBe('documents');expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(task.updatedAt!));
  expect((await advance('requirements')).status).toBe(409);
  await waitUntil(async()=>(await chat.get(project.id,task.id,'documents')).messages.at(-1)?.status==='completed');
  expect((await (await advance('documents')).json()).phase).toBe('implementation');
  await waitUntil(async()=>(await chat.get(project.id,task.id,'implementation')).messages.at(-1)?.status==='completed');
  expect((await (await advance('implementation')).json()).phase).toBe('requirements');
  expect((await advance('execution')).status).toBe(409);
 } finally {store.close();await rm(folder,{recursive:true,force:true})}
});

test('HTTPはタスク会話phaseを必須とし、イベントのページ・版・カーソルを検証する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-events-http-'));const store=new Store(':memory:');const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');const handle=createHandler(store,folder,new ChatService(()=>folder,()=>null));
 const get=(path:string)=>handle(new Request('http://127.0.0.1:3210'+path));const query=`projectId=${project.id}&taskId=${task.id}`;
 const post=(path:string,input:unknown)=>handle(jsonPost(path,input));
 try{
  for(const suffix of ['', '&phase=unknown'])for(const path of ['/api/chat','/api/chat/packs'])expect((await get(`${path}?${query}${suffix}`)).status).toBe(400);
  expect((await get(`/api/chat?projectId=${project.id}&phase=requirements`)).status).toBe(400);
  expect((await post('/api/chat/send',{projectId:project.id,taskId:task.id,content:'hello',model:null})).status).toBe(400);
  expect((await post('/api/chat/send',{projectId:project.id,taskId:task.id,phase:'documents',content:'hello',model:null})).status).toBe(409);
  expect((await post('/api/chat/interrupt',{projectId:project.id,taskId:task.id})).status).toBe(400);
  expect((await post('/api/chat/packs/missing/ack',{projectId:project.id,taskId:task.id,hash:'0'.repeat(64)})).status).toBe(400);
  const path=`/api/tasks/${task.id}/events?projectId=${project.id}`;const first=await (await get(path+'&limit=1')).json();expect(first.events).toHaveLength(1);expect(first.hasMore).toBe(true);expect(first.lastEventId).toBe(1);
  const rest=await (await get(path+`&after=1&through=${first.through}`)).json();expect(rest.events.length).toBeGreaterThan(0);expect(rest.through).toBe(first.through);expect(rest.hasMore).toBe(false);
  const event=rest.events.find((event:any)=>event.version);const version=await (await get(`/api/tasks/${task.id}/events/versions/${event.version}?projectId=${project.id}`)).json();expect(version.version).toBe(event.version);expect(typeof version.content).toBe('string');
  for(const suffix of ['&after=-1','&after=1.5','&after=NaN','&limit=0','&limit=101','&through=0&after=1'])expect((await get(path+suffix)).status).toBe(400);
  expect((await get(path+'&after=999999')).status).toBe(404);expect((await get(`/api/tasks/${task.id}/events/versions/${'0'.repeat(64)}?projectId=${project.id}`)).status).toBe(404);
  expect((await post(`/api/tasks/${task.id}/phase`,{projectId:project.id,phase:'requirements',target:'execution'})).status).toBe(400);
  expect((await post(`/api/tasks/${task.id}/phase`,{projectId:project.id,phase:'requirements',target:'documents'})).status).toBe(200);
  expect((await post(`/api/tasks/${task.id}/phase`,{projectId:project.id,phase:'documents',target:'requirements'})).status).toBe(200);
  expect((await post(`/api/tasks/${task.id}/delete`,{projectId:project.id})).status).toBe(200);
  const retained=await (await get(path)).json();expect(retained.events.at(-1).type).toBe('task.deleted');
  expect((await get(`/api/tasks/${task.id}/events/versions/${event.version}?projectId=${project.id}`)).status).toBe(200);
  const other=store.createProject('Other',await mkdtemp(join(tmpdir(),'beni-events-scope-')));
  try{expect((await get(`/api/tasks/${task.id}/events/versions/${event.version}?projectId=${other.id}`)).status).toBe(404)}finally{await rm(other.folder,{recursive:true,force:true})}
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('WSのphaseスコープを検証し、タスク全体の文書・フェーズイベントを通知する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-events-wire-'));const store=new Store(':memory:');const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,folder,new ChatService(()=>folder,()=>null))});const origin=`http://127.0.0.1:${server.port}`;const ws=new Socket(origin.replace('http:','ws:')+'/api/ws',{headers:{origin}});const inbox=socketMessages(ws);
 try{
  await opened(ws);ws.send(JSON.stringify({type:'hello',version:1}));await inbox.next();
  const subscribe=(id:string,topic:string,phase?:unknown)=>ws.send(JSON.stringify({type:'subscribe',subscriptionId:id,topic,scope:{projectId:project.id,taskId:task.id,...(phase===undefined?{}:{phase})}}));
  subscribe('missing','chat');expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});subscribe('bad-documents','documents','requirements');expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});subscribe('bad-events','task-events',null);expect(await inbox.next()).toMatchObject({code:'INVALID_MESSAGE'});
  subscribe('requirements','chat','requirements');expect(await inbox.next()).toMatchObject({type:'subscribed'});subscribe('documents','chat','documents');expect(await inbox.next()).toMatchObject({type:'subscribed'});
  subscribe('events','task-events');expect(await inbox.next()).toEqual({type:'subscribed',subscriptionId:'events'});const initial=await inbox.next();expect(initial).toMatchObject({name:'task.events.changed'});
  const phase=await fetch(origin+`/api/tasks/${task.id}/phase`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({projectId:project.id,phase:'requirements',target:'documents'})});expect(phase.status).toBe(200);const changed=await inbox.next();expect(changed).toMatchObject({subscriptionId:'events',name:'task.events.changed'});expect(changed.data.lastEventId).toBeGreaterThan(initial.data.lastEventId);
  ws.send(JSON.stringify({type:'unsubscribe',subscriptionId:'events'}));expect(await inbox.next()).toMatchObject({type:'unsubscribed'});
  store.deleteTask(project.id,task.id);
  subscribe('retained-events','task-events');expect(await inbox.next()).toMatchObject({type:'subscribed',subscriptionId:'retained-events'});
  expect(await inbox.next()).toMatchObject({name:'task.events.changed',data:{lastEventId:store.taskEvents(project.id,task.id).through}});
 }finally{ws.close();server.stop(true);store.close();await rm(folder,{recursive:true,force:true})}
});

test('準備phaseを直接選び、本文のある実装手順から開始して停止する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-start-stop-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>join(import.meta.dir,'test/fake-codex.ts')),handle=createHandler(store,folder,chat);
 const post=(action:string,input:object)=>handle(jsonPost(`/api/tasks/${task.id}/${action}`,{projectId:project.id,...input}));
 const detail=async()=>await(await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();
 try {
  expect((await detail()).canStart).toBe(false);
  expect((await post('start',{phase:'requirements',model:null})).status).toBe(409);
  expect((await post('phase',{phase:'requirements',target:'implementation'})).status).toBe(200);
  expect((await post('phase',{phase:'requirements',target:'documents'})).status).toBe(409);
  expect((await post('phase',{phase:'implementation',target:'execution'})).status).toBe(400);
  await waitUntil(async()=>(await chat.get(project.id,task.id,'implementation')).messages.at(-1)?.status==='completed');
  writeTaskDocument(store,project.id,task.id,'implementation.md','  \n');expect((await detail()).canStart).toBe(false);
  writeTaskDocument(store,project.id,task.id,'implementation.md','# 実装手順\n\n1. 仕様を実装する');expect((await detail()).canStart).toBe(true);
  const started=await post('start',{phase:'implementation',model:'model-a'});expect(started.status).toBe(200);expect((await started.json()).phase).toBe('execution');
  expect((await post('phase',{phase:'execution',target:'requirements'})).status).toBe(409);
  expect((await post('start',{phase:'implementation',model:null})).status).toBe(409);
  const stopped=await post('stop',{phase:'execution'});expect(stopped.status).toBe(200);expect((await stopped.json()).phase).toBe('implementation');
  const messages=(await chat.get(project.id,task.id,'execution')).messages;
  expect(messages[0]).toMatchObject({role:'user',model:'model-a'});expect(messages[0]!.content).toContain('実装手順');
  expect(['completed','interrupted']).toContain(messages[1]!.status);
  store.invalidateAgentStatus('codex');
  const unavailable=createHandler(store,folder,new ChatService(()=>folder,()=>null));
  const failed=await unavailable(jsonPost(`/api/tasks/${task.id}/start`,{projectId:project.id,phase:'implementation',model:null}));
  expect(failed.status).toBe(400);expect(store.task(task.id)!.phase).toBe('implementation');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('Claude の状態・送信と実装開始は接続先を検証して引き継ぐ',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-claude-http-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>null,()=>join(import.meta.dir,'test/fake-claude.ts')),handle=createHandler(store,folder,chat);
 const post=(path:string,input:object)=>handle(jsonPost(path,{projectId:project.id,...input}));
 const wait=async(phase:null|'execution')=>{for(let i=0;i<100;i++){if((await chat.get(project.id,phase===null?null:task.id,phase)).messages.at(-1)?.status==='completed')return;await Bun.sleep(20)}throw Error('timed out')};
 try{
  const status=await handle(new Request('http://127.0.0.1:3210/api/claude/status'));expect(status.status).toBe(200);expect(await status.json()).toMatchObject({installed:true,auth:'claude',models:[{id:'sonnet',name:'Sonnet'},{id:'opus',name:'Opus'},{id:'haiku',name:'Haiku'}]});
  expect(await(await handle(new Request('http://127.0.0.1:3210/api/codex/status'))).json()).toMatchObject({installed:false,models:null});
  for(const provider of ['other',null,1,{}]){
   expect((await post('/api/chat/send',{taskId:null,content:'hello',model:null,provider})).status).toBe(400);
   expect((await post(`/api/tasks/${task.id}/start`,{phase:'requirements',model:null,provider})).status).toBe(400);
  }
  const unavailable=await post('/api/chat/send',{taskId:null,content:'hello',model:'missing',provider:'claude'});expect(unavailable.status).toBe(400);expect(await unavailable.json()).toMatchObject({code:'MODEL_UNAVAILABLE'});expect((await chat.get(project.id,null)).messages).toHaveLength(0);
  expect((await post('/api/chat/send',{taskId:null,content:'hello',model:'opus',provider:'claude'})).status).toBe(202);await wait(null);expect((await chat.get(project.id,null)).messages.at(-1)).toMatchObject({provider:'claude',model:'opus'});
  expect((await post(`/api/tasks/${task.id}/phase`,{phase:'requirements',target:'implementation'})).status).toBe(200);
  writeTaskDocument(store,project.id,task.id,'implementation.md','# 実装手順\n\n1. 仕様を実装する');
  const started=await post(`/api/tasks/${task.id}/start`,{phase:'implementation',model:'haiku',provider:'claude'});expect(started.status).toBe(200);expect((await started.json()).phase).toBe('execution');
  await wait('execution');expect((await chat.get(project.id,task.id,'execution')).messages[0]).toMatchObject({provider:'claude',model:'haiku'});
  await waitUntil(()=>store.task(task.id)?.phase==='retrospective');
  await waitForFailedReview(store.projectDatabasePath(project.id),task.id);
  expect((await post(`/api/tasks/${task.id}/stop`,{phase:'execution'})).status).toBe(409);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('文書の引用を照合し、自動分析から終了後のインストラクション更新まで実行する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-doc-workflow-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>fakeCodex),handle=createHandler(store,folder,chat);
 const address='http://127.0.0.1:3210',taskPath=`/api/tasks/${task.id}`;
 const post=(path:string,input:object)=>handle(jsonPost(path,{projectId:project.id,...input}));
 const detail=async()=>(await (await handle(new Request(address+taskPath))).json());
 const settled=async(phase:'requirements'|'documents'|'implementation')=>waitUntil(async()=>(
  (await chat.get(project.id,task.id,phase)).messages.at(-1)?.status==='completed'));
 const document=(name:string,scope:string|null=task.id)=>store.managedDocument(project.id,scope,name)!;
 let editorNotified=false;
 const unsubscribe=chat.subscribe(INSTRUCTIONS_CHAT_ID,null,event=>{if(event.name==='chat.changed')editorNotified=true});
 process.env.FAKE_CODEX_WORKFLOW='enabled';
 try{
  const original=document('requirements.md');
  expect((await post('/api/chat/send',{taskId:task.id,phase:'requirements',content:fixtureRequest,model:null})).status).toBe(202);
  await settled('requirements');
  const requirements=document('requirements.md'),reference=requirements.items.at(-1)!.sources[0]!;
  expect(requirements.items.at(-1)).toMatchObject({text:'入力値を検証する。',sources:[{kind:'message',text:fixtureRequest}]});
  expect(requirements.items.at(-2)).toMatchObject({text:'\n## 入力の検証\n\n',reason:'入力検証の要件をまとめる',sources:[reference]});
  expect(store.managedDocument(project.id,task.id,'requirements.md',original.revision)?.content).toBe(original.content);
  expect(store.managedDocumentHistory(project.id,task.id).filter(doc=>doc.name==='requirements.md')).toHaveLength(2);
  const source=chat.workflowSources(project.id,task.id,'requirements')!;
  expect(reference.id).toBe(['requirements',source.chatId,source.messages[0]!.id].join('/'));
  expect(source.packs.filter(pack=>pack.tool?.name==='edit_document').map(pack=>pack.status)).toEqual(['failed','failed','completed']);
  expect((await post('/api/chat/commands',{taskId:task.id,phase:'requirements',command:'clear',provider:'codex'})).status).toBe(202);

  expect((await post(taskPath+'/phase',{phase:'requirements',target:'documents'})).status).toBe(200);
  await settled('documents');
  expect(document('documents.md').items.at(-1)?.sources[0]).toMatchObject({kind:'document',revision:requirements.revision});
  expect((await post(taskPath+'/phase',{phase:'documents',target:'implementation'})).status).toBe(200);
  await settled('implementation');
  expect((await detail()).canStart).toBe(true);
  expect((await post(taskPath+'/start',{phase:'implementation',model:null})).status).toBe(200);
  await waitUntil(async()=>(await detail()).workflow.review?.state==='done');
  const review=await detail();
  expect(review.task.phase).toBe('retrospective');
  expect(review.workflow.review).toEqual({state:'done',error:null});
  expect(document('retrospective.md').content).toContain('検証の根拠を見直す。');
  const reviewPacks=chat.workflowSources(project.id,task.id,'retrospective')!.packs;
  expect(reviewPacks.some(pack=>pack.tool?.name==='get_retrospective_signals'&&pack.status==='completed')).toBe(true);
  expect(reviewPacks.some(pack=>pack.tool?.name==='read_source'&&pack.tool.output.includes(fixtureRequest))).toBe(true);
  expect(reviewPacks.some(pack=>pack.tool?.name==='finish_retrospective'&&pack.status==='completed')).toBe(true);
  expect(document('retrospective.md').items.at(-1)?.sources[0]).toMatchObject({kind:'message',text:fixtureRequest});

  process.env.FAKE_CODEX_WORKFLOW='without-finish';
  expect((await post(taskPath+'/complete',{phase:'retrospective'})).status).toBe(200);
  await waitUntil(()=>store.task(task.id)?.phase==='retrospective');
  expect(store.instructionJob(project.id,task.id)).toBeUndefined();
  process.env.FAKE_CODEX_WORKFLOW='enabled';
  expect((await post(taskPath+'/complete',{phase:'retrospective'})).status).toBe(200);
  await waitUntil(async()=>(await detail()).workflow.instructionJob?.status==='succeeded');
  expect((await detail()).task).toMatchObject({phase:'finalization',status:'completed'});
  expect(editorNotified).toBe(true);
  const knowledge=document('knowledge.md',null),job=store.instructionJob(project.id,task.id)!;
  expect(knowledge.content).toContain('検証の根拠を保つ。');
  expect(job.revision).toBe(knowledge.revision);
  const knowledgeItem = knowledge.items.find(item => item.sources[0]?.kind === 'document')!;
  const knowledgeLookup = (revision:string,itemId:string) => handle(new Request(address+'/api/document-provenance?'+new URLSearchParams({
   name:'knowledge.md',projectId:project.id,taskId:task.id,revision,itemId
  })));
  const newerKnowledge = store.writeManagedDocument(project.id,null,'knowledge.md',knowledge.revision,[
   {text:'別タスクの学び。',reason:'新しい学びを追加する。',sources:knowledgeItem.sources}
  ],'fixture');
  expect((await detail()).documents.find((doc:{name:string})=>doc.name==='knowledge.md').provenance.revision).toBe(knowledge.revision);
  expect(await (await knowledgeLookup(knowledge.revision,knowledgeItem.id)).json()).toEqual({
   reason:knowledgeItem.reason,sources:knowledgeItem.sources
  });
  expect((await knowledgeLookup(newerKnowledge.revision,newerKnowledge.items[0]!.id)).status).toBe(404);
  expect(await Bun.file(join(store.legacyProjectDirectory(project.id),'knowledge.md')).exists()).toBe(false);
  expect(store.instructionDocument('common')?.items.at(-1)).toMatchObject({
   text:'- 検証の根拠を記録する。',sources:[{kind:'document',revision:knowledge.revision,text:'検証の根拠を保つ。'}]
  });
  expect(chat.workflowSources(project.id,null,null)).toBeUndefined();
  expect(chat.workflowSources(project.id,null,null,undefined,undefined,job.id)?.packs.some(pack=>(
   pack.tool?.name==='finish_instruction_update'&&pack.status==='completed'))).toBe(true);
  const jobChatId=store.chats.current({projectId:project.id,taskId:null,phase:null,workflowJobId:job.id})!.chatId;
  expect(jobChatId).not.toBe(job.id);
  const jobFile=store.chats.path(jobChatId);
  expect(await Bun.file(jobFile).exists()).toBe(true);
  const query=new URLSearchParams({projectId:project.id,chatId:jobChatId,workflowJobId:job.id});
  const byId=()=>handle(new Request(address+'/api/chat?'+query));
  expect(await (await byId()).json()).toMatchObject({id:jobChatId,workflowJobId:job.id});
  expect((await post(taskPath+'/reopen',{phase:'finalization'})).status).toBe(200);
  expect(store.task(task.id)).toMatchObject({phase:'retrospective',status:'idle'});
  expect((await knowledgeLookup(knowledge.revision,knowledgeItem.id)).status).toBe(404);
  expect((await post(taskPath+'/delete',{})).status).toBe(200);
  expect(await Bun.file(jobFile).exists()).toBe(true);
  expect(await (await byId()).json()).toMatchObject({id:jobChatId,workflowJobId:job.id});
  expect(chat.workflowSources(project.id,null,null,undefined,undefined,job.id)?.packs.some(pack=>pack.tool?.name==='finish_instruction_update')).toBe(true);
  expect(store.instructionJob(project.id,task.id)).toMatchObject({id:job.id,status:'succeeded'});
  await expect(stat(store.legacyProjectDirectory(project.id))).rejects.toThrow();
 }finally{unsubscribe();delete process.env.FAKE_CODEX_WORKFLOW;store.close();await rm(folder,{recursive:true,force:true})}
},15000);

test('指示更新の待機中と、後続ジョブに置き換わった実行中は削除を拒否する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-job-delete-')),store=new Store(':memory:');
 const project=store.createProject('Project',folder);
 const runningTask=store.createTask(project.id,'Running'),queuedTask=store.createTask(project.id,'Queued');
 const release=Promise.withResolvers<void>();
 let entered=false,settled=false;
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(_request,_host,accept)=>{
  await accept();
  entered=true;
  await release.promise;
  return {status:'completed'};
 }});
 const job={id:'running',projectId:project.id,taskId:runningTask.id,revision:'fixture',provider:'dummy',model:null};
 store.enqueueInstructionJob(job);
 const handle=createHandler(store,folder,new ChatService(()=>folder,[agent]),undefined,undefined,(_project,taskId)=>{
  if(taskId===runningTask.id)settled=true;
 });
 const remove=(taskId:string)=>handle(new Request(`http://127.0.0.1:3210/api/tasks/${taskId}/delete`,{
  method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id})
 }));
 try{
  await waitUntil(()=>entered);
  const started=store.taskEvents(project.id,runningTask.id).events.find(event=>event.type==='workflow.started');
  expect(started).toMatchObject({details:{workflowJobId:job.id,eventKey:'task.completed',triggerEventId:null},chatId:null});
  store.enqueueInstructionJob({...job,id:'queued',taskId:queuedTask.id});
  for(const task of [runningTask,queuedTask]){
   const response=await remove(task.id);
   expect(response.status).toBe(409);
   expect(await response.json()).toEqual({error:'インストラクションの更新待ち・更新中はタスクを削除できません'});
   expect(store.task(task.id)).not.toBeNull();
  }
  store.finishInstructionJob('queued','fixture');
  expect((await remove(queuedTask.id)).status).toBe(200);
  store.enqueueInstructionJob({...job,id:'replacement'});
  store.finishInstructionJob('replacement','fixture');
  expect(store.pendingInstructionJob()).toBeUndefined();
  expect((await remove(runningTask.id)).status).toBe(409);
  release.resolve();
  await waitUntil(()=>settled);
  expect((await remove(runningTask.id)).status).toBe(200);
 }finally{
  release.resolve();
  if(agent.requests.length)await waitUntil(()=>settled);
  store.close();
  await rm(folder,{recursive:true,force:true});
 }
});

test('タスク完了ワークフローは確定後に固定版を使い、変更なしで再試行を完了できる', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-task-workflow-')),store=new Store(':memory:');
 const project=store.createProject('Project',folder),task=store.createTask(project.id,'Origin'),other=store.createTask(project.id,'Other');
 const key='task.completed';
 const template='編集した方針\n{{project_directory}}|{{working_directory}}|{{task_id}}|{{task_directory}}|{{phase}}|{{knowledge_path}}|{{knowledge_content}}';
 const saveWorkflow=(content:string)=>store.updateInstruction(key,content,store.instructionDocument(key)!.content);
 const source=store.managedDocument(project.id,task.id,'requirements.md')!;
 const saveKnowledge=(text:string)=>store.writeManagedDocument(project.id,null,'knowledge.md',store.managedDocument(project.id,null,'knowledge.md')!.revision,[
  {text,reason:'ナレッジを記録する',sources:[{kind:'document',id:'requirements.md/'+source.items[0]!.id,revision:source.revision,text:source.items[0]!.text}]}
 ],crypto.randomUUID());
 const originalKnowledge=saveKnowledge('確定した学び {{task_id}}');
 const completion={id:crypto.randomUUID(),revision:originalKnowledge.revision,provider:'dummy',model:null};
 const workflowEvents=()=>store.projectEvents(project.id,{taskId:task.id,modelPage:true,types:['workflow.started','workflow.completed','workflow.failed']}).events;
 const observations:unknown[]=[];
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(request,host,accept)=>{
  await accept();
  const call=(name:string,input:object,id=name)=>host.callTool({id,name,input});
  const job=store.instructionJob(project.id,task.id)!;
  observations.push({
   operation:request.operation,
   task:store.task(task.id)?.status,
   event:store.projectEvent(project.id,job.eventId!),
   workflowEvents:workflowEvents().map(event=>event.type),
   allowed:(await call('list_documents',{})).text,
   knowledge:await call('read_document',{name:'knowledge.md'}),
   otherRevision:(await call('read_document',{name:'knowledge.md',revision:newerKnowledge.revision},'newer')).ok,
   ownRead:(await call('read_document',{name:key},'own-read')).ok,
   editorRead:(await call('read_document',{name:'editor'},'editor-read')).ok,
   ownEdit:(await call('edit_document',{name:key,revision:null,update_id:'self',edits:[]},'own-edit')).ok,
   editorEdit:(await call('edit_document',{name:'editor',revision:null,update_id:'editor',edits:[]},'editor-edit')).ok,
  });
  if(observations.length===2)await call('finish_instruction_update',{reason:'既存の指示で扱えている'});
  return {status:'completed'};
 }});
 const chat=new ChatService(()=>folder,[agent]);
 let handle=createHandler(store,folder,chat);
 const origin='http://127.0.0.1:3210',base=`${origin}/api/tasks/${task.id}`;
 const post=(action:string)=>handle(new Request(`${base}/${action}`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({projectId:project.id})}));
 const currentJob=()=>store.instructionJob(project.id,task.id);
 let newerKnowledge=originalKnowledge;
 try {
  saveWorkflow(template);
  const instructionRevision=store.instructionDocument(key)!.revision;
  const common=store.instructionDocument('common');
  const editor=store.instructionDocument('editor');
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  store.startTaskFinalization(project.id,task.id);
  await Bun.sleep(0);
  expect(agent.requests).toHaveLength(0);
  expect(currentJob()).toBeUndefined();
  store.setTaskCompleted(project.id,task.id,true,'finalization',completion);
  newerKnowledge=saveKnowledge('完了後の別の版');
  handle=createHandler(store,folder,chat);
  await waitUntil(()=>currentJob()?.status==='failed');
  expect(currentJob()).toMatchObject({id:completion.id,instructionRevision,error:'ワークフローを完了できませんでした'});
  expect(store.task(task.id)?.status).toBe('completed');
  const firstChatId=store.chats.current({projectId:project.id,taskId:null,phase:null,workflowJobId:completion.id})!.chatId;
  saveWorkflow('# 変更後の方針');
  expect((await post('retry-instructions')).status).toBe(202);
  await waitUntil(()=>currentJob()?.status==='succeeded');
  expect(currentJob()).toMatchObject({id:completion.id,instructionRevision,reason:'既存の指示で扱えている'});
  const recorded=workflowEvents();
  expect(recorded.map(event=>event.type)).toEqual(['workflow.started','workflow.failed','workflow.started','workflow.completed']);
  const [started,failed,retried,completed]=recorded;
  expect(started!.id).toBeGreaterThan(currentJob()!.eventId!);
  expect(started!.chatId).toBeNull();
  expect([failed!.chatId,retried!.chatId,completed!.chatId]).toEqual([firstChatId,firstChatId,firstChatId]);
  for(const event of recorded)expect(event).toMatchObject({taskId:task.id,details:{
   workflowJobId:completion.id,eventKey:key,triggerEventId:currentJob()!.eventId
  }});
  expect(started!.details.attemptId).toBe(failed!.details.attemptId);
  expect(retried!.details.attemptId).toBe(completed!.details.attemptId);
  expect(started!.details.attemptId).not.toBe(retried!.details.attemptId);
  expect(store.instructionDocument('common')).toEqual(common);
  expect(store.instructionDocument('editor')).toEqual(editor);
  expect(store.instructionDocument(key)?.content).toBe('# 変更後の方針');
  expect(agent.requests.map(request=>request.instructions)).toEqual([0,1].map(()=>
   `編集した方針\n${project.folder}|${project.folder}|${task.id}|Beni のタスク文書（埋め込みツールで参照）|finalization|Beni のプロジェクトナレッジ（埋め込みツールで参照）|"確定した学び {{task_id}}"`));
  expect(agent.requests.every(request=>request.access==='read-only'&&request.builtInTools==='disabled'&&!request.instructions.includes(other.id))).toBe(true);
  const allowed=JSON.parse((observations[0] as {allowed:string}).allowed).documents.map((item:{name:string})=>item.name);
  expect(allowed).toEqual(['knowledge.md','common','requirements','documents','implementation','execution','retrospective','finalization']);
  expect(observations).toHaveLength(2);
  expect(observations[0]).toMatchObject({workflowEvents:['workflow.started']});
  expect(observations[1]).toMatchObject({workflowEvents:['workflow.started','workflow.failed','workflow.started']});
  for(const observation of observations)expect(observation).toMatchObject({
   operation:{kind:'send',text:key},task:'completed',event:{type:key,taskId:task.id},
   knowledge:{ok:true},otherRevision:false,ownRead:false,editorRead:false,ownEdit:false,editorEdit:false,
  });
 }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test.each(['workflow.started','workflow.completed'] as const)('%s の記録失敗でワークフローの成功を取り消さない',async(rejectedType)=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-workflow-event-failure-')),store=new Store(':memory:');
 try{
  const project=store.createProject('Project',folder),task=store.createTask(project.id,'Origin');
  const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(_request,host,accept)=>{
   await accept();
   await host.callTool({id:'finish',name:'finish_instruction_update',input:{reason:'変更は不要です'}});
   return {status:'completed'};
  }});
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  store.startTaskFinalization(project.id,task.id);
  const revision=store.managedDocument(project.id,null,'knowledge.md')!.revision;
  store.setTaskCompleted(project.id,task.id,true,'finalization',{id:crypto.randomUUID(),revision,provider:'dummy',model:null});
  withDatabase(store.projectDatabasePath(project.id),db=>db.exec(`CREATE TRIGGER fail_workflow_event BEFORE INSERT ON events
   WHEN NEW.type='${rejectedType}' BEGIN SELECT RAISE(ABORT,'simulated event failure'); END`));
  createHandler(store,folder,new ChatService(()=>folder,[agent]));
  await waitUntil(()=>store.instructionJob(project.id,task.id)?.status==='succeeded');
  expect(store.instructionJob(project.id,task.id)?.reason).toBe('変更は不要です');
  expect(store.pendingInstructionJob()).toBeUndefined();
  expect(agent.requests).toHaveLength(1);
  const recorded=store.taskEvents(project.id,task.id).events.filter(event=>event.type.startsWith('workflow.'));
  expect(recorded.map(event=>event.type)).toEqual(rejectedType==='workflow.started'?['workflow.completed']:['workflow.started']);
 }finally{store.close();await rm(folder,{recursive:true,force:true});}
});

test('ワークフロー会話の移行先が衝突した場合は両方を保全する', async () => {
 const root=await mkdtemp(join(tmpdir(),'beni-workflow-collision-')),folder=join(root,'work');
 await mkdir(folder);
 const app=join(root,'app.sqlite');
 let store=new Store(app);
 try{
  const project=store.createProject('Project',folder),task=store.createTask(project.id,'Task');
  const job={id:'workflow-collision',projectId:project.id,taskId:task.id,revision:'fixture',provider:'dummy',model:null};
  store.enqueueInstructionJob(job);
  store.finishInstructionJob(job.id);
  const {workflowJobHash}=await import('./chat-files');
  const projectRoot=store.legacyProjectDirectory(project.id),source=join(projectRoot,'workflow-jobs'),
   target=join(projectRoot,'workflows','task.completed');
  const oldName=workflowJobHash(job.id)+'.chat.json',name=job.id+'.chat.json';
  const original=JSON.stringify({version:1,id:crypto.randomUUID(),projectId:project.id,taskId:null,phase:null,workflowJobId:job.id,messages:[],packs:[]});
  const other=original.replace(JSON.parse(original).id,crypto.randomUUID());
  await mkdir(source,{recursive:true});
  await mkdir(target,{recursive:true});
  await writeFile(join(source,oldName),original);
  await writeFile(join(target,name),other);
  store.close();
  store=new Store(app);
  const {migrateChatStorage}=await import('./chat-migration');
  expect(()=>migrateChatStorage(store.chats,store.dataDirectory,store.chatMigrationProjects())).toThrow();
  expect(await readFile(join(source,oldName),'utf8')).toBe(original);
  expect(await readFile(join(target,name),'utf8')).toBe(other);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test('反省会の自動分析では完了申告があっても停止が勝ち、再起動後は手動で再開できる', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-review-stop-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const entered=Promise.withResolvers<void>(),aborted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(request,host,accept)=>{
  await accept();
  const revision=store.managedDocument(project.id,task.id,'retrospective.md')!.revision;
  const finish=(reason='追記する発見なし')=>host.callTool({id:'finish',name:'finish_retrospective',input:{revision,reason}});
  if(request.operation.kind==='send'&&request.operation.text==='検証について相談する。'){
   expect(request.access).toBe('workspace-write');
   expect(request.tools).toEqual(agent.requests[0]?.tools);
   expect(request.resumeToolsChanged).toBe(false);
   expect(request.instructions).not.toContain('finish_retrospective');
   expect((await finish(' ')).ok).toBe(false);
   expect((await host.callTool({id:'signals',name:'get_retrospective_signals',input:{area:'documents'}})).ok).toBe(true);
   await host.emit({type:'text.completed',itemId:'reply',text:'確認します。'});
   return {status:'completed'};
  }
  expect(request.access).toBe('read-only');
  expect((await finish()).ok).toBe(true);
  if(agent.requests.length===1){
   const interrupted=new Promise<void>(resolve=>host.signal.addEventListener('abort',()=>resolve(),{once:true}));
   entered.resolve();
   await interrupted;
   aborted.resolve();
   await release.promise;
  }
  return {status:'completed'};
 }});
 let chat=new ChatService(()=>folder,[agent]),handle=createHandler(store,folder,chat);
 const address='http://127.0.0.1:3210',taskPath=`/api/tasks/${task.id}`;
 const get=(path:string)=>handle(new Request(address+path));
 const post=(path:string,input:object={})=>handle(jsonPost(path,{projectId:project.id,...input}));
 const review=async()=>(await (await get(taskPath)).json()).workflow.review;
 try{
  expect((await post(taskPath+'/stop-review')).status).toBe(409);
  expect((await post(taskPath+'/stop-review',{projectId:generateId('project')})).status).toBe(404);
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  await get(taskPath);
  await entered.promise;
  const running=await review();
  expect(running).toEqual({state:'running',error:null});

  const stop=post(taskPath+'/stop-review');
  await aborted.promise;
  expect((await post(taskPath+'/retry-review')).status).toBe(409);
  expect((await post(taskPath+'/stop-review')).status).toBe(409);
  release.resolve();
  const stopped=await stop;
  expect(stopped.status).toBe(200);
  expect(await stopped.json()).toEqual({ok:true});
  expect((await chat.get(project.id,task.id,'retrospective')).messages.at(-1)?.status).toBe('completed');

  chat=new ChatService(()=>folder,[agent]);
  handle=createHandler(store,folder,chat);
  expect((await get('/api/state')).status).toBe(200);
  expect(await review()).toEqual({...running,state:'stopped'});
  expect((await post(taskPath+'/complete',{phase:'retrospective'})).status).toBe(409);
  expect(agent.requests).toHaveLength(1);
  expect((await post('/api/chat/send',{taskId:task.id,phase:'retrospective',content:'検証について相談する。',model:null})).status).toBe(202);
  await waitUntil(async()=>(await chat.get(project.id,task.id,'retrospective')).messages.at(-1)?.status==='completed');
  expect(await review()).toEqual({...running,state:'stopped'});

  const retries=await Promise.all([post(taskPath+'/retry-review'),post(taskPath+'/retry-review')]);
  expect(retries.map(response=>response.status).sort()).toEqual([202,409]);
  await waitUntil(async()=>(await review()).state==='done');
  expect(await review()).toEqual({state:'done',error:null});
  expect(agent.requests).toHaveLength(3);
  expect((await post(taskPath+'/stop-review')).status).toBe(409);
 }finally{release.resolve();store.close();await rm(folder,{recursive:true,force:true})}
});

test('完了申告のない反省会の自動分析は失敗し、再送しない',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-review-stalled-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const agent=new DummyAgent({supportsEmbeddedTools:true});
 const handle=createHandler(store,folder,new ChatService(()=>folder,[agent]));
 const detail=async()=>(await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json());
 try{
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  await detail();
  await waitForFailedReview(store.projectDatabasePath(project.id),task.id);
  expect((await detail()).workflow.review).toMatchObject({state:'failed',error:'反省会の分析を完了できませんでした'});
  expect(agent.requests).toHaveLength(1);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('通常の反省会チャットでは有効な完了申告のターンが正常終了すると分析が完了する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-review-manual-finish-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const entered=Promise.withResolvers<void>();
 let oldRevision='';
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(request,host,accept)=>{
  await accept();
  if(request.access==='read-only')return {status:'completed'};
  const text=request.operation.kind==='send'?request.operation.text:'';
  const revision=store.managedDocument(project.id,task.id,'retrospective.md')!.revision;
  const finish=()=>host.callTool({id:'finish',name:'finish_retrospective',
   input:{revision:text==='古い版で完了を申告してください。'?oldRevision:revision,reason:'追記する発見なし'}});
  if(text==='古い版で完了を申告してください。'){
   expect((await finish()).ok).toBe(false);
  }else{
   expect((await finish()).ok).toBe(true);
   if(text==='申告後に文書を追記してください。'){
    writeTaskDocument(store,project.id,task.id,'retrospective.md','分析内容を追記する。');
   }
   if(text==='完了を申告してください。停止の確認用。'){
    const interrupted=new Promise<void>(resolve=>host.signal.addEventListener('abort',()=>resolve(),{once:true}));
    entered.resolve();
    await interrupted;
    return {status:'interrupted'};
   }
  }
  return {status:'completed'};
 }});
 const chat=new ChatService(()=>folder,[agent]),handle=createHandler(store,folder,chat);
 const address='http://127.0.0.1:3210',taskPath=`/api/tasks/${task.id}`;
 const detail=async()=>(await (await handle(new Request(address+taskPath))).json());
 const post=(path:string,input:object)=>handle(jsonPost(path,{projectId:project.id,...input}));
 const send=async(content:string)=>{
  expect((await post('/api/chat/send',{taskId:task.id,phase:'retrospective',content,model:null})).status).toBe(202);
 };
 const status=async()=>(await chat.get(project.id,task.id,'retrospective')).messages.at(-1)?.status;
 try{
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  await detail();
  await waitForFailedReview(store.projectDatabasePath(project.id),task.id);
  oldRevision=store.managedDocument(project.id,task.id,'retrospective.md')!.revision;
  writeTaskDocument(store,project.id,task.id,'retrospective.md','分析結果を記録する。');

  for(const content of ['古い版で完了を申告してください。','申告後に文書を追記してください。']){
   await send(content);
   await waitUntil(async()=>await status()==='completed');
   expect((await detail()).workflow.review.state).toBe('failed');
  }

  await send('完了を申告してください。停止の確認用。');
  await entered.promise;
  expect((await detail()).workflow.review.state).toBe('failed');
  expect((await post(taskPath+'/retry-review',{})).status).toBe(409);
  expect((await post('/api/chat/interrupt',{taskId:task.id,phase:'retrospective'})).status).toBe(200);
  expect(await status()).toBe('interrupted');
  expect((await detail()).workflow.review.state).toBe('failed');

  await send('分析の完了を申告してください。');
  await waitUntil(async()=>(await detail()).workflow.review.state==='done');
  expect(await status()).toBe('completed');
  expect((await detail()).workflow.review).toEqual({state:'done',error:null});
  expect(store.task(task.id)).toMatchObject({phase:'retrospective',status:'idle'});
  expect(agent.requests.map(request=>request.access)).toEqual(['read-only','workspace-write','workspace-write','workspace-write','workspace-write']);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('モデル接続の確認中に自動分析を停止すると送信しない',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-review-stop-before-send-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const checking=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const agent=new DummyAgent({supportsEmbeddedTools:true}),getStatus=agent.getStatus.bind(agent);
 agent.getStatus=async()=>{
  checking.resolve();
  await release.promise;
  return getStatus();
 };
 const handle=createHandler(store,folder,new ChatService(()=>folder,[agent]));
 const address='http://127.0.0.1:3210',taskPath=`/api/tasks/${task.id}`;
 const detail=async()=>(await (await handle(new Request(address+taskPath))).json());
 try{
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  await detail();
  await checking.promise;
  const stop=handle(jsonPost(taskPath+'/stop-review',{projectId:project.id}));
  await waitUntil(async()=>(await detail()).workflow.review.state==='stopped');
  release.resolve();
  expect((await stop).status).toBe(200);
  expect((await detail()).workflow.review).toMatchObject({state:'stopped',error:null});
  expect(agent.requests).toHaveLength(0);
 }finally{release.resolve();store.close();await rm(folder,{recursive:true,force:true})}
});

test('旧反省会の状態を復旧し、旧資料キューは変更しない',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-review-recovery-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder);
 const tasks=(['pending','running','stopped','done','failed'] as const).map(state=>({state,task:store.createTask(project.id,state)}));
 const agent=new DummyAgent({supportsEmbeddedTools:true,scenario:async(_request,host,accept)=>{
  await accept();
  const read=await host.callTool({id:'read',name:'read_document',input:{name:'retrospective.md'}});
  expect(read.ok).toBe(true);
  const {revision}=JSON.parse(read.text);
  expect((await host.callTool({id:'finish',name:'finish_retrospective',input:{revision,reason:'追記する発見なし'}})).ok).toBe(true);
  return {status:'completed'};
 }});
 const handle=createHandler(store,folder,new ChatService(()=>folder,[agent]));
 const address='http://127.0.0.1:3210';
 const review=async(id:string)=>(await (await handle(new Request(address+'/api/tasks/'+id))).json()).workflow.review;
 try{
  for(const {task} of tasks)store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  withDatabase(store.projectDatabasePath(project.id),db=>{
   db.exec(`CREATE TABLE document_review (task_id TEXT PRIMARY KEY,state TEXT NOT NULL,error TEXT);
    CREATE TABLE document_review_items (task_id TEXT NOT NULL,id INTEGER NOT NULL,label TEXT NOT NULL,text TEXT NOT NULL,
     source TEXT,read_to INTEGER NOT NULL DEFAULT -1,finding TEXT,PRIMARY KEY(task_id,id));`);
   for(const {state,task} of tasks){
    db.query('INSERT INTO document_review VALUES (?,?,?)').run(task.id,state,state==='failed'?'以前の分析エラー':null);
    db.query('INSERT INTO document_review_items(task_id,id,label,text) VALUES (?,1,?,?)').run(task.id,'旧資料','確認待ち');
   }
  });
  expect((await handle(new Request(address+'/api/state'))).status).toBe(200);
  for(const {state,task} of tasks){
   if(state==='pending'||state==='running')await waitUntil(async()=>(await review(task.id)).state==='done');
   else expect((await review(task.id)).state).toBe(state);
  }
  expect(agent.requests).toHaveLength(2);
  expect(withDatabase(store.projectDatabasePath(project.id),db=>db.query('SELECT text,read_to,finding FROM document_review_items ORDER BY task_id').all())).toEqual(
   tasks.map(()=>({text:'確認待ち',read_to:-1,finding:null}))
  );
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('終了中にサーバーが停止した場合は反省会に戻す', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-finalization-recover-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const handler=createHandler(store,folder,new ChatService(()=>folder,()=>null));
 try {
  store.selectTaskPhase(project.id,task.id,'requirements','retrospective');
  store.startTaskFinalization(project.id,task.id);
  const state=await handler(new Request('http://127.0.0.1:3210/api/state'));
  expect(state.status).toBe(200);
  expect((await state.json()).tasks).toMatchObject([{phase:'retrospective',status:'idle'}]);
  expect(store.taskEvents(project.id,task.id).events.some(event=>event.type==='task.completed')).toBe(false);
 } finally {store.close();await rm(folder,{recursive:true,force:true})}
});

test('実装の自然なfailedとunknownは反省会へ通知し停止競合は実装手順へ戻す',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-retro-terminal-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),fake=join(import.meta.dir,'test/fake-codex.ts');
 const chat=new ChatService(()=>folder,()=>fake,()=>join(import.meta.dir,'test/fake-claude.ts'));let changed=0;
 const handle=createHandler(store,folder,chat,undefined,undefined,()=>changed++);
 const post=(id:string,action:string,input:object)=>handle(jsonPost(`/api/tasks/${id}/${action}`,{projectId:project.id,...input}));
 try {
  for(const [action,status] of [['fail','failed'],['disconnect','unknown']] as const){
   const task=store.createTask(project.id,action);writeTaskDocument(store,project.id,task.id,'implementation.md','# Plan\nImplement.');
   process.env.FAKE_CODEX_TURN_ACTION=action;
   expect((await post(task.id,'start',{phase:'requirements',model:null})).status).toBe(200);
   for(let i=0;i<100&&store.task(task.id)!.phase==='execution';i++)await Bun.sleep(20);
   expect(store.task(task.id)!.phase).toBe('retrospective');
   expect((await chat.get(project.id,task.id,'execution')).messages.at(-1)?.status).toBe(status);
   await waitForFailedReview(store.projectDatabasePath(project.id),task.id);
  }
  delete process.env.FAKE_CODEX_TURN_ACTION;
  const task=store.createTask(project.id,'Stop pending');writeTaskDocument(store,project.id,task.id,'implementation.md','# Plan\nImplement.');
  process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS='500';process.env.FAKE_CLAUDE_LOG=join(folder,'claude.jsonl');
  expect((await post(task.id,'start',{phase:'requirements',model:'sonnet',provider:'claude'})).status).toBe(200);
  for(let i=0;i<100;i++){try{if((await readFile(process.env.FAKE_CLAUDE_LOG,'utf8')).length)break}catch{}await Bun.sleep(10)}
  expect((await post(task.id,'stop',{phase:'execution'})).status).toBe(200);
  expect(store.task(task.id)!.phase).toBe('implementation');
  expect((await chat.get(project.id,task.id,'execution')).messages.at(-1)?.status).toBe('interrupted');
  expect(changed).toBeGreaterThanOrEqual(6);
 }finally{delete process.env.FAKE_CODEX_TURN_ACTION;delete process.env.FAKE_CLAUDE_ACCEPT_DELAY_MS;delete process.env.FAKE_CLAUDE_LOG;store.close();await rm(folder,{recursive:true,force:true})}
});

test('次回準備の知識本文と反省会のproject cwdをCLIへ渡す',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-retro-context-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Preparation'),retro=store.createTask(project.id,'Review');
 const chat=new ChatService(()=>folder,()=>join(import.meta.dir,'test/fake-codex.ts')),log=join(folder,'rpc.jsonl');
 try {
  createHandler(store,folder,chat);
  const knowledge=store.managedDocument(project.id,null,'knowledge.md')!;
  const seed=knowledge.items[0]!;
  store.writeManagedDocument(project.id,null,'knowledge.md',knowledge.revision,[{
   text:'# 確認済み: 検証は段階ごとに実施する。',reason:'確認済みの学びを記録する。',
   sources:[{kind:'document',id:knowledge.name+'/'+seed.id,revision:knowledge.revision,text:seed.text}]
  }],'fixture');
  process.env.FAKE_CODEX_LOG=log;
  const wait=async(id:string,phase:'requirements'|'retrospective')=>{for(let i=0;i<100;i++){if((await chat.get(project.id,id,phase)).messages.at(-1)?.status==='completed')return;await Bun.sleep(20)}throw Error('timed out')};
  await chat.send(project.id,task.id,'hello',null,folder,undefined,'requirements');await wait(task.id,'requirements');
  store.selectTaskPhase(project.id,retro.id,'requirements','retrospective');
  await chat.send(project.id,retro.id,'hello',null,folder,undefined,'retrospective');await wait(retro.id,'retrospective');
  const records=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),starts=records.filter(record=>record.method==='thread/start'),turns=records.filter(record=>record.method==='turn/start');
  expect(starts[0].params.developerInstructions).toContain('確認済み: 検証は段階ごとに実施する。');
  expect(starts[0].params.cwd).toBe(folder);
  expect(turns[0].params.sandboxPolicy.type).toBe('readOnly');
  expect(starts[1].params.cwd).toBe(folder);
  expect(turns[1].params.input.some((item:{text:string})=>item.text.includes('実装の会話抜粋'))).toBe(true);
  expect(turns[1].params.sandboxPolicy.writableRoots).toEqual([folder]);
 }finally{delete process.env.FAKE_CODEX_LOG;store.close();await rm(folder,{recursive:true,force:true})}
});


test('埋め込みツールの保存成功だけをタスクイベントへ通知し、文書照合の実行参照を渡す', async () => {
 const folder=await mkdtemp(join(tmpdir(),'beni-event-notifications-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task'),chat=new ChatService(()=>folder,()=>null);
 let provider:TaskEventsProvider|undefined;
 const original=chat.setTaskEvents.bind(chat);chat.setTaskEvents=value=>{provider=value;original(value)};
 const notifications:{projectId:string;taskId:string}[]=[];
 createHandler(store,folder,chat,undefined,undefined,(projectId,taskId)=>notifications.push({projectId,taskId}));
 try {
  const operation={taskId:task.id,phase:'requirements' as const,operationId:'example-operation',chatId:'example-chat',sendId:'example-send',packId:'example-pack',toolCallId:'example-call'};
  provider!.append!(project.id,{...operation,type:'tool.started',details:{toolName:'command'}});
  provider!.append!(project.id,{...operation,type:'tool.finished',details:{toolName:'command',result:'completed'}});
  expect(notifications).toEqual([{projectId:project.id,taskId:task.id},{projectId:project.id,taskId:task.id}]);
  provider!.append!(project.id,{type:'tool.started',operationId:'general-operation',taskId:null,phase:null});
  expect(notifications).toHaveLength(2);
  expect(provider!.events(project.id,task.id,0,undefined,1).events[0]?.type).toBe('task.created');
  expect(provider!.events(project.id,task.id,0,undefined,1,['tool.finished'])).toMatchObject({
   events:[{type:'tool.finished',operationId:operation.operationId}],hasMore:false
  });
  expect(()=>provider!.append!(project.id,{...operation,type:'invalid.event'})).toThrow();
  expect(notifications).toHaveLength(2);
  createServerOptions(store,folder,chat);
  const before=store.projectEventCursor(project.id);
  const version=writeTaskDocument(store,project.id,task.id,'requirements.md','Recorded tool edit');
  provider!.append!(project.id,{...operation,operationId:'another-operation',type:'tool.finished',details:{result:'completed'}});
  expect(store.projectEventCursor(project.id)).toBe(before+2);
  provider!.capture(project.id,task.id,'requirements',operation.operationId);
  expect(store.taskEvents(project.id,task.id).events).toContainEqual(expect.objectContaining({type:'document.updated',phase:'requirements',details:{revision:version.revision}}));
 } finally {store.close();await rm(folder,{recursive:true,force:true})}
});

test('instruction chat WS scope is accepted only by chat topic',()=>{
 const store=new Store(':memory:'),chat=new ChatService(()=>{throw Error('project resolution forbidden')});
 const {websocket}=createServerOptions(store,'/tmp',chat),sent:any[]=[];
 const socket={data:{ready:true,used:new Set<string>(),subscriptions:new Map()},readyState:1,getBufferedAmount:()=>0,send:(value:string)=>{sent.push(JSON.parse(value));return value.length},close:()=>{}} as any;
 try{
  const subscribe=(id:string,topic:string,scope:any)=>{websocket.message(socket,JSON.stringify({type:'subscribe',subscriptionId:id,topic,scope}));return sent.at(-1)};
  expect(subscribe('chat','chat',{projectId:'instructions',taskId:null}).type).toBe('subscribed');
  for(const topic of ['terminal','documents','task-events'])expect(subscribe(topic,topic,{projectId:'instructions',taskId:null})).toMatchObject({type:'error',code:'NOT_FOUND'});
  for(const scope of [{projectId:'instructions',taskId:null,phase:null},{projectId:'instructions',taskId:generateId('task'),phase:'requirements'},{projectId:'instructions',taskId:null,terminalId:'terminal'}])expect(subscribe(JSON.stringify(scope),'chat',scope)).toMatchObject({type:'error',code:'INVALID_MESSAGE'});
 }finally{websocket.close(socket);store.close()}
});


test('インストラクション反映は64 KiB本文のJSONエスケープを許可し、他APIと反映の上限を守る', async () => {
 const store=new Store(':memory:'),chat=new ChatService(()=>'/tmp',()=>null);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,undefined,chat)});
 const origin=`http://127.0.0.1:${server.port}`;
 const post=(path:string,body:string,requestOrigin=origin)=>fetch(origin+path,{method:'POST',headers:{origin:requestOrigin,'content-type':'application/json'},body});
 try {
  await chat.instructionEditorState();
  const content='#'+String.fromCharCode(1).repeat(65535);
  store.updateInstruction('editor',content,store.instructions().find(item=>item.key==='editor')!.content);
  const body=JSON.stringify({expected_content:content});
  expect(Buffer.byteLength(body)).toBeGreaterThan(65536);
  expect((await post('/api/instructions/apply',body,'https://example.com')).status).toBe(403);
  expect((await post('/api/instructions/apply',JSON.stringify({expected_content:content.slice(1)}))).status).toBe(409);
  const applied=await post('/api/instructions/apply',body);
  expect(applied.status).toBe(200);expect(await applied.json()).toEqual({editorState:{pending:false,busy:false}});
  expect(await chat.instructionEditorState()).toEqual({pending:false,busy:false});
  expect((await post('/api/projects',JSON.stringify({name:'x'.repeat(65536),folder:'/tmp/example'}))).status).toBe(413);
  const oversized=JSON.stringify({expected_content:'x'.repeat(65536*6+1024)});
  const handle=createHandler(store,undefined,chat);
  expect((await handle(new Request(origin+'/api/instructions/apply',{method:'POST',headers:{origin,'content-type':'application/json'},body:oversized}))).status).toBe(413);
  expect((await post('/api/instructions/apply',oversized)).status).toBe(413);
 } finally {await server.stop(true);store.close()}
});

test('プロジェクト内の実ファイルを階層ごとに一覧し、安全な範囲の本文を返す', async () => {
 const root = await mkdtemp(join(tmpdir(),'beni-project-files-'));
 const folder = join(root,'project'), outside = join(root,'outside');
 const store = new Store(':memory:');
 try {
  await mkdir(join(folder,'docs'),{recursive:true});
  await mkdir(join(folder,'node_modules'),{recursive:true});
  await mkdir(outside);
  await writeFile(join(folder,'.gitignore'),'node_modules\n');
  await writeFile(join(folder,'.env'),'PRIVATE=example');
  await writeFile(join(folder,'docs','設計.md'),'# 設計\n');
  await writeFile(join(folder,'docs','raw.bin'),new Uint8Array([0,1,255]));
  await writeFile(join(folder,'docs','large.txt'),'a'.repeat(1024*1024+1));
  await writeFile(join(outside,'file.txt'),'外側');
  await symlink(outside,join(folder,'external'));
  await symlink(join(outside,'file.txt'),join(folder,'docs','external.txt'));
  const project = store.createProject('Example',folder);
  const handle = createHandler(store,root,new ChatService(()=>folder,()=>null));
  const get = (endpoint:string,path:string,projectId=project.id,host='127.0.0.1:3210') =>
   handle(new Request(`http://${host}/api/${endpoint}?${new URLSearchParams({projectId,path})}`));
  expect(await (await get('project-files','')).json()).toEqual({
   entries:[{name:'docs',kind:'directory'},{name:'.gitignore',kind:'file'}],truncated:false
  });
  expect(await (await get('project-files','docs')).json()).toEqual({
   entries:[{name:'large.txt',kind:'file'},{name:'raw.bin',kind:'file'},{name:'設計.md',kind:'file'}],truncated:false
  });
  expect(await (await get('project-file','docs/設計.md')).json()).toEqual({kind:'text',content:'# 設計\n'});
  expect(await (await get('project-file','docs/raw.bin')).json()).toEqual({kind:'binary'});
  expect(await (await get('project-file','docs/large.txt')).json()).toEqual({kind:'too-large'});
  for (const path of ['../outside/file.txt',join(outside,'file.txt'),'docs//設計.md','docs\\設計.md','.env','node_modules/file.js']) {
   expect((await get('project-file',path)).status).toBe(400);
  }
  expect((await get('project-files','external')).status).toBe(404);
  expect((await get('project-file','external/file.txt')).status).toBe(404);
  expect((await get('project-file','docs/external.txt')).status).toBe(404);
  expect((await get('project-files','',generateId('project'))).status).toBe(404);
  expect((await get('project-file','docs/設計.md',project.id,'example.com')).status).toBe(403);
 } finally {
  store.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('保存先の集約で旧WAL・文書・会話アーカイブを保持し、既知の旧ファイルだけを削除する',async()=>{
 const {Database}=await import('bun:sqlite');
 const {createHash}=await import('node:crypto');
 const {newMetadata,writeJson}=await import('./data');
 const {captureProjectTaskHistory}=await import('./project-events');
 const {copyFile,rename}=await import('node:fs/promises');
 const {migrateChatStorage}=await import('./chat-migration');
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-storage-migration-')));
 const folder=join(root,'work'), source=join(folder,'.beni'), app=join(root,'beni.sqlite');
 const project=newMetadata('project','旧プロジェクト'), task=newMetadata('task','旧タスク');
 let store:Store|undefined,fixtureStore:Store|undefined;
 try {
  await mkdir(join(source,'tasks',task.id),{recursive:true});
  writeJson(join(source,'project.json'),project);
  writeJson(join(source,'tasks',task.id,'task.json'),{...task,phase:'requirements',status:'idle'});
  await writeFile(join(source,'tasks',task.id,'requirements.md'),'# 旧要件\r\n');
  await writeFile(join(source,'unknown.txt'),'残す');
  writeJson(join(source,'legacy-history.json'),{version:1,taskIdMap:{1:task.id},messages:[]});
  const livePath=join(source,'project.sqlite');
  const documentEvent=captureProjectTaskHistory(livePath,source,task.id,'requirements').events.find(event=>event.type==='document.created')!;
  const scratchPath=join(root,'snapshot.sqlite');
  await copyFile(livePath,scratchPath);
  const writer=new Database(scratchPath);
  try {
   writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
   writer.query('INSERT INTO events(id,type,at,task_id,details) VALUES (?,?,?,?,?)')
    .run(321,'task.renamed','2026-01-01T00:00:00.000Z',task.id,'{"name":"旧タスク"}');
   await copyFile(scratchPath,join(source,'events.sqlite'));
   await copyFile(scratchPath+'-wal',join(source,'events.sqlite-wal'));
  }finally{writer.close();}
  await rm(livePath);
  const fixtureFolder=join(root,'chat-fixture');await mkdir(fixtureFolder);
  fixtureStore=new Store(join(fixtureFolder,'beni.sqlite'));
  const legacyChat=new ChatService(()=>fixtureFolder,[new DummyAgent()]);
  legacyChat.setProjectStorage({chats:fixtureStore.chats,generation:()=>0,canRun:()=>true,workflowJobEvent:()=>'task.completed'});
  await legacyChat.send(project.id,null,'移行前の発言',null,folder);
  await waitUntil(async()=>(await legacyChat.get(project.id,null)).messages.at(-1)?.status==='completed');
  const archived=await legacyChat.get(project.id,null);
  await legacyChat.command(project.id,null,'clear',folder);
  const current=await legacyChat.get(project.id,null);
  const jobId='旧更新ジョブ', jobHash=createHash('sha256').update(jobId).digest('hex');
  legacyChat.setWorkflowTools({
   context:(_project,_task,_phase,id)=>id===jobId?{text:'指示更新',knowledge:''}:undefined,
   tools:()=>[],
   call:()=>undefined,
  });
  expect(await legacyChat.workflowJob(jobId,project.id,folder,'指示更新の発言','dummy',null)).toBe('completed');
  const jobSources=legacyChat.workflowSources(project.id,null,null,undefined,undefined,jobId);
  expect(jobSources?.packs).toHaveLength(2);
  await legacyChat.send(project.id,task.id,'タスクの旧発言',null,folder);
  await waitUntil(async()=>(await legacyChat.get(project.id,task.id)).messages.at(-1)?.status==='completed');
  const archivedTaskChat=await legacyChat.get(project.id,task.id);
  await legacyChat.command(project.id,task.id,'clear',folder);
  const currentTaskChat=await legacyChat.get(project.id,task.id);
  // 未確定の削除は集約先だけで復旧する。
  const staged=join(source,`.deleting-${task.id}`);
  await mkdir(staged);
  writeJson(join(staged,'journal.json'),{version:1,projectId:project.id,taskId:task.id});
  const oldChatRoot=join(source,'chat');
  const saveLegacy=async(path:string,chatId:string)=>{
   const saved=JSON.parse(await readFile(fixtureStore!.chats.path(chatId),'utf8'));
   const {chatId:_,...value}=saved;
   writeJson(path,{...value,id:chatId});
  };
  for(const directory of [join(oldChatRoot,'history'),join(oldChatRoot,'workflow-jobs'),join(oldChatRoot,task.id),join(source,'tasks',task.id,'history')])await mkdir(directory,{recursive:true});
  await saveLegacy(join(oldChatRoot,'general.json'),current.id);
  await saveLegacy(join(oldChatRoot,'history',archived.id+'.json'),archived.id);
  await saveLegacy(join(oldChatRoot,'workflow-jobs',jobHash+'.chat.json'),jobSources!.chatId);
  await saveLegacy(join(oldChatRoot,task.id,'requirements.json'),currentTaskChat.id);
  await saveLegacy(join(source,'tasks',task.id,'history',archivedTaskChat.id+'.chat.json'),archivedTaskChat.id);
  await rename(join(source,'tasks',task.id),join(staged,'task'));
  const jobs=new Store(app);
  jobs.enqueueInstructionJob({id:jobId,projectId:project.id,taskId:task.id,revision:'fixture',provider:'dummy',model:null});
  jobs.finishInstructionJob(jobId);
  jobs.close();
  const registry=new Database(app);
  registry.query('INSERT INTO projects(id,name,folder) VALUES (?,?,?)').run(project.id,'一覧の旧名',folder);
  registry.close();
  store=new Store(app);
  const central=store.legacyProjectDirectory(project.id);
  const databasePath=join(root,'projects',project.id+'.sqlite');
  expect(store.projectDatabasePath(project.id)).toBe(databasePath);
  expect(await Bun.file(databasePath).exists()).toBe(true);
  expect(await Bun.file(join(central,'project.sqlite')).exists()).toBe(false);
  migrateChatStorage(store.chats,store.dataDirectory,store.chatMigrationProjects());
  store.migrateTasks();
  store.close();store=new Store(app);
  const chat=new ChatService(()=>{throw Error('作業フォルダーを解決した');},[]);
  createHandler(store,folder,chat);
  expect(store.projects()).toEqual([{id:project.id,name:project.name,folder}]);
  expect(store.task(task.id)).toMatchObject({id:task.id,updatedAt:task.updatedAt});
  expect(store.projectEvent(project.id,321)).toMatchObject({id:321,taskId:task.id,details:{name:'旧タスク'}});
  expect(store.projectFileVersion(project.id,`.beni/tasks/${task.id}/requirements.md`,documentEvent.id)).toMatchObject({content:'# 旧要件\r\n'});
  expect(await Bun.file(store.chats.path(current.id)).exists()).toBe(true);
  await expect(stat(join(central,'chat'))).rejects.toThrow();
  expect(await Bun.file(store.chats.path(archived.id)).exists()).toBe(true);
  expect(await Bun.file(store.chats.path(jobSources!.chatId)).exists()).toBe(true);
  await expect(stat(join(central,'workflow-jobs'))).rejects.toThrow();
  expect((await chat.get(project.id,null)).id).toBe(current.id);
  expect(chat.workflowSources(project.id,null,null,archived.id)?.packs).toEqual(archived.packs);
  expect(chat.workflowSources(project.id,null,null,undefined,undefined,jobId)).toEqual(jobSources);
  expect((await chat.get(INSTRUCTIONS_CHAT_ID,null)).id).not.toBe(current.id);
  const editor=await chat.get(INSTRUCTIONS_CHAT_ID,null);
  expect(await Bun.file(store.chats.path(editor.id)).exists()).toBe(true);
  expect((await chat.get(project.id,task.id)).id).toBe(currentTaskChat.id);
  expect(chat.workflowSources(project.id,task.id,'requirements',archivedTaskChat.id)?.packs).toEqual(archivedTaskChat.packs);
  expect(await Bun.file(join(central,'legacy-history.json')).exists()).toBe(true);
  expect(await Bun.file(join(central,'project.json')).exists()).toBe(false);
  expect(await Bun.file(join(source,'project.json')).exists()).toBe(false);
  expect(await Bun.file(join(source,'events.sqlite-wal')).exists()).toBe(false);
  expect(await readFile(join(source,'unknown.txt'),'utf8')).toBe('残す');
  expect(await readFile(join(central,'.migration-extras','unknown.txt'),'utf8')).toBe('残す');
  store.close();store=undefined;
  store=new Store(app);
  expect(store.projectEvent(project.id,321)?.id).toBe(321);
  expect(store.managedDocument(project.id,task.id,'requirements.md')?.content).toBe('# 旧要件\r\n');
  expect(store.chats.read({projectId:project.id,taskId:null,phase:null})?.id).toBe(current.id);
  await expect(stat(join(central,'chat'))).rejects.toThrow();
 }finally{store?.close();fixtureStore?.close();await rm(root,{recursive:true,force:true});}
});

test('保存先の集約で確定直前・削除途中を再開し、移行元の変更や未検証の衝突を隔離する',async()=>{
 const {Database}=await import('bun:sqlite');
 const {newMetadata,writeJson}=await import('./data');
 const {migrationVerification,stageProjectMigration}=await import('./store/project-migration');
 const {flattenProjectDatabase}=await import('./store/flat-project-migration');
 const {rename,link}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-storage-retry-')));
 const app=join(root,'beni.sqlite'), projects=join(root,'projects');
 let store:Store|undefined;
 try {
  store=new Store(app);
  const otherFolder=join(root,'other');await mkdir(otherFolder);
  const other=store.createProject('健全',otherFolder), task=store.createTask(other.id,'閲覧できる');
  store.close();store=undefined;
  const registry=new Database(app);
  const sources=[];
  try {
   for(const situation of ['renamed','cleanup','changed','collision','linked','missing'] as const){
    const project=newMetadata('project',situation), folder=join(root,situation), source=join(folder,'.beni');
    const destination=join(projects,project.id), staging=`.migration-${crypto.randomUUID()}`, stage=join(projects,staging);
    registry.query('INSERT INTO projects(id,name,folder) VALUES (?,?,?)').run(project.id,project.name,folder);
    sources.push({situation,project,folder,source,destination});
    if(situation==='missing')continue;
    await mkdir(source,{recursive:true});
    writeJson(join(source,'project.json'),project);
    await writeFile(join(source,'knowledge.md'),'# 初期ナレッジ\n');
    if(situation==='linked'){
     await link(join(source,'knowledge.md'),join(root,'external.md'));
     continue;
    }
    if(situation==='collision'){
     await mkdir(destination);
     await writeFile(join(destination,'keep.txt'),'既存データ');
     continue;
    }
    if(situation==='renamed'){
     await mkdir(join(source,'chat'));
     writeJson(join(source,'chat','general.json'),{
      version:1,id:crypto.randomUUID(),projectId:project.id,taskId:null,phase:null,lastEventId:0,
      selectedModel:null,threadId:null,sessionId:null,messages:[],packs:[],
     });
    }
    await mkdir(stage);
    const {sourceInventory}=stageProjectMigration(source,stage,project.id);
    if(situation==='renamed'){
     // 旧版が旧ファイル名で検証・記録した集約先を再現する。
     await mkdir(join(stage,'chat'));
     await rename(join(stage,'general.chat.json'),join(stage,'chat','general.json'));
    }
    const verification=migrationVerification(stage);
    await rename(stage,destination);
    registry.query('INSERT INTO project_storage(project_id,state,source,staging,sourceInventory,verification) VALUES (?,?,?,?,?,?)')
     .run(project.id,situation==='cleanup'?'ready':'prepared',source,staging,sourceInventory,verification);
    if(situation==='cleanup'){
     flattenProjectDatabase(destination,join(projects,project.id+'.sqlite'),project.id);
     await rm(join(source,'knowledge.md'));
    }
    if(situation==='changed')await writeFile(join(source,'knowledge.md'),'# コピー後に更新\n');
   }
  }finally{registry.close();}
  store=new Store(app);
  expect(store.task(task.id)?.name).toBe(task.name);
  for(const entry of sources){
   const {situation,project,source,destination}=entry;
   if(situation==='renamed'||situation==='cleanup'){
    expect(store.project(project.id)?.storageError).toBeUndefined();
    expect(store.managedDocument(project.id,null,'knowledge.md')?.content).toBe('# 初期ナレッジ\n');
    expect(await Bun.file(join(destination,'project.json')).exists()).toBe(false);
    await expect(stat(source)).rejects.toThrow();
   } else {
    expect(store.project(project.id)?.storageError).toBeTruthy();
    expect(()=>store!.projectDatabasePath(project.id)).toThrow();
    if(situation!=='missing')expect(await Bun.file(join(source,'project.json')).exists()).toBe(true);
   }
   if(situation==='renamed'){
    const {migrateChatStorage}=await import('./chat-migration');
    migrateChatStorage(store.chats,store.dataDirectory,[{projectId:project.id,directory:destination,databasePath:store.projectDatabasePath(project.id)}]);
    expect(store.chats.read({projectId:project.id,taskId:null,phase:null})).toBeDefined();
    await expect(stat(join(destination,'chat'))).rejects.toThrow();
   }
   if(situation==='changed')expect(await readFile(join(source,'knowledge.md'),'utf8')).toBe('# コピー後に更新\n');
   if(situation==='collision')expect(await readFile(join(destination,'keep.txt'),'utf8')).toBe('既存データ');
   if(situation==='missing'){
    const moved=join(root,'found');await mkdir(join(moved,'.beni'),{recursive:true});
    writeJson(join(moved,'.beni','project.json'),project);
    expect(store.changeProjectFolder(project.id,moved)).toEqual({id:project.id,name:project.name,folder:moved});
   }
  }
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('作業フォルダー変更は実行と排他し、消失後も履歴を読み、同じ会話を新しいcwdの新規セッションへ引き継ぐ',async()=>{
 const {rename}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-storage-folder-')));
 const original=join(root,'original'), replacement=join(root,'replacement'), moved=join(root,'moved');
 await mkdir(original);await mkdir(replacement);
 const store=new Store(join(root,'beni.sqlite'));
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const agent=new DummyAgent({scenario:async(_request,host,accept)=>{
  await accept();
  await gate;
  await host.emit({type:'context.usage',data:{usedTokens:300,maxTokens:1000}});
  await host.emit({type:'text.completed',itemId:'reply',text:'返信'});
  return {status:'completed'};
 }});
 const chat=new ChatService(id=>store.workingFolder(id),[agent]);
 const handle=createHandler(store,root,chat), address='http://127.0.0.1:3210';
 const get=(path:string)=>handle(new Request(address+path));
 const post=(path:string,data:unknown)=>handle(jsonPost(path,data));
 try {
  const project=store.createProject('作業場所',original), task=store.createTask(project.id,'文書');
  const folderPath=`/api/projects/${project.id}/folder`, send={projectId:project.id,content:'最初の発言',model:null};
  expect((await post('/api/chat/send',send)).status).toBe(202);
  expect((await post(folderPath,{folder:replacement})).status).toBe(409);
  release();
  await waitUntil(async()=>(await chat.get(project.id,null)).messages.at(-1)?.status==='completed');
  const previous=await chat.get(project.id,null);
  expect(previous.threadId).not.toBeNull();
  expect(previous.contextUsage?.usedTokens).toBe(300);
  expect(await Bun.file(join(original,'.beni','project.json')).exists()).toBe(false);
  await rename(original,moved);
  expect((await (await get('/api/state')).json()).projects).toEqual([{...project,folderAvailable:false}]);
  expect((await get(`/api/tasks/${task.id}`)).status).toBe(200);
  expect((await (await get(`/api/chat?projectId=${project.id}`)).json()).id).toBe(previous.id);
  expect((await post('/api/chat/send',send)).status).toBe(409);
  expect((await post('/api/terminals',{projectId:project.id,requestId:'example'})).status).toBe(409);
  expect((await post(folderPath,{folder:'relative'})).status).toBe(400);
  expect((await post(`/api/projects/${generateId('project')}/folder`,{folder:replacement})).status).toBe(404);
  const other=store.createProject('別',replacement);
  expect((await post(folderPath,{folder:other.folder})).status).toBe(409);
  const foreign=join(root,'foreign');await mkdir(join(foreign,'.beni'),{recursive:true});
  const {newMetadata,writeJson}=await import('./data');
  writeJson(join(foreign,'.beni','project.json'),newMetadata('project','別ID'));
  expect((await post(folderPath,{folder:foreign})).status).toBe(409);
  const response=await post(folderPath,{folder:moved});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({...project,folder:moved});
  const cleared=await chat.get(project.id,null);
  expect(cleared).toMatchObject({id:previous.id,threadId:null,messages:previous.messages,packs:previous.packs});
  expect(cleared.contextUsage).toBeUndefined();
  expect((await post('/api/chat/send',{...send,content:'次の発言'})).status).toBe(202);
  await waitUntil(async()=>(await chat.get(project.id,null)).messages.at(-1)?.status==='completed');
  expect(agent.requests.at(-1)).toMatchObject({cwd:moved,target:{mode:'new'}});
  expect((await chat.get(project.id,null)).messages.slice(0,2)).toEqual(previous.messages);
 }finally{release();store.close();await rm(root,{recursive:true,force:true});}
});

test('旧配置のファイル名を整理する際、既知の会話だけを移して衝突元を保全する',async()=>{
 const {link,symlink}=await import('node:fs/promises');
 const {workflowJobHash,migrateProjectChats,migrateInstructionChats}=await import('./chat-files');
 const root=await realpath(await mkdtemp(join(tmpdir(),'beni-chat-filename-')));
 let store:Store|undefined;
 try {
  const app=join(root,'beni.sqlite');
  store=new Store(app);
  const work=join(root,'work'), other=join(root,'other'), linked=join(root,'linked');
  await Promise.all([work,other,linked].map(path=>mkdir(path)));
  const project=store.createProject('通常',work), task=store.createTask(project.id,'依頼');
  const collision=store.createProject('衝突',other), linkProject=store.createProject('リンク',linked);
  const collisionTask=store.createTask(collision.id,'衝突する依頼');
  const projectRoot=store.legacyProjectDirectory(project.id), taskRoot=join(projectRoot,'tasks',task.id);
  const collisionTaskRoot=join(store.legacyProjectDirectory(collision.id),'tasks',collisionTask.id);
  await mkdir(taskRoot,{recursive:true});
  await mkdir(collisionTaskRoot,{recursive:true});
  const projectChats=join(projectRoot,'chat');
  const collisionChats=join(store.legacyProjectDirectory(collision.id),'chat'), linkedChats=join(store.legacyProjectDirectory(linkProject.id),'chat');
  const appChats=join(root,'chat'), archive='019a0000-0000-4000-8000-000000000001';
  const files=[
   join(projectChats,'general'),join(projectChats,'history',archive),join(projectChats,task.id,'requirements'),
   join(projectChats,task.id,'history',archive),join(projectChats,'workflow-jobs','a'.repeat(64)),
   join(appChats,'instructions'),join(appChats,'history',archive),join(appChats,'instruction-history',archive),
  ];
  const bytes=' { "data": "既存" }\r\n';
  for(const stem of files){
   await mkdir(join(stem,'..'),{recursive:true});
   await writeFile(stem+'.json',bytes);
  }
  // 旧名変更と新しい保存先への移動がリンク作成直後に停止した状態から再開する。
  await link(files[0]+'.json',files[0]+'.chat.json');
  await link(files[2]+'.json',join(taskRoot,'requirements.chat.json'));
  await mkdir(join(projectRoot,'workflow-jobs'));
  await link(files[4]+'.json',join(projectRoot,'workflow-jobs','a'.repeat(64)+'.chat.json'));
  const job={id:'job',projectId:project.id,taskId:task.id,revision:'fixture',provider:'dummy',model:null};
  const missing={...job,id:'missing-task',taskId:generateId('task')};
  const taskOnly={...job,id:'task-only'};
  const fromCanonical={...job,id:'canonical-hash'};
  const unsafeJobs=['../escape','nested\\escape','あ'.repeat(83)].map(id=>({...job,id}));
  const jobBytes=(id:string)=>JSON.stringify({
   version:1,id:'fixture-conversation',projectId:project.id,taskId:null,phase:null,workflowJobId:id,messages:[],packs:[]
  });
  const oldJob=join(projectRoot,'workflow-jobs',workflowJobHash(job.id)+'.json');
  const oldTaskJob=join(taskRoot,'workflow-jobs',workflowJobHash(job.id)+'.chat.json');
  const workflowFolder=join(projectRoot,'workflows','task.completed');
  const canonical=(id:string)=>join(workflowFolder,id+'.chat.json');
  const hashedCanonical=(id:string)=>canonical(workflowJobHash(id));
  const orphan=join(projectRoot,'workflow-jobs',workflowJobHash(missing.id)+'.chat.json');
  for(const entry of [job,missing,taskOnly,fromCanonical,...unsafeJobs]){
   store.enqueueInstructionJob(entry);
   store.finishInstructionJob(entry.id);
  }
  await writeFile(oldJob,jobBytes(job.id));
  await writeFile(orphan,jobBytes(missing.id));
  await mkdir(join(taskRoot,'workflow-jobs'));
  await link(oldJob,oldTaskJob);
  await mkdir(workflowFolder,{recursive:true});
  await link(oldJob,hashedCanonical(job.id));
  await link(oldJob,canonical(job.id));
  await writeFile(hashedCanonical(fromCanonical.id),jobBytes(fromCanonical.id));
  for(const {id} of unsafeJobs)await writeFile(hashedCanonical(id),jobBytes(id));
  await writeFile(join(taskRoot,'workflow-jobs',workflowJobHash(taskOnly.id)+'.json'),jobBytes(taskOnly.id));
  await writeFile(join(projectChats,'notes.json'),'管理外');
  await writeFile(join(projectChats,task.id,'notes.json'),'タスク会話の管理外');
  await writeFile(join(projectChats,task.id,'history','notes.json'),'履歴の管理外');
  await writeFile(join(projectChats,task.id+'.json'),'旧フラット会話');
  await mkdir(join(collisionChats,collisionTask.id),{recursive:true});
  await writeFile(join(collisionChats,collisionTask.id,'requirements.json'),'旧');
  await writeFile(join(collisionTaskRoot,'requirements.chat.json'),'新');
  await mkdir(linkedChats,{recursive:true});
  const outside=join(root,'outside.json');
  await writeFile(outside,'外部');
  await symlink(outside,join(linkedChats,'general.json'));
  store.close();
  store=new Store(app);
  const jobTarget=(stem:string,hashed:boolean)=>{
   const match=[job,missing,taskOnly,fromCanonical,...unsafeJobs].find(item=>(hashed?workflowJobHash(item.id):item.id)===stem);
   return match&&{jobId:match.id,taskId:match.taskId};
  };
  migrateProjectChats(projectRoot,project.id,jobTarget);
  migrateInstructionChats(root);
  expect(store.project(project.id)?.storageError).toBeUndefined();
  expect(store.task(task.id)?.name).toBe(task.name);
  for(const {id} of [job,missing,taskOnly,fromCanonical]){
   expect(await readFile(canonical(id),'utf8')).toBe(jobBytes(id));
   await expect(stat(hashedCanonical(id))).rejects.toThrow();
  }
  for(const {id} of unsafeJobs){
   expect(await readFile(hashedCanonical(id),'utf8')).toBe(jobBytes(id));
  }
  await expect(stat(oldJob)).rejects.toThrow();
  await expect(stat(orphan)).rejects.toThrow();
  await expect(stat(join(taskRoot,'workflow-jobs'))).rejects.toThrow();
  await expect(stat(join(projectRoot,'tasks',missing.taskId))).rejects.toThrow();
  const destinations=files.map(stem=>stem.replace(join(projectChats,task.id)+'/',taskRoot+'/').replace(projectChats+'/',projectRoot+'/'));
  for(const [index,stem] of files.entries()){
   expect(await readFile(destinations[index]+'.chat.json','utf8')).toBe(bytes);
   if(index===4)expect(await readFile(stem+'.json','utf8')).toBe(bytes);
   else await expect(stat(stem+'.json')).rejects.toThrow();
  }
  expect(await readFile(join(projectChats,'notes.json'),'utf8')).toBe('管理外');
  expect(await readFile(join(projectChats,task.id,'notes.json'),'utf8')).toBe('タスク会話の管理外');
  expect(await readFile(join(projectChats,task.id,'history','notes.json'),'utf8')).toBe('履歴の管理外');
  expect(await readFile(join(projectChats,task.id+'.json'),'utf8')).toBe('旧フラット会話');
  await expect(stat(join(projectChats,'history'))).rejects.toThrow();
  expect((await stat(join(projectChats,'workflow-jobs'))).isDirectory()).toBe(true);
  expect(()=>migrateProjectChats(store!.legacyProjectDirectory(collision.id),collision.id,()=>undefined)).toThrow();
  expect(await readFile(join(collisionChats,collisionTask.id,'requirements.json'),'utf8')).toBe('旧');
  expect(await readFile(join(collisionTaskRoot,'requirements.chat.json'),'utf8')).toBe('新');
  expect(()=>migrateProjectChats(store!.legacyProjectDirectory(linkProject.id),linkProject.id,()=>undefined)).toThrow();
  expect(await readFile(outside,'utf8')).toBe('外部');
  expect(await Bun.file(join(store.legacyProjectDirectory(linkProject.id),'general.chat.json')).exists()).toBe(false);
  store.close();
  store=new Store(app);
  expect(store.project(project.id)?.storageError).toBeUndefined();
  expect(await readFile(canonical(fromCanonical.id),'utf8')).toBe(jobBytes(fromCanonical.id));
 }finally{store?.close();await rm(root,{recursive:true,force:true});}
});

test('チャットIDで取得すると用途と所有者を照合し、欠落したチャットを作り直さない',async()=>{
 const root=await mkdtemp(join(tmpdir(),'beni-chat-lookup-')),store=new Store(':memory:');
 try{
  const otherFolder=join(root,'other');await mkdir(otherFolder);
  const project=store.createProject('Project',root),other=store.createProject('Project',otherFolder);
  const task=store.createTask(project.id,'Task');
  const chat=new ChatService(()=>root,[]);
  const handler=createHandler(store,root,chat);
  const get=(projectId:string,params:Record<string,string>={})=>handler(new Request(
   'http://127.0.0.1:3210/api/chat?'+new URLSearchParams({projectId,...params})
  ));
  const alternate=new ChatService(()=>root,[]);
  createHandler(store,root,alternate);
  const [initial,concurrent,otherChat]=await Promise.all([
   chat.get(project.id,null),alternate.get(project.id,null),chat.get(other.id,null)
  ]);
  const scope={projectId:project.id,taskId:null,phase:null};
  expect(concurrent.id).toBe(initial.id);
  expect(store.chats.list(scope)).toHaveLength(1);
  expect(validChatId(initial.id)).toBe(true);
  expect(otherChat.id).not.toBe(initial.id);
  await chat.command(project.id,null,'clear',root);
  const current=await chat.get(project.id,null);
  expect(current.id).not.toBe(initial.id);
  expect(await (await get(project.id,{chatId:initial.id})).json()).toMatchObject({id:initial.id});
  expect((await get(other.id,{chatId:initial.id})).status).toBe(404);
  expect((await get(project.id,{chatId:initial.id,taskId:task.id,phase:'requirements'})).status).toBe(404);

  const path=store.chats.path(current.id),bytes=await readFile(path,'utf8');
  await writeFile(path,JSON.stringify({...JSON.parse(bytes),chatId:initial.id}));
  expect((await get(project.id,{chatId:current.id})).status).toBe(500);
  await rm(path);
  expect((await get(project.id)).status).toBe(500);
  expect(store.chats.current(scope)?.chatId).toBe(current.id);
  expect(await Bun.file(path).exists()).toBe(false);
  await writeFile(path,bytes);
  expect(await (await get(project.id)).json()).toMatchObject({id:current.id});
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
