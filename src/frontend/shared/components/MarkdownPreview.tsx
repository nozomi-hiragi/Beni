import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { createMemo, type JSX } from 'solid-js';
import type { DocumentProvenance } from '../types';
import { renderWithProvenance } from './markdown-provenance';

const markdown = new Marked({ async: false, gfm: true });

export function renderMarkdown(content: string, documents: readonly string[], variableLabels?: Record<string, string>, provenance?: DocumentProvenance) {
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

export interface MarkdownPreviewProps {
  content: string;
  documents?: string[];
  onDocument?: (name: string) => void;
  variableLabels?: Record<string, string>;
}

type ArticleEvents = Pick<JSX.HTMLAttributes<HTMLElement>, 'onMouseOver' | 'onMouseMove' | 'onMouseOut' | 'onFocusIn' | 'onFocusOut'>;

export function MarkdownArticle(props: ArticleEvents & { html: string; onDocument?: MarkdownPreviewProps['onDocument'] }) {
  return <article class="markdown-preview min-h-0 min-w-0 flex-1 overflow-auto p-5 text-sm leading-relaxed" innerHTML={props.html}
    onMouseOver={props.onMouseOver}
    onMouseMove={props.onMouseMove}
    onMouseOut={props.onMouseOut}
    onFocusIn={props.onFocusIn}
    onFocusOut={props.onFocusOut}
    onClick={event => {
      const name = (event.target as Element).closest('a')?.getAttribute('data-document');
      if (name) {
        event.preventDefault();
        props.onDocument?.(name);
      }
    }}
    onAuxClick={event => { if ((event.target as Element).closest('a[data-document]')) event.preventDefault(); }} />;
}

export default function MarkdownPreview(props: MarkdownPreviewProps) {
  const rendered = createMemo(() => renderMarkdown(props.content, props.documents ?? [], props.variableLabels));
  return <MarkdownArticle html={rendered().html} onDocument={props.onDocument} />;
}
