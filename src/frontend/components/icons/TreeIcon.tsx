export default function TreeIcon(props: { folder?: boolean }) {
  return <svg aria-hidden="true" class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <path stroke-linecap="round" stroke-linejoin="round" d={props.folder
      ? 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'
      : 'M6 3h8l4 4v14H6z M14 3v5h4 M9 13h6 M9 17h6'} />
  </svg>;
}
