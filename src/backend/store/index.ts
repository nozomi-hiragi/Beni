import { taskDocuments, taskDocumentSnapshot, documentContentsKey } from '../documents';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validProjectId, validTaskId } from '../../shared/ids';
import { cleanDeletedTask, directory, metadata, newMetadata, projectRoot, recoverTasks, pathExists, writeJson, validateChatDirectory, type TaskMetadata } from '../data';
import { taskPhases, type TaskPhase } from '../../shared/task-phase';
import { captureTaskHistory, taskEvents, taskEventVersion } from '../task-history';
export { taskPhases } from '../../shared/task-phase';
export type Project = {
  id: string;
  name: string;
  folder: string;
};
export type TaskRow = {
  id: string;
  project_id: string;
  createdAt: string | null;
  updatedAt: string | null;
  name: string;
  phase: string;
  status: string;
};
export class Store {
  private readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, {
      create: true
    });
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','messages','documents')").all();
    const columns = this.db.query('PRAGMA table_info(projects)').all() as {
      name: string;
      type: string;
    }[];
    if (tables.length || columns.some(c => c.name === 'id' && c.type.toUpperCase() !== 'TEXT')) {
      this.db.close();
      throw Error('Legacy data detected. Stop Beni and run bun run migrate:data -- <data-directory> before restarting.');
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE)');
  }
  close() {
    this.db.close();
  }
  projects(): Project[] {
    const rows = this.db.query('SELECT * FROM projects ORDER BY id DESC').all() as Project[];
    for (const row of rows) {
      if (!existsSync(row.folder)) continue;
      const data = metadata(join(projectRoot(row.folder), 'project.json'), 'project');
      if (data.id !== row.id) throw Error('Project ID mismatch');
      row.name = data.name;
      this.db.query('UPDATE projects SET name=? WHERE id=?').run(row.name, row.id);
      recoverTasks(row.folder);
    }
    return rows;
  }
  createProject(name: string, folder: string): Project {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const normalized = resolve(folder),
      root = projectRoot(normalized),
      file = join(root, 'project.json');
    const data = pathExists(file) ? metadata(file, 'project') : newMetadata('project', name.trim());
    const old = this.db.query('SELECT * FROM projects WHERE id=?').get(data.id) as Project | null;
    if (old && old.folder !== normalized && existsSync(old.folder)) throw Error('Duplicate live project copy. Use bun run clone:project to create a separate project.');
    if (!pathExists(file)) writeJson(file, data);
    recoverTasks(normalized);
    this.db.query('INSERT INTO projects(id,name,folder) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,folder=excluded.folder').run(data.id, data.name, normalized);
    return {
      id: data.id,
      name: data.name,
      folder: normalized
    };
  }
  tasks(projectId?: string, reconcile = true): TaskRow[] {
    if (projectId !== undefined && !validProjectId(projectId)) throw Error('Invalid project');
    const projects = this.projects().filter(p => projectId === undefined || p.id === projectId);
    return projects.flatMap(project => {
      if (!existsSync(project.folder)) return [];
      const root = recoverTasks(project.folder);
      return readdirSync(root).filter(validTaskId).map(id => {
        const value = reconcile ? this.reconcileDocuments(project, id) : metadata(join(root, id, 'task.json'), 'task') as TaskMetadata;
        return {
          id: value.id,
          project_id: project.id,
          name: value.name,
          phase: value.phase,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          status: value.status
        };
      });
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  task(id: string): TaskRow | null {
    if (!validTaskId(id)) throw Error('Invalid task');
    const matches = this.tasks(undefined, false).filter(task => task.id === id);
    if (matches.length > 1) throw Error('Duplicate task ID');
    return matches[0] ?? null;
  }
  // 文書の内容を比較する。初回は基準だけを保存し、移行・復元日時を活動にしない。
  private reconcileDocuments(project: Project, taskId: string, initialize = false): TaskMetadata {
    const root = directory(join(projectRoot(project.folder), 'tasks')), path = directory(join(root, taskId));
    const file = join(path, 'task.json');
    const value = metadata(file, 'task') as TaskMetadata;
    if (value.id !== taskId) throw Error('Task directory ID mismatch');
    const baseline = taskDocumentSnapshot(path);
    const previous = initialize ? undefined : value.documentBaseline;
    if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous) || Object.entries(previous).some(([name, entry]) => !/^[a-z][a-z0-9-]*\.md$/.test(name) || !entry || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isFinite(entry.modifiedAt)))) throw Error('Invalid document baseline');
    const changed = Object.keys(baseline).filter(name => previous && previous[name]?.hash !== baseline[name]!.hash);
    const removed = previous && Object.keys(previous).some(name => !(name in baseline));
    if (previous && (changed.length || removed)) {
      // 変更時刻が保存されている編集はその時刻を使う。削除・時刻保存編集は検出時刻になる。
      const time = removed || changed.some(name => (previous[name]?.modifiedAt ?? -Infinity) >= baseline[name]!.modifiedAt)
        ? Date.now() : Math.max(...changed.map(name => baseline[name]!.modifiedAt));
      value.updatedAt = new Date(Math.max(Date.parse(value.updatedAt ?? '') || 0, time)).toISOString();
    }
    if (JSON.stringify(value.documentBaseline) !== JSON.stringify(baseline)) {
      value.documentBaseline = baseline;
      writeJson(file, value);
    }
    captureTaskHistory(path, value.phase);
    return value;
  }
  private scopedTask(projectId: string, taskId: string) {
    if (!validProjectId(projectId) || !validTaskId(taskId)) throw Error('Invalid task scope');
    const project = this.db.query('SELECT * FROM projects WHERE id=?').get(projectId) as Project | null;
    if (!project) throw Error('Unknown project');
    const root = projectRoot(project.folder);
    if (metadata(join(root, 'project.json'), 'project').id !== projectId) throw Error('Project ID mismatch');
    const tasks = directory(join(root, 'tasks'));
    if (!pathExists(join(tasks, taskId))) throw Error('Unknown task');
    const path = directory(join(tasks, taskId));
    const file = join(path, 'task.json');
    const value = metadata(file, 'task') as TaskMetadata;
    if (value.id !== taskId) throw Error('Task directory ID mismatch');
    return {project, file, value};
  }
  reconcileTaskDocuments(projectId: string, taskId: string) {
    const {project, value: before} = this.scopedTask(projectId, taskId);
    const after = this.reconcileDocuments(project, taskId);
    return before.documentBaseline !== undefined && documentContentsKey(before.documentBaseline) !== documentContentsKey(after.documentBaseline!);
  }
  taskDocumentFolder(projectId: string, taskId: string) {
    const {project, value: task} = this.scopedTask(projectId, taskId);
    this.reconcileDocuments(project, taskId);
    const path = taskDocuments(project.folder, taskId, {requirements: '# ' + task.name + '\n'});
    // 読み込み時の既定文書の補完は活動に数えない。
    this.reconcileDocuments(project, taskId, true);
    return path;
  }
  touchTask(projectId: string, taskId: string) {
    const {file, value} = this.scopedTask(projectId, taskId);
    value.updatedAt = new Date(Math.max(Date.now(), Date.parse(value.updatedAt ?? '') || 0)).toISOString();
    writeJson(file, value);
  }
  renameTask(projectId: string, taskId: string, name: string): TaskRow {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const {file, value} = this.scopedTask(projectId, taskId);
    if (value.name === name.trim()) return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
    value.name = name.trim();
    value.updatedAt = new Date(Math.max(Date.now(), Date.parse(value.updatedAt ?? '') || 0)).toISOString();
    writeJson(file, value);
    return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
  }
  captureTaskHistory(projectId: string, taskId: string, sourcePhase: TaskPhase | null = null) {
    const {file, value} = this.scopedTask(projectId, taskId);
    captureTaskHistory(join(file, '..'), value.phase, sourcePhase);
  }
  taskEvents(projectId: string, taskId: string, after = 0, through?: number, limit = 100) {
    const {file, value} = this.scopedTask(projectId, taskId);
    return taskEvents(join(file, '..'), value.phase, after, through, limit);
  }
  taskEventVersion(projectId: string, taskId: string, version: string) {
    const {file} = this.scopedTask(projectId, taskId);
    return taskEventVersion(join(file, '..'), version);
  }
  advanceTaskPhase(projectId: string, taskId: string, expectedPhase: string, direction: 'next' | 'back' = 'next'): TaskRow {
    const {file, value} = this.scopedTask(projectId, taskId);
    const index = taskPhases.indexOf(expectedPhase as typeof taskPhases[number]);
    if (index < 0) throw Error('invalid phase');
    if (direction !== 'next' && direction !== 'back') throw Error('invalid direction');
    const next = index + (direction === 'next' ? 1 : -1);
    if (value.phase !== expectedPhase || next < 0 || next >= taskPhases.length) throw Error('phase conflict');
    captureTaskHistory(join(file, '..'), value.phase);
    value.phase = taskPhases[next]!;
    value.updatedAt = new Date(Math.max(Date.now(), (Date.parse(value.updatedAt ?? '') || 0) + 1)).toISOString();
    writeJson(file, value);
    captureTaskHistory(join(file, '..'), value.phase, expectedPhase as TaskPhase);
    return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
  }
  deleteTask(projectId: string, taskId: string) {
    const {project} = this.scopedTask(projectId, taskId);
    const root = projectRoot(project.folder), task = join(root, 'tasks', taskId);
    const chatRoot = join(root, 'chat');
    if (pathExists(chatRoot)) directory(chatRoot);
    const chat = join(chatRoot, `${taskId}.json`);
    if (pathExists(chat)) {
      const stat = lstatSync(chat);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid chat file');
    }
    const phaseChat = join(chatRoot, taskId);
    if (pathExists(phaseChat)) validateChatDirectory(phaseChat);
    const staged = join(root, `.deleting-${taskId}`);
    mkdirSync(staged, {mode:0o700});
    try { writeJson(join(staged, 'journal.json'), {version:1, projectId, taskId}); }
    catch (error) { rmSync(staged, {recursive:true}); throw error; }
    try {
      renameSync(task, join(staged, 'task'));
      if (pathExists(chat)) renameSync(chat, join(staged, 'chat.json'));
      if (pathExists(phaseChat)) renameSync(phaseChat, join(staged, 'chat'));
      renameSync(join(staged, 'journal.json'), join(staged, 'committed.json'));
    } catch (error) {
      recoverTasks(project.folder);
      throw error;
    }
    // 確定後の掃除に失敗しても対象は一覧へ戻さず、次回に再試行する。
    try { cleanDeletedTask(staged); } catch { /* recoverTasks が再試行する。 */ }
  }
  createTask(projectId: string, name: string, initialize?: (task: TaskRow) => void): TaskRow {
    if (!validProjectId(projectId)) throw Error('Invalid project');
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const project = this.projects().find(p => p.id === projectId);
    if (!project) throw Error('Unknown project');
    const value = {
      ...newMetadata('task', name.trim()),
      phase: 'requirements',
      status: 'idle'
    };
    const task = {
      id: value.id,
      project_id: projectId,
      name: value.name,
      phase: value.phase,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      status: value.status
    };
    const root = directory(join(projectRoot(project.folder), 'tasks')),
      path = join(root, value.id);
    if (existsSync(path)) throw Error('Task ID collision');
    try {
      if (initialize) initialize(task);else taskDocuments(project.folder, task.id, {
        requirements: `# ${task.name}\n`
      }, true);
      directory(path);
      writeJson(join(path, 'task.json'), value);
      this.reconcileDocuments(project, value.id);
    } catch (error) {
      if (existsSync(path)) rmSync(path, {
        recursive: true
      });
      throw error;
    }
    return task;
  }
}
