import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateId, validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase } from '../shared/task-phase';
import type { AgentId } from '../shared/agent';
import { chatFileStem, chatIdPattern, relocateTaskChats, workflowJobNamePattern } from './chat-files';
export type Metadata = {
  version: 1;
  id: string;
  name: string;
  createdAt: string | null;
  updatedAt: string | null;
};
export type TaskMetadata = Metadata & {
  documentBaseline?: Record<string, {hash: string; modifiedAt: number}>;
  pendingCompletion?: TaskCompletion;
  phase: string;
  status: string;
};
export type TaskCompletion = {id: string; chatId?: string; revision: string; provider: AgentId; model: string | null};
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
export function recoverTaskDeletions(rootDirectory: string, projectId: string, committedInDatabase: (taskId: string, legacy: boolean) => boolean) {
  const managed = directory(rootDirectory), root = join(managed, 'tasks');
  if (pathExists(root)) directory(root);
  const cleanup: string[] = [];
  // 未確定の削除は戻し、確定済みの隔離データは再試行で片付ける。
  for (const entry of readdirSync(managed)) {
    if (!entry.startsWith('.deleting-') || !validTaskId(entry.slice(10))) continue;
    const staged = directory(join(managed, entry)), id = entry.slice(10);
    if (!readdirSync(staged).length) { rmSync(staged, {recursive:true}); continue; }
    const committed = pathExists(join(staged, 'committed.json'));
    const journalPath = join(staged, committed ? 'committed.json' : 'journal.json');
    if (!pathExists(journalPath) && readdirSync(staged).every(name => /^journal\.json\.tmp-[a-f0-9-]+$/.test(name))) {
      for (const name of readdirSync(staged)) {
        const stat = lstatSync(join(staged, name));
        if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid deletion journal');
      }
      rmSync(staged, {recursive:true}); continue;
    }
    const journal = readJson(journalPath);
    if (!journal || !(journal.version === 1 || journal.version === 2 && !committed) ||
        journal.taskId !== id || journal.projectId !== projectId ||
        readdirSync(staged).some(name => !['journal.json','committed.json','task','chat.json','chat'].includes(name))) throw Error('Invalid deletion journal');
    const task = join(staged, 'task'), chat = join(staged, 'chat.json'), phaseChat = join(staged, 'chat');
    const destination = join(root, id);
    if (pathExists(task)) {
      validateChatDirectory(task);
      const file = join(task, 'task.json');
      if (pathExists(file) && metadata(file, 'task').id !== id) throw Error('Task directory ID mismatch');
    }
    if (pathExists(phaseChat)) {
      validateChatDirectory(phaseChat);
      if (readdirSync(phaseChat).some(name => name !== 'history' && name !== 'workflow-jobs' && !isTaskPhase(chatFileStem(name)))) {
        throw Error('Unexpected files in deletion journal');
      }
    }
    if (pathExists(chat)) {
      const stat = lstatSync(chat);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Invalid chat file');
    }
    if (committed && pathExists(destination)) throw Error('Deletion recovery conflict');
    if ((committed || journal.version === 2) && committedInDatabase(id, committed)) {
      cleanup.push(staged);
      continue;
    }
    if (pathExists(task) && pathExists(destination)) throw Error('Deletion recovery conflict');
    if (pathExists(chat)) {
      const target = join(directory(join(managed, 'chat')), `${id}.json`);
      if (pathExists(target)) throw Error('Deletion recovery conflict');
      renameSync(chat, target);
    }
    if (pathExists(task)) {
      directory(root);
      renameSync(task, destination);
    }
    if (pathExists(phaseChat)) {
      relocateTaskChats(phaseChat, destination);
      if (pathExists(phaseChat)) throw Error('Unexpected files in deletion journal');
    }
    rmSync(staged, {recursive:true});
  }
  return cleanup;
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

// フェーズ会話の隔離では、タスク文書と会話を区別してリンクを拒否する。
export function validateChatDirectory(path: string) {
  directory(path);
  for (const name of readdirSync(path)) {
    if (name === 'history' || name === 'workflow-jobs') {
      const folder = directory(join(path, name));
      const pattern = name === 'history' ? chatIdPattern : workflowJobNamePattern;
      for (const entry of readdirSync(folder)) {
        if (!pattern.test(chatFileStem(entry))) throw Error('Invalid chat history file');
        readJson(join(folder, entry));
      }
      continue;
    }
    if (isTaskPhase(chatFileStem(name))) readJson(join(path, name));
  }
}
