import { availableModels, chooseModel, loadModels, modelIsAvailable, modelLabel, modelScope, modelValue, providerReady, rejectModel, selectedModel as cachedModel } from '../../shared/model-cache';
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { api, ApiError, loadDocumentProvenance } from '../../shared/api';
import { isTaskPhase, type TaskPhase } from '../../../shared/task-phase';
import { communication } from '../../shared/communication';
import ChatPanel, { type ChatTabStatus } from '../../shared/components/ChatPanel';
import MarkdownPreview from '../../shared/components/MarkdownPreview';
import PromptTableMarkdownPreview from '../../shared/components/PromptTableMarkdownPreview';
import PhaseIndicator from './PhaseIndicator';
import { phaseDocuments } from '../../shared/phase-display';
import TabBar from '../../shared/components/TabBar';
import TreeView, { type TreeNode } from './TreeView';
import ProjectFileContent, { projectFileName, projectFilePath, projectFileTree } from './ProjectFiles';
import TerminalPanel from './TerminalPanel';
import ResizeHandle, { MAX_RATIO } from '../../shared/components/ResizeHandle';
import type { AppState, Document, Task, TaskDetail } from '../../shared/types';

export interface WorkspaceProps {
  taskId?: string;
  projectId?: string;
  onTaskChange?: (id: string | undefined, task?: Task) => void;
  onHome: () => void;
  onTaskDeleted?: (id: string) => void;
}

const documentId = (document: Document) => document.path ?? JSON.stringify([document.name, document.version]);
type DocumentTabs = { known: string[]; open: string[]; selected?: string };
const reviewLabels = { pending: '待機中', running: '実行中', stopped: '停止済み', done: '完了', failed: '失敗' };
const instructionJobLabels = { pending: '処理中', succeeded: '完了', failed: '失敗', superseded: '後続の更新依頼に置き換え済み' };

export default function Workspace(props: WorkspaceProps) {
  const [chatBusy, setChatBusy] = createSignal(false);
  const implementationScope = () => modelScope(detail()?.task.projectId ?? '', activeTask(), 'implementation-assignee');
  const implementationModel = () => cachedModel(implementationScope());
  const implementationAvailable = () => modelIsAvailable(implementationScope());
  createEffect(() => {
    const task = detail()?.task;
    if (!task) return;
    const scope = implementationScope();
    void loadModels(false).catch(() => { });
    untrack(() => { if (cachedModel(scope) && !modelIsAvailable(scope)) void loadModels(true, cachedModel(scope)?.provider).catch(() => { }); });
  });
  createEffect(() => {
    if (!detail()) return;
    const candidate = availableModels().find(item => providerReady(item.provider));
    if (!implementationModel() && candidate) chooseModel(implementationScope(), candidate);
  });
  const [detailState, setDetailState] = createStore<{ value?: TaskDetail }>({});
  const detail = () => detailState.value;
  const setDetail = (value: TaskDetail | undefined) => setDetailState('value', value === undefined ? undefined : reconcile(value, { key: 'id' }));
  const [activeTask, setActiveTaskId] = createSignal<string | undefined>(props.taskId);
  const [chatTabStatus, setChatTabStatus] = createSignal<ChatTabStatus>();
  const [pendingChatStatus, setPendingChatStatus] = createSignal<string>();
  const activeChatTab = () => activeTask() ?? 'general';
  function setActiveTask(id: string | undefined) {
    if (id === untrack(activeTask)) return;
    batch(() => { setPendingChatStatus(undefined); setChatTabStatus(undefined); setLoadError(''); setActiveTaskId(id); });
  }
  function registerChatTabStatus(taskId: string | undefined, status: ChatTabStatus, failed = false) {
    if (taskId !== untrack(activeTask)) return;
    batch(() => {
      if (failed) setPendingChatStatus(undefined);
      setChatTabStatus(status);
    });
  }
  function actionsForChatTab(id: string) {
    const task = taskOptions().find(item => item.id === id);
    if (!projectId() || (task && !isTaskPhase(task.phase))) return undefined;
    const active = id === activeChatTab();
    const status = active ? chatTabStatus() : undefined;
    return [{
      id: 'status',
      label: '状態を表示',
      disabled: active && (!status || status.disabled),
      run: () => {
        if (id === activeChatTab()) {
          chatTabStatus()?.open();
          return;
        }
        // 非選択タブの履歴は状態表示を選んだときに読み込む。
        batch(() => {
          selectChatTab(id);
          if (activeChatTab() === id) setPendingChatStatus(id);
        });
      },
    }];
  }
  const [viewPhase, setViewPhase] = createSignal<TaskPhase>();
  const actualPhase = createMemo(() => {
    const phase = detail()?.task.phase;
    return isTaskPhase(phase) ? phase : undefined;
  });
  const review = () => detail()?.workflow?.review;
  const instructionJob = () => detail()?.workflow?.instructionJob;
  const reviewInProgress = () => actualPhase() === 'retrospective' && (review()?.state === 'pending' || review()?.state === 'running');
  const canComplete = () => detail()?.workflow === undefined || review()?.state === 'done';
  createEffect(() => { activeTask(); setViewPhase(actualPhase()); });
  const chatPhase = () => {
    const phase = actualPhase(), selected = viewPhase();
    if (phase === 'finalization' && (selected === 'execution' || selected === 'retrospective')) return selected;
    if (phase === 'retrospective' && selected === 'execution') return selected;
    return phase;
  };
  const [openTasks, setOpenTasks] = createSignal<string[]>(props.taskId === undefined ? [] : [props.taskId]);
  const [projectId, setProjectId] = createSignal<string | undefined>(props.projectId);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [treeError, setTreeError] = createSignal('');
  const [taskTreeOpen, setTaskTreeOpen] = createSignal(false);
  const [documentTreeOpen, setDocumentTreeOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  createEffect(() => {
    const id = pendingChatStatus();
    if (id === undefined) return;
    const task = detail()?.task;
    const taskUnavailable = id !== 'general' && (loadError() || (task?.id === id && !isTaskPhase(task.phase)));
    if (id !== activeChatTab() || taskUnavailable) {
      setPendingChatStatus(undefined);
      return;
    }
    const status = chatTabStatus();
    if (!status || status.disabled) return;
    setPendingChatStatus(undefined);
    untrack(status.open);
  });
  const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
  const [activeDocument, setActiveDocument] = createSignal<string>();
  const [openFiles, setOpenFiles] = createSignal<string[]>([]);
  const [activeFile, setActiveFile] = createSignal<string>();
  createEffect(() => { activeTask(); setActiveFile(undefined); });
  createEffect(() => { projectId(); setOpenFiles([]); setActiveFile(undefined); });
  const [leftRatio, setLeftRatio] = createSignal(50);
  const [chatRatio, setChatRatio] = createSignal(MAX_RATIO);
  let workspace: HTMLElement | undefined;
  let leftPanels: HTMLDivElement | undefined;
  const deletedTasks = new Set<string>();
  const documentTabs = new Map<string, DocumentTabs>();
  let documentOwner: string | undefined;
  let alive = true;
  let refreshTaskDetail: (() => Promise<void>) | undefined;
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
    const list = tasks().filter(task => task.projectId === project && !deletedTasks.has(task.id));
    const current = detail()?.task;
    if (current && !deletedTasks.has(current.id) && current.projectId === project && !list.some(task => task.id === current.id)) list.unshift(current);
    return list;
  });
  const taskLabel = (task: Task) => task.name;
  const taskName = (id: string) => {
    const task = taskOptions().find(item => item.id === id);
    return task ? taskLabel(task) : 'タスク';
  };
  const [advancing, setAdvancing] = createSignal(false);
  const [phaseError, setPhaseError] = createSignal('');
  createEffect(() => { activeTask(); setPhaseError(''); });
  const documents = createMemo(() => detail()?.documents ?? []);
  const documentName = (name: string) => phaseDocuments.find(item => item.name === name)?.label ?? name;
  const documentLabel = (document: Document) => documents().filter(item => item.name === document.name).length > 1 ? `${documentName(document.name)} · v${document.version}` : documentName(document.name);
  const projectFiles = createMemo(() => {
    const project = projectId();
    return project === undefined ? undefined : projectFileTree(project);
  });
  const previewNodes = createMemo<TreeNode[]>(() => {
    const nodes: TreeNode[] = [];
    if (activeTask() !== undefined && documents().length) {
      nodes.push({ label: 'タスク文書', children: documents().map(document => ({ id: documentId(document), label: documentLabel(document) })) });
    }
    const files = projectFiles();
    if (files) nodes.push(files);
    return nodes;
  });
  const currentDocument = createMemo(() => documents().find(document => documentId(document) === activeDocument()));
  const currentDocumentSource = createMemo(() => {
    const document = currentDocument();
    const task = detail()?.task;
    if (!document?.provenance || !task) return undefined;
    const { revision } = document.provenance;
    const scope = { projectId: task.projectId, taskId: task.id };
    return {
      provenance: document.provenance,
      loadProvenance: (itemId: string) => loadDocumentProvenance(document.name, revision, itemId, scope),
    };
  });

  // URL changes select tabs without remounting this workspace or creating history.
  createEffect(() => {
    const id = props.taskId;
    if (id !== undefined && deletedTasks.has(id)) return;
    if (id !== undefined) setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
  });

  onMount(async () => {
    try {
      const state = await api<AppState>('/api/state');
      if (alive) {
        batch(() => {
          setTasks(state.tasks.filter(task => !deletedTasks.has(task.id)));
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
    const phaseDocument = phaseDocuments.find(item => item.phase === detail()?.task.phase)?.name;
    const initialName = phaseDocument && values.some(document => document.name === phaseDocument) ? phaseDocument : values.some(document => document.name === 'requirements.md') ? 'requirements.md' : values.some(document => document.name === '指示書.md') ? '指示書.md' : values[0]?.name;
    const newest = values.filter(document => document.name === initialName).reduce<Document | undefined>(
      (latest, document) => !latest || document.version > latest.version ? document : latest, undefined,
    );
    const knowledgeReady = newest?.name === 'knowledge.md' && actualPhase() === 'finalization' && !previous?.known.includes(documentId(newest));
    const selected = knowledgeReady ? documentId(newest)
      : previous?.selected && open.includes(previous.selected) ? previous.selected : previous ? open[open.length - 1] : newest && documentId(newest);
    saveDocumentTabs(taskId, open, selected, available);
  }

  createEffect(() => {
    const taskId = activeTask();
    if (taskId === undefined) { setLoading(false); return; }
    let active = true;
    let sequence = 0, fetching = false, reload = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeEvents: (() => void) | undefined;
    if (documentOwner !== taskId) {
      batch(() => { setDetail(undefined); restoreDocumentTabs(taskId); });
    }
    setLoading(true);
    const load = async () => {
      if (fetching) { reload = true; return } fetching = true;
      do {
        reload = false;
        const request = ++sequence;
        try {
          const data = await api<TaskDetail>(`/api/tasks/${taskId}`);
          if (!active || request !== sequence || deletedTasks.has(taskId)) return;
          batch(() => {
            const previousPhase = detail()?.task.phase;
            setDetail(data);
            if (previousPhase !== undefined && previousPhase !== data.task.phase) props.onTaskChange?.(data.task.id, data.task);
            setTasks(previous => previous.map(item => item.id === data.task.id ? data.task : item));
            setProjectId(data.task.projectId);
            adoptDocuments(taskId, data.documents);
            if (previousPhase !== data.task.phase && data.task.phase === 'retrospective') {
              const retrospective = data.documents.filter(item => item.name === 'retrospective.md').reduce<Document | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
              if (retrospective) openDocument(documentId(retrospective));
            }
            setLoadError('');
          });
          if (!unsubscribeEvents) {
            unsubscribeEvents = communication.subscribe('task-events', { projectId: data.task.projectId, taskId }, {
              subscribed: () => { if (active) void load(); },
              event: () => { if (active) void load(); },
              error: message => { if (active) setLoadError(message); },
            });
          }
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
      } while (reload && active); fetching = false;
    };
    refreshTaskDetail = load;
    void load();
    onCleanup(() => { active = false; sequence++; refreshTaskDetail = undefined; unsubscribe?.(); unsubscribeEvents?.(); });
  });

  async function workflowAction(action: 'retry-review' | 'retry-instructions' | 'stop-review') {
    const task = detail()?.task;
    if (!task || task.id !== activeTask() || advancing()) return;
    setAdvancing(true);
    setPhaseError('');
    try {
      await api(`/api/tasks/${task.id}/${action}`, { projectId: task.projectId });
    } catch (error) {
      if (alive && task.id === activeTask()) setPhaseError(error instanceof Error ? error.message : action === 'stop-review' ? '自動分析を停止できませんでした' : '再試行を開始できませんでした');
    } finally {
      if (alive && task.id === activeTask()) await refreshTaskDetail?.();
      if (alive) setAdvancing(false);
    }
  }

  async function renameTask(id: string, name: string) {
    const project = projectId();
    if (!project) throw Error('プロジェクトが見つかりません');
    const task = await api<Task>(`/api/tasks/${id}/rename`, { projectId: project, name });
    if (!alive || deletedTasks.has(task.id)) return;
    batch(() => {
      setTasks(previous => previous.some(item => item.id === task.id) ? previous.map(item => item.id === task.id ? task : item) : [...previous, task]);
      const current = detail();
      if (current?.task.id === task.id) setDetail({ ...current, task });
    });
  }
  async function deleteTask(id: string) {
    const project = projectId();
    if (!project) throw Error('プロジェクトが見つかりません');
    await api<{ ok: boolean }>(`/api/tasks/${id}/delete`, { projectId: project });
    if (!alive) return;
    deletedTasks.add(id);
    batch(() => {
      setTasks(previous => previous.filter(task => task.id !== id));
      documentTabs.delete(id);
      if (detail()?.task.id === id) { setDetail(undefined); documentOwner = undefined; setOpenDocuments([]); setActiveDocument(undefined); }
      closeTask(id);
      props.onTaskDeleted?.(id);
    });
  }
  function openTask(id: string) {
    if (deletedTasks.has(id)) return;
    if (id !== props.taskId && !taskOptions().some(task => task.id === id)) return;
    setOpenTasks(previous => previous.includes(id) ? previous : [...previous, id]);
    setActiveTask(id);
    props.onTaskChange?.(id, taskOptions().find(task => task.id === id));
  }
  function selectChatTab(id: string) {
    if (id === 'general') { setActiveTask(undefined); props.onTaskChange?.(undefined); }
    else openTask(id);
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

  function openPreview(id: string) {
    if (projectFilePath(id) !== undefined) {
      setOpenFiles(previous => previous.includes(id) ? previous : [...previous, id]);
      setActiveFile(id);
    } else {
      setActiveFile(undefined);
      openDocument(id);
    }
  }
  function closePreview(id: string) {
    if (projectFilePath(id) === undefined) {
      closeDocument(id);
      if (!activeDocument() && !activeFile()) setActiveFile(openFiles().at(-1));
      return;
    }
    const remaining = openFiles().filter(file => file !== id);
    setOpenFiles(remaining);
    if (activeFile() === id) setActiveFile(remaining.at(-1));
  }

  const toggle = (label: string, expanded: boolean, controls: string, onClick: () => void, setRef: (element: HTMLButtonElement) => void) =>
    <button ref={setRef} type="button" class="btn btn-ghost btn-square btn-sm m-1" aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onClick}><span aria-hidden="true">☰</span></button>;

  return <section ref={workspace} class="workspace mx-auto grid h-auto min-h-[34rem] min-w-0 gap-4 px-2 py-2" style={{ "--left-ratio": `${leftRatio()}fr`, "--right-ratio": `${100 - leftRatio()}fr` }}>
    <div ref={leftPanels} class="workspace-left grid min-h-0 min-w-0 gap-4" classList={{ "workspace-left-terminal": projectId() !== undefined }} style={{ "--chat-ratio": `${chatRatio()}fr`, "--terminal-ratio": `${100 - chatRatio()}fr` }}>
      <section class="card card-border border-base-300 bg-base-100 shadow-sm min-h-[20rem] min-w-0 overflow-hidden lg:min-h-0" aria-label="タスクチャット">
        <TabBar onDelete={deleteTask} onRename={renameTask} label="チャット" tabs={[{ id: 'general', label: 'General', closable: false }, ...openTasks().map(id => ({ id: String(id), label: taskName(id), renameable: true, deletable: true }))]} activeId={activeChatTab()} onSelect={selectChatTab} contextActions={actionsForChatTab} onClose={id => { if (id !== 'general') closeTask(id); }} left={toggle('タスクツリーを開閉', taskTreeOpen(), 'task-tree', () => setTaskTreeOpen(value => !value), element => { taskTreeToggle = element; })} />
        <div class="relative flex min-h-0 flex-1 flex-col overflow-auto">
          <Show when={taskTreeOpen()}><TreeView id="task-tree" label="タスク" nodes={[{ id: 'general', label: 'General' }, ...taskOptions().map(task => ({ id: String(task.id), label: taskLabel(task) })), ...(props.taskId !== undefined && !deletedTasks.has(props.taskId) && !taskOptions().some(task => task.id === props.taskId) ? [{ id: String(props.taskId), label: taskName(props.taskId) }] : [])]} onSelect={id => { selectChatTab(id); setTaskTreeOpen(false); }} /></Show>
          <Show when={taskTreeOpen() && treeError()}><p role="alert" class="relative z-20 m-2 text-sm text-error">{treeError()}</p></Show>
          <Show when={activeTask() === undefined && projectId() !== undefined}><ChatPanel projectId={projectId()!} onTabStatusChange={registerChatTabStatus} /></Show>
          <Show when={activeTask() !== undefined}>
            <Show when={loadError()}><div role="alert" class="alert alert-error text-sm">{loadError()}</div></Show>
            <Show when={loading() && !detail()}><p class="p-4 text-sm text-base-content/60">読み込み中...</p></Show>
            <Show when={detail() && detail()?.task.id === activeTask()}>
              <PhaseIndicator phase={detail()!.task.phase} viewPhase={chatPhase()} onViewPhaseChange={setViewPhase} advancing={advancing()} canStart={!!detail()?.canStart && implementationAvailable()} canComplete={canComplete()} completed={detail()?.task.status === 'completed'} busy={chatBusy()} modelSelect={<select class="select select-bordered select-sm w-auto min-w-0" style={{ 'field-sizing': 'content' }} aria-label="実装担当モデル" value={implementationModel() ? modelValue(implementationModel()!) : ''} disabled={advancing() || !availableModels().length} onChange={event => { const model = availableModels().find(item => modelValue(item) === event.currentTarget.value); if (model && providerReady(model.provider)) chooseModel(implementationScope(), model); }}>
                <Show when={implementationModel() && !implementationAvailable()}><option value={modelValue(implementationModel()!)} selected disabled>⚠️ {modelLabel(implementationModel()!.name, implementationModel()!.provider)}</option></Show>
                <Show when={!implementationModel()}><option value="">未確認</option></Show>
                <For each={availableModels().filter(item => implementationAvailable() || modelValue(item) !== (implementationModel() ? modelValue(implementationModel()!) : ''))}>{item => <option value={modelValue(item)} selected={modelValue(item) === (implementationModel() ? modelValue(implementationModel()!) : '')} disabled={!providerReady(item.provider)}>{modelLabel(item.name, item.provider)}</option>}</For>
              </select>} onChange={async target => {
                const current = detail(), requestedModel = implementationModel();
                if (!current || advancing() || (target === 'start' && !implementationAvailable()) || (target === 'complete' && !canComplete())) return;
                setAdvancing(true); setPhaseError('');
                try {
                  const result = await api<Task>(`/api/tasks/${current.task.id}/${['start', 'stop', 'complete', 'reopen'].includes(target) ? target : 'phase'}`, { projectId: current.task.projectId, phase: current.task.phase, ...(target === 'start' ? { model: requestedModel?.id, provider: requestedModel?.provider ?? 'codex' } : ['stop', 'complete', 'reopen'].includes(target) ? {} : { target }) });
                  if (detail()?.task.id === current.task.id) {
                    setDetail({ ...detail()!, task: result, canStart: false });
                    setTasks(previous => previous.map(item => item.id === result.id ? result : item));
                    props.onTaskChange?.(result.id, result);
                    const next = phaseDocuments.find(item => item.phase === result.phase);
                    const target = documents().filter(item => item.name === next?.name).reduce<Document | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
                    if (target) openPreview(documentId(target));
                    const refreshed = await api<TaskDetail>(`/api/tasks/${current.task.id}`);
                    if (alive && detail()?.task.id === current.task.id) {
                      setDetail(refreshed);
                      adoptDocuments(current.task.id, refreshed.documents);
                    }
                  }
                } catch (error) {
                  if (target === 'start' && error instanceof ApiError && error.code === 'MODEL_UNAVAILABLE' && requestedModel) rejectModel(modelScope(current.task.projectId, current.task.id, 'implementation-assignee'), requestedModel.id, requestedModel.provider);
                  if (error instanceof ApiError && error.status === 409) {
                    try { const refreshed = await api<TaskDetail>(`/api/tasks/${current.task.id}`); if (alive && detail()?.task.id === current.task.id) { batch(() => { setDetail(refreshed); adoptDocuments(current.task.id, refreshed.documents); setTasks(previous => previous.map(item => item.id === refreshed.task.id ? refreshed.task : item)); }); props.onTaskChange?.(refreshed.task.id, refreshed.task); } } catch { /* 元のエラーを表示する。 */ }
                  }
                  if (alive && detail()?.task.id === current.task.id) setPhaseError(error instanceof Error ? error.message : 'フェーズを更新できませんでした');
                }
                finally { setAdvancing(false); }
              }} />
              <Show when={phaseError()}><p role="alert" class="p-2 text-sm text-error">{phaseError()}</p></Show>
              <Show when={actualPhase() === 'retrospective' && review()}>{state =>
                <div class="flex flex-wrap items-center gap-2 border-b border-base-300 px-3 py-2 text-sm">
                  <p role="status">反省会の自動分析 · {reviewLabels[state().state]}</p>
                  <Show when={state().state === 'pending' || state().state === 'running'}>
                    <button type="button" class="btn btn-sm" disabled={advancing()} onClick={() => void workflowAction('stop-review')}>停止</button>
                  </Show>
                  <Show when={state().state === 'stopped'}>
                    <button type="button" class="btn btn-sm" disabled={advancing() || chatBusy()} onClick={() => void workflowAction('retry-review')}>自動分析を再開</button>
                  </Show>
                  <Show when={state().state === 'failed'}>
                    <Show when={state().error}><p class="text-error">{state().error}</p></Show>
                    <button type="button" class="btn btn-sm" disabled={advancing() || chatBusy()} onClick={() => void workflowAction('retry-review')}>自動分析を再試行</button>
                  </Show>
                </div>
              }</Show>
              <Show when={actualPhase() === 'finalization' && detail()?.task.status === 'completed' && instructionJob()}>{job =>
                <div class="flex flex-wrap items-center gap-2 border-b border-base-300 px-3 py-2 text-sm">
                  <p role="status">インストラクションの更新 · {instructionJobLabels[job().status]}</p>
                  <Show when={job().status === 'failed'}>
                    <Show when={job().error}><p class="text-error">{job().error}</p></Show>
                    <button type="button" class="btn btn-sm" disabled={advancing()} onClick={() => void workflowAction('retry-instructions')}>インストラクションの更新を再試行</button>
                  </Show>
                </div>
              }</Show>
              <Show when={isTaskPhase(detail()?.task.phase)}><ChatPanel onTabStatusChange={registerChatTabStatus} readOnly={chatPhase() === 'execution' || actualPhase() === 'finalization' || detail()?.task.status === 'completed' || reviewInProgress()} onBusyChange={setChatBusy} onModelUnavailable={(model, provider) => { if (detail()?.task.phase === 'execution') rejectModel(implementationScope(), model, provider); }} projectId={detail()!.task.projectId} taskId={activeTask()} phase={chatPhase()} /></Show>
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
    <section class="card card-border border-base-300 bg-base-100 shadow-sm min-h-[20rem] min-w-0 lg:min-h-0 overflow-hidden" aria-label="文書プレビュー">
      <TabBar label="文書" tabs={[
        ...openDocuments().map(id => { const document = documents().find(item => documentId(item) === id); return { id, label: document ? documentLabel(document) : 'タスク文書' }; }),
        ...openFiles().map(id => {
          const path = projectFilePath(id)!;
          const name = projectFileName(path);
          const duplicate = openFiles().some(other => other !== id && projectFileName(projectFilePath(other)!) === name)
            || documents().some(document => documentLabel(document) === name);
          return { id, label: duplicate ? `プロジェクトファイル / ${path}` : name };
        }),
      ]} activeId={activeFile() ?? activeDocument()} onSelect={openPreview} onClose={closePreview} left={toggle('文書ツリーを開閉', documentTreeOpen(), 'document-tree', () => setDocumentTreeOpen(value => !value), element => { documentTreeToggle = element; })} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Show when={documentTreeOpen()}><TreeView id="document-tree" label="文書" nodes={previewNodes()} activeId={activeFile() ?? activeDocument()} onSelect={id => { openPreview(id); setDocumentTreeOpen(false); }} /></Show>
        <Show when={activeFile()} keyed>{id => <ProjectFileContent projectId={projectId()!} path={projectFilePath(id)!} />}</Show>
        <Show when={!activeFile() && currentDocument()}>{document => {
          const preview = {
            get content() { return document().content; },
            get documents() { return documents().map(item => item.name); },
            onDocument(name: string) {
              const target = documents().find(item => item.name === name);
              if (target) openDocument(documentId(target));
            },
          };
          return <Show when={currentDocumentSource()} fallback={<MarkdownPreview {...preview} />}>
            {source => <PromptTableMarkdownPreview {...preview} {...source()} />}
          </Show>;
        }}</Show>
      </div>
    </section>
  </section>;
}
