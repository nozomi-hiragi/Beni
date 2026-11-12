import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { validPack } from '../shared/communication';
import { validTaskId } from '../shared/ids';
import { isTaskPhase } from '../shared/task-phase';
import { decodeChatHistory } from './chat-history';
import { taskCompletedInstructionKey } from './instructions';

export const chatFileSuffix = '.chat.json';
export const chatIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const workflowJobNamePattern = /^[a-f0-9]{64}$/;
export const workflowJobHash = (id: string) => createHash('sha256').update(id).digest('hex');

export function validWorkflowJobFileStem(id: string) {
  return !!id && id !== '.' && id !== '..' && !/[<>:"/\\|?*\x00-\x1f\x7f\p{Surrogate}]/u.test(id) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(id) &&
    Buffer.byteLength(id + chatFileSuffix, 'utf8') <= 255;
}

export function chatFileStem(name: string) {
  if (name.endsWith(chatFileSuffix)) return name.slice(0, -chatFileSuffix.length);
  if (name.endsWith('.json')) return name.slice(0, -5);
  return '';
}

function statIfPresent(path: string) {
  try { return lstatSync(path); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

export function chatFile(directory: string, stem: string) {
  const legacy = join(directory, stem + '.json'), current = join(directory, stem + chatFileSuffix);
  moveChatFile(legacy, current);
  return current;
}

function moveChatFile(legacy: string, current: string, verify?: (path: string) => void) {
  const oldStat = statIfPresent(legacy), newStat = statIfPresent(current);
  if (oldStat && !oldStat.isFile() || newStat && !newStat.isFile()) throw Error('Invalid chat file');
  if (!oldStat) {
    if (newStat && newStat.nlink !== 1) throw Error('Invalid chat file');
    return;
  }
  if (newStat) {
    // 排他的なリンク作成の直後に停止した場合だけ、残った旧名を取り除く。
    if (newStat.dev !== oldStat.dev || newStat.ino !== oldStat.ino || oldStat.nlink !== 2) throw Error('Chat filename migration conflict');
    verify?.(legacy);
  } else {
    if (oldStat.nlink !== 1) throw Error('Invalid chat file');
    verify?.(legacy);
    // 同名のファイルが並行して作られた場合も上書きしない。
    linkSync(legacy, current);
  }
  unlinkSync(legacy);
}

function directoryEntries(path: string) {
  const stat = statIfPresent(path);
  if (!stat) return [];
  if (!stat.isDirectory()) throw Error('Invalid chat directory');
  return readdirSync(path);
}

function migrateNamedFiles(path: string, matches: (stem: string) => boolean) {
  const stems = new Set(directoryEntries(path).map(chatFileStem).filter(matches));
  for (const stem of stems) chatFile(path, stem);
}

export function migrateTaskChats(path: string) {
  migrateNamedFiles(path, isTaskPhase);
  migrateNamedFiles(join(path, 'history'), stem => chatIdPattern.test(stem));
}

function relocateNamedFiles(source: string, target: string, matches: (stem: string) => boolean) {
  const stems = new Set(directoryEntries(source).map(chatFileStem).filter(matches));
  if (!stems.size) return;
  for (const stem of stems) relocateNamedFile(source, target, stem);
}

function relocateNamedFile(source: string, target: string, stem: string, verify?: (path: string) => void) {
  if (!statIfPresent(target)) mkdirSync(target, {mode: 0o700});
  directoryEntries(target);
  const oldName = join(source, stem + '.json'), renamed = join(source, stem + chatFileSuffix);
  const current = join(target, stem + chatFileSuffix);
  if (statIfPresent(join(target, stem + '.json'))) throw Error('Chat filename migration conflict');
  if (statIfPresent(renamed) && statIfPresent(oldName)) {
    if (statIfPresent(current)) throw Error('Chat filename migration conflict');
    chatFile(source, stem);
  }
  moveChatFile(statIfPresent(renamed) ? renamed : oldName, current, verify);
}

export function relocateTaskChats(source: string, task: string) {
  const entries = directoryEntries(source);
  if (!statIfPresent(source)) return;
  const history = join(source, 'history');
  const archives = directoryEntries(history);
  if (entries.some(name => isTaskPhase(chatFileStem(name))) || archives.some(name => chatIdPattern.test(chatFileStem(name)))) {
    if (!statIfPresent(task)) throw Error('Missing task directory for chat migration');
    directoryEntries(task);
    relocateNamedFiles(source, task, isTaskPhase);
    relocateNamedFiles(history, join(task, 'history'), stem => chatIdPattern.test(stem));
  }
  // 管理外のファイルは移さず、空になったディレクトリーだけを片付ける。
  if (statIfPresent(history) && !directoryEntries(history).length) rmdirSync(history);
  if (!directoryEntries(source).length) rmdirSync(source);
}

export function relocateProjectChats(root: string) {
  const source = join(root, 'chat');
  relocateNamedFiles(source, root, stem => stem === 'general');
  chatFile(root, 'general');
  const oldHistory = join(source, 'history'), history = join(root, 'history');
  relocateNamedFiles(oldHistory, history, stem => chatIdPattern.test(stem));
  migrateNamedFiles(history, stem => chatIdPattern.test(stem));
  if (statIfPresent(oldHistory) && !directoryEntries(oldHistory).length) rmdirSync(oldHistory);
  // 管理外ファイルや廃止済みのフラットなタスク会話は旧ディレクトリーに残す。
  if (statIfPresent(source) && !directoryEntries(source).length) rmdirSync(source);
}

export type JobChatTarget = (stem: string, hashed: boolean, legacyTaskId?: string) => {jobId: string; taskId: string} | undefined;
type JobChatFile = {path: string; stat: Stats};

function verifyWorkflowChat(path: string, stat: Stats, projectId: string, jobId?: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw Error('Workflow chat changed during migration');
    const chat = decodeChatHistory(JSON.parse(readFileSync(fd, 'utf8')));
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw Error('Workflow chat changed during migration');
    }
    if (chat.projectId !== projectId || chat.taskId !== null || chat.phase !== null || !chat.workflowJobId ||
        jobId !== undefined && chat.workflowJobId !== jobId ||
        chat.packs.some((pack, index) => !validPack(pack) || pack.sequence !== index + 1) ||
        new Set(chat.packs.map(pack => pack.packId)).size !== chat.packs.length) throw Error('Invalid workflow job conversation scope');
    return chat.workflowJobId;
  } finally { closeSync(fd); }
}

export function migrateWorkflowChats(root: string, projectId: string, jobTarget: JobChatTarget) {
  const tasks = join(root, 'tasks'), chats = join(root, 'chat'), workflows = join(root, 'workflows');
  const destination = join(workflows, taskCompletedInstructionKey);
  directoryEntries(chats);
  directoryEntries(workflows);
  const legacyFolders = [
    ...directoryEntries(tasks).filter(validTaskId).map(taskId => {
      const task = join(tasks, taskId);
      directoryEntries(task);
      return {folder: join(task, 'workflow-jobs'), taskId};
    }),
    {folder: join(root, 'workflow-jobs'), taskId: null},
    {folder: join(chats, 'workflow-jobs'), taskId: null},
  ];
  const byJobId = new Map<string, JobChatFile[]>();
  for (const {folder, taskId} of [...legacyFolders, {folder: destination, taskId: null}]) {
    for (const name of directoryEntries(folder)) {
      const stem = chatFileStem(name);
      const direct = folder === destination && name.endsWith(chatFileSuffix) ? jobTarget(stem, false) : undefined;
      const hashed = workflowJobNamePattern.test(stem) ? jobTarget(stem, true, taskId ?? undefined) : undefined;
      // 登録のない会話や安全なファイル名を作れない旧実行は元の位置に残す。
      const job = direct ?? hashed;
      if (!job || !validWorkflowJobFileStem(job.jobId)) continue;
      const path = join(folder, name), stat = lstatSync(path);
      if (!stat.isFile()) throw Error('Invalid workflow chat file');
      // ハッシュと別の実行IDが一致する場合は保存済みの実行IDで判定する。
      const jobId = direct && hashed && direct.jobId !== hashed.jobId ? verifyWorkflowChat(path, stat, projectId) : job.jobId;
      if (jobId !== direct?.jobId && jobId !== hashed?.jobId) throw Error('Invalid workflow job conversation scope');
      if (!validWorkflowJobFileStem(jobId)) continue;
      const files = byJobId.get(jobId) ?? [];
      files.push({path, stat});
      byJobId.set(jobId, files);
    }
  }
  for (const [jobId, files] of byJobId) {
    const first = files[0]!;
    // 既知の旧名・新名だけを指す同一 inode は、リンク作成後の中断から復旧できる。
    if (files.some(({stat}) => stat.ino !== first.stat.ino || stat.dev !== first.stat.dev || stat.nlink !== files.length)) {
      throw Error('Workflow chat migration conflict');
    }
    const target = join(destination, jobId + chatFileSuffix);
    if (files.length === 1 && first.path === target) continue;
    const installed = files.some(({path}) => path === target);
    if (!installed) {
      verifyWorkflowChat(first.path, first.stat, projectId, jobId);
      if (!statIfPresent(workflows)) mkdirSync(workflows, {mode: 0o700});
      directoryEntries(workflows);
      if (!statIfPresent(destination)) mkdirSync(destination, {mode: 0o700});
      directoryEntries(destination);
      linkSync(first.path, target);
    }
    verifyWorkflowChat(target, first.stat, projectId, jobId);
    let links = files.length + (installed ? 0 : 1);
    for (const {path} of files) {
      if (path === target) continue;
      const old = lstatSync(path), current = lstatSync(target);
      if ([old, current].some(stat => stat.dev !== first.stat.dev || stat.ino !== first.stat.ino || stat.nlink !== links)) {
        throw Error('Workflow chat changed during migration');
      }
      unlinkSync(path);
      links--;
    }
  }
  for (const {folder} of legacyFolders) {
    if (statIfPresent(folder) && !directoryEntries(folder).length) rmdirSync(folder);
  }
  if (statIfPresent(chats) && !directoryEntries(chats).length) rmdirSync(chats);
}

export function migrateProjectChats(root: string, projectId: string, jobTarget: JobChatTarget) {
  directoryEntries(root);
  const tasks = join(root, 'tasks'), chats = join(root, 'chat');
  const taskIds = directoryEntries(tasks).filter(validTaskId);
  for (const taskId of directoryEntries(chats).filter(validTaskId)) {
    relocateTaskChats(join(chats, taskId), join(tasks, taskId));
  }
  for (const taskId of taskIds) migrateTaskChats(join(tasks, taskId));
  relocateProjectChats(root);
  migrateWorkflowChats(root, projectId, jobTarget);
}

export function migrateInstructionChats(root: string) {
  const path = join(root, 'chat');
  directoryEntries(path);
  chatFile(path, 'instructions');
  for (const history of ['history', 'instruction-history']) {
    migrateNamedFiles(join(path, history), stem => chatIdPattern.test(stem));
  }
}
