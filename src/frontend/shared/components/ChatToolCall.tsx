import { createMemo, Show } from 'solid-js';
import type { Pack } from '../../../shared/communication';

const summaryKeys = ['command', 'cmd', 'file_path', 'filePath', 'path', 'query', 'pattern', 'url'];

function parsePayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function summarizeInput(input: string, payload: unknown) {
  let summary = typeof payload === 'string' ? payload : input;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const fields = payload as Record<string, unknown>;
    for (const key of summaryKeys) {
      const value = fields[key];
      if (typeof value === 'string' && value.trim()) {
        summary = value;
        break;
      }
    }
  }
  const characters = Array.from(summary.replace(/\s+/g, ' ').trim());
  return characters.length > 100 ? characters.slice(0, 100).join('') + '…' : characters.join('');
}

function formatPayload(value: string, payload: unknown) {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return value;
    }
  }
  return value;
}

function ToolPayload(props: { label: '入力' | '出力'; value: string }) {
  return <Show when={props.value.trim()} fallback={<p class="text-xs text-base-content/70">{props.label}なし</p>}>
    <div>
      <p class="mb-1 text-xs font-medium text-base-content/70">{props.label}</p>
      <pre class="max-h-56 overflow-auto rounded-field border border-base-300 bg-base-100 p-2 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere">{props.value}</pre>
    </div>
  </Show>;
}

export default function ChatToolCall(props: { tool: Pack['tool'] }) {
  const input = () => props.tool?.input ?? '';
  const output = () => props.tool?.output ?? '';
  const parsedInput = createMemo(() => parsePayload(input()));
  const summary = createMemo(() => summarizeInput(input(), parsedInput()));

  return <details class="group">
    <summary class="flex cursor-pointer items-start gap-2 rounded-field focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">
      <svg class="mt-0.5 size-4 shrink-0 text-base-content/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14.7 6.3a5 5 0 0 0-6.4 6.4l-5.6 5.6a2.1 2.1 0 0 0 3 3l5.6-5.6a5 5 0 0 0 6.4-6.4l-3 3-3-3 3-3Z" />
      </svg>
      <span class="min-w-0 flex-1">
        <span class="block text-sm font-medium wrap-anywhere">{props.tool?.name ?? 'ツール'}</span>
        <Show when={summary()}>{value => <span class="block truncate font-mono text-xs leading-relaxed text-base-content/70">{value()}</span>}</Show>
      </span>
      <svg class="mt-0.5 size-4 shrink-0 text-base-content/70 group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </summary>
    <div class="mt-2 space-y-3 border-t border-base-300 pt-2">
      <ToolPayload label="入力" value={formatPayload(input(), parsedInput())} />
      <ToolPayload label="出力" value={formatPayload(output(), parsePayload(output()))} />
    </div>
  </details>;
}
