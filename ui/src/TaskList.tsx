import { For, Show } from 'solid-js';
import type { Task } from './types';

export type SortKey = 'id' | 'name' | 'phase' | 'status';
const columns: { key: SortKey; label: string }[] = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'タスク名' },
  { key: 'phase', label: 'フェーズ' },
  { key: 'status', label: '状態' },
];

export interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  sortKey: SortKey;
  sortDirection: 1 | -1;
  onSort: (key: SortKey) => void;
  onOpenTask: (task: Task) => void;
}

export default function TaskList(props: TaskListProps) {
  return <div class="task-list">
    <div class="task-list-heading"><h2>タスク一覧</h2><span class="task-count">{props.tasks.length} 件</span></div>
    <div class="table-scroll">
      <table class="table">
        <thead><tr><For each={columns}>{column =>
          <th aria-sort={props.sortKey === column.key ? (props.sortDirection === 1 ? 'ascending' : 'descending') : 'none'}>
            <button type="button" class="sort-control" onClick={() => props.onSort(column.key)}>
              {column.label}<span aria-hidden="true"> ↕</span>
            </button>
          </th>
        }</For></tr></thead>
        <tbody><For each={props.tasks}>{task =>
          <tr data-id={task.id} tabIndex={0} onClick={() => props.onOpenTask(task)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onOpenTask(task); }
          }}>
            <td class="task-id">#{task.id}</td><td class="task-title">{task.name}</td><td>{task.phase}</td><td><span class="status-chip">{task.status}</span></td>
          </tr>
        }</For></tbody>
      </table>
      <Show when={props.loading}><p class="empty-state">読み込み中</p></Show>
      <Show when={!props.loading && !props.tasks.length}><p class="empty-state">表示するタスクはありません</p></Show>
    </div>
  </div>;
}
