import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { api } from './api';
import ChatContent from './components/ChatContent';
import ChatComposer from './components/ChatComposer';
import PhaseIndicator from './components/PhaseIndicator';
import TabBar from './components/TabBar';
import TreeView from './components/TreeView';
import WorkflowRecovery, { readAttempts } from './components/WorkflowRecovery';
import WorkflowHistoryView from './components/WorkflowHistory';
import WorkflowResults from './components/WorkflowResults';
import { clearBlock, clearPendingPreview, isBlocked, knownUnavailable, notify, perform, scheduleRequirements, setNotice, setPendingPreview, stateFor, storageAvailable, subscribe, validCapabilities, validProjection, workflowPost } from './workflowController';
import type { AppState, Capabilities, Document, Task, TaskDetail, Workflow } from './types';

export interface WorkspaceProps {
  taskId?: number;
  projectId?: number;
  onTaskChange?: (id: number | undefined, task?: Task) => void;
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
  const [openTasks, setOpenTasks] = createSignal<number[]>(props.taskId === undefined ? [] : [props.taskId]);
  const [projectId, setProjectId] = createSignal<number | undefined>(props.projectId);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [treeError, setTreeError] = createSignal('');
  const [taskTreeOpen, setTaskTreeOpen] = createSignal(false);
  const [documentTreeOpen, setDocumentTreeOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [history, setHistory] = createSignal<Workflow | null>(null);
  const [historyError, setHistoryError] = createSignal('');
  const [capabilities, setCapabilities] = createSignal<Capabilities>();
  const [revision, setRevision] = createSignal(0);
  const [draftText, setDraftText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal('');
  const [openDocuments, setOpenDocuments] = createSignal<string[]>([]);
  const [activeDocument, setActiveDocument] = createSignal<string>();
  const documentTabs = new Map<number, DocumentTabs>();
  let documentOwner: number | undefined;
  let alive = true;
  let taskViewGeneration = 0;
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
  const documentLabel = (document: Document) => {
    const name = document.name === 'plan' ? '実装計画.md' : document.name;
    return documents().filter(item => item.name === document.name).length > 1 ? `${name} · v${document.version}` : name;
  };
  const currentDocument = createMemo(() => documents().find(document => documentId(document) === activeDocument()));
  const latest = (names: string[]) => documents().filter(document => names.includes(document.name)).reduce<Document | undefined>((best, document) => !best || document.version > best.version ? document : best, undefined);
  // Only the server's authoritative kind mapping may gate approval.
  const latestRequirements = () => latest(['指示書.md']);
  const latestPlan = () => latest(['plan']);
  const integrityOkay = () => activeTask() !== undefined && validProjection(detail(), activeTask()!);
  const requirementsCurrent = () => {
    const data = detail(), saved = history(), document = latestRequirements();
    if (!data || !saved || !document) return false;
    const instructions = data.messages.filter(message => message.role === 'user').map(message => ({ id: message.id, content: message.content }));
    // The initial requirements document is created from the task name; no messages exist yet.
    if (!instructions.length) return true;
    return saved.requirements.some(result => {
      if (result.kind !== 'settled' || result.payload.status !== 'adopted' || result.payload.version !== document.version || result.payload.content !== document.content) return false;
      const started = saved.requirements.find(event => event.kind === 'started' && event.attempt_id === result.attempt_id);
      return Array.isArray(started?.payload?.snapshot?.instructions) && JSON.stringify(started.payload.snapshot.instructions) === JSON.stringify(instructions);
    });
  };
  const ready = () => activeTask() !== undefined && detail()?.task.id === activeTask();
  const operation = () => { revision(); const id = activeTask(); return id === undefined ? undefined : stateFor(id); };
  const connected = (kind: keyof Capabilities) => { revision(); return !!capabilities()?.[kind] && !knownUnavailable(kind); };
  const connectionLabel = (kind: keyof Capabilities) => capabilities() ? (connected(kind) ? '設定あり（接続未確認）' : '未設定') : '未確認';
  const blocked = () => { revision(); const id = activeTask(); return id === undefined || isBlocked(id); };
  const historySafe = () => {
    const parsed = readAttempts(history(), activeTask());
    return parsed.valid && !parsed.attempts.some(attempt => attempt.status === 'running' || (attempt.kind !== 'review' && ['unknown', 'interrupted'].includes(attempt.status) && !attempt.acknowledged));
  };
  const currentPlan = () => {
    const req = latestRequirements(), plan = latestPlan(), data = detail(), saved = history();
    if (!req || !plan || !data || !saved) return false;
    const event = saved.workflow.filter(item => item.kind === 'plan').at(-1);
    const messageId = Math.max(0, ...data.messages.filter(message => message.role === 'user').map(message => message.id));
    return event?.payload.requirementsVersion === req.version && event.payload.planVersion === plan.version && event.payload.messageId === messageId;
  };
  const alreadyRequested = () => {
    const req = latestRequirements(), plan = latestPlan(), events = history()?.workflow ?? [];
    if (!req || !plan) return false;
    const approvals = events.filter(item => item.kind === 'approval' && item.payload.requirementsVersion === req.version && item.payload.planVersion === plan.version);
    return events.some(item => item.kind === 'execution_requested' && approvals.some(approval => approval.id === item.payload.approvalId));
  };
  const reviewNeedsInstruction = () => {
    const saved = history();
    if (!saved) return false;
    const issue = saved.workflow.filter(event => event.kind === 'review_interrupted' ||
      (event.kind === 'review_result' && ['failed', 'interrupted', 'unknown', 'stale'].includes(event.payload.status))).at(-1);
    if (!issue) return false;
    let previousMessage: number | undefined;
    if (issue.kind === 'review_result' && issue.payload.status === 'stale') {
      const review = saved.review.find(item => item.id === issue.payload.reviewId && item.attempt_id === issue.payload.attemptId);
      const savedMessageId: unknown = review?.snapshot?.messageId;
      if (typeof savedMessageId === 'number' && Number.isSafeInteger(savedMessageId) && savedMessageId >= 0) previousMessage = savedMessageId;
    }
    return !saved.workflow.some(event => (event.kind === 'instruction' || event.kind === 'feedback') &&
      (event.id > issue.id || (previousMessage !== undefined && Number.isSafeInteger(event.payload.messageId) && event.payload.messageId > previousMessage)));
  };
  const canAdvance = () => ready() && integrityOkay() && !!history() && !historyError() && historySafe() && !blocked() && !operation()?.busy && !operation()?.checking && !operation()?.queued && !operation()?.pending && !sending() && !draftText().trim();

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
  onMount(async () => {
    try {
      const result = await api<Capabilities>('/api/workflow/capabilities');
      if (alive && validCapabilities(result)) setCapabilities(result);
    } catch { /* Capabilities remain unconfirmed and all operations disabled. */ }
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
    let selected = previous?.selected && open.includes(previous.selected) ? previous.selected : previous ? open[open.length - 1] : newest && documentId(newest);
    const pending = stateFor(taskId).pending;
    if (pending) {
      const names = pending.kind === 'plan' ? ['plan'] : ['指示書.md'];
      const found = values.filter(document => names.includes(document.name) && document.version >= pending.version).sort((a, b) => b.version - a.version)[0];
      if (found) {
        const id = documentId(found);
        if (!open.includes(id)) open.push(id);
        selected = id;
        clearPendingPreview(taskId, pending.kind, found.version);
      }
    }
    saveDocumentTabs(taskId, open, selected, available);
  }

  createEffect(() => {
    const taskId = activeTask();
    taskViewGeneration++;
    if (taskId === undefined) { setLoading(false); return; }
    const draft = draftFor(taskId);
    let active = true;
    let sequence = 0;
    if (documentOwner !== taskId) {
      batch(() => { setDetail(undefined); setHistory(null); setHistoryError(''); restoreDocumentTabs(taskId); });
    }
    setLoading(true);
    setLoadError('');
    const load = async () => {
      const request = ++sequence;
      setHistory(null);
      try {
        const [data, saved] = await Promise.allSettled([
          api<TaskDetail>(`/api/tasks/${taskId}`),
          api<Workflow>(`/api/tasks/${taskId}/workflow/events`),
        ]);
        if (!active || request !== sequence) return;
        if (data.status === 'rejected') throw data.reason;
        batch(() => {
          setDetail(data.value);
          setProjectId(data.value.task.projectId);
          adoptDocuments(taskId, data.value.documents);
          if (saved.status === 'fulfilled' && readAttempts(saved.value, taskId).valid) { setHistory(saved.value); setHistoryError(''); }
          else { setHistory(null); setHistoryError('履歴を取得できません。処理は開始できません。'); }
          setLoadError('');
        });
      } catch (error) {
        if (active && request === sequence) { setHistory(null); setHistoryError('履歴を取得できません。処理は開始できません。'); setLoadError(error instanceof Error ? error.message : 'タスクを取得できませんでした'); }
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
    const unsubscribe = subscribe((id, refresh) => {
      if (!active || id !== taskId) return;
      setRevision(value => value + 1);
      if (refresh) void load();
    });
    update(false);
    void load();
    onCleanup(() => {
      active = false;
      sequence++;
      draft.listeners.delete(update);
      unsubscribe();
    });
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
      scheduleRequirements(taskId);
    } catch (error) {
      draft.error = error instanceof Error ? error.message : '送信できませんでした';
      publish(draft);
    } finally {
      draft.sending = false;
      publish(draft);
    }
  }
  function updateRequirements() {
    const id = activeTask();
    if (id === undefined || !canAdvance() || !connected('requirements')) return;
    scheduleRequirements(id);
  }
  function requestPlan() {
    const id = activeTask(), req = latestRequirements();
    if (id === undefined || !canAdvance() || reviewNeedsInstruction() || !requirementsCurrent() || !connected('plan') || !req || activeDocument() !== documentId(req)) return;
    void perform(id, '計画を生成中', async () => {
      const result = await workflowPost<{status: string; version?: number; outcomeUnknown?: boolean}>(`/api/tasks/${id}/workflow/plan`, { requestKey: crypto.randomUUID() }, 'plan');
      if (!result || !['adopted', 'stale', 'failed'].includes(result.status) || result.outcomeUnknown !== false) throw new Error('Unknown outcome');
      if (result.status === 'adopted') {
        if (!Number.isSafeInteger(result.version) || !result.version || result.version < 1) throw new Error('Invalid version');
        setPendingPreview(id, 'plan', result.version);
      }
      setNotice(id, `計画生成: ${result.status}`);
    });
  }
  function executePlan() {
    const id = activeTask(), req = latestRequirements(), plan = latestPlan();
    if (id === undefined || !canAdvance() || reviewNeedsInstruction() || !requirementsCurrent() || !connected('execution') || !connected('review') || !req || !plan || !currentPlan() || alreadyRequested() || activeDocument() !== documentId(plan)) return;
    void perform(id, '実行中', async () => {
      await api(`/api/tasks/${id}/workflow/approve`, { requirementsVersion: req.version, planVersion: plan.version });
      const result = await workflowPost<{status:string;attemptId:number;stale?:boolean;result?:{outcomeUnknown?:boolean;output?:string;evidence?:unknown[]}}>(`/api/tasks/${id}/workflow/execute`, {}, 'execution');
      if (!result || !['succeeded', 'failed'].includes(result.status) || typeof result.stale !== 'boolean' || !result.result ||
        (result.status === 'failed' && result.result.outcomeUnknown !== false) ||
        (result.status === 'succeeded' && ((result.result.outcomeUnknown !== undefined && result.result.outcomeUnknown !== false) || typeof result.result.output !== 'string' || !result.result.output.trim() || !Array.isArray(result.result.evidence) || !result.result.evidence.length || !result.result.evidence.every(item => typeof item === 'string' && !!item.trim())))) throw new Error('Unknown outcome');
      setNotice(id, `実行: ${result.status}${result.stale ? '（追加指示等により旧版）' : ''}`);
      if (result.status === 'succeeded' && !result.stale) {
        if (!Number.isSafeInteger(result.attemptId) || result.attemptId < 1) throw new Error('Invalid attempt');
        const review = await workflowPost<{status:string}>(`/api/tasks/${id}/workflow/review`, { attemptId: result.attemptId }, 'review');
        if (!review || !['completed', 'changes_requested', 'stale', 'failed'].includes(review.status)) throw new Error('Unknown review');
        setNotice(id, `監修: ${review.status}`);
      }
    });
  }
  async function refreshHistory(taskId: number) {
    const generation = taskViewGeneration;
    const [saved, current] = await Promise.all([
      api<Workflow>(`/api/tasks/${taskId}/workflow/events`),
      api<TaskDetail>(`/api/tasks/${taskId}`),
    ]);
    if (!validProjection(current, taskId) || !readAttempts(saved, taskId).valid) throw new Error('履歴を確認できません');
    if (!alive || activeTask() !== taskId || generation !== taskViewGeneration) throw new Error('画面が切り替わりました');
    setHistory(saved); setHistoryError(''); notify(taskId, true);
  }
  const toggle = (label: string, expanded: boolean, controls: string, onClick: () => void, setRef: (element: HTMLButtonElement) => void) =>
    <button ref={setRef} type="button" class="btn btn-ghost btn-square btn-sm m-1" aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onClick}>☰</button>;

  return <section class="mx-auto grid h-auto min-h-[34rem] min-w-0 max-w-7xl gap-4 px-4 pb-5 pt-4 lg:h-[calc(100vh-7rem)] lg:grid-cols-2">
    <div class="flex min-h-0 min-w-0 flex-col gap-4">
      <section class="card flex min-h-[20rem] min-w-0 flex-1 flex-col overflow-hidden border border-base-300 bg-base-100 shadow-sm" aria-label="タスクチャット">
        <TabBar label="チャット" tabs={openTasks().map(id => ({ id: String(id), label: taskName(id) }))} activeId={activeTask() === undefined ? undefined : String(activeTask())} onSelect={id => openTask(Number(id))} onClose={id => closeTask(Number(id))} left={toggle('タスクツリーを開閉', taskTreeOpen(), 'task-tree', () => setTaskTreeOpen(value => !value), element => { taskTreeToggle = element; })} />
        <div class="relative flex min-h-0 flex-1 flex-col">
          <Show when={taskTreeOpen()}><TreeView id="task-tree" label="タスク" nodes={[...taskOptions().map(task => ({id:String(task.id), label:taskLabel(task)})), ...(props.taskId !== undefined && !taskOptions().some(task => task.id === props.taskId) ? [{id:String(props.taskId),label:taskName(props.taskId)}] : [])]} onSelect={id => { openTask(Number(id)); setTaskTreeOpen(false); }} /></Show>
          <Show when={taskTreeOpen() && treeError()}><p role="alert" class="relative z-20 m-2 text-sm text-error">{treeError()}</p></Show>
          <Show when={activeTask() === undefined}><p class="p-4 text-sm text-base-content/60">ツリーからタスクを選択してください。</p></Show>
          <Show when={activeTask() !== undefined}>
            <Show when={loadError()}><div role="alert" class="alert alert-error text-sm">{loadError()}</div></Show>
            <Show when={loading() && !detail()}><p class="p-4 text-sm text-base-content/60">読み込み中...</p></Show>
            <Show when={detail() && detail()?.task.id === activeTask()}>
              <PhaseIndicator phase={detail()!.task.phase} onRequirements={() => {
                const document = documents().filter(item => item.name === '指示書.md').reduce<Document | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
                if (document) openDocument(documentId(document));
              }} hasPlan={!!latestPlan()} onPlan={() => { const doc = latestPlan(); if (doc) openDocument(documentId(doc)); }}
                onUpdateRequirements={updateRequirements} updateDisabled={!canAdvance() || !connected('requirements')}
                onRequestPlan={requestPlan} requestDisabled={!canAdvance() || reviewNeedsInstruction() || !requirementsCurrent() || !connected('plan') || !latestRequirements() || activeDocument() !== (latestRequirements() && documentId(latestRequirements()!))}
                onExecute={executePlan} executeDisabled={!canAdvance() || reviewNeedsInstruction() || !requirementsCurrent() || !connected('execution') || !connected('review') || !currentPlan() || alreadyRequested() || !latestPlan() || activeDocument() !== (latestPlan() && documentId(latestPlan()!))} />
              <p class="border-b border-base-300 bg-base-200/50 px-5 py-3 text-xs leading-relaxed text-base-content/70">現在: {phaseLabel(detail()!.task.phase)} · {statusLabel(detail()!.task.status)}。
                接続状態: 指示書生成 {connectionLabel('requirements')} ／ 計画 {connectionLabel('plan')} ／ 実行 {connectionLabel('execution')} ／ 監修 {connectionLabel('review')}。
                {capabilities() ? '操作には最新の指示書・計画の表示と必要な接続が必要です。' : '接続状態を確認できないため操作を開始できません。'}
              </p>
              <Show when={operation()?.notice}><p class="px-4 py-2 text-sm" role="status">{operation()!.notice}</p></Show>
              <Show when={historyError()}><p class="px-4 py-2 text-sm text-error" role="alert">{historyError()}</p></Show>
              <Show when={history() && detail()!.messages.some(message => message.role === 'user') && !requirementsCurrent()}><p class="px-4 py-2 text-sm" role="status">最新の追加指示を指示書に反映してから計画を依頼できます。</p></Show>
              <Show when={reviewNeedsInstruction()}><p class="px-4 py-2 text-sm" role="status">監修が完了していません。再計画には追加指示が必要です。</p></Show>
              <Show when={!storageAvailable()}><p class="px-4 py-2 text-sm text-error" role="alert">確認状態を保存できないため処理を開始できません。</p></Show>
              <ChatContent messages={detail()!.messages}><WorkflowResults taskId={detail()!.task.id} history={history()} integrity={integrityOkay()} /></ChatContent>
              <div class="max-h-40 overflow-auto px-4 pb-2">
                <WorkflowHistoryView history={history()} integrity={integrityOkay()} />
                <WorkflowRecovery taskId={detail()!.task.id} history={history()} blocked={blocked()} onClear={() => {
                  const id = detail()!.task.id, state = stateFor(id);
                  if (state.busy || state.checking || !integrityOkay() || !clearBlock(id)) throw new Error('処理中または確認状態を保存できません');
                }} onNotice={text => setNotice(detail()!.task.id, text)} onRefresh={() => refreshHistory(detail()!.task.id)} />
              </div>
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
      <TabBar label="文書" tabs={openDocuments().map(id => { const document = documents().find(item => documentId(item) === id); return {id, label:document ? documentLabel(document) : id}; })} activeId={activeDocument()} onSelect={openDocument} onClose={closeDocument} left={toggle('文書ツリーを開閉', documentTreeOpen(), 'document-tree', () => setDocumentTreeOpen(value => !value), element => { documentTreeToggle = element; })} />
      <div class="relative flex min-h-0 flex-1 flex-col">
        <Show when={documentTreeOpen()}><TreeView id="document-tree" label="文書" nodes={documents().map(document => ({id:documentId(document),label:documentLabel(document)}))} onSelect={id => { openDocument(id); setDocumentTreeOpen(false); }} /></Show>
        <Show when={currentDocument()}>{document => <pre class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-sm leading-relaxed">{document().content}</pre>}</Show>
      </div>
    </section>
  </section>;
}
