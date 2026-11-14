import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from './ProjectPage';
import { FakeWebSocket, stubLegacyAgentFetch } from '../test/test-events';
import { resetModelCache } from '../shared/model-cache';
import type { Task } from '../shared/types';

// チャットと端末の通信を除き、実際のタスクツリーと文書表示を確認する。
vi.mock('../shared/components/ChatPanel', () => ({ default: () => null }));
vi.mock('./components/TerminalPanel', () => ({ default: () => null }));

const project = { id: '019a0000-0000-7000-8000-000000000001', name: 'サンプル', folder: '/tmp/example' };
const created: Task = { id: '019a0000-0000-7100-8000-000000000001', projectId: project.id, name: '新しい作業', phase: 'requirements', status: 'idle' };
function json(value: unknown): Response { return { ok: true, json: async () => value } as Response; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(
  tasks: Task[] = [],
  post: () => Promise<Response> = async () => json(created),
  workspaceState?: Promise<Response>,
) {
  let stateRequests = 0;
  const request = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') {
      // ProjectPage が先にプロジェクトを読み込み、Workspace が続けて一覧を取得する。
      if (++stateRequests === 2 && workspaceState) return workspaceState;
      return Promise.resolve(json({ projects: [project], tasks }));
    }
    if (path === '/api/tasks' && init?.method === 'POST') return post();
    if (path === `/api/tasks/${created.id}`) return Promise.resolve(json({ task: created, documents: [{ name: 'requirements.md', content: '# 追加したタスクの要件', version: 1 }] }));
    const task = tasks.find(item => path === `/api/tasks/${item.id}`);
    if (task) return Promise.resolve(json({ task, documents: [{ name: 'requirements.md', content: '# 既存タスクの要件', version: 1 }] }));
    throw new Error(`Unexpected request: ${path}`);
  });
  stubLegacyAgentFetch(request);
  const onTaskChange = vi.fn();
  const view = render(() => {
    const [task, setTask] = createSignal<string>();
    return <ProjectPage id={project.id} task={task()} invalidTask={false} onTaskChange={id => { onTaskChange(id); setTask(id); }} onHome={() => {}} onTitle={() => {}} />;
  });
  return { ...view, request, onTaskChange, posts: () => request.mock.calls.filter(([path, init]) => path === '/api/tasks' && init?.method === 'POST') };
}
async function openTaskTree() {
  const toggle = await screen.findByRole('button', { name: 'タスクツリーを開閉' });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
  return within(screen.getByRole('complementary', { name: 'タスク' }));
}
async function openDialog() {
  const tree = await openTaskTree();
  fireEvent.click(tree.getByRole('button', { name: '＋ タスクを追加' }));
  return screen.getByRole<HTMLDialogElement>('dialog', { name: 'タスクを追加' });
}
beforeEach(() => {
  resetModelCache();
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('プロジェクト内のタスク追加', () => {
  it.each([{ tasks: [] }, { tasks: [{ ...created, id: '019a0000-0000-7100-8000-000000000002', name: '既存の作業' }] }])('タスクが0件でも存在しても名前だけで作成して要件文書を開く (%j)', async ({ tasks }) => {
    const { posts, onTaskChange } = setup(tasks);
    await openDialog();
    expect(screen.queryByRole('combobox', { name: 'プロジェクト' })).toBeNull();
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await screen.findByText('追加したタスクの要件');
    expect(onTaskChange).toHaveBeenCalledWith(created.id);
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String(posts()[0]![1]!.body))).toEqual({ projectId: project.id, name: created.name });
    expect(screen.getByRole('button', { name: '要件定義' }).getAttribute('aria-current')).toBe('step');
    expect(screen.queryByText('このプロジェクトのタスクが見つかりません')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'タスクを追加' })).toBeNull();
    expect(screen.getByRole('tab', { name: created.name }).getAttribute('aria-selected')).toBe('true');
  });

  it('作成前のタスク一覧が遅れて届いても、別のタスクを開いた後に新しいタスクをツリーから選び直せる', async () => {
    const existing = { ...created, id: '019a0000-0000-7100-8000-000000000002', name: '既存の作業' };
    const workspaceState = deferred<Response>();
    setup([existing], undefined, workspaceState.promise);
    await openDialog();
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await screen.findByText('追加したタスクの要件');

    const tree = await openTaskTree();
    expect(tree.queryByRole('button', { name: existing.name })).toBeNull();
    workspaceState.resolve(json({ projects: [project], tasks: [existing] }));
    fireEvent.click(await tree.findByRole('button', { name: existing.name }));
    await screen.findByText('既存タスクの要件');

    const reopenedTree = await openTaskTree();
    fireEvent.click(reopenedTree.getByRole('button', { name: created.name }));
    await screen.findByText('追加したタスクの要件');
    expect(screen.getByRole('tab', { name: created.name }).getAttribute('aria-selected')).toBe('true');
  });

  it('空の名前と空白だけの名前では送信せず、キャンセルやEscapeでも作成しない', async () => {
    const { posts } = setup();
    let dialog = await openDialog();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'タスク名' });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '作成' });
    for (const value of ['', '   ']) {
      fireEvent.input(input, { target: { value } });
      expect(submit.disabled).toBe(true);
      fireEvent.submit(submit.closest('form')!);
    }
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'タスクツリーを開閉' }).getAttribute('aria-expanded')).toBe('true');
    dialog = await openDialog();
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: created.name } });
    const escape = new Event('cancel', { bubbles: false, cancelable: true });
    fireEvent(dialog, escape);
    expect(escape.defaultPrevented).toBe(false);
    // happy-dom は Escape による cancel の既定動作を実装していない。
    if (!escape.defaultPrevented) dialog.close();
    expect(screen.queryByRole('dialog')).toBeNull();
    dialog = await openDialog();
    dialog.close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('送信中は二重送信とキャンセルを防ぎ、失敗後は名前を保持して再試行できる', async () => {
    const pending = deferred<Response>();
    let attempts = 0;
    const { posts } = setup([], () => ++attempts === 1 ? pending.promise : Promise.resolve(json(created)));
    const dialog = await openDialog();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'タスク名' });
    fireEvent.input(input, { target: { value: created.name } });
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: '作成' });
    fireEvent.click(submit);
    expect(input.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'キャンセル' }).disabled).toBe(true);
    fireEvent.click(submit);
    fireEvent.submit(submit.closest('form')!);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(posts()).toHaveLength(1);
    pending.resolve({ ok: false, status: 500, json: async () => ({ error: 'タスクを作成できませんでした' }) } as Response);
    expect((await screen.findByRole('alert')).textContent).toContain('タスクを作成できませんでした');
    expect(input.value).toBe(created.name);
    expect(input.disabled).toBe(false);
    fireEvent.click(submit);
    await screen.findByText('追加したタスクの要件');
    expect(posts()).toHaveLength(2);
  });

  it('画面を離れた後に作成が完了してもタスクへ遷移しない', async () => {
    const pending = deferred<Response>();
    const { unmount, onTaskChange } = setup([], () => pending.promise);
    await openDialog();
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    unmount();
    pending.resolve(json(created));
    await pending.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(onTaskChange).not.toHaveBeenCalled();
  });
});
