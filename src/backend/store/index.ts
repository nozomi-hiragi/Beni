import { DataBrowser } from '../data-browser';
import { AgentTable } from './agents';
import type { AgentStatus } from '../agents/agent';
import type { AgentId, RateLimitUsage } from '../../shared/agent';
import { createHash } from 'node:crypto';
import { defaultInstructions, isInstructionKey, isWorkflowUpdateTarget, taskCompletedInstructionKey, validateInstruction, type Instruction } from '../instructions';
import { initialImplementationPlan, taskDocumentSnapshot, documentContentsKey } from '../documents';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { closeSync, constants, lstatSync, openSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { validProjectId, validTaskId } from '../../shared/ids';
import { cleanDeletedTask, directory, metadata, newMetadata, recoverTaskDeletions, pathExists, writeJson, validateChatDirectory, type TaskCompletion, type TaskMetadata } from '../data';
import { taskPhases, type TaskPhase } from '../../shared/task-phase';
import { captureManagedTaskHistory, captureTaskHistory, ensureProjectIdentity, legacyProjectDatabasePath, recordManagedDocumentHistory, readProjectIdentity, readTrackedDocument, withDatabase, projectEvents, projectEvent, getProjectFileChange, getProjectFileVersion, projectTaskVersion, appendProjectEvent, insertEvent, recordTaskDeleted, type ProjectEventInput, type ProjectEventsOptions, type WorkflowEventType } from '../project-events';
import { validWorkflowJobFileStem, workflowJobHash } from '../chat-files';
import { ChatStore } from '../chat-store';
import { assertChatMigrationReady, migrateChatStorage } from '../chat-migration';
import { cleanMigratedSource, migrationVerification, stageProjectMigration, verifyMigrationSource } from './project-migration';
import { insertTaskMetadata, readTaskList, readTaskMetadata, updateTaskMetadata, validCompletion, validateDocumentBaseline } from './task-table';
import { flattenProjectDatabase, projectDatabaseMigrationStage } from './flat-project-migration';
import { migrateTaskStorage } from './task-migration';
import { DocumentTable, type DocumentItemInput, type DocumentSeed, type DocumentVersion } from '../document-table';
export { taskPhases } from '../../shared/task-phase';
export type Project = {
  id: string;
  name: string;
  folder: string;
  folderAvailable?: false;
  storageError?: string;
};

type ProjectStorage = {
  state: 'pending' | 'prepared' | 'ready';
  generation: number;
  source: string | null;
  staging: string | null;
  sourceInventory: string | null;
  verification: string | null;
};
type ProjectMetadataRow = {name: string; createdAt: string | null; updatedAt: string | null; metadata_migrated: 0 | 1};
export class ProjectFolderError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export class InstructionJobBusy extends Error {
  constructor() { super('インストラクションの更新待ち・更新中はタスクを削除できません'); }
}
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
export type InstructionJobInput = TaskCompletion & {
  projectId: string;
  taskId: string;
  eventId?: number;
};
export type InstructionJob = InstructionJobInput & {
  eventKey: typeof taskCompletedInstructionKey;
  instructionRevision: string;
  status: 'pending' | 'succeeded' | 'failed' | 'superseded';
  error?: string;
  reason?: string;
};
type InstructionJobChange = {key: string; base: string | null; items: DocumentItemInput[]};
const instructionJobColumns = 'id, project_id AS projectId, task_id AS taskId, revision, provider, model, event_id AS eventId, event_key AS eventKey, instruction_revision AS instructionRevision, status, error, reason';
type InstructionJobRow = Omit<InstructionJob, 'error' | 'reason' | 'eventId'> & {eventId: number | null; error: string | null; reason: string | null};
function instructionJobValue(row: InstructionJobRow | null): InstructionJob | undefined {
  if (!row) return undefined;
  const {error, reason, eventId, ...job} = row;
  return {...job, ...(eventId === null ? {} : {eventId}), ...(error === null ? {} : {error}), ...(reason === null ? {} : {reason})};
}
function taskFolder(root: string, taskId: string) {
  const tasks = join(root, 'tasks'), path = join(tasks, taskId);
  if (pathExists(tasks) && !lstatSync(tasks).isDirectory()) throw Error('Invalid legacy task directory');
  if (!pathExists(path)) return;
  if (!lstatSync(path).isDirectory()) throw Error('Invalid legacy task directory');
  return path;
}

function requireTask(db: Database, taskId: string) {
  const task = readTaskMetadata(db, taskId);
  if (!task) throw Error('Unknown task');
  return task;
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
function taskRow(projectId: string, {id, name, phase, status, createdAt, updatedAt}: TaskMetadata): TaskRow {
  return {id, project_id: projectId, name, phase, status, createdAt, updatedAt};
}

function recoverProjectTaskDeletions(databasePath: string, root: string, projectId: string) {
  if (!pathExists(root)) return;
  const cleanup = withDatabase(databasePath, db => db.transaction(() =>
    recoverTaskDeletions(root, projectId, (taskId, legacy) => {
      if (legacy) {
        recordTaskDeleted(db, taskId);
        db.query('DELETE FROM tasks WHERE id=?').run(taskId);
        return true;
      }
      const task = readTaskMetadata(db, taskId);
      const deleted = !!db.query("SELECT 1 FROM events WHERE task_id=? AND type='task.deleted'").get(taskId);
      if (deleted === !!task) throw Error('Conflicting task deletion journal');
      return deleted;
    })).immediate());
  // ファイルを消す前に、旧ジャーナルから補った削除イベントを確定させる。
  for (const staged of cleanup) try { cleanDeletedTask(staged); } catch { /* 次回の起動で再試行する。 */ }
}

export class Store {
  private readonly db: Database;
  private readonly instructionTable: DocumentTable;
  private readonly agentTable: AgentTable;
  private memoryDirectory?:string;
  get dataDirectory(){return this.databasePath===':memory:'?(this.memoryDirectory??=mkdtempSync(join(tmpdir(),'beni-app-'))):dirname(resolve(this.databasePath))}
  readonly chats: ChatStore;
  dataBrowser() {
    return new DataBrowser(this.dataDirectory,this.databasePath,this.databasePath === ':memory:' ? this.db : undefined);
  }
  constructor(private databasePath: string, options: {migration?:boolean} = {}) {
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,folder TEXT NOT NULL UNIQUE,
      createdAt TEXT, updatedAt TEXT, metadata_migrated INTEGER NOT NULL DEFAULT 0 CHECK(metadata_migrated IN (0,1)))`);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project_storage (
        project_id TEXT PRIMARY KEY REFERENCES projects(id), state TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        source TEXT, staging TEXT, sourceInventory TEXT, verification TEXT);
      CREATE TABLE IF NOT EXISTS instructions(key TEXT PRIMARY KEY,content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS instruction_jobs (
        ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
        revision TEXT NOT NULL, provider TEXT NOT NULL, model TEXT, status TEXT NOT NULL, error TEXT, reason TEXT,
        event_id INTEGER, event_key TEXT NOT NULL DEFAULT 'task.completed', instruction_revision TEXT);
      CREATE INDEX IF NOT EXISTS instruction_jobs_task ON instruction_jobs(project_id,task_id,ordinal);
      CREATE INDEX IF NOT EXISTS instruction_jobs_pending ON instruction_jobs(status,ordinal);`);
    this.instructionTable = new DocumentTable(this.db);
    this.db.transaction(() => {
      const projectColumns = this.db.query<{name: string}, []>('PRAGMA table_info(projects)').all();
      if (!projectColumns.some(column => column.name === 'createdAt')) this.db.exec('ALTER TABLE projects ADD COLUMN createdAt TEXT');
      if (!projectColumns.some(column => column.name === 'updatedAt')) this.db.exec('ALTER TABLE projects ADD COLUMN updatedAt TEXT');
      if (!projectColumns.some(column => column.name === 'metadata_migrated')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN metadata_migrated INTEGER NOT NULL DEFAULT 0 CHECK(metadata_migrated IN (0,1))');
      }
      const jobColumns = this.db.query<{name: string}, []>('PRAGMA table_info(instruction_jobs)').all();
      if (!jobColumns.some(column => column.name === 'reason')) this.db.exec('ALTER TABLE instruction_jobs ADD COLUMN reason TEXT');
      if (!jobColumns.some(column => column.name === 'event_id')) this.db.exec('ALTER TABLE instruction_jobs ADD COLUMN event_id INTEGER');
      if (!jobColumns.some(column => column.name === 'event_key')) this.db.exec("ALTER TABLE instruction_jobs ADD COLUMN event_key TEXT NOT NULL DEFAULT 'task.completed'");
      if (!jobColumns.some(column => column.name === 'instruction_revision')) this.db.exec('ALTER TABLE instruction_jobs ADD COLUMN instruction_revision TEXT');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS instruction_jobs_event ON instruction_jobs(project_id,event_id)');
      const legacy = this.db.query('SELECT content FROM instructions WHERE key=?');
      for (const instruction of defaultInstructions) {
        if (this.instructionTable.get(instructionScope, instruction.key)) continue;
        const old = legacy.get(instruction.key) as {content: string} | null;
        const isLegacyDefault = old && legacyInstructionHashes[instruction.key]?.includes(createHash('sha256').update(old.content).digest('hex'));
        if (old && !isLegacyDefault) this.instructionTable.seed(instructionScope, instruction.key, old.content, legacyDocument);
        else this.instructionTable.seed(instructionScope, instruction.key, instruction.content, documentTemplate);
      }
      this.db.query('UPDATE instruction_jobs SET instruction_revision=? WHERE instruction_revision IS NULL')
        .run(this.instructionDocument(taskCompletedInstructionKey)!.revision);
    }).immediate();
    this.agentTable = new AgentTable(this.db, this.databasePath === ':memory:' ? undefined : this.dataDirectory);
    this.chats = new ChatStore(this.db, this.dataDirectory);
    if (!options.migration) this.initializeStorage();
  }
  initializeStorage() {
    for (const project of this.registeredProjects()) this.initializeProjectStorage(project);
    this.chats.recoverDeletions((projectId,taskId) => {
      if (!this.registeredProject(projectId)) return false;
      if (taskId === null) return true;
      if (this.storageErrors.has(projectId)) return;
      return withDatabase(this.projectDatabasePath(projectId), db => !!readTaskMetadata(db, taskId));
    });
  }
  chatMigrationProjects(finishPrepared = false) {
    return this.registeredProjects().map(project => {
      if (this.storage(project.id)?.state === 'prepared') {
        if (!finishPrepared) throw Error('Beni を停止し、bun src/backend/migrate-chats.ts を実行してください。');
        this.migrateProject(project);
      }
      const state = this.storage(project.id);
      const directory = this.legacyProjectDirectory(project.id), databasePath = this.flatDatabasePath(project.id);
      return {projectId:project.id,directory,
        ...(pathExists(databasePath) ? {databasePath} : {}),
        ...(state?.state === 'ready' ? {} : {legacyDirectory:join(project.folder,'.beni')})};
    });
  }
  registerAgents(agents: readonly {id:string;name:string}[]) { this.agentTable.registerAgents(agents); }
  agentStatus(id: AgentId) { return this.agentTable.agentStatus(id); }
  saveAgentStatus(id: AgentId, status: AgentStatus) { this.agentTable.saveAgentStatus(id,status); }
  invalidateAgentStatus(id: AgentId) { this.agentTable.invalidateAgentStatus(id); }
  agentUsage(id: AgentId) { return this.agentTable.agentUsage(id); }
  saveAgentUsage(id: AgentId, identity: string, usage: RateLimitUsage) { this.agentTable.saveAgentUsage(id,identity,usage); }
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
    if (!validProjectId(job.projectId) || !validTaskId(job.taskId) || !validCompletion(job) ||
        job.eventId !== undefined && (!Number.isSafeInteger(job.eventId) || job.eventId < 1)) throw Error('Invalid instruction job');
    return this.db.transaction(() => {
      const previous = this.instructionJobById(job.id);
      if (previous) {
        if (previous.projectId !== job.projectId || previous.taskId !== job.taskId || previous.revision !== job.revision ||
            previous.provider !== job.provider || previous.model !== job.model ||
            job.eventId !== undefined && previous.eventId !== undefined && previous.eventId !== job.eventId) throw Error('Conflicting instruction job');
        if (job.eventId !== undefined && previous.eventId === undefined) {
          this.db.query('UPDATE instruction_jobs SET event_id=? WHERE id=?').run(job.eventId, job.id);
          return {...previous, eventId: job.eventId};
        }
        return previous;
      }
      this.db.query("UPDATE instruction_jobs SET status='superseded' WHERE project_id=? AND task_id=? AND status='pending'").run(job.projectId, job.taskId);
      this.db.query("INSERT INTO instruction_jobs(id,project_id,task_id,revision,provider,model,status,event_id,event_key,instruction_revision) VALUES (?,?,?,?,?,?,'pending',?,?,?)").run(
        job.id, job.projectId, job.taskId, job.revision, job.provider, job.model, job.eventId ?? null, taskCompletedInstructionKey,
        this.instructionDocument(taskCompletedInstructionKey)!.revision);
      return this.instructionJobById(job.id)!;
    }).immediate();
  }
  pendingInstructionJob(availableOnly = false) {
    const pending = this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE status='pending' ORDER BY ordinal`);
    if (!availableOnly) return instructionJobValue(pending.get() as InstructionJobRow | null);
    for (const row of pending.all() as InstructionJobRow[]) {
      if (this.canRunProject(row.projectId) && this.legacyInstructionJobReady(row)) return instructionJobValue(row);
    }
  }
  private legacyInstructionJobReady(job: InstructionJobRow) {
    if (job.eventId !== null) return true;
    const databasePath = this.projectDatabasePath(job.projectId);
    const value = withDatabase(databasePath, db => readTaskMetadata(db, job.taskId));
    if (value?.phase !== 'finalization' || value.status !== 'idle') return true;
    // 旧実装は完了前に登録したため、終了フェーズの復旧で完了が確定するまで待つ。
    const chatId = this.chats.resolve({projectId:job.projectId,taskId:job.taskId,phase:'finalization'},job.id)?.chatId ?? job.id;
    return withDatabase(databasePath, db => !db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_knowledge_completion'").get() ||
      !db.query('SELECT 1 FROM document_knowledge_completion WHERE task_id=? AND chat_id=?').get(job.taskId, chatId));
  }
  private instructionJobById(id: string) {
    return instructionJobValue(this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE id=?`).get(id) as InstructionJobRow | null);
  }
  workflowJobEvent(projectId: string, jobId: string) {
    const job = this.instructionJobById(jobId);
    if (job?.projectId !== projectId || job.eventKey !== taskCompletedInstructionKey) {
      throw Object.assign(new Error('Unknown workflow job'), {code: 'ENOENT'});
    }
    return job.eventKey;
  }
  private workflowJobChatTarget(root: string, projectId: string) {
    const jobs = this.db.query<{id: string; taskId: string}, [string]>(
      'SELECT id, task_id AS taskId FROM instruction_jobs WHERE project_id=?'
    ).all(projectId);
    const byHash = new Map(jobs.map(job => [workflowJobHash(job.id), job]));
    const byId = new Map(jobs.map(job => [job.id, job]));
    return (stem: string, hashed: boolean, legacyTaskId?: string) => {
      const job = (hashed ? byHash : byId).get(stem);
      if (!job) return;
      if (legacyTaskId !== undefined && validWorkflowJobFileStem(job.id) &&
          (job.taskId !== legacyTaskId || !this.legacyWorkflowTaskExists(root, legacyTaskId))) {
        throw Error('Invalid workflow job task scope');
      }
      return {taskId: job.taskId, jobId: job.id};
    };
  }
  private legacyWorkflowTaskExists(root: string, taskId: string) {
    const folder = taskFolder(root, taskId);
    const file = folder && join(folder, 'task.json');
    if (file && pathExists(file)) {
      if (metadata(file, 'task').id !== taskId) throw Error('Task directory ID mismatch');
      return true;
    }
    return withDatabase(legacyProjectDatabasePath(root), db => !!readTaskMetadata(db, taskId));
  }
  instructionJob(projectId: string, taskId: string) {
    if (!validProjectId(projectId) || !validTaskId(taskId)) throw Error('Invalid instruction job scope');
    return instructionJobValue(this.db.query(`SELECT ${instructionJobColumns} FROM instruction_jobs WHERE project_id=? AND task_id=? ORDER BY ordinal DESC LIMIT 1`).get(projectId, taskId) as InstructionJobRow | null);
  }
  recordInstructionJobEvent(job: InstructionJob, type: WorkflowEventType, attemptId: string) {
    const {id, projectId, taskId, eventKey, eventId} = job;
    const chatId = this.chats.current({projectId, taskId: null, phase: null, workflowJobId: id})?.chatId ?? null;
    return this.recordProjectEvent(projectId, {
      type, taskId, chatId,
      details: {workflowJobId: id, eventKey, triggerEventId: eventId ?? null, attemptId}
    });
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
      for (const {key, base, items} of changes) {
        if (!isWorkflowUpdateTarget(key)) throw Error('このインストラクションはワークフローから編集できません');
        this.writeInstructionDocument(key, base, items, id);
      }
      this.db.query("UPDATE instruction_jobs SET status='succeeded', error=NULL, reason=? WHERE id=?").run(reason ?? null, id);
      return this.instructionJobById(id)!;
    }).immediate();
  }
  close() {
    this.db.close();
    if(this.memoryDirectory)rmSync(this.memoryDirectory,{recursive:true,force:true});
  }
  private readonly storageErrors = new Map<string, string>();
  private registeredProjects() {
    return this.db.query('SELECT id,name,folder FROM projects ORDER BY id DESC').all() as Project[];
  }
  private registeredProject(id: string) {
    return this.db.query('SELECT id,name,folder FROM projects WHERE id=?').get(id) as Project | null;
  }
  private storage(id: string) {
    return this.db.query('SELECT * FROM project_storage WHERE project_id=?').get(id) as ProjectStorage | null;
  }
  private projectStorageParent(id: string) {
    if (!validProjectId(id)) throw Error('Invalid project');
    return directory(join(this.dataDirectory, 'projects'));
  }
  legacyProjectDirectory(id: string) {
    const path = join(this.projectStorageParent(id), id);
    if (pathExists(path) && !lstatSync(path).isDirectory()) throw Error('Invalid legacy project directory');
    return path;
  }
  private flatDatabasePath(id: string) {
    return join(this.projectStorageParent(id), `${id}.sqlite`);
  }
  private requireFlatProjectDatabase(id: string) {
    const root = this.legacyProjectDirectory(id), path = this.flatDatabasePath(id);
    if (pathExists(projectDatabaseMigrationStage(path)) || ['project.sqlite', 'events.sqlite'].some(name =>
      ['', '-wal', '-shm', '-journal'].some(suffix => pathExists(join(root, name + suffix))))) {
      throw new ProjectFolderError(409, '旧プロジェクト DB の移行が必要です。Beni を停止し、bun src/backend/migrate-projects.ts を実行してください。');
    }
    if (readProjectIdentity(path) !== id) throw Error('Project ID mismatch');
    return path;
  }
  projectDatabasePath(id: string) {
    if (!validProjectId(id) || this.storage(id)?.state !== 'ready') throw Error('Project storage unavailable');
    return this.requireFlatProjectDatabase(id);
  }
  migrateProjectDatabases() {
    let migrated = 0;
    for (const project of this.registeredProjects()) {
      if (this.migrateProject(project, true)) migrated++;
    }
    return {migrated};
  }
  projectFolderGeneration(id: string) {
    return this.storage(id)?.generation ?? 0;
  }
  canRunProject(id: string) {
    const project = this.registeredProject(id);
    if (!project || this.storageErrors.has(id) || this.storage(id)?.state !== 'ready' || !this.folderAvailable(project.folder)) return false;
    try { this.projectDatabasePath(id); return true; } catch { return false; }
  }
  workingFolder(id: string) {
    const project = this.registeredProject(id);
    if (!project || !this.canRunProject(id)) throw new ProjectFolderError(409, '作業フォルダーと保存データを確認してください');
    return project.folder;
  }
  private folderAvailable(path: string) {
    try { return lstatSync(path).isDirectory(); } catch { return false; }
  }
  private normalizeWorkingFolder(folder: unknown) {
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new ProjectFolderError(400, '作業フォルダーの絶対パスを指定してください');
    try {
      const path = resolve(folder);
      if (!lstatSync(path).isDirectory()) throw Error('Invalid project directory');
      return realpathSync(path);
    } catch { throw new ProjectFolderError(400, '実在する作業フォルダーを指定してください'); }
  }
  private legacyRoot(folder: string) {
    const path = join(folder, '.beni');
    return pathExists(path) ? directory(path) : undefined;
  }
  private initializeProjectStorage(project: Project, importChats = false) {
    try {
      this.migrateProject(project);
      const databasePath = this.projectDatabasePath(project.id), root = this.legacyProjectDirectory(project.id);
      if (importChats) migrateChatStorage(this.chats, this.dataDirectory, [{projectId:project.id,directory:root,databasePath}]);
      recoverProjectTaskDeletions(databasePath, root, project.id);
      migrateTaskStorage(databasePath, root, project.id, this.chats, {importJson: importChats});
      this.cleanLegacyProjectSource(project.id);
      this.storageErrors.delete(project.id);
      for (const task of withDatabase(databasePath, readTaskList)) {
        if (task.pendingCompletion) this.recoverTaskCompletion(project.id, task.id);
      }
    } catch (error) {
      this.storageErrors.set(project.id, error instanceof ProjectFolderError || error instanceof Error && error.message.startsWith('旧タスクの移行が必要です。')
        ? error.message : '保存データの移行を確認できませんでした');
    }
  }
  migrateTasks() {
    const totals = {migrated: 0, removed: 0};
    assertChatMigrationReady(this.chats, this.dataDirectory, this.chatMigrationProjects(true));
    const owners = new Set<string>();
    const projects = this.registeredProjects().map(project => {
      this.migrateProject(project);
      const databasePath = this.projectDatabasePath(project.id), root = this.legacyProjectDirectory(project.id);
      recoverProjectTaskDeletions(databasePath, root, project.id);
      const ids = new Set(withDatabase(databasePath, db => db.query<{id: string}, []>('SELECT id FROM tasks').all().map(row => row.id)));
      const folders = join(root, 'tasks');
      if (pathExists(folders)) {
        for (const id of readdirSync(directory(folders)).filter(validTaskId)) {
          const folder = taskFolder(root, id)!;
          if (pathExists(join(folder, 'task.json'))) ids.add(id);
        }
      }
      for (const id of ids) {
        if (owners.has(id)) throw Error('Duplicate task ID');
        owners.add(id);
      }
      return {project, databasePath, root};
    });
    for (const {project, databasePath, root} of projects) {
      const result = migrateTaskStorage(databasePath, root, project.id, this.chats, {importJson: true});
      totals.migrated += result.migrated;
      totals.removed += result.removed;
      this.cleanLegacyProjectSource(project.id);
    }
    return totals;
  }
  private migrateProject(project: Project, flattenCentral = false) {
    const id = project.id, destination = this.legacyProjectDirectory(id), databasePath = this.flatDatabasePath(id);
    let state = this.storage(id);
    const importing = state?.state !== 'ready';
    if (importing) {
      if (pathExists(databasePath)) throw new ProjectFolderError(409, '集約先に別の保存データがあります');
      const parent = dirname(destination);
      if (state?.staging && !/^\.migration-[A-Za-z0-9-]+$/.test(state.staging)) throw Error('Invalid migration record');
      if (state?.state !== 'prepared') {
        if (pathExists(destination)) throw new ProjectFolderError(409, '集約先に別の保存データがあります');
        if (!this.folderAvailable(project.folder)) throw new ProjectFolderError(409, '移行元が見つかりません');
        const source = this.legacyRoot(project.folder);
        if (!source || !pathExists(join(source, 'project.json'))) throw new ProjectFolderError(409, '移行元が見つかりません');
        if (state?.staging) {
          const interrupted = join(parent, state.staging);
          if (pathExists(interrupted)) rmSync(directory(interrupted), {recursive: true});
        }
        const staging = `.migration-${crypto.randomUUID()}`, stage = join(parent, staging);
        this.db.query(`INSERT INTO project_storage(project_id,state,source,staging) VALUES (?,'pending',?,?)
          ON CONFLICT(project_id) DO UPDATE SET source=excluded.source,staging=excluded.staging`).run(id, source, staging);
        mkdirSync(stage, {mode: 0o700});
        let prepared = false;
        try {
          const {sourceInventory, verification} = stageProjectMigration(source, stage, id, this.workflowJobChatTarget(stage, id));
          this.db.query("UPDATE project_storage SET state='prepared',sourceInventory=?,verification=? WHERE project_id=?")
            .run(sourceInventory, verification, id);
          prepared = true;
        } finally {
          if (!prepared) rmSync(stage, {recursive: true, force: true});
        }
        state = this.storage(id);
      }
      if (!state?.staging || !state.source || !state.sourceInventory || !state.verification) throw Error('Invalid migration record');
      const stage = join(parent, state.staging), installed = pathExists(destination);
      if (installed && pathExists(stage)) throw new ProjectFolderError(409, '集約先に別の保存データがあります');
      const candidate = installed ? destination : stage;
      if (!pathExists(candidate) || migrationVerification(candidate) !== state.verification) throw new ProjectFolderError(409, '集約先の検証結果が一致しません');
      const source = state.source, relocated = join(project.folder, '.beni');
      const originalMatches = this.folderAvailable(dirname(source)) && verifyMigrationSource(source, state.sourceInventory);
      const verifiedSource = originalMatches ? source :
        relocated !== source && this.folderAvailable(project.folder) && verifyMigrationSource(relocated, state.sourceInventory) ? relocated : null;
      if (!verifiedSource) throw new ProjectFolderError(409, '検証後に移行元が変更されました');
      if (!installed) renameSync(stage, destination);
      this.db.query("UPDATE project_storage SET state='ready',source=?,staging=NULL,verification=NULL WHERE project_id=?").run(verifiedSource, id);
    }
    const migrated = (importing || flattenCentral) && this.db.transaction(() =>
      flattenProjectDatabase(destination, databasePath, id)).immediate();
    this.requireFlatProjectDatabase(id);
    this.migrateProjectMetadata(destination, databasePath, id);
    return migrated;
  }
  private cleanLegacyProjectSource(id: string) {
    const state = this.storage(id);
    if (state?.source && state.sourceInventory) {
      try {
        if (!this.folderAvailable(dirname(state.source))) return;
        if (cleanMigratedSource(state.source, state.sourceInventory)) this.db.query('UPDATE project_storage SET source=NULL,sourceInventory=NULL WHERE project_id=?').run(id);
      } catch { /* 正本は確定済み。旧ファイルの掃除は次の起動時に再試行する。 */ }
    }
  }
  private migrateProjectMetadata(root: string, databasePath: string, id: string) {
    const file = join(root, 'project.json');
    const before = pathExists(file) ? lstatSync(file) : undefined;
    const legacy = before && metadata(file, 'project');
    const identity = readProjectIdentity(databasePath);
    if (legacy && legacy.id !== id || identity !== undefined && identity !== id) throw Error('Project ID mismatch');
    const get = this.db.query<ProjectMetadataRow, [string]>('SELECT name,createdAt,updatedAt,metadata_migrated FROM projects WHERE id=?');
    const current = get.get(id)!;
    if (!current.metadata_migrated) {
      if (!legacy) throw Error('Missing legacy project metadata');
      ensureProjectIdentity(databasePath, id);
      this.db.query('UPDATE projects SET name=?,createdAt=?,updatedAt=?,metadata_migrated=1 WHERE id=? AND metadata_migrated=0')
        .run(legacy.name, legacy.createdAt, legacy.updatedAt, id);
    }
    if (!legacy) return;
    const saved = get.get(id)!;
    if (!saved.metadata_migrated || saved.name !== legacy.name || saved.createdAt !== legacy.createdAt ||
        saved.updatedAt !== legacy.updatedAt || readProjectIdentity(databasePath) !== id) throw Error('Conflicting project metadata');
    const after = lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw Error('Project metadata changed during migration');
    }
    unlinkSync(file);
    if (!readdirSync(root).length) rmdirSync(root);
  }
  project(id: string): Project | undefined {
    if (!validProjectId(id)) return;
    const row = this.registeredProject(id);
    if (!row) return;
    if (!this.folderAvailable(row.folder)) row.folderAvailable = false;
    try {
      this.projectDatabasePath(id);
      if (this.storageErrors.has(id)) row.storageError = this.storageErrors.get(id);
    } catch {
      row.storageError = this.storageErrors.get(id) ?? '保存データを読み込めませんでした';
    }
    return row;
  }
  projects(): Project[] {
    return this.registeredProjects().map(({id, ...row}) => this.project(id) ?? {...row, id, storageError: 'プロジェクト ID が無効です'});
  }
  private checkFolderConflict(id: string, folder: string) {
    for (const other of this.registeredProjects()) {
      if (other.id === id) continue;
      let registered = other.folder;
      try { registered = realpathSync(registered); } catch { /* 消失済みでも登録パスを確認する。 */ }
      if (registered === folder) throw new ProjectFolderError(409, 'この作業フォルダーは別のプロジェクトに登録済みです');
    }
  }
  changeProjectFolder(id: string, folder: unknown): Project {
    const project = this.registeredProject(id);
    if (!validProjectId(id) || !project) throw new ProjectFolderError(404, 'プロジェクトが見つかりません');
    const normalized = this.normalizeWorkingFolder(folder);
    this.checkFolderConflict(id, normalized);
    const legacy = this.legacyRoot(normalized), file = legacy && join(legacy, 'project.json');
    const old = file && pathExists(file) ? metadata(file, 'project') : undefined;
    const oldId = old?.id ?? (legacy && readProjectIdentity(join(legacy, 'project.sqlite')));
    if (oldId && oldId !== id) throw new ProjectFolderError(409, '移行元のプロジェクト ID が一致しません');
    if (this.storage(id)?.state !== 'ready') {
      if (!old && this.storage(id)?.state !== 'prepared') throw new ProjectFolderError(409, '同じプロジェクト ID の移行元を指定してください');
      this.initializeProjectStorage({...project, folder: normalized}, true);
      const error = this.storageErrors.get(id);
      if (error) throw new ProjectFolderError(409, error);
    }
    if (project.folder !== normalized) this.db.transaction(() => {
      const previous = this.db.query<{updatedAt: string | null}, [string]>('SELECT updatedAt FROM projects WHERE id=?').get(id)?.updatedAt;
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(previous ?? '') || 0) + 1)).toISOString();
      this.db.query('UPDATE projects SET folder=?,updatedAt=? WHERE id=?').run(normalized, updatedAt, id);
      this.db.query('UPDATE project_storage SET generation=generation+1 WHERE project_id=?').run(id);
    }).immediate();
    return this.project(id)!;
  }
  createProject(name: string, folder: string): Project {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const normalized = this.normalizeWorkingFolder(folder);
    const legacy = this.legacyRoot(normalized), file = legacy && join(legacy, 'project.json');
    const existing = file && pathExists(file) ? metadata(file, 'project') : undefined;
    const existingId = existing?.id ?? (legacy && readProjectIdentity(join(legacy, 'project.sqlite')));
    if (existingId && this.registeredProject(existingId)) throw new ProjectFolderError(409, 'Duplicate live project copy. 作業フォルダーを変更してください');
    if (legacy && !existing) throw new ProjectFolderError(409, '旧保存データのプロジェクト ID を確認できません');
    const data = existing ?? newMetadata('project', name.trim());
    this.checkFolderConflict(data.id, normalized);
    if (existing) {
      this.db.query('INSERT INTO projects(id,name,folder) VALUES (?,?,?)').run(data.id, data.name, normalized);
      this.initializeProjectStorage({id: data.id, name: data.name, folder: normalized}, true);
      const error = this.storageErrors.get(data.id);
      if (error) throw new ProjectFolderError(409, error);
    } else {
      const databasePath = this.flatDatabasePath(data.id);
      if (pathExists(this.legacyProjectDirectory(data.id)) || pathExists(projectDatabaseMigrationStage(databasePath)) ||
          ['-wal', '-shm', '-journal'].some(suffix => pathExists(databasePath + suffix))) throw Error('Project ID collision');
      closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
      try {
        ensureProjectIdentity(databasePath, data.id);
        this.db.transaction(() => {
          this.db.query('INSERT INTO projects(id,name,folder,createdAt,updatedAt,metadata_migrated) VALUES (?,?,?,?,?,1)')
            .run(data.id, data.name, normalized, data.createdAt, data.updatedAt);
          this.db.query("INSERT INTO project_storage(project_id,state) VALUES (?,'ready')").run(data.id);
        }).immediate();
      } catch (error) {
        unlinkSync(databasePath);
        throw error;
      }
    }
    return this.project(data.id)!;
  }
  tasks(projectId?: string, reconcile = true): TaskRow[] {
    if (projectId !== undefined && !validProjectId(projectId)) throw Error('Invalid project');
    const projects = this.projects().filter(p => !p.storageError && (projectId === undefined || p.id === projectId));
    return projects.flatMap(project => {
      const root = this.legacyProjectDirectory(project.id);
      return withDatabase(this.projectDatabasePath(project.id), db => db.transaction(() => readTaskList(db).map(value =>
        taskRow(project.id, reconcile ? this.reconcileDocuments(db, root, value) : value))).immediate());
    }).sort((a, b) => b.id.localeCompare(a.id));
  }
  task(id: string): TaskRow | null {
    if (!validTaskId(id)) throw Error('Invalid task');
    let found: TaskRow | null = null;
    for (const project of this.projects()) {
      if (project.storageError) continue;
      const value = withDatabase(this.projectDatabasePath(project.id), db => readTaskMetadata(db, id));
      if (!value) continue;
      if (found) throw Error('Duplicate task ID');
      found = taskRow(project.id, value);
    }
    return found;
  }
  // 文書の内容を比較する。初回は基準だけを保存し、移行・復元日時を活動にしない。
  private reconcileDocuments(db: Database, root: string, value: TaskMetadata) {
    if (db.query('SELECT 1 FROM managed_document_scopes WHERE scope=?').get(value.id)) return value;
    const folder = taskFolder(root, value.id);
    const baseline = folder ? taskDocumentSnapshot(folder) : {};
    const previous = value.documentBaseline;
    validateDocumentBaseline(previous);
    const changed = Object.keys(baseline).filter(name => previous && previous[name]?.hash !== baseline[name]!.hash);
    const removed = previous && Object.keys(previous).some(name => !(name in baseline));
    if (previous && (changed.length || removed)) {
      // 変更時刻が保存されている編集はその時刻を使う。削除・時刻保存編集は検出時刻になる。
      const time = removed || changed.some(name => (previous[name]?.modifiedAt ?? -Infinity) >= baseline[name]!.modifiedAt)
        ? Date.now() : Math.max(...changed.map(name => baseline[name]!.modifiedAt));
      value.updatedAt = new Date(Math.max(Date.parse(value.updatedAt ?? '') || 0, time)).toISOString();
    }
    if (JSON.stringify(previous) !== JSON.stringify(baseline)) {
      value.documentBaseline = baseline;
      updateTaskMetadata(db, value);
    }
    captureTaskHistory(db, root, value.id, value.phase);
    return value;
  }
  private withTask<T>(projectId: string, taskId: string, operation: (db: Database, root: string, task: TaskMetadata) => T) {
    if (!validTaskId(taskId)) throw Error('Invalid task scope');
    const databasePath = this.scopedProjectDatabase(projectId), root = this.legacyProjectDirectory(projectId);
    return withDatabase(databasePath, db => db.transaction(() => operation(db, root, requireTask(db, taskId))).immediate());
  }
  private prepareManagedDocuments(db: Database, root: string, task: TaskMetadata | null) {
    const scope = task?.id ?? knowledgeScope;
    const table = new DocumentTable(db);
    if (db.query('SELECT 1 FROM managed_document_scopes WHERE scope=?').get(scope)) return {scope, table};

    const documents = new Map<string, {content: string; seed: DocumentSeed}>();
    if (task) {
      for (const {name, content, seed} of taskSeeds(task.name)) documents.set(name, {content, seed});
      if (task.phase === 'retrospective' || task.phase === 'finalization') {
        documents.set('retrospective.md', {content: retrospectiveSeed, seed: documentTemplate});
      }
      const folder = taskFolder(root, task.id);
      if (folder) for (const name of readdirSync(folder).filter(name => managedName.test(name)).sort()) {
        documents.set(name, {content: readTrackedDocument(join(folder, name)).toString('utf8'), seed: legacyDocument});
      }
      captureManagedTaskHistory(db, task.id, task.phase);
    } else {
      const path = join(root, 'knowledge.md');
      documents.set('knowledge.md', pathExists(path)
        ? {content: readTrackedDocument(path).toString('utf8'), seed: legacyDocument}
        : {content: '# プロジェクトの学び\n', seed: documentTemplate});
    }
    for (const [name, {content, seed}] of documents) {
      const version = table.seed(scope, name, content, seed);
      recordManagedDocumentHistory(db, task?.id ?? null, (task?.phase as TaskPhase | undefined) ?? null, version, true);
    }
    db.query('INSERT INTO managed_document_scopes(scope) VALUES (?)').run(scope);
    return {scope, table};
  }
  private withManagedDocuments<T>(projectId: string, taskId: string | null, operation: (db: Database, table: DocumentTable, scope: string, task: TaskMetadata | null) => T) {
    const run = (db: Database, root: string, task: TaskMetadata | null) => {
      const {table, scope} = this.prepareManagedDocuments(db, root, task);
      return operation(db, table, scope, task);
    };
    if (taskId !== null) return this.withTask(projectId, taskId, run);
    const databasePath = this.scopedProjectDatabase(projectId), root = this.legacyProjectDirectory(projectId);
    return withDatabase(databasePath, db => db.transaction(() => run(db, root, null)).immediate());
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
    return this.withManagedDocuments(projectId, taskId, (db, table, scope, task) => {
      const version = table.update(scope, name, base, items, actor);
      recordManagedDocumentHistory(db, taskId, (task?.phase as TaskPhase | undefined) ?? null, version);
      if (task) {
        task.updatedAt = new Date(Math.max(Date.parse(task.updatedAt ?? '') || 0, version.updatedAt)).toISOString();
        updateTaskMetadata(db, task);
      }
      return version;
    });
  }
  reconcileTaskDocuments(projectId: string, taskId: string) {
    return this.withTask(projectId, taskId, (db, root, value) => {
      const before = value.documentBaseline;
      const after = this.reconcileDocuments(db, root, value).documentBaseline;
      return before !== undefined && after !== undefined && documentContentsKey(before) !== documentContentsKey(after);
    });
  }
  touchTask(projectId: string, taskId: string) {
    this.withTask(projectId, taskId, (db, _root, task) => {
      task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt ?? '') || 0)).toISOString();
      updateTaskMetadata(db, task);
    });
  }
  renameTask(projectId: string, taskId: string, name: string): TaskRow {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    return this.withTask(projectId, taskId, (db, _root, task) => {
      if (task.name === name.trim()) return taskRow(projectId, task);
      const previousName = task.name;
      task.name = name.trim();
      task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt ?? '') || 0)).toISOString();
      updateTaskMetadata(db, task);
      insertEvent(db, {type: 'task.renamed', taskId, phase: task.phase as TaskPhase, details: {previousName, name: task.name}});
      return taskRow(projectId, task);
    });
  }
  // 削除済みタスクの履歴もプロジェクトのスコープで参照する。
  private scopedProjectDatabase(projectId: string) {
    if (!validProjectId(projectId)) throw Error('Invalid project');
    if (!this.registeredProject(projectId)) throw Error('Unknown project');
    if (this.storageErrors.has(projectId)) throw Error('Project storage unavailable');
    return this.projectDatabasePath(projectId);
  }
  captureTaskHistory(projectId: string, taskId: string | null, sourcePhase: TaskPhase | null = null, operationId?: string) {
    if (taskId !== null) return this.withTask(projectId, taskId, (db, root, task) => {
      captureTaskHistory(db, root, task.id, task.phase, sourcePhase, operationId);
    });
    const databasePath = this.scopedProjectDatabase(projectId), root = this.legacyProjectDirectory(projectId);
    withDatabase(databasePath, db => db.transaction(() => {
      for (const task of readTaskList(db)) captureTaskHistory(db, root, task.id, task.phase, sourcePhase, operationId);
    }).immediate());
  }
  projectEvents(projectId: string, options: ProjectEventsOptions = {}) {
    const databasePath = this.scopedProjectDatabase(projectId);
    if (options.taskId !== undefined && !validTaskId(options.taskId)) throw Error('Invalid task scope');
    if (!options.modelPage || options.through === undefined) this.captureTaskHistory(projectId, null);
    return projectEvents(databasePath, options);
  }
  projectEventCursor(projectId: string) {
    return projectEvents(this.projectDatabasePath(projectId), {limit: 1}).through;
  }
  projectEvent(projectId: string, eventId: number) {
    return projectEvent(this.projectDatabasePath(projectId), eventId);
  }
  projectFileChange(projectId: string, eventId: number) {
    return getProjectFileChange(this.projectDatabasePath(projectId), eventId);
  }
  projectFileVersion(projectId: string, path: string, changeId: number) {
    return getProjectFileVersion(this.projectDatabasePath(projectId), path, changeId);
  }
  recordProjectEvent(projectId: string, event: ProjectEventInput) {
    return appendProjectEvent(this.projectDatabasePath(projectId), event);
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
    return projectTaskVersion(this.projectDatabasePath(projectId), taskId, version);
  }
  selectTaskPhase(projectId: string, taskId: string, expectedPhase: string, target: TaskPhase): TaskRow {
    if (!taskPhases.includes(target)) throw Error('invalid phase');
    return this.withTask(projectId, taskId, (db, root, task) => {
      if (task.phase !== expectedPhase || task.status === 'completed' || target === 'finalization' || task.phase === 'finalization') throw Error('phase conflict');
      if (task.phase !== target) this.saveTaskTransition(db, root, task, target, task.status);
      return taskRow(projectId, task);
    });
  }
  startTaskFinalization(projectId: string, taskId: string): TaskRow {
    return this.withTask(projectId, taskId, (db, root, task) => {
      if (task.phase !== 'retrospective' || task.status !== 'idle') throw Error('phase conflict');
      this.saveTaskTransition(db, root, task, 'finalization', 'idle');
      return taskRow(projectId, task);
    });
  }
  rollbackTaskFinalization(projectId: string, taskId: string): TaskRow {
    return this.withTask(projectId, taskId, (db, root, task) => {
      if (task.phase !== 'finalization' || task.status !== 'idle') throw Error('phase conflict');
      this.saveTaskTransition(db, root, task, 'retrospective', 'idle');
      return taskRow(projectId, task);
    });
  }
  setTaskCompleted(projectId: string, taskId: string, completed: boolean, expectedPhase?: TaskPhase, completion?: TaskCompletion): TaskRow {
    if (!completed) this.recoverTaskCompletion(projectId, taskId);
    const result = this.withTask(projectId, taskId, (db, root, task) => {
      if ((task.phase !== 'retrospective' && task.phase !== 'finalization') ||
          (expectedPhase !== undefined && task.phase !== expectedPhase) ||
          task.status !== (completed ? 'idle' : 'completed')) throw Error('phase conflict');
      if (completion && (!completed || task.phase !== 'finalization' || !validCompletion(completion))) throw Error('Invalid workflow completion');
      if (task.pendingCompletion) throw new InstructionJobBusy();
      const phase = completed ? task.phase : 'retrospective';
      const event = completion ? undefined : completed ? 'task.completed' : 'task.reopened';
      if (completion) task.pendingCompletion = completion;
      this.saveTaskTransition(db, root, task, phase, completed ? 'completed' : 'idle', event);
      if (completion) this.recordTaskCompletion(db, taskId, completion);
      return taskRow(projectId, task);
    });
    // 状態・イベント・登録入力を先に確定する。登録失敗時は同じ完了回を再試行する。
    if (completion) this.recoverTaskCompletion(projectId, taskId);
    return result;
  }
  private recordTaskCompletion(db: Database, taskId: string, completion: TaskCompletion) {
    return insertEvent(db, {
      type: taskCompletedInstructionKey, taskId, phase: 'finalization', operationId: completion.id, chatId: completion.chatId ?? completion.id
    }).id;
  }
  recoverTaskCompletion(projectId: string, taskId: string) {
    const pending = this.withTask(projectId, taskId, (db, _root, task) => {
      const completion = task.pendingCompletion;
      if (completion === undefined) return;
      if (task.phase !== 'finalization' || task.status !== 'completed' || !validCompletion(completion)) throw Error('Invalid pending workflow completion');
      // 旧版は完了状態の保存とイベント追加の間で中断することがある。
      return {completion, eventId: this.recordTaskCompletion(db, taskId, completion)};
    });
    if (!pending) return false;
    try {
      this.enqueueInstructionJob({...pending.completion, projectId, taskId, eventId: pending.eventId});
    } catch {
      return false;
    }
    try {
      this.withTask(projectId, taskId, (db, _root, task) => {
        if (task.pendingCompletion?.id === pending.completion.id) {
          delete task.pendingCompletion;
          updateTaskMetadata(db, task);
        }
      });
    } catch { /* 登録を照合して次回に復旧情報を取り除く。 */ }
    return true;
  }
  private saveTaskTransition(db: Database, root: string, task: TaskMetadata, phase: TaskPhase, status: string, event?: 'task.completed' | 'task.reopened') {
    const taskId = task.id, previousPhase = task.phase as TaskPhase;
    captureTaskHistory(db, root, taskId, previousPhase);
    if (phase === 'retrospective' && previousPhase !== phase) {
      const {table, scope} = this.prepareManagedDocuments(db, root, task);
      captureManagedTaskHistory(db, taskId, phase, previousPhase, undefined, event);
      if (!table.get(scope, 'retrospective.md')) {
        const version = table.seed(scope, 'retrospective.md', retrospectiveSeed, documentTemplate);
        recordManagedDocumentHistory(db, taskId, phase, version);
      }
    } else if (phase !== previousPhase) captureTaskHistory(db, root, taskId, phase, previousPhase, undefined, event);
    else if (event) insertEvent(db, {type: event, taskId, phase});
    task.phase = phase;
    task.status = status;
    task.updatedAt = new Date(Math.max(Date.now(), (Date.parse(task.updatedAt ?? '') || 0) + 1)).toISOString();
    updateTaskMetadata(db, task);
  }
  advanceTaskPhase(projectId: string, taskId: string, expectedPhase: string, direction: 'next' | 'back' = 'next'): TaskRow {
    const index = taskPhases.indexOf(expectedPhase as TaskPhase);
    if (index < 0) throw Error('invalid phase');
    if (direction !== 'next' && direction !== 'back') throw Error('invalid direction');
    const next = index + (direction === 'next' ? 1 : -1);
    if (next < 0 || next >= taskPhases.length) throw Error('phase conflict');
    return this.selectTaskPhase(projectId,taskId,expectedPhase,taskPhases[next]!);
  }

  deleteTask(projectId: string, taskId: string) {
    this.recoverTaskCompletion(projectId, taskId);
    let staged: string | undefined, prepared = false;
    try {
      this.withTask(projectId, taskId, (db, root, task) => {
        if (task.pendingCompletion || this.db.query("SELECT 1 FROM instruction_jobs WHERE project_id=? AND task_id=? AND status='pending' LIMIT 1").get(projectId, taskId)) throw new InstructionJobBusy();
        const folder = taskFolder(root, taskId), chatRoot = join(root, 'chat');
        if (pathExists(chatRoot)) directory(chatRoot);
        const chat = join(chatRoot, `${taskId}.json`), hasChat = pathExists(chat);
        if (hasChat) {
          const stat = lstatSync(chat);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('Invalid chat file');
        }
        if (folder) validateChatDirectory(folder);
        captureTaskHistory(db, root, taskId, task.phase);
        this.chats.prepareDeletion(projectId,taskId);
        prepared = true;
        if (folder || hasChat) {
          const stage = join(root, `.deleting-${taskId}`);
          mkdirSync(stage, {mode:0o700});
          staged = stage;
          writeJson(join(stage, 'journal.json'), {version:2, projectId, taskId});
          if (folder) renameSync(folder, join(stage, 'task'));
          if (hasChat) renameSync(chat, join(stage, 'chat.json'));
        }
        recordTaskDeleted(db, taskId);
        db.query('DELETE FROM tasks WHERE id=?').run(taskId);
      });
    } catch (error) {
      if (staged) recoverProjectTaskDeletions(this.projectDatabasePath(projectId), this.legacyProjectDirectory(projectId), projectId);
      if (prepared) this.chats.cancelDeletion(projectId, taskId);
      throw error;
    }
    this.chats.finishDeletion(projectId,taskId);
    if (staged) try { cleanDeletedTask(staged); } catch { /* 起動時に掃除を再試行する。 */ }
  }

  createTask(projectId: string, name: string, initialize?: (task: TaskRow) => void): TaskRow {
    if (typeof name !== 'string' || !name.trim()) throw Error('Empty value');
    const databasePath = this.scopedProjectDatabase(projectId), root = this.legacyProjectDirectory(projectId);
    const value = {...newMetadata('task', name.trim()), phase: 'requirements', status: 'idle'};
    const task = taskRow(projectId, value);
    if (taskFolder(root, task.id)) throw Error('Task ID collision');
    try {
      initialize?.(task);
      withDatabase(databasePath, db => db.transaction(() => {
        insertTaskMetadata(db, value);
        this.prepareManagedDocuments(db, root, value);
      }).immediate());
    } catch (error) {
      if (initialize) rmSync(join(root, 'tasks', value.id), {recursive: true, force: true});
      throw error;
    }
    return task;
  }
}
