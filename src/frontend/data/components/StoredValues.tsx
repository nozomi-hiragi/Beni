import { createSignal, For, Match, Show, Switch, type JSX } from 'solid-js';
import { object } from '../../../shared/communication';

export function JsonValue(props: { value: unknown }) {
  return <pre class="max-h-96 overflow-auto rounded-box bg-base-200 p-3 text-xs"><code>{JSON.stringify(props.value, null, 2)}</code></pre>;
}

export function Expandable(props: { label: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return <details class="rounded-box border border-base-300 p-3" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary class="cursor-pointer wrap-anywhere text-sm">{props.label}</summary>
    <Show when={open()}><div class="mt-2 space-y-2">{props.children}</div></Show>
  </details>;
}

export function TextValue(props: { text: string }) {
  return <Show when={props.text.length > 400} fallback={<span class="wrap-anywhere whitespace-pre-wrap">{props.text}</span>}>
    <Expandable label={`テキストを表示（${props.text.length} 文字）`}>
      <pre class="max-h-96 overflow-auto wrap-anywhere whitespace-pre-wrap">{props.text}</pre>
    </Expandable>
  </Show>;
}

export function MetadataTable(props: { fields: Record<string, unknown>; databaseRow?: boolean }) {
  return <table class="table table-sm table-fixed wrap-anywhere">
    <tbody>
      <For each={Object.entries(props.fields)}>{([name, value]) => <tr>
        <th scope="row" class="w-29 text-xs font-medium text-base-content/70">{name}</th>
        <td><Switch>
          <Match when={typeof value === 'string'}><TextValue text={value as string} /></Match>
          <Match when={props.databaseRow && object(value) && value.type === 'BLOB' && typeof value.bytes === 'number' && value}>
            {blob => <>BLOB ({String(blob().bytes)} bytes)</>}
          </Match>
          <Match when={value !== null && typeof value === 'object'}>
            <Expandable label="JSON を表示"><JsonValue value={value} /></Expandable>
          </Match>
          <Match when={true}>{value == null ? (props.databaseRow ? 'NULL' : '—') : String(value)}</Match>
        </Switch></td>
      </tr>}</For>
    </tbody>
  </table>;
}
