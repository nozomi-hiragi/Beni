import { Show } from 'solid-js';

export interface MenuProps {
  title: string;
  showHome: boolean;
  query: string;
  onHome: () => void;
  onQueryChange: (query: string) => void;
  onSettings: () => void;
}

export default function Menu(props: MenuProps) {
  return <header class="flex min-h-16 flex-wrap items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3 sm:px-6">
    <Show when={props.showHome}>
      <button type="button" class="btn btn-ghost btn-square btn-sm text-lg" aria-label="ホームへ戻る" onClick={props.onHome}>⌂</button>
    </Show>
    <strong class="min-w-0 truncate text-lg font-semibold tracking-tight">{props.title}</strong>
    <span class="flex-1" aria-hidden="true" />
    <small class="whitespace-nowrap text-xs text-base-content/60">利用枠：未確認</small>
    <input class="input input-bordered input-sm min-w-0 w-36 max-w-xs flex-1 sm:w-56 sm:flex-none" type="search" aria-label="タスクを検索" placeholder="簡易検索（名前・ID）" value={props.query} onInput={event => props.onQueryChange(event.currentTarget.value)} />
    <button type="button" class="btn btn-ghost btn-square btn-sm text-lg" aria-label="設定" onClick={props.onSettings}>⚙</button>
  </header>;
}
