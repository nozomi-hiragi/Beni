import { test, expect } from 'bun:test';
import { Store } from './store/index';
import { createHandler, dataPaths } from './server';
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
  expect((await post(`/api/tasks/${task.id}/messages`,{content:'  原文\n'})).status).toBe(201);
  const detail=await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();
  expect(detail.messages[0].content).toBe('  原文\n');expect(detail.documents[0].content).toBe('# Sample\n');
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
  expect(await page.text()).toContain('/ui/build/app.js');
  const js = await handle(new Request('http://127.0.0.1:3210/ui/build/app.js'));
  expect(js.status).toBe(200);
  expect((await js.text()).length).toBeGreaterThan(1000);
  const css = await handle(new Request('http://127.0.0.1:3210/ui/generated.css'));
  expect(css.status).toBe(200);
  expect(await css.text()).toContain('.btn-primary');
 } finally { store.close(); }
});

test('serves SPA entry for supported direct URLs without intercepting API or other paths', async () => {
 const store = new Store(':memory:');
 try {
  const handle = createHandler(store);
  for (const path of ['/settings', '/project/1', '/project/42?task=10']) {
   const response = await handle(new Request(`http://127.0.0.1:3210${path}`));
   expect(response.status).toBe(200);
   expect(await response.text()).toContain('/ui/build/app.js');
  }
  for (const path of ['/project', '/project/0', '/settings/extra', '/api/missing']) {
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


test('creates task Markdown, seeds latest legacy documents once, and previews real file updates', async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-documents-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(path:string,data:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 const detail=async(id:number)=>(await handle(new Request(`http://127.0.0.1:3210/api/tasks/${id}`))).json();
 try{
  const project=await (await post('/api/projects',{name:'Example',folder})).json();
  const task=await (await post('/api/tasks',{name:'New task',projectId:project.id})).json();
  const base=join(folder,'.beni','tasks',String(task.id));
  expect(await readFile(join(base,'requirements.md'),'utf8')).toBe('# New task\n');
  expect(await readFile(join(base,'implementation-plan.md'),'utf8')).toContain('# Implementation plan');
  await writeFile(join(base,'requirements.md'),'# Actual file\n');
  expect((await detail(task.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Actual file\n');
  const legacy=store.createTask(project.id,'Legacy') as {id:number};store.saveDocument(legacy.id,'requirements','# Latest saved version\n',1);
  expect((await detail(legacy.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Latest saved version\n');
  store.saveDocument(legacy.id,'requirements','# DB no longer authoritative\n',2);
  expect((await detail(legacy.id)).documents.find((d:any)=>d.name==='requirements.md').content).toBe('# Latest saved version\n');
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
  await symlink(outside,join(tasks,'1'));expect(()=>taskDocuments(folder,1,{requirements:'no'})).toThrow();
  await mkdir(join(tasks,'2'));await writeFile(join(outside,'requirements.md'),'untouched');await symlink(join(outside,'requirements.md'),join(tasks,'2','requirements.md'));
  expect(()=>taskDocuments(folder,2,{requirements:'no'})).toThrow();
  expect(()=>readTaskDocuments(join(tasks,'2'))).toThrow();
  expect(await readFile(join(outside,'requirements.md'),'utf8')).toBe('untouched');
  const another=join(root,'another');await mkdir(another);await mkdir(join(another,'.beni'));await symlink(outside,join(another,'.beni','tasks'));
  expect(()=>projectDocuments(another)).toThrow();
 }finally{store.close();await rm(root,{recursive:true,force:true})}
});

test('rolls back failed task creation and preserves existing documents on ID collision',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-document-collision-'));const store=new Store(':memory:');const handle=createHandler(store);
 const post=(path:string,data:unknown)=>handle(new Request('http://127.0.0.1:3210'+path,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(data)}));
 try{
  const project=await (await post('/api/projects',{name:'Example',folder})).json();
  const existing=join(folder,'.beni','tasks','1');await mkdir(existing);await writeFile(join(existing,'requirements.md'),'preserve');
  expect((await post('/api/tasks',{name:'Collision',projectId:project.id})).status).toBe(400);
  expect(store.tasks()).toHaveLength(0);expect(store.documents(1)).toHaveLength(0);
  expect(await readFile(join(existing,'requirements.md'),'utf8')).toBe('preserve');
  // Removing only this fixture's collision demonstrates the rolled-back task can be created normally.
  await rm(existing,{recursive:true});
  expect((await post('/api/tasks',{name:'Retry',projectId:project.id})).status).toBe(201);
  expect(store.tasks()).toHaveLength(1);expect(await readFile(join(existing,'requirements.md'),'utf8')).toBe('# Retry\n');
 }finally{store.close();await rm(folder,{recursive:true,force:true})}
});


test('document SSE validates scope, detects atomic replacement, resyncs and closes on abort',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'beni-events-'));const store=new Store(':memory:');const handle=createHandler(store);
 const project=store.createProject('Example',folder) as {id:number};const other=store.createProject('Other',folder) as {id:number};const task=store.createTask(project.id,'Task') as {id:number};
 const url=`http://127.0.0.1:3210/api/tasks/${task.id}/documents/events?projectId=${project.id}`;
 const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 try{
  expect((await handle(new Request(url.replace(`projectId=${project.id}`,`projectId=${other.id}`)))).status).toBe(404);
  expect((await handle(new Request(url,{headers:{origin:'https://example.com'}}))).status).toBe(403);
  const response=await handle(new Request(url,{signal:abort.signal}));expect(response.headers.get('content-type')).toBe('text/event-stream');reader=response.body!.getReader();
  const decode=(value:Uint8Array|undefined)=>new TextDecoder().decode(value);
  expect(decode((await reader.read()).value)).toContain('event: change');
  const path=join(folder,'.beni','tasks',String(task.id));await writeFile(join(path,'replacement.tmp'),'# Atomic replacement');await rename(join(path,'replacement.tmp'),join(path,'requirements.md'));
  const changed=await Promise.race([reader.read(),Bun.sleep(1500).then(()=>{throw Error('Missing file event')})]);expect(decode(changed.value)).toContain('event: change');
  abort.abort();expect((await reader.read()).done).toBe(true);
  await writeFile(join(path,'requirements.md'),'# While disconnected');
  const reconnect=await handle(new Request(url));const again=reconnect.body!.getReader();expect(decode((await again.read()).value)).toContain('event: change');await again.cancel();
  const detail=await (await handle(new Request(`http://127.0.0.1:3210/api/tasks/${task.id}`))).json();expect(detail.documents.find((d:any)=>d.name==='requirements.md').content).toBe('# While disconnected');
 }finally{abort.abort();store.close();await rm(folder,{recursive:true,force:true})}
});

test('change streams coalesce continuous updates without starvation and release subscriptions',async()=>{
 const {changeEvents}=await import('./events');let changed=()=>{},closed=0;
 const abort=new AbortController();const response=changeEvents(new Request('http://127.0.0.1/events',{signal:abort.signal}),notify=>{changed=notify;return()=>{closed++}});
 const reader=response.body!.getReader();await reader.read();const timer=setInterval(changed,15);
 try{
  for(let i=0;i<3;i++){const result=await Promise.race([reader.read(),Bun.sleep(600).then(()=>{throw Error('Continuous events starved')})]);expect(new TextDecoder().decode(result.value)).toContain('event: change')}
 }finally{clearInterval(timer);await reader.cancel()}
 expect(closed).toBe(1);abort.abort();expect(closed).toBe(1);
});


test('SSE keepalive outlives the default HTTP idle timeout',async()=>{
 const {changeEvents}=await import('./events');let released=false;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>changeEvents(request,()=>()=>{released=true})});
 const abort=new AbortController();
 try{
  const response=await fetch(`http://127.0.0.1:${server.port}`,{signal:abort.signal});const reader=response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: change');
  const started=Date.now();let heartbeats=0;
  while(Date.now()-started<10500){const result=await reader.read();expect(result.done).toBe(false);if(new TextDecoder().decode(result.value).includes('keepalive'))heartbeats++}
  expect(heartbeats).toBeGreaterThanOrEqual(2);await reader.cancel();
 }finally{abort.abort();server.stop(true)}
 for(let i=0;i<20&&!released;i++)await Bun.sleep(10);
 expect(released).toBe(true);
},20000);


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
