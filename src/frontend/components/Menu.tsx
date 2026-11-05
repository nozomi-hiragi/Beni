import { Show } from 'solid-js';
import type { JSX } from 'solid-js';

function MenuIcon(props: { children: JSX.Element }) {
  return <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{props.children}</svg>;
}

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
  return <header class="flex min-h-16 flex-wrap items-center gap-3 border-b border-base-300 bg-base-100 px-4 py-3 sm:px-6">
    <Show when={props.showHome}>
      <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="ホームへ戻る" onClick={props.onHome}>
        <MenuIcon><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9v11h13V9" /><path d="M9.5 20v-6.5h5V20" /></MenuIcon>
      </button>
    </Show>
    <strong class="min-w-0 truncate text-lg font-semibold tracking-tight">{props.title}</strong>
    <span class="flex-1" aria-hidden="true" />
    <small class="whitespace-nowrap text-xs text-base-content/60">利用枠：未確認</small>
    <input class="input input-bordered input-sm min-w-0 w-36 max-w-xs flex-1 sm:w-56 sm:flex-none" type="search" aria-label="タスクを検索" placeholder="簡易検索（名前・ID）" value={props.query} onInput={event => props.onQueryChange(event.currentTarget.value)} />
    <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="インストラクション管理" title="インストラクション管理" onClick={props.onInstructions}>
      <MenuIcon><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></MenuIcon>
    </button>
    <button type="button" class="btn btn-ghost btn-square btn-sm" aria-label="設定" onClick={props.onSettings}>
      <MenuIcon><circle cx="12" cy="12" r="3" /><path d="M10.2 2h3.6l.55 2.04c.44.13.86.31 1.26.52l1.83-1.05 2.55 2.55-1.05 1.83c.21.4.39.82.52 1.26l2.04.55v3.6l-2.04.55c-.13.44-.31.86-.52 1.26l1.05 1.83-2.55 2.55-1.83-1.05c-.4.21-.82.39-1.26.52L13.8 22h-3.6l-.55-2.04c-.44-.13-.86-.31-1.26-.52l-1.83 1.05-2.55-2.55 1.05-1.83a7.7 7.7 0 0 1-.52-1.26L2 13.8v-3.6l2.04-.55c.13-.44.31-.86.52-1.26L3.51 6.56l2.55-2.55 1.83 1.05c.4-.21.82-.39 1.26-.52L10.2 2Z" /></MenuIcon>
    </button>
  </header>;
}
