import { For, Show } from 'solid-js';
import type { Task } from '../types';

export type SortKey = 'id' | 'name' | 'phase' | 'status' | 'createdAt' | 'updatedAt';
const columns: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'タスク名' },
  { key: 'phase', label: 'フェーズ' },
  { key: 'status', label: '状態' },
  { key: 'createdAt', label: '作成日' },
  { key: 'updatedAt', label: '更新日' },
];

export interface TaskListProps {
  tasks: Task[];
  loading: boolean;
  sortKey: SortKey;
  sortDirection: 1 | -1;
  onSort: (key: SortKey) => void;
  onOpenTask: (task: Task) => void;
}

const dateFormatter = new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function TaskDate(props: { value?: string | null }) {
  return <>{props.value ? <time dateTime={props.value}>{dateFormatter.format(new Date(props.value))}</time> : '—'}</>;
}

export default function TaskList(props: TaskListProps) {
  return <div class="card card-border border-base-300 bg-base-100 shadow-sm mt-6 overflow-hidden">
    <div class="flex items-center gap-2.5 border-b border-base-300 px-[1.4rem] py-[1.2rem]"><h2 class="text-[.95rem] font-bold">タスク一覧</h2><span class="text-xs text-base-content/55">{props.tasks.length} 件</span></div>
    <div class="overflow-x-auto">
      <table class="table w-full [&_th]:px-[1.4rem] [&_th]:py-[.95rem] [&_td]:px-[1.4rem] [&_td]:py-[.95rem] max-[540px]:[&_th]:p-[.8rem] max-[540px]:[&_td]:p-[.8rem] max-[540px]:[&_th]:whitespace-nowrap max-[540px]:[&_td]:whitespace-nowrap">
        <thead class="text-[.72rem] text-base-content/55"><tr><For each={columns}>{column =>
          <th aria-sort={props.sortKey === column.key ? (props.sortDirection === 1 ? 'ascending' : 'descending') : 'none'}>
            <button type="button" class="cursor-pointer font-semibold" onClick={() => props.onSort(column.key)}>
              {column.label}<span class="text-base-content/40" aria-hidden="true"> ↕</span>
            </button>
          </th>
        }</For></tr></thead>
        <tbody><For each={props.tasks}>{task =>
          <tr class="cursor-pointer hover:bg-base-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary" data-id={task.id} tabIndex={0} onClick={() => props.onOpenTask(task)} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); props.onOpenTask(task); }
          }}>
            <td class="font-semibold">{task.name}</td><td>{task.phase}</td><td><span class="inline-flex max-w-full rounded-full border border-base-300 bg-base-200 px-2.5 py-1 text-xs text-base-content/70">{task.status}</span></td><td><TaskDate value={task.createdAt} /></td><td><TaskDate value={task.updatedAt} /></td>
          </tr>
        }</For></tbody>
      </table>
      <Show when={props.loading}><p class="px-4 py-14 text-center text-sm text-base-content/55">読み込み中</p></Show>
      <Show when={!props.loading && !props.tasks.length}><p class="px-4 py-14 text-center text-sm text-base-content/55">表示するタスクはありません</p></Show>
    </div>
  </div>;
}
