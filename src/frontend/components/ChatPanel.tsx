import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError } from '../api';
import type { ChatMessage, CodexStatus, Conversation, Message } from '../types';

interface Draft { text: string; version: number; sending: boolean; error: string; listeners: Set<() => void> }
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
  const [status, setStatus] = createSignal<CodexStatus>();
  const [text, setText] = createSignal('');
  const [model, setModel] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loadError, setLoadError] = createSignal('');
  const [interrupting, setInterrupting] = createSignal(false);
  const key = () => `${props.projectId}:${props.taskId ?? 'general'}`;
  const query = () => `/api/chat?projectId=${props.projectId}${props.taskId === undefined ? '' : `&taskId=${props.taskId}`}`;
  let refresh: () => void = () => {};
  createEffect(() => {
    const currentKey = key(), url = query(), draft = draftFor(currentKey);
    let active = true, sequence = 0,fetching=false,reload=false;
    const updateDraft = () => { setText(draft.text); setSending(draft.sending); setError(draft.error); };
    draft.listeners.add(updateDraft);
    setConversation(undefined); updateDraft(); setLoadError(''); setInterrupting(false);
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
      const request = ++sequence;
      try { const value = await api<Conversation>(url); if (active && request === sequence) { setConversation(value); setLoadError(''); } }
      catch { if (active && request === sequence) setLoadError('履歴を取得できませんでした'); }
      }while(reload&&active);fetching=false;
    };
    refresh = () => { void load(); };
    void load();
    void api<CodexStatus>('/api/codex/status').then(value => { if (active) { setStatus(value); setModel(previous => value.models?.some(item => item.id === previous) ? previous : value.models?.[0]?.id ?? ''); } }).catch(() => { if (active) setStatus(undefined); });
    const events=typeof EventSource === 'undefined'?undefined:new EventSource(url.replace('/api/chat?','/api/chat/events?'));
    events?.addEventListener('change',()=>{if(active)void load()});
    if(events)events.onerror=()=>{if(active)setLoadError('チャットの更新接続を再試行しています')};
    onCleanup(() => { active = false; sequence++; events?.close(); draft.listeners.delete(updateDraft); });
  });
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
      if (key() === currentKey) refresh();
    } catch (error) {
      draft.error = error instanceof ApiError && error.status >= 400 && error.status < 500 ? `送信できませんでした: ${error.message}` : '送信を確認できませんでした。履歴を確認してから再送してください。';
      draft.listeners.forEach(listener => listener());
      if (key() === currentKey) refresh();
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
    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
      <Show when={props.legacyMessages?.length}><section aria-label="以前の履歴"><p class="mb-2 text-xs text-base-content/60">以前の履歴（読み取り専用）</p><For each={props.legacyMessages}>{message => <article class="mb-3 rounded-xl bg-base-200 px-4 py-3"><p class="mb-1 text-xs font-medium text-base-content/55">{message.role === 'user' ? 'あなた' : message.role === 'assistant' ? 'アシスタント' : message.role}</p><p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p></article>}</For></section></Show>
      <Show when={conversation()?.messages.length} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}><For each={conversation()?.messages}>{message => <article class="rounded-xl bg-base-200 px-4 py-3"><p class="mb-1 text-xs font-medium text-base-content/55">{message.role === 'user' ? 'あなた' : 'アシスタント'} · {message.provider}{message.model ? ` · ${message.model}` : ''} · {stateLabel[message.status]}</p><p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p></article>}</For></Show>
    </div>
    <Show when={error()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{error()}</p></Show>
    <form class="border-t border-base-300 p-4" onSubmit={send}>
      <textarea class="textarea textarea-bordered min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" required value={text()} onInput={event => { const draft = draftFor(key()); draft.text = event.currentTarget.value; draft.version++; setText(draft.text); }} />
      <div class="mt-2 flex items-center justify-end gap-2"><span class="text-xs">Codex</span><select class="select select-bordered select-sm" aria-label="モデル" value={model()} disabled={!status()?.models?.length} onChange={event => setModel(event.currentTarget.value)}><Show when={status()?.models?.length} fallback={<option value="">未確認</option>}><For each={status()?.models}>{item => <option value={item.id}>{item.name}</option>}</For></Show></select><Show when={busy()}><button type="button" class="btn btn-sm" disabled={interrupting()} onClick={interrupt}>中断</button></Show><button class="btn btn-primary btn-sm" type="submit" disabled={busy() || !text().trim() || status()?.auth !== 'chatgpt' || !model() || !conversation() || !!loadError()}>{busy() ? '応答中...' : '送信'}</button></div>
    </form>
  </>;
}
