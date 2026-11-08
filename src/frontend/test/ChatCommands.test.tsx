import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modelStatus, resetModelCache } from '../shared/model-cache';
import { chatModelPicker, FakeWebSocket, packResponse, stubLegacyAgentFetch } from './test-events';
import type { ChatCommand } from '../../shared/chat-commands';
import type { ChatMessage, Conversation } from '../shared/types';
import ChatPanel, { type ChatTabStatus } from '../shared/components/ChatPanel';

const json = (data: unknown, status = 200) => ({ok: status < 400, status, json: async () => data}) as Response;
let serial = 0;
beforeEach(() => { resetModelCache(); localStorage.clear(); FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(options: {noModels?: boolean; claude?: boolean; taskId?: string; messages?: ChatMessage[]; instructions?: boolean; instructionFocus?: string; readOnly?: boolean; command?: ChatCommand; working?: boolean; tabStatus?: boolean; commandResponse?: () => Promise<Response>; contextResponse?: (init?: RequestInit) => Promise<Response>; contextUsage?: {usedTokens:number;maxTokens:number}} = {}) {
  const projectId = options.instructions ? 'instructions' : `commands-${++serial}`;
  const snapshot: Conversation = {id:`conversation-${++serial}`,projectId,taskId:options.taskId ?? null,threadId:'saved-thread',sessionProvider:'codex',selectedModel:options.noModels ? null : {id:'test',name:'Test',provider:'codex'},contextUsage:options.contextUsage,messages: options.messages ?? (options.working ? [{id:'assistant',sendId:'send',role:'assistant',content:'',provider:'codex',model:'test',createdAt:'',updatedAt:'',status:'streaming'}] : []),command:options.command};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/codex/status') return json({installed:true,auth:'chatgpt',models: options.noModels ? [] : [{id:'test',name:'Test'}]});
    if (url === '/api/claude/status') return json({installed:!!options.claude,auth:options.claude ? 'claude' : 'none',models:options.claude ? [{id:'sonnet',name:'Sonnet'}] : []});
    if (url.startsWith('/api/chat?')) return json({...snapshot});
    const packs = packResponse(url, snapshot.messages); if (packs) return packs;
    if (url === '/api/chat/context-usage') return options.contextResponse?.(init) ?? json({});
    if (url === '/api/chat/commands') {
      if (options.commandResponse) return options.commandResponse();
      const name = JSON.parse(String(init?.body)).command;
      snapshot.command = {id:'command-1',name,status:name === 'clear' ? 'completed' : 'running'};
      if (name === 'clear') { snapshot.id = `reset-${serial}`; snapshot.messages = []; }
      return json({command:snapshot.command}, 202);
    }
    if (url === '/api/chat/send' || url === '/api/chat/interrupt') return json({});
    throw new Error(`${url}: ${init?.method}`);
  });
  stubLegacyAgentFetch(fetchMock);
  const onBusyChange = vi.fn();
  const onTabStatusChange = vi.fn<(taskId: string | undefined, status: ChatTabStatus, failed?: boolean) => void>();
  const tabStatus = () => onTabStatusChange.mock.lastCall?.[1];
  const [scope,setScope] = createSignal(projectId);
  render(() => <ChatPanel projectId={scope()} taskId={options.taskId} phase={options.taskId ? 'requirements' : undefined} instructionFocus={options.instructionFocus} onTabStatusChange={options.tabStatus ? onTabStatusChange : undefined} readOnly={options.readOnly} onBusyChange={onBusyChange} />);
  await waitFor(() => expect(FakeWebSocket.instances.at(-1)?.subscriptions.size).toBe(1));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/chat?')).length).toBeGreaterThanOrEqual(2));
  await waitFor(() => { expect(modelStatus('codex')).toBeDefined(); expect(modelStatus('claude')).toBeDefined(); });
  return {snapshot, fetchMock, onBusyChange, onTabStatusChange, tabStatus, setScope, socket: FakeWebSocket.instances.at(-1)!};
}
const textarea = () => screen.getByRole('textbox', {name:'希望や回答を入力'}) as HTMLTextAreaElement;
const input = (value: string) => fireEvent.input(textarea(), {target:{value}});
const submit = () => fireEvent.submit(textarea().closest('form')!);
const commandMenu = () => screen.getByRole('button', {name:'コマンド'});
const menuItem = (category: string, name: string) => {
  fireEvent.click(commandMenu());
  fireEvent.click(screen.getByText(category, {selector:'summary'}));
  return screen.getByRole('button', {name});
};

it('executes compact from the context gauge and preserves the draft', async () => {
  const {fetchMock, onTabStatusChange, tabStatus} = await setup({taskId:'task-example', tabStatus:true});
  input('送信前の下書き');
  const gauge = screen.getByRole('img', {name:/コンテキスト:/});
  fireEvent.contextMenu(gauge);
  const compact = screen.getByRole('menuitem', {name:'圧縮'});
  fireEvent.click(commandMenu()); fireEvent.click(screen.getByText('会話操作', {selector:'summary'}));
  expect(screen.getByRole('button', {name:'/clear · 履歴を残して新しい会話'})).toBeTruthy();
  expect(screen.queryByRole('button', {name:'/compact · 会話を圧縮'})).toBeNull();
  expect(screen.queryByText('画面操作', {selector:'summary'})).toBeNull();
  expect(tabStatus()?.disabled).toBe(false);
  expect(onTabStatusChange.mock.lastCall?.[0]).toBe('task-example');
  expect(commandCalls(fetchMock)).toHaveLength(0);
  fireEvent.click(compact);
  await screen.findByText('圧縮中…');
  expect(commandCalls(fetchMock)).toHaveLength(1);
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({command:'compact',args:''});
  expect(commandMenu().getAttribute('aria-expanded')).toBe('false');
  expect((commandMenu() as HTMLButtonElement).disabled).toBe(true);
  expect(textarea().value).toBe('送信前の下書き');
});

it('sends a generation command from the composer menu and keeps the draft when its model is rejected asynchronously', async () => {
  const {fetchMock,snapshot,socket} = await setup({tabStatus:true});
  const user: ChatMessage = {...message('/review'), role:'user', sendId:'menu-send'};
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url,init) => url === '/api/chat/send' ? json({messages:[user]}) : original(url,init));
  input('別の依頼の下書き');
  fireEvent.click(menuItem('生成', '/review · 変更をレビュー'));
  await waitFor(() => expect(commandCalls(fetchMock)).toHaveLength(1));
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({content:'/review',provider:'codex',model:'test'});
  await waitFor(() => expect((commandMenu() as HTMLButtonElement).disabled).toBe(false));
  expect(textarea().value).toBe('別の依頼の下書き');
  snapshot.messages = [user,{...message(''),sendId:'menu-send',status:'failed',errorCode:'MODEL_UNAVAILABLE'}]; socket.change();
  await screen.findByText('選択したモデルを利用できません。別のモデルを選択してください。');
  expect(textarea().value).toBe('別の依頼の下書き');
});

it('filters menu categories and items by conversation scope and provider', async () => {
  await setup({instructions:true,claude:true});
  fireEvent.click(commandMenu());
  expect(screen.queryByText('生成', {selector:'summary'})).toBeNull();
  expect(screen.queryByText('/context · コンテキストの使用状況')).toBeNull();
  expect(screen.queryByText('/rename · 名前を変更')).toBeNull();
  expect(screen.queryByText('画面操作', {selector:'summary'})).toBeNull();
  fireEvent.keyDown(commandMenu(), {key:'Escape'});
  expect(commandMenu().getAttribute('aria-expanded')).toBe('false');
  choose('Claude/Sonnet');
  expect(menuItem('会話操作', '/usage · 使用量を表示')).toBeTruthy();
  expect(screen.queryByText('/context · コンテキストの使用状況')).toBeNull();
  fireEvent.pointerDown(textarea());
  expect(commandMenu().getAttribute('aria-expanded')).toBe('false');
});

it('offers remaining prefix matches and accepts click, Tab and an explicitly selected Enter without sending', async () => {
  const { fetchMock } = await setup();
  input('/');
  expect(screen.getByRole('listbox', {name:'スラッシュコマンド'})).toBeTruthy();
  expect(screen.queryByRole('option', {name:'/compact · 会話を圧縮'})).toBeNull();
  input('/rec'); fireEvent.keyDown(textarea(), {key:'Tab'});
  expect(textarea().value).toBe('/recap');
  input('/rec'); fireEvent.keyDown(textarea(), {key:'ArrowDown'});
  expect(screen.getByRole('option', {name:'/recap · 会話を要約'}).getAttribute('aria-selected')).toBe('true');
  expect(textarea().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', {name:'/recap · 会話を要約'}).id);
  fireEvent.keyDown(textarea(), {key:'Enter'}); expect(textarea().value).toBe('/recap');
  expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/co'); fireEvent.keyDown(textarea(), {key:'Escape'}); expect(screen.queryByRole('listbox')).toBeNull();
  input('/other'); expect(screen.queryByRole('listbox')).toBeNull();
});

it('Enter sends once, while Shift+Enter and IME confirmation keep their native behavior', async () => {
  const { fetchMock } = await setup();
  input('変換した本文');
  const keyDown = (options: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
    fireEvent(textarea(), event);
    return event.defaultPrevented;
  };
  expect(keyDown({ shiftKey: true })).toBe(false);
  expect(keyDown({ isComposing: true })).toBe(false);
  expect(keyDown({ keyCode: 229 })).toBe(false);
  expect(commandCalls(fetchMock)).toHaveLength(0);
  expect(textarea().value).toBe('変換した本文');
  expect(keyDown({})).toBe(true);
  await waitFor(() => expect(commandCalls(fetchMock)).toHaveLength(1));
  expect(JSON.parse(String(commandCalls(fetchMock)[0]?.[1]?.body)).content).toBe('変換した本文');
});

it('rejects compact when typed as a slash command', async () => {
  const {fetchMock} = await setup();
  input('/compact');
  fireEvent.keyDown(textarea(), { key: 'Enter' });
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('Enter respects the send restriction in instruction conversations', async () => {
  const { fetchMock } = await setup({ instructions: true });
  input('編集の相談');
  fireEvent.keyDown(textarea(), { key: 'Enter' });
  expect(commandCalls(fetchMock)).toHaveLength(0);
  expect(textarea().value).toBe('編集の相談');
});

it('sends compact from the gauge through its own API with the selected model', async () => {
  const {fetchMock, snapshot, socket, onBusyChange} = await setup();
  fireEvent.contextMenu(screen.getByRole('img',{name:/コンテキスト:/}));
  fireEvent.click(screen.getByRole('menuitem',{name:'圧縮'}));
  await screen.findByText('圧縮中…');
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/chat/commands');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({projectId:expect.stringMatching(/^commands-/),taskId:null,command:'compact',args:'',provider:'codex',model:'test'});
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  await waitFor(() => expect(textarea().value).toBe('')); expect(onBusyChange).toHaveBeenLastCalledWith(true);
  expect((screen.getByRole('button',{name:'圧縮中...'}) as HTMLButtonElement).disabled).toBe(true);
  expect(chatModelPicker().disabled).toBe(true);
  expect(screen.queryByText('圧縮: 完了')).toBeNull();
  snapshot.command = {...snapshot.command!,status:'completed'}; socket.change();
  await screen.findByText('圧縮: 完了');
  expect(screen.queryByText('圧縮中…')).toBeNull(); expect(onBusyChange).toHaveBeenLastCalledWith(false);
  input('通常の依頼'); expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false);
});

it.each(['/unknown', '/compact extra', '/help', '/model', '/copy', '/export'])('keeps %s out of normal model messages and preserves the input', async command => {
  const {fetchMock} = await setup(); input(command); submit();
  expect(await screen.findByRole('alert')).toBeTruthy(); expect(textarea().value).toBe(command);
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/send' || url === '/api/chat/commands')).toBe(false);
});

it.each(['/tmp/example.txt', '/Users/example/project', '「/compact」を説明して', '普通の質問'])('preserves ordinary message handling for %s', async content => {
  const {fetchMock} = await setup(); input(content); submit();
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(true));
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/commands')).toBe(false);
  expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/api/chat/send')?.[1]?.body)).content).toBe(content);
});

it('preserves input on a rejected compact operation and preserves newer edits after acceptance', async () => {
  let release!: (value: Response) => void;
  const {snapshot,fetchMock} = await setup({commandResponse:() => new Promise(resolve => {release = resolve;})});
  const compact = () => { fireEvent.contextMenu(screen.getByRole('img',{name:/コンテキスト:/})); fireEvent.click(screen.getByRole('menuitem',{name:'圧縮'})); };
  compact();
  await screen.findByText('圧縮中…'); input('新しい下書き');
  release(json({error:'保存されたセッションがありません'},409));
  await screen.findByText('圧縮できませんでした: 保存されたセッションがありません');
  expect(textarea().value).toBe('新しい下書き');
  compact();
  await screen.findByText('圧縮中…'); input('次の下書き');
  snapshot.command = {id:'accepted',name:'compact',status:'running'};
  const loads = fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/chat?')).length;
  release(json({command:snapshot.command},202));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/chat?')).length).toBeGreaterThan(loads));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(textarea().value).toBe('次の下書き');
});

it.each(['failed','interrupted','unknown'] as const)('restores compact activity on mount and displays the %s snapshot', async status => {
  const {snapshot, socket, fetchMock} = await setup({command:{id:'saved-command',name:'compact',status:'running'}});
  expect(await screen.findByText('圧縮中…')).toBeTruthy(); input('/compact'); submit();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/commands')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'中断'}));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/interrupt')).toBe(true));
  snapshot.command = {...snapshot.command!,status,...(status === 'failed' ? {error:'圧縮に失敗しました'} : {})}; socket.change();
  await screen.findByText(status === 'failed' ? '圧縮: 失敗 · 圧縮に失敗しました' : status === 'interrupted' ? '圧縮: 中断' : '圧縮: 結果不明');
  expect(screen.queryByText('圧縮中…')).toBeNull();
});

it('blocks commands during ordinary generation and hides editing in read-only views', async () => {
  const {fetchMock} = await setup({working:true}); input('/compact'); submit();
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/commands')).toBe(false);
  cleanup(); await setup({readOnly:true,command:{id:'read-only-command',name:'compact',status:'running'}});
  expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('button',{name:'中断'})).toBeNull();
  expect(screen.getByText('圧縮中…')).toBeTruthy();
});

it('does not offer compact as a typed command before or after history loads', async () => {
  let release!: (value:Response) => void;
  stubLegacyAgentFetch(vi.fn((url:string) => {
    if (url.startsWith('/api/chat?')) return new Promise<Response>(resolve => {release = resolve;});
    return Promise.resolve(packResponse(url,[]) ?? json({installed:false,auth:'none',models:[]}));
  }));
  render(() => <ChatPanel projectId={`loading-${++serial}`} />); input('/compact');
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
  release(json({id:'loaded',messages:[]}));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
});

it('shows counts and unknown context usage, and scopes compact to the selected session', async () => {
  await setup({claude:true,contextUsage:{usedTokens:1200,maxTokens:800}});
  const gauge = screen.getByRole('img',{name:/コンテキスト:/});
  expect(gauge.textContent).toBe('150%');
  expect(gauge.getAttribute('style')).toContain('--value: 100');
  const tooltipRows = screen.getByRole('tooltip').children;
  expect(tooltipRows).toHaveLength(2);
  expect(tooltipRows[0].textContent).toContain('150%');
  expect(tooltipRows[1].textContent).toContain('1,200 / 800 tokens');
  fireEvent.contextMenu(gauge); const item = screen.getByRole('menuitem',{name:'圧縮'});
  await waitFor(()=>expect(item).toBe(document.activeElement));
  expect(gauge.parentElement?.classList.contains('dropdown-open')).toBe(true);
  fireEvent.keyDown(item,{key:'Escape'});
  expect(screen.queryByRole('menuitem',{name:'圧縮'})).toBeNull();
  expect(gauge).toBe(document.activeElement);
  gauge.focus(); fireEvent.keyDown(gauge,{key:'F10',shiftKey:true});
  expect(await screen.findByRole('menuitem',{name:'圧縮'})).toBeTruthy();
  choose('Claude/Sonnet');
  expect(screen.queryByRole('menuitem',{name:'圧縮'})).toBeNull();
  expect(screen.getByRole('tooltip').textContent).toContain('不明');
});

it('shows missing context counts as unknown', async () => {
  await setup();
  const gauge = screen.getByRole('img',{name:/コンテキスト:/});
  await waitFor(() => expect(gauge.textContent).toBe('?'));
  expect(screen.getByRole('tooltip').textContent).toContain('不明');
});

it('automatically probes once per missing session and retries from the gauge', async () => {
  const requests: ((value: Response) => void)[] = [];
  const {fetchMock, snapshot, socket} = await setup({
    taskId: 'context-task',
    contextResponse: () => new Promise(resolve => requests.push(resolve)),
  });
  const gauge = () => screen.getByRole('img', {name:/コンテキスト:/});
  const calls = () => fetchMock.mock.calls.filter(([url]) => url === '/api/chat/context-usage');
  await waitFor(() => expect(calls()).toHaveLength(1));
  expect(JSON.parse(String(calls()[0][1]?.body))).toEqual({
    projectId: snapshot.projectId, taskId: 'context-task', phase: 'requirements', provider: 'codex', model: 'test',
  });
  expect(gauge().getAttribute('aria-busy')).toBe('true');
  expect(gauge().classList.contains('radial-progress')).toBe(false);
  fireEvent.contextMenu(gauge());
  expect((screen.getByRole('menuitem',{name:'更新'}) as HTMLButtonElement).disabled).toBe(true);
  requests[0](json({}, 500));
  await waitFor(() => expect(gauge().textContent).toBe('?'));
  snapshot.messages = [message('履歴更新')]; socket.change();
  await screen.findByText('履歴更新');
  expect(calls()).toHaveLength(1);

  fireEvent.contextMenu(gauge());
  fireEvent.click(screen.getByRole('menuitem',{name:'更新'}));
  expect(calls()).toHaveLength(2);
  expect(JSON.parse(String(calls()[1][1]?.body))).toMatchObject({refresh:true});
  snapshot.contextUsage = {usedTokens:200,maxTokens:1000};
  requests[1](json({contextUsage:snapshot.contextUsage}));
  await waitFor(() => expect(gauge().textContent).toBe('20%'));
  expect(gauge().classList.contains('radial-progress')).toBe(true);

  fireEvent.contextMenu(gauge());
  fireEvent.click(screen.getByRole('menuitem',{name:'更新'}));
  requests[2](json({}));
  await waitFor(() => expect(gauge().textContent).toBe('20%'));
  snapshot.threadId = 'next-thread'; snapshot.contextUsage = undefined; socket.change();
  await waitFor(() => expect(calls()).toHaveLength(4));
  requests[3](json({}));
  await waitFor(() => expect(gauge().textContent).toBe('?'));
});

const commandCalls = (fetchMock: Awaited<ReturnType<typeof setup>>['fetchMock']) => fetchMock.mock.calls.filter(([url]) => url === '/api/chat/commands' || url === '/api/chat/send');
const choose = (name: string) => {
  fireEvent.click(chatModelPicker());
  fireEvent.click(within(screen.getByRole('listbox', {name:'モデル'})).getByRole('option', {name}));
};
const message = (content: string, status: ChatMessage['status'] = 'completed'): ChatMessage => ({id:`fixture-${++serial}`,sendId:`send-${serial}`,role:'assistant',content,provider:'codex',model:'test',createdAt:'',updatedAt:'',status});

it('shows provider icons in the model picker and supports keyboard selection', async () => {
  const {fetchMock} = await setup({claude:true});
  const picker = chatModelPicker();
  expect(picker.textContent).toContain('Test');
  expect(picker.querySelector('svg[aria-hidden="true"] path[stroke]')).not.toBeNull();
  expect(screen.queryByRole('listbox',{name:'モデル'})).toBeNull();

  picker.focus();
  fireEvent.keyDown(picker,{key:'ArrowDown'});
  expect(picker.getAttribute('aria-expanded')).toBe('true');
  const options = within(screen.getByRole('listbox',{name:'モデル'}));
  const codex = options.getByRole('option',{name:'Codex/Test'});
  const claude = options.getByRole('option',{name:'Claude/Sonnet'});
  expect(codex.getAttribute('aria-selected')).toBe('true');
  expect(codex.querySelector('svg[aria-hidden="true"] path[stroke]')).not.toBeNull();
  expect(claude.querySelector('svg[aria-hidden="true"] path[fill="#EB764B"]')).not.toBeNull();
  fireEvent.keyDown(picker,{key:'End'});
  expect(picker.getAttribute('aria-activedescendant')).toBe(claude.id);
  fireEvent.keyDown(picker,{key:'Enter'});
  expect(picker.value).toBe('claude:sonnet');
  expect(picker.textContent).toContain('Sonnet');
  expect(picker.querySelector('svg[aria-hidden="true"] path[fill="#EB764B"]')).not.toBeNull();
  expect(picker.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('listbox',{name:'モデル'})).toBeNull();
  expect(document.activeElement).toBe(picker);
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('uses the saved provider icon for each assistant reply when the selected model changes', async () => {
  await setup({ claude: true, messages: [
    { ...message('Codex からの返答'), provider: 'codex' },
    { ...message('Claude からの返答'), provider: 'claude' },
    { ...message('ユーザーの入力'), role: 'user', provider: 'claude' },
  ] });
  const codex = (await screen.findByText('Codex からの返答')).closest('article')!;
  const claude = (await screen.findByText('Claude からの返答')).closest('article')!;
  const user = (await screen.findByText('ユーザーの入力')).closest('article')!;
  const codexIcon = codex.querySelector(':scope > .chat-image.avatar svg');
  const claudeIcon = claude.querySelector(':scope > .chat-image.avatar svg');
  expect(codexIcon?.querySelector('path[stroke]')).not.toBeNull();
  expect(claudeIcon?.querySelector('path[fill="#EB764B"]')).not.toBeNull();
  expect(codexIcon?.getAttribute('aria-hidden')).toBe('true');
  expect(claudeIcon?.getAttribute('aria-hidden')).toBe('true');
  expect(user.querySelector('.chat-image')).toBeNull();
  expect(codex.querySelector('.chat-header svg')).toBeNull();
  expect(claude.querySelector('.chat-header svg')).toBeNull();
  choose('Claude/Sonnet');
  expect(chatModelPicker().value).toBe('claude:sonnet');
  expect(codex.querySelector('svg')).toBe(codexIcon);
  expect(claude.querySelector('svg')).toBe(claudeIcon);
});

it('shows the saved model and local creation time on both sides of the chat', async () => {
  const createdAt = '2026-11-07T10:10:00+09:00';
  const updatedAt = '2026-11-07T10:20:00+09:00';
  const date = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(createdAt));
  await setup({ messages: [
    { ...message('質問本文'), role: 'user', model: 'gpt-6-luna', createdAt, updatedAt },
    { ...message('返答本文'), model: 'gpt-6-luna', createdAt, updatedAt },
    { ...message('日時不明の返答'), model: null, createdAt: 'invalid' },
  ] });
  for (const content of ['質問本文', '返答本文']) {
    const header = (await screen.findByText(content)).closest('article')!.querySelector('.chat-header')!;
    expect(header.textContent).toBe(`Codex/gpt-6-luna ${date}`);
    expect(header.querySelector('time')?.getAttribute('datetime')).toBe(createdAt);
  }
  const missing = (await screen.findByText('日時不明の返答')).closest('article')!.querySelector('.chat-header')!;
  expect(missing.textContent).toBe('Codex');
  expect(missing.querySelector('time')).toBeNull();
});

it('limits candidates to the selected provider and resets keyboard selection when it changes', async () => {
  const {fetchMock} = await setup({claude:true, tabStatus:true});
  input('/'); expect(screen.queryByRole('option',{name:'/context · コンテキストの使用状況'})).toBeNull();
  choose('Claude/Sonnet');
  expect(screen.queryByRole('option',{name:'/context · コンテキストの使用状況'})).toBeNull();
  expect(screen.getByRole('option',{name:'/usage · 使用量を表示'})).toBeTruthy();
  fireEvent.keyDown(textarea(),{key:'ArrowUp'});
  expect(textarea().getAttribute('aria-activedescendant')).toBeTruthy();
  choose('Codex/Test');
  expect(textarea().getAttribute('aria-activedescendant')).toBeNull();
  expect(screen.queryByRole('option',{name:'/security-review · 安全性をレビュー'})).toBeNull();
  input('/context'); submit();
  expect((await screen.findByRole('alert')).textContent).toContain('不明なコマンド');
  expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/new'); expect(screen.getByRole('option',{name:'/clear · 履歴を残して新しい会話'})).toBeTruthy();
  fireEvent.keyDown(textarea(),{key:'Tab'}); expect(textarea().value).toBe('/clear');
  input('/'); fireEvent.blur(textarea()); expect(screen.queryByRole('listbox')).toBeNull();
});

it('opens tab status when no model is available', async () => {
  const {fetchMock,tabStatus} = await setup({noModels:true,tabStatus:true}); input('/');
  expect(screen.queryByRole('option',{name:'/compact · 会話を圧縮'})).toBeNull();
  input('/compact'); expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
  tabStatus()!.open();
  const dialog = await screen.findByRole('dialog', {name:'チャットの状態'});
  expect(within(dialog).getByText('未選択')).toBeTruthy();
  expect(within(dialog).getByText('Codex')).toBeTruthy();
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('rejects generation commands and status in instruction conversations', async () => {
  const {fetchMock} = await setup({instructions:true}); input('/');
  expect(screen.queryByRole('option',{name:'/review · 変更をレビュー'})).toBeNull();
  input('/review'); submit(); expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/status'); submit(); await screen.findByText('不明なコマンドです。');
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('routes message commands through normal send with the selected provider and model', async () => {
  const {fetchMock} = await setup({claude:true});
  choose('Claude/Sonnet'); input('/code-review src/example.ts'); submit();
  await waitFor(() => expect(commandCalls(fetchMock)).toHaveLength(1));
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({content:'/code-review src/example.ts',model:'sonnet',provider:'claude'});
  expect(commandCalls(fetchMock)[0][0]).toBe('/api/chat/send');
});

it.each(['/status', '/rename 新しいタスク'])('rejects %s as a slash command in task conversations', async command => {
  const {fetchMock} = await setup({taskId:'task-example',tabStatus:true});
  input('/');
  expect(screen.queryByRole('option', {name:/^\/(status|rename) ·/})).toBeNull();
  input(command); submit();
  await screen.findByText('不明なコマンドです。');
  expect(textarea().value).toBe(command);
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/rename'))).toBe(false);
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it.each([false, true])('shows status while busy (readOnly = %s) and disables provider commands', async readOnly => {
  const {fetchMock, tabStatus} = await setup({tabStatus:true, working:true, readOnly});
  const status = tabStatus()!;
  expect(status.disabled).toBe(false);
  if (readOnly) {
    expect(screen.queryByRole('button', {name:'コマンド'})).toBeNull();
  } else {
    expect((commandMenu() as HTMLButtonElement).disabled).toBe(true);
    input('次の依頼');
  }
  status.open();
  const dialog = await screen.findByRole('dialog', {name:'チャットの状態'});
  fireEvent.click(within(dialog).getByRole('button', {name:'閉じる'}));
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  if (!readOnly) expect(textarea().value).toBe('次の依頼');
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('closes status on scope changes and rejects previous tab actions', async () => {
  const {fetchMock, tabStatus, setScope, onTabStatusChange} = await setup({taskId:'task-example', tabStatus:true});
  expect(onTabStatusChange.mock.calls[0][1].disabled).toBe(true);
  const status = tabStatus()!;
  status.open();
  await screen.findByRole('dialog', {name:'チャットの状態'});
  setScope(`another-scope-${++serial}`);
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  await waitFor(() => expect(tabStatus()?.disabled).toBe(false));
  status.open();
  expect(screen.queryByRole('dialog', {name:'チャットの状態'})).toBeNull();
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('confirms reset aliases, preserves canceled input and refreshes a new conversation without old packs', async () => {
  const {fetchMock,snapshot} = await setup({messages:[message('以前の会話')]});
  await screen.findByText('以前の会話');
  const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm',confirm);
  input('/reset'); submit();
  expect(confirm).toHaveBeenCalledWith('現在の会話をリセットしますか？履歴はアーカイブに残ります。');
  expect(commandCalls(fetchMock)).toHaveLength(0); expect(textarea().value).toBe('/reset');
  const oldId = snapshot.id; confirm.mockReturnValue(true); submit();
  await screen.findByText('会話リセット: 完了');
  await waitFor(() => expect(screen.queryByText('以前の会話')).toBeNull());
  expect(snapshot.id).not.toBe(oldId); expect(textarea().value).toBe('');
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({command:'clear',provider:'codex',model:'test',args:''});
});

it('displays operation output as text and routes provider aliases canonically', async () => {
  const {fetchMock,snapshot,socket} = await setup({claude:true}); choose('Claude/Sonnet');
  input('/cost'); submit(); await screen.findByText('使用量中…');
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({command:'usage',provider:'claude',model:'sonnet'});
  snapshot.command = {...snapshot.command!,status:'completed',output:'<b>12 units</b>'}; socket.change();
  await screen.findByText('使用量: 完了');
  expect(screen.getByText('<b>12 units</b>').tagName).toBe('PRE');
});

it('fits the popup into the chat viewport, follows layout resizing and scrolls keyboard selections', async () => {
  const observers: {callback:()=>void; targets:Element[]}[] = [];
  vi.stubGlobal('ResizeObserver',class {
    private value: {callback:()=>void;targets:Element[]};
    constructor(callback:()=>void) { this.value = {callback,targets:[]}; observers.push(this.value); }
    observe(target:Element) { this.value.targets.push(target); }
    disconnect() {}
  });
  await setup();
  let inputTop = 150;
  vi.spyOn(textarea(),'getBoundingClientRect').mockImplementation(() => ({top:inputTop} as DOMRect));
  vi.spyOn(screen.getByRole('log'),'getBoundingClientRect').mockReturnValue({top:120} as DOMRect);
  const clippingAncestor = textarea().closest('form')!;
  clippingAncestor.style.overflowY = 'hidden';
  vi.spyOn(clippingAncestor,'getBoundingClientRect').mockReturnValue({top:50} as DOMRect);
  input('/rec'); const popup = screen.getByRole('listbox');
  await waitFor(() => expect((popup as HTMLElement).style.maxHeight).toBe('92px'));
  const observer = observers.find(item => item.targets.includes(textarea()))!;
  expect(observer.targets).toContain(screen.getByRole('log'));
  inputTop = 100; observer.callback(); expect((popup as HTMLElement).style.maxHeight).toBe('42px');
  inputTop = 70; fireEvent(window,new Event('resize')); expect((popup as HTMLElement).style.maxHeight).toBe('40px');
  input('/rec'); const option = screen.getByRole('option',{name:'/recap · 会話を要約'});
  const scrollIntoView = vi.fn(); option.scrollIntoView = scrollIntoView;
  fireEvent.keyDown(textarea(),{key:'ArrowDown'});
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({block:'nearest'}));
});

it('forgets an earlier pending draft after a successful clear', async () => {
  const {fetchMock,snapshot,socket} = await setup();
  const user: ChatMessage = {...message('以前に送った内容'),role:'user',sendId:'old-send'};
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url,init) => url === '/api/chat/send' ? json({messages:[user]}) : original(url,init));
  input(user.content); submit(); await waitFor(() => expect(textarea().value).toBe(''));
  vi.stubGlobal('confirm',vi.fn().mockReturnValue(true));
  input('/clear'); submit(); await screen.findByText('会話リセット: 完了');
  snapshot.messages = [user,{...message(''),sendId:'old-send',status:'failed',errorCode:'MODEL_UNAVAILABLE'}]; socket.change();
  await screen.findByText('直近の応答: 失敗');
  expect(textarea().value).toBe('');
  expect(screen.queryByText('選択したモデルを利用できません。別のモデルを選択してください。')).toBeNull();
});


it('rejects message commands in editing conversations even after an instruction focus is selected', async () => {
  const {fetchMock} = await setup({instructions:true,instructionFocus:'common',claude:true});
  choose('Claude/Sonnet'); input('/');
  expect(screen.queryByRole('option',{name:'/review · 変更をレビュー'})).toBeNull();
  expect(screen.queryByRole('option',{name:'/recap · 会話を要約'})).toBeNull();
  expect(screen.queryByRole('option',{name:'/code-review · コードをレビュー'})).toBeNull();
  input('/review src/example.ts'); submit();
  await screen.findByText('不明なコマンドです。');
  expect(textarea().value).toBe('/review src/example.ts'); expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('keeps operation results inside the log, collapsed and escaped, with dismissal preserved across snapshots', async () => {
  const {snapshot,socket} = await setup({command:{id:'result-a',name:'usage',status:'completed',output:'<b>12 units</b>'}});
  const body = await screen.findByText('<b>12 units</b>');
  const log = screen.getByRole('log',{name:'チャット履歴'});
  expect(log.contains(body)).toBe(true); expect(body.tagName).toBe('PRE'); expect(body.querySelector('b')).toBeNull();
  const details = body.closest('details')!;
  expect(details.open).toBe(false);
  fireEvent.click(screen.getByText('使用量: 完了')); expect(details.open).toBe(true);
  snapshot.command = {...snapshot.command!,output:'updated result'}; socket.change();
  await screen.findByText('updated result'); expect(details.open).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'コマンド結果を閉じる'}));
  expect(screen.queryByText('使用量: 完了')).toBeNull();
  snapshot.messages = [message('結果更新の確認','interrupted')]; socket.change();
  await screen.findByText('直近の応答: 中断');
  expect(screen.queryByText('使用量: 完了')).toBeNull(); expect(screen.queryByText('updated result')).toBeNull();
  snapshot.command = {id:'result-b',name:'context',status:'completed',output:'next result'}; socket.change();
  const nextBody = await screen.findByText('next result');
  expect(nextBody.closest('details')!.open).toBe(false); expect(log.contains(nextBody)).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'コマンド結果を閉じる'}));
  snapshot.id = `replaced-conversation-${++serial}`; socket.change();
  const resetBody = await screen.findByText('next result'); expect(resetBody.closest('details')!.open).toBe(false);
});

it('renders output-free operation status as a dismissible line inside the log', async () => {
  await setup({command:{id:'compact-result',name:'compact',status:'completed'}});
  const status = await screen.findByText('圧縮: 完了');
  expect(screen.getByRole('log').contains(status)).toBe(true); expect(status.closest('details')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'コマンド結果を閉じる'}));
  expect(screen.queryByText('圧縮: 完了')).toBeNull();
});
