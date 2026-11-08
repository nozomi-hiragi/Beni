import { stubLegacyAgentFetch } from './test-events';
import { resetModelCache } from '../shared/model-cache';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Workspace from '../project/components/Workspace';
import {FakeWebSocket, packResponse} from './test-events';

// Terminal behavior is covered separately; these tests isolate task/document navigation.
vi.mock('../project/components/TerminalPanel', () => ({default: () => null}));

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function json(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

beforeEach(() => { resetModelCache(); localStorage.clear();
  // jsdom has no layout or ResizeObserver; chat scrolling is tested separately.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Workspace task and document tabs', () => {
  it('dismisses each tree after selection or an outside click without interfering with the toggles', async () => {
    const first = { id:'019a0000-0000-7100-8000-000000000065', projectId:'019a0000-0000-7000-8000-000000000018', name: '設計', phase: 'requirements', status: 'idle' };
    const second = { id:'019a0000-0000-7100-8000-000000000066', projectId:'019a0000-0000-7000-8000-000000000018', name: '画面', phase: 'requirements', status: 'idle' };
    const documents = [{ name: '指示書.md', content: '# 設計', version: 1 }, { name: '仕様.md', content: '# 仕様', version: 1 }];
    stubLegacyAgentFetch(vi.fn((path: string) => {
      if (path === '/api/state') return Promise.resolve(json({ projects: [], tasks: [first, second] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000065') return Promise.resolve(json({ task: first, messages: [], documents }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000066') return Promise.resolve(json({ task: second, messages: [], documents }));
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000065'} onHome={() => {}} />);
    await screen.findByRole('tab', { name: '設計' });
    const taskToggle = () => screen.getByRole('button', { name: 'タスクツリーを開閉' });
    const documentToggle = () => screen.getByRole('button', { name: '文書ツリーを開閉' });

    fireEvent.click(taskToggle());
    expect(taskToggle().getAttribute('aria-expanded')).toBe('true');
    const taskTree = screen.getByRole('complementary', { name: 'タスク' });
    fireEvent.click(taskTree);
    // Future nested tree items still count as inside when opening a folder.
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'フォルダ';
    details.append(summary);
    taskTree.append(details);
    fireEvent.click(summary);
    expect(taskToggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(document.body);
    expect(taskToggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(taskToggle());
    fireEvent.click(taskToggle());
    expect(taskToggle().getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(taskToggle());
    fireEvent.click(documentToggle());
    expect(taskToggle().getAttribute('aria-expanded')).toBe('false');
    expect(documentToggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '仕様.md' }));
    expect(documentToggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading',{name:'仕様',level:1})).toBeTruthy();

    fireEvent.click(taskToggle());
    fireEvent.click(await screen.findByRole('button', { name: '画面' }));
    await screen.findByRole('tab', { name: '画面' });
    expect(taskToggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('tab', { name: '画面' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(documentToggle());
    fireEvent.click(document.body);
    expect(documentToggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('removes the outside-click listener when the workspace is unmounted', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    stubLegacyAgentFetch(vi.fn(() => new Promise<Response>(() => {})));
    try {
      const view = render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000067'} onHome={() => {}} />);
      const registered = add.mock.calls.find(([type, , capture]) => type === 'click' && capture === true);
      expect(registered).toBeTruthy();
      view.unmount();
      expect(remove).toHaveBeenCalledWith('click', registered![1], true);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  it('uses real same-project tasks and documents to close, switch and reopen tabs', async () => {
    const first = { id:'019a0000-0000-7100-8000-000000000001', projectId:'019a0000-0000-7000-8000-000000000004', name: '設計', phase: 'requirements', status: 'idle' };
    const second = { id:'019a0000-0000-7100-8000-000000000002', projectId:'019a0000-0000-7000-8000-000000000004', name: '画面', phase: 'requirements', status: 'idle' };
    const foreign = { id:'019a0000-0000-7100-8000-000000000003', projectId:'019a0000-0000-7000-8000-000000000005', name: '別プロジェクト', phase: 'requirements', status: 'idle' };
    const firstDocs = [{ name: '指示書.md', content: '# 設計', version: 1 }, { name: '仕様.md', content: '# 仕様', version: 1 }];
    const secondDocs = [{ name: '指示書.md', content: '# 画面', version: 1 }];
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [first, second, foreign] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000001' && !init) return Promise.resolve(json({ task: first, messages: [], documents: firstDocs }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000002' && !init) return Promise.resolve(json({ task: second, messages: [], documents: secondDocs }));
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000001'} onHome={() => {}} />);

    await screen.findByRole('tab', { name: '設計' });
    expect(screen.getByRole('heading',{name:'設計',level:1})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    await screen.findByRole('button', { name: '画面' });
    expect(screen.queryByRole('button', { name: '別プロジェクト' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '画面' }));
    await screen.findByRole('heading',{name:'画面',level:1});
    expect(screen.getByRole('tab', { name: '設計' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '画面' }).getAttribute('aria-selected')).toBe('true');

    // Closing the active task returns to the remaining open task.
    fireEvent.click(screen.getByRole('button', { name: '画面 を閉じる' }));
    await screen.findByRole('heading',{name:'設計',level:1});
    expect(screen.queryByRole('tab', { name: '画面' })).toBeNull();
    expect(screen.getByRole('tab', { name: '設計' }).getAttribute('aria-selected')).toBe('true');

    // Documents can be reopened from their own tree without reopening task tabs.
    fireEvent.click(screen.getByRole('button', { name: '文書ツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '仕様.md' }));
    await screen.findByRole('heading',{name:'仕様',level:1});
    fireEvent.click(screen.getByRole('button', { name: '仕様.md を閉じる' }));
    expect(screen.queryByRole('tab', { name: '仕様.md' })).toBeNull();
    expect(screen.getByRole('heading',{name:'設計',level:1})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '文書ツリーを開閉' }));
    fireEvent.click(screen.getByRole('button', { name: '仕様.md' }));
    expect(screen.getByRole('heading',{name:'仕様',level:1})).toBeTruthy();

    // Closing the last chat empties the pane; tree remains available to reopen.
    fireEvent.click(screen.getByRole('button', { name: '設計 を閉じる' }));
    expect(screen.queryByRole('tab', { name: '設計' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(screen.getByRole('button', { name: '設計' }));
    await screen.findByRole('tab', { name: '設計' });
    expect(screen.getByRole('textbox', { name: '希望や回答を入力' })).toBeTruthy();
  });

  it('retains a draft and prevents duplicate sends after closing and reopening a sending task', async () => {
    FakeWebSocket.instances=[];vi.stubGlobal('WebSocket',FakeWebSocket);
    const task = { id:'019a0000-0000-7100-8000-00000000000b', projectId:'019a0000-0000-7000-8000-000000000008', name: '入力', phase: 'requirements', status: 'idle' };
    const post = deferred<Response>();
    const messages: { id: number; role: string; content: string }[] = [];
    let posts = 0;
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-00000000000b' && !init) return Promise.resolve(json({ task, messages: [], documents: [] }));
      if (path === '/api/chat/model') return Promise.resolve(json({id:'c',messages:[...messages],selectedModel:{id:JSON.parse(String(init?.body)).model,name:'Test'}}));
      if (path === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}],usage:'unknown'}));
      if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'c',projectId:'019a0000-0000-7000-8000-000000000008',taskId:'019a0000-0000-7100-8000-00000000000b',threadId:null,selectedModel:{id:'test',name:'Test'},messages:[...messages]}));
      const pack = packResponse(path, messages); if (pack) return Promise.resolve(pack);
      if (path === '/api/chat/send' && init?.method === 'POST') { posts++; return post.promise; }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-00000000000b'} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '最初の依頼' } });
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.input(textbox, { target: { value: '次の依頼' } });
    fireEvent.click(screen.getByRole('button', { name: '入力 を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '入力' }));
    const reopened = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect((reopened as HTMLTextAreaElement).value).toBe('次の依頼');
    const sending = screen.getByRole('button', { name: '応答中...' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    fireEvent.submit(sending.closest('form')!);
    expect(posts).toBe(1);
    messages.push({ id: 1, role: 'user', content: '最初の依頼', provider: 'codex', model: 'test', status: 'completed' } as any);
    post.resolve(json({ id: 1 }));
    FakeWebSocket.instances.filter(event=>!event.closed).forEach(event=>event.change());
    await screen.findByText('最初の依頼');
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次の依頼');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    expect(posts).toBe(1);
  });

  it('does not show or send a different task while a tab switch is still loading', async () => {
    const first = { id:'019a0000-0000-7100-8000-000000000015', projectId:'019a0000-0000-7000-8000-00000000000c', name: '先のタスク', phase: 'requirements', status: 'idle' };
    const second = { id:'019a0000-0000-7100-8000-000000000016', projectId:'019a0000-0000-7000-8000-00000000000c', name: '後のタスク', phase: 'requirements', status: 'idle' };
    const slow = deferred<Response>();
    let posts = 0;
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [first, second] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000015' && !init) return Promise.resolve(json({ task: first, messages: [], documents: [{ name: '先.md', content: '先の内容', version: 1 }] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000016' && !init) return slow.promise;
      if (path.endsWith('/messages') && init?.method === 'POST') { posts++; return Promise.resolve(json({})); }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000015'} onHome={() => {}} />);
    await screen.findByText('先の内容');
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '後のタスク' }));
    expect(screen.queryByRole('textbox', { name: '希望や回答を入力' })).toBeNull();
    expect(screen.queryByText('先の内容')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '先のタスク' }));
    await screen.findByText('先の内容');
    slow.resolve(json({ task: second, messages: [], documents: [{ name: '後.md', content: '後の内容', version: 1 }] }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '先のタスク' }).getAttribute('aria-selected')).toBe('true'));
    expect(screen.queryByText('後の内容')).toBeNull();
    expect(posts).toBe(0);
  });

  it('shows the saved result once when sending finishes while the task tab is closed', async () => {
    FakeWebSocket.instances=[];vi.stubGlobal('WebSocket',FakeWebSocket);
    const task = { id:'019a0000-0000-7100-8000-00000000001f', projectId:'019a0000-0000-7000-8000-00000000000e', name: '閉じた後', phase: 'requirements', status: 'idle' };
    const post = deferred<Response>();
    const messages: { id: number; role: string; content: string }[] = [];
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-00000000001f' && !init) return Promise.resolve(json({ task, messages: [], documents: [] }));
      if (path === '/api/chat/model') return Promise.resolve(json({id:'c',messages:[...messages],selectedModel:{id:JSON.parse(String(init?.body)).model,name:'Test'}}));
      if (path === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}],usage:'unknown'}));
      if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'c',projectId:'019a0000-0000-7000-8000-00000000000e',taskId:'019a0000-0000-7100-8000-00000000001f',threadId:null,selectedModel:{id:'test',name:'Test'},messages:[...messages]}));
      const pack = packResponse(path, messages); if (pack) return Promise.resolve(pack);
      if (path === '/api/chat/send' && init?.method === 'POST') return post.promise;
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-00000000001f'} onHome={() => {}} />);
    const textbox = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(textbox, { target: { value: '保存する依頼' } });
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.input(textbox, { target: { value: '次の下書き' } });
    fireEvent.click(screen.getByRole('button', { name: '閉じた後 を閉じる' }));
    messages.push({ id: 1, role: 'user', content: '保存する依頼', provider: 'codex', model: 'test', status: 'completed' } as any);
    post.resolve(json({ id: 1 }));
    FakeWebSocket.instances.filter(event=>!event.closed).forEach(event=>event.change());
    await post.promise;
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    fireEvent.click(await screen.findByRole('button', { name: '閉じた後' }));
    await screen.findByRole('textbox',{name:'希望や回答を入力'});
    FakeWebSocket.instances.filter(event=>!event.closed).forEach(event=>event.change());
    await screen.findByText('保存する依頼', { exact: true });
    expect(screen.getAllByText('保存する依頼', { exact: true })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次の下書き');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('can recover the initial tab when it was closed before both state and task load finished', async () => {
    const task = { id:'019a0000-0000-7100-8000-000000000029', projectId:'019a0000-0000-7000-8000-00000000000f', name: '初期', phase: 'requirements', status: 'idle' };
    const state = deferred<Response>();
    const firstGet = deferred<Response>();
    let taskGets = 0;
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return state.promise;
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000029' && !init) {
        taskGets++;
        return taskGets === 1 ? firstGet.promise : Promise.resolve(json({ task, messages: [], documents: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000029'} onHome={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'タスク を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    state.resolve(json({ projects: [], tasks: [task] }));
    fireEvent.click(await screen.findByRole('button', { name: '初期' }));
    await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect(taskGets).toBe(2);
    firstGet.resolve(json({ task: { ...task, name: '古い応答' }, messages: [], documents: [] }));
    await firstGet.promise;
    expect(screen.getByRole('tab', { name: '初期' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '古い応答' })).toBeNull();
  });

  it('can reopen the initial task when the list fails and the first task request is still pending', async () => {
    const task = { id:'019a0000-0000-7100-8000-000000000033', projectId:'019a0000-0000-7000-8000-000000000010', name: '復元', phase: 'requirements', status: 'idle' };
    const firstGet = deferred<Response>();
    let taskGets = 0;
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.reject(new Error('offline'));
      if (path === '/api/tasks/019a0000-0000-7100-8000-000000000033' && !init) {
        taskGets++;
        return taskGets === 1 ? firstGet.promise : Promise.resolve(json({ task, messages: [], documents: [] }));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-000000000033'} onHome={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'タスク を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: 'タスクツリーを開閉' }));
    await screen.findByText('タスク一覧を取得できませんでした');
    fireEvent.click(screen.getByRole('button', { name: 'タスク' }));
    await screen.findByRole('tab', { name: '復元' });
    expect(screen.getByRole('textbox', { name: '希望や回答を入力' })).toBeTruthy();
    expect(taskGets).toBe(2);
  });

  it('distinguishes document versions and opens the latest revision from the phase indicator', async () => {
    const task = { id:'019a0000-0000-7100-8000-00000000003d', projectId:'019a0000-0000-7000-8000-000000000011', name: '版', phase: 'requirements', status: 'idle' };
    const documents = [{ name: 'requirements.md', content: '第一版の内容', version: 1 }, { name: 'requirements.md', content: '第二版の内容', version: 2 }];
    stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/state' && !init) return Promise.resolve(json({ projects: [], tasks: [task] }));
      if (path === '/api/tasks/019a0000-0000-7100-8000-00000000003d' && !init) return Promise.resolve(json({ task, messages: [], documents }));
      if (path === `/api/tasks/${task.id}/phase`) {
        expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,phase:'requirements',target:'requirements'});
        return Promise.resolve(json(task));
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    render(() => <Workspace taskId={'019a0000-0000-7100-8000-00000000003d'} onHome={() => {}} />);
    await screen.findByRole('tab', { name: '要件定義 · v2' });
    expect(screen.getByText('第二版の内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '要件定義 · v1' }));
    expect(screen.getByText('第一版の内容')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '要件定義 · v2 を閉じる' }));
    expect(screen.queryByRole('tab', { name: '要件定義 · v2' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '要件定義' }));
    expect(await screen.findByText('第二版の内容')).toBeTruthy();
    expect(screen.getByRole('tab', { name: '要件定義 · v2' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '文書ツリーを開閉' }));
    expect(screen.getByRole('button', { name: '要件定義 · v1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '要件定義 · v2' })).toBeTruthy();
  });
});

it('updates the task tab and tree from the rename response without selecting a different task', async () => {
 const task={id:'019a0000-0000-7100-8000-000000000065',projectId:'019a0000-0000-7000-8000-000000000018',name:'Before',phase:'requirements',status:'idle'};
 const changed=vi.fn();
 const fetchMock=vi.fn((path:string,init?:RequestInit)=>{
  if(path==='/api/state') return Promise.resolve(json({projects:[],tasks:[task]}));
  if(path===`/api/tasks/${task.id}/rename`) {expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,name:'After'});task.name='After';return Promise.resolve(json({...task}));}
  if(path===`/api/tasks/${task.id}`) return Promise.resolve(json({task:{...task},documents:[]}));
  throw Error('Unexpected request');
 });
 stubLegacyAgentFetch(fetchMock);
 render(()=><Workspace taskId={task.id} onTaskChange={changed} onHome={()=>{}} />);
 fireEvent.contextMenu(await screen.findByRole('tab',{name:'Before'}));fireEvent.click(screen.getByRole('menuitem',{name:'リネーム'}));
 fireEvent.input(screen.getByRole('textbox',{name:'タスク名'}),{target:{value:'After'}});fireEvent.keyDown(screen.getByRole('textbox',{name:'タスク名'}),{key:'Enter'});
 await screen.findByRole('tab',{name:'After'});
 expect(screen.queryByRole('tab',{name:'Before'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'タスクツリーを開閉'}));
 expect(screen.getByRole('button',{name:'After'})).toBeTruthy();expect(changed).not.toHaveBeenCalled();
});

it('タスクを選ばずにフォルダーを展開し、プロジェクトファイルのタブを開いて切り替えられる', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000018';
  const slow = deferred<Response>();
  const fetchMock = vi.fn((url: string) => {
    const { pathname, searchParams } = new URL(url, 'http://127.0.0.1:3210');
    if (pathname === '/api/state') return Promise.resolve(json({ projects: [], tasks: [] }));
    const path = searchParams.get('path');
    if (pathname === '/api/project-files' && path === '') return Promise.resolve(json({
      entries: [{ name: 'docs', kind: 'directory' }, { name: 'README.md', kind: 'file' }], truncated: false,
    }));
    if (pathname === '/api/project-files' && path === 'docs') return Promise.resolve(json({
      entries: [{ name: 'example.html', kind: 'file' }, { name: 'slow.txt', kind: 'file' }], truncated: false,
    }));
    if (pathname === '/api/project-file' && path === 'README.md') return Promise.resolve(json({ kind: 'text', content: '# 使い方' }));
    if (pathname === '/api/project-file' && path === 'docs/example.html') return Promise.resolve(json({ kind: 'text', content: '<p>HTML の例</p>' }));
    if (pathname === '/api/project-file' && path === 'docs/slow.txt') return slow.promise;
    throw Error('Unexpected request');
  });
  stubLegacyAgentFetch(fetchMock);
  render(() => <Workspace projectId={projectId} onHome={() => {}} />);

  const toggle = () => screen.getByRole('button', { name: '文書ツリーを開閉' });
  fireEvent.click(toggle());
  const readme = await screen.findByRole('button', { name: 'README.md' });
  const folder = screen.getByText('docs').closest('details')!;
  expect(folder.open).toBe(false);
  expect(fetchMock.mock.calls.some(([url]) => url.includes('path=docs'))).toBe(false);
  folder.open = true;
  fireEvent(folder, new Event('toggle'));
  const example = await screen.findByRole('button', { name: 'example.html' });
  expect(toggle().getAttribute('aria-expanded')).toBe('true');

  fireEvent.click(readme);
  await screen.findByRole('heading', { name: '使い方' });
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle());
  const reopened = (await screen.findByText('docs')).closest('details')!;
  reopened.open = true;
  fireEvent(reopened, new Event('toggle'));
  expect(example.isConnected).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: 'example.html' }));
  await waitFor(() => expect(screen.getByLabelText('文書プレビュー').querySelector('pre code')?.textContent).toBe('<p>HTML の例</p>'));
  expect(screen.getByLabelText('文書プレビュー').querySelector('pre p')).toBeNull();

  fireEvent.click(toggle());
  const next = (await screen.findByText('docs')).closest('details')!;
  next.open = true;
  fireEvent(next, new Event('toggle'));
  fireEvent.click(await screen.findByRole('button', { name: 'slow.txt' }));
  const readmeTab = screen.getByRole('tab', { name: 'README.md' });
  fireEvent.click(readmeTab);
  await screen.findByRole('heading', { name: '使い方' });
  slow.resolve(json({ kind: 'text', content: '古い要求の結果' }));
  expect(screen.queryByText('古い要求の結果')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'README.md を閉じる' }));
  await screen.findByText('古い要求の結果');
  expect(screen.getByRole('tab', { name: 'slow.txt' }).getAttribute('aria-selected')).toBe('true');
});
