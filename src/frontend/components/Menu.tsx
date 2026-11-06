import { Show } from 'solid-js';
import HomeIcon from './icons/HomeIcon';
import DocumentIcon from './icons/DocumentIcon';
import SettingsIcon from './icons/SettingsIcon';

export interface MenuProps {
  title: string;
  showHome: boolean;
  query: string;
  onHome: () => void;
  onQueryChange: (query: string) => void;
  onInstructions: () => void;
  onSettings: () => void;
}

export default function Menu(props: MenuProps) {
  return <header class="navbar w-auto mx-2 mt-2 rounded-box border border-base-300 bg-base-100 shadow-sm min-h-10 flex-wrap items-center gap-3 px-4 py-2">
    <Show when={props.showHome}>
      <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="ホームへ戻る" onClick={props.onHome}>
        <HomeIcon />
      </button>
    </Show>
    <strong class="min-w-0 truncate text-lg font-semibold tracking-tight">{props.title}</strong>
    <span class="flex-1" aria-hidden="true" />
    <small class="whitespace-nowrap text-xs text-base-content/60">利用枠：未確認</small>
    <input class="input input-bordered input-sm min-w-0 w-36 max-w-xs flex-1 sm:w-56 sm:flex-none" type="search" aria-label="タスクを検索" placeholder="簡易検索（名前・ID）" value={props.query} onInput={event => props.onQueryChange(event.currentTarget.value)} />
    <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="インストラクション管理" title="インストラクション管理" onClick={props.onInstructions}>
      <DocumentIcon />
    </button>
    <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="設定" onClick={props.onSettings}>
      <SettingsIcon />
    </button>
  </header>;
}
