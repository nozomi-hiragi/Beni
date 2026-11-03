import { api, ApiError } from './api';
import type { Capabilities, TaskDetail, Workflow } from './types';
import { readAttempts } from './components/WorkflowRecovery';

type GenerationResult = { status: string; version?: number; outcomeUnknown?: boolean };
type Pending = { kind: 'requirements' | 'plan'; version: number };
type AdapterKind = 'requirements' | 'plan' | 'execution' | 'review';
const unconfigured: Record<AdapterKind, string> = { requirements: '指示書生成は未接続です', plan: '計画生成は未接続です', execution: '実行先は未接続です', review: '監修先は未接続です' };
class NotConfigured extends Error { constructor(message: string, readonly kind: AdapterKind) { super(message); } }
export async function workflowPost<T>(path: string, body: unknown, kind: AdapterKind): Promise<T> {
  try { return await api<T>(path, body); }
  catch (error) {
    if (error instanceof ApiError && error.status === 503 && error.message === unconfigured[kind]) throw new NotConfigured(error.message, kind);
    throw error;
  }
}
export type OperationState = { busy: string; queued: boolean; pending?: Pending; notice: string; checking: boolean; unconfigured?: AdapterKind };
const states = new Map<number, OperationState>();
const unavailable = new Set<AdapterKind>();
const listeners = new Set<(taskId: number, refresh: boolean) => void>();
const scheduled = new Set<number>();
const key = 'beni-workflow-unconfirmed';
const blocked = new Set<number>();
let storageOK = true;
export function validCapabilities(value: unknown): value is Capabilities {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    ['requirements', 'plan', 'execution', 'review'].every(name => typeof (value as Record<string, unknown>)[name] === 'boolean');
}
export function validProjection(detail: TaskDetail | undefined, id: number): boolean {
  const task = detail?.task;
  return !!task && task.id === id && typeof task.phase === 'string' && !!task.phase.trim() && typeof task.status === 'string' && !!task.status.trim() && task.phase !== '確認が必要' && task.status !== '履歴の確認が必要';
}
try {
  const saved = sessionStorage.getItem(key);
  if (saved !== null) {
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed) || !parsed.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid state');
    for (const id of parsed) blocked.add(id);
  }
} catch { storageOK = false; }
function persist(): boolean {
  if (!storageOK) return false;
  try { sessionStorage.setItem(key, JSON.stringify([...blocked])); return true; }
  catch { storageOK = false; return false; }
}
export function stateFor(id: number): OperationState {
  let value = states.get(id);
  if (!value) { value = { busy: '', queued: false, notice: '', checking: false }; states.set(id, value); }
  return value;
}
export function isBlocked(id: number) { return !storageOK || blocked.has(id); }
export function storageAvailable() { return storageOK; }
export function knownUnavailable(kind: AdapterKind) { return unavailable.has(kind); }
export function clearBlock(id: number): boolean {
  const state = stateFor(id);
  if (state.busy || state.checking) return false;
  blocked.delete(id);
  const ok = persist();
  if (!ok) blocked.add(id);
  else state.queued = false; // Explicit confirmation never restarts queued work.
  notify(id);
  return ok;
}
export function subscribe(fn: (taskId: number, refresh: boolean) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify(id: number, refresh = false) { for (const fn of listeners) fn(id, refresh); }
export function setNotice(id: number, notice: string) { stateFor(id).notice = notice; notify(id); }
export function clearPendingPreview(id: number, kind: Pending['kind'], version: number) {
  const state = stateFor(id), pending = state.pending;
  if (pending && pending.kind === kind && version >= pending.version) { state.pending = undefined; notify(id); }
}
function guardHistory(id: number, history: Workflow): boolean {
  const parsed = readAttempts(history, id);
  return parsed.valid && !parsed.attempts.some(attempt => attempt.status === 'running' ||
    (attempt.kind !== 'review' && ['unknown', 'interrupted'].includes(attempt.status) && !attempt.acknowledged));
}
function start(id: number, label: string): boolean {
  const state = stateFor(id);
  if (state.busy || isBlocked(id)) return false;
  blocked.add(id);
  if (!persist()) { state.notice = '確認状態を保存できないため処理を開始できません。'; notify(id); return false; }
  state.busy = label; notify(id); return true;
}
function knownResult(id: number) { blocked.delete(id); if (!persist()) blocked.add(id); }
function unknown(id: number) { blocked.add(id); persist(); stateFor(id).notice = '処理結果を確認できません。履歴と外部処理を確認してください。'; }
export async function perform(id: number, label: string, op: () => Promise<void>): Promise<void> {
  if (!start(id, label)) return;
  try { await op(); knownResult(id); }
  catch (error) {
    if (error instanceof NotConfigured) {
      knownResult(id); stateFor(id).queued = false; stateFor(id).unconfigured = error.kind; stateFor(id).notice = error.message;
      unavailable.add(error.kind);
      for (const other of states.keys()) notify(other);
    }
    else unknown(id);
  }
  finally {
    const state = stateFor(id); state.busy = ''; notify(id, true);
    if (state.queued && !isBlocked(id)) void drainRequirements(id);
  }
}
async function drainRequirements(id: number): Promise<void> {
  const state = stateFor(id);
  if (!state.queued || state.busy || isBlocked(id) || state.checking) return;
  if (unavailable.has('requirements')) { state.queued = false; state.notice = '指示書生成は未接続です。'; notify(id); return; }
  state.checking = true; notify(id);
  try {
    const [capabilities, history, detail] = await Promise.all([
      api<Capabilities>('/api/workflow/capabilities'),
      api<Workflow>(`/api/tasks/${id}/workflow/events`),
      api<TaskDetail>(`/api/tasks/${id}`),
    ]);
    if (!validCapabilities(capabilities)) { state.queued = false; state.notice = '接続状態を確認できません。'; return; }
    if (!capabilities.requirements) { state.queued = false; state.notice = '指示書生成は未接続です。'; return; }
    if (!validProjection(detail, id) || !guardHistory(id, history)) { state.queued = false; state.notice = '履歴を確認できないため指示書生成を開始できません。'; return; }
  } catch { state.queued = false; state.notice = '接続状態または履歴を確認できません。'; return; }
  finally { state.checking = false; notify(id); }
  await perform(id, '指示書を更新中', async () => {
    while (state.queued) {
      state.queued = false;
      const result = await workflowPost<GenerationResult>(`/api/tasks/${id}/workflow/requirements`, { requestKey: crypto.randomUUID() }, 'requirements');
      if (!result || !['adopted', 'stale', 'failed'].includes(result.status) || result.outcomeUnknown !== false) throw new Error('Unknown outcome');
      if (result.status === 'adopted') {
        if (!Number.isSafeInteger(result.version) || !result.version || result.version < 1) throw new Error('Invalid version');
        state.pending = { kind: 'requirements', version: result.version };
      }
      state.notice = `指示書生成: ${result.status}`; notify(id);
    }
  });
}
export function scheduleRequirements(id: number, initial = false) {
  if (!Number.isSafeInteger(id) || id < 1 || (initial && scheduled.has(id))) return;
  if (initial) scheduled.add(id);
  const state = stateFor(id);
  if (isBlocked(id) && !state.busy) return;
  state.queued = true; notify(id);
  void drainRequirements(id);
}
export function setPendingPreview(id: number, kind: Pending['kind'], version: number) {
  stateFor(id).pending = { kind, version }; notify(id);
}
