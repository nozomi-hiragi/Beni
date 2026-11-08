import { validProjectId, validTaskId } from '../shared/ids';
import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import HomePage from './home/HomePage';
import Navbar from './shared/components/Navbar';
import SettingsPage from './settings/SettingsPage';
import InstructionsPage from './instructions/InstructionsPage';
import ProjectPage from './project/ProjectPage';

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

export default function App() {
  const [route, setRoute] = createSignal<Route>(parseRoute(new URL(window.location.href)));
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
    <Navbar title={route().kind === 'project' ? (projectTitle()?.id === projectId() ? projectTitle()!.name : 'プロジェクト') : route().kind === 'settings' ? '設定' : route().kind === 'instructions' ? 'インストラクション管理' : 'Beni'} showHome={route().kind !== 'home'} onHome={home} onInstructions={() => navigate('/instructions')} onSettings={() => navigate('/settings')} />
    <main class="mx-auto w-full px-2 py-2">
      <Show when={route().kind === 'home'}><HomePage onOpenProject={project => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}`); }} onOpenTask={(task, project) => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}?task=${task.id}`); }} /></Show>
      <Show when={projectId()} keyed>{id => <ProjectPage id={id} task={projectRoute()?.task} invalidTask={projectRoute()?.invalidTask ?? false} onHome={home} onTitle={name => setProjectTitle({ id, name })} onTaskChange={task => navigate(`/project/${id}${task === undefined ? '' : `?task=${task}`}`)} />}</Show>
      <Show when={route().kind === 'settings'}><SettingsPage /></Show>
      <Show when={route().kind === 'instructions'}><InstructionsPage /></Show>
      <Show when={route().kind === 'not-found'}><p role="alert">画面が見つかりません</p></Show>
    </main>
  </div>;
}
