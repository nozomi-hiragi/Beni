import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import Home from './Home';
import Menu from './Menu';
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
      <Show when={view().kind === 'settings'}><section class="settings-surface mx-auto max-w-6xl"><h1>設定</h1><div class="settings-card"><h2>LLM 接続</h2><p>未接続</p></div></section></Show>
    </main>
  </>;
}
const root = document.getElementById('app');
if (!root) throw new Error('Application root missing');
render(() => <App />, root);
