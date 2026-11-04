import { For } from 'solid-js';

export type TreeNode =
  | { id: string; label: string }
  | { label: string; children: TreeNode[] };

export interface TreeViewProps {
  id: string;
  label: string;
  nodes: TreeNode[];
  onSelect: (id: string) => void;
}

function TreeItems(props: Pick<TreeViewProps, 'nodes' | 'onSelect'>) {
  return <ul class="space-y-1">
    <For each={props.nodes}>{node => <li>
      {'children' in node
        ? <details open><summary class="cursor-pointer rounded px-2 py-1 text-sm font-medium">{node.label}</summary><div class="pl-3"><TreeItems nodes={node.children} onSelect={props.onSelect} /></div></details>
        : <button type="button" class="w-full rounded px-2 py-1 text-left text-sm hover:bg-base-200" onClick={() => props.onSelect(node.id)}>{node.label}</button>}
    </li>}</For>
  </ul>;
}

// The parent positions this inside the pane body, below its fixed tab bar.
export default function TreeView(props: TreeViewProps) {
  return <aside id={props.id} aria-label={props.label} class="absolute inset-y-0 left-0 z-10 w-56 max-w-full overflow-auto border-r border-base-300 bg-base-100 p-3 shadow-sm">
    <strong class="mb-2 block text-sm">{props.label}</strong>
    <TreeItems nodes={props.nodes} onSelect={props.onSelect} />
  </aside>;
}
