import { Database } from 'bun:sqlite';
import { statSync } from 'node:fs';
import { Workflow, type Executor } from './index';
import { RequirementsGeneration, type RequirementsAdapter } from './requirements';
import { PlanGeneration, type PlanAdapter } from './plan';
import { ExecutionReview, type Reviewer } from './review';
import { databasePath } from './database';
import { syncDocuments, adoptDocument } from './document-sync';
import { syncChat } from './chat-sync';

export interface WorkflowAdapters {
  requirements?: RequirementsAdapter;
  plan?: PlanAdapter;
  execution?: Executor;
  review?: Reviewer;
}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
// Shared by handlers in this process; persisted state still governs recovery after restart.
const live = new Map<string, number>();
function begin(key: string) { live.set(key, (live.get(key) ?? 0) + 1); }
function end(key: string) { const count = live.get(key) ?? 0; if (count <= 1) live.delete(key); else live.set(key, count - 1); }
async function tracked<T>(key: string, run: () => Promise<T>): Promise<T> {
  begin(key);
  try { return await run(); } finally { end(key); }
}

/** Returns null for unrelated routes. Mount before the server's fallback 404. */
export function createWorkflowHandler(path: string, adapters: WorkflowAdapters = {}, chatDirectory?: string) {
  path = databasePath(path);
  const db = new Database(path);
  // A database may be opened through a symlink or another path. Key live
  // operations by the underlying file identity, not the spelling of a path.
  let dbKey: string;
  try {
    const file = statSync(path);
    dbKey = JSON.stringify([file.dev, file.ino]);
  } catch (error) {
    db.close();
    throw error;
  }
  const folders = new Map<number, string>();
  const sync = (taskId: number) => { if (chatDirectory !== undefined) { syncChat(db, taskId, chatDirectory); folders.set(taskId, syncDocuments(db, taskId).folder); } };
  const publish = (kind: 'requirements' | 'plan') => (taskId: number, expected: string, content: string) => { if (chatDirectory !== undefined) { const folder = folders.get(taskId); if (!folder) throw Error('Documents not synchronized'); adoptDocument(folder, kind, expected, content); } };
  const workflow = new Workflow(path, sync);
  const requirements = new RequirementsGeneration(path, sync, publish('requirements'));
  const plan = new PlanGeneration(path, sync, publish('plan'));
  const review = new ExecutionReview(path, sync);
  const capabilities = { requirements: !!adapters.requirements, plan: !!adapters.plan, execution: !!adapters.execution, review: !!adapters.review };
  const key = (taskId: number, kind: string) => JSON.stringify([dbKey, taskId, kind]);
  return {
    close() { requirements.close(); plan.close(); review.close(); workflow.close(); db.close(); },
    async fetch(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/api\/tasks\/(\d+)\/workflow\/(events|requirements|plan|approve|execute|review|recover|acknowledge)$/);
      const isCapabilities = url.pathname === '/api/workflow/capabilities';
      if (!match && !isCapabilities) return null;
      if (url.hostname !== '127.0.0.1') return json({ error: 'アクセスできません' }, 403);
      if (isCapabilities) return request.method === 'GET' ? json(capabilities) : json({ error: 'アクセスできません' }, 403);
      const taskId = Number(match![1]);
      if (!validId(taskId)) return json({ error: 'タスクを確認してください' }, 400);
      if (!db.query('SELECT 1 FROM tasks WHERE id=?').get(taskId)) return json({ error: 'タスクが見つかりません' }, 404);
      const action = match![2];
      if (action === 'events' && request.method === 'GET') {
        try { sync(taskId); } catch { return json({ error: '会話または文書を同期できませんでした' }, 409); }
        return json({ workflow: workflow.events(taskId), requirements: requirements.history(taskId), plan: plan.history(taskId), review: review.history(taskId) });
      }
      if (request.method !== 'POST' || request.headers.get('origin') !== url.origin || request.headers.get('content-type') !== 'application/json') return json({ error: 'アクセスできません' }, 403);
      try {
        if (Number(request.headers.get('content-length') || 0) > 65536) return json({ error: '入力が長すぎます' }, 413);
        const body = await request.text();
        if (new TextEncoder().encode(body).byteLength > 65536) return json({ error: '入力が長すぎます' }, 413);
        let input: any;
        try { input = JSON.parse(body); } catch { return json({ error: '入力を確認してください' }, 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: '入力を確認してください' }, 400);
        if (action === 'requirements' || action === 'plan') {
          if (!nonempty(input.requestKey) || input.requestKey.length > 256) return json({ error: '入力を確認してください' }, 400);
          if (action === 'requirements') {
            if (!adapters.requirements) return json({ error: '指示書生成は未接続です' }, 503);
            const operationKey = key(taskId, 'requirements');
            const adapter = adapters.requirements;
            return json(await tracked(operationKey, () => requirements.generate(taskId, input.requestKey, {
              generate: (snapshot, signal) => tracked(operationKey, () => adapter.generate(snapshot, signal)),
            }, request.signal)));
          }
          if (!adapters.plan) return json({ error: '計画生成は未接続です' }, 503);
          const operationKey = key(taskId, 'plan');
          const adapter = adapters.plan;
          return json(await tracked(operationKey, () => plan.generate(taskId, input.requestKey, {
            generate: (snapshot, signal) => tracked(operationKey, () => adapter.generate(snapshot, signal)),
          }, request.signal)));
        }
        if (action === 'approve') {
          if (!validId(input.requirementsVersion) || !validId(input.planVersion)) return json({ error: '入力を確認してください' }, 400);
          return json({ approvalId: workflow.approve(taskId, input.requirementsVersion, input.planVersion, 'user') });
        }
        if (action === 'execute') {
          if (!adapters.execution) return json({ error: '実行先は未接続です' }, 503);
          const operationKey = key(taskId, 'execution');
          const adapter = adapters.execution;
          return json(await tracked(operationKey, () => workflow.execute(taskId, {
            execute: (snapshot, signal) => tracked(operationKey, () => adapter.execute(snapshot, signal)),
          }, request.signal)));
        }
        if (action === 'review') {
          if (!validId(input.attemptId)) return json({ error: '入力を確認してください' }, 400);
          if (!adapters.review) return json({ error: '監修先は未接続です' }, 503);
          if (review.history(taskId).some(item => item.attempt_id === input.attemptId)) return json({ error: 'この実行の監修は記録済みです。監修の再試行は未実装です' }, 409);
          const operationKey = key(taskId, 'review');
          const adapter = adapters.review;
          return json(await tracked(operationKey, () => review.review(taskId, input.attemptId, {
            review: (snapshot, signal) => tracked(operationKey, () => adapter.review(snapshot, signal)),
          }, request.signal)));
        }
        if (action === 'recover' || action === 'acknowledge') {
          sync(taskId);
          if (!['requirements', 'plan', 'execution', 'review'].includes(input.kind)) return json({ error: '入力を確認してください' }, 400);
          if (live.has(key(taskId, input.kind))) return json({ error: '処理中のため復旧できません。結果を確認してください' }, 409);
          if (action === 'recover') {
            const count = input.kind === 'requirements' ? requirements.recover(taskId) : input.kind === 'plan' ? plan.recover(taskId) : input.kind === 'review' ? review.recover(taskId) : workflow.recover(taskId);
            return json({ count });
          }
          if (!validId(input.attemptId)) return json({ error: '入力を確認してください' }, 400);
          if (input.kind === 'review') return json({ error: '監修の結果確認後の再試行は未実装です' }, 409);
          if (input.kind === 'requirements') requirements.acknowledge(taskId, input.attemptId, 'user');
          else if (input.kind === 'plan') plan.acknowledge(taskId, input.attemptId, 'user');
          else workflow.acknowledgeRecovery(taskId, input.attemptId, 'user');
          return json({ acknowledged: true });
        }
        return json({ error: '見つかりません' }, 404);
      } catch {
        // Never return driver, adapter, or SQL error messages to the browser.
        return json({ error: '現在の状態では操作できません。状態と履歴を確認してください' }, 409);
      }
    },
  };
}
