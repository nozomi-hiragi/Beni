import { For, Show } from 'solid-js';
import type { Project } from '../../shared/types';

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
  return <div class="card card-border border-base-300 bg-base-100 shadow-sm p-[1.1rem]">
    <form class="flex items-center gap-3 max-[900px]:flex-wrap max-[540px]:[&>*]:w-full" onSubmit={props.onCreateTask}>
      <input
        class="input input-bordered min-w-0 flex-[1_1_18rem] max-[900px]:basis-full"
        aria-label="タスク名"
        placeholder="タスク名"
        required
        value={props.taskName}
        onInput={event => props.onTaskName(event.currentTarget.value)}
      />
      <select
        ref={props.projectSelectRef}
        class="select select-bordered min-w-40 flex-[0_1_14rem] max-[540px]:basis-full"
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
