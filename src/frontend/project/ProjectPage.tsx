import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import Workspace from './components/Workspace';
import { api } from '../shared/api';
import type { AppState, Task } from '../shared/types';

export default function ProjectPage(props: { id: string; task?: string; invalidTask: boolean; onTaskChange: (id?: string) => void; onHome: () => void; onTitle: (title: string) => void }) {
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
