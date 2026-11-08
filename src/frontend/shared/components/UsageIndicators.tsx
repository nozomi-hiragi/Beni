import { createUniqueId, For, onMount, Show } from 'solid-js';
import { loadModels, modelStatus, registeredAgents } from '../model-cache';
import type { AgentInfo } from '../../../shared/agent';
import type { Provider } from '../types';
import AgentIcon from './icons/AgentIcon';

function usageWindows(provider: Provider) {
  const usage = modelStatus(provider)?.usage;
  return usage && usage !== 'unknown' ? usage.windows : [];
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

function UsageIndicator(props: { agent: AgentInfo }) {
  const {id, name} = props.agent;
  const tooltipId = createUniqueId();
  const windows = () => {
    const usage = usageWindows(id);
    if (id !== 'codex' && id !== 'claude') return usage;
    return [
      {...usage.find(window => window.label === '5時間枠'), label:'5時間'},
      {...usage.find(window => window.label === '7日枠'), label:'週間'},
    ];
  };
  const primary = () => windows().find(window => remainingPercent(window.usedPercent) !== undefined);
  const value = () => remainingPercent(primary()?.usedPercent);
  return <div class="tooltip tooltip-bottom flex hover:z-10 focus-within:z-10">
    <div id={tooltipId} role="tooltip" class="tooltip-content">
      <div class="font-semibold">{name}</div>
      <For each={windows()} fallback={<div>未取得</div>}>{window => <>
        <div>{window.label} {remainingLabel(remainingPercent(window.usedPercent))}</div>
        <div class="text-xs">リセット: {resetLabel(window.resetsAt)}</div>
      </>}</For>
    </div>
    <div class="absolute inset-0 rounded-full border-[3px] border-base-300" aria-hidden="true" />
    <div
      role="progressbar"
      aria-label={`${name} の利用枠`}
      aria-describedby={tooltipId}
      aria-valuenow={value()}
      aria-valuetext={primary() ? `${primary()!.label} ${remainingLabel(value())}` : '未取得'}
      tabIndex={0}
      class="radial-progress focus-visible:outline-2 focus-visible:outline-offset-2"
      classList={{
        'text-primary-content': (value() ?? 0) > 20,
        'text-warning': (value() ?? 0) > 0 && (value() ?? 0) <= 20,
        'before:hidden after:hidden': !value(),
      }}
      style={{ '--size': '1.7rem', '--thickness': '2px', '--value': value() ?? 0 }}
    >
      <AgentIcon provider={id} class="size-3" />
    </div>
  </div>;
}

export default function UsageIndicators() {
  const agentsWithUsage = () => registeredAgents().filter(agent => {
    const status = modelStatus(agent.id);
    return status && status.availability !== 'not-installed' && (agent.supportsUsage || usageWindows(agent.id).length > 0);
  });
  onMount(() => { void loadModels().catch(() => { }); });
  return <Show when={agentsWithUsage().length}>
    <div class="flex shrink-0 gap-2">
      <For each={agentsWithUsage()}>{agent => <UsageIndicator agent={agent} />}</For>
    </div>
  </Show>;
}
