import { For, Show } from 'solid-js';
import type { Project } from './types';

export interface TaskCreateProps {
  taskName: string;
  projectId: string;
  projects: Project[];
  creatingProject: boolean;
  canCreate: boolean;
  selectedProject?: Project;
  projectSelectRef: (element: HTMLSelectElement) => void;
  onTaskName: (value: string) => void;
  onChooseProject: (value: string) => void;
  onCreateTask: (event: SubmitEvent) => void;
  onOpenProject?: (project: Project) => void;
}

export default function TaskCreate(props: TaskCreateProps) {
  return <div class="create-card">
    <form class="create" onSubmit={props.onCreateTask}>
      <input
        class="input input-bordered task-name"
        aria-label="タスク名"
        placeholder="タスク名"
        required
        value={props.taskName}
        onInput={event => props.onTaskName(event.currentTarget.value)}
      />
      <select
        ref={props.projectSelectRef}
        class="select select-bordered project-select"
        aria-label="プロジェクト"
        value={props.projectId}
        onChange={event => props.onChooseProject(event.currentTarget.value)}
      >
        <option value="">プロジェクト</option>
        <For each={props.projects}>{project => <option value={String(project.id)}>{project.name}</option>}</For>
        <option value="new" disabled={props.creatingProject}>＋ 新規プロジェクト作成</option>
      </select>
      <Show when={props.onOpenProject}>
        <button class="btn btn-outline" type="button" disabled={!props.selectedProject} onClick={() => {
          if (props.selectedProject) props.onOpenProject?.(props.selectedProject);
        }}>プロジェクトを開く</button>
      </Show>
      <button class="btn btn-primary" type="submit" disabled={!props.canCreate}>タスク作成</button>
    </form>
  </div>;
}
