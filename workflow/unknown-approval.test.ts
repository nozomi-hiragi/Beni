import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { Workflow } from './index';
import { RequirementsGeneration } from './requirements';
import { PlanGeneration } from './plan';

for (const kind of ['requirements', 'plan'] as const) {
  for (const outcome of ['unknown', 'interrupted'] as const) {
    test(`${kind} ${outcome} blocks approval and execution until acknowledged`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'beni-generation-approval-'));
      const path = join(dir, 'db');
      const store = new Store(path);
      store.createProject('example', '/tmp/example');
      store.createTask(1, 'first');
      store.createTask(1, 'second');
      const workflow = new Workflow(path);
      const generation = kind === 'requirements' ? new RequirementsGeneration(path) : new PlanGeneration(path);
      try {
        workflow.savePlan(1, 1, 'first plan');
        workflow.approve(1, 1, 1, 'user');
        workflow.savePlan(2, 1, 'second plan');

        let attemptId: number;
        let adapterCalls = 0;
        if (outcome === 'unknown') {
          const result = await generation.generate(1, 'failure', {
            generate: async () => { adapterCalls++; throw new Error('mock failure'); },
          });
          expect(result.status).toBe('unknown');
          attemptId = result.attemptId;
        } else {
          let release!: (result: { content: string }) => void;
          const pending = generation.generate(1, 'interrupted', {
            generate: () => { adapterCalls++; return new Promise(resolve => { release = resolve; }); },
          });
          await Promise.resolve();
          expect(generation.recover(1)).toBe(1);
          const event = generation.history(1).find(item => item.kind === 'interrupted');
          expect(event).toBeDefined();
          attemptId = event.attempt_id;
          release({ content: 'late result' });
          await expect(pending).rejects.toThrow('already settled');
        }

        expect(adapterCalls).toBe(1);
        let executionCalls = 0;
        const executor = { execute: async () => { executionCalls++; return { output: 'done', evidence: ['test'] }; } };
        expect(() => workflow.approve(1, 1, 1, 'user')).toThrow('outcome must be acknowledged');
        await expect(workflow.execute(1, executor)).rejects.toThrow('outcome must be acknowledged');
        expect(executionCalls).toBe(0);

        // An unresolved generation must not block a different task.
        workflow.approve(2, 1, 1, 'user');
        expect((await workflow.execute(2, executor)).status).toBe('succeeded');
        expect(executionCalls).toBe(1);

        generation.acknowledge(1, attemptId, 'user');
        // The existing approval remains usable because neither document nor instructions changed.
        expect((await workflow.execute(1, executor)).status).toBe('succeeded');
        expect(executionCalls).toBe(2);
        expect(workflow.approve(1, 1, 1, 'user')).toBeGreaterThan(0);
        expect(adapterCalls).toBe(1);
      } finally {
        generation.close();
        workflow.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('acknowledgement does not revive approval made stale by a new instruction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beni-generation-stale-'));
  const path = join(dir, 'db');
  const store = new Store(path);
  store.createProject('example', '/tmp/example');
  store.createTask(1, 'task');
  const workflow = new Workflow(path);
  const generation = new RequirementsGeneration(path);
  try {
    workflow.savePlan(1, 1, 'original plan');
    workflow.approve(1, 1, 1, 'user');
    const uncertain = await generation.generate(1, 'failure', {
      generate: async () => { throw new Error('mock failure'); },
    });
    expect(uncertain.status).toBe('unknown');
    store.addMessage(1, 1, 'user', 'new instruction');
    generation.acknowledge(1, uncertain.attemptId, 'user');
    let executionCalls = 0;
    const executor = { execute: async () => { executionCalls++; return { output: 'done', evidence: ['test'] }; } };
    await expect(workflow.execute(1, executor)).rejects.toThrow('Current approval required');
    expect(() => workflow.approve(1, 1, 1, 'user')).toThrow('Plan must be regenerated');
    expect(executionCalls).toBe(0);
    workflow.savePlan(1, 1, 'updated plan');
    workflow.approve(1, 1, 2, 'user');
    expect((await workflow.execute(1, executor)).status).toBe('succeeded');
    expect(executionCalls).toBe(1);
  } finally {
    generation.close();
    workflow.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
