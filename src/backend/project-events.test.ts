import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateId } from '../shared/ids';
import { appendProjectEvent, captureProjectTaskHistory, getProjectFileChange, getProjectFileVersion, projectEvent, projectEvents, projectTaskDeleted, projectTaskVersion, type ProjectEventInput } from './project-events';
import { retrospectiveSignals } from './retrospective-signals';
import { Store } from './store';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'beni-events-'));
  roots.push(root);
  const id = generateId('task'), task = join(root, '.beni', 'tasks', id), path = `.beni/tasks/${id}/requirements.md`;
  mkdirSync(task, {recursive: true});
  return {root, id, task, path, file: join(task, 'requirements.md')};
}
const digest = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
function editDatabase(root: string, edit: (db: Database) => void) {
  const db = new Database(join(root, '.beni', 'project.sqlite'));
  try { edit(db); } finally { db.close(); }
}

test('LF・CRLF・混在・無末尾改行・空文書を初版と差分から完全に復元する', () => {
  const {root, id, file, path} = fixture();
  const contents = ['', '先頭\n次行\n', '先頭\r\n次行\r\n', '先頭\r\n変更\n末尾', '先頭\r\n変更\n末尾\n', '追加\n先頭\r\n変更\n末尾\n', '\ufeff\r\n\r末尾', ''];
  const versions: {id: number; content: string}[] = [];
  for (const content of contents) {
    writeFileSync(file, content);
    const event = captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type.startsWith('document.'))!;
    expect(event.version).toBe(digest(content));
    versions.push({id: event.id, content});
    const diff = getProjectFileChange(root, event.id);
    expect(diff.patch.startsWith('--- ')).toBe(true);
    expect(diff.patch.includes('\n+++ ')).toBe(true);
    expect(diff.afterHash).toBe(digest(content));
  }
  // キャッシュに依存せず、初版の追加差分からすべての版を再生する。
  editDatabase(root, db => db.exec('DELETE FROM file_snapshots'));
  for (const version of versions) {
    expect(getProjectFileVersion(root, path, version.id)).toEqual({path, changeId: version.id, content: version.content, hash: digest(version.content), exists: true});
    expect(projectTaskVersion(root, id, digest(version.content)).content).toBe(version.content);
  }
});

test('削除と同じパスの再作成を別の連鎖にし、空文書と不存在を区別する', () => {
  const {root, id, file, path} = fixture();
  writeFileSync(file, 'before\n');
  const first = captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  rmSync(file);
  const removed = captureProjectTaskHistory(root, id, 'requirements').events[0]!;
  expect(removed.type).toBe('document.deleted');
  expect(removed.version).toBe(digest('before\n'));
  expect(getProjectFileVersion(root, path, removed.id)).toMatchObject({content: null, hash: null, exists: false});
  writeFileSync(file, '');
  const recreated = captureProjectTaskHistory(root, id, 'requirements').events[0]!;
  expect(getProjectFileChange(root, recreated.id).previousChangeId).toBeNull();
  expect(getProjectFileVersion(root, path, recreated.id)).toMatchObject({content: '', hash: digest(''), exists: true});
  expect(getProjectFileVersion(root, path, first.id).content).toBe('before\n');
});

test('後のフェーズでも既追跡文書の一対一リネームを継続し、新規資料を追跡しない', () => {
  const {root, id, task} = fixture();
  writeFileSync(join(task, 'notes.md'), 'same\r\n');
  captureProjectTaskHistory(root, id, 'documents');
  renameSync(join(task, 'notes.md'), join(task, 'renamed.md'));
  writeFileSync(join(task, 'generated.md'), 'excluded');
  const captured = captureProjectTaskHistory(root, id, 'execution', 'documents');
  const renamed = captured.events.find(event => event.type === 'document.renamed')!;
  expect(renamed.previousPath).toBe(`.beni/tasks/${id}/notes.md`);
  expect(renamed.path).toBe(`.beni/tasks/${id}/renamed.md`);
  expect(captured.snapshot).toEqual({'renamed.md': digest('same\r\n')});
  expect(getProjectFileVersion(root, renamed.path!, renamed.id).content).toBe('same\r\n');
  expect(() => getProjectFileVersion(root, renamed.previousPath!, renamed.id)).toThrow('Unknown file version');
  writeFileSync(join(task, 'renamed.md'), 'updated');
  expect(captureProjectTaskHistory(root, id, 'retrospective').events.some(event => event.type === 'document.updated')).toBe(true);
});

test('同一内容の候補が複数ある場合はリネームと推測しない', () => {
  const {root, id, task} = fixture();
  writeFileSync(join(task, 'before.md'), 'same');
  captureProjectTaskHistory(root, id, 'requirements');
  rmSync(join(task, 'before.md'));
  writeFileSync(join(task, 'after-one.md'), 'same');
  writeFileSync(join(task, 'after-two.md'), 'same');
  const events = captureProjectTaskHistory(root, id, 'requirements').events;
  expect(events.map(event => event.type)).toEqual(['document.deleted', 'document.created', 'document.created']);
});

test('文書更新と同時にフェーズが変わっても一度だけ記録する', () => {
  const {root, id, file} = fixture();
  writeFileSync(file, 'first');
  captureProjectTaskHistory(root, id, 'requirements');
  writeFileSync(file, 'second');
  // 実行通知のphaseは実行の文脈であり、タスクのフェーズ移動そのものではない。
  appendProjectEvent(root, {type: 'tool.started', taskId: id, phase: 'documents', operationId: 'phase-test-operation'});
  const events = captureProjectTaskHistory(root, id, 'documents', 'requirements').events;
  expect(events.map(event => event.type)).toEqual(['document.updated', 'phase.changed']);
  expect(events[1]).toMatchObject({from: 'requirements', to: 'documents', sourcePhase: 'requirements'});
  expect(captureProjectTaskHistory(root, id, 'documents').events).toEqual([]);
});

test('固定上限と絞り込み前の走査カーソルで空ページも進める', () => {
  const {root, id} = fixture();
  const other = generateId('task');
  appendProjectEvent(root, {type: 'task.created', taskId: other});
  appendProjectEvent(root, {type: 'task.completed', taskId: other});
  appendProjectEvent(root, {type: 'task.created', taskId: id});
  const first = projectEvents(root, {taskId: id, limit: 1});
  expect(first).toMatchObject({events: [], lastEventId: 1, nextCursor: 1, through: 3, hasMore: true});
  appendProjectEvent(root, {type: 'task.reopened', taskId: id});
  const second = projectEvents(root, {taskId: id, after: first.nextCursor, through: first.through, limit: 1});
  expect(second.events).toEqual([]);
  const last = projectEvents(root, {taskId: id, after: second.nextCursor, through: first.through, limit: 1});
  expect(last.events.map(event => event.id)).toEqual([3]);
  expect(last.hasMore).toBe(false);
  expect(() => projectEvents(root, {after: 5})).toThrow('Unknown event cursor');
  expect(() => projectEvents(root, {after: 2, through: 1})).toThrow('Invalid event cursor');
});

test('モデル用ページは対象外の操作とタスクを飛ばし、最終ページで固定上限まで進める', () => {
  const {root, id} = fixture();
  const other = generateId('task');
  for (let index = 0; index < 101; index++) appendProjectEvent(root, {type: 'tool.started', taskId: id});
  appendProjectEvent(root, {type: 'task.created', taskId: other});
  const created = appendProjectEvent(root, {type: 'task.created', taskId: id});
  appendProjectEvent(root, {type: 'task.completed', taskId: other});
  const completed = appendProjectEvent(root, {type: 'task.completed', taskId: id});
  const tail = appendProjectEvent(root, {type: 'tool.finished', taskId: id});
  const options = {taskId: id, types: ['task.created', 'task.completed'], limit: 1};
  const audit = projectEvents(root, options);
  expect(audit).toMatchObject({events: [], nextCursor: 1, hasMore: true});
  const first = projectEvents(root, {...options, modelPage: true});
  expect(first.events.map(event => event.id)).toEqual([created.id]);
  expect(first).toMatchObject({nextCursor: created.id, through: tail.id, hasMore: true});
  appendProjectEvent(root, {type: 'task.completed', taskId: id});
  const last = projectEvents(root, {...options, modelPage: true, after: first.nextCursor, through: first.through});
  expect(last.events.map(event => event.id)).toEqual([completed.id]);
  expect(last).toMatchObject({nextCursor: tail.id, hasMore: false});
  expect(projectEvents(root, {...options, modelPage: true, after: completed.id, through: first.through})).toMatchObject({
    events: [], nextCursor: tail.id, hasMore: false,
  });
  expect(projectEvents(root, {modelPage: true, types: [], limit: 1}).events.map(event => event.type)).toEqual(['tool.started']);
});

test('10変更ごとにキャッシュし、古い間隔を倍にして間引いても全版を復元できる', () => {
  const {root, id, file, path} = fixture();
  const ids: number[] = [];
  for (let revision = 0; revision <= 160; revision++) {
    writeFileSync(file, `revision ${revision}\r\n`);
    ids.push(captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type.startsWith('document.'))!.id);
  }
  let counts: number[] = [];
  editDatabase(root, db => { counts = (db.query('SELECT c.change_count FROM file_snapshots s JOIN file_changes c ON c.event_id=s.change_id ORDER BY c.change_count').all() as {change_count: number}[]).map(row => row.change_count); });
  expect(counts).toEqual([0, 40, 80, 100, 120, 130, 140, 150, 160]);
  for (const revision of [0, 20, 27, 40, 79, 99, 125, 160]) expect(getProjectFileVersion(root, path, ids[revision]!).content).toBe(`revision ${revision}\r\n`);
});

test('壊れたキャッシュを使わず、差分も壊れていれば履歴破損を報告する', () => {
  const {root, id, file, path} = fixture();
  writeFileSync(file, 'first\n');
  const first = captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  writeFileSync(file, 'next\n');
  const next = captureProjectTaskHistory(root, id, 'requirements').events[0]!;
  editDatabase(root, db => db.query('UPDATE file_snapshots SET content=? WHERE change_id=?').run(Buffer.from('corrupt'), first.id));
  expect(getProjectFileVersion(root, path, next.id).content).toBe('next\n');
  editDatabase(root, db => db.query('UPDATE file_changes SET patch=? WHERE event_id=?').run(Buffer.from('--- a\n+++ b\n@@ -1,1 +1,1 @@\n-wrong\n+next\n'), next.id));
  expect(() => getProjectFileVersion(root, path, next.id)).toThrow('Unified diff content mismatch');
});

test('サイズ超過・不正UTF-8・リンクを拒否し、最後の版を進めない', () => {
  const {root, id, file} = fixture();
  writeFileSync(file, 'saved');
  const first = captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 97));
  expect(() => captureProjectTaskHistory(root, id, 'requirements')).toThrow('exceeds 1 MiB');
  writeFileSync(file, Buffer.from([0xc0, 0xaf]));
  expect(() => captureProjectTaskHistory(root, id, 'requirements')).toThrow('not valid UTF-8');
  expect(projectEvents(root).through).toBe(first.id);
  writeFileSync(file, 'recovered');
  const next = captureProjectTaskHistory(root, id, 'requirements').events[0]!;
  expect(getProjectFileChange(root, next.id).previousChangeId).toBe(first.id);
  const outside = join(root, 'outside.md');
  writeFileSync(outside, 'outside');
  rmSync(file);
  symlinkSync(outside, file);
  expect(() => captureProjectTaskHistory(root, id, 'requirements')).toThrow('Invalid tracked document');
});

test('タスク削除の失敗をロールバックし、削除後も履歴を残して二重削除を防ぐ', () => {
  const {root, id, task, file, path} = fixture();
  writeFileSync(file, 'retained');
  const first = captureProjectTaskHistory(root, id, 'requirements').events.find(event => event.type === 'document.created')!;
  expect(() => projectTaskDeleted(root, id, () => { throw Error('commit failed'); })).toThrow('commit failed');
  expect(projectEvents(root).through).toBe(first.id);
  const deleted = projectTaskDeleted(root, id, () => rmSync(task, {recursive: true}));
  expect(projectTaskDeleted(root, id).id).toBe(deleted.id);
  expect(projectEvents(root).through).toBe(deleted.id);
  expect(getProjectFileVersion(root, path, first.id).content).toBe('retained');
  expect(projectTaskVersion(root, id, digest('retained')).content).toBe('retained');
  expect(() => captureProjectTaskHistory(root, id, 'requirements')).toThrow('Task history is deleted');
  expect(projectEvents(root).events.filter(event => event.type === 'document.deleted')).toEqual([]);
});

test('実行開始・終了は参照と種別で重複を防ぎ、出力・コマンドの保存を拒否する', () => {
  const {root, id} = fixture();
  const input = {type: 'tool.started', taskId: id, phase: 'execution' as const, operationId: 'operation-one', chatId: 'chat-one', sendId: 'send-one', packId: 'pack-one', toolCallId: 'call-one', details: {toolName: 'command', targetPaths: ['src/example.ts']}};
  const first = appendProjectEvent(root, input);
  expect(appendProjectEvent(root, input).id).toBe(first.id);
  const finished = appendProjectEvent(root, {...input, type: 'tool.finished', details: {...input.details, result: 'success', exitCode: 0}});
  expect(finished.id).toBe(first.id + 1);
  expect(projectEvent(root, finished.id).packId).toBe('pack-one');
  expect(() => appendProjectEvent(root, {...input, chatId: 'another-chat'})).toThrow('Conflicting operation event');
  expect(() => appendProjectEvent(root, {...input, operationId: 'other', details: {command: 'example command'} as any})).toThrow('Unsupported event details');
  expect(() => appendProjectEvent(root, {...input, operationId: 'other', details: {output: 'example output'} as any})).toThrow('Unsupported event details');
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

test('イベントDBやsidecarのシンボリックリンク・ハードリンクを拒否する', () => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const {root} = fixture(), outside = join(root, 'outside.sqlite');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, join(root, '.beni', 'project.sqlite' + suffix));
    expect(() => projectEvents(root)).toThrow('Invalid event database file');
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
  }
  const {root} = fixture();
  projectEvents(root);
  linkSync(join(root, '.beni', 'project.sqlite'), join(root, 'linked.sqlite'));
  expect(() => projectEvents(root)).toThrow('Invalid event database file');
});

test('旧イベントDBをWALから復旧して改名し、イベントを維持する', () => {
  const {root} = fixture(), legacy = join(root, '.beni', 'events.sqlite');
  const db = new Database(legacy);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT, phase TEXT, source_phase TEXT,
    operation_id TEXT, chat_id TEXT, send_id TEXT, pack_id TEXT, tool_call_id TEXT, details TEXT NOT NULL, from_phase TEXT, to_phase TEXT);
    PRAGMA journal_mode=WAL;`);
  db.query('INSERT INTO events(type,at,details) VALUES (?,?,?)').run('project.created', '2026-01-01T00:00:00.000Z', '{}');
  db.close();
  expect(projectEvents(root).events.map(event => event.type)).toEqual(['project.created']);
  expect(readFileSync(join(root, '.beni', 'project.sqlite')).byteLength).toBeGreaterThan(0);
  expect(() => readFileSync(legacy)).toThrow();
  const reopened = new Database(join(root, '.beni', 'project.sqlite'));
  expect(reopened.query('PRAGMA journal_mode').get()).toEqual({journal_mode: 'delete'});
  reopened.close();
});

test('新旧イベントDBが両方ある場合はどちらにも触れず拒否する', () => {
  const {root} = fixture();
  writeFileSync(join(root, '.beni', 'events.sqlite'), 'legacy');
  writeFileSync(join(root, '.beni', 'project.sqlite'), 'current');
  expect(() => projectEvents(root)).toThrow('Both project event databases exist');
  expect(readFileSync(join(root, '.beni', 'events.sqlite'), 'utf8')).toBe('legacy');
  expect(readFileSync(join(root, '.beni', 'project.sqlite'), 'utf8')).toBe('current');
});

test('タスク文書だけを保存し、プロジェクト共通知識とソースコードを追跡しない', () => {
  const {root, id, task, file} = fixture();
  writeFileSync(file, 'requirements');
  writeFileSync(join(root, '.beni', 'knowledge.md'), 'knowledge');
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'spec.md'), 'copied spec');
  writeFileSync(join(task, 'source.ts'), 'source');
  expect(captureProjectTaskHistory(root, id, 'requirements').snapshot).toEqual({'requirements.md': digest('requirements')});
});
