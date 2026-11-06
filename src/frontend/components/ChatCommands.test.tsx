import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetModelCache } from '../model-cache';
import { FakeWebSocket, packResponse } from '../test-events';
import type { ChatCommand } from '../../shared/chat-commands';
import type { ChatMessage, Conversation } from '../types';
import ChatPanel from './ChatPanel';

const json = (data: unknown, status = 200) => ({ok: status < 400, status, json: async () => data}) as Response;
let serial = 0;
beforeEach(() => { resetModelCache(); localStorage.clear(); FakeWebSocket.instances = []; vi.stubGlobal('WebSocket', FakeWebSocket); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup(options: {noModels?: boolean; claude?: boolean; taskId?: string; messages?: ChatMessage[]; instructions?: boolean; instructionFocus?: string; readOnly?: boolean; command?: ChatCommand; working?: boolean; commandResponse?: () => Promise<Response>} = {}) {
  const projectId = options.instructions ? 'instructions' : `commands-${++serial}`;
  const snapshot: Conversation = {id:`conversation-${++serial}`,projectId,taskId:options.taskId ?? null,threadId:'saved-thread',sessionProvider:'codex',messages: options.messages ?? (options.working ? [{id:'assistant',sendId:'send',role:'assistant',content:'',provider:'codex',model:'test',createdAt:'',updatedAt:'',status:'streaming'}] : []),command:options.command};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/codex/status') return json({installed:true,auth:'chatgpt',models: options.noModels ? [] : [{id:'test',name:'Test'}]});
    if (url === '/api/claude/status') return json({installed:!!options.claude,auth:options.claude ? 'claude' : 'none',models:options.claude ? [{id:'sonnet',name:'Sonnet'}] : []});
    if (url.startsWith('/api/chat?')) return json({...snapshot});
    const packs = packResponse(url, snapshot.messages); if (packs) return packs;
    if (url === '/api/chat/commands') {
      if (options.commandResponse) return options.commandResponse();
      const name = JSON.parse(String(init?.body)).command;
      snapshot.command = {id:'command-1',name,status:name === 'clear' ? 'completed' : 'running'};
      if (name === 'clear') { snapshot.id = `reset-${serial}`; snapshot.messages = []; }
      return json({command:snapshot.command}, 202);
    }
    if (url.startsWith('/api/tasks/')) return json({id:options.taskId,projectId,name:JSON.parse(String(init?.body)).name,phase:'requirements',status:'active'});
    if (url === '/api/chat/send' || url === '/api/chat/interrupt') return json({});
    throw new Error(`${url}: ${init?.method}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onBusyChange = vi.fn(), onTaskRename = vi.fn();
  const [scope,setScope] = createSignal(projectId);
  render(() => <ChatPanel projectId={scope()} taskId={options.taskId} phase={options.taskId ? 'requirements' : undefined} instructionFocus={options.instructionFocus} onTaskRename={onTaskRename} readOnly={options.readOnly} onBusyChange={onBusyChange} />);
  await waitFor(() => expect(FakeWebSocket.instances.at(-1)?.subscriptions.size).toBe(1));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/chat?')).length).toBeGreaterThanOrEqual(2));
  return {snapshot, fetchMock, onBusyChange, onTaskRename, setScope, socket: FakeWebSocket.instances.at(-1)!};
}
const textarea = () => screen.getByRole('textbox', {name:'希望や回答を入力'}) as HTMLTextAreaElement;
const input = (value: string) => fireEvent.input(textarea(), {target:{value}});
const submit = () => fireEvent.submit(textarea().closest('form')!);

it('offers prefix matches and accepts click, Tab and an explicitly selected Enter without sending', async () => {
  const { fetchMock } = await setup();
  input('/');
  expect(screen.getByRole('listbox', {name:'スラッシュコマンド'})).toBeTruthy();
  fireEvent.click(screen.getByRole('option', {name:'/compact · 会話を圧縮'}));
  expect(textarea().value).toBe('/compact'); expect(screen.queryByRole('listbox')).toBeNull();
  input('/co'); fireEvent.keyDown(textarea(), {key:'Tab'});
  expect(textarea().value).toBe('/compact');
  input('/c'); fireEvent.keyDown(textarea(), {key:'ArrowDown'});
  expect(screen.getByRole('option', {name:'/compact · 会話を圧縮'}).getAttribute('aria-selected')).toBe('true');
  expect(textarea().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', {name:'/compact · 会話を圧縮'}).id);
  fireEvent.keyDown(textarea(), {key:'Enter'}); expect(textarea().value).toBe('/compact');
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

it('Enter submits a complete slash command without a selected suggestion', async () => {
  await setup();
  input('/help');
  fireEvent.keyDown(textarea(), { key: 'Enter' });
  expect(await screen.findByText('/help · 結果')).toBeTruthy();
});

it('Enter respects the send restriction in instruction conversations', async () => {
  const { fetchMock } = await setup({ instructions: true });
  input('編集の相談');
  fireEvent.keyDown(textarea(), { key: 'Enter' });
  expect(commandCalls(fetchMock)).toHaveLength(0);
  expect(textarea().value).toBe('編集の相談');
});

it('sends compact through its own API with the selected model without instruction focus and awaits a changed snapshot', async () => {
  const {fetchMock, snapshot, socket, onBusyChange} = await setup({instructions:true});
  input('/compact');
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false);
  submit();
  await screen.findByText('圧縮中…');
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/chat/commands');
  expect(JSON.parse(String(request?.[1]?.body))).toEqual({projectId:'instructions',taskId:null,command:'compact',args:'',provider:'codex',model:'test'});
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/send')).toBe(false);
  await waitFor(() => expect(textarea().value).toBe('')); expect(onBusyChange).toHaveBeenLastCalledWith(true);
  expect((screen.getByRole('button',{name:'圧縮中...'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.queryByText('圧縮: 完了')).toBeNull();
  snapshot.command = {...snapshot.command!,status:'completed'}; socket.change();
  await screen.findByText('圧縮: 完了');
  expect(screen.queryByText('圧縮中…')).toBeNull(); expect(onBusyChange).toHaveBeenLastCalledWith(false);
  input('通常の依頼'); expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
});

it.each(['/unknown', '/compact extra'])('keeps %s out of normal model messages and preserves the input', async command => {
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

it('preserves input on a rejected command and preserves newer edits after successful acceptance', async () => {
  let release!: (value: Response) => void;
  const {snapshot,fetchMock} = await setup({commandResponse:() => new Promise(resolve => {release = resolve;})});
  input('/compact'); submit();
  await screen.findByText('圧縮中…'); input('新しい下書き');
  release(json({error:'保存されたセッションがありません'},409));
  await screen.findByText('圧縮できませんでした: 保存されたセッションがありません');
  expect(textarea().value).toBe('新しい下書き');
  input('/compact'); submit();
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

it('blocks compact until history has loaded', async () => {
  let release!: (value:Response) => void;
  vi.stubGlobal('fetch',vi.fn((url:string) => {
    if (url.startsWith('/api/chat?')) return new Promise<Response>(resolve => {release = resolve;});
    return Promise.resolve(packResponse(url,[]) ?? json({installed:false,auth:'none',models:[]}));
  }));
  render(() => <ChatPanel projectId={`loading-${++serial}`} />); input('/compact');
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
  release(json({id:'loaded',messages:[]}));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
});

it('retains the command itself after server rejection', async () => {
  await setup({commandResponse:async () => json({error:'接続された会話がありません'},400)});
  input('/compact'); submit();
  await screen.findByText('圧縮できませんでした: 接続された会話がありません');
  expect(textarea().value).toBe('/compact');
});

const commandCalls = (fetchMock: Awaited<ReturnType<typeof setup>>['fetchMock']) => fetchMock.mock.calls.filter(([url]) => url === '/api/chat/commands' || url === '/api/chat/send');
const choose = (value: string) => fireEvent.change(screen.getByRole('combobox',{name:'モデル'}),{target:{value}});
const message = (content: string, status: ChatMessage['status'] = 'completed'): ChatMessage => ({id:`fixture-${++serial}`,sendId:`send-${serial}`,role:'assistant',content,provider:'codex',model:'test',createdAt:'',updatedAt:'',status});

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
  choose('claude:sonnet');
  expect((screen.getByRole('combobox', { name: 'モデル' }) as HTMLSelectElement).value).toBe('claude:sonnet');
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
  const {fetchMock} = await setup({claude:true});
  input('/'); expect(screen.queryByRole('option',{name:'/context · コンテキストの使用状況'})).toBeNull();
  choose('claude:sonnet');
  expect(screen.getByRole('option',{name:'/context · コンテキストの使用状況'})).toBeTruthy();
  fireEvent.keyDown(textarea(),{key:'ArrowUp'});
  expect(textarea().getAttribute('aria-activedescendant')).toBeTruthy();
  choose('codex:test');
  expect(textarea().getAttribute('aria-activedescendant')).toBeNull();
  expect(screen.queryByRole('option',{name:'/security-review · 安全性をレビュー'})).toBeNull();
  input('/context'); submit();
  expect((await screen.findByRole('alert')).textContent).toContain('不明なコマンド');
  expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/new'); expect(screen.getByRole('option',{name:'/clear · 履歴を残して新しい会話'})).toBeTruthy();
  fireEvent.keyDown(textarea(),{key:'Tab'}); expect(textarea().value).toBe('/clear');
  input('/'); fireEvent.blur(textarea()); expect(screen.queryByRole('listbox')).toBeNull();
});

it('offers only client commands without a model and still permits help and status', async () => {
  const {fetchMock} = await setup({noModels:true}); input('/');
  expect(screen.queryByRole('option',{name:'/compact · 会話を圧縮'})).toBeNull();
  input('/compact'); expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(true);
  input('/help'); submit();
  expect(await screen.findByText(/\/model \[接続先\/モデルID\]/)).toBeTruthy();
  input('/status'); submit(); await screen.findByText(/選択: 未選択/);
  expect(screen.getByText(/保存された接続先: Codex/)).toBeTruthy();
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('keeps instruction message commands behind the focus requirement while allowing local commands', async () => {
  const {fetchMock} = await setup({instructions:true}); input('/');
  expect(screen.queryByRole('option',{name:'/review · 変更をレビュー'})).toBeNull();
  input('/review'); submit(); expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/help'); submit(); await screen.findByText(/\/compact · 会話を圧縮/);
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('routes message commands through normal send with the selected provider and model', async () => {
  const {fetchMock} = await setup({claude:true});
  choose('claude:sonnet'); input('/code-review src/example.ts'); submit();
  await waitFor(() => expect(commandCalls(fetchMock)).toHaveLength(1));
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({content:'/code-review src/example.ts',model:'sonnet',provider:'claude'});
  expect(commandCalls(fetchMock)[0][0]).toBe('/api/chat/send');
});

it('shows help aliases and arguments, changes models locally and focuses the existing selector', async () => {
  const {fetchMock} = await setup({claude:true});
  input('/help'); submit(); await screen.findByText(/別名: \/new, \/reset/);
  expect(screen.getByText(/\/model \[接続先\/モデルID\]/)).toBeTruthy();
  input('/model'); submit();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox',{name:'モデル'})));
  input('/model Sonnet'); submit(); await screen.findByRole('alert'); expect(textarea().value).toBe('/model Sonnet');
  input('/model Claude/sonnet'); submit(); await screen.findByText('モデルを Claude/Sonnet に変更しました。');
  expect((screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement).value).toBe('claude:sonnet');
  expect(Object.values(localStorage).some(value => String(value).includes('sonnet'))).toBe(true);
  input('/model missing'); submit(); await screen.findByRole('alert'); expect(textarea().value).toBe('/model missing');
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('rejects ambiguous model labels until a model ID is explicit', async () => {
  resetModelCache();
  vi.stubGlobal('fetch',vi.fn(async (url:string) => {
    if (url.endsWith('/status')) return json({installed:true,auth:url.includes('claude')?'claude':'chatgpt',models:[{id:'a',name:'Same'},{id:'b',name:'Same'}]});
    return packResponse(url,[]) ?? json({id:'ambiguous',messages:[]});
  }));
  render(() => <ChatPanel projectId="ambiguous-models" />);
  await waitFor(() => expect((screen.getByRole('combobox',{name:'モデル'}) as HTMLSelectElement).value).toBe('codex:a'));
  input('/model Same'); submit(); await screen.findByText('モデル名が曖昧です。接続先/モデルIDで指定してください。');
  input('/model codex/b'); submit(); await screen.findByText('モデルを Codex/Same に変更しました。');
});

it('copies the latest completed response and preserves input when clipboard fails', async () => {
  const {fetchMock} = await setup({messages:[message('完了した回答'),message('未完了の回答','interrupted')]});
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator',{clipboard:{writeText}});
  input('/copy'); submit(); await screen.findByText('最後の回答をコピーしました。');
  expect(writeText).toHaveBeenCalledWith('完了した回答');
  writeText.mockRejectedValueOnce(new Error('denied'));
  input('/copy'); submit(); await screen.findByText('回答をコピーできませんでした。');
  expect(textarea().value).toBe('/copy'); expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('does not copy unfinished responses or accept unwanted local arguments', async () => {
  const {fetchMock} = await setup({messages:[message('中断した回答','interrupted')]});
  input('/copy'); submit(); await screen.findByText('コピーできる完了した回答がありません。');
  input('/status extra'); submit(); await screen.findByText('/status に引数は指定できません。');
  expect(textarea().value).toBe('/status extra'); expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('exports the conversation as a local Markdown download and releases its object URL', async () => {
  const {fetchMock,snapshot} = await setup({messages:[message('保存する回答')]});
  const createObjectURL = vi.fn().mockReturnValue('blob:export'); const revokeObjectURL = vi.fn();
  const clicked = vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(function(this:HTMLAnchorElement) {
    expect(this.download).toBe(`chat-${snapshot.id}.md`); expect(this.href).toBe('blob:export');
  });
  const originalURL = URL; vi.stubGlobal('URL',class extends originalURL {static createObjectURL=createObjectURL;static revokeObjectURL=revokeObjectURL;});
  input('/export'); submit(); await screen.findByText('会話を書き出しました。');
  expect(await (createObjectURL.mock.calls[0][0] as Blob).text()).toContain('## アシスタント · 完了\n\n保存する回答');
  expect(clicked).toHaveBeenCalledOnce(); expect(revokeObjectURL).toHaveBeenCalledWith('blob:export');
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('renames task conversations through the existing API and notifies their parent', async () => {
  const {fetchMock,onTaskRename} = await setup({taskId:'task-example'});
  input('/rename 新しいタスク'); submit(); await screen.findByText('名前を「新しいタスク」に変更しました。');
  const request = fetchMock.mock.calls.find(([url]) => url === '/api/tasks/task-example/rename');
  expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({name:'新しいタスク'});
  expect(onTaskRename).toHaveBeenCalledWith(expect.objectContaining({id:'task-example',name:'新しいタスク'}));
  expect(commandCalls(fetchMock)).toHaveLength(0);
  input('/rename'); submit(); await screen.findByText('/rename に名前を指定してください。');
});

it('hides rename outside task conversations and clears local output on scope changes', async () => {
  const {fetchMock,setScope} = await setup(); input('/');
  expect(screen.queryByRole('option',{name:'/rename · 名前を変更'})).toBeNull();
  input('/rename other'); submit(); await screen.findByText('不明なコマンドです。');
  input('/status'); submit(); await screen.findByText(/メッセージ数: 0/);
  setScope(`another-scope-${++serial}`);
  await waitFor(() => expect(screen.queryByText(/メッセージ数: 0/)).toBeNull());
  expect(commandCalls(fetchMock)).toHaveLength(0);
});

it('confirms reset aliases, preserves canceled input and refreshes a new conversation without old packs', async () => {
  const {fetchMock,snapshot} = await setup({messages:[message('以前の会話')]});
  await screen.findByText('以前の会話');
  input('/status'); submit(); await screen.findByText(/メッセージ数: 1/);
  const confirm = vi.fn().mockReturnValue(false); vi.stubGlobal('confirm',confirm);
  input('/reset'); submit();
  expect(confirm).toHaveBeenCalledWith('現在の会話をリセットしますか？履歴はアーカイブに残ります。');
  expect(commandCalls(fetchMock)).toHaveLength(0); expect(textarea().value).toBe('/reset');
  const oldId = snapshot.id; confirm.mockReturnValue(true); submit();
  await screen.findByText('会話リセット: 完了');
  await waitFor(() => expect(screen.queryByText(/メッセージ数: 1/)).toBeNull());
  await waitFor(() => expect(screen.queryByText('以前の会話')).toBeNull());
  expect(snapshot.id).not.toBe(oldId); expect(textarea().value).toBe('');
  expect(JSON.parse(String(commandCalls(fetchMock)[0][1]?.body))).toMatchObject({command:'clear',provider:'codex',model:'test',args:''});
});

it('displays operation output as text and routes provider aliases canonically', async () => {
  const {fetchMock,snapshot,socket} = await setup({claude:true}); choose('claude:sonnet');
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
  input('/'); const popup = screen.getByRole('listbox');
  await waitFor(() => expect((popup as HTMLElement).style.maxHeight).toBe('92px'));
  const observer = observers.find(item => item.targets.includes(textarea()))!;
  expect(observer.targets).toContain(screen.getByRole('log'));
  inputTop = 100; observer.callback(); expect((popup as HTMLElement).style.maxHeight).toBe('42px');
  inputTop = 70; fireEvent(window,new Event('resize')); expect((popup as HTMLElement).style.maxHeight).toBe('40px');
  const option = screen.getByRole('option',{name:'/compact · 会話を圧縮'});
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
  choose('claude:sonnet'); input('/');
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

it('collapses each new local result inside the log and lets users dismiss it without websocket revival', async () => {
  const {snapshot,socket} = await setup();
  input('/help'); submit(); const help = await screen.findByText('/help · 結果');
  const details = help.closest('details')!; expect(details.open).toBe(false); expect(screen.getByRole('log').contains(help)).toBe(true);
  fireEvent.click(help); expect(details.open).toBe(true);
  input('/status'); submit(); const status = await screen.findByText('/status · 結果');
  expect(status.closest('details')!.open).toBe(false); expect(screen.queryByText('/help · 結果')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'ローカルコマンド結果を閉じる'}));
  expect(screen.queryByText('/status · 結果')).toBeNull();
  snapshot.messages = [message('更新後の応答','interrupted')]; socket.change(); await screen.findByText('直近の応答: 中断');
  expect(screen.queryByText('/status · 結果')).toBeNull();
  input('/status'); submit(); const repeated = await screen.findByText('/status · 結果'); expect(repeated.closest('details')!.open).toBe(false);
});
