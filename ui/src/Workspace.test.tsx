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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Workspace message submission across navigation', () => {
  it('retains the newer draft and the sending lock across remount, then displays the saved message once', async () => {
    const taskId = 73;
    const task = { id: taskId, projectId: 1, name: 'サンプル', phase: 'requirements', status: 'idle' };
    const documents = [{ name: '指示書.md', content: '# サンプル\n', version: 1 }];
    const messages: { id: number; role: string; content: string }[] = [];
    const post = deferred<Response>();
    const remountGet = deferred<Response>();
    let getCount = 0;
    let postCount = 0;
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === `/api/tasks/${taskId}` && !init) {
        getCount++;
        if (getCount === 2) return remountGet.promise;
        return Promise.resolve(json({ task, messages: [...messages], documents }));
      }
      if (path === `/api/tasks/${taskId}/messages` && init?.method === 'POST') {
        postCount++;
        expect(JSON.parse(String(init.body))).toEqual({ content: '最初の希望' });
        return post.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onHome = vi.fn();

    const first = render(() => <Workspace taskId={taskId} onHome={onHome} />);
    const message = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(message, { target: { value: '最初の希望' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(postCount).toBe(1);
    expect((screen.getByRole('button', { name: '送信中...' }) as HTMLButtonElement).disabled).toBe(true);

    // The user continues typing while the submitted message is still in flight.
    fireEvent.input(message, { target: { value: '次に伝えること' } });
    first.unmount();
    render(() => <Workspace taskId={taskId} onHome={onHome} />);
    remountGet.resolve(json({ task, messages: [], documents }));
    const reopened = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect((reopened as HTMLTextAreaElement).value).toBe('次に伝えること');
    const sending = screen.getByRole('button', { name: '送信中...' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    fireEvent.click(sending);
    // A direct form submit also cannot bypass the per-task in-flight lock.
    fireEvent.submit(sending.closest('form')!);
    expect(postCount).toBe(1);

    messages.push({ id: 1, role: 'user', content: '最初の希望' });
    post.resolve(json({ id: 1 }));
    await screen.findByText('最初の希望', { exact: true });
    expect(screen.getAllByText('最初の希望', { exact: true })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次に伝えること');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    expect(postCount).toBe(1);
    expect(getCount).toBeGreaterThanOrEqual(3);
    expect(onHome).not.toHaveBeenCalled();
  });
});
