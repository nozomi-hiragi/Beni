import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import type { ContextUsage } from '../../../shared/agent';

export default function ContextGauge(props: { usage?: ContextUsage; loading: boolean; compactAvailable: boolean; onCompact: () => void; refreshSupported: boolean; refreshAvailable: boolean; onRefresh: () => void }) {
  const [menuOpen, setMenuOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let trigger: HTMLSpanElement | undefined, compactItem: HTMLButtonElement | undefined, refreshItem: HTMLButtonElement | undefined;
  const percent = () => props.usage && props.usage.maxTokens > 0 ? Math.round(props.usage.usedTokens / props.usage.maxTokens * 100) : undefined;
  const number = (value?: number) => value === undefined ? '不明' : new Intl.NumberFormat('ja-JP').format(value);
  const usageLabel = () => `コンテキスト: ${props.loading ? '取得中' : percent() === undefined ? '不明' : `${percent()}%`}`;
  const tokenLabel = () => `${number(props.usage?.usedTokens)} / ${number(props.usage?.maxTokens)} tokens`;
  const title = () => `${usageLabel()} · ${tokenLabel()}`;
  const close = () => setMenuOpen(false);
  onMount(() => {
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', dismiss, true);
    onCleanup(() => document.removeEventListener('pointerdown', dismiss, true));
  });
  const menuAvailable = () => props.compactAvailable || props.refreshSupported;
  const showMenu = (event: KeyboardEvent | MouseEvent) => { event.preventDefault(); if (menuAvailable()) setMenuOpen(true); };
  const choose = (action: () => void) => { close(); trigger?.focus(); action(); };
  createEffect(() => { if (menuOpen()) queueMicrotask(() => (props.compactAvailable ? compactItem : refreshItem)?.focus()); });
  createEffect(() => { if (!menuAvailable()) close(); });
  return <div ref={root} class="flex hover:z-10 focus-within:z-10 dropdown dropdown-top dropdown-end relative" classList={{ tooltip: !menuOpen(), 'tooltip-top': !menuOpen(), 'dropdown-open': menuOpen() }} onContextMenu={showMenu} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showMenu(event); if (event.key === 'Escape' && menuOpen()) { event.preventDefault(); close(); trigger?.focus(); } }}>
    <Show when={!menuOpen()}>
      <div role="tooltip" class="tooltip-content">
        <div>{usageLabel()}</div>
        <div>{tokenLabel()}</div>
      </div>
    </Show>
    <span ref={trigger} class="text-primary text-[10px] leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" classList={{ 'radial-progress': !props.loading, grid: props.loading, 'size-8': props.loading, 'place-items-center': props.loading }} role="img" tabIndex={0} aria-label={title()} aria-busy={props.loading} aria-haspopup="menu" style={{ '--value': `${Math.min(100, percent() ?? 0)}`, '--size': '2rem', '--thickness': '3px' }}>
      <Show when={props.loading} fallback={percent() === undefined ? '?' : `${percent()}%`}>
        <span class="loading loading-spinner loading-xs" aria-hidden="true" />
      </Show>
    </span>
    <Show when={menuOpen()}><ul class="dropdown-content menu menu-sm z-50 mb-2 w-40 rounded-box border border-base-300 bg-base-100 shadow-lg" role="menu">
      <li><button ref={compactItem} type="button" role="menuitem" disabled={!props.compactAvailable} onClick={() => choose(props.onCompact)}>圧縮</button></li>
      <Show when={props.refreshSupported}><li><button ref={refreshItem} type="button" role="menuitem" disabled={!props.refreshAvailable} onClick={() => choose(props.onRefresh)}>更新</button></li></Show>
    </ul></Show>
  </div>;
}
