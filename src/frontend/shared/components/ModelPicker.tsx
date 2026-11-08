import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js';
import { modelLabel, modelValue, providerName, providerReady } from '../model-cache';
import type { Model } from '../types';
import { popupHeight } from './chat-popup';
import AgentIcon from './icons/AgentIcon';

type ModelOption = { model: Model; value: string; disabled: boolean; warning: boolean };

function optionLabel(option: ModelOption) {
  return `${option.warning ? '⚠️ ' : ''}${modelLabel(option.model.name, option.model.provider)}`;
}

function ModelName(props: { model: Model; warning?: boolean }) {
  const provider = () => props.model.provider ?? 'codex';
  return <>
    <Show when={props.warning}><span class="shrink-0" aria-hidden="true">⚠️</span></Show>
    <AgentIcon provider={provider()} class="size-4 shrink-0" />
    <span class="min-w-0">
      <Show when={provider() !== 'codex' && provider() !== 'claude'}>{providerName(provider())}/</Show>
      {props.model.name}
    </span>
  </>;
}

export default function ModelPicker(props: {
  models: readonly Model[];
  selection: Model | undefined;
  available: boolean;
  busy: boolean;
  anchor: () => HTMLElement;
  onSelect: (value: string) => void;
}) {
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal('');
  const [height, setHeight] = createSignal(320);
  let root!: HTMLDivElement;
  let list: HTMLUListElement | undefined;
  let search = '';
  let lastKeyTime = 0;
  const selectedValue = () => props.selection ? modelValue(props.selection) : '';
  const warning = () => !!props.selection && !props.available;
  const options = createMemo<ModelOption[]>(() => {
    const options = props.models.map(model => ({ model, value: modelValue(model), disabled: !providerReady(model.provider), warning: false }));
    if (!warning()) return options;
    const value = selectedValue();
    return [{ model: props.selection!, value, disabled: true, warning: true }, ...options.filter(option => option.value !== value)];
  });
  const current = () => options().find(option => option.value === selectedValue());
  const enabled = createMemo(() => options().filter(option => !option.disabled));
  const disabled = () => props.busy || !props.models.length;
  const optionId = (value: string) => `${listId}-${options().findIndex(option => option.value === value)}`;
  const active = () => enabled().find(option => option.value === highlighted()) ?? enabled()[0];

  function close() {
    setOpen(false);
    search = '';
  }
  function show(fromEnd = false) {
    const choices = enabled();
    setHighlighted((choices.find(option => option.value === selectedValue()) ?? choices.at(fromEnd ? -1 : 0))?.value ?? '');
    setOpen(true);
  }
  function select(value: string) {
    if (disabled() || !enabled().some(option => option.value === value)) return;
    close();
    props.onSelect(value);
  }
  function keyDown(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape' && open()) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (event.repeat) return;
      if (!open()) show();
      else if (active()) select(active()!.value);
      return;
    }
    const choices = enabled();
    const index = choices.indexOf(active()!);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const backwards = event.key === 'ArrowUp';
      if (!open()) show(backwards);
      else setHighlighted(choices[Math.max(0, Math.min(index + (backwards ? -1 : 1), choices.length - 1))]?.value ?? '');
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setHighlighted(choices.at(event.key === 'End' ? -1 : 0)?.value ?? '');
      setOpen(true);
      return;
    }
    if (event.key.length !== 1 || !choices.length) return;
    event.preventDefault();
    const letter = event.key.toLocaleLowerCase();
    const now = Date.now();
    search = now - lastKeyTime > 500 || search === letter ? letter : search + letter;
    lastKeyTime = now;
    const start = open() ? index + (search.length === 1 ? 1 : 0) : 0;
    const match = [...choices.slice(start), ...choices.slice(0, start)].find(option =>
      option.model.name.toLocaleLowerCase().startsWith(search) || optionLabel(option).toLocaleLowerCase().startsWith(search));
    if (match) {
      setHighlighted(match.value);
      setOpen(true);
    }
  }

  createEffect(() => { if (disabled()) close(); });
  createEffect(() => {
    if (!open()) return;
    const anchor = props.anchor();
    const size = () => setHeight(popupHeight(anchor, 320));
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) close();
    };
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(size) : undefined;
    if (observer) {
      for (let element: HTMLElement | null = anchor; element; element = element.parentElement) observer.observe(element);
    }
    size();
    window.addEventListener('resize', size);
    document.addEventListener('pointerdown', dismiss, true);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener('resize', size);
      document.removeEventListener('pointerdown', dismiss, true);
    });
  });
  createEffect(() => {
    const option = open() && active();
    if (!option) return;
    const id = optionId(option.value);
    queueMicrotask(() => {
      const item = document.getElementById(id);
      if (!list || !item) return;
      const bounds = list.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    });
  });

  return <div ref={root} class="max-w-full min-w-0">
    <button type="button" role="combobox" aria-label="モデル" aria-expanded={open()}
      aria-controls={open() ? listId : undefined} aria-activedescendant={open() && active() ? optionId(active()!.value) : undefined}
      value={selectedValue()} title={current() ? optionLabel(current()!) : '未確認'} disabled={disabled()}
      class="select select-bordered select-sm w-auto max-w-full gap-1.5 whitespace-nowrap [&>span:last-child]:truncate"
      onKeyDown={keyDown} onBlur={close}
      onClick={event => { event.currentTarget.focus(); if (open()) close(); else show(); }}>
      <Show when={current()} fallback={<span>未確認</span>}>{option => <ModelName model={option().model} warning={option().warning} />}</Show>
    </button>
    <Show when={open()}>
      <ul ref={list} id={listId} role="listbox" aria-label="モデル" style={{ 'max-height': `${height()}px` }}
        class="absolute right-0 bottom-full z-50 mb-2 w-80 max-w-full overflow-y-auto overscroll-contain rounded-box border border-base-300 bg-base-100 p-1 shadow-lg">
        <For each={options()}>{(option, index) => <li role="none">
          <button id={`${listId}-${index()}`} type="button" role="option" tabindex={-1} value={option.value}
            aria-label={optionLabel(option)} aria-selected={option.value === selectedValue()} aria-disabled={option.disabled}
            class="flex w-full items-center gap-1.5 rounded px-3 py-2 text-left text-sm wrap-anywhere"
            classList={{ 'bg-base-200': active()?.value === option.value, 'hover:bg-base-200': !option.disabled, 'opacity-50': option.disabled }}
            onMouseDown={event => event.preventDefault()} onClick={() => select(option.value)}>
            <ModelName model={option.model} warning={option.warning} />
            <Show when={option.value === selectedValue()}><span aria-hidden="true" class="ml-auto shrink-0">✓</span></Show>
          </button>
        </li>}</For>
      </ul>
    </Show>
  </div>;
}
