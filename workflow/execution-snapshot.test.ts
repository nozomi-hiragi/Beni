import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppHandler } from './runtime';
import type { ExecutionResult } from './index';

function fixture(executionResult: ExecutionResult) {
  const dir = mkdtempSync(join(tmpdir(), 'beni-execution-snapshot-'));
  const path = join(dir, 'db');
  let executions = 0;
  let reviews = 0;
  const app = createAppHandler(path, {
    plan: { generate: async () => ({ content: 'plan' }) },
    execution: { execute: async () => { executions++; return executionResult; } },
    review: { review: async snapshot => {
      reviews++;
      expect(snapshot.execution).toMatchObject({ output: 'verified output', evidence: ['verified evidence'] });
      return { passed: true, feedback: 'checked' };
    } },
  });
  const get = (route: string) => app.fetch(new Request(`http://127.0.0.1:3210${route}`));
  const post = (route: string, data: unknown = {}) => app.fetch(new Request(`http://127.0.0.1:3210${route}`, {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data),
  }));
  return { app, dir, get, post, executions: () => executions, reviews: () => reviews, close() { app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function prepare(f: ReturnType<typeof fixture>) {
  expect((await f.post('/api/projects', { name: 'example', folder: f.dir })).status).toBe(201);
  expect((await f.post('/api/tasks', { projectId: 1, name: 'task' })).status).toBe(201);
  expect((await f.post('/api/tasks/1/workflow/plan', { requestKey: 'plan' })).status).toBe(200);
  expect((await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 })).status).toBe(200);
}

test('HTTP adopts only one detached snapshot of a mutable getter result', async () => {
  const reads = { output: 0, evidence: 0, unknown: 0 };
  const result = {
    get output() { reads.output++; return reads.output === 1 ? 'verified output' : ''; },
    get evidence() { reads.evidence++; return reads.evidence === 1 ? ['verified evidence'] : []; },
    get outcomeUnknown() { reads.unknown++; return reads.unknown !== 1; },
  };
  const f = fixture(result);
  try {
    await prepare(f);
    const execution = await (await f.post('/api/tasks/1/workflow/execute')).json() as any;
    expect(execution.status).toBe('succeeded');
    expect(execution.result).toEqual({ output: 'verified output', evidence: ['verified evidence'], outcomeUnknown: false });
    expect(reads).toEqual({ output: 1, evidence: 1, unknown: 1 });
    const events = await (await f.get('/api/tasks/1/workflow/events')).json() as any;
    const saved = events.workflow.find((event: any) => event.kind === 'execution_result');
    expect(saved.payload.result).toEqual(execution.result);
    const review = await (await f.post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).json() as any;
    expect(review.status).toBe('completed');
    expect(f.executions()).toBe(1);
    expect(f.reviews()).toBe(1);
    expect(reads).toEqual({ output: 1, evidence: 1, unknown: 1 });
  } finally { f.close(); }
});

for (const invalid of ['output', 'evidence', 'unknown'] as const) {
  test(`HTTP does not adopt a mutable getter whose first ${invalid} value is unsafe`, async () => {
    const reads = { output: 0, evidence: 0, unknown: 0 };
    const result = {
      get output() { reads.output++; return invalid === 'output' && reads.output === 1 ? '' : 'verified output'; },
      get evidence() { reads.evidence++; return invalid === 'evidence' && reads.evidence === 1 ? [] : ['verified evidence']; },
      get outcomeUnknown() { reads.unknown++; return invalid === 'unknown' && reads.unknown === 1; },
    };
    const f = fixture(result);
    try {
      await prepare(f);
      const execution = await (await f.post('/api/tasks/1/workflow/execute')).json() as any;
      expect(execution.status).toBe('failed');
      expect(execution.result.outcomeUnknown).toBe(true);
      expect(reads).toEqual({ output: 1, evidence: 1, unknown: 1 });
      const events = await (await f.get('/api/tasks/1/workflow/events')).json() as any;
      const saved = events.workflow.find((event: any) => event.kind === 'execution_result');
      expect(saved.payload.status).toBe('failed');
      expect(saved.payload.result.outcomeUnknown).toBe(true);
      expect((await f.post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).status).toBe(409);
      expect((await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 })).status).toBe(409);
      expect(f.executions()).toBe(1);
      expect(f.reviews()).toBe(0);
    } finally { f.close(); }
  });
}

test('HTTP rejects an execution result inheriting outcomeUnknown from its prototype', async () => {
  const inherited = Object.assign(Object.create({ outcomeUnknown: true }), {
    output: 'verified output', evidence: ['verified evidence'],
  });
  const f = fixture(inherited);
  try {
    await prepare(f);
    const execution = await (await f.post('/api/tasks/1/workflow/execute')).json() as any;
    expect(execution.status).toBe('failed');
    expect(execution.result.outcomeUnknown).toBe(true);
    expect((await f.post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).status).toBe(409);
    expect((await f.post('/api/tasks/1/workflow/approve', { requirementsVersion: 1, planVersion: 2 })).status).toBe(409);
    expect(f.executions()).toBe(1);
    expect(f.reviews()).toBe(0);
  } finally { f.close(); }
});

test('HTTP accepts a valid execution result with a null prototype', async () => {
  const plain = Object.assign(Object.create(null), {
    output: 'verified output', evidence: ['verified evidence'], outcomeUnknown: false,
  });
  const f = fixture(plain);
  try {
    await prepare(f);
    const execution = await (await f.post('/api/tasks/1/workflow/execute')).json() as any;
    expect(execution.status).toBe('succeeded');
    expect(execution.result).toEqual({ output: 'verified output', evidence: ['verified evidence'], outcomeUnknown: false });
    const review = await (await f.post('/api/tasks/1/workflow/review', { attemptId: execution.attemptId })).json() as any;
    expect(review.status).toBe('completed');
    expect(f.executions()).toBe(1);
    expect(f.reviews()).toBe(1);
  } finally { f.close(); }
});
