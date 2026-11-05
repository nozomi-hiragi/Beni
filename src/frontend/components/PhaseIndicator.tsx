import { For, Show, type JSX } from 'solid-js';

export const phaseDocuments = [
  { phase: 'requirements', name: 'requirements.md', label: '要件定義' },
  { phase: 'documents', name: 'documents.md', label: '仕様整理' },
  { phase: 'implementation', name: 'implementation.md', label: '実装手順' },
  { phase: 'retrospective', name: 'retrospective.md', label: '反省会' },
];

export default function PhaseIndicator(props: { phase: string; onChange: (target: string) => void; advancing?: boolean; canStart?: boolean; completed?: boolean; busy?: boolean; modelSelect?: JSX.Element }) {
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <For each={phaseDocuments.filter(item => item.phase !== 'retrospective')}>{item => <>
      <button type="button" class="btn btn-ghost btn-sm" classList={{"btn-active": props.phase === item.phase}} aria-current={props.phase === item.phase ? 'step' : undefined} disabled={props.advancing || props.busy || (props.phase === 'execution' || props.phase === 'retrospective')} onClick={() => props.onChange(item.phase)}>{item.label}</button>
      <span aria-hidden="true">›</span>
    </>}</For>
    <span class="inline-flex h-8 items-center rounded px-3 text-sm text-base-content" classList={{"bg-base-300 font-semibold": props.phase === 'execution'}} aria-current={props.phase === 'execution' ? 'step' : undefined}>実装中</span>
    <span aria-hidden="true">›</span>
    <span class="inline-flex h-8 items-center rounded px-3 text-sm" classList={{"bg-base-300 font-semibold": props.phase === 'retrospective'}} aria-current={props.phase === 'retrospective' ? 'step' : undefined}>反省会</span>
    <span class="flex-1" />
    <Show when={props.phase !== 'execution' && props.phase !== 'retrospective'}>{props.modelSelect}</Show>
    <Show when={props.phase === 'retrospective'} fallback={<button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || (props.phase !== 'execution' && (props.busy || !props.canStart))} onClick={() => props.onChange(props.phase === 'execution' ? 'stop' : 'start')}>{props.phase === 'execution' ? '停止' : '開始'}</button>}>
      <button type="button" class="btn btn-primary btn-sm" disabled={props.advancing || props.busy} onClick={() => props.onChange(props.completed ? 'reopen' : 'complete')}>{props.completed ? '再開' : 'タスク完了'}</button>
    </Show>
  </div>;
}
