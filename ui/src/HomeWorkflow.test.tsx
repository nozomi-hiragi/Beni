import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import Home from './Home';
import { clearBlock, isBlocked, perform, scheduleRequirements, stateFor } from './workflowController';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}
const history = { workflow: [], requirements: [], plan: [], review: [] };
const project = { id: 701, name: '架空のプロジェクト', folder: '/tmp/example' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('schedules the new task once after Home has unmounted, without navigating from the old view', async () => {
  const post = deferred<Response>();
  const task = { id: 7101, projectId: project.id, name: '架空のタスク', phase: 'requirements', status: 'idle' };
  const requests = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [project], tasks: [] }));
    if (path === '/api/tasks' && init?.method === 'POST') return post.promise;
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: true, plan: false, execution: false, review: false }));
    if (path === '/api/tasks/7101/workflow/events') return Promise.resolve(json(history));
    if (path === '/api/tasks/7101') return Promise.resolve(json({ task, messages: [], documents: [] }));
    if (path === '/api/tasks/7101/workflow/requirements' && init?.method === 'POST') {
      expect(JSON.parse(String(init.body)).requestKey).toEqual(expect.any(String));
      return Promise.resolve(json({ status: 'adopted', version: 2, outcomeUnknown: false }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', requests);
  const open = vi.fn();
  const view = render(() => <Home query="" onOpenTask={open} />);
  await screen.findByRole('option', { name: project.name });
  fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: String(project.id) } });
  fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: task.name } });
  fireEvent.click(screen.getByRole('button', { name: 'タスク作成' }));
  view.unmount();
  post.resolve(json(task));
  await waitFor(() => expect(requests.mock.calls.filter(([path]) => path === '/api/tasks/7101/workflow/requirements')).toHaveLength(1));
  await waitFor(() => expect(stateFor(task.id).busy).toBe(''));
  scheduleRequirements(task.id, true);
  await Promise.resolve();
  expect(requests.mock.calls.filter(([path]) => path === '/api/tasks/7101/workflow/requirements')).toHaveLength(1);
  expect(open).not.toHaveBeenCalled();
});

it('does not request initial generation if the requirements adapter is unavailable', async () => {
  const post = deferred<Response>();
  const task = { id: 7102, projectId: project.id, name: '未接続のタスク', phase: 'requirements', status: 'idle' };
  const requests = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [project], tasks: [] }));
    if (path === '/api/tasks' && init?.method === 'POST') return post.promise;
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: false, plan: false, execution: false, review: false }));
    if (path === '/api/tasks/7102/workflow/events') return Promise.resolve(json(history));
    if (path === '/api/tasks/7102') return Promise.resolve(json({ task, messages: [], documents: [] }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', requests);
  const open = vi.fn();
  const view = render(() => <Home query="" onOpenTask={open} />);
  await screen.findByRole('option', { name: project.name });
  fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: String(project.id) } });
  fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: task.name } });
  fireEvent.click(screen.getByRole('button', { name: 'タスク作成' }));
  view.unmount();
  post.resolve(json(task));
  await waitFor(() => expect(stateFor(task.id).notice).toBe('指示書生成は未接続です。'));
  expect(requests.mock.calls.filter(([path]) => path.includes('/workflow/requirements'))).toHaveLength(0);
  expect(open).not.toHaveBeenCalled();
});

it('fails closed instead of invoking a malformed truthy capability value', async () => {
  const post = deferred<Response>();
  const task = { id: 7103, projectId: project.id, name: '不正な接続情報', phase: 'requirements', status: 'idle' };
  const requests = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [project], tasks: [] }));
    if (path === '/api/tasks' && init?.method === 'POST') return post.promise;
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: 'false', plan: false, execution: false, review: false }));
    if (path === '/api/tasks/7103/workflow/events') return Promise.resolve(json(history));
    if (path === '/api/tasks/7103') return Promise.resolve(json({ task, messages: [], documents: [] }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', requests);
  const view = render(() => <Home query="" onOpenTask={vi.fn()} />);
  await screen.findByRole('option', { name: project.name });
  fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: String(project.id) } });
  fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: task.name } });
  fireEvent.click(screen.getByRole('button', { name: 'タスク作成' }));
  view.unmount();
  post.resolve(json(task));
  await waitFor(() => expect(stateFor(task.id).notice).toBe('接続状態を確認できません。'));
  expect(requests.mock.calls.filter(([path]) => path.includes('/workflow/requirements'))).toHaveLength(0);
});

it.each([
  [7105, { phase: '確認が必要', status: '入力待ち' }],
  [7106, { phase: 'requirements', status: '履歴の確認が必要' }],
  [7107, { phase: '', status: '入力待ち' }],
  [7108, { phase: 'requirements', status: '' }],
  [7109, { phase: 'requirements', status: '入力待ち', id: 9999 }],
  [7110, { phase: undefined, status: '入力待ち' }],
  [7111, { phase: 'requirements', status: undefined }],
])('does not start generation if task %i has a damaged or mismatched projection', async (id, projection) => {
  const post = deferred<Response>();
  const task = { id, projectId: project.id, name: `破損確認 ${id}`, phase: 'requirements', status: 'idle' };
  const requests = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [project], tasks: [] }));
    if (path === '/api/tasks' && init?.method === 'POST') return post.promise;
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: true, plan: true, execution: true, review: true }));
    if (path === `/api/tasks/${id}/workflow/events`) return Promise.resolve(json(history));
    if (path === `/api/tasks/${id}`) return Promise.resolve(json({ task: { ...task, ...projection }, messages: [], documents: [] }));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', requests);
  const view = render(() => <Home query="" onOpenTask={vi.fn()} />);
  await screen.findByRole('option', { name: project.name });
  fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: String(project.id) } });
  fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: task.name } });
  fireEvent.click(screen.getByRole('button', { name: 'タスク作成' }));
  view.unmount();
  post.resolve(json(task));
  await waitFor(() => expect(stateFor(id).notice).toBe('履歴を確認できないため指示書生成を開始できません。'));
  expect(requests.mock.calls.filter(([path]) => path.includes('/workflow/requirements'))).toHaveLength(0);
});

it('discards queued work after a failed operation is explicitly cleared and never automatically retries', async () => {
  const id = 7104;
  let reject!: (reason: Error) => void;
  const wait = new Promise<void>((_, fail) => { reject = fail; });
  const requests = vi.fn(() => { throw new Error('No request should be sent'); });
  vi.stubGlobal('fetch', requests);
  const running = perform(id, '実行中', () => wait);
  expect(stateFor(id).busy).toBe('実行中');
  scheduleRequirements(id);
  expect(stateFor(id).queued).toBe(true);
  reject(new Error('connection lost'));
  await running;
  expect(isBlocked(id)).toBe(true);
  expect(stateFor(id).queued).toBe(true);
  expect(clearBlock(id)).toBe(true);
  expect(stateFor(id).queued).toBe(false);
  expect(isBlocked(id)).toBe(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(requests).not.toHaveBeenCalled();
});
