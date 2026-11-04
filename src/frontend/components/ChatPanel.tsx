import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError } from '../api';
import { communication } from '../communication';
import { ChatSync } from '../chat-sync';
import { followChatBottom } from '../chat-scroll';
import type { Pack } from '../../shared/communication';
import type { ChatMessage, CodexStatus, Conversation, Message } from '../types';

interface Draft { text: string; version: number; sending: boolean; error: string; listeners: Set<() => void>; refresh?: () => void }
const drafts = new Map<string, Draft>();
const draftFor = (key: string) => {
  let draft = drafts.get(key);
  if (!draft) { draft = { text: '', version: 0, sending: false, error: '', listeners: new Set() }; drafts.set(key, draft); }
  return draft;
};
const stateLabel: Record<ChatMessage['status'], string> = { pending: '送信待ち', streaming: '応答中', completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明' };

export default function ChatPanel(props: { projectId: number; taskId?: number; legacyMessages?: Message[] }) {
  const [conversationState,setConversationState]=createStore<{value?:Conversation}>({});
  const conversation=()=>conversationState.value;
  const setConversation=(value:Conversation|undefined)=>setConversationState('value',value===undefined?undefined:reconcile(value,{key:'id'}));
  const [packState, setPackState] = createStore<{value: Pack[]}>({value: []});
  const [syncError, setSyncError] = createSignal('');
  const [status, setStatus] = createSignal<CodexStatus>();
  const [text, setText] = createSignal('');
  const [model, setModel] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loadError, setLoadError] = createSignal('');
  const [interrupting, setInterrupting] = createSignal(false);
  const key = () => `${props.projectId}:${props.taskId ?? 'general'}`;
  const query = () => `/api/chat?projectId=${props.projectId}${props.taskId === undefined ? '' : `&taskId=${props.taskId}`}`;
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
    let active = true, sequence = 0,fetching=false,reload=false;
    const sync = new ChatSync({ projectId: props.projectId, taskId: props.taskId ?? null }, packs => { if (active) setPackState('value', reconcile(packs, {key: 'packId'})); }, message => { if (active) setSyncError(message); });
    const updateDraft = () => { setText(draft.text); setSending(draft.sending); setError(draft.error); };
    draft.listeners.add(updateDraft);
    setConversation(undefined); updateDraft(); setLoadError(''); setSyncError(''); setInterrupting(false);
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
      const request = ++sequence;
      try { const value = await api<Conversation>(url); if (active && request === sequence) { setConversation(value); setLoadError(''); } }
      catch { if (active && request === sequence) setLoadError('履歴を取得できませんでした'); }
      }while(reload&&active);fetching=false;
    };
    const refreshCurrent = () => { void load(); sync.refresh(); };
    refresh = refreshCurrent; draft.refresh = refreshCurrent;
    void load(); sync.refresh();
    void api<CodexStatus>('/api/codex/status').then(value => { if (active) { setStatus(value); setModel(previous => value.models?.some(item => item.id === previous) ? previous : value.models?.[0]?.id ?? ''); } }).catch(() => { if (active) setStatus(undefined); });
    const unsubscribe = communication.subscribe('chat', { projectId: props.projectId, taskId: props.taskId ?? null }, {
      subscribed: () => { if (active) { sync.subscribed(); void load(); } },
      event: event => { if (active) { sync.event(event); if (event.name === 'chat.changed') void load(); } },
      error: message => { if (active) setSyncError(message); },
    });
    onCleanup(() => { active = false; sequence++; unsubscribe(); sync.dispose(); draft.listeners.delete(updateDraft); if (draft.refresh === refreshCurrent) draft.refresh = undefined; });
  });
  const latestOutcome = () => {
    const message = conversation()?.messages.findLast(message => message.role === 'assistant');
    return message && (message.status === 'failed' || message.status === 'interrupted' || message.status === 'unknown') ? stateLabel[message.status] : undefined;
  };
  const busy = () => sending() || !!conversation()?.messages.some(message => message.status === 'pending' || message.status === 'streaming');
  async function send(event: SubmitEvent) {
    event.preventDefault();
    const currentKey = key(), draft = draftFor(currentKey), content = draft.text, version = draft.version;
    if (draft.sending || busy() || !conversation() || loadError() || !content.trim() || status()?.auth !== 'chatgpt' || !model()) return;
    draft.sending = true; draft.error = ''; draft.listeners.forEach(listener => listener());
    try {
      await api('/api/chat/send', { projectId: props.projectId, taskId: props.taskId ?? null, content, model: model() });
      if (draft.version === version) draft.text = '';
      draft.listeners.forEach(listener => listener());
      draft.refresh?.();
    } catch (error) {
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
    try { await api('/api/chat/interrupt', { projectId: props.projectId, taskId: props.taskId ?? null }); }
    catch { if (key() === currentKey) setError('中断を確認できませんでした。状態を確認してください。'); }
    finally { if (key() === currentKey) { setInterrupting(false); refresh(); } }
  }
  return <>
    <p class="border-b border-base-300 px-4 py-2 text-xs text-base-content/60">{props.taskId === undefined ? 'ジェネラルは読み取り専用です。コマンド実行や MCP は無効です。' : `このタスクの .beni/tasks/${props.taskId}/ 内で文書を読み書きします。コマンド実行はこのフォルダへの書き込みに限定し、外部ツールとネットワークは無効です。`}</p>
    <Show when={status()?.auth === 'none'}><p class="px-4 pt-3 text-sm">Codex にログインしてください。</p></Show>
    <Show when={status() && !status()!.installed}><p class="px-4 pt-3 text-sm">Codex CLI をインストールしてください。</p></Show>
    <Show when={status()?.auth === 'apiKey' || status()?.auth === 'other'}><p class="px-4 pt-3 text-sm">Codex はサブスクリプション以外の認証方式です。設定を確認してください。</p></Show>
    <Show when={loadError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{loadError()}</p></Show>
    <Show when={syncError()}><p role="alert" class="px-4 pt-3 text-sm text-error">{syncError()} <button class="btn btn-xs" onClick={() => refresh()}>更新</button></p></Show>
    <div ref={scrollport} class="min-h-0 flex-1 overflow-y-auto p-5" role="log" aria-label="チャット履歴" aria-live="polite">
      <div ref={scrollContent} class="space-y-3">
        <Show when={props.legacyMessages?.length}><section aria-label="以前の履歴"><p class="mb-2 text-xs text-base-content/60">以前の履歴（読み取り専用）</p><For each={props.legacyMessages}>{message => <article class={`chat ${message.role === 'user' ? 'chat-end' : 'chat-start'}`}><div class="chat-header text-xs text-base-content/60">{message.role === 'user' ? 'あなた' : message.role === 'assistant' ? 'アシスタント' : message.role}</div><div class={`chat-bubble min-w-0 ${message.role === 'user' ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}><p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p></div><div class="chat-footer text-xs text-base-content/60">読み取り専用</div></article>}</For></section></Show>
        <Show when={packState.value.length} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}><For each={packState.value}>{pack => <article class={`chat ${pack.role === 'user' ? 'chat-end' : 'chat-start'}`}><div class="chat-header text-xs text-base-content/60">{pack.role === 'user' ? 'あなた' : 'アシスタント'} · codex{pack.model ? ` · ${pack.model}` : ''}</div><div class={`chat-bubble min-w-0 ${pack.role === 'user' ? 'chat-bubble-primary' : 'bg-base-200 text-base-content'}`}><Show when={pack.kind === 'tool'} fallback={<p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{pack.content}</p>}><details><summary>{pack.tool?.name ?? 'ツール'}</summary><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.input}</pre><pre class="whitespace-pre-wrap break-words text-xs">{pack.tool?.output}</pre></details></Show></div><div class="chat-footer text-xs text-base-content/60">{stateLabel[pack.status]}</div></article>}</For></Show>
      </div>
    </div>
    <Show when={busy()}><div role="status" class="mx-4 mb-3 self-start"><div class="aura text-primary motion-reduce:animate-none"><div class="card bg-base-100 px-4 py-2 text-sm text-base-content">作業中…</div></div></div></Show>
    <Show when={latestOutcome()}><p role="status" class="mx-4 mb-2 text-sm">直近の応答: {latestOutcome()}</p></Show>
    <Show when={error()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{error()}</p></Show>
    <form class="border-t border-base-300 p-4" onSubmit={send}>
      <textarea class="textarea textarea-bordered min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" required value={text()} onInput={event => { const draft = draftFor(key()); draft.text = event.currentTarget.value; draft.version++; setText(draft.text); }} />
      <div class="mt-2 flex items-center justify-end gap-2"><span class="text-xs">Codex</span><select class="select select-bordered select-sm" aria-label="モデル" value={model()} disabled={!status()?.models?.length} onChange={event => setModel(event.currentTarget.value)}><Show when={status()?.models?.length} fallback={<option value="">未確認</option>}><For each={status()?.models}>{item => <option value={item.id}>{item.name}</option>}</For></Show></select><Show when={busy()}><button type="button" class="btn btn-sm" disabled={interrupting()} onClick={interrupt}>中断</button></Show><button class="btn btn-primary btn-sm" type="submit" disabled={busy() || !text().trim() || status()?.auth !== 'chatgpt' || !model() || !conversation() || !!loadError()}>{busy() ? '応答中...' : '送信'}</button></div>
    </form>
  </>;
}
