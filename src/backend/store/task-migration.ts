import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  renameSync, rmdirSync, unlinkSync, type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { object } from '../../shared/communication';
import { validProjectId, validTaskId } from '../../shared/ids';
import { isTaskPhase } from '../../shared/task-phase';
import { chatScopeKey, type ChatStore } from '../chat-store';
import { metadata, newMetadata, readJson, type TaskMetadata } from '../data';
import { readProjectIdentity, readTrackedDocument, verifyProjectEventHistory, withDatabase } from '../project-events';
import { insertTaskMetadata, readTaskMetadata, validCompletion, validateDocumentBaseline } from './task-table';

const markdown = /^[a-z][a-z0-9-]*\.md$/;
const numeric = /^\d+$/;
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`;
const unchanged = (before: Stats, after: Stats) => identity(before) === identity(after) &&
  before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.nlink === after.nlink;

type JsonSource = {value: TaskMetadata; identity: string; digest: string};
type JsonRecord = {task_id: string; source_identity: string; source_digest: string; task_digest: string; removed: number};
type MarkdownRecord = {source_name: string; source_identity: string; task_id: string; documents_digest: string; restored: number};

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function entries(path: string) {
  const info = stat(path);
  if (!info) return [];
  if (!info.isDirectory()) throw Error('Invalid task migration directory');
  return readdirSync(path).sort();
}

function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readSource(path: string, id?: string): JsonSource {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw Error('Invalid legacy task file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!unchanged(before, fstatSync(fd))) throw Error('Legacy task changed during migration');
    const content = readFileSync(fd);
    let value: TaskMetadata, parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(content));
      value = metadata(path, 'task') as TaskMetadata;
    }
    catch { throw Error('Invalid legacy task metadata'); }
    if (!unchanged(before, fstatSync(fd)) || !unchanged(before, lstatSync(path)) ||
        !isDeepStrictEqual(value, parsed)) throw Error('Legacy task changed during migration');
    if (id !== undefined && value.id !== id || !isTaskPhase(value.phase) || !['idle', 'completed'].includes(value.status) ||
        Object.keys(value).some(key => !['version', 'id', 'name', 'createdAt', 'updatedAt', 'phase', 'status', 'documentBaseline', 'pendingCompletion'].includes(key))) {
      throw Error('Invalid legacy task metadata');
    }
    validateDocumentBaseline(value.documentBaseline);
    if (value.pendingCompletion !== undefined &&
        (value.phase !== 'finalization' || value.status !== 'completed' || !validCompletion(value.pendingCompletion))) {
      throw Error('Invalid pending workflow completion');
    }
    return {value, identity: identity(before), digest: hash(content)};
  } finally { closeSync(fd); }
}

function taskDigest(task: TaskMetadata) {
  return hash(JSON.stringify([task.id, task.name, task.createdAt, task.updatedAt, task.phase, task.status, task.documentBaseline, task.pendingCompletion]));
}

function documentDigest(folder: string) {
  return hash(JSON.stringify(entries(folder).filter(name => markdown.test(name))
    .map(name => [name, hash(readTrackedDocument(join(folder, name)))])));
}

const hasTable = (db: Database, name: string) =>
  !!db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);
const deleted = (db: Database, id: string) =>
  !!db.query("SELECT 1 FROM events WHERE task_id=? AND type='task.deleted'").get(id);

function verifyTaskReferences(db: Database, chats: ChatStore, projectId: string, task: TaskMetadata) {
  const taskId = task.id;
  const cache = new Map<string, NonNullable<ReturnType<ChatStore['read']>>>();
  function readChat(phase: unknown, chatId: string) {
    if (!isTaskPhase(phase)) throw Error('Invalid task chat phase');
    const scope = {projectId, taskId, phase};
    const key = JSON.stringify([phase, chatId]);
    const cached = cache.get(key);
    if (cached) return cached;
    const chat = chats.read(scope, chatId);
    if (!chat) throw Error('Unresolved task chat reference');
    cache.set(key, chat);
    return chat;
  }
  const refs = chats.db.query<{chat_id: string; phase: string; scope_key: string; kind: string; workflow_job_id: string | null}, [string, string]>(
    'SELECT chat_id,phase,scope_key,kind,workflow_job_id FROM chat_refs WHERE project_id=? AND task_id=?');
  for (const ref of refs.all(projectId, taskId)) {
    if (!isTaskPhase(ref.phase) || ref.kind !== 'task' || ref.workflow_job_id !== null ||
        ref.scope_key !== chatScopeKey({projectId, taskId, phase: ref.phase})) throw Error('Invalid task chat owner');
    readChat(ref.phase, ref.chat_id);
  }
  if (task.pendingCompletion?.chatId !== undefined) readChat('finalization', task.pendingCompletion.chatId);

  const events = db.query<{type: string; phase: string; operation_id: string | null; chat_id: string; send_id: string | null; pack_id: string | null}, [string]>(
    'SELECT type,phase,operation_id,chat_id,send_id,pack_id FROM events WHERE task_id=? AND chat_id IS NOT NULL');
  for (const event of events.iterate(taskId)) {
    // 会話を持たない旧完了イベントは、実行IDをチャットID欄にも記録した。
    if (event.type === 'task.completed' && event.chat_id === event.operation_id && event.send_id === null && event.pack_id === null) continue;
    const chat = readChat(event.phase, event.chat_id);
    if (event.send_id !== null && !chat.messages.some(message => message.sendId === event.send_id) ||
        event.pack_id !== null && !chat.packs.some(pack => pack.packId === event.pack_id && (event.send_id === null || pack.sendId === event.send_id))) {
      throw Error('Unresolved task event chat reference');
    }
  }

  if (hasTable(db, 'document_knowledge_completion')) {
    const completions = db.query<{chat_id: string}, [string]>('SELECT DISTINCT chat_id FROM document_knowledge_completion WHERE task_id=?');
    for (const completion of completions.iterate(taskId)) readChat('finalization', completion.chat_id);
  }
  if (!hasTable(db, 'document_versions')) return;
  const versions = db.query<{name: string; items_json: string; content_hash: string}, [string]>(
    'SELECT name,items_json,content_hash FROM document_versions WHERE scope=?');
  for (const version of versions.iterate(taskId)) {
    const items: unknown = JSON.parse(version.items_json);
    if (!markdown.test(version.name) || !Array.isArray(items) ||
        items.some(item => !object(item) || typeof item.id !== 'string' || typeof item.text !== 'string' || !Array.isArray(item.sources)) ||
        hash(items.map(item => item.text).join('')) !== version.content_hash) throw Error('Invalid task document version');
    for (const item of items) {
      for (const source of item.sources) {
        if (!object(source) || typeof source.kind !== 'string' || typeof source.id !== 'string') throw Error('Invalid task document source');
        if (source.kind !== 'message' && source.kind !== 'result') continue;
        const [phase, chatId, itemId, ...rest] = source.id.split('/');
        if (!chatId || !itemId || rest.length) throw Error('Invalid task document chat reference');
        const chat = readChat(phase, chatId);
        if (!(source.kind === 'message' ? chat.messages.some(message => message.id === itemId) : chat.packs.some(pack => pack.packId === itemId))) {
          throw Error('Unresolved task document chat reference');
        }
      }
    }
  }
}

function recordSchema(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_task_json (
    task_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL, source_digest TEXT NOT NULL, task_digest TEXT NOT NULL,
    removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS legacy_task_markdown (
    source_name TEXT PRIMARY KEY, source_identity TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, documents_digest TEXT NOT NULL,
    restored INTEGER NOT NULL DEFAULT 0 CHECK(restored IN (0,1))
  );`);
}

function verifyJsonRecord(db: Database, row: JsonRecord, source?: JsonSource) {
  if (!validTaskId(row.task_id) || deleted(db, row.task_id)) throw Error('Legacy task conflicts with task deletion');
  if (source && (row.removed || source.identity !== row.source_identity || source.digest !== row.source_digest)) {
    throw Error('Legacy task changed during migration');
  }
  const saved = readTaskMetadata(db, row.task_id);
  if (!saved || taskDigest(saved) !== row.task_digest || source && !isDeepStrictEqual(saved, source.value)) {
    throw Error('Conflicting migrated task metadata');
  }
  return saved;
}

function mappedIds(root: string) {
  const file = join(root, 'legacy-history.json');
  if (!stat(file)) return {};
  const history: unknown = readJson(file);
  if (!object(history) || history.version !== 1 || !object(history.taskIdMap) ||
      Object.entries(history.taskIdMap).some(([key, id]) => !numeric.test(key) || !validTaskId(id))) {
    throw Error('Invalid legacy task map');
  }
  return history.taskIdMap as Record<string, string>;
}

function recoveredTask(id: string): TaskMetadata {
  return {version: 1, id, name: 'Unknown', createdAt: null, updatedAt: null, phase: 'requirements', status: 'idle'};
}

export function migrateTaskStorage(databasePath: string, root: string, projectId: string, chats: ChatStore, options: {importJson: boolean}) {
  if (!validProjectId(projectId) || readProjectIdentity(databasePath) !== projectId) throw Error('Invalid task migration project');
  const tasks = join(root, 'tasks');
  return withDatabase(databasePath, db => {
    recordSchema(db);
    const json = db.query<JsonRecord, [string]>('SELECT * FROM legacy_task_json WHERE task_id=?');
    const pendingJson = db.query<JsonRecord, []>('SELECT * FROM legacy_task_json WHERE removed=0 ORDER BY task_id');
    const markdownRecord = db.query<MarkdownRecord, [string]>('SELECT * FROM legacy_task_markdown WHERE source_name=?');
    const pendingMarkdown = db.query<MarkdownRecord, []>('SELECT * FROM legacy_task_markdown WHERE restored=0 ORDER BY source_name');
    const addJson = db.query('INSERT INTO legacy_task_json(task_id,source_identity,source_digest,task_digest) VALUES (?,?,?,?)');
    const staged = new Map<string, JsonSource>();
    const addMarkdown = db.query('INSERT INTO legacy_task_markdown(source_name,source_identity,task_id,documents_digest) VALUES (?,?,?,?)');

    // ファイルに手を加える前に、保存結果と移行元の対応を確定する。
    const migrated = db.transaction(() => {
      const files = new Map<string, string>(), onlyMarkdown: string[] = [];
      for (const name of entries(tasks)) {
        const folder = join(tasks, name);
        if (name.startsWith('.creating-')) {
          const children = entries(folder);
          if (children.includes('task.json')) staged.set(folder, readSource(join(folder, 'task.json')));
          for (const child of children.filter(file => /^task\.json\.tmp-[a-f0-9-]+$/.test(file))) {
            const info = lstatSync(join(folder, child));
            if (!info.isFile() || info.nlink !== 1) throw Error('Invalid task creation journal');
          }
          continue;
        }
        if (!validTaskId(name) && !numeric.test(name)) {
          if (stat(folder)?.isDirectory() && stat(join(folder, 'task.json'))) throw Error('Invalid legacy task directory name');
          continue;
        }
        const names = entries(folder);
        if (names.includes('task.json')) files.set(name, folder);
        else if (names.some(file => markdown.test(file))) onlyMarkdown.push(name);
      }
      const pending = pendingJson.all();
      if (!options.importJson && (files.size || pending.length || staged.size)) {
        throw Error('旧タスクの移行が必要です。Beni を停止し、bun src/backend/migrate-tasks.ts を実行してください。');
      }
      const stagedIds = new Set<string>();
      for (const {value: {id}} of staged.values()) {
        if (stagedIds.has(id) || stat(join(tasks, id)) || readTaskMetadata(db, id) || deleted(db, id)) {
          throw Error('Conflicting task creation journal');
        }
        stagedIds.add(id);
      }
      const planned = pendingMarkdown.all();
      const plannedTargets = new Set(planned.map(row => row.task_id));
      const legacyIds = onlyMarkdown.some(name => numeric.test(name)) ? mappedIds(root) : {};
      const recoveries = onlyMarkdown.filter(name => {
        if (validTaskId(name)) return !plannedTargets.has(name) && !deleted(db, name) && !readTaskMetadata(db, name);
        const previous = legacyIds[name];
        // 過去の整数ID移行で登録されたタスクには、新しいIDを重ねて割り当てない。
        return !markdownRecord.get(name) && (!previous ||
          !deleted(db, previous) && !readTaskMetadata(db, previous) && !stat(join(tasks, previous)));
      });
      if (files.size || pending.length || recoveries.length || planned.length) {
        if (db.query('PRAGMA foreign_key_check').get()) throw Error('Invalid project database references');
        verifyProjectEventHistory(db);
      }
      for (const [name, folder] of files) {
        const source = readSource(join(folder, 'task.json'), name);
        const row = json.get(name);
        if (row) verifyJsonRecord(db, row, source);
        else {
          if (deleted(db, name) || plannedTargets.has(name)) throw Error('Conflicting legacy task owner');
          const saved = readTaskMetadata(db, name);
          if (saved && !isDeepStrictEqual(saved, source.value)) throw Error('Conflicting migrated task metadata');
          if (!saved) insertTaskMetadata(db, source.value);
          addJson.run(name, source.identity, source.digest, taskDigest(source.value));
        }
      }
      for (const row of pendingJson.all()) {
        const task = verifyJsonRecord(db, row);
        documentDigest(join(tasks, task.id));
        verifyTaskReferences(db, chats, projectId, task);
      }
      for (const name of recoveries) {
        const folder = join(tasks, name), documents = documentDigest(folder);
        if (numeric.test(name)) {
          const taskId = newMetadata('task', 'Unknown', true).id;
          if (stat(join(tasks, taskId)) || readTaskMetadata(db, taskId) || deleted(db, taskId)) throw Error('Conflicting recovered task owner');
          verifyTaskReferences(db, chats, projectId, recoveredTask(taskId));
          addMarkdown.run(name, identity(lstatSync(folder)), taskId, documents);
        } else {
          const task = recoveredTask(name);
          verifyTaskReferences(db, chats, projectId, task);
          insertTaskMetadata(db, task);
          if (!isDeepStrictEqual(readTaskMetadata(db, name), task)) throw Error('Conflicting recovered task metadata');
        }
      }
      return files.size + pending.filter(row => !files.has(row.task_id)).length +
        recoveries.filter(validTaskId).length + pendingMarkdown.all().length;
    }).immediate();

    // 数字名のフォルダーを移動した直後に停止しても、同じ発番先から復旧する。
    db.transaction(() => {
      for (const row of pendingMarkdown.all()) {
        if (!numeric.test(row.source_name) || !validTaskId(row.task_id) || deleted(db, row.task_id) || readTaskMetadata(db, row.task_id)) {
          throw Error('Conflicting recovered task owner');
        }
        const source = join(tasks, row.source_name), target = join(tasks, row.task_id);
        const before = stat(source), after = stat(target);
        const folder = before ? source : target;
        const info = before ?? after;
        if (!info?.isDirectory() || before && after || identity(info) !== row.source_identity ||
            documentDigest(folder) !== row.documents_digest || stat(join(folder, 'task.json'))) {
          throw Error('Legacy task folder changed during migration');
        }
        const task = recoveredTask(row.task_id);
        verifyTaskReferences(db, chats, projectId, task);
        if (before) renameSync(source, target);
        syncDirectory(tasks);
        if (identity(lstatSync(target)) !== row.source_identity || documentDigest(target) !== row.documents_digest) {
          throw Error('Legacy task folder changed during migration');
        }
        insertTaskMetadata(db, task);
        if (!isDeepStrictEqual(readTaskMetadata(db, task.id), task)) throw Error('Conflicting recovered task metadata');
        db.query('UPDATE legacy_task_markdown SET restored=1 WHERE source_name=?').run(row.source_name);
      }
    }).immediate();

    const removed = db.transaction(() => {
      const rows = pendingJson.all();
      for (const row of rows) {
        const task = verifyJsonRecord(db, row);
        const folder = join(tasks, task.id), file = join(folder, 'task.json');
        documentDigest(folder);
        verifyTaskReferences(db, chats, projectId, task);
        if (stat(file)) {
          verifyJsonRecord(db, row, readSource(file, task.id));
          unlinkSync(file);
        }
        if (stat(folder)) {
          syncDirectory(folder);
          if (!entries(folder).length) rmdirSync(folder);
        }
        db.query('UPDATE legacy_task_json SET removed=1 WHERE task_id=?').run(task.id);
      }
      // 公開前の作成記録はタスクにせず、検証したJSONだけを除く。
      for (const [folder, source] of staged) {
        const file = join(folder, 'task.json'), current = readSource(file, source.value.id);
        if (current.digest !== source.digest || current.identity !== source.identity || stat(join(tasks, source.value.id))) {
          throw Error('Legacy task creation changed during migration');
        }
        unlinkSync(file);
        syncDirectory(folder);
        if (!entries(folder).length) rmdirSync(folder);
      }
      if (rows.length || staged.size) {
        if (stat(tasks)) {
          syncDirectory(tasks);
          if (!entries(tasks).length) rmdirSync(tasks);
        }
        syncDirectory(root);
      }
      return rows.length + staged.size;
    }).immediate();
    return {migrated, removed};
  });
}
