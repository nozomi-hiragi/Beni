import { createSignal } from 'solid-js';
import { resetModelCache } from './model-cache';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';
import { chatModelPicker, FakeWebSocket, packResponse, stubLegacyAgentFetch } from './test/test-events';
import type { TaskDetail } from './types';

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Workspace message submission across navigation', () => {
  it('retains the newer draft and the sending lock across remount, then displays the saved message once', async () => {
    FakeWebSocket.instances=[];vi.stubGlobal('WebSocket',FakeWebSocket);
    const taskId = '019a0000-0000-7100-8000-000000000049';
    const task = { id: taskId, projectId:'019a0000-0000-7000-8000-000000000001', name: 'サンプル', phase: 'requirements', status: 'idle' };
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
      if (path === '/api/chat/model') return Promise.resolve(json({id:'c',messages:[...messages],selectedModel:{id:JSON.parse(String(init?.body)).model,name:'Test'}}));
    if (path === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}],usage:'unknown'}));
      if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'c',projectId:'019a0000-0000-7000-8000-000000000001',taskId,threadId:null,selectedModel:{id:'test',name:'Test'},messages:[...messages]}));
      const pack = packResponse(path, messages); if (pack) return Promise.resolve(pack);
      if (path === '/api/chat/send' && init?.method === 'POST') {
        postCount++;
        expect(JSON.parse(String(init.body))).toEqual({ projectId:'019a0000-0000-7000-8000-000000000001', taskId, phase: 'requirements', content: '最初の希望', model:'test',provider:'codex' });
        return post.promise;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    stubLegacyAgentFetch(fetchMock);
    const onHome = vi.fn();

    const first = render(() => <Workspace taskId={taskId} onHome={onHome} />);
    const message = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    fireEvent.input(message, { target: { value: '最初の希望' } });
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(postCount).toBe(1);
    expect((screen.getByRole('button', { name: '応答中...' }) as HTMLButtonElement).disabled).toBe(true);

    // The user continues typing while the submitted message is still in flight.
    fireEvent.input(message, { target: { value: '次に伝えること' } });
    first.unmount();
    render(() => <Workspace taskId={taskId} onHome={onHome} />);
    remountGet.resolve(json({ task, messages: [], documents }));
    const reopened = await screen.findByRole('textbox', { name: '希望や回答を入力' });
    expect((reopened as HTMLTextAreaElement).value).toBe('次に伝えること');
    const sending = screen.getByRole('button', { name: '応答中...' }) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    fireEvent.click(sending);
    // A direct form submit also cannot bypass the per-task in-flight lock.
    fireEvent.submit(sending.closest('form')!);
    expect(postCount).toBe(1);

    messages.push({ id: 1, role: 'user', content: '最初の希望', provider:'codex', model:'test', status:'completed' } as any);
    post.resolve(json({ id: 1 }));
    FakeWebSocket.instances.filter(event=>!event.closed).forEach(event=>event.change());
    await screen.findByText('最初の希望', { exact: true });
    expect(screen.getAllByText('最初の希望', { exact: true })).toHaveLength(1);
    expect((screen.getByRole('textbox', { name: '希望や回答を入力' }) as HTMLTextAreaElement).value).toBe('次に伝えること');
    await waitFor(() => expect((screen.getByRole('button', { name: '送信' }) as HTMLButtonElement).disabled).toBe(false));
    expect(postCount).toBe(1);
    expect(getCount).toBeGreaterThanOrEqual(2);
    expect(onHome).not.toHaveBeenCalled();
  });
});


it('refreshes real Markdown content without duplicating tabs and selects requirements from its phase',async()=>{
 FakeWebSocket.instances=[];vi.stubGlobal('WebSocket',FakeWebSocket);
 const task={id:'019a0000-0000-7100-8000-000000000385',projectId:'019a0000-0000-7000-8000-000000000001',name:'Documents',phase:'requirements',status:'idle'};
 let content='# Initial',version=1, currentPhase='requirements';
 const provenanceRequests: URLSearchParams[] = [];
 stubLegacyAgentFetch(vi.fn((path:string, init?: RequestInit)=>{
  if(path.endsWith('/phase')) { expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,phase:'requirements',target:'documents'}); currentPhase='documents'; return Promise.resolve(json({...task,phase:currentPhase})); }
  if(path==='/api/state')return Promise.resolve(json({projects:[],tasks:[task]}));
  if(path==='/api/tasks/019a0000-0000-7100-8000-000000000385')return Promise.resolve(json({task:{...task,phase:currentPhase},messages:[],documents:[{path:'requirements.md',name:'requirements.md',content,version,provenance:{revision:`revision-${version}`,items:[{id:'item',start:0,end:content.length}]}},{path:'documents.md',name:'documents.md',content:'# Index\n\n## 仕様\n\n[API](api.md)',version:1},{path:'api.md',name:'api.md',content:'# API specification',version:1},{path:'implementation.md',name:'implementation.md',content:'# Plan',version:1}]}));
  if(path.startsWith('/api/document-provenance?')){
   const query = new URL(path, 'http://localhost').searchParams;
   provenanceRequests.push(query);
   return Promise.resolve(json({reason:`根拠 ${query.get('revision')}`,sources:[]}));
  }
  if(path==='/api/codex/status')return Promise.resolve(json({installed:false,auth:'none',models:[],usage:'unknown'}));
  if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'document-test',messages:[]}));
  throw Error(path);
 }));
 render(()=><Workspace projectId={'019a0000-0000-7000-8000-000000000001'} taskId={'019a0000-0000-7100-8000-000000000385'} onHome={()=>{}}/>);
 const heading=await screen.findByRole('heading',{name:'Initial',level:1});
 fireEvent.mouseOver(heading);
 await screen.findByText('根拠 revision-1');
 expect(Object.fromEntries(provenanceRequests[0]!)).toEqual({name:'requirements.md',revision:'revision-1',itemId:'item',projectId:task.projectId,taskId:task.id});
 const preview=heading.closest('article')!;
 const tab=screen.getByRole('tab',{name:'要件定義'});
 preview.scrollTop=12;
 const subscription=FakeWebSocket.instances.find(event=>!event.closed)!;
 await waitFor(()=>expect([...subscription.subscriptions.values()].some(sub=>sub.topic==='documents')).toBe(true));
 subscription.change('documents');
 await Promise.resolve();
 expect(screen.getByRole('heading',{name:'Initial',level:1}).closest('article')).toBe(preview);
 content='# Updated from disk';version=2;subscription.change('documents');
 await waitFor(()=>expect(screen.getByRole('heading',{name:'Updated from disk',level:1})).toBeTruthy(),{timeout:3000});
 expect(screen.getAllByRole('tab',{name:'要件定義'})).toHaveLength(1);
 expect(screen.getByRole('tab',{name:'要件定義'})).toBe(tab);expect(screen.getByRole('heading',{name:'Updated from disk',level:1}).closest('article')).toBe(preview);expect(preview.scrollTop).toBe(12);
 fireEvent.mouseOver(screen.getByRole('heading',{name:'Updated from disk',level:1}));
 await screen.findByText('根拠 revision-2');
 expect(provenanceRequests.map(query => query.get('revision'))).toEqual(['revision-1','revision-2']);
 fireEvent.click(screen.getByRole('tab',{name:'実装手順'}));
 expect(screen.getByRole('heading',{name:'Plan',level:1})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'要件定義'}));
 expect(screen.getByRole('heading',{name:'Updated from disk',level:1})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'仕様整理'}));
 await screen.findByRole('heading',{name:'Index'});
 expect(screen.getByRole('button',{name:'仕様整理'}).getAttribute('aria-current')).toBe('step');
 fireEvent.click(screen.getByRole('link',{name:'API'}));
 expect(screen.getByRole('heading',{name:'API specification'})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'General'}));
 await waitFor(()=>expect([...subscription.subscriptions.values()].some(sub=>sub.topic==='documents')).toBe(false));
 cleanup();expect(FakeWebSocket.instances.every(event=>event.closed)).toBe(true);
});

it('deletes an inactive task without changing selection and removes active task documents and tree entries', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000001';
  const first = {id:'019a0000-0000-7100-8000-000000000601',projectId,name:'Delete A',phase:'requirements',status:'idle'};
  const second = {...first,id:'019a0000-0000-7100-8000-000000000602',name:'Delete B'};
  const onTaskChange = vi.fn(); const onTaskDeleted = vi.fn(); const deletes: string[] = [];
  stubLegacyAgentFetch(vi.fn((path:string, init?:RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({projects:[],tasks:[first,second]}));
    if (path.endsWith('/delete')) { expect(init?.method).toBe('POST'); expect(JSON.parse(String(init?.body))).toEqual({projectId}); deletes.push(path); return Promise.resolve(json({ok:true})); }
    const task = [first,second].find(task => path === `/api/tasks/${task.id}`);
    if (task) return Promise.resolve(json({task,documents:[{name:`${task.name}.md`,content:'# Document',version:1}]}));
    if(path==='/api/codex/status')return Promise.resolve(json({installed:false,auth:'none',models:[],usage:'unknown'}));
    if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
    if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'delete-chat',messages:[]}));
    throw Error(path);
  }));
  render(() => <Workspace projectId={projectId} taskId={first.id} onHome={()=>{}} onTaskChange={onTaskChange} onTaskDeleted={onTaskDeleted} />);
  await screen.findByRole('tab',{name:'Delete A.md'});
  fireEvent.click(screen.getByRole('button',{name:'タスクツリーを開閉'}));
  fireEvent.click(await screen.findByRole('button',{name:'Delete B'}));
  await screen.findByRole('tab',{name:'Delete B.md'});
  const remove = async (name:string) => { fireEvent.contextMenu(screen.getByRole('tab',{name})); fireEvent.click(screen.getByRole('menuitem',{name:'削除'})); fireEvent.click(screen.getByRole('button',{name:'OK'})); await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull()); };
  onTaskChange.mockClear();
  await remove('Delete A');
  expect(onTaskChange).not.toHaveBeenCalled();
  expect(screen.getByRole('tab',{name:'Delete B'}).getAttribute('aria-selected')).toBe('true');
  await remove('Delete B');
  expect(onTaskChange).toHaveBeenLastCalledWith(undefined, undefined);
  expect(screen.getByRole('tab',{name:'General'}).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('tab',{name:'Delete B.md'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'タスクツリーを開閉'}));
  expect(screen.queryByRole('button',{name:'Delete A'})).toBeNull();
  expect(screen.queryByRole('button',{name:'Delete B'})).toBeNull();
  expect(onTaskDeleted.mock.calls).toEqual([[first.id],[second.id]]);
  expect(deletes).toEqual([`/api/tasks/${first.id}/delete`,`/api/tasks/${second.id}/delete`]);
});

it('opens status for the clicked chat after its history loads and cancels on navigation', async ({ onTestFinished }) => {
  // jsdom does not implement modal dialogs. ChatCommands tests use the native API in happy-dom.
  const dialogPrototype = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(dialogPrototype, 'showModal');
  const close = Object.getOwnPropertyDescriptor(dialogPrototype, 'close');
  Object.defineProperties(dialogPrototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
  onTestFinished(() => {
    if (showModal) Object.defineProperty(dialogPrototype, 'showModal', showModal);
    else Reflect.deleteProperty(dialogPrototype, 'showModal');
    if (close) Object.defineProperty(dialogPrototype, 'close', close);
    else Reflect.deleteProperty(dialogPrototype, 'close');
  });
  const projectId = '019a0000-0000-7000-8000-000000000601';
  const task = { id: '019a0000-0000-7100-8000-000000000601', projectId, name: '作業チャット', phase: 'documents', status: 'idle' };
  const taskHistory = { id: 'task-chat', projectId, taskId: task.id, selectedModel: { id: 'test', name: 'Test', provider: 'codex' }, sessionProvider: 'claude', messages: [] };
  const generalHistory = { ...taskHistory, id: 'general-chat', taskId: null, sessionProvider: 'codex' };
  const onTaskReload = vi.fn();
  let taskReload: Deferred<Response> | undefined;
  stubLegacyAgentFetch(vi.fn(async (path: string) => {
    if (path === '/api/state') return json({ projects: [], tasks: [task] });
    if (path === `/api/tasks/${task.id}`) return json({ task, documents: [] });
    if (path === '/api/codex/status') return json({ installed: true, auth: 'chatgpt', models: [{ id: 'test', name: 'Test' }] });
    if (path === '/api/claude/status') return json({ installed: false, auth: 'none', models: [] });
    if (path.startsWith('/api/chat?')) {
      const taskId = new URL(path, 'http://localhost').searchParams.get('taskId');
      if (taskId !== task.id) return json(generalHistory);
      if (taskReload) { onTaskReload(); return taskReload.promise; }
      return json(taskHistory);
    }
    const packs = packResponse(path, []);
    if (packs) return packs;
    throw new Error(path);
  }));
  render(() => <Workspace projectId={projectId} taskId={task.id} onHome={() => {}} />);

  const general = screen.getByRole('tab', { name: 'General' });
  await screen.findByRole('textbox', { name: '希望や回答を入力' });
  const taskTab = screen.getByRole('tab', { name: task.name });
  const status = () => screen.getByRole<HTMLButtonElement>('menuitem', { name: '状態を表示' });
  const composerCommand = /^\//;
  fireEvent.contextMenu(taskTab);
  await waitFor(() => expect(status().disabled).toBe(false));
  expect(screen.queryByRole('menuitem', { name: composerCommand })).toBeNull();
  fireEvent.keyDown(status(), { key: 'Escape' });

  fireEvent.keyDown(general, { key: 'F10', shiftKey: true });
  const generalMenu = screen.getByRole('menu', { name: 'General の操作' });
  const generalStatus = within(generalMenu).getByRole('menuitem', { name: '状態を表示' });
  expect(within(generalMenu).queryByRole('menuitem', { name: /リネーム|削除/ })).toBeNull();
  expect(within(generalMenu).queryByRole('menuitem', { name: composerCommand })).toBeNull();
  expect(taskTab.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(generalStatus);
  const generalDialog = await screen.findByRole('dialog', {name:'チャットの状態'});
  expect(within(generalDialog).getByText('Codex')).toBeTruthy();
  expect(general.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(within(generalDialog).getByRole('button', {name:'閉じる'}));

  taskReload = deferred<Response>();
  fireEvent.contextMenu(taskTab);
  expect(screen.getByRole('menuitem', { name: 'リネーム' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: '削除' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: composerCommand })).toBeNull();
  expect(general.getAttribute('aria-selected')).toBe('true');
  fireEvent.click(status());
  expect(taskTab.getAttribute('aria-selected')).toBe('true');
  await waitFor(() => expect(onTaskReload).toHaveBeenCalled());
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  fireEvent.click(general);
  taskReload.resolve(json(taskHistory));
  await screen.findByRole('textbox', { name: '希望や回答を入力' });
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();

  fireEvent.contextMenu(taskTab);
  fireEvent.click(status());
  const dialog = await screen.findByRole('dialog', {name:'チャットの状態'});
  expect(within(dialog).getByText('Claude')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', {name:'閉じる'}));
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
});

it('moves back, recovers a phase conflict and follows task event changes', async () => {
  const task = {id:'019a0000-0000-7100-8000-000000000801',projectId:'019a0000-0000-7000-8000-000000000801',name:'Phase changes',phase:'documents',status:'idle'};
  let phase = task.phase, conflict = false;
  const onTaskChange = vi.fn();
  stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({projects:[],tasks:[task]}));
    if (path.endsWith('/phase')) {
      expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,phase:'documents',target:'requirements'});
      phase = conflict ? 'implementation' : 'requirements';
      return Promise.resolve(conflict ? {ok:false,status:409,json:async()=>({error:'フェーズが変更されています'})} as Response : json({...task,phase}));
    }
    if (path === `/api/tasks/${task.id}`) return Promise.resolve(json({task:{...task,phase},documents:[{name:'requirements.md',content:'# Requirements',version:1},{name:'documents.md',content:'# Documents',version:1}]}));
    if (path === '/api/codex/status') return Promise.resolve(json({installed:false,auth:'none',models:[]}));
    if (path.startsWith('/api/chat/packs')) return Promise.resolve(json({packs:[]}));
    if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'phase',messages:[]}));
    throw Error(path);
  }));
  render(() => <Workspace taskId={task.id} onHome={() => {}} onTaskChange={onTaskChange} />);
  fireEvent.click(await screen.findByRole('button',{name:'要件定義'}));
  await waitFor(() => expect(screen.getByRole('button',{name:'要件定義'}).getAttribute('aria-current')).toBe('step'));

  const socket = FakeWebSocket.instances.find(socket => !socket.closed)!;
  phase = 'documents';
  await waitFor(() => expect([...socket.subscriptions.values()].some(sub => sub.topic === 'task-events')).toBe(true));
  socket.event('task-events',{name:'task.events.changed',data:{lastEventId:1}});
  await waitFor(() => expect(screen.getByRole('button',{name:'仕様整理'}).getAttribute('aria-current')).toBe('step'));
  conflict = true;
  fireEvent.click(screen.getByRole('button',{name:'要件定義'}));
  await screen.findByText('フェーズが変更されています');
  expect(screen.getByRole('button',{name:'実装手順'}).getAttribute('aria-current')).toBe('step');
  expect(onTaskChange).toHaveBeenLastCalledWith(task.id, expect.objectContaining({phase:'implementation'}));
});

it.each(['codex','claude'] as const)('starts with the selected %s model and refreshes start availability after stopping', async provider => {
  const saved:Record<string,string>={};
  const task = {id:'019a0000-0000-7100-8000-000000000901',projectId:'019a0000-0000-7000-8000-000000000901',name:'Selected model',phase:'implementation',status:'idle'};
  let phase = task.phase, canStart = true;
  const starts: unknown[] = [];
  stubLegacyAgentFetch(vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({projects:[],tasks:[task]}));
    if (path.endsWith('/start')) {
      starts.push(JSON.parse(String(init?.body)));
      phase = 'execution';
      return Promise.resolve(json({...task,phase}));
    }
    if (path.endsWith('/stop')) {
      phase = 'implementation'; canStart = false;
      return Promise.resolve(json({...task,phase}));
    }
    if (path === `/api/tasks/${task.id}`) return Promise.resolve(json({task:{...task,phase},documents:[],canStart}));
      if (path === '/api/chat/model') {saved[phase]=JSON.parse(String(init?.body)).model;return Promise.resolve(json({id:'start-model',messages:[],selectedModel:{id:saved[phase],name:saved[phase]}}));}
    if (path === '/api/claude/status') return Promise.resolve(json({installed:true,auth:'claude',models:[{id:'first',name:'First'},{id:'chosen',name:'Chosen'}]}));
    if (path === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'first',name:'First'},{id:'chosen',name:'Chosen'}]}));
    if (path.startsWith('/api/chat/packs')) return Promise.resolve(json({packs:[]}));
    if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'start-model',messages:[],selectedModel:saved[phase]?{id:saved[phase],name:saved[phase]}:null}));
    throw Error(path);
  }));
  render(() => <Workspace taskId={task.id} onHome={() => {}} />);
  const model = await screen.findByRole('combobox',{name:'実装担当モデル'});
  await waitFor(() => expect((model as HTMLSelectElement).value).toBe('codex:first'));
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(model,{target:{value:`${provider}:chosen`}});
  await waitFor(() => expect((model as HTMLSelectElement).value).toBe(`${provider}:chosen`));
  expect(saved['implementation']).toBeUndefined();
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'開始'}));
  await waitFor(() => expect(starts).toEqual([{projectId:task.projectId,phase:'implementation',model:'chosen',provider}]));
  await waitFor(() => expect((screen.getByRole('button',{name:'停止'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'停止'}));
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(true));
  await waitFor(() => expect((screen.getByRole('combobox',{name:'実装担当モデル'}) as HTMLSelectElement).value).toBe(`${provider}:chosen`));
});

it('利用不可の保存モデルを表示して送信を止め、有効モデルの保存で解除する',async()=>{
 const {default:ChatPanel}=await import('./components/ChatPanel');
 let selectedModel={id:'removed',name:'Saved model'};
 const post=vi.fn();
 stubLegacyAgentFetch(vi.fn((path:string,init?:RequestInit)=>{
  if(path==='/api/codex/status')return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'available',name:'Available'}]}));
  if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'models',messages:[],selectedModel}));
  if(path==='/api/chat/model'){post(JSON.parse(String(init?.body)));selectedModel={id:'available',name:'Available'};return Promise.resolve(json({id:'models',messages:[],selectedModel}));}
  throw Error(path);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000001" />);
 const model=chatModelPicker();
 await waitFor(()=>expect(model.title).toBe('⚠️ Codex/Saved model'));
 fireEvent.input(screen.getByRole('textbox',{name:'希望や回答を入力'}),{target:{value:'hello'}});
 expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
 expect(post).not.toHaveBeenCalled();
 await waitFor(()=>expect(model.disabled).toBe(false));
 fireEvent.click(model);
 expect(screen.getByRole('option',{name:'⚠️ Codex/Saved model'}).getAttribute('aria-disabled')).toBe('true');
 fireEvent.click(screen.getByRole('option',{name:'Codex/Available'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
 expect(post).not.toHaveBeenCalled();
 expect(model.title).toBe('Codex/Available');
 fireEvent.click(model);
 expect(screen.queryByRole('option',{name:'⚠️ Codex/Saved model'})).toBeNull();
});

it('実装担当モデルをチャットと独立して記憶し、実装から反省会・終了・再開へ進む', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000001', taskId = '019a0000-0000-7100-8000-000000000089';
  let task = {id: taskId, projectId, name: 'サンプル', phase: 'requirements', status: 'idle'};
  const posted: {path: string; body: any}[] = [];
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/state') return json({projects: [], tasks: [task]});
    if (path === `/api/tasks/${taskId}`) return json({task, documents: [], canStart: true});
    if (path === '/api/codex/status') return json({installed: true, auth: 'chatgpt', models: [{id:'c', name:'Codex model'}]});
    if (path === '/api/claude/status') return json({installed: true, auth: 'claude', models: [{id:'a', name:'Claude model'}]});
    if (path.startsWith('/api/chat?') || path.startsWith('/api/chat/packs')) {
      const phase = new URL(path, 'http://localhost').searchParams.get('phase');
      const messages = phase ? [{id:phase, role:'assistant', content:phase + ' の会話', status:phase === 'finalization' && task.status === 'idle' ? 'streaming' : 'completed'}] : [];
      return packResponse(path, messages) ?? json({id:phase ?? 'conversation', messages});
    }
    if (path.startsWith(`/api/tasks/${taskId}/`)) {
      const body = JSON.parse(String(init?.body)); posted.push({path, body});
      if (path.endsWith('/start')) task = {...task, phase: 'execution', status: 'running'};
      if (path.endsWith('/stop')) task = {...task, phase: 'implementation', status: 'idle'};
      if (path.endsWith('/phase')) task = {...task, phase: body.target};
      if (path.endsWith('/complete')) task = {...task, phase:'finalization', status:'idle'};
      if (path.endsWith('/reopen')) task = {...task, phase:'retrospective', status:'idle'};
      return json(task);
    }
    return json({sessions: []});
  });
  stubLegacyAgentFetch(fetchMock);
  const view = render(() => <Workspace taskId={taskId} onHome={() => {}} />);
  const select = await screen.findByRole('combobox', {name:'実装担当モデル'});
  await waitFor(() => expect((select as HTMLSelectElement).value).toBe('codex:c'));
  fireEvent.change(select, {target:{value:'claude:a'}});
  expect(chatModelPicker().value).toBe('codex:c');
  fireEvent.click(screen.getByRole('button', {name:'仕様整理'}));
  await waitFor(() => expect(posted.at(-1)?.body.target).toBe('documents'));
  await waitFor(() => expect((screen.getByRole('button', {name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole('combobox', {name:'実装担当モデル'}) as HTMLSelectElement).value).toBe('claude:a');
  fireEvent.click(screen.getByRole('button', {name:'開始'}));
  await waitFor(() => expect((screen.getByRole('button', {name:'停止'}) as HTMLButtonElement).disabled).toBe(false));
  expect(posted.at(-1)?.body).toMatchObject({model:'a',provider:'claude'});
  expect(screen.queryByRole('textbox', {name:'希望や回答を入力'})).toBeNull();
  expect(screen.queryByRole('combobox', {name:'モデル'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'停止'}));
  await screen.findByRole('button', {name:'開始'});
  view.unmount(); task = {...task, phase:'retrospective'};
  const second = render(() => <Workspace taskId={taskId} onHome={() => {}} />);
  await screen.findByRole('textbox', {name:'希望や回答を入力'});
  expect((screen.getByRole('button', {name:'要件定義'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', {name:'タスク完了'}));
  await screen.findByText('finalization の会話');
  expect(posted.at(-1)?.body).toEqual({projectId, phase:'retrospective'});
  expect(screen.getByRole('button', {name:'終了'}).getAttribute('aria-current')).toBe('step');
  expect(screen.queryByRole('button', {name:'再開'})).toBeNull();
  expect(screen.queryByRole('button', {name:'タスク完了'})).toBeNull();
  expect(screen.queryByRole('button', {name:'停止'})).toBeNull();
  expect(screen.queryByRole('button', {name:'中断'})).toBeNull();
  expect(screen.queryByRole('combobox', {name:'モデル'})).toBeNull();
  expect(screen.queryByRole('combobox', {name:'実装担当モデル'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'実装中'}));
  await screen.findByText('execution の会話');
  fireEvent.click(screen.getByRole('button', {name:'反省会'}));
  await screen.findByText('retrospective の会話');
  expect(screen.queryByRole('textbox', {name:'希望や回答を入力'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'終了'}));
  await screen.findByText('finalization の会話');

  const socket = FakeWebSocket.instances.find(item => !item.closed)!;
  task = {...task, status:'completed'};
  socket.event('task-events', {name:'task.events.changed', data:{lastEventId:1}});
  socket.change('chat', taskId);
  await waitFor(() => expect((screen.getByRole('button', {name:'再開'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', {name:'再開'}));
  await screen.findByRole('textbox', {name:'希望や回答を入力'});
  expect(posted.at(-1)?.body).toEqual({projectId, phase:'finalization'});
  expect(screen.getByRole('button', {name:'反省会'}).getAttribute('aria-current')).toBe('step');
  second.unmount(); task = {...task, phase:'requirements'};
  render(() => <Workspace taskId={taskId} onHome={() => {}} />);
  await waitFor(() => expect((screen.getByRole('combobox', {name:'実装担当モデル'}) as HTMLSelectElement).value).toBe('claude:a'));
});

it('保存した実装担当モデルが利用不可なら警告を表示し開始を防ぐ', async () => {
 const projectId='019a0000-0000-7000-8000-000000000001', taskId='019a0000-0000-7100-8000-000000000090';
 const task={id:taskId,projectId,name:'サンプル',phase:'implementation',status:'idle'};
 localStorage.setItem(`beni:model:${projectId}:${taskId}:implementation-assignee`,JSON.stringify({id:'removed',name:'Old',provider:'claude'}));
 stubLegacyAgentFetch(vi.fn(async (path:string) => {
  if(path==='/api/state')return json({projects:[],tasks:[task]});
  if(path===`/api/tasks/${taskId}`)return json({task,documents:[],canStart:true});
  if(path==='/api/codex/status')return json({installed:true,auth:'chatgpt',models:[{id:'new',name:'New'}]});
  if(path==='/api/claude/status')return json({installed:true,auth:'claude',models:[]});
  if(path.startsWith('/api/chat?'))return json({id:'c',messages:[]});
  const pack=packResponse(path,[]);if(pack)return pack;
  return json({sessions:[]});
 }));
 render(()=><Workspace taskId={taskId} onHome={()=>{}} />);
 await screen.findByRole('option',{name:'⚠️ Claude/Old'});
 await waitFor(()=>expect(screen.getAllByRole('option',{name:'Codex/New'}).length).toBeGreaterThan(0));
 expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.change(screen.getByRole('combobox',{name:'実装担当モデル'}),{target:{value:'codex:new'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
});

async function executionHistory(status = 'idle', initialPhase = 'retrospective') {
  const projectId = '019a0000-0000-7000-8000-000000000095';
  const tasks = ['096','097'].map((suffix,index) => ({id:`019a0000-0000-7100-8000-000000000${suffix}`,projectId,name:`履歴タスク${index+1}`,phase:initialPhase,status}));
  const [taskId,setTaskId] = createSignal(tasks[0].id);
  const posted: {path:string; body:Record<string,unknown>}[] = [];
  const fetchMock = vi.fn(async (path:string,init?:RequestInit) => {
    if (path === '/api/state') return json({projects:[],tasks});
    const task = tasks.find(item => path === `/api/tasks/${item.id}`);
    if (task) return json({task:{...task},documents:[{name:'retrospective.md',content:'# 反省会の文書',version:1}],canStart:true});
    if (path === '/api/codex/status') return json({installed:true,auth:'chatgpt',models:[{id:'sample',name:'Sample'}]});
    if (path === '/api/claude/status') return json({installed:false,auth:'none',models:[]});
    if (path.startsWith('/api/chat?') || path.startsWith('/api/chat/packs')) {
      const query = new URL(path,'http://localhost').searchParams;
      const phase = query.get('phase'), id = query.get('taskId');
      const messages = [{id:`history-${id}-${phase}`,role:'assistant',content:`${id} ${phase}の会話`,status:'completed'}];
      return packResponse(path,messages) ?? json({id:`conversation-${id}-${phase}`,messages});
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posted.push({path,body});
      const current = tasks.find(item => path.startsWith(`/api/tasks/${item.id}/`));
      if (current && (path.endsWith('/complete') || path.endsWith('/reopen'))) {current.status=path.endsWith('/complete')?'completed':'idle';return json({...current});}
      throw Error(`Unexpected mutation: ${path}`);
    }
    return json({sessions:[]});
  });
  stubLegacyAgentFetch(fetchMock);
  render(()=><Workspace taskId={taskId()} projectId={projectId} onHome={()=>{}} />);
  await screen.findByText(`${tasks[0].id} ${initialPhase}の会話`);
  const socket = FakeWebSocket.instances.find(item=>!item.closed)!;
  await waitFor(()=>expect([...socket.subscriptions.values()].some(item=>item.topic==='task-events')).toBe(true));
  return {tasks,setTaskId,posted,fetchMock,socket};
}

it.each(['idle','completed'])('実装終了後は実装中からreadOnly履歴を閲覧し、反省会へ戻れる %s', async status => {
  const {tasks,posted,fetchMock} = await executionHistory(status);
  fireEvent.click(screen.getByRole('button',{name:'実装中'}));
  await screen.findByText(`${tasks[0].id} executionの会話`);
  expect(screen.getByRole('button',{name:'実装中'}).getAttribute('aria-current')).toBe('step');
  expect(screen.queryByRole('textbox',{name:'希望や回答を入力'})).toBeNull();
  expect(screen.queryByRole('combobox',{name:'モデル'})).toBeNull();
  expect(screen.queryByRole('button',{name:'送信'})).toBeNull();expect(screen.queryByRole('button',{name:'停止'})).toBeNull();
  expect(screen.getByRole('heading',{name:'反省会の文書'})).toBeTruthy();
  expect(fetchMock.mock.calls.some(([path])=>path.startsWith('/api/chat?')&&path.includes('phase=execution'))).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'反省会'}));
  await screen.findByText(`${tasks[0].id} retrospectiveの会話`);
  expect(screen.getByRole('button',{name:'反省会'}).getAttribute('aria-current')).toBe('step');
  if(status==='idle')expect(screen.getByRole('textbox',{name:'希望や回答を入力'})).toBeTruthy();
  else expect(screen.queryByRole('textbox',{name:'希望や回答を入力'})).toBeNull();
  expect(posted).toEqual([]);
});

it('同じ実フェーズの再取得では履歴閲覧を維持し、タスク変更と実フェーズ変更で戻す', async () => {
  const {tasks,setTaskId,posted,socket} = await executionHistory();
  fireEvent.click(screen.getByRole('button',{name:'実装中'}));await screen.findByText(`${tasks[0].id} executionの会話`);
  tasks[0].name='再取得した履歴タスク';socket.event('task-events',{name:'task.events.changed',data:{lastEventId:1}});
  await screen.findByRole('tab',{name:'再取得した履歴タスク'});
  expect(screen.getByRole('button',{name:'実装中'}).getAttribute('aria-current')).toBe('step');
  expect(screen.getByText(`${tasks[0].id} executionの会話`)).toBeTruthy();
  setTaskId(tasks[1].id);await screen.findByText(`${tasks[1].id} retrospectiveの会話`);
  expect(screen.getByRole('button',{name:'反省会'}).getAttribute('aria-current')).toBe('step');
  fireEvent.click(screen.getByRole('button',{name:'実装中'}));await screen.findByText(`${tasks[1].id} executionの会話`);
  tasks[1].phase='implementation';socket.event('task-events',{name:'task.events.changed',data:{lastEventId:2}});
  await screen.findByText(`${tasks[1].id} implementationの会話`);
  expect(screen.getByRole('button',{name:'実装手順'}).getAttribute('aria-current')).toBe('step');
  expect(screen.getByRole('textbox',{name:'希望や回答を入力'})).toBeTruthy();expect(posted).toEqual([]);
});

it.each(['idle','completed'])('履歴閲覧中の完了と再開は実際の反省会を操作する %s', async status => {
  const {tasks,posted} = await executionHistory(status);
  fireEvent.click(screen.getByRole('button',{name:'実装中'}));await screen.findByText(`${tasks[0].id} executionの会話`);
  fireEvent.click(screen.getByRole('button',{name:status==='idle'?'タスク完了':'再開'}));
  await waitFor(()=>expect(posted).toEqual([{path:`/api/tasks/${tasks[0].id}/${status==='idle'?'complete':'reopen'}`,body:{projectId:tasks[0].projectId,phase:'retrospective'}}]));
  expect(screen.queryByRole('button',{name:'停止'})).toBeNull();
});


it('初回から実装実行中のタスクはexecution会話をreadOnlyで表示し停止だけを提供する', async () => {
 const {tasks,posted}=await executionHistory('running','execution');
 expect(screen.getByText(`${tasks[0].id} executionの会話`)).toBeTruthy();
 expect(screen.queryByRole('textbox',{name:'希望や回答を入力'})).toBeNull();expect(screen.queryByRole('combobox',{name:'モデル'})).toBeNull();
 expect(screen.queryByRole('button',{name:'実装中'})).toBeNull();expect(screen.getByRole('button',{name:'停止'})).toBeTruthy();
 expect(posted).toEqual([]);
});

it('自動精査の進捗と再試行に応じて反省会のチャットと完了操作を切り替え、指示更新も再試行できる', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000001';
  const id = '019a0000-0000-7100-8000-000000000099';
  const task = { id, projectId, name: '精査の確認', phase: 'retrospective', status: 'idle' };
  const workflow: NonNullable<TaskDetail['workflow']> = { review: { state: 'pending', remaining: 3 } };
  const documents = [{ path: 'retrospective.md', name: 'retrospective.md', content: '# 精査結果', version: 1 }];
  const retries: string[] = [];
  stubLegacyAgentFetch(vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/state') return json({ projects: [], tasks: [task] });
    if (path === `/api/tasks/${id}`) return json(structuredClone({ task, documents, workflow }));
    if (path === `/api/tasks/${id}/retry-review` || path === `/api/tasks/${id}/retry-instructions`) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ projectId });
      retries.push(path);
      if (path.endsWith('retry-review')) workflow.review = { state: 'running', remaining: 2 };
      else workflow.instructionJob = { status: 'pending' };
      return json({ ok: true });
    }
    if (path.startsWith('/api/chat?')) return json({ id: 'review-conversation', messages: [] });
    return packResponse(path, []) ?? json({ sessions: [] });
  }));
  render(() => <Workspace taskId={id} onHome={() => {}} />);
  const composer = () => screen.queryByRole('textbox', { name: '希望や回答を入力' });
  const complete = () => screen.getByRole<HTMLButtonElement>('button', { name: 'タスク完了' });
  await screen.findByText('反省会の自動精査 · 待機中 · 残り 3 件');
  expect(composer()).toBeNull();
  expect(complete().disabled).toBe(true);

  const socket = FakeWebSocket.instances.find(item => !item.closed)!;
  let lastEventId = 0;
  const notify = () => socket.event('task-events', { name: 'task.events.changed', data: { lastEventId: ++lastEventId } });
  await waitFor(() => expect([...socket.subscriptions.values()].some(item => item.topic === 'task-events')).toBe(true));
  workflow.review = { state: 'failed', remaining: 2, error: '精査に失敗しました' };
  notify();
  const retry = await screen.findByRole('button', { name: '自動精査を再試行' });
  expect(screen.getByText('精査に失敗しました')).toBeTruthy();
  expect(composer()).toBeTruthy();
  expect(complete().disabled).toBe(true);
  fireEvent.click(retry);
  await screen.findByText('反省会の自動精査 · 実行中 · 残り 2 件');
  expect(composer()).toBeNull();
  expect(complete().disabled).toBe(true);

  workflow.review = { state: 'done', remaining: 0 };
  notify();
  await screen.findByText('反省会の自動精査 · 完了');
  await screen.findByRole('heading', { name: '精査結果' });
  expect(composer()).toBeTruthy();
  expect(complete().disabled).toBe(false);

  task.phase = 'finalization';
  notify();
  await waitFor(() => expect(screen.getByRole('button', { name: '終了' }).getAttribute('aria-current')).toBe('step'));
  task.status = 'completed';
  documents.push({ path: 'knowledge.md', name: 'knowledge.md', content: '# 次回に活かす知識', version: 1 });
  workflow.instructionJob = { status: 'failed', error: '更新に失敗しました' };
  notify();
  fireEvent.click(await screen.findByRole('button', { name: 'インストラクションの更新を再試行' }));
  await screen.findByText('インストラクションの更新 · 処理中');
  expect(screen.getByRole('tab', { name: 'ナレッジ' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('heading', { name: '次回に活かす知識' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'インストラクションの更新を再試行' })).toBeNull();
  expect(retries).toEqual([`/api/tasks/${id}/retry-review`, `/api/tasks/${id}/retry-instructions`]);
});
