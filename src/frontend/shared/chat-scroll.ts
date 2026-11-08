// Follow new content and layout changes until the reader scrolls away from the bottom.
export function followChatBottom(scrollport: HTMLElement, content: HTMLElement) {
  let following = true;
  let frame: number | undefined;
  let programmaticTop: number | undefined;
  const schedule = () => {
    if (!following || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (following) {
        const bottom = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight);
        if (scrollport.scrollTop !== bottom) {
          scrollport.scrollTop = bottom;
          programmaticTop = scrollport.scrollTop;
        }
      }
    });
  };
  const scroll = () => {
    // Browsers dispatch the scroll event after setting scrollTop. It may arrive
    // after a scope switch or content resize, so don't mistake our own write
    // for the reader scrolling away from the bottom.
    if (programmaticTop !== undefined) {
      if (scrollport.scrollTop === programmaticTop) {
        programmaticTop = undefined;
        return;
      }
      programmaticTop = undefined;
    }
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
