import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { api } from '../../shared/api';

type FolderListing = {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
};

export default function FolderPicker(props: {
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = createSignal<FolderListing>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  let attemptedPath: string | undefined;
  let alive = true;
  let requestId = 0;
  let inFlight = false;

  onCleanup(() => { alive = false; requestId++; });
  async function load(path?: string) {
    if (inFlight) return;
    inFlight = true;
    const id = ++requestId;
    attemptedPath = path;
    setListing(undefined);
    setError('');
    setLoading(true);
    try {
      const result = await api<FolderListing>('/api/folders/list', path === undefined ? {} : { path });
      if (alive && id === requestId) setListing(result);
    } catch (cause) {
      if (alive && id === requestId) setError(cause instanceof Error ? cause.message : 'フォルダを読み込めませんでした');
    } finally {
      inFlight = false;
      if (alive && id === requestId) setLoading(false);
    }
  }
  onMount(() => { void load(); });

  return <section aria-label="フォルダを選択" class="rounded-box border border-base-300 p-3">
    <div class="flex items-center justify-between gap-2">
      <strong>フォルダを選択</strong>
      <button type="button" class="btn btn-ghost btn-sm" onClick={() => props.onCancel()}>閉じる</button>
    </div>
    <Show when={loading()}><p role="status">読み込み中…</p></Show>
    <Show when={error()}><div role="alert"><p>{error()}</p><button type="button" class="btn btn-sm" onClick={() => void load(attemptedPath)}>再試行</button></div></Show>
    <Show when={listing()} keyed>{current => <>
      <p class="break-all" aria-label="現在のフォルダ">{current.path}</p>
      <button type="button" class="btn btn-sm" disabled={loading() || !current.parent} onClick={() => { if (current.parent) void load(current.parent); }}>親フォルダへ</button>
      <ul aria-label="フォルダ一覧" class="my-2 max-h-48 overflow-auto">
        <For each={current.directories}>{directory => <li><button type="button" class="btn btn-ghost btn-sm w-full justify-start" disabled={loading()} onClick={() => void load(directory.path)}>{directory.name}</button></li>}</For>
      </ul>
      <Show when={current.directories.length === 0}><p>表示できるフォルダはありません</p></Show>
      <Show when={current.truncated}><p>表示件数の上限に達したため、一部のフォルダを表示していません。</p></Show>
      <button type="button" class="btn btn-primary btn-sm" disabled={loading()} onClick={() => props.onSelect(current.path)}>このフォルダを選択</button>
    </>}</Show>
  </section>;
}
