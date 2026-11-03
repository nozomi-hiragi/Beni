import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { api } from '../api';

export interface WorkflowEvent { id: number; task_id?: number; kind: string; payload: Record<string, any> }
export interface WorkflowHistory { workflow: WorkflowEvent[]; requirements: any[]; plan: any[]; review: any[] }

export type AttemptKind = 'requirements' | 'plan' | 'execution' | 'review';
export type Attempt = { kind: AttemptKind; id: number; status: string; acknowledged: boolean };
export type RecoveryProps = {
  taskId: number;
  history: WorkflowHistory | null;
  blocked: boolean;
  onClear: () => void;
  onNotice: (text: string) => void;
  onRefresh: () => Promise<void>;
};

const names: Record<AttemptKind, string> = {
  requirements: '指示書生成', plan: '計画生成', execution: '実行', review: '監修',
};
// A recovery request can outlive the mounted view. Keep its lock by task so
// closing and reopening a task cannot dispatch the same operation twice.
const pendingTasks = new Set<number>();
const pendingListeners = new Set<() => void>();
function lock(taskId: number): boolean {
  if (pendingTasks.has(taskId)) return false;
  pendingTasks.add(taskId);
  for (const listener of pendingListeners) listener();
  return true;
}
function unlock(taskId: number) {
  pendingTasks.delete(taskId);
  for (const listener of pendingListeners) listener();
}
const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const unresolved = (attempt: Attempt) => attempt.status === 'running' ||
  (['unknown', 'interrupted'].includes(attempt.status) && !attempt.acknowledged);
// A review has no acknowledgement API. The user can explicitly confirm its
// interruption in this UI, while the backend requires a new plan/approval.
const blocksClear = (attempt: Attempt) => unresolved(attempt) && !(attempt.kind === 'review' && attempt.status === 'interrupted');
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const nonnegativeId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const document = (value: unknown): value is { version: number; content: string } => object(value) && isId(value.version) && nonempty(value.content);
const sameDocument = (left: unknown, right: unknown) => document(left) && document(right) && left.version === right.version && left.content === right.content;
const validEvidence = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(nonempty);

/** An invalid or missing history never permits clearing the confirmation gate. */
export function readAttempts(history: WorkflowHistory | null, taskId?: number): { attempts: Attempt[]; valid: boolean } {
  if (!history || !Array.isArray(history.requirements) || !Array.isArray(history.plan) ||
      !Array.isArray(history.workflow) || !Array.isArray(history.review) || (taskId !== undefined && !isId(taskId))) return { attempts: [], valid: false };
  const attempts = new Map<string, Attempt>();
  for (const kind of ['requirements', 'plan'] as const) {
    for (const event of history[kind]) {
      if (!event || !isId(event.attempt_id) || (taskId !== undefined && event.task_id !== taskId) || typeof event.kind !== 'string' || !object(event.payload)) return { attempts: [], valid: false };
      const key = `${kind}:${event.attempt_id}`;
      const prior = attempts.get(key);
      if (event.kind === 'started') {
        if (prior) return { attempts: [], valid: false };
        attempts.set(key, { kind, id: event.attempt_id, status: 'running', acknowledged: false });
        continue;
      }
      if (!prior) return { attempts: [], valid: false };
      if (event.kind === 'settled') {
        if (prior.status !== 'running' || !['adopted', 'stale', 'unknown', 'failed'].includes(event.payload.status) ||
            typeof event.payload.outcomeUnknown !== 'boolean' || (event.payload.status === 'unknown') !== event.payload.outcomeUnknown) return { attempts: [], valid: false };
        prior.status = event.payload.status;
      } else if (event.kind === 'interrupted') {
        if (prior.status !== 'running' || event.payload.outcomeUnknown !== true) return { attempts: [], valid: false };
        prior.status = 'interrupted';
      } else if (event.kind === 'acknowledged') {
        if (!['unknown', 'interrupted'].includes(prior.status) || prior.acknowledged) return { attempts: [], valid: false };
        prior.acknowledged = true;
      }
      else return { attempts: [], valid: false };
      attempts.set(key, prior);
    }
  }
  const workflowIds = new Set<number>();
  const plans: WorkflowEvent[] = [];
  const approvals = new Map<number, WorkflowEvent>();
  const requests = new Map<number, WorkflowEvent>();
  const results = new Map<number, WorkflowEvent>();
  const reviewEvents = new Map<number, WorkflowEvent>();
  const recordedMessages = new Set<number>();
  let previousEventId = 0;
  for (const event of history.workflow) {
    if (!event || !isId(event.id) || event.id <= previousEventId || workflowIds.has(event.id) || (taskId !== undefined && event.task_id !== taskId) || typeof event.kind !== 'string' || !object(event.payload)) return { attempts: [], valid: false };
    workflowIds.add(event.id);
    previousEventId = event.id;
    if (event.kind === 'instruction' || event.kind === 'feedback') {
      if (!isId(event.payload.messageId) || recordedMessages.has(event.payload.messageId) ||
          (event.kind === 'instruction' && !nonempty(event.payload.original)) ||
          (event.kind === 'feedback' && (!isId(event.payload.attemptId) || !requests.has(event.payload.attemptId) || !nonempty(event.payload.content)))) return { attempts: [], valid: false };
      recordedMessages.add(event.payload.messageId);
    }
    if (event.kind === 'plan' || event.kind === 'approval') {
      if (!isId(event.payload.requirementsVersion) || !isId(event.payload.planVersion) || !nonnegativeId(event.payload.messageId)) return { attempts: [], valid: false };
      if (event.kind === 'plan') plans.push(event);
      else {
        if (!nonempty(event.payload.actor) || !plans.some(plan => plan.id < event.id && plan.payload.requirementsVersion === event.payload.requirementsVersion && plan.payload.planVersion === event.payload.planVersion && plan.payload.messageId === event.payload.messageId)) return { attempts: [], valid: false };
        approvals.set(event.id, event);
      }
    }
    if (event.kind === 'review_result' || event.kind === 'review_interrupted') {
      if (!isId(event.payload.reviewId) || !isId(event.payload.attemptId) || reviewEvents.has(event.payload.reviewId)) return { attempts: [], valid: false };
      reviewEvents.set(event.payload.reviewId, event);
    }
    if (!['execution_requested', 'execution_result', 'execution_interrupted', 'recovery_acknowledged'].includes(event.kind)) continue;
    const id = event.payload.attemptId;
    if (!isId(id)) return { attempts: [], valid: false };
    const key = `execution:${id}`;
    const prior = attempts.get(key);
    if (event.kind === 'execution_requested') {
      const approval = approvals.get(event.payload.approvalId);
      const request = event.payload.request;
      if (prior || !approval || !object(request) || !isId(request.taskId) || (taskId !== undefined && request.taskId !== taskId) || !document(request.requirements) || !document(request.plan) || !nonnegativeId(event.payload.messageId) ||
          request.requirements.version !== approval.payload.requirementsVersion || request.plan.version !== approval.payload.planVersion || event.payload.messageId !== approval.payload.messageId ||
          [...requests.values()].some(requested => requested.payload.approvalId === event.payload.approvalId)) return { attempts: [], valid: false };
      requests.set(id, event);
      attempts.set(key, { kind: 'execution', id, status: 'running', acknowledged: false });
      continue;
    }
    if (!prior) return { attempts: [], valid: false };
    if (event.kind === 'execution_interrupted') {
      if (prior.status !== 'running' || event.payload.outcomeUnknown !== true) return { attempts: [], valid: false };
      prior.status = 'interrupted';
    }
    else if (event.kind === 'execution_result') {
      if (prior.status !== 'running' || typeof event.payload.stale !== 'boolean' || !['succeeded', 'failed'].includes(event.payload.status) || !object(event.payload.result) ||
          (event.payload.status === 'failed' && typeof event.payload.result.outcomeUnknown !== 'boolean') ||
          (event.payload.status === 'succeeded' && (!nonempty(event.payload.result.output) || !validEvidence(event.payload.result.evidence) || (event.payload.result.outcomeUnknown !== undefined && event.payload.result.outcomeUnknown !== false)))) return { attempts: [], valid: false };
      results.set(id, event);
      prior.status = event.payload.result?.outcomeUnknown ? 'unknown' : event.payload.status;
    } else {
      if (!['unknown', 'interrupted'].includes(prior.status) || prior.acknowledged) return { attempts: [], valid: false };
      prior.acknowledged = true;
    }
    attempts.set(key, prior);
  }
  const reviewAttempts = new Set<number>();
  for (const review of history.review) {
    if (!object(review) || !isId(review.id) || !isId(review.task_id) || (taskId !== undefined && review.task_id !== taskId) || !isId(review.attempt_id) || !['running', 'completed', 'changes_requested', 'stale', 'failed', 'interrupted'].includes(review.status) || reviewAttempts.has(review.attempt_id) || attempts.has(`review:${review.id}`)) return { attempts: [], valid: false };
    const request = requests.get(review.attempt_id), execution = results.get(review.attempt_id), snapshot = review.snapshot, event = reviewEvents.get(review.id);
    if (!request || !execution || execution.payload.status !== 'succeeded' || execution.payload.stale !== false || !object(snapshot) ||
        snapshot.taskId !== review.task_id || snapshot.taskId !== request.payload.request.taskId || snapshot.attemptId !== review.attempt_id || snapshot.approvalId !== request.payload.approvalId || snapshot.messageId !== request.payload.messageId ||
        !sameDocument(snapshot.requirements, request.payload.request.requirements) || !sameDocument(snapshot.plan, request.payload.request.plan) || !object(snapshot.execution) ||
        snapshot.execution.output !== execution.payload.result.output || !validEvidence(snapshot.execution.evidence) || JSON.stringify(snapshot.execution.evidence) !== JSON.stringify(execution.payload.result.evidence) ||
        !object(snapshot.generationIds) || !nonnegativeId(snapshot.generationIds.requirements) || !nonnegativeId(snapshot.generationIds.plan)) return { attempts: [], valid: false };
    if (review.status === 'running') {
      if (review.result !== null || event) return { attempts: [], valid: false };
    } else if (!object(review.result) || review.result.status !== review.status || !event || event.id <= execution.id || event.payload.attemptId !== review.attempt_id || event.payload.status !== review.status ||
      (review.status === 'interrupted'
        ? event.kind !== 'review_interrupted' || review.result.outcomeUnknown !== true || event.payload.outcomeUnknown !== true
        : event.kind !== 'review_result' || typeof review.result.stale !== 'boolean' || review.result.stale !== event.payload.stale || review.result.reason !== event.payload.reason ||
          (review.status === 'stale') !== review.result.stale || JSON.stringify(review.result.decision) !== JSON.stringify(event.payload.decision) ||
          (review.status === 'completed' && (review.result.decision?.passed !== true || !nonempty(review.result.decision.feedback))) ||
          (review.status === 'changes_requested' && (review.result.decision?.passed !== false || !nonempty(review.result.decision.feedback))))) return { attempts: [], valid: false };
    reviewAttempts.add(review.attempt_id);
    reviewEvents.delete(review.id);
    attempts.set(`review:${review.id}`, { kind: 'review', id: review.id, status: review.status, acknowledged: false });
  }
  if (reviewEvents.size) return { attempts: [], valid: false };
  return { attempts: [...attempts.values()], valid: true };
}

export default function Recovery(props: RecoveryProps) {
  const [checked, setChecked] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const state = createMemo(() => readAttempts(props.history, props.taskId));
  const taskIdMemo = createMemo(() => props.taskId);
  const needsAttention = createMemo(() => props.blocked || state().attempts.some(attempt =>
    ['unknown', 'interrupted'].includes(attempt.status) && !attempt.acknowledged));
  let alive = true;
  let taskEpoch = 0;
  onCleanup(() => { alive = false; });
  createEffect(() => {
    const taskId = taskIdMemo();
    taskEpoch++;
    setChecked(false);
    const sync = () => setBusy(pendingTasks.has(taskId));
    pendingListeners.add(sync);
    sync();
    onCleanup(() => pendingListeners.delete(sync));
  });
  const sameTask = (id: number, epoch: number) => alive && props.taskId === id && taskEpoch === epoch;
  const errorText = (error: unknown) => error instanceof Error ? error.message : '操作できませんでした';

  async function refresh() {
    const id = props.taskId;
    const epoch = taskEpoch;
    if (!lock(id)) return;
    try { await props.onRefresh(); }
    catch { if (sameTask(id, epoch)) props.onNotice('履歴を取得できません。自動再試行せず、再取得してください。'); }
    finally { unlock(id); }
  }
  async function act(action: 'recover' | 'acknowledge', attempt: Attempt) {
    if (!checked() || !state().valid) return;
    const id = props.taskId;
    const epoch = taskEpoch;
    if (!lock(id)) return;
    try {
      await api(`/api/tasks/${id}/workflow/${action}`, action === 'recover'
        ? { kind: attempt.kind } : { kind: attempt.kind, attemptId: attempt.id });
      if (sameTask(id, epoch)) props.onNotice('操作を保存しました。履歴を確認してから確認待ちを解除してください。');
    } catch (error) {
      if (sameTask(id, epoch)) props.onNotice(errorText(error));
    } finally {
      if (sameTask(id, epoch)) {
        try { await props.onRefresh(); }
        catch { if (sameTask(id, epoch)) props.onNotice('履歴を取得できません。自動再試行せず、再取得してください。'); }
        if (sameTask(id, epoch)) setChecked(false);
      }
      unlock(id);
    }
  }
  async function clear() {
    if (!checked() || !props.blocked || !state().valid) return;
    const id = props.taskId;
    const epoch = taskEpoch;
    if (!lock(id)) return;
    try {
      const fresh = readAttempts(await api<WorkflowHistory>(`/api/tasks/${id}/workflow/events`), id);
      if (!sameTask(id, epoch)) return;
      if (!fresh.valid || fresh.attempts.some(blocksClear)) {
        props.onNotice('処理中または未確認の結果が残っています。復旧・外部結果の確認記録が必要です。');
        return;
      }
      await props.onRefresh();
      if (!sameTask(id, epoch)) return;
      const afterRefresh = readAttempts(await api<WorkflowHistory>(`/api/tasks/${id}/workflow/events`), id);
      if (!sameTask(id, epoch)) return;
      if (!afterRefresh.valid || afterRefresh.attempts.some(blocksClear)) {
        props.onNotice('処理中または未確認の結果が残っています。復旧・外部結果の確認記録が必要です。');
        return;
      }
      props.onClear();
      props.onNotice('確認待ちを解除しました。自動再実行は行いません。追加指示が未反映の場合は「指示書を更新」を押してください。');
    } catch {
      if (sameTask(id, epoch)) props.onNotice('履歴を取得できないため解除しませんでした。');
    } finally { unlock(id); }
  }

  return <details class={`mt-3 rounded-lg border p-3 text-sm ${needsAttention() ? 'border-warning bg-warning/10' : 'border-base-300 bg-base-100'}`} open={needsAttention()}>
    <summary>{needsAttention() ? '処理結果の確認が必要です' : '処理結果の確認と復旧'}</summary>
    <section class="space-y-3 p-3">
      <button type="button" class="btn btn-ghost btn-xs" disabled={busy()} onClick={() => void refresh()}>保存履歴を再取得</button>
      <Show when={state().valid} fallback={<p>履歴を取得できないため確認待ちを解除できません。</p>}>
        <ul class="space-y-2">
          <For each={state().attempts} fallback={<li>保存された試行はありません。</li>}>{attempt =>
            <li>
              <span>{names[attempt.kind]} / 試行 #{attempt.id} / {attempt.status}{attempt.acknowledged ? '（外部結果を確認済み）' : ''} </span>
              <Show when={attempt.status === 'running'}><button type="button" class="btn btn-outline btn-xs" disabled={!checked() || busy()} onClick={() => void act('recover', attempt)}>中断した処理として復旧</button></Show>
              <Show when={attempt.kind !== 'review' && ['unknown', 'interrupted'].includes(attempt.status) && !attempt.acknowledged}><button type="button" class="btn btn-outline btn-xs" disabled={!checked() || busy()} onClick={() => void act('acknowledge', attempt)}>外部結果を確認済みとして記録</button></Show>
              <Show when={attempt.kind === 'review' && ['failed', 'interrupted', 'stale'].includes(attempt.status)}><small class="block">監修の確認・再試行は未実装です。新しい指示と計画、承認が必要です。監修中に追加された指示は引き継がれます。</small></Show>
            </li>
          }</For>
        </ul>
        <label class="flex items-start gap-2"><input type="checkbox" class="checkbox checkbox-sm" checked={checked()} onChange={event => setChecked(event.currentTarget.checked)} />保存履歴と外部処理の状態を自分で確認しました。復旧・確認操作だけを行い、実行を再試行しません。</label>
        <Show when={props.blocked}><button type="button" class="btn btn-outline btn-xs" disabled={!checked() || busy()} onClick={() => void clear()}>履歴確認を完了し、画面の確認待ちを解除</button></Show>
        <p>稼働中の処理はサーバーが復旧を拒否します。復旧・確認待ち解除では生成や実行を再開しません。</p>
      </Show>
    </section>
  </details>;
}
