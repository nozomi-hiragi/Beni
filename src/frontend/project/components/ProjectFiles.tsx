import { createSignal, Match, onCleanup, onMount, Switch } from 'solid-js';
import type { ProjectFileList, ProjectFilePreview } from '../../../shared/project-files';
import { api } from '../../shared/api';
import MarkdownPreview from '../../shared/components/MarkdownPreview';
import CodePreview from './CodePreview';
import type { TreeNode } from './TreeView';

const filePrefix = 'project-file:';
export const projectFilePath = (id: string) => id.startsWith(filePrefix) ? id.slice(filePrefix.length) : undefined;
export const projectFileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export function projectFileTree(projectId: string, path = ''): TreeNode {
  return {
    label: path ? projectFileName(path) : 'プロジェクトファイル',
    open: !path,
    async load(signal) {
      const query = new URLSearchParams({ projectId, path });
      const { entries, truncated } = await api<ProjectFileList>(`/api/project-files?${query}`, undefined, signal);
      return {
        nodes: entries.map(entry => {
          const child = path ? `${path}/${entry.name}` : entry.name;
          return entry.kind === 'directory'
            ? projectFileTree(projectId, child)
            : { id: filePrefix + child, label: entry.name };
        }),
        truncated,
      };
    },
  };
}

export default function ProjectFileContent(props: { projectId: string; path: string }) {
  const [preview, setPreview] = createSignal<ProjectFilePreview>();
  const [failed, setFailed] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  onMount(async () => {
    const query = new URLSearchParams({ projectId: props.projectId, path: props.path });
    try {
      const value = await api<ProjectFilePreview>(`/api/project-file?${query}`, undefined, controller.signal);
      if (!controller.signal.aborted) setPreview(value);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    }
  });
  const text = () => {
    const value = preview();
    return value?.kind === 'text' ? value : undefined;
  };
  return <Switch fallback={<p role="status" class="p-4 text-sm text-base-content/60">読み込み中...</p>}>
    <Match when={failed()}><p role="alert" class="p-4 text-sm text-error">ファイルを読み込めませんでした</p></Match>
    <Match when={preview()?.kind === 'too-large'}><p class="p-4 text-sm">1 MiB を超えるファイルはプレビューできません。</p></Match>
    <Match when={preview()?.kind === 'binary'}><p class="p-4 text-sm">UTF-8 のテキストとして表示できないファイルです。</p></Match>
    <Match when={text()}>{value => /\.(?:md|markdown)$/i.test(props.path)
      ? <MarkdownPreview content={value().content} />
      : <CodePreview path={props.path} content={value().content} />}
    </Match>
  </Switch>;
}
