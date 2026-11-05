import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api } from './api';
import { communication } from './communication';
import ChatPanel from './components/ChatPanel';
import MarkdownPreview from './components/MarkdownPreview';
import PhaseIndicator from './components/PhaseIndicator';
import TabBar from './components/TabBar';
import TreeView from './components/TreeView';
import TerminalPanel from './components/TerminalPanel';
import ResizeHandle from './components/ResizeHandle';
import type { AppState, Document, Task, TaskDetail } from './types';

export interface WorkspaceProps {
  taskId?: string;
  projectId?: string;
  onTaskChange?: (id: string | undefined, task?: Task) => void;
  onHome: () => void;
}

const documentId = (document: Document) => document.path ?? JSON.stringify([document.name, document.version]);
type DocumentTabs = { known: string[]; open: string[]; selected?: string };

export default function Workspace(props: WorkspaceProps) {
  const [detailState,setDetailState]=createStore<{value?:TaskDetail}>({});
  const detail=()=>detailState.value;
  const setDetail=(value:TaskDetail|undefined)=>setDetailState('value',value===undefined?undefined:reconcile(value,{key:'id'}));
  const [activeTask, setActiveTask] = createSignal<string | undefined>(props.taskId);
  const [openTasks, setOpenTasks] = createSignal<string[]>(props.taskId === undefined ? [] : [props.taskId]);
  const [projectId, setProjectId] = createSignal<string | undefined>(props.projectId);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [treeError, setTreeError] = createSignal('');
  const [taskTreeOpen, setTaskTreeOpen] = createSignal(false);
  const [documentTreeOpen, setDocumentTreeOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
  const [activeDocument, setActiveDocument] = createSignal<string>();
  const [leftRatio, setLeftRatio] = createSignal(50);
  const [chatRatio, setChatRatio] = createSignal(60);
  let workspace: HTMLElement | undefined;
  let leftPanels: HTMLDivElement | undefined;
  const documentTabs = new Map<string, DocumentTabs>();
  let documentOwner: string | undefined;
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
  const taskLabel = (task: Task) => task.name;
  const taskName = (id: string) => {
    const task = taskOptions().find(item => item.id === id);
    return task ? taskLabel(task) : 'タスク';
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

  function restoreDocumentTabs(taskId: string) {
    const previous = documentTabs.get(taskId);
    setOpenDocuments(previous?.open ?? []);
    setActiveDocument(previous?.selected);
    documentOwner = taskId;
  }
  function saveDocumentTabs(taskId: string, open: string[], selected: string | undefined, known?: string[]) {
    documentTabs.set(taskId, { known: known ?? documentTabs.get(taskId)?.known ?? [], open, selected });
    if (documentOwner === taskId) { setOpenDocuments(open); setActiveDocument(selected); }
  }
  function adoptDocuments(taskId: string, values: Document[]) {
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
    let unsubscribe: (() => void) | undefined;
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
        if (!unsubscribe) {
          unsubscribe = communication.subscribe('documents', { projectId: data.task.projectId, taskId }, {
            subscribed: () => { if (active) void load(); },
            event: () => { if (active) void load(); },
            error: message => { if (active) setLoadError(message); },
          });
        }
      } catch (error) {
        if (active && request === sequence) setLoadError(error instanceof Error ? error.message : 'タスクを取得できませんでした');
      } finally {
        if (active && request === sequence) setLoading(false);
      }
      }while(reload&&active);fetching=false;
    };
    void load();
    onCleanup(() => { active = false; sequence++; unsubscribe?.(); });
  });

  function openTask(id: string) {
    if (id !== props.taskId && !taskOptions().some(task => task.id === id)) return;
    setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
    props.onTaskChange?.(id, taskOptions().find(task => task.id === id));
  }
  function closeTask(id: string) {
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

  return <section ref={workspace} class="workspace mx-auto grid h-auto min-h-[34rem] min-w-0 max-w-7xl gap-4 px-4 pb-5 pt-4 lg:h-[calc(100vh-7rem)] lg:min-h-0" style={{"--left-ratio": `${leftRatio()}fr`, "--right-ratio": `${100 - leftRatio()}fr`}}>
    <div ref={leftPanels} class="workspace-left grid min-h-0 min-w-0 gap-4" classList={{"workspace-left-terminal": projectId() !== undefined}} style={{"--chat-ratio": `${chatRatio()}fr`, "--terminal-ratio": `${100 - chatRatio()}fr`}}>
      <section class="card flex min-h-[20rem] min-w-0 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm lg:min-h-0" aria-label="タスクチャット">
        <TabBar label="チャット" tabs={[{ id: 'general', label: 'ジェネラル', closable: false }, ...openTasks().map(id => ({ id: String(id), label: taskName(id) }))]} activeId={activeTask() === undefined ? 'general' : String(activeTask())} onSelect={id => id === 'general' ? (setActiveTask(undefined), props.onTaskChange?.(undefined)) : openTask(id)} onClose={id => { if (id !== 'general') closeTask(id); }} left={toggle('タスクツリーを開閉', taskTreeOpen(), 'task-tree', () => setTaskTreeOpen(value => !value), element => { taskTreeToggle = element; })} />
        <div class="relative flex min-h-0 flex-1 flex-col overflow-auto">
          <Show when={taskTreeOpen()}><TreeView id="task-tree" label="タスク" nodes={[{id:'general', label:'ジェネラル'}, ...taskOptions().map(task => ({id:String(task.id), label:taskLabel(task)})), ...(props.taskId !== undefined && !taskOptions().some(task => task.id === props.taskId) ? [{id:String(props.taskId),label:taskName(props.taskId)}] : [])]} onSelect={id => { if (id === 'general') { setActiveTask(undefined); props.onTaskChange?.(undefined); } else openTask(id); setTaskTreeOpen(false); }} /></Show>
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
              <ChatPanel projectId={detail()!.task.projectId} taskId={activeTask()} />
            </Show>
          </Show>
        </div>
      </section>
      <Show when={projectId() !== undefined}>
        <ResizeHandle orientation="horizontal" label="チャットとターミナルの高さを調整" container={() => leftPanels} value={chatRatio()} onChange={setChatRatio} />
        <TerminalPanel projectId={projectId()!} />
      </Show>
    </div>
    <ResizeHandle orientation="vertical" label="チャットと文書プレビューの幅を調整" container={() => workspace} value={leftRatio()} onChange={setLeftRatio} />
    <section class="card flex min-h-[20rem] min-w-0 flex-col lg:min-h-0 overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="文書プレビュー">
      <TabBar label="文書" tabs={openDocuments().map(id => { const document = documents().find(item => documentId(item) === id); return {id, label:document ? documentLabel(document) : id}; })} activeId={activeDocument()} onSelect={openDocument} onClose={closeDocument} left={toggle('文書ツリーを開閉', documentTreeOpen(), 'document-tree', () => setDocumentTreeOpen(value => !value), element => { documentTreeToggle = element; })} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Show when={documentTreeOpen()}><TreeView id="document-tree" label="文書" nodes={documents().map(document => ({id:documentId(document),label:documentLabel(document)}))} onSelect={id => { openDocument(id); setDocumentTreeOpen(false); }} /></Show>
        <Show when={currentDocument()}>{document => <MarkdownPreview content={document().content} />}</Show>
      </div>
    </section>
  </section>;
}
