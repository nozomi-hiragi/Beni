import { createSignal, onCleanup, onMount } from 'solid-js';

export const MAX_RATIO = 80;

export default function ResizeHandle(props: {
  orientation: 'horizontal' | 'vertical';
  label: string;
  container: () => HTMLElement | undefined;
  value: number;
  onChange: (value: number) => void;
}) {
  const [dragging, setDragging] = createSignal(false);
  let handle!: HTMLDivElement;
  let pointerId: number | undefined;
  const change = (value: number) => props.onChange(Math.max(100 - MAX_RATIO, Math.min(MAX_RATIO, value)));
  function stop() {
    const id = pointerId;
    pointerId = undefined;
    setDragging(false);
    if (id !== undefined && handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const container = props.container();
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const styles = getComputedStyle(container);
    const vertical = props.orientation === 'vertical';
    const startPadding = parseFloat(vertical ? styles.paddingLeft : styles.paddingTop) || 0;
    const endPadding = parseFloat(vertical ? styles.paddingRight : styles.paddingBottom) || 0;
    const handleSize = vertical ? handle.offsetWidth : handle.offsetHeight;
    const size = (vertical ? rect.width : rect.height) - startPadding - endPadding - handleSize;
    if (size <= 0) return;
    const position = (vertical ? event.clientX - rect.left : event.clientY - rect.top) - startPadding - handleSize / 2;
    change(position / size * 100);
  }
  onMount(() => {
    window.addEventListener('blur', stop);
    window.addEventListener('resize', stop);
  });
  onCleanup(() => {
    stop();
    window.removeEventListener('blur', stop);
    window.removeEventListener('resize', stop);
  });
  return <div ref={handle} role="separator" tabindex="0" aria-label={props.label} aria-orientation={props.orientation} aria-valuemin={100 - MAX_RATIO} aria-valuemax={MAX_RATIO} aria-valuenow={Math.round(props.value)}
    class="workspace-resize" classList={{'workspace-resize-vertical': props.orientation === 'vertical', 'workspace-resize-horizontal': props.orientation === 'horizontal', 'workspace-resize-active': dragging()}}
    onPointerDown={event => {
      if (!event.isPrimary || event.button !== 0 || pointerId !== undefined) return;
      event.preventDefault();
      handle.focus();
      pointerId = event.pointerId;
      handle.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={move}
    onPointerUp={event => { if (event.pointerId === pointerId) stop(); }}
    onPointerCancel={event => { if (event.pointerId === pointerId) stop(); }}
    onLostPointerCapture={stop}
    onKeyDown={event => {
      if (event.key === 'Escape') { stop(); return; }
      const decrease = props.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const increase = props.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      change(event.key === 'Home' ? 100 - MAX_RATIO : event.key === 'End' ? MAX_RATIO : props.value + (event.key === increase ? 2 : -2));
    }} />;
}
