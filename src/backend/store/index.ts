import { defaultInstructions, validateInstruction, type Instruction } from '../instructions';
import { taskDocuments, taskDocumentSnapshot, documentContentsKey, retrospectiveDocument } from '../documents';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validProjectId, validTaskId } from '../../shared/ids';
import { cleanDeletedTask, directory, metadata, newMetadata, projectRoot, recoverTasks, pathExists, readJson, writeJson, validateChatDirectory, type TaskMetadata } from '../data';
import { taskPhases, type TaskPhase } from '../../shared/task-phase';
import { captureProjectTaskHistory, projectEvents, projectEvent, getProjectFileChange, getProjectFileVersion, projectTaskVersion, appendProjectEvent, projectTaskDeleted, type ProjectEventInput } from '../project-events';
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
// ファイル削除の確定直後に停止しても、隔離データを消す前に削除イベントを補う。
function recoverProjectTasks(folder: string, projectId: string) {
  const root = projectRoot(folder);
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith('.deleting-') || !validTaskId(entry.slice(10))) continue;
    const staged = directory(join(root, entry)), committed = join(staged, 'committed.json');
    if (!pathExists(committed)) continue;
    const journal = readJson(committed), taskId = entry.slice(10);
    if (!journal || journal.version !== 1 || journal.projectId !== projectId || journal.taskId !== taskId) throw Error('Invalid deletion journal');
    projectTaskDeleted(folder, taskId);
  }
  return recoverTasks(folder);
}
export class Store {
  private readonly db: Database;
  private memoryDirectory?:string;
  get dataDirectory(){return this.databasePath===':memory:'?(this.memoryDirectory??=mkdtempSync(join(tmpdir(),'beni-app-'))):dirname(resolve(this.databasePath))}
  constructor(private databasePath: string) {
    const path=databasePath;
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
      throw Error('Legacy data is unsupported.');
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE)');
    this.db.exec('CREATE TABLE IF NOT EXISTS instructions(key TEXT PRIMARY KEY,content TEXT NOT NULL)');
    this.db.transaction(() => {
      const insert = this.db.query('INSERT OR IGNORE INTO instructions(key,content) VALUES (?,?)');
      for (const instruction of defaultInstructions) insert.run(instruction.key, instruction.content);
    })();
  }
  instructions(): Instruction[] {
    const rows = this.db.query('SELECT key,content FROM instructions').all() as Instruction[];
    return defaultInstructions.map(({key}) => rows.find(row => row.key === key)!);
  }
  updateInstruction(key:unknown,content:unknown,expected:unknown) {
    validateInstruction(key,content);
    if(typeof expected!=='string')throw Error('expected_content が必要です');
    const result=this.db.query('UPDATE instructions SET content=? WHERE key=? AND content=?').run(content,key as string,expected);
    if(result.changes!==1)throw Error('インストラクションが変更されています。最新の本文を確認してください');
    return {key,content};
  }
  close() {
    this.db.close();
    if(this.memoryDirectory)rmSync(this.memoryDirectory,{recursive:true,force:true});
  }
  projects(): Project[] {
    const rows = this.db.query('SELECT * FROM projects ORDER BY id DESC').all() as Project[];
    for (const row of rows) {
      if (!existsSync(row.folder)) continue;
      const data = metadata(join(projectRoot(row.folder), 'project.json'), 'project');
      if (data.id !== row.id) throw Error('Project ID mismatch');
      row.name = data.name;
      this.db.query('UPDATE projects SET name=? WHERE id=?').run(row.name, row.id);
      recoverProjectTasks(row.folder, row.id);
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
    if (old && old.folder !== normalized && existsSync(old.folder)) throw Error('Duplicate live project copy.');
    if (!pathExists(file)) writeJson(file, data);
    recoverProjectTasks(normalized, data.id);
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
      const root = recoverProjectTasks(project.folder, project.id);
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
    captureProjectTaskHistory(project.folder, taskId, value.phase);
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
    const {project, file, value} = this.scopedTask(projectId, taskId);
    if (value.name === name.trim()) return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
    const before = structuredClone(value), previousName = value.name;
    value.name = name.trim();
    value.updatedAt = new Date(Math.max(Date.now(), Date.parse(value.updatedAt ?? '') || 0)).toISOString();
    writeJson(file, value);
    try { appendProjectEvent(project.folder, {type: 'task.renamed', taskId, phase: value.phase as TaskPhase, details: {previousName, name: value.name}}); }
    catch (error) { writeJson(file, before); throw error; }
    return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
  }
  // 削除済みタスクの履歴も、現存タスクではなくプロジェクトのスコープで検証する。
  private scopedProject(projectId: string) {
    if (!validProjectId(projectId)) throw Error('Invalid project');
    const project = this.db.query('SELECT * FROM projects WHERE id=?').get(projectId) as Project | null;
    if (!project) throw Error('Unknown project');
    if (metadata(join(projectRoot(project.folder), 'project.json'), 'project').id !== projectId) throw Error('Project ID mismatch');
    return project;
  }
  captureTaskHistory(projectId: string, taskId: string | null, sourcePhase: TaskPhase | null = null, operationId?: string) {
    const project = this.scopedProject(projectId);
    if (taskId === null) {
      for (const task of this.tasks(projectId, false)) captureProjectTaskHistory(project.folder, task.id, task.phase, sourcePhase, operationId);
      return;
    }
    const {value} = this.scopedTask(projectId, taskId);
    captureProjectTaskHistory(project.folder, taskId, value.phase, sourcePhase, operationId);
  }
  projectEvents(projectId: string, options: {after?: number; through?: number; limit?: number; taskId?: string; types?: string[]} = {}) {
    const project = this.scopedProject(projectId);
    if (options.taskId !== undefined && !validTaskId(options.taskId)) throw Error('Invalid task scope');
    this.captureTaskHistory(projectId, null);
    return projectEvents(project.folder, options);
  }
  projectEventCursor(projectId: string) {
    return projectEvents(this.scopedProject(projectId).folder, {limit: 1}).through;
  }
  projectEvent(projectId: string, eventId: number) {
    return projectEvent(this.scopedProject(projectId).folder, eventId);
  }
  projectFileChange(projectId: string, eventId: number) {
    return getProjectFileChange(this.scopedProject(projectId).folder, eventId);
  }
  projectFileVersion(projectId: string, path: string, changeId: number) {
    return getProjectFileVersion(this.scopedProject(projectId).folder, path, changeId);
  }
  recordProjectEvent(projectId: string, event: ProjectEventInput) {
    return appendProjectEvent(this.scopedProject(projectId).folder, event);
  }
  taskEvents(projectId: string, taskId: string | null, after = 0, through?: number, limit = 100) {
    const page = this.projectEvents(projectId, {after, through, limit, ...(taskId === null ? {} : {taskId})});
    if (taskId === null) return page;
    const prefix = `.beni/tasks/${taskId}/`;
    // 既存のタスクUIでは文書名だけを表示する。IDとカーソルはプロジェクト共通。
    return {...page, events: page.events.map(event => ({...event,
      ...(event.path === undefined ? {} : {path: event.path.startsWith(prefix) ? event.path.slice(prefix.length) : event.path}),
      ...(event.previousPath === undefined ? {} : {previousPath: event.previousPath.startsWith(prefix) ? event.previousPath.slice(prefix.length) : event.previousPath})
    }))};
  }
  taskEventVersion(projectId: string, taskId: string, version: string) {
    if (!validTaskId(taskId)) throw Error('Invalid task scope');
    return projectTaskVersion(this.scopedProject(projectId).folder, taskId, version);
  }
  selectTaskPhase(projectId: string, taskId: string, expectedPhase: string, target: TaskPhase): TaskRow {
    const {project, file, value} = this.scopedTask(projectId, taskId);
    if (!taskPhases.includes(target)) throw Error('invalid phase');
    if (value.phase !== expectedPhase || value.status==='completed') throw Error('phase conflict');
    if(target==='retrospective')retrospectiveDocument(join(file,'..'));
    if(value.phase===target)return {id:value.id,project_id:projectId,name:value.name,phase:value.phase,status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt};
    captureProjectTaskHistory(project.folder, taskId, value.phase);
    const before = structuredClone(value);
    value.phase = target;
    value.updatedAt = new Date(Math.max(Date.now(), (Date.parse(value.updatedAt ?? '') || 0) + 1)).toISOString();
    writeJson(file, value);
    try { captureProjectTaskHistory(project.folder, taskId, target, expectedPhase as TaskPhase); }
    catch (error) { writeJson(file, before); throw error; }
    return {id: value.id, project_id: projectId, name: value.name, phase: value.phase, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt};
  }
  setTaskCompleted(projectId:string,taskId:string,completed:boolean):TaskRow {
    const {project,file,value}=this.scopedTask(projectId,taskId);
    if(value.phase!=='retrospective'||value.status!==(completed?'idle':'completed'))throw Error('phase conflict');
    captureProjectTaskHistory(project.folder, taskId, value.phase);
    const before = structuredClone(value);
    value.status=completed?'completed':'idle';
    value.updatedAt=new Date(Math.max(Date.now(),(Date.parse(value.updatedAt??'')||0)+1)).toISOString();
    writeJson(file,value);
    try { appendProjectEvent(project.folder, {type: completed ? 'task.completed' : 'task.reopened', taskId, phase: value.phase as TaskPhase}); }
    catch (error) { writeJson(file, before); throw error; }
    return {id:value.id,project_id:projectId,name:value.name,phase:value.phase,status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt};
  }
  advanceTaskPhase(projectId: string, taskId: string, expectedPhase: string, direction: 'next' | 'back' = 'next'): TaskRow {
    const {file, value} = this.scopedTask(projectId, taskId);
    const index = taskPhases.indexOf(expectedPhase as typeof taskPhases[number]);
    if (index < 0) throw Error('invalid phase');
    if (direction !== 'next' && direction !== 'back') throw Error('invalid direction');
    const next = index + (direction === 'next' ? 1 : -1);
    if (value.phase !== expectedPhase || next < 0 || next >= taskPhases.length) throw Error('phase conflict');
    return this.selectTaskPhase(projectId,taskId,expectedPhase,taskPhases[next]!);
  }

  deleteTask(projectId: string, taskId: string) {
    const {project, value} = this.scopedTask(projectId, taskId);
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
    captureProjectTaskHistory(project.folder, taskId, value.phase);
    const staged = join(root, `.deleting-${taskId}`);
    mkdirSync(staged, {mode:0o700});
    try { writeJson(join(staged, 'journal.json'), {version:1, projectId, taskId}); }
    catch (error) { rmSync(staged, {recursive:true}); throw error; }
    try {
      renameSync(task, join(staged, 'task'));
      if (pathExists(chat)) renameSync(chat, join(staged, 'chat.json'));
      if (pathExists(phaseChat)) renameSync(phaseChat, join(staged, 'chat'));
      projectTaskDeleted(project.folder, taskId, () => renameSync(join(staged, 'journal.json'), join(staged, 'committed.json')));
    } catch (error) {
      // DBのcommit失敗はファイル側の削除確定も取り消してから復元する。
      const committed = join(staged, 'committed.json');
      if (pathExists(committed)) renameSync(committed, join(staged, 'journal.json'));
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
