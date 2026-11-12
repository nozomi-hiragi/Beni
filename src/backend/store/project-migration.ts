import { rejectSuperJournal } from './flat-project-migration';
import { readTaskMetadata } from './task-table';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validPack } from '../../shared/communication';
import { validTaskId } from '../../shared/ids';
import { isTaskPhase } from '../../shared/task-phase';
import { chatFileStem, chatFileSuffix, chatIdPattern, migrateWorkflowChats, relocateProjectChats, validWorkflowJobFileStem, workflowJobHash, workflowJobNamePattern, type JobChatTarget } from '../chat-files';
import { decodeChatHistory } from '../chat-history';
import { taskCompletedInstructionKey } from '../instructions';
import { metadata, pathExists, readJson } from '../data';
import { legacyProjectDatabasePath, readProjectIdentity, readTrackedDocument, verifyProjectEventHistory, withDatabase } from '../project-events';

const archiveName = (name: string) => chatIdPattern.test(chatFileStem(name));
const databaseName = /^(?:project|events)\.sqlite(?:-wal|-shm|-journal)?$/;
const markdownName = /^[a-z][a-z0-9-]*\.md$/;
const taskName = (name: string) => validTaskId(name) || /^\d+$/.test(name);
const journalName = (name: string) => name.startsWith('.deleting-') && validTaskId(name.slice(10));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Entry = {path: string; type: 'directory' | 'file'; identity: string; digest?: string; known: boolean};

function taskChatType(parts: string[]): Entry['type'] | undefined {
  const [first, second] = parts;
  if (parts.length === 1 && (first === 'history' || first === 'workflow-jobs')) return 'directory';
  if (parts.length === 1 && isTaskPhase(chatFileStem(first!))) return 'file';
  if (parts.length === 2 && first === 'history' && archiveName(second!)) return 'file';
  if (parts.length === 2 && first === 'workflow-jobs' && workflowJobNamePattern.test(chatFileStem(second!))) return 'file';
}

function projectChatType(parts: string[], allowWorkflows = true): Entry['type'] | undefined {
  const [first, second, third] = parts;
  if (!first) return;
  if (parts.length === 1 && chatFileStem(first) === 'general') return 'file';
  if (first === 'history' || first === 'workflow-jobs') {
    if (parts.length === 1) return 'directory';
    const pattern = first === 'history' ? chatIdPattern : workflowJobNamePattern;
    if (parts.length === 2 && pattern.test(chatFileStem(second!))) return 'file';
  }
  if (allowWorkflows && first === 'workflows') {
    if (parts.length === 1 || parts.length === 2 && second === taskCompletedInstructionKey) return 'directory';
    if (parts.length === 3 && second === taskCompletedInstructionKey) {
      const stem = chatFileStem(third!);
      if (workflowJobNamePattern.test(stem) || third!.endsWith(chatFileSuffix) && validWorkflowJobFileStem(stem)) return 'file';
    }
  }
}

function managedType(path: string): Entry['type'] | undefined {
  const [root, ...parts] = path.split('/') as [string, ...string[]];
  if (root === '') return 'directory';
  const projectChat = projectChatType([root, ...parts]);
  if (projectChat) return projectChat;
  if (!parts.length) {
    if (root === 'tasks' || root === 'chat' || journalName(root)) return 'directory';
    if (root === 'project.json' || root === 'knowledge.md' || root === 'legacy-history.json' || databaseName.test(root)) return 'file';
    return;
  }
  const [first, ...rest] = parts as [string, ...string[]];
  if (root === 'tasks' && taskName(first)) {
    if (!rest.length) return 'directory';
    if (rest.length === 1 && (rest[0] === 'task.json' || markdownName.test(rest[0]!))) return 'file';
    if (validTaskId(first)) return taskChatType(rest);
  }
  if (root === 'chat') {
    if (!rest.length && first.endsWith('.json') && validTaskId(first.slice(0, -5))) return 'file';
    if (validTaskId(first)) return rest.length ? taskChatType(rest) : 'directory';
    return projectChatType(parts, false);
  }
  if (journalName(root)) {
    if (!rest.length && ['journal.json', 'committed.json', 'chat.json'].includes(first)) return 'file';
    if (first === 'task') return managedType(['tasks', root.slice(10), ...rest].join('/'));
    if (first === 'chat') return managedType(['chat', root.slice(10), ...rest].join('/'));
  }
  return;
}

function fileDigest(path: string, stat: import('node:fs').Stats) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Error('Migration source changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    for (let size; (size = readSync(fd, buffer, 0, buffer.length, null));) digest.update(buffer.subarray(0, size));
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('Migration source changed');
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

function inventory(root: string) {
  const entries: Entry[] = [];
  function visit(path: string) {
    const absolute = join(root, path), stat = lstatSync(absolute);
    const type = stat.isDirectory() ? 'directory' : 'file', expected = managedType(path);
    if (stat.isSymbolicLink() || type === 'file' && (!stat.isFile() || stat.nlink !== 1) || expected && expected !== type) throw Error('Invalid migration file');
    const identity = `${stat.dev}:${stat.ino}${type === 'file' ? `:${stat.mtimeMs}:${stat.ctimeMs}` : ''}`;
    entries.push({path, type, identity, ...(type === 'file' ? {digest: fileDigest(absolute, stat)} : {}), known: !!expected});
    if (type === 'directory') for (const name of readdirSync(absolute).sort()) visit(path ? `${path}/${name}` : name);
  }
  visit('');
  return entries;
}

function copyInventory(source: string, target: string, entries: Entry[]) {
  for (const entry of entries.slice(1)) {
    // 管理外のファイルも退避する。通常のタスクや会話の探索からは分離する。
    const destination = join(target, entry.known ? entry.path : join('.migration-extras', entry.path));
    if (entry.type === 'directory') {
      mkdirSync(destination, {recursive: true, mode: 0o700});
    } else {
      const original = join(source, entry.path);
      const stat = lstatSync(original);
      mkdirSync(dirname(destination), {recursive: true, mode: 0o700});
      copyFileSync(original, destination, constants.COPYFILE_EXCL);
      if (fileDigest(destination, lstatSync(destination)) !== entry.digest) throw Error('Migration copy differs');
      utimesSync(destination, stat.atime, stat.mtimeMs / 1000);
    }
  }
}

function validateChat(file: string, projectId: string, taskId: string | null, phase: string | null | undefined, jobStem?: string, allowDirectJobId = false) {
  const raw = readJson(file);
  const chat = decodeChatHistory(raw);
  const jobId = chat.workflowJobId;
  const validJob = jobStem === undefined ? jobId === undefined :
    !!jobId && (allowDirectJobId && jobId === jobStem || workflowJobHash(jobId) === jobStem);
  if (chat.projectId !== projectId || chat.taskId !== taskId || phase !== undefined && chat.phase !== phase ||
      !validJob ||
      chat.packs.some((pack, index) => !validPack(pack) || pack.sequence !== index + 1) ||
      new Set(chat.packs.map(pack => pack.packId)).size !== chat.packs.length) throw Error('Invalid migrated conversation scope');
  return chat;
}

function validateTaskChat(file: string, projectId: string, taskId: string, name?: string, archivedName?: string) {
  if (name === 'history') {
    const chat = validateChat(file, projectId, taskId, undefined);
    if (!isTaskPhase(chat.phase) || chat.id !== chatFileStem(archivedName!)) throw Error('Invalid archive scope');
  } else if (name === 'workflow-jobs') {
    validateChat(file, projectId, null, null, chatFileStem(archivedName!));
  } else validateChat(file, projectId, taskId, name === undefined ? undefined : chatFileStem(name));
}

function validateProjectChat(file: string, projectId: string, [name, entry, workflowEntry]: string[]) {
  const jobStem = name === 'workflow-jobs' ? chatFileStem(entry!) : name === 'workflows' ? chatFileStem(workflowEntry!) : undefined;
  const chat = validateChat(file, projectId, null, null, jobStem, name === 'workflows' && workflowEntry!.endsWith(chatFileSuffix));
  if (name === 'history' && chat.id !== chatFileStem(entry!)) throw Error('Invalid archive ID');
}

function verifyDatabase(db: Database) {
  const results = db.query('PRAGMA integrity_check').all() as {integrity_check: string}[];
  if (results.length !== 1 || results[0]?.integrity_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) throw Error('Invalid project database');
  for (const table of ['document_review','document_review_items','document_send_inputs','document_execution_completion','document_knowledge_completion']) {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    for (const row of db.query(`SELECT DISTINCT task_id FROM ${table} WHERE task_id IS NOT NULL`).all() as {task_id: string}[]) {
      if (!validTaskId(row.task_id)) throw Error('Invalid database task scope');
    }
  }
}

function prepareDatabase(target: string) {
  const current = join(target, 'project.sqlite'), legacy = join(target, 'events.sqlite');
  if (pathExists(current) && pathExists(legacy)) throw Error('Both project event databases exist');
  for (const path of [current, legacy]) {
    if (!pathExists(path)) {
      if (['-wal','-shm','-journal'].some(suffix => pathExists(path + suffix))) throw Error('Orphaned SQLite sidecar');
      continue;
    }
    // WAL・ロールバックジャーナルを含む複製側をSQLiteで読み、確定済みの状態に揃える。
    // SHMはWALの索引なので、複製側で再構築する。
    rejectSuperJournal(path + '-journal');
    if (pathExists(path + '-shm')) unlinkSync(path + '-shm');
    const db = new Database(path, {readwrite: true, create: false});
    try {
      verifyDatabase(db);
      const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy: number; log: number; checkpointed: number};
      if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) throw Error('Could not checkpoint migrated project database');
      const mode = db.query('PRAGMA journal_mode=DELETE').get() as {journal_mode: string};
      if (mode.journal_mode !== 'delete') throw Error('Could not close migrated database journal');
    } finally { db.close(); }
  }
  withDatabase(legacyProjectDatabasePath(target), db => {
    verifyDatabase(db);
    verifyProjectEventHistory(db);
    for (const table of ['managed_document_scopes','document_versions','document_heads']) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const {scope} of db.query(`SELECT DISTINCT scope FROM ${table}`).iterate() as Iterable<{scope: string}>) {
        if (scope !== 'knowledge' && !validTaskId(scope)) throw Error('Invalid managed document scope');
      }
    }
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_versions'").get()) {
      for (const row of db.query('SELECT name,items_json,content_hash FROM document_versions').iterate() as Iterable<{name: string; items_json: string; content_hash: string}>) {
        const items = JSON.parse(row.items_json);
        if (!markdownName.test(row.name) || !Array.isArray(items) ||
            items.some(item => typeof item?.id !== 'string' || typeof item?.text !== 'string' || !Array.isArray(item.sources)) ||
            hash(items.map(item => item.text).join('')) !== row.content_hash) throw Error('Invalid managed document version');
      }
    }
  });
}

function validateCopy(target: string, projectId: string, entries: Entry[]) {
  if (metadata(join(target, 'project.json'), 'project').id !== projectId) throw Error('Project ID mismatch');
  const tasks = new Set(entries.filter(entry => entry.type === 'directory' && /^tasks\/[^/]+$/.test(entry.path) && entry.known).map(entry => entry.path.slice(6)));
  prepareDatabase(target);
  withDatabase(legacyProjectDatabasePath(target), db => {
    for (const {id} of db.query<{id: string}, []>('SELECT id FROM tasks').iterate()) {
      if (!validTaskId(id)) throw Error('Invalid database task scope');
      tasks.add(id);
    }
  });
  const deleted = new Set(entries.filter(entry => entry.type === 'directory' && !entry.path.includes('/') && journalName(entry.path)).map(entry => entry.path.slice(10)));
  for (const {path, type, known} of entries) {
    if (!known || type !== 'file') continue;
    const file = join(target, path);
    const parts = path.split('/');
    const [root, first, second, third] = parts;
    const projectChatParts = root === 'chat' ? parts.slice(1) : parts;
    if (path.endsWith('.md')) readTrackedDocument(file);
    else if (path === 'legacy-history.json') {
      const history = readJson(file);
      if (history?.version !== 1 || !history.taskIdMap || Object.values(history.taskIdMap).some(id => !validTaskId(id))) {
        throw Error('Invalid legacy history');
      }
    }
    else if (root === 'tasks' && second === 'task.json' || root && journalName(root) && first === 'task' && second === 'task.json') {
      const data = metadata(file, 'task');
      if (data.id !== (root === 'tasks' ? first : root.slice(10))) throw Error('Task directory ID mismatch');
    } else if (root === 'tasks') {
      validateTaskChat(file, projectId, first!, second, third);
    } else if (projectChatType(projectChatParts, root !== 'chat') === 'file') {
      validateProjectChat(file, projectId, projectChatParts);
    } else if (root === 'chat') {
      const taskId = first!.replace(/\.json$/, '');
      if (!tasks.has(taskId) && !deleted.has(taskId)) throw Error('Invalid chat task scope');
      validateTaskChat(file, projectId, taskId, second, third);
    } else if (root && journalName(root)) {
      const taskId = root.slice(10);
      if (first === 'committed.json' || first === 'journal.json') {
        const journal = readJson(file);
        if (journal.version !== 1 || journal.taskId !== taskId || journal.projectId !== projectId) throw Error('Invalid deletion journal');
      } else if (first === 'chat.json') validateChat(file, projectId, taskId, undefined);
      else if (first === 'chat' || first === 'task') validateTaskChat(file, projectId, taskId, second, third);
    }
  }
  withDatabase(legacyProjectDatabasePath(target), db => {
    for (const taskId of tasks) {
      const folder = join(target, 'tasks', taskId);
      const files = pathExists(folder) ? readdirSync(folder) : [];
      if (validTaskId(taskId) && !files.includes('task.json') && !files.some(name => markdownName.test(name)) && !readTaskMetadata(db, taskId)) {
        throw Error('Missing task metadata');
      }
    }
  });
  const identity = readProjectIdentity(legacyProjectDatabasePath(target));
  if (identity !== undefined && identity !== projectId) throw Error('Project ID mismatch');
}

export function stageProjectMigration(source: string, target: string, projectId: string, jobTarget?: JobChatTarget) {
  const before = inventory(source);
  copyInventory(source, target, before);
  validateCopy(target, projectId, before);
  relocateProjectChats(target);
  if (jobTarget) migrateWorkflowChats(target, projectId, jobTarget);
  if (JSON.stringify(inventory(source)) !== JSON.stringify(before)) throw Error('Migration source changed');
  return {sourceInventory: JSON.stringify(before), verification: migrationVerification(target)};
}

export function migrationVerification(path: string) {
  return hash(JSON.stringify(inventory(path).map(({path, type, digest}) => ({path, type, digest}))));
}

export function verifyMigrationSource(source: string, savedInventory: string) {
  if (!pathExists(source)) return false;
  const previous = JSON.parse(savedInventory) as Entry[], current = inventory(source);
  return previous.length === current.length && current.every((entry, index) => sameInventoryEntry(entry, previous[index]));
}

function sameInventoryEntry(entry: Entry, previous?: Entry) {
  return previous && entry.path === previous.path && entry.type === previous.type && entry.identity === previous.identity && entry.digest === previous.digest;
}

export function cleanMigratedSource(source: string, savedInventory: string) {
  if (!pathExists(source)) return true;
  const previous = new Map((JSON.parse(savedInventory) as Entry[]).map(entry => [entry.path, entry]));
  const current = inventory(source);
  if (current.some(entry => !sameInventoryEntry(entry, previous.get(entry.path)))) return false;
  const present = new Set(current.map(entry => entry.path));
  if ([...previous.values()].some(entry => !entry.known && !present.has(entry.path))) return false;
  for (const entry of current.reverse()) {
    if (!previous.get(entry.path)?.known) continue;
    const path = join(source, entry.path);
    if (entry.type === 'file') {
      const stat = lstatSync(path);
      if (`${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}` !== entry.identity || fileDigest(path, stat) !== entry.digest) return false;
      unlinkSync(path);
    } else if (!readdirSync(path).length) rmdirSync(path);
  }
  return true;
}
