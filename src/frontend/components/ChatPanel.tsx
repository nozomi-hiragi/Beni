import { createMemo, createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError } from '../api';
import { communication } from '../communication';
import { ChatSync } from '../chat-sync';
import { followChatBottom } from '../chat-scroll';
import type { Pack, TaskPhase } from '../../shared/communication';
import { availableModels, chooseModel, loadModels, modelIsAvailable, modelLabel, modelScope, modelStatus, modelValue, providerName, providerReady, rejectModel, selectedModel } from '../model-cache';
import type { ChatMessage, Conversation, Model } from '../types';

interface Draft { text: string; version: number; sending: boolean; error: string; listeners: Set<() => void>; refresh?: () => void; pending?: {content: string; version: number; sendId?: string}; restored: Set<string> }
const drafts = new Map<string, Draft>();
const draftFor = (key: string) => {
  let draft = drafts.get(key);
  if (!draft) { draft = { text: '', version: 0, sending: false, error: '', listeners: new Set(), restored: new Set() }; drafts.set(key, draft); }
  return draft;
};
const restoreDraft = (draft: Draft, content: string) => {
  if (!draft.text.startsWith(content)) draft.text = draft.text ? `${content}\n${draft.text}` : content;
};
const stateLabel: Record<ChatMessage['status'], string> = { pending: '送信待ち', streaming: '応答中', completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明' };

export default function ChatPanel(props: { projectId: string; taskId?: string; phase?: TaskPhase; readOnly?: boolean; instructionFocus?: string | null; instructionFocusLabel?: string; onModelUnavailable?: (model: string, provider?: Model['provider']) => void; onBusyChange?: (busy: boolean) => void; onModelChange?: (model: Model | null) => void }) {
  const [conversationState,setConversationState]=createStore<{value?:Conversation}>({});
  const conversation=()=>conversationState.value;
  const setConversation=(value:Conversation|undefined)=>setConversationState('value',value===undefined?undefined:reconcile(value,{key:'id'}));
  const [packState, setPackState] = createStore<{value: Pack[]}>({value: []});
  const [syncError, setSyncError] = createSignal('');
  const status = () => modelStatus();
  const models = createMemo(availableModels);
  const [text, setText] = createSignal('');
  const key = () => modelScope(props.projectId, props.taskId, props.phase);
  const selection = () => selectedModel(key());
  const model = () => selection() ? modelValue(selection()!) : '';
  const modelAvailable = () => modelIsAvailable(key());
  createEffect(() => props.onModelChange?.(modelAvailable() ? selection()! : null));
  function selectModel(value: string) {
    const available = models().find(item => modelValue(item) === value);
    if (available) chooseModel(key(), available);
  }
  let modelSelect: HTMLSelectElement | undefined;
  createEffect(() => { model(); models(); queueMicrotask(() => { if(modelSelect)modelSelect.value=model(); }); });
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loadError, setLoadError] = createSignal('');
  const [interrupting, setInterrupting] = createSignal(false);
  const query = () => `/api/chat?projectId=${props.projectId}${props.taskId === undefined ? '' : `&taskId=${props.taskId}&phase=${props.phase}`}`;
  let scrollport!: HTMLDivElement, scrollContent!: HTMLDivElement;
  let bottomFollow: ReturnType<typeof followChatBottom> | undefined;
  onMount(() => {
    bottomFollow = followChatBottom(scrollport, scrollContent);
    onCleanup(() => bottomFollow?.dispose());
  });
  createEffect(() => { key(); bottomFollow?.reset(); });
  let refresh: () => void = () => {};
  createEffect(() => {
    const currentKey = key(), url = query(), draft = draftFor(currentKey);
    const controller = new AbortController();
    let modelRefreshRequested = !untrack(() => selectedModel(currentKey)) || untrack(() => !modelIsAvailable(currentKey));
    const hadModels = !!untrack(() => status() || modelStatus('claude'));
    let active = true, sequence = 0,fetching=false,reload=false;
    const sync = new ChatSync({ projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }, packs => { if (active) setPackState('value', reconcile(packs, {key: 'packId'})); }, message => { if (active) setSyncError(message); });
    const updateDraft = () => { setText(draft.text); setSending(draft.sending); setError(draft.error); };
    draft.listeners.add(updateDraft);
    setConversation(undefined); updateDraft(); setLoadError(''); setSyncError(''); setInterrupting(false);
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
      const request = ++sequence;
      try { const value = await api<Conversation>(url, undefined, controller.signal); if (active && request === sequence) { if (!untrack(() => selectedModel(currentKey)) && value.selectedModel) { chooseModel(currentKey, value.selectedModel); if (hadModels && !untrack(() => modelIsAvailable(currentKey)) && modelRefreshRequested) {modelRefreshRequested = false; void loadModels(true, value.selectedModel.provider ?? 'codex').catch(() => {});} } sync.conversation(value.id); setConversation(value); setLoadError(''); } }
      catch { if (active && request === sequence) setLoadError('履歴を取得できませんでした'); }
      }while(reload&&active);fetching=false;
    };
    const refreshCurrent = () => { void load(); sync.refresh(); };
    refresh = refreshCurrent; draft.refresh = refreshCurrent;
    void load(); sync.refresh();
    void loadModels(false).catch(() => {});
    if (untrack(() => !!selectedModel(currentKey) && !modelIsAvailable(currentKey))) void loadModels(true, untrack(() => selectedModel(currentKey)?.provider)).catch(() => {});
    const unsubscribe = communication.subscribe('chat', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }, {
      subscribed: () => { if (active) { sync.subscribed(); void load(); } },
      event: event => { if (active) { sync.event(event); if (event.name === 'chat.changed') void load(); } },
      error: message => { if (active) setSyncError(message); },
    });
    onCleanup(() => { active = false; sequence++; controller.abort(); unsubscribe(); sync.dispose(); draft.listeners.delete(updateDraft); if (draft.refresh === refreshCurrent) draft.refresh = undefined; });
  });
  createEffect(() => {
    const value = conversation(), available = models().find(item => providerReady(item.provider)), scope = key();
    if (value && !selectedModel(scope) && available) chooseModel(scope, available);
    const rejected = value?.messages.filter(message => message.errorCode === 'MODEL_UNAVAILABLE') ?? [];
    const draft = draftFor(scope);
    for (const message of rejected) {
      if (message.model) props.onModelUnavailable?.(message.model, message.provider);
      if (!draft.pending?.sendId || draft.pending.sendId !== message.sendId || draft.restored.has(message.sendId)) continue;
      draft.restored.add(message.sendId);
      if (message.model) rejectModel(scope, message.model, message.provider);
      const content = value?.messages.find(item => item.sendId === message.sendId && item.role === 'user')?.content;
      if (content && draft.pending?.content === content) {
        restoreDraft(draft, content);
        draft.pending = undefined;
        draft.error = '選択したモデルを利用できません。別のモデルを選択してください。';
        draft.listeners.forEach(listener => listener());
      }
    }
  });
  const latestOutcome = () => {
    const message = conversation()?.messages.findLast(message => message.role === 'assistant');
    return message && (message.status === 'failed' || message.status === 'interrupted' || message.status === 'unknown') ? stateLabel[message.status] : undefined;
  };
  const busy = () => sending() || !!conversation()?.messages.some(message => message.status === 'pending' || message.status === 'streaming');
  createEffect(() => props.onBusyChange?.(busy()));
  const validInstructionFocus = () => props.projectId !== 'instructions' || ['common','requirements','documents','implementation','execution','retrospective','editor'].includes(props.instructionFocus ?? '');
  async function send(event: SubmitEvent) {
    event.preventDefault();
    const currentKey = key(), draft = draftFor(currentKey), content = draft.text, version = draft.version, sentModel = selection(), sentInstructionFocus = props.instructionFocus;
    if (!validInstructionFocus() || props.readOnly || draft.sending || busy() || !conversation() || loadError() || !content.trim() || !modelAvailable()) return;
    draft.sending = true; draft.error = ''; draft.listeners.forEach(listener => listener());
    try {
      draft.pending = {content, version};
      const accepted = await api<Conversation>('/api/chat/send', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }), ...(props.projectId === 'instructions' ? {instructionFocus: sentInstructionFocus} : {}), content, model: sentModel!.id, provider: sentModel!.provider ?? 'codex' });
      if (draft.pending) { draft.pending.sendId = accepted.messages?.findLast(message => message.role === 'user')?.sendId; if (draft.version === version) draft.text = ''; }
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } catch (error) {
      draft.pending = undefined;
      if (error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE') { rejectModel(currentKey, sentModel!.id, sentModel!.provider); restoreDraft(draft, content); }
      draft.error = error instanceof ApiError && error.status >= 400 && error.status < 500 ? `送信できませんでした: ${error.message}` : '送信を確認できませんでした。履歴を確認してから再送してください。';
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } finally {
      draft.sending = false;
      draft.listeners.forEach(listener => listener());
    }
  }
  async function interrupt() {
    const currentKey = key(); setInterrupting(true); setError('');
    try { await api('/api/chat/interrupt', { projectId: props.projectId, taskId: props.taskId ?? null, ...(props.taskId === undefined ? {} : { phase: props.phase }) }); }
    catch { if (key() === currentKey) setError('中断を確認できませんでした。状態を確認してください。'); }
    finally { if (key() === currentKey) { setInterrupting(false); refresh(); } }
  }
  return <>
    <Show when={status()?.auth === 'none'}><p class="px-4 pt-3 text-sm">Codex にログインしてください。</p></Show>
    <Show when={status() && !status()!.installed}><p class="px-4 pt-3 text-sm">Codex CLI をインストールしてください。</p></Show>
    <Show when={status()?.auth === 'apiKey' || status()?.auth === 'other'}><p class="px-4 pt-3 text-sm">Codex はサブスクリプション以外の認証方式です。設定を確認してください。</p></Show>
    <Show when={loadError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{loadError()}</p></Show>
    <Show when={syncError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{syncError()} <button class="btn btn-xs" onClick={() => refresh()}>更新</button></p></Show>
    <div ref={scrollport} class="min-h-0 flex-1 overflow-y-auto p-5" role="log" aria-label="チャット履歴" aria-live="polite">
      <div ref={scrollContent} class="space-y-3">
        <Show when={packState.value.length} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}><For each={packState.value}>{pack => <article class={`chat ${pack.role === 'user' ? 'chat-end' : 'chat-start'}`}><div class="chat-header text-xs text-base-content/60">{pack.role === 'user' ? 'あなた' : 'アシスタント'} · {pack.model ? modelLabel(pack.model, pack.provider) : providerName(pack.provider)}</div><div class={`chat-bubble min-w-0 ${pack.role === 'user' ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}><Show when={pack.kind === 'tool'} fallback={<p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{pack.content}</p>}><details><summary>{pack.tool?.name ?? 'ツール'}</summary><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.input}</pre><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.output}</pre></details></Show></div><div class="chat-footer text-xs text-base-content/60">{stateLabel[pack.status]}</div></article>}</For></Show>
      </div>
    </div>
    <Show when={busy()}><div role="status" class="mx-4 mb-3 self-start"><div class="aura text-primary motion-reduce:animate-none"><div class="card bg-base-100 px-4 py-2 text-sm text-base-content">作業中…</div></div></div></Show>
    <Show when={latestOutcome()}><p role="status" class="mx-4 mb-2 text-sm">直近の応答: {latestOutcome()}</p></Show>
    <Show when={error()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{error()}</p></Show>
    <Show when={!props.readOnly}><form class="border-t border-base-300 p-4" onSubmit={send}>
      <textarea class="textarea textarea-bordered min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" required value={text()} onInput={event => { const draft = draftFor(key()); draft.text = event.currentTarget.value; draft.version++; setText(draft.text); }} />
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2"><Show when={props.projectId==='instructions'}><span class="mr-auto text-xs text-base-content/70">フォーカス: {props.instructionFocusLabel ?? '未選択'}</span></Show><select ref={modelSelect} class="select select-bordered select-sm w-auto" style={{ 'field-sizing': 'content' }} aria-label="モデル" value={model()} disabled={busy() || !models().length} onChange={event => selectModel(event.currentTarget.value)}><Show when={model() && !modelAvailable()}><option value={model()} selected disabled>⚠️ {modelLabel(selection()?.name ?? model(), selection()?.provider)}</option></Show><Show when={models().length} fallback={<Show when={!model()}><option value="">未確認</option></Show>}><For each={models().filter(item => modelAvailable() || modelValue(item) !== model())}>{item => <option value={modelValue(item)} selected={modelValue(item) === model()} disabled={!providerReady(item.provider)}>{modelLabel(item.name, item.provider)}</option>}</For></Show></select><Show when={busy()}><button type="button" class="btn btn-sm" disabled={interrupting()} onClick={interrupt}>中断</button></Show><button class="btn btn-primary btn-sm" type="submit" disabled={!validInstructionFocus() || busy() || !text().trim() || !modelAvailable() || !conversation() || !!loadError()}>{busy() ? '応答中...' : '送信'}</button></div>
    </form></Show>
  </>;
}
