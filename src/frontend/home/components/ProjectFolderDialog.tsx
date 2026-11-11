import { createSignal, onMount, Show } from 'solid-js';
import type { Project } from '../../shared/types';
import FolderPicker from './FolderPicker';

export default function ProjectFolderDialog(props: {
  project: Project;
  saving: boolean;
  onSave: (folder: string) => Promise<void>;
  onClose: () => void;
}) {
  const [folder, setFolder] = createSignal(props.project.folder);
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [error, setError] = createSignal('');
  let dialog!: HTMLDialogElement;
  onMount(() => dialog.showModal());

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (props.saving || !folder().trim()) return;
    setError('');
    setPickerOpen(false);
    try {
      await props.onSave(folder());
      if (dialog.open) dialog.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '作業フォルダーを変更できませんでした');
    }
  }

  return <dialog ref={dialog} class="modal" aria-labelledby="projectFolderDialogTitle" onClose={props.onClose} onCancel={event => { if (props.saving) event.preventDefault(); }}>
    <form class="modal-box flex max-w-lg flex-col gap-5" onSubmit={save}>
      <h2 id="projectFolderDialogTitle" class="text-lg font-semibold">作業フォルダーを変更</h2>
      <p class="break-all">{props.project.name}</p>
      <Show when={error()}><p role="alert" class="alert alert-error">{error()}</p></Show>
      <div class="flex flex-col gap-2 text-sm font-medium">
        <label for="project-folder-change">作業フォルダー</label>
        <div class="flex gap-2">
          <input id="project-folder-change" name="folder" class="input input-bordered min-w-0 w-full font-normal" required disabled={props.saving} value={folder()} onInput={event => setFolder(event.currentTarget.value)} />
          <button type="button" class="btn" disabled={props.saving} onClick={() => setPickerOpen(true)}>参照</button>
        </div>
      </div>
      <Show when={pickerOpen()}><FolderPicker onSelect={path => { setFolder(path); setPickerOpen(false); }} onCancel={() => setPickerOpen(false)} /></Show>
      <footer class="modal-action mt-1">
        <button type="button" class="btn btn-ghost" disabled={props.saving} onClick={() => dialog.close()}>キャンセル</button>
        <button type="submit" class="btn btn-primary" disabled={props.saving || !folder().trim()}>保存</button>
      </footer>
    </form>
  </dialog>;
}
