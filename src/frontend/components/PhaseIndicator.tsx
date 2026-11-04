export interface PhaseIndicatorProps {
  phase: string;
  onRequirements: () => void;
}

// Only requirements is connected in this version; later actions stay disabled.
export default function PhaseIndicator(props: PhaseIndicatorProps) {
  return <div class="flex flex-wrap items-center gap-1 border-b border-base-300 px-3 py-2" aria-label="タスクのフェーズ">
    <button type="button" class="btn btn-ghost btn-sm" aria-current={props.phase === 'requirements' ? 'step' : undefined} onClick={props.onRequirements}>タスク内容</button>
    <span aria-hidden="true">›</span>
    <button type="button" class="btn btn-ghost btn-sm" disabled>実装フロー</button>
    <span aria-hidden="true">›</span>
    <button type="button" class="btn btn-ghost btn-sm" disabled>実装中</button>
    <span class="flex-1" />
    <button type="button" class="btn btn-primary btn-sm" disabled>高モデルに依頼</button>
  </div>;
}
