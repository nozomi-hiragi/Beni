import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateId, validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase } from '../shared/task-phase';
export type Metadata = {
  version: 1;
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
};
export type TaskMetadata = Metadata & {
  documentBaseline?: Record<string, {hash: string; modifiedAt: number}>;
  phase: string;
  status: string;
};
export function pathExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function directory(path: string) {
  if (!pathExists(path)) mkdirSync(path, {
    mode: 0o700
  });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid managed directory');
  return path;
}
export function projectRoot(folder: string) {
  const root = resolve(folder);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid project directory');
  return directory(join(root, '.beni'));
}
export function readJson(path: string): any {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid metadata file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writeJson(path: string, value: unknown) {
  if (pathExists(path)) readJson(path);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, {
      force: true
    });
  }
}
function validDate(value: unknown) {
  return value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function metadata(path: string, kind: 'project' | 'task'): Metadata | TaskMetadata {
  const value = readJson(path);
  if (value.version !== 1) throw Error('Unsupported metadata version');
  if (!(kind === 'project' ? validProjectId(value.id) : validTaskId(value.id)) || typeof value.name !== 'string' || !value.name.trim() || !validDate(value.createdAt) || !validDate(value.updatedAt) || kind === 'task' && (typeof value.phase !== 'string' || !value.phase || typeof value.status !== 'string' || !value.status)) throw Error('Invalid metadata');
  return value;
}
export function newMetadata(kind: 'project' | 'task', name: string, unknownDates = false): Metadata {
  const now = unknownDates ? null : new Date().toISOString();
  return {
    version: 1,
    id: generateId(kind),
    name,
    createdAt: now,
    updatedAt: now
  };
}
export function recoverTasks(folder: string) {
  const managed = projectRoot(folder);
  const root = directory(join(managed, 'tasks'));
  // 未確定の削除は戻し、確定済みの隔離データは再試行で片付ける。
  for (const entry of readdirSync(managed)) {
    if (!entry.startsWith('.deleting-') || !validTaskId(entry.slice(10))) continue;
    const staged = directory(join(managed, entry)), id = entry.slice(10);
    if (!readdirSync(staged).length) { rmSync(staged, {recursive:true}); continue; }
    const committed = pathExists(join(staged, 'committed.json'));
    if (!committed && !pathExists(join(staged, 'task')) && !pathExists(join(staged, 'chat.json')) && !pathExists(join(staged, 'chat')) && readdirSync(staged).every(name => name === 'journal.json' || /^journal\.json\.tmp-[a-f0-9-]+$/.test(name))) {
      rmSync(staged, {recursive:true}); continue;
    }
    const journal = readJson(join(staged, committed ? 'committed.json' : 'journal.json'));
    if (journal.version !== 1 || journal.taskId !== id || journal.projectId !== metadata(join(managed, 'project.json'), 'project').id || readdirSync(staged).some(name => !['journal.json','committed.json','task','chat.json','chat'].includes(name))) throw Error('Invalid deletion journal');
    if (committed) {
      try { cleanDeletedTask(staged); } catch { /* 次回の読み込みで再試行する。 */ }
      continue;
    }
    const task = join(staged, 'task'), chat = join(staged, 'chat.json');
    if (pathExists(chat)) {
      const destination = join(directory(join(managed, 'chat')), `${id}.json`);
      if (pathExists(destination)) throw Error('Deletion recovery conflict');
      const stat = lstatSync(chat);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid chat file');
      renameSync(chat, destination);
    }
    const phaseChat = join(staged, 'chat');
    if (pathExists(phaseChat)) {
      validateChatDirectory(phaseChat);
      const destination = join(directory(join(managed, 'chat')), id);
      if (pathExists(destination)) throw Error('Deletion recovery conflict');
      renameSync(phaseChat, destination);
    }
    if (pathExists(task)) {
      directory(task);
      if (pathExists(join(root, id))) throw Error('Deletion recovery conflict');
      renameSync(task, join(root, id));
    }
    rmSync(staged, {recursive:true});
  }
  for (const entry of readdirSync(root)) {
    if (entry.startsWith('.creating-')) continue;
    const path = join(root, entry);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid task directory');
    const file = join(path, 'task.json');
    if (pathExists(file)) {
      const value = metadata(file, 'task');
      if (value.id !== entry) throw Error('Task directory ID mismatch');
      continue;
    }
    if (!validTaskId(entry) && !/^\d+$/.test(entry)) throw Error('Unrecognized task directory');
    const documents = readdirSync(path).filter(name => /^[a-z][a-z0-9-]*\.md$/.test(name));
    if (!documents.length) continue;
    for (const name of documents) {
      const stat = lstatSync(join(path, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid document file');
    }
    const value = {
      ...newMetadata('task', 'Unknown', true),
      phase: 'requirements',
      status: 'idle'
    };
    if (validTaskId(entry)) value.id = entry;else {
      const target = join(root, value.id);
      if (existsSync(target)) throw Error('Task ID collision');
      renameSync(path, target);
    }
    writeJson(join(root, value.id, 'task.json'), value);
  }
  return root;
}
// 確定マーカーを最後まで残し、途中で掃除に失敗しても復元しない。
export function cleanDeletedTask(staged: string) {
  rmSync(join(staged, 'task'), {recursive:true, force:true});
  rmSync(join(staged, 'chat.json'), {force:true});
  rmSync(join(staged, 'chat'), {recursive:true, force:true});
  rmSync(join(staged, 'journal.json'), {force:true});
  rmSync(join(staged, 'committed.json'), {force:true});
  rmSync(staged, {recursive:true});
}

// フェーズ会話の隔離では、管理外ファイルやリンクを巻き込まない。
export function validateChatDirectory(path: string) {
  directory(path);
  for (const name of readdirSync(path)) {
    if (!name.endsWith('.json') || !isTaskPhase(name.slice(0, -5))) throw Error('Invalid phase chat file');
    readJson(join(path, name));
  }
}
