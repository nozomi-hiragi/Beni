import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import makefile from 'highlight.js/lib/languages/makefile';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { createMemo, Show } from 'solid-js';

for (const [name, grammar] of Object.entries({
  bash, css, diff, dockerfile, go, ini, javascript, json, makefile, python, rust, sql, typescript, xml, yaml,
})) hljs.registerLanguage(name, grammar);

const names = new Map([
  ['dockerfile', 'dockerfile'], ['containerfile', 'dockerfile'], ['makefile', 'makefile'],
  ['.bashrc', 'bash'], ['.zshrc', 'bash'],
]);
const extensions = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'],
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['html', 'xml'], ['htm', 'xml'], ['xml', 'xml'], ['svg', 'xml'],
  ['css', 'css'], ['json', 'json'], ['jsonc', 'json'], ['yaml', 'yaml'], ['yml', 'yaml'],
  ['ini', 'ini'], ['toml', 'ini'], ['sh', 'bash'], ['bash', 'bash'], ['zsh', 'bash'],
  ['py', 'python'], ['go', 'go'], ['rs', 'rust'], ['sql', 'sql'],
  ['diff', 'diff'], ['patch', 'diff'],
]);

// 構文解析の入力を制限し、長い行を含む生成物はそのまま表示する。
const maxHighlightLength = 64 * 1024;
const longLine = /[^\r\n]{4097}/;

function lineNumbers(content: string) {
  // 末尾の改行は直前の行の終端として扱う。
  let line = 1;
  let numbers = '1';
  for (let index = 0; index < content.length - 1; index++) {
    if (content[index] === '\n' || (content[index] === '\r' && content[index + 1] !== '\n')) {
      numbers += `\n${++line}`;
    }
  }
  return numbers;
}

export default function CodePreview(props: { path: string; content: string }) {
  const numbers = createMemo(() => lineNumbers(props.content));
  const highlighted = createMemo(() => {
    const file = props.path.slice(props.path.lastIndexOf('/') + 1).toLowerCase();
    const extension = file.lastIndexOf('.');
    const language = names.get(file) ?? (extension < 0 ? undefined : extensions.get(file.slice(extension + 1)));
    const content = props.content;
    if (!language || content.length > maxHighlightLength || longLine.test(content)) return undefined;
    // HTML の解析で CR が正規化されないよう、サニタイズと表示の両方で文字参照を使う。
    const html = hljs.highlight(content, { language, ignoreIllegals: true }).value.replaceAll('\r', '&#13;');
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['span'],
      ALLOWED_ATTR: ['class'],
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
    }).replaceAll('\r', '&#13;');
  });

  return <pre class="flex min-h-0 min-w-0 flex-1 items-start gap-4 overflow-auto whitespace-pre p-5 font-mono text-sm leading-6">
    <span aria-hidden="true" class="sticky left-0 shrink-0 bg-base-100 pr-2 text-right text-base-content/60 select-none">{numbers()}</span>
    <Show when={highlighted()} fallback={<code class="shrink-0">{props.content}</code>}>
      {html => <code class="hljs shrink-0" innerHTML={html()} />}
    </Show>
  </pre>;
}
