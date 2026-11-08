import { Renderer, type Marked, type Token, type Tokens } from 'marked';
import type { DocumentProvenance } from '../types';

type Source = { text: string; offset: (index: number) => number };

export function renderWithProvenance(markdown: Marked, content: string, provenance: DocumentProvenance) {
  // Marked normalizes line endings before lexing. Keep offsets in the original UTF-16 text.
  const carriageReturns: number[] = [];
  const text = content.replace(/\r\n?/g, (lineEnding: string, index: number) => {
    if (lineEnding.length === 2) carriageReturns.push(index - carriageReturns.length);
    return '\n';
  });
  const source: Source = {
    text,
    offset(index) {
      let lo = 0;
      let hi = carriageReturns.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (carriageReturns[mid]! < index) lo = mid + 1;
        else hi = mid;
      }
      return index + lo;
    },
  };
  const tokens = markdown.lexer(text);
  const markers = new Map<Token, number>();
  const itemIds: string[][] = [];
  // Only the renderer can add this attribute. The sanitized fragment converts it to an app-owned marker.
  const usedAttributes = new Set(content.toLowerCase().match(/data-beni-source-\d+/g));
  let suffix = 0;
  while (usedAttributes.has(`data-beni-source-${suffix}`)) suffix++;
  const attribute = `data-beni-source-${suffix}`;

  const mark = (token: Token, parent: Source, start: number, end: number, excluded: [number, number][] = []) => {
    let from = parent.offset(start);
    const to = parent.offset(end);
    const ranges: [number, number][] = [];
    for (const [left, right] of excluded) {
      if (left > from) ranges.push([from, left]);
      from = right;
    }
    if (from < to) ranges.push([from, to]);
    const ids = provenance.items.filter(item => ranges.some(([left, right]) => {
      const overlapStart = Math.max(left, item.start);
      const overlapEnd = Math.min(right, item.end);
      return overlapStart < overlapEnd && content.slice(overlapStart, overlapEnd).trim().length > 0;
    })).map(item => item.id);
    if (ids.length) markers.set(token, itemIds.push([...new Set(ids)]) - 1);
  };

  function locate(blocks: Token[], parent: Source, inListItem = false, task = false): [number, number][] {
    let cursor = 0;
    const nestedRanges: [number, number][] = [];
    for (const [index, token] of blocks.entries()) {
      // The renderer reinserts the checkbox in loose tasks, though item.text
      // remains stripped. Reject other mismatches instead of matching later text.
      const raw = index === 0 && task && !parent.text.startsWith(token.raw)
        ? token.raw.replace(/^\[[ xX]\] /, '') : token.raw;
      const start = parent.text.indexOf(raw, cursor);
      if (start < 0 || parent.text.slice(cursor, start).trim()) break;
      const end = start + raw.length;
      cursor = end;
      if (token.type === 'list') {
        const list = token as Tokens.List;
        let itemStart = start;
        for (const item of list.items) {
          const itemEnd = itemStart + item.raw.length;
          const itemSource = deindent(parent, itemStart, item.raw, item.text);
          const nested = itemSource ? locate(item.tokens, itemSource, true, item.task) : [];
          mark(item, parent, itemStart, itemEnd, nested);
          itemStart = itemEnd;
        }
        nestedRanges.push([parent.offset(start), parent.offset(end)]);
      } else if (token.type === 'blockquote') {
        const quote = token as Tokens.Blockquote;
        const quoteSource = deindent(parent, start, quote.raw, quote.text);
        const nested = quoteSource ? locate(quote.tokens, quoteSource, true) : [];
        if (inListItem) nestedRanges.push(...nested);
        else mark(token, parent, start, end, nested);
      } else if (!inListItem && token.type !== 'space' && token.type !== 'def' && token.type !== 'html') {
        mark(token, parent, start, end);
      }
    }
    return nestedRanges;
  }
  locate(tokens, source);

  function annotate(token: Token, html: string) {
    const marker = markers.get(token);
    return marker === undefined ? html : html.replace(/^<\w+/, tag => `${tag} ${attribute}="${marker}"`);
  }
  class ProvenanceRenderer extends Renderer {
    override heading(token: Tokens.Heading) { return annotate(token, super.heading(token)); }
    override paragraph(token: Tokens.Paragraph) { return annotate(token, super.paragraph(token)); }
    override listitem(token: Tokens.ListItem) { return annotate(token, super.listitem(token)); }
    override blockquote(token: Tokens.Blockquote) { return annotate(token, super.blockquote(token)); }
    override table(token: Tokens.Table) { return annotate(token, super.table(token)); }
    override code(token: Tokens.Code) { return annotate(token, super.code(token)); }
    override hr(token: Tokens.Hr) { return annotate(token, super.hr(token)); }
  }
  return { html: markdown.parser(tokens, { ...markdown.defaults, renderer: new ProvenanceRenderer() }), attribute, itemIds };
}

// Marked removes list prefixes and indentation before lexing child blocks. A child
// line with altered whitespace cannot be mapped reliably, so use the enclosing item.
function deindent(parent: Source, start: number, raw: string, inner: string): Source | undefined {
  const rawLines = raw.split('\n');
  const innerLines = inner.split('\n');
  const offsets: { inner: number; raw: number; prefix: number }[] = [];
  let rawIndex = start;
  let innerIndex = 0;
  for (const [index, line] of innerLines.entries()) {
    const rawLine = rawLines[index];
    if (rawLine === undefined) return;
    const trimmed = rawLine.trimEnd();
    const matchedLine = rawLine.endsWith(line) ? rawLine : trimmed;
    if (!matchedLine.endsWith(line)) return;
    offsets.push({ inner: innerIndex, raw: rawIndex, prefix: matchedLine.length - line.length });
    rawIndex += rawLine.length + 1;
    innerIndex += line.length + 1;
  }
  return {
    text: inner,
    offset(index) {
      let lo = 0;
      let hi = offsets.length;
      while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsets[mid]!.inner <= index) lo = mid;
        else hi = mid;
      }
      const line = offsets[lo]!;
      const column = index - line.inner;
      // Include the indentation in the line's first boundary. The preceding
      // item's end then stays before the next item's indentation.
      return parent.offset(line.raw + (column ? line.prefix + column : 0));
    },
  };
}
