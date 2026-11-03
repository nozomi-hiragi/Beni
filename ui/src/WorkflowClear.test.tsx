import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import Workspace from './Workspace';
import { clearBlock, isBlocked, perform, stateFor } from './workflowController';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown): Response { return { ok: true, json: async () => value } as Response; }

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('does not clear the local confirmation marker during a live POST even if history is still empty', async () => {
  const id = 7201;
  const task = { id, projectId: 702, name: '架空のタスク', phase: 'requirements', status: 'idle' };
  const pending = deferred<Response>();
  const history = { workflow: [], requirements: [], plan: [], review: [] };
  let historyCalls = 0;
  let generationCalls = 0;
  const fetchMock = vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [task] }));
    if (path === `/api/tasks/${id}`) return Promise.resolve(json({ task, messages: [], documents: [{ name: '指示書.md', content: '# 指示書', version: 1 }] }));
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: true, plan: true, execution: false, review: false }));
    if (path === `/api/tasks/${id}/workflow/events`) { historyCalls++; return Promise.resolve(json(history)); }
    if (path === `/api/tasks/${id}/workflow/requirements` && init?.method === 'POST') { generationCalls++; return pending.promise; }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(() => <Workspace taskId={id} projectId={702} onHome={vi.fn()} />);
  const update = await screen.findByRole('button', { name: '指示書を更新' });
  await waitFor(() => expect((update as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(update);
  await waitFor(() => expect(generationCalls).toBe(1));
  expect(stateFor(id).busy).toBeTruthy();
  expect(isBlocked(id)).toBe(true);
  expect(clearBlock(id)).toBe(false);
  expect(isBlocked(id)).toBe(true);
  expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).toContain(id);

  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '履歴確認を完了し、画面の確認待ちを解除' }));
  await waitFor(() => expect(historyCalls).toBeGreaterThanOrEqual(5));
  expect(isBlocked(id)).toBe(true);
  expect(stateFor(id).busy).toBeTruthy();
  expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).toContain(id);
  expect(generationCalls).toBe(1);

  pending.resolve(json({ status: 'stale', outcomeUnknown: false }));
  await waitFor(() => expect(stateFor(id).busy).toBe(''));
  expect(generationCalls).toBe(1);
});

it('allows an explicit confirmation after a request has ended and empty history has been rechecked', async () => {
  const id = 7202;
  const task = { id, projectId: 702, name: '架空の再確認', phase: 'requirements', status: 'idle' };
  const history = { workflow: [], requirements: [], plan: [], review: [] };
  const fetchMock = vi.fn((path: string) => {
    if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [task] }));
    if (path === `/api/tasks/${id}`) return Promise.resolve(json({ task, messages: [], documents: [{ name: '指示書.md', content: '# 指示書', version: 1 }] }));
    if (path === '/api/workflow/capabilities') return Promise.resolve(json({ requirements: true, plan: true, execution: false, review: false }));
    if (path === `/api/tasks/${id}/workflow/events`) return Promise.resolve(json(history));
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  await perform(id, '実行中', async () => { throw new Error('connection lost'); });
  expect(isBlocked(id)).toBe(true);
  expect(stateFor(id).busy).toBe('');
  render(() => <Workspace taskId={id} projectId={702} onHome={vi.fn()} />);
  await screen.findByRole('button', { name: '履歴確認を完了し、画面の確認待ちを解除' });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '履歴確認を完了し、画面の確認待ちを解除' }));
  await waitFor(() => expect(isBlocked(id)).toBe(false));
  expect(JSON.parse(sessionStorage.getItem('beni-workflow-unconfirmed') || '[]')).not.toContain(id);
});
