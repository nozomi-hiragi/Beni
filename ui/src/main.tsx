import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import Home from './Home';
import Menu from './components/Menu';
import Workspace from './Workspace';
import type { Project, Task } from './types';

type View = { kind: 'home' } | { kind: 'task'; task: Task; project: Project } | { kind: 'settings' };
function App() {
  const [view, setView] = createSignal<View>({ kind: 'home' });
  const [query, setQuery] = createSignal('');
  const home = () => setView({ kind: 'home' });
  const currentTask = () => { const current = view(); return current.kind === 'task' ? current : undefined; };
  return <>
    <Menu
      title={view().kind === 'task' ? (view() as Extract<View,{kind:'task'}>).project.name : view().kind === 'settings' ? '設定' : 'Beni'}
      showHome={view().kind !== 'home'}
      query={query()}
      onHome={home}
      onQueryChange={setQuery}
      onSettings={() => setView({ kind: 'settings' })}
    />
    <main class="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6">
      <Show when={view().kind === 'home'}><Home query={query()} onOpenTask={(task, project) => setView({ kind: 'task', task, project })} /></Show>
      <Show when={currentTask()} keyed>{current => <Workspace taskId={current.task.id} onHome={home} />}</Show>
      <Show when={view().kind === 'settings'}><section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]"><h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1><div class="mt-6 rounded-2xl border border-base-300 bg-base-100 p-6 shadow-sm"><h2 class="mb-2 text-[.95rem] font-bold">LLM 接続</h2><p class="text-sm text-base-content/60">未接続</p></div></section></Show>
    </main>
  </>;
}
const root = document.getElementById('app');
if (!root) throw new Error('Application root missing');
render(() => <App />, root);
