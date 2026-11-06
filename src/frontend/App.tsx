import { validProjectId, validTaskId } from '../shared/ids';
import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import Home from './Home';
import Menu from './components/Menu';
import CodexSettings from './components/CodexSettings';
import Instructions from './Instructions';
import Workspace from './Workspace';
import { api } from './api';
import type { AppState, Task } from './types';

type Route = { kind: 'home' } | { kind: 'settings' } | { kind: 'instructions' } | { kind: 'project'; id: string; task?: string; invalidTask: boolean } | { kind: 'not-found' };
export function parseRoute(url: URL): Route {
  if (url.pathname === '/') return { kind: 'home' };
  if (url.pathname === '/settings') return { kind: 'settings' };
  if (url.pathname === '/instructions') return { kind: 'instructions' };
  const match = /^\/project\/([^/]+)$/.exec(url.pathname);
  const id = validProjectId(match?.[1]) ? match![1] : undefined;
  if (id === undefined) return { kind: 'not-found' };
  const tasks = url.searchParams.getAll('task');
  const task = validTaskId(tasks[0]) ? tasks[0] : undefined;
  return { kind: 'project', id, task, invalidTask: tasks.length > 1 || (tasks.length === 1 && task === undefined) };
}

function ProjectScreen(props: { id: string; task?: string; invalidTask: boolean; onTaskChange: (id?: string) => void; onHome: () => void; onTitle: (title: string) => void }) {
  const [state, setState] = createSignal<AppState>();
  const [error, setError] = createSignal('');
  let active = true;
  onMount(async () => {
    try {
      const data = await api<AppState>('/api/state');
      if (!active) return;
      setState(data);
      const project = data.projects.find(item => item.id === props.id);
      props.onTitle(project?.name ?? 'プロジェクト');
    } catch {
      if (active) setError('プロジェクトを取得できませんでした');
    }
  });
  onCleanup(() => { active = false; });
  const project = createMemo(() => state()?.projects.find(item => item.id === props.id));
  const validTask = createMemo(() => props.task === undefined || !!state()?.tasks.some(task => task.id === props.task && task.projectId === props.id));
  function changeTask(id?: string, task?: Task) {
    // The workspace can load a newer task list than this screen's first snapshot.
    // Carry the verified same-project task forward before updating the URL.
    if (id !== undefined && task?.id === id && task.projectId === props.id) {
      setState(previous => previous && { ...previous, tasks: [...previous.tasks.filter(item => item.id !== id), task] });
    }
    props.onTaskChange(id);
  }
  return <>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Show when={!state() && !error()}><p>読み込み中...</p></Show>
    <Show when={state() && !project()}><p role="alert">プロジェクトが見つかりません</p></Show>
    <Show when={project()}>
      <Show when={!props.invalidTask && validTask()} fallback={<p role="alert">このプロジェクトのタスクが見つかりません</p>}>
        <Workspace onTaskDeleted={id => setState(previous => previous && { ...previous, tasks: previous.tasks.filter(task => task.id !== id) })} projectId={props.id} taskId={props.task} onTaskChange={changeTask} onHome={props.onHome} />
      </Show>
    </Show>
  </>;
}

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute(new URL(window.location.href)));
  const [query, setQuery] = createSignal('');
  const [projectTitle, setProjectTitle] = createSignal<{ id: string; name: string }>();
  const projectId = createMemo(() => { const current = route(); return current.kind === 'project' ? current.id : undefined; });
  const projectRoute = () => { const current = route(); return current.kind === 'project' ? current : undefined; };
  const navigate = (path: string) => {
    if (path === `${window.location.pathname}${window.location.search}`) return;
    window.history.pushState(null, '', path);
    setRoute(parseRoute(new URL(window.location.href)));
  };
  const home = () => navigate('/');
  onMount(() => {
    const pop = () => setRoute(parseRoute(new URL(window.location.href)));
    window.addEventListener('popstate', pop);
    onCleanup(() => window.removeEventListener('popstate', pop));
  });
  return <div class="flow-root" classList={{ 'instructions-shell': route().kind === 'instructions', 'project-shell': route().kind === 'project' }}>
    <Menu title={route().kind === 'project' ? (projectTitle()?.id === projectId() ? projectTitle()!.name : 'プロジェクト') : route().kind === 'settings' ? '設定' : route().kind === 'instructions' ? 'インストラクション管理' : 'Beni'} showHome={route().kind !== 'home'} query={query()} onHome={home} onQueryChange={setQuery} onInstructions={() => navigate('/instructions')} onSettings={() => navigate('/settings')} />
    <main class="mx-auto w-full px-2 py-2">
      <Show when={route().kind === 'home'}><Home query={query()} onOpenProject={project => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}`); }} onOpenTask={(task, project) => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}?task=${task.id}`); }} /></Show>
      <Show when={projectId()} keyed>{id => <ProjectScreen id={id} task={projectRoute()?.task} invalidTask={projectRoute()?.invalidTask ?? false} onHome={home} onTitle={name => setProjectTitle({ id, name })} onTaskChange={task => navigate(`/project/${id}${task === undefined ? '' : `?task=${task}`}`)} />}</Show>
      <Show when={route().kind === 'settings'}><CodexSettings /></Show>
      <Show when={route().kind === 'instructions'}><Instructions /></Show>
      <Show when={route().kind === 'not-found'}><p role="alert">画面が見つかりません</p></Show>
    </main>
  </div>;
}
