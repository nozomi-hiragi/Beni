import { createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import TreeIcon from '../../shared/components/icons/TreeIcon';

type TreeContents = { nodes: TreeNode[]; truncated?: boolean };

type TreeFolder = {
  label: string;
  children?: TreeNode[];
  open?: boolean;
  load?: (signal: AbortSignal) => Promise<TreeContents>;
};

export type TreeNode = { id: string; label: string } | TreeFolder;

export interface TreeViewProps {
  id: string;
  label: string;
  actions?: JSX.Element;
  nodes: TreeNode[];
  activeId?: string;
  onSelect: (id: string) => void;
}

type TreeSelection = Pick<TreeViewProps, 'activeId' | 'onSelect'>;

function TreeBranch(props: TreeSelection & { node: TreeFolder }) {
  const [contents, setContents] = createSignal<TreeContents>();
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  async function load() {
    if (!props.node.load || contents() || loading()) return;
    setLoading(true);
    setFailed(false);
    try {
      const result = await props.node.load(controller.signal);
      if (!controller.signal.aborted) setContents(result);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const initiallyOpen = props.node.open ?? !props.node.load;
  onMount(() => { if (initiallyOpen) void load(); });
  return <details open={initiallyOpen} onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary title={props.node.label}><TreeIcon folder /><span class="min-w-0 wrap-anywhere">{props.node.label}</span></summary>
    <ul>
      <TreeItems nodes={contents()?.nodes ?? props.node.children ?? []} activeId={props.activeId} onSelect={props.onSelect} />
      <Show when={loading()}><li><span role="status">読み込み中...</span></li></Show>
      <Show when={failed()}><li><span role="alert" class="text-error">フォルダーを開けませんでした</span></li></Show>
      <Show when={contents()?.nodes.length === 0}><li><span class="text-base-content/60">空のフォルダー</span></li></Show>
      <Show when={contents()?.truncated}><li><span class="text-base-content/60">先頭の500件を表示</span></li></Show>
    </ul>
  </details>;
}

function TreeItems(props: TreeSelection & { nodes: TreeNode[] }) {
  return <For each={props.nodes}>{node => <li>
    {'id' in node
      ? <button type="button" title={node.label} classList={{ 'menu-active': props.activeId === node.id }} aria-current={props.activeId === node.id ? 'true' : undefined} onClick={() => props.onSelect(node.id)}>
        <TreeIcon /><span class="min-w-0 wrap-anywhere">{node.label}</span>
      </button>
      : <TreeBranch node={node} activeId={props.activeId} onSelect={props.onSelect} />}
  </li>}</For>;
}

// The parent positions this inside the pane body, below its fixed tab bar.
export default function TreeView(props: TreeViewProps) {
  return <aside id={props.id} aria-label={props.label} class="absolute inset-y-0 left-0 z-10 w-56 max-w-full overflow-auto border-r border-base-300 bg-base-100 p-3 shadow-sm">
    <div class="mb-2 flex items-center justify-between gap-1"><strong class="text-sm">{props.label}</strong>{props.actions}</div>
    <ul class="menu menu-xs w-full rounded-box bg-base-200">
      <TreeItems nodes={props.nodes} activeId={props.activeId} onSelect={props.onSelect} />
    </ul>
  </aside>;
}
