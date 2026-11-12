import { Database, constants as sqlite } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { fstatSync, readSync, readdirSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { dataKinds, type DataDetail, type DataKind, type DataList, type DataReadError, type DataSqlCatalog, type DataSummary, type DataView, type DocumentDiff } from '../shared/data-browser';
import { object, validPack } from '../shared/communication';
import { validChatId, validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase, phaseLabels } from '../shared/task-phase';
import { decodeChatHistory, encodeChatHistory, type StoredConversation } from './chat-history';
import { chatScopeKey } from './chat-store';
import { projectIdentity, unifiedPatch, workflowEventTypes } from './project-events';
import { restoreRateLimitUsage } from './rate-limits';
import { absent, directoryStat, fileStat, openDataDatabase, withFile } from './data-browser-files';
import { DataSqlError, maxSqlBytes, runDataSql, type DataSqlSource } from './data-sql';

type Value = string | number | bigint | Uint8Array | null;
type Row = Record<string, Value>;
type Key = string;
type Location = [storage: string, table: string, ...keys: Key[]];
type Table = {
  kind: DataKind;
  keys: readonly string[];
  summary: readonly string[];
  name?: string;
  status?: string;
  date?: string;
  project?: string;
  integerKeys?: boolean;
};

const appTables: Record<string, Table> = {
  projects: {kind:'registration', keys:['id'], summary:['name','updatedAt'], name:'name', date:'updatedAt', project:'id'},
  project_storage: {kind:'management', keys:['project_id'], summary:['state'], status:'state', project:'project_id'},
  instructions: {kind:'instruction', keys:['key'], summary:[]},
  document_heads: {kind:'instruction', keys:['scope','name'], summary:['revision'], name:'name', date:'updated_at'},
  document_versions: {kind:'instruction', keys:['scope','name','revision'], summary:['updated_at'], name:'name', date:'updated_at'},
  instruction_jobs: {kind:'workflow', keys:['ordinal'], summary:['id','project_id','task_id','status','event_key'], name:'id', status:'status', project:'project_id', integerKeys:true},
  agents: {kind:'cache', keys:['id'], summary:['name','availability','checked_at'], name:'name', status:'availability', date:'checked_at'},
  agent_usage_cache: {kind:'cache', keys:['provider'], summary:[]},
  chat_refs: {kind:'management', keys:['chat_id'], summary:['kind','project_id','task_id','phase','workflow_job_id','archived'], project:'project_id'},
  chat_changes: {kind:'management', keys:['scope_key'], summary:['chat_id'], name:'chat_id'},
  chat_deletions: {kind:'management', keys:['project_id','task_id'], summary:['confirmed'], project:'project_id'},
  chat_migration_aliases: {kind:'management', keys:['scope_key','legacy_id'], summary:['chat_id']},
  chat_migration_sources: {kind:'management', keys:['path'], summary:['scope_key','chat_id','state'], status:'state'},
};
const projectTables: Record<string, Table> = {
  project_identity: {kind:'registration', keys:['singleton'], summary:['project_id'], name:'project_id', integerKeys:true},
  tasks: {kind:'task', keys:['id'], summary:['name','updated_at','phase','status'], name:'name', date:'updated_at', status:'status'},
  document_heads: {kind:'document', keys:['scope','name'], summary:['revision'], name:'name', date:'updated_at'},
  document_versions: {kind:'document', keys:['scope','name','revision'], summary:['updated_at'], name:'name', date:'updated_at'},
  events: {kind:'event', keys:['id'], summary:['type','at','task_id','phase'], name:'type', date:'at', integerKeys:true},
  file_changes: {kind:'event', keys:['event_id'], summary:['path','after_hash'], name:'path', integerKeys:true},
  file_snapshots: {kind:'event', keys:['change_id'], summary:[], integerKeys:true},
  managed_document_scopes: {kind:'management', keys:['scope'], summary:[]},
  document_review: {kind:'workflow', keys:['task_id'], summary:['state'], status:'state'},
  document_send_inputs: {kind:'workflow', keys:['task_id','send_id'], summary:['phase']},
  document_execution_completion: {kind:'workflow', keys:['task_id','send_id'], summary:['outcome'], status:'outcome'},
  document_knowledge_completion: {kind:'workflow', keys:['task_id','chat_id'], summary:['revision']},
  legacy_task_json: {kind:'management', keys:['task_id'], summary:['removed']},
  legacy_task_markdown: {kind:'management', keys:['source_name'], summary:['task_id','restored']},
};

const appScope = {id:'app', name:'アプリ共通'};
const maxLimit = 100;
const maxChatBytes = 64 * 1024 * 1024;
const maxSnapshotBytes = 1024 * 1024;
const maxVersionBytes = 8 * maxSnapshotBytes;
const maxDiffLines = 100_000;
const documentOrder = 'updated_at DESC, rowid DESC';
const readFailure = '保存データを読み込めませんでした';
const validIntegerKey = (value: unknown): value is string => typeof value === 'string' && /^(?:0|-?[1-9][0-9]{0,18})$/.test(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const text = (value: unknown) => isText(value) ? value : '';
const sqlIdentifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const idFor = (location: Location) => Buffer.from(JSON.stringify(location)).toString('base64url');
const tablesFor = (storage: string) => storage === 'app' ? appTables : projectTables;
const tableFor = (storage: string, table: string) => Object.hasOwn(tablesFor(storage), table) ? tablesFor(storage)[table] : undefined;
const toKey = (value: unknown) => typeof value === 'bigint' || typeof value === 'number' ? String(value) : text(value);
const fileKind = (kind: DataKind) => kind === 'document' || kind === 'instruction';
const sectionTables = {events:'events',tasks:'tasks',agents:'agents'} as const;
type Section = keyof typeof sectionTables;
const sectionFor = (name: string) => Object.hasOwn(sectionTables,name) ? name as Section : undefined;
const statusSection = (section: Section | undefined) => section === 'tasks' || section === 'agents';
const displayPhase = (phase: Value | undefined) => isTaskPhase(phase) ? phaseLabels[phase] : text(phase);
const nullableText = (value: Value | undefined) => isText(value) ? value : null;
const relatedLimit = 20;
const workflowTypes = new Set<string>(workflowEventTypes);

export class DataBrowserError extends Error {
  constructor(readonly status: 400 | 404 | 500) {
    super(status === 400 ? 'データの指定を確認してください' : status === 404 ? '対象のデータが見つかりません' : readFailure);
  }
}

function locationFor(id: string | null): Location {
  if (!id || !/^[A-Za-z0-9_-]{1,24000}$/.test(id)) throw new DataBrowserError(400);
  try {
    const value: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length < 3 || idFor(value as Location) !== id) throw Error();
    const [storage, table, ...keys] = value;
    if (storage === 'chats' && table === 'chat' && keys.length === 1 && validChatId(keys[0])) return value as Location;
    if (storage !== 'app' && !validProjectId(storage) || !isText(table)) throw Error();
    const config = tableFor(storage, table);
    if (!config || keys.length !== config.keys.length ||
        !keys.every(key => config.integerKeys ? validIntegerKey(key) : isText(key) && !key.includes('\0'))) throw Error();
    return value as Location;
  } catch {
    throw new DataBrowserError(400);
  }
}

function openDatabase(path: string) {
  const db = openDataDatabase(path, file => new Database(file, sqlite.SQLITE_OPEN_READONLY | sqlite.SQLITE_OPEN_NOFOLLOW));
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

type DatabaseView = {db: Database; tables: Set<string>};

function databaseView(db: Database): DatabaseView {
  const tables = db.query<{name:string; type:string; schema:string}, []>('PRAGMA table_list').all()
    .filter(row => row.schema === 'main' && row.type === 'table').map(row => row.name);
  return {db, tables:new Set(tables)};
}

function columns(view: DatabaseView, table: string) {
  return new Set(view.db.query<{name:string}, []>(`PRAGMA table_info(${sqlIdentifier(table)})`).all().map(row => row.name));
}

function getRow(view: DatabaseView | undefined, location: Location, fields?: readonly string[]): Row | null {
  const [storage, table, ...keys] = location;
  if (!view?.tables.has(table)) return null;
  const config = tableFor(storage, table)!;
  const predicates = config.keys.map(column => sqlIdentifier(column) + '=?').join(' AND ');
  const projection = fields?.map(sqlIdentifier).join(',') ?? '*';
  return view.db.query<Row, Key[]>(`SELECT ${projection} FROM ${sqlIdentifier(table)} WHERE ${predicates}`).safeIntegers(true).get(...keys);
}

function asDate(value: Value | undefined) {
  const timestamp = typeof value === 'bigint' || typeof value === 'number' ? Number(value) : Date.parse(text(value));
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function projectOf(value: unknown, projects: Map<string, string>) {
  return isText(value) && projects.has(value) ? value : appScope.id;
}

function projectOfScopeKey(value: unknown, projects: Map<string, string>) {
  try {
    const scope = JSON.parse(text(value));
    if (Array.isArray(scope)) return projectOf(scope[0], projects);
  } catch { /* 不正な参照キーも管理行として表示する。 */ }
  return appScope.id;
}

function tableScope(storage: string, table: string, config: Table, row: Row, projects: Map<string, string>) {
  if (storage !== 'app') return storage;
  if (config.project) return projectOf(row[config.project], projects);
  if (table.startsWith('chat_')) return projectOfScopeKey(row.scope_key, projects);
  return appScope.id;
}

function summarize(location: Location, row: Row, scope: string, database: string, head?: Row | null): DataSummary {
  const [storage, table, ...keys] = location, config = tableFor(storage, table)!;
  let name = config.name ? text(row[config.name]) : '';
  let status = config.status ? text(row[config.status]) : '';
  if (!name) name = keys.filter(key => key !== '').join(' / ') || table;
  if (table === 'document_versions' && head !== undefined) {
    status = !head ? '現行版なし' : head.revision === row.revision ? '現行' : '過去版';
  }
  if (table === 'document_heads') status = '現行';
  if (Number(row.task_deleted) === 1) status += '（削除済みタスク）';
  if (table === 'instructions' || table === 'agent_usage_cache') status = '旧データ';
  if (table === 'chat_refs') status = Number(row.archived) === 1 ? 'アーカイブ' : '現行';
  if (table === 'chat_deletions') status = Number(row.confirmed) === 1 ? '確定' : '処理中';
  if (table === 'legacy_task_json') status = Number(row.removed) === 1 ? '削除済み' : '取り込み済み';
  if (table === 'legacy_task_markdown') status = Number(row.restored) === 1 ? '復元済み' : '取り込み済み';
  return {id:idFor(location), name, scope, kind:config.kind, status,
    source:`${database} · ${table}`, updatedAt:config.date ? asDate(row[config.date]) : null};
}

function eventSummary(location: Location, row: Row, source: string, taskName?: string): DataSummary {
  const phase = displayPhase(row.phase);
  const task = taskName || text(row.task_id);
  return {...summarize(location,row,location[0],source), eventId:Number(row.id),
    ...(task && {eventTask:task}), ...(phase && {eventPhase:phase})};
}

function sectionSummary(section: Section, location: Location, row: Row, scope: string, source: string): DataSummary {
  const summary = summarize(location,row,scope,source);
  const subtitle = section === 'tasks' ? displayPhase(row.phase) : '';
  return {...summary, ...(subtitle && {subtitle})};
}

function workflowJob(app: DatabaseView | undefined, projectId: unknown, jobId: unknown) {
  if (!app?.tables.has('instruction_jobs') || !validProjectId(projectId) || !isText(jobId)) return null;
  return app.db.query<Row,[string,string]>(
    'SELECT * FROM instruction_jobs WHERE project_id=? AND id=?',
  ).safeIntegers(true).get(projectId,jobId);
}

function describeWorkflow(job: Row, task: Row | null): NonNullable<DataDetail['workflow']> {
  return {
    eventKey:nullableText(job.event_key), taskId:nullableText(job.task_id), taskName:nullableText(task?.name),
    status:nullableText(job.status), provider:nullableText(job.provider), model:nullableText(job.model),
    error:nullableText(job.error), reason:nullableText(job.reason), revision:nullableText(job.revision),
    instructionRevision:nullableText(job.instruction_revision),
  };
}

type SavedChat = {id: string; stat: Stats; reference?: Row | null};

const chatLocation = (id: string, reference?: Row | null) => text(reference?.scope_key) || id;
const chatRefColumns = 'chat_id,scope_key,kind,project_id,task_id,phase,workflow_job_id,archived';
const compareChatVersions = (a: SavedChat, b: SavedChat) =>
  Number(b.reference != null && Number(b.reference.archived) === 0) -
  Number(a.reference != null && Number(a.reference.archived) === 0) ||
  b.stat.mtimeMs - a.stat.mtimeMs || b.id.localeCompare(a.id);

function chatName(id: string, reference?: Row | null, taskName?: string, job?: Row | null) {
  if (reference?.kind === 'instructions') return 'インストラクション編集相談';
  if (reference?.kind === 'general') return 'General';
  if (reference?.kind === 'workflow') return `ワークフロー · ${text(job?.event_key) || text(reference.workflow_job_id) || id}`;
  if (reference?.kind === 'task') {
    const phase = isTaskPhase(reference.phase) ? phaseLabels[reference.phase] : text(reference.phase);
    return [taskName || text(reference.task_id) || id, phase].filter(Boolean).join(' · ');
  }
  return id;
}

function chatSummary(chat: SavedChat, scope: string, source: string, count: number, taskName?: string, job?: Row | null): DataSummary {
  const {id, stat, reference} = chat;
  const status = text(job?.status) || (!reference ? '参照なし' : Number(reference.archived) === 1 ? 'アーカイブ' : '現行');
  const subtitle = job && (taskName || text(job.task_id));
  return {id:idFor(['chats','chat',id]), name:chatName(id,reference,taskName,job), scope, kind:'conversation', status,
    ...(subtitle && {subtitle}), source, updatedAt:asDate(stat.mtimeMs), chatLocation:chatLocation(id,reference), chatVersionCount:count};
}

function readChat(path: string, stat: Stats, id: string, reference: Row | null) {
  if (stat.size > maxChatBytes) throw Error('Chat is too large');
  const raw: unknown = withFile(path, stat, fd => {
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (length === 0) throw Error('Chat changed while reading');
      offset += length;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('Chat changed while reading');
    return JSON.parse(bytes.toString('utf8'));
  });
  const decoded = decodeChatHistory(raw);
  const scope = chatScopeKey(decoded);
  if (!object(raw) || raw.chatId !== id || decoded.id !== id ||
      reference && (reference.scope_key !== scope || reference.project_id !== decoded.projectId ||
        reference.task_id !== decoded.taskId || reference.phase !== decoded.phase ||
        reference.workflow_job_id !== (decoded.workflowJobId ?? null)) ||
      decoded.packs.some((pack, index) => !validPack(pack) || pack.sequence !== index + 1) ||
      new Set(decoded.packs.map(pack => pack.packId)).size !== decoded.packs.length) throw Error('Invalid saved chat');
  const conversation = raw.version === 3 ? raw as StoredConversation : encodeChatHistory(decoded);
  return {raw, conversation};
}

function serializeRow(row: Row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, value instanceof Uint8Array ? {type:'BLOB', bytes:value.byteLength} :
      typeof value === 'bigint' ? Number.isSafeInteger(Number(value)) ? Number(value) : String(value) : value,
  ]));
}

function describeRow(row: Row) {
  const raw = serializeRow(row);
  const fields = Object.fromEntries(Object.entries(raw).map(([key, value]) => [
    key, typeof value === 'object' && value !== null ? `BLOB (${value.bytes} bytes)` :
      typeof value === 'string' && value.length > 512 ? value.slice(0, 512) + '…（先頭512文字。全文は保存データで確認）' : value,
  ]));
  return {fields, raw};
}

function parseSaved(value: unknown): unknown {
  if (!isText(value)) return value ?? null;
  try { return JSON.parse(value); }
  catch { return value; }
}

function describeAgent(row: Row, saved: ReturnType<typeof serializeRow>, observedAt: string): NonNullable<DataDetail['agent']> {
  const invalidated = Number(row.status_invalidated) === 1;
  const checkedAt = asDate(row.checked_at);
  const issues: string[] = [];
  if (invalidated) issues.push('接続情報のキャッシュは失効しています');
  if (row.checked_at == null) issues.push('接続情報は未取得です');
  else if (!checkedAt) issues.push('接続情報の取得日時が不正です');

  let models = parseSaved(saved.models);
  if (models === null) issues.push('モデル一覧は未取得です');
  else if (!Array.isArray(models) || !models.every(model => object(model) && isText(model.id) && isText(model.name))) {
    issues.push('保存されたモデル一覧が不正です');
    models = saved.models;
  }
  let usage: unknown = null;
  if (row.usage == null) issues.push('利用枠は未取得です');
  else {
    const restored = restoreRateLimitUsage(parseSaved(saved.usage));
    if (restored === 'unknown') {
      issues.push('保存された利用枠が不正です');
      usage = saved.usage;
    } else {
      usage = restored;
      if (restored.windows.some(window => window.resetsAt !== undefined && window.resetsAt * 1000 <= Date.parse(observedAt))) {
        issues.push('リセット日時を過ぎた利用枠があります');
      }
    }
  }
  return {availability:nullableText(row.availability),auth:nullableText(row.auth),version:nullableText(row.version),
    checkedAt,invalidated,models,usage,issues};
}

type Related = DataDetail['related'];
type RelatedRow = (location: Location, fields?: readonly string[]) => Row | null;

function readDocumentVersion(view: DatabaseView, location: Location) {
  if (!view.tables.has('document_versions')) return null;
  const existing = columns(view,'document_versions');
  if (!existing.has('items_json')) {
    const row = getRow(view,location);
    return row && {row, saved:describeRow(row)};
  }
  const fields = [...existing].map(column => column === 'items_json'
    ? `CASE WHEN typeof(items_json)='text' AND length(CAST(items_json AS BLOB))<=${maxVersionBytes} THEN items_json END AS items_json`
    : sqlIdentifier(column));
  const stored = view.db.query<Row, Key[]>(`
    SELECT ${fields.join(',')}, length(CAST(items_json AS BLOB)) AS items_bytes, typeof(items_json) AS items_type
    FROM document_versions WHERE scope=? AND name=? AND revision=?
  `).safeIntegers(true).get(...location.slice(2));
  if (!stored) return null;
  const {items_bytes, items_type, ...row} = stored;
  const saved = describeRow(row);
  if (row.items_json === null && items_type !== 'null') {
    const omitted = {type:text(items_type).toUpperCase(), bytes:Number(items_bytes), omitted:true};
    saved.raw.items_json = omitted;
    saved.fields.items_json = `表示を省略（${omitted.bytes} bytes）`;
  }
  return {row,saved};
}

function describeDocumentVersion(version: Row | null | undefined): DataDetail['document'] {
  if (!isText(version?.items_json)) return;
  let items: unknown;
  try { items = JSON.parse(version.items_json); }
  catch { return; }
  if (!Array.isArray(items) || !items.every(item => object(item) && isText(item.text))) return;
  const content = items.map(item => item.text).join('');
  if (Buffer.byteLength(content) > maxSnapshotBytes) return;
  if (isText(version.content_hash) && createHash('sha256').update(content).digest('hex') !== version.content_hash) return;
  return {content, revision:text(version.revision), items};
}

function compareDocumentVersions(
  selected: NonNullable<DataDetail['document']>, previous: DataDetail['document'], previousRevision: string, name: string,
): DocumentDiff {
  if (!previous) return {state:'unavailable', previousRevision, message:'前の版の本文を読み取れませんでした。'};
  if (selected.content === previous.content) return {state:'unchanged', previousRevision};
  if ([previous.content, selected.content].some(content => content.split('\n', maxDiffLines + 2).length > maxDiffLines + Number(content.endsWith('\n')))) {
    return {state:'unavailable', previousRevision, message:'本文の行数が差分表示の上限を超えています。'};
  }
  const path = name.replace(/[\r\n]/g, ' ');
  const patch = unifiedPatch(Buffer.from(previous.content), Buffer.from(selected.content), path, path).toString('utf8');
  return {state:'changed', previousRevision, patch};
}

function describeDocument(table: string, storage: string, row: Row, getRelated: RelatedRow): DataDetail['document'] {
  if (table === 'instructions') return {content:text(row.content), revision:text(row.key), items:[]};
  if (table === 'file_snapshots' && row.content instanceof Uint8Array && row.content.byteLength <= maxSnapshotBytes) {
    const change = getRelated([storage,'file_changes',toKey(row.change_id)],['after_hash']);
    if (isText(change?.after_hash) && createHash('sha256').update(row.content).digest('hex') === change.after_hash) {
      try {
        const content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(row.content);
        return {content, revision:change.after_hash, items:[]};
      } catch { /* UTF-8 ではない保存値は BLOB として表示する。 */ }
    }
  }
}

function documentHistory(view: DatabaseView, storage: string, row: Row): DataDetail['history'] {
  if (!view.tables.has('document_versions')) return [];
  return view.db.query<{revision:string; updated_at:number}, [string,string]>(`
    SELECT revision,updated_at FROM document_versions WHERE scope=? AND name=? ORDER BY ${documentOrder}
  `).all(text(row.scope),text(row.name)).map(({revision,updated_at}) =>
    ({id:idFor([storage,'document_versions',text(row.scope),text(row.name),text(revision)]), revision:text(revision), updatedAt:asDate(updated_at)}));
}

export class DataBrowser {
  constructor(
    private readonly dataDirectory: string,
    private readonly appDatabasePath: string,
    private readonly memoryDatabase?: Database,
  ) {}

  private appSource() {
    return this.memoryDatabase ? 'beni.sqlite (:memory:)' : resolve(this.appDatabasePath);
  }

  private projectSource(id: string) {
    return resolve(this.dataDirectory, 'projects', id + '.sqlite');
  }

  private chatSource(id: string) {
    return resolve(this.dataDirectory, 'chats', id + '.json');
  }

  private withApp<T>(read: (view: DatabaseView) => T): T {
    if (this.memoryDatabase) {
      const db = this.memoryDatabase;
      return db.transaction(() => read(databaseView(db)))();
    }
    const path = this.appSource();
    if (dirname(path) !== resolve(this.dataDirectory)) throw Error('Invalid app database location');
    directoryStat(this.dataDirectory);
    const db = openDatabase(path);
    try { return db.transaction(() => read(databaseView(db)))(); } finally { db.close(); }
  }

  private withProject<T>(id: string, read: (view: DatabaseView) => T): T {
    if (!validProjectId(id)) throw Error('Invalid project ID');
    directoryStat(this.dataDirectory);
    directoryStat(join(this.dataDirectory, 'projects'));
    const db = openDatabase(this.projectSource(id));
    try {
      return db.transaction(() => {
        if (projectIdentity(db) !== id) throw Error('Project identity mismatch');
        return read(databaseView(db));
      })();
    } finally {
      db.close();
    }
  }

  private projects(view: DatabaseView) {
    const projects = new Map<string, string>();
    if (view.tables.has('projects')) {
      for (const row of view.db.query<{id:string; name:string}, []>('SELECT id,name FROM projects ORDER BY name,id').iterate()) {
        if (validProjectId(row.id)) projects.set(row.id, row.name);
      }
    }
    return projects;
  }

  private sqlSource(database: string): DataSqlSource {
    if (database === 'app' && this.memoryDatabase) return {memory:this.memoryDatabase.serialize().toString('base64')};
    const path = database === 'app' ? this.appSource() : this.projectSource(database);
    if (database === 'app' && dirname(path) !== resolve(this.dataDirectory)) throw new DataSqlError('unavailable');
    return {path, root:resolve(this.dataDirectory), ...(database !== 'app' && {projectId:database})};
  }

  private sqlProjects() {
    try { return this.withApp(app => this.projects(app)); }
    catch { throw new DataSqlError('unavailable'); }
  }

  async sqlCatalog(database: string, signal?: AbortSignal): Promise<DataSqlCatalog> {
    if (database !== 'app' && !validProjectId(database)) throw new DataSqlError('invalid');
    const projects = this.sqlProjects();
    if (database !== 'app' && !projects.has(database)) throw new DataSqlError('missing');
    const databases = [{...appScope, source:this.appSource()},
      ...Array.from(projects,([id,name]) => ({id,name,source:this.projectSource(id)}))];
    const {tables, observedAt} = await runDataSql(() => this.sqlSource(database), undefined, signal);
    return {databases, database, tables, observedAt};
  }

  async executeSql(database: string, sql: string, signal?: AbortSignal) {
    if (database !== 'app' && !validProjectId(database)) throw new DataSqlError('invalid');
    if (Buffer.byteLength(sql) > maxSqlBytes) throw new DataSqlError('sqlSize');
    if (database !== 'app' && !this.sqlProjects().has(database)) throw new DataSqlError('missing');
    return await runDataSql(() => this.sqlSource(database), sql, signal);
  }

  private taskNames(projectId: string, taskIds: Set<string>) {
    const names = new Map<string,string>();
    this.withProject(projectId, view => {
      if (!view.tables.has('tasks')) return;
      const find = view.db.query<{name:string}, [string]>('SELECT name FROM tasks WHERE id=?');
      for (const id of taskIds) {
        const name = text(find.get(id)?.name);
        if (name) names.set(id,name);
      }
    });
    return names;
  }

  private taskNamesByProject(
    references: Iterable<readonly [unknown,unknown]>, projects: Map<string,string>, report: (source: string) => void,
  ) {
    const tasks = new Map<string,Set<string>>();
    for (const [projectId,taskId] of references) {
      if (!validProjectId(projectId) || !validTaskId(taskId) || !projects.has(projectId)) continue;
      let ids = tasks.get(projectId);
      if (!ids) tasks.set(projectId,ids = new Set());
      ids.add(taskId);
    }
    const names = new Map<string,Map<string,string>>();
    for (const [id,taskIds] of tasks) {
      try { names.set(id,this.taskNames(id,taskIds)); }
      catch { report(this.projectSource(id)); }
    }
    return names;
  }

  list(params: URLSearchParams): DataList {
    if ([...params.keys()].some(key =>
      !['view','scope','kind','database','table','eventType','status','query','offset','limit'].includes(key) || params.getAll(key).length !== 1)) {
      throw new DataBrowserError(400);
    }
    const viewName = params.get('view') ?? 'files';
    const database = params.get('database') ?? 'all', selectedTable = params.get('table') ?? 'all';
    const scope = params.get('scope') ?? 'all', kind = params.get('kind') ?? 'all', query = params.get('query') ?? '';
    const section = sectionFor(viewName), isEvents = section === 'events', eventType = params.get('eventType') ?? 'all';
    const status = params.get('status') ?? 'all';
    const rawOffset = params.get('offset') ?? '0', rawLimit = params.get('limit') ?? '50';
    const offset = Number(rawOffset), requestedLimit = Number(rawLimit);
    if (viewName !== 'files' && viewName !== 'chats' && viewName !== 'db' && !section ||
        database !== 'all' && database !== 'app' && !validProjectId(database) ||
        selectedTable !== 'all' && !Object.hasOwn(appTables,selectedTable) && !Object.hasOwn(projectTables,selectedTable) ||
        scope !== 'all' && scope !== 'app' && !validProjectId(scope) ||
        kind !== 'all' && !Object.hasOwn(dataKinds,kind) || query.length > 512 ||
        !isEvents && params.has('eventType') || eventType.length > 512 ||
        !statusSection(section) && params.has('status') || status.length > 512 ||
        !/^\d+$/.test(rawOffset) || !Number.isSafeInteger(offset) ||
        !/^\d+$/.test(rawLimit) || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw new DataBrowserError(400);
    const limit = Math.min(requestedLimit,maxLimit);
    const isDb = viewName === 'db';
    const isChats = viewName === 'chats';
    const records: DataSummary[] = [], errors: DataReadError[] = [];
    const tables: NonNullable<DataList['tables']> = [];
    const eventTypes = new Set<string>();
    const statuses = new Set<string>();
    const observedAt = new Date().toISOString();
    let projects = new Map<string,string>();
    const filter = query.trim().toLowerCase();
    const report = (source: string) => {
      if (!errors.some(error => error.source === source)) errors.push({source, message:readFailure});
    };
    const add = (summary: DataSummary, search: unknown[]) => {
      if (!isDb && scope !== 'all' && scope !== summary.scope) return;
      if (statusSection(section) && summary.status) statuses.add(summary.status);
      if ((isDb || kind === 'all' || kind === summary.kind) && (status === 'all' || status === summary.status) &&
          (!filter || (section ? [summary.name,...search] : [summary.id,summary.name,...search])
            .some(value => String(value ?? '').toLowerCase().includes(filter)))) records.push(summary);
    };
    const listSection = (view: DatabaseView, storage: string, source: string, section: Section) => {
      const table = sectionTables[section];
      if (!view.tables.has(table)) return;
      const config = tableFor(storage,table)!;
      const existing = columns(view,table);
      if (!config.keys.every(key => existing.has(key))) throw Error('Invalid database schema');
      const projected = [...new Set([...config.keys,...config.summary])].filter(field => existing.has(field));
      const fields = projected.map(sqlIdentifier);
      const rows = view.db.query<Row,[]>(`SELECT ${fields.join(',')} FROM ${sqlIdentifier(table)}`).safeIntegers(true);
      for (const row of rows.iterate()) {
        const owner = tableScope(storage,table,config,row,projects);
        if (scope !== 'all' && scope !== owner) continue;
        const key = toKey(row[config.keys[0]]);
        add(sectionSummary(section,[storage,table,key],row,owner,source),[key]);
      }
    };
    const listEvents = (view: DatabaseView, storage: string, source: string) => {
      if (!view.tables.has('events')) return;
      const eventColumns = columns(view,'events');
      const taskColumns = view.tables.has('tasks') ? columns(view,'tasks') : new Set<string>();
      const hasTaskNames = eventColumns.has('task_id') && taskColumns.has('id') && taskColumns.has('name');
      const joinTask = hasTaskNames ? ' LEFT JOIN tasks t ON t.id=e.task_id' : '';
      const taskId = eventColumns.has('task_id') ? 'e.task_id' : 'NULL AS task_id';
      const taskName = hasTaskNames ? 't.name AS task_name' : 'NULL AS task_name';
      const phase = eventColumns.has('phase') ? 'e.phase' : 'NULL AS phase';
      for (const {type} of view.db.query<{type:string},[]>('SELECT DISTINCT type FROM events').iterate()) {
        if (isText(type)) eventTypes.add(type);
      }
      const where = eventType === 'all' ? '' : ' WHERE e.type=?';
      const args = eventType === 'all' ? [] : [eventType];
      const sql = `SELECT e.id,e.type,e.at,${taskId},${taskName},${phase} FROM events e${joinTask}${where}`;
      for (const row of view.db.query<Row,string[]>(sql).safeIntegers(true).iterate(...args)) {
        const id = toKey(row.id);
        const summary = eventSummary([storage,'events',id],row,source,text(row.task_name));
        add(summary,[id,row.task_id,summary.eventTask]);
      }
    };
    const listTables = (view: DatabaseView, storage: string, source: string) => {
      for (const [table, config] of Object.entries(tablesFor(storage))) {
        if (!view.tables.has(table)) continue;
        if (isDb) {
          tables.push({database:storage, name:table});
          if (database !== 'all' && database !== storage || selectedTable !== 'all' && selectedTable !== table) continue;
        } else if (!fileKind(config.kind) || kind !== 'all' && kind !== config.kind) continue;
        try {
          const existing = columns(view,table);
          if (!config.keys.every(key => existing.has(key))) throw Error('Invalid database schema');
          const projected = [...new Set([...config.keys,...config.summary])].filter(column => existing.has(column));
          const fields = projected.map(column => `r.${sqlIdentifier(column)}`);
          const filters: string[] = [];
          let sourceTable = sqlIdentifier(table);
          if (!isDb && table === 'document_versions') {
            const headless = view.tables.has('document_heads') ?
              'WHERE NOT EXISTS(SELECT 1 FROM document_heads h WHERE h.scope=v.scope AND h.name=v.name)' : '';
            // 現行版の参照がない文書だけ、保存されている最新の版で代表させる。
            sourceTable = `(
              SELECT scope,name,revision,updated_at,
                ROW_NUMBER() OVER (PARTITION BY scope,name ORDER BY ${documentOrder}) AS version_rank
              FROM document_versions v ${headless}
            )`;
            filters.push('r.version_rank=1');
          }
          if (!isDb && table === 'instructions') {
            for (const modernTable of ['document_heads','document_versions']) {
              if (view.tables.has(modernTable)) {
                filters.push(`NOT EXISTS(SELECT 1 FROM ${modernTable} d WHERE d.scope='instructions' AND d.name=r.key)`);
              }
            }
          }
          const hasVersions = !isDb && table === 'document_heads' && view.tables.has('document_versions');
          const version = hasVersions ? ' LEFT JOIN document_versions v ON v.scope=r.scope AND v.name=r.name AND v.revision=r.revision' : '';
          const versionDate = hasVersions ? ', v.updated_at' : '';
          const hasTaskEvents = !isDb && storage !== 'app' && (table === 'document_heads' || table === 'document_versions') &&
            view.tables.has('events') && ['task_id','type'].every(column => columns(view,'events').has(column));
          const deleted = hasTaskEvents ? ", EXISTS(SELECT 1 FROM events e WHERE e.task_id=r.scope AND e.type='task.deleted') AS task_deleted" : '';
          const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
          const sql = `SELECT ${fields.join(',')}${versionDate}${deleted} FROM ${sourceTable} r${version}${where}`;
          for (const row of view.db.query<Row,[]>(sql).safeIntegers(true).iterate()) {
            const keys = config.keys.map(key => toKey(row[key]));
            const location: Location = [storage,table,...keys];
            const ownership = tableScope(storage,table,config,row,projects);
            const summary = summarize(location,row,ownership,source,isDb ? undefined : null);
            add(isDb ? {...summary, database:storage, table, rowKey:keys.join(' / ')} : summary,Object.values(row));
          }
        } catch { report(`${source} · ${table}`); }
      }
    };
    const references = new Map<string, Row>();
    const jobs = new Map<string, Row>();
    let appReadable = false;
    try {
      this.withApp(view => {
        projects = this.projects(view);
        appReadable = true;
        if (section === 'agents') {
          try { listSection(view,'app',this.appSource(),section); }
          catch { report(`${this.appSource()} · ${sectionTables[section]}`); }
        } else if (!isChats && !section) listTables(view,'app',this.appSource());
        if (isChats && view.tables.has('chat_refs')) {
          try {
            for (const row of view.db.query<Row,[]>(`SELECT ${chatRefColumns} FROM chat_refs`).iterate()) {
              if (validChatId(row.chat_id)) references.set(row.chat_id,row);
              else report(`${this.appSource()} · chat_refs`);
            }
          } catch { report(`${this.appSource()} · chat_refs`); }
          try {
            for (const [id, reference] of references) {
              if (reference.kind !== 'workflow' || scope !== 'all' && scope !== reference.project_id) continue;
              const job = workflowJob(view,reference.project_id,reference.workflow_job_id);
              if (job) jobs.set(id,job);
            }
          } catch { report(`${this.appSource()} · instruction_jobs`); }
        }
      });
    } catch { report(this.appSource()); }
    if (isDb && appReadable && validProjectId(database) && !projects.has(database)) throw new DataBrowserError(400);
    if (isChats) {
      const chats = resolve(this.dataDirectory,'chats');
      const found = new Set<string>();
      const groups = new Map<string, {versions: SavedChat[]; ids: string[]}>();
      const groupFor = (id: string, reference?: Row) => {
        const location = chatLocation(id,reference);
        let group = groups.get(location);
        if (!group) groups.set(location,group = {versions:[],ids:[]});
        return group;
      };
      for (const [id,reference] of references) groupFor(id,reference).ids.push(id);
      try {
        directoryStat(this.dataDirectory);
        directoryStat(chats);
        for (const filename of readdirSync(chats)) {
          const id = basename(filename,'.json');
          if (filename !== id + '.json' || !validChatId(id)) continue;
          found.add(id);
          const reference = references.get(id);
          const ownership = projectOf(reference?.project_id,projects);
          const source = this.chatSource(id);
          try { groupFor(id,reference).versions.push({id,stat:fileStat(source),reference}); }
          catch { if (scope === 'all' || scope === ownership) report(source); }
        }
      } catch (error) {
        if (!absent(error)) report(chats);
      }
      for (const [id, reference] of references) {
        if (!found.has(id) && (scope === 'all' || scope === projectOf(reference.project_id,projects))) report(this.chatSource(id));
      }
      const representatives = Array.from(groups.values()).filter(group => group.versions.length > 0).map(group => ({
        chat:group.versions.sort(compareChatVersions)[0], count:group.versions.length, ids:group.ids,
      })).filter(({chat}) => scope === 'all' || scope === projectOf(chat.reference?.project_id,projects));
      const names = this.taskNamesByProject(representatives.map(({chat:{id,reference}}) =>
        [reference?.project_id,jobs.get(id)?.task_id ?? reference?.task_id]),projects,report);
      for (const {chat,count,ids} of representatives) {
        const {id,reference} = chat, ownership = projectOf(reference?.project_id,projects);
        const job = jobs.get(id);
        const taskName = names.get(ownership)?.get(text(job?.task_id ?? reference?.task_id));
        const summary = chatSummary(chat,ownership,this.chatSource(id),count,taskName,job);
        add(summary,[id,...ids,...Object.values(reference ?? {}),projects.get(ownership),summary.subtitle,job?.task_id]);
      }
    } else if (section !== 'agents') {
      for (const id of projects.keys()) {
        if (!isDb && scope !== 'all' && scope !== id) continue;
        const source = this.projectSource(id);
        try {
          this.withProject(id, view => {
            if (isEvents) listEvents(view,id,source);
            else if (section) listSection(view,id,source,section);
            else listTables(view,id,source);
          });
        }
        catch { report(source); }
      }
    }
    records.sort((a,b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
      a.scope.localeCompare(b.scope) || (isEvents ? (a.eventId ?? 0) - (b.eventId ?? 0) : a.kind.localeCompare(b.kind)) ||
      a.id.localeCompare(b.id));
    return {
      records:records.slice(offset,offset + limit), scopes:[appScope,...Array.from(projects,([id,name]) => ({id,name}))],
      total:records.length, offset, limit, errors, observedAt,
      ...(isEvents && {eventTypes:Array.from(eventTypes).sort()}),
      ...(statusSection(section) && {statuses:Array.from(statuses).sort()}),
      ...(isDb ? {
        databases:[{...appScope, source:this.appSource()},
          ...Array.from(projects,([id,name]) => ({id,name,source:this.projectSource(id)}))],
        tables,
      } : {}),
    };
  }

  detail(id: string | null, viewName = 'files'): DataDetail {
    const section = sectionFor(viewName);
    if (viewName !== 'files' && viewName !== 'chats' && viewName !== 'db' && !section) throw new DataBrowserError(400);
    const location = locationFor(id), [storage,table,...keys] = location;
    if (section && table !== sectionTables[section]) throw new DataBrowserError(400);
    const observedAt = new Date().toISOString();
    const isDb = viewName === 'db';
    // アプリ DB が読めない場合でも、孤立した会話ファイルの詳細は読める。
    if (storage === 'chats') {
      if (isDb) throw new DataBrowserError(400);
      const load = (app?: DatabaseView) => {
        const chatId = String(keys[0]), source = this.chatSource(chatId);
        const projects = app ? this.projects(app) : new Map<string,string>();
        const refLocation: Location = ['app','chat_refs',chatId];
        const ref = getRow(app,refLocation);
        directoryStat(this.dataDirectory);
        directoryStat(join(this.dataDirectory,'chats'));
        const stat = fileStat(source);
        const {raw,conversation} = readChat(source,stat,chatId,ref);
        const selected = {id:chatId,stat,reference:ref};
        const versions: SavedChat[] = [selected];
        if (app && ref && isText(ref.scope_key)) {
          try {
            for (const reference of app.db.query<Row,[string,string]>(
              `SELECT ${chatRefColumns} FROM chat_refs WHERE scope_key=? AND chat_id<>?`,
            ).iterate(ref.scope_key,chatId)) {
              if (!validChatId(reference.chat_id)) continue;
              try { versions.push({id:reference.chat_id,stat:fileStat(this.chatSource(reference.chat_id)),reference}); }
              catch { /* 欠損した版は選択肢に含めず、選択版はそのまま表示する。 */ }
            }
          } catch { /* 他の版の情報を取得できなくても、選択版は表示する。 */ }
        }
        const history = versions.sort(compareChatVersions).map(({id,stat}) =>
          ({id:idFor(['chats','chat',id]), revision:id, updatedAt:asDate(stat.mtimeMs)}));
        const scope = projectOf(ref?.project_id,projects);
        let job: Row | null = null;
        if (conversation.workflowJobId) {
          try { job = workflowJob(app,conversation.projectId,conversation.workflowJobId); }
          catch { /* ジョブが読めなくても会話は表示する。 */ }
        }
        let task: Row | null = null;
        const taskId = job?.task_id ?? ref?.task_id;
        if (scope !== appScope.id && validTaskId(taskId)) {
          try { task = this.withProject(scope,view => getRow(view,[scope,'tasks',taskId],job ? undefined : ['name'])); }
          catch { /* タスクが読めなくても会話は表示する。 */ }
        }
        const summary = chatSummary(selected,scope,source,history.length,text(task?.name),job);
        const fields = {
          chat_id:chatId, project_id:conversation.projectId, task_id:conversation.taskId, phase:conversation.phase,
          workflow_job_id:conversation.workflowJobId ?? null, messages:conversation.messages.length,
        };
        const related = this.related(id!,projects,app,conversation.projectId,
          job ?? fields,job ? 'instruction_jobs' : 'chat');
        if (ref) related.unshift({id:idFor(refLocation),name:`chat_refs · ${chatId}`,view:'db'});
        const storageRows: NonNullable<DataDetail['storageRows']> = [];
        if (ref) storageRows.push({source:this.appSource(),table:'chat_refs',row:serializeRow(ref)});
        if (job) {
          storageRows.push({source:this.appSource(),table:'instruction_jobs',row:serializeRow(job)});
          if (task) storageRows.push({source:this.projectSource(scope),table:'tasks',row:serializeRow(task)});
        }
        return {...summary, fields, raw, storageRows, conversation, ...(job && {workflow:describeWorkflow(job,task)}), history, related, observedAt};
      };
      try {
        let started = false;
        try { return this.withApp(view => { started = true; return load(view); }); }
        catch (error) { if (started) throw error; return load(); }
      } catch (error) {
        throw new DataBrowserError(absent(error) ? 404 : 500);
      }
    }

    if (viewName === 'chats') throw new DataBrowserError(400);
    try {
      return this.withApp(app => {
        const projects = this.projects(app);
        if (storage !== 'app' && !projects.has(storage)) throw new DataBrowserError(404);
        const load = (view: DatabaseView, database: string) => view.db.transaction(() => {
          const requestedVersion = !isDb && table === 'document_versions' ? readDocumentVersion(view,location) : null;
          const row = requestedVersion?.row ?? (isDb || table !== 'document_versions' ? getRow(view,location) : null);
          if (!row) throw new DataBrowserError(404);
          const scope = tableScope(storage,table,tableFor(storage,table)!,row,projects);
          const project = storage === 'app' ? undefined : view;
          if (isDb) {
            const summary = summarize(location,row,scope,database);
            const related = this.related(id!,projects,app,scope,row,table,project);
            return {...summary, database:storage, table, rowKey:keys.join(' / '),
              ...describeRow(row), history:[], related, observedAt};
          }
          if (section === 'events') {
            let taskName = '';
            const taskId = text(row.task_id) || null;
            if (taskId) {
              try { taskName = text(getRow(view,[storage,'tasks',taskId],['name'])?.name); }
              catch { /* タスク名が取得できない場合は ID を使う。 */ }
            }
            const summary = eventSummary(location,row,database,taskName);
            const saved = describeRow(row);
            let details: unknown = saved.raw.details ?? null;
            if (isText(details)) {
              try { details = JSON.parse(details); }
              catch { /* 解釈できない保存値もそのまま表示する。 */ }
            }
            const event = {type:summary.name,at:summary.updatedAt,taskId,taskName:taskName || null,
              phase:text(row.phase) || null,details};
            const related = this.related(id!,projects,app,scope,row,table,project,undefined,event);
            return {...summary, ...saved, event, history:[], related, observedAt};
          }
          if (section) return this.sectionDetail(section,location,row,scope,database,observedAt,projects,app,project);
          const getRelated: RelatedRow = (target, fields) => {
            try { return getRow(target[0] === 'app' ? app : view, target, fields); } catch { return null; }
          };
          const summaryRow = {...row};
          const isManagedDocument = table === 'document_versions' || table === 'document_heads';
          const head = table === 'document_heads' ? row : table === 'document_versions' ?
            getRelated([storage,'document_heads',text(row.scope),text(row.name)]) : undefined;
          const version = table === 'document_heads'
            ? readDocumentVersion(view,[storage,'document_versions',text(row.scope),text(row.name),text(row.revision)])
            : requestedVersion;
          if (table === 'document_heads') {
            summaryRow.updated_at = version?.row.updated_at ?? null;
          }
          if (isManagedDocument && storage !== 'app' && validTaskId(row.scope) && view.tables.has('events')) {
            const eventColumns = columns(view,'events');
            if (eventColumns.has('task_id') && eventColumns.has('type')) {
              summaryRow.task_deleted = view.db.query(
                "SELECT 1 FROM events WHERE task_id=? AND type='task.deleted' LIMIT 1",
              ).get(row.scope) ? 1 : 0;
            }
          }
          const summary = summarize(location,summaryRow,scope,database,head);
          const document = isManagedDocument ? describeDocumentVersion(version?.row) : describeDocument(table,storage,row,getRelated);
          if (version && !document) throw new DataBrowserError(500);
          const history = isManagedDocument ? documentHistory(view,storage,row) : [];
          const related = this.related(id!,projects,app,scope,row,table,project,document);
          const saved = requestedVersion?.saved ?? describeRow(row);
          const storageRows: NonNullable<DataDetail['storageRows']> = [];
          if (head) storageRows.push({source:database, table:'document_heads', row:head === row ? saved.raw : serializeRow(head)});
          if (version) storageRows.push({source:database, table:'document_versions', row:version.saved.raw});
          if (table === 'instructions') storageRows.push({source:database, table, row:saved.raw});

          let documentDiff: DocumentDiff | undefined;
          if (isManagedDocument || table === 'instructions') {
            documentDiff = {state:'unavailable', message:'版の履歴を確認できませんでした。'};
            const selectedIndex = history.findIndex(entry => entry.revision === row.revision);
            if (document && selectedIndex >= 0 && history.every(entry => entry.revision && entry.updatedAt)) {
              const previous = history[selectedIndex + 1];
              if (!previous) {
                documentDiff = {state:'initial'};
              } else {
                const previousRow = readDocumentVersion(view,[storage,'document_versions',text(row.scope),text(row.name),previous.revision]);
                if (previousRow) storageRows.push({source:database, table:'document_versions', row:previousRow.saved.raw, role:'previousVersion'});
                documentDiff = compareDocumentVersions(document,describeDocumentVersion(previousRow?.row),previous.revision,summary.name);
              }
            }
          }
          return {...summary, ...saved, ...(storageRows.length && {storageRows}), document, documentDiff, history, related, observedAt};
        })();
        return storage === 'app' ? load(app,this.appSource()) : this.withProject(storage,view => load(view,this.projectSource(storage)));
      });
    } catch (error) {
      if (error instanceof DataBrowserError) throw error;
      throw new DataBrowserError(500);
    }
  }

  private sectionDetail(
    section: Exclude<Section,'events'>, location: Location, row: Row, scope: string, database: string, observedAt: string,
    projects: Map<string,string>, app: DatabaseView, project?: DatabaseView,
  ): DataDetail {
    const [,table] = location;
    const id = idFor(location);
    const saved = describeRow(row);
    const summary = sectionSummary(section,location,row,scope,database);
    const base = {...summary, ...saved, history:[], observedAt};
    const storageRow = (table: string, row: Row) => ({source:database,table,row:serializeRow(row)});
    const related = this.related(id,projects,app,scope,row,table,project);
    if (section === 'agents') return {...base, agent:describeAgent(row,saved.raw,observedAt), related};
    let completed: Row | null = null;
    if (project?.tables.has('events')) {
      try {
        completed = project.db.query<Row,[string]>(`
          SELECT * FROM events WHERE task_id=? AND type='task.completed' ORDER BY at DESC,id DESC LIMIT 1
        `).safeIntegers(true).get(toKey(row.id));
      } catch { /* 完了イベントを読めない場合は日時を推測しない。 */ }
    }
    const task = {
      phase:nullableText(row.phase), status:nullableText(row.status), createdAt:asDate(row.created_at), updatedAt:summary.updatedAt,
      completedAt:asDate(completed?.at), completion:parseSaved(saved.raw.pending_completion), baseline:parseSaved(saved.raw.document_baseline),
    };
    return {...base, task, related, ...(completed && {storageRows:[storageRow('tasks',row),storageRow('events',completed)]})};
  }

  private related(
    id: string, projects: Map<string,string>, app: DatabaseView | undefined, projectId: string, row: Row, table: string,
    project?: DatabaseView, document?: DataDetail['document'], displayedEvent?: DataDetail['event'],
  ): Related {
    const related = new Map<string,Related[number]>();
    const isWorkflowEvent = table === 'events' && workflowTypes.has(text(row.type));
    const workflowDetails = isWorkflowEvent ? displayedEvent?.details ?? parseSaved(row.details) : null;
    const add = (location: Location, name: string) => {
      const otherId = idFor(location);
      const [storage, table] = location;
      const kind = tableFor(storage,table)?.kind;
      const view: DataView = storage === 'chats' ? 'chats' :
        sectionFor(table) ?? (kind && fileKind(kind) ? 'files' : 'db');
      if (otherId !== id) related.set(otherId,{id:otherId,name,view});
    };
    const link = (view: DatabaseView | undefined, location: Location) => {
      const [storage, table, ...keys] = location;
      if (!view?.tables.has(table)) return;
      try {
        const config = tableFor(storage,table)!;
        const predicate = config.keys.map(column => sqlIdentifier(column) + '=?').join(' AND ');
        const field = config.name ? sqlIdentifier(config.name) : sqlIdentifier(config.keys[0]);
        const row = view.db.query<{name:Value}, Key[]>(`SELECT ${field} AS name FROM ${sqlIdentifier(table)} WHERE ${predicate}`).get(...keys);
        if (row) add(location, config.kind === 'document' || config.kind === 'instruction' ?
          toKey(row.name) : `${table} · ${toKey(row.name)}`);
      } catch { /* 欠損した参照元の ID は保存値に残る。 */ }
    };
    const linkChat = (value: unknown, name?: string) => {
      if (!validChatId(value)) return false;
      const path = this.chatSource(value);
      try {
        directoryStat(this.dataDirectory);
        directoryStat(dirname(path));
        fileStat(path);
        add(['chats','chat',value],name ?? `会話 · ${value}`);
        return true;
      } catch { return false; }
    };
    const linkJob = (job: Row) => {
      if (app?.tables.has('chat_refs')) {
        try {
          const refs = app.db.query<{chat_id:string}, [string,string]>(`
            SELECT chat_id FROM chat_refs
            WHERE project_id=? AND workflow_job_id=? AND kind='workflow'
            ORDER BY archived,chat_id DESC
          `);
          for (const ref of refs.iterate(projectId,text(job.id))) {
            if (linkChat(ref.chat_id,`ワークフロー · ${text(job.event_key) || text(job.id)}`)) return;
          }
        } catch { /* 会話を確認できなければジョブ行へ移動する。 */ }
      }
      add(['app','instruction_jobs',toKey(job.ordinal)],text(job.id));
    };
    if (projects.has(projectId)) add(['app','projects',projectId],projects.get(projectId)!);
    const linkProject = (view: DatabaseView) => {
      const taskId = table === 'tasks' ? row.id : row.task_id ?? row.scope;
      if (validTaskId(taskId)) link(view,[projectId,'tasks',taskId]);
      const event = table === 'file_snapshots' ? row.change_id : row.event_id;
      if (event !== null && event !== undefined) link(view,[projectId,'events',toKey(event)]);
      if (table === 'events') {
        const change: Location = [projectId,'file_changes',toKey(row.id)];
        link(view,change);
        if (object(workflowDetails)) {
          const trigger = workflowDetails.triggerEventId;
          if (typeof trigger === 'number' && Number.isSafeInteger(trigger) && trigger > 0) {
            link(view,[projectId,'events',String(trigger)]);
          }
        }
        const revision = object(displayedEvent?.details) ? text(displayedEvent.details.revision) : '';
        if (revision && (displayedEvent?.type === 'document.created' || displayedEvent?.type === 'document.updated')) {
          try {
            const path = text(getRow(view,change,['path'])?.path);
            if (validTaskId(taskId)) {
              const prefix = `.beni/tasks/${taskId}/`;
              if (path.startsWith(prefix)) link(view,[projectId,'document_versions',taskId,path.slice(prefix.length),revision]);
            } else if (path === '.beni/knowledge.md') {
              link(view,[projectId,'document_versions','knowledge','knowledge.md',revision]);
            }
          } catch { /* 参照先が利用できなくてもイベントを表示する。 */ }
        }
      }
      if (table === 'file_changes') {
        link(view,[projectId,'file_snapshots',toKey(row.event_id)]);
        if (row.previous_change_id !== null && row.previous_change_id !== undefined) {
          link(view,[projectId,'file_changes',toKey(row.previous_change_id)]);
        }
      }
      if (table === 'file_snapshots') link(view,[projectId,'file_changes',toKey(row.change_id)]);
      if ((table === 'instruction_jobs' || table === 'document_knowledge_completion') && isText(row.revision)) {
        link(view,[projectId,'document_versions','knowledge','knowledge.md',row.revision]);
      }
    };
    if (project) linkProject(project);
    else if (projects.has(projectId) && (validTaskId(row.task_id) || row.event_id != null)) {
      try { this.withProject(projectId,linkProject); } catch { /* 他の保存元の失敗は詳細から分離する。 */ }
    }
    if (table === 'tasks' && validTaskId(row.id)) {
      if (project?.tables.has('document_heads')) {
        try {
          for (const doc of project.db.query<{name:string}, [string]>(
            'SELECT name FROM document_heads WHERE scope=? ORDER BY name',
          ).iterate(row.id)) add([projectId,'document_heads',row.id,doc.name],doc.name);
        } catch { /* 参照先が利用できなくてもタスクを表示する。 */ }
      }
      if (app?.tables.has('chat_refs')) {
        try {
          const places = new Set<string>();
          for (const ref of app.db.query<{chat_id:string; scope_key:string}, [string,string]>(
            'SELECT chat_id,scope_key FROM chat_refs WHERE project_id=? AND task_id=? ORDER BY archived,phase,chat_id DESC',
          ).iterate(projectId,row.id)) {
            if (!places.has(ref.scope_key) && linkChat(ref.chat_id)) places.add(ref.scope_key);
          }
        } catch { /* 参照先が利用できなくてもタスクを表示する。 */ }
      }
      if (project?.tables.has('events')) {
        try {
          for (const event of project.db.query<{id:bigint; type:string}, [string,number]>(
            'SELECT id,type FROM events WHERE task_id=? ORDER BY at DESC,id DESC LIMIT ?',
          ).safeIntegers(true).iterate(row.id,relatedLimit)) add([projectId,'events',toKey(event.id)],`最近のイベント · ${event.type}`);
        } catch { /* 参照先が利用できなくてもタスクを表示する。 */ }
      }
      if (app?.tables.has('instruction_jobs')) {
        try {
          for (const job of app.db.query<Row, [string,string,number]>(
            'SELECT * FROM instruction_jobs WHERE project_id=? AND task_id=? ORDER BY ordinal DESC LIMIT ?',
          ).safeIntegers(true).iterate(projectId,row.id,relatedLimit)) linkJob(job);
        } catch { /* 参照先が利用できなくてもタスクを表示する。 */ }
      }
    }

    if (!isWorkflowEvent) {
      linkChat(row.chat_id);
      if (table !== 'chat' && validChatId(row.chat_id)) link(app,['app','chat_refs',row.chat_id]);
    }
    if (table === 'chat_changes') linkChat(row.previous_id);
    if (table === 'events' && app?.tables.has('instruction_jobs')) {
      try {
        if (isWorkflowEvent) {
          const job = object(workflowDetails) ? workflowJob(app,projectId,workflowDetails.workflowJobId) : null;
          if (job) linkJob(job);
        } else {
          const job = app.db.query<Row,[string,string]>(
            'SELECT * FROM instruction_jobs WHERE project_id=? AND event_id=?',
          ).safeIntegers(true).get(projectId,toKey(row.id));
          if (job) linkJob(job);
        }
      } catch { /* 参照先が利用できなくてもイベントを表示する。 */ }
    }
    if (isText(row.workflow_job_id)) {
      try {
        const job = workflowJob(app,projectId,row.workflow_job_id);
        if (job) link(app,['app','instruction_jobs',toKey(job.ordinal)]);
      } catch { /* 欠損した参照元の ID は保存値に残る。 */ }
    }
    if (table === 'instruction_jobs') {
      if (isText(row.instruction_revision)) {
        link(app,['app','document_versions','instructions',text(row.event_key) || 'task.completed',row.instruction_revision]);
      }
      const location: Location = ['app','instruction_jobs',toKey(row.ordinal)];
      if (id === idFor(location)) linkJob(row);
      else add(location,`instruction_jobs · ${text(row.id)}`);
    }
    if (table === 'document_heads' || table === 'document_versions') {
      const [storage,view] = project ? [projectId,project] : ['app',app];
      const keys = [text(row.scope),text(row.name)] as const;
      if (table === 'document_versions') link(view,[storage,'document_heads',...keys]);
      const sources = new Set<string>();
      for (const item of document?.items ?? []) {
        if (!object(item) || !Array.isArray(item.sources)) continue;
        for (const source of item.sources) {
          if (!object(source) || !isText(source.id) || !isText(source.revision)) continue;
          const name = source.id.split('/',1)[0];
          const target: Location | undefined = source.kind === 'instruction' ?
            ['app','document_versions','instructions',name,source.revision] :
            source.kind === 'document' && project ?
              [storage,'document_versions',name === 'knowledge.md' ? 'knowledge' : keys[0],name,source.revision] : undefined;
          if (!target || target[0] === storage && target[2] === keys[0] && target[3] === keys[1] && target[4] === row.revision) continue;
          const key = idFor(target);
          if (sources.has(key)) continue;
          sources.add(key);
          link(target[0] === 'app' ? app : view,target);
        }
      }
    }
    return Array.from(related.values());
  }
}
