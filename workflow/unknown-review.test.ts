import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { Workflow } from './index';
import { RequirementsGeneration } from './requirements';
import { PlanGeneration } from './plan';
import { ExecutionReview } from './review';

for (const kind of ['requirements', 'plan'] as const) {
  for (const outcome of ['unknown', 'interrupted'] as const) {
    test(`${kind} ${outcome} blocks review until acknowledged`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'beni-generation-review-'));
      const path = join(dir, 'db');
      const store = new Store(path);
      store.createProject('example', '/tmp/example');
      store.createTask(1, 'first');
      store.createTask(1, 'second');
      const workflow = new Workflow(path);
      const review = new ExecutionReview(path);
      const generation = kind === 'requirements' ? new RequirementsGeneration(path) : new PlanGeneration(path);
      try {
        const executor = { execute: async () => ({ output: 'done', evidence: ['saved verification'] }) };
        workflow.savePlan(1, 1, 'first plan');
        workflow.approve(1, 1, 1, 'user');
        const first = await workflow.execute(1, executor);
        workflow.savePlan(2, 1, 'second plan');
        workflow.approve(2, 1, 1, 'user');
        const second = await workflow.execute(2, executor);

        let attemptId: number;
        let generationCalls = 0;
        if (outcome === 'unknown') {
          const result = await generation.generate(1, 'failure', {
            generate: async () => { generationCalls++; throw new Error('mock failure'); },
          });
          expect(result.status).toBe('unknown');
          attemptId = result.attemptId;
        } else {
          let release!: (result: { content: string }) => void;
          const pending = generation.generate(1, 'interrupted', {
            generate: () => { generationCalls++; return new Promise(resolve => { release = resolve; }); },
          });
          await Promise.resolve();
          expect(generation.recover(1)).toBe(1);
          const event = generation.history(1).find(item => item.kind === 'interrupted');
          expect(event).toBeDefined();
          attemptId = event.attempt_id;
          release({ content: 'late result' });
          await expect(pending).rejects.toThrow('already settled');
        }
        expect(generationCalls).toBe(1);

        let reviewCalls = 0;
        const reviewer = { review: async (snapshot: any) => {
          reviewCalls++;
          expect(snapshot.execution).toEqual({ output: 'done', evidence: ['saved verification'] });
          return { passed: true, feedback: 'checked saved evidence' };
        } };
        await expect(review.review(1, first.attemptId, reviewer)).rejects.toThrow('outcome must be acknowledged');
        expect(reviewCalls).toBe(0);
        expect(review.history(1)).toHaveLength(0);

        // Uncertain generation on one task must not block another task's review.
        expect((await review.review(2, second.attemptId, reviewer)).status).toBe('completed');
        expect(reviewCalls).toBe(1);

        generation.acknowledge(1, attemptId, 'user');
        expect((await review.review(1, first.attemptId, reviewer)).status).toBe('completed');
        expect(reviewCalls).toBe(2);
        expect(generationCalls).toBe(1);
      } finally {
        generation.close();
        review.close();
        workflow.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('a generation becoming unknown during a review makes its result stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beni-review-unknown-'));
  const path = join(dir, 'db');
  const store = new Store(path);
  store.createProject('example', '/tmp/example');
  store.createTask(1, 'task');
  const workflow = new Workflow(path);
  const review = new ExecutionReview(path);
  const generation = new RequirementsGeneration(path);
  try {
    workflow.savePlan(1, 1, 'plan');
    workflow.approve(1, 1, 1, 'user');
    const execution = await workflow.execute(1, { execute: async () => ({ output: 'done', evidence: ['test'] }) });
    let release!: (decision: { passed: boolean; feedback: string }) => void;
    const pending = review.review(1, execution.attemptId, {
      review: () => new Promise(resolve => { release = resolve; }),
    });
    await Promise.resolve();
    const uncertain = await generation.generate(1, 'uncertain', {
      generate: async () => { throw new Error('mock failure'); },
    });
    expect(uncertain.status).toBe('unknown');
    release({ passed: true, feedback: 'checked' });
    const result = await pending;
    expect(result.status).toBe('stale');
    expect(result.stale).toBe(true);
    expect(review.history(1)[0].result.status).toBe('stale');
  } finally {
    generation.close();
    review.close();
    workflow.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
