import { createTaskTable } from './store/task-table';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { pathExists } from './data';
import { validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase, type TaskPhase } from '../shared/task-phase';
import { taskCompletedInstructionKey } from './instructions';

export const workflowEventTypes = ['workflow.started', 'workflow.completed', 'workflow.failed'] as const;
export type WorkflowEventType = typeof workflowEventTypes[number];
type WorkflowEventDetails = {workflowJobId: string; eventKey: typeof taskCompletedInstructionKey; triggerEventId: number | null; attemptId: string};
export type ProjectEventDetails = Partial<WorkflowEventDetails> & {
  toolName?: string; targetPaths?: string[]; result?: string; exitCode?: number; name?: string; previousName?: string; revision?: string;
};
export type ProjectEvent = {
  id: number; type: string; at: string; taskId: string | null; phase: TaskPhase | null; sourcePhase: TaskPhase | null;
  operationId: string | null; chatId: string | null; sendId: string | null; packId: string | null; toolCallId: string | null;
  details: ProjectEventDetails; path?: string; previousPath?: string; version?: string; previousVersion?: string; from?: TaskPhase; to?: TaskPhase;
};
export type ProjectEventInput = {
  type: string; taskId?: string | null; phase?: TaskPhase | null; sourcePhase?: TaskPhase | null;
  operationId?: string | null; chatId?: string | null; sendId?: string | null; packId?: string | null; toolCallId?: string | null;
  details?: ProjectEventDetails; from?: TaskPhase; to?: TaskPhase;
};
export type ProjectEventsOptions = {after?: number; through?: number; limit?: number; taskId?: string; types?: string[]; modelPage?: boolean};
type EventRow = {
  id: number; type: string; at: string; task_id: string | null; phase: TaskPhase | null; source_phase: TaskPhase | null;
  operation_id: string | null; chat_id: string | null; send_id: string | null; pack_id: string | null; tool_call_id: string | null;
  details: string; from_phase: TaskPhase | null; to_phase: TaskPhase | null;
};
type ChangeRow = {
  event_id: number; path: string; previous_path: string | null; previous_change_id: number | null; patch: Uint8Array;
  after_hash: string | null; change_count: number;
};
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const documentName = (value: string) => /^[a-z][a-z0-9-]*\.md$/.test(value);
const hash = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const reference = (value: unknown) => value === undefined || value === null || typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const relativePath = (value: string) => value.length > 0 && value.length <= 4096 && !value.includes('\\') && !/[\x00-\x1f]/.test(value) && !posix.isAbsolute(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
function taskPrefix(taskId: string) {
  if (!validTaskId(taskId)) throw Error('Invalid task');
  return `.beni/tasks/${taskId}/`;
}
function checkDatabaseFile(path: string) {
  if (!pathExists(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid event database file');
}
export function legacyProjectDatabasePath(folder: string) {
  if (!lstatSync(folder).isDirectory()) throw Error('Invalid legacy project directory');
  const path = join(folder, 'project.sqlite'), legacy = join(folder, 'events.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) { checkDatabaseFile(path + suffix); checkDatabaseFile(legacy + suffix); }
  if (pathExists(path) && pathExists(legacy)) throw Error('Both project event databases exist');
  if (!pathExists(path) && pathExists(legacy)) {
    if (['-journal', '-wal', '-shm'].some(suffix => pathExists(path + suffix))) throw Error('Project database sidecar already exists');
    const before = lstatSync(legacy), db = new Database(legacy, {create: false, strict: true});
    try {
      const opened = lstatSync(legacy);
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Event database changed while opening');
      db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
      db.query('PRAGMA schema_version').get();
      const checkpoint = db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy: number; log: number; checkpointed: number};
      if (checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) throw Error('Could not checkpoint legacy event database');
      const journal = db.query('PRAGMA journal_mode=DELETE').get() as {journal_mode: string};
      if (journal.journal_mode.toLowerCase() !== 'delete') throw Error('Could not disable legacy event database journal');
    } finally { db.close(); }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      checkDatabaseFile(legacy + suffix);
      if (!pathExists(legacy + suffix)) continue;
      const sidecar = lstatSync(legacy + suffix);
      if ((suffix === '-wal' && sidecar.size === 0) || suffix === '-shm') unlinkSync(legacy + suffix);
      else throw Error(`Legacy event database sidecar remains after recovery: ${suffix}`);
    }
    if (pathExists(path)) throw Error('Both project event databases exist');
    renameSync(legacy, path);
  }
  return path;
}
export function withDatabase<T>(path: string, operation: (db: Database) => T): T {
  if (!lstatSync(dirname(path)).isDirectory()) throw Error('Invalid project database directory');
  for (const suffix of ['', '-journal', '-wal', '-shm']) checkDatabaseFile(path + suffix);
  if (!pathExists(path)) {
    if (['-journal', '-wal', '-shm'].some(suffix => pathExists(path + suffix))) throw Error('Orphaned SQLite sidecar');
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  checkDatabaseFile(path);
  const before = lstatSync(path), db = new Database(path, {create: false, strict: true});
  try {
    const opened = lstatSync(path);
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Event database changed while opening');
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, at TEXT NOT NULL, task_id TEXT, phase TEXT, source_phase TEXT,
        operation_id TEXT, chat_id TEXT, send_id TEXT, pack_id TEXT, tool_call_id TEXT, details TEXT NOT NULL, from_phase TEXT, to_phase TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS event_operation_type ON events(operation_id,type) WHERE operation_id IS NOT NULL AND type IN ('operation.started','operation.finished','execution.started','execution.finished','tool.started','tool.finished');
      CREATE INDEX IF NOT EXISTS event_task ON events(task_id,id);
      CREATE TABLE IF NOT EXISTS managed_document_scopes (scope TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS file_changes (
        event_id INTEGER PRIMARY KEY REFERENCES events(id), path TEXT NOT NULL, previous_path TEXT,
        previous_change_id INTEGER REFERENCES file_changes(event_id), patch BLOB NOT NULL, after_hash TEXT, change_count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS change_path ON file_changes(path,event_id);
      CREATE TABLE IF NOT EXISTS file_snapshots (change_id INTEGER PRIMARY KEY REFERENCES file_changes(event_id), content BLOB NOT NULL);`);
    createTaskTable(db);
    return operation(db);
  } finally { db.close(); }
}
export function projectIdentity(db: Database) {
  if (!db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='project_identity'").get()) return;
  const rows = db.query<{singleton: number; project_id: string}, []>('SELECT singleton,project_id FROM project_identity').all();
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || !validProjectId(rows[0].project_id)) throw Error('Invalid project identity');
  return rows[0].project_id;
}
export function readProjectIdentity(path: string) {
  if (!lstatSync(dirname(path)).isDirectory()) throw Error('Invalid project database directory');
  for (const suffix of ['', '-journal', '-wal', '-shm']) checkDatabaseFile(path + suffix);
  if (!pathExists(path)) return;
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw Error('Invalid event database file');
  const db = new Database(path, {readonly: true, create: false, strict: true});
  try {
    const opened = lstatSync(path);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) throw Error('Project database changed while opening');
    return projectIdentity(db);
  } finally { db.close(); }
}
export function ensureProjectIdentity(path: string, id: string) {
  if (!validProjectId(id)) throw Error('Invalid project ID');
  withDatabase(path, db => db.transaction(() => {
    const previous = projectIdentity(db);
    if (previous === id) return;
    if (previous !== undefined) throw Error('Project ID mismatch');
    db.exec('CREATE TABLE project_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), project_id TEXT NOT NULL)');
    db.query('INSERT INTO project_identity(singleton,project_id) VALUES (1,?)').run(id);
  }).immediate());
}
export function readTrackedDocument(path: string) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw Error('Invalid tracked document');
  if (before.size > MAX_DOCUMENT_BYTES) throw Error('Tracked document exceeds 1 MiB');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) throw Error('Tracked document changed while opening');
    if (opened.size > MAX_DOCUMENT_BYTES) throw Error('Tracked document exceeds 1 MiB');
    const content = readFileSync(fd), after = fstatSync(fd);
    if (content.length > MAX_DOCUMENT_BYTES) throw Error('Tracked document exceeds 1 MiB');
    if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error('Tracked document changed while reading');
    try { new TextDecoder('utf-8', {fatal: true}).decode(content); } catch { throw Error('Tracked document is not valid UTF-8'); }
    return content;
  } finally { closeSync(fd); }
}

// 行のバイト列を保ち、共通の先頭・末尾だけを除いた単一hunkを作る。
// 最小差分は保証しないが、巨大な文書でも二乗時間の探索を行わない。
function lines(content: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === 10) { result.push(content.subarray(start, i + 1)); start = i + 1; }
  if (start < content.length) result.push(content.subarray(start));
  return result;
}
export function unifiedPatch(before: Buffer, after: Buffer, oldPath: string, newPath: string) {
  const old = lines(before), next = lines(after);
  let first = 0, endOld = old.length, endNext = next.length;
  while (first < endOld && first < endNext && old[first]!.equals(next[first]!)) first++;
  while (endOld > first && endNext > first && old[endOld - 1]!.equals(next[endNext - 1]!)) { endOld--; endNext--; }
  const parts: Buffer[] = [Buffer.from(`--- ${oldPath}\n+++ ${newPath}\n`)];
  if (endOld !== first || endNext !== first) {
    const oldCount = endOld - first, nextCount = endNext - first;
    parts.push(Buffer.from(`@@ -${oldCount ? first + 1 : first},${oldCount} +${nextCount ? first + 1 : first},${nextCount} @@\n`));
    const append = (prefix: string, line: Buffer) => {
      parts.push(Buffer.from(prefix), line);
      if (line.at(-1) !== 10) parts.push(Buffer.from('\n\\ No newline at end of file\n'));
    };
    for (let i = first; i < endOld; i++) append('-', old[i]!);
    for (let i = first; i < endNext; i++) append('+', next[i]!);
  }
  return Buffer.concat(parts);
}
function applyPatch(content: Buffer, patch: Uint8Array, reverse = false): Buffer {
  const records = Buffer.from(patch).toString('latin1').split('\n');
  if (records.pop() !== '' || !records[0]?.startsWith('--- ') || !records[1]?.startsWith('+++ ')) throw Error('Invalid unified diff');
  if (records.length === 2) return content;
  const match = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(records[2] ?? '');
  if (!match) throw Error('Invalid unified diff hunk');
  const oldStart = Number(match[reverse ? 3 : 1]), oldCount = Number(match[reverse ? 4 : 2]);
  const newStart = Number(match[reverse ? 1 : 3]), newCount = Number(match[reverse ? 2 : 4]);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) throw Error('Invalid unified diff range');
  const removed: Buffer[] = [], added: Buffer[] = [];
  for (let i = 3; i < records.length; i++) {
    const record = records[i]!;
    if (record[0] !== '-' && record[0] !== '+') throw Error('Invalid unified diff line');
    const noNewline = records[i + 1] === '\\ No newline at end of file';
    const line = Buffer.from(record.slice(1) + (noNewline ? '' : '\n'), 'latin1');
    if (noNewline) i++;
    (record[0] === (reverse ? '+' : '-') ? removed : added).push(line);
  }
  const source = lines(content), offset = oldCount === 0 ? oldStart : oldStart - 1;
  if (removed.length !== oldCount || added.length !== newCount || offset < 0 || offset > source.length || offset + oldCount > source.length || newStart !== (newCount === 0 ? offset : offset + 1)) throw Error('Unified diff range mismatch');
  if (removed.some((line, index) => !line.equals(source[offset + index]!))) throw Error('Unified diff content mismatch');
  return Buffer.concat([...source.slice(0, offset), ...added, ...source.slice(offset + oldCount)]);
}
function checkedDetails(input: ProjectEventInput): ProjectEventDetails {
  const details = input.details ?? {}, keys = Object.keys(details);
  if (workflowEventTypes.some(type => type === input.type)) {
    const {workflowJobId, eventKey, triggerEventId, attemptId} = details;
    if (keys.some(key => !['workflowJobId', 'eventKey', 'triggerEventId', 'attemptId'].includes(key))) throw Error('Unsupported event details');
    if (!validTaskId(input.taskId) || typeof workflowJobId !== 'string' || !reference(workflowJobId) ||
        eventKey !== taskCompletedInstructionKey || triggerEventId !== null && (typeof triggerEventId !== 'number' || !Number.isSafeInteger(triggerEventId) || triggerEventId < 1) ||
        typeof attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)) {
      throw Error('Invalid workflow event details');
    }
    return details;
  }
  const allowed = ['toolName', 'targetPaths', 'result', 'exitCode', ...(input.type.startsWith('task.') ? ['name', 'previousName'] : []), ...(input.type.startsWith('document.') ? ['revision'] : [])];
  if (keys.some(key => !allowed.includes(key))) throw Error('Unsupported event details');
  for (const key of ['toolName', 'result', 'name', 'previousName'] as const) if (details[key] !== undefined && (typeof details[key] !== 'string' || details[key]!.length > 512 || /[\x00-\x1f]/.test(details[key]!))) throw Error('Invalid event details');
  if (details.revision !== undefined && !reference(details.revision)) throw Error('Invalid document revision');
  if (details.result !== undefined && !['completed', 'failed', 'interrupted', 'unknown', 'success', 'cancelled'].includes(details.result)) throw Error('Invalid execution result');
  if (details.exitCode !== undefined && !Number.isSafeInteger(details.exitCode)) throw Error('Invalid exit code');
  if (details.targetPaths !== undefined && (!Array.isArray(details.targetPaths) || details.targetPaths.length > 100 || details.targetPaths.some(path => typeof path !== 'string' || !relativePath(path)))) throw Error('Invalid target paths');
  return details;
}
export function insertEvent(db: Database, input: ProjectEventInput, internalDocument = false): ProjectEvent {
  if ((!/^(?:document|phase|task|operation|execution|tool)\.[a-z]+$/.test(input.type) && !workflowEventTypes.some(type => type === input.type)) ||
      input.type.startsWith('document.') && !internalDocument) throw Error('Invalid event type');
  if (input.taskId !== undefined && input.taskId !== null && !validTaskId(input.taskId)) throw Error('Invalid event task');
  if (input.phase !== undefined && input.phase !== null && !isTaskPhase(input.phase) || input.sourcePhase !== undefined && input.sourcePhase !== null && !isTaskPhase(input.sourcePhase)) throw Error('Invalid event phase');
  for (const key of ['operationId', 'chatId', 'sendId', 'packId', 'toolCallId'] as const) if (!reference(input[key])) throw Error('Invalid event reference');
  if (input.type === 'phase.changed' && (!isTaskPhase(input.from) || !isTaskPhase(input.to) || input.from === input.to)) throw Error('Invalid phase change');
  const details = checkedDetails(input);
  if (input.operationId && (input.type === 'task.completed' || /^(?:operation|execution|tool)\.(?:started|finished)$/.test(input.type))) {
    const existing = db.query('SELECT * FROM events WHERE operation_id=? AND type=?').get(input.operationId, input.type) as EventRow | null;
    if (existing) {
      if (existing.task_id !== (input.taskId ?? null) || existing.chat_id !== (input.chatId ?? null) || existing.send_id !== (input.sendId ?? null) || existing.pack_id !== (input.packId ?? null) || existing.tool_call_id !== (input.toolCallId ?? null) || input.type === 'task.completed' && existing.phase !== (input.phase ?? null)) throw Error('Conflicting operation event');
      return eventValue(db, existing);
    }
  }
  const result = db.query('INSERT INTO events(type,at,task_id,phase,source_phase,operation_id,chat_id,send_id,pack_id,tool_call_id,details,from_phase,to_phase) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    input.type, new Date().toISOString(), input.taskId ?? null, input.phase ?? null, input.sourcePhase ?? null, input.operationId ?? null,
    input.chatId ?? null, input.sendId ?? null, input.packId ?? null, input.toolCallId ?? null, JSON.stringify(details), input.from ?? null, input.to ?? null);
  return eventValue(db, db.query('SELECT * FROM events WHERE id=?').get(Number(result.lastInsertRowid)) as EventRow);
}
function change(db: Database, id: number) { return db.query('SELECT * FROM file_changes WHERE event_id=?').get(id) as ChangeRow | null; }
function eventValue(db: Database, row: EventRow): ProjectEvent {
  const result: ProjectEvent = {id: row.id, type: row.type, at: row.at, taskId: row.task_id, phase: row.phase, sourcePhase: row.source_phase,
    operationId: row.operation_id, chatId: row.chat_id, sendId: row.send_id, packId: row.pack_id, toolCallId: row.tool_call_id, details: JSON.parse(row.details)};
  if (row.from_phase) result.from = row.from_phase;
  if (row.to_phase) result.to = row.to_phase;
  const file = change(db, row.id);
  if (file) {
    result.path = file.path;
    if (file.previous_path) result.previousPath = file.previous_path;
    if (file.after_hash) result.version = file.after_hash;
    if (file.previous_change_id !== null) {
      const previous = change(db, file.previous_change_id);
      if (!previous) throw Error('Broken file history');
      if (previous.after_hash) { result.previousVersion = previous.after_hash; if (row.type === 'document.deleted') result.version = previous.after_hash; }
    }
  }
  return result;
}
function restore(db: Database, target: ChangeRow) {
  const chain: ChangeRow[] = [], seen = new Set<number>();
  let current: ChangeRow | null = target, content: Buffer = Buffer.alloc(0), foundCache = false;
  while (current) {
    if (seen.has(current.event_id) || current.previous_change_id !== null && current.previous_change_id >= current.event_id) throw Error('Broken file history chain');
    seen.add(current.event_id);
    const snapshot = db.query('SELECT content FROM file_snapshots WHERE change_id=?').get(current.event_id) as {content: Uint8Array} | null;
    if (snapshot && current.after_hash && hash(snapshot.content) === current.after_hash) { content = Buffer.from(snapshot.content); foundCache = true; break; }
    chain.push(current);
    if (current.previous_change_id === null) break;
    const previous = change(db, current.previous_change_id);
    if (!previous || previous.path !== (current.previous_path ?? current.path) || previous.after_hash === null) throw Error('Broken file history chain');
    current = previous;
  }
  if (!foundCache && chain.at(-1)?.previous_change_id !== null) throw Error('Missing file history origin');
  for (const file of chain.reverse()) {
    content = applyPatch(content, file.patch);
    if (file.after_hash === null ? content.length !== 0 : hash(content) !== file.after_hash) throw Error('File history hash mismatch');
  }
  return {content: target.after_hash === null ? null : content, hash: target.after_hash, exists: target.after_hash !== null};
}
// 移行時は保存済みの論理パスと差分を読み戻す。ファイルやイベントは更新しない。
export function verifyProjectEventHistory(db: Database) {
  for (const row of db.query('SELECT * FROM events ORDER BY id').iterate() as Iterable<EventRow>) {
    if (row.task_id !== null && !validTaskId(row.task_id)) throw Error('Invalid event task scope');
    const event = eventValue(db, row);
    if (event.path === undefined) continue;
    const matches = (path: string) => row.task_id === null ? path === '.beni/knowledge.md' :
      path.startsWith(taskPrefix(row.task_id)) && documentName(path.slice(taskPrefix(row.task_id).length));
    if (!matches(event.path) || event.previousPath !== undefined && !matches(event.previousPath)) throw Error('Invalid event document scope');
    restore(db, change(db, row.id)!);
  }
}
function latestTaskChanges(db: Database, taskId: string) {
  // リネーム元と削除版を除いた「最後に観測した状態」。実ファイル一覧ではない。
  const rows = db.query('SELECT c.* FROM file_changes c JOIN events e ON e.id=c.event_id WHERE e.task_id=? ORDER BY c.event_id').all(taskId) as ChangeRow[];
  const current = new Map<string, ChangeRow>();
  for (const row of rows) {
    if (row.previous_path) current.delete(row.previous_path);
    if (row.after_hash === null) current.delete(row.path); else current.set(row.path, row);
  }
  return current;
}
function pruneSnapshots(db: Database, current: ChangeRow) {
  let previous: ChangeRow | null = current;
  while (previous) {
    const distance = current.change_count - previous.change_count;
    let interval = 10, bound = 40;
    while (distance > bound) { interval *= 2; bound *= 2; }
    if (previous.change_count !== 0 && previous.change_count % interval !== 0) db.query('DELETE FROM file_snapshots WHERE change_id=?').run(previous.event_id);
    previous = previous.previous_change_id === null ? null : change(db, previous.previous_change_id);
  }
}
function recordFile(db: Database, input: Omit<ProjectEventInput, 'type'>, type: string, path: string, before: ChangeRow | null, content: Buffer | null, previousPath?: string) {
  const previousContent = before ? restore(db, before).content : null;
  if (before && previousContent === null) throw Error('Cannot continue a deleted file history');
  const old = previousContent ?? Buffer.alloc(0), next = content ?? Buffer.alloc(0);
  const patch = unifiedPatch(old, next, before ? previousPath ?? path : '/dev/null', content === null ? '/dev/null' : path);
  if (!applyPatch(old, patch).equals(next) || !applyPatch(next, patch, true).equals(old)) throw Error('File diff round trip failed');
  const event = insertEvent(db, {...input, type}, true);
  const count = before ? before.change_count + (type === 'document.updated' ? 1 : 0) : 0;
  const afterHash = content === null ? null : hash(content);
  db.query('INSERT INTO file_changes(event_id,path,previous_path,previous_change_id,patch,after_hash,change_count) VALUES (?,?,?,?,?,?,?)').run(event.id, path, previousPath ?? null, before?.event_id ?? null, patch, afterHash, count);
  const recorded = change(db, event.id)!;
  // キャッシュは補助データなので、失敗しても初版・差分の確定を妨げない。
  try {
    db.transaction(() => {
      if (content !== null && (before === null || type === 'document.updated' && count % 10 === 0)) db.query('INSERT INTO file_snapshots(change_id,content) VALUES (?,?)').run(event.id, content);
      pruneSnapshots(db, recorded);
    })();
  } catch { /* 次回の復元は初版と差分へフォールバックする。 */ }
  return eventValue(db, db.query('SELECT * FROM events WHERE id=?').get(event.id) as EventRow);
}

export function recordManagedDocumentHistory(db: Database, taskId: string | null, phase: TaskPhase | null, document: {name: string; content: string; revision: string}, migration = false) {
  if (!documentName(document.name)) throw Error('Invalid document name');
  const path = (taskId === null ? '.beni/' : taskPrefix(taskId)) + document.name;
  const latest = db.query('SELECT * FROM file_changes WHERE path=? OR previous_path=? ORDER BY event_id DESC LIMIT 1').get(path, path) as ChangeRow | null;
  const before = latest?.path === path && latest.after_hash ? latest : null;
  const content = Buffer.from(document.content);
  if (migration && before?.after_hash === hash(content)) return;
  return recordFile(db, {taskId, phase, details: {revision: document.revision}}, before ? 'document.updated' : 'document.created', path, before, content);
}

function recordTaskPhase(db: Database, input: {taskId: string; phase: TaskPhase; sourcePhase?: TaskPhase | null; operationId?: string}, taskEvent?: 'task.completed' | 'task.reopened') {
  const events: ProjectEvent[] = [];
  const last = db.query("SELECT COALESCE(to_phase,phase) AS phase FROM events WHERE task_id=? AND type IN ('task.created','phase.changed') AND COALESCE(to_phase,phase) IS NOT NULL ORDER BY id DESC LIMIT 1").get(input.taskId) as {phase: TaskPhase} | null;
  if (!last) events.push(insertEvent(db, {...input, type: 'task.created'}));
  else if (last.phase !== input.phase) events.push(insertEvent(db, {...input, type: 'phase.changed', from: last.phase, to: input.phase}));
  if (taskEvent) events.push(insertEvent(db, {...input, type: taskEvent}));
  return events;
}

export function captureManagedTaskHistory(db: Database, taskId: string, phase: string, sourcePhase?: TaskPhase | null, operationId?: string, taskEvent?: 'task.completed' | 'task.reopened') {
  if (!isTaskPhase(phase)) throw Error('Invalid history phase');
  if (db.query("SELECT id FROM events WHERE type='task.deleted' AND task_id=? LIMIT 1").get(taskId)) throw Error('Task history is deleted');
  const events = recordTaskPhase(db, {taskId, phase, sourcePhase, operationId}, taskEvent);
  const prefix = taskPrefix(taskId);
  const snapshot = Object.fromEntries([...latestTaskChanges(db, taskId)].map(([path, row]) => [path.slice(prefix.length), row.after_hash!]));
  return {phase, snapshot, events};
}

export function appendProjectEvent(databasePath: string, input: ProjectEventInput) {
  return withDatabase(databasePath, db => db.transaction(() => insertEvent(db, input)).immediate());
}
export function captureProjectTaskHistory(path: string, folder: string, taskId: string, phase: string, sourcePhase: TaskPhase | null = null, operationId?: string, taskEvent?: 'task.completed' | 'task.reopened') {
  return withDatabase(path, db => db.transaction(() =>
    captureTaskHistory(db, folder, taskId, phase, sourcePhase, operationId, taskEvent)).immediate());
}
export function captureTaskHistory(db: Database, folder: string, taskId: string, phase: string, sourcePhase: TaskPhase | null = null, operationId?: string, taskEvent?: 'task.completed' | 'task.reopened') {
  if (!isTaskPhase(phase) || sourcePhase !== null && !isTaskPhase(sourcePhase)) throw Error('Invalid history phase');
  const prefix = taskPrefix(taskId);
  if (db.query('SELECT 1 FROM managed_document_scopes WHERE scope=?').get(taskId)) return captureManagedTaskHistory(db, taskId, phase, sourcePhase, operationId, taskEvent);
  if (db.query("SELECT id FROM events WHERE type='task.deleted' AND task_id=? LIMIT 1").get(taskId)) throw Error('Task history is deleted');
  const tasks = join(folder, 'tasks'), task = join(tasks, taskId);
  if (pathExists(folder) && !lstatSync(folder).isDirectory()) throw Error('Invalid legacy project directory');
  for (const path of [tasks, task]) {
    if (!pathExists(path)) return captureManagedTaskHistory(db, taskId, phase, sourcePhase, operationId, taskEvent);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid tracked task directory');
  }
  const previous = latestTaskChanges(db, taskId), current = new Map<string, Buffer>();
  const known = new Set((db.query('SELECT c.path FROM file_changes c JOIN events e ON e.id=c.event_id WHERE e.task_id=?').all(taskId) as {path: string}[]).map(row => row.path));
  const allowNew = ['requirements', 'documents', 'implementation'].includes(phase);
  const eligible = new Set<string>(), candidates: string[] = [];
  for (const name of readdirSync(task).filter(documentName).sort()) {
    const path = prefix + name;
    if (!allowNew && !known.has(path) && !['requirements.md', 'documents.md', 'implementation.md', 'retrospective.md'].includes(name)) { candidates.push(name); continue; }
    eligible.add(path);
    current.set(path, readTrackedDocument(join(task, name)));
  }
  const missingHashes = new Set([...previous].filter(([path]) => !current.has(path)).map(([, row]) => row.after_hash));
  // 後のフェーズで新規資料を追跡し始めず、既追跡文書のリネームだけを継続する。
  if (missingHashes.size) for (const name of candidates) {
    let content: Buffer;
    try { content = readTrackedDocument(join(task, name)); } catch { continue; }
    if (missingHashes.has(hash(content))) current.set(prefix + name, content);
  }
  const events: ProjectEvent[] = [], input = {taskId, phase, sourcePhase, operationId};
  if (!db.query("SELECT id FROM events WHERE task_id=? AND type='task.created' LIMIT 1").get(taskId)) events.push(insertEvent(db, {...input, type: 'task.created'}));
  const lastPhase = db.query("SELECT COALESCE(to_phase,phase) AS phase FROM events WHERE task_id=? AND type IN ('task.created','phase.changed') AND COALESCE(to_phase,phase) IS NOT NULL ORDER BY id DESC LIMIT 1").get(taskId) as {phase: TaskPhase} | null;
  const removed = [...previous].filter(([path]) => !current.has(path));
  const added = [...current].filter(([path]) => !previous.has(path));
  const renamed = new Set<string>();
  for (const [path, before] of removed) {
    const candidates = added.filter(([, content]) => hash(content) === before.after_hash);
    if (candidates.length === 1 && removed.filter(([, row]) => row.after_hash === before.after_hash).length === 1) {
      const [nextPath, content] = candidates[0]!;
      events.push(recordFile(db, input, 'document.renamed', nextPath, before, content, path));
      renamed.add(nextPath);
    } else events.push(recordFile(db, input, 'document.deleted', path, before, null));
  }
  for (const [path, content] of added) if (!renamed.has(path)) {
    if (eligible.has(path)) events.push(recordFile(db, input, 'document.created', path, null, content)); else current.delete(path);
  }
  for (const [path, content] of current) {
    const before = previous.get(path);
    if (before && before.after_hash !== hash(content)) events.push(recordFile(db, input, 'document.updated', path, before, content));
  }
  if (lastPhase && lastPhase.phase !== phase) events.push(insertEvent(db, {...input, type: 'phase.changed', from: lastPhase.phase, to: phase}));
  if (taskEvent) events.push(insertEvent(db, {...input, type: taskEvent}));
  return {phase, snapshot: Object.fromEntries([...current].map(([path, content]) => [path.slice(prefix.length), hash(content)])), events};
}
export function projectEvents(databasePath: string, options: ProjectEventsOptions = {}) {
  const {after = 0, through, limit = 100, taskId, types, modelPage} = options;
  if (!Number.isSafeInteger(after) || after < 0 || through !== undefined && (!Number.isSafeInteger(through) || through < after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Invalid event cursor');
  if (taskId !== undefined) taskPrefix(taskId);
  if (types !== undefined && (!Array.isArray(types) || types.length > 100 || types.some(type => typeof type !== 'string' || !/^[a-z]+\.[a-z]+$/.test(type)))) throw Error('Invalid event types');
  return withDatabase(databasePath, db => {
    const tail = (db.query('SELECT COALESCE(MAX(id),0) AS id FROM events').get() as {id: number}).id;
    if (after > tail || through !== undefined && through > tail) throw Error('Unknown event cursor');
    const upper = through ?? tail;
    if (modelPage) {
      const conditions = ['id>?', 'id<=?'];
      const values: (number | string)[] = [after, upper];
      if (taskId !== undefined) {
        conditions.push('task_id=?');
        values.push(taskId);
      }
      if (types?.length) {
        conditions.push(`type IN (${types.map(() => '?').join(',')})`);
        values.push(...types);
      }
      const rows = db.query(`SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`).all(...values, limit + 1) as EventRow[];
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const nextCursor = hasMore ? rows[limit - 1]!.id : upper;
      return {events: rows.map(row => eventValue(db, row)), lastEventId: nextCursor, nextCursor, through: upper, hasMore};
    }
    // 返した最後のIDではなく、絞り込み前に走査した範囲をカーソルにする。
    const rows = db.query('SELECT * FROM events WHERE id>? AND id<=? ORDER BY id LIMIT ?').all(after, upper, limit) as EventRow[];
    const nextCursor = rows.at(-1)?.id ?? upper;
    const events = rows.filter(row => (taskId === undefined || row.task_id === taskId) && (types === undefined || types.includes(row.type))).map(row => eventValue(db, row));
    return {events, lastEventId: nextCursor, nextCursor, through: upper, hasMore: nextCursor < upper};
  });
}
export function projectEvent(databasePath: string, eventId: number) {
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw Error('Invalid event ID');
  return withDatabase(databasePath, db => {
    const row = db.query('SELECT * FROM events WHERE id=?').get(eventId) as EventRow | null;
    if (!row) throw Error('Unknown project event');
    return eventValue(db, row);
  });
}
export function getProjectFileChange(databasePath: string, eventId: number) {
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw Error('Invalid change ID');
  return withDatabase(databasePath, db => {
    const row = change(db, eventId);
    if (!row) throw Error('Unknown file change');
    return {eventId: row.event_id, path: row.path, previousPath: row.previous_path, previousChangeId: row.previous_change_id, patch: Buffer.from(row.patch).toString('utf8'), afterHash: row.after_hash};
  });
}
export function getProjectFileVersion(databasePath: string, path: string, changeId: number) {
  if (typeof path !== 'string' || !relativePath(path) || !Number.isSafeInteger(changeId) || changeId < 1) throw Error('Invalid file version');
  return withDatabase(databasePath, db => {
    const row = change(db, changeId);
    if (!row || row.path !== path) throw Error('Unknown file version');
    const version = restore(db, row);
    return {path, changeId, ...version, content: version.content?.toString('utf8') ?? null};
  });
}
export function projectTaskVersion(databasePath: string, taskId: string, version: string) {
  taskPrefix(taskId);
  if (!validHash(version)) throw Error('Invalid history version');
  return withDatabase(databasePath, db => {
    const row = db.query('SELECT c.* FROM file_changes c JOIN events e ON e.id=c.event_id WHERE e.task_id=? AND c.after_hash=? ORDER BY c.event_id DESC LIMIT 1').get(taskId, version) as ChangeRow | null;
    if (!row) throw Error('Unknown history version');
    return {version, content: restore(db, row).content!.toString('utf8')};
  });
}
export function recordTaskDeleted(db: Database, taskId: string) {
  taskPrefix(taskId);
  const previous = db.query("SELECT * FROM events WHERE type='task.deleted' AND task_id=? ORDER BY id LIMIT 1").get(taskId) as EventRow | null;
  return previous ? eventValue(db, previous) : insertEvent(db, {type: 'task.deleted', taskId});
}

export function projectTaskDeleted(databasePath: string, taskId: string, commit?: () => void) {
  return withDatabase(databasePath, db => db.transaction(() => {
    const event = recordTaskDeleted(db, taskId);
    commit?.();
    return event;
  }).immediate());
}
