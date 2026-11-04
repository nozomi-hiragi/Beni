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

beforeEach(() => {
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
      if (path === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}],usage:'unknown'}));
      if (path.startsWith('/api/chat?')) return Promise.resolve(json({id:'c',projectId:1,taskId,threadId:null,messages:[...messages]}));
      const pack = packResponse(path, messages); if (pack) return Promise.resolve(pack);
      if (path === '/api/chat/send' && init?.method === 'POST') {
        postCount++;
        expect(JSON.parse(String(init.body))).toEqual({ projectId:1, taskId, content: '最初の希望', model:'test' });
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
 const task={id:901,projectId:1,name:'Documents',phase:'requirements',status:'idle'};
 let content='# Initial',version=1;
 vi.stubGlobal('fetch',vi.fn((path:string)=>{
  if(path==='/api/state')return Promise.resolve(json({projects:[],tasks:[task]}));
  if(path==='/api/tasks/901')return Promise.resolve(json({task,messages:[],documents:[{path:'requirements.md',name:'requirements.md',content,version},{path:'implementation-plan.md',name:'implementation-plan.md',content:'# Plan',version:1}]}));
  if(path==='/api/codex/status')return Promise.resolve(json({installed:false,auth:'none',models:[],usage:'unknown'}));
  if(path.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(path.startsWith('/api/chat?'))return Promise.resolve(json({id:'document-test',messages:[]}));
  throw Error(path);
 }));
 render(()=><Workspace projectId={1} taskId={901} onHome={()=>{}}/>);
 const heading=await screen.findByRole('heading',{name:'Initial',level:1});
 const preview=heading.closest('article')!;
 const tab=screen.getByRole('tab',{name:'requirements.md'});
 preview.scrollTop=12;
 const subscription=FakeWebSocket.instances.find(event=>!event.closed)!;
 await waitFor(()=>expect([...subscription.subscriptions.values()].some(sub=>sub.topic==='documents')).toBe(true));
 subscription.change('documents');
 await Promise.resolve();
 expect(screen.getByRole('heading',{name:'Initial',level:1}).closest('article')).toBe(preview);
 content='# Updated from disk';version=2;subscription.change('documents');
 await waitFor(()=>expect(screen.getByRole('heading',{name:'Updated from disk',level:1})).toBeTruthy(),{timeout:3000});
 expect(screen.getAllByRole('tab',{name:'requirements.md'})).toHaveLength(1);
 expect(screen.getByRole('tab',{name:'requirements.md'})).toBe(tab);expect(screen.getByRole('heading',{name:'Updated from disk',level:1}).closest('article')).toBe(preview);expect(preview.scrollTop).toBe(12);
 fireEvent.click(screen.getByRole('tab',{name:'implementation-plan.md'}));
 expect(screen.getByRole('heading',{name:'Plan',level:1})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'タスク内容'}));
 expect(screen.getByRole('heading',{name:'Updated from disk',level:1})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'ジェネラル'}));
 await waitFor(()=>expect([...subscription.subscriptions.values()].some(sub=>sub.topic==='documents')).toBe(false));
 cleanup();expect(FakeWebSocket.instances.every(event=>event.closed)).toBe(true);
});
