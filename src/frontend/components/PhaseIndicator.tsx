import { For, Match, Show, Switch, type JSX } from 'solid-js';
import type { TaskPhase } from '../../shared/task-phase';

export const phaseLabels = { requirements: '要件定義', documents: '仕様整理', implementation: '実装手順', execution: '実装中', retrospective: '反省会', finalization: '終了' } satisfies Record<TaskPhase, string>;

const preparationPhases = ['requirements', 'documents', 'implementation'] as const;
const historyPhases = ['execution', 'retrospective', 'finalization'] as const;
type HistoryPhase = typeof historyPhases[number];

export const phaseDocuments = [...preparationPhases, 'retrospective' as const].map(phase => ({ phase, name: `${phase}.md`, label: phaseLabels[phase] }));

export default function PhaseIndicator(props: { phase: string; viewPhase?: string; onViewPhaseChange?: (phase: HistoryPhase) => void; onChange: (target: string) => void; advancing?: boolean; canStart?: boolean; completed?: boolean; busy?: boolean; modelSelect?: JSX.Element }) {
  const selectedPhase = () => props.viewPhase ?? props.phase;
  const finalizing = () => props.phase === 'finalization';
  const retrospective = () => props.phase === 'retrospective';
  const execution = () => props.phase === 'execution';
  const canViewHistory = (phase: HistoryPhase) => props.onViewPhaseChange && (finalizing() || (retrospective() && phase !== 'finalization'));
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <For each={preparationPhases}>{phase => <>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": selectedPhase() === phase}} aria-current={selectedPhase() === phase ? 'step' : undefined} disabled={props.advancing || props.busy || execution() || retrospective() || finalizing()} onClick={() => props.onChange(phase)}>{phaseLabels[phase]}</button>
      <span aria-hidden="true">›</span>
    </>}</For>
    <For each={historyPhases}>{(phase, index) => <>
      <Show when={index() > 0}><span aria-hidden="true">›</span></Show>
      <Show when={canViewHistory(phase)} fallback={<span class="inline-flex h-8 items-center rounded px-3 text-sm text-base-content" classList={{"bg-base-300 font-semibold": selectedPhase() === phase}} aria-current={selectedPhase() === phase ? 'step' : undefined}>{phaseLabels[phase]}</span>}>
        <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": selectedPhase() === phase}} aria-current={selectedPhase() === phase ? 'step' : undefined} disabled={props.advancing || (!finalizing() && props.busy)} onClick={() => props.onViewPhaseChange?.(phase)}>{phaseLabels[phase]}</button>
      </Show>
    </>}</For>
    <span class="flex-1" />
    <Switch>
      <Match when={finalizing() || retrospective()}>
        <Show when={props.completed || retrospective()}>
          <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || (retrospective() && props.busy)} onClick={() => props.onChange(props.completed ? 'reopen' : 'complete')}>{props.completed ? '再開' : 'タスク完了'}</button>
        </Show>
      </Match>
      <Match when={execution()}>
        <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing} onClick={() => props.onChange('stop')}>停止</button>
      </Match>
      <Match when={true}>
        {props.modelSelect}
        <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || props.busy || !props.canStart} onClick={() => props.onChange('start')}>開始</button>
      </Match>
    </Switch>
  </div>;
}
