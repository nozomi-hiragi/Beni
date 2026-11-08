import type { JSX } from 'solid-js';

export default function HeaderIcon(props: { children: JSX.Element }) {
  return <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{props.children}</svg>;
}
