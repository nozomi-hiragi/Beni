// @vitest-environment beni-jsdom
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MarkdownPreview from './MarkdownPreview';
import PromptTableMarkdownPreview from './PromptTableMarkdownPreview';

afterEach(cleanup);

describe('Markdown document preview', () => {
  it('leaves template tokens unchanged unless variable labels are supplied', () => {
    const { container } = render(() => <MarkdownPreview content="{{project_directory}}" />);
    expect(container.textContent).toBe('{{project_directory}}\n');
    expect(container.querySelector('.badge')).toBeNull();
  });

  it('decorates known text tokens safely without changing link attributes or unknown tokens', () => {
    const label = '<img src=x onerror=alert(1)>';
    const { container } = render(() => <MarkdownPreview
      content={'{{project_directory}} {{unknown}} {{constructor}} `{{project_directory}}` [{{project_directory}}](https://example.com/{{project_directory}} "{{project_directory}}")'}
      variableLabels={{project_directory: label}}
    />);
    const badges = container.querySelectorAll('.badge');
    expect(badges).toHaveLength(3);
    expect(Array.from(badges, badge => badge.textContent)).toEqual([label, label, label]);
    expect(container.querySelector('img, [onerror]')).toBeNull();
    expect(container.textContent).toContain('{{unknown}} {{constructor}}');
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/%7B%7Bproject_directory%7D%7D');
    expect(link.getAttribute('title')).toBe('{{project_directory}}');
  });

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

describe('Markdown preview provenance', () => {
  it('keeps individual list items, original offsets, and the surrounding Markdown layout', async () => {
    const content = '# 📝 文書\r\n\r\n- 一つ目\r\n  - 子項目\r\n- 二つ目\r\n- 根拠なし\r\n\r\n| 列 |\r\n| --- |\r\n| 値 |';
    const range = (id: string, text: string) => {
      const start = content.indexOf(text);
      return { id, start, end: start + text.length };
    };
    const load = vi.fn(async (id: string) => ({
      reason: `根拠 ${id}`,
      sources: [
        { kind: 'document' as const, id: 'requirements.md/item-id', text: '<img src=x onerror=alert(1)>', projectName: '架空プロジェクト', taskName: 'サンプル' },
        { kind: 'instruction' as const, id: 'common/instruction-id', text: '全体に適用する指示' },
        { kind: 'document' as const, id: 'knowledge.md/knowledge-id', text: '再利用する知識' },
      ],
    }));
    const { container } = render(() => <PromptTableMarkdownPreview content={content}
      provenance={{ revision: 'v1', items: [range('first', '- 一つ目'), range('nested', '- 子項目'), range('second', '- 二つ目'), range('table', '| 値 |')] }}
      loadProvenance={load}
    />);
    const items = screen.getAllByRole('listitem');
    expect(items.map(item => item.getAttribute('tabindex'))).toEqual(['0', '0', '0', null]);
    expect(container.querySelectorAll('article > ul')).toHaveLength(1);
    fireEvent.mouseOver(items[0]!);
    expect(await screen.findByText('根拠 first')).toBeTruthy();
    const popup = screen.getByRole('region', { name: '出典と根拠' });
    expect(container.contains(popup)).toBe(false);
    const [source, instruction, knowledge] = within(within(popup).getByRole('list')).getAllByRole('listitem');
    expect(source.textContent).toContain('要件定義ドキュメント');
    expect(source.textContent).toContain('プロジェクト「架空プロジェクト」 / タスク「サンプル」');
    expect(source.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(instruction.textContent).toContain('全共通');
    expect(instruction.textContent).toContain('インストラクション');
    expect(knowledge.textContent).toContain('プロジェクトナレッジ');
    expect(popup.textContent).not.toMatch(/requirements\.md|common\/instruction-id|knowledge-id/);
    expect(popup.querySelector('img')).toBeNull();
    fireEvent.mouseOver(items[1]!);
    expect(await screen.findByText('根拠 nested')).toBeTruthy();
    fireEvent.focusIn(items[2]!);
    expect(await screen.findByText('根拠 second')).toBeTruthy();
    fireEvent.focusIn(screen.getByRole('table'));
    expect(await screen.findByText('根拠 table')).toBeTruthy();
    expect(load.mock.calls).toEqual([['first'], ['nested'], ['second'], ['table']]);
  });

  it('keeps indentation and blank lines from assigning a neighboring item to a list entry', async () => {
    const texts = ['- 親\n', '  - 子\n', '  - 次の子\n', '- 次', '\n\n- 最後\n'];
    let offset = 0;
    const items = texts.map((text, index) => {
      const start = offset;
      offset += text.length;
      return { id: String(index), start, end: offset };
    });
    const load = vi.fn(async (id: string) => ({ reason: `根拠 ${id}`, sources: [] }));
    render(() => <PromptTableMarkdownPreview content={texts.join('')} provenance={{ revision: 'v1', items }} loadProvenance={load} />);
    for (const [index, item] of screen.getAllByRole('listitem').entries()) {
      fireEvent.mouseOver(item);
      expect(await screen.findByText(`根拠 ${index}`)).toBeTruthy();
    }
    expect(load.mock.calls).toEqual(items.map(item => [item.id]));
  });

  it('groups several item ranges in one paragraph and ignores a stale response after switching', async () => {
    const content = '関連する二つの項目。\n\n# 次の項目';
    let finishOld!: (detail: { reason: string; sources: [] }) => void;
    const load = vi.fn((id: string) => id === 'slow'
      ? new Promise<{ reason: string; sources: [] }>(resolve => { finishOld = resolve; })
      : Promise.resolve({ reason: id, sources: [] }));
    const { container } = render(() => <PromptTableMarkdownPreview content={content} provenance={{ revision: 'v1', items: [
      { id: 'slow', start: 0, end: 5 },
      { id: 'also grouped', start: 5, end: content.indexOf('\n') },
      { id: 'new item', start: content.indexOf('#'), end: content.length },
    ] }} loadProvenance={load} />);
    fireEvent.mouseOver(container.querySelector('article p')!);
    expect(load.mock.calls).toEqual([['slow'], ['also grouped']]);
    fireEvent.focusIn(screen.getByRole('heading', { name: '次の項目' }));
    expect(await screen.findByText('new item')).toBeTruthy();
    finishOld({ reason: 'stale item', sources: [] });
    await Promise.resolve();
    expect(screen.queryByText('stale item')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: '出典と根拠' })).toBeNull();
  });

  it('follows the hovered block and closes on leaving it or scrolling the preview', async () => {
    const content = '根拠付き';
    const load = vi.fn(async () => ({ reason: '根拠', sources: [
      { kind: 'message' as const, id: 'requirements/chat/message', text: '発言原文' },
    ] }));
    render(() => <PromptTableMarkdownPreview content={content}
      provenance={{ revision: 'v1', items: [{ id: 'item', start: 0, end: content.length }] }}
      loadProvenance={load}
    />);
    const trigger = screen.getByText(content);
    fireEvent.mouseOver(trigger, { clientX: 60, clientY: 60 });
    expect(await screen.findByText('要件定義のチャット')).toBeTruthy();
    expect(screen.getByText('所属不明')).toBeTruthy();
    expect(screen.queryByText('requirements/chat/message')).toBeNull();
    const popup = screen.getByRole('region', { name: '出典と根拠' });
    expect(popup.style.left).toBe('76px');
    fireEvent.mouseMove(trigger, { clientX: 90, clientY: 90 });
    expect(popup.style.left).toBe('106px');
    fireEvent.mouseMove(trigger, { clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 });
    expect(parseFloat(popup.style.left) + 640).toBe(window.innerWidth - 17);
    expect(parseFloat(popup.style.top) + Math.min(720, window.innerHeight - 24)).toBe(window.innerHeight - 12);
    expect(popup.style.maxHeight).toBe('');
    expect(load).toHaveBeenCalledExactlyOnceWith('item');
    fireEvent.focusIn(trigger);
    fireEvent.mouseOut(trigger, { relatedTarget: popup });
    expect(screen.queryByRole('region', { name: '出典と根拠' })).toBeNull();
    fireEvent.mouseOver(popup, { relatedTarget: trigger });
    expect(screen.queryByText('発言原文')).toBeNull();
    fireEvent.mouseOver(trigger);
    expect(await screen.findByText('発言原文')).toBeTruthy();
    fireEvent.scroll(screen.getByRole('article'));
    expect(screen.queryByRole('region', { name: '出典と根拠' })).toBeNull();
  });

  it('keeps Markdown HTML from assigning provenance to another block', async () => {
    const content = '<p data-beni-source-0="0" data-provenance="0" tabindex="0">偽装</p>\n\n本物';
    const load = vi.fn(async () => ({ reason: '本物の根拠', sources: [] }));
    render(() => <PromptTableMarkdownPreview content={content} provenance={{ revision: 'v1', items: [
      { id: 'actual', start: content.indexOf('本物'), end: content.length },
    ] }} loadProvenance={load} />);
    const spoof = screen.getByText('偽装');
    expect(spoof.hasAttribute('tabindex')).toBe(false);
    fireEvent.mouseOver(spoof);
    expect(load).not.toHaveBeenCalled();
    fireEvent.mouseOver(screen.getByText('本物'));
    expect(await screen.findByText('本物の根拠')).toBeTruthy();
    expect(load).toHaveBeenCalledExactlyOnceWith('actual');
  });
});
