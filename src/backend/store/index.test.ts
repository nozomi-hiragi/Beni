import { test, expect, spyOn } from 'bun:test';
import { Store } from './index';
import { Database } from 'bun:sqlite';
import { cpSync, linkSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultInstructions } from '../instructions';
import { generateId, validProjectId, validTaskId } from '../../shared/ids';
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
test('canonical metadata persists tasks and recovers documents idempotently', () => {
  const f = fixture();
  try {
    let store = new Store(f.path);
    const p = store.createProject('Demo', f.folder),
      t = store.createTask(p.id, 'Task');
    expect(validProjectId(p.id)).toBe(true);
    expect(validTaskId(t.id)).toBe(true);
    expect(validProjectId(t.id)).toBe(false);
    expect(readFileSync(join(f.folder, '.beni', 'tasks', t.id, 'requirements.md'), 'utf8')).toBe('# Task\n');
    store.close();
    const orphan = join(f.folder, '.beni', 'tasks', '12');
    mkdirSync(orphan);
    writeFileSync(join(orphan, 'requirements.md'), 'unchanged\r\n');
    store = new Store(f.path);
    const tasks = store.tasks();
    expect(tasks.length).toBe(2);
    const recovered = tasks.find(t => t.name === 'Unknown')!;
    expect(readFileSync(join(f.folder, '.beni', 'tasks', recovered.id, 'requirements.md'), 'utf8')).toBe('unchanged\r\n');
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
    cpSync(f.folder, duplicate, {
      recursive: true
    });
    expect(() => store.createProject('Duplicate', duplicate)).toThrow('Duplicate live project');
    const moved = join(f.root, 'moved');
    renameSync(f.folder, moved);
    expect(store.createProject('Ignored', moved).id).toBe(p.id);
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
  try {
    const store = new Store(f.path),
      p = store.createProject('Demo', f.folder);
    const projectFile = join(f.folder, '.beni', 'project.json');
    const original = JSON.parse(readFileSync(projectFile, 'utf8'));
    for (const invalid of [{
      ...original,
      version: 2
    }, {
      ...original,
      createdAt: '2026-02-30T00:00:00.000Z'
    }]) {
      writeFileSync(projectFile, JSON.stringify(invalid));
      expect(() => store.projects()).toThrow();
      expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toEqual(invalid);
    }
    writeFileSync(projectFile, JSON.stringify(original));
    const orphan = join(f.folder, '.beni', 'tasks', '99');
    mkdirSync(orphan);
    writeFileSync(join(f.root, 'outside.md'), 'original');
    linkSync(join(f.root, 'outside.md'), join(orphan, 'requirements.md'));
    expect(() => store.tasks()).toThrow('Invalid document file');
    expect(existsSync(join(orphan, 'task.json'))).toBe(false);
    rmSync(join(orphan, 'requirements.md'));
    symlinkSync(join(f.root, 'missing'), join(orphan, 'task.json'));
    expect(() => store.tasks()).toThrow();
    store.close();
  } finally {
    rmSync(f.root, {
      recursive: true,
      force: true
    });
  }
});
test('task rows expose canonical creation dates including unknown dates', () => {
  const f = fixture();
  const store = new Store(f.path);
  try {
    const project = store.createProject('Demo', f.folder);
    const task = store.createTask(project.id, 'Task');
    const path = join(f.folder, '.beni', 'tasks', task.id, 'task.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    expect(task.createdAt).toBe(data.createdAt);
    expect(task.updatedAt).toBe(data.updatedAt);
    data.createdAt = '2026-01-02T03:04:05.000Z';
    data.updatedAt = '2026-02-03T04:05:06.000Z';
    writeFileSync(path, JSON.stringify(data));
    expect(store.tasks(project.id)[0]!.createdAt).toBe(data.createdAt);
    expect(store.task(task.id)!.createdAt).toBe(data.createdAt);
    expect(store.task(task.id)!.updatedAt).toBe(data.updatedAt);
    data.createdAt = null;
    data.updatedAt = null;
    writeFileSync(path, JSON.stringify(data));
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
    const project = store.createProject('Demo', f.folder), task = store.createTask(project.id, 'Task');
    const path = join(f.folder, '.beni', 'tasks', task.id), file = join(path, 'task.json');
    const original = JSON.parse(readFileSync(file, 'utf8'));
    original.createdAt = null; original.updatedAt = null; delete original.documentBaseline;
    writeFileSync(file, JSON.stringify(original));
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    const baseline = readFileSync(file, 'utf8');
    expect(store.tasks()[0]!.updatedAt).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(baseline);
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
    store.taskDocumentFolder(project.id, task.id);
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
  const root=join(f.folder,'.beni'), chats=join(root,'chat');mkdirSync(chats);
  for(const name of ['general.json',`${target.id}.json`,`${other.id}.json`])writeFileSync(join(chats,name),'{}');
  mkdirSync(join(root,'old'));writeFileSync(join(root,'old','archive.json'),'archive');
  const external=join(f.root,'external.json');writeFileSync(external,'safe');rmSync(join(chats,`${target.id}.json`));symlinkSync(external,join(chats,`${target.id}.json`));
  expect(()=>store.deleteTask(p.id,target.id)).toThrow('Invalid chat file');expect(store.task(target.id)).not.toBeNull();expect(readFileSync(external,'utf8')).toBe('safe');
  rmSync(join(chats,`${target.id}.json`));writeFileSync(join(chats,`${target.id}.json`),'{}');
  expect(()=>store.deleteTask(generateId('project'),target.id)).toThrow();
  store.deleteTask(p.id,target.id);
  expect(store.tasks().map(t=>t.id)).toEqual([other.id]);expect(existsSync(join(chats,`${target.id}.json`))).toBe(false);
  expect(readFileSync(join(chats,'general.json'),'utf8')).toBe('{}');expect(readFileSync(join(chats,`${other.id}.json`),'utf8')).toBe('{}');expect(readFileSync(join(root,'old','archive.json'),'utf8')).toBe('archive');
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task deletion recovery rolls back incomplete moves and never restores committed partial cleanup', () => {
 const f=fixture(),store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),root=join(f.folder,'.beni');mkdirSync(join(root,'chat'));
  const staged=join(root,`.deleting-${t.id}`);mkdirSync(staged);writeFileSync(join(staged,'journal.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));
  renameSync(join(root,'tasks',t.id),join(staged,'task'));writeFileSync(join(staged,'chat.json'),'{}');
  expect(store.tasks().map(t=>t.id)).toContain(t.id);expect(readFileSync(join(root,'chat',`${t.id}.json`),'utf8')).toBe('{}');expect(existsSync(staged)).toBe(false);
  mkdirSync(staged);renameSync(join(root,'tasks',t.id),join(staged,'task'));renameSync(join(root,'chat',`${t.id}.json`),join(staged,'chat.json'));
  writeFileSync(join(staged,'committed.json'),JSON.stringify({version:1,projectId:p.id,taskId:t.id}));rmSync(join(staged,'task','task.json'));
  expect(store.tasks()).toEqual([]);expect(existsSync(staged)).toBe(false);expect(existsSync(join(root,'chat',`${t.id}.json`))).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task deletion rolls back filesystem failures before commit', async () => {
 const f=fixture(),store=new Store(f.path),fs=await import('node:fs');
 const original=fs.renameSync;
 let fault:ReturnType<typeof spyOn>|undefined;
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),root=join(f.folder,'.beni');mkdirSync(join(root,'chat'));writeFileSync(join(root,'chat',`${t.id}.json`),'history');
  fault=spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to).endsWith('/committed.json'))throw Error('simulated filesystem failure');return original(from,to)});
  expect(()=>store.deleteTask(p.id,t.id)).toThrow('simulated filesystem failure');fault.mockRestore();fault=undefined;
  expect(store.task(t.id)?.name).toBe('Target');expect(readFileSync(join(root,'tasks',t.id,'requirements.md'),'utf8')).toBe('# Target\n');expect(readFileSync(join(root,'chat',`${t.id}.json`),'utf8')).toBe('history');
  store.deleteTask(p.id,t.id);expect(store.tasks()).toEqual([]);
 }finally{fault?.mockRestore();store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('recovery discards an initial journal write interrupted before any source was moved', () => {
 const f=fixture(),store=new Store(f.path);
 try {
  const p=store.createProject('Demo',f.folder),t=store.createTask(p.id,'Target'),staged=join(f.folder,'.beni',`.deleting-${t.id}`);mkdirSync(staged);writeFileSync(join(staged,'journal.json.tmp-00000000-0000-0000-0000-000000000000'),'{');
  expect(store.tasks().map(t=>t.id)).toEqual([t.id]);expect(existsSync(staged)).toBe(false);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true})}
});

test('task history retains created, updated, renamed and deleted document versions across restart', () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const folder = join(f.folder, '.beni', 'tasks', task.id);
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
    writeFileSync(join(f.folder, '.beni', 'tasks', task.id, 'extra.md'), 'later');
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
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(f.folder, '.beni', 'tasks', task.id);
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
    // メタデータ更新後・履歴確定前に中断した状態も次の照合で取り込む。
    const file = join(folder, 'task.json'), value = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({...value, phase: 'implementation'}));
    expect(store.taskEvents(p.id, task.id).events.at(-1)).toMatchObject({type: 'phase.changed', from: 'requirements', to: 'implementation', sourcePhase: null});
    expect(() => store.advanceTaskPhase(p.id, task.id, 'requirements')).toThrow('phase conflict');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('history rejects linked databases and unsafe current documents without touching their targets', () => {
  for (const target of ['database', 'document', 'hardlink']) {
    const f = fixture(), store = new Store(f.path);
    try {
      const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
      const file = target === 'database' ? join(f.folder, '.beni', 'events.sqlite') : join(f.folder, '.beni', 'tasks', task.id, 'requirements.md');
      const external = join(f.root, 'external'); writeFileSync(external, 'outside');
      rmSync(file);
      if (target === 'hardlink') linkSync(external, file); else symlinkSync(external, file);
      expect(() => store.taskEvents(p.id, task.id)).toThrow();
      expect(readFileSync(external, 'utf8')).toBe('outside');
    } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
  }
});

test('task deletion removes legacy and all phase conversations while preserving other task history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const root = join(f.folder, '.beni'), chat = join(root, 'chat', task.id); mkdirSync(chat, {recursive: true});
    const original = {
      version: 1, id: 'conversation', projectId: p.id, taskId: task.id,
      phase: 'requirements', lastEventId: 3, threadId: 'thread', sessionId: 'session',
      messages: [{id: 'message', sendId: 'send', role: 'user', content: 'Example', provider: 'codex', model: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', threadId: 'thread', sessionId: 'session', status: 'completed'}], packs: []
    };
    for (const phase of ['requirements', 'documents']) writeFileSync(join(chat, phase + '.json'), JSON.stringify({...original, phase, id: phase}));
    const remaining = store.createTask(p.id, 'Remaining'), before = store.taskEvents(p.id, remaining.id);
    // 旧会話と全フェーズの会話が併存していても削除対象はタスク内に閉じる。
    writeFileSync(join(root, 'chat', task.id + '.json'), JSON.stringify(original));
    store.deleteTask(p.id, task.id);
    expect(existsSync(join(root, 'tasks', task.id))).toBe(false);
    expect(existsSync(chat)).toBe(false);
    expect(existsSync(join(root, 'chat', task.id + '.json'))).toBe(false);
    const after = store.taskEvents(p.id, remaining.id);
    expect(after.events).toEqual(before.events);
    expect(after.through).toBeGreaterThan(before.through);
    expect(after.nextCursor).toBe(after.through);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('phase chat deletion recovery restores uncommitted directories and rejects links', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), root = join(f.folder, '.beni');
    const chat = join(root, 'chat', task.id); mkdirSync(chat, {recursive: true});
    writeFileSync(join(chat, 'requirements.json'), '{}');
    const staged = join(root, `.deleting-${task.id}`); mkdirSync(staged);
    writeFileSync(join(staged, 'journal.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(join(root, 'tasks', task.id), join(staged, 'task')); renameSync(chat, join(staged, 'chat'));
    expect(store.tasks(p.id).map(value => value.id)).toEqual([task.id]);
    expect(readFileSync(join(chat, 'requirements.json'), 'utf8')).toBe('{}');
    const external = join(f.root, 'external.json'); writeFileSync(external, '{}');
    symlinkSync(external, join(chat, 'documents.json'));
    expect(() => store.deleteTask(p.id, task.id)).toThrow('Invalid metadata file');
    expect(store.task(task.id)).not.toBeNull();
    rmSync(join(chat, 'documents.json'));
    // 確定済みジャーナルは残ったフェーズ会話を復元せず削除する。
    mkdirSync(staged); writeFileSync(join(staged, 'committed.json'), JSON.stringify({version: 1, projectId: p.id, taskId: task.id}));
    renameSync(join(root, 'tasks', task.id), join(staged, 'task')); renameSync(chat, join(staged, 'chat'));
    expect(store.tasks(p.id)).toEqual([]); expect(existsSync(staged)).toBe(false);
    expect(readFileSync(external, 'utf8')).toBe('{}');
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('SQLite history rolls back failed commits and retries without event gaps', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task'), folder = join(f.folder, '.beni', 'tasks', task.id);
    const before = store.taskEvents(p.id, task.id), database = new Database(join(f.folder, '.beni', 'events.sqlite'));
    database.exec("CREATE TRIGGER fail_event BEFORE INSERT ON file_changes BEGIN SELECT RAISE(ABORT, 'simulated history commit failure'); END");
    writeFileSync(join(folder, 'extra.md'), 'new version');
    expect(() => store.captureTaskHistory(p.id, task.id, 'documents')).toThrow('simulated history commit failure');
    expect(database.query('SELECT MAX(id) AS id FROM events').get()).toEqual({id: before.through});
    expect(database.query('SELECT COUNT(*) AS count FROM file_changes').get()).toEqual({count: 3});
    database.exec('DROP TRIGGER fail_event'); database.close();
    store.captureTaskHistory(p.id, task.id, 'documents');
    expect(store.taskEvents(p.id, task.id, before.through).events).toMatchObject([{id: before.through + 1, type: 'document.created', path: 'extra.md', sourcePhase: 'documents'}]);
    expect(existsSync(join(folder, '.history'))).toBe(false);
  } finally { store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('project cursors advance over other tasks and retained history survives task deletion', () => {
  const f = fixture(); let store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const file = join(f.folder, '.beni', 'tasks', task.id, 'requirements.md');
    const first = store.taskEvents(p.id, task.id);
    const original = first.events.find(event => event.path === 'requirements.md')!;
    const other = store.createTask(p.id, 'Other');
    const empty = store.taskEvents(p.id, task.id, first.through, undefined, 1);
    expect(empty.events).toEqual([]); expect(empty.nextCursor).toBeGreaterThan(first.through);
    let cursor = empty.nextCursor;
    while (cursor < empty.through) cursor = store.taskEvents(p.id, task.id, cursor, empty.through, 1).nextCursor;
    expect(cursor).toBe(empty.through);
    writeFileSync(file, 'final edit\r\n');
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
    const db = new Database(join(f.folder, '.beni', 'events.sqlite'));
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

test('task deletion refuses lost history and rolls back its deletion event on filesystem failure', async () => {
  const f = fixture(), store = new Store(f.path), fs = await import('node:fs'), original = fs.renameSync;
  let fault: ReturnType<typeof spyOn> | undefined;
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Task');
    const path = join(f.folder, '.beni', 'tasks', task.id, 'requirements.md');
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1));
    expect(() => store.deleteTask(p.id, task.id)).toThrow('Tracked document exceeds 1 MiB');
    expect(store.task(task.id)).not.toBeNull();
    writeFileSync(path, 'saved before delete');
    fault = spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('/committed.json')) throw Error('simulated deletion failure');
      return original(from, to);
    });
    expect(() => store.deleteTask(p.id, task.id)).toThrow('simulated deletion failure');
    fault.mockRestore(); fault = undefined;
    expect(store.task(task.id)).not.toBeNull();
    expect(store.taskEvents(p.id, task.id).events.some(event => event.type === 'task.deleted')).toBe(false);
    store.deleteTask(p.id, task.id);
    expect(store.taskEvents(p.id, task.id).events.filter(event => event.type === 'task.deleted')).toHaveLength(1);
  } finally { fault?.mockRestore(); store.close(); rmSync(f.root, {recursive: true, force: true}); }
});

test('failed task creation leaves neither a task nor committed history', () => {
  const f = fixture(), store = new Store(f.path);
  try {
    const p = store.createProject('Demo', f.folder), task = store.createTask(p.id, 'Existing');
    const before = store.projectEvents(p.id), database = new Database(join(f.folder, '.beni', 'events.sqlite'));
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
    const database = new Database(join(f.folder, '.beni', 'events.sqlite'));
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

test('instructions seed missing keys and preserve saved templates across restart', () => {
 const f=fixture();
 try {
  let store=new Store(f.path);
  expect(store.instructions().map(item=>item.key)).toEqual(['common','requirements','documents','implementation','execution','retrospective','finalization','editor']);
  store.close();
  const db=new Database(f.path);
  db.query('UPDATE instructions SET content=? WHERE key=?').run('# Saved {{project_directory}}','common');
  db.query('DELETE FROM instructions WHERE key=?').run('documents'); db.close();
  store=new Store(f.path);
  expect(store.instructions()).toHaveLength(8);
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
  const store=new Store(f.path);
  store.close();
  const db=new Database(f.path);
  db.query('UPDATE instructions SET content=? WHERE key=?').run(legacy,'retrospective');
  db.query('UPDATE instructions SET content=? WHERE key=?').run('# Custom prompt','execution');
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
