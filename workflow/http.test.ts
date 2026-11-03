import { test, expect } from 'bun:test';
import { Store } from '../store';
import { Database } from 'bun:sqlite';
import { Workflow } from './index';
import { createWorkflowHandler, type WorkflowAdapters } from './http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture(adapters: WorkflowAdapters = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'beni-http-'));
  const path = join(dir, 'db');
  const store = new Store(path);
  store.createProject('project', '/tmp/project');
  store.createTask(1, 'task');
  const handler = createWorkflowHandler(path, adapters);
  const get = (url: string) => handler.fetch(new Request(`http://127.0.0.1:3210${url}`));
  const post = (action: string, data: unknown = {}, options: { origin?: string; url?: string } = {}) => handler.fetch(new Request(`${options.url ?? 'http://127.0.0.1:3210'}/api/tasks/1/workflow/${action}`, { method: 'POST', headers: { origin: options.origin ?? 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify(data) }));
  return { dir, path, store, handler, get, post, close() { handler.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('injected adapters complete generation, planning, explicit approval and separate execution', async () => {
  let executions = 0;
  const f = fixture({
    requirements: { generate: async snapshot => { expect(snapshot.instructions[0].content).toBe(' raw '); return { content: '# requirements' }; } },
    plan: { generate: async snapshot => { expect(snapshot.requirements.version).toBe(2); return { content: '# plan' }; } },
    execution: { execute: async snapshot => { executions++; expect(snapshot.plan.content).toBe('# plan'); return { output: 'done', evidence: ['test passed'] }; } },
  });
  try {
    f.store.addMessage(1, 1, 'user', ' raw ');
    expect(await (await f.get('/api/workflow/capabilities'))!.json()).toEqual({ requirements: true, plan: true, execution: true, review: false });
    expect((await f.post('execute'))!.status).toBe(409);
    expect((await (await f.post('requirements', { requestKey: 'r1' }))!.json()).status).toBe('adopted');
    expect((await (await f.post('plan', { requestKey: 'p1' }))!.json()).status).toBe('adopted');
    expect((await f.post('approve', { requirementsVersion: 2, planVersion: 1 }))!.status).toBe(200);
    expect(executions).toBe(0);
    const execution = await (await f.post('execute'))!.json();
    expect(execution.status).toBe('succeeded');
    expect(executions).toBe(1);
    expect((await f.post('execute'))!.status).toBe(409);
    const events = await (await f.get('/api/tasks/1/workflow/events'))!.json();
    expect(events.workflow.map((e: any) => e.kind)).toEqual(['instruction', 'plan', 'approval', 'execution_requested', 'execution_result']);
    expect(events.requirements.at(-1).payload.status).toBe('adopted');
    expect(events.plan.at(-1).payload.status).toBe('adopted');
  } finally { f.close(); }
});

test('unconfigured endpoints report unavailable without saving attempts', async () => {
  const f = fixture();
  try {
    expect(await (await f.get('/api/workflow/capabilities'))!.json()).toEqual({ requirements: false, plan: false, execution: false, review: false });
    expect((await f.post('requirements', { requestKey: 'r' }))!.status).toBe(503);
    expect((await f.post('plan', { requestKey: 'p' }))!.status).toBe(503);
    expect((await f.post('execute'))!.status).toBe(503);
    expect((await f.post('review', { attemptId: 1 }))!.status).toBe(503);
    expect((await f.post('review', { attemptId: 0 }))!.status).toBe(400);
    const events = await (await f.get('/api/tasks/1/workflow/events'))!.json();
    expect(events).toEqual({ workflow: [], requirements: [], plan: [], review: [] });
  } finally { f.close(); }
});

test('invalid or obsolete approvals do not invoke the executor', async () => {
  let executions = 0;
  const f = fixture({ plan: { generate: async () => ({ content: 'plan' }) }, execution: { execute: async () => { executions++; return { output: 'x', evidence: ['x'] }; } } });
  try {
    expect((await f.post('approve', { requirementsVersion: 0, planVersion: 1 }))!.status).toBe(400);
    expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(409);
    await f.post('plan', { requestKey: 'p' });
    f.store.addMessage(1, 1, 'user', 'extra request');
    expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(409);
    expect((await f.post('execute'))!.status).toBe(409);
    expect(executions).toBe(0);
  } finally { f.close(); }
});

test('unknown result requires explicit acknowledgement, error details are never returned', async () => {
  let calls = 0;
  const f = fixture({ requirements: { generate: async () => { calls++; throw Error('internal secret'); } } });
  try {
    const failed = await (await f.post('requirements', { requestKey: 'one' }))!.json();
    expect(failed.outcomeUnknown).toBe(true);
    const blocked = await f.post('requirements', { requestKey: 'two' });
    expect(blocked!.status).toBe(409);
    expect(await blocked!.text()).not.toContain('internal secret');
    expect((await f.post('acknowledge', { kind: 'requirements', attemptId: failed.attemptId }))!.status).toBe(200);
    expect((await f.post('requirements', { requestKey: 'one' }))!.status).toBe(409);
    expect(calls).toBe(1);
    const events = await (await f.get('/api/tasks/1/workflow/events'))!.text();
    expect(events).not.toContain('internal secret');
  } finally { f.close(); }
});

test('routes validate origin, inputs, size, tasks and method; unrelated routes are passed through', async () => {
  const f = fixture();
  try {
    expect(await f.get('/api/state')).toBeNull();
    expect((await f.post('plan', { requestKey: 'x' }, { origin: 'https://evil.test' }))!.status).toBe(403);
    expect((await f.post('plan', { requestKey: 'x' }, { url: 'http://evil.test' }))!.status).toBe(403);
    expect((await f.post('plan', { requestKey: ' ' }))!.status).toBe(400);
    expect((await f.post('plan', { requestKey: 'x'.repeat(70000) }))!.status).toBe(413);
    expect((await f.post('recover', { kind: 'bad' }))!.status).toBe(400);
    expect((await f.post('acknowledge', { kind: 'plan', attemptId: 0 }))!.status).toBe(400);
    expect((await f.get('/api/tasks/999/workflow/events'))!.status).toBe(404);
    expect((await f.get('/api/tasks/1/workflow/execute'))!.status).toBe(403);
    const malformed = await f.handler.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/plan', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: '{' }));
    expect(malformed!.status).toBe(400);
  } finally { f.close(); }
});

test('recover refuses live requirements, plan, and execution operations across handler instances', async () => {
  for (const kind of ['requirements', 'plan', 'execution'] as const) {
    let release!: (result: any) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const delayed = () => new Promise<any>(resolve => { release = resolve; started(); });
    const f = fixture({ requirements: { generate: delayed }, plan: { generate: delayed }, execution: { execute: delayed } });
    const other = createWorkflowHandler(f.path);
    try {
      if (kind === 'execution') {
        const w = new Workflow(f.path);
        w.savePlan(1, 1, 'plan'); w.approve(1, 1, 1, 'user'); w.close();
      }
      const action = kind === 'execution' ? 'execute' : kind;
      const pending = f.post(action, { requestKey: 'first' });
      await entered;
      const recover = await other.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/recover', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify({kind}) }));
      expect(recover!.status).toBe(409);
      expect((await f.post('recover', { kind }))!.status).toBe(409);
      release(kind === 'execution' ? { output: 'done', evidence: ['test'] } : { content: 'done' });
      expect((await pending)!.status).toBe(200);
      expect((await (await f.post('recover', { kind }))!.json()).count).toBe(0);
    } finally { other.close(); f.close(); }
  }
});

test('orphaned persisted operations can be explicitly recovered and acknowledged', async () => {
  const f = fixture();
  const db = new Database(f.path);
  try {
    db.query("INSERT INTO plan_generations(task_id,request_key,status,snapshot) VALUES (1,'orphan','running','{}')").run();
    expect((await (await f.post('recover', { kind: 'plan' }))!.json()).count).toBe(1);
    const events = await (await f.get('/api/tasks/1/workflow/events'))!.json();
    const interrupted = events.plan.find((e: any) => e.kind === 'interrupted');
    expect((await f.post('acknowledge', { kind: 'plan', attemptId: interrupted.attempt_id }))!.status).toBe(200);
  } finally { db.close(); f.close(); }
});

test('a cancelled HTTP request cannot acknowledge unknown results while the adapter is still live', async () => {
  let release!: (value: { content: string }) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ plan: { generate: () => new Promise(resolve => { release = resolve; started(); }) } });
  try {
    const controller = new AbortController();
    const pending = f.handler.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/plan', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: 'key' }), signal: controller.signal }));
    await entered;
    controller.abort();
    const result = await (await pending)!.json();
    expect(result.outcomeUnknown).toBe(true);
    expect((await f.post('acknowledge', { kind: 'plan', attemptId: result.attemptId }))!.status).toBe(409);
    release({ content: 'late' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((await f.post('acknowledge', { kind: 'plan', attemptId: result.attemptId }))!.status).toBe(200);
    expect((f.store.documents(1) as any[]).filter(d => d.kind === 'plan')).toHaveLength(0);
  } finally { f.close(); }
});

test('review sees saved evidence, changes requested feed a new plan, and old approval is blocked', async () => {
  let planCalls = 0;
  const f = fixture({
    plan: { generate: async snapshot => {
      planCalls++;
      if (planCalls === 2) expect(snapshot.reviewFeedback.map(v => v.content)).toEqual(['Add a regression test']);
      return { content: planCalls === 1 ? 'initial plan' : 'plan with regression test' };
    } },
    execution: { execute: async () => ({ output: 'implemented', evidence: ['test evidence'] }) },
    review: { review: async snapshot => {
      expect(snapshot.execution.evidence).toEqual(['test evidence']);
      return { passed: false, feedback: 'Add a regression test' };
    } },
  });
  try {
    expect((await (await f.get('/api/workflow/capabilities'))!.json()).review).toBe(true);
    expect((await f.post('plan', { requestKey: 'initial' }))!.status).toBe(200);
    expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(200);
    const run = await (await f.post('execute'))!.json();
    const decision = await (await f.post('review', { attemptId: run.attemptId }))!.json();
    expect(decision.status).toBe('changes_requested');
    expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(409);
    expect((await f.post('execute'))!.status).toBe(409);
    const duplicate = await f.post('review', { attemptId: run.attemptId });
    expect(duplicate!.status).toBe(409);
    expect((await duplicate!.json()).error).toContain('再試行は未実装');
    const events = await (await f.get('/api/tasks/1/workflow/events'))!.json();
    expect(events.review[0].result.status).toBe('changes_requested');
    expect(events.review[0].snapshot.execution.evidence).toEqual(['test evidence']);
    expect((await (await f.post('plan', { requestKey: 'corrected' }))!.json()).status).toBe('adopted');
    expect((await f.post('approve', { requirementsVersion: 1, planVersion: 2 }))!.status).toBe(200);
    expect((await (await f.post('execute'))!.json()).status).toBe('succeeded');
  } finally { f.close(); }
});

test('review rejects unknown or malformed execution outcomes and accepts absent or false flags', async () => {
  const cases: { label: string; result: Record<string, unknown>; accepted: boolean }[] = [
    { label: 'unknown', result: { outcomeUnknown: true }, accepted: false },
    { label: 'null', result: { outcomeUnknown: null }, accepted: false },
    { label: 'string', result: { outcomeUnknown: 'false' }, accepted: false },
    { label: 'number', result: { outcomeUnknown: 0 }, accepted: false },
    { label: 'object', result: { outcomeUnknown: {} }, accepted: false },
    { label: 'absent', result: {}, accepted: true },
    { label: 'false', result: { outcomeUnknown: false }, accepted: true },
  ];
  for (const entry of cases) {
    let reviewCalls = 0;
    const f = fixture({
      plan: { generate: async () => ({ content: 'plan' }) },
      execution: { execute: async () => ({ output: 'done', evidence: ['evidence'], ...entry.result }) },
      review: { review: async () => { reviewCalls++; return { passed: true, feedback: 'checked' }; } },
    });
    try {
      expect((await f.post('plan', { requestKey: `p-${entry.label}` }))!.status).toBe(200);
      expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(200);
      const execution = await (await f.post('execute'))!.json();
      expect(execution.status).toBe(entry.accepted ? 'succeeded' : 'failed');
      if (!entry.accepted) expect(execution.result.outcomeUnknown).toBe(true);
      const response = await f.post('review', { attemptId: execution.attemptId });
      expect(response!.status).toBe(entry.accepted ? 200 : 409);
      expect(reviewCalls).toBe(entry.accepted ? 1 : 0);
      if (!entry.accepted) {
        expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(409);
        expect((await f.post('execute'))!.status).toBe(409);
        expect((await f.post('acknowledge', { kind: 'execution', attemptId: execution.attemptId }))!.status).toBe(200);
        expect((await f.post('review', { attemptId: execution.attemptId }))!.status).toBe(409);
      }
      const events = await (await f.get('/api/tasks/1/workflow/events'))!.json();
      expect(events.review).toHaveLength(entry.accepted ? 1 : 0);
      if (entry.accepted) expect((await response!.json()).status).toBe('completed');
    } finally { f.close(); }
  }
});

test('review rejects previously persisted successful results with unknown or malformed outcome flags', async () => {
  for (const value of [true, null, 'false', 0, {}]) {
    let reviewCalls = 0;
    const f = fixture({
      plan: { generate: async () => ({ content: 'plan' }) },
      execution: { execute: async () => ({ output: 'done', evidence: ['evidence'] }) },
      review: { review: async () => { reviewCalls++; return { passed: true, feedback: 'checked' }; } },
    });
    const db = new Database(f.path);
    try {
      expect((await f.post('plan', { requestKey: 'p' }))!.status).toBe(200);
      expect((await f.post('approve', { requirementsVersion: 1, planVersion: 1 }))!.status).toBe(200);
      const execution = await (await f.post('execute'))!.json();
      expect(execution.status).toBe('succeeded');
      const event = db.query("SELECT id,payload FROM workflow_events WHERE kind='execution_result' AND task_id=1").get() as { id: number; payload: string };
      const payload = JSON.parse(event.payload);
      payload.result.outcomeUnknown = value;
      db.query('UPDATE workflow_events SET payload=? WHERE id=?').run(JSON.stringify(payload), event.id);
      const response = await f.post('review', { attemptId: execution.attemptId });
      expect(response!.status).toBe(409);
      expect(reviewCalls).toBe(0);
      expect((await (await f.get('/api/tasks/1/workflow/events'))!.json()).review).toHaveLength(0);
    } finally { db.close(); f.close(); }
  }
});

test('live review cannot be recovered, and review retry remains unavailable', async () => {
  let release!: (decision: { passed: boolean; feedback: string }) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ review: { review: () => new Promise(resolve => { release = resolve; started(); }) } });
  const other = createWorkflowHandler(f.path);
  try {
    const w = new Workflow(f.path);
    w.savePlan(1, 1, 'plan'); w.approve(1, 1, 1, 'user');
    const result = await w.execute(1, { execute: async () => ({ output: 'done', evidence: ['evidence'] }) });
    w.close();
    const pending = f.post('review', { attemptId: result.attemptId });
    await entered;
    const recovery = await other.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/recover', { method: 'POST', headers: { origin: 'http://127.0.0.1:3210', 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'review' }) }));
    expect(recovery!.status).toBe(409);
    release({ passed: true, feedback: 'reviewed' });
    expect((await (await pending)!.json()).status).toBe('completed');
    expect((await (await f.post('recover', { kind: 'review' }))!.json()).count).toBe(0);
    const acknowledgement = await f.post('acknowledge', { kind: 'review', attemptId: result.attemptId });
    expect(acknowledgement!.status).toBe(409);
    expect((await acknowledgement!.json()).error).toContain('再試行は未実装');
  } finally { other.close(); f.close(); }
});

test('cancelled HTTP review blocks recovery until the late reviewer resolves or rejects', async () => {
  for (const mode of ['resolve', 'reject']) {
    let release!: (decision: {passed:boolean;feedback:string}) => void;
    let fail!: (error: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const f = fixture({ review: { review: () => new Promise((resolve, reject) => { release = resolve; fail = reject; started(); }) } });
    const other = createWorkflowHandler(f.path);
    try {
      const w = new Workflow(f.path);w.savePlan(1,1,'plan');w.approve(1,1,1,'user');
      const run = await w.execute(1,{execute:async()=>({output:'done',evidence:['saved test']})});w.close();
      const controller = new AbortController();
      const pending = f.handler.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/review', {method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({attemptId:run.attemptId}),signal:controller.signal}));
      await entered;controller.abort();
      const settled = await (await pending)!.json();expect(settled.status).toBe('failed');expect(settled.reason).toBe('cancelled');
      const recover = () => other.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/recover',{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify({kind:'review'})}));
      expect((await recover())!.status).toBe(409);
      if(mode==='resolve')release({passed:true,feedback:'late pass'});else fail(Error('late private reviewer failure'));
      await new Promise(resolve=>setTimeout(resolve,0));
      const recovered = await recover();expect(recovered!.status).toBe(200);expect((await recovered!.json()).count).toBe(0);
      const response = await f.get('/api/tasks/1/workflow/events');const events = await response!.json();
      expect(events.review).toHaveLength(1);expect(events.review[0].status).toBe('failed');
      expect(events.workflow.filter((e:any)=>e.kind==='review_result')).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain('late private reviewer failure');
      const retry=await f.post('review',{attemptId:run.attemptId});expect(retry!.status).toBe(409);expect((await retry!.json()).error).toContain('再試行は未実装');
    } finally {other.close();f.close();}
  }
});

test('reopened orphaned running review can be recovered but cannot be retried', async () => {
  let calls=0;const f=fixture({review:{review:async()=>{calls++;return {passed:true,feedback:'must not run'}}}});
  let reopened:ReturnType<typeof createWorkflowHandler>|undefined;
  try{
    const w=new Workflow(f.path);w.savePlan(1,1,'plan');w.approve(1,1,1,'user');
    const run=await w.execute(1,{execute:async()=>({output:'done',evidence:['saved test']})});w.close();
    const db=new Database(f.path);db.query("INSERT INTO execution_reviews(task_id,attempt_id,status,snapshot) VALUES (1,?,'running','{}')").run(run.attemptId);db.close();
    f.handler.close();reopened=createWorkflowHandler(f.path,{review:{review:async()=>{calls++;return {passed:true,feedback:'must not run'}}}});
    const post=(action:string,input:unknown)=>reopened!.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/'+action,{method:'POST',headers:{origin:'http://127.0.0.1:3210','content-type':'application/json'},body:JSON.stringify(input)}));
    const recovered=await post('recover',{kind:'review'});expect(recovered!.status).toBe(200);expect((await recovered!.json()).count).toBe(1);
    const events=await (await reopened.fetch(new Request('http://127.0.0.1:3210/api/tasks/1/workflow/events')))!.json();
    expect(events.review[0].status).toBe('interrupted');expect(events.review[0].result.outcomeUnknown).toBe(true);
    expect(events.workflow.filter((e:any)=>e.kind==='review_interrupted')).toHaveLength(1);
    const retry=await post('review',{attemptId:run.attemptId});expect(retry!.status).toBe(409);expect((await retry!.json()).error).toContain('再試行は未実装');expect(calls).toBe(0);
    expect((await (await post('recover',{kind:'review'}))!.json()).count).toBe(0);
  }finally{if(reopened)reopened.close();else f.handler.close();f.store.close();rmSync(f.dir,{recursive:true,force:true})}
});
