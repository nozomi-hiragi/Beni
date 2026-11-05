import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { createMemo } from 'solid-js';

const markdown = new Marked({ async: false, gfm: true });

function renderMarkdown(content: string, documents: string[], variableLabels?: Record<string, string>): string {
  const fragment = DOMPurify.sanitize(markdown.parse(content, { async: false }), {
    ALLOWED_TAGS: ['body', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'em', 'strong', 'del', 'a', 'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'hr', 'br', 'input', 'img'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'type', 'checked', 'disabled', 'alt'],
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
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

export default function MarkdownPreview(props: { content: string; documents?: string[]; onDocument?: (name: string) => void; variableLabels?: Record<string, string> }) {
  const html = createMemo(() => renderMarkdown(props.content, props.documents ?? [], props.variableLabels));
  return <article class="markdown-preview min-h-0 min-w-0 flex-1 overflow-auto p-5 text-sm leading-relaxed" innerHTML={html()} onClick={event => {
    const link = (event.target as Element).closest('a');
    const name = link?.getAttribute('data-document');
    if (name) {
      event.preventDefault();
      props.onDocument?.(name);
    }
  }} onAuxClick={event => { if ((event.target as Element).closest('a[data-document]')) event.preventDefault(); }} />;
}
