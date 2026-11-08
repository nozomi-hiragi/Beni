export default function ChatComposer(props: {
  text: string;
  sending: boolean;
  onInput: (value: string) => void;
  onSubmit: (event: SubmitEvent) => void;
}) {
  return <form class="border-t border-base-300 p-4" onSubmit={props.onSubmit}>
    <textarea class="textarea textarea-bordered min-h-24 w-full resize-y" aria-label="希望や回答を入力" placeholder="希望や回答を入力" required value={props.text} onInput={event => props.onInput(event.currentTarget.value)} />
    <div class="mt-2 flex items-center justify-end gap-2"><select class="select select-bordered select-sm" aria-label="モデル" disabled><option>未接続</option></select><button class="btn btn-primary btn-sm" type="submit" disabled={props.sending || !props.text.trim()}>{props.sending ? '送信中...' : '送信'}</button></div>
  </form>;
}
