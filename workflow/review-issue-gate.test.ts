import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { Workflow } from './index';
import { PlanGeneration } from './plan';
import { ExecutionReview } from './review';
import { createAppHandler } from './runtime';

for (const outcome of ['failed', 'interrupted'] as const) {
  test(`${outcome} review requires new instruction, plan and approval before another execution`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beni-review-issue-'));
    const path = join(dir, 'db');
    const store = new Store(path);
    store.createProject('example', '/tmp/example');
    store.createTask(1, 'first');
    store.createTask(1, 'second');
    const workflow = new Workflow(path);
    const review = new ExecutionReview(path);
    const plans = new PlanGeneration(path);
    try {
      workflow.savePlan(1, 1, 'initial plan');
      workflow.approve(1, 1, 1, 'user');
      workflow.savePlan(2, 1, 'other plan');
      const executor = { execute: async () => ({ output: 'done', evidence: ['test'] }) };
      const execution = await workflow.execute(1, executor);
      let reviewId: number;
      if (outcome === 'failed') {
        const result = await review.review(1, execution.attemptId, {
          review: async () => { throw new Error('mock reviewer failure'); },
        });
        expect(result.status).toBe('failed');
        reviewId = result.reviewId;
      } else {
        let release!: (value: { passed: boolean; feedback: string }) => void;
        const pending = review.review(1, execution.attemptId, {
          review: () => new Promise(resolve => { release = resolve; }),
        });
        await Promise.resolve();
        expect(review.recover(1)).toBe(1);
        const interrupted = workflow.events(1).find(event => event.kind === 'review_interrupted');
        expect(interrupted).toBeDefined();
        reviewId = interrupted.payload.reviewId;
        release({ passed: true, feedback: 'late review' });
        await expect(pending).rejects.toThrow('already settled');
      }

      const issue = workflow.events(1).find(event =>
        (event.kind === 'review_interrupted' || event.kind === 'review_result') && event.payload.reviewId === reviewId,
      );
      expect(issue).toBeDefined();
      expect(() => workflow.approve(1, 1, 1, 'user')).toThrow();
      let calls = 0;
      const countingExecutor = { execute: async () => { calls++; return { output: 'reworked', evidence: ['test'] }; } };
      await expect(workflow.execute(1, countingExecutor)).rejects.toThrow();
      expect(calls).toBe(0);

      // A review problem on the first task must not block the second.
      workflow.approve(2, 1, 1, 'user');
      expect((await workflow.execute(2, executor)).status).toBe('succeeded');

      workflow.recordInstruction(1, 'Investigate the review issue and revise the plan');
      const plan = await plans.generate(1, 'corrective', { generate: async snapshot => {
        expect(snapshot.reviewIssues).toContainEqual({ eventId: issue.id, reviewId, attemptId: execution.attemptId, status: outcome });
        return { content: 'corrective plan' };
      } });
      expect(plan.status).toBe('adopted');
      expect(plan.version).toBe(2);
      await expect(workflow.execute(1, countingExecutor)).rejects.toThrow();
      expect(calls).toBe(0);
      workflow.approve(1, 1, 2, 'user');
      expect((await workflow.execute(1, countingExecutor)).status).toBe('succeeded');
      expect(calls).toBe(1);
    } finally {
      plans.close();
      review.close();
      workflow.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('HTTP refuses the same plan after a failed review and allows a newly approved plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beni-review-issue-http-'));
  const path = join(dir, 'db');
  const seenIssues: unknown[] = [];
  let executionCalls = 0;
  const app = createAppHandler(path, {
    plan: { generate: async snapshot => { seenIssues.push(snapshot.reviewIssues); return { content: 'generated plan' }; } },
    execution: { execute: async () => { executionCalls++; return { output: 'done', evidence: ['test'] }; } },
    review: { review: async () => { throw new Error('mock review failure'); } },
  });
  const post = (route: string, data: unknown = {}) => app.fetch(new Request(`http://127.0.0.1:3210${route}`, {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data),
  }));
  try {
    expect((await post('/api/projects', { name: 'example', folder: dir })).status).toBe(201);
    expect((await post('/api/tasks', { projectId: 1, name: 'task' })).status).toBe(201);
    expect((await post('/api/tasks/1/workflow/plan', { requestKey: 'first' })).status).toBe(200);
    expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 })).status).toBe(200);
    const first = await (await post('/api/tasks/1/workflow/execute')).json() as { attemptId: number };
    const failed = await (await post('/api/tasks/1/workflow/review', { attemptId: first.attemptId })).json() as { status: string; reviewId: number };
    expect(failed.status).toBe('failed');
    expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 })).status).toBe(409);
    expect((await post('/api/tasks/1/workflow/execute')).status).toBe(409);
    expect(executionCalls).toBe(1);
    expect((await post('/api/tasks/1/messages', { content: 'Investigate the review failure' })).status).toBe(201);
    expect((await post('/api/tasks/1/workflow/plan', { requestKey: 'corrective' })).status).toBe(200);
    const issues = seenIssues[1] as { eventId: number; reviewId: number; attemptId: number; status: string }[];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ eventId: expect.any(Number), reviewId: failed.reviewId, attemptId: first.attemptId, status: 'failed' });
    expect((await post('/api/tasks/1/workflow/execute')).status).toBe(409);
    expect((await post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 3 })).status).toBe(200);
    expect((await post('/api/tasks/1/workflow/execute')).status).toBe(200);
    expect(executionCalls).toBe(2);
  } finally {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
