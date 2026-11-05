// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownPreview from './MarkdownPreview';

afterEach(cleanup);

describe('Markdown document preview', () => {
  it('renders GFM content and updates within the same scroll container', () => {
    const [content, setContent] = createSignal(`# Document

A **strong** and *emphasized* paragraph with ~~removed~~ text.

- First item
  - Nested item
- [x] Finished
- [ ] Pending

1. Ordered item

> Quoted text

| Name | Value |
| --- | --- |
| Sample | 42 |

\`\`\`ts
const value = '<safe>';
\`\`\`

---

[Reference](https://example.com/docs)`);
    const { container } = render(() => <MarkdownPreview content={content()} />);
    const preview = screen.getByRole('article');
    expect(screen.getByRole('heading', { name: 'Document', level: 1 })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('strong');
    expect(container.querySelector('em')?.textContent).toBe('emphasized');
    expect(container.querySelector('del')?.textContent).toBe('removed');
    expect(container.querySelector('ul ul li')?.textContent).toBe('Nested item');
    expect(container.querySelector('ol li')?.textContent).toBe('Ordered item');
    expect(container.querySelector('blockquote')?.textContent).toContain('Quoted text');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('cell', { name: '42' })).toBeTruthy();
    expect(container.querySelector('pre code')?.textContent).toBe("const value = '<safe>';\n");
    expect(container.querySelector('hr')).toBeTruthy();
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.map(input => [input.checked, input.disabled])).toEqual([[true, true], [false, true]]);
    const link = screen.getByRole('link', { name: 'Reference' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    preview.scrollTop = 18;
    setContent('## Revised\n\nNew document content.');
    expect(screen.getByRole('article')).toBe(preview);
    expect(preview.scrollTop).toBe(18);
    expect(screen.getByRole('heading', { name: 'Revised', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Document' })).toBeNull();
  });

  it('removes active HTML, unsafe navigation and image requests', () => {
    const { container } = render(() => <MarkdownPreview content={`# Safe heading

<script>alert('script')</script>
<iframe src="https://example.com/embed"></iframe>
<form action="https://example.com/submit"><button>Send</button><input type="text" value="secret"></form>
<style>body { display: none }</style>
<svg onload="alert('svg')"><a href="javascript:alert(1)">SVG</a></svg>
<p onclick="alert('click')" style="position:fixed" id="clobber" data-private="value">Visible text</p>
<a href="javascript:alert(1)" target="_self">Unsafe HTML link</a>
<a href="java&#x0a;script:alert(1)">Obfuscated link</a>
<input type="checkbox" onclick="alert('input')">

[Unsafe Markdown](javascript:alert(1))
[Data link](data:text/html,test)
[Relative](../requirements.md)
[Fragment](#safe-heading)
[Protocol relative](//example.com/docs)
[HTTP](http://example.com/docs)

![Diagram](https://example.com/image.png)
<img src="https://example.com/raw.png" srcset="https://example.com/other.png 2x" onerror="alert('image')" alt="Raw diagram">`} />);
    expect(screen.getByRole('heading', { name: 'Safe heading' })).toBeTruthy();
    expect(screen.getByText('Visible text')).toBeTruthy();
    expect(container.querySelector('script, iframe, form, button, style, svg, img, input[type="text"]')).toBeNull();
    expect(container.querySelector('[onclick], [onload], [onerror], [style], [id], [data-private], [src], [srcset]')).toBeNull();
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('http://example.com/docs');
    for (const label of ['Unsafe HTML link', 'Obfuscated link', 'Unsafe Markdown', 'Data link', 'Relative', 'Fragment', 'Protocol relative']) {
      expect(screen.getByText(label).closest('a')?.hasAttribute('href')).toBe(false);
    }
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(container.textContent).toContain('Diagram');
    expect(container.textContent).toContain('Raw diagram');
  });

  it('opens only known task Markdown links without navigating the browser', () => {
    const onDocument = vi.fn();
    render(() => <MarkdownPreview content="[Spec](./api.md) [Outside](../api.md) [Unknown](unknown.md)" documents={['api.md']} onDocument={onDocument} />);
    fireEvent.click(screen.getByRole('link', {name: 'Spec'}));
    expect(onDocument).toHaveBeenCalledWith('api.md');
    expect(screen.getByText('Outside').closest('a')?.hasAttribute('href')).toBe(false);
    expect(screen.getByText('Unknown').closest('a')?.hasAttribute('href')).toBe(false);
  });

  it('keeps wide code and tables inside the preview scroll boundary', () => {
    const longValue = 'value'.repeat(2000);
    const { container } = render(() => <MarkdownPreview content={`\`\`\`\n${longValue}\n\`\`\`\n\n| Column |\n| --- |\n| ${longValue} |`} />);
    const preview = screen.getByRole('article');
    expect(preview.classList.contains('min-w-0')).toBe(true);
    expect(preview.classList.contains('overflow-auto')).toBe(true);
    expect(container.querySelector('pre code')?.textContent).toBe(`${longValue}\n`);
    expect(screen.getByRole('cell').textContent).toBe(longValue);
  });
});
