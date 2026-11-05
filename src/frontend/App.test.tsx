// @vitest-environment jsdom
import { FakeWebSocket } from './test-events';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App, { parseRoute } from './App';

const projects = [{ id:'019a0000-0000-7000-8000-000000000001', name: '架空プロジェクト', folder: '/tmp/a' }, { id:'019a0000-0000-7000-8000-000000000002', name: '空プロジェクト', folder: '/tmp/b' }, { id:'019a0000-0000-7000-8000-000000000003', name: '別プロジェクト', folder: '/tmp/c' }];
const tasks = [{id:'019a0000-0000-7100-8000-00000000000b', projectId:'019a0000-0000-7000-8000-000000000001', name: '一つ目', phase:'requirements',status:'idle'}, {id:'019a0000-0000-7100-8000-00000000000c', projectId:'019a0000-0000-7000-8000-000000000001', name: '二つ目',phase:'requirements',status:'idle'}, {id:'019a0000-0000-7100-8000-00000000000d', projectId:'019a0000-0000-7000-8000-000000000003', name: '他のタスク',phase:'requirements',status:'idle'}];
const json = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
beforeEach(() => {
  history.replaceState(null, '', '/');
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/state') return Promise.resolve(json({projects,tasks}));
    const task = tasks.find(item => url === `/api/tasks/${item.id}`);
    if (task) return Promise.resolve(json({task,messages:[],documents:[{name:'指示書.md',version:1,content:`# ${task.name}`}]}));
    throw new Error(`Unexpected URL ${url}`);
  }));
});
beforeEach(() => {
  // jsdom has no layout or ResizeObserver; chat scrolling is tested separately.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });
const pop = (url: string) => { history.replaceState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); };

it('updates URLs and restores task tabs through history without discarding a draft', async () => {
  render(() => <App />);
  fireEvent.click(await screen.findByText('一つ目'));
  await screen.findByRole('heading',{name:'一つ目',level:1});
  expect(location.pathname).toBe('/project/019a0000-0000-7000-8000-000000000001');
  expect(location.search).toBe('?task=019a0000-0000-7100-8000-00000000000b');
  fireEvent.input(screen.getByRole('textbox',{name:'希望や回答を入力'}), {target:{value:'下書き'}});
  fireEvent.click(screen.getByRole('button',{name:'タスクツリーを開閉'}));
  fireEvent.click(await screen.findByRole('button',{name:'二つ目'}));
  await screen.findByRole('heading',{name:'二つ目',level:1});
  expect(location.search).toBe('?task=019a0000-0000-7100-8000-00000000000c');
  expect(screen.getByRole('tab',{name:'一つ目'})).toBeTruthy();
  pop('/project/019a0000-0000-7000-8000-000000000001?task=019a0000-0000-7100-8000-00000000000b');
  await waitFor(() => expect((screen.getByRole('textbox',{name:'希望や回答を入力'}) as HTMLTextAreaElement).value).toBe('下書き'));
  expect(screen.getByRole('tab',{name:'二つ目'})).toBeTruthy();
  pop('/settings');
  expect(await screen.findByRole('heading',{name:'設定'})).toBeTruthy();
  pop('/project/019a0000-0000-7000-8000-000000000001?task=019a0000-0000-7100-8000-00000000000c');
  expect(await screen.findByRole('heading',{name:'二つ目',level:1})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'ホームへ戻る'}));
  expect(location.pathname).toBe('/');
});

it('validates direct projects and refuses missing or another project task', async () => {
  pop('/project/019a0000-0000-7000-8000-000000000001?task=019a0000-0000-7100-8000-00000000000d');
  render(() => <App />);
  expect((await screen.findByRole('alert')).textContent).toContain('このプロジェクトのタスクが見つかりません');
  expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/tasks/019a0000-0000-7100-8000-00000000000d')).toBe(false);
  pop('/project/019a0000-0000-7000-8000-000000000063');
  expect((await screen.findByRole('alert')).textContent).toContain('プロジェクトが見つかりません');
  pop('/project/019a0000-0000-7000-8000-000000000002');
  await screen.findByRole('button',{name:'タスクツリーを開閉'});
  expect(screen.getByText('空プロジェクト')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'希望や回答を入力'})).toBeTruthy();
  pop('/project/019a0000-0000-7000-8000-000000000001?task=bad');
  expect((await screen.findByRole('alert')).textContent).toContain('このプロジェクトのタスクが見つかりません');
});

it('does not recognize arbitrary or unsafe URL paths', () => {
  expect(parseRoute(new URL('http://localhost/project/0')).kind).toBe('not-found');
  expect(parseRoute(new URL('http://localhost/project/9007199254740992')).kind).toBe('not-found');
  expect(parseRoute(new URL('http://localhost/anything')).kind).toBe('not-found');
});

it('does not let a late project lookup change a newer page', async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/state') return pending;
    throw new Error(`Unexpected URL ${url}`);
  }));
  pop('/project/019a0000-0000-7000-8000-000000000001');
  render(() => <App />);
  expect(await screen.findByText('読み込み中...')).toBeTruthy();
  pop('/settings');
  expect(await screen.findByRole('heading', {name:'設定'})).toBeTruthy();
  release(json({projects,tasks}));
  await pending;
  await waitFor(() => expect(screen.getByRole('heading', {name:'設定'})).toBeTruthy());
  expect(screen.queryByText('架空プロジェクト')).toBeNull();
  expect(location.pathname).toBe('/settings');
});

it('never labels another project with the previous project name while loading or after failure', async () => {
  let calls = 0;
  let rejectSecond!: (error: Error) => void;
  const pending = new Promise<Response>((_, reject) => { rejectSecond = reject; });
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/state') {
      calls++;
      return calls <= 2 ? Promise.resolve(json({projects,tasks})) : pending;
    }
    const task = tasks.find(item => url === `/api/tasks/${item.id}`);
    if (task) return Promise.resolve(json({task,messages:[],documents:[]}));
    throw new Error(`Unexpected URL ${url}`);
  }));
  pop('/project/019a0000-0000-7000-8000-000000000001?task=019a0000-0000-7100-8000-00000000000b');
  render(() => <App />);
  await screen.findByText('架空プロジェクト', {selector:'strong'});
  await screen.findByRole('textbox', {name:'希望や回答を入力'});
  pop('/project/019a0000-0000-7000-8000-000000000002');
  expect(screen.queryByText('架空プロジェクト', {selector:'strong'})).toBeNull();
  expect(screen.getByText('プロジェクト', {selector:'strong'})).toBeTruthy();
  rejectSecond(new Error('offline'));
  expect((await screen.findByRole('alert')).textContent).toContain('プロジェクトを取得できませんでした');
  expect(screen.queryByText('架空プロジェクト', {selector:'strong'})).toBeNull();
});

it('opens a selected project even if it has no tasks', async () => {
  render(() => <App />);
  const select = await screen.findByRole('combobox',{name:'プロジェクト'});
  await screen.findByRole('option',{name:'空プロジェクト'});
  fireEvent.change(select, {target:{value:'019a0000-0000-7000-8000-000000000002'}});
  fireEvent.click(screen.getByRole('button',{name:'プロジェクトを開く'}));
  expect(location.pathname).toBe('/project/019a0000-0000-7000-8000-000000000002');
  expect(location.search).toBe('');
  expect(await screen.findByRole('button',{name:'タスクツリーを開閉'})).toBeTruthy();
  expect(screen.getByRole('tab', {name:'ジェネラル'})).toBeTruthy();
});

it('keeps a newly loaded same-project task when the workspace list is newer than the project snapshot', async () => {
  let stateCalls = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/state') {
      stateCalls++;
      return Promise.resolve(json({projects, tasks: stateCalls === 1 ? [tasks[0]] : [tasks[0], tasks[1]]}));
    }
    const task = tasks.find(item => url === `/api/tasks/${item.id}`);
    if (task) return Promise.resolve(json({task,messages:[],documents:[{name:'指示書.md',version:1,content:`# ${task.name}`}]}));
    throw new Error(`Unexpected URL ${url}`);
  }));
  pop('/project/019a0000-0000-7000-8000-000000000001?task=019a0000-0000-7100-8000-00000000000b');
  render(() => <App />);
  await screen.findByRole('heading',{name:'一つ目',level:1});
  fireEvent.click(screen.getByRole('button',{name:'タスクツリーを開閉'}));
  fireEvent.click(await screen.findByRole('button',{name:'二つ目'}));
  await screen.findByRole('heading',{name:'二つ目',level:1});
  expect(location.search).toBe('?task=019a0000-0000-7100-8000-00000000000c');
  expect(screen.getByRole('tab',{name:'一つ目'})).toBeTruthy();
  expect(screen.queryByText('このプロジェクトのタスクが見つかりません')).toBeNull();
});


it('validates project and task UUID kinds and rejects reserved bits and duplicate task queries', () => {
  const project=projects[0].id,task=tasks[0].id;
  expect(parseRoute(new URL(`http://localhost/project/${project}?task=${task}`))).toEqual({kind:'project',id:project,task,invalidTask:false});
  expect(parseRoute(new URL(`http://localhost/project/${task}`)).kind).toBe('not-found');
  expect(parseRoute(new URL(`http://localhost/project/${project.replace('-7000-','-7001-')}`)).kind).toBe('not-found');
  expect(parseRoute(new URL(`http://localhost/project/${project}?task=${project}`))).toMatchObject({kind:'project',invalidTask:true});
  expect(parseRoute(new URL(`http://localhost/project/${project}?task=${task}&task=${task}`))).toMatchObject({kind:'project',invalidTask:true});
});
