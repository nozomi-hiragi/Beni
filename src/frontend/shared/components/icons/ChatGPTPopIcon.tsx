// Beni独自の識別用イラスト。公式ロゴではない。
const spiral = `M22.5 4.75 H11.1
  Q9.5 4.75 8.7 6.14 L3.8 14.61
  Q3 16 3.8 17.39 L8.7 25.86
  Q9.5 27.25 11.1 27.25 H20.9
  Q22.5 27.25 23.3 25.86 L28.2 17.39
  Q29 16 28.2 14.61 L26.1 10.99
  Q25.3 9.6 23.7 9.6 H13.5
  Q12.3 9.6 11.7 10.64 L9.2 14.96
  Q8.6 16 9.2 17.04 L11.7 21.36
  Q12.3 22.4 13.5 22.4 H18.5
  Q19.7 22.4 20.3 21.36 L22.8 17.04
  Q23.4 16 22.8 14.96 L22.2 13.92`;

export default function ChatGPTPopIcon(props: { class?: string }) {
  return <svg
    class={props.class ?? 'size-5 shrink-0'}
    viewBox="0 0 32 32"
    aria-hidden="true"
    {...{ focusable: 'false' }}
  >
    <g transform="rotate(30 16 16)" fill="none" stroke-linecap="round">
      <path d={spiral} stroke="#000" stroke-width="6" />
      <path d={spiral} stroke="#fff" stroke-width="3.0" />
    </g>
  </svg>;
}
