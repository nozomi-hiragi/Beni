import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store';
import { Workflow } from './index';
import { ExecutionReview } from './review';
import { RequirementsGeneration } from './requirements';
import { PlanGeneration } from './plan';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'beni-review-')), path = join(dir, 'db');
  const store = new Store(path); store.createProject('p', '/tmp/p'); store.createTask(1, 'task');
  const workflow = new Workflow(path); workflow.recordInstruction(1, 'original'); workflow.savePlan(1, 1, 'plan'); workflow.approve(1, 1, 1, 'user');
  const execution = await workflow.execute(1, { execute: async () => ({ output: 'implemented', evidence: ['test run recorded'] }) });
  const review = new ExecutionReview(path);
  return { dir, path, store, workflow, execution, review, close() { review.close(); workflow.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const pass = { review: async () => ({ passed: true, feedback: 'Checked saved evidence' }) };

test('running requirement or plan generation blocks review only for its own task', async () => {
  for (const kind of ['requirements', 'plan']) for (const taskId of [1, 2]) {
    const f = await fixture();
    const generation = kind === 'requirements' ? new RequirementsGeneration(f.path) : new PlanGeneration(f.path);
    try {
      f.store.createTask(1, 'other task');
      const controller = new AbortController();
      const pending = generation.generate(taskId, 'pending', { generate: () => new Promise(() => {}) }, controller.signal);
      await Promise.resolve();
      if (taskId === 1) {
        await expect(f.review.review(1, f.execution.attemptId, pass)).rejects.toThrow('Generation still running');
        expect(f.review.history(1)).toHaveLength(0);
      } else expect((await f.review.review(1, f.execution.attemptId, pass)).status).toBe('completed');
      controller.abort(); await pending;
    } finally { generation.close(); f.close(); }
  }
});

test('generation starting during review prevents completion even if it finishes before the reviewer', async () => {
  for (const kind of ['requirements', 'plan']) for (const settled of [false, true]) {
    const f = await fixture();
    const generation = kind === 'requirements' ? new RequirementsGeneration(f.path) : new PlanGeneration(f.path);
    try {
      let release!: (value: {passed:boolean;feedback:string}) => void;
      const reviewing = f.review.review(1, f.execution.attemptId, { review: () => new Promise(resolve => { release = resolve; }) });
      await Promise.resolve();
      const controller = new AbortController();
      const pending = generation.generate(1, 'new-generation', { generate: () => new Promise(() => {}) }, controller.signal);
      await Promise.resolve();
      if (settled) { controller.abort(); await pending; }
      release({ passed: true, feedback: 'old execution looks fine' });
      expect((await reviewing).status).toBe('stale');
      if (!settled) { controller.abort(); await pending; }
    } finally { generation.close(); f.close(); }
  }
});

test('stale approval and a newer execution cannot be reviewed as current', async () => {
  for (const mode of ['instruction', 'approval', 'execution']) {
    const f = await fixture();
    try {
      if (mode === 'instruction') f.workflow.recordInstruction(1, 'changed instruction');
      else {
        f.workflow.approve(1, 1, 1, 'user');
        if (mode === 'execution') await f.workflow.execute(1, { execute: async () => ({ output: 'new output', evidence: ['new tests'] }) });
      }
      await expect(f.review.review(1, f.execution.attemptId, pass)).rejects.toThrow();
      expect(f.review.history(1)).toHaveLength(0);
    } finally { f.close(); }
  }
});

test('independent review completes from saved evidence, persists and cannot run twice', async () => {
  const f = await fixture();
  try {
    const result = await f.review.review(1, f.execution.attemptId, { review: async snapshot => {
      expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.execution.evidence)).toBe(true);
      try { snapshot.execution.evidence.push('fabricated'); } catch {}
      return { passed: true, feedback: 'Reviewed independently' };
    } });
    expect(result.status).toBe('completed');
    expect(f.review.history(1)[0].snapshot.execution.evidence).toEqual(['test run recorded']);
    await expect(f.review.review(1, f.execution.attemptId, pass)).rejects.toThrow();
    const other = new ExecutionReview(f.path); expect(other.history(1)[0].result.status).toBe('completed'); other.close();
  } finally { f.close(); }
});

test('review cannot fabricate evidence missing from saved execution', async () => {
  const f = await fixture(); const db = new Database(f.path);
  try {
    const row = db.query("SELECT id,payload FROM workflow_events WHERE kind='execution_result'").get() as any;
    const payload = JSON.parse(row.payload); payload.result.evidence = [];
    db.query('UPDATE workflow_events SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
    let calls = 0;
    await expect(f.review.review(1, f.execution.attemptId, { review: async () => { calls++; return { passed: true, feedback: 'invented' }; } })).rejects.toThrow('evidence');
    expect(calls).toBe(0);
  } finally { db.close(); f.close(); }
});

test('additional instructions, document edits and saved evidence changes during review prevent completion', async () => {
  for (const mode of ['instruction', 'requirements', 'plan', 'evidence']) {
    const f = await fixture();
    try {
      let release!: (value: {passed:boolean;feedback:string}) => void;
      const pending = f.review.review(1, f.execution.attemptId, { review: () => new Promise(resolve => { release = resolve; }) });
      await Promise.resolve();
      if (mode === 'instruction') f.workflow.recordInstruction(1, 'new request');
      if (mode === 'requirements') f.store.saveDocument(1, 'requirements', 'changed', 1);
      if (mode === 'plan') f.workflow.savePlan(1, 1, 'changed plan');
      if (mode === 'evidence') {
        const db = new Database(f.path); const row = db.query("SELECT id,payload FROM workflow_events WHERE kind='execution_result'").get() as any;
        const payload = JSON.parse(row.payload); payload.result.evidence = []; db.query('UPDATE workflow_events SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id); db.close();
      }
      release({ passed: true, feedback: 'Looks good' }); expect((await pending).status).toBe('stale');
    } finally { f.close(); }
  }
});

test('changes requested are recorded as a decision, with no automatic execution', async () => {
  const f = await fixture();
  try {
    expect((await f.review.review(1, f.execution.attemptId, { review: async () => ({ passed: false, feedback: 'Add a missing test' }) })).status).toBe('changes_requested');
    expect(f.workflow.events(1).at(-1)!.payload.decision).toEqual({ passed: false, feedback: 'Add a missing test' });
    expect(f.workflow.events(1).filter(e => e.kind === 'execution_requested')).toHaveLength(1);
  } finally { f.close(); }
});

test('recovery and cancellation reject late results and never repeat review', async () => {
  for (const mode of ['recover', 'cancel']) {
    const f = await fixture(); const other = new ExecutionReview(f.path);
    try {
      const controller = new AbortController(); let release!: (value: {passed:boolean;feedback:string}) => void;
      const pending = f.review.review(1, f.execution.attemptId, { review: () => new Promise(resolve => { release = resolve; }) }, controller.signal);
      await Promise.resolve(); await expect(other.review(1, f.execution.attemptId, pass)).rejects.toThrow();
      if (mode === 'recover') other.recover(1); else controller.abort();
      if (mode === 'cancel') expect((await pending).status).toBe('failed');
      release({ passed: true, feedback: 'late' });
      if (mode === 'recover') await expect(pending).rejects.toThrow('settled');
      await Promise.resolve();
      expect(other.history(1)).toHaveLength(1); expect(other.history(1)[0].status).not.toBe('completed');
      await expect(other.review(1, f.execution.attemptId, pass)).rejects.toThrow();
    } finally { other.close(); f.close(); }
  }
});
