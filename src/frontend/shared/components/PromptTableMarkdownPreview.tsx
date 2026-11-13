import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { DocumentProvenance, DocumentProvenanceDetail } from '../types';
import { MarkdownArticle, renderMarkdown, type MarkdownPreviewProps } from './MarkdownPreview';
import { phaseDocuments, phaseLabels } from '../phase-display';
import { instructionLabels } from '../instruction-display';
import { INSTRUCTIONS_CHAT_ID } from '../../../shared/communication';

function sourceLabel(source: DocumentProvenanceDetail['sources'][number]) {
  const name = source.id.split('/')[0]!;
  switch (source.kind) {
    case 'template': return '初期設定';
    case 'legacy': return '取り込んだ既存文書';
    case 'document': {
      if (name === 'knowledge.md') return 'プロジェクトナレッジ';
      const document = phaseDocuments.find(item => item.name === name);
      return document ? `${document.label}ドキュメント` : /^[a-z][a-z0-9-]*\.md$/.test(name) ? name : 'ドキュメント';
    }
    case 'instruction': return Object.hasOwn(instructionLabels, name) ? instructionLabels[name] : '種類不明のプロンプト';
    case 'message':
    case 'result': {
      if (source.kind === 'message' && name === INSTRUCTIONS_CHAT_ID) return '編集相談チャット';
      const label = source.kind === 'message' ? 'チャット' : '実行結果';
      return Object.hasOwn(phaseLabels, name) ? `${phaseLabels[name as keyof typeof phaseLabels]}の${label}` : label;
    }
  }
}

function sourceContext(source: DocumentProvenanceDetail['sources'][number]) {
  if (source.kind === 'instruction') return 'インストラクション';
  if (source.kind === 'message' && source.id.startsWith(INSTRUCTIONS_CHAT_ID + '/')) return undefined;
  const project = source.projectName ? `プロジェクト「${source.projectName}」` : undefined;
  const task = source.taskName ? `タスク「${source.taskName}」` : undefined;
  if (project && task) return `${project} / ${task}`;
  if (project || task) return project ?? task;
  if (source.kind === 'document' && source.id.split('/')[0] === 'knowledge.md') return undefined;
  return '所属不明';
}

export default function PromptTableMarkdownPreview(props: MarkdownPreviewProps & {
  provenance: DocumentProvenance;
  loadProvenance: (id: string) => Promise<DocumentProvenanceDetail>;
}) {
  const rendered = createMemo(() => renderMarkdown(props.content, props.documents ?? [], props.variableLabels, props.provenance));
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [position, setPosition] = createSignal<{ left: number; top?: number; bottom?: number; maxHeight?: number }>({ left: 0 });
  const [details, setDetails] = createSignal<(DocumentProvenanceDetail | null)[]>();
  let popup: HTMLElement | undefined;
  let mousePosition: { x: number; y: number } | undefined;
  let request = 0;

  function close() {
    mousePosition = undefined;
    popup = undefined;
    request++;
    setAnchor(undefined);
    setDetails(undefined);
  }

  function reposition() {
    const current = anchor();
    if (!current) return;
    const margin = 12;
    const width = Math.max(0, Math.min(640, window.innerWidth - 2 * margin));
    const maxHeight = Math.max(0, Math.min(720, window.innerHeight - 2 * margin));
    const contentHeight = popup ? popup.scrollHeight + popup.offsetHeight - popup.clientHeight : maxHeight;
    const height = Math.min(maxHeight, contentHeight || maxHeight);
    const rightLimit = window.innerWidth - margin;
    const bottomLimit = window.innerHeight - margin;
    if (mousePosition) {
      const { x, y } = mousePosition;
      const gap = 16;
      const fitsRight = x + gap + width <= rightLimit;
      const fitsLeft = x - gap - width >= margin;
      const preferredLeft = fitsRight ? x + gap : x - gap - width;
      const left = Math.max(margin, Math.min(preferredLeft, rightLimit - width));
      if (fitsRight || fitsLeft) {
        const top = Math.max(margin, Math.min(y + gap, bottomLimit - height));
        setPosition({ left, top });
        return;
      }
      const below = bottomLimit - y - gap;
      const above = y - gap - margin;
      if (below >= height || below >= above) {
        setPosition({ left, top: y + gap, maxHeight: Math.max(0, Math.min(maxHeight, below)) });
      } else {
        setPosition({ left, bottom: window.innerHeight - y + gap, maxHeight: Math.max(0, Math.min(maxHeight, above)) });
      }
      return;
    }
    const rect = current.getBoundingClientRect();
    const right = rect.right + width <= rightLimit;
    const left = Math.max(margin, right ? rect.right : Math.min(rect.left, rightLimit - width));
    if (!right && rect.bottom + height > bottomLimit && rect.top >= height + margin) {
      setPosition({ left, bottom: window.innerHeight - rect.top });
    } else {
      const top = Math.max(margin, Math.min(right ? rect.top : rect.bottom, bottomLimit - height));
      setPosition({ left, top });
    }
  }

  function onScroll(event: Event) {
    if (!(event.target instanceof Node) || !popup?.contains(event.target)) close();
  }

  function block(target: EventTarget | null) {
    // A list item without provenance must never inherit another item's marker.
    const element = target instanceof Element ? target.closest<HTMLElement>('li, [data-provenance]') : null;
    return element?.hasAttribute('data-provenance') ? element : undefined;
  }

  function open(element: HTMLElement | undefined) {
    if (!element) { close(); return; }
    if (anchor() === element) {
      reposition();
      return;
    }
    const ids = rendered().itemIds[Number(element.getAttribute('data-provenance'))];
    const load = props.loadProvenance;
    if (!ids) return;
    const current = ++request;
    setDetails(undefined);
    setAnchor(element);
    reposition();
    void Promise.all(ids.map(async id => {
      try { return await load(id); }
      catch { return null; }
    })).then(results => { if (current === request) setDetails(results); });
  }

  function onFocusOut(event: FocusEvent) {
    const current = anchor();
    const next = event.relatedTarget;
    if (!current || mousePosition || block(next) === current || (next instanceof Node && popup?.contains(next))) return;
    close();
  }

  function onKeyDown(event: KeyboardEvent) {
    const current = anchor();
    if (!current) return;
    if (event.key === 'Escape') {
      if (popup?.contains(document.activeElement)) current.focus();
      close();
    } else if (event.key === 'ArrowDown' && block(event.target) === current) {
      event.preventDefault();
      mousePosition = undefined;
      popup?.focus();
    }
  }

  createEffect(() => {
    rendered();
    close();
  });
  createEffect(() => {
    if (anchor()) {
      details();
      queueMicrotask(reposition);
    }
  });
  onMount(() => {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', onScroll, true);
  });
  onCleanup(() => {
    close();
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', onScroll, true);
  });

  return <>
    <MarkdownArticle html={rendered().html} onDocument={props.onDocument}
      onMouseOver={event => {
        const target = block(event.target);
        if (!target) return;
        mousePosition = { x: event.clientX, y: event.clientY };
        open(target);
      }}
      onMouseMove={event => {
        const current = anchor();
        if (current && block(event.target) === current) {
          mousePosition = { x: event.clientX, y: event.clientY };
          reposition();
        }
      }}
      onMouseOut={event => {
        if (mousePosition && block(event.relatedTarget) !== anchor()) close();
      }}
      onFocusIn={event => {
        const target = block(event.target);
        if (mousePosition && target === anchor()) return;
        mousePosition = undefined;
        open(target);
      }}
      onFocusOut={onFocusOut} />
    <Show when={anchor()}>
      <Portal>
        <section ref={element => { popup = element; }} aria-label="出典と根拠" tabindex="-1"
          class="card card-border card-sm fixed! z-50 max-h-[min(720px,calc(100dvh-24px))] w-[min(640px,calc(100vw-24px))] overflow-auto border-base-300 bg-base-100 shadow-lg"
          style={{
            left: `${position().left}px`,
            top: position().top === undefined ? undefined : `${position().top}px`,
            bottom: position().bottom === undefined ? undefined : `${position().bottom}px`,
            'max-height': position().maxHeight === undefined ? undefined : `${position().maxHeight}px`,
          }}
          onFocusOut={onFocusOut}
        >
          <div class="card-body shrink-0">
            <h2 class="card-title">出典と根拠</h2>
            <Show when={details()} fallback={<p role="status">読み込み中…</p>}>
              {results => <For each={results()}>{detail => <div class="space-y-2 wrap-break-word">
                <Show when={detail} fallback={<p role="status">出典と根拠を取得できませんでした。</p>}>
                  {value => <>
                    <p class="whitespace-pre-wrap">{value().reason}</p>
                    <Show when={value().sources.length}>
                      <ul class="list">
                        <For each={value().sources}>{source => <li class="list-row">
                          <div class="list-col-grow min-w-0">
                            <div class="font-medium">{sourceLabel(source)}</div>
                            <Show when={sourceContext(source)}>{context => <div class="text-xs text-base-content/70">{context()}</div>}</Show>
                            <blockquote class="whitespace-pre-wrap">{source.text}</blockquote>
                          </div>
                        </li>}</For>
                      </ul>
                    </Show>
                  </>}
                </Show>
              </div>}</For>}
            </Show>
          </div>
        </section>
      </Portal>
    </Show>
  </>;
}
