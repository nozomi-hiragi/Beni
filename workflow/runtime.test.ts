import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppHandler } from './runtime';
import type { WorkflowAdapters } from './http';

function fixture(adapters: WorkflowAdapters = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beni-runtime-'));
  const path = join(dir, 'db');
  const app = createAppHandler(path, adapters);
  const get = (path: string) => app.fetch(new Request(`http://127.0.0.1:3210${path}`));
  const post = (path: string, data: unknown = {}) => app.fetch(new Request(`http://127.0.0.1:3210${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data) }));
  return { app, path, dir, get, post, close() { app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('application routes support instructions through separately approved execution and review with fake adapters', async () => {
  let executed = 0, reviewed = 0;
  const f = fixture({
    requirements: { generate: async snapshot => { expect(snapshot.instructions[0].content).toBe(' raw instruction '); return { content: '# requirements' }; } },
    plan: { generate: async snapshot => { expect(snapshot.requirements.content).toBe('# requirements'); return { content: '# plan' }; } },
    execution: { execute: async snapshot => { executed++; expect(snapshot.plan.content).toBe('# plan'); return { output: 'done', evidence: ['fake verification'] }; } },
    review: { review: async snapshot => { reviewed++; expect(snapshot.execution.output).toBe('done'); expect(snapshot.execution.evidence).toEqual(['fake verification']); return { passed: true, feedback: 'verified by fake reviewer' }; } },
  });
  try {
    expect((await f.get('/')).status).toBe(200);
    expect((await f.post('/api/projects', { name: 'Demo', folder: f.dir })).status).toBe(201);
    expect((await f.post('/api/tasks', { projectId: 1, name: 'Task' })).status).toBe(201);
    expect((await f.post('/api/tasks/1/messages', { content: ' raw instruction ' })).status).toBe(201);
    expect((await (await f.post('/api/tasks/1/workflow/requirements', { requestKey: 'r1' })).json()).status).toBe('adopted');
    expect((await (await f.post('/api/tasks/1/workflow/plan', { requestKey: 'p1' })).json()).status).toBe('adopted');
    expect((await f.post('/api/tasks/1/workflow/execute')).status).toBe(409);
    expect((await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 2, planVersion: 2 })).status).toBe(200);
    expect(executed).toBe(0);
    const execution = await (await f.post('/api/tasks/1/workflow/execute')).json();
    expect(execution.status).toBe('succeeded');
    expect(reviewed).toBe(0);
    const review = await (await f.post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).json();
    expect(review.status).toBe('completed');
    expect(review.decision.passed).toBe(true);
    expect(reviewed).toBe(1);
    expect(executed).toBe(1);
    const detail = await (await f.get('/api/tasks/1')).json();
    expect(detail.messages[0].content).toBe(' raw instruction ');
    expect(detail.documents.some((d: any) => d.content === '# requirements')).toBe(true);
    expect((await f.get('/not-found')).status).toBe(404);
    expect((await f.app.fetch(new Request('http://evil.test/api/state'))).status).toBe(403);
  } finally { f.close(); }
});

test('default application is unconnected and closing is idempotent', async () => {
  const f = fixture();
  try {
    await f.post('/api/projects', { name: 'Demo', folder: f.dir });
    await f.post('/api/tasks', { projectId: 1, name: 'Task' });
    expect(await (await f.get('/api/workflow/capabilities')).json()).toEqual({ requirements: false, plan: false, execution: false, review: false });
    for (const action of ['requirements', 'plan', 'execute']) expect((await f.post(`/api/tasks/1/workflow/${action}`, { requestKey: 'key' })).status).toBe(503);
    expect((await f.post('/api/tasks/1/workflow/review', { attemptId: 1 })).status).toBe(503);
    f.app.close(); f.app.close();
    expect((await f.get('/api/state')).status).toBe(503);
  } finally { f.close(); }
});

test('application serves current UI routes and records user instructions atomically', async () => {
  let seen: unknown;
  const f = fixture({ requirements: { generate: async snapshot => { seen = snapshot.instructions; return { content: '# revised' }; } } });
  const db = new Database(f.path);
  try {
    for (const route of ['/settings', '/project/1?task=1']) {
      const response = await f.get(route);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('/ui/build/app.js');
    }
    expect((await f.get('/api/missing')).status).toBe(404);
    await f.post('/api/projects', { name: 'Demo', folder: f.dir });
    await f.post('/api/tasks', { projectId: 1, name: 'Task' });
    const message = await (await f.post('/api/tasks/1/messages', { content: '  original request  ' })).json();
    const history = await (await f.get('/api/tasks/1/workflow/events')).json();
    expect(history.workflow.filter((event: any) => event.kind === 'instruction')).toHaveLength(1);
    expect(history.workflow.find((event: any) => event.kind === 'instruction').payload).toEqual({ messageId: message.id, original: '  original request  ' });
    expect((await f.post('/api/tasks/1/workflow/requirements', { requestKey: 'req' })).status).toBe(200);
    expect(seen).toEqual([{ id: message.id, content: '  original request  ' }]);

    db.exec("CREATE TRIGGER reject_instruction BEFORE INSERT ON workflow_events WHEN NEW.kind = 'instruction' BEGIN SELECT RAISE(ABORT, 'test'); END");
    expect((await f.post('/api/tasks/1/messages', { content: 'must roll back' })).status).toBe(400);
    const detail = await (await f.get('/api/tasks/1')).json();
    expect(detail.messages.map((item: any) => item.content)).toEqual(['  original request  ']);
  } finally { db.close(); f.close(); }
});

test('application rejects connection-local in-memory databases', () => {
  for (const path of ['', ':memory:', 'file::memory:?cache=shared']) expect(() => createAppHandler(path)).toThrow();
});

test('same-process symlink aliases cannot recover a live operation', async () => {
  let started!: () => void, finish!: (value: { content: string }) => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<{ content: string }>(resolve => { finish = resolve; });
  const f = fixture({ requirements: { generate: () => { started(); return pending; } } });
  const alias = `${f.path}-alias`;
  let second: ReturnType<typeof createAppHandler> | undefined;
  try {
    symlinkSync(f.path, alias);
    second = createAppHandler(alias);
    await f.post('/api/projects', { name: 'Demo', folder: f.dir });
    await f.post('/api/tasks', { projectId: 1, name: 'Task' });
    const running = f.post('/api/tasks/1/workflow/requirements', { requestKey: 'req' });
    await entered;
    const recover = await second.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/recover', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'requirements' }) }));
    expect(recover.status).toBe(409);
    finish({ content: '# done' });
    const runningResponse = await running;
    const runningResult = await runningResponse.json();
    expect(runningResult.status).toBe('adopted');
  } finally { second?.close(); f.close(); }
});

test('application rejects hardlinked database files before SQLite connections are opened', () => {
  const dir = mkdtempSync(join(tmpdir(), 'beni-hardlink-'));
  const path = join(dir, 'db'), alias = join(dir, 'alias');
  const db = new Database(path); db.close();
  try {
    linkSync(path, alias);
    expect(() => createAppHandler(alias)).toThrow();
    expect(() => createAppHandler(path)).toThrow();
    unlinkSync(alias);
    const app = createAppHandler(path); app.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('home projects durable task states across generation, review, rework, new instructions and restart', async () => {
  let begin!: () => void, release!: (value: any) => void;
  let entered: Promise<void>;
  const waitForStart = () => { entered = new Promise(resolve => { begin = resolve; }); };
  const delayed = () => new Promise<any>(resolve => { release = resolve; begin(); });
  let passReview = false;
  let holdRequirements = true, holdPlan = true, holdExecution = true, holdReview = true;
  const adapters: WorkflowAdapters = {
    requirements: { generate: () => holdRequirements ? delayed() : Promise.resolve({ content: 'requirements v3' }) },
    plan: { generate: () => holdPlan ? delayed() : Promise.resolve({ content: 'revised plan' }) },
    execution: { execute: () => holdExecution ? delayed() : Promise.resolve({ output: 'fixed', evidence: ['verified'] }) },
    review: { review: () => holdReview ? delayed() : Promise.resolve({ passed: passReview, feedback: 'checked' }) },
  };
  const f = fixture(adapters);
  let reopened: ReturnType<typeof createAppHandler> | undefined;
  try {
    await f.post('/api/projects', { name: 'Demo', folder: f.dir });
    await f.post('/api/tasks', { projectId: 1, name: 'first' });
    await f.post('/api/tasks', { projectId: 1, name: 'second' });
    const state = async () => (await (await f.get('/api/state')).json()).tasks as any[];
    const task = async (id: number) => (await state()).find(t => t.id === id);
    expect(await task(1)).toMatchObject({ phase: 'requirements', status: '入力待ち' });
    waitForStart(); const r = f.post('/api/tasks/1/workflow/requirements', { requestKey: 'r' }); await entered!;
    expect(await task(1)).toMatchObject({ phase: 'requirements', status: '指示書を作成中' });
    expect(await task(2)).toMatchObject({ phase: 'requirements', status: '入力待ち' });
    release({ content: 'requirements' }); await r; holdRequirements = false;
    waitForStart(); const p = f.post('/api/tasks/1/workflow/plan', { requestKey: 'p' }); await entered!;
    expect(await task(1)).toMatchObject({ phase: '実装フロー', status: '計画を作成中' });
    release({ content: 'plan' }); await p; holdPlan = false;
    expect(await task(1)).toMatchObject({ phase: '実装フロー', status: '計画の確認待ち' });
    await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 2, planVersion: 2 });
    expect((await task(1)).status).toBe('実行指示待ち');
    waitForStart(); const e = f.post('/api/tasks/1/workflow/execute'); await entered!;
    expect(await task(1)).toMatchObject({ phase: '実装中', status: '実行中' });
    release({ output: 'done', evidence: ['evidence'] }); const run = await (await e).json(); holdExecution = false;
    expect((await task(1)).status).toBe('監修待ち');
    waitForStart(); const v = f.post('/api/tasks/1/workflow/review', { attemptId: run.attemptId }); await entered!;
    expect((await task(1)).status).toBe('監修中');
    release({ passed: false, feedback: 'fix this' }); await v; holdReview = false;
    expect(await task(1)).toMatchObject({ phase: '実装フロー', status: '手直しが必要' });
    await f.post('/api/tasks/1/workflow/plan', { requestKey: 'p2' });
    expect((await task(1)).status).toBe('計画の確認待ち');
    await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 2, planVersion: 3 });
    const fixed = await (await f.post('/api/tasks/1/workflow/execute')).json();
    passReview = true;
    await f.post('/api/tasks/1/workflow/review', { attemptId: fixed.attemptId });
    expect(await task(1)).toMatchObject({ phase: '実装中', status: '完了（監修済み）' });
    expect((await (await f.get('/api/tasks/1')).json()).task).toMatchObject({ phase: '実装中', status: '完了（監修済み）' });
    expect((await f.get('/api/tasks/999')).status).toBe(404);
    f.app.close(); reopened = createAppHandler(f.path);
    const reopenedState = await (await reopened.fetch(new Request('http://127.0.0.1:3210/api/state'))).json();
    expect(reopenedState.tasks.find((t: any) => t.id === 1).status).toBe('完了（監修済み）');
    await reopened.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/messages', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify({ content: 'another change' }) }));
    const changed = await (await reopened.fetch(new Request('http://127.0.0.1:3210/api/state'))).json();
    expect(changed.tasks.find((t: any) => t.id === 1)).toMatchObject({ phase: 'requirements', status: '追加指示・変更あり' });
    const changedDetail = await (await reopened.fetch(new Request('http://127.0.0.1:3210/api/tasks/1'))).json();
    expect(changedDetail.task).toMatchObject({ phase: 'requirements', status: '追加指示・変更あり' });
    expect(changed.tasks.find((t: any) => t.id === 2)).toMatchObject({ phase: 'requirements', status: '入力待ち' });
  } finally { reopened?.close(); f.close(); }
});

test('missing optional tables are tolerated, corrupt task histories are isolated, unexpected database errors propagate', async () => {
  const f = fixture(); const db = new Database(f.path);
  try {
    await f.post('/api/projects', { name: 'Demo', folder: f.dir });
    await f.post('/api/tasks', { projectId: 1, name: 'Task' });
    await f.post('/api/tasks', { projectId: 1, name: 'Other' });
    db.exec('DROP TABLE plan_generations');
    expect((await (await f.get('/api/state')).json()).tasks[0].status).toBe('入力待ち');
    db.query("INSERT INTO workflow_events(task_id,kind,payload) VALUES (1,'plan','not json')").run();
    const state = await (await f.get('/api/state')).json();
    expect(state.tasks.find((t: any) => t.id === 1).status).toBe('履歴の確認が必要');
    expect(state.tasks.find((t: any) => t.id === 2).status).toBe('入力待ち');
    db.exec('DROP TABLE documents');
    await expect(f.get('/api/state')).rejects.toThrow();
  } finally { db.close(); f.close(); }
});

test('completed status requires intact persisted evidence, execution, and review references', async () => {
  const mutations = [
    "UPDATE workflow_events SET payload=json_set(payload,'$.result.evidence',json('[]')) WHERE kind='execution_result' AND task_id=1",
    "UPDATE workflow_events SET payload=json_remove(payload,'$.stale') WHERE kind='execution_result' AND task_id=1",
    "UPDATE workflow_events SET payload=json_set(payload,'$.stale',null) WHERE kind='execution_result' AND task_id=1",
    "UPDATE workflow_events SET payload=json_set(payload,'$.stale',0) WHERE kind='execution_result' AND task_id=1",
    "UPDATE workflow_events SET payload=json_set(payload,'$.result.output','') WHERE kind='execution_result' AND task_id=1",
    "UPDATE workflow_events SET payload=json_set(payload,'$.reviewId',999) WHERE kind='review_result' AND task_id=1",
    "UPDATE execution_reviews SET snapshot=json_set(snapshot,'$.attemptId',999) WHERE task_id=1",
    "UPDATE execution_reviews SET snapshot=json_set(snapshot,'$.execution.evidence',json('[\"different\"]')) WHERE task_id=1",
    "UPDATE execution_reviews SET result=json_set(result,'$.decision.passed',json('false')) WHERE task_id=1",
    "UPDATE execution_attempts SET payload=json_set(payload,'$.plan.content','changed') WHERE task_id=1",
  ];
  for (const mutation of mutations) {
    const f = fixture({
      plan: { generate: async () => ({ content: 'plan' }) },
      execution: { execute: async () => ({ output: 'done', evidence: ['test'] }) },
      review: { review: async () => ({ passed: true, feedback: 'checked' }) },
    });
    const db = new Database(f.path);
    try {
      await f.post('/api/projects', { name: 'Demo', folder: f.dir });
      await f.post('/api/tasks', { projectId: 1, name: 'first' });
      await f.post('/api/tasks', { projectId: 1, name: 'second' });
      await f.post('/api/tasks/1/workflow/plan', { requestKey: 'p' });
      await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 });
      const run = await (await f.post('/api/tasks/1/workflow/execute')).json();
      await f.post('/api/tasks/1/workflow/review', { attemptId: run.attemptId });
      expect((await (await f.get('/api/state')).json()).tasks.find((t: any) => t.id === 1).status).toBe('完了（監修済み）');
      db.exec(mutation);
      const state = await (await f.get('/api/state')).json();
      expect(state.tasks.find((t: any) => t.id === 1).status).toBe('履歴の確認が必要');
      expect((await (await f.get('/api/tasks/1')).json()).task.status).toBe('履歴の確認が必要');
      expect(state.tasks.find((t: any) => t.id === 2).status).toBe('入力待ち');
      expect((await (await f.get('/api/tasks/2')).json()).task.status).toBe('入力待ち');
    } finally { db.close(); f.close(); }
  }
});
