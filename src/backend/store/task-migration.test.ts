import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId, validTaskId } from '../../shared/ids';
import { encodeChatHistory } from '../chat-history';
import { ChatStore, type ChatScope } from '../chat-store';
import { newMetadata, writeJson, type TaskMetadata } from '../data';
import { DocumentTable } from '../document-table';
import { appendProjectEvent, ensureProjectIdentity, getProjectFileVersion, projectEvent, captureProjectTaskHistory, withDatabase } from '../project-events';
import { migrateTaskStorage } from './task-migration';
import { readTaskMetadata } from './task-table';

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'beni-task-migration-'));
  const root = join(temporary, 'project'), tasks = join(root, 'tasks'), projectId = generateId('project');
  mkdirSync(tasks, {recursive: true});
  const databasePath = join(temporary, projectId + '.sqlite');
  ensureProjectIdentity(databasePath, projectId);
  const app = new Database(join(temporary, 'beni.sqlite')), chats = new ChatStore(app, temporary);
  function legacy(fields: Partial<TaskMetadata> = {}) {
    const value: TaskMetadata = {...newMetadata('task', '旧タスク'), phase: 'requirements', status: 'idle', ...fields};
    const folder = join(tasks, value.id), file = join(folder, 'task.json');
    mkdirSync(folder);
    writeJson(file, value);
    return {value, folder, file};
  }
  return {
    root, tasks, databasePath, projectId, chats, legacy,
    read: (id: string) => withDatabase(databasePath, db => readTaskMetadata(db, id)),
    migrate: (importJson = true) => migrateTaskStorage(databasePath, root, projectId, chats, {importJson}),
    close: () => { app.close(); rmSync(temporary, {recursive: true, force: true}); },
  };
}

function conversation(scope: ChatScope, id: string) {
  const at = '2026-11-01T01:23:45.000Z';
  return encodeChatHistory({
    ...scope, id, version: 1, threadId: null, sessionId: null, lastEventId: 0, selectedModel: null,
    messages: [{id: 'message', sendId: 'send', role: 'user', content: '記録', provider: 'codex', model: 'test',
      status: 'completed', createdAt: at, updatedAt: at, threadId: null, sessionId: null}], packs: [],
  });
}

test('旧JSONの全項目を読み戻し、文書・会話・イベントを維持して旧JSONだけを削除する', () => {
  const f = fixture();
  try {
    const chatId = generateId('chat');
    const completion = {id: 'completion', chatId, revision: 'revision', provider: 'codex', model: null} as const;
    const {value, folder, file} = f.legacy({
      createdAt: null, updatedAt: '2026-11-01T02:03:04.000Z', phase: 'finalization', status: 'completed',
      documentBaseline: {'requirements.md': {hash: 'a'.repeat(64), modifiedAt: 123}}, pendingCompletion: completion,
    });
    const scope = {projectId: f.projectId, taskId: value.id, phase: 'finalization'} as const;
    writeJson(f.chats.path(chatId), conversation(scope, chatId));
    f.chats.publish(scope, chatId, true);
    const chatBefore = f.chats.read(scope, chatId);
    const unmanaged = join(folder, 'local.data'), document = join(folder, 'requirements.md');
    writeFileSync(unmanaged, '保持');
    writeFileSync(document, '# 旧要件\r\n');
    const history = captureProjectTaskHistory(f.databasePath, f.root, value.id, 'finalization').events.find(event => event.path)!;
    const chatEvent = appendProjectEvent(f.databasePath, {...scope, type: 'task.completed', operationId: completion.id, chatId, sendId: 'send'});
    const synthetic = appendProjectEvent(f.databasePath, {...scope, type: 'task.completed', operationId: 'without-chat', chatId: 'without-chat'});
    const version = withDatabase(f.databasePath, db => new DocumentTable(db).update(value.id, 'documents.md', null, [
      {text: '参照あり', reason: '要件の整理', sources: [{kind: 'message', id: `finalization/${chatId}/message`, text: '記録'}]},
    ], 'migration-test'));

    expect(() => f.migrate(false)).toThrow('旧タスクの移行が必要');
    expect(f.read(value.id)).toBeUndefined();
    expect(f.migrate()).toEqual({migrated: 1, removed: 1});
    expect(f.read(value.id)).toEqual(value);
    expect(f.chats.read(scope, chatId)).toEqual(chatBefore);
    expect(f.chats.ref(chatId)?.archived).toBe(1);
    expect(projectEvent(f.databasePath, chatEvent.id)).toEqual(chatEvent);
    expect(projectEvent(f.databasePath, synthetic.id)).toEqual(synthetic);
    expect(getProjectFileVersion(f.databasePath, history.path!, history.id).content).toBe('# 旧要件\r\n');
    expect(withDatabase(f.databasePath, db => new DocumentTable(db).get(value.id, 'documents.md', version.revision))).toEqual(version);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(document, 'utf8')).toBe('# 旧要件\r\n');
    expect(readFileSync(unmanaged, 'utf8')).toBe('保持');
    expect(f.migrate()).toEqual({migrated: 0, removed: 0});
  } finally { f.close(); }
});

test('旧JSONを削除した後に停止しても保存結果から移行を完了し、空のフォルダーを片付ける', () => {
  const f = fixture();
  try {
    const {value, folder, file} = f.legacy();
    withDatabase(f.databasePath, db => {
      // 旧JSONの削除までは許可し、片付けの確定に失敗させる。
      db.exec('CREATE TABLE legacy_task_json(task_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL, source_digest TEXT NOT NULL, task_digest TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0)');
      db.exec("CREATE TRIGGER stop_cleanup BEFORE UPDATE ON legacy_task_json BEGIN SELECT RAISE(ABORT,'cleanup interrupted'); END");
    });
    expect(f.migrate).toThrow('cleanup interrupted');
    expect(f.read(value.id)).toEqual(value);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(() => f.migrate(false)).toThrow('旧タスクの移行が必要');
    withDatabase(f.databasePath, db => db.exec('DROP TRIGGER stop_cleanup'));
    expect(f.migrate()).toEqual({migrated: 1, removed: 1});
    expect(existsSync(f.tasks)).toBe(false);
    expect(f.migrate()).toEqual({migrated: 0, removed: 0});
  } finally { f.close(); }
});

test('発番先への移動で中断しても同じIDを使い、削除済みの旧フォルダーを復元しない', () => {
  const f = fixture();
  try {
    const original = join(f.tasks, '12'), deletedId = generateId('task');
    for (const name of ['12', '34', deletedId]) {
      const folder = join(f.tasks, name);
      mkdirSync(folder);
      writeFileSync(join(folder, 'requirements.md'), '# 保持');
    }
    writeFileSync(join(original, 'local.data'), '管理外');
    writeJson(join(f.root, 'legacy-history.json'), {version: 1, taskIdMap: {34: deletedId}});
    appendProjectEvent(f.databasePath, {type: 'task.deleted', taskId: deletedId});
    withDatabase(f.databasePath, db => {
      db.exec("CREATE TRIGGER stop_recovery BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'recovery interrupted'); END");
    });
    expect(() => f.migrate(false)).toThrow('recovery interrupted');
    expect(existsSync(original)).toBe(false);
    const id = readdirSync(f.tasks).find(name => name !== '34' && name !== deletedId)!;
    expect(validTaskId(id)).toBe(true);
    expect(f.read(id)).toBeUndefined();
    withDatabase(f.databasePath, db => db.exec('DROP TRIGGER stop_recovery'));
    expect(f.migrate(false)).toEqual({migrated: 1, removed: 0});
    expect(f.read(id)).toEqual({version: 1, id, name: 'Unknown', createdAt: null, updatedAt: null, phase: 'requirements', status: 'idle'});
    expect(f.read(deletedId)).toBeUndefined();
    expect(readFileSync(join(f.tasks, id, 'local.data'), 'utf8')).toBe('管理外');
    expect(readFileSync(join(f.tasks, '34', 'requirements.md'), 'utf8')).toBe('# 保持');
    expect(f.migrate(false)).toEqual({migrated: 0, removed: 0});
  } finally { f.close(); }
});

test('途中の保存済みタスクを上書きせず、移行元の差し替えを拒む', () => {
  const f = fixture();
  try {
    const {value, file} = f.legacy();
    const numeric = join(f.tasks, '12');
    mkdirSync(numeric);
    writeFileSync(join(numeric, 'requirements.md'), '# 要件');
    withDatabase(f.databasePath, db => {
      db.exec("CREATE TRIGGER stop_recovery BEFORE INSERT ON tasks WHEN NEW.name='Unknown' BEGIN SELECT RAISE(ABORT,'recovery interrupted'); END");
    });
    expect(f.migrate).toThrow('recovery interrupted');
    expect(f.read(value.id)).toEqual(value);
    const before = readFileSync(file);
    writeJson(file, value);
    expect(f.migrate).toThrow('Legacy task changed during migration');
    expect(readFileSync(file)).toEqual(before);
    withDatabase(f.databasePath, db => db.query('UPDATE tasks SET name=? WHERE id=?').run('新しい値', value.id));
    expect(f.migrate).toThrow();
    expect(f.read(value.id)?.name).toBe('新しい値');
    expect(readFileSync(file)).toEqual(before);
  } finally { f.close(); }
});

test('リンク、会話の欠落、完了情報の破損を検出したときは旧ファイルを保持する', () => {
  const f = fixture();
  try {
    const {value, folder, file} = f.legacy();
    const outside = join(folder, 'copy.json');
    linkSync(file, outside);
    expect(f.migrate).toThrow('Invalid legacy task file');
    expect(readFileSync(file)).toEqual(readFileSync(outside));
    rmSync(outside);

    writeJson(file, {...value, pendingCompletion: {id: 'bad'}});
    expect(f.migrate).toThrow('Invalid pending workflow completion');
    writeJson(file, value);
    const scope = {projectId: f.projectId, taskId: value.id, phase: 'requirements'} as const;
    const chatId = generateId('chat'), path = f.chats.path(chatId);
    writeJson(path, conversation(scope, chatId));
    f.chats.publish(scope, chatId, false);
    rmSync(path);
    expect(f.migrate).toThrow('Missing chat history');
    expect(f.read(value.id)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  } finally { f.close(); }
});

test('公開前の作成記録を検証し、タスクへ昇格させずに旧JSONを片付ける', () => {
  const f = fixture();
  try {
    const {value, folder} = f.legacy();
    const staged = join(f.tasks, '.creating-123abc');
    renameSync(folder, staged);
    const privateFile = join(staged, 'local.data');
    writeFileSync(privateFile, '保持');
    expect(() => f.migrate(false)).toThrow('旧タスクの移行が必要');
    expect(f.migrate()).toEqual({migrated: 0, removed: 1});
    expect(f.read(value.id)).toBeUndefined();
    expect(existsSync(join(staged, 'task.json'))).toBe(false);
    expect(readFileSync(privateFile, 'utf8')).toBe('保持');
    expect(f.migrate()).toEqual({migrated: 0, removed: 0});
  } finally { f.close(); }
});
