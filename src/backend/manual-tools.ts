import { createHash } from 'node:crypto';
import type { ManualToolDefinition, ManualToolOperation, ManualToolScope, ManualToolsCatalog } from '../shared/manual-tools';
import { validateManualToolInput } from '../shared/manual-tools';
import { INSTRUCTIONS_CHAT_ID } from '../shared/communication';
import { validProjectId, validTaskId } from '../shared/ids';
import { isTaskPhase } from '../shared/task-phase';
import { instructionTools, shorten, type ChatService } from './chat';
import type { DocumentWorkflow } from './document-workflow';
import { eventToolArguments, eventTools, ManualToolInputError, type EmbeddedTool } from './embedded-tools';
import { isInstructionKey } from './instructions';
import type { Store } from './store';

const maxOutputBytes = 1024 * 1024;
const busyReason = 'この対象では別の処理が実行中です';
const opIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const object = (value: unknown): value is Record<string, unknown> =>
 typeof value === 'object' && value !== null && !Array.isArray(value);
const projectIdFor = (scope: ManualToolScope) => scope.kind === 'project' ? scope.projectId : INSTRUCTIONS_CHAT_ID;
const taskIdFor = (scope: ManualToolScope) => scope.kind === 'project' ? scope.taskId ?? null : null;
const sameScope = (a: ManualToolScope, b: ManualToolScope) =>
 projectIdFor(a) === projectIdFor(b) && taskIdFor(a) === taskIdFor(b);

export class ManualToolRequestError extends Error {
 constructor(readonly status: number, message: string) { super(message); }
}

function scopeFrom(value: unknown): ManualToolScope {
 if (object(value)) {
  if (value.kind === 'instructions' && Object.keys(value).length === 1) return { kind: 'instructions' };
  if (value.kind === 'project' && validProjectId(value.projectId) &&
      (!Object.hasOwn(value, 'taskId') || validTaskId(value.taskId)) &&
      Object.keys(value).every(key => ['kind', 'projectId', 'taskId'].includes(key))) {
   return { kind: 'project', projectId: value.projectId, ...(typeof value.taskId === 'string' ? {taskId: value.taskId} : {}) };
  }
 }
 throw new ManualToolRequestError(400, '操作対象を確認してください');
}
export function manualToolQueryScope(query: URLSearchParams) {
 const pairs = [...query];
 const fields = Object.fromEntries(pairs);
 if (Object.keys(fields).length !== pairs.length) throw new ManualToolRequestError(400, '操作対象を確認してください');
 return scopeFrom(fields);
}

function canonicalJson(value: unknown): string {
 if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
 if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
 return JSON.stringify(value);
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const definition = (tool: EmbeddedTool, category: ManualToolDefinition['category']): ManualToolDefinition => ({
 name: tool.name,
 description: tool.description,
 inputSchema: tool.inputSchema,
 category,
 effect: tool.name === 'finish_retrospective' ? 'complete' :
  tool.name === 'edit_document' || tool.name === 'update_instruction' ? 'write' : 'read'
});

export class ManualTools {
 private readonly live = new Set<string>();
 constructor(private readonly store: Store, private readonly chat: ChatService, private readonly workflow: DocumentWorkflow) {}

 private target(scope: ManualToolScope): { label: string; phase: ManualToolsCatalog['phase']; folder?: string; status?: string; stateCursor?: number } {
  if (scope.kind === 'instructions') return { label: 'インストラクション管理', phase: null };
  const project = this.store.project(scope.projectId);
  if (!project) throw new ManualToolRequestError(404, 'プロジェクトが見つかりません');
  if (!this.store.canRunProject(scope.projectId)) throw new ManualToolRequestError(409, '作業フォルダーと保存データを確認してください');
  if (scope.taskId === undefined) return { label: project.name, phase: null, folder: project.folder };
  const task = this.store.task(scope.taskId);
  if (!task || task.project_id !== scope.projectId) throw new ManualToolRequestError(404, 'タスクが見つかりません');
  if (!isTaskPhase(task.phase)) throw new ManualToolRequestError(409, 'フェーズを確認してください');
  return { label: project.name + ' / ' + task.name, phase: task.phase, folder: project.folder, status: task.status,
   stateCursor: this.store.taskStateCursor(project.id, task.id) };
 }

 private current(scope: ManualToolScope) {
  const { label, phase, folder, status, stateCursor } = this.target(scope);
  const p = projectIdFor(scope), t = taskIdFor(scope);
  const reviewState = t && phase === 'retrospective' ? this.workflow.review(p, t)?.state : undefined;
  const writable = status === 'idle' && phase !== 'execution' && phase !== 'finalization' &&
   reviewState !== 'pending' && reviewState !== 'running';
  const tools = scope.kind === 'instructions' ? instructionTools.map(tool => definition(tool, 'instructions')) : [
   ...eventTools.filter(tool => tool.name !== 'acknowledge_events').map(tool => definition(tool, 'events')),
   ...(t && phase ? this.workflow.manualTools(p, t, phase, writable, reviewState).map(tool => definition(tool, 'documents')) : [])
  ];
  const finalizingFolder = t === null || phase === 'finalization' ? folder : undefined;
  const disabledReason = this.chat.manualToolScopeBusy(p, t, finalizingFolder) ||
   this.workflow.manualToolBusy(p, t) ? busyReason : undefined;
  const folderGeneration = scope.kind === 'project' ? this.store.projectFolderGeneration(p) : undefined;
  const revision = hash(JSON.stringify([scope, label, phase, folder, folderGeneration, status, stateCursor, reviewState, tools]));
  const catalog: ManualToolsCatalog = {scope, label, phase, revision, tools, ...(disabledReason ? {disabledReason} : {})};
  return {catalog, finalizingFolder};
 }

 catalog(scope: ManualToolScope) { return this.current(scope).catalog; }

 operation(scope: ManualToolScope, id: string) {
  if (!opIdPattern.test(id)) throw new ManualToolRequestError(400, '操作 ID を確認してください');
  const record = this.store.manualToolOperation(id);
  if (!record || !sameScope(record.operation.scope, scope)) throw new ManualToolRequestError(404, '操作が見つかりません');
  return this.operationStatus(record.operation);
 }

 private operationStatus(operation: ManualToolOperation): ManualToolOperation {
  if (operation.status !== 'running' || this.live.has(operation.id)) return operation;
  return { ...operation, status: 'unknown', error: '実行結果を確認できませんでした' };
 }

 accept(body: Record<string, unknown>) {
  const scope = scopeFrom(body.scope);
  const { operationId: id, revision, name, input } = body;
  if (typeof id !== 'string' || !opIdPattern.test(id) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) ||
      typeof name !== 'string' || !object(input) || Object.keys(body).some(key => !['scope','operationId','revision','name','input'].includes(key))) {
   throw new ManualToolRequestError(400, 'ツールの実行情報を確認してください');
  }
  const fingerprint = hash(canonicalJson([scope, name, input]));
  const replay = this.store.manualToolOperation(id);
  if (replay) return this.replay(replay, scope, fingerprint);

  const {catalog, finalizingFolder} = this.current(scope);
  if (catalog.revision !== revision) throw new ManualToolRequestError(409, '操作対象の状態が変更されました。一覧を取得し直してください');
  const tool = catalog.tools.find(tool => tool.name === name);
  if (!tool) throw new ManualToolRequestError(400, 'この対象で利用できるツールを指定してください');
  const invalid = validateManualToolInput(tool.inputSchema, input);
  if (invalid) throw new ManualToolRequestError(400, invalid);
  if (tool.category === 'events') {
   try { eventToolArguments(name, input); }
   catch (error) { throw new ManualToolRequestError(400, error instanceof ManualToolInputError ? error.message : 'イベントの入力を確認してください'); }
  }
  if (tool.category === 'instructions' && name !== 'list_instructions' && !isInstructionKey(input.key)) {
   throw new ManualToolRequestError(400, 'インストラクションのキーを確認してください');
  }
  if (catalog.disabledReason) throw new ManualToolRequestError(409, catalog.disabledReason);

  const p = projectIdFor(scope), t = taskIdFor(scope);
  const release = this.chat.reserveManualTool(p, t, finalizingFolder);
  try {
   const run = this.prepare(tool, catalog, id, input);
   const timestamp = new Date().toISOString();
   const operation: ManualToolOperation = { id, scope, label: catalog.label, phase: catalog.phase, name, input, status: 'running', createdAt: timestamp, updatedAt: timestamp };
   if (!this.store.acceptManualToolOperation(operation, fingerprint)) {
    release();
    return this.replay(this.store.manualToolOperation(id)!, scope, fingerprint);
   }
   this.live.add(id);
   setTimeout(() => {
    void this.run(operation, () => {
     if (scope.kind === 'project' && !this.store.canRunProject(p)) {
      throw new ManualToolInputError('作業フォルダーと保存データを確認してください');
     }
     if (this.current(scope).catalog.revision !== revision) {
      throw new ManualToolInputError('操作対象の状態が変更されました。一覧を取得し直してください');
     }
     return run();
    }).finally(() => {
     this.live.delete(id);
     release();
     this.workflow.manualToolReleased();
    });
   }, 0);
   return { operation, status: 202 };
  } catch (error) {
   release();
   throw error;
  }
 }

 private replay(record: { operation: ManualToolOperation; fingerprint: string }, scope: ManualToolScope, fingerprint: string) {
  if (!sameScope(record.operation.scope, scope)) throw new ManualToolRequestError(404, '操作が見つかりません');
  if (record.fingerprint !== fingerprint) throw new ManualToolRequestError(409, '同じ操作 ID に異なる入力が指定されています');
  return { operation: this.operationStatus(record.operation), status: 200 };
 }

 private prepare(tool: ManualToolDefinition, catalog: ManualToolsCatalog, id: string, input: Record<string, unknown>) {
  const p = projectIdFor(catalog.scope), t = taskIdFor(catalog.scope);
  if (tool.category === 'instructions') return () => {
   const result = this.chat.callInstructionTool(tool.name, input);
   if (result.ok) return result.value;
   if (result.value.error === 'インストラクションが変更されています。最新の本文を確認してください') {
    throw new ManualToolInputError(result.value.error);
   }
   throw new ManualToolInputError('インストラクションを保存できませんでした。本文と変数を確認してください');
  };
  if (tool.category === 'events') {
   this.store.captureTaskHistory(p, t);
   const through = this.store.projectEventCursor(p);
   if (typeof input.task_id === 'string' && this.store.task(input.task_id)?.project_id !== p) {
    const {events} = this.store.projectEvents(p, {through, taskId: input.task_id, types: ['task.deleted'], limit: 1, modelPage: true});
    if (!events.length) throw new ManualToolRequestError(400, 'プロジェクト内のタスクを指定してください');
   }
   const after = input.after;
   const end = input.through ?? through;
   if ((typeof after === 'number' && typeof end === 'number' && after > end) ||
       (typeof end === 'number' && end > through) ||
       [input.event_id, input.change_id].some(value => typeof value === 'number' && value > through)) {
    throw new ManualToolRequestError(400, 'イベントの取得範囲を確認してください');
   }
   return () => this.chat.callEventTool(p, t, { after: 0, through }, tool.name, input);
  }
  const context = this.workflow.manualContext(p, t!, catalog.phase!, id);
  return () => this.workflow.call(context, tool.name, input);
 }

 private async run(operation: ManualToolOperation, run: () => unknown) {
  let result: ManualToolOperation;
  try {
   const value = await run();
   const text = JSON.stringify(value);
   const output = shorten(text, maxOutputBytes, text => Buffer.byteLength(text, 'utf8'));
   result = { ...operation, status: 'completed', output };
  } catch (error) {
   const message = error instanceof ManualToolInputError ? error.message : 'ツールを実行できませんでした';
   result = { ...operation, status: 'failed', error: message };
  }
  try {
   this.store.saveManualToolOperation({ ...result, updatedAt: new Date().toISOString() });
  } catch { /* 結果の保存が確定しなければ照会で結果不明を返す。 */ }
 }
}
