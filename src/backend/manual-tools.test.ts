import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ManualToolOperation, ManualToolRequest, ManualToolScope, ManualToolsCatalog } from '../shared/manual-tools';
import { ChatService } from './chat';
import { withDatabase } from './project-events';
import { createHandler, createServerOptions } from './server';
import { Store } from './store';
import { DummyAgent } from './test/dummy-agent';

const origin = 'http://127.0.0.1:3210';
const instructions = { kind: 'instructions' } as const;
const query = (scope: ManualToolScope) => '?' + new URLSearchParams(scope);
const headers = (origin: string) => ({ origin, 'content-type': 'application/json' });
type RequestHandler = (request: Request) => Promise<Response>;

function api(handle: RequestHandler) {
 const get = (path: string) => handle(new Request(origin + path));
 const post = (path: string, data: unknown) => handle(new Request(origin + path, {
  method: 'POST', headers: headers(origin), body: JSON.stringify(data)
 }));
 const catalog = async (scope: ManualToolScope): Promise<ManualToolsCatalog> => {
  const response = await get('/api/tools' + query(scope));
  expect(response.status).toBe(200);
  return response.json();
 };
 const accept = (body: ManualToolRequest) => post('/api/tools', body);
 const operation = (scope: ManualToolScope, id: string) => get('/api/tools/operations/' + id + query(scope));
 const settled = async (scope: ManualToolScope, id: string): Promise<ManualToolOperation> => {
  for (let i = 0; i < 100; i++) {
   const response = await operation(scope, id);
   expect(response.status).toBe(200);
   const { operation: value } = await response.json();
   if (value.status !== 'running') return value;
   await Bun.sleep(10);
  }
  throw Error('手動操作が終わりませんでした');
 };
 const request = (catalog: ManualToolsCatalog, name: string, input: ManualToolRequest['input'] = {}): ManualToolRequest => ({
  scope: catalog.scope, revision: catalog.revision, operationId: crypto.randomUUID(), name, input
 });
 return { get, post, catalog, accept, operation, settled, request };
}

async function fixture(agent = new DummyAgent({ supportsEmbeddedTools: true })) {
 const root = await mkdtemp(join(tmpdir(), 'beni-manual-tools-'));
 const folder = join(root, 'project'), otherFolder = join(root, 'other');
 await mkdir(folder);
 await mkdir(otherFolder);
 const database = join(root, 'beni.sqlite');
 const store = new Store(database);
 const project = store.createProject('Project', folder);
 const task = store.createTask(project.id, 'Task');
 const sibling = store.createTask(project.id, 'Sibling');
 const other = store.createProject('Other', otherFolder);
 const foreign = store.createTask(other.id, 'Foreign');
 const scope = { kind: 'project', projectId: project.id, taskId: task.id } as const;
 const projectScope = { kind: 'project', projectId: project.id } as const;
 const resolver = (id: string) => id === project.id ? folder : otherFolder;
 const chat = new ChatService(resolver, [agent]);
 const client = api(createHandler(store, root, chat));
 const close = async () => { store.close(); await rm(root, { recursive: true, force: true }); };
 return { client, store, project, task, sibling, foreign, scope, projectScope, folder, otherFolder, other, agent, root, database, resolver, chat, close };
}

test('手動ツールの一覧は実フェーズと所有範囲を検証し、旧フェーズの一覧を拒否する', async () => {
 const { client, store, project, task, foreign, scope, projectScope, close } = await fixture();
 try {
  const general = await client.catalog(projectScope);
  expect(general.phase).toBeNull();
  expect(general.tools.map(tool => tool.name)).toEqual(['list_events','get_event','get_file_change','get_file_version','get_execution_output']);
  const initial = await client.catalog(scope);
  expect(initial.phase).toBe('requirements');
  expect(initial.label).toBe('Project / Task');
  expect(initial.tools.map(tool => tool.name)).toContain('edit_document');
  expect((await client.get('/api/tools?kind=instructions&taskId=' + task.id)).status).toBe(400);
  expect((await client.get('/api/tools?kind=project&kind=instructions')).status).toBe(400);
  expect((await client.get('/api/tools' + query({...scope, taskId: foreign.id}))).status).toBe(404);
  for (const name of ['acknowledge_events', 'finish_instruction_update', 'finish_retrospective', 'Bash']) {
   expect((await client.accept(client.request(initial, name))).status).toBe(400);
  }
  expect((await client.accept(client.request(general, 'list_events', {task_id: foreign.id}))).status).toBe(400);
  store.selectTaskPhase(project.id, task.id, 'requirements', 'execution');
  const executing = await client.catalog(scope);
  expect(executing.phase).toBe('execution');
  expect(executing.tools.every(tool => tool.effect === 'read')).toBe(true);
  store.selectTaskPhase(project.id, task.id, 'execution', 'requirements');
  expect((await client.accept(client.request(initial, 'list_events'))).status).toBe(409);
 } finally { await close(); }
});

test('作業フォルダーの変更と手動操作を排他し、旧世代や消失後の実行を拒否する', async () => {
 const { client, project, scope, folder, root, close } = await fixture();
 try {
  const original = await client.catalog(scope);
  const request = client.request(original, 'list_events');
  const moved = join(root, 'moved');
  await mkdir(moved);
  const changeFolder = (folder: string) => client.post('/api/projects/' + project.id + '/folder', {folder});
  expect((await client.accept(request)).status).toBe(202);
  expect((await changeFolder(moved)).status).toBe(409);
  expect((await client.settled(scope, request.operationId)).status).toBe('completed');
  expect((await changeFolder(moved)).status).toBe(200);
  expect((await changeFolder(folder)).status).toBe(200);
  expect((await client.accept(client.request(original, 'list_events'))).status).toBe(409);

  const current = await client.catalog(scope);
  const unavailable = client.request(current, 'list_events');
  await rename(folder, join(root, 'unavailable'));
  expect((await client.get('/api/tools' + query(scope))).status).toBe(409);
  expect((await client.accept(unavailable)).status).toBe(409);
  await writeFile(folder, '');
  expect((await client.accept(unavailable)).status).toBe(409);
 } finally { await close(); }
});

test('イベント取得の上限を受付時に固定し、通常のチャット履歴・パック・カーソルに影響しない', async () => {
 const { client, store, project, task, scope, root, agent, close } = await fixture();
 try {
  const body = { projectId: project.id, taskId: task.id, phase: 'requirements', content: '要件の入力', model: null };
  expect((await client.post('/api/chat/send', body)).status).toBe(202);
  const chatQuery = '?' + new URLSearchParams({projectId: project.id, taskId: task.id, phase: body.phase});
  const chatPath = '/api/chat' + chatQuery;
  const packsPath = '/api/chat/packs' + chatQuery;
  let before;
  for (let i = 0; i < 100; i++) {
   before = await (await client.get(chatPath)).json();
   if (before.messages.at(-1)?.status === 'completed') break;
   await Bun.sleep(10);
  }
  expect(before.messages.at(-1)?.status).toBe('completed');
  const packs = await (await client.get(packsPath)).text();
  const history = join(root, 'chats', before.id + '.json');
  const previousJson = readFileSync(history, 'utf8');
  const catalog = await client.catalog(scope);
  const input = client.request(catalog, 'list_events');
  const response = await client.accept(input);
  expect(response.status).toBe(202);
  expect((await response.json()).operation).toMatchObject({ status: 'running', input: {}, phase: 'requirements' });
  const lateEvent = store.recordProjectEvent(project.id, {type:'task.renamed',taskId:task.id});
  const operation = await client.settled(scope, input.operationId);
  expect(operation.status).toBe('completed');
  const output = JSON.parse(operation.output!);
  expect(output.through).toBeLessThan(lateEvent.id);
  expect(output.events.length).toBeGreaterThan(0);
  expect((await client.accept(client.request(catalog, 'list_events', {through: lateEvent.id + 100}))).status).toBe(400);
  expect((await client.accept(client.request(catalog, 'get_event', {event_id: lateEvent.id + 100}))).status).toBe(400);
  expect(await (await client.get(chatPath)).json()).toEqual(before);
  expect(await (await client.get(packsPath)).text()).toBe(packs);
  expect(readFileSync(history, 'utf8')).toBe(previousJson);
  expect(agent.requests).toHaveLength(1);
  expect((await client.post('/api/chat/send', { ...body, content:'次の入力' })).status).toBe(202);
  for (let i = 0; i < 100 && agent.requests.length < 2; i++) await Bun.sleep(10);
  expect(JSON.stringify(agent.requests[1])).not.toContain(input.operationId);
  for (let i = 0; i < 100; i++) {
   const current = await (await client.get(chatPath)).json();
   if (current.messages.at(-1)?.status === 'completed') break;
   await Bun.sleep(10);
  }
 } finally { await close(); }
});

test('文書の版・引用・編集先を検証し、入れ子の型と省略・null・false・0を区別する', async () => {
 const { client, store, project, task, scope, agent, close } = await fixture();
 try {
  store.selectTaskPhase(project.id, task.id, 'requirements', 'documents');
  const catalog = await client.catalog(scope);
  const base = store.managedDocument(project.id, task.id, 'requirements.md')!;
  const source = {kind:'document' as const, id:'requirements.md/' + base.items[0]!.id, revision:base.revision, start:0, text:base.items[0]!.text};
  const edit = {text:'新しい仕様', reason:'要件の本文に従う', sources:[source], index:0, remove:false};
  const args = {name:'feature.md', revision:null, update_id:'fixture-update', edits:[edit]};
  for (const invalid of [
   { ...args, revision: undefined }, { ...args, extra:false }, { ...args, edits:[] },
   { ...args, edits:[{ ...edit, index:-1 }] }, { ...args, edits:[{ ...edit, remove:null }] },
   { ...args, edits:[{ ...edit, sources:[{ ...source, kind:'unknown' }] }] }
  ]) expect((await client.accept(client.request(catalog, 'edit_document', invalid))).status).toBe(400);
  for (const invalid of [
   { ...args, name:'requirements.md' }, { ...args, revision:base.revision },
   { ...args, edits:[{ ...edit, sources:[{ ...source, text:'引用元と異なる本文' }] }] }
  ]) {
   const request = client.request(catalog, 'edit_document', invalid);
   expect((await client.accept(request)).status).toBe(202);
   expect((await client.settled(scope, request.operationId)).status).toBe('failed');
  }
  const request = client.request(catalog, 'edit_document', args);
  expect((await client.accept(request)).status).toBe(202);
  const operation = await client.settled(scope, request.operationId);
  expect(operation).toMatchObject({ status:'completed', input:args });
  const document = store.managedDocument(project.id, task.id, 'feature.md')!;
  expect(document.content).toBe(edit.text);
  expect(document.items[0]?.sources[0]).toEqual(source);
  const read = client.request(catalog, 'read_document', {name: 'feature.md', item: 0});
  expect((await client.accept(read)).status).toBe(202);
  expect(JSON.parse((await client.settled(scope, read.operationId)).output!)).toMatchObject({revision:document.revision,item:{text:edit.text}});
  expect(agent.requests).toHaveLength(0);
  expect(store.chats.list({projectId:project.id,taskId:task.id,phase:'documents'})).toHaveLength(0);
 } finally { await close(); }
});

test('別タブとの排他、同じ入力の再送、別スコープによる照会を扱う', async () => {
 const { client, project, task, scope, projectScope, other, close } = await fixture();
 try {
  const catalog = await client.catalog(scope);
  const general = await client.catalog(projectScope);
  const otherCatalog = await client.catalog({kind:'project', projectId:other.id});
  const body = client.request(catalog, 'list_events', {after:0, limit:20});
  const same = { ...body, input:{limit:20, after:0} };
  const otherBody = client.request(otherCatalog, 'list_events');
  const responses = await Promise.all([
   client.accept(body),
   client.accept(same),
   client.accept(client.request(catalog, 'list_events')),
   client.accept(client.request(general, 'list_events')),
   client.post('/api/chat/send', {projectId:project.id,taskId:task.id,phase:'requirements',content:'競合する入力',model:null}),
   client.accept(otherBody)
  ]);
  expect(responses.map(response => response.status)).toEqual([202,200,409,409,409,202]);
  expect((await responses[1]!.json()).operation.status).toBe('running');
  expect((await client.accept({ ...same, input:{after:0,limit:10} })).status).toBe(409);
  expect((await client.accept({ ...same, scope:projectScope })).status).toBe(404);
  expect((await client.operation(projectScope, body.operationId)).status).toBe(404);
  expect((await client.operation(instructions, body.operationId)).status).toBe(404);
  expect((await client.settled(scope, body.operationId)).status).toBe('completed');
  expect((await client.settled(otherCatalog.scope, otherBody.operationId)).status).toBe('completed');
 } finally { await close(); }
});

test('通常送信の実行中は同じ対象を拒否し、同一プロジェクト内の別タスクは独立する', async () => {
 let finish!: () => void;
 const gate = new Promise<void>(resolve => { finish = resolve; });
 const agent = new DummyAgent({ supportsEmbeddedTools:true, scenario:async (_request, host, accept) => {
  await accept();
  await gate;
  await host.emit({type:'text.completed',itemId:'reply',text:'完了'});
  return {status:'completed'};
 }});
 const { client, project, task, sibling, scope, projectScope, close, chat } = await fixture(agent);
 try {
  expect((await client.post('/api/chat/send', {
   projectId:project.id,taskId:task.id,phase:'requirements',content:'競合を検証する',model:null
  })).status).toBe(202);
  for (const target of [scope, projectScope]) {
   const catalog = await client.catalog(target);
   expect(catalog.disabledReason).toBeString();
   expect((await client.accept(client.request(catalog, 'list_events'))).status).toBe(409);
  }
  const independent = await client.catalog({...scope, taskId:sibling.id});
  expect(independent.disabledReason).toBeUndefined();
  const request = client.request(independent, 'list_events');
  expect((await client.accept(request)).status).toBe(202);
  expect((await client.settled(independent.scope, request.operationId)).status).toBe('completed');
 } finally {
  finish();
  for (let i = 0; i < 100; i++) {
   const conversation = await chat.get(project.id, task.id, 'requirements');
   if (conversation.messages.at(-1)?.status === 'completed') break;
   await Bun.sleep(10);
  }
  await close();
 }
});

test('インストラクションの直接更新を会話なしで実行し、再起動と期限切れでも副作用を繰り返さない', async () => {
 const { client, store, database, root, resolver, agent } = await fixture();
 let currentStore = store;
 try {
  const catalog = await client.catalog(instructions);
  const previous = store.instructionDocument('editor')!;
  const item = previous.items[0]!;
  const source = {kind:'instruction',id:'editor/'+item.id,revision:previous.revision,text:item.text.slice(0,24)};
  expect(catalog.tools.map(tool => tool.name)).toEqual(['list_instructions','get_instruction','list_chat_sources','read_source','update_instruction']);
  const read = client.request(catalog, 'read_source', {kind:source.kind,id:source.id,revision:source.revision});
  expect((await client.accept(read)).status).toBe(202);
  expect(JSON.parse((await client.settled(instructions, read.operationId)).output!)).toEqual({text:item.text,next:null});
  const legacy = client.request(catalog, 'update_instruction', {key:'editor',expected_content:previous.content,content:'旧形式'});
  expect((await client.accept(legacy)).status).toBe(400);
  const request = client.request(catalog, 'update_instruction', {
   key:'editor', revision:previous.revision, edits:[{id:item.id,reason:'既存の編集方針を維持するため',sources:[source]}]
  });
  expect((await client.accept(request)).status).toBe(202);
  const operation = await client.settled(instructions, request.operationId);
  expect(operation.status).toBe('completed');
  const revision = store.instructionDocument('editor')!.revision;
  expect(revision).not.toBe(previous.revision);
  expect(store.instructionDocument('editor')).toMatchObject({content:previous.content,items:[{
   id:item.id,text:item.text,reason:'既存の編集方針を維持するため',sources:[{...source,start:0}],
  }]});
  expect(store.chats.list({projectId:'instructions',taskId:null,phase:null})).toHaveLength(0);
  expect(agent.requests).toHaveLength(0);
  const conflict = client.request(catalog, 'update_instruction', request.input);
  expect((await client.accept(conflict)).status).toBe(202);
  expect(await client.settled(instructions, conflict.operationId)).toMatchObject({
   status:'failed', error:'文書の版が更新されています。最新の版を取得してください。'
  });
  store.close();
  const sql = new Database(database);
  try {
   sql.query(`UPDATE manual_tool_operations SET operation=json_remove(json_set(operation, '$.status', 'running'), '$.output') WHERE id=?`).run(request.operationId);
  } finally { sql.close(); }
  currentStore = new Store(database);
  const restarted = api(createHandler(currentStore, root, new ChatService(resolver, [agent])));
  const replay = await restarted.accept(request);
  expect(replay.status).toBe(200);
  expect((await replay.json()).operation.status).toBe('unknown');
  expect(currentStore.instructionDocument('editor')!.revision).toBe(revision);
  const expiry = new Database(database);
  try { expiry.query('UPDATE manual_tool_operations SET expires_at=0 WHERE id=?').run(request.operationId); }
  finally { expiry.close(); }
  const expired = await restarted.accept(request);
  expect(expired.status).toBe(200);
  expect((await expired.json()).operation).toMatchObject({status:'unknown',input:{},error:expect.stringContaining('保存期限')});
  expect((await restarted.accept({...request, input:{...request.input, edits:[{id:item.id,reason:'異なる入力'}]}})).status).toBe(409);
  expect(currentStore.instructionDocument('editor')!.revision).toBe(revision);
  expect(agent.requests).toHaveLength(0);
 } finally {
  currentStore.close();
  await rm(root, {recursive:true, force:true});
 }
});

test('HTTP サーバーが JSON エスケープされた上限サイズの本文と引用を受け付ける', async () => {
 const { store, root, chat, close } = await fixture();
 const before = '\u0001'.repeat(65536), after = '\u0002'.repeat(65536);
 store.updateInstruction('editor', before, store.instructionDocument('editor')!.content);
 const previous = store.instructionDocument('editor')!, item = previous.items[0]!;
 const server = Bun.serve({hostname:'127.0.0.1',port:0,...createServerOptions(store,root,chat)});
 const address = 'http://127.0.0.1:' + server.port;
 try {
  const client = api(request => fetch(new Request(address + new URL(request.url).pathname + new URL(request.url).search, {
   method:request.method, headers:headers(address), body:request.body
  })));
  const catalog = await client.catalog(instructions);
  const request = client.request(catalog, 'update_instruction', {key:'editor',revision:previous.revision,edits:[{
   id:item.id,text:after,reason:'編集方針を更新する',sources:[{kind:'instruction',id:'editor/'+item.id,revision:previous.revision,text:before}],
  }]});
  expect((await client.accept(request)).status).toBe(202);
  expect((await client.settled(instructions, request.operationId)).status).toBe('completed');
  expect(store.instructionDocument('editor')!.content).toBe(after);
  const saved = store.instructionDocument('editor')!;
  const read = client.request(catalog, 'get_instruction', {key:'editor'});
  expect((await client.accept(read)).status).toBe(202);
  expect(JSON.parse((await client.settled(instructions, read.operationId)).output!)).toMatchObject({
   revision:saved.revision,item:{text:after.slice(0,4096),sources:[{text:before.slice(0,256),textTruncated:true,textLength:before.length}]},
   next:{item:0,offset:4096},
  });
 } finally { server.stop(true); await close(); }
});

test('編集相談の引用を所有範囲で検証し、保存済みの編集相談発言は会話を消去した後も取得できる', async () => {
 const {client, store, chat, project, task, folder, close} = await fixture(new DummyAgent({id:'codex',supportsEmbeddedTools:true}));
 try {
  const taskChat = await chat.send(project.id, task.id, 'タスクの発言', 'dummy-model', folder, undefined, 'requirements');
  const editorChat = await chat.send('instructions', null, '編集相談の発言', 'dummy-model', folder, undefined, null, false, 'codex', 'editor');
  for (let i = 0; i < 100 && chat.manualToolScopeBusy('instructions', null); i++) await Bun.sleep(10);
  const taskMessage = taskChat.messages[0]!, editorMessage = editorChat.messages[0]!;
  const foreign = `instructions/${taskChat.id}/${taskMessage.id}`;
  const own = `instructions/${editorChat.id}/${editorMessage.id}`;
  await chat.command('instructions', null, 'clear', folder);
  const catalog = await client.catalog(instructions);
  const run = async (name: string, input: Record<string, unknown>) => {
   const request = client.request(catalog,name,input);
   expect((await client.accept(request)).status).toBe(202);
   return client.settled(instructions,request.operationId);
  };
  const before = store.instructionDocument('editor')!, item = before.items[0]!;
  const read = await run('read_source',{kind:'message',id:own});
  expect(JSON.parse(read.output!)).toEqual({text:editorMessage.content,next:null});
  expect(await run('read_source',{kind:'message',id:foreign})).toMatchObject({status:'failed',error:'参照元が見つかりません'});
  expect(await run('update_instruction',{key:'editor',revision:before.revision,edits:[
   {text:'有効な引用',reason:'編集相談を引用',sources:[{kind:'message',id:own,text:editorMessage.content}]},
   {id:item.id,text:'範囲外の引用',reason:'タスクを引用',sources:[{kind:'message',id:foreign,text:taskMessage.content}]},
  ]})).toMatchObject({status:'failed',error:'参照元が見つかりません'});
  expect(store.instructionDocument('editor')).toEqual(before);
  expect(await run('update_instruction',{key:'editor',revision:before.revision,edits:[
   {text:'\n\n',index:0},
   {text:'新しい方針',reason:'編集相談の希望を反映',sources:[{kind:'message',id:own,text:editorMessage.content}],index:1},
   {id:item.id,index:0},
  ]})).toMatchObject({status:'completed'});
  const moved = store.instructionDocument('editor')!;
  expect(moved.items[0]).toEqual(item);
  expect(moved.items[1]).toMatchObject({text:'\n\n',reason:'',sources:[]});
  expect(moved.items[2]).toMatchObject({text:'新しい方針',reason:'編集相談の希望を反映'});
  expect(await run('update_instruction',{key:'editor',revision:moved.revision,edits:[
   {id:moved.items[1]!.id,remove:true},{id:moved.items[2]!.id,remove:true},
  ]})).toMatchObject({status:'completed'});
  expect(store.instructionDocument('editor')!.items).toEqual(before.items);
 } finally { await close(); }
});

test('反省会の完了は停止後の有効な最新版・理由があるときだけ確定する', async () => {
 const { client, store, project, task, scope, agent, close } = await fixture();
 try {
  store.selectTaskPhase(project.id, task.id, 'requirements', 'retrospective');
  const initial = await client.catalog(scope);
  expect(initial.tools.some(tool => tool.name === 'finish_retrospective')).toBe(false);
  const review = (state: string) => withDatabase(store.projectDatabasePath(project.id), db =>
   db.query("INSERT OR REPLACE INTO document_review(task_id,state,error) VALUES (?,?,NULL)").run(task.id, state));
  review('pending');
  const pending = await client.catalog(scope);
  expect(pending.disabledReason).toBeString();
  expect(pending.tools.every(tool => tool.effect === 'read')).toBe(true);
  review('stopped');
  const catalog = await client.catalog(scope);
  expect(catalog.tools.find(tool => tool.name === 'finish_retrospective')?.effect).toBe('complete');
  const document = store.managedDocument(project.id, task.id, 'retrospective.md')!;
  for (const args of [{revision:'invalid',reason:'根拠'}, {revision:document.revision,reason:' '}]) {
   const request = client.request(catalog, 'finish_retrospective', args);
   expect((await client.accept(request)).status).toBe(202);
   expect((await client.settled(scope, request.operationId)).status).toBe('failed');
  }
  const signals = client.request(catalog, 'get_retrospective_signals', {area:'documents'});
  expect((await client.accept(signals)).status).toBe(202);
  expect((await client.settled(scope, signals.operationId)).status).toBe('completed');
  const finish = client.request(catalog, 'finish_retrospective', {revision:document.revision,reason:'確認した項目に追記すべき改善はない'});
  expect((await client.accept(finish)).status).toBe(202);
  expect((await client.settled(scope, finish.operationId)).status).toBe('completed');
  expect((await client.catalog(scope)).tools.some(tool => tool.name === 'finish_retrospective')).toBe(false);
  expect(store.task(task.id)?.phase).toBe('retrospective');
  expect(agent.requests).toHaveLength(0);
  expect(store.chats.list({projectId:project.id,taskId:task.id,phase:'retrospective'})).toHaveLength(0);
  store.setTaskCompleted(project.id, task.id, true, 'retrospective');
  expect((await client.catalog(scope)).tools.every(tool => tool.effect === 'read')).toBe(true);
 } finally { await close(); }
});

test('自動インストラクション更新と同じ対象の手動操作を排他する', async () => {
 let finish!: () => void;
 const gate = new Promise<void>(resolve => { finish = resolve; });
 const agent = new DummyAgent({ supportsEmbeddedTools:true, scenario:async (_request, host, accept) => {
  await accept();
  await gate;
  expect((await host.callTool({id:'finish',name:'finish_instruction_update',input:{reason:'変更不要'}})).ok).toBe(true);
  return {status:'completed'};
 }});
 const { store, project, task, sibling, scope, projectScope, root, resolver, close } = await fixture(agent);
 try {
  store.enqueueInstructionJob({id:'fixture-job',projectId:project.id,taskId:task.id,revision:'fixture-version',provider:agent.id,model:null});
  const client = api(createHandler(store, root, new ChatService(resolver, [agent])));
  for (let i = 0; i < 100 && agent.requests.length === 0; i++) await Bun.sleep(10);
  expect(agent.requests).toHaveLength(1);
  for (const [target, name] of [[scope, 'list_events'], [projectScope, 'list_events'], [instructions, 'list_instructions']] as const) {
   const catalog = await client.catalog(target);
   expect(catalog.disabledReason).toBeString();
   expect((await client.accept(client.request(catalog, name))).status).toBe(409);
  }
  const independent = await client.catalog({...scope,taskId:sibling.id});
  const request = client.request(independent, 'list_events');
  expect((await client.accept(request)).status).toBe(202);
  expect((await client.settled(independent.scope, request.operationId)).status).toBe('completed');
 } finally {
  finish();
  for (let i = 0; i < 100 && store.pendingInstructionJob(); i++) await Bun.sleep(10);
  await close();
 }
});
