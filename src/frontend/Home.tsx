import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { api } from './api';
import TaskCreate from './components/TaskCreate';
import TaskList, { type SortKey } from './components/TaskList';
import ProjectCreateDialog from './components/ProjectCreateDialog';
import type { AppState, Project, Task } from './types';

export interface HomeProps {
  query: string;
  onOpenProject?: (project: Project) => void;
  onOpenTask: (task: Task, project: Project, created: boolean) => void;
}

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
  const [folderPickerOpen, setFolderPickerOpen] = createSignal(false);
  const [sortKey, setSortKey] = createSignal<SortKey>('id');
  const [sortDirection, setSortDirection] = createSignal<1 | -1>(-1);
  const sortDirections = new Map<SortKey, 1 | -1>([['id', -1]]);
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
        return [...merged.values()].sort((a, b) => b.id.localeCompare(a.id));
      });
      setTasks(previous => {
        const merged = new Map(loaded.tasks.map(item => [item.id, item]));
        for (const item of previous) merged.set(item.id, item);
        return [...merged.values()].sort((a, b) => confirmationPriority(a) - confirmationPriority(b) || b.id.localeCompare(a.id));
      });
    } catch (cause) {
      if (alive) setError(cause instanceof Error ? cause.message : '一覧を取得できませんでした');
    } finally {
      if (alive) setLoading(false);
    }
  });

  function sort(key: SortKey) {
    const direction: 1 | -1 = sortDirections.get(key) === 1 ? -1 : 1;
    sortDirections.set(key, direction);
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
      if (creatingProject()) {
        if (projectSelect) projectSelect.value = projectId();
        return;
      }
      setProjectId('');
      // A signal already set to '' does not update the DOM when the user has
      // selected the special "new" option. Reset it even in that case.
      if (projectSelect) projectSelect.value = '';
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

  return <section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]">
    <Show when={error() || actionError()}><p role="alert" class="alert alert-error mb-4">{error() || actionError()}</p></Show>
    <TaskCreate
      taskName={taskName()}
      projectId={projectId()}
      projects={projects()}
      creatingProject={creatingProject()}
      canCreate={canCreate()}
      selectedProject={selectedProject()}
      projectSelectRef={element => { projectSelect = element; }}
      onTaskName={value => { interactionVersion++; taskNameEditVersion++; setTaskName(value); }}
      onChooseProject={chooseProject}
      onCreateTask={createTask}
      onOpenProject={props.onOpenProject}
    />
    <TaskList tasks={filteredTasks()} loading={loading()} sortKey={sortKey()} sortDirection={sortDirection()} onSort={sort} onOpenTask={openTask} />
    <ProjectCreateDialog
      dialogRef={element => { dialog = element; }}
      creating={creatingProject()}
      error={projectError()}
      name={projectName()}
      folder={folder()}
      folderPickerOpen={folderPickerOpen()}
      onCreate={createProject}
      onName={setProjectName}
      onFolder={setFolder}
      onFolderPickerOpen={setFolderPickerOpen}
    />
  </section>;
}
