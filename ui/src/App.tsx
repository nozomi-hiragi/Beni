import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import Home from './Home';
import Menu from './components/Menu';
import Workspace from './Workspace';
import { api } from './api';
import type { AppState, Task } from './types';

type Route = { kind: 'home' } | { kind: 'settings' } | { kind: 'project'; id: number; task?: number; invalidTask: boolean } | { kind: 'not-found' };
const positiveId = (value: string | null): number | undefined => {
  if (!value || !/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
};
export function parseRoute(url: URL): Route {
  if (url.pathname === '/') return { kind: 'home' };
  if (url.pathname === '/settings') return { kind: 'settings' };
  const match = /^\/project\/([1-9]\d*)$/.exec(url.pathname);
  const id = positiveId(match?.[1] ?? null);
  if (id === undefined) return { kind: 'not-found' };
  const tasks = url.searchParams.getAll('task');
  const task = positiveId(tasks[0] ?? null);
  return { kind: 'project', id, task, invalidTask: tasks.length > 1 || (tasks.length === 1 && task === undefined) };
}

function ProjectScreen(props: { id: number; task?: number; invalidTask: boolean; onTaskChange: (id?: number) => void; onHome: () => void; onTitle: (title: string) => void }) {
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
  function changeTask(id?: number, task?: Task) {
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
        <Workspace projectId={props.id} taskId={props.task} onTaskChange={changeTask} onHome={props.onHome} />
      </Show>
    </Show>
  </>;
}

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute(new URL(window.location.href)));
  const [query, setQuery] = createSignal('');
  const [projectTitle, setProjectTitle] = createSignal<{ id: number; name: string }>();
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
  return <>
    <Menu title={route().kind === 'project' ? (projectTitle()?.id === projectId() ? projectTitle()!.name : 'プロジェクト') : route().kind === 'settings' ? '設定' : 'Beni'} showHome={route().kind !== 'home'} query={query()} onHome={home} onQueryChange={setQuery} onSettings={() => navigate('/settings')} />
    <main class="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <Show when={route().kind === 'home'}><Home query={query()} onOpenProject={project => { setProjectTitle({id:project.id,name:project.name}); navigate(`/project/${project.id}`); }} onOpenTask={(task, project) => { setProjectTitle({id:project.id,name:project.name}); navigate(`/project/${project.id}?task=${task.id}`); }} /></Show>
      <Show when={projectId()} keyed>{id => <ProjectScreen id={id} task={projectRoute()?.task} invalidTask={projectRoute()?.invalidTask ?? false} onHome={home} onTitle={name => setProjectTitle({id,name})} onTaskChange={task => navigate(`/project/${id}${task === undefined ? '' : `?task=${task}`}`)} />}</Show>
      <Show when={route().kind === 'settings'}><section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]"><h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1><div class="mt-6 rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm"><h2 class="mb-2 text-[.95rem] font-bold">LLM 接続</h2><p class="text-sm text-base-content/60">未接続</p></div></section></Show>
      <Show when={route().kind === 'not-found'}><p role="alert">画面が見つかりません</p></Show>
    </main>
  </>;
}
