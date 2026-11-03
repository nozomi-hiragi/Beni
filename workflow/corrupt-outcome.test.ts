import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppHandler } from './runtime';

for (const kind of ['null', 'zero', 'empty', 'unknown', 'false', 'absent'] as const) {
  test(`HTTP handles historical execution outcomeUnknown=${kind} safely`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beni-corrupt-outcome-'));
    const path = join(dir, 'db');
    let executionCalls = 0;
    const app = createAppHandler(path, {
      plan: { generate: async () => ({ content: 'plan' }) },
      execution: { execute: async () => { executionCalls++; return { output: 'done', evidence: ['test'] }; } },
    });
    const db = new Database(path);
    const get = (route: string) => app.fetch(new Request(`http://127.0.0.1:3210${route}`));
    const post = (route: string, data: unknown = {}) => app.fetch(new Request(`http://127.0.0.1:3210${route}`, {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data),
    }));
    try {
      expect((await post('/api/projects', { name: 'example', folder: '/tmp/example' })).status).toBe(201);
      expect((await post('/api/tasks', { projectId: 1, name: 'task' })).status).toBe(201);
      expect((await post('/api/tasks/1/workflow/plan', { requestKey: 'plan' })).status).toBe(200);
      expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 1 })).status).toBe(200);
      expect((await (await post('/api/tasks/1/workflow/execute')).json() as any).status).toBe('succeeded');
      // A fresh approval ensures the following execute could run if malformed history were ignored.
      expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 1 })).status).toBe(200);
      const stored = db.query("SELECT id,payload FROM workflow_events WHERE task_id=1 AND kind='execution_result'").get() as { id: number; payload: string };
      const payload = JSON.parse(stored.payload);
      if (kind === 'absent') delete payload.result.outcomeUnknown;
      else payload.result.outcomeUnknown = ({ null: null, zero: 0, empty: '', unknown: true, false: false } as Record<string, unknown>)[kind];
      db.query('UPDATE workflow_events SET payload=? WHERE id=?').run(JSON.stringify(payload), stored.id);

      const state = await (await get('/api/state')).json() as any;
      const detail = await (await get('/api/tasks/1')).json() as any;
      if (kind === 'null' || kind === 'zero' || kind === 'empty') {
        expect(state.tasks[0].status).toBe('履歴の確認が必要');
        expect(detail.task.status).toBe('履歴の確認が必要');
      } else if (kind === 'unknown') {
        expect(state.tasks[0].status).toBe('結果の確認が必要');
        expect(detail.task.status).toBe('結果の確認が必要');
      } else {
        expect(state.tasks[0].status).toBe('実行指示待ち');
        expect(detail.task.status).toBe('実行指示待ち');
      }

      const approval = await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 1 });
      const execution = await post('/api/tasks/1/workflow/execute');
      if (kind === 'false' || kind === 'absent') {
        expect(approval.status).toBe(200);
        expect(execution.status).toBe(200);
        expect((await execution.json() as any).status).toBe('succeeded');
        expect(executionCalls).toBe(2);
      } else {
        expect(approval.status).toBe(409);
        expect(execution.status).toBe(409);
        expect(executionCalls).toBe(1);
      }
    } finally {
      db.close();
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const kind of ['null', 'zero', 'empty', 'unknown', 'false', 'absent'] as const) {
  test(`HTTP does not silently mark corrupt outcomeUnknown=${kind} as reviewed completion`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beni-corrupt-completed-'));
    const path = join(dir, 'db');
    const app = createAppHandler(path, {
      plan: { generate: async () => ({ content: 'plan' }) },
      execution: { execute: async () => ({ output: 'done', evidence: ['test'] }) },
      review: { review: async () => ({ passed: true, feedback: 'checked' }) },
    });
    const db = new Database(path);
    const get = (route: string) => app.fetch(new Request(`http://127.0.0.1:3210${route}`));
    const post = (route: string, data: unknown = {}) => app.fetch(new Request(`http://127.0.0.1:3210${route}`, {
      method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data),
    }));
    try {
      expect((await post('/api/projects', { name: 'example', folder: '/tmp/example' })).status).toBe(201);
      expect((await post('/api/tasks', { projectId: 1, name: 'task' })).status).toBe(201);
      expect((await post('/api/tasks/1/workflow/plan', { requestKey: 'plan' })).status).toBe(200);
      expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 1 })).status).toBe(200);
      const execution = await (await post('/api/tasks/1/workflow/execute')).json() as { attemptId: number; status: string };
      expect(execution.status).toBe('succeeded');
      expect((await (await post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).json() as any).status).toBe('completed');
      const stored = db.query("SELECT id,payload FROM workflow_events WHERE task_id=1 AND kind='execution_result'").get() as { id: number; payload: string };
      const payload = JSON.parse(stored.payload);
      if (kind === 'absent') delete payload.result.outcomeUnknown;
      else payload.result.outcomeUnknown = ({ null: null, zero: 0, empty: '', unknown: true, false: false } as Record<string, unknown>)[kind];
      db.query('UPDATE workflow_events SET payload=? WHERE id=?').run(JSON.stringify(payload), stored.id);

      const expected = kind === 'unknown' ? '結果の確認が必要'
        : kind === 'false' || kind === 'absent' ? '完了（監修済み）' : '履歴の確認が必要';
      expect(((await (await get('/api/state')).json()) as any).tasks[0].status).toBe(expected);
      expect(((await (await get('/api/tasks/1')).json()) as any).task.status).toBe(expected);
      if (kind === 'null' || kind === 'zero' || kind === 'empty') {
        const acknowledge = await post('/api/tasks/1/workflow/acknowledge', { kind: 'execution', attemptId: execution.attemptId });
        expect(acknowledge.status).toBe(409);
        expect(((await (await get('/api/state')).json()) as any).tasks[0].status).toBe('履歴の確認が必要');
        const unchanged = db.query('SELECT payload FROM workflow_events WHERE id=?').get(stored.id) as { payload: string };
        expect(JSON.parse(unchanged.payload).result.outcomeUnknown).toBe(payload.result.outcomeUnknown);
        expect(db.query("SELECT 1 FROM workflow_events WHERE kind='recovery_acknowledged'").get()).toBeNull();
      }
    } finally {
      db.close();
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
