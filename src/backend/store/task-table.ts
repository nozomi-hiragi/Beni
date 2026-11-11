import type { Database } from 'bun:sqlite';
import { isAgentId } from '../../shared/agent';
import { validChatId } from '../../shared/ids';
import type { TaskCompletion, TaskMetadata } from '../data';

type TaskRecord = Omit<TaskMetadata, 'version' | 'documentBaseline' | 'pendingCompletion'> & {
  documentBaseline: string | null;
  pendingCompletion: string | null;
};
const columns = 'id,name,created_at AS createdAt,updated_at AS updatedAt,phase,status,document_baseline AS documentBaseline,pending_completion AS pendingCompletion';
export function createTaskTable(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS tasks(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, updated_at TEXT,
    phase TEXT NOT NULL, status TEXT NOT NULL, document_baseline TEXT, pending_completion TEXT
  )`);
}

function decodeTask(row: TaskRecord): TaskMetadata {
  const {documentBaseline, pendingCompletion, ...task} = row;
  return {
    ...task, version: 1,
    ...(documentBaseline === null ? {} : {documentBaseline: JSON.parse(documentBaseline)}),
    ...(pendingCompletion === null ? {} : {pendingCompletion: JSON.parse(pendingCompletion)})
  };
}

export function readTaskMetadata(db: Database, id: string) {
  const row = db.query<TaskRecord, [string]>(`SELECT ${columns} FROM tasks WHERE id=?`).get(id);
  return row ? decodeTask(row) : undefined;
}

export function readTaskList(db: Database) {
  return db.query<TaskRecord, []>(`SELECT ${columns} FROM tasks ORDER BY id DESC`).all().map(decodeTask);
}

export function insertTaskMetadata(db: Database, task: TaskMetadata) {
  db.query('INSERT INTO tasks(id,name,created_at,updated_at,phase,status,document_baseline,pending_completion) VALUES (?,?,?,?,?,?,?,?)')
    .run(task.id, task.name, task.createdAt, task.updatedAt, task.phase, task.status,
      JSON.stringify(task.documentBaseline) ?? null, JSON.stringify(task.pendingCompletion) ?? null);
}

export function updateTaskMetadata(db: Database, task: TaskMetadata) {
  db.query('UPDATE tasks SET name=?,updated_at=?,phase=?,status=?,document_baseline=?,pending_completion=? WHERE id=?')
    .run(task.name, task.updatedAt, task.phase, task.status,
      JSON.stringify(task.documentBaseline) ?? null, JSON.stringify(task.pendingCompletion) ?? null, task.id);
}

export function validCompletion(value: unknown): value is TaskCompletion {
  const completion = value as TaskCompletion;
  return (completion?.chatId === undefined || validChatId(completion.chatId)) && typeof completion?.id === 'string' && !!completion.id && completion.id.length <= 512 &&
    typeof completion.revision === 'string' && !!completion.revision && completion.revision.length <= 512 &&
    isAgentId(completion.provider) && (completion.model === null || typeof completion.model === 'string' && completion.model.length <= 512);
}

export function validateDocumentBaseline(value: unknown) {
  const baseline = value as TaskMetadata['documentBaseline'];
  if (baseline !== undefined && (!baseline || typeof baseline !== 'object' || Array.isArray(baseline) ||
      Object.entries(baseline).some(([name, entry]) => !/^[a-z][a-z0-9-]*\.md$/.test(name) || !entry ||
        typeof entry.hash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isFinite(entry.modifiedAt)))) {
    throw Error('Invalid document baseline');
  }
}
