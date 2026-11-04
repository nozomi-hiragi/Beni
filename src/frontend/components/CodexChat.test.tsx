import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel';
import CodexSettings from './CodexSettings';
import {FakeEventSource} from '../test-events';

const json = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('refreshes installation and login state without starting login', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    expect(url).toBe('/api/codex/status');
    calls++;
    return Promise.resolve(json(calls === 1 ? { installed: false, auth: 'unknown', models: null, usage: 'unknown' } : { installed: true, path: '/usr/bin/codex', version: '1.2.3', checkedAt: '2026-01-02T03:04:05Z', auth: 'none', models: null, usage: 'unknown' }));
  }));
  render(() => <CodexSettings />);
  expect(await screen.findByText('Codex CLI をインストールしてください')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(await screen.findByText('Codex にログインしてください')).toBeTruthy();
  expect(screen.getByText('/usr/bin/codex')).toBeTruthy();
  expect(screen.getByText('1.2.3')).toBeTruthy();
  expect(calls).toBe(2);
});

it('keeps task histories separate and displays streamed status and interruption', async () => {
  const status = { installed: true, auth: 'chatgpt', models: [{ id: 'test', name: 'Test' }], usage: 'unknown' };
  let streaming = false;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === '/api/codex/status') return Promise.resolve(json(status));
    if (url.startsWith('/api/chat?')) return Promise.resolve(json({id:'c', projectId:123, taskId:5, threadId:null, messages: streaming ? [{id:'m',sendId:'s',role:'assistant',content:'途中の回答',provider:'codex',model:'test',status:'streaming'}] : []}));
    if (url === '/api/chat/send') { expect(JSON.parse(String(init?.body))).toEqual({projectId:123,taskId:5,content:'質問',model:'test'}); streaming = true; return Promise.resolve(json({})); }
    if (url === '/api/chat/interrupt') { expect(JSON.parse(String(init?.body))).toEqual({projectId:123,taskId:5}); return Promise.resolve(json({})); }
    throw new Error(url);
  }));
  render(() => <ChatPanel projectId={123} taskId={5} />);
  fireEvent.input(screen.getByRole('textbox', { name:'希望や回答を入力' }), {target:{value:'質問'}});
  await waitFor(() => expect((screen.getByRole('button', {name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', {name:'送信'}));
  expect(await screen.findByText('途中の回答')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name:'中断'}));
  await waitFor(() => expect(requests).toContain('/api/chat/interrupt'));
  expect(requests).toContain('/api/chat?projectId=123&taskId=5');
});

it('shows existing task messages as read-only history', async () => {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(json(url === '/api/codex/status' ? {installed:false,auth:'unknown',models:null,usage:'unknown'} : {id:'c',projectId:11,taskId:9,threadId:null,messages:[]}))));
  render(() => <ChatPanel projectId={11} taskId={9} legacyMessages={[{id:1,role:'user',content:'以前の依頼'}]} />);
  expect(screen.getByRole('region', {name:'以前の履歴'}).textContent).toContain('以前の依頼');
  expect(screen.getByText('以前の履歴（読み取り専用）')).toBeTruthy();
});


it('uses scoped change events and reconciles message nodes without flicker or overlapping snapshots',async()=>{
 FakeEventSource.instances=[];vi.stubGlobal('EventSource',FakeEventSource);
 let content='First response',calls=0,release:((value:Response)=>void)|undefined;
 const snapshot=()=>json({id:'stable-chat',projectId:44,taskId:4,messages:[{id:'stable-message',role:'assistant',content,provider:'codex',status:'streaming'}]});
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/codex/status')return Promise.resolve(json({installed:false,models:[],auth:'none'}));
  calls++;if(calls===3)return new Promise<Response>(resolve=>{release=resolve});return Promise.resolve(snapshot());
 }));
 render(()=><ChatPanel projectId={44} taskId={4}/>);
 const paragraph=await screen.findByText('First response');const article=paragraph.closest('article');
 const events=FakeEventSource.instances[0];expect(events.url).toBe('/api/chat/events?projectId=44&taskId=4');
 events.change();await waitFor(()=>expect(calls).toBe(2));
 expect(screen.getByText('First response').closest('article')).toBe(article);
 events.change();await waitFor(()=>expect(release).toBeDefined());
 events.change();events.change();events.change();expect(calls).toBe(3);
 content='Updated response';release!(snapshot());
 await screen.findByText('Updated response');await waitFor(()=>expect(calls).toBe(4));
 expect(screen.getByText('Updated response').closest('article')).toBe(article);
 cleanup();expect(events.closed).toBe(true);
});
