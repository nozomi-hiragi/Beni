import { test, expect } from 'bun:test';
// Bun supports headers in its client constructor; DOM types expose only protocols.
const Socket = globalThis.WebSocket as unknown as {new(url:string,options:Bun.WebSocketOptions):WebSocket};
import { generateId, validProjectId, validTaskId } from '../shared/ids';
import { INSTRUCTIONS_CHAT_ID } from '../shared/communication';
import { Store } from './store/index';
import { ChatService, type TaskEventsProvider } from './chat';
import { createHandler, createServerOptions, dataPaths } from './server';
import { withDatabase } from './project-events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const fakeCodex=join(import.meta.dir,'test/fake-codex.ts');
const fixtureRequest='入力の形式を検証してください。';
const waitUntil=async(check:()=>boolean|Promise<boolean>)=>{
 for(let i=0;i<150;i++){if(await check())return;await Bun.sleep(20)}
 throw Error('条件を満たすまでに時間切れになりました');
};
const waitForFailedReview=(folder:string,t:string)=>waitUntil(()=>withDatabase(folder,db=>{
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
  for (const path of ['/settings', '/instructions', `/project/${generateId('project')}`, `/project/${generateId('project')}?task=${generateId('task')}`]) {
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


test('新規タスク文書はDBを正本とし、後から置いたMarkdownを取り込まない', async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-documents-'));const store=new Store(':memory:');
 const handle=createHandler(store,folder,new ChatService(()=>folder,()=>null));
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'New task');
 const detail=async(id:string)=>(await handle(new Request(`http://127.0.0.1:3210/api/tasks/${id}`))).json();
 try{
  const base=join(folder,'.beni','tasks',task.id);
  const documents=(await detail(task.id)).documents;
  expect(documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# New task\n');
  expect(documents.find((doc:any)=>doc.name==='implementation.md').content).toContain('# Implementation plan');
  for(const name of ['requirements.md','documents.md','implementation.md'])expect(await Bun.file(join(base,name)).exists()).toBe(false);
  await writeFile(join(base,'requirements.md'),'# 外部で置いたファイル\n');
  writeTaskDocument(store,project.id,task.id,'requirements.md','# DBの正本\n');
  const second=store.createTask(project.id,'Second');
  expect((await detail(second.id)).documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# Second\n');
  expect((await detail(task.id)).documents.find((doc:any)=>doc.name==='requirements.md').content).toBe('# DBの正本\n');
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
 const post=(taskId:string|null,content:string)=>handle(new Request('http://127.0.0.1:3210/api/chat/send',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,taskId,phase:taskId===null?null:'requirements',content,model:null})}));
 try{
  const path=join(folder,'.beni','tasks',task.id,'task.json');const value=JSON.parse(await readFile(path,'utf8'));value.createdAt=null;value.updatedAt=null;await writeFile(path,JSON.stringify(value));
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
 const post=(path:string,data:unknown)=>handle(new Request(`http://127.0.0.1:3210${path}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try {
  const project=store.createProject('Example',folder);const task=store.createTask(project.id,'Before');
  const file=join(folder,'.beni','tasks',task.id,'task.json');
  const before=JSON.parse(await readFile(file,'utf8'));before.updatedAt=null;before.extra={retained:true};await writeFile(file,JSON.stringify(before));
  for(const name of ['', '  ', 42, null]) expect((await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name})).status).toBe(400);
  expect((await post(`/api/tasks/${task.id}/rename`,{projectId:generateId('project'),name:'After'})).status).toBe(404);
  expect((await post('/api/tasks/invalid/rename',{projectId:project.id,name:'After'})).status).toBe(404);
  expect(JSON.parse(await readFile(file,'utf8'))).toEqual(before);
  const response=await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name:'  After  '});expect(response.status).toBe(200);
  const result=await response.json();expect(result.name).toBe('After');expect(result.id).toBe(task.id);expect(result.updatedAt).toBeTruthy();
  const after=JSON.parse(await readFile(file,'utf8'));expect(after).toEqual({...before,name:'After',updatedAt:result.updatedAt});
  expect((await post(`/api/tasks/${task.id}/rename`,{projectId:project.id,name:' After '})).status).toBe(200);
  expect(JSON.parse(await readFile(file,'utf8'))).toEqual(after);
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
  const post=(projectId:unknown,origin='http://127.0.0.1:3210')=>handle(new Request(`http://127.0.0.1:3210/api/tasks/${t.id}/delete`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({projectId})}));
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
 const post=(path:string,data:unknown)=>handle(new Request(`http://127.0.0.1:3210${path}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
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
 const post=(path:string,input:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(input)}));
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
 const post=(action:string,input:object)=>handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}/${action}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,...input})}));
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
  const unavailable=createHandler(store,folder,new ChatService(()=>folder,()=>null));
  const failed=await unavailable(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}/start`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,phase:'implementation',model:null})}));
  expect(failed.status).toBe(400);expect(store.task(task.id)!.phase).toBe('implementation');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('Claude の状態・送信と実装開始は接続先を検証して引き継ぐ',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-claude-http-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>null,()=>join(import.meta.dir,'test/fake-claude.ts')),handle=createHandler(store,folder,chat);
 const post=(path:string,input:object)=>handle(new Request(`http://127.0.0.1:3210${path}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,...input})}));
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
  await waitForFailedReview(folder,task.id);
  expect((await post(`/api/tasks/${task.id}/stop`,{phase:'execution'})).status).toBe(409);
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});

test('文書の引用を照合し、精査から終了後のインストラクション更新まで実行する',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-doc-workflow-')),store=new Store(':memory:');
 const project=store.createProject('Example',folder),task=store.createTask(project.id,'Task');
 const chat=new ChatService(()=>folder,()=>fakeCodex),handle=createHandler(store,folder,chat);
 const address='http://127.0.0.1:3210',taskPath=`/api/tasks/${task.id}`;
 const post=(path:string,input:object)=>handle(new Request(address+path,{method:'POST',headers:{origin:address,'content-type':'application/json'},body:JSON.stringify({projectId:project.id,...input})}));
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
  expect(review.workflow.review.remaining).toBe(0);
  expect(document('retrospective.md').content).toContain('検証の根拠を見直す。');
  const reviewPacks=chat.workflowSources(project.id,task.id,'retrospective')!.packs;
  expect(reviewPacks.some(pack=>pack.tool?.name==='review_next'&&pack.tool.output.includes(fixtureRequest))).toBe(true);
  expect(reviewPacks.some(pack=>pack.tool?.name==='record_review'&&pack.status==='completed')).toBe(true);

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
  expect(await Bun.file(join(folder,'.beni','knowledge.md')).exists()).toBe(false);
  expect(store.instructionDocument('common')?.items.at(-1)).toMatchObject({
   text:'- 検証の根拠を記録する。',sources:[{kind:'document',revision:knowledge.revision,text:'検証の根拠を保つ。'}]
  });
  expect(chat.workflowSources(project.id,null,null)).toBeUndefined();
  expect(chat.workflowSources(project.id,null,null,undefined,undefined,job.id)?.packs.some(pack=>(
   pack.tool?.name==='finish_instruction_update'&&pack.status==='completed'))).toBe(true);
  expect((await post(taskPath+'/reopen',{phase:'finalization'})).status).toBe(200);
  expect(store.task(task.id)).toMatchObject({phase:'retrospective',status:'idle'});
  expect((await knowledgeLookup(knowledge.revision,knowledgeItem.id)).status).toBe(404);
 }finally{unsubscribe();delete process.env.FAKE_CODEX_WORKFLOW;store.close();await rm(folder,{recursive:true,force:true})}
},15000);

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
 const post=(id:string,action:string,input:object)=>handle(new Request(`http://127.0.0.1:3210/api/tasks/${id}/${action}`,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({projectId:project.id,...input})}));
 try {
  for(const [action,status] of [['fail','failed'],['disconnect','unknown']] as const){
   const task=store.createTask(project.id,action);writeTaskDocument(store,project.id,task.id,'implementation.md','# Plan\nImplement.');
   process.env.FAKE_CODEX_TURN_ACTION=action;
   expect((await post(task.id,'start',{phase:'requirements',model:null})).status).toBe(200);
   for(let i=0;i<100&&store.task(task.id)!.phase==='execution';i++)await Bun.sleep(20);
   expect(store.task(task.id)!.phase).toBe('retrospective');
   expect((await chat.get(project.id,task.id,'execution')).messages.at(-1)?.status).toBe(status);
   await waitForFailedReview(folder,task.id);
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
  await chat.send(project.id,task.id,'hello',null,folder,store.taskDocumentFolder(project.id,task.id),'requirements');await wait(task.id,'requirements');
  store.selectTaskPhase(project.id,retro.id,'requirements','retrospective');
  await chat.send(project.id,retro.id,'hello',null,folder,store.taskDocumentFolder(project.id,retro.id),'retrospective');await wait(retro.id,'retrospective');
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
