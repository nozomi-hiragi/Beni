import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { createMemo } from 'solid-js';

const markdown = new Marked({ async: false, gfm: true });

function renderMarkdown(content: string, documents: string[]): string {
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
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}

export default function MarkdownPreview(props: { content: string; documents?: string[]; onDocument?: (name: string) => void }) {
  const html = createMemo(() => renderMarkdown(props.content, props.documents ?? []));
  return <article class="markdown-preview min-h-0 min-w-0 flex-1 overflow-auto p-5 text-sm leading-relaxed" innerHTML={html()} onClick={event => {
    const link = (event.target as Element).closest('a');
    const name = link?.getAttribute('data-document');
    if (name) {
      event.preventDefault();
      props.onDocument?.(name);
    }
  }} onAuxClick={event => { if ((event.target as Element).closest('a[data-document]')) event.preventDefault(); }} />;
}
