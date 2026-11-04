import { Show } from 'solid-js';
import FolderPicker from './FolderPicker';

export interface ProjectCreateDialogProps {
  dialogRef: (element: HTMLDialogElement) => void;
  creating: boolean;
  error: string;
  name: string;
  folder: string;
  folderPickerOpen: boolean;
  onCreate: (event: SubmitEvent) => void;
  onName: (value: string) => void;
  onFolder: (value: string) => void;
  onFolderPickerOpen: (open: boolean) => void;
}

export default function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  let dialog: HTMLDialogElement | undefined;
  return <dialog ref={element => { dialog = element; props.dialogRef(element); }} class="modal" aria-labelledby="projectDialogTitle" onClose={() => props.onFolderPickerOpen(false)} onCancel={event => { if (props.creating) event.preventDefault(); }}>
    <form class="modal-box flex max-w-lg flex-col gap-5" onSubmit={props.onCreate}>
      <h2 id="projectDialogTitle" class="text-lg font-semibold">プロジェクトを作成</h2>
      <Show when={props.error}><p role="alert" class="alert alert-error">{props.error}</p></Show>
      <label class="form-control flex flex-col gap-2 text-sm font-medium">プロジェクト名
        <input name="name" class="input input-bordered w-full font-normal" required disabled={props.creating} value={props.name} onInput={event => props.onName(event.currentTarget.value)} />
      </label>
      <div class="flex flex-col gap-2 text-sm font-medium">
        <label for="project-folder">フォルダ</label>
        <div class="flex gap-2">
          <input id="project-folder" name="folder" class="input input-bordered w-full font-normal" required disabled={props.creating} value={props.folder} onInput={event => props.onFolder(event.currentTarget.value)} />
          <button type="button" class="btn" disabled={props.creating} onClick={() => props.onFolderPickerOpen(true)}>参照</button>
        </div>
      </div>
      <Show when={props.folderPickerOpen}><FolderPicker onSelect={path => { props.onFolder(path); props.onFolderPickerOpen(false); }} onCancel={() => props.onFolderPickerOpen(false)} /></Show>
      <footer class="modal-action mt-1">
        <button type="button" class="btn btn-ghost" disabled={props.creating} onClick={() => dialog?.close()}>キャンセル</button>
        <button type="submit" class="btn btn-primary" disabled={props.creating || !props.name.trim() || !props.folder.trim()}>作成</button>
      </footer>
    </form>
  </dialog>;
}
