import { test, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { INSTRUCTIONS_CHAT_ID } from '../shared/communication';
import { generateId, validChatId } from '../shared/ids';
import { workflowJobHash } from './chat-files';
import { assertChatMigrationReady, migrateChatStorage } from './chat-migration';
import type { ChatScope } from './chat-store';
import { appendProjectEvent, projectEvent, withDatabase } from './project-events';
import { Store } from './store';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beni-chat-migration-'));
  const store = new Store(join(root, 'beni.sqlite'), {migration: true});
  const work = join(root, 'work');
  mkdirSync(work);
  const project = store.createProject('Project', work);
  const task = store.createTask(project.id, 'Task');
  const directory = store.legacyProjectDirectory(project.id), databasePath = store.projectDatabasePath(project.id);
  const general = {projectId: project.id, taskId: null, phase: null};
  const finalization = {projectId: project.id, taskId: task.id, phase: 'finalization'} as const;
  const projects = store.chatMigrationProjects(), chats = store.chats;
  return {
    root, directory, databasePath, chats, general, finalization, store,
    migrate: () => migrateChatStorage(chats, root, projects),
    ready: () => assertChatMigrationReady(chats, root, projects),
    close: () => { store.close(); rmSync(root, {recursive: true, force: true}); },
  };
}

function legacy(path: string, scope: ChatScope, id: string, fields = {}) {
  mkdirSync(dirname(path), {recursive: true});
  const now = '2026-01-01T00:00:00.000Z';
  const value = {
    id, version: 1, ...scope, threadId: 'test-resume', sessionId: 'test-session', lastEventId: 3,
    selectedModel: {id: 'test-model', name: 'Test model', provider: 'codex'},
    messages: [{
      id: 'test-message', sendId: 'test-send', role: 'user', content: 'Test body', provider: 'codex',
      model: 'test-model', createdAt: now, updatedAt: now, status: 'completed',
      threadId: 'test-resume', sessionId: 'test-session',
    }],
    packs: [], ...fields,
  };
  writeFileSync(path, JSON.stringify(value));
  return value;
}

test('全用途とアーカイブを所有者ごとに移行し、過去イベントを変更せずに参照を解決する', () => {
  const f = fixture();
  try {
    const oldId = crypto.randomUUID(), archiveId = generateId('chat');
    const job = {...f.finalization, id: oldId, revision: 'test-revision', provider: 'codex', model: null} as const;
    f.store.enqueueInstructionJob(job);
    const workflow = {...f.general, workflowJobId: job.id};
    const instructions = {projectId: INSTRUCTIONS_CHAT_ID, taskId: null, phase: null};
    const task = join(f.directory, 'tasks', f.finalization.taskId);
    const instructionDirectory = join(f.root, 'chat');
    const files = [
      [join(f.directory, 'general.chat.json'), f.general, oldId],
      [join(f.directory, 'history', archiveId + '.json'), f.general, archiveId],
      [join(task, 'finalization.chat.json'), f.finalization, oldId],
      [join(task, 'workflow-jobs', workflowJobHash(job.id) + '.json'), workflow, oldId],
      [join(instructionDirectory, 'instructions.json'), instructions, oldId],
    ] as const;
    for (const [path, scope, id] of files) legacy(path, scope, id, scope === instructions ? {appliedEditorContent: 'Test editor'} : {});
    const unmanaged = join(instructionDirectory, 'readme.txt');
    writeFileSync(unmanaged, 'keep');
    const event = appendProjectEvent(f.databasePath, {
      ...f.finalization, type: 'task.completed', chatId: oldId, operationId: oldId, sendId: 'test-send',
    });
    withDatabase(f.databasePath, db => {
      db.exec('CREATE TABLE document_knowledge_completion (task_id TEXT,chat_id TEXT,PRIMARY KEY(task_id,chat_id))');
      db.query('INSERT INTO document_knowledge_completion VALUES (?,?)').run(f.finalization.taskId, oldId);
    });

    expect(f.ready).toThrow('旧チャットの移行が必要');
    expect(f.migrate()).toEqual({chats: 5, removed: 5});
    f.ready();
    const ids = files.map(([path, scope, old]) => {
      const chat = f.chats.read(scope, old)!;
      expect(validChatId(chat.id)).toBe(true);
      expect(chat.messages[0]).toMatchObject({id: 'test-message', sendId: 'test-send', content: 'Test body'});
      expect(chat).toMatchObject({threadId: 'test-resume', sessionId: 'test-session', lastEventId: 3});
      const raw = JSON.parse(readFileSync(f.chats.path(chat.id), 'utf8'));
      expect(raw).toHaveProperty('chatId', chat.id);
      expect(raw).not.toHaveProperty('id');
      expect(existsSync(path)).toBe(false);
      return chat.id;
    });
    expect(new Set(ids).size).toBe(5);
    expect(f.chats.ref(archiveId)?.archived).toBe(1);
    expect(existsSync(join(f.directory, 'history'))).toBe(false);
    expect(readFileSync(unmanaged, 'utf8')).toBe('keep');
    expect(f.chats.read(instructions)?.appliedEditorContent).toBe('Test editor');
    expect(projectEvent(f.databasePath, event.id)).toEqual(event);
    expect(withDatabase(f.databasePath, db => db.query('SELECT chat_id FROM document_knowledge_completion').get())).toEqual({chat_id: ids[2]});
    expect(f.store.pendingInstructionJob()?.id).toBe(oldId);
    expect(f.migrate()).toEqual({chats: 0, removed: 0});
  } finally { f.close(); }
});

test('検証が中断しても同じ移行先を使い、衝突した会話と移行元を保全する', () => {
  const f = fixture();
  try {
    const oldId = crypto.randomUUID(), path = join(f.directory, 'general.chat.json');
    legacy(path, f.general, oldId);
    const original = readFileSync(path, 'utf8');
    const event = appendProjectEvent(f.databasePath, {type: 'tool.started', chatId: oldId, sendId: 'missing-send'});
    expect(f.migrate).toThrow('Unresolved project event chat reference');
    const filenames = readdirSync(join(f.root, 'chats'));
    expect(filenames).toHaveLength(1);
    const target = join(f.root, 'chats', filenames[0]!);
    const verified = readFileSync(target, 'utf8');
    expect(f.chats.current(f.general)).toBeNull();
    expect(f.ready).toThrow('旧チャットの移行が必要');

    writeFileSync(target, '{}');
    expect(f.migrate).toThrow('Conflicting chat migration target');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readFileSync(target, 'utf8')).toBe('{}');

    writeFileSync(target, verified);
    withDatabase(f.databasePath, db => db.query('DELETE FROM events WHERE id=?').run(event.id));
    expect(f.migrate()).toEqual({chats: 1, removed: 1});
    expect(readdirSync(join(f.root, 'chats'))).toEqual(filenames);
    expect(f.chats.resolve(f.general, oldId)?.chatId + '.json').toBe(filenames[0]);
    expect(existsSync(path)).toBe(false);
  } finally { f.close(); }
});

test('未確定の旧タスク削除に隔離された会話を回収し、タスクの復元記録を保つ', () => {
  const f = fixture();
  try {
    const {projectId, taskId} = f.finalization;
    const staged = join(f.directory, '.deleting-' + taskId), task = join(f.directory, 'tasks', taskId);
    mkdirSync(task, {recursive: true});
    const path = join(staged, 'task', 'finalization.chat.json'), oldId = crypto.randomUUID();
    mkdirSync(staged);
    renameSync(task, join(staged, 'task'));
    writeFileSync(join(staged, 'journal.json'), JSON.stringify({version: 1, projectId, taskId}));
    legacy(path, f.finalization, oldId);
    appendProjectEvent(f.databasePath, {...f.finalization, type: 'tool.started', chatId: oldId, sendId: 'test-send'});
    expect(f.ready).toThrow('旧チャットの移行が必要');
    expect(f.migrate()).toEqual({chats: 1, removed: 1});
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(staged, 'journal.json'))).toBe(true);
    expect(f.chats.read(f.finalization, oldId)?.messages[0]?.content).toBe('Test body');
    f.store.initializeStorage();
    expect(f.store.task(taskId)).not.toBeNull();
  } finally { f.close(); }
});
