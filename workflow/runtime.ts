import { Database } from 'bun:sqlite';
import { Store } from '../store';
import { createHandler } from '../server';
import { createWorkflowHandler, type WorkflowAdapters } from './http';
import { databasePath } from './database';

type Task = { id: number; phase: string; status: string; [key: string]: unknown };
type Event = { id: number; kind: string; payload: any };
class CorruptHistory extends Error {}
function objectJson(value: unknown): Record<string, any> {
  if (typeof value !== 'string') throw new CorruptHistory('invalid stored JSON');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) {
    if (error instanceof SyntaxError) throw new CorruptHistory('invalid stored JSON');
    throw error;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CorruptHistory('invalid stored object');
  return parsed as Record<string, any>;
}
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const sameDocument = (a: any, b: any) => !!a && !!b && a.version === b.version && a.content === b.content;
function assertCompleted(taskId: number, requirements: any, plan: any, approval: Event, requested: Event, result: Event, verdict: Event, attempts: any[], reviews: any[]) {
  const execution = result.payload.result;
  if (!nonempty(execution?.output) || !Array.isArray(execution.evidence) || !execution.evidence.length || !execution.evidence.every(nonempty)) throw new CorruptHistory('execution evidence missing');
  const attempt = attempts.find(r => r.id === requested.payload.attemptId);
  const review = reviews.find(r => r.id === verdict.payload.reviewId);
  if (!attempt || attempt.status !== 'succeeded' || attempts[0]?.id !== attempt.id || !review || review.task_id !== taskId || review.attempt_id !== attempt.id || review.status !== 'completed') throw new CorruptHistory('execution or review reference mismatch');
  const request = requested.payload.request, savedRequest = objectJson(attempt.payload), snapshot = objectJson(review.snapshot), savedReview = objectJson(review.result);
  if (request?.taskId !== taskId || savedRequest.taskId !== taskId || snapshot.taskId !== taskId || snapshot.attemptId !== attempt.id || snapshot.approvalId !== approval.id || snapshot.messageId !== approval.payload.messageId || requested.payload.messageId !== approval.payload.messageId || !sameDocument(request.requirements, requirements) || !sameDocument(request.plan, plan) || !sameDocument(savedRequest.requirements, request.requirements) || !sameDocument(savedRequest.plan, request.plan) || !sameDocument(snapshot.requirements, request.requirements) || !sameDocument(snapshot.plan, request.plan)) throw new CorruptHistory('saved snapshot mismatch');
  if (snapshot.execution?.output !== execution.output || !Array.isArray(snapshot.execution?.evidence) || JSON.stringify(snapshot.execution.evidence) !== JSON.stringify(execution.evidence)) throw new CorruptHistory('saved evidence mismatch');
  if (savedReview.status !== 'completed' || savedReview.stale !== false || savedReview.decision?.passed !== true || !nonempty(savedReview.decision.feedback) || savedReview.decision.feedback !== verdict.payload.decision?.feedback) throw new CorruptHistory('saved review mismatch');
}

/** Derived display state; does not overwrite the persisted workflow records. */
function projectTask(db: Database, task: Task, tables: Set<string>): Task {
  const rows = (table: string) => tables.has(table) ? db.query(`SELECT * FROM ${table} WHERE task_id=? ORDER BY id DESC`).all(task.id) as any[] : [];
  const reqGenerations = rows('requirement_generations');
  const planGenerations = rows('plan_generations');
  const attempts = rows('execution_attempts');
  const reviews = rows('execution_reviews');
  // Preserve the existing UI's canonical value for the requirements phase.
  const display = (phase: string, status: string) => ({ ...task, phase: phase === 'タスク内容' ? 'requirements' : phase, status });
  if (reqGenerations.some(r => r.status === 'running')) return display('タスク内容', '指示書を作成中');
  if (planGenerations.some(r => r.status === 'running')) return display('実装フロー', '計画を作成中');
  if (attempts.some(r => r.status === 'running')) return display('実装中', '実行中');
  if (reviews.some(r => r.status === 'running')) return display('実装中', '監修中');
  if (reqGenerations.some(r => ['unknown', 'interrupted'].includes(r.status) && !r.acknowledged_by)) return display('タスク内容', '結果の確認が必要');
  if (planGenerations.some(r => ['unknown', 'interrupted'].includes(r.status) && !r.acknowledged_by)) return display('実装フロー', '結果の確認が必要');

  const events = (rows('workflow_events') as Event[]).reverse().map(e => ({ ...e, payload: objectJson(e.payload) }));
  const last = (kind: string) => events.filter(e => e.kind === kind).at(-1);
  const doc = (kind: string) => db.query('SELECT version,content FROM documents WHERE task_id=? AND kind=? ORDER BY version DESC LIMIT 1').get(task.id, kind) as { version: number } | null;
  const requirements = doc('requirements'), plan = doc('plan');
  const latestMessage = (db.query("SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE task_id=? AND role='user'").get(task.id) as { id: number }).id;
  const planEvent = last('plan');
  if (!planEvent || !requirements || !plan || planEvent.payload.requirementsVersion !== requirements.version || planEvent.payload.planVersion !== plan.version || planEvent.payload.messageId !== latestMessage) {
    return display('タスク内容', planEvent ? '追加指示・変更あり' : '入力待ち');
  }
  const approval = last('approval');
  if (!approval || approval.payload.requirementsVersion !== requirements.version || approval.payload.planVersion !== plan.version || approval.payload.messageId !== latestMessage || approval.id < planEvent.id) return display('実装フロー', '計画の確認待ち');
  const requested = events.filter(e => e.kind === 'execution_requested' && e.payload.approvalId === approval.id).at(-1);
  if (!requested) return display('実装フロー', '実行指示待ち');
  const result = events.filter(e => e.kind === 'execution_result' && e.payload.attemptId === requested.payload.attemptId).at(-1);
  if (!result) return display('実装中', '結果の確認が必要');
  if (result.payload.result?.outcomeUnknown) return display('実装中', '結果の確認が必要');
  if (result.payload.stale === true) return display('タスク内容', '追加指示・変更あり');
  if (result.payload.stale !== false) throw new CorruptHistory('invalid execution freshness');
  if (result.payload.status !== 'succeeded') return display('実装中', '実行失敗');
  const verdict = events.filter(e => e.kind === 'review_result' && e.payload.attemptId === requested.payload.attemptId).at(-1);
  if (!verdict) {
    if (reviews.some(r => r.attempt_id === requested.payload.attemptId && r.status === 'interrupted')) return display('実装中', '監修結果の確認が必要');
    return display('実装中', '監修待ち');
  }
  if (verdict.payload.status === 'completed' && verdict.payload.stale === false && verdict.payload.decision?.passed === true) {
    assertCompleted(task.id, requirements, plan, approval, requested, result, verdict, attempts, reviews);
    return display('実装中', '完了（監修済み）');
  }
  if (verdict.payload.status === 'changes_requested' && verdict.payload.stale === false) return display('実装フロー', '手直しが必要');
  if (verdict.payload.status === 'stale') return display('実装中', '監修結果は旧版');
  return display('実装中', '監修結果の確認が必要');
}

/** One application owns both handlers and their database connections. */
export function createAppHandler(path: string, adapters: WorkflowAdapters = {}) {
  path = databasePath(path);
  const store = new Store(path);
  let workflow: ReturnType<typeof createWorkflowHandler>;
  try { workflow = createWorkflowHandler(path, adapters); }
  catch (error) { store.close(); throw error; }
  let projection: Database;
  try { projection = new Database(path); }
  catch (error) { try { workflow.close(); } finally { store.close(); } throw error; }
  const application = createHandler(store);
  let closed = false;
  return {
    async fetch(request: Request): Promise<Response> {
      if (closed) return Response.json({ error: '終了しています' }, { status: 503 });
      const workflowResponse = await workflow.fetch(request);
      if (workflowResponse) return workflowResponse;
      const response = await application(request);
      const url = new URL(request.url);
      const isState = url.pathname === '/api/state';
      const isDetail = /^\/api\/tasks\/\d+$/.test(url.pathname);
      if (request.method !== 'GET' || (!isState && !isDetail) || response.status !== 200) return response;
      const data = await response.json() as { tasks?: Task[]; task?: Task; [key: string]: unknown };
      const projected = projection.transaction(() => {
        const tables = new Set((projection.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
        const project = (task: Task) => {
          try { return projectTask(projection, task, tables); }
          catch (error) {
            if (error instanceof CorruptHistory) return { ...task, phase: '確認が必要', status: '履歴の確認が必要' };
            throw error;
          }
        };
        if (isState) return { ...data, tasks: data.tasks!.map(project) };
        return { ...data, task: project(data.task!) };
      })();
      return Response.json(projected, { headers: response.headers });
    },
    close() {
      if (closed) return;
      closed = true;
      try { workflow.close(); } finally { try { projection.close(); } finally { store.close(); } }
    },
  };
}
