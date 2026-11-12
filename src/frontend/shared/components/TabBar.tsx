import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import { Portal } from 'solid-js/web';

export interface TabItem { id: string; label: string; closable?: boolean; renameable?: boolean; deletable?: boolean }
type ContextAction = { id: string; label: string; disabled?: boolean; run: () => void };

export interface TabBarProps {
  label: string;
  tabs: TabItem[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  panelId?: string;
  onRename?: (id: string, name: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  contextActions?: (id: string) => readonly ContextAction[] | undefined;
  onClose?: (id: string) => void;
  left?: JSX.Element;
  right?: JSX.Element;
}

// The left action stays fixed; tabs and the trailing action scroll together.
export default function TabBar(props: TabBarProps) {
  const [menu, setMenu] = createSignal<{ id: string; x: number; y: number }>();
  const [deleting, setDeleting] = createSignal<string>();
  const [editing, setEditing] = createSignal<string>();
  const [name, setName] = createSignal('');
  const [error, setError] = createSignal('');
  const [saving, setSaving] = createSignal(false);
  const buttons = new Map<string, HTMLButtonElement>();
  let menuElement: HTMLDivElement | undefined;
  let alive = true;
  const dismiss = (event: PointerEvent) => { if (!menuElement?.contains(event.target as Node)) setMenu(undefined); };
  document.addEventListener('pointerdown', dismiss);
  onCleanup(() => { alive = false; document.removeEventListener('pointerdown', dismiss); });
  const menuActions = createMemo(() => {
    const target = menu();
    return target ? props.contextActions?.(target.id) ?? [] : [];
  });
  const tabById = (id: string) => props.tabs.find(tab => tab.id === id);
  const canRename = (id: string) => !!props.onRename && tabById(id)?.renameable === true;
  const canDelete = (id: string) => !!props.onDelete && tabById(id)?.deletable === true;
  const hasMenu = (id: string) => canRename(id) || canDelete(id) || !!props.contextActions?.(id)?.length;
  const menuItems = (element: HTMLElement) => [...element.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')];
  createEffect(() => {
    const target = menu();
    if (!target) return;
    menuActions();
    const position = () => {
      const element = menuElement;
      if (!element?.isConnected || menu() !== target) return;
      element.style.left = `${Math.max(0, Math.min(target.x, window.innerWidth - element.offsetWidth))}px`;
      element.style.top = `${Math.max(0, Math.min(target.y, window.innerHeight - element.offsetHeight))}px`;
    };
    queueMicrotask(() => {
      position();
      const element = menuElement;
      if (!element?.isConnected || menu() !== target) return;
      const items = menuItems(element);
      if (!items.some(item => item === document.activeElement)) (items[0] ?? element).focus();
    });
    window.addEventListener('resize', position);
    onCleanup(() => window.removeEventListener('resize', position));
  });
  function openMenu(id: string, x: number, y: number) {
    if (saving()) return;
    setEditing(undefined); setError('');
    setMenu({ id, x, y });
  }
  function closeMenu(id: string) {
    setMenu(undefined);
    buttons.get(id)?.focus();
  }
  function menuKeyDown(event: KeyboardEvent, id: string) {
    if (event.key === 'Escape') { event.preventDefault(); closeMenu(id); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = menuItems(event.currentTarget as HTMLElement);
    if (!items.length) return;
    const index = items.findIndex(item => item === document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (Math.max(0, index) - 1 + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  }
  function cancel(id: string) { setEditing(undefined); setError(''); buttons.get(id)?.focus(); }
  async function save(id: string) {
    if (saving()) return;
    if (name().trim() === props.tabs.find(tab => tab.id === id)?.label) { cancel(id); return; }
    if (!name().trim()) { setError('タスク名を入力してください'); return; }
    setSaving(true); setError('');
    try { await props.onRename?.(id, name().trim()); if (alive) cancel(id); }
    catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : 'タスク名を保存できませんでした'); }
    finally { if (alive) setSaving(false); }
  }
  function editKeyDown(event: KeyboardEvent, id: string) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && !saving()) { event.preventDefault(); cancel(id); }
    if (event.key === 'Enter') { event.preventDefault(); void save(id); }
  }
  function beginRename(id: string) {
    setName(props.tabs.find(tab => tab.id === id)?.label ?? '');
    setError(''); setEditing(id); setMenu(undefined);
  }
  function selectWithKey(event: KeyboardEvent, index: number) {
    if (!props.panelId) return;
    const count = props.tabs.length;
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % count;
    else if (event.key === 'ArrowLeft') next = (index + count - 1) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    else return;
    const tab = props.tabs[next];
    if (!tab) return;
    event.preventDefault();
    props.onSelect(tab.id);
    buttons.get(tab.id)?.focus();
  }
  return <div class="flex min-h-12 min-w-0">
    <Show when={props.left}><div class="flex shrink-0 items-center">{props.left}</div></Show>
    <div class="flex min-w-0 flex-1 overflow-x-auto">
      <div class="tabs tabs-border shrink-0 flex-nowrap" role="tablist" aria-label={props.label}>
        <For each={props.tabs.map(tab => tab.id)}>{(id, index) => {
          const tab = () => tabById(id);
          const handleContextMenu = (event: MouseEvent) => {
            if (editing() === id || saving() || !hasMenu(id)) return;
            event.preventDefault(); openMenu(id, event.clientX, event.clientY);
          };
          return <>
            <Show when={editing() !== id} fallback={
              <div class="flex shrink-0 flex-col self-center px-2 py-1">
                <input ref={element => queueMicrotask(() => { if (element.isConnected) { element.focus(); element.select(); } })} class="input input-bordered input-sm" aria-label="タスク名" aria-invalid={!!error()} value={name()} readOnly={saving()} onInput={event => { setName(event.currentTarget.value); setError(''); }} onBlur={() => { if (!saving()) { setEditing(undefined); setError(''); } }} onKeyDown={event => editKeyDown(event, id)} />
                <Show when={error()}><p role="alert" class="text-sm text-error">{error()}</p></Show>
              </div>
            }>
              <button
                ref={element => buttons.set(id, element)}
                type="button"
                role="tab"
                class="tab h-auto shrink-0 flex-nowrap px-4 py-3 text-sm"
                classList={{ 'tab-active font-semibold': props.activeId === id }}
                id={props.panelId ? `${props.panelId}-${id}` : undefined}
                aria-controls={props.panelId}
                aria-selected={props.activeId === id}
                tabIndex={props.panelId ? (props.activeId === id ? 0 : -1) : undefined}
                aria-haspopup={hasMenu(id) ? 'menu' : undefined}
                onContextMenu={handleContextMenu}
                onKeyDown={event => {
                  if (!saving() && hasMenu(id) && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
                    event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(id, rect.left, rect.bottom);
                  }
                  selectWithKey(event, index());
                }}
                onClick={() => props.onSelect(id)}>{tab()?.label}</button>
            </Show>
            <Show when={props.onClose && tab()?.closable !== false}><button type="button" class="btn btn-ghost btn-xs btn-square ms-1 self-center" aria-label={`${tab()?.label} を閉じる`} onContextMenu={handleContextMenu} onClick={() => props.onClose?.(id)}><span aria-hidden="true">×</span></button></Show>
          </>;
        }}</For>
      </div>
      <Show when={props.right}><div class="flex shrink-0 items-center">{props.right}</div></Show>
    </div>
    <Show when={menu()}>{value => <Portal><div ref={menuElement} role="menu" tabIndex={-1} aria-label={`${tabById(value().id)?.label} の操作`} class="fixed z-50 max-h-[100vh] w-max min-w-[min(8rem,100vw)] max-w-[100vw] overflow-auto rounded-box border border-base-300 bg-base-100 p-1 shadow-lg" onFocusOut={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setMenu(undefined);
    }} onKeyDown={event => menuKeyDown(event, value().id)}>
      <For each={menuActions().map(action => action.id)}>{actionId => {
        const action = () => menuActions().find(item => item.id === actionId);
        return <button type="button" role="menuitem" class="btn btn-ghost btn-sm h-auto min-h-8 w-full justify-start whitespace-normal text-left" disabled={action()?.disabled} onClick={() => {
          const current = action();
          if (!current || current.disabled) return;
          closeMenu(value().id);
          current.run();
        }}>{action()?.label}</button>;
      }}</For>
      <Show when={canRename(value().id)}><button type="button" role="menuitem" class="btn btn-ghost btn-sm w-full justify-start" onClick={() => beginRename(value().id)}>リネーム</button></Show>
      <Show when={canDelete(value().id)}><button type="button" role="menuitem" class="btn btn-ghost btn-sm w-full justify-start text-error" onClick={() => { setDeleting(value().id); setError(''); setMenu(undefined); }}>削除</button></Show>
    </div></Portal>}</Show>
    <Show when={deleting()}>{id => <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onKeyDown={event => {
      if (event.key === 'Escape' && !saving()) { event.preventDefault(); const target = id(); setDeleting(undefined); buttons.get(target)?.focus(); }
      if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'); const first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }}><div role="alertdialog" aria-modal="true" aria-labelledby="delete-task-title" aria-describedby="delete-task-impact" class="rounded-box bg-base-100 p-6 shadow-xl">
        <h2 id="delete-task-title">「{props.tabs.find(tab => tab.id === id())?.label}」を削除しますか？</h2>
        <p id="delete-task-impact">タスクの文書とチャット履歴も削除されます。この操作は取り消せません。</p>
        <Show when={error()}><p role="alert" class="text-error">{error()}</p></Show>
        <div class="mt-4 flex justify-end gap-2"><button ref={element => queueMicrotask(() => { if (element.isConnected) element.focus(); })} type="button" class="btn" disabled={saving()} onClick={() => { const target = id(); setDeleting(undefined); buttons.get(target)?.focus(); }}>キャンセル</button>
          <button type="button" class="btn btn-error" disabled={saving()} onClick={async () => {
            if (saving()) return; setSaving(true); setError('');
            try { await props.onDelete?.(id()); if (alive) { setDeleting(undefined); buttons.get(props.activeId ?? '')?.focus(); } }
            catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : 'タスクを削除できませんでした'); }
            finally { if (alive) setSaving(false); }
          }}>OK</button></div>
      </div></div>}</Show>
  </div>;
}
