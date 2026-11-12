import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '../shared/ids';
import { defaultEventKinds, eventToolArguments } from './embedded-tools';
import { appendProjectEvent, captureProjectTaskHistory, getProjectFileChange, getProjectFileVersion, legacyProjectDatabasePath, projectEvent, projectEvents, projectTaskDeleted, projectTaskVersion, type ProjectEventInput } from './project-events';
import { retrospectiveSignals } from './retrospective-signals';
import { Store } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beni-events-'));
  roots.push(root);
  const id = generateId('task'), task = join(root, 'tasks', id), path = `.beni/tasks/${id}/requirements.md`;
  mkdirSync(task, {recursive: true});
  return {root, databasePath: join(root, 'test.sqlite'), id, task, path, file: join(task, 'requirements.md')};
}
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
function editDatabase(databasePath: string, edit: (db: Database) => void) {
  const db = new Database(databasePath);
  try { edit(db); } finally { db.close(); }
}

test('LF・CRLF・混在・無末尾改行・空文書を初版と差分から完全に復元する', () => {
  const {root, databasePath, id, file, path} = fixture();
  const contents = ['', '先頭\n次行\n', '先頭\r\n次行\r\n', '先頭\r\n変更\n末尾', '先頭\r\n変更\n末尾\n', '追加\n先頭\r\n変更\n末尾\n', '\ufeff\r\n\r末尾', ''];
  const versions: {id: number; content: string}[] = [];
  for (const content of contents) {
    writeFileSync(file, content);
    const event = captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type.startsWith('document.'))!;
    expect(event.version).toBe(digest(content));
    versions.push({id: event.id, content});
    const diff = getProjectFileChange(databasePath, event.id);
    expect(diff.patch.startsWith('--- ')).toBe(true);
    expect(diff.patch.includes('\n+++ ')).toBe(true);
    expect(diff.afterHash).toBe(digest(content));
  }
  // キャッシュに依存せず、初版の追加差分からすべての版を再生する。
  editDatabase(databasePath, db => db.exec('DELETE FROM file_snapshots'));
  for (const version of versions) {
    expect(getProjectFileVersion(databasePath, path, version.id)).toEqual({path, changeId: version.id, content: version.content, hash: digest(version.content), exists: true});
    expect(projectTaskVersion(databasePath, id, digest(version.content)).content).toBe(version.content);
  }
});

test('削除と同じパスの再作成を別の連鎖にし、空文書と不存在を区別する', () => {
  const {root, databasePath, id, file, path} = fixture();
  writeFileSync(file, 'before\n');
  const first = captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  rmSync(file);
  const removed = captureProjectTaskHistory(databasePath, root, id, 'requirements').events[0]!;
  expect(removed.type).toBe('document.deleted');
  expect(removed.version).toBe(digest('before\n'));
  expect(getProjectFileVersion(databasePath, path, removed.id)).toMatchObject({content: null, hash: null, exists: false});
  writeFileSync(file, '');
  const recreated = captureProjectTaskHistory(databasePath, root, id, 'requirements').events[0]!;
  expect(getProjectFileChange(databasePath, recreated.id).previousChangeId).toBeNull();
  expect(getProjectFileVersion(databasePath, path, recreated.id)).toMatchObject({content: '', hash: digest(''), exists: true});
  expect(getProjectFileVersion(databasePath, path, first.id).content).toBe('before\n');
});

test('後のフェーズでも既追跡文書の一対一リネームを継続し、新規資料を追跡しない', () => {
  const {root, databasePath, id, task} = fixture();
  writeFileSync(join(task, 'notes.md'), 'same\r\n');
  captureProjectTaskHistory(databasePath, root, id, 'documents');
  renameSync(join(task, 'notes.md'), join(task, 'renamed.md'));
  writeFileSync(join(task, 'generated.md'), 'excluded');
  const captured = captureProjectTaskHistory(databasePath, root, id, 'execution', 'documents');
  const renamed = captured.events.find(event => event.type === 'document.renamed')!;
  expect(renamed.previousPath).toBe(`.beni/tasks/${id}/notes.md`);
  expect(renamed.path).toBe(`.beni/tasks/${id}/renamed.md`);
  expect(captured.snapshot).toEqual({'renamed.md': digest('same\r\n')});
  expect(getProjectFileVersion(databasePath, renamed.path!, renamed.id).content).toBe('same\r\n');
  expect(() => getProjectFileVersion(databasePath, renamed.previousPath!, renamed.id)).toThrow('Unknown file version');
  writeFileSync(join(task, 'renamed.md'), 'updated');
  expect(captureProjectTaskHistory(databasePath, root, id, 'retrospective').events.some(event => event.type === 'document.updated')).toBe(true);
});

test('同一内容の候補が複数ある場合はリネームと推測しない', () => {
  const {root, databasePath, id, task} = fixture();
  writeFileSync(join(task, 'before.md'), 'same');
  captureProjectTaskHistory(databasePath, root, id, 'requirements');
  rmSync(join(task, 'before.md'));
  writeFileSync(join(task, 'after-one.md'), 'same');
  writeFileSync(join(task, 'after-two.md'), 'same');
  const events = captureProjectTaskHistory(databasePath, root, id, 'requirements').events;
  expect(events.map(event => event.type)).toEqual(['document.deleted', 'document.created', 'document.created']);
});

test('文書更新と同時にフェーズが変わっても一度だけ記録する', () => {
  const {root, databasePath, id, file} = fixture();
  writeFileSync(file, 'first');
  captureProjectTaskHistory(databasePath, root, id, 'requirements');
  writeFileSync(file, 'second');
  // 実行通知のphaseは実行の文脈であり、タスクのフェーズ移動そのものではない。
  appendProjectEvent(databasePath, {type: 'tool.started', taskId: id, phase: 'documents', operationId: 'phase-test-operation'});
  const events = captureProjectTaskHistory(databasePath, root, id, 'documents', 'requirements').events;
  expect(events.map(event => event.type)).toEqual(['document.updated', 'phase.changed']);
  expect(events[1]).toMatchObject({from: 'requirements', to: 'documents', sourcePhase: 'requirements'});
  expect(captureProjectTaskHistory(databasePath, root, id, 'documents').events).toEqual([]);
});

test('固定上限と絞り込み前の走査カーソルで空ページも進める', () => {
  const {databasePath, id} = fixture();
  const other = generateId('task');
  appendProjectEvent(databasePath, {type: 'task.created', taskId: other});
  appendProjectEvent(databasePath, {type: 'task.completed', taskId: other});
  appendProjectEvent(databasePath, {type: 'task.created', taskId: id});
  const first = projectEvents(databasePath, {taskId: id, limit: 1});
  expect(first).toMatchObject({events: [], lastEventId: 1, nextCursor: 1, through: 3, hasMore: true});
  appendProjectEvent(databasePath, {type: 'task.reopened', taskId: id});
  const second = projectEvents(databasePath, {taskId: id, after: first.nextCursor, through: first.through, limit: 1});
  expect(second.events).toEqual([]);
  const last = projectEvents(databasePath, {taskId: id, after: second.nextCursor, through: first.through, limit: 1});
  expect(last.events.map(event => event.id)).toEqual([3]);
  expect(last.hasMore).toBe(false);
});

test('モデル用ページは対象外の操作とタスクを飛ばし、最終ページで固定上限まで進める', () => {
  const {databasePath, id} = fixture();
  const other = generateId('task');
  for (let index = 0; index < 101; index++) appendProjectEvent(databasePath, {type: 'tool.started', taskId: id});
  appendProjectEvent(databasePath, {type: 'task.created', taskId: other});
  const created = appendProjectEvent(databasePath, {type: 'task.created', taskId: id});
  appendProjectEvent(databasePath, {type: 'task.completed', taskId: other});
  const completed = appendProjectEvent(databasePath, {type: 'task.completed', taskId: id});
  const tail = appendProjectEvent(databasePath, {type: 'tool.finished', taskId: id});
  const options = {taskId: id, types: ['task.created', 'task.completed'], limit: 1};
  const audit = projectEvents(databasePath, options);
  expect(audit).toMatchObject({events: [], nextCursor: 1, hasMore: true});
  const first = projectEvents(databasePath, {...options, modelPage: true});
  expect(first.events.map(event => event.id)).toEqual([created.id]);
  expect(first).toMatchObject({nextCursor: created.id, through: tail.id, hasMore: true});
  appendProjectEvent(databasePath, {type: 'task.completed', taskId: id});
  const last = projectEvents(databasePath, {...options, modelPage: true, after: first.nextCursor, through: first.through});
  expect(last.events.map(event => event.id)).toEqual([completed.id]);
  expect(last).toMatchObject({nextCursor: tail.id, hasMore: false});
  expect(projectEvents(databasePath, {...options, modelPage: true, after: completed.id, through: first.through})).toMatchObject({
    events: [], nextCursor: tail.id, hasMore: false,
  });
  expect(projectEvents(databasePath, {modelPage: true, types: [], limit: 1}).events.map(event => event.type)).toEqual(['tool.started']);
});

test('10変更ごとにキャッシュし、古い間隔を倍にして間引いても全版を復元できる', () => {
  const {root, databasePath, id, file, path} = fixture();
  const ids: number[] = [];
  for (let revision = 0; revision <= 160; revision++) {
    writeFileSync(file, `revision ${revision}\r\n`);
    ids.push(captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type.startsWith('document.'))!.id);
  }
  let counts: number[] = [];
  editDatabase(databasePath, db => { counts = (db.query('SELECT c.change_count FROM file_snapshots s JOIN file_changes c ON c.event_id=s.change_id ORDER BY c.change_count').all() as {change_count: number}[]).map(row => row.change_count); });
  expect(counts).toEqual([0, 40, 80, 100, 120, 130, 140, 150, 160]);
  for (const revision of [0, 20, 27, 40, 79, 99, 125, 160]) expect(getProjectFileVersion(databasePath, path, ids[revision]!).content).toBe(`revision ${revision}\r\n`);
});

test('壊れたキャッシュを使わず、差分も壊れていれば履歴破損を報告する', () => {
  const {root, databasePath, id, file, path} = fixture();
  writeFileSync(file, 'first\n');
  const first = captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  writeFileSync(file, 'next\n');
  const next = captureProjectTaskHistory(databasePath, root, id, 'requirements').events[0]!;
  editDatabase(databasePath, db => db.query('UPDATE file_snapshots SET content=? WHERE change_id=?').run(Buffer.from('corrupt'), first.id));
  expect(getProjectFileVersion(databasePath, path, next.id).content).toBe('next\n');
  editDatabase(databasePath, db => db.query('UPDATE file_changes SET patch=? WHERE event_id=?').run(Buffer.from('--- a\n+++ b\n@@ -1,1 +1,1 @@\n-wrong\n+next\n'), next.id));
  expect(() => getProjectFileVersion(databasePath, path, next.id)).toThrow('Unified diff content mismatch');
});

test('サイズ超過・不正UTF-8・リンクを拒否し、最後の版を進めない', () => {
  const {root, databasePath, id, file} = fixture();
  writeFileSync(file, 'saved');
  const first = captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 97));
  expect(() => captureProjectTaskHistory(databasePath, root, id, 'requirements')).toThrow('exceeds 1 MiB');
  writeFileSync(file, Buffer.from([0xc0, 0xaf]));
  expect(() => captureProjectTaskHistory(databasePath, root, id, 'requirements')).toThrow('not valid UTF-8');
  expect(projectEvents(databasePath).through).toBe(first.id);
  writeFileSync(file, 'recovered');
  const next = captureProjectTaskHistory(databasePath, root, id, 'requirements').events[0]!;
  expect(getProjectFileChange(databasePath, next.id).previousChangeId).toBe(first.id);
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'outside');
  rmSync(file);
  symlinkSync(outside, file);
  expect(() => captureProjectTaskHistory(databasePath, root, id, 'requirements')).toThrow('Invalid tracked document');
});

test('タスク削除の失敗をロールバックし、削除後も履歴を残して二重削除を防ぐ', () => {
  const {root, databasePath, id, task, file, path} = fixture();
  writeFileSync(file, 'retained');
  const first = captureProjectTaskHistory(databasePath, root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  expect(() => projectTaskDeleted(databasePath, id, () => { throw Error('commit failed'); })).toThrow('commit failed');
  expect(projectEvents(databasePath).through).toBe(first.id);
  const deleted = projectTaskDeleted(databasePath, id, () => rmSync(task, {recursive: true}));
  expect(projectTaskDeleted(databasePath, id).id).toBe(deleted.id);
  expect(projectEvents(databasePath).through).toBe(deleted.id);
  expect(getProjectFileVersion(databasePath, path, first.id).content).toBe('retained');
  expect(projectTaskVersion(databasePath, id, digest('retained')).content).toBe('retained');
  expect(() => captureProjectTaskHistory(databasePath, root, id, 'requirements')).toThrow('Task history is deleted');
  expect(projectEvents(databasePath).events.filter(event => event.type === 'document.deleted')).toEqual([]);
});

test('実行開始・終了は参照と種別で重複を防ぎ、出力・コマンドの保存を拒否する', () => {
  const {databasePath, id} = fixture();
  const input = {type: 'tool.started', taskId: id, phase: 'execution' as const, operationId: 'operation-one', chatId: 'chat-one', sendId: 'send-one', packId: 'pack-one', toolCallId: 'call-one', details: {toolName: 'command', targetPaths: ['src/example.ts']}};
  const first = appendProjectEvent(databasePath, input);
  expect(appendProjectEvent(databasePath, input).id).toBe(first.id);
  const finished = appendProjectEvent(databasePath, {...input, type: 'tool.finished', details: {...input.details, result: 'success', exitCode: 0}});
  expect(finished.id).toBe(first.id + 1);
  expect(projectEvent(databasePath, finished.id).packId).toBe('pack-one');
  expect(() => appendProjectEvent(databasePath, {...input, chatId: 'another-chat'})).toThrow('Conflicting operation event');
  expect(() => appendProjectEvent(databasePath, {...input, operationId: 'other', details: {command: 'example command'} as any})).toThrow('Unsupported event details');
  expect(() => appendProjectEvent(databasePath, {...input, operationId: 'other', details: {output: 'example output'} as any})).toThrow('Unsupported event details');
});

test('ワークフローの詳細を専用イベントに保存し、イベントツールの絞り込みで使える', () => {
  const {databasePath, id: taskId} = fixture();
  const trigger = appendProjectEvent(databasePath, {type: 'task.completed', taskId});
  const details = {workflowJobId: 'fixture-job', eventKey: 'task.completed' as const, triggerEventId: trigger.id, attemptId: crypto.randomUUID()};
  const input = {type: 'workflow.started', taskId, details};
  const started = appendProjectEvent(databasePath, input);
  const chatId = generateId('chat');
  const completed = appendProjectEvent(databasePath, {...input, type: 'workflow.completed', chatId});
  expect(started).toMatchObject({taskId, details, chatId: null});
  expect(projectEvent(databasePath, completed.id)).toMatchObject({taskId, details, chatId});
  const {kind} = eventToolArguments('list_events', {kind: 'workflow.completed'});
  expect(projectEvents(databasePath, {types: [kind], modelPage: true}).events).toEqual([completed]);
  expect(projectEvents(databasePath, {types: defaultEventKinds, modelPage: true}).events).toEqual([trigger, started, completed]);
  expect(() => appendProjectEvent(databasePath, {...input, type: 'task.completed'})).toThrow('Unsupported event details');
  expect(() => appendProjectEvent(databasePath, {...input, type: 'workflow.unknown'})).toThrow('Invalid event type');
  expect(() => appendProjectEvent(databasePath, {...input, details: {...details, attemptId: 'invalid'}})).toThrow('Invalid workflow event details');
  expect(() => appendProjectEvent(databasePath, {...input, details: {...details, triggerEventId: 0}})).toThrow('Invalid workflow event details');
  expect(() => appendProjectEvent(databasePath, {...input, details: {...details, result: 'completed'}})).toThrow('Unsupported event details');
});

test('反省会の引用集計は空白を除き、抜粋が異なる同じ原文をまとめる', () => {
  const { root } = fixture();
  const store = new Store(join(root, 'store.sqlite'));
  try {
    const project = store.createProject('Project', root);
    const task = store.createTask(project.id, 'Task');
    const original = store.managedDocument(project.id, task.id, 'requirements.md')!;
    const document = store.writeManagedDocument(project.id, task.id, original.name, original.revision, [
      ...original.items,
      { text: '\n', reason: '', sources: [] },
      { text: '要件本文', reason: '合意したため', sources: [
        { kind: 'message', id: 'message', text: '抜粋1' },
        { kind: 'message', id: 'message', text: '抜粋2' },
        { kind: 'document', id: 'document/item', revision: 'old', text: '旧版の本文' },
        { kind: 'document', id: 'document/item', revision: 'new', text: '新版の本文' },
      ] },
    ], 'test');

    const result = retrospectiveSignals(store, project.id, task.id, 'documents', 0);
    expect(result).toMatchObject({ area: 'documents', next: null });
    if (result.area !== 'documents') throw Error('Expected document signals');
    expect(result.documents.find(entry => entry.name === original.name)).toEqual({
      name: original.name, revision: document.revision, items: 2, citations: 4,
      byKind: { document: 2, instruction: 0, message: 2, result: 0 },
      uniqueSources: 3, imported: { template: 1, legacy: 0 },
      mostCitedItems: [{ item: 2, excerpt: '要件本文', citations: 4 }],
    });
  } finally { store.close(); }
});

test('反省会の実装集計は対象タスクの書き込みの反復と終了の異常を返す', () => {
  const { root } = fixture();
  const store = new Store(join(root, 'store.sqlite'));
  try {
    const project = store.createProject('Project', root);
    const task = store.createTask(project.id, 'Task');
    const other = store.createTask(project.id, 'Other');
    const record = (event: ProjectEventInput) => store.recordProjectEvent(project.id, {
      taskId: task.id, phase: 'execution', ...event,
    });
    const edit = { type: 'tool.finished', details: { toolName: 'Edit', targetPaths: ['src/example.ts'], result: 'completed' } };
    const first = record({ ...edit, operationId: 'edit-1' });
    const second = record({ ...edit, operationId: 'edit-2' });
    record({ ...edit, operationId: 'edit-other', taskId: other.id });
    record({ ...edit, operationId: 'edit-retrospective', phase: 'retrospective' });
    for (const operationId of ['read-1', 'read-2']) record({
      type: 'tool.finished', operationId, details: { toolName: 'Read', targetPaths: ['src/read-only.ts'], result: 'completed' },
    });
    record({ type: 'tool.started', operationId: 'command', details: { toolName: 'command' } });
    const failed = record({
      type: 'tool.finished', operationId: 'command', details: { toolName: 'command', result: 'completed', exitCode: 1 },
    });
    const interrupted = record({
      type: 'tool.finished', operationId: 'interrupted', details: { toolName: 'command', result: 'interrupted' },
    });
    const unknown = record({ type: 'tool.started', operationId: 'unknown', details: { toolName: 'command' } });
    expect(retrospectiveSignals(store, project.id, task.id, 'execution', 0)).toMatchObject({
      area: 'execution', toolExecutions: 7, successfulEditCallsWithPaths: 2, anomalyCount: 3,
      anomalies: [
        { eventId: unknown.id, operationId: 'unknown', result: 'unknown', missingFinish: true },
        { eventId: interrupted.id, operationId: 'interrupted', result: 'interrupted' },
        { eventId: failed.id, operationId: 'command', result: 'failed', exitCode: 1 },
      ],
      repeatedEditCount: 1, repeatedEdits: [{ path: 'src/example.ts', count: 2, eventIds: [second.id, first.id] }],
      latestCompletion: null, next: null,
    });
  } finally { store.close(); }
});

test.each(['', '-journal', '-wal', '-shm'])('イベントDB（接尾辞 "%s"）のシンボリックリンクを拒否する', suffix => {
  const {root, databasePath} = fixture(), outside = join(root, 'outside.sqlite');
  writeFileSync(outside, 'untouched');
  symlinkSync(outside, databasePath + suffix);
  expect(() => projectEvents(databasePath)).toThrow('Invalid event database file');
  expect(readFileSync(outside, 'utf8')).toBe('untouched');
});

test('イベントDBのハードリンクを拒否する', () => {
  const {root, databasePath} = fixture();
  projectEvents(databasePath);
  linkSync(databasePath, join(root, 'linked.sqlite'));
  expect(() => projectEvents(databasePath)).toThrow('Invalid event database file');
});

test('旧イベントDBをWALから復旧して改名し、イベントを維持する', () => {
  const {root} = fixture(), legacy = join(root, 'events.sqlite');
  const db = new Database(legacy);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT, phase TEXT, source_phase TEXT,
    operation_id TEXT, chat_id TEXT, send_id TEXT, pack_id TEXT, tool_call_id TEXT, details TEXT NOT NULL, from_phase TEXT, to_phase TEXT);
    PRAGMA journal_mode=WAL;`);
  db.query('INSERT INTO events(type,at,details) VALUES (?,?,?)').run('project.created', '2026-01-01T00:00:00.000Z', '{}');
  db.close();
  expect(projectEvents(legacyProjectDatabasePath(root)).events.map(event => event.type)).toEqual(['project.created']);
  expect(readFileSync(join(root, 'project.sqlite')).byteLength).toBeGreaterThan(0);
  expect(() => readFileSync(legacy)).toThrow();
  const reopened = new Database(join(root, 'project.sqlite'));
  expect(reopened.query('PRAGMA journal_mode').get()).toEqual({journal_mode: 'delete'});
  reopened.close();
});

test('新旧イベントDBが両方ある場合はどちらにも触れず拒否する', () => {
  const {root} = fixture();
  writeFileSync(join(root, 'events.sqlite'), 'legacy');
  writeFileSync(join(root, 'project.sqlite'), 'current');
  expect(() => legacyProjectDatabasePath(root)).toThrow('Both project event databases exist');
  expect(readFileSync(join(root, 'events.sqlite'), 'utf8')).toBe('legacy');
  expect(readFileSync(join(root, 'project.sqlite'), 'utf8')).toBe('current');
});

test('タスク文書だけを保存し、プロジェクト共通知識とソースコードを追跡しない', () => {
  const {root, databasePath, id, task, file} = fixture();
  writeFileSync(file, 'requirements');
  writeFileSync(join(root, 'knowledge.md'), 'knowledge');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'spec.md'), 'copied spec');
  writeFileSync(join(task, 'source.ts'), 'source');
  expect(captureProjectTaskHistory(databasePath, root, id, 'requirements').snapshot).toEqual({'requirements.md': digest('requirements')});
});
