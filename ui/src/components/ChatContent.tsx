import { For, Show } from 'solid-js';
import type { JSX } from 'solid-js';
import type { Message } from '../types';

export default function ChatContent(props: { messages: Message[]; children?: JSX.Element }) {
  return <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
    <Show when={props.messages.length > 0} fallback={<p class="text-sm text-base-content/50">希望や回答を入力してください。</p>}>
      <For each={props.messages}>{message => <article class="rounded-xl bg-base-200 px-4 py-3"><p class="mb-1 text-xs font-medium text-base-content/55">{message.role === 'user' ? 'あなた' : message.role === 'assistant' ? 'アシスタント' : message.role}</p><p class="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p></article>}</For>
    </Show>
    {props.children}
  </div>;
}
