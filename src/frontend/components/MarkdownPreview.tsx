import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { DocumentProvenance, DocumentProvenanceDetail } from '../types';
import { renderWithProvenance } from './markdown-provenance';
import { phaseDocuments, phaseLabels } from './PhaseIndicator';

const markdown = new Marked({ async: false, gfm: true });

function renderMarkdown(content: string, documents: string[], variableLabels?: Record<string, string>, provenance?: DocumentProvenance) {
  const annotated = provenance?.items.length ? renderWithProvenance(markdown, content, provenance) : undefined;
  const fragment = DOMPurify.sanitize(annotated?.html ?? markdown.parse(content, { async: false }), {
    ALLOWED_TAGS: ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'em', 'strong', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'hr', 'br', 'input', 'img'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'type', 'checked', 'disabled', 'alt'],
    ADD_ATTR: annotated ? [annotated.attribute] : [],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  // Documents cannot navigate the application or request image resources.
  for (const image of fragment.querySelectorAll('img')) image.replaceWith(document.createTextNode(image.getAttribute('alt') ?? ''));
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else if (!documents.includes(href.replace(/^\.\//, '')) || !/^(?:\.\/)?[a-z][a-z0-9-]*\.md$/.test(href)) link.removeAttribute('href');
    else { link.setAttribute('data-document', href.replace(/^\.\//, '')); link.setAttribute('href', '#'); }
  }
  for (const input of fragment.querySelectorAll('input')) {
    if (input.getAttribute('type') !== 'checkbox') { input.remove(); continue; }
    input.setAttribute('disabled', '');
  }
  if (variableLabels) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    for (const node of nodes) {
      const text = node.data;
      const replacement = document.createDocumentFragment();
      let offset = 0;
      for (const match of text.matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
        if (!Object.hasOwn(variableLabels, match[1]!)) continue;
        replacement.append(document.createTextNode(text.slice(offset, match.index)));
        const badge = document.createElement('span');
        badge.className = 'badge badge-soft badge-primary h-auto max-w-full whitespace-normal align-baseline text-xs';
        badge.textContent = variableLabels[match[1]!]!;
        replacement.append(badge);
        offset = match.index + match[0].length;
      }
      if (offset) {
        replacement.append(document.createTextNode(text.slice(offset)));
        node.replaceWith(replacement);
      }
    }
  }
  if (annotated) {
    for (const element of fragment.querySelectorAll(`[${annotated.attribute}]`)) {
      const marker = element.getAttribute(annotated.attribute)!;
      element.removeAttribute(annotated.attribute);
      element.setAttribute('data-provenance', marker);
      element.setAttribute('tabindex', '0');
      element.classList.add('hover:bg-base-200', 'focus:bg-base-200', 'focus-visible:outline-primary');
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return { html: container.innerHTML, itemIds: annotated?.itemIds ?? [] };
}

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

export default function MarkdownPreview(props: {
  content: string;
  documents?: string[];
  onDocument?: (name: string) => void;
  variableLabels?: Record<string, string>;
  provenance?: DocumentProvenance;
  loadProvenance?: (id: string) => Promise<DocumentProvenanceDetail>;
}) {
  const rendered = createMemo(() => renderMarkdown(props.content, props.documents ?? [], props.variableLabels,
    props.loadProvenance ? props.provenance : undefined));
  const [anchor, setAnchor] = createSignal<HTMLElement>();
  const [position, setPosition] = createSignal<{ left: number; top?: number; bottom?: number }>({ left: 0 });
  const [details, setDetails] = createSignal<(DocumentProvenanceDetail | null)[]>();
  let popup: HTMLElement | undefined;
  let pointer: Node | null = null;
  let request = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    clearTimeout(closeTimer);
    request++;
    setAnchor(undefined);
    setDetails(undefined);
  }

  function reposition() {
    const current = anchor();
    if (!current) return;
    const rect = current.getBoundingClientRect();
    const width = Math.min(384, window.innerWidth - 16);
    const height = Math.min(320, window.innerHeight / 2);
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
    clearTimeout(closeTimer);
    if (!element) { close(); return; }
    if (anchor() === element) return;
    const ids = rendered().itemIds[Number(element.getAttribute('data-provenance'))];
    const load = props.loadProvenance;
    if (!ids || !load) return;
    const current = ++request;
    setDetails(undefined);
    setAnchor(element);
    reposition();
    void Promise.all(ids.map(async id => {
      try { return await load(id); }
      catch { return null; }
    })).then(results => { if (current === request) setDetails(results); });
  }

  function leave(relatedTarget: EventTarget | null) {
    const current = anchor();
    const next = relatedTarget instanceof Node ? relatedTarget : null;
    if (!current || (next && (block(next) === current || popup?.contains(next)))) return;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      const focused = document.activeElement;
      if (block(focused) === current || (focused && popup?.contains(focused))) return;
      if (block(pointer) === current || (pointer && popup?.contains(pointer))) return;
      close();
    }, 120);
  }

  function onKeyDown(event: KeyboardEvent) {
    const current = anchor();
    if (!current) return;
    if (event.key === 'Escape') {
      if (popup?.contains(document.activeElement)) current.focus();
      close();
    } else if (event.key === 'ArrowDown' && block(event.target) === current) {
      event.preventDefault();
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
    <article class="markdown-preview min-h-0 min-w-0 flex-1 overflow-auto p-5 text-sm leading-relaxed" innerHTML={rendered().html}
      onMouseOver={event => {
        pointer = event.target as Node;
        const target = block(event.target);
        if (target) open(target);
        else leave(null);
      }}
      onMouseOut={event => {
        pointer = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        leave(event.relatedTarget);
      }}
      onFocusIn={event => open(block(event.target))}
      onFocusOut={event => leave(event.relatedTarget)}
      onClick={event => {
        const link = (event.target as Element).closest('a');
        const name = link?.getAttribute('data-document');
        if (name) {
          event.preventDefault();
          props.onDocument?.(name);
        }
      }} onAuxClick={event => { if ((event.target as Element).closest('a[data-document]')) event.preventDefault(); }} />
    <Show when={anchor()}>
      <Portal>
        <section ref={element => { popup = element; }} aria-label="出典と根拠" tabindex="-1"
          class="fixed z-50 max-h-[min(20rem,50vh)] w-[min(24rem,calc(100vw-1rem))] overflow-auto rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow-lg"
          style={{
            left: `${position().left}px`,
            top: position().top === undefined ? undefined : `${position().top}px`,
            bottom: position().bottom === undefined ? undefined : `${position().bottom}px`,
          }}
          onMouseOver={event => { pointer = event.target as Node; clearTimeout(closeTimer); }}
          onMouseOut={event => {
            pointer = event.relatedTarget instanceof Node ? event.relatedTarget : null;
            leave(event.relatedTarget);
          }}
          onFocusIn={() => clearTimeout(closeTimer)}
          onFocusOut={event => leave(event.relatedTarget)}
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
