import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WorkflowRecovery, { readAttempts, type WorkflowHistory } from './WorkflowRecovery';
import WorkflowHistoryView from './WorkflowHistory';

const history = (): WorkflowHistory => ({ workflow: [], requirements: [], plan: [], review: [] });
const executionHistory = (): WorkflowHistory => {
  const requirements = { version: 1, content: '# 指示書' }, plan = { version: 1, content: '# 計画' };
  const execution = { output: '完了', evidence: ['テスト成功'] };
  return {
    requirements: [], plan: [], review: [],
    workflow: [
      { id: 1, task_id: 7, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 0 } },
      { id: 2, task_id: 7, kind: 'approval', payload: { requirementsVersion: 1, planVersion: 1, messageId: 0, actor: 'user' } },
      { id: 3, task_id: 7, kind: 'execution_requested', payload: { attemptId: 3, approvalId: 2, messageId: 0, request: { taskId: 7, requirements, plan } } },
      { id: 4, task_id: 7, kind: 'execution_result', payload: { attemptId: 3, status: 'succeeded', result: execution, stale: false } },
    ],
  };
};
const reviewSnapshot = () => ({ taskId: 7, attemptId: 3, approvalId: 2, messageId: 0,
  generationIds: { requirements: 0, plan: 0 }, requirements: { version: 1, content: '# 指示書' },
  plan: { version: 1, content: '# 計画' }, execution: { output: '完了', evidence: ['テスト成功'] } });
const json = (value: unknown, ok = true) => ({ ok, json: async () => value }) as Response;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('workflow recovery', () => {
  it('requires explicit checking before acknowledging an unknown result, without retrying', async () => {
    const data = executionHistory();
    data.requirements = [
      { task_id: 7, attempt_id: 3, kind: 'started', payload: {} },
      { task_id: 7, attempt_id: 3, kind: 'settled', payload: { status: 'unknown', outcomeUnknown: true } },
    ];
    data.review = [{ id: 2, task_id: 7, attempt_id: 3, status: 'interrupted', snapshot: reviewSnapshot(), result: { status: 'interrupted', outcomeUnknown: true } }];
    data.workflow.push({ id: 5, task_id: 7, kind: 'review_interrupted', payload: { reviewId: 2, attemptId: 3, status: 'interrupted', outcomeUnknown: true } });
    const fetcher = vi.fn().mockResolvedValue(json({ acknowledged: true }));
    vi.stubGlobal('fetch', fetcher);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    render(() => <WorkflowRecovery taskId={7} history={data} blocked={true} onClear={() => {}} onNotice={notify} onRefresh={refresh} />);
    const ack = screen.getByRole('button', { name: '外部結果を確認済みとして記録' }) as HTMLButtonElement;
    expect(ack.disabled).toBe(true);
    expect(screen.getByText(/監修の確認・再試行は未実装/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(ack);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/tasks/7/workflow/acknowledge');
    expect(JSON.parse(init.body)).toEqual({ kind: 'requirements', attemptId: 3 });
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('never clears the guard on malformed history or a newly unresolved attempt', async () => {
    const clear = vi.fn();
    const data = history();
    const [current, setCurrent] = createSignal<WorkflowHistory | null>(null);
    const fetcher = vi.fn().mockResolvedValue(json({ ...data, plan: [{ task_id: 4, attempt_id: 8, kind: 'started', payload: {} }] }));
    vi.stubGlobal('fetch', fetcher);
    render(() => <WorkflowRecovery taskId={4} history={current()} blocked={true} onClear={clear} onNotice={() => {}} onRefresh={async () => {}} />);
    expect(screen.getByText('履歴を取得できないため確認待ちを解除できません。')).toBeTruthy();
    expect(clear).not.toHaveBeenCalled();
    setCurrent(data);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '履歴確認を完了し、画面の確認待ちを解除' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(clear).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][0]).toBe('/api/tasks/4/workflow/events');
  });

  it('finishes an explicit clear when refresh replaces props for the same task', async () => {
    const data = history();
    const clear = vi.fn();
    const [task, setTask] = createSignal({ id: 104 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(data)));
    render(() => <WorkflowRecovery taskId={task().id} history={data} blocked={true} onClear={clear} onNotice={() => {}} onRefresh={async () => { setTask({ id: 104 }); }} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '履歴確認を完了し、画面の確認待ちを解除' }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
  });

  it('does not refresh or change notices for another task after an operation settles', async () => {
    const data = history();
    data.plan = [{ task_id: 1, attempt_id: 1, kind: 'started', payload: {} }];
    let resolve!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const [id, setId] = createSignal(1);
    const refresh = vi.fn().mockResolvedValue(undefined), notice = vi.fn();
    render(() => <WorkflowRecovery taskId={id()} history={data} blocked={true} onClear={() => {}} onNotice={notice} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '中断した処理として復旧' }));
    setId(2);
    resolve(json({ count: 1 }));
    await new Promise(done => setTimeout(done, 0));
    expect(refresh).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).toBeNull(); // The old task's history is not valid for the new task.
  });

  it('keeps a pending recovery locked across A → B → A without clearing from an old response', async () => {
    const data = history();
    data.plan = [{ task_id: 81, attempt_id: 1, kind: 'started', payload: {} }];
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const [id, setId] = createSignal(81);
    const refresh = vi.fn().mockResolvedValue(undefined), notice = vi.fn(), clear = vi.fn();
    render(() => <WorkflowRecovery taskId={id()} history={data} blocked={true} onClear={clear} onNotice={notice} onRefresh={refresh} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '中断した処理として復旧' }));
    setId(82);
    setId(81);
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: '中断した処理として復旧' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(fetcher).toHaveBeenCalledOnce();
    resolve(json({ count: 1 }));
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('keeps a pending recovery locked when the same task view remounts', async () => {
    const data = history();
    data.plan = [{ task_id: 91, attempt_id: 9, kind: 'started', payload: {} }];
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const view = () => <WorkflowRecovery taskId={91} history={data} blocked={true} onClear={() => {}} onNotice={() => {}} onRefresh={refresh} />;
    const mounted = render(view);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '中断した処理として復旧' }));
    mounted.unmount();
    render(view);
    fireEvent.click(screen.getByRole('checkbox'));
    expect((screen.getByRole('button', { name: '中断した処理として復旧' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    resolve(json({ count: 1 }));
    await waitFor(() => expect((screen.getByRole('button', { name: '中断した処理として復旧' }) as HTMLButtonElement).disabled).toBe(false));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('treats inconsistent history as invalid and presents plain-text results', () => {
    const data = history();
    data.plan = [{ attempt_id: 1, kind: 'settled', payload: { status: 'adopted' } }];
    expect(readAttempts(data).valid).toBe(false);
    data.plan = [{ attempt_id: 1, kind: 'started', payload: [] }];
    expect(readAttempts(data).valid).toBe(false);
    data.plan = [{ attempt_id: 1, kind: 'started', payload: {} }, { attempt_id: 1, kind: 'settled', payload: { status: 'failed' } }];
    expect(readAttempts(data).valid).toBe(false);
    data.plan = [];
    data.workflow = [{ id: 1, kind: 'execution_requested', payload: { attemptId: 3 } }, { id: 2, kind: 'execution_result', payload: { attemptId: 3, status: 'failed', result: {} } }];
    expect(readAttempts(data).valid).toBe(false);
    data.workflow = [{ id: 1, kind: 'execution_result', payload: { attemptId: 3, status: 'succeeded', result: { output: '<script>bad()</script>', evidence: ['テスト成功'] } } }];
    render(() => <WorkflowHistoryView history={data} integrity={true} />);
    fireEvent.click(screen.getByText('ワークフローの保存記録'));
    expect(screen.getByText(/<script>bad\(\)<\/script>/)).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/テスト成功/)).toBeTruthy();
  });

  it('accepts coherent execution and review states but rejects broken references or snapshots', () => {
    const running = executionHistory();
    expect(readAttempts(running).valid).toBe(true);
    running.review = [{ id: 5, task_id: 7, attempt_id: 3, status: 'running', snapshot: reviewSnapshot(), result: null }];
    expect(readAttempts(running).valid).toBe(true);
    const completed = structuredClone(running);
    const decision = { passed: true, feedback: '確認済み' };
    completed.review[0] = { ...completed.review[0], status: 'completed', result: { status: 'completed', decision, stale: false } };
    completed.workflow.push({ id: 5, task_id: 7, kind: 'review_result', payload: { reviewId: 5, attemptId: 3, status: 'completed', decision: { ...decision }, stale: false } });
    expect(readAttempts(completed).valid).toBe(true);
    expect(readAttempts(completed, 7).valid).toBe(true);
    expect(readAttempts(completed, 8).valid).toBe(false);
    const foreignEvent = structuredClone(completed);
    foreignEvent.workflow[1].task_id = 99;
    expect(readAttempts(foreignEvent, 7).valid).toBe(false);
    delete foreignEvent.workflow[1].task_id;
    expect(readAttempts(foreignEvent, 7).valid).toBe(false);
    const invalid = (mutate: (data: WorkflowHistory) => void) => {
      const value = structuredClone(completed); mutate(value); expect(readAttempts(value).valid).toBe(false);
    };
    invalid(data => { data.workflow[2].payload.approvalId = 999; });
    invalid(data => { data.workflow[2].payload.request.plan.version = 2; });
    invalid(data => { data.workflow[2].payload.messageId = 3; });
    invalid(data => { delete data.workflow[3].payload.stale; });
    invalid(data => { data.review[0].attempt_id = 999; });
    invalid(data => { data.review[0].task_id = 999; });
    invalid(data => { data.review[0].snapshot.execution.evidence = ['偽の証拠']; });
    invalid(data => { data.review[0].result.decision.feedback = '不一致'; });
    invalid(data => { data.workflow.pop(); });
    invalid(data => { data.review.push(structuredClone(data.review[0])); });
    invalid(data => { data.workflow[4].payload.attemptId = 999; });
    invalid(data => { data.workflow[4].payload.decision.passed = false; });
    invalid(data => { data.workflow[4].payload.reason = '一致しない理由'; });
    const orphan = history();
    orphan.review = [{ id: 1, status: 'completed' }];
    expect(readAttempts(orphan).valid).toBe(false);
    const badInstruction = history();
    badInstruction.workflow = [{ id: 1, task_id: 7, kind: 'instruction', payload: { messageId: 1 } }];
    expect(readAttempts(badInstruction, 7).valid).toBe(false);
    badInstruction.workflow = [
      { id: 1, task_id: 7, kind: 'instruction', payload: { messageId: 1, original: '依頼' } },
      { id: 2, task_id: 7, kind: 'instruction', payload: { messageId: 1, original: '依頼' } },
    ];
    expect(readAttempts(badInstruction, 7).valid).toBe(false);
  });

});
