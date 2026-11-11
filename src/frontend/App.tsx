import { validProjectId, validTaskId } from '../shared/ids';
import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import HomePage from './home/HomePage';
import Navbar from './shared/components/Navbar';
import SettingsPage from './settings/SettingsPage';
import InstructionsPage from './instructions/InstructionsPage';
import ProjectPage from './project/ProjectPage';
import DataPage from './data/DataPage';
import type { ManualToolScope } from '../shared/manual-tools';

type Route = { kind: 'home' } | { kind: 'settings' } | { kind: 'instructions' } | { kind: 'data' } | { kind: 'project'; id: string; task?: string; invalidTask: boolean } | { kind: 'not-found' };
export function parseRoute(url: URL): Route {
  if (url.pathname === '/') return { kind: 'home' };
  if (url.pathname === '/settings') return { kind: 'settings' };
  if (url.pathname === '/instructions') return { kind: 'instructions' };
  if (url.pathname === '/data') return { kind: 'data' };
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
  const [dataPageKey, setDataPageKey] = createSignal(1);
  const projectId = createMemo(() => { const current = route(); return current.kind === 'project' ? current.id : undefined; });
  const toolScope = createMemo<ManualToolScope | undefined>(() => {
    const current = route();
    if (current.kind === 'instructions') return { kind: 'instructions' };
    if (current.kind === 'project' && !current.invalidTask) return { kind: 'project', projectId: current.id, taskId: current.task };
  });
  const projectRoute = () => { const current = route(); return current.kind === 'project' ? current : undefined; };
  const navigate = (path: string) => {
    if (path === `${window.location.pathname}${window.location.search}`) return;
    window.history.pushState(null, '', path);
    setRoute(parseRoute(new URL(window.location.href)));
  };
  const home = () => navigate('/');
  const openData = () => {
    const reset = route().kind === 'data' && window.location.search !== '';
    navigate('/data');
    if (reset) setDataPageKey(key => key + 1);
  };
  onMount(() => {
    const pop = () => setRoute(parseRoute(new URL(window.location.href)));
    window.addEventListener('popstate', pop);
    onCleanup(() => window.removeEventListener('popstate', pop));
  });
  const title = () => {
    switch (route().kind) {
      case 'project': return projectTitle()?.id === projectId() ? projectTitle()!.name : 'プロジェクト';
      case 'settings': return '設定';
      case 'instructions': return 'インストラクション管理';
      case 'data': return 'データ';
      default: return 'Beni';
    }
  };
  return <div classList={{ 'flow-root': route().kind !== 'data', 'instructions-shell': route().kind === 'instructions', 'project-shell': route().kind === 'project', 'flex h-dvh flex-col overflow-hidden [&>header]:shrink-0': route().kind === 'data' }}>
    <Navbar title={title()} toolScope={toolScope()} toolsPage={route().kind} toolsUnavailable={projectRoute()?.invalidTask ? 'このプロジェクトのタスクが見つかりません' : undefined} showHome={route().kind !== 'home'} onHome={home} onData={openData} onInstructions={() => navigate('/instructions')} onSettings={() => navigate('/settings')} />
    <main class="mx-auto w-full px-2 py-2" classList={{ 'min-h-0 flex-1': route().kind === 'data' }}>
      <Show when={route().kind === 'home'}><HomePage onOpenProject={project => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}`); }} onOpenTask={(task, project) => { setProjectTitle({ id: project.id, name: project.name }); navigate(`/project/${project.id}?task=${task.id}`); }} /></Show>
      <Show when={projectId()} keyed>{id => <ProjectPage id={id} task={projectRoute()?.task} invalidTask={projectRoute()?.invalidTask ?? false} onHome={home} onTitle={name => setProjectTitle({ id, name })} onTaskChange={task => navigate(`/project/${id}${task === undefined ? '' : `?task=${task}`}`)} />}</Show>
      <Show when={route().kind === 'settings'}><SettingsPage /></Show>
      <Show when={route().kind === 'instructions'}><InstructionsPage /></Show>
      <Show when={route().kind === 'data' && dataPageKey()} keyed><DataPage /></Show>
      <Show when={route().kind === 'not-found'}><p role="alert">画面が見つかりません</p></Show>
    </main>
  </div>;
}
