import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataBrowser, DataBrowserError } from './data-browser';
import { createHandler } from './server';
import { Store } from './store';
import { chatScopeKey } from './chat-store';
import { recordManagedDocumentHistory, withDatabase } from './project-events';
import type { StoredConversation } from './chat-history';

const projectId = '01990000-0000-7000-8000-000000000001';
const otherProjectId = '01990000-0000-7000-8000-000000000002';
const taskId = '01990000-0000-7100-8000-000000000001';
const deletedTaskId = '01990000-0000-7100-8000-000000000002';
const chatId = '01990000-0000-7200-8000-000000000001';
const orphanId = '01990000-0000-7200-8000-000000000002';
const brokenChatId = '01990000-0000-7200-8000-000000000003';
const savedAt = '2025-07-01T12:00:00.000Z';
const deletedAt = '2025-07-03T12:00:00.000Z';
const jobId = 'job-sample';
const planName = 'requirements.md';
const snapshotText = '## 旧文書\n';
const snapshotHash = createHash('sha256').update(snapshotText).digest('hex');
const documentSchema = `
  CREATE TABLE document_heads(scope TEXT,name TEXT,revision TEXT,PRIMARY KEY(scope,name));
  CREATE TABLE document_versions(scope TEXT,name TEXT,revision TEXT,updated_at INTEGER,items_json TEXT,PRIMARY KEY(scope,name,revision));
`;
let root: string, appPath: string, projectPath: string, otherPath: string, chatFolder: string;
let browser: DataBrowser;

const list = (params: Record<string, string> = {}) => browser.list(new URLSearchParams(params));
const chats = (params: Record<string, string> = {}) => list({view:'chats',...params});
const events = (params: Record<string, string> = {}) => list({view:'events',...params});
const key = (...values: string[]) => Buffer.from(JSON.stringify(values)).toString('base64url');
const chatKey = (id: string) => key('chats','chat',id);

function errorStatus(run: () => unknown, status: DataBrowserError["status"]) {
  try { run(); }
  catch (error) {
    expect(error).toBeInstanceOf(DataBrowserError);
    expect((error as DataBrowserError).status).toBe(status);
    return;
  }
  throw Error('保存データの読み取りエラーが必要です');
}

function chat(chatId: string): StoredConversation {
  return {
    version:3, chatId, projectId, taskId, phase:'requirements', selectedModelId:null,
    providers:{}, messages:[],
  };
}

function withFixtureDb(path: string, write: (db: Database) => void) {
  const db = new Database(path);
  try { write(db); } finally { db.close(); }
}

function saveChat(conversation: StoredConversation, kind: string, archived: boolean, at?: string) {
  const {chatId,projectId,taskId,phase,workflowJobId} = conversation;
  const source = join(chatFolder,chatId + '.json');
  withFixtureDb(appPath, db => db.run('INSERT INTO chat_refs VALUES (?,?,?,?,?,?,?,?)',
    [chatId,chatScopeKey(conversation),kind,projectId,taskId,phase,workflowJobId ?? null,Number(archived)]));
  if (at) {
    writeFileSync(source,JSON.stringify(conversation));
    utimesSync(source,new Date(at),new Date(at));
  }
  return source;
}

function fixtureFiles() {
  const names = readdirSync(root,{recursive:true}).map(String).sort();
  return names.map(name => [name, name === 'projects' || name === 'chats' ? null : readFileSync(join(root,name)).toString('base64')]);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(),'beni-data-browser-'));
  mkdirSync(join(root,'projects'));
  chatFolder = join(root,'chats');
  mkdirSync(chatFolder);
  appPath = join(root,'beni.sqlite');
  projectPath = join(root,'projects',projectId + '.sqlite');
  otherPath = join(root,'projects',otherProjectId + '.sqlite');
  browser = new DataBrowser(root,appPath);
  withFixtureDb(appPath, db => {
    db.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,folder TEXT,updatedAt TEXT);
      CREATE TABLE instructions(key TEXT PRIMARY KEY,content TEXT);
      CREATE TABLE instruction_jobs(ordinal INTEGER PRIMARY KEY,id TEXT,project_id TEXT,task_id TEXT,status TEXT,event_key TEXT);
      CREATE TABLE chat_refs(chat_id TEXT PRIMARY KEY,scope_key TEXT,kind TEXT,project_id TEXT,task_id TEXT,phase TEXT,workflow_job_id TEXT,archived INTEGER);
      CREATE TABLE chat_migration_aliases(scope_key TEXT,legacy_id TEXT,chat_id TEXT,PRIMARY KEY(scope_key,legacy_id));
    `);
    db.run('INSERT INTO projects VALUES (?,?,?,?)',[projectId,'星図ノート','/example/workspace',savedAt]);
    db.run('INSERT INTO projects VALUES (?,?,?,?)',[otherProjectId,'野鳥ログ','/example/other-workspace',savedAt]);
    db.run('INSERT INTO instructions VALUES (?,?)',['common','これは旧本文です']);
    db.run('INSERT INTO instruction_jobs VALUES (?,?,?,?,?,?)',[1,jobId,projectId,taskId,'pending','task.completed']);
    const scope = chatScopeKey(chat(chatId));
    db.run('INSERT INTO chat_refs VALUES (?,?,?,?,?,?,?,?)',[chatId,scope,'task',projectId,taskId,'requirements',null,1]);
    db.run('INSERT INTO chat_migration_aliases VALUES (?,?,?)',[scope,'legacy-one',chatId]);
    db.run('INSERT INTO chat_migration_aliases VALUES (?,?,?)',[scope,'legacy-two',chatId]);
  });
  withFixtureDb(projectPath, db => {
    db.exec(`
      CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY,project_id TEXT);
      CREATE TABLE tasks(id TEXT PRIMARY KEY,name TEXT,phase TEXT,status TEXT,updated_at TEXT,pending_completion TEXT);
      ${documentSchema}
      CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,at TEXT,task_id TEXT,details TEXT);
      CREATE TABLE file_changes(event_id INTEGER PRIMARY KEY,path TEXT,patch BLOB,after_hash TEXT);
      CREATE TABLE file_snapshots(change_id INTEGER PRIMARY KEY,content BLOB);
      CREATE TABLE managed_document_scopes(scope TEXT PRIMARY KEY);
      CREATE TABLE sample_unmanaged(id TEXT PRIMARY KEY);
    `);
    db.run('INSERT INTO project_identity VALUES (?,?)',[1,projectId]);
    db.run('INSERT INTO tasks VALUES (?,?,?,?,?,?)',[taskId,'星図の作成','requirements','idle',savedAt,'本文だけにある文字列']);
    db.run('INSERT INTO document_heads VALUES (?,?,?)',[taskId,planName,'first']);
    db.run('INSERT INTO document_heads VALUES (?,?,?)',[deletedTaskId,planName,'second']);
    for (const [id,revision,at,content] of [
      [taskId,'first',savedAt,'現行の本文'],
      [deletedTaskId,'first',savedAt,'削除済みタスクの過去の本文'],
      [deletedTaskId,'second',deletedAt,'削除済みタスクの本文'],
    ]) {
      db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[id,planName,revision,Date.parse(at),JSON.stringify([{id:'item',text:content,reason:'採用理由',sources:[]}])]);
    }
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[1,'task.deleted',deletedAt,deletedTaskId,'{"private":true}']);
    db.run('INSERT INTO file_changes VALUES (?,?,?,?)',[1,'.beni/tasks/example/requirements.md',Buffer.from([1,2]),snapshotHash]);
    db.run('INSERT INTO file_snapshots VALUES (?,?)',[1,Buffer.from(snapshotText)]);
  });
  withFixtureDb(otherPath, db => {
    db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY,project_id TEXT)');
    db.run('INSERT INTO project_identity VALUES (?,?)',[1,otherProjectId]);
  });
  writeFileSync(join(chatFolder,chatId + '.json'),JSON.stringify(chat(chatId)));
  writeFileSync(join(chatFolder,orphanId + '.json'),JSON.stringify(chat(orphanId)));
  writeFileSync(join(chatFolder,brokenChatId + '.json'),'{broken');
});

afterEach(() => rmSync(root,{recursive:true,force:true}));

test('概要を所属・種類・検索語で絞り込み、順序を固定してページを返す', () => {
  const all = list({scope:projectId,kind:'document'});
  expect(all.scopes).toEqual([
    {id:'app',name:'アプリ共通'}, {id:projectId,name:'星図ノート'}, {id:otherProjectId,name:'野鳥ログ'},
  ]);
  expect(all.total).toBe(2);
  expect(all.errors).toEqual([]);
  expect(all.records[0].updatedAt).toBe(deletedAt);
  expect(all.records.map(record => [record.id,record.name])).toEqual([
    [key(projectId,'document_heads',deletedTaskId,planName),planName],
    [key(projectId,'document_heads',taskId,planName),planName],
  ]);
  expect(list({scope:projectId,kind:'document',limit:'1'})).toMatchObject({records:all.records.slice(0,1),total:2});
  expect(list({scope:projectId,kind:'document',offset:'1',limit:'1'})).toMatchObject({records:all.records.slice(1,2),total:2});
  expect(list({query:'削除済みタスクの過去の本文'}).total).toBe(0);
  expect(list({kind:'task',limit:'1000'})).toMatchObject({records:[],total:0,limit:100});
  expect(list().records.map(record => record.kind).sort()).toEqual([
    'document','document','instruction',
  ]);
  expect(list({kind:'conversation'}).total).toBe(0);
});

test('DB は保存元とテーブルで絞り込み、空のテーブルを候補に含める', () => {
  const all = list({view:'db'});
  expect(all.errors).toEqual([]);
  expect(all.databases).toEqual([
    {id:'app',name:'アプリ共通',source:appPath},
    {id:projectId,name:'星図ノート',source:projectPath},
    {id:otherProjectId,name:'野鳥ログ',source:otherPath},
  ]);
  expect(all.tables).toContainEqual({database:projectId,name:'managed_document_scopes'});
  expect(all.tables?.some(table => table.name === 'sample_unmanaged' || table.name.startsWith('sqlite_'))).toBe(false);
  expect(all.records.some(record => record.kind === 'conversation')).toBe(false);
  expect(all.records).toContainEqual(expect.objectContaining({
    id:key('app','chat_refs',chatId),database:'app',table:'chat_refs',scope:projectId,
  }));
  expect(list({view:'db',database:'app',table:'projects'}).records.map(record => record.name).sort()).toEqual(['星図ノート','野鳥ログ']);
  expect(list({view:'db',database:projectId,table:'tasks',query:taskId}).records[0]).toMatchObject({
    database:projectId,table:'tasks',name:'星図の作成',scope:projectId,status:'idle',
  });
  expect(list({view:'db',query:'本文だけにある文字列'}).total).toBe(0);
  expect(list({view:'db',database:'app',table:'tasks'}).total).toBe(0);
  expect(list({view:'db',database:projectId,table:'managed_document_scopes'})).toMatchObject({records:[],total:0});
  const aliases = list({view:'db',table:'chat_migration_aliases',query:'legacy-'}).records;
  expect(aliases).toHaveLength(2);
  expect(aliases[0].id).not.toBe(aliases[1].id);
  expect(browser.detail(aliases[1].id).fields.legacy_id).toBe('legacy-two');
});

test('一覧と詳細を読んでも DB、会話、作業フォルダーの内容や構成は変わらない', () => {
  const before = fixtureFiles();
  for (const row of list().records) browser.detail(row.id);
  for (const row of chats().records.filter(record => record.id !== chatKey(brokenChatId))) browser.detail(row.id,'chats');
  for (const row of events().records) browser.detail(row.id,'events');
  for (const row of list({view:'db'}).records) browser.detail(row.id,'db');
  expect(fixtureFiles()).toEqual(before);
});

test('DB 詳細では文書として解釈できない行も保存値で確認できる', () => {
  withFixtureDb(projectPath, db => {
    db.run('UPDATE document_versions SET items_json=? WHERE scope=? AND name=? AND revision=?',
      ['{broken',taskId,planName,'first']);
  });
  const id = key(projectId,'document_versions',taskId,planName,'first');
  const raw = browser.detail(id,'db');
  expect(raw).toMatchObject({
    database:projectId, table:'document_versions', rowKey:`${taskId} / ${planName} / first`, history:[], status:'',
    fields:{items_json:'{broken'}, raw:{items_json:'{broken'},
  });
  expect(raw.document).toBeUndefined();
  expect(raw.storageRows).toBeUndefined();
  errorStatus(() => browser.detail(id),500);
  errorStatus(() => browser.detail(key('chats','chat',chatId),'db'),400);
});

test('文書の版と引用、削除済みタスクの履歴、保存値と関連先を取得できる', () => {
  const records = list({scope:projectId,kind:'document',query:deletedTaskId}).records;
  const head = records.find(record => record.source.endsWith('document_heads'))!;
  const detail = browser.detail(head.id);
  expect(detail.status).toContain('削除済みタスク');
  expect(detail.document).toMatchObject({content:'削除済みタスクの本文',revision:'second',items:[{reason:'採用理由',sources:[]}]});
  expect(detail.raw).toEqual({scope:deletedTaskId,name:planName,revision:'second'});
  expect(detail.history.map(item => item.revision)).toEqual(['second','first']);
  expect(detail.related.some(record => record.id === detail.history[0].id)).toBe(false);
  const previous = browser.detail(detail.history[1].id);
  expect(previous.document?.content).toBe('削除済みタスクの過去の本文');
  expect(previous.related.some(record => record.id === head.id)).toBe(true);

  const task = browser.detail(list({view:'db',table:'tasks'}).records[0].id);
  expect(task.related.map(record => browser.detail(record.id).kind)).toEqual(['registration','document','conversation','workflow']);
  expect(task.related.map(record => record.view)).toEqual(['db','files','chats','db']);
  const snapshot = browser.detail(list({view:'db',table:'file_snapshots'}).records[0].id);
  expect(snapshot.raw).toEqual({change_id:1,content:{type:'BLOB',bytes:Buffer.byteLength(snapshotText)}});
  expect(snapshot.document?.content).toBe(snapshotText);
  expect(snapshot.related.map(record => browser.detail(record.id).kind)).toEqual(['registration','event','event']);
  expect(snapshot.related.map(record => record.view)).toEqual(['db','events','db']);
});

test('文書の保存データは現行版への参照、選択した版と比較元の全列を返す', () => {
  const items = (text: string) => JSON.stringify([{id:'item',text,reason:'採用理由',sources:[]}]);
  const latest = '現行版の本文'.repeat(100);
  const previous = '削除済みタスクの過去の本文';
  const version = (revision: string, content: string, at: string, actor: string) => ({
    scope:deletedTaskId, name:planName, revision, items_json:items(content),
    content_hash:createHash('sha256').update(content).digest('hex'), actor, updated_at:Date.parse(at),
  });
  const currentRow = version('second',latest,deletedAt,'assistant');
  const previousRow = version('first',previous,savedAt,'user');
  withFixtureDb(projectPath, db => {
    db.exec('ALTER TABLE document_versions ADD COLUMN content_hash TEXT; ALTER TABLE document_versions ADD COLUMN actor TEXT;');
    for (const row of [currentRow,previousRow]) {
      db.run('UPDATE document_versions SET items_json=?,content_hash=?,actor=? WHERE scope=? AND name=? AND revision=?',
        [row.items_json,row.content_hash,row.actor,row.scope,row.name,row.revision]);
    }
  });
  const head = {source:projectPath, table:'document_heads', row:{scope:deletedTaskId,name:planName,revision:'second'}};
  const current = browser.detail(key(projectId,'document_heads',deletedTaskId,planName));
  expect(current.storageRows).toEqual([
    head,
    {source:projectPath,table:'document_versions',row:currentRow},
    {source:projectPath,table:'document_versions',row:previousRow,role:'previousVersion'},
  ]);
  expect(current.document?.content).toBe(latest);
  expect(current.documentDiff).toMatchObject({state:'changed',previousRevision:'first',patch:expect.stringContaining('+' + latest)});
  const past = browser.detail(key(projectId,'document_versions',deletedTaskId,planName,'first'));
  expect(past.storageRows).toEqual([head,{source:projectPath,table:'document_versions',row:previousRow}]);
  expect(past.document?.content).toBe(previous);
  expect(past.documentDiff).toEqual({state:'initial'});
});

test('移行済みインストラクションを現行版にまとめ、未移行の旧データと旧版への直接リンクを保持する', () => {
  withFixtureDb(appPath, db => {
    db.exec(documentSchema);
    db.run('INSERT INTO instructions VALUES (?,?)',['editor','未移行の旧本文']);
    db.run('INSERT INTO document_heads VALUES (?,?,?)',['instructions','common','second']);
    for (const [revision,at,content] of [
      ['first',savedAt,'共通インストラクションの過去の本文'],
      ['second',deletedAt,'共通インストラクションの現行本文'],
    ]) {
      db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[
        'instructions','common',revision,Date.parse(at),JSON.stringify([{text:content}]),
      ]);
    }
  });
  const instructions = list({scope:'app',kind:'instruction'});
  const headId = key('app','document_heads','instructions','common');
  const oldId = key('app','document_versions','instructions','common','first');
  const legacyId = key('app','instructions','editor');
  expect(instructions.records.map(record => record.id)).toEqual([headId,legacyId]);
  expect(instructions.total).toBe(2);
  const legacy = browser.detail(legacyId);
  expect(legacy.document?.content).toBe('未移行の旧本文');
  expect(legacy.documentDiff?.state).toBe('unavailable');
  expect(legacy.storageRows).toEqual([{source:appPath,table:'instructions',row:{key:'editor',content:'未移行の旧本文'}}]);
  const current = browser.detail(headId);
  expect(current.document?.content).toBe('共通インストラクションの現行本文');
  expect(current.history.map(version => version.revision)).toEqual(['second','first']);
  expect(current.history[1].id).toBe(oldId);
  expect(current.documentDiff).toMatchObject({state:'changed',previousRevision:'first',
    patch:expect.stringContaining('+共通インストラクションの現行本文')});
  expect(browser.detail(oldId)).toMatchObject({status:'過去版', document:{content:'共通インストラクションの過去の本文'}});
  const rawApp = list({view:'db',database:'app'});
  expect(rawApp.records.filter(record => record.table === 'instructions').map(record => record.id).sort()).toEqual(
    [key('app','instructions','common'),legacyId].sort(),
  );
  expect(rawApp.records.filter(record => record.table === 'document_heads').map(record => record.id)).toEqual([headId]);
  expect(rawApp.records.filter(record => record.table === 'document_versions').map(record => record.id)).toEqual([
    key('app','document_versions','instructions','common','second'),oldId,
  ]);
  expect(list({view:'db',database:projectId,table:'document_versions'}).records.map(record => record.id).sort()).toEqual([
    key(projectId,'document_versions',taskId,planName,'first'),
    key(projectId,'document_versions',deletedTaskId,planName,'first'),
    key(projectId,'document_versions',deletedTaskId,planName,'second'),
  ].sort());
});

test('現行版の参照がない文書は所属ごとに保存済みの最新の版で代表させる', () => {
  for (const path of [projectPath,otherPath]) {
    withFixtureDb(path, db => {
      if (path === otherPath) db.exec(documentSchema);
      for (const [revision,at,content] of [
        ['first',savedAt,'以前のナレッジ'],
        ['second',deletedAt,'保存済みの最新のナレッジ'],
      ]) {
        db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[
          'knowledge','knowledge.md',revision,Date.parse(at),JSON.stringify([{text:content}]),
        ]);
      }
    });
  }
  const knowledge = list({kind:'document',query:'knowledge.md'});
  expect(knowledge.total).toBe(2);
  expect(knowledge.records.map(record => record.scope).sort()).toEqual([projectId,otherProjectId]);
  for (const record of knowledge.records) {
    expect(record).toMatchObject({
      id:key(record.scope,'document_versions','knowledge','knowledge.md','second'),status:'現行版なし',
    });
    const detail = browser.detail(record.id);
    expect(detail).toMatchObject({status:'現行版なし',document:{content:'保存済みの最新のナレッジ'}});
    expect(detail.storageRows?.map(row => row.table)).toEqual(['document_versions','document_versions']);
    expect(detail.history.map(version => version.revision)).toEqual(['second','first']);
    expect(browser.detail(detail.history[1].id).document?.content).toBe('以前のナレッジ');
  }
});

test('会話の本文は詳細だけで検証し、参照情報と孤立ファイルを閲覧できる', () => {
  const all = chats();
  expect(all.records).toHaveLength(3);
  expect(all.errors).toEqual([]);
  const current = all.records.find(record => record.scope === projectId)!;
  expect(current.status).toBe('アーカイブ');
  const detail = browser.detail(current.id,'chats');
  expect(detail.conversation).toEqual(chat(chatId));
  expect(detail.raw).toEqual(chat(chatId));
  expect(detail.storageRows).toEqual([{source:appPath,table:'chat_refs',row:{
    chat_id:chatId,scope_key:chatScopeKey(chat(chatId)),kind:'task',project_id:projectId,task_id:taskId,
    phase:'requirements',workflow_job_id:null,archived:1,
  }}]);
  expect(detail.related.map(record => browser.detail(record.id).kind)).toEqual(['management','registration','task']);
  expect(detail.related.map(record => record.view)).toEqual(['db','db','tasks']);
  const orphan = all.records.find(record => record.name === orphanId)!;
  expect(orphan).toMatchObject({scope:'app',status:'参照なし'});
  const orphanDetail = browser.detail(orphan.id,'chats');
  expect(orphanDetail.conversation?.chatId).toBe(orphanId);
  expect(orphanDetail.history.map(version => version.id)).toEqual([orphan.id]);
  expect(orphanDetail.storageRows).toEqual([]);
  const broken = all.records.find(record => record.name === brokenChatId)!;
  errorStatus(() => browser.detail(broken.id,'chats'),500);
});

test('チャット一覧は場所ごとに現行版を代表にし、過去版のIDで検索しても現行版を開く', () => {
  const currentId = '01990000-0000-7200-8000-000000000004';
  const anotherArchiveId = '01990000-0000-7200-8000-000000000005';
  const currentPath = saveChat(chat(currentId),'task',false,savedAt);
  saveChat(chat(anotherArchiveId),'task',true,deletedAt);
  const mostRecent = '2025-07-04T12:00:00.000Z';
  utimesSync(join(chatFolder,chatId + '.json'),new Date(mostRecent),new Date(mostRecent));
  const location = chatScopeKey(chat(chatId));
  const representative = {
    id:chatKey(currentId), name:'星図の作成 · 要件定義', scope:projectId, status:'現行',
    chatLocation:location, chatVersionCount:3, updatedAt:savedAt,
  };
  expect(chats({scope:projectId})).toMatchObject({total:1, records:[representative], errors:[]});
  for (const query of [chatId,anotherArchiveId,location,'星図の作成','要件定義']) {
    expect(chats({query})).toMatchObject({total:1,records:[representative]});
  }
  const old = browser.detail(chatKey(chatId),'chats');
  expect(old).toMatchObject({
    ...representative, id:chatKey(chatId), status:'アーカイブ', updatedAt:mostRecent,
    history:[
      {id:chatKey(currentId),revision:currentId,updatedAt:savedAt},
      {id:chatKey(chatId),revision:chatId,updatedAt:mostRecent},
      {id:chatKey(anotherArchiveId),revision:anotherArchiveId,updatedAt:deletedAt},
    ],
    raw:chat(chatId), conversation:chat(chatId), storageRows:[{row:{chat_id:chatId}}],
  });
  expect(browser.detail(old.history[0].id,'chats')).toMatchObject({
    ...representative, raw:chat(currentId), conversation:chat(currentId), storageRows:[{row:{chat_id:currentId}}],
  });

  rmSync(currentPath);
  expect(chats({scope:projectId,query:currentId})).toMatchObject({
    total:1, records:[{id:chatKey(chatId),chatVersionCount:2,status:'アーカイブ'}],
    errors:[{source:currentPath}],
  });
  expect(browser.detail(old.id,'chats').history.map(version => version.revision)).toEqual([chatId,anotherArchiveId]);
  errorStatus(() => browser.detail(chatKey(currentId),'chats'),404);
  expect(existsSync(currentPath)).toBe(false);
});

test('同名の別タスク、別フェーズ・ジョブ・プロジェクトと参照なしの会話を分けてページを返す', () => {
  const task2 = '01990000-0000-7100-8000-000000000003';
  withFixtureDb(projectPath, db => db.run('INSERT INTO tasks VALUES (?,?,?,?,?,?)',
    [task2,'星図の作成','requirements','idle',savedAt,null]));
  const locations: [Partial<StoredConversation>, string, string][] = [
    [{taskId:task2},'task','星図の作成 · 要件定義'],
    [{taskId:deletedTaskId},'task',deletedTaskId + ' · 要件定義'],
    [{phase:'documents'},'task','星図の作成 · 仕様整理'],
    [{taskId:null,phase:null,workflowJobId:'job-one'},'workflow','ワークフロー · job-one'],
    [{taskId:null,phase:null,workflowJobId:'job-two'},'workflow','ワークフロー · job-two'],
    [{taskId:null,phase:null},'general','General'],
    [{projectId:otherProjectId,taskId:null,phase:null},'general','General'],
    [{projectId:'instructions',taskId:null,phase:null},'instructions','インストラクション編集相談'],
  ];
  const samples = locations.map(([overrides,kind,name], index) => {
    const id = '01990000-0000-7200-8000-' + String(index + 10).padStart(12,'0');
    const conversation = {...chat(id),...overrides};
    saveChat(conversation,kind,false,savedAt);
    return {id:chatKey(id),name,chatLocation:chatScopeKey(conversation),chatVersionCount:1};
  });
  const all = chats();
  expect(all.total).toBe(11);
  expect(all.errors).toEqual([]);
  expect(new Set(all.records.map(record => record.chatLocation)).size).toBe(all.total);
  for (const sample of samples) {
    expect(all.records.find(record => record.id === sample.id)).toMatchObject(sample);
    expect(browser.detail(sample.id,'chats')).toMatchObject(sample);
  }
  expect(chats({scope:otherProjectId}).records.map(record => record.id)).toEqual([samples[6].id]);
  expect(chats({scope:'app'}).records.map(record => record.id)).toEqual(expect.arrayContaining([
    chatKey(orphanId),chatKey(brokenChatId),samples[7].id,
  ]));
  expect(chats({query:'ワークフロー'}).total).toBe(2);
  const project = chats({scope:projectId});
  expect(project.total).toBe(7);
  expect(chats({scope:projectId,offset:'1',limit:'2'})).toMatchObject({
    total:project.total, records:project.records.slice(1,3),
  });
});

test('保存元の欠損、破損、誤った DB ID は別の保存元の表示を妨げない', () => {
  rmSync(otherPath);
  expect(list().errors).toEqual([{source:otherPath,message:'保存データを読み込めませんでした'}]);
  expect(existsSync(otherPath)).toBe(false);
  writeFileSync(otherPath,'invalid database');
  expect(list().errors.map(error => error.source)).toEqual([otherPath]);
  rmSync(otherPath);
  withFixtureDb(otherPath, db => {
    db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY,project_id TEXT)');
    db.run('INSERT INTO project_identity VALUES (?,?)',[1,projectId]);
  });
  expect(list().errors.map(error => error.source)).toEqual([otherPath]);
  expect(list({view:'db',table:'tasks'}).total).toBe(1);

  rmSync(appPath);
  expect(chats().errors.map(error => error.source)).toEqual([appPath]);
  expect(chats().total).toBe(3);
  expect(browser.detail(key('chats','chat',orphanId)).conversation?.chatId).toBe(orphanId);
  expect(existsSync(appPath)).toBe(false);
});

test('イベントの種類候補を所属から作り、日時・プロジェクト・イベントID順で絞り込み後にページを返す', () => {
  withFixtureDb(projectPath, db => {
    db.exec('ALTER TABLE events ADD COLUMN phase TEXT');
    db.run('INSERT INTO events VALUES (?,?,?,?,?,?)',[2,'tool.started',deletedAt,taskId,'{}','requirements']);
    db.run('INSERT INTO events VALUES (?,?,?,?,?,?)',[10,'tool.started',deletedAt,taskId,'{}','execution']);
    db.run('INSERT INTO events VALUES (?,?,?,?,?,?)',[11,'project.updated',savedAt,null,'{}',null]);
  });
  withFixtureDb(otherPath, db => {
    db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,at TEXT,task_id TEXT,details TEXT)');
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[1,'other.updated',deletedAt,null,'{}']);
  });
  const all = events();
  expect(all.errors).toEqual([]);
  expect(all.eventTypes).toEqual(['other.updated','project.updated','task.deleted','tool.started']);
  expect(all.records.map(record => [record.scope,record.eventId])).toEqual([
    [projectId,1],[projectId,2],[projectId,10],[otherProjectId,1],[projectId,11],
  ]);
  expect(all.records[0]).toMatchObject({eventTask:deletedTaskId,name:'task.deleted'});
  expect(all.records[1]).toMatchObject({
    id:key(projectId,'events','2'),kind:'event',name:'tool.started',updatedAt:deletedAt,eventTask:'星図の作成',eventPhase:'要件定義',
  });
  expect(all.records[4].eventTask).toBeUndefined();
  expect(events({scope:'app'})).toMatchObject({records:[],total:0,eventTypes:[]});
  expect(events({scope:otherProjectId,eventType:'tool.started'})).toMatchObject({
    records:[],total:0,eventTypes:['other.updated'],
  });
  expect(events({scope:projectId,eventType:'tool.started',query:'星図の作成',offset:'1',limit:'1'})).toMatchObject({
    records:[all.records[2]],total:2,eventTypes:['project.updated','task.deleted','tool.started'],
  });
  expect(events({query:'TOOL.STARTED'}).records).toEqual(all.records.slice(1,3));
  expect(events({query:taskId}).records).toEqual(all.records.slice(1,3));
  expect(events({query:'11'}).records).toEqual([all.records[4]]);
  expect(events({eventType:"tool.started' OR 1=1 --"})).toMatchObject({records:[],total:0,eventTypes:all.eventTypes});
  errorStatus(() => events({eventType:'x'.repeat(513)}),400);
  expect(list().records.some(record => record.kind === 'event')).toBe(false);
});

test('イベント詳細は元の保存行、JSON、参照された文書版と会話版を返す', () => {
  const json = '{"revision":"first","toolName":"sample"}';
  withFixtureDb(projectPath, db => {
    db.exec('ALTER TABLE events ADD COLUMN phase TEXT; ALTER TABLE events ADD COLUMN chat_id TEXT');
    db.run('INSERT INTO events VALUES (?,?,?,?,?,?,?)',[2,'document.updated',savedAt,taskId,json,'requirements',chatId]);
    db.run('INSERT INTO events VALUES (?,?,?,?,?,?,?)',[3,'project.updated',deletedAt,null,'{broken',null,null]);
    db.run('INSERT INTO file_changes VALUES (?,?,?,?)',[2,`.beni/tasks/${taskId}/${planName}`,Buffer.from([1,2]),null]);
  });
  const id = key(projectId,'events','2');
  const detail = browser.detail(id,'events');
  expect(detail).toMatchObject({
    eventId:2,eventTask:'星図の作成',eventPhase:'要件定義',history:[],
    event:{
      type:'document.updated',at:savedAt,taskId,taskName:'星図の作成',phase:'requirements',
      details:{revision:'first',toolName:'sample'},
    },
    raw:{id:2,type:'document.updated',at:savedAt,task_id:taskId,details:json,phase:'requirements',chat_id:chatId},
  });
  const conversation = detail.related.find(record => record.view === 'chats')!;
  expect(conversation.id).toBe(chatKey(chatId));
  expect(browser.detail(conversation.id,'chats').status).toBe('アーカイブ');
  expect(detail.related).toContainEqual(expect.objectContaining({
    id:key(projectId,'document_versions',taskId,planName,'first'),view:'files',
  }));
  expect(detail.related).toContainEqual(expect.objectContaining({id:key(projectId,'file_changes','2'),view:'db'}));
  expect(browser.detail(key(projectId,'events','1'),'events').event).toMatchObject({taskId:deletedTaskId,taskName:null});
  expect(browser.detail(key(projectId,'events','3'),'events').event).toEqual({
    type:'project.updated',at:deletedAt,taskId:null,taskName:null,phase:null,details:'{broken',
  });
  expect(browser.detail(id,'db')).toMatchObject({table:'events',history:[],raw:detail.raw});
  expect(browser.detail(id,'db').event).toBeUndefined();
  errorStatus(() => browser.detail(chatKey(chatId),'events'),400);
  errorStatus(() => browser.detail(key(projectId,'tasks',taskId),'events'),400);
  errorStatus(() => browser.detail(key(projectId,'events','999'),'events'),404);
});

test('タスク一覧の状態候補は検索と状態の指定に依存せず、詳細は最新の完了記録と関連先を返す', () => {
  withFixtureDb(projectPath, db => {
    db.exec('ALTER TABLE tasks ADD COLUMN created_at TEXT; ALTER TABLE tasks ADD COLUMN document_baseline TEXT');
    db.run('UPDATE tasks SET created_at=?,pending_completion=?,document_baseline=? WHERE id=?',
      [savedAt,'{"revision":"example"}','{broken',taskId]);
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[2,'task.completed',deletedAt,taskId,'{}']);
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[3,'task.completed',savedAt,taskId,'{}']);
    db.run('INSERT INTO tasks(id,name,phase,status,updated_at) VALUES (?,?,?,?,?)',[deletedTaskId,'別のタスク','finalization','completed',deletedAt]);
  });
  const filtered = list({view:'tasks',scope:projectId,status:'idle',query:'星図',limit:'1'});
  expect(filtered).toMatchObject({
    total:1,statuses:['completed','idle'],
    records:[{id:key(projectId,'tasks',taskId),name:'星図の作成',subtitle:'要件定義',status:'idle'}],
  });
  expect(list({view:'tasks',scope:otherProjectId}).statuses).toEqual([]);
  expect(list({view:'tasks',query:taskId,offset:'1'})).toMatchObject({total:1,records:[]});
  const before = fixtureFiles();
  const detail = browser.detail(filtered.records[0].id,'tasks');
  expect(detail.task).toEqual({
    phase:'requirements',status:'idle',createdAt:savedAt,updatedAt:savedAt,completedAt:deletedAt,
    completion:{revision:'example'},baseline:'{broken',
  });
  expect(detail.storageRows).toMatchObject([{table:'tasks',row:{id:taskId}},{table:'events',row:{id:2}}]);
  expect(detail.related.map(item => item.view)).toEqual(['db','files','chats','events','events','db']);
  expect(browser.detail(key(projectId,'tasks',deletedTaskId),'tasks').task?.completedAt).toBeNull();
  errorStatus(() => browser.detail(chatKey(chatId),'tasks'),400);
  expect(fixtureFiles()).toEqual(before);
});

test('ワークフローの会話にジョブを表示し、イベントとタスクから実行会話またはDB行へ移動できる', () => {
  const workflowChatId = '01990000-0000-7200-8000-000000000022';
  saveChat({...chat(workflowChatId),taskId:null,phase:null,workflowJobId:jobId},'workflow',false,savedAt);
  withFixtureDb(appPath, db => {
    db.exec(`${documentSchema}
      ALTER TABLE instruction_jobs ADD COLUMN provider TEXT;
      ALTER TABLE instruction_jobs ADD COLUMN model TEXT;
      ALTER TABLE instruction_jobs ADD COLUMN revision TEXT;
      ALTER TABLE instruction_jobs ADD COLUMN instruction_revision TEXT;
      ALTER TABLE instruction_jobs ADD COLUMN event_id INTEGER;
      ALTER TABLE instruction_jobs ADD COLUMN error TEXT;
      ALTER TABLE instruction_jobs ADD COLUMN reason TEXT;`);
    db.run('UPDATE instruction_jobs SET provider=?,model=?,revision=?,instruction_revision=?,event_id=?,reason=? WHERE id=?',
      ['sample-provider','sample-model','knowledge-first','instruction-first',2,'保存済み理由',jobId]);
    db.run('INSERT INTO instruction_jobs(ordinal,id,project_id,task_id,status,event_key) VALUES (?,?,?,?,?,?)',
      [2,'older-job',projectId,deletedTaskId,'failed',null]);
    db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',
      ['instructions','task.completed','instruction-first',Date.parse(savedAt),'[]']);
  });
  withFixtureDb(projectPath, db => {
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[2,'task.completed',savedAt,taskId,'{}']);
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[3,'workflow.started',savedAt,taskId,
      JSON.stringify({workflowJobId:jobId,eventKey:'task.completed',triggerEventId:2,attemptId:'sample-attempt'})]);
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[4,'workflow.failed',savedAt,deletedTaskId,
      JSON.stringify({workflowJobId:'older-job',eventKey:'task.completed',triggerEventId:null,attemptId:'older-attempt'})]);
    db.run('INSERT INTO tasks VALUES (?,?,?,?,?,?)',[deletedTaskId,'別のタスク','requirements','idle',savedAt,null]);
    db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',['knowledge','knowledge.md','knowledge-first',Date.parse(savedAt),'[]']);
    db.exec('CREATE TABLE document_review(task_id TEXT PRIMARY KEY,state TEXT)');
    db.run('INSERT INTO document_review VALUES (?,?)',[taskId,'pending']);
  });
  withFixtureDb(otherPath, db => {
    db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY,type TEXT,at TEXT,chat_id TEXT,details TEXT)');
    db.run('INSERT INTO events VALUES (?,?,?,?,?)',[1,'workflow.started',savedAt,workflowChatId,
      JSON.stringify({workflowJobId:jobId,eventKey:'task.completed',triggerEventId:2,attemptId:'other-attempt'})]);
  });
  const filtered = chats({scope:projectId,query:'星図の作成'});
  const summary = {id:chatKey(workflowChatId),name:'ワークフロー · task.completed',status:'pending',subtitle:'星図の作成',updatedAt:savedAt};
  expect(filtered.records).toContainEqual(expect.objectContaining(summary));
  expect(chats({query:'task.completed'}).records).toMatchObject([summary]);
  expect(chats({query:jobId}).records).toMatchObject([summary]);
  expect(chats({query:'older-job'}).records).toEqual([]);
  expect(chats({scope:otherProjectId,query:jobId}).records).toEqual([]);
  const before = fixtureFiles();
  const jobKey = key('app','instruction_jobs','1');
  const chatTarget = expect.objectContaining({id:chatKey(workflowChatId),view:'chats'});
  const detail = browser.detail(summary.id,'chats');
  expect(detail).toMatchObject(summary);
  expect(detail.conversation).toMatchObject({chatId:workflowChatId,workflowJobId:jobId});
  expect(detail.workflow).toMatchObject({
    taskName:'星図の作成',taskId,eventKey:'task.completed',status:'pending',provider:'sample-provider',model:'sample-model',
    revision:'knowledge-first',instructionRevision:'instruction-first',reason:'保存済み理由',error:null,
  });
  expect(detail.storageRows).toMatchObject([
    {source:appPath,table:'chat_refs',row:{chat_id:workflowChatId}},
    {source:appPath,table:'instruction_jobs',row:{id:jobId}},
    {source:projectPath,table:'tasks',row:{id:taskId}},
  ]);
  expect(detail.related).toEqual(expect.arrayContaining([
    expect.objectContaining({id:key(projectId,'tasks',taskId),view:'tasks'}),
    expect.objectContaining({id:key(projectId,'events','2'),view:'events'}),
    expect.objectContaining({id:key(projectId,'document_versions','knowledge','knowledge.md','knowledge-first'),view:'files'}),
    expect.objectContaining({id:key('app','document_versions','instructions','task.completed','instruction-first'),view:'files'}),
    expect.objectContaining({id:jobKey,view:'db'}),
  ]));
  expect(browser.detail(key(projectId,'tasks',taskId),'tasks').related).toContainEqual(chatTarget);
  expect(browser.detail(key(projectId,'events','2'),'events').related).toContainEqual(chatTarget);
  const lifecycle = browser.detail(key(projectId,'events','3'),'events');
  expect(lifecycle.event?.details).toEqual({workflowJobId:jobId,eventKey:'task.completed',triggerEventId:2,attemptId:'sample-attempt'});
  expect(lifecycle.related).toEqual(expect.arrayContaining([
    chatTarget,expect.objectContaining({id:key(projectId,'events','2'),view:'events'}),
  ]));
  expect(browser.detail(key(otherProjectId,'events','1'),'events').related).toEqual([
    expect.objectContaining({id:key('app','projects',otherProjectId),view:'db'}),
  ]);
  const missingChatJob = key('app','instruction_jobs','2');
  const fallback = expect.objectContaining({id:missingChatJob,view:'db'});
  expect(browser.detail(key(projectId,'tasks',deletedTaskId),'tasks').related).toContainEqual(fallback);
  expect(browser.detail(key(projectId,'events','4'),'events').related).toContainEqual(fallback);
  expect(browser.detail(missingChatJob,'db').raw).toMatchObject({id:'older-job',status:'failed'});
  errorStatus(() => list({view:'workflows'}),400);
  errorStatus(() => browser.detail(jobKey,'workflows'),400);
  expect(fixtureFiles()).toEqual(before);
});

test('イベントとDBから保存されたファイル変更と対応する文書版を参照できる', () => {
  withFixtureDb(projectPath, db => db.exec('DROP TABLE file_snapshots; DROP TABLE file_changes; DROP TABLE events'));
  const eventIds = withDatabase(projectPath, db => {
    const first = recordManagedDocumentHistory(db,taskId,'requirements',{name:planName,content:'旧本文\n',revision:'first'})!;
    const second = recordManagedDocumentHistory(db,taskId,'requirements',{name:planName,content:'新本文\n',revision:'second'})!;
    db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[
      taskId,planName,'second',Date.parse(deletedAt),JSON.stringify([{text:'新本文\n',reason:'採用理由',sources:[{id:'example'}]}]),
    ]);
    return [String(first.id),String(second.id)];
  });
  const first = key(projectId,'file_changes',eventIds[0]), second = key(projectId,'file_changes',eventIds[1]);
  const before = fixtureFiles();
  errorStatus(() => list({view:'changes'}),400);
  errorStatus(() => browser.detail(second,'changes'),400);
  expect(list({view:'db',database:projectId,table:'file_changes',query:planName}).records.map(row => row.id)).toEqual([first,second].sort());
  const detail = browser.detail(second,'db');
  expect(detail.raw).toMatchObject({event_id:Number(eventIds[1]),patch:{type:'BLOB',bytes:expect.any(Number)}});
  const eventId = key(projectId,'events',eventIds[1]);
  expect(detail.related).toEqual(expect.arrayContaining([
    expect.objectContaining({id:first,view:'db'}),
    expect.objectContaining({id:eventId,view:'events'}),
  ]));
  expect(browser.detail(eventId,'events').related).toEqual(expect.arrayContaining([
    expect.objectContaining({id:second,view:'db'}),
    expect.objectContaining({id:key(projectId,'document_versions',taskId,planName,'second'),view:'files'}),
  ]));
  expect(fixtureFiles()).toEqual(before);
});

test('選んだ過去版を同じファイルの直前版と比べ、同時刻は保存順で区別する', () => {
  withFixtureDb(projectPath, db => {
    db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[
      deletedTaskId,planName,'earlier',Date.parse(savedAt),JSON.stringify([{text:'最初の本文'}]),
    ]);
    db.run('INSERT INTO document_versions VALUES (?,?,?,?,?)',[
      deletedTaskId,planName,'third',Date.parse(deletedAt),JSON.stringify([{text:'削除済みタスクの本文',reason:'新しい根拠'}]),
    ]);
    db.run('UPDATE document_heads SET revision=? WHERE scope=? AND name=?',['third',deletedTaskId,planName]);
  });
  const current = browser.detail(key(projectId,'document_heads',deletedTaskId,planName));
  expect(current.history.map(version => version.revision)).toEqual(['third','second','earlier','first']);
  expect(current.documentDiff).toEqual({state:'unchanged',previousRevision:'second'});
  const past = browser.detail(current.history[1].id);
  expect(past.documentDiff).toMatchObject({state:'changed',previousRevision:'earlier',patch:expect.stringContaining('-最初の本文')});
  expect(past.storageRows?.at(-1)).toMatchObject({role:'previousVersion',row:{revision:'earlier'}});
  expect(browser.detail(current.history[3].id).documentDiff).toEqual({state:'initial'});
});

test('比較元が不正または上限超過でも選んだ版と比較元の保存行を表示する', () => {
  const currentId = key(projectId,'document_heads',deletedTaskId,planName);
  for (const items of ['{broken', JSON.stringify([{text:'x'.repeat(8 * 1024 * 1024)}])]) {
    withFixtureDb(projectPath, db => db.run('UPDATE document_versions SET items_json=? WHERE scope=? AND name=? AND revision=?',
      [items,deletedTaskId,planName,'first']));
    const current = browser.detail(currentId);
    expect(current.document?.content).toBe('削除済みタスクの本文');
    expect(current.documentDiff).toMatchObject({state:'unavailable',previousRevision:'first'});
    expect(current.storageRows?.at(-1)).toMatchObject({role:'previousVersion',row:{revision:'first',
      items_json:items.length > 8 * 1024 * 1024 ? {type:'TEXT',bytes:Buffer.byteLength(items),omitted:true} : items}});
  }
});

test('登録済みエージェントを状態で絞り込み、保存キャッシュの未取得・失効・不正を区別する', () => {
  const models = [{id:'sample-model',name:'Sample'}];
  const usage = {observedAt:savedAt,windows:[{label:'利用枠',usedPercent:23,resetsAt:1}]};
  withFixtureDb(appPath, db => {
    db.exec(`CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT,availability TEXT,auth TEXT,models TEXT,version TEXT,
      checked_at TEXT,status_invalidated INTEGER,usage TEXT);
      CREATE TABLE agent_usage_cache(provider TEXT PRIMARY KEY,usage TEXT);`);
    db.run('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?)',
      ['sample-one','サンプル','ready','none',JSON.stringify(models),'1',savedAt,1,JSON.stringify(usage)]);
    db.run('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?)',
      ['sample-two','破損例','unavailable',null,'{broken',null,'bad-date',0,'{"windows":[]}']);
    db.run('INSERT INTO agents(id,name) VALUES (?,?)',['sample-three','未取得']);
    db.run('INSERT INTO agent_usage_cache VALUES (?,?)',['legacy-provider','{}']);
  });
  const agents = list({view:'agents',scope:'app',status:'ready',query:'sample-one'});
  expect(agents).toMatchObject({total:1,statuses:['ready','unavailable'],records:[{name:'サンプル',updatedAt:savedAt}]});
  expect(list({view:'agents'}).total).toBe(3);
  expect(list({view:'agents',scope:projectId}).statuses).toEqual([]);
  const before = fixtureFiles();
  const saved = browser.detail(agents.records[0].id,'agents');
  expect(saved.agent).toMatchObject({availability:'ready',auth:'none',version:'1',checkedAt:savedAt,invalidated:true,models,usage});
  expect(saved.agent?.issues).toEqual(expect.arrayContaining(['接続情報のキャッシュは失効しています','リセット日時を過ぎた利用枠があります']));
  const broken = browser.detail(key('app','agents','sample-two'),'agents');
  expect(broken.agent).toMatchObject({checkedAt:null,models:'{broken',usage:'{"windows":[]}',issues:[
    '接続情報の取得日時が不正です','保存されたモデル一覧が不正です','保存された利用枠が不正です',
  ]});
  expect(browser.detail(key('app','agents','sample-three'),'agents').agent?.issues).toEqual([
    '接続情報は未取得です','モデル一覧は未取得です','利用枠は未取得です',
  ]);
  expect(browser.detail(agents.records[0].id,'db').agent).toBeUndefined();
  errorStatus(() => browser.detail(key('app','agent_usage_cache','legacy-provider'),'agents'),400);
  errorStatus(() => list({view:'agents',status:'a'.repeat(513)}),400);
  expect(fixtureFiles()).toEqual(before);
});

test('不正な ID・パス・テーブル名や保存先へのシンボリックリンクを拒否する', () => {
  for (const id of [
    null, '../beni.sqlite', key('..','tasks',taskId), key('app','sqlite_schema','projects'),
    key('app','constructor','projects'), key('chats','chat','../example'), key(projectId,'events','1 OR 1=1'),
  ]) errorStatus(() => browser.detail(id),400);
  errorStatus(() => browser.detail(key(otherProjectId,'tasks',taskId)),404);
  errorStatus(() => list({path:'example'}),400);
  errorStatus(() => list({scope:'../example'}),400);
  errorStatus(() => list({offset:'-1'}),400);
  errorStatus(() => list({view:'rows'}),400);
  errorStatus(() => list({view:'db',database:'../example'}),400);
  errorStatus(() => list({view:'db',database:'01990000-0000-7000-8000-000000000003'}),400);
  for (const table of ['sqlite_schema','sample_unmanaged','constructor','tasks;SELECT 1']) {
    errorStatus(() => list({view:'db',table}),400);
  }
  for (const param of ['view','database','table']) {
    errorStatus(() => browser.list(new URLSearchParams([[param,'db'],[param,'db']])),400);
  }
  rmSync(otherPath);
  symlinkSync(projectPath,otherPath);
  const chatPath = join(chatFolder,chatId + '.json');
  rmSync(chatPath);
  symlinkSync(join(chatFolder,orphanId + '.json'),chatPath);
  expect(list().errors.map(error => error.source)).toEqual([otherPath]);
  expect(chats().errors.map(error => error.source)).toEqual([chatPath]);
  errorStatus(() => browser.detail(key('chats','chat',chatId)),500);
  errorStatus(() => browser.detail(key(otherProjectId,'project_identity','1')),500);

  renameSync(chatFolder,join(root,'moved'));
  symlinkSync(join(root,'moved'),chatFolder);
  expect(chats().total).toBe(0);
  errorStatus(() => browser.detail(key('chats','chat',orphanId)),500);
});

test('WAL の保存元を SQLite で開かず、共有メモリーを作成しない', () => {
  withFixtureDb(otherPath, db => { db.exec('PRAGMA journal_mode=WAL'); });
  const before = fixtureFiles();
  expect(list().errors.map(error => error.source)).toEqual([otherPath]);
  expect(fixtureFiles()).toEqual(before);
  expect(existsSync(otherPath + '-shm')).toBe(false);
});

test('HTTP API は読み取り専用で、失敗の種類を返す', async () => {
  const store = new Store(':memory:');
  try {
    const handle = createHandler(store);
    const request = (path: string, method?: string) => handle(new Request('http://127.0.0.1' + path,{method}));
    const response = await request('/api/data?kind=instruction&limit=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data = await response.json() as ReturnType<typeof list>;
    expect(data.errors).toEqual([]);
    expect(data.records).toHaveLength(1);
    expect((await request('/api/data/detail?id=' + data.records[0].id)).status).toBe(200);
    const raw = await request('/api/data/detail?view=db&id=' + data.records[0].id);
    expect(raw.status).toBe(200);
    expect(await raw.json()).toMatchObject({database:'app',table:'document_heads',history:[]});
    expect((await request('/api/data?view=chats')).status).toBe(200);
    expect((await request('/api/data?view=events')).status).toBe(200);
    expect((await request('/api/data?view=workflows')).status).toBe(400);
    expect((await request('/api/data/detail?view=workflows&id=' + key('app','instruction_jobs','1'))).status).toBe(400);
    expect((await request('/api/data/detail?view=chats&id=' + data.records[0].id)).status).toBe(400);
    expect((await request('/api/data/detail?view=events&id=' + data.records[0].id)).status).toBe(400);
    expect((await request('/api/data/detail?view=db&view=files&id=' + data.records[0].id)).status).toBe(400);
    expect((await request('/api/data/detail?view=unknown&id=' + data.records[0].id)).status).toBe(400);
    expect((await request('/api/data/detail?id=bad')).status).toBe(400);
    expect((await request('/api/data/detail?id=' + key('app','projects',projectId))).status).toBe(404);
    expect((await request('/api/data','POST')).status).not.toBe(200);
  } finally {
    store.close();
  }
});

test('SQLは実在のテーブルとビューを検出し、JOIN・WITH・EXPLAINを読み取り専用で実行する', async () => {
  withFixtureDb(projectPath, db => db.exec(`
    CREATE VIEW "sample ""view""" AS SELECT id FROM sample_unmanaged;
    INSERT INTO sample_unmanaged VALUES ('sample');
  `));
  const before = fixtureFiles();
  const catalog = await browser.sqlCatalog(projectId);
  expect(catalog).toMatchObject({database:projectId,databases:[
    {id:'app',name:'アプリ共通',source:appPath},
    {id:projectId,name:'星図ノート',source:projectPath},
    {id:otherProjectId,name:'野鳥ログ',source:otherPath},
  ]});
  expect(catalog.tables).toEqual(expect.arrayContaining([
    expect.objectContaining({name:'sqlite_schema',type:'table',sql:null}),
    {name:'sample_unmanaged',type:'table',sql:'CREATE TABLE sample_unmanaged(id TEXT PRIMARY KEY)',
      columns:[{name:'id',type:'TEXT',notnull:false,pk:true}]},
    {name:'sample "view"',type:'view',sql:'CREATE VIEW "sample ""view""" AS SELECT id FROM sample_unmanaged',
      columns:[{name:'id',type:'TEXT',notnull:false,pk:false}]},
  ]));
  expect(await browser.executeSql(projectId,`
    WITH sample AS (SELECT id FROM "sample ""view""")
    SELECT s.id AS value, d.type AS value, NULL AS none, x'00ff' AS blob, 9223372036854775807 AS integer
    FROM sample s JOIN sqlite_schema d ON d.name='sample_unmanaged'
  `)).toMatchObject({
    columns:['value','value','none','blob','integer'],
    rows:[['sample','table',null,{type:'blob',hex:'00ff',bytes:2},{type:'integer',value:'9223372036854775807'}]],
    truncated:false,
  });
  expect(await browser.executeSql(projectId,'SELECT id, name FROM tasks WHERE 0')).toMatchObject({
    columns:['id','name'], rows:[], truncated:false,
  });
  expect(await browser.executeSql(projectId,'EXPLAIN QUERY PLAN SELECT id FROM tasks')).toMatchObject({
    columns:['id','parent','notused','detail'],
  });
  expect(fixtureFiles()).toEqual(before);
});

test('SQLは複数文・変更・パラメーターを拒否し、SQL構文エラーに入力値を含めない', async () => {
  const before = fixtureFiles();
  expect(await browser.executeSql('app',`/* prefix ; */ SELECT 'a;''b', '--;' /* comment ; */; -- tail ;
  /* comment */`)).toMatchObject({rows:[["a;'b","--;"]]});
  for (const [sql,code] of [
    ['SELECT 1; /*comment*/ DELETE FROM projects','multiple'],
    ['SELECT 1; -- end\nSELECT 2','multiple'],
    ['SELECT 1;\0SELECT 2','syntax'],
    ['WITH x AS (SELECT 1) DELETE FROM projects RETURNING id','readonly'],
    ['EXPLAIN UPDATE projects SET name=\'sample\'','readonly'],
    ['PRAGMA journal_mode=WAL','readonly'],
    ['SELECT * FROM pragma_journal_mode','readonly'],
    ["ATTACH DATABASE '/example/sample.sqlite' AS extra",'readonly'],
    ['DETACH DATABASE main','readonly'],
    ['SELECT :sample','bindings'],
    ['SELECT ?','bindings'],
    ['SELECT * FROM private_sample_identifier','syntax'],
  ]) {
    await expect(browser.executeSql('app',sql)).rejects.toMatchObject({code,status:400});
  }
  await expect(browser.executeSql('app',"SELECT load_extension('/example/sample')")).rejects.toMatchObject({status:400});
  expect(fixtureFiles()).toEqual(before);
});

test('SQLは登録されたDBのみに接続し、シンボリックリンクとWALを拒否する', async () => {
  const unregistered = '01990000-0000-7000-8000-000000000003';
  const unregisteredPath = join(root,'projects',unregistered + '.sqlite');
  withFixtureDb(unregisteredPath, db => {
    db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY,project_id TEXT)');
    db.run('INSERT INTO project_identity VALUES (1,?)',[unregistered]);
  });
  await expect(browser.executeSql(unregistered,'SELECT 1')).rejects.toMatchObject({status:404});
  await expect(browser.executeSql('../beni.sqlite','SELECT 1')).rejects.toMatchObject({status:400});
  withFixtureDb(otherPath, db => db.exec('PRAGMA journal_mode=WAL'));
  const before = fixtureFiles();
  await expect(browser.sqlCatalog(otherProjectId)).rejects.toMatchObject({status:500});
  await expect(browser.executeSql(otherProjectId,'SELECT 1')).rejects.toMatchObject({status:500});
  expect(fixtureFiles()).toEqual(before);
  expect(existsSync(otherPath + '-shm')).toBe(false);
  rmSync(otherPath);
  symlinkSync(projectPath,otherPath);
  await expect(browser.executeSql(otherProjectId,'SELECT 1')).rejects.toMatchObject({status:500});
  rmSync(otherPath);
  withFixtureDb(otherPath, db => {
    db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY,project_id TEXT)');
    db.run('INSERT INTO project_identity VALUES (1,?)',[projectId]);
  });
  await expect(browser.executeSql(otherProjectId,'SELECT 1')).rejects.toMatchObject({status:500});
});

test('SQLは件数・セル・レスポンスの上限で切り詰める', async () => {
  const recursive = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n)';
  expect(await browser.executeSql('app',recursive + ' SELECT i FROM n LIMIT 500')).toMatchObject({truncated:false});
  const capped = await browser.executeSql('app',recursive + ' SELECT i FROM n');
  expect(capped.rows).toHaveLength(500);
  expect(capped.truncated).toBe(true);
  const cells = await browser.executeSql('app',"SELECT replace(hex(zeroblob(21846)),'00','界'),zeroblob(65537)");
  expect(cells).toMatchObject({truncated:true,rows:[[
    {type:'text',value:'界'.repeat(21845),bytes:65538,truncated:true},
    {type:'blob',hex:'00'.repeat(65536),bytes:65537,truncated:true},
  ]]});
  const response = await browser.executeSql('app',recursive + ' SELECT zeroblob(65536) FROM n');
  expect(response.truncated).toBe(true);
  expect(response.rows.length).toBeGreaterThan(0);
  expect(response.rows.length).toBeLessThan(500);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(4 * 1024 * 1024);
  await expect(browser.executeSql('app','SELECT zeroblob(1000000000)')).rejects.toMatchObject({code:'resource',status:400});
});

test('SQLの時間切れ・中断・同時実行上限の後も、次の読み取りを実行できる', async () => {
  const slow = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n) SELECT count(i) FROM n';
  const cancel = new AbortController();
  const timeout = browser.executeSql('app',slow).catch(error => error);
  const cancelled = browser.executeSql('app',slow,cancel.signal).catch(error => error);
  await expect(browser.executeSql('app','SELECT 1')).rejects.toMatchObject({code:'busy',status:429});
  await Bun.sleep(100);
  cancel.abort();
  expect(await cancelled).toMatchObject({code:'cancelled',status:408});
  expect(await browser.executeSql('app','SELECT 2')).toMatchObject({rows:[[2]]});
  expect(await timeout).toMatchObject({code:'timeout',status:408});
  expect(await browser.executeSql('app','SELECT 3')).toMatchObject({rows:[[3]]});
}, 6000);

test('SQL HTTP APIはメモリーDBの複製を読み、同一オリジンとJSON本文を要求する', async () => {
  const store = new Store(':memory:');
  try {
    const handle = createHandler(store);
    const origin = 'http://127.0.0.1';
    const url = origin + '/api/data/sql';
    const get = (query = '') => handle(new Request(url + query));
    const post = (body: object, headers = {origin,'content-type':'application/json'}) =>
      handle(new Request(url,{method:'POST',headers,body:JSON.stringify(body)}));
    const sql = {database:'app',sql:'SELECT count(*) AS n FROM projects'};
    const catalog = await get();
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('Cache-Control')).toBe('no-store');
    expect(await catalog.json()).toMatchObject({database:'app',tables:expect.arrayContaining([
      expect.objectContaining({name:'projects',type:'table'}),
    ])});
    expect((await get('?database=app&database=app')).status).toBe(400);
    expect((await get('?sql=select%201')).status).toBe(400);
    expect((await post(sql,{origin:'https://example.com','content-type':'application/json'})).status).toBe(403);
    expect((await post(sql,{origin,'content-type':'text/plain'})).status).toBe(403);
    expect((await post({...sql,params:[]})).status).toBe(400);
    const result = await post(sql);
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toMatchObject({columns:['n'],rows:[[0]]});
    const invalid = await post({...sql,sql:'SELECT * FROM private_sample_identifier'});
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({error:'SQLの構文やテーブル名、列名を確認してください'});
    expect((await post({...sql,sql:'SELECT 1 --' + ' '.repeat(65536 - 11)})).status).toBe(200);
    expect((await post({...sql,sql:"SELECT '" + '界'.repeat(21846) + "'"})).status).toBe(413);
    const projectFolder = join(root,'workspace');
    mkdirSync(projectFolder);
    store.createProject('Sample',projectFolder);
    expect(await (await post(sql)).json()).toMatchObject({rows:[[1]]});
  } finally {
    store.close();
  }
});
