import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function json(value: unknown): Response { return { ok: true, json: async () => structuredClone(value) } as Response; }
const emptyHistory = () => ({ workflow: [], requirements: [], plan: [], review: [] });
const task = (id: number, name = 'テスト') => ({ id, projectId: 77, name, phase: 'requirements', status: 'idle' });
const doc = (version: number, content = `指示書 v${version}`) => ({ name: '指示書.md', content, version });
const adoptedRequirements = (taskId: number, attemptId: number, version: number, instructions: {id:number;content:string}[]) => [
  { id: attemptId * 2 - 1, task_id: taskId, attempt_id: attemptId, kind: 'started', payload: { requestKey: `request-${attemptId}`, snapshot: { taskId, taskName: 'テスト', instructions, document: { version: version - 1, content: version === 2 ? '# 初期' : `指示書 v${version - 1}` } } } },
  { id: attemptId * 2, task_id: taskId, attempt_id: attemptId, kind: 'settled', payload: { status: 'adopted', version, content: `指示書 v${version}`, outcomeUnknown: false } },
];
const enabled = { requirements: true, plan: true, execution: true, review: true };
const disabled = { requirements: false, plan: false, execution: false, review: false };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('workflow screen', () => {
  it('shows disabled actions for unconfigured adapters and never invokes generation after a message', async () => {
    const t = task(1101); const messages: {id:number;role:string;content:string}[] = []; let generation = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(disabled));
      if (path === '/api/tasks/1101/workflow/events') return Promise.resolve(json(emptyHistory()));
      if (path === '/api/tasks/1101') return Promise.resolve(json({ task: t, messages, documents: [doc(1)] }));
      if (path === '/api/tasks/1101/messages' && init?.method === 'POST') { messages.push({ id: 1, role: 'user', content: JSON.parse(String(init.body)).content }); return Promise.resolve(json({ id: 1 })); }
      if (path.endsWith('/requirements') && init?.method === 'POST') { generation++; throw new Error('unconfigured generation invoked'); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1101} projectId={77} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    await waitFor(() => expect(screen.getByText(/指示書生成.*未設定/)).toBeTruthy());
    expect((screen.getByRole('button', { name: '指示書を更新' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.input(textbox, { target: { value: '希望を追記' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('希望を追記', { exact: true });
    await waitFor(() => expect(screen.getByText('指示書生成は未接続です。')).toBeTruthy());
    expect(generation).toBe(0);
  });

  it('fails closed when workflow history cannot be retrieved', async () => {
    const t = task(1102); let posts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === '/api/tasks/1102') return Promise.resolve(json({ task: t, messages: [], documents: [doc(1)] }));
      if (path === '/api/tasks/1102/workflow/events') return Promise.reject(new Error('offline'));
      if (init?.method === 'POST') { posts++; throw new Error('unsafe'); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1102} projectId={77} onHome={() => {}} />);
    await screen.findByText('履歴を取得できません。処理は開始できません。');
    const plan = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    const update = screen.getByRole('button', { name: '指示書を更新' }) as HTMLButtonElement;
    expect(plan.disabled).toBe(true); expect(update.disabled).toBe(true);
    fireEvent.click(plan); fireEvent.click(update); expect(posts).toBe(0);
  });

  it('waits for updated documents to be displayed before planning and executing, and prevents double execution', async () => {
    const t = task(1103); let documents = [doc(1)]; let workflow: any[] = [];
    const detailAfterRequirements = deferred<Response>(), detailAfterPlan = deferred<Response>(), execution = deferred<Response>();
    let detailGets = 0, generationPosts = 0, planPosts = 0, approvals = 0, executions = 0, reviews = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === '/api/tasks/1103/workflow/events') return Promise.resolve(json({ ...emptyHistory(), workflow }));
      if (path === '/api/tasks/1103') {
        detailGets++;
        if (detailGets === 3) return detailAfterRequirements.promise;
        if (detailGets === 4) return detailAfterPlan.promise;
        return Promise.resolve(json({ task: t, messages: [], documents }));
      }
      if (path === '/api/tasks/1103/workflow/requirements' && init?.method === 'POST') { generationPosts++; return Promise.resolve(json({ status: 'adopted', version: 2, outcomeUnknown: false })); }
      if (path === '/api/tasks/1103/workflow/plan' && init?.method === 'POST') { planPosts++; workflow = [{ id: 1, task_id: 1103, kind: 'plan', payload: { requirementsVersion: 2, planVersion: 1, messageId: 0 } }]; return Promise.resolve(json({ status: 'adopted', version: 1, outcomeUnknown: false })); }
      if (path === '/api/tasks/1103/workflow/approve' && init?.method === 'POST') { approvals++; expect(JSON.parse(String(init.body))).toEqual({ requirementsVersion: 2, planVersion: 1 }); return Promise.resolve(json({ approvalId: 1 })); }
      if (path === '/api/tasks/1103/workflow/execute' && init?.method === 'POST') { executions++; return execution.promise; }
      if (path === '/api/tasks/1103/workflow/review' && init?.method === 'POST') { reviews++; expect(JSON.parse(String(init.body))).toEqual({ attemptId: 7 }); return Promise.resolve(json({ status: 'completed' })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1103} projectId={77} onHome={() => {}} />);
    await screen.findByText('指示書 v1');
    const update = screen.getByRole('button', { name: '指示書を更新' }) as HTMLButtonElement;
    await waitFor(() => expect(update.disabled).toBe(false));
    expect((screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement).disabled).toBe(false); // 初期タスク名だけでまだ発言がない
    fireEvent.click(update);
    await waitFor(() => expect(generationPosts).toBe(1));
    await waitFor(() => expect(detailGets).toBeGreaterThanOrEqual(3));
    const planButton = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    expect(planButton.disabled).toBe(true); fireEvent.click(planButton); expect(planPosts).toBe(0);
    documents = [doc(1), doc(2)]; detailAfterRequirements.resolve(json({ task: t, messages: [], documents }));
    await screen.findByText('指示書 v2');
    await waitFor(() => expect(planButton.disabled).toBe(false));
    fireEvent.click(planButton);
    await waitFor(() => expect(planPosts).toBe(1));
    await waitFor(() => expect(detailGets).toBeGreaterThanOrEqual(4));
    expect(screen.queryByRole('button', { name: '実行指示' })).toBeNull();
    documents = [doc(1), doc(2), { name: 'plan', content: '# 実装案', version: 1 }];
    detailAfterPlan.resolve(json({ task: t, messages: [], documents }));
    await screen.findByText('# 実装案');
    const executeButton = await screen.findByRole('button', { name: '実行指示' }) as HTMLButtonElement;
    await waitFor(() => expect(executeButton.disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'タスク内容' }));
    expect(executeButton.disabled).toBe(true); fireEvent.click(executeButton); expect(approvals).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '実装フロー' }));
    await waitFor(() => expect(executeButton.disabled).toBe(false));
    fireEvent.click(executeButton); fireEvent.click(executeButton);
    await waitFor(() => expect(executions).toBe(1));
    expect(approvals).toBe(1); expect(executeButton.disabled).toBe(true);
    execution.resolve(json({ status: 'succeeded', attemptId: 7, stale: false, result: { output: '完了', evidence: ['確認済み'] } }));
    await waitFor(() => expect(reviews).toBe(1));
  });

  it('queues an additional message while requirements generation is running', async () => {
    const t = task(1104); const messages: {id:number;role:string;content:string}[] = []; let documents = [doc(1)];
    const firstGeneration = deferred<Response>(); let generationPosts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === '/api/tasks/1104/workflow/events') return Promise.resolve(json(emptyHistory()));
      if (path === '/api/tasks/1104') return Promise.resolve(json({ task: t, messages, documents }));
      if (path === '/api/tasks/1104/messages' && init?.method === 'POST') {
        messages.push({ id: messages.length + 1, role: 'user', content: JSON.parse(String(init.body)).content });
        return Promise.resolve(json({ id: messages.length }));
      }
      if (path === '/api/tasks/1104/workflow/requirements' && init?.method === 'POST') {
        generationPosts++;
        if (generationPosts === 1) return firstGeneration.promise;
        documents = [doc(1), doc(2), doc(3)];
        return Promise.resolve(json({ status: 'adopted', version: 3, outcomeUnknown: false }));
      }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1104} projectId={77} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '最初の希望' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await waitFor(() => expect(generationPosts).toBe(1));
    expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).toContain(1104);
    fireEvent.input(textbox, { target: { value: '追加の希望' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('追加の希望', { exact: true });
    expect(generationPosts).toBe(1);
    documents = [doc(1), doc(2)];
    firstGeneration.resolve(json({ status: 'adopted', version: 2, outcomeUnknown: false }));
    await waitFor(() => expect(generationPosts).toBe(2));
    await screen.findByText('指示書 v3');
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(1104));
    expect(messages.map(item => item.content)).toEqual(['最初の希望', '追加の希望']);
  });

  it('keeps another task selected when an earlier task generation finishes', async () => {
    const a = task(1105, '先'), b = task(1106, '後'); const generation = deferred<Response>();
    let aDocuments = [doc(1, '先の文書')]; let generationPosts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [a, b] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path.endsWith('/workflow/events')) return Promise.resolve(json(emptyHistory()));
      if (path === '/api/tasks/1105') return Promise.resolve(json({ task: a, messages: [], documents: aDocuments }));
      if (path === '/api/tasks/1106') return Promise.resolve(json({ task: b, messages: [], documents: [doc(1, '後の文書')] }));
      if (path === '/api/tasks/1105/workflow/requirements' && init?.method === 'POST') { generationPosts++; return generation.promise; }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1105} projectId={77} onHome={() => {}} />);
    await screen.findByText('先の文書');
    const update = screen.getByRole('button', { name: '指示書を更新' }) as HTMLButtonElement;
    await waitFor(() => expect(update.disabled).toBe(false));
    fireEvent.click(update); await waitFor(() => expect(generationPosts).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '#1106 後' }));
    await screen.findByText('後の文書');
    aDocuments = [doc(1, '先の文書'), doc(2, '先の更新')];
    generation.resolve(json({ status: 'adopted', version: 2, outcomeUnknown: false }));
    await generation.promise;
    expect(screen.getByText('後の文書')).toBeTruthy();
    expect(screen.queryByText('先の更新')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '#1105 先' }));
    await screen.findByText('先の更新');
    expect(screen.getByRole('tab', { name: '#1105 先' }).getAttribute('aria-selected')).toBe('true');
  });

  it('does not approve a same-version document that is not the authoritative plan kind', async () => {
    const t = task(1108); let approvals = 0;
    const documents = [doc(1), { name: '実装計画.md', content: '意図しない別文書', version: 1 }, { name: 'plan', content: '正規の計画', version: 1 }];
    const workflow = [{ id: 1, task_id: 1108, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 0 } }];
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === '/api/tasks/1108/workflow/events') return Promise.resolve(json({ ...emptyHistory(), workflow }));
      if (path === '/api/tasks/1108') return Promise.resolve(json({ task: t, messages: [], documents }));
      if (path.endsWith('/approve') && init?.method === 'POST') { approvals++; return Promise.resolve(json({ approvalId: 1 })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1108} projectId={77} onHome={() => {}} />);
    await screen.findByText('指示書 v1');
    const executeButton = screen.getByRole('button', { name: '実行指示' }) as HTMLButtonElement;
    const tabs = screen.getAllByRole('tab', { name: '実装計画.md' });
    fireEvent.click(tabs[0]);
    expect(screen.getByText('意図しない別文書')).toBeTruthy();
    expect(executeButton.disabled).toBe(true);
    fireEvent.click(executeButton); expect(approvals).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '実装フロー' }));
    expect(screen.getByText('正規の計画')).toBeTruthy();
    await waitFor(() => expect(executeButton.disabled).toBe(false));
  });

  it('blocks planning and execution after an unreflected instruction until the adopted generation is shown', async () => {
    const t = task(1113); const messages: {id:number;role:string;content:string}[] = [];
    let documents = [doc(1), { name: 'plan', content: '旧計画', version: 1 }];
    const workflow: Array<{ id: number; task_id: number; kind: string; payload: Record<string, unknown> }> = [{ id: 1, task_id: t.id, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 0 } }];
    const history = { ...emptyHistory(), workflow, requirements: [] as ReturnType<typeof adoptedRequirements> };
    let planPosts = 0, approvals = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json({ ...enabled, requirements: false }));
      if (path === `/api/tasks/${t.id}/workflow/events`) return Promise.resolve(json(history));
      if (path === `/api/tasks/${t.id}`) return Promise.resolve(json({ task: t, messages, documents }));
      if (path === `/api/tasks/${t.id}/messages` && init?.method === 'POST') {
        messages.push({ id: 6, role: 'user', content: '未反映の追加指示' });
        history.workflow.push({ id: 2, task_id: t.id, kind: 'instruction', payload: { messageId: 6, original: '未反映の追加指示' } });
        // Even an apparently current plan cannot prove the requirements incorporated this message.
        history.workflow.push({ id: 3, task_id: t.id, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 6 } });
        return Promise.resolve(json({ id: 6 }));
      }
      if (path === `/api/tasks/${t.id}/workflow/plan` && init?.method === 'POST') { planPosts++; return Promise.resolve(json({ status: 'stale', outcomeUnknown: false })); }
      if (path === `/api/tasks/${t.id}/workflow/approve` && init?.method === 'POST') { approvals++; return Promise.resolve(json({ approvalId: 99 })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={t.id} projectId={77} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '未反映の追加指示' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findByText('最新の追加指示を指示書に反映してから計画を依頼できます。');
    const request = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    expect(request.disabled).toBe(true); fireEvent.click(request); expect(planPosts).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: '実装フロー' }));
    const execute = screen.getByRole('button', { name: '実行指示' }) as HTMLButtonElement;
    expect(execute.disabled).toBe(true); fireEvent.click(execute); expect(approvals).toBe(0);
    // Simulate a successful later generation with the exact saved message in its snapshot.
    documents = [doc(1), doc(2), { name: 'plan', content: '旧計画', version: 1 }];
    history.requirements.push(...adoptedRequirements(t.id, 44, 2, [{ id: 6, content: '未反映の追加指示' }]));
    fireEvent.click(screen.getByText('処理結果の確認と復旧'));
    fireEvent.click(screen.getByRole('button', { name: '保存履歴を再取得' }));
    await screen.findByRole('tab', { name: '指示書.md · v2' });
    expect(request.disabled).toBe(true); // still viewing the old plan
    fireEvent.click(screen.getByRole('button', { name: 'タスク内容' }));
    expect(screen.getByText('指示書 v2')).toBeTruthy();
    await waitFor(() => expect(request.disabled).toBe(false));
    fireEvent.click(request); await waitFor(() => expect(planPosts).toBe(1));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(t.id));
  });

  for (const status of ['failed', 'stale'] as const) it(`does not treat a ${status} generation as proof that the latest instruction was incorporated`, async () => {
    const t = task(status === 'failed' ? 1114 : 1115);
    const messages = [{ id: 8, role: 'user', content: '新しい指示' }];
    const events = adoptedRequirements(t.id, 45, 2, [{ id: 8, content: '新しい指示' }]);
    events[1].payload = { status, outcomeUnknown: false } as typeof events[number]['payload'];
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === `/api/tasks/${t.id}/workflow/events`) return Promise.resolve(json({ ...emptyHistory(), requirements: events }));
      if (path === `/api/tasks/${t.id}`) return Promise.resolve(json({ task: t, messages, documents: [doc(1)] }));
      if (init?.method === 'POST') { calls++; throw new Error('must not execute'); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={t.id} projectId={77} onHome={() => {}} />);
    await screen.findByText('最新の追加指示を指示書に反映してから計画を依頼できます。');
    const request = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    expect(request.disabled).toBe(true); fireEvent.click(request); expect(calls).toBe(0);
  });

  for (const status of ['failed', 'interrupted'] as const) it(`requires a new instruction before replanning after a ${status} review`, async () => {
    const t = task(status === 'failed' ? 1110 : 1111); const messages = [{ id: 5, role: 'user', content: '元の指示' }];
    const requirements = { version: 2, content: '指示書 v2' }, plan = { version: 1, content: '旧計画' }, execution = { output: '作業結果', evidence: ['証拠'] };
    const snapshot = { taskId: t.id, attemptId: 11, approvalId: 3, messageId: 5, generationIds: { requirements: 0, plan: 0 }, requirements, plan, execution };
    const reviewResult = status === 'failed' ? { status: 'failed', reason: 'review_failed', stale: false } : { status: 'interrupted', outcomeUnknown: true };
    const history = {
      ...emptyHistory(),
      requirements: adoptedRequirements(t.id, 41, 2, [{ id: 5, content: '元の指示' }]),
      workflow: [
        { id: 1, kind: 'instruction', payload: { messageId: 5, original: '元の指示' } },
        { id: 2, kind: 'plan', payload: { requirementsVersion: 2, planVersion: 1, messageId: 5 } },
        { id: 3, kind: 'approval', payload: { requirementsVersion: 2, planVersion: 1, messageId: 5, actor: 'user' } },
        { id: 4, kind: 'execution_requested', payload: { attemptId: 11, approvalId: 3, request: { taskId: t.id, requirements, plan }, messageId: 5 } },
        { id: 5, kind: 'execution_result', payload: { attemptId: 11, status: 'succeeded', stale: false, result: execution } },
        { id: 6, kind: status === 'failed' ? 'review_result' : 'review_interrupted', payload: { reviewId: 21, attemptId: 11, ...reviewResult } },
      ].map(event => ({ ...event, task_id: t.id })),
      review: [{ id: 21, task_id: t.id, attempt_id: 11, status, snapshot, result: reviewResult }],
    };
    let planPosts = 0; let documents = [doc(2), { name: 'plan', content: '旧計画', version: 1 }];
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === `/api/tasks/${t.id}/workflow/events`) return Promise.resolve(json(history));
      if (path === `/api/tasks/${t.id}`) return Promise.resolve(json({ task: t, messages, documents }));
      if (path === `/api/tasks/${t.id}/messages` && init?.method === 'POST') {
        messages.push({ id: 6, role: 'user', content: JSON.parse(String(init.body)).content });
        history.workflow.push({ id: 7, task_id: t.id, kind: 'instruction', payload: { messageId: 6, original: '再計画して' } } as typeof history.workflow[number]);
        return Promise.resolve(json({ id: 6 }));
      }
      if (path === `/api/tasks/${t.id}/workflow/requirements` && init?.method === 'POST') {
        documents = [doc(2), doc(3), { name: 'plan', content: '旧計画', version: 1 }];
        history.requirements.push(...adoptedRequirements(t.id, 42, 3, [{ id: 5, content: '元の指示' }, { id: 6, content: '再計画して' }]));
        return Promise.resolve(json({ status: 'adopted', version: 3, outcomeUnknown: false }));
      }
      if (path === `/api/tasks/${t.id}/workflow/plan` && init?.method === 'POST') { planPosts++; return Promise.resolve(json({ status: 'stale', outcomeUnknown: false })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={t.id} projectId={77} onHome={() => {}} />);
    await screen.findByText('監修が完了していません。再計画には追加指示が必要です。');
    const request = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    expect(request.disabled).toBe(true); fireEvent.click(request); expect(planPosts).toBe(0);
    const textbox = screen.getByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '再計画して' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    await screen.findAllByText('再計画して', { exact: true });
    await waitFor(() => expect(request.disabled).toBe(false));
    fireEvent.click(request);
    await waitFor(() => expect(planPosts).toBe(1));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(t.id));
  });

  it('accepts a new instruction already recorded during a stale review without requiring it twice', async () => {
    const t = task(1112); const requirements = { version: 1, content: '指示書 v1' }, plan = { version: 1, content: '旧計画' }, execution = { output: '作業結果', evidence: ['証拠'] };
    const snapshot = { taskId: t.id, attemptId: 11, approvalId: 3, messageId: 5, generationIds: { requirements: 0, plan: 0 }, requirements, plan, execution };
    const reviewResult = { status: 'stale', stale: true, decision: { passed: true, feedback: '確認' } };
    const history = { ...emptyHistory(), requirements: adoptedRequirements(t.id, 43, 2, [{ id: 5, content: '元の指示' }, { id: 6, content: '監修中の指示' }]), workflow: [
      { id: 1, kind: 'instruction', payload: { messageId: 5, original: '元の指示' } },
      { id: 2, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 5 } },
      { id: 3, kind: 'approval', payload: { requirementsVersion: 1, planVersion: 1, messageId: 5, actor: 'user' } },
      { id: 4, kind: 'execution_requested', payload: { attemptId: 11, approvalId: 3, request: { taskId: t.id, requirements, plan }, messageId: 5 } },
      { id: 5, kind: 'execution_result', payload: { attemptId: 11, status: 'succeeded', stale: false, result: execution } },
      { id: 6, kind: 'instruction', payload: { messageId: 6, original: '監修中の指示' } },
      { id: 7, kind: 'review_result', payload: { reviewId: 21, attemptId: 11, ...reviewResult } },
    ].map(event => ({ ...event, task_id: t.id })), review: [{ id: 21, task_id: t.id, attempt_id: 11, status: 'stale', snapshot, result: reviewResult }] };
    let planPosts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json({ ...enabled, requirements: false }));
      if (path === `/api/tasks/${t.id}/workflow/events`) return Promise.resolve(json(history));
      if (path === `/api/tasks/${t.id}`) return Promise.resolve(json({ task: t, messages: [{ id: 5, role: 'user', content: '元の指示' }, { id: 6, role: 'user', content: '監修中の指示' }], documents: [doc(2)] }));
      if (path === `/api/tasks/${t.id}/workflow/plan` && init?.method === 'POST') { planPosts++; return Promise.resolve(json({ status: 'stale', outcomeUnknown: false })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={t.id} projectId={77} onHome={() => {}} />);
    await screen.findAllByText('監修中の指示', { exact: true });
    const request = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    await waitFor(() => expect(request.disabled).toBe(false));
    expect(screen.queryByText('監修が完了していません。再計画には追加指示が必要です。')).toBeNull();
    fireEvent.click(request);
    await waitFor(() => expect(planPosts).toBe(1));
    await waitFor(() => expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(t.id));
  });

  it('does not invoke review when a successful-looking execution reports an unknown outcome', async () => {
    const t = task(1116); let executionPosts = 0, reviewPosts = 0;
    const history = { ...emptyHistory(), workflow: [{ id: 1, task_id: t.id, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 0 } }] };
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === `/api/tasks/${t.id}/workflow/events`) return Promise.resolve(json(history));
      if (path === `/api/tasks/${t.id}`) return Promise.resolve(json({ task: t, messages: [], documents: [doc(1), { name: 'plan', content: '実行する計画', version: 1 }] }));
      if (path === `/api/tasks/${t.id}/workflow/approve` && init?.method === 'POST') return Promise.resolve(json({ approvalId: 5 }));
      if (path === `/api/tasks/${t.id}/workflow/execute` && init?.method === 'POST') { executionPosts++; return Promise.resolve(json({ status: 'succeeded', stale: false, attemptId: 7, result: { outcomeUnknown: true, output: '要確認', evidence: ['証拠'] } })); }
      if (path === `/api/tasks/${t.id}/workflow/review` && init?.method === 'POST') { reviewPosts++; return Promise.resolve(json({ status: 'completed' })); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={t.id} projectId={77} onHome={() => {}} />);
    await screen.findByText('指示書 v1');
    fireEvent.click(screen.getByRole('button', { name: '実装フロー' }));
    await screen.findByText('実行する計画');
    const execute = screen.getByRole('button', { name: '実行指示' }) as HTMLButtonElement;
    await waitFor(() => expect(execute.disabled).toBe(false));
    fireEvent.click(execute);
    await screen.findByText('処理結果を確認できません。履歴と外部処理を確認してください。');
    expect(executionPosts).toBe(1); expect(reviewPosts).toBe(0);
    expect(execute.disabled).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).toContain(t.id);
  });

  it('marks planning unavailable across tasks on an authoritative not-connected response without blocking or retrying', async () => {
    const first = task(1120, '先'), second = task(1121, '後'); let planPosts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [first, second] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path.endsWith('/workflow/events')) return Promise.resolve(json(emptyHistory()));
      if (path === '/api/tasks/1120') return Promise.resolve(json({ task: first, messages: [], documents: [doc(1, '先の指示書')] }));
      if (path === '/api/tasks/1121') return Promise.resolve(json({ task: second, messages: [], documents: [doc(1, '後の指示書')] }));
      if (path === '/api/tasks/1120/workflow/plan' && init?.method === 'POST') {
        planPosts++;
        return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: '計画生成は未接続です' }) } as Response);
      }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1120} projectId={77} onHome={() => {}} />);
    await screen.findByText('先の指示書');
    const request = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    await waitFor(() => expect(request.disabled).toBe(false));
    fireEvent.click(request);
    await screen.findByText('計画生成は未接続です');
    expect(screen.getByText(/計画\s*未設定/)).toBeTruthy();
    expect(request.disabled).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(first.id);
    expect(screen.queryByText('処理結果を確認できません。履歴と外部処理を確認してください。')).toBeNull();
    fireEvent.click(request); expect(planPosts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '#1121 後' }));
    await screen.findByText('後の指示書');
    const otherRequest = screen.getByRole('button', { name: '高モデルに依頼' }) as HTMLButtonElement;
    expect(otherRequest.disabled).toBe(true);
    expect(screen.getByText(/計画\s*未設定/)).toBeTruthy();
    fireEvent.click(otherRequest); expect(planPosts).toBe(1);
  });

  it('does not send a model operation when the confirmation marker cannot be persisted', async () => {
    const t = task(1107); let operationPosts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [t] }));
      if (path === '/api/workflow/capabilities') return Promise.resolve(json(enabled));
      if (path === '/api/tasks/1107/workflow/events') return Promise.resolve(json(emptyHistory()));
      if (path === '/api/tasks/1107') return Promise.resolve(json({ task: t, messages: [], documents: [doc(1)] }));
      if (init?.method === 'POST') { operationPosts++; throw new Error('must not run'); }
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={1107} projectId={77} onHome={() => {}} />);
    await screen.findByText('指示書 v1');
    const update = screen.getByRole('button', { name: '指示書を更新' }) as HTMLButtonElement;
    await waitFor(() => expect(update.disabled).toBe(false));
    const storage = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      fireEvent.click(update);
      expect((await screen.findAllByText('確認状態を保存できないため処理を開始できません。')).length).toBeGreaterThan(0);
      expect(operationPosts).toBe(0);
      expect(update.disabled).toBe(true);
    } finally { storage.mockRestore(); }
  });

  it('fails closed when a persisted confirmation marker is malformed', async () => {
    sessionStorage.setItem('beni-workflow-unconfirmed', '{broken');
    vi.resetModules();
    try {
      const controller = await import('./workflowController');
      const operation = vi.fn(async () => {});
      expect(controller.isBlocked(1109)).toBe(true);
      await controller.perform(1109, '計画', operation);
      expect(operation).not.toHaveBeenCalled();
    } finally { sessionStorage.removeItem('beni-workflow-unconfirmed'); }
  });
});
