import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api } from './api';
import type { AppState, Project, Task } from './types';

export interface HomeProps {
  query: string;
  onOpenProject?: (project: Project) => void;
  onOpenTask: (task: Task, project: Project, created: boolean) => void;
}

type SortKey = 'id' | 'name' | 'phase' | 'status';
const columns: { key: SortKey; label: string }[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'タスク名' },
  { key: 'phase', label: 'フェーズ' },
  { key: 'status', label: '状態' },
];

/** A stable secondary order is the order immediately before the latest header click. */
function compare(left: Task, right: Task, key: SortKey): number {
  return String(left[key]).localeCompare(String(right[key]), 'ja', { numeric: true });
}

function confirmationPriority(task: Task): number {
  return /確認待ち|回答待ち/.test(task.status) ? 0 : 1;
}

// Creation requests and drafts belong to the application, not to a single Home mount.
// A request can outlive the view while the user visits settings or another project.
const [taskName, setTaskName] = createSignal('');
const [projectId, setProjectId] = createSignal('');
const [projectName, setProjectName] = createSignal('');
const [folder, setFolder] = createSignal('');
const [creatingTask, setCreatingTask] = createSignal(false);
const [creatingProject, setCreatingProject] = createSignal(false);
const [actionError, setActionError] = createSignal('');
const taskListeners = new Set<(task: Task) => void>();
const projectListeners = new Set<(project: Project) => void>();
let taskNameEditVersion = 0;
let projectChoiceVersion = 0;

export default function Home(props: HomeProps) {
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [tasks, setTasks] = createSignal<Task[]>([]);
  const [error, setError] = createSignal('');
  const [projectError, setProjectError] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [sortKey, setSortKey] = createSignal<SortKey>('id');
  const [sortDirection, setSortDirection] = createSignal<1 | -1>(-1);
  let dialog: HTMLDialogElement | undefined;
  let projectSelect: HTMLSelectElement | undefined;
  let projectSelectVersion = 0;
  let alive = true;
  let interactionVersion = 0;
  let lastQuery = props.query;

  const selectedProject = createMemo(() => projects().find(project => String(project.id) === projectId()));
  const filteredTasks = createMemo(() => {
    const query = props.query.trim().toLocaleLowerCase();
    return tasks().filter(task => `${task.id} ${task.name}`.toLocaleLowerCase().includes(query));
  });
  const canCreate = createMemo(() => Boolean(taskName().trim() && selectedProject()) && !creatingTask());

  createEffect(() => {
    const next = props.query;
    if (next !== lastQuery) {
      lastQuery = next;
      interactionVersion++;
    }
  });
  // The value can be restored before asynchronous project options exist. Reapply it
  // after Solid has updated the <option> nodes, including when a project is created.
  createEffect(() => {
    projects();
    const selected = projectId();
    const version = ++projectSelectVersion;
    queueMicrotask(() => {
      if (alive && version === projectSelectVersion && projectSelect) projectSelect.value = selected;
    });
  });
  const receiveTask = (task: Task) => setTasks(previous => [task, ...previous.filter(item => item.id !== task.id)]);
  const receiveProject = (project: Project) => setProjects(previous => [project, ...previous.filter(item => item.id !== project.id)]);
  taskListeners.add(receiveTask);
  projectListeners.add(receiveProject);
  onCleanup(() => {
    alive = false;
    taskListeners.delete(receiveTask);
    projectListeners.delete(receiveProject);
  });
  onMount(async () => {
    try {
      const loaded = await api<AppState>('/api/state');
      if (!alive) return;
      setProjects(previous => {
        const merged = new Map(loaded.projects.map(item => [item.id, item]));
        for (const item of previous) merged.set(item.id, item);
        return [...merged.values()].sort((a, b) => b.id - a.id);
      });
      setTasks(previous => {
        const merged = new Map(loaded.tasks.map(item => [item.id, item]));
        for (const item of previous) merged.set(item.id, item);
        return [...merged.values()].sort((a, b) => confirmationPriority(a) - confirmationPriority(b) || b.id - a.id);
      });
    } catch (cause) {
      if (alive) setError(cause instanceof Error ? cause.message : '一覧を取得できませんでした');
    } finally {
      if (alive) setLoading(false);
    }
  });

  function sort(key: SortKey) {
    const direction: 1 | -1 = sortKey() === key && sortDirection() === 1 ? -1 : 1;
    setTasks(previous => previous.map((task, index) => ({ task, index }))
      .sort((left, right) => direction * compare(left.task, right.task, key) || left.index - right.index)
      .map(item => item.task));
    setSortKey(key);
    setSortDirection(direction);
  }

  function chooseProject(value: string) {
    interactionVersion++;
    projectChoiceVersion++;
    if (value === 'new') {
      if (creatingProject()) return;
      setProjectId('');
      setProjectError('');
      dialog?.showModal();
      return;
    }
    setProjectId(value);
  }

  async function createProject(event: SubmitEvent) {
    event.preventDefault();
    if (creatingProject() || !projectName().trim() || !folder().trim()) return;
    const selectedBefore = projectChoiceVersion;
    const name = projectName();
    const path = folder();
    setCreatingProject(true);
    setProjectError('');
    setActionError('');
    try {
      const created = await api<Project>('/api/projects', { name, folder: path });
      for (const notify of projectListeners) notify(created);
      // Do not replace a selection the user made after leaving this view.
      if (projectChoiceVersion === selectedBefore) setProjectId(String(created.id));
      if (projectName() === name && folder() === path) {
        setProjectName('');
        setFolder('');
      }
      if (alive && dialog?.open) dialog.close();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'プロジェクトを作成できませんでした';
      if (alive && dialog?.open) setProjectError(message);
      else setActionError(message);
    } finally {
      setCreatingProject(false);
    }
  }

  async function createTask(event: SubmitEvent) {
    event.preventDefault();
    const project = selectedProject();
    const name = taskName();
    if (creatingTask() || !project || !name.trim()) return;
    const before = interactionVersion;
    const nameEditBefore = taskNameEditVersion;
    setCreatingTask(true);
    setError('');
    setActionError('');
    try {
      const task = await api<Task>('/api/tasks', { projectId: project.id, name });
      for (const notify of taskListeners) notify(task);
      if (taskNameEditVersion === nameEditBefore) setTaskName('');
      // A completion from an old Home must never take over the current view.
      if (alive && interactionVersion === before && String(project.id) === projectId()) props.onOpenTask(task, project, true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'タスクを作成できませんでした');
    } finally {
      setCreatingTask(false);
    }
  }

  function openTask(task: Task) {
    const project = projects().find(item => item.id === task.projectId);
    if (!project) {
      setError('プロジェクトが見つかりません');
      return;
    }
    props.onOpenTask(task, project, false);
  }

  return <section class="home-surface mx-auto max-w-6xl">
    <div class="home-intro">
      <p class="eyebrow">WORKSPACE</p>
      <h1>タスク</h1>
      <p>プロジェクトを選んで、新しいタスクを始めましょう。</p>
    </div>
    <Show when={error() || actionError()}><p role="alert" class="alert alert-error mb-4">{error() || actionError()}</p></Show>
    <div class="create-card">
      <form class="create" onSubmit={createTask}>
        <input
          class="input input-bordered task-name"
          aria-label="タスク名"
          placeholder="タスク名"
          required
          value={taskName()}
          onInput={event => { interactionVersion++; taskNameEditVersion++; setTaskName(event.currentTarget.value); }}
        />
        <select
          ref={projectSelect}
          class="select select-bordered project-select"
          aria-label="プロジェクト"
          value={projectId()}
          onChange={event => chooseProject(event.currentTarget.value)}
        >
          <option value="">プロジェクト</option>
          <For each={projects()}>{project => <option value={String(project.id)}>{project.name}</option>}</For>
          <option value="new" disabled={creatingProject()}>＋ 新規プロジェクト作成</option>
        </select>
        <Show when={props.onOpenProject}>
          <button class="btn btn-outline" type="button" disabled={!selectedProject()} onClick={() => {
            const project = selectedProject();
            if (project) props.onOpenProject?.(project);
          }}>プロジェクトを開く</button>
        </Show>
        <button class="btn btn-primary" type="submit" disabled={!canCreate()}>タスク作成</button>
      </form>
    </div>
    <div class="task-list">
      <div class="task-list-heading"><h2>タスク一覧</h2><span class="task-count">{filteredTasks().length} 件</span></div>
      <div class="table-scroll">
        <table class="table">
          <thead><tr><For each={columns}>{column =>
            <th aria-sort={sortKey() === column.key ? (sortDirection() === 1 ? 'ascending' : 'descending') : 'none'}>
              <button type="button" class="sort-control" onClick={() => sort(column.key)}>
                {column.label}<span aria-hidden="true"> ↕</span>
              </button>
            </th>
          }</For></tr></thead>
          <tbody><For each={filteredTasks()}>{task =>
            <tr data-id={task.id} tabIndex={0} onClick={() => openTask(task)} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTask(task); }
            }}>
              <td class="task-id">#{task.id}</td><td class="task-title">{task.name}</td><td>{task.phase}</td><td><span class="status-chip">{task.status}</span></td>
            </tr>
          }</For></tbody>
        </table>
        <Show when={loading()}><p class="empty-state">読み込み中</p></Show>
        <Show when={!loading() && !filteredTasks().length}><p class="empty-state">表示するタスクはありません</p></Show>
      </div>
    </div>
    <dialog ref={dialog} class="modal" aria-labelledby="projectDialogTitle" onCancel={event => { if (creatingProject()) event.preventDefault(); }}>
      <form class="modal-box flex max-w-lg flex-col gap-5" onSubmit={createProject}>
        <h2 id="projectDialogTitle" class="text-lg font-semibold">プロジェクトを作成</h2>
        <Show when={projectError()}><p role="alert" class="alert alert-error">{projectError()}</p></Show>
        <label class="form-control flex flex-col gap-2 text-sm font-medium">プロジェクト名
          <input name="name" class="input input-bordered w-full font-normal" required disabled={creatingProject()} value={projectName()} onInput={event => setProjectName(event.currentTarget.value)} />
        </label>
        <label class="form-control flex flex-col gap-2 text-sm font-medium">フォルダ
          <input name="folder" class="input input-bordered w-full font-normal" required disabled={creatingProject()} value={folder()} onInput={event => setFolder(event.currentTarget.value)} />
        </label>
        <footer class="modal-action mt-1">
          <button type="button" class="btn btn-ghost" disabled={creatingProject()} onClick={() => dialog?.close()}>キャンセル</button>
          <button type="submit" class="btn btn-primary" disabled={creatingProject() || !projectName().trim() || !folder().trim()}>作成</button>
        </footer>
      </form>
    </dialog>
  </section>;
}
