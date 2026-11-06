import { createSignal, createUniqueId, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { api } from '../api';
import { communication } from '../communication';
import MarkdownPreview from './MarkdownPreview';
import ChatPanel from './ChatPanel';
import ResizeHandle from './ResizeHandle';
import { phaseLabels } from './PhaseIndicator';
import { taskPhases as phases, type TaskPhase } from '../../shared/task-phase';

const labels: Record<string, string> = {editor:'編集相談用プロンプト', common:'全共通', ...phaseLabels};
const variables = [
 { name: 'project_directory', description: 'プロジェクトのディレクトリ' },
 { name: 'working_directory', description: '作業ディレクトリ' },
 { name: 'task_id', description: 'タスクID' },
 { name: 'task_directory', description: 'タスク文書のディレクトリ' },
 { name: 'phase', description: '現在のフェーズ' },
 { name: 'knowledge_path', description: 'ナレッジのパス' },
 { name: 'knowledge_content', description: 'ナレッジの本文' },
 { name: 'execution_chat_path', description: '実装中チャットのパス' },
 { name: 'retrospective_chat_path', description: '反省会チャットのパス' },
];
const variableLabels = Object.fromEntries(variables.map(variable => [variable.name, variable.description]));
const embeddedTools = [
 { name: 'list_events', description: 'イベント一覧の取得' },
 { name: 'get_event', description: 'イベント詳細の取得' },
 { name: 'get_file_change', description: 'ファイル変更差分の取得' },
 { name: 'get_file_version', description: '過去のファイル版の取得' },
 { name: 'get_execution_output', description: 'ツール・コマンドの実行出力の取得' },
 { name: 'acknowledge_events', description: 'イベントの確認済み位置の更新' },
];
export default function InstructionsSettings() {
 const [instructions, setInstructions] = createSignal<{key:string;content:string}[]>([]);
 const [instructionFocus, setInstructionFocus] = createSignal<string|null>(null);
 const [selected, setSelected] = createSignal<TaskPhase>('requirements');
 const [leftRatio, setLeftRatio] = createSignal(50);
 const [selectedGroup, setSelectedGroup] = createSignal('instructions');
 const [chatRatio, setChatRatio] = createSignal(65);
 let leftPanels: HTMLElement | undefined;
 let layout: HTMLDivElement | undefined;
 const tabId = createUniqueId();
 const [loading, setLoading] = createSignal(true);
 const [error, setError] = createSignal('');
 const [editorState, setEditorState] = createSignal({pending:false,busy:false});
 const [chatBusy, setChatBusy] = createSignal(false);
 const [applying, setApplying] = createSignal(false);
 const [applyError, setApplyError] = createSignal('');
 let reloadInstructions = async () => {};
 const applyEditor = async () => {
  if (applying() || chatBusy() || editorState().busy || !editorState().pending) return;
  setApplying(true); setApplyError('');
  try {
   const result = await api<{editorState:{pending:boolean;busy:boolean}}>('/api/instructions/apply', {expected_content:instructions().find(item=>item.key==='editor')?.content ?? ''});
   setEditorState(result.editorState);
   await reloadInstructions();
  } catch (cause) { setApplyError(cause instanceof Error ? cause.message : '適用できませんでした'); }
  finally { setApplying(false); }
 };
 onMount(() => {
  let active = true, sequence = 0;
  const reload = async () => {
   const request = ++sequence;
   try {
    const data=await api<{instructions?:unknown;editorState?:{pending:boolean;busy:boolean}}>('/api/instructions');
    if (!active || request !== sequence) return;
    if (!Array.isArray(data?.instructions) || !data.instructions.length || data.instructions.some(item=>!item || typeof item.key!=='string' || typeof item.content!=='string')) throw Error('Invalid instructions');
    setInstructions(data.instructions);
    setEditorState(data.editorState ?? {pending:false,busy:false});
    setError('');
   }
   catch { if (active && request === sequence) setError('インストラクションを読み込めませんでした'); }
   finally { if (active && request === sequence) setLoading(false); }
  };
  reloadInstructions = reload;
  const unsubscribe = communication.subscribe('chat', { projectId: 'instructions', taskId: null }, {
   subscribed: () => { void reload(); },
   event: event => { if (event.name === 'chat.changed') void reload(); },
   error: () => {},
  });
  onCleanup(() => { active = false; sequence++; unsubscribe(); });
  void reload();
 });
 return <div ref={layout} class="instructions-layout grid min-w-0 items-start gap-6" style={{"--instructions-left-ratio": `${leftRatio()}fr`, "--instructions-right-ratio": `${100-leftRatio()}fr`}}>
  <aside ref={leftPanels} class="instructions-left min-w-0 space-y-6" style={{"--instructions-chat-ratio": `${chatRatio()}fr`, "--instructions-references-ratio": `${100-chatRatio()}fr`}}>
   <section class="instructions-chat flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-base-300 bg-base-100 shadow-sm">
    <div class="flex shrink-0 items-center justify-between border-b border-base-300 px-4 py-3"><h2 class="text-sm font-bold">インストラクション相談</h2><Show when={editorState().pending}><button type="button" class="btn btn-primary btn-sm" disabled={chatBusy() || editorState().busy || applying()} onClick={applyEditor}>{applying() ? '適用中...' : '適用'}</button></Show></div>
    <Show when={applyError()}><p role="alert" class="px-4 py-2 text-sm text-error">{applyError()}</p></Show>
    <div class="instructions-chat-content flex h-[clamp(28rem,65vh,48rem)] min-h-0 flex-col"><ChatPanel projectId="instructions" onBusyChange={setChatBusy} instructionFocus={instructionFocus()} instructionFocusLabel={instructionFocus() ? labels[instructionFocus()!] : undefined}/></div>
   </section>
   <ResizeHandle orientation="horizontal" label="チャットと変数・ツールの高さを調整" container={() => leftPanels} value={chatRatio()} onChange={setChatRatio}/>
   <InstructionReferences/>
  </aside>
  <ResizeHandle orientation="vertical" label="相談とインストラクションの幅を調整" container={() => layout} value={leftRatio()} onChange={setLeftRatio}/>
  <section class="instructions-content min-h-0 min-w-0 overflow-auto rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-6">
  <div role="tablist" aria-label="プロンプトの種類" class="tabs tabs-border flex-nowrap">
   <For each={['editor', 'instructions']}>{(group,index)=><button type="button" role="tab"
    id={`${tabId}-group-${group}`} aria-controls={`${tabId}-group-panel`} aria-selected={selectedGroup()===group}
    tabIndex={selectedGroup()===group?0:-1} class={`tab whitespace-nowrap ${selectedGroup()===group?'tab-active':''}`}
    onClick={()=>setSelectedGroup(group)} onKeyDown={event=>{
     let next:number;
     if(event.key==='ArrowRight'||event.key==='ArrowLeft') next=1-index();
     else if(event.key==='Home') next=0;
     else if(event.key==='End') next=1;
     else return;
     event.preventDefault();
     const nextGroup=['editor','instructions'][next];
     setSelectedGroup(nextGroup);
     document.getElementById(`${tabId}-group-${nextGroup}`)?.focus();
    }}>{group==='editor'?'編集用':'インストラクション'}</button>}</For>
  </div>
  <div role="tabpanel" id={`${tabId}-group-panel`} aria-labelledby={`${tabId}-group-${selectedGroup()}`} tabIndex={0}>
  <Show when={loading()}><p role="status" class="mt-3 text-sm">読み込み中...</p></Show>
  <Show when={error()}><p role="alert" class="mt-3 text-sm text-error">{error()}</p></Show>
  <Show when={!loading() && !error()}>
   <Show when={selectedGroup()==='editor'} fallback={<>
   <h3 class="mt-4 text-sm font-bold">全共通</h3>
   <FocusPrompt label={labels.common} selected={instructionFocus()==='common'} onSelect={()=>setInstructionFocus('common')}><MarkdownPreview variableLabels={variableLabels} content={instructions().find(item=>item.key==='common')?.content??''}/></FocusPrompt>
   <div role="tablist" aria-label="フェーズ別インストラクション" class="tabs tabs-border mt-6 flex-nowrap overflow-x-auto">
    <For each={phases}>{(phase, index)=><button
     type="button"
     role="tab"
     id={`${tabId}-${phase}`}
     aria-controls={`${tabId}-panel`}
     aria-selected={selected()===phase}
     tabIndex={selected()===phase?0:-1}
     class={`tab shrink-0 whitespace-nowrap ${selected()===phase?'tab-active':''}`}
     onClick={()=>setSelected(phase)}
     onKeyDown={event=>{
      let next: number;
      if (event.key==='ArrowRight') next=(index()+1)%phases.length;
      else if (event.key==='ArrowLeft') next=(index()+phases.length-1)%phases.length;
      else if (event.key==='Home') next=0;
      else if (event.key==='End') next=phases.length-1;
      else return;
      event.preventDefault();
      setSelected(phases[next]);
      document.getElementById(`${tabId}-${phases[next]}`)?.focus();
     }}
    >{labels[phase]}</button>}</For>
   </div>
   <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${selected()}`} tabIndex={0}>
    <FocusPrompt label={labels[selected()]} selected={instructionFocus()===selected()} onSelect={()=>setInstructionFocus(selected())}><MarkdownPreview variableLabels={variableLabels} content={instructions().find(item=>item.key===selected())?.content??''}/></FocusPrompt>
   </div>
   </>}>
    <h3 class="mt-4 text-sm font-bold">編集相談用プロンプト</h3>
    <FocusPrompt label={labels.editor} selected={instructionFocus()==='editor'} onSelect={()=>setInstructionFocus('editor')}><MarkdownPreview content={instructions().find(item=>item.key==='editor')?.content??''}/></FocusPrompt>
   </Show>
  </Show>
  </div>
 </section>
 </div>;
}

function FocusPrompt(props: {label:string; selected:boolean; onSelect:()=>void; children:JSX.Element}) {
 return <div class="p-2">
  <div role="region" aria-label={`${props.label}のフォーカス対象`} aria-current={props.selected ? 'true' : 'false'} tabIndex={0}
   class={`w-full rounded-lg p-[.125rem] ${props.selected ? 'aura text-primary motion-reduce:animate-none' : ''}`}
   onClick={event=>{if (!(event.target as HTMLElement).closest('a,button,input,select,textarea')) props.onSelect();}}
   onKeyDown={event=>{if(event.target===event.currentTarget && (event.key==='Enter'||event.key===' ')){event.preventDefault();props.onSelect();}}}>
   <div class="relative rounded-lg bg-base-100 p-2 text-base-content">{props.children}</div>
  </div>
 </div>;
}

export function InstructionReferences() {
 const [selectedGroup, setSelectedGroup] = createSignal('instructions');
 const tabId = createUniqueId();
 return <section class="instructions-references min-h-0 min-w-0 overflow-auto rounded-2xl border border-base-300 bg-base-100 p-4 shadow-sm sm:p-6">
  <div role="tablist" aria-label="変数・ツールの種類" class="tabs tabs-border flex-nowrap">
   <For each={['editor', 'instructions']}>{(group,index)=><button type="button" role="tab"
    id={`${tabId}-${group}`} aria-controls={`${tabId}-panel`} aria-selected={selectedGroup()===group}
    tabIndex={selectedGroup()===group?0:-1} class={`tab whitespace-nowrap ${selectedGroup()===group?'tab-active':''}`}
    onClick={()=>setSelectedGroup(group)} onKeyDown={event=>{
     let next:number;
     if(event.key==='ArrowRight'||event.key==='ArrowLeft') next=1-index();
     else if(event.key==='Home') next=0;
     else if(event.key==='End') next=1;
     else return;
     event.preventDefault();
     const nextGroup=['editor','instructions'][next];
     setSelectedGroup(nextGroup);
     document.getElementById(`${tabId}-${nextGroup}`)?.focus();
    }}>{group==='editor'?'編集用':'インストラクション'}</button>}</For>
  </div>
  <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${selectedGroup()}`} tabIndex={0}>
  <h2 class="mt-4 text-sm font-bold">変数</h2>
  <Show when={selectedGroup()==='instructions'} fallback={<p class="mt-3 text-sm">なし</p>}>
   <ul aria-label="埋め込み変数" class="mt-3 flex flex-wrap gap-2">
    <For each={variables}>{variable=><li class="badge badge-soft badge-primary h-auto max-w-full whitespace-normal text-xs">{variable.description}</li>}</For>
   </ul>
  </Show>
  <h2 class="mt-6 text-sm font-bold">埋め込みツール</h2>
  <Show when={selectedGroup()==='editor'} fallback={
   <dl aria-label="埋め込みツール" class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
    <For each={embeddedTools}>{tool=><>
     <dt class="break-all"><code>{tool.name}</code></dt>
     <dd class="min-w-0">{tool.description}</dd>
    </>}</For>
   </dl>
  }>
   <dl aria-label="編集相談チャット専用ツール" class="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
    <dt class="break-all"><code>list_instructions</code></dt>
    <dd class="min-w-0">一覧の取得（キー・表示名）</dd>
    <dt class="break-all"><code>get_instruction</code></dt>
    <dd class="min-w-0">本文の取得（指定したキー）</dd>
    <dt class="break-all"><code>update_instruction</code></dt>
    <dd class="min-w-0">指示の更新・保存（編集相談チャット専用）</dd>
   </dl>
  </Show>
  </div>
 </section>;
}
