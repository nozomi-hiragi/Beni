import { createUniqueId, For, onMount, Show } from 'solid-js';
import { loadModels, modelStatus, providerName } from '../model-cache';
import type { Provider } from '../types';
import ChatGPTPopIcon from './icons/ChatGPTPopIcon';
import ClaudePopIcon from './icons/ClaudePopIcon';

const providers = [
  { id: 'codex', Icon: ChatGPTPopIcon },
  { id: 'claude', Icon: ClaudePopIcon },
] as const;

function usageWindow(provider: Provider, label: string) {
  const usage = modelStatus(provider)?.usage;
  return usage && usage !== 'unknown' ? usage.windows.find(window => window.label === label) : undefined;
}

function remainingPercent(used: number | undefined) {
  if (used === undefined || !Number.isFinite(used)) return undefined;
  return Math.round(100 - Math.min(100, Math.max(0, used)));
}

const remainingLabel = (value: number | undefined) => value === undefined ? '未取得' : `残り ${value}%`;

function resetLabel(timestamp: number | undefined) {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '未取得';
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return '未取得';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
}

function UsageIndicator(props: { provider: typeof providers[number] }) {
  const { id, Icon } = props.provider;
  const tooltipId = createUniqueId();
  const name = providerName(id);
  const sessionWindow = () => usageWindow(id, '5時間枠');
  const weekWindow = () => usageWindow(id, '7日枠');
  const session = () => remainingPercent(sessionWindow()?.usedPercent);
  const week = () => remainingPercent(weekWindow()?.usedPercent);
  const value = () => session() ?? week();
  return <div class="tooltip tooltip-bottom flex hover:z-10 focus-within:z-10">
    <div id={tooltipId} role="tooltip" class="tooltip-content">
      <div class="font-semibold">{name}</div>
      <div>5時間 {remainingLabel(session())}</div>
      <div class="text-xs">リセット: {resetLabel(sessionWindow()?.resetsAt)}</div>
      <div>週間 {remainingLabel(week())}</div>
      <div class="text-xs">リセット: {resetLabel(weekWindow()?.resetsAt)}</div>
    </div>
    <div class="absolute inset-0 rounded-full border-[3px] border-base-300" aria-hidden="true" />
    <div
      role="progressbar"
      aria-label={`${name} の利用枠`}
      aria-describedby={tooltipId}
      aria-valuenow={value()}
      aria-valuetext={session() !== undefined ? `5時間 ${remainingLabel(session())}` : week() !== undefined ? `週間 ${remainingLabel(week())}` : '未取得'}
      tabIndex={0}
      class="radial-progress focus-visible:outline-2 focus-visible:outline-offset-2"
      classList={{
        'text-primary-content': (value() ?? 0) > 20,
        'text-warning': (value() ?? 0) > 0 && (value() ?? 0) <= 20,
        'before:hidden after:hidden': !value(),
      }}
      style={{ '--size': '1.7rem', '--thickness': '2px', '--value': value() ?? 0 }}
    >
      <Icon class="size-3" />
    </div>
  </div>;
}

export default function UsageIndicators() {
  const installed = () => providers.filter(provider => modelStatus(provider.id)?.installed);
  onMount(() => { void loadModels().catch(() => { }); });
  return <Show when={installed().length}>
    <div class="flex shrink-0 gap-2">
      <For each={installed()}>{provider => <UsageIndicator provider={provider} />}</For>
    </div>
  </Show>;
}
