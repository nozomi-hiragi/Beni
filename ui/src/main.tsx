import { createSignal, Show } from 'solid-js';
import { render } from 'solid-js/web';
import Home from './Home';
import Workspace from './Workspace';
import type { Project, Task } from './types';

type View = { kind: 'home' } | { kind: 'task'; task: Task; project: Project } | { kind: 'settings' };
function App() {
  const [view, setView] = createSignal<View>({ kind: 'home' });
  const [query, setQuery] = createSignal('');
  const home = () => setView({ kind: 'home' });
  const currentTask = () => { const current = view(); return current.kind === 'task' ? current : undefined; };
  return <>
    <header class="flex min-h-16 flex-wrap items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3 sm:px-6">
      <button type="button" class="btn btn-ghost btn-square btn-sm text-lg" aria-label="ホームへ戻る" onClick={home}>⌂</button>
      <strong class="min-w-0 truncate text-lg font-semibold tracking-tight">{view().kind === 'task' ? (view() as Extract<View,{kind:'task'}>).project.name : 'Beni'}</strong>
      <span class="flex-1" aria-hidden="true" />
      <small class="whitespace-nowrap text-xs text-base-content/60">利用枠：未確認</small>
      <input class="input input-bordered input-sm min-w-0 w-36 max-w-xs flex-1 sm:w-56 sm:flex-none" type="search" aria-label="タスクを検索" placeholder="簡易検索（名前・ID）" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
      <button type="button" class="btn btn-ghost btn-square btn-sm text-lg" aria-label="設定" onClick={() => setView({ kind: 'settings' })}>⚙</button>
    </header>
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
