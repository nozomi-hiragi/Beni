import { cleanup, render, screen, within } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAttempts, type WorkflowHistory } from './WorkflowRecovery';
import WorkflowResults from './WorkflowResults';
import Workspace from '../Workspace';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(taskId: number, executionMode: 'succeeded' | 'failed' | 'unknown' | 'stale' = 'succeeded', reviewMode?: 'completed' | 'changes_requested' | 'stale' | 'failed' | 'interrupted', staleExecution = false): WorkflowHistory {
  const requirements = { version: 1, content: '# 要望' };
  const plan = { version: 1, content: '# 計画' };
  const execution = executionMode === 'failed' || executionMode === 'unknown'
    ? { reason: 'execution_failed', outcomeUnknown: executionMode === 'unknown' }
    : { output: '架空の実行出力', evidence: ['架空の検証証拠'] };
  const status = executionMode === 'failed' || executionMode === 'unknown' ? 'failed' : 'succeeded';
  const workflow: WorkflowHistory['workflow'] = [
    { id: 1, task_id: taskId, kind: 'instruction', payload: { messageId: 5, original: '架空の依頼' } },
    { id: 2, task_id: taskId, kind: 'plan', payload: { requirementsVersion: 1, planVersion: 1, messageId: 5 } },
    { id: 3, task_id: taskId, kind: 'approval', payload: { requirementsVersion: 1, planVersion: 1, messageId: 5, actor: 'user' } },
    { id: 4, task_id: taskId, kind: 'execution_requested', payload: { attemptId: 11, approvalId: 3, request: { taskId, requirements, plan }, messageId: 5 } },
    { id: 5, task_id: taskId, kind: 'execution_result', payload: { attemptId: 11, status, stale: executionMode === 'stale' || staleExecution, result: execution } },
  ];
  const review: WorkflowHistory['review'] = [];
  if (reviewMode) {
    if (executionMode !== 'succeeded' || staleExecution) throw new Error('A review requires a current successful execution');
    const snapshot = { taskId, attemptId: 11, approvalId: 3, messageId: 5, generationIds: { requirements: 0, plan: 0 }, requirements, plan, execution };
    const decision = reviewMode === 'completed' ? { passed: true, feedback: '架空の監修フィードバック' }
      : reviewMode === 'changes_requested' ? { passed: false, feedback: '架空の修正指摘' }
      : reviewMode === 'stale' ? { passed: true, feedback: '旧版に対する監修' } : undefined;
    const result = reviewMode === 'interrupted' ? { status: reviewMode, outcomeUnknown: true }
      : { status: reviewMode, stale: reviewMode === 'stale', ...(reviewMode === 'failed' ? { reason: 'review_failed' } : {}), ...(decision ? { decision } : {}) };
    workflow.push({ id: 6, task_id: taskId, kind: reviewMode === 'interrupted' ? 'review_interrupted' : 'review_result', payload: { reviewId: 21, attemptId: 11, ...result } });
    review.push({ id: 21, task_id: taskId, attempt_id: 11, status: reviewMode, snapshot, result });
  }
  return { workflow, requirements: [], plan: [], review };
}

describe('saved execution and review results', () => {
  it('shows the persisted output, evidence, and reviewer feedback', () => {
    const history = fixture(1701, 'succeeded', 'completed');
    expect(readAttempts(history, 1701).valid).toBe(true);
    render(() => <WorkflowResults taskId={1701} history={history} integrity={true} />);
    expect(screen.getByText('実行完了 · 実行 #11')).toBeTruthy();
    expect(screen.getByText('架空の実行出力')).toBeTruthy();
    expect(screen.getByText('架空の検証証拠')).toBeTruthy();
    expect(screen.getByText('監修完了 · 実行 #11')).toBeTruthy();
    expect(screen.getByText('架空の監修フィードバック')).toBeTruthy();
    expect(screen.getByText(/保存記録上の過去の結果（最新とは限らず、内容の真正性は未確認）/)).toBeTruthy();
  });

  it.each([
    ['failed', '実行失敗 · 実行 #11'],
    ['unknown', '実行結果は未確認 · 実行 #11'],
    ['stale', '実行完了（旧版） · 実行 #11'],
  ] as const)('labels an execution with %s state accurately', (mode, label) => {
    const history = fixture(1702, mode);
    expect(readAttempts(history, 1702).valid).toBe(true);
    render(() => <WorkflowResults taskId={1702} history={history} integrity={true} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('実行完了 · 実行 #11')).toBeNull();
    expect(screen.queryByText('監修完了 · 実行 #11')).toBeNull();
  });

  it.each([
    ['failed', '実行失敗（旧版） · 実行 #11'],
    ['unknown', '実行結果は未確認（旧版） · 実行 #11'],
  ] as const)('preserves both %s and stale indicators', (mode, label) => {
    const history = fixture(1708, mode, undefined, true);
    expect(readAttempts(history, 1708).valid).toBe(true);
    render(() => <WorkflowResults taskId={1708} history={history} integrity={true} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('実行完了 · 実行 #11')).toBeNull();
  });

  it.each([
    ['failed', '監修失敗 · 実行 #11'],
    ['stale', '監修結果（旧版） · 実行 #11'],
    ['changes_requested', '手直しが必要 · 実行 #11'],
  ] as const)('does not present a %s review as completed', (mode, label) => {
    const history = fixture(1703, 'succeeded', mode);
    expect(readAttempts(history, 1703).valid).toBe(true);
    render(() => <WorkflowResults taskId={1703} history={history} integrity={true} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText('監修完了 · 実行 #11')).toBeNull();
  });

  it('does not render trusted results if the saved approval/execution linkage is corrupted', () => {
    const history = fixture(1704, 'succeeded', 'completed');
    history.workflow.find(event => event.kind === 'execution_requested')!.payload.approvalId = 999;
    expect(readAttempts(history, 1704).valid).toBe(false);
    render(() => <WorkflowResults taskId={1704} history={history} integrity={true} />);
    expect(screen.queryByLabelText('保存された実行・監修結果')).toBeNull();
    expect(screen.queryByText('架空の実行出力')).toBeNull();
    expect(screen.queryByText('架空の検証証拠')).toBeNull();
    expect(screen.queryByText('架空の監修フィードバック')).toBeNull();
  });

  it('does not display records for another task', () => {
    const history = fixture(1705, 'succeeded', 'completed');
    expect(readAttempts(history, 1706).valid).toBe(false);
    render(() => <WorkflowResults taskId={1706} history={history} integrity={true} />);
    expect(screen.queryByLabelText('保存された実行・監修結果')).toBeNull();
  });

  it('does not display otherwise consistent results when projected integrity is unconfirmed', () => {
    const history = fixture(1709, 'succeeded', 'completed');
    expect(readAttempts(history, 1709).valid).toBe(true);
    render(() => <WorkflowResults taskId={1709} history={history} integrity={false} />);
    expect(screen.queryByLabelText('保存された実行・監修結果')).toBeNull();
    expect(screen.queryByText('架空の実行出力')).toBeNull();
    expect(screen.queryByText('架空の監修フィードバック')).toBeNull();
  });

  it('renders saved results inside the task chat when the workspace loads', async () => {
    const task = { id: 1707, projectId: 77, name: '架空', phase: '実装中', status: '完了（監修済み）' };
    const history = fixture(task.id, 'succeeded', 'completed');
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      const response = (value: unknown) => Promise.resolve({ ok: true, json: async () => structuredClone(value) } as Response);
      if (path === '/api/state') return response({ projects: [], tasks: [task] });
      if (path === '/api/workflow/capabilities') return response({ requirements: false, plan: false, execution: false, review: false });
      if (path === `/api/tasks/${task.id}`) return response({ task, messages: [{ id: 5, role: 'user', content: '架空の依頼' }], documents: [{ name: '指示書.md', content: '# 要望', version: 1 }] });
      if (path === `/api/tasks/${task.id}/workflow/events`) return response(history);
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={task.id} projectId={77} onHome={() => {}} />);
    const output = await screen.findByText('架空の実行出力');
    expect(output.closest('[aria-live="polite"]')).toBeTruthy();
    expect(output.closest('[aria-label="タスクチャット"]')).toBeTruthy();
    expect(screen.getByText('架空の検証証拠').closest('[aria-label="タスクチャット"]')).toBeTruthy();
    const results = screen.getByLabelText('保存された実行・監修結果');
    expect(within(results).getByText('架空の監修フィードバック').closest('[aria-label="タスクチャット"]')).toBeTruthy();
  });

  it.each([
    ['確認が必要', '入力待ち'],
    ['実装中', '履歴の確認が必要'],
  ])('does not display trusted chat results for projected %s / %s', async (phase, status) => {
    const task = { id: 1710, projectId: 77, name: '架空', phase, status };
    const history = fixture(task.id, 'succeeded', 'completed');
    expect(readAttempts(history, task.id).valid).toBe(true);
    vi.stubGlobal('fetch', vi.fn((path: string) => {
      const response = (value: unknown) => Promise.resolve({ ok: true, json: async () => structuredClone(value) } as Response);
      if (path === '/api/state') return response({ projects: [], tasks: [task] });
      if (path === '/api/workflow/capabilities') return response({ requirements: false, plan: false, execution: false, review: false });
      if (path === `/api/tasks/${task.id}`) return response({ task, messages: [{ id: 5, role: 'user', content: '架空の依頼' }], documents: [{ name: '指示書.md', content: '# 要望', version: 1 }] });
      if (path === `/api/tasks/${task.id}/workflow/events`) return response(history);
      throw new Error(`Unexpected: ${path}`);
    }));
    render(() => <Workspace taskId={task.id} projectId={77} onHome={() => {}} />);
    await screen.findByText('# 要望');
    await screen.findByText('実行の依頼'); // history loaded; suppression must not just be a loading artifact
    expect(screen.queryByLabelText('保存された実行・監修結果')).toBeNull();
    expect(screen.queryAllByText('架空の実行出力').filter(node => node.closest('[aria-live="polite"]'))).toHaveLength(0);
    expect(screen.queryAllByText('架空の監修フィードバック').filter(node => node.closest('[aria-live="polite"]'))).toHaveLength(0);
  });
});
