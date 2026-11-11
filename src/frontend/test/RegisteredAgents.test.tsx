import { cleanup, fireEvent, render, screen, waitFor, within } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentConnectionStatus, AgentInfo } from '../../shared/agent';
import { modelScope, resetModelCache } from '../shared/model-cache';
import { chatModelPicker, FakeWebSocket, packResponse } from './test-events';
import ChatPanel from '../shared/components/ChatPanel';
import SettingsPage from '../settings/SettingsPage';
import UsageIndicators from '../shared/components/UsageIndicators';

beforeEach(() => {
  resetModelCache();
  localStorage.clear();
  FakeWebSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses a registered agent for models, command aliases, settings and usage', async () => {
  const agent: AgentInfo = {
    id: 'test-agent', name: '試験エージェント', supportsUsage: true,
    commands: [
      {name:'inspect', aliases:['check'], description:'状態を調査', kind:'maintenance', requiresSession:false, argumentHint:'[対象]'},
      {name:'compact', description:'会話を圧縮', kind:'maintenance', requiresSession:true},
    ],
  };
  const status: AgentConnectionStatus = {
    availability:'ready', auth:'not-required', models:[{id:'one',name:'One'}, {id:'two',name:'Two'}], checkedAt:'2026-01-01T00:00:00Z',
    usage:{observedAt:'2026-01-01T00:00:00Z', windows:[{label:'当日',usedPercent:10}]},
  };
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/agents') return Response.json({agents:[agent]});
    if (path === '/api/agents/test-agent/status') {
      return Response.json(init?.method === 'POST' ? {...status, usage:{observedAt:'2026-01-01T00:00:00Z', windows:[{label:'当日',usedPercent:30}]}} : status);
    }
    if (path.startsWith('/api/chat?')) return Response.json({id:'registered-chat',messages:[],selectedModel:{id:'one',name:'One',provider:'test-agent'},sessionProvider:'test-agent',threadId:'registered-thread'});
    if (path === '/api/chat/commands') return Response.json({command:{id:'inspect-result',name:'inspect',status:'completed'}});
    const packs = packResponse(path, []);
    if (packs) return packs;
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(() => <><SettingsPage /><UsageIndicators /><ChatPanel projectId="019a0000-0000-7000-8000-000000000901" /></>);

  expect(await screen.findByRole('heading',{name:'試験エージェント 接続'})).toBeTruthy();
  expect(await screen.findByText('認証不要')).toBeTruthy();
  const models = chatModelPicker();
  await waitFor(() => expect(models.value).toBe('test-agent:one'));
  fireEvent.click(models);
  const options = within(screen.getByRole('listbox',{name:'モデル'}));
  expect(options.getAllByRole('option')).toEqual([
    options.getByRole('option',{name:'試験エージェント/One'}),
    options.getByRole('option',{name:'試験エージェント/Two'}),
  ]);
  const text = screen.getByRole<HTMLTextAreaElement>('textbox',{name:'希望や回答を入力'});
  fireEvent.click(options.getByRole('option',{name:'試験エージェント/Two'}));
  await waitFor(() => expect(models.value).toBe('test-agent:two'));
  fireEvent.click(screen.getByRole('button',{name:'コマンド'}));
  fireEvent.click(screen.getByText('会話操作',{selector:'summary'}));
  expect(screen.getByRole('button',{name:'/inspect · 状態を調査'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'/usage · 使用量を表示'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'コマンド'}));
  fireEvent.input(text,{target:{value:'/ch'}});
  expect(screen.getByRole('option',{name:'/inspect · 状態を調査'})).toBeTruthy();
  expect(screen.queryByRole('option',{name:'/compact · 会話を圧縮'})).toBeNull();
  fireEvent.input(text,{target:{value:'/check 対象'}});
  fireEvent.submit(text.form!);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/chat/commands', expect.objectContaining({method:'POST'})));
  const request = fetchMock.mock.calls.find(([path]) => path === '/api/chat/commands')?.[1];
  expect(JSON.parse(String(request?.body))).toMatchObject({command:'inspect',args:'対象',provider:'test-agent',model:'two'});

  await waitFor(() => expect(models.disabled).toBe(false));
  fireEvent.click(models);
  fireEvent.click(within(screen.getByRole('listbox',{name:'モデル'})).getByRole('option',{name:'試験エージェント/One'}));
  const context = screen.getByRole('img',{name:/コンテキスト:/});
  fireEvent.contextMenu(context);
  expect(screen.getByRole('menuitem',{name:'圧縮'})).toBeTruthy();

  const gauge = screen.getByRole('progressbar',{name:'試験エージェント の利用枠'});
  expect(gauge.getAttribute('aria-valuetext')).toBe('当日 残り 90%');
  const refresh = screen.getByRole<HTMLButtonElement>('button',{name:'試験エージェント の接続状態を更新'});
  await waitFor(() => expect(refresh.disabled).toBe(false));
  fireEvent.click(refresh);
  await waitFor(() => expect(gauge.getAttribute('aria-valuetext')).toBe('当日 残り 70%'));
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/agents')).toHaveLength(1);
  expect(fetchMock.mock.calls.some(([path]) => /^\/api\/(codex|claude)\/status$/.test(path))).toBe(false);
});

it('preserves the selected model and history when the registry is empty', async () => {
  const projectId = '019a0000-0000-7000-8000-000000000902';
  const saved = {id:'model', name:'過去のモデル', provider:'removed-agent'};
  const storageKey = `beni:model:${modelScope(projectId)}`;
  localStorage.setItem(storageKey, JSON.stringify(saved));
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/agents') return Response.json({agents:[]});
    if (path.startsWith('/api/chat?')) return Response.json({id:'saved-chat',messages:[]});
    const packs = packResponse(path, [{id:'reply',role:'assistant',content:'過去の応答',provider:'removed-agent',model:'model'}]);
    if (packs) return packs;
    throw new Error(path);
  });
  vi.stubGlobal('fetch', fetchMock);
  render(() => <><SettingsPage /><ChatPanel projectId={projectId} /></>);
  expect(await screen.findByText('登録されているエージェントはありません。')).toBeTruthy();
  expect(await screen.findByText('過去の応答')).toBeTruthy();
  expect(within(screen.getByRole('log')).getByText(/removed-agent\/model/)).toBeTruthy();
  expect(chatModelPicker().title).toBe('⚠️ removed-agent/過去のモデル');
  expect(chatModelPicker().disabled).toBe(true);
  const text = screen.getByRole<HTMLTextAreaElement>('textbox',{name:'希望や回答を入力'});
  fireEvent.input(text,{target:{value:'新しい質問'}});
  fireEvent.submit(text.form!);
  expect(screen.getByRole<HTMLButtonElement>('button',{name:'送信'}).disabled).toBe(true);
  fireEvent.input(text,{target:{value:'/'}});
  expect(screen.queryByRole('listbox',{name:'スラッシュコマンド'})).toBeNull();
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
  expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/status') || path === '/api/chat/send')).toBe(false);
});

it('利用枠非対応でも接続状態の更新はPOSTで再確認する', async () => {
  const agent: AgentInfo = {id:'local-agent',name:'ローカル接続',supportsUsage:false,commands:[]};
  const status: AgentConnectionStatus = {availability:'not-installed',auth:'unknown',models:null,checkedAt:'2026-01-01T00:00:00Z',usage:'unknown'};
  const fetchMock=vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/agents')return Response.json({agents:[agent]});
    if(path==='/api/agents/local-agent/status')return Response.json(init?.method==='POST'?{...status,availability:'ready',auth:'not-required'}:status);
    throw Error(path);
  });
  vi.stubGlobal('fetch',fetchMock);
  render(()=><SettingsPage />);
  const refresh=await screen.findByRole<HTMLButtonElement>('button',{name:'ローカル接続 の接続状態を更新'});
  await waitFor(()=>expect(refresh.disabled).toBe(false));
  fireEvent.click(refresh);
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/agents/local-agent/status',expect.objectContaining({method:'POST'})));
  expect(await screen.findByText('認証不要')).toBeTruthy();
});

it.each([
  {name:'Codex の空のコマンド定義',provider:'codex',registryStatus:200},
  {name:'Claude の空のコマンド定義',provider:'claude',registryStatus:200},
  {name:'登録 API の 404',provider:'codex',registryStatus:404},
  {name:'登録 API の 405',provider:'codex',registryStatus:405},
])('$name から固有候補や圧縮を推測しない', async ({provider,registryStatus}) => {
  const agent: AgentInfo = {id:provider,name:'試験接続先',supportsUsage:false,supportsContextUsage:true,commands:[]};
  const legacy = registryStatus !== 200;
  const statusPath = legacy ? '/api/codex/status' : `/api/agents/${provider}/status`;
  const models = [{id:'test',name:'Test'}];
  const fetchMock = vi.fn(async (path:string) => {
    if (path === '/api/agents') return legacy ? Response.json({}, {status:registryStatus}) : Response.json({agents:[agent]});
    if (path === statusPath) return Response.json(legacy
      ? {installed:true,auth:'chatgpt',models}
      : {availability:'ready',auth:'not-required',models});
    if (legacy && path === '/api/claude/status') return Response.json({installed:false,auth:'none',models:[]});
    if (path.startsWith('/api/chat?')) return Response.json({id:'empty-commands',messages:[],selectedModel:{id:'test',name:'Test',provider},sessionProvider:provider,threadId:'saved-thread',contextUsage:{usedTokens:10,maxTokens:100}});
    const packs = packResponse(path, []); if (packs) return packs;
    throw new Error(path);
  });
  vi.stubGlobal('fetch',fetchMock);
  render(() => <ChatPanel projectId="empty-commands" />);
  await waitFor(() => { expect(chatModelPicker().value).toBe(`${provider}:test`); expect(chatModelPicker().disabled).toBe(false); });
  const text = screen.getByRole<HTMLTextAreaElement>('textbox',{name:'希望や回答を入力'});
  fireEvent.input(text,{target:{value:'/'}});
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['/clear · 履歴を残して新しい会話']);
  fireEvent.input(text,{target:{value:'/review'}}); fireEvent.submit(text.form!);
  expect(await screen.findByText('不明なコマンドです。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'コマンド'}));
  expect(screen.queryByText('生成',{selector:'summary'})).toBeNull();
  fireEvent.contextMenu(screen.getByRole('img',{name:/コンテキスト:/}));
  const compact = screen.getByRole<HTMLButtonElement>('menuitem',{name:'圧縮'});
  expect(compact.disabled).toBe(true); fireEvent.click(compact);
  expect(fetchMock.mock.calls.some(([path]) => path === statusPath)).toBe(true);
  expect(fetchMock.mock.calls.some(([path]) => path === '/api/chat/send' || path === '/api/chat/commands')).toBe(false);
});
