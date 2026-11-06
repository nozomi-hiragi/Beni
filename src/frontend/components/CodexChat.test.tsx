import { loadModels, resetModelCache } from '../model-cache';
import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel';
import CodexSettings from './CodexSettings';
import { FakeWebSocket, packResponse, testPack } from '../test-events';

const json = (data: unknown) => ({ ok: true, json: async () => data }) as Response;
beforeEach(() => { resetModelCache(); localStorage.clear(); FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('refreshes installation and login state without starting login', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/claude/status') return Promise.resolve(json({installed:false,auth:'none',models:[]}));
    expect(url).toBe('/api/codex/status');
    calls++;
    if (calls === 1) {
      expect(init?.method).toBeUndefined();
      return Promise.resolve(json({ installed: false, auth: 'unknown', models: null, usage: 'unknown' }));
    }
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{}');
    return Promise.resolve(json({ installed: true, path: '/usr/bin/codex', version: '1.2.3', checkedAt: '2026-01-02T03:04:05Z', auth: 'none', models: null, usage: {observedAt:'2026-01-02T03:04:05Z',windows:[{label:'週間',usedPercent:25}]} }));
  }));
  render(() => <CodexSettings />);
  expect(await screen.findByText('Codex CLI をインストールしてください')).toBeTruthy();
  await waitFor(() => expect((screen.getByRole('button', { name: 'Codex の接続状態を更新' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Codex の接続状態を更新' }));
  expect(await screen.findByText('Codex にログインしてください')).toBeTruthy();
  expect(screen.getByText('/usr/bin/codex')).toBeTruthy();
  expect(screen.getByText('1.2.3')).toBeTruthy();
  expect(screen.getByText('残り 75%')).toBeTruthy();
  expect(calls).toBe(2);
});

it('keeps task histories separate and displays streamed status and interruption', async () => {
  const status = { installed: true, auth: 'chatgpt', models: [{ id: 'test', name: 'Test' }], usage: 'unknown' };
  let streaming = false;
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    requests.push(url);
    if (url === '/api/codex/status') return Promise.resolve(json(status));
    if (url.startsWith('/api/chat?')) return Promise.resolve(json({id:'c', projectId:'019a0000-0000-7000-8000-00000000007b', taskId:'019a0000-0000-7100-8000-000000000005', threadId:null, selectedModel:{id:'test',name:'Test'}, messages: streaming ? [{id:'m',sendId:'s',role:'assistant',content:'途中の回答',provider:'codex',model:'test',status:'streaming'}] : []}));
    const pack = packResponse(url, streaming ? [{id:'m', role:'assistant', content:'途中の回答'}] : []); if (pack) return Promise.resolve(pack);
    if (url === '/api/chat/send') { expect(JSON.parse(String(init?.body))).toEqual({projectId:'019a0000-0000-7000-8000-00000000007b',taskId:'019a0000-0000-7100-8000-000000000005',phase:'requirements',content:'質問',model:'test',provider:'codex'}); streaming = true; return Promise.resolve(json({})); }
    if (url === '/api/chat/interrupt') { expect(JSON.parse(String(init?.body))).toEqual({projectId:'019a0000-0000-7000-8000-00000000007b',taskId:'019a0000-0000-7100-8000-000000000005',phase:'requirements'}); return Promise.resolve(json({})); }
    throw new Error(url);
  }));
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-00000000007b'} taskId={'019a0000-0000-7100-8000-000000000005'} />);
  fireEvent.input(screen.getByRole('textbox', { name:'希望や回答を入力' }), {target:{value:'質問'}});
  await waitFor(() => expect((screen.getByRole('button', {name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', {name:'送信'}));
  expect(await screen.findByText('途中の回答')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name:'中断'}));
  await waitFor(() => expect(requests).toContain('/api/chat/interrupt'));
  expect(requests).toContain('/api/chat?projectId=019a0000-0000-7000-8000-00000000007b&taskId=019a0000-0000-7100-8000-000000000005&phase=requirements');
});

it('shows previous task history from the saved pack API', async () => {
  const previous=[{id:'previous-request',role:'user',content:'以前の依頼'}];
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(packResponse(url,previous) ?? json(url === '/api/codex/status' ? {installed:false,auth:'unknown',models:null,usage:'unknown'} : {id:'c',projectId:'019a0000-0000-7000-8000-00000000000b',taskId:'019a0000-0000-7100-8000-000000000009',threadId:null,messages:[]}))));
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-00000000000b'} taskId={'019a0000-0000-7100-8000-000000000009'} />);
  const request=await screen.findByText('以前の依頼');
  expect(request.closest('article')?.classList.contains('chat-end')).toBe(true);
  expect(screen.queryByRole('region',{name:'以前の履歴'})).toBeNull();
});


it('streams pack deltas without fetching conversation snapshots, then confirms without duplicating nodes', async () => {
  FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket);
  let packs = [testPack('Initial', {packId: 'initial'})];
  let conversationCalls = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/codex/status') return Promise.resolve(json({installed: false, models: [], auth: 'none'}));
    if (url.startsWith('/api/chat?')) { conversationCalls++; return Promise.resolve(json({id: 'stable', messages: []})); }
    if (url.endsWith('/ack')) return Promise.resolve(json({matched: true}));
    if (url.startsWith('/api/chat/packs?')) {
      const after = new URL(url, 'http://localhost').searchParams.get('afterPackId');
      return Promise.resolve(json({packs: packs.slice(after ? packs.findIndex(pack => pack.packId === after) + 1 : 0).map(pack => ({packId: pack.packId, state: pack.state}))}));
    }
    return Promise.resolve(json({pack: packs.find(pack => url.includes(`/packs/${pack.packId}?`))}));
  });
  vi.stubGlobal('fetch', fetchMock);
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-00000000002c'} taskId={'019a0000-0000-7100-8000-000000000004'} />);
  const initial = await screen.findByText('Initial');
  const socket = FakeWebSocket.instances[0];
  await waitFor(() => expect(socket.subscriptions.size).toBe(1));
  expect(String(socket.url)).toContain('/api/ws');
  await waitFor(() => expect(conversationCalls).toBeGreaterThanOrEqual(2));
  const before = conversationCalls;
  const pack = testPack('First response', {packId: 'streamed', sequence: 2, state: 'streaming', status: 'streaming'});
  const {content, tool, ...header} = pack;
  socket.event('chat', {name:'chat.pack.delta', data:{packId:pack.packId, delta:'First ', header}});
  const paragraph = await screen.findByText('First'), article = paragraph.closest('article');
  socket.event('chat', {name:'chat.pack.delta', data:{packId:pack.packId, delta:'response', header}});
  expect(screen.getByText('First response').closest('article')).toBe(article);
  expect(conversationCalls).toBe(before);
  packs = [packs[0], {...pack, state:'closed', status:'completed'}];
  socket.event('chat', {name:'chat.pack.closed', data:{packId:pack.packId, header:{...header,state:'closed',status:'completed'}}});
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/ack'))).toBe(true));
  await waitFor(() => expect(screen.getByText('First response').closest('article')?.textContent).toContain('完了'));
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/packs/streamed?'))).toBe(false);
  socket.event('chat', {name:'chat.pack.delta',data:{packId:pack.packId,delta:'Late',header}});
  expect(screen.getByText('First response').closest('article')).toBe(article);
  expect(screen.getByText('Initial')).toBe(initial);
  cleanup(); expect(socket.closed).toBe(true);
});


it('shows the final turn failure even when the saved text pack completed before the turn failed', async () => {
  const pack = testPack('Saved explanation', {packId:'early-completed'});
  let failed = false;
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}]}));
    if (url.startsWith('/api/chat?')) return Promise.resolve(json({id:'failed-turn',selectedModel:{id:'test',name:'Test'},messages:[{id:'assistant',role:'assistant',status:failed?'failed':'streaming',content:pack.content}]}));
    if (url.startsWith('/api/chat/packs?')) return Promise.resolve(json({packs:url.includes('afterPackId')?[]:[{packId:pack.packId,state:'closed'}]}));
    return Promise.resolve(json({pack}));
  }));
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-000000000037'} taskId={'019a0000-0000-7100-8000-000000000006'} />);
  const paragraph = await screen.findByText('Saved explanation'), article = paragraph.closest('article');
  expect(article?.textContent).toContain('完了');
  const socket = FakeWebSocket.instances[0];
  await waitFor(() => expect(socket.subscriptions.size).toBe(1));
  failed = true; socket.change();
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('直近の応答: 失敗'));
  expect(screen.getAllByText('Saved explanation')).toHaveLength(1);
  expect(screen.getByText('Saved explanation').closest('article')).toBe(article);
  expect(article?.textContent).toContain('完了');
  expect(screen.queryByRole('button',{name:'中断'})).toBeNull();
});


it('follows streamed content only at the bottom and resets following when the scope changes', async () => {
  let resize: () => void = () => {};
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(0)); };
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/codex/status') return Promise.resolve(json({installed:false,auth:'none',models:[]}));
    if (url.startsWith('/api/chat?')) return Promise.resolve(json({id:'scroll',messages:[]}));
    return Promise.resolve(packResponse(url, [])!);
  }));
  const [taskId, setTaskId] = createSignal('019a0000-0000-7100-8000-00000000003d');
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-00000000003d'} taskId={taskId()} />);
  const log = screen.getByRole('log', {name:'チャット履歴'});
  let height = 1000, viewport = 300;
  Object.defineProperties(log, {scrollHeight:{get:()=>height},clientHeight:{get:()=>viewport}});
  flush();
  expect(log.scrollTop).toBe(700);
  const socket = FakeWebSocket.instances[0];
  await waitFor(() => expect(socket.subscriptions.size).toBe(1));
  const pack = testPack('', {packId:'scrolling',status:'streaming',state:'streaming'});
  const {content, tool, ...header} = pack;
  socket.event('chat', {name:'chat.pack.delta',data:{packId:pack.packId,delta:'Growing response',header}});
  expect(await screen.findByText('Growing response')).toBeTruthy();
  height = 1200; resize(); resize();
  expect(frames.size).toBe(1);
  flush(); expect(log.scrollTop).toBe(900);
  height = 1400; resize();
  log.scrollTop = 500; fireEvent.scroll(log);
  flush(); expect(log.scrollTop).toBe(500);
  height = 1600; resize(); flush(); expect(log.scrollTop).toBe(500);
  log.scrollTop = 1300; fireEvent.scroll(log); flush();
  height = 1800; resize(); flush(); expect(log.scrollTop).toBe(1500);
  viewport = 250; resize(); flush(); expect(log.scrollTop).toBe(1550);
  log.scrollTop = 500; fireEvent.scroll(log);
  viewport = 200; resize(); flush(); expect(log.scrollTop).toBe(500);
  setTaskId('019a0000-0000-7100-8000-00000000003e'); flush(); expect(log.scrollTop).toBe(1600);
  cleanup(); expect(disconnect).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
});

it.each(['completed', 'interrupted', 'failed'] as const)('keeps Aura visible during tool work until the turn is %s', async outcome => {
  let working = true;
  const pack = testPack('', {packId:`tool-${outcome}`,sequence:3,kind:'tool',tool:{name:'read_file',input:'notes.md',output:'Task notes'}});
  const earlier=testPack('Earlier request',{packId:`earlier-${outcome}`,role:'user'});
  const user = testPack('New request', {packId:`user-${outcome}`,sequence:2,role:'user'});
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}]}));
    if (url.startsWith('/api/chat?')) return Promise.resolve(json({id:`tool-turn-${outcome}`,selectedModel:{id:'test',name:'Test'},messages:[{id:'assistant',role:'assistant',status:working?'streaming':outcome,content:''}]}));
    if (url.startsWith('/api/chat/packs?')) return Promise.resolve(json({packs:url.includes('afterPackId')?[]:[earlier,user,pack].map(item => ({packId:item.packId,state:item.state}))}));
    return Promise.resolve(json({pack:url.includes(`/packs/${earlier.packId}?`)?earlier:url.includes(`/packs/${user.packId}?`)?user:pack}));
  }));
  const taskId = `019a0000-0000-7100-8000-00000000000${['completed','interrupted','failed'].indexOf(outcome) + 7}`;
  render(() => <ChatPanel phase="requirements" projectId={'019a0000-0000-7000-8000-000000000047'} taskId={taskId} />);
  const tool = await screen.findByText('read_file');
  const article = tool.closest('article')!;
  const details = tool.closest('details')!;
  details.open = true;
  expect(article.classList.contains('chat-start')).toBe(true);
  expect(tool.closest('.chat-bubble')?.classList.contains('bg-base-200')).toBe(true);
  expect(article.querySelector('.chat-header')?.textContent).toContain('アシスタント');
  expect(article.querySelector('.chat-footer')?.textContent).toBe('完了');
  const legacy = screen.getByText('Earlier request');
  expect(legacy.closest('article')?.classList.contains('chat-end')).toBe(true);
  expect(legacy.closest('.chat-bubble')?.classList.contains('chat-bubble-primary')).toBe(true);
  const request = await screen.findByText('New request');
  expect(request.closest('article')?.classList.contains('chat-end')).toBe(true);
  expect(request.closest('.chat-bubble')?.classList.contains('chat-bubble-primary')).toBe(true);
  const indicator = await screen.findByText('作業中…');
  expect(indicator.closest('.aura')).toBeTruthy();
  expect(indicator.closest('[role="log"]')).toBeNull();
  expect(screen.getByRole('button',{name:'中断'})).toBeTruthy();
  const socket = FakeWebSocket.instances[0];
  await waitFor(() => expect(socket.subscriptions.size).toBe(1));
  socket.change();
  await waitFor(() => expect(screen.getByText('作業中…')).toBe(indicator));
  working = false; socket.change();
  await waitFor(() => expect(screen.queryByText('作業中…')).toBeNull());
  expect(screen.queryByRole('button',{name:'中断'})).toBeNull();
  expect(screen.getByText('read_file').closest('article')).toBe(article);
  expect(details.open).toBe(true);
});

it('isolates phase history, drafts, requests and subscriptions and ignores a late previous-phase load', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000088', taskId = '019a0000-0000-7100-8000-000000000088';
  const [phase, setPhase] = createSignal<'requirements' | 'documents'>('requirements');
  let release: ((value: Response) => void) | undefined;
  let delay = false;
  const requests: {url: string; body?: Record<string, unknown>}[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    requests.push({url, body: init?.body ? JSON.parse(String(init.body)) : undefined});
    if (url === '/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}]}));
    const current = new URL(url, 'http://localhost').searchParams.get('phase');
    if (url.startsWith('/api/chat?')) {
      if (delay && current === 'documents') return new Promise<Response>(resolve => { release = resolve; });
      return Promise.resolve(json({id:current,selectedModel:{id:'test',name:'Test'},messages:[]}));
    }
    if (url === '/api/chat/send') return Promise.resolve(json({}));
    const pack = testPack(`${current} history`, {packId:`phase-${current}`});
    if (url.startsWith('/api/chat/packs?')) return Promise.resolve(json({packs:url.includes('afterPackId') ? [] : [{packId:pack.packId,state:'closed'}]}));
    return Promise.resolve(json({pack}));
  }));
  render(() => <ChatPanel projectId={projectId} taskId={taskId} phase={phase()} />);
  await screen.findByText('requirements history');
  const textarea = () => screen.getByRole('textbox', {name:'希望や回答を入力'}) as HTMLTextAreaElement;
  fireEvent.input(textarea(), {target:{value:'requirements draft'}});
  delay = true; setPhase('documents');
  await screen.findByText('documents history');
  expect(screen.queryByText('requirements history')).toBeNull();
  expect(textarea().value).toBe('');
  fireEvent.input(textarea(), {target:{value:'documents draft'}});
  setPhase('requirements');
  expect(await screen.findByText('requirements history')).toBeTruthy();
  expect(textarea().value).toBe('requirements draft');
  release?.(json({id:'late',messages:[{role:'assistant',status:'streaming'}]}));
  await waitFor(() => expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'送信'}));
  await waitFor(() => expect(requests.some(request => request.body?.content === 'requirements draft' && request.body.phase === 'requirements')).toBe(true));
  delay = false; setPhase('documents');
  await waitFor(() => expect(textarea().value).toBe('documents draft'));
  const socket = FakeWebSocket.instances.find(socket => !socket.closed)!;
  await waitFor(() => expect([...socket.subscriptions.values()].filter(sub => sub.topic === 'chat').map(sub => sub.scope.phase)).toEqual(['documents']));
});

it('モデル保存前に始まった遅い履歴取得で選択を巻き戻さない',async()=>{
 let selected='a', stale=false;
 let resolveOld!:(response:Response)=>void;
 const old=new Promise<Response>(resolve=>{resolveOld=resolve;});
 const snapshot=(id:string)=>json({id:'race',messages:[],selectedModel:{id,name:id}});
 vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
  if(url==='/api/codex/status')return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'a'},{id:'b',name:'b'}]}));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?')){if(stale){stale=false;return old;}return Promise.resolve(snapshot(selected));}
  if(url==='/api/chat/model'){selected=JSON.parse(String(init?.body)).model;return Promise.resolve(snapshot(selected));}
  throw Error(url);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000abc" />);
 const model=screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement;
 await waitFor(()=>expect(model.value).toBe('codex:a'));
 const socket=FakeWebSocket.instances[0];
 await waitFor(()=>expect(socket.subscriptions.size).toBe(1));
 stale=true;socket.event('chat',{name:'chat.changed',data:{}});
 fireEvent.change(model,{target:{value:'codex:b'}});
 await waitFor(()=>expect(model.value).toBe('codex:b'));
 expect(selected).toBe('a');
 resolveOld(snapshot('a'));
 await waitFor(()=>expect(model.value).toBe('codex:b'));
 fireEvent.input(screen.getByRole('textbox',{name:'希望や回答を入力'}),{target:{value:'hello'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
 expect(model.value).toBe('codex:b');
});

it('保存モデルが先に届いても後から追加したモデル一覧で選択表示を一致させる',async()=>{
 let release!:(response:Response)=>void;
 const status=new Promise<Response>(resolve=>{release=resolve;});
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/codex/status')return status;
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'late-models',messages:[],selectedModel:{id:'b',name:'Model B'}}));
  throw Error(url);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000abd" />);
 await screen.findByRole('option',{name:'⚠️ Codex/Model B'});
 release(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'Model A'},{id:'b',name:'Model B'}]}));
 await waitFor(()=>expect((screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement).value).toBe('codex:b'));
 expect((await screen.findByRole('option',{name:'Codex/Model B'}) as HTMLOptionElement).selected).toBe(true);
});

it('一覧取得を共有し通常フェーズ移動では選択を即復元し、警告フェーズだけ再同期する',async()=>{
 const [phase,setPhase]=createSignal<'requirements'|'documents'>('requirements');
 const projectId='019a0000-0000-7000-8000-000000000ac0';
 let models=[{id:'a',name:'A'},{id:'b',name:'B'}],calls=0;
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  requests.push(url);
  if(url==='/api/codex/status'){calls++;return Promise.resolve(json({installed:true,auth:'chatgpt',models}));}
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:phase(),messages:[],selectedModel:phase()==='documents'?{id:'missing',name:'Missing'}:{id:'a',name:'A'}}));
  throw Error(url);
 }));
 render(()=><ChatPanel projectId={projectId} taskId="019a0000-0000-7100-8000-000000000ac0" phase={phase()}/>);
 const select=screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement;
 await waitFor(()=>expect(select.value).toBe('codex:a'));
 fireEvent.change(select,{target:{value:'codex:b'}});
 expect(select.value).toBe('codex:b');expect(calls).toBe(1);
 setPhase('documents');
 await screen.findByRole('option',{name:'⚠️ Codex/Missing'});
 await waitFor(()=>expect(calls).toBe(2));
 await loadModels();
 setPhase('requirements');expect(select.value).toBe('codex:b');expect(calls).toBe(2);
 models=[...models,{id:'missing',name:'Missing'}];
 setPhase('documents');expect(select.value).toBe('codex:missing');
 await waitFor(()=>expect(calls).toBe(3));
 await screen.findByRole('option',{name:'Codex/Missing'});
 expect(requests.filter(url=>url==='/api/chat/model')).toHaveLength(0);
});

it.each(['MODEL_UNAVAILABLE',undefined])('受理前エラー%sではモデル不可だけ警告にして追記を保持する',async(code)=>{
 let release!:(response:Response)=>void;
 const response=new Promise<Response>(resolve=>{release=resolve;});
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/codex/status')return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'A'},{id:'b',name:'B'}]}));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'preflight',messages:[],selectedModel:{id:'a',name:'A'}}));
  if(url==='/api/chat/send')return response;
  throw Error(url);
 }));
 render(()=><ChatPanel projectId={`019a0000-0000-7000-8000-${code?'000000000ac1':'000000000ac2'}`} />);
 const text=screen.getByRole('textbox',{name:'希望や回答を入力'}) as HTMLTextAreaElement;
 fireEvent.input(text,{target:{value:'original'}});
 const send=screen.getByRole('button',{name:'送信'}) as HTMLButtonElement;
 await waitFor(()=>expect(send.disabled).toBe(false));fireEvent.click(send);
 fireEvent.input(text,{target:{value:'new note'}});
 release({ok:false,status:code?400:500,json:async()=>({error:'rejected',code})} as Response);
 await screen.findByRole('alert');
 if(code){expect(text.value).toBe('original\nnew note');expect(send.disabled).toBe(true);await screen.findByRole('option',{name:'⚠️ Codex/A'});fireEvent.change(screen.getByRole('combobox'),{target:{value:'codex:b'}});expect(send.disabled).toBe(false);}
 else{expect(text.value).toBe('new note');expect(send.disabled).toBe(false);expect(screen.queryByRole('option',{name:'⚠️ Codex/A'})).toBeNull();}
});

it('受理後のモデル拒否は元フェーズの送信IDへ一度だけ復元し、古い拒否で新選択を戻さない',async()=>{
 const [phase,setPhase]=createSignal<'requirements'|'documents'>('requirements');
 let rejected=false,accepted=false;
 const messages=()=>accepted?[{id:'u',sendId:'send-unique',role:'user',content:'original',status:'completed',model:'a'},{id:'a',sendId:'send-unique',role:'assistant',content:'',status:rejected?'failed':'streaming',model:'a',...(rejected?{errorCode:'MODEL_UNAVAILABLE'}:{})}]:[];
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/codex/status')return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'A'},{id:'b',name:'B'}]}));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:phase(),messages:phase()==='requirements'?messages():[],selectedModel:{id:'a',name:'A'}}));
  if(url==='/api/chat/send'){accepted=true;return Promise.resolve(json({messages:messages()}));}
  throw Error(url);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000ac3" taskId="019a0000-0000-7100-8000-000000000ac3" phase={phase()}/>);
 const text=()=>screen.getByRole('textbox',{name:'希望や回答を入力'}) as HTMLTextAreaElement;
 fireEvent.input(text(),{target:{value:'original'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'送信'}));
 await waitFor(()=>expect(text().value).toBe(''));
 fireEvent.input(text(),{target:{value:'new note'}});
 setPhase('documents');rejected=true;setPhase('requirements');
 await waitFor(()=>expect(text().value).toBe('original\nnew note'));
 await screen.findByRole('option',{name:'⚠️ Codex/A'});
 fireEvent.change(screen.getByRole('combobox'),{target:{value:'codex:b'}});
 const socket=FakeWebSocket.instances.find(socket=>!socket.closed)!;
 socket.event('chat',{name:'chat.changed',data:{}});
 await waitFor(()=>expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('codex:b'));
 expect(text().value).toBe('original\nnew note');
 expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false);
});

it('同時パネルは一覧取得を共有し、ローカル選択は再初期化後も古い履歴より優先する',async()=>{
 let release!:(response:Response)=>void;
 let calls=0;
 const pending=new Promise<Response>(resolve=>{release=resolve;});
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/codex/status'){calls++;return calls===1?pending:Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'A'},{id:'b',name:'B'}]}));}
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'cached',messages:[],selectedModel:{id:'a',name:'A'}}));
  throw Error(url);
 }));
 const first='019a0000-0000-7000-8000-000000000ac4',second='019a0000-0000-7000-8000-000000000ac5';
 render(()=><><ChatPanel projectId={first}/><ChatPanel projectId={second}/></>);
 expect(calls).toBe(1);
 release(json({installed:true,auth:'chatgpt',models:[{id:'a',name:'A'},{id:'b',name:'B'}]}));
 await waitFor(()=>expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('codex:a'));
 fireEvent.change(screen.getAllByRole('combobox')[0]!,{target:{value:'codex:b'}});
 cleanup();resetModelCache();
 render(()=><ChatPanel projectId={first}/>);
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('codex:b');
 await screen.findByRole('option',{name:'Codex/B'});
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('codex:b');
 expect(calls).toBe(2);
});

it('requires instruction focus and sends the selection captured at submit', async () => {
 const sent:unknown[]=[];
 vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
  if(url==='/api/codex/status') return Promise.resolve(json({installed:true,auth:'chatgpt',models:[{id:'test',name:'Test'}]}));
  if(url==='/api/claude/status') return Promise.resolve(json({installed:false,auth:'none',models:[]}));
  if(url==='/api/chat/send'){sent.push(JSON.parse(String(init?.body)));return Promise.resolve(json({messages:[]}));}
  return Promise.resolve(packResponse(url,[])??json({id:'focus-chat',projectId:'instructions',taskId:null,selectedModel:{id:'test',name:'Test',provider:'codex'},messages:[]}));
 }));
 const [focus,setFocus]=createSignal<string|null>(null);
 render(()=> <ChatPanel projectId="instructions" instructionFocus={focus()} instructionFocusLabel={focus()==='common'?'全共通':undefined}/>);
 fireEvent.input(screen.getByRole('textbox',{name:'希望や回答を入力'}),{target:{value:'指示を整えて'}});
 await screen.findByRole('option',{name:'Codex/Test'});
 const submit=screen.getByRole('button',{name:'送信'}) as HTMLButtonElement;
 expect(submit.disabled).toBe(true);
 expect(screen.getByText('フォーカス: 未選択')).toBeTruthy();
 fireEvent.submit(submit.closest('form')!);
 expect(sent).toHaveLength(0);
 setFocus('common');
 await waitFor(()=>expect(submit.disabled).toBe(false));
 expect(screen.getByText('フォーカス: 全共通')).toBeTruthy();
 fireEvent.click(submit);
 setFocus('editor');
 await waitFor(()=>expect(sent).toHaveLength(1));
 expect(sent[0]).toMatchObject({projectId:'instructions',instructionFocus:'common',content:'指示を整えて'});
});
