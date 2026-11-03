import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Home creation across navigation', () => {
  it('keeps the pending lock, restores the selection, and shows the completed task without losing a newer draft', async () => {
    const projectA = { id: 1, name: 'プロジェクト A', folder: '/tmp/example-a' };
    const projectB = { id: 2, name: 'プロジェクト B', folder: '/tmp/example-b' };
    const state = { projects: [projectA, projectB], tasks: [] };
    const task = { id: 11, projectId: 1, name: '最初の作業', phase: 'requirements', status: 'idle' };
    const post = deferred<Response>();
    const remountState = deferred<Response>();
    let stateCalls = 0;
    let taskPosts = 0;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') {
        stateCalls++;
        return stateCalls === 2 ? remountState.promise : Promise.resolve(json(state));
      }
      if (path === '/api/tasks' && init?.method === 'POST') {
        taskPosts++;
        expect(JSON.parse(String(init.body))).toEqual({ projectId: 1, name: '最初の作業' });
        return post.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onOpenTask = vi.fn();

    const first = render(() => <Home query="" onOpenTask={onOpenTask} />);
    await screen.findByRole('option', { name: 'プロジェクト A' });
    fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: '1' } });
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: '最初の作業' } });
    fireEvent.click(screen.getByRole('button', { name: 'タスク作成' }));
    expect(taskPosts).toBe(1);

    // Settings/navigation unmounts Home while the POST is still in flight.
    first.unmount();
    const second = render(() => <Home query="" onOpenTask={onOpenTask} />);
    remountState.resolve(json(state));
    await screen.findByRole('option', { name: 'プロジェクト A' });
    const select = screen.getByRole('combobox', { name: 'プロジェクト' }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('1'));
    expect((screen.getByRole('textbox', { name: 'タスク名' }) as HTMLInputElement).value).toBe('最初の作業');
    const create = screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(create);
    // Even programmatic submission cannot bypass the in-flight guard.
    fireEvent.submit(create.closest('form')!);
    expect(taskPosts).toBe(1);

    // Edits made after the original submission must not be overwritten by it.
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: '次の作業' } });
    fireEvent.change(select, { target: { value: '2' } });
    second.unmount();
    render(() => <Home query="" onOpenTask={onOpenTask} />);
    await screen.findByRole('option', { name: 'プロジェクト B' });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'プロジェクト' }) as HTMLSelectElement).value).toBe('2'));
    expect((screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement).disabled).toBe(true);

    post.resolve(json(task));
    await screen.findByRole('cell', { name: '最初の作業' });
    expect((screen.getByRole('textbox', { name: 'タスク名' }) as HTMLInputElement).value).toBe('次の作業');
    expect((screen.getByRole('combobox', { name: 'プロジェクト' }) as HTMLSelectElement).value).toBe('2');
    expect((screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement).disabled).toBe(false);
    expect(taskPosts).toBe(1);
    expect(onOpenTask).not.toHaveBeenCalled();
  });
});

describe('project selection and cancellation', () => {
  it('returns the select to its placeholder when new project creation is cancelled, including repeated cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/state') return json({ projects: [{ id: 1, name: 'プロジェクト A', folder: '/tmp/example' }], tasks: [] });
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Home query="" onOpenTask={vi.fn()} />);
    await screen.findByRole('option', { name: 'プロジェクト A' });
    const select = screen.getByRole('combobox', { name: 'プロジェクト' }) as HTMLSelectElement;
    fireEvent.input(screen.getByRole('textbox', { name: 'タスク名' }), { target: { value: '作業' } });
    fireEvent.change(select, { target: { value: '1' } });
    expect((screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement).disabled).toBe(false);

    for (let i = 0; i < 2; i++) {
      fireEvent.change(select, { target: { value: 'new' } });
      expect(screen.getByRole('dialog', { name: 'プロジェクトを作成' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
      expect(select.value).toBe('');
      expect((screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(select, { target: { value: '1' } });
    expect(select.value).toBe('1');
    expect((screen.getByRole('button', { name: 'タスク作成' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('uses a folder selected via the browser panel when creating the project', async () => {
    const request = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [] }));
      if (path === '/api/folders/list') {
        const body = JSON.parse(String(init?.body));
        if (!body.path) return Promise.resolve(json({ path: '/tmp/demo', parent: '/tmp', directories: [{ name: 'Project', path: '/tmp/demo/Project' }], truncated: false }));
        if (body.path === '/tmp/demo/Project') return Promise.resolve(json({ path: body.path, parent: '/tmp/demo', directories: [], truncated: false }));
      }
      if (path === '/api/projects') {
        expect(JSON.parse(String(init?.body))).toEqual({ name: '新しいプロジェクト', folder: '/tmp/demo/Project' });
        return Promise.resolve(json({ id: 10, name: '新しいプロジェクト', folder: '/tmp/demo/Project' }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', request);
    render(() => <Home query="" onOpenTask={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'プロジェクト' }), { target: { value: 'new' } });
    fireEvent.input(screen.getByRole('textbox', { name: 'プロジェクト名' }), { target: { value: '新しいプロジェクト' } });
    fireEvent.click(screen.getByRole('button', { name: '参照' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Project' }));
    await screen.findByText('/tmp/demo/Project');
    fireEvent.click(screen.getByRole('button', { name: 'このフォルダを選択' }));
    expect((screen.getByRole('textbox', { name: 'フォルダ' }) as HTMLInputElement).value).toBe('/tmp/demo/Project');
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await screen.findByRole('option', { name: '新しいプロジェクト' });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'プロジェクト' }) as HTMLSelectElement).value).toBe('10'));
    expect(request.mock.calls.filter(([path]) => path === '/api/projects')).toHaveLength(1);
  });
});
