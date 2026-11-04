import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Store } from '../store';
import { Workflow } from './index';
import { PlanGeneration } from './plan';
import { ExecutionReview } from './review';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'beni-plan-'));
  const path = join(dir, 'db');
  const store = new Store(path);
  store.createProject('p', dir);
  store.createTask(1, 'task title');
  const workflow = new Workflow(path);
  const generation = new PlanGeneration(path);
  return { dir, path, store, workflow, generation, close() { generation.close(); workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('snapshot preserves originals, is isolated from adapter changes, and generates an approvable plan', async () => {
  const f = fixture();
  try {
    f.store.addMessage(1, 1, 'user', ' raw request ');
    await expect(f.generation.generate(1, 'one', undefined)).rejects.toThrow('not connected');
    const result = await f.generation.generate(1, 'one', { generate: async s => {
      expect(s.taskName).toBe('task title');
      expect(s.instructions[0].content).toBe(' raw request ');
      expect(s.requirements.version).toBe(1);
      s.requirements.content = 'mutated';
      return { content: '# plan' };
    } });
    expect(result.status).toBe('adopted');
    expect(result.version).toBe(1);
    expect(f.workflow.events(1).find(e => e.kind === 'plan')!.payload).toEqual({ requirementsVersion: 1, planVersion: 1, messageId: 1 });
    expect(f.workflow.approve(1, 1, 1, 'user')).toBeGreaterThan(0);
    expect(f.generation.history(1)[0].payload.snapshot.requirements.content).toBe('# task title\n');
    await expect(f.generation.generate(1, 'one', { generate: async () => ({ content: 'duplicate' }) })).rejects.toThrow();
  } finally { f.close(); }
});

test('added instruction, requirements revision, and concurrent plan revision make results stale', async () => {
  for (const mode of ['instruction', 'requirements', 'plan']) {
    const f = fixture();
    try {
      let release!: (value: { content: string }) => void;
      const pending = f.generation.generate(1, mode, { generate: () => new Promise(resolve => { release = resolve; }) });
      await Promise.resolve();
      if (mode === 'instruction') f.store.addMessage(1, 1, 'user', 'new request');
      if (mode === 'requirements') f.store.saveDocument(1, 'requirements', 'edited', 1);
      if (mode === 'plan') f.workflow.savePlan(1, 1, 'manually saved plan');
      release({ content: 'stale output' });
      expect((await pending).status).toBe('stale');
      expect(f.generation.history(1).at(-1)!.payload.content).toBe('stale output');
      expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan').length).toBe(mode === 'plan' ? 1 : 0);
      expect(f.workflow.events(1).filter(e => e.kind === 'plan').length).toBe(mode === 'plan' ? 1 : 0);
    } finally { f.close(); }
  }
});

test('two instances serialize attempts, and late results after explicit recovery are never adopted', async () => {
  const f = fixture();
  const other = new PlanGeneration(f.path);
  try {
    let calls = 0;
    let release!: (value: { content: string }) => void;
    const adapter = { generate: () => { calls++; return new Promise<{ content: string }>(resolve => { release = resolve; }); } };
    const pending = f.generation.generate(1, 'first', adapter);
    await expect(other.generate(1, 'second', adapter)).rejects.toThrow();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(other.recover(1)).toBe(1);
    await expect(other.generate(1, 'second', adapter)).rejects.toThrow('acknowledged');
    release({ content: 'late plan' });
    await expect(pending).rejects.toThrow('already settled');
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan')).toHaveLength(0);
    const interrupted = other.history(1).at(-1)!;
    other.acknowledge(1, interrupted.attempt_id, 'user');
    await expect(other.generate(1, 'first', adapter)).rejects.toThrow();
    expect((await other.generate(1, 'second', { generate: async () => ({ content: 'new' }) })).status).toBe('adopted');
  } finally { other.close(); f.close(); }
});

test('abort before invocation is known; cancellation after invocation requires acknowledgement and ignores late response', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const before = new AbortController(); before.abort();
    const first = await f.generation.generate(1, 'before', { generate: async () => { calls++; return { content: 'wrong' }; } }, before.signal);
    expect(first.outcomeUnknown).toBe(false);
    expect(calls).toBe(0);
    const after = new AbortController();
    let release!: (value: { content: string }) => void;
    const pending = f.generation.generate(1, 'after', { generate: () => new Promise(resolve => { calls++; release = resolve; }) }, after.signal);
    await Promise.resolve(); after.abort();
    const second = await pending;
    expect(second.outcomeUnknown).toBe(true);
    release({ content: 'late' }); await Promise.resolve();
    await expect(f.generation.generate(1, 'blocked', { generate: async () => ({ content: 'wrong' }) })).rejects.toThrow('acknowledged');
    expect(f.generation.history(1).filter(e => e.attempt_id === second.attemptId && e.kind === 'settled')).toHaveLength(1);
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan')).toHaveLength(0);
  } finally { f.close(); }
});

test('unknown adapter errors do not leak details and survive reopening', async () => {
  const f = fixture();
  let other: PlanGeneration | undefined;
  try {
    const failed = await f.generation.generate(1, 'failed', { generate: async () => { throw Error('private secret'); } });
    expect(failed.status).toBe('unknown');
    expect(JSON.stringify(f.generation.history(1))).not.toContain('private secret');
    other = new PlanGeneration(f.path);
    await expect(other.generate(1, 'retry', { generate: async () => ({ content: 'x' }) })).rejects.toThrow('acknowledged');
    other.acknowledge(1, failed.attemptId, 'user');
    expect((await other.generate(1, 'retry', { generate: async () => ({ content: 'ok' }) })).status).toBe('adopted');
  } finally { other?.close(); f.close(); }
});

test('plan revision and workflow event roll back together when event write fails', async () => {
  const f = fixture();
  const db = new Database(f.path);
  try {
    db.exec("CREATE TRIGGER reject_plan BEFORE INSERT ON workflow_events WHEN NEW.kind='plan' BEGIN SELECT RAISE(ABORT,'reject event'); END");
    await expect(f.generation.generate(1, 'key', { generate: async () => ({ content: 'generated' }) })).rejects.toThrow();
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan')).toHaveLength(0);
    expect(f.workflow.events(1).filter(e => e.kind === 'plan')).toHaveLength(0);
    expect(f.generation.recover(1)).toBe(1);
  } finally { db.close(); f.close(); }
});

test('review changes are separate from user instructions and included in the corrective plan', async () => {
  const f = fixture(); const review = new ExecutionReview(f.path);
  try {
    f.workflow.recordInstruction(1, ' original user request ');
    f.workflow.savePlan(1, 1, 'first plan'); f.workflow.approve(1, 1, 1, 'user');
    const execution = await f.workflow.execute(1, { execute: async () => ({ output: 'done', evidence: ['tests'] }) });
    const verdict = await review.review(1, execution.attemptId, { review: async () => ({ passed: false, feedback: ' Preserve raw input whitespace ' }) });
    const generated = await f.generation.generate(1, 'corrective', { generate: async snapshot => {
      expect(snapshot.instructions.map(i => i.content)).toEqual([' original user request ']);
      expect(snapshot.reviewFeedback).toEqual([{ eventId: f.workflow.events(1).at(-1)!.id, reviewId: verdict.reviewId, attemptId: execution.attemptId, content: ' Preserve raw input whitespace ' }]);
      snapshot.reviewFeedback[0].content = 'adapter mutation';
      return { content: 'corrective plan' };
    } });
    expect(generated.status).toBe('adopted');
    expect(f.generation.history(1)[0].payload.snapshot.reviewFeedback[0].content).toBe(' Preserve raw input whitespace ');
    expect(f.workflow.approve(1, 1, 2, 'user')).toBeGreaterThan(0);
  } finally { review.close(); f.close(); }
});

test('pending plan generation blocks review without disturbing delayed plan adoption', async () => {
  const f = fixture(); const review = new ExecutionReview(f.path);
  try {
    f.workflow.savePlan(1, 1, 'first plan'); f.workflow.approve(1, 1, 1, 'user');
    const execution = await f.workflow.execute(1, { execute: async () => ({ output: 'done', evidence: ['tests'] }) });
    let release!: (value: { content: string }) => void;
    const pending = f.generation.generate(1, 'pending', { generate: () => new Promise(resolve => { release = resolve; }) });
    await Promise.resolve();
    let reviewCalls = 0;
    const reviewer = { review: async () => { reviewCalls++; return { passed: false, feedback: 'Missing regression test' }; } };
    await expect(review.review(1, execution.attemptId, reviewer)).rejects.toThrow('Generation still running');
    expect(reviewCalls).toBe(0);
    expect(review.history(1)).toHaveLength(0);
    expect(f.workflow.events(1).filter(e => e.kind === 'review_result')).toHaveLength(0);
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan')).toHaveLength(1);
    release({ content: 'new plan after delayed generation' });
    const adopted = await pending;
    expect(adopted.status).toBe('adopted');
    expect(adopted.version).toBe(2);
    expect(f.workflow.events(1).filter(e => e.kind === 'plan')).toHaveLength(2);
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan').at(-1).content).toBe('new plan after delayed generation');
    await expect(review.review(1, execution.attemptId, reviewer)).rejects.toThrow('stale');
    expect(reviewCalls).toBe(0);
    await expect(f.generation.generate(1, 'pending', { generate: async () => ({ content: 'duplicate' }) })).rejects.toThrow();
    expect(f.workflow.events(1).filter(e => e.kind === 'plan')).toHaveLength(2);
  } finally { review.close(); f.close(); }
});
