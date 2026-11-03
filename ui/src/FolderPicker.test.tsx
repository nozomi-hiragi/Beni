import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import FolderPicker from './FolderPicker';

const ok = (value: unknown) => ({ ok: true, json: async () => value } as Response);
const fail = (error: string) => ({ ok: false, json: async () => ({ error }) } as Response);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('navigates into a folder, returns to its parent, and selects the displayed absolute path', async () => {
  const request = vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!body.path) return Promise.resolve(ok({ path: '/home/demo', parent: '/home', directories: [{name:'Projects',path:'/home/demo/Projects'}], truncated:true }));
    if (body.path === '/home/demo/Projects') return Promise.resolve(ok({ path: body.path, parent: '/home/demo', directories: [], truncated:false }));
    if (body.path === '/home/demo') return Promise.resolve(ok({ path: body.path, parent: '/home', directories: [{name:'Projects',path:'/home/demo/Projects'}], truncated:false }));
    throw new Error('unexpected path');
  });
  vi.stubGlobal('fetch', request);
  const onSelect = vi.fn();
  render(() => <FolderPicker onSelect={onSelect} onCancel={() => {}} />);
  await screen.findByRole('button', { name: 'Projects' });
  expect(screen.getByText(/表示件数の上限/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
  await screen.findByText('/home/demo/Projects');
  fireEvent.click(screen.getByRole('button', { name: '親フォルダへ' }));
  await screen.findByRole('button', { name: 'Projects' });
  fireEvent.click(screen.getByRole('button', { name: 'このフォルダを選択' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('/home/demo');
  expect(request).toHaveBeenCalledTimes(3);
  expect(JSON.parse(String(request.mock.calls[1][1].body))).toEqual({path:'/home/demo/Projects'});
});

it('does not select the prior folder on a failed navigation and retries the intended path', async () => {
  let count = 0;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!body.path) return Promise.resolve(ok({path:'/root/example',parent:'/root',directories:[{name:'locked',path:'/root/example/locked'}],truncated:false}));
    count++;
    return Promise.resolve(count === 1 ? fail('フォルダを開けません') : ok({path:body.path,parent:'/root/example',directories:[],truncated:false}));
  }));
  const onSelect = vi.fn();
  render(() => <FolderPicker onSelect={onSelect} onCancel={() => {}} />);
  fireEvent.click(await screen.findByRole('button', {name:'locked'}));
  expect((await screen.findByRole('alert')).textContent).toContain('フォルダを開けません');
  expect(screen.queryByRole('button', {name:'このフォルダを選択'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'再試行'}));
  await screen.findByText('/root/example/locked');
  fireEvent.click(screen.getByRole('button', {name:'このフォルダを選択'}));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('/root/example/locked');
});

it('suppresses repeated navigation while pending and ignores completion after unmount', async () => {
  const pending = deferred<Response>();
  const request = vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (!body.path) return Promise.resolve(ok({path:'/tmp/demo',parent:'/tmp',directories:[{name:'next',path:'/tmp/demo/next'}],truncated:false}));
    return pending.promise;
  });
  vi.stubGlobal('fetch', request);
  const cancel = vi.fn();
  const select = vi.fn();
  const view = render(() => <FolderPicker onSelect={select} onCancel={cancel} />);
  const next = await screen.findByRole('button', {name:'next'});
  fireEvent.click(next);
  fireEvent.click(next);
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', {name:'閉じる'}));
  expect(cancel).toHaveBeenCalledTimes(1);
  view.unmount();
  pending.resolve(ok({path:'/tmp/demo/next',parent:'/tmp/demo',directories:[],truncated:false}));
  await waitFor(() => expect(screen.queryByText('/tmp/demo/next')).toBeNull());
  expect(select).not.toHaveBeenCalled();
});
