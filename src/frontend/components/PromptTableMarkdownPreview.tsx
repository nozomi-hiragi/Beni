import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { DocumentProvenance, DocumentProvenanceDetail } from '../types';
import { MarkdownArticle, renderMarkdown, type MarkdownPreviewProps } from './MarkdownPreview';
import { phaseDocuments, phaseLabels } from './PhaseIndicator';

const instructionNames: Record<string, string> = { common: '全共通', editor: '編集相談用プロンプト', ...phaseLabels };

function sourceLabel(source: DocumentProvenanceDetail['sources'][number]) {
  const name = source.id.split('/')[0]!;
  switch (source.kind) {
    case 'template': return '初期設定';
    case 'legacy': return '取り込んだ既存文書';
    case 'document': return phaseDocuments.find(item => item.name === name)?.label ?? name;
    case 'instruction': return Object.hasOwn(instructionNames, name) ? instructionNames[name] : 'インストラクション';
    case 'message':
    case 'result': {
      const label = source.kind === 'message' ? '会話' : '実行結果';
      return Object.hasOwn(phaseLabels, name) ? `${phaseLabels[name as keyof typeof phaseLabels]}の${label}` : label;
    }
  }
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
    request++;
    setAnchor(undefined);
    setDetails(undefined);
  }

  function reposition() {
    const current = anchor();
    if (!current) return;
    const width = Math.min(384, window.innerWidth - 16);
    const height = Math.min(320, window.innerHeight / 2);
    if (mousePosition) {
      const { x, y } = mousePosition;
      const gap = 16;
      const rightLimit = window.innerWidth - 8;
      const preferredLeft = x + gap + width <= rightLimit ? x + gap : x - gap - width;
      const left = Math.max(8, Math.min(preferredLeft, rightLimit - width));
      const below = window.innerHeight - y - gap - 8;
      const above = y - gap - 8;
      if (below >= height || below >= above) {
        setPosition({ left, top: y + gap, maxHeight: below });
      } else {
        setPosition({ left, bottom: window.innerHeight - y + gap, maxHeight: above });
      }
      return;
    }
    const rect = current.getBoundingClientRect();
    const right = rect.right + width <= window.innerWidth - 8;
    const left = right ? Math.max(8, rect.right) : Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    if (!right && rect.bottom + height > window.innerHeight - 8 && rect.top >= height + 8) {
      setPosition({ left, bottom: window.innerHeight - rect.top });
    } else {
      const top = Math.max(8, Math.min(right ? rect.top : rect.bottom, window.innerHeight - height - 8));
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
          class="fixed z-50 max-h-[min(20rem,50vh)] w-[min(24rem,calc(100vw-1rem))] overflow-auto rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow-lg"
          style={{
            left: `${position().left}px`,
            top: position().top === undefined ? undefined : `${position().top}px`,
            bottom: position().bottom === undefined ? undefined : `${position().bottom}px`,
            'max-height': position().maxHeight === undefined ? undefined : `min(20rem, 50vh, ${position().maxHeight}px)`,
          }}
          onFocusOut={onFocusOut}
        >
          <h2 class="font-semibold">出典と根拠</h2>
          <Show when={details()} fallback={<p role="status">読み込み中…</p>}>
            {results => <For each={results()}>{detail => <div class="mt-2 space-y-2 break-words">
              <Show when={detail} fallback={<p role="status">出典と根拠を取得できませんでした。</p>}>
                {value => <>
                  <p class="whitespace-pre-wrap">{value().reason}</p>
                  <For each={value().sources}>{source => <figure class="border-l-2 border-base-300 pl-2">
                    <figcaption class="font-medium">{sourceLabel(source)}</figcaption>
                    <blockquote class="whitespace-pre-wrap">{source.text}</blockquote>
                  </figure>}</For>
                </>}
              </Show>
            </div>}</For>}
          </Show>
        </section>
      </Portal>
    </Show>
  </>;
}
