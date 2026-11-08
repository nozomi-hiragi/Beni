// @vitest-environment jsdom
import { cleanup, render } from '@solidjs/testing-library';
import { afterEach, expect, it } from 'vitest';
import CodePreview from './CodePreview';

afterEach(cleanup);

it.each([
  ['src/example.TSX', 'const view = <div>Example</div>;', '.hljs-keyword'],
  ['data/example.json', '{ "example": 123 }', '.hljs-number'],
  ['docker/Dockerfile', 'FROM scratch', '.hljs-keyword'],
])('%s をファイル名に対応する構文で表示する', (path, content, token) => {
  const { container } = render(() => <CodePreview path={path} content={content} />);
  expect(container.querySelector('pre code')?.textContent).toBe(content);
  expect(container.querySelector(token)).not.toBeNull();
});

it('HTMLをソースとして表示する', () => {
  const content = '<img src=x onerror="throw 1"><script>throw 2</script>';
  const { container } = render(() => <CodePreview path="example.html" content={content} />);
  expect(container.querySelector('pre code')?.textContent).toBe(content);
  expect(container.querySelector('.hljs-tag')).not.toBeNull();
  expect(container.querySelector('img, script, [onerror]')).toBeNull();
});

it.each([
  ['unknown.txt', '<strong>原文</strong>'],
  ['long.ts', 'const value = 1;\n'.repeat(4096)],
  ['wide.ts', 'const value = "' + 'a'.repeat(4097) + '";'],
])('%s を原文のまま表示する', (path, content) => {
  const { container } = render(() => <CodePreview path={path} content={content} />);
  expect(container.querySelector('pre code')?.textContent).toBe(content);
  expect(container.querySelector('code *')).toBeNull();
});

it.each([
  ['src/example.ts', '/* コメント\r\n続き */\r\n\r\nconst x = 1;\r\n', '1\n2\n3\n4'],
  ['plain.txt', '最初\n\n最後', '1\n2\n3'],
  ['empty.txt', '', '1'],
])('%s のコード本文を保って表示行に番号を付ける', (path, content, numbers) => {
  const { container } = render(() => <CodePreview path={path} content={content} />);
  const gutter = container.querySelector('pre > [aria-hidden="true"]');
  expect(gutter?.textContent).toBe(numbers);
  expect(gutter?.classList.contains('select-none')).toBe(true);
  const code = container.querySelector('pre > code');
  expect(code?.textContent).toBe(content);
  if (path.endsWith('.ts')) {
    expect(code?.querySelector('.hljs-comment')?.textContent).toBe('/* コメント\r\n続き */');
  }
});
