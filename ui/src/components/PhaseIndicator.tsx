import { Show } from 'solid-js';

export interface PhaseIndicatorProps {
  phase: string;
  onRequirements: () => void;
  onPlan?: () => void;
  hasPlan?: boolean;
  onUpdateRequirements?: () => void;
  updateDisabled?: boolean;
  onRequestPlan?: () => void;
  requestDisabled?: boolean;
  onExecute?: () => void;
  executeDisabled?: boolean;
}

export default function PhaseIndicator(props: PhaseIndicatorProps) {
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <button type="button" class="btn btn-ghost btn-sm" aria-current={props.phase === 'requirements' ? 'step' : undefined} onClick={props.onRequirements}>タスク内容</button>
    <span aria-hidden="true">›</span>
    <button type="button" class="btn btn-ghost btn-sm" aria-current={props.phase === '実装フロー' ? 'step' : undefined} disabled={!props.hasPlan} onClick={props.onPlan}>実装フロー</button>
    <span aria-hidden="true">›</span>
    <button type="button" class="btn btn-ghost btn-sm" aria-current={props.phase === '実装中' ? 'step' : undefined} disabled>実装中</button>
    <span class="flex-1" />
    <Show when={props.onUpdateRequirements}><button type="button" class="btn btn-ghost btn-sm" disabled={props.updateDisabled} onClick={props.onUpdateRequirements}>指示書を更新</button></Show>
    <button type="button" class="btn btn-primary btn-sm" disabled={props.requestDisabled !== false || !props.onRequestPlan} onClick={props.onRequestPlan}>高モデルに依頼</button>
    <Show when={props.hasPlan}><button type="button" class="btn btn-primary btn-sm" disabled={props.executeDisabled !== false || !props.onExecute} onClick={props.onExecute}>実行指示</button></Show>
  </div>;
}
