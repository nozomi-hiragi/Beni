// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import InstructionsSettings from './InstructionsSettings';
import { communication } from '../communication';
vi.mock('../communication',()=>({communication:{subscribe:vi.fn(()=>vi.fn())}}));
const chatMock = vi.hoisted(()=>({busyChange: undefined as ((busy:boolean)=>void)|undefined}));
vi.mock('./ChatPanel',()=>({default: (props: {projectId:string; instructionFocus?:string|null; instructionFocusLabel?:string; onBusyChange?:(busy:boolean)=>void})=>{chatMock.busyChange=props.onBusyChange;return <div data-testid="instructions-chat">{props.projectId}<span data-testid="focus-label">{props.instructionFocusLabel??'未選択'}</span></div>}}));
afterEach(()=>{cleanup();vi.unstubAllGlobals()});
it('loads templates and switches the Markdown preview with descriptive variable badges',async()=>{
 const executionContent = '# Execution instructions';
 const fetch = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({
  instructions:[{key:'editor',content:'# Editor {{working_directory}} {{custom}}'},{key:'common',content:'# Common {{project_directory}}'},{key:'requirements',content:'# Requirements {{task_id}}'},{key:'execution',content:executionContent},{key:'retrospective',content:'# Retrospective instructions'},{key:'finalization',content:'# 終了時に参照する {{retrospective_chat_path}}'}],
  provenance:{execution:{revision:'execution-revision',items:[{id:'execution-item',start:0,end:executionContent.length}]}},
 })}).mockResolvedValueOnce({ok:true,json:async()=>({reason:'実装時の指示の根拠',sources:[]})});
 vi.stubGlobal('fetch',fetch);
 render(()=> <InstructionsSettings/>);
 expect(screen.getAllByRole('status')[0].textContent).toContain('読み込み中');
 expect(await screen.findByRole('heading',{name:'Common プロジェクトのディレクトリ'})).toBeTruthy();
 expect(screen.queryByText('{{project_directory}}')).toBeNull();
 expect(screen.getByRole('list',{name:'埋め込み変数'}).textContent).not.toContain('{{');
 expect(screen.queryByText('Editor instructions')).toBeNull();
 expect(screen.getByTestId('instructions-chat').textContent).toContain('instructions');
 expect(screen.getByRole('heading',{name:'変数'})).toBeTruthy();
 expect(screen.getByRole('heading',{name:'埋め込みツール'})).toBeTruthy();
 expect(screen.queryByLabelText('編集相談チャット専用ツール')).toBeNull();
 const projectTools=screen.getByLabelText('埋め込みツール');
 expect(projectTools.textContent).toContain('list_events');
 expect(projectTools.textContent).not.toContain('list_instructions');
 expect(projectTools.textContent).not.toContain('get_instruction');
 expect(screen.getAllByRole('tab')).toHaveLength(10);
 expect(screen.getByRole('tab',{name:'要件定義'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByRole('tabpanel',{name:'要件定義'}).textContent).toContain('Requirements タスクID');
 const common=screen.getByRole('region',{name:'全共通のフォーカス対象'});
 fireEvent.click(common.querySelector('.badge')!);
 expect(common.classList.contains('aura')).toBe(true);
 expect(screen.getByTestId('focus-label').textContent).toBe('全共通');
 fireEvent.click(screen.getByRole('tab',{name:'実装中'}));
 fireEvent.mouseOver(await screen.findByRole('heading',{name:'Execution instructions'}));
 fireEvent.click(await screen.findByText('実装時の指示の根拠'));
 const query = new URL(fetch.mock.calls[1]![0], 'http://localhost').searchParams;
 expect(Object.fromEntries(query)).toEqual({name:'execution',revision:'execution-revision',itemId:'execution-item'});
 expect(screen.getByTestId('focus-label').textContent).toBe('全共通');
 expect(screen.getByRole('heading',{name:'Common プロジェクトのディレクトリ'})).toBeTruthy();
 expect(screen.queryByText('Requirements instructions')).toBeNull();
 const execution=screen.getByRole('tab',{name:'実装中'});
 execution.focus();
 fireEvent.keyDown(execution,{key:'ArrowRight'});
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'反省会'}));
 expect(screen.getByRole('tabpanel',{name:'反省会'}).textContent).toContain('Retrospective instructions');
 fireEvent.keyDown(document.activeElement!,{key:'Home'});
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'要件定義'}));
 fireEvent.keyDown(document.activeElement!,{key:'ArrowLeft'});
 expect(document.activeElement).toBe(screen.getByRole('tab',{name:'終了'}));
 fireEvent.keyDown(document.activeElement!,{key:'End'});
 expect(screen.getByRole('tab',{name:'終了'}).getAttribute('aria-selected')).toBe('true');
 const finalization = screen.getByRole('region',{name:'終了のフォーカス対象'});
 expect(within(finalization).getByRole('heading',{name:'終了時に参照する 反省会チャットのパス'})).toBeTruthy();
 fireEvent.click(finalization);
 expect(screen.getByTestId('focus-label').textContent).toBe('終了');
 expect(screen.getByRole('heading',{name:'Common プロジェクトのディレクトリ'})).toBeTruthy();
 fireEvent.click(within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'編集用'}));
 expect(screen.getByRole('heading',{name:'Editor {{working_directory}} {{custom}}'}).querySelector('.badge')).toBeNull();
});
it('shows a loading failure',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(Error('offline')));
 render(()=> <InstructionsSettings/>);
 expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
});

it.each([{}, {instructions:null}, {instructions:[]}, {instructions:[{key:'editor',content:'# Editor instructions'},{key:'common'}]}])('shows malformed responses as a loading failure: %j',async data=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>data}));
 render(()=> <InstructionsSettings/>);
 expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
 expect(screen.queryByRole('tablist',{name:'フェーズ別インストラクション'})).toBeNull();
});

it('refreshes saved instructions on chat events and ignores older responses',async()=>{
 let listener: {event(event: {name:string}):void; subscribed():void};
 const unsubscribe=vi.fn();
 vi.mocked(communication.subscribe).mockImplementationOnce((_topic,_scope,value)=>{listener=value;return unsubscribe});
 let resolveOlder!: (response: unknown)=>void;
 const response=(editor:string,common:string)=>({ok:true,json:async()=>({instructions:[{key:'editor',content:editor},{key:'common',content:common}]})});
 const fetch=vi.fn().mockResolvedValueOnce(response('Initial editor','Initial common'))
  .mockImplementationOnce(()=>new Promise(resolve=>{resolveOlder=resolve}))
  .mockResolvedValueOnce(response('Saved editor','Saved common'));
 vi.stubGlobal('fetch',fetch);
 const view=render(()=> <InstructionsSettings/>);
 await screen.findByText('Initial common');
 expect(communication.subscribe).toHaveBeenLastCalledWith('chat',{projectId:'instructions',taskId:null},expect.anything());
 listener!.event({name:'chat.changed'});
 listener!.event({name:'chat.changed'});
 await screen.findByText('Saved common');
 fireEvent.click(within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'編集用'}));
 expect(screen.getByText('Saved editor')).toBeTruthy();
 resolveOlder(response('Older editor','Older common'));
 await Promise.resolve();await Promise.resolve();
 expect(screen.queryByText('Older common')).toBeNull();
 view.unmount();
 expect(unsubscribe).toHaveBeenCalledOnce();
});

it('shows refresh failures and recovers when the chat reconnects',async()=>{
 let listener: {event(event: {name:string}):void; subscribed():void};
 vi.mocked(communication.subscribe).mockImplementationOnce((_topic,_scope,value)=>{listener=value;return vi.fn()});
 const response=(content:string)=>({ok:true,json:async()=>({instructions:[{key:'common',content}]})});
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(response('Initial common')).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(response('Recovered common')));
 render(()=> <InstructionsSettings/>);
 await screen.findByText('Initial common');
 listener!.event({name:'chat.changed'});
 expect((await screen.findByRole('alert')).textContent).toContain('読み込めませんでした');
 listener!.subscribed();
 expect(await screen.findByText('Recovered common')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
});

it('resizes the instruction columns with keyboard controls within the allowed range',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'common',content:'Common instructions'}]})}));
 render(()=> <InstructionsSettings/>);
 await screen.findByText('Common instructions');
 const handle=screen.getByRole('separator',{name:'相談とインストラクションの幅を調整'});
 const layout=handle.parentElement!;
 const expectRatio=(ratio:number)=>{
  expect(handle.getAttribute('aria-valuenow')).toBe(String(ratio));
  expect(layout.style.getPropertyValue('--instructions-left-ratio')).toBe(`${ratio}fr`);
  expect(layout.style.getPropertyValue('--instructions-right-ratio')).toBe(`${100-ratio}fr`);
 };
 expect(handle.getAttribute('aria-orientation')).toBe('vertical');
 expectRatio(50);
 fireEvent.keyDown(handle,{key:'ArrowRight'});
 expectRatio(52);
 fireEvent.keyDown(handle,{key:'ArrowLeft'});
 expectRatio(50);
 fireEvent.keyDown(handle,{key:'Home'});
 fireEvent.keyDown(handle,{key:'ArrowLeft'});
 expectRatio(20);
 fireEvent.keyDown(handle,{key:'End'});
 fireEvent.keyDown(handle,{key:'ArrowRight'});
 expectRatio(80);
});

it('resizes the chat and references boundary with keyboard controls',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'editor',content:'Editor instructions'}]})}));
 render(()=> <InstructionsSettings/>);
 await screen.findByRole('tab',{name:'要件定義'});
 expect(screen.queryByRole('separator',{name:'プロンプトと下部パネルの高さを調整'})).toBeNull();
 const chatHandle=screen.getByRole('separator',{name:'チャットと変数・ツールの高さを調整'});
 const expectRatio=(handle:HTMLElement,first:string,second:string,ratio:number)=>{
  expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
  expect(handle.getAttribute('aria-valuenow')).toBe(String(ratio));
  expect(handle.parentElement!.style.getPropertyValue(first)).toBe(`${ratio}fr`);
  expect(handle.parentElement!.style.getPropertyValue(second)).toBe(`${100-ratio}fr`);
 };
 const expectChat=(ratio:number)=>expectRatio(chatHandle,'--instructions-chat-ratio','--instructions-references-ratio',ratio);
 expectChat(65);
 fireEvent.keyDown(chatHandle,{key:'ArrowUp'});
 expectChat(63);
 fireEvent.keyDown(chatHandle,{key:'Home'});
 fireEvent.keyDown(chatHandle,{key:'ArrowUp'});
 expectChat(20);
 fireEvent.keyDown(chatHandle,{key:'End'});
 fireEvent.keyDown(chatHandle,{key:'ArrowDown'});
 expectChat(80);
 expect(screen.getByRole('separator',{name:'相談とインストラクションの幅を調整'}).getAttribute('aria-valuenow')).toBe('50');
});

it('selects prompt content by click and keyboard while keeping focus separate from displayed tabs',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'editor',content:'Editor instructions'},{key:'common',content:'Common instructions'},{key:'requirements',content:'Requirements instructions'},{key:'execution',content:'Execution instructions'}]})}));
 render(()=> <InstructionsSettings/>);
 await screen.findByText('Common instructions');
 expect(screen.getByTestId('focus-label').textContent).toBe('未選択');
 const common=screen.getByRole('region',{name:'全共通のフォーカス対象'});
 fireEvent.click(screen.getByText('Common instructions'));
 expect(common.getAttribute('aria-current')).toBe('true');
 expect(common.classList.contains('aura')).toBe(true);
 expect(screen.getByTestId('focus-label').textContent).toBe('全共通');
 fireEvent.click(screen.getByRole('tab',{name:'実装中'}));
 expect(screen.getByTestId('focus-label').textContent).toBe('全共通');
 const execution=screen.getByRole('region',{name:'実装中のフォーカス対象'});
 fireEvent.keyDown(execution,{key:'Enter'});
 expect(screen.getByTestId('focus-label').textContent).toBe('実装中');
 expect(common.classList.contains('aura')).toBe(false);
 fireEvent.click(screen.getByRole('tab',{name:'要件定義'}));
 expect(screen.getByTestId('focus-label').textContent).toBe('実装中');
 const editorTab=within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'編集用'});
 fireEvent.click(editorTab);
 expect(screen.getByTestId('focus-label').textContent).toBe('実装中');
 fireEvent.keyDown(screen.getByRole('region',{name:'編集相談用プロンプトのフォーカス対象'}),{key:' '});
 expect(screen.getByTestId('focus-label').textContent).toBe('編集相談用プロンプト');
 editorTab.focus();
 fireEvent.keyDown(editorTab,{key:'ArrowRight'});
 expect(document.activeElement).toBe(within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'インストラクション'}));
 expect(screen.getByTestId('focus-label').textContent).toBe('編集相談用プロンプト');
 fireEvent.keyDown(document.activeElement!,{key:'Home'});
 expect(document.activeElement).toBe(editorTab);
 expect(screen.getByRole('region',{name:'編集相談用プロンプトのフォーカス対象'}).classList.contains('aura')).toBe(true);
 fireEvent.keyDown(editorTab,{key:'End'});
 expect(within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'インストラクション'}).getAttribute('aria-selected')).toBe('true');
 fireEvent.keyDown(document.activeElement!,{key:'ArrowLeft'});
 expect(document.activeElement).toBe(editorTab);
});

it('applies pending editor content and refreshes the templates',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({instructions:[{key:'editor',content:'New editor'}],editorState:{pending:true,busy:false}})})
  .mockResolvedValueOnce({ok:true,json:async()=>({editorState:{pending:false,busy:false}})})
  .mockResolvedValueOnce({ok:true,json:async()=>({instructions:[{key:'editor',content:'New editor'}],editorState:{pending:false,busy:false}})});
 vi.stubGlobal('fetch',fetch);
 render(()=> <InstructionsSettings/>);
 fireEvent.click(await screen.findByRole('button',{name:'適用'}));
 await vi.waitFor(()=>expect(screen.queryByRole('button',{name:'適用'})).toBeNull());
 expect(fetch.mock.calls[1][0]).toBe('/api/instructions/apply');
 expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({expected_content:'New editor'});
 await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(3));
});
it('keeps pending content visible when apply fails',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({instructions:[{key:'editor',content:'New editor'}],editorState:{pending:true,busy:false}})})
  .mockResolvedValueOnce({ok:false,status:409,json:async()=>({error:'編集内容が更新されました'})}));
 render(()=> <InstructionsSettings/>);
 fireEvent.click(await screen.findByRole('button',{name:'適用'}));
 expect((await screen.findByRole('alert')).textContent).toBe('編集内容が更新されました');
 expect((screen.getByRole('button',{name:'適用'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(within(screen.getByRole('tablist',{name:'プロンプトの種類'})).getByRole('tab',{name:'編集用'}));
 expect(await screen.findByText('New editor')).toBeTruthy();
});
it.each([false,true])('disables apply while editor is busy: %s',async busy=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'editor',content:'Editor'}],editorState:{pending:true,busy}})}));
 render(()=> <InstructionsSettings/>);
 expect((await screen.findByRole('button',{name:'適用'}) as HTMLButtonElement).disabled).toBe(busy);
});
it('hides apply when no editor changes are pending',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'editor',content:'Editor'}],editorState:{pending:false,busy:false}})}));
 render(()=> <InstructionsSettings/>);
 await within(screen.getByRole('tablist',{name:'プロンプトの種類'})).findByRole('tab',{name:'編集用'});
 await vi.waitFor(()=>expect(screen.queryByRole('status')).toBeNull());
 expect(screen.queryByRole('button',{name:'適用'})).toBeNull();
});

it('disables apply while the chat is busy',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'editor',content:'Editor'}],editorState:{pending:true,busy:false}})}));
 render(()=> <InstructionsSettings/>);
 const button=await screen.findByRole('button',{name:'適用'}) as HTMLButtonElement;
 chatMock.busyChange?.(true);
 expect(button.disabled).toBe(true);
 chatMock.busyChange?.(false);
 expect(button.disabled).toBe(false);
});

it('switches reference tabs independently with correctly categorized variables and tools',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({instructions:[{key:'common',content:'Common instructions'},{key:'editor',content:'Editor instructions'}]})}));
 render(()=> <InstructionsSettings/>);
 await screen.findByText('Common instructions');
 const references=within(screen.getByRole('tablist',{name:'変数・ツールの種類'}));
 const prompts=within(screen.getByRole('tablist',{name:'プロンプトの種類'}));
 const panel=()=>document.getElementById(references.getByRole('tab',{selected:true}).getAttribute('aria-controls')!)!;
 expect(references.getByRole('tab',{name:'インストラクション'}).getAttribute('aria-selected')).toBe('true');
 expect(within(panel()).getAllByRole('listitem')).toHaveLength(9);
 expect(panel().querySelectorAll('dt')).toHaveLength(6);
 expect(within(panel()).queryByLabelText('編集相談チャット専用ツール')).toBeNull();
 fireEvent.click(references.getByRole('tab',{name:'編集用'}));
 expect(prompts.getByRole('tab',{name:'インストラクション'}).getAttribute('aria-selected')).toBe('true');
 expect(screen.getByText('Common instructions')).toBeTruthy();
 expect(within(panel()).getByRole('heading',{name:'変数'})).toBeTruthy();
 expect(within(panel()).getByText('なし')).toBeTruthy();
 expect(within(panel()).queryByRole('list')).toBeNull();
 const tools=within(panel()).getByLabelText('編集相談チャット専用ツール');
 expect(tools.querySelectorAll('dt')).toHaveLength(3);
 expect(tools.textContent).toContain('list_instructions一覧の取得（キー・表示名）');
 expect(tools.textContent).toContain('get_instruction本文の取得（指定したキー）');
 expect(tools.textContent).toContain('update_instruction指示の更新・保存（編集相談チャット専用）');
 expect(panel().textContent).not.toContain('list_events');
 fireEvent.click(prompts.getByRole('tab',{name:'編集用'}));
 expect(references.getByRole('tab',{name:'編集用'}).getAttribute('aria-selected')).toBe('true');
 const editor=references.getByRole('tab',{name:'編集用'});
 editor.focus();
 fireEvent.keyDown(editor,{key:'ArrowRight'});
 expect(document.activeElement).toBe(references.getByRole('tab',{name:'インストラクション'}));
 expect(prompts.getByRole('tab',{name:'編集用'}).getAttribute('aria-selected')).toBe('true');
 expect(within(panel()).getAllByRole('listitem')).toHaveLength(9);
 fireEvent.keyDown(document.activeElement!,{key:'ArrowRight'});
 expect(document.activeElement).toBe(editor);
 fireEvent.keyDown(editor,{key:'End'});
 expect(document.activeElement).toBe(references.getByRole('tab',{name:'インストラクション'}));
 fireEvent.keyDown(document.activeElement!,{key:'Home'});
 expect(document.activeElement).toBe(editor);
 fireEvent.keyDown(editor,{key:'ArrowLeft'});
 expect(document.activeElement).toBe(references.getByRole('tab',{name:'インストラクション'}));
 expect(new Set(screen.getAllByRole('tab').map(tab=>tab.id)).size).toBe(screen.getAllByRole('tab').length);
});
