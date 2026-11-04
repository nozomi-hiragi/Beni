import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api } from './api';
import ChatPanel from './components/ChatPanel';
import PhaseIndicator from './components/PhaseIndicator';
import TabBar from './components/TabBar';
import TreeView from './components/TreeView';
import type { AppState, Document, Task, TaskDetail } from './types';

export interface WorkspaceProps {
  taskId?: number;
  projectId?: number;
  onTaskChange?: (id: number | undefined, task?: Task) => void;
  onHome: () => void;
}

const phaseLabel = (phase: string) => phase === 'requirements' ? 'タスク内容' : phase;
const statusLabel = (status: string) => status === 'idle' ? '入力待ち' : status;
const documentId = (document: Document) => document.path ?? JSON.stringify([document.name, document.version]);
type DocumentTabs = { known: string[]; open: string[]; selected?: string };

export default function Workspace(props: WorkspaceProps) {
  const [detailState,setDetailState]=createStore<{value?:TaskDetail}>({});
  const detail=()=>detailState.value;
  const setDetail=(value:TaskDetail|undefined)=>setDetailState('value',value===undefined?undefined:reconcile(value,{key:'id'}));
  const [activeTask, setActiveTask] = createSignal<number | undefined>(props.taskId);
  const [openTasks, setOpenTasks] = createSignal<number[]>(props.taskId === undefined ? [] : [props.taskId]);
  const [projectId, setProjectId] = createSignal<number | undefined>(props.projectId);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [treeError, setTreeError] = createSignal('');
  const [taskTreeOpen, setTaskTreeOpen] = createSignal(false);
  const [documentTreeOpen, setDocumentTreeOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
  const [activeDocument, setActiveDocument] = createSignal<string>();
  const documentTabs = new Map<number, DocumentTabs>();
  let documentOwner: number | undefined;
  let alive = true;
  let taskTreeToggle: HTMLButtonElement | undefined;
  let documentTreeToggle: HTMLButtonElement | undefined;

  function dismissTrees(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (taskTreeOpen() && !taskTreeToggle?.contains(target) && !document.getElementById('task-tree')?.contains(target)) setTaskTreeOpen(false);
    if (documentTreeOpen() && !documentTreeToggle?.contains(target) && !document.getElementById('document-tree')?.contains(target)) setDocumentTreeOpen(false);
  }
  // Capture before Solid updates the toggle element in response to this click.
  onMount(() => document.addEventListener('click', dismissTrees, true));
  onCleanup(() => document.removeEventListener('click', dismissTrees, true));

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

  // URL changes select tabs without remounting this workspace or creating history.
  createEffect(() => {
    const id = props.taskId;
    if (id !== undefined) setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
  });

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
    const initialName = values.some(document => document.name === 'requirements.md') ? 'requirements.md' : values.some(document => document.name === '指示書.md') ? '指示書.md' : values[0]?.name;
    const newest = values.filter(document => document.name === initialName).reduce<Document | undefined>(
      (latest, document) => !latest || document.version > latest.version ? document : latest, undefined,
    );
    const selected = previous?.selected && open.includes(previous.selected) ? previous.selected : previous ? open[open.length - 1] : newest && documentId(newest);
    saveDocumentTabs(taskId, open, selected, available);
  }

  createEffect(() => {
    const taskId = activeTask();
    if (taskId === undefined) { setLoading(false); return; }
    let active = true;
    let sequence = 0,fetching=false,reload=false;
    let events: EventSource | undefined;
    if (documentOwner !== taskId) {
      batch(() => { setDetail(undefined); restoreDocumentTabs(taskId); });
    }
    setLoading(true);
    setLoadError('');
    const load = async () => {
      if(fetching){reload=true;return}fetching=true;
      do {reload=false;
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
        if(!events && typeof EventSource !== 'undefined'){
          events=new EventSource(`/api/tasks/${taskId}/documents/events?projectId=${data.task.projectId}`);
          events.addEventListener('change',()=>{if(active)void load()});
          events.onerror=()=>{if(active)setLoadError('文書の更新接続を再試行しています')};
        }
      } catch (error) {
        if (active && request === sequence) setLoadError(error instanceof Error ? error.message : 'タスクを取得できませんでした');
      } finally {
        if (active && request === sequence) setLoading(false);
      }
      }while(reload&&active);fetching=false;
    };
    void load();
    onCleanup(() => { active = false; sequence++; events?.close(); });
  });

  function openTask(id: number) {
    if (id !== props.taskId && !taskOptions().some(task => task.id === id)) return;
    setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
    props.onTaskChange?.(id, taskOptions().find(task => task.id === id));
  }
  function closeTask(id: number) {
    const remaining = openTasks().filter(item => item !== id);
    setOpenTasks(remaining);
    if (activeTask() === id) {
      const next = remaining[remaining.length - 1];
      setActiveTask(next);
      props.onTaskChange?.(next, taskOptions().find(task => task.id === next));
    }
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

  const toggle = (label: string, expanded: boolean, controls: string, onClick: () => void, setRef: (element: HTMLButtonElement) => void) =>
    <button ref={setRef} type="button" class="btn btn-ghost btn-square btn-sm m-1" aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>☰</button>;

  return <section class="mx-auto grid h-auto min-h-[34rem] min-w-0 max-w-7xl gap-4 px-4 pb-5 pt-4 lg:h-[calc(100vh-7rem)] lg:grid-cols-2">
    <div class="flex min-h-0 min-w-0 flex-col gap-4">
      <section class="card flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="タスクチャット">
        <TabBar label="チャット" tabs={[{ id: 'general', label: 'ジェネラル', closable: false }, ...openTasks().map(id => ({ id: String(id), label: taskName(id) }))]} activeId={activeTask() === undefined ? 'general' : String(activeTask())} onSelect={id => id === 'general' ? (setActiveTask(undefined), props.onTaskChange?.(undefined)) : openTask(Number(id))} onClose={id => { if (id !== 'general') closeTask(Number(id)); }} left={toggle('タスクツリーを開閉', taskTreeOpen(), 'task-tree', () => setTaskTreeOpen(value => !value), element => { taskTreeToggle = element; })} />
        <div class="relative flex min-h-0 flex-1 flex-col">
          <Show when={taskTreeOpen()}><TreeView id="task-tree" label="タスク" nodes={[{id:'general', label:'ジェネラル'}, ...taskOptions().map(task => ({id:String(task.id), label:taskLabel(task)})), ...(props.taskId !== undefined && !taskOptions().some(task => task.id === props.taskId) ? [{id:String(props.taskId),label:taskName(props.taskId)}] : [])]} onSelect={id => { if (id === 'general') { setActiveTask(undefined); props.onTaskChange?.(undefined); } else openTask(Number(id)); setTaskTreeOpen(false); }} /></Show>
          <Show when={taskTreeOpen() && treeError()}><p role="alert" class="relative z-20 m-2 text-sm text-error">{treeError()}</p></Show>
          <Show when={activeTask() === undefined && projectId() !== undefined}><ChatPanel projectId={projectId()!} /></Show>
          <Show when={activeTask() !== undefined}>
            <Show when={loadError()}><div role="alert" class="alert alert-error text-sm">{loadError()}</div></Show>
            <Show when={loading() && !detail()}><p class="p-4 text-sm text-base-content/60">読み込み中...</p></Show>
            <Show when={detail() && detail()?.task.id === activeTask()}>
              <PhaseIndicator phase={detail()!.task.phase} onRequirements={() => {
                const document = documents().filter(item => (item.name === 'requirements.md' || item.name === '指示書.md')).reduce<Document | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
                if (document) openDocument(documentId(document));
              }} />
              <p class="border-b border-base-300 bg-base-200/50 px-5 py-3 text-xs leading-relaxed text-base-content/70">現在: {phaseLabel(detail()!.task.phase)} · {statusLabel(detail()!.task.status)}。タスクの会話から requirements.md と implementation-plan.md を更新します。</p>
              <ChatPanel projectId={detail()!.task.projectId} taskId={activeTask()} legacyMessages={detail()!.messages} />
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
      <TabBar label="文書" tabs={openDocuments().map(id => { const document = documents().find(item => documentId(item) === id); return {id, label:document ? documentLabel(document) : id}; })} activeId={activeDocument()} onSelect={openDocument} onClose={closeDocument} left={toggle('文書ツリーを開閉', documentTreeOpen(), 'document-tree', () => setDocumentTreeOpen(value => !value), element => { documentTreeToggle = element; })} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Show when={documentTreeOpen()}><TreeView id="document-tree" label="文書" nodes={documents().map(document => ({id:documentId(document),label:documentLabel(document)}))} onSelect={id => { openDocument(id); setDocumentTreeOpen(false); }} /></Show>
        <Show when={currentDocument()}>{document => <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-relaxed">{document().content}</pre>}</Show>
      </div>
    </section>
  </section>;
}
