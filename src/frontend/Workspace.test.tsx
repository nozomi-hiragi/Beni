import { resetModelCache } from './model-cache';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Workspace from './Workspace';
import {FakeWebSocket, packResponse} from './test-events';

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
    vi.stubGlobal('fetch', fetchMock);
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
 vi.stubGlobal('fetch',vi.fn((path:string, init?: RequestInit)=>{
  if(path.endsWith('/phase')) { expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,phase:'requirements',target:'documents'}); currentPhase='documents'; return Promise.resolve(json({...task,phase:currentPhase})); }
  if(path==='/api/state')return Promise.resolve(json({projects:[],tasks:[task]}));
  if(path==='/api/tasks/019a0000-0000-7100-8000-000000000385')return Promise.resolve(json({task:{...task,phase:currentPhase},messages:[],documents:[{path:'requirements.md',name:'requirements.md',content,version},{path:'documents.md',name:'documents.md',content:'# Index\n\n## 仕様\n\n[API](api.md)',version:1},{path:'api.md',name:'api.md',content:'# API specification',version:1},{path:'implementation-plan.md',name:'implementation-plan.md',content:'# Plan',version:1}]}));
  if(path==='/api/codex/status')return Promise.resolve(json({installed:false,auth:'none',models:[],usage:'unknown'}));
  if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'document-test',messages:[]}));
  throw Error(path);
 }));
 render(()=><Workspace projectId={'019a0000-0000-7000-8000-000000000001'} taskId={'019a0000-0000-7100-8000-000000000385'} onHome={()=>{}}/>);
 const heading=await screen.findByRole('heading',{name:'Initial',level:1});
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
  vi.stubGlobal('fetch', vi.fn((path:string, init?:RequestInit) => {
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

it('moves back, recovers a phase conflict and follows task event changes', async () => {
  const task = {id:'019a0000-0000-7100-8000-000000000801',projectId:'019a0000-0000-7000-8000-000000000801',name:'Phase changes',phase:'documents',status:'idle'};
  let phase = task.phase, conflict = false;
  const onTaskChange = vi.fn();
  vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({projects:[],tasks:[task]}));
    if (path.endsWith('/phase')) {
      expect(JSON.parse(String(init?.body))).toEqual({projectId:task.projectId,phase:'documents',target:'requirements'});
      phase = conflict ? 'implementation-plan' : 'requirements';
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
  expect(onTaskChange).toHaveBeenLastCalledWith(task.id, expect.objectContaining({phase:'implementation-plan'}));
});

it.each(['codex','claude'] as const)('starts with the selected %s model and refreshes start availability after stopping', async provider => {
  const saved:Record<string,string>={};
  const task = {id:'019a0000-0000-7100-8000-000000000901',projectId:'019a0000-0000-7000-8000-000000000901',name:'Selected model',phase:'implementation-plan',status:'idle'};
  let phase = task.phase, canStart = true;
  const starts: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
    if (path === '/api/state') return Promise.resolve(json({projects:[],tasks:[task]}));
    if (path.endsWith('/start')) {
      starts.push(JSON.parse(String(init?.body)));
      phase = 'implementation';
      return Promise.resolve(json({...task,phase}));
    }
    if (path.endsWith('/stop')) {
      phase = 'implementation-plan'; canStart = false;
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
  const model = await screen.findByRole('combobox',{name:'モデル'});
  await waitFor(() => expect((model as HTMLSelectElement).value).toBe('codex:first'));
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(model,{target:{value:`${provider}:chosen`}});
  await waitFor(() => expect((model as HTMLSelectElement).value).toBe(`${provider}:chosen`));
  expect(saved['implementation-plan']).toBeUndefined();
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'開始'}));
  await waitFor(() => expect(starts).toEqual([{projectId:task.projectId,phase:'implementation-plan',model:'chosen',provider}]));
  await waitFor(() => expect((screen.getByRole('button',{name:'停止'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'停止'}));
  await waitFor(() => expect((screen.getByRole('button',{name:'開始'}) as HTMLButtonElement).disabled).toBe(true));
  await waitFor(() => expect((screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement).value).toBe(`${provider}:chosen`));
});

it('利用不可の保存モデルを表示して送信を止め、有効モデルの保存で解除する',async()=>{
 const {default:ChatPanel}=await import('./components/ChatPanel');
 let selectedModel={id:'removed',name:'Saved model'};
 const post=vi.fn();
 vi.stubGlobal('fetch',vi.fn((path:string,init?:RequestInit)=>{
  if(path==='/api/codex/status')return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'available',name:'Available'}]}));
  if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'models',messages:[],selectedModel}));
  if(path==='/api/chat/model'){post(JSON.parse(String(init?.body)));selectedModel={id:'available',name:'Available'};return Promise.resolve(json({id:'models',messages:[],selectedModel}));}
  throw Error(path);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000001" />);
 const model=await screen.findByRole('combobox',{name:'モデル'});
 await screen.findByRole('option',{name:'⚠️ Codex/Saved model'});
 fireEvent.input(screen.getByRole('textbox',{name:'希望や回答を入力'}),{target:{value:'hello'}});
 expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
 expect(post).not.toHaveBeenCalled();
 fireEvent.change(model,{target:{value:'codex:available'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
 expect(post).not.toHaveBeenCalled();
 expect(screen.queryByRole('option',{name:'⚠️ Codex/Saved model'})).toBeNull();
});
