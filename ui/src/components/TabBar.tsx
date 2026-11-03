import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';

export interface TabItem { id: string; label: string }

export interface TabBarProps {
  label: string;
  tabs: TabItem[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  left?: JSX.Element;
  right?: JSX.Element;
}

// The left action stays fixed; tabs and the trailing action scroll together.
export default function TabBar(props: TabBarProps) {
  return <div class="flex min-h-12 min-w-0 border-b border-base-300">
    <Show when={props.left}><div class="shrink-0">{props.left}</div></Show>
    <div class="flex min-w-0 flex-1 overflow-x-auto">
      <div class="flex shrink-0" role="tablist" aria-label={props.label}>
        <For each={props.tabs}>{tab => <span class="flex shrink-0 items-center border-b-2 border-r border-r-base-300" classList={{ 'border-b-primary font-semibold': props.activeId === tab.id, 'border-b-transparent text-base-content/60': props.activeId !== tab.id }}>
          <button type="button" role="tab" class="px-4 py-3 text-sm" aria-selected={props.activeId === tab.id} onClick={() => props.onSelect(tab.id)}>{tab.label}</button>
          <Show when={props.onClose}>{onClose => <button type="button" class="px-2 py-3 text-sm" aria-label={`${tab.label} を閉じる`} onClick={() => onClose()(tab.id)}>×</button>}</Show>
        </span>}</For>
      </div>
      <Show when={props.right}><div class="shrink-0">{props.right}</div></Show>
    </div>
  </div>;
}
