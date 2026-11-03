import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { api } from './api';
import ChatContent from './ChatContent';
import ChatComposer from './ChatComposer';
import TabBar from './TabBar';
import type { TaskDetail } from './types';

export interface WorkspaceProps {
  taskId: number;
  onHome: () => void;
}

// Keep unsent input and the in-flight lock when a task is closed and reopened.
interface DraftState {
  text: string;
  editVersion: number;
  sending: boolean;
  error: string;
  listeners: Set<(saved: boolean) => void>;
}
const drafts = new Map<number, DraftState>();
function draftFor(id: number): DraftState {
  let draft = drafts.get(id);
  if (!draft) {
    draft = { text: '', editVersion: 0, sending: false, error: '', listeners: new Set() };
    drafts.set(id, draft);
  }
  return draft;
}
function publish(draft: DraftState, saved = false) {
  for (const listener of draft.listeners) listener(saved);
}

const phaseLabel = (phase: string) => phase === 'requirements' ? 'タスク内容' : phase;
const statusLabel = (status: string) => status === 'idle' ? '入力待ち' : status;

export default function Workspace(props: WorkspaceProps) {
  const [detail, setDetail] = createSignal<TaskDetail>();
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [draftText, setDraftText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [documentIndex, setDocumentIndex] = createSignal(0);

  createEffect(() => {
    const taskId = props.taskId;
    const draft = draftFor(taskId);
    let active = true;
    let sequence = 0;
    setDetail(undefined);
    setDocumentIndex(0);
    setLoading(true);
    setLoadError('');

    const load = async () => {
      const request = ++sequence;
      try {
        const data = await api<TaskDetail>(`/api/tasks/${taskId}`);
        if (!active || request !== sequence) return;
        setDetail(data);
        setDocumentIndex(previous => Math.min(previous, Math.max(0, data.documents.length - 1)));
        setLoadError('');
      } catch (error) {
        if (active && request === sequence) {
          setLoadError(error instanceof Error ? error.message : 'タスクを取得できませんでした');
        }
      } finally {
        if (active && request === sequence) setLoading(false);
      }
    };
    const update = (saved: boolean) => {
      if (!active) return;
      setDraftText(draft.text);
      setSending(draft.sending);
      setSendError(draft.error);
      if (saved) void load();
    };
    draft.listeners.add(update);
    update(false);
    void load();
    onCleanup(() => {
      active = false;
      sequence++;
      draft.listeners.delete(update);
    });
  });

  function updateDraft(value: string) {
    const draft = draftFor(props.taskId);
    draft.text = value;
    draft.editVersion++;
    publish(draft);
  }

  async function send(event: SubmitEvent) {
    event.preventDefault();
    const taskId = props.taskId;
    const draft = draftFor(taskId);
    const content = draft.text;
    if (draft.sending || !content.trim()) return;
    const editVersion = draft.editVersion;
    draft.sending = true;
    draft.error = '';
    publish(draft);
    try {
      await api(`/api/tasks/${taskId}/messages`, { content });
      if (draft.editVersion === editVersion) draft.text = '';
      // The current subscriber, if any, reloads only its own task.
      publish(draft, true);
    } catch (error) {
      draft.error = error instanceof Error ? error.message : '送信できませんでした';
      publish(draft);
    } finally {
      draft.sending = false;
      publish(draft);
    }
  }

  return (
    <section class="mx-auto flex h-[calc(100vh-7rem)] min-h-[34rem] max-w-7xl flex-col gap-4 px-4 pb-5 pt-4">
      <div class="flex flex-wrap items-center gap-3">
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => props.onHome()} aria-label="ホームに戻る">← ホーム</button>
        <Show when={detail()} fallback={<h1 class="text-lg font-semibold">タスク #{props.taskId}</h1>}>
          {data => <div class="min-w-0"><h1 class="truncate text-lg font-semibold">#{data().task.id} {data().task.name}</h1><p class="text-xs text-base-content/60">{phaseLabel(data().task.phase)} · {statusLabel(data().task.status)}</p></div>}
        </Show>
      </div>
      <Show when={loadError()}><div role="alert" class="alert alert-error text-sm">{loadError()}</div></Show>
      <Show when={loading() && !detail()}><p class="text-sm text-base-content/60">読み込み中...</p></Show>
      <Show when={detail()}>
        {data => <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
          <section class="card flex min-h-[24rem] min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="タスクチャット">
            <div class="border-b border-base-300 px-5 py-3"><h2 class="text-sm font-semibold">チャット</h2></div>
            <p class="border-b border-base-300 bg-base-200/50 px-5 py-3 text-xs leading-relaxed text-base-content/70">LLM は未接続です。送信内容は保存しますが、AI の返答・指示書の自動更新は行いません。</p>
            <ChatContent messages={data().messages} />
            <Show when={sendError()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{sendError()}</p></Show>
            <ChatComposer text={draftText()} sending={sending()} onInput={updateDraft} onSubmit={send} />
            <div class="border-t border-base-300 bg-base-200/40 px-5 py-3 text-xs text-base-content/60">ターミナル：未接続</div>
          </section>
          <section class="card flex min-h-[24rem] min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="文書プレビュー">
            <TabBar label="文書" tabs={data().documents.map((document, index) => ({ id: String(index), label: document.name }))} activeId={String(documentIndex())} onSelect={id => setDocumentIndex(Number(id))} />
            <Show when={data().documents[documentIndex()]} fallback={<p class="p-5 text-sm text-base-content/50">表示できる文書はありません。</p>}>
              {document => <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-relaxed">{document().content}</pre>}
            </Show>
          </section>
        </div>}
      </Show>
    </section>
  );
}
