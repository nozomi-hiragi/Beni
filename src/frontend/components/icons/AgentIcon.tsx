import { Match, Switch } from 'solid-js';
import type { Provider } from '../../types';
import ChatGPTPopIcon from './ChatGPTPopIcon';
import ClaudePopIcon from './ClaudePopIcon';

export default function AgentIcon(props: { provider?: Provider; class?: string }) {
  return <Switch fallback={<svg class={props.class ?? 'size-5 shrink-0'} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path stroke-linecap="round" stroke-linejoin="round" d="M6 5h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5l-5 3v-3H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    <path stroke-linecap="round" d="M8 11h.01m4 0h.01m4 0h.01" />
  </svg>}>
    <Match when={props.provider === undefined || props.provider === 'codex'}><ChatGPTPopIcon class={props.class} /></Match>
    <Match when={props.provider === 'claude'}><ClaudePopIcon class={props.class} /></Match>
  </Switch>;
}
