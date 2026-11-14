import { Show } from 'solid-js';

export interface TaskCreateDialogProps {
  dialogRef: (element: HTMLDialogElement) => void;
  creating: boolean;
  error: string;
  name: string;
  onCreate: (event: SubmitEvent) => void;
  onName: (value: string) => void;
}

export default function TaskCreateDialog(props: TaskCreateDialogProps) {
  let dialog: HTMLDialogElement | undefined;
  return <dialog ref={element => { dialog = element; props.dialogRef(element); }} class="modal" aria-labelledby="taskDialogTitle" onCancel={event => { if (props.creating) event.preventDefault(); }}>
    <form class="modal-box flex max-w-lg flex-col gap-5" onSubmit={props.onCreate}>
      <h2 id="taskDialogTitle" class="text-lg font-semibold">タスクを追加</h2>
      <Show when={props.error}><p role="alert" class="alert alert-error">{props.error}</p></Show>
      <label class="form-control flex flex-col gap-2 text-sm font-medium">タスク名
        <input name="name" class="input input-bordered w-full font-normal" required disabled={props.creating} value={props.name} onInput={event => props.onName(event.currentTarget.value)} />
      </label>
      <footer class="modal-action mt-1">
        <button type="button" class="btn btn-ghost" disabled={props.creating} onClick={() => dialog?.close()}>キャンセル</button>
        <button type="submit" class="btn btn-primary" disabled={props.creating || !props.name.trim()}>作成</button>
      </footer>
    </form>
  </dialog>;
}
