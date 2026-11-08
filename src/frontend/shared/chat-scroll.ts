// Follow new content and layout changes until the reader scrolls away from the bottom.
export function followChatBottom(scrollport: HTMLElement, content: HTMLElement) {
  let following = true;
  let frame: number | undefined;
  const schedule = () => {
    if (!following || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (following) scrollport.scrollTop = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
    });
  };
  const scroll = () => {
    following = scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop <= 2;
    if (following) schedule();
  };
  const resize = new ResizeObserver(schedule);
  resize.observe(scrollport);
  resize.observe(content);
  scrollport.addEventListener('scroll', scroll, { passive: true });
  schedule();
  return {
    reset() { following = true; schedule(); },
    dispose() {
      resize.disconnect();
      scrollport.removeEventListener('scroll', scroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
    },
  };
}
