import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Workspace task and document tabs', () => {
  it('uses real same-project tasks and documents to close, switch and reopen tabs', async () => {
    const first = { id: 1, projectId: 4, name: '設計', phase: 'requirements', status: 'idle' };
    const second = { id: 2, projectId: 4, name: '画面', phase: 'requirements', status: 'idle' };
    const foreign = { id: 3, projectId: 5, name: '別プロジェクト', phase: 'requirements', status: 'idle' };
    const firstDocs = [{ name: '指示書.md', content: '# 設計', version: 1 }, { name: '仕様.md', content: '# 仕様', version: 1 }];
    const secondDocs = [{ name: '指示書.md', content: '# 画面', version: 1 }];
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [first, second, foreign] }));
      if (path === '/api/tasks/1' && !init) return Promise.resolve(json({ task: first, messages: [], documents: firstDocs }));
      if (path === '/api/tasks/2' && !init) return Promise.resolve(json({ task: second, messages: [], documents: secondDocs }));
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={1} onHome={() => {}} />);

    await screen.findByRole('tab', { name: '#1 設計' });
    expect(screen.getByText('# 設計')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    await screen.findByRole('button', { name: '#2 画面' });
    expect(screen.queryByRole('button', { name: '#3 別プロジェクト' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '#2 画面' }));
    await screen.findByText('# 画面');
    expect(screen.getByRole('tab', { name: '#1 設計' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '#2 画面' }).getAttribute('aria-selected')).toBe('true');

    // Closing the active task returns to the remaining open task.
    fireEvent.click(screen.getByRole('button', { name: '#2 画面 を閉じる' }));
    await screen.findByText('# 設計');
    expect(screen.queryByRole('tab', { name: '#2 画面' })).toBeNull();
    expect(screen.getByRole('tab', { name: '#1 設計' }).getAttribute('aria-selected')).toBe('true');

    // Documents can be reopened from their own tree without reopening task tabs.
    fireEvent.click(screen.getByRole('button', { name: '文書ツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '仕様.md' }));
    await screen.findByText('# 仕様');
    fireEvent.click(screen.getByRole('button', { name: '仕様.md を閉じる' }));
    expect(screen.queryByRole('tab', { name: '仕様.md' })).toBeNull();
    expect(screen.getByText('# 設計')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '仕様.md' }));
    expect(screen.getByText('# 仕様')).toBeTruthy();

    // Closing the last chat empties the pane; tree remains available to reopen.
    fireEvent.click(screen.getByRole('button', { name: '#1 設計 を閉じる' }));
    expect(screen.queryByRole('tab', { name: '#1 設計' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '希望や回答を入力' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '#1 設計' }));
    await screen.findByRole('tab', { name: '#1 設計' });
    expect(screen.getByRole('textbox', { name: '希望や回答を入力' })).toBeTruthy();
  });

  it('retains a draft and prevents duplicate sends after closing and reopening a sending task', async () => {
    const task = { id: 11, projectId: 8, name: '入力', phase: 'requirements', status: 'idle' };
    const post = deferred<Response>();
    const messages: { id: number; role: string; content: string }[] = [];
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/11' && !init) return Promise.resolve(json({ task, messages: [...messages], documents: [] }));
      if (path === '/api/tasks/11/messages' && init?.method === 'POST') { posts++; return post.promise; }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={11} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '最初の依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.input(textbox, { target: { value: '次の依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '#11 入力 を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '#11 入力' }));
    const reopened = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect((reopened as HTMLTextAreaElement).value).toBe('次の依頼');
    const sending = screen.getByRole('button', { name: '送信中...' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    fireEvent.submit(sending.closest('form')!);
    expect(posts).toBe(1);
    messages.push({ id: 1, role: 'user', content: '最初の依頼' });
    post.resolve(json({ id: 1 }));
    await screen.findByText('最初の依頼');
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次の依頼');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    expect(posts).toBe(1);
  });

  it('does not show or send a different task while a tab switch is still loading', async () => {
    const first = { id: 21, projectId: 12, name: '先のタスク', phase: 'requirements', status: 'idle' };
    const second = { id: 22, projectId: 12, name: '後のタスク', phase: 'requirements', status: 'idle' };
    const slow = deferred<Response>();
    let posts = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [first, second] }));
      if (path === '/api/tasks/21' && !init) return Promise.resolve(json({ task: first, messages: [], documents: [{ name: '先.md', content: '先の内容', version: 1 }] }));
      if (path === '/api/tasks/22' && !init) return slow.promise;
      if (path.endsWith('/messages') && init?.method === 'POST') { posts++; return Promise.resolve(json({})); }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={21} onHome={() => {}} />);
    await screen.findByText('先の内容');
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '#22 後のタスク' }));
    expect(screen.queryByRole('textbox', { name: '希望や回答を入力' })).toBeNull();
    expect(screen.queryByText('先の内容')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '#21 先のタスク' }));
    await screen.findByText('先の内容');
    slow.resolve(json({ task: second, messages: [], documents: [{ name: '後.md', content: '後の内容', version: 1 }] }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '#21 先のタスク' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('後の内容')).toBeNull();
    expect(posts).toBe(0);
  });

  it('shows the saved result once when sending finishes while the task tab is closed', async () => {
    const task = { id: 31, projectId: 14, name: '閉じた後', phase: 'requirements', status: 'idle' };
    const post = deferred<Response>();
    const messages: { id: number; role: string; content: string }[] = [];
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/31' && !init) return Promise.resolve(json({ task, messages: [...messages], documents: [] }));
      if (path === '/api/tasks/31/messages' && init?.method === 'POST') return post.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={31} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '保存する依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.input(textbox, { target: { value: '次の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '#31 閉じた後 を閉じる' }));
    messages.push({ id: 1, role: 'user', content: '保存する依頼' });
    post.resolve(json({ id: 1 }));
    await post.promise;
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '#31 閉じた後' }));
    await screen.findByText('保存する依頼', { exact: true });
    expect(screen.getAllByText('保存する依頼', { exact: true })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次の下書き');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('can recover the initial tab when it was closed before both state and task load finished', async () => {
    const task = { id: 41, projectId: 15, name: '初期', phase: 'requirements', status: 'idle' };
    const state = deferred<Response>();
    const firstGet = deferred<Response>();
    let taskGets = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return state.promise;
      if (path === '/api/tasks/41' && !init) {
        taskGets++;
        return taskGets === 1 ? firstGet.promise : Promise.resolve(json({ task, messages: [], documents: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={41} onHome={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '#41 を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    state.resolve(json({ projects: [], tasks: [task] }));
    fireEvent.click(await screen.findByRole('button', { name: '#41 初期' }));
    await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect(taskGets).toBe(2);
    firstGet.resolve(json({ task: { ...task, name: '古い応答' }, messages: [], documents: [] }));
    await firstGet.promise;
    expect(screen.getByRole('tab', { name: '#41 初期' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '#41 古い応答' })).toBeNull();
  });

  it('can reopen the initial task when the list fails and the first task request is still pending', async () => {
    const task = { id: 51, projectId: 16, name: '復元', phase: 'requirements', status: 'idle' };
    const firstGet = deferred<Response>();
    let taskGets = 0;
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.reject(new Error('offline'));
      if (path === '/api/tasks/51' && !init) {
        taskGets++;
        return taskGets === 1 ? firstGet.promise : Promise.resolve(json({ task, messages: [], documents: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={51} onHome={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '#51 を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    await screen.findByText('タスク一覧を取得できませんでした');
    fireEvent.click(screen.getByRole('button', { name: '#51' }));
    await screen.findByRole('tab', { name: '#51 復元' });
    expect(screen.getByRole('textbox', { name: '希望や回答を入力' })).toBeTruthy();
    expect(taskGets).toBe(2);
  });

  it('distinguishes document versions and opens the latest revision from the phase indicator', async () => {
    const task = { id: 61, projectId: 17, name: '版', phase: 'requirements', status: 'idle' };
    const documents = [{ name: '指示書.md', content: '第一版の内容', version: 1 }, { name: '指示書.md', content: '第二版の内容', version: 2 }];
    vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/61' && !init) return Promise.resolve(json({ task, messages: [], documents }));
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={61} onHome={() => {}} />);
    await screen.findByRole('tab', { name: '指示書.md · v2' });
    expect(screen.getByText('第二版の内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '指示書.md · v1' }));
    expect(screen.getByText('第一版の内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '指示書.md · v2 を閉じる' }));
    expect(screen.queryByRole('tab', { name: '指示書.md · v2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'タスク内容' }));
    expect(screen.getByText('第二版の内容')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '指示書.md · v2' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '文書ツリーを開閉' }));
    expect(screen.getByRole('button', { name: '指示書.md · v1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '指示書.md · v2' })).toBeTruthy();
  });
});
