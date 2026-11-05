import { For, Show, type JSX } from 'solid-js';

export const phaseDocuments = [
  { phase: 'requirements', name: 'requirements.md', label: '要件定義' },
  { phase: 'documents', name: 'documents.md', label: '仕様整理' },
  { phase: 'implementation', name: 'implementation.md', label: '実装手順' },
  { phase: 'retrospective', name: 'retrospective.md', label: '反省会' },
];

export default function PhaseIndicator(props: { phase: string; viewPhase?: string; onViewPhaseChange?: (phase: 'execution' | 'retrospective') => void; onChange: (target: string) => void; advancing?: boolean; canStart?: boolean; completed?: boolean; busy?: boolean; modelSelect?: JSX.Element }) {
  const selectedPhase = () => props.viewPhase ?? props.phase;
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <For each={phaseDocuments.filter(item => item.phase !== 'retrospective')}>{item => <>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": selectedPhase() === item.phase}} aria-current={selectedPhase() === item.phase ? 'step' : undefined} disabled={props.advancing || props.busy || (props.phase === 'execution' || props.phase === 'retrospective')} onClick={() => props.onChange(item.phase)}>{item.label}</button>
      <span aria-hidden="true">›</span>
    </>}</For>
    <Show when={props.phase === 'retrospective' && props.onViewPhaseChange} fallback={<span class="inline-flex h-8 items-center rounded px-3 text-sm text-base-content" classList={{"bg-base-300 font-semibold": selectedPhase() === 'execution'}} aria-current={selectedPhase() === 'execution' ? 'step' : undefined}>実装中</span>}>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active":selectedPhase() === 'execution'}} aria-current={selectedPhase() === 'execution' ? 'step' : undefined} disabled={props.advancing || props.busy} onClick={() => props.onViewPhaseChange?.('execution')}>実装中</button>
    </Show>
    <span aria-hidden="true">›</span>
    <Show when={props.phase === 'retrospective' && props.onViewPhaseChange} fallback={<span class="inline-flex h-8 items-center rounded px-3 text-sm" classList={{"bg-base-300 font-semibold": selectedPhase() === 'retrospective'}} aria-current={selectedPhase() === 'retrospective' ? 'step' : undefined}>反省会</span>}>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active":selectedPhase() === 'retrospective'}} aria-current={selectedPhase() === 'retrospective' ? 'step' : undefined} disabled={props.advancing || props.busy} onClick={() => props.onViewPhaseChange?.('retrospective')}>反省会</button>
    </Show>
    <span class="flex-1" />
    <Show when={props.phase !== 'execution' && props.phase !== 'retrospective'}>{props.modelSelect}</Show>
    <Show when={props.phase === 'retrospective'} fallback={<button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || (props.phase !== 'execution' && (props.busy || !props.canStart))} onClick={() => props.onChange(props.phase === 'execution' ? 'stop' : 'start')}>{props.phase === 'execution' ? '停止' : '開始'}</button>}>
      <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || props.busy} onClick={() => props.onChange(props.completed ? 'reopen' : 'complete')}>{props.completed ? '再開' : 'タスク完了'}</button>
    </Show>
  </div>;
}
