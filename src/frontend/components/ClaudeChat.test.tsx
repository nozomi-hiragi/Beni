import { createSignal } from 'solid-js';
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel';
import CodexSettings from './CodexSettings';
import { resetModelCache } from '../model-cache';
import { FakeWebSocket } from '../test-events';

const json = (data: unknown) => ({ok:true,json:async()=>data}) as Response;
const codex = {installed:true,auth:'chatgpt',models:[{id:'same',name:'Shared'}]};
const claude = {installed:true,auth:'claude',version:'2.1.292',models:[{id:'same',name:'Shared'}]};
beforeEach(()=>{resetModelCache();localStorage.clear();FakeWebSocket.instances=[];vi.stubGlobal('WebSocket',FakeWebSocket);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('同じ生IDのCodexとClaudeを区別して送信し、拒否は選択providerだけを警告する',async()=>{
 let sent:unknown;
 vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>{
  if(url==='/api/instructions')return Promise.resolve(json({instructions:[{key:'common',content:'# 共通'}]}));
  if(url==='/api/codex/status')return Promise.resolve(json(codex));
  if(url==='/api/claude/status')return Promise.resolve(json(claude));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'mixed',messages:[],selectedModel:{id:'same',name:'Shared'}}));
  if(url==='/api/chat/send'){sent=JSON.parse(String(init?.body));return Promise.resolve({ok:false,status:400,json:async()=>({error:'利用不可',code:'MODEL_UNAVAILABLE'})} as Response);}
  throw Error(url);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000ad1"/>);
 await screen.findByRole('option',{name:'Codex/Shared'});await screen.findByRole('option',{name:'Claude/Shared'});
 const select=screen.getByRole('combobox') as HTMLSelectElement;
 expect([...select.options].map(option=>option.value)).toEqual(['codex:same','claude:same']);
 fireEvent.change(select,{target:{value:'claude:same'}});
 fireEvent.input(screen.getByRole('textbox'),{target:{value:'Claudeへの依頼'}});
 const send=screen.getByRole('button',{name:'送信'}) as HTMLButtonElement;
 await waitFor(()=>expect(send.disabled).toBe(false));fireEvent.click(send);
 await screen.findByRole('option',{name:'⚠️ Claude/Shared'});
 expect(sent).toEqual({projectId:'019a0000-0000-7000-8000-000000000ad1',taskId:null,content:'Claudeへの依頼',model:'same',provider:'claude'});
 expect(send.disabled).toBe(true);
 fireEvent.change(select,{target:{value:'codex:same'}});
 expect(send.disabled).toBe(false);
 expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Claudeへの依頼');
});

it.each(['認証なし','取得失敗'])('Claudeが%sでもCodexの選択と送信を妨げない',async failure=>{
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/instructions')return Promise.resolve(json({instructions:[{key:'common',content:'# 共通'}]}));
  if(url==='/api/codex/status')return Promise.resolve(json(codex));
  if(url==='/api/claude/status')return failure==='取得失敗'?Promise.reject(Error('offline')):Promise.resolve(json({...claude,auth:'none'}));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:failure,messages:[],selectedModel:null}));
  throw Error(url);
 }));
 render(()=><ChatPanel projectId={`019a0000-0000-7000-8000-${failure==='認証なし'?'000000000ad2':'000000000ad3'}`}/>);
 fireEvent.input(screen.getByRole('textbox'),{target:{value:'Codexへの依頼'}});
 await waitFor(()=>expect((screen.getByRole('button',{name:'送信'}) as HTMLButtonElement).disabled).toBe(false));
 expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('codex:same');
 if(failure==='認証なし')expect((screen.getByRole('option',{name:'Claude/Shared'}) as HTMLOptionElement).disabled).toBe(true);
});

it('Codex取得失敗時もClaudeを使え、フェーズ往復で選択を即復元する',async()=>{
 let codexCalls=0,claudeCalls=0;
 const [phase,setPhase]=createSignal<'requirements'|'documents'>('requirements');
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/instructions')return Promise.resolve(json({instructions:[{key:'common',content:'# 共通'}]}));
  if(url==='/api/codex/status'){codexCalls++;return Promise.reject(Error('offline'));}
  if(url==='/api/claude/status'){claudeCalls++;return Promise.resolve(json(claude));}
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:phase(),messages:[],selectedModel:null}));
  throw Error(url);
 }));
 render(()=><ChatPanel projectId="019a0000-0000-7000-8000-000000000ad4" taskId="019a0000-0000-7100-8000-000000000ad4" phase={phase()}/>);
 const select=screen.getByRole('combobox') as HTMLSelectElement;
 await waitFor(()=>expect(select.value).toBe('claude:same'));
 setPhase('documents');await waitFor(()=>expect(select.value).toBe('claude:same'));
 setPhase('requirements');expect(select.value).toBe('claude:same');
 expect(codexCalls).toBe(1);expect(claudeCalls).toBe(1);
});

it('設定のClaude更新だけ共有一覧へ反映し、CLI制限と非対応版を表示する',async()=>{
 let version='2.1.291',codexCalls=0,claudeCalls=0;
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/instructions')return Promise.resolve(json({instructions:[{key:'common',content:'# 共通'}]}));
  if(url==='/api/codex/status'){codexCalls++;return Promise.resolve(json(codex));}
  if(url==='/api/claude/status'){claudeCalls++;return Promise.resolve(json({...claude,version,auth:version==='2.1.291'?'unknown':'claude',models:version==='2.1.291'?null:[{id:'opus',name:'Opus'}]}));}
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'settings-shared',messages:[],selectedModel:null}));
  throw Error(url);
 }));
 render(()=><><CodexSettings/><ChatPanel projectId="019a0000-0000-7000-8000-000000000ad5"/></>);
 await screen.findByText('Claude Code 2.1.292 以降に更新してください');
 expect(screen.getByText('Claude Code 2.1.292 以降とサブスクリプションのログインが必要です。実装中・反省会では作業フォルダー内のファイル編集とコマンド実行ができます。ネットワークと外部ツールは無効です。')).toBeTruthy();
 expect(codexCalls).toBe(1);expect(claudeCalls).toBe(1);
 const refresh=screen.getByRole('button',{name:'Claude の接続状態を更新'}) as HTMLButtonElement;
 await waitFor(()=>expect(refresh.disabled).toBe(false));version='2.1.292';fireEvent.click(refresh);
 await screen.findByRole('option',{name:'Claude/Opus'});
 expect(claudeCalls).toBe(2);expect(codexCalls).toBe(1);
 await screen.findByText('Claude Code サブスクリプションでログイン済み');
});

it('providerのないローカル保存をCodexとして復元する',async()=>{
 const projectId='019a0000-0000-7000-8000-000000000ad6';
 localStorage.setItem(`beni:model:${projectId}:general:`,JSON.stringify({id:'same',name:'Legacy'}));
 vi.stubGlobal('fetch',vi.fn((url:string)=>{
  if(url==='/api/instructions')return Promise.resolve(json({instructions:[{key:'common',content:'# 共通'}]}));
  if(url==='/api/codex/status')return Promise.resolve(json(codex));
  if(url==='/api/claude/status')return Promise.resolve(json(claude));
  if(url.startsWith('/api/chat/packs'))return Promise.resolve(json({packs:[]}));
  if(url.startsWith('/api/chat?'))return Promise.resolve(json({id:'legacy',messages:[],selectedModel:{id:'same',name:'Shared',provider:'claude'}}));
  throw Error(url);
 }));
 render(()=><ChatPanel projectId={projectId}/>);
 const select=screen.getByRole('combobox') as HTMLSelectElement;
 expect(select.value).toBe('codex:same');
 await screen.findByRole('option',{name:'Claude/Shared'});
 expect(select.value).toBe('codex:same');
});

it.each([false,true])('設定でClaudeの検出と認証状態を説明する installed=%s',async installed=>{
 vi.stubGlobal('fetch',vi.fn((url:string)=>Promise.resolve(json(url==='/api/instructions'?{instructions:[{key:'common',content:'# 共通'}]}:url==='/api/codex/status'?codex:{...claude,installed,auth:'none',version:installed?'2.1.292':null,models:null}))));
 render(()=><CodexSettings/>);
 await screen.findByText(installed?'Claude にログインしてください':'Claude CLI をインストールしてください');
});
