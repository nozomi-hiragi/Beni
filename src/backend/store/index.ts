import { createHash } from 'node:crypto';
import { defaultInstructions, isInstructionKey, validateInstruction, type Instruction } from '../instructions';
import { initialImplementationPlan, taskDocumentSnapshot, documentContentsKey, projectKnowledge } from '../documents';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { validProjectId, validTaskId } from '../../shared/ids';
import { cleanDeletedTask, directory, metadata, newMetadata, projectRoot, recoverTasks, pathExists, readJson, writeJson, validateChatDirectory, type TaskMetadata } from '../data';
import { taskPhases, type TaskPhase } from '../../shared/task-phase';
import { captureManagedTaskHistory, captureProjectTaskHistory, recordManagedDocumentHistory, readTrackedDocument, withDatabase, projectEvents, projectEvent, getProjectFileChange, getProjectFileVersion, projectTaskVersion, appendProjectEvent, projectTaskDeleted, type ProjectEventInput, type ProjectEventsOptions } from '../project-events';
import { DocumentTable, type DocumentItemInput, type DocumentSeed, type DocumentVersion } from '../document-table';
export { taskPhases } from '../../shared/task-phase';
export type Project = {
  id: string;
  name: string;
  folder: string;
};
// 終了フェーズ追加の前後で保存された初期本文だけを更新する。
const legacyInstructionHashes: Partial<Record<Instruction['key'], readonly string[]>> = {
  common: ['75814755c3e5fb64f465e9c333e78409d088b61cbd3149a4d5c57559961d4252'],
  requirements: ['72baf44f5568ef82c01aa73b0de875f64443767af15a1b23ba1740da4e47e19b', '829aff7cc0073e57a4e9c59d111b4b62e485cbd751d0057643b665343fb36623'],
  documents: ['6b004fa0d4faa88974fc0461e2122e1abd9ed303d003733a605bbad229c5cbe7', 'db04e338ea0a5e3928f8d7705be969314ae2d68d5e7adb44892290156e921976'],
  implementation: ['c96c0d5db393de3048363bbe27dc02ecd95dbaf1ba8aa30a6fc55d1ff19240db', '244094cc78ff4fbd8a91d7e6cd9750db5df5a2b62d76545a23f8d35bca14fcf7'],
  execution: ['3cf2d5369d6808dd3223bacb91f01e77b94430dd23d978e9e4641a780f2b17eb', 'd3d53499b0dd83c123aae152e02b841f3a661720b60004be9a3af9aed646175c'],
  retrospective: ['197564ac50f478ce0e916049c0edf5b75d5ed9486d7652b6f85af503e887449e', 'eadacb92d68c1df5e3b3b74c9bb6c5489ce5e85c0dd5924bfd746f7acdc8f984'],
  finalization: ['715cb6f374fc043f43fd3f37e50dd1dba1129ecc792e66d2eb6927ef72c05735'],
};
const instructionScope = 'instructions';
const knowledgeScope = 'knowledge';
const managedName = /^[a-z][a-z0-9-]{0,251}\.md$/;
const retrospectiveSeed = '# 反省会\n\n## 未達・意図との差\n\n## 原因\n\n## 次回への改善\n';
const documentTemplate = {kind: 'template', reason: 'Beni の初期テンプレートから作成した。'} as const;
const legacyDocument = {kind: 'legacy', reason: '既存の文書を初期版として取り込んだ。'} as const;
const taskSeeds = (name: string) => [
  {name: 'requirements.md', content: `# ${name}\n`, seed: {kind: 'template', reason: '登録されたタスク名を最初の見出しに使った。', sourceText: name} as const},
  {name: 'documents.md', content: '# 仕様整理\n\n## 資料\n\n## 仕様\n', seed: documentTemplate},
  {name: 'implementation.md', content: initialImplementationPlan, seed: documentTemplate}
];
export type InstructionJobInput = {
  id: string;
  projectId: string;
  taskId: string;
  revision: string;
  provider: 'codex' | 'claude';
  model: string | null;
};
export type InstructionJob = InstructionJobInput & {
  status: 'pending' | 'succeeded' | 'failed' | 'superseded';
  error?: string;
  reason?: string;
};
type InstructionJobChange = {key: string; base: string | null; items: DocumentItemInput[]};
const instructionJobColumns = 'id, project_id AS projectId, task_id AS taskId, revision, provider, model, status, error, reason';
type InstructionJobRow = Omit<InstructionJob, 'error' | 'reason'> & {error: string | null; reason: string | null};
function instructionJobValue(row: InstructionJobRow | null): InstructionJob | undefined {
  if (!row) return undefined;
  const {error, reason, ...job} = row;
  return {...job, ...(error === null ? {} : {error}), ...(reason === null ? {} : {reason})};
}
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
  private readonly instructionTable: DocumentTable;
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
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS instructions(key TEXT PRIMARY KEY,content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instruction_jobs (
        ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
        revision TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, error TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS instruction_jobs_task ON instruction_jobs(project_id,task_id,ordinal);
      CREATE INDEX IF NOT EXISTS instruction_jobs_pending ON instruction_jobs(status,ordinal);`);
    this.instructionTable = new DocumentTable(this.db);
    this.db.transaction(() => {
      const jobColumns = this.db.query<{name: string}, []>('PRAGMA table_info(instruction_jobs)').all();
      if (!jobColumns.some(column => column.name === 'reason')) this.db.exec('ALTER TABLE instruction_jobs ADD COLUMN reason TEXT');
      const legacy = this.db.query('SELECT content FROM instructions WHERE key=?');
      for (const instruction of defaultInstructions) {
        if (this.instructionTable.get(instructionScope, instruction.key)) continue;
        const old = legacy.get(instruction.key) as {content: string} | null;
        const isLegacyDefault = old && legacyInstructionHashes[instruction.key]?.includes(createHash('sha256').update(old.content).digest('hex'));
        if (old && !isLegacyDefault) this.instructionTable.seed(instructionScope, instruction.key, old.content, legacyDocument);
        else this.instructionTable.seed(instructionScope, instruction.key, instruction.content, documentTemplate);
      }
    }).immediate();
  }
  instructions(): Instruction[] {
    const contents = new Map(this.instructionTable.list(instructionScope).map(({name, content}) => [name, content]));
    return defaultInstructions.map(({key}) => ({key, content: contents.get(key)!}));
  }
  instructionDocument(key: string, revision?: string): DocumentVersion | undefined {
    if (!isInstructionKey(key)) throw Error('未知のインストラクションキー');
    return this.instructionTable.get(instructionScope, key, revision);
  }
  writeInstructionDocument(key: string, base: string | null, items: DocumentItemInput[], actor: string): DocumentVersion {
    return this.db.transaction(() => {
      if (!isInstructionKey(key)) throw Error('未知のインストラクションキー');
      const version = this.instructionTable.update(instructionScope, key, base, items, actor);
      validateInstruction(key, version.content);
      return version;
    }).immediate();
  }
  updateInstruction(key: unknown, content: unknown, expected: unknown) {
    validateInstruction(key, content);
    if (typeof expected !== 'string') throw Error('expected_content が必要です');
    const name = key as Instruction['key'];
    return this.db.transaction(() => {
      const current = this.instructionDocument(name)!;
      if (current.content !== expected) throw Error('インストラクションが変更されています。最新の本文を確認してください');
      if (content !== expected) {
        this.writeInstructionDocument(name, current.revision, [{
          text: content, reason: 'ユーザーが承認したインストラクションの編集',
          sources: [{kind: 'instruction', id: name, revision: current.revision, text: current.content.trim().slice(0, 1024) || content.trim().slice(0, 1024)}]
        }], 'instruction-editor');
      }
      return {key: name, content};
    }).immediate();
  }
  enqueueInstructionJob(job: InstructionJobInput) {
    if (!validProjectId(job.projectId) || !validTaskId(job.taskId) ||
        typeof job.id !== 'string' || !job.id || job.id.length > 512 ||
        typeof job.revision !== 'string' || !job.revision || job.revision.length > 512 ||
        (job.provider !== 'codex' && job.provider !== 'claude') ||
        (job.model !== null && (typeof job.model !== 'string' || job.model.length > 512))) throw Error('Invalid instruction job');
    return this.db.transaction(() => {
      const previous = this.instructionJobById(job.id);
      if (previous) {
        if (previous.projectId !== job.projectId || previous.taskId !== job.taskId || previous.revision !== job.revision ||
            previous.provider !== job.provider || previous.model !== job.model) throw Error('Conflicting instruction job');
        return previous;
      }
      this.db.query("UPDATE instruction_jobs SET status='superseded' WHERE project_id=? AND task_id=? AND status='pending'").run(job.projectId, job.taskId);
      this.db.query("INSERT INTO instruction_jobs(id,project_id,task_id,revision,provider,model,status) VALUES (?,?,?,?,?,?,'pending')").run(
        job.id, job.projectId, job.taskId, job.revision, job.provider, job.model);
      return this.instructionJobById(job.id)!;
    }).immediate();
  }
  pendingInstructionJob() {
    return instructionJobValue(this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE status='pending' ORDER BY ordinal LIMIT 1`).get() as InstructionJobRow | null);
  }
  private instructionJobById(id: string) {
    return instructionJobValue(this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE id=?`).get(id) as InstructionJobRow | null);
  }
  instructionJob(projectId: string, taskId: string) {
    if (!validProjectId(projectId) || !validTaskId(taskId)) throw Error('Invalid instruction job scope');
    return instructionJobValue(this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE project_id=? AND task_id=? ORDER BY ordinal DESC LIMIT 1`).get(projectId, taskId) as InstructionJobRow | null);
  }
  finishInstructionJob(id: string, error?: string) {
    if (error === undefined) return this.commitInstructionJob(id, []);
    if (typeof error !== 'string' || !error.trim() || error.length > 4096) throw Error('Invalid instruction job error');
    this.db.query("UPDATE instruction_jobs SET status='failed', error=? WHERE id=? AND status='pending'").run(error, id);
    return this.instructionJobById(id);
  }
  retryInstructionJob(projectId: string, taskId: string) {
    return this.db.transaction(() => {
      const job = this.instructionJob(projectId, taskId);
      if (job?.status !== 'failed') throw Error('再試行できるインストラクション更新がありません');
      this.db.query("UPDATE instruction_jobs SET status='pending', error=NULL WHERE id=?").run(job.id);
      return this.instructionJobById(job.id)!;
    }).immediate();
  }
  commitInstructionJob(id: string, changes: InstructionJobChange[], reason?: string) {
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 4096)) throw Error('Invalid instruction job reason');
    if (new Set(changes.map(change => change.key)).size !== changes.length) throw Error('Duplicate instruction change');
    return this.db.transaction(() => {
      if (this.instructionJobById(id)?.status !== 'pending') throw Error('Instruction job is no longer pending');
      for (const {key, base, items} of changes) this.writeInstructionDocument(key, base, items, id);
      this.db.query("UPDATE instruction_jobs SET status='succeeded', error=NULL, reason=? WHERE id=?").run(reason ?? null, id);
      return this.instructionJobById(id)!;
    }).immediate();
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
  private reconcileDocuments(project: Project, taskId: string): TaskMetadata {
    const root = directory(join(projectRoot(project.folder), 'tasks')), path = directory(join(root, taskId));
    const file = join(path, 'task.json');
    const value = metadata(file, 'task') as TaskMetadata;
    if (value.id !== taskId) throw Error('Task directory ID mismatch');
    if (withDatabase(project.folder, db => !!db.query('SELECT 1 FROM managed_document_scopes WHERE scope=?').get(taskId))) return value;
    const baseline = taskDocumentSnapshot(path);
    const previous = value.documentBaseline;
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
  private prepareManagedDocuments(db: Database, project: Project, task: {file: string; value: TaskMetadata} | null) {
    const scope = task?.value.id ?? knowledgeScope;
    const table = new DocumentTable(db);
    if (db.query('SELECT 1 FROM managed_document_scopes WHERE scope=?').get(scope)) return {scope, table};

    const documents = new Map<string, {content: string; seed: DocumentSeed}>();
    if (task) {
      for (const {name, content, seed} of taskSeeds(task.value.name)) documents.set(name, {content, seed});
      if (task.value.phase === 'retrospective' || task.value.phase === 'finalization') {
        documents.set('retrospective.md', {content: retrospectiveSeed, seed: documentTemplate});
      }
      const directory = dirname(task.file);
      for (const name of readdirSync(directory).filter(name => managedName.test(name)).sort()) {
        documents.set(name, {content: readTrackedDocument(join(directory, name)).toString('utf8'), seed: legacyDocument});
      }
      captureManagedTaskHistory(db, task.value.id, task.value.phase);
    } else {
      const path = projectKnowledge(project.folder, false);
      documents.set('knowledge.md', pathExists(path)
        ? {content: readTrackedDocument(path).toString('utf8'), seed: legacyDocument}
        : {content: '# プロジェクトの学び\n', seed: documentTemplate});
    }
    for (const [name, {content, seed}] of documents) {
      const version = table.seed(scope, name, content, seed);
      recordManagedDocumentHistory(db, task?.value.id ?? null, (task?.value.phase as TaskPhase | undefined) ?? null, version, true);
    }
    db.query('INSERT INTO managed_document_scopes(scope) VALUES (?)').run(scope);
    return {scope, table};
  }
  private withManagedDocuments<T>(projectId: string, taskId: string | null, operation: (db: Database, table: DocumentTable, scope: string, task: {file: string; value: TaskMetadata} | null) => T) {
    const project = this.scopedProject(projectId);
    return withDatabase(project.folder, db => db.transaction(() => {
      const task = taskId === null ? null : this.scopedTask(projectId, taskId);
      const {table, scope} = this.prepareManagedDocuments(db, project, task);
      return operation(db, table, scope, task);
    }).immediate());
  }
  managedDocuments(projectId: string, taskId: string | null): DocumentVersion[] {
    return this.withManagedDocuments(projectId, taskId, (_db, table, scope) => {
      const documents = table.list(scope);
      const requirements = documents.findIndex(document => document.name === 'requirements.md');
      if (requirements > 0) documents.unshift(...documents.splice(requirements, 1));
      return documents;
    });
  }
  managedDocument(projectId: string, taskId: string | null, name: string, revision?: string): DocumentVersion | undefined {
    this.validateManagedName(taskId, name);
    return this.withManagedDocuments(projectId, taskId, (_db, table, scope) => table.get(scope, name, revision));
  }
  replayManagedDocument(projectId: string, taskId: string | null, name: string, actor: string) {
    this.validateManagedName(taskId, name);
    return this.withManagedDocuments(projectId, taskId, (_db, table, scope) => table.replay(scope, name, actor));
  }
  managedDocumentHistory(projectId: string, taskId: string | null): DocumentVersion[] {
    return this.withManagedDocuments(projectId, taskId, (_db, table, scope) => table.history(scope));
  }
  private validateManagedName(taskId: string | null, name: string) {
    if (typeof name !== 'string' || (taskId === null ? name !== 'knowledge.md' : !managedName.test(name))) throw Error('Invalid managed document name');
  }
  writeManagedDocument(projectId: string, taskId: string | null, name: string, base: string | null, items: DocumentItemInput[], actor: string): DocumentVersion {
    this.validateManagedName(taskId, name);
    let previousMetadata: {file: string; value: TaskMetadata} | undefined;
    try {
      return this.withManagedDocuments(projectId, taskId, (db, table, scope, task) => {
        const version = table.update(scope, name, base, items, actor);
        recordManagedDocumentHistory(db, taskId, (task?.value.phase as TaskPhase | undefined) ?? null, version);
        if (task) {
          const {file, value} = task;
          writeJson(file, {...value, updatedAt: new Date(Math.max(Date.parse(value.updatedAt ?? '') || 0, version.updatedAt)).toISOString()});
          previousMetadata = task;
        }
        return version;
      });
    } catch (error) {
      if (previousMetadata) writeJson(previousMetadata.file, previousMetadata.value);
      throw error;
    }
  }
  reconcileTaskDocuments(projectId: string, taskId: string) {
    const {project, value: before} = this.scopedTask(projectId, taskId);
    const after = this.reconcileDocuments(project, taskId);
    return before.documentBaseline !== undefined && after.documentBaseline !== undefined &&
      documentContentsKey(before.documentBaseline) !== documentContentsKey(after.documentBaseline);
  }
  taskDocumentFolder(projectId: string, taskId: string) {
    return dirname(this.scopedTask(projectId, taskId).file);
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
  projectEvents(projectId: string, options: ProjectEventsOptions = {}) {
    const project = this.scopedProject(projectId);
    if (options.taskId !== undefined && !validTaskId(options.taskId)) throw Error('Invalid task scope');
    if (!options.modelPage || options.through === undefined) this.captureTaskHistory(projectId, null);
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
    if (value.phase !== expectedPhase || value.status==='completed' || target==='finalization' || value.phase==='finalization') throw Error('phase conflict');
    if(value.phase===target)return {id:value.id,project_id:projectId,name:value.name,phase:value.phase,status:value.status,createdAt:value.createdAt,updatedAt:value.updatedAt};
    return this.saveTaskTransition(project, file, value, target, value.status);
  }
  startTaskFinalization(projectId: string, taskId: string): TaskRow {
    const {project, file, value} = this.scopedTask(projectId, taskId);
    if (value.phase !== 'retrospective' || value.status !== 'idle') throw Error('phase conflict');
    return this.saveTaskTransition(project, file, value, 'finalization', 'idle');
  }
  rollbackTaskFinalization(projectId: string, taskId: string): TaskRow {
    const {project, file, value} = this.scopedTask(projectId, taskId);
    if (value.phase !== 'finalization' || value.status !== 'idle') throw Error('phase conflict');
    return this.saveTaskTransition(project, file, value, 'retrospective', 'idle');
  }
  setTaskCompleted(projectId: string, taskId: string, completed: boolean, expectedPhase?: TaskPhase): TaskRow {
    const {project, file, value} = this.scopedTask(projectId, taskId);
    if ((value.phase !== 'retrospective' && value.phase !== 'finalization') ||
        (expectedPhase !== undefined && value.phase !== expectedPhase) ||
        value.status !== (completed ? 'idle' : 'completed')) throw Error('phase conflict');
    const phase = completed ? value.phase : 'retrospective';
    return this.saveTaskTransition(project, file, value, phase, completed ? 'completed' : 'idle', completed ? 'task.completed' : 'task.reopened');
  }
  private saveTaskTransition(project: Project, file: string, value: TaskMetadata, phase: TaskPhase, status: string, event?: 'task.completed' | 'task.reopened'): TaskRow {
    const taskId = value.id, previousPhase = value.phase as TaskPhase;
    captureProjectTaskHistory(project.folder, taskId, previousPhase);
    const before = structuredClone(value);
    value.phase = phase;
    value.status = status;
    value.updatedAt = new Date(Math.max(Date.now(), (Date.parse(value.updatedAt ?? '') || 0) + 1)).toISOString();
    writeJson(file, value);
    try {
      if (phase === 'retrospective' && previousPhase !== phase) {
        withDatabase(project.folder, db => db.transaction(() => {
          const {table, scope} = this.prepareManagedDocuments(db, project, {file, value: before});
          captureManagedTaskHistory(db, taskId, phase, previousPhase, undefined, event);
          if (!table.get(scope, 'retrospective.md')) {
            const version = table.seed(scope, 'retrospective.md', retrospectiveSeed, documentTemplate);
            recordManagedDocumentHistory(db, taskId, phase, version);
          }
        }).immediate());
      } else if (phase !== previousPhase) captureProjectTaskHistory(project.folder, taskId, phase, previousPhase, undefined, event);
      else if (event) appendProjectEvent(project.folder, {type: event, taskId, phase});
    }
    catch (error) { writeJson(file, before); throw error; }
    return {id: taskId, project_id: project.id, name: value.name, phase, status, createdAt: value.createdAt, updatedAt: value.updatedAt};
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
    const staged = initialize ? path : mkdtempSync(join(root, '.creating-'));
    let created = false;
    try {
      if (initialize) {
        initialize(task);
        directory(path);
      }
      writeJson(join(staged, 'task.json'), value);
      if (staged !== path) {
        if (pathExists(path)) throw Error('Task ID collision');
        renameSync(staged, path);
      }
      created = true;
      const file = join(path, 'task.json');
      withDatabase(project.folder, db => db.transaction(() => this.prepareManagedDocuments(db, project, {file, value})).immediate());
    } catch (error) {
      rmSync(created ? path : staged, {recursive: true, force: true});
      throw error;
    }
    return task;
  }
}
