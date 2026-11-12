import { Show } from 'solid-js';

export default function Pagination(props: { label: string; total: number; offset: number; limit: number; unit?: string; onChange: (offset: number) => void }) {
  const first = () => Math.min(props.offset + 1, props.total);
  const last = () => Math.min(props.offset + props.limit, props.total);
  const previous = () => Math.max(0, Math.min(props.offset - props.limit, Math.floor((props.total - 1) / props.limit) * props.limit));
  return <Show when={props.total > props.limit || props.offset > 0}>
    <nav aria-label={props.label} class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-base-300 px-3 py-2 text-xs">
      <button type="button" class="btn btn-xs" disabled={props.offset === 0} onClick={() => props.onChange(previous())}>前のページ</button>
      <span>{props.offset >= props.total ? '0' : `${first()}–${last()}`} / {props.total} {props.unit ?? '件'}</span>
      <button type="button" class="btn btn-xs" disabled={props.offset + props.limit >= props.total} onClick={() => props.onChange(props.offset + props.limit)}>次のページ</button>
    </nav>
  </Show>;
}
