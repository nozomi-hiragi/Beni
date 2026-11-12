import { test, expect, spyOn } from 'bun:test';
import { Store } from './index';
import { AgentTable } from './agents';
import { Database } from 'bun:sqlite';
import { copyFileSync, linkSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultInstructions } from '../instructions';
import { initialImplementationPlan } from '../documents';
import { newMetadata, writeJson } from '../data';
import { generateId, validProjectId, validTaskId } from '../../shared/ids';
import { INSTRUCTIONS_CHAT_ID } from '../../shared/communication';
import { withDatabase } from '../project-events';
import { encodeChatHistory } from '../chat-history';
import { ChatStore, type ChatScope } from '../chat-store';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beni-store-'));
  const folder = join(root, 'project');
  mkdirSync(folder);
  return {
    root,
    folder,
    path: join(root, 'beni.sqlite')
  };
}
function legacyTask(projectDirectory: string, name: string) {
  const value = newMetadata('task', name);
  const path = join(projectDirectory, 'tasks', value.id);
  mkdirSync(path, {recursive: true});
  writeFileSync(join(path, 'requirements.md'), `# ${name}\n`);
  writeFileSync(join(path, 'documents.md'), '# 仕様整理\n\n## 資料\n\n## 仕様\n');
  writeFileSync(join(path, 'implementation.md'), initialImplementationPlan);
  writeJson(join(path, 'task.json'), {...value, phase: 'requirements', status: 'idle'});
  return value;
}
const emptyChat = (scope:ChatScope,id:string) => encodeChatHistory({
  ...scope,id,version:1,threadId:null,sessionId:null,lastEventId:0,selectedModel:null,messages:[],packs:[]
});
const createChat = (chats:ChatStore,scope:ChatScope,previousId?:string) =>
  chats.create(scope,id=>emptyChat(scope,id),previousId);
const evidencedText = (text: string) => [{text, reason: '合意した修正', sources: [{kind: 'message' as const, id: 'message', text}]}];

test('canonical metadata persists tasks and recovers documents idempotently', () => {
  const f = fixture();
  try {
    let store = new Store(f.path);
    const p = store.createProject('Demo', f.folder),
      t = store.createTask(p.id, 'Task');
    expect(validProjectId(p.id)).toBe(true);
    expect(validTaskId(t.id)).toBe(true);
    expect(validProjectId(t.id)).toBe(false);
    expect(store.managedDocument(p.id, t.id, 'requirements.md')?.content).toBe('# Task\n');
    const root = store.legacyProjectDirectory(p.id);
    const databasePath = join(f.root, 'projects', p.id + '.sqlite');
    expect(store.projectDatabasePath(p.id)).toBe(databasePath);
    expect(existsSync(databasePath)).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(root, 'tasks', t.id, 'requirements.md'))).toBe(false);
    expect(existsSync(join(f.folder, '.beni'))).toBe(false);
    store.close();
    const orphan = join(root, 'tasks', '12');
    mkdirSync(orphan, {recursive: true});
    writeFileSync(join(orphan, 'requirements.md'), 'unchanged\r\n');
    store = new Store(f.path);
    const tasks = store.tasks();
    expect(tasks.length).toBe(2);
    const recovered = tasks.find(t => t.name === 'Unknown')!;
    expect(readFileSync(join(root, 'tasks', recovered.id, 'requirements.md'), 'utf8')).toBe('unchanged\r\n');
    expect(store.tasks()).toEqual(tasks);
    expect(() => store.createTask(p.id, 'bad', () => {
      throw Error('fail');
    })).toThrow();
    expect(store.tasks().length).toBe(2);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('moves preserve IDs and live duplicate project IDs are rejected', () => {
  const f = fixture();
  try {
    const store = new Store(f.path),
      p = store.createProject('Demo', f.folder),
      t = store.createTask(p.id, 'Task');
    const duplicate = join(f.root, 'duplicate');
    mkdirSync(duplicate);
    mkdirSync(join(duplicate, '.beni'));
    copyFileSync(store.projectDatabasePath(p.id), join(duplicate, '.beni', 'project.sqlite'));
    expect(() => store.createProject('Duplicate', duplicate)).toThrow('Duplicate live project');
    const moved = join(f.root, 'moved');
    renameSync(f.folder, moved);
    expect(store.project(p.id)).toMatchObject({folderAvailable: false});
    expect(store.tasks(p.id).map(task => task.id)).toEqual([t.id]);
    expect(store.changeProjectFolder(p.id, moved)).toEqual({...p, folder: realpathSync(moved)});
    expect(store.projects().length).toBe(1);
    expect(store.tasks(p.id).map(task => task.id)).toEqual([t.id]);
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('legacy store refuses startup without changing existing data', () => {
  const f = fixture();
  try {
    const db = new Database(f.path);
    db.exec('CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,folder TEXT);CREATE TABLE tasks(id INTEGER PRIMARY KEY,project_id INTEGER,name TEXT,phase TEXT,status TEXT)');
    db.query('INSERT INTO projects VALUES(1,?,?)').run('Demo', f.folder);
    db.exec("INSERT INTO tasks VALUES(2,1,'Task','requirements','idle')");
    db.close();
    const before = readFileSync(f.path);
    expect(() => new Store(f.path)).toThrow('Legacy data is unsupported');
    expect(readFileSync(f.path)).toEqual(before);
    expect(readdirSync(f.root).sort()).toEqual(['beni.sqlite', 'project']);
  } finally { rmSync(f.root, {recursive: true, force: true}); }
});
test('invalid and future metadata and unsafe orphan files are never rewritten', () => {
  const f = fixture();
  let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder);
    const root = store.legacyProjectDirectory(p.id), projectFile = join(root, 'project.json');
    mkdirSync(root);
    const original = {version: 1, id: p.id, name: p.name, createdAt: null, updatedAt: null};
    for (const invalid of [{
      ...original,
      version: 2
    }, {
      ...original,
      createdAt: '2026-02-30T00:00:00.000Z'
    }, {
      ...original,
      id: generateId('project')
    }]) {
      writeFileSync(projectFile, JSON.stringify(invalid));
      store.close();
      store = new Store(f.path);
      expect(store.projects()[0]).toMatchObject({id: p.id, storageError: expect.any(String)});
      expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual(invalid);
    }
    const outsideJson = join(f.root, 'project-metadata.json');
    writeFileSync(outsideJson, JSON.stringify(original));
    for (const link of [symlinkSync, linkSync]) {
      rmSync(projectFile);
      link(outsideJson, projectFile);
      store.close();
      store = new Store(f.path);
      expect(store.project(p.id)?.storageError).toBeTruthy();
      expect(readFileSync(projectFile, 'utf8')).toBe(JSON.stringify(original));
      expect(readFileSync(outsideJson, 'utf8')).toBe(JSON.stringify(original));
    }
    rmSync(projectFile);
    store.close();
    store = new Store(f.path);
    expect(store.project(p.id)?.storageError).toBeUndefined();
    const orphan = join(root, 'tasks', '99');
    mkdirSync(orphan, {recursive: true});
    writeFileSync(join(f.root, 'outside.md'), 'original');
    linkSync(join(f.root, 'outside.md'), join(orphan, 'requirements.md'));
    expect(() => store.migrateTasks()).toThrow('Invalid tracked document');
    expect(existsSync(join(orphan, 'task.json'))).toBe(false);
    rmSync(join(orphan, 'requirements.md'));
    symlinkSync(join(f.root, 'missing'), join(orphan, 'task.json'));
    expect(() => store.migrateTasks()).toThrow();
  } finally {
    store.close();
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});

test('集約済みproject.jsonを日時ごと取り込み、途中停止後は同じ値だけを確定する', () => {
  const f = fixture();
  let store = new Store(f.path);
  const registry = new Database(f.path);
  try {
    const project = store.createProject('旧一覧名', f.folder);
    const root = store.legacyProjectDirectory(project.id), legacyPath = join(root, 'project.json');
    expect(existsSync(legacyPath)).toBe(false);
    const readRow = () => registry.query('SELECT name,createdAt,updatedAt,metadata_migrated FROM projects WHERE id=?').get(project.id);
    expect(readRow()).toMatchObject({name: '旧一覧名', createdAt: expect.any(String), updatedAt: expect.any(String), metadata_migrated: 1});
    const legacy = {version: 1, id: project.id, name: '保存済みの名前', createdAt: '2025-05-20T01:02:03.004Z', updatedAt: null};
    mkdirSync(root);
    writeJson(legacyPath, legacy);
    const projectDbPath = store.projectDatabasePath(project.id), nestedDatabasePath = join(root, 'project.sqlite');
    renameSync(projectDbPath, nestedDatabasePath);
    const projectDb = new Database(nestedDatabasePath);
    try { projectDb.exec('DROP TABLE project_identity'); } finally { projectDb.close(); }
    registry.query('UPDATE projects SET createdAt=NULL,updatedAt=NULL,metadata_migrated=0 WHERE id=?').run(project.id);
    registry.exec("CREATE TRIGGER fail_metadata BEFORE UPDATE OF metadata_migrated ON projects BEGIN SELECT RAISE(ABORT, 'simulated metadata failure'); END");
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.storageError).toContain('migrate-projects.ts');
    expect(existsSync(projectDbPath)).toBe(false);
    expect(existsSync(nestedDatabasePath)).toBe(true);
    expect(() => store.migrateProjectDatabases()).toThrow('simulated metadata failure');
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(legacy);
    expect(readRow()).toMatchObject({name: '旧一覧名', metadata_migrated: 0});
    registry.exec('DROP TRIGGER fail_metadata');
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.name).toBe(legacy.name);
    expect(store.projectDatabasePath(project.id)).toBe(projectDbPath);
    expect(existsSync(nestedDatabasePath)).toBe(false);
    expect(store.migrateProjectDatabases()).toEqual({migrated: 0});
    expect(readRow()).toEqual({name: legacy.name, createdAt: legacy.createdAt, updatedAt: null, metadata_migrated: 1});
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(root)).toBe(false);
    // DB確定後、旧JSON削除前に停止した状態も同じ値を照合して完了する。
    mkdirSync(root);
    writeJson(legacyPath, legacy);
    store.close();
    store = new Store(f.path);
    expect(existsSync(legacyPath)).toBe(false);
    registry.query('UPDATE projects SET name=? WHERE id=?').run('DBでの新しい名前', project.id);
    mkdirSync(root);
    writeJson(legacyPath, legacy);
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)).toMatchObject({name: 'DBでの新しい名前', storageError: expect.any(String)});
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(legacy);
    expect(readRow()).toMatchObject({name: 'DBでの新しい名前', createdAt: legacy.createdAt, updatedAt: null});
  } finally { registry.close(); store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('移行済み領域は所属の相違やDBの欠落時に再初期化しない', () => {
  const f = fixture();
  let store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder);
    const root = store.legacyProjectDirectory(project.id), path = store.projectDatabasePath(project.id);
    mkdirSync(root);
    const legacy = newMetadata('project', project.name);
    const file = join(root, 'project.json');
    writeJson(file, {...legacy, id: project.id});
    const db = new Database(path);
    try { db.query('UPDATE project_identity SET project_id=?').run(legacy.id); } finally { db.close(); }
    const before = readFileSync(path);
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.storageError).toBeTruthy();
    expect(() => store.projectDatabasePath(project.id)).toThrow('Project ID mismatch');
    expect(readFileSync(path)).toEqual(before);
    expect(existsSync(file)).toBe(true);
    rmSync(file);
    const backup = join(root, 'saved.sqlite');
    renameSync(path, backup);
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.storageError).toBeTruthy();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(backup)).toEqual(before);
    renameSync(backup, path);
    const missingIdentity = new Database(path);
    try { missingIdentity.exec('DROP TABLE project_identity'); } finally { missingIdentity.close(); }
    const withoutIdentity = readFileSync(path);
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.storageError).toBeTruthy();
    expect(readFileSync(path)).toEqual(withoutIdentity);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});
test('task rows expose canonical creation dates including unknown dates', () => {
  const f = fixture();
  const store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder);
    const task = store.createTask(project.id, 'Task');
    const databasePath = store.projectDatabasePath(project.id);
    const readDates = () => withDatabase(databasePath, db => db.query<{createdAt: string | null; updatedAt: string | null}, [string]>(
      'SELECT created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE id=?').get(task.id)!);
    const setDates = (createdAt: string | null, updatedAt: string | null) => withDatabase(databasePath, db =>
      db.query('UPDATE tasks SET created_at=?,updated_at=? WHERE id=?').run(createdAt, updatedAt, task.id));
    expect(readDates()).toEqual({createdAt: task.createdAt, updatedAt: task.updatedAt});
    setDates('2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06.000Z');
    expect(store.tasks(project.id)[0]!.createdAt).toBe(readDates().createdAt);
    expect(store.task(task.id)!.createdAt).toBe(readDates().createdAt);
    expect(store.task(task.id)!.updatedAt).toBe(readDates().updatedAt);
    setDates(null, null);
    expect(store.task(task.id)!.createdAt).toBeNull();
    expect(store.task(task.id)!.updatedAt).toBeNull();
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('document activity survives restart and ignores initial unknown dates and timestamp-only changes', async () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder), root = store.legacyProjectDirectory(project.id), task = legacyTask(root, 'Task');
    const path = join(root, 'tasks', task.id), file = join(path, 'task.json');
    const original = JSON.parse(readFileSync(file, 'utf8'));
    original.createdAt = null; original.updatedAt = null; delete original.documentBaseline;
    writeFileSync(file, JSON.stringify(original));
    store.migrateTasks();
    const readBaseline = () => withDatabase(store.projectDatabasePath(project.id), db => db.query('SELECT document_baseline FROM tasks WHERE id=?').get(task.id));
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    const baseline = readBaseline();
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    expect(readBaseline()).toEqual(baseline);
    store.close(); await Bun.sleep(5);
    writeFileSync(join(path, 'requirements.md'), '# Offline edit\n');
    store = new Store(f.path);
    const edited = store.tasks()[0]!;
    expect(edited.createdAt).toBeNull(); expect(edited.updatedAt).not.toBeNull();
    writeFileSync(join(path, 'large.md'), 'a'.repeat(1024 * 1024 + 1));
    expect(() => store.tasks()).toThrow('Tracked document exceeds 1 MiB');
    rmSync(join(path, 'large.md'));
    const stable = store.tasks()[0]!.updatedAt;
    writeFileSync(join(path, 'requirements.md'), '# Offline edit\n');
    expect(store.tasks()[0]!.updatedAt).toBe(stable);
    const {statSync, utimesSync} = await import('node:fs');
    const priorStat = statSync(join(path, 'requirements.md'));
    await Bun.sleep(5);
    writeFileSync(join(path, 'requirements.md'), '# Preserved timestamp edit\n');
    utimesSync(join(path, 'requirements.md'), priorStat.atime, priorStat.mtime);
    // A preserved (or older rounded) timestamp must never regress a newer activity.
    const preserved = store.tasks()[0]!.updatedAt;
    expect(preserved! >= stable!).toBe(true);
    await Bun.sleep(5); rmSync(join(path, 'requirements.md'));
    expect(store.tasks()[0]!.updatedAt! > stable!).toBe(true);
    const removed = store.task(task.id)!.updatedAt;
    expect(store.managedDocument(project.id, task.id, 'requirements.md')?.content).toBe('# Task\n');
    expect(store.task(task.id)!.updatedAt).toBe(removed);
    mkdirSync(join(f.root, 'other'));
    const other = store.createProject('Other', join(f.root, 'other'));
    expect(() => store.touchTask(other.id, task.id)).toThrow('Unknown task');
  } finally { store.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('task deletion removes only scoped documents and chat and rejects unsafe chat links', () => {
 const f=fixture(), store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder), target=store.createTask(p.id,'Target'), other=store.createTask(p.id,'Other');
  const root=store.legacyProjectDirectory(p.id), scope={projectId:p.id,taskId:target.id,phase:'requirements'} as const;
  const targetPath=store.chats.path(createChat(store.chats,scope).id);
  const generalPath=store.chats.path(createChat(store.chats,{...scope,taskId:null,phase:null}).id);
  const otherPath=store.chats.path(createChat(store.chats,{...scope,taskId:other.id}).id);
  mkdirSync(join(root,'old'),{recursive:true});writeFileSync(join(root,'old','archive.json'),'archive');
  const external=join(f.root,'external.json'),backup=targetPath+'.backup';
  writeFileSync(external,'safe');renameSync(targetPath,backup);symlinkSync(external,targetPath);
  expect(()=>store.deleteTask(p.id,target.id)).toThrow('Invalid metadata file');
  expect(store.task(target.id)).not.toBeNull();expect(readFileSync(external,'utf8')).toBe('safe');
  rmSync(targetPath);renameSync(backup,targetPath);
  expect(()=>store.deleteTask(generateId('project'),target.id)).toThrow();
  store.deleteTask(p.id,target.id);
  expect(store.tasks().map(t=>t.id)).toEqual([other.id]);expect(existsSync(targetPath)).toBe(false);
  expect(existsSync(generalPath)).toBe(true);expect(existsSync(otherPath)).toBe(true);
  expect(readFileSync(join(root,'old','archive.json'),'utf8')).toBe('archive');
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task deletion recovery rolls back incomplete moves and never restores committed partial cleanup', () => {
 const f=fixture();
 let store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),root=store.legacyProjectDirectory(p.id);mkdirSync(join(root,'chat'),{recursive:true});
  mkdirSync(join(root, 'tasks', t.id), {recursive: true});
  const staged=join(root,`.deleting-${t.id}`);mkdirSync(staged);writeFileSync(join(staged,'journal.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));
  renameSync(join(root,'tasks',t.id),join(staged,'task'));writeFileSync(join(staged,'chat.json'),'{}');
  store.close();store=new Store(f.path);
  expect(store.tasks().map(t=>t.id)).toContain(t.id);expect(readFileSync(join(root,'chat',`${t.id}.json`),'utf8')).toBe('{}');expect(existsSync(staged)).toBe(false);
  mkdirSync(staged);renameSync(join(root,'tasks',t.id),join(staged,'task'));renameSync(join(root,'chat',`${t.id}.json`),join(staged,'chat.json'));
  writeFileSync(join(staged,'committed.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));
  store.close();store=new Store(f.path);
  expect(store.tasks()).toEqual([]);expect(existsSync(staged)).toBe(false);expect(existsSync(join(root,'chat',`${t.id}.json`))).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('recovery discards an initial journal write interrupted before any source was moved', () => {
 const f=fixture();
 let store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),staged=join(store.legacyProjectDirectory(p.id),`.deleting-${t.id}`);mkdirSync(staged,{recursive:true});writeFileSync(join(staged,'journal.json.tmp-00000000-0000-0000-0000-000000000000'),'{');
  store.close();store=new Store(f.path);
  expect(store.tasks().map(t=>t.id)).toEqual([t.id]);expect(existsSync(staged)).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('DBで確定したタスク削除を会話の削除前の停止から復旧する', () => {
  const f = fixture();
  let store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder), task = store.createTask(project.id, 'Task');
    const root = store.legacyProjectDirectory(project.id), folder = join(root, 'tasks', task.id);
    mkdirSync(folder, {recursive: true});
    const scope = {projectId: project.id, taskId: task.id, phase: 'requirements'} as const;
    const chat = createChat(store.chats, scope);
    const path = store.chats.path(chat.id);
    const finish = spyOn(store.chats, 'finishDeletion').mockImplementationOnce(() => { throw Error('simulated interruption'); });
    try {
      expect(() => store.deleteTask(project.id, task.id)).toThrow('simulated interruption');
    } finally { finish.mockRestore(); }
    expect(store.task(task.id)).toBeNull();
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(root, `.deleting-${task.id}`, 'journal.json'))).toBe(true);
    store.close();
    // 残存するMarkdownのフォルダーがあっても、削除済みのタスクは復元されない。
    mkdirSync(folder);
    writeFileSync(join(folder, 'requirements.md'), '# 削除済み');
    store = new Store(f.path);
    expect(store.task(task.id)).toBeNull();
    expect(store.chats.ref(chat.id)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(store.taskEvents(project.id, task.id).events.filter(event => event.type === 'task.deleted')).toHaveLength(1);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('task history retains created, updated, renamed and deleted document versions across restart', () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = legacyTask(store.legacyProjectDirectory(p.id), 'Task');
    store.migrateTasks();
    const folder = join(store.legacyProjectDirectory(p.id), 'tasks', task.id);
    const initial = store.taskEvents(p.id, task.id);
    expect(initial.events.map(event => event.type)).toEqual(['task.created', 'document.created', 'document.created', 'document.created']);
    expect(initial.events.every(event => event.sourcePhase === null)).toBe(true);
    const original = initial.events.find(event => event.path === 'requirements.md')!;
    writeFileSync(join(folder, 'requirements.md'), 'updated\r\n');
    store.reconcileTaskDocuments(p.id, task.id);
    const updated = store.taskEvents(p.id, task.id, initial.lastEventId).events[0]!;
    expect(updated).toMatchObject({type: 'document.updated', previousVersion: original.version, path: 'requirements.md', sourcePhase: null});
    renameSync(join(folder, 'requirements.md'), join(folder, 'notes.md'));
    const renamed = store.taskEvents(p.id, task.id, updated.id).events[0]!;
    expect(renamed).toMatchObject({type: 'document.renamed', previousPath: 'requirements.md', path: 'notes.md', version: updated.version});
    rmSync(join(folder, 'notes.md'));
    const deleted = store.taskEvents(p.id, task.id, renamed.id).events[0]!;
    expect(deleted).toMatchObject({type: 'document.deleted', path: 'notes.md', version: updated.version});
    store.close(); store = new Store(f.path);
    expect(store.taskEvents(p.id, task.id).lastEventId).toBe(deleted.id);
    expect(store.taskEventVersion(p.id, task.id, original.version!).content).toBe('# Task\n');
    expect(store.taskEventVersion(p.id, task.id, deleted.version!).content).toBe('updated\r\n');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history pagination fixes through and validates unknown cursors and references', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const first = store.taskEvents(p.id, task.id, 0, undefined, 1);
    expect(first).toMatchObject({lastEventId: 1, through: 4, hasMore: true});
    store.writeManagedDocument(p.id, task.id, 'extra.md', null, evidencedText('later'), 'author');
    const next = store.taskEvents(p.id, task.id, first.lastEventId, first.through, 100);
    expect(next.events.map(event => event.id)).toEqual([2, 3, 4]);
    expect(next).toMatchObject({lastEventId: 4, through: 4, hasMore: false});
    expect(store.taskEvents(p.id, task.id, 4).events.map(event => event.id)).toEqual([5]);
    expect(store.taskEvents(p.id, task.id, 3, 3).lastEventId).toBe(3);
    for (const args of [[-1], [1.5], [0, 1.5], [3, 2], [0, undefined, 0], [0, undefined, 101]] as [number, number?, number?][]) expect(() => store.taskEvents(p.id, task.id, ...args)).toThrow('Invalid event cursor');
    expect(() => store.taskEvents(p.id, task.id, 99)).toThrow('Unknown event cursor');
    expect(() => store.taskEvents(p.id, task.id, 0, 99)).toThrow('Unknown event cursor');
    expect(() => store.taskEventVersion(p.id, task.id, '../task.json')).toThrow('Invalid history version');
    expect(() => store.taskEventVersion(p.id, task.id, '0'.repeat(64))).toThrow('Unknown history version');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('ambiguous document moves stay separate events and phase transitions preserve history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = legacyTask(store.legacyProjectDirectory(p.id), 'Task'), folder = join(store.legacyProjectDirectory(p.id), 'tasks', task.id);
    store.migrateTasks();
    writeFileSync(join(folder, 'one.md'), 'same'); writeFileSync(join(folder, 'two.md'), 'same');
    const before = store.taskEvents(p.id, task.id).lastEventId;
    renameSync(join(folder, 'one.md'), join(folder, 'three.md')); renameSync(join(folder, 'two.md'), join(folder, 'four.md'));
    expect(store.taskEvents(p.id, task.id, before).events.map(event => event.type)).toEqual(['document.deleted', 'document.deleted', 'document.created', 'document.created']);
    const start = store.taskEvents(p.id, task.id).lastEventId;
    store.advanceTaskPhase(p.id, task.id, 'requirements');
    store.advanceTaskPhase(p.id, task.id, 'documents', 'back');
    expect(store.taskEvents(p.id, task.id, start).events).toMatchObject([
      {type: 'phase.changed', from: 'requirements', to: 'documents', sourcePhase: 'requirements'},
      {type: 'phase.changed', from: 'documents', to: 'requirements', sourcePhase: 'documents'}
    ]);
    // 旧版でメタデータ更新後・履歴確定前に中断した状態を取り込む。
    withDatabase(store.projectDatabasePath(p.id), db => db.query("UPDATE tasks SET phase='implementation' WHERE id=?").run(task.id));
    expect(store.taskEvents(p.id, task.id).events.at(-1)).toMatchObject({type: 'phase.changed', from: 'requirements', to: 'implementation', sourcePhase: null});
    expect(() => store.advanceTaskPhase(p.id, task.id, 'requirements')).toThrow('phase conflict');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history rejects linked databases and unsafe current documents without touching their targets', () => {
  for (const target of ['database', 'document', 'hardlink']) {
    const f = fixture(), store = new Store(f.path);
    try {
      const p = store.createProject('Demo', f.folder), task = legacyTask(store.legacyProjectDirectory(p.id), 'Task');
      store.migrateTasks();
      store.taskEvents(p.id, task.id);
      const file = target === 'database' ? store.projectDatabasePath(p.id) : join(store.legacyProjectDirectory(p.id), 'tasks', task.id, 'requirements.md');
      const external = join(f.root, 'external'); writeFileSync(external, 'outside');
      rmSync(file);
      if (target === 'hardlink') linkSync(external, file); else symlinkSync(external, file);
      expect(() => store.taskEvents(p.id, task.id)).toThrow();
      expect(readFileSync(external, 'utf8')).toBe('outside');
    } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
  }
});

test('task deletion removes current and archived phase conversations while preserving other task history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const root = store.legacyProjectDirectory(p.id), directory = join(root, 'tasks', task.id);
    const scope = {projectId:p.id,taskId:task.id,phase:'requirements'} as const;
    const archived = createChat(store.chats, scope);
    const requirements = createChat(store.chats, scope, archived.id);
    const documents = createChat(store.chats, {...scope,phase:'documents'});
    const remaining = store.createTask(p.id, 'Remaining'), before = store.taskEvents(p.id, remaining.id);
    const other = createChat(store.chats, {...scope,taskId:remaining.id});
    store.deleteTask(p.id, task.id);
    expect(existsSync(directory)).toBe(false);
    for(const chat of [archived,requirements,documents]){
      expect(existsSync(store.chats.path(chat.id))).toBe(false);
      expect(store.chats.ref(chat.id)).toBeNull();
    }
    expect(store.chats.read({...scope,taskId:remaining.id})).toEqual(other);
    const after = store.taskEvents(p.id, remaining.id);
    expect(after.events).toEqual(before.events);
    expect(after.through).toBeGreaterThan(before.through);
    expect(after.nextCursor).toBe(after.through);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('チャット作成・アーカイブと削除を保存途中から同じIDで復旧する', () => {
  const f=fixture(),db=new Database(f.path);
  try{
    const scope={projectId:generateId('project'),taskId:generateId('task'),phase:'requirements'} as const;
    const chats=new ChatStore(db,f.root);
    const before=createChat(chats,scope),beforePath=chats.path(before.id);
    const original=readFileSync(beforePath,'utf8');
    db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON chat_refs BEGIN SELECT RAISE(ABORT,'publish interrupted'); END");
    expect(()=>createChat(chats,scope,before.id)).toThrow('publish interrupted');
    const pending=db.query<{chatId:string},[]>("SELECT chat_id AS chatId FROM chat_changes").get()!;
    expect(existsSync(chats.path(pending.chatId))).toBe(true);
    expect(chats.current(scope)?.chatId).toBe(before.id);
    expect(chats.ref(pending.chatId)).toBeNull();
    db.exec('DROP TRIGGER fail_publish');
    const reopened=new ChatStore(db,f.root);
    reopened.recover(scope);
    expect(reopened.current(scope)?.chatId).toBe(pending.chatId);
    expect(reopened.ref(before.id)?.archived).toBe(1);
    expect(readFileSync(beforePath,'utf8')).toBe(original);
    expect(createChat(reopened,scope).id).toBe(pending.chatId);
    expect(reopened.list(scope)).toHaveLength(2);

    reopened.prepareDeletion(scope.projectId,scope.taskId);
    reopened.recoverDeletions(()=>true);
    expect(reopened.list(scope)).toHaveLength(2);
    reopened.prepareDeletion(scope.projectId,scope.taskId);
    rmSync(beforePath);
    reopened.recoverDeletions(()=>false);
    expect(reopened.list(scope)).toEqual([]);
    expect(existsSync(reopened.path(pending.chatId))).toBe(false);

    const general={projectId:scope.projectId,taskId:null,phase:null};
    const workflow={...general,workflowJobId:'completed-job'};
    const other={...general,projectId:generateId('project')};
    const editor={...general,projectId:INSTRUCTIONS_CHAT_ID};
    const removed=[createChat(reopened,general),createChat(reopened,workflow)];
    const kept=[createChat(reopened,other),createChat(reopened,editor)];
    reopened.prepareDeletion(scope.projectId,null);
    reopened.finishDeletion(scope.projectId,null);
    for(const {id} of removed){
      expect(reopened.ref(id)).toBeNull();
      expect(existsSync(reopened.path(id))).toBe(false);
    }
    for(const {id} of kept){
      expect(reopened.ref(id)).not.toBeNull();
      expect(existsSync(reopened.path(id))).toBe(true);
    }
  }finally{db.close();rmSync(f.root,{recursive:true,force:true})}
});

test('phase chat deletion recovery restores uncommitted directories and rejects links', () => {
  const f = fixture();
  let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), root = store.legacyProjectDirectory(p.id);
    mkdirSync(join(root, 'tasks', task.id), {recursive: true});
    const chat = join(root, 'chat', task.id); mkdirSync(chat, {recursive: true});
    writeFileSync(join(chat, 'requirements.json'), '{}');
    const staged = join(root, `.deleting-${task.id}`); mkdirSync(staged);
    writeFileSync(join(staged, 'journal.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(join(root, 'tasks', task.id), join(staged, 'task')); renameSync(chat, join(staged, 'chat'));
    store.close();store=new Store(f.path);
    expect(store.tasks(p.id).map(value => value.id)).toEqual([task.id]);
    const taskDirectory = join(root, 'tasks', task.id);
    expect(readFileSync(join(taskDirectory, 'requirements.chat.json'), 'utf8')).toBe('{}');
    expect(existsSync(chat)).toBe(false);
    const external = join(f.root, 'external.json'); writeFileSync(external, '{}');
    symlinkSync(external, join(taskDirectory, 'documents.json'));
    expect(() => store.deleteTask(p.id, task.id)).toThrow('Invalid metadata file');
    expect(store.task(task.id)).not.toBeNull();
    rmSync(join(taskDirectory, 'documents.json'));
    // 確定済みジャーナルは残ったフェーズ会話を復元せず削除する。
    mkdirSync(staged); writeFileSync(join(staged, 'committed.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(taskDirectory, join(staged, 'task'));
    mkdirSync(join(staged, 'chat')); writeFileSync(join(staged, 'chat', 'documents.json'), '{}');
    store.close();store=new Store(f.path);
    expect(store.tasks(p.id)).toEqual([]); expect(existsSync(staged)).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe('{}');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('SQLite history rolls back failed commits and retries without event gaps', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(store.legacyProjectDirectory(p.id), 'tasks', task.id);
    const before = store.taskEvents(p.id, task.id), database = new Database(store.projectDatabasePath(p.id));
    database.exec("CREATE TRIGGER fail_event BEFORE INSERT ON file_changes BEGIN SELECT RAISE(ABORT, 'simulated history commit failure'); END");
    const write = () => store.writeManagedDocument(p.id, task.id, 'extra.md', null, evidencedText('new version'), 'author');
    expect(write).toThrow('simulated history commit failure');
    expect(store.managedDocument(p.id, task.id, 'extra.md')).toBeUndefined();
    expect(database.query('SELECT MAX(id) AS id FROM events').get()).toEqual({id: before.through});
    expect(database.query('SELECT COUNT(*) AS count FROM file_changes').get()).toEqual({count: 3});
    database.exec('DROP TRIGGER fail_event'); database.close();
    const written = write();
    expect(store.taskEvents(p.id, task.id, before.through).events).toMatchObject([{id: before.through + 1, type: 'document.created', path: 'extra.md', details: {revision: written.revision}}]);
    expect(existsSync(join(folder, '.history'))).toBe(false);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('project cursors advance over other tasks and retained history survives task deletion', () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const first = store.taskEvents(p.id, task.id);
    const original = first.events.find(event => event.path === 'requirements.md')!;
    const other = store.createTask(p.id, 'Other');
    const empty = store.taskEvents(p.id, task.id, first.through, undefined, 1);
    expect(empty.events).toEqual([]); expect(empty.nextCursor).toBeGreaterThan(first.through);
    let cursor = empty.nextCursor;
    while (cursor < empty.through) cursor = store.taskEvents(p.id, task.id, cursor, empty.through, 1).nextCursor;
    expect(cursor).toBe(empty.through);
    const head = store.managedDocument(p.id, task.id, 'requirements.md')!;
    store.writeManagedDocument(p.id, task.id, 'requirements.md', head.revision, evidencedText('final edit\r\n'), 'author');
    store.deleteTask(p.id, task.id);
    const deleted = store.taskEvents(p.id, task.id, first.through);
    expect(deleted.events.map(event => event.type)).toEqual(['document.updated', 'task.deleted']);
    const updated = deleted.events[0]!;
    store.close(); store = new Store(f.path);
    expect(store.task(task.id)).toBeNull();
    expect(store.taskEventVersion(p.id, task.id, original.version!).content).toBe('# Task\n');
    expect(store.projectFileVersion(p.id, `.beni/tasks/${task.id}/requirements.md`, updated.id)).toMatchObject({content: 'final edit\r\n'});
    expect(store.taskEvents(p.id, task.id).events.at(-1)?.type).toBe('task.deleted');
    expect(store.task(other.id)).not.toBeNull();
    mkdirSync(join(f.root, 'other')); const another = store.createProject('Other project', join(f.root, 'other'));
    expect(() => store.projectFileVersion(another.id, `.beni/tasks/${task.id}/requirements.md`, updated.id)).toThrow();
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('task operations emit create rename phase complete and reopen events once', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    store.renameTask(p.id, task.id, 'Renamed'); store.renameTask(p.id, task.id, 'Renamed');
    store.selectTaskPhase(p.id, task.id, 'requirements', 'retrospective');
    store.setTaskCompleted(p.id, task.id, true); store.setTaskCompleted(p.id, task.id, false);
    const operations = store.taskEvents(p.id, task.id).events.filter(event => !event.type.startsWith('document.'));
    expect(operations.map(event => event.type)).toEqual(['task.created', 'task.renamed', 'phase.changed', 'task.completed', 'task.reopened']);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('終了済みタスクの再開時はフェーズと再開イベントをまとめて記録する', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    store.selectTaskPhase(p.id, task.id, 'requirements', 'retrospective');
    store.startTaskFinalization(p.id, task.id);
    store.setTaskCompleted(p.id, task.id, true, 'finalization');
    const completed = store.task(task.id);
    const before = store.taskEvents(p.id, task.id);
    const db = new Database(store.projectDatabasePath(p.id));
    try {
      db.exec("CREATE TRIGGER fail_reopen BEFORE INSERT ON events WHEN NEW.type='task.reopened' BEGIN SELECT RAISE(ABORT, 'simulated reopen failure'); END");
      expect(() => store.setTaskCompleted(p.id, task.id, false, 'finalization')).toThrow('simulated reopen failure');
      expect(store.task(task.id)).toEqual(completed);
      expect(store.taskEvents(p.id, task.id)).toEqual(before);
      db.exec('DROP TRIGGER fail_reopen');
    } finally { db.close(); }
    expect(store.setTaskCompleted(p.id, task.id, false, 'finalization')).toMatchObject({phase: 'retrospective', status: 'idle'});
    const reopened = store.taskEvents(p.id, task.id, before.through).events;
    expect(reopened.map(event => event.type)).toEqual(['phase.changed', 'task.reopened']);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('task deletion refuses a document that cannot be preserved in history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = legacyTask(store.legacyProjectDirectory(p.id), 'Task');
    store.migrateTasks();
    const path = join(store.legacyProjectDirectory(p.id), 'tasks', task.id, 'requirements.md');
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    expect(() => store.deleteTask(p.id, task.id)).toThrow('Tracked document exceeds 1 MiB');
    expect(store.task(task.id)).not.toBeNull();
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test.each(['task', 'chat.json'])('task deletion rolls back if moving %s fails before commit', async entry => {
  const f = fixture(), store = new Store(f.path), fs = await import('node:fs'), original = fs.renameSync;
  try {
    const p = store.createProject('Demo', f.folder), root = store.legacyProjectDirectory(p.id);
    const task = entry === 'task' ? legacyTask(root, 'Target') : store.createTask(p.id, 'Target');
    const document = join(root, 'tasks', task.id, 'requirements.md');
    const chat = join(root, 'chat', task.id + '.json');
    if (entry === 'task') {
      store.migrateTasks();
      writeFileSync(document, 'saved before delete');
    }
    mkdirSync(join(root, 'chat'), {recursive: true});
    writeFileSync(chat, 'history');
    const destination = join(root, `.deleting-${task.id}`, entry);
    const fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === destination) throw Error('simulated filesystem failure');
      return original(from, to);
    });
    try {
      expect(() => store.deleteTask(p.id, task.id)).toThrow('simulated filesystem failure');
    } finally { fault.mockRestore(); }
    expect(store.task(task.id)?.name).toBe('Target');
    if (entry === 'task') expect(readFileSync(document, 'utf8')).toBe('saved before delete');
    else expect(store.managedDocument(p.id, task.id, 'requirements.md')?.content).toBe('# Target\n');
    expect(readFileSync(chat, 'utf8')).toBe('history');
    expect(store.taskEvents(p.id, task.id).events.some(event => event.type === 'task.deleted')).toBe(false);
    store.deleteTask(p.id, task.id);
    expect(store.tasks()).toEqual([]);
    expect(store.taskEvents(p.id, task.id).events.filter(event => event.type === 'task.deleted')).toHaveLength(1);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('failed task creation leaves neither a task nor committed history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Existing');
    const before = store.projectEvents(p.id), database = new Database(store.projectDatabasePath(p.id));
    database.exec("CREATE TRIGGER fail_creation BEFORE INSERT ON file_changes BEGIN SELECT RAISE(ABORT, 'simulated creation failure'); END");
    expect(() => store.createTask(p.id, 'Failed')).toThrow('simulated creation failure');
    database.exec('DROP TRIGGER fail_creation'); database.close();
    expect(store.tasks(p.id).map(value => value.id)).toEqual([task.id]);
    expect(store.projectEvents(p.id)).toEqual(before);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('task metadata rolls back when its operation history cannot be recorded', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const database = new Database(store.projectDatabasePath(p.id));
    database.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON events WHEN NEW.type IN ('task.renamed','phase.changed','task.completed','task.reopened') BEGIN SELECT RAISE(ABORT, 'simulated operation failure'); END");
    expect(() => store.renameTask(p.id, task.id, 'Failed')).toThrow('simulated operation failure');
    expect(store.task(task.id)?.name).toBe('Task');
    expect(() => store.selectTaskPhase(p.id, task.id, 'requirements', 'documents')).toThrow('simulated operation failure');
    expect(store.task(task.id)?.phase).toBe('requirements');
    database.exec('DROP TRIGGER fail_operation');
    store.selectTaskPhase(p.id, task.id, 'requirements', 'retrospective');
    database.exec("CREATE TRIGGER fail_operation BEFORE INSERT ON events WHEN NEW.type IN ('task.completed','task.reopened') BEGIN SELECT RAISE(ABORT, 'simulated operation failure'); END");
    expect(() => store.setTaskCompleted(p.id, task.id, true)).toThrow('simulated operation failure');
    expect(store.task(task.id)?.status).toBe('idle');
    database.exec('DROP TRIGGER fail_operation'); database.close();
    store.renameTask(p.id, task.id, 'Retry'); store.setTaskCompleted(p.id, task.id, true);
    const operations = store.taskEvents(p.id, task.id).events.map(event => event.type);
    expect(operations.filter(type => type === 'task.renamed')).toHaveLength(1);
    expect(operations.filter(type => type === 'task.completed')).toHaveLength(1);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('完了イベントを実行登録より先に確定し、中断した登録と完了回を重複なく復旧する', () => {
  const f = fixture();
  let store = new Store(f.path);
  const registry = new Database(f.path);
  try {
    const project = store.createProject('Demo', f.folder), task = store.createTask(project.id, 'Task');
    store.selectTaskPhase(project.id, task.id, 'requirements', 'retrospective');
    store.startTaskFinalization(project.id, task.id);
    const databasePath = store.projectDatabasePath(project.id);
    const readPending = () => withDatabase(databasePath, db => {
      const row = db.query<{pending_completion: string | null}, [string]>('SELECT pending_completion FROM tasks WHERE id=?').get(task.id)!;
      return row.pending_completion === null ? undefined : JSON.parse(row.pending_completion);
    });
    const knowledge = store.managedDocument(project.id, null, 'knowledge.md')!;
    const completion = {id: crypto.randomUUID(), revision: knowledge.revision, provider: 'codex' as const, model: null};
    const projectDb = new Database(databasePath);
    try {
      projectDb.exec("CREATE TRIGGER fail_completion BEFORE INSERT ON events WHEN NEW.type='task.completed' BEGIN SELECT RAISE(ABORT, 'simulated event failure'); END");
      expect(() => store.setTaskCompleted(project.id, task.id, true, 'finalization', completion)).toThrow('simulated event failure');
      expect(store.task(task.id)?.status).toBe('idle');
      expect(store.pendingInstructionJob()).toBeUndefined();
      projectDb.exec('DROP TRIGGER fail_completion');
    } finally { projectDb.close(); }
    registry.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON instruction_jobs BEGIN SELECT RAISE(ABORT, 'simulated registration failure'); END");
    expect(store.setTaskCompleted(project.id, task.id, true, 'finalization', completion).status).toBe('completed');
    const events = () => store.taskEvents(project.id, task.id).events.filter(event => event.type === 'task.completed');
    expect(events()).toHaveLength(1);
    expect(store.pendingInstructionJob()).toBeUndefined();
    expect(() => store.deleteTask(project.id, task.id)).toThrow('削除できません');
    expect(readPending()).toEqual(completion);
    registry.exec('DROP TRIGGER fail_registration');

    store.close();
    store = new Store(f.path);
    const first = store.pendingInstructionJob()!;
    expect(first).toMatchObject({...completion, eventId: events()[0]!.id, eventKey: 'task.completed'});
    expect(readPending()).toBeUndefined();
    store.finishInstructionJob(first.id);
    store.setTaskCompleted(project.id, task.id, false, 'finalization');
    store.startTaskFinalization(project.id, task.id);
    const next = {...completion, id: crypto.randomUUID()};
    // 旧版の完了状態確定後・イベント書き込み前の停止を再現する。
    withDatabase(databasePath, db => db.query("UPDATE tasks SET status='completed',pending_completion=? WHERE id=?").run(JSON.stringify(next), task.id));
    store.close();
    store = new Store(f.path);
    expect(events()).toHaveLength(2);
    const second = store.pendingInstructionJob()!;
    expect(second).toMatchObject({...next, eventId: events()[1]!.id, eventKey: 'task.completed'});
    expect(second.id).not.toBe(first.id);
    store.close();
    store = new Store(f.path);
    expect(events()).toHaveLength(2);
    expect(store.pendingInstructionJob()).toEqual(second);
  } finally { registry.close(); store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('instructions seed missing keys and preserve saved templates across restart', () => {
 const f=fixture();
 try {
  const db=new Database(f.path);
  db.exec('CREATE TABLE instructions(key TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.query('INSERT INTO instructions(key,content) VALUES (?,?)').run('common','# Saved {{project_directory}}');
  db.close();
  const store=new Store(f.path);
  expect(store.instructions().map(item=>item.key)).toEqual(['common','requirements','documents','implementation','execution','retrospective','finalization','editor','task.completed']);
  expect(store.instructions()[0]!.content).toBe('# Saved {{project_directory}}');
  expect(store.instructions().find(item=>item.key==='documents')!.content).toContain('仕様整理');
  store.close();
 } finally {rmSync(f.root,{recursive:true,force:true})}
});

test('既知の旧反省会本文だけを更新し、カスタム本文は保持する', () => {
 const f=fixture();
 try {
  const current=defaultInstructions.find(item=>item.key==='retrospective')!.content;
  const legacy=current
   .replace('準備・実装では、ここに添付されたプロジェクトナレッジを参照する。保存先: {{knowledge_path}}。','準備・実装の前にプロジェクトナレッジ {{knowledge_path}} を読む。')
   .replace('反省会、終了。変更は UI','反省会。変更は UI')
   .replace('既存の文書と決定を保つ。','既存の文書と決定を保つ。\nナレッジには確認済みで再利用できる教訓だけを追記し、仮説を区別して既存内容を保つ。')
   .replace('Beniから入力に添付される実装の発言と結果の抜粋を読み取り専用の文脈として確認する。不足する場合だけ関連するイベントや差分を追加で調べる。保存用 JSON や CLI ログを丸読みしない。','実装の会話と終端メッセージの状態を {{execution_chat_path}} から読み取り専用の文脈として確認する。');
  const db=new Database(f.path);
  db.exec('CREATE TABLE instructions(key TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.query('INSERT INTO instructions(key,content) VALUES (?,?)').run('retrospective',legacy);
  db.query('INSERT INTO instructions(key,content) VALUES (?,?)').run('execution','# Custom prompt');
  db.close();
  const migrated=new Store(f.path);
  expect(migrated.instructions().find(item=>item.key==='retrospective')!.content).toBe(current);
  expect(migrated.instructions().find(item=>item.key==='execution')!.content).toBe('# Custom prompt');
  migrated.close();
 } finally { rmSync(f.root,{recursive:true,force:true}); }
});

test('instruction replacement validates variables and never re-evaluates inserted content', async () => {
 const {renderInstruction,composeInstructions,defaultInstructions}=await import('../instructions');
 expect(renderInstruction('{{knowledge_content}} / {{project_directory}}',{knowledge_content:'{{unknown}}',project_directory:'/example'})).toBe('{{unknown}} / /example');
 expect(()=>renderInstruction('{{unknown}}',{})).toThrow('未知のインストラクション変数: unknown');
 expect(()=>renderInstruction('{{task_id}}',{})).toThrow('インストラクション変数が不足しています: task_id');
 expect(composeInstructions(defaultInstructions,null,{project_directory:'/project',working_directory:'/project'})).not.toContain('requirements.md');
});

test('旧タスク文書を一括移行し、移行後も元のファイルを保持する', () => {
  const f = fixture();
  let store: Store | undefined;
  try {
    const project = newMetadata('project', 'Demo');
    const source = join(f.folder, '.beni');
    const task = legacyTask(source, 'Legacy');
    writeJson(join(source, 'project.json'), project);
    const db = new Database(f.path);
    try {
      db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE)');
      db.query('INSERT INTO projects VALUES(?,?,?)').run(project.id, project.name, realpathSync(f.folder));
    } finally { db.close(); }
    store = new Store(f.path, {migration:true});
    store.migrateTasks();
    store.close();
    store = new Store(f.path);
    expect(store.project(project.id)?.name).toBe(project.name);
    expect(existsSync(join(source, 'project.json'))).toBe(false);
    const folder = join(store.legacyProjectDirectory(project.id), 'tasks', task.id);
    const requirements = join(folder, 'requirements.md');
    const extra = join(folder, 'extra.md');
    writeFileSync(requirements, '旧本文\r\n');
    writeFileSync(extra, Buffer.from([0xff]));
    const current = store;
    expect(() => current.managedDocuments(project.id, task.id)).toThrow('not valid UTF-8');
    writeFileSync(requirements, '移行を再試行\r\n');
    writeFileSync(extra, '追加資料');
    const documents = store.managedDocuments(project.id, task.id);
    expect(documents.map(doc => doc.name)).toEqual(['requirements.md', 'documents.md', 'extra.md', 'implementation.md']);
    expect(documents[0]?.content).toBe('移行を再試行\r\n');
    expect(documents[0]?.items[0]).toMatchObject({
      reason: '既存の文書を初期版として取り込んだ。',
      sources: [{kind: 'legacy', id: 'requirements.md', text: '移行を再試行'}]
    });
    expect(store.managedDocument(project.id, null, 'knowledge.md')?.items[0]?.sources)
      .toEqual([{kind: 'template', id: 'knowledge.md', text: '# プロジェクトの学び'}]);
    const version = store.writeManagedDocument(project.id, task.id, 'requirements.md', documents[0]!.revision, evidencedText('DBの更新'), 'send-1');
    expect(store.replayManagedDocument(project.id, task.id, 'requirements.md', 'send-1')).toEqual(version);
    expect(readFileSync(requirements, 'utf8')).toBe('移行を再試行\r\n');
    writeFileSync(requirements, '旧ファイルの更新');
    store.close();
    store = new Store(f.path);
    expect(store.managedDocument(project.id, task.id, 'requirements.md')).toEqual(version);
    expect(store.managedDocument(project.id, task.id, 'requirements.md', documents[0]!.revision)).toEqual(documents[0]);
  } finally {
    store?.close();
    rmSync(f.root, {recursive: true, force: true});
  }
});

test('インストラクション更新ジョブは永続化され、全更新と成功をまとめて確定する', () => {
  const f = fixture();
  let store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder);
    const task = store.createTask(project.id, 'Task');
    const request = {id: 'job-1', projectId: project.id, taskId: task.id, revision: 'knowledge-version', provider: 'codex' as const, model: null};
    const workflow = store.instructionDocument('task.completed')!;
    const inputs = {eventKey: 'task.completed' as const, instructionRevision: workflow.revision};
    store.enqueueInstructionJob(request);
    store.close();
    store = new Store(f.path);
    expect(store.pendingInstructionJob()).toEqual({...request, ...inputs, status: 'pending'});
    const common = store.instructionDocument('common')!;
    const editor = store.instructionDocument('editor')!;
    const nextCommon = {key: 'common', base: common.revision, items: evidencedText('新しい共通指示')};
    expect(() => store.commitInstructionJob(request.id, [nextCommon, {key: 'editor', base: editor.revision, items: []}], '指示を統合する')).toThrow();
    expect(() => store.commitInstructionJob(request.id, [nextCommon, {key: 'task.completed', base: workflow.revision, items: evidencedText('禁止')}])).toThrow('ワークフローから編集できません');
    expect(store.instructionDocument('common')).toEqual(common);
    expect(store.instructionJob(project.id, task.id)).toEqual({...request, ...inputs, status: 'pending'});
    store.finishInstructionJob(request.id, '模擬失敗');
    expect(store.instructionJob(project.id, task.id)?.status).toBe('failed');
    expect(store.retryInstructionJob(project.id, task.id)).toEqual({...request, ...inputs, status: 'pending'});
    const followUp = {...request, id: 'job-2'};
    store.enqueueInstructionJob(followUp);
    expect(() => store.commitInstructionJob(request.id, [nextCommon])).toThrow('no longer pending');
    expect(store.enqueueInstructionJob(request).status).toBe('superseded');
    expect(store.commitInstructionJob(followUp.id, [nextCommon], '学びを共通指示へ反映した')).toMatchObject({
      status: 'succeeded', reason: '学びを共通指示へ反映した'
    });
    const updated = store.instructionDocument('common');
    expect(updated?.content).toBe('新しい共通指示');
    const noChange = {...request, id: 'job-3'};
    store.enqueueInstructionJob(noChange);
    store.commitInstructionJob(noChange.id, [], '既存の指示に含まれるため更新なし');
    store.close();
    store = new Store(f.path);
    expect(store.instructionJob(project.id, task.id)).toEqual({...noChange, ...inputs, status: 'succeeded', reason: '既存の指示に含まれるため更新なし'});
    expect(store.instructionDocument('common')).toEqual(updated);
    expect(store.pendingInstructionJob()).toBeUndefined();
  } finally {
    store.close();
    rmSync(f.root, {recursive: true, force: true});
  }
});

test('利用枠キャッシュを移行し、再起動後はDBの値を優先する', () => {
 const {root,path}=fixture(),file=join(root,'rate-limits-codex.json');
 const usage={observedAt:'2026-01-02T00:00:00.000Z',windows:[{label:'5時間枠',usedPercent:25}]};
 let store:Store|undefined;
 try {
  writeJson(file,{version:1,identity:'example-account',usage});
  store=new Store(path);
  expect(store.agentUsage('codex')).toEqual({identity:'example-account',usage});
  expect(existsSync(file)).toBe(false);
  store.saveAgentUsage('codex','example-account',{...usage,observedAt:'2026-01-01T00:00:00.000Z'});
  expect(store.agentUsage('codex')?.usage).toEqual(usage);
  store.close();store=undefined;
  writeJson(file,{version:1,identity:'different-account',usage:{...usage,windows:[{label:'5時間枠',usedPercent:90}]}});
  store=new Store(path);
  expect(store.agentUsage('codex')).toEqual({identity:'example-account',usage});
  expect(existsSync(file)).toBe(false);
 } finally {store?.close();rmSync(root,{recursive:true,force:true})}
});

test('壊れた利用枠キャッシュは起動を妨げず旧ファイルを保持する', () => {
 const {root,path}=fixture(),file=join(root,'rate-limits-claude.json');
 try {
  for(const content of ['{',JSON.stringify({version:2,identity:'example',usage:{}}),JSON.stringify({version:1,identity:12,usage:{}}),JSON.stringify({version:1,identity:'example',usage:{}})]) {
   writeFileSync(file,content);
   const store=new Store(path);
   try {expect(store.agentUsage('claude')).toBeUndefined();expect(readFileSync(file,'utf8')).toBe(content)} finally {store.close()}
  }
 } finally {rmSync(root,{recursive:true,force:true})}
});

test('壊れたDB利用枠は新しい取得で回復できる', () => {
 const {root,path}=fixture();
 const store=new Store(path);
 try {
  const db=new Database(path);
  try {db.query("INSERT INTO agents(id,name,usage_identity,usage) VALUES(?,'Codex',?,?)").run('codex','example-account','{')} finally {db.close()}
  expect(store.agentUsage('codex')).toBeUndefined();
  const usage={observedAt:'2026-01-02T00:00:00.000Z',windows:[{label:'5時間枠',usedPercent:25}]};
  store.saveAgentUsage('codex','example-account',usage);
  expect(store.agentUsage('codex')).toEqual({identity:'example-account',usage});
 } finally {store.close();rmSync(root,{recursive:true,force:true})}
});

test('旧利用枠テーブルを廃止し、接続未確認のまま既存DBの利用枠を優先する', () => {
 const {root,path}=fixture();
 const usage={observedAt:'2026-01-02T00:00:00.000Z',windows:[{label:'5時間枠',usedPercent:25}]};
 let store:Store|undefined;
 try {
  const db=new Database(path);
  db.exec('CREATE TABLE agent_usage_cache(provider TEXT PRIMARY KEY,identity TEXT NOT NULL,usage TEXT NOT NULL)');
  db.query('INSERT INTO agent_usage_cache VALUES(?,?,?)').run('codex','example-account',JSON.stringify(usage));
  db.close();
  store=new Store(path);
  expect(store.agentUsage('codex')).toEqual({identity:'example-account',usage});
  expect(store.agentStatus('codex')).toBeUndefined();
  store.close();store=undefined;
  const old=new Database(path);
  expect(old.query("SELECT name FROM sqlite_master WHERE name='agent_usage_cache'").get()).toBeNull();
  expect(old.query('SELECT checked_at FROM agents WHERE id=?').get('codex')).toEqual({checked_at:null});
  old.exec('CREATE TABLE agent_usage_cache(provider TEXT PRIMARY KEY,identity TEXT NOT NULL,usage TEXT NOT NULL)');
  old.query('INSERT INTO agent_usage_cache VALUES(?,?,?)').run('codex','different-account',JSON.stringify({...usage,windows:[]}));
  old.close();
  store=new Store(path);
  expect(store.agentUsage('codex')).toEqual({identity:'example-account',usage});
 } finally {store?.close();rmSync(root,{recursive:true,force:true})}
});

test('接続情報の再登録・無効化と破損からの回復で日時と利用枠を維持する', () => {
 const {root,path}=fixture(),store=new Store(path);
 const status={availability:'ready',auth:'subscription',models:[{id:'example',name:'Example'}],checkedAt:'2026-01-02T00:00:00.000Z',version:'1.0',executablePath:'/example/bin/agent',accountKey:'example-status-key'} as const;
 const usage={observedAt:'2026-01-02T00:00:00.000Z',windows:[{label:'5時間枠',usedPercent:25}]};
 try {
  store.registerAgents([{id:'codex',name:'Codex'}]);
  expect(store.agentStatus('codex')).toBeUndefined();
  store.saveAgentStatus('codex',status);
  store.saveAgentUsage('codex','example-usage-key',usage);
  store.registerAgents([{id:'codex',name:'New Codex'}]);
  expect(store.agentStatus('codex')).toEqual(status);
  expect(store.agentUsage('codex')).toEqual({identity:'example-usage-key',usage});
  store.invalidateAgentStatus('codex');
  expect(store.agentStatus('codex')).toBeUndefined();
  const db=new Database(path);
  try {
   expect(db.query('SELECT name,checked_at,account_key,usage_identity FROM agents WHERE id=?').get('codex')).toEqual({name:'New Codex',checked_at:status.checkedAt,account_key:status.accountKey,usage_identity:'example-usage-key'});
   db.exec("UPDATE agents SET models='{',status_invalidated=0 WHERE id='codex'");
   expect(store.agentStatus('codex')).toBeUndefined();
   store.saveAgentStatus('codex',{...status,models:null});
   expect(store.agentStatus('codex')).toEqual({...status,models:null});
  } finally {db.close()}
 } finally {store.close();rmSync(root,{recursive:true,force:true})}
});


test('専用AgentTableはエージェント情報だけを初期化する', () => {
 const db=new Database(':memory:');
 try {
  const table=new AgentTable(db);
  table.registerAgents([{id:'codex',name:'Codex'}]);
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{name:'agents'}]);
  expect(table.agentStatus('codex')).toBeUndefined();
  expect(db.query('SELECT checked_at FROM agents').get()).toEqual({checked_at:null});
 } finally {db.close()}
});
