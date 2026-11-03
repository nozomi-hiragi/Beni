import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { Workflow } from './index';
import { RequirementsGeneration } from './requirements';
import { PlanGeneration } from './plan';
import { ExecutionReview } from './review';

for (const trigger of ['unknown-generation', 'instruction-during-review'] as const) {
  test(`stale review after ${trigger} requires a new plan and approval`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'beni-stale-review-gate-'));
    const path = join(dir, 'db');
    const store = new Store(path);
    store.createProject('example', '/tmp/example');
    store.createTask(1, 'task');
    const workflow = new Workflow(path);
    const review = new ExecutionReview(path);
    const requirements = new RequirementsGeneration(path);
    const plans = new PlanGeneration(path);
    try {
      workflow.recordInstruction(1, 'original instruction');
      workflow.savePlan(1, 1, 'original plan');
      workflow.approve(1, 1, 1, 'user');
      let executionCalls = 0;
      const executor = { execute: async () => { executionCalls++; return { output: 'done', evidence: ['test'] }; } };
      const execution = await workflow.execute(1, executor);
      let release!: (decision: { passed: boolean; feedback: string }) => void;
      const pending = review.review(1, execution.attemptId, {
        review: () => new Promise(resolve => { release = resolve; }),
      });
      await Promise.resolve();

      let uncertainAttempt: number | undefined;
      if (trigger === 'unknown-generation') {
        const uncertain = await requirements.generate(1, 'failed-generation', {
          generate: async () => { throw new Error('mock failure'); },
        });
        expect(uncertain.status).toBe('unknown');
        uncertainAttempt = uncertain.attemptId;
      } else {
        workflow.recordInstruction(1, 'instruction already sent during review');
      }
      release({ passed: true, feedback: 'checked' });
      const verdict = await pending;
      expect(verdict.status).toBe('stale');
      expect(verdict.stale).toBe(true);
      const issue = workflow.events(1).find(event => event.kind === 'review_result' && event.payload.reviewId === verdict.reviewId);
      expect(issue).toBeDefined();
      if (uncertainAttempt !== undefined) requirements.acknowledge(1, uncertainAttempt, 'user');

      expect(() => workflow.approve(1, 1, 1, 'user')).toThrow();
      await expect(workflow.execute(1, executor)).rejects.toThrow();
      expect(executionCalls).toBe(1);
      if (trigger === 'unknown-generation') workflow.recordInstruction(1, 'investigate the stale review');
      const plan = await plans.generate(1, 'follow-up', { generate: async snapshot => {
        expect(snapshot.reviewIssues).toContainEqual({ eventId: issue.id, reviewId: verdict.reviewId, attemptId: execution.attemptId, status: 'stale' });
        expect(snapshot.instructions).toHaveLength(2);
        expect(snapshot.instructions[1].content).toBe(trigger === 'unknown-generation' ? 'investigate the stale review' : 'instruction already sent during review');
        return { content: 'follow-up plan' };
      } });
      expect(plan.status).toBe('adopted');
      expect(plan.version).toBe(2);
      await expect(workflow.execute(1, executor)).rejects.toThrow();
      expect(executionCalls).toBe(1);
      workflow.approve(1, 1, 2, 'user');
      expect((await workflow.execute(1, executor)).status).toBe('succeeded');
      expect(executionCalls).toBe(2);
    } finally {
      plans.close();
      requirements.close();
      review.close();
      workflow.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
