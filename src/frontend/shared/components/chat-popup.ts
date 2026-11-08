export function popupHeight(anchor: HTMLElement, maxHeight: number) {
  let top = 8;
  for (let ancestor = anchor.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (/^(hidden|auto|scroll|clip)$/.test(window.getComputedStyle(ancestor).overflowY)) top = Math.max(top, ancestor.getBoundingClientRect().top);
  }
  return Math.max(0, Math.min(maxHeight, anchor.getBoundingClientRect().top - top - 8));
}
