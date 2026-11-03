import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { api } from './api';
import ChatContent from './components/ChatContent';
import ChatComposer from './components/ChatComposer';
import PhaseIndicator from './components/PhaseIndicator';
import TabBar from './components/TabBar';
import TreeView from './components/TreeView';
import type { AppState, Document, Task, TaskDetail } from './types';

export interface WorkspaceProps {
  taskId: number;
  onHome: () => void;
}

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
const documentId = (document: Document) => JSON.stringify([document.name, document.version]);
type DocumentTabs = { known: string[]; open: string[]; selected?: string };

export default function Workspace(props: WorkspaceProps) {
  const [detail, setDetail] = createSignal<TaskDetail>();
  const [activeTask, setActiveTask] = createSignal<number | undefined>(props.taskId);
  const [openTasks, setOpenTasks] = createSignal<number[]>([props.taskId]);
  const [projectId, setProjectId] = createSignal<number>();
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [treeError, setTreeError] = createSignal('');
  const [taskTreeOpen, setTaskTreeOpen] = createSignal(false);
  const [documentTreeOpen, setDocumentTreeOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [draftText, setDraftText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
  const [activeDocument, setActiveDocument] = createSignal<string>();
  const documentTabs = new Map<number, DocumentTabs>();
  let documentOwner: number | undefined;
  let alive = true;

  const taskOptions = createMemo(() => {
    const project = projectId();
    const list = tasks().filter(task => task.projectId === project);
    const current = detail()?.task;
    if (current && current.projectId === project && !list.some(task => task.id === current.id)) list.unshift(current);
    return list;
  });
  const taskLabel = (task: Task) => `#${task.id} ${task.name}`;
  const taskName = (id: number) => {
    const task = taskOptions().find(item => item.id === id);
    return task ? taskLabel(task) : `#${id}`;
  };
  const documents = createMemo(() => detail()?.documents ?? []);
  const documentLabel = (document: Document) => documents().filter(item => item.name === document.name).length > 1 ? `${document.name} · v${document.version}` : document.name;
  const currentDocument = createMemo(() => documents().find(document => documentId(document) === activeDocument()));

  onMount(async () => {
    try {
      const state = await api<AppState>('/api/state');
      if (alive) {
        batch(() => {
          setTasks(state.tasks);
          const initial = state.tasks.find(task => task.id === props.taskId);
          if (projectId() === undefined && initial) setProjectId(initial.projectId);
          setTreeError('');
        });
      }
    } catch {
      if (alive) setTreeError('タスク一覧を取得できませんでした');
    }
  });
  onCleanup(() => { alive = false; });

  function restoreDocumentTabs(taskId: number) {
    const previous = documentTabs.get(taskId);
    setOpenDocuments(previous?.open ?? []);
    setActiveDocument(previous?.selected);
    documentOwner = taskId;
  }
  function saveDocumentTabs(taskId: number, open: string[], selected: string | undefined, known?: string[]) {
    documentTabs.set(taskId, { known: known ?? documentTabs.get(taskId)?.known ?? [], open, selected });
    if (documentOwner === taskId) { setOpenDocuments(open); setActiveDocument(selected); }
  }
  function adoptDocuments(taskId: number, values: Document[]) {
    const available = values.map(documentId);
    const previous = documentTabs.get(taskId);
    const open = previous
      ? [...previous.open.filter(id => available.includes(id)), ...available.filter(id => !previous.known.includes(id))]
      : available;
    const initialName = values.some(document => document.name === '指示書.md') ? '指示書.md' : values[0]?.name;
    const newest = values.filter(document => document.name === initialName).reduce<Document | undefined>(
      (latest, document) => !latest || document.version > latest.version ? document : latest, undefined,
    );
    const selected = previous?.selected && open.includes(previous.selected) ? previous.selected : previous ? open[open.length - 1] : newest && documentId(newest);
    saveDocumentTabs(taskId, open, selected, available);
  }

  createEffect(() => {
    const taskId = activeTask();
    if (taskId === undefined) { setLoading(false); return; }
    const draft = draftFor(taskId);
    let active = true;
    let sequence = 0;
    if (documentOwner !== taskId) {
      batch(() => { setDetail(undefined); restoreDocumentTabs(taskId); });
    }
    setLoading(true);
    setLoadError('');
    const load = async () => {
      const request = ++sequence;
      try {
        const data = await api<TaskDetail>(`/api/tasks/${taskId}`);
        if (!active || request !== sequence) return;
        batch(() => {
          setDetail(data);
          setProjectId(data.task.projectId);
          adoptDocuments(taskId, data.documents);
          setLoadError('');
        });
      } catch (error) {
        if (active && request === sequence) setLoadError(error instanceof Error ? error.message : 'タスクを取得できませんでした');
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

  function openTask(id: number) {
    if (id !== props.taskId && !taskOptions().some(task => task.id === id)) return;
    setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
  }
  function closeTask(id: number) {
    const remaining = openTasks().filter(item => item !== id);
    setOpenTasks(remaining);
    if (activeTask() === id) setActiveTask(remaining[remaining.length - 1]);
  }
  function openDocument(id: string) {
    if (documentOwner === undefined || !documents().some(document => documentId(document) === id)) return;
    const open = openDocuments().includes(id) ? openDocuments() : [...openDocuments(), id];
    saveDocumentTabs(documentOwner, open, id);
  }
  function closeDocument(id: string) {
    if (documentOwner === undefined) return;
    const remaining = openDocuments().filter(item => item !== id);
    const selected = activeDocument() === id ? remaining[remaining.length - 1] : activeDocument();
    saveDocumentTabs(documentOwner, remaining, selected);
  }

  function updateDraft(value: string) {
    const taskId = activeTask();
    if (taskId === undefined) return;
    const draft = draftFor(taskId);
    draft.text = value;
    draft.editVersion++;
    publish(draft);
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    const taskId = activeTask();
    if (taskId === undefined || detail()?.task.id !== taskId) return;
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
      publish(draft, true);
    } catch (error) {
      draft.error = error instanceof Error ? error.message : '送信できませんでした';
      publish(draft);
    } finally {
      draft.sending = false;
      publish(draft);
    }
  }
  const toggle = (label: string, expanded: boolean, controls: string, onClick: () => void) =>
    <button type="button" class="btn btn-ghost btn-square btn-sm m-1" aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>☰</button>;

  return <section class="mx-auto grid h-auto min-h-[34rem] min-w-0 max-w-7xl gap-4 px-4 pb-5 pt-4 lg:h-[calc(100vh-7rem)] lg:grid-cols-2">
    <div class="flex min-h-0 min-w-0 flex-col gap-4">
      <section class="card flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="タスクチャット">
        <TabBar label="チャット" tabs={openTasks().map(id => ({ id: String(id), label: taskName(id) }))} activeId={activeTask() === undefined ? undefined : String(activeTask())} onSelect={id => openTask(Number(id))} onClose={id => closeTask(Number(id))} left={toggle('タスクツリーを開閉', taskTreeOpen(), 'task-tree', () => setTaskTreeOpen(value => !value))} />
        <div class="relative flex min-h-0 flex-1 flex-col">
          <Show when={taskTreeOpen()}><TreeView id="task-tree" label="タスク" nodes={[...taskOptions().map(task => ({id:String(task.id), label:taskLabel(task)})), ...(!taskOptions().some(task => task.id === props.taskId) ? [{id:String(props.taskId),label:taskName(props.taskId)}] : [])]} onSelect={id => openTask(Number(id))} /></Show>
          <Show when={taskTreeOpen() && treeError()}><p role="alert" class="relative z-20 m-2 text-sm text-error">{treeError()}</p></Show>
          <Show when={activeTask() !== undefined}>
            <Show when={loadError()}><div role="alert" class="alert alert-error text-sm">{loadError()}</div></Show>
            <Show when={loading() && !detail()}><p class="p-4 text-sm text-base-content/60">読み込み中...</p></Show>
            <Show when={detail() && detail()?.task.id === activeTask()}>
              <PhaseIndicator phase={detail()!.task.phase} onRequirements={() => {
                const document = documents().filter(item => item.name === '指示書.md').reduce<Document | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
                if (document) openDocument(documentId(document));
              }} />
              <p class="border-b border-base-300 bg-base-200/50 px-5 py-3 text-xs leading-relaxed text-base-content/70">現在: {phaseLabel(detail()!.task.phase)} · {statusLabel(detail()!.task.status)}。LLM は未接続です。送信内容は保存しますが、AI の返答・指示書の自動更新は行いません。</p>
              <ChatContent messages={detail()!.messages} />
              <Show when={sendError()}><p role="alert" class="mx-4 mb-2 text-sm text-error">{sendError()}</p></Show>
              <ChatComposer text={draftText()} sending={sending()} onInput={updateDraft} onSubmit={send} />
            </Show>
          </Show>
        </div>
      </section>
      <section class="card flex h-36 min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="ターミナル">
        <TabBar label="ターミナル" tabs={[{id:'unavailable',label:'ターミナル（未接続）'}]} activeId="unavailable" onSelect={() => {}} right={<button type="button" class="btn btn-ghost btn-square btn-sm m-1" aria-label="ターミナルを追加（未接続）" title="ターミナルは未接続です" disabled>＋</button>} />
        <p class="p-4 text-sm text-base-content/60">ターミナル実行は未接続です。</p>
      </section>
    </div>
    <section class="card flex min-h-[20rem] min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="文書プレビュー">
      <TabBar label="文書" tabs={openDocuments().map(id => { const document = documents().find(item => documentId(item) === id); return {id, label:document ? documentLabel(document) : id}; })} activeId={activeDocument()} onSelect={openDocument} onClose={closeDocument} left={toggle('文書ツリーを開閉', documentTreeOpen(), 'document-tree', () => setDocumentTreeOpen(value => !value))} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Show when={documentTreeOpen()}><TreeView id="document-tree" label="文書" nodes={documents().map(document => ({id:documentId(document),label:documentLabel(document)}))} onSelect={openDocument} /></Show>
        <Show when={currentDocument()}>{document => <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-relaxed">{document().content}</pre>}</Show>
      </div>
    </section>
  </section>;
}
