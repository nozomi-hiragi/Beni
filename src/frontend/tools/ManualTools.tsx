import { createEffect, createSignal, createUniqueId, For, Match, on, onCleanup, Show, Switch } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ManualToolDefinition, ManualToolOperation, ManualToolRequest, ManualToolResponse, ManualToolsCatalog, ManualToolScope } from '../../shared/manual-tools';
import { api, ApiError } from '../shared/api';
import { phaseLabels } from '../shared/phase-display';
import HeaderIcon from '../shared/components/icons/HeaderIcon';
import ToolArguments from './ToolArguments';

const categories = { events: 'イベント・履歴', documents: '文書', instructions: 'インストラクション' } as const;
const effects = { read: '参照', write: '更新', complete: '完了申告' };
const statuses = { running: '実行中', completed: '完了', failed: '失敗', interrupted: '中断', unknown: '結果不明' };
const query = (scope: ManualToolScope) => new URLSearchParams(scope.kind === 'instructions' ? { kind: scope.kind } : {
  kind: scope.kind, projectId: scope.projectId, ...(scope.taskId !== undefined ? { taskId: scope.taskId } : {}),
}).toString();
const key = (scope: ManualToolScope) => `beni.manual-tool:${query(scope)}`;
const message = (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback;
type Reference = { scope: ManualToolScope; id: string; label?: string };
const readReference = (scope: ManualToolScope): Reference | undefined => {
  try {
    const id = sessionStorage.getItem(key(scope));
    if (id && /^[0-9a-f-]{36}$/i.test(id)) return { scope, id };
  } catch { /* ストレージにアクセスできないタブでも操作できる。 */ }
};
function saveReference(ref: Reference, remove = false) {
  try {
    if (!remove) sessionStorage.setItem(key(ref.scope), ref.id);
    else if (sessionStorage.getItem(key(ref.scope)) === ref.id) sessionStorage.removeItem(key(ref.scope));
  } catch { /* ストレージにアクセスできないタブでも操作できる。 */ }
}

function scopeName(scope: ManualToolScope) {
  return scope.kind === 'instructions' ? '共通のインストラクション' : scope.taskId
    ? `プロジェクト ${scope.projectId} / タスク ${scope.taskId}` : `プロジェクト ${scope.projectId}`;
}

export default function ManualTools(props: { scope?: ManualToolScope; page?: string; unavailable?: string }) {
  const title = createUniqueId();
  const [opened, setOpened] = createSignal(false);
  const [catalog, setCatalog] = createSignal<ManualToolsCatalog>();
  const [selected, setSelected] = createSignal<{ tool: ManualToolDefinition; revision: string }>();
  const [listError, setListError] = createSignal('');
  const [submitError, setSubmitError] = createSignal('');
  const [reloadRequired, setReloadRequired] = createSignal(false);
  const [reference, setReference] = createSignal<Reference>();
  const [operation, setOperation] = createSignal<ManualToolOperation>();
  const [pending, setPending] = createSignal<ManualToolRequest>();
  const [checking, setChecking] = createSignal(false);
  const [checkError, setCheckError] = createSignal('');
  const [missingOperation, setMissingOperation] = createSignal(false);
  const references = new Map<string, Reference>();
  let dialog!: HTMLDialogElement;
  let trigger!: HTMLButtonElement;
  let heading!: HTMLHeadingElement;
  let catalogController: AbortController | undefined;
  let catalogTimer: ReturnType<typeof setTimeout> | undefined;
  let operationController: AbortController | undefined;
  let operationTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const focusHeading = () => queueMicrotask(() => { if (opened()) heading.focus(); });

  function stopCatalog() {
    clearTimeout(catalogTimer);
    catalogController?.abort();
  }

  function stopOperation() {
    clearTimeout(operationTimer);
    operationController?.abort();
  }

  function close() {
    if (!opened()) return;
    setOpened(false);
    stopCatalog();
    stopOperation();
    const ref = reference();
    const result = operation();
    if (ref && result && result.status !== 'running') {
      saveReference(ref, true);
      references.delete(key(ref.scope));
    }
    setReference(undefined);
    setOperation(undefined);
    setPending(undefined);
    setChecking(false);
    setCheckError('');
    setMissingOperation(false);
    setCatalog(undefined);
    setSelected(undefined);
    setListError('');
    setSubmitError('');
    setReloadRequired(false);
    if (dialog.open) dialog.close();
    trigger.focus();
  }

  createEffect(on(() => props.scope ? query(props.scope) : props.page, () => {
    if (opened() && !reference()) close();
  }, { defer: true }));
  onCleanup(() => { stopCatalog(); stopOperation(); });

  async function loadCatalog(scope: ManualToolScope, refresh = false) {
    stopCatalog();
    const controller = catalogController = new AbortController();
    if (!refresh) setListError('');
    try {
      const data = await api<ManualToolsCatalog>(`/api/tools?${query(scope)}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (controller.signal.aborted || !opened() || reference()) return;
      const previous = catalog();
      if (previous && previous.phase !== data.phase) { close(); return; }
      if (!refresh && selected()?.revision !== data.revision) setSelected(undefined);
      if (!previous || previous.revision !== data.revision || previous.disabledReason !== data.disabledReason || previous.label !== data.label) {
        setCatalog(data);
      }
      if (!refresh) setReloadRequired(false);
      setListError('');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (refresh && error instanceof ApiError && error.status === 404) { close(); return; }
      setListError(message(error, 'ツール一覧を取得できませんでした'));
    }
    if (!controller.signal.aborted && opened() && !reference() && !listError()) {
      catalogTimer = setTimeout(() => void loadCatalog(scope, true), 3_000);
    }
  }

  function applyOperation(data: ManualToolResponse, ref: Reference) {
    setOperation(data.operation);
    setPending(undefined);
    setCheckError('');
    setMissingOperation(false);
    attempts = 0;
    if (data.operation.status === 'running') operationTimer = setTimeout(() => void check(ref), 900);
  }

  async function check(ref: Reference) {
    stopOperation();
    const controller = operationController = new AbortController();
    setChecking(true);
    setMissingOperation(false);
    try {
      const data = await api<ManualToolResponse>(`/api/tools/operations/${encodeURIComponent(ref.id)}?${query(ref.scope)}`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (!controller.signal.aborted) applyOperation(data, ref);
    } catch (error) {
      if (controller.signal.aborted) return;
      setCheckError(message(error, '実行状態を確認できませんでした'));
      if (++attempts < 4) operationTimer = setTimeout(() => void check(ref), 2_000);
      else if (error instanceof ApiError && error.status === 404) setMissingOperation(true);
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }

  function open() {
    if (opened()) return;
    setOpened(true);
    dialog.showModal();
    focusHeading();
    const scope = props.scope;
    if (!scope) return;
    const saved = references.get(key(scope)) ?? readReference(scope);
    if (saved) {
      attempts = 0;
      setReference(saved);
      void check(saved);
    } else void loadCatalog(scope);
  }

  async function run(input: Record<string, unknown>) {
    const target = catalog();
    const choice = selected();
    if (!target || !choice || blocked()) return;
    const request: ManualToolRequest = { scope: target.scope, revision: choice.revision, operationId: crypto.randomUUID(), name: choice.tool.name, input };
    const ref = { scope: target.scope, id: request.operationId, label: target.label };
    setSubmitError('');
    setPending(request);
    setReference(ref);
    saveReference(ref);
    references.set(key(ref.scope), ref);
    stopCatalog();
    focusHeading();
    const controller = operationController = new AbortController();
    try {
      const data = await api<ManualToolResponse>('/api/tools', request, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
      if (!controller.signal.aborted) applyOperation(data, ref);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        saveReference(ref, true);
        references.delete(key(ref.scope));
        setReference(undefined);
        setPending(undefined);
        if (!props.scope || query(props.scope) !== query(ref.scope)) { close(); return; }
        setSubmitError(error.message);
        setReloadRequired(error.status !== 400);
        catalogTimer = setTimeout(() => void loadCatalog(ref.scope, true), 3_000);
      } else {
        attempts = 0;
        void check(ref);
      }
    }
  }

  const target = () => operation()?.label ?? (reference() ? reference()?.label ?? scopeName(reference()!.scope) : catalog()?.label ?? (props.scope ? scopeName(props.scope) : 'なし'));
  const outputClass = 'max-w-full whitespace-pre-wrap break-all rounded-box bg-base-200 p-3 text-xs';
  const stale = () => !!selected() && selected()?.revision !== catalog()?.revision;
  const issue = () => listError() || submitError() || catalog()?.disabledReason ||
    (stale() ? '操作対象の状態が変更されました。一覧を取得し直してください' : '');
  const blocked = () => !!(catalog()?.disabledReason || listError() || reloadRequired() || reference() || stale());
  return <>
    <li>
      <button ref={trigger} type="button" class="tooltip tooltip-bottom" data-tip="ツール" aria-label="ツール" aria-haspopup="dialog" onClick={open}>
        <HeaderIcon><path d="M14.7 6.3a5 5 0 0 0-6.4 6.4l-5.6 5.6a2.1 2.1 0 0 0 3 3l5.6-5.6a5 5 0 0 0 6.4-6.4l-3 3-3-3 3-3Z" /></HeaderIcon>
      </button>
    </li>
    <Portal><dialog ref={dialog} class="modal" aria-labelledby={title} onClose={() => { if (!dialog.open) close(); }} onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key !== 'Tab') return;
        const stops = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
          .filter(element => !element.closest('[hidden]') && (!element.closest('details:not([open])') || element.tagName === 'SUMMARY'));
        const first = stops[0], last = stops.at(-1), active = document.activeElement;
        if (first && last && (event.shiftKey ? active === first || !stops.includes(active as HTMLElement) : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}>
      <div class="modal-box flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-xl flex-col overflow-hidden p-4 sm:p-6">
        <div class="flex shrink-0 flex-wrap items-start justify-between gap-2">
          <h2 ref={heading} id={title} tabindex={-1} class="text-lg font-semibold">ツール</h2>
          <button type="button" class="btn btn-sm btn-ghost" onClick={close}>閉じる</button>
        </div>
        <p class="mb-3 shrink-0 break-words text-sm">対象：{target()}
          <Show when={operation()?.phase ?? catalog()?.phase}>{phase => <>（{phaseLabels[phase()]}）</>}</Show>
        </p>
        <div class="min-h-0 min-w-0 overflow-y-auto overscroll-contain" tabindex={0}>
          <Show when={reference()}>
            <section class="flex flex-col gap-3">
              <h3 class="break-all font-semibold">{operation()?.name ?? pending()?.name ?? '実行状態の照合'}</h3>
              <p role="status">{checkError() ? '結果不明' : operation() ? statuses[operation()!.status] : pending() && !checking() ? '実行受付を確認中…' : '実行状態を確認中…'}</p>
              <Show when={operation()}>{result => <>
                <p class="text-sm">実行時刻 <time datetime={result().createdAt}>{new Date(result().createdAt).toLocaleString()}</time></p>
                <h4 class="text-sm font-medium">入力</h4>
                <pre class={outputClass}>{JSON.stringify(result().input, null, 2)}</pre>
                <Show when={result().output !== undefined}>
                  <h4 class="text-sm font-medium">結果</h4>
                  <pre class={outputClass}>{result().output}</pre>
                </Show>
                <Show when={result().error}><p role="alert" class="break-words text-error">{result().error}</p></Show>
              </>}</Show>
              <Show when={!operation() && pending()}>{request => <>
                <h4 class="text-sm font-medium">入力</h4>
                <pre class={outputClass}>{JSON.stringify(request().input, null, 2)}</pre>
              </>}</Show>
              <Show when={checkError()}>
                <p role="alert" class="text-error">{checkError()}</p>
                <div class="flex flex-wrap gap-2">
                  <button type="button" class="btn" disabled={checking()} onClick={() => { attempts = 0; void check(reference()!); }}>状態を再取得</button>
                  <Show when={missingOperation()}>
                    <p class="w-full text-sm">操作はすでに実行された可能性があります。</p>
                    <button type="button" class="btn btn-ghost" onClick={() => {
                      const ref = reference()!;
                      saveReference(ref, true);
                      references.delete(key(ref.scope));
                      close();
                    }}>照合を終了して閉じる</button>
                  </Show>
                </div>
              </Show>
            </section>
          </Show>
          <div hidden={!!reference()} class="flex flex-col gap-3">
            <Show when={issue()}>
              <p role="alert" class="break-words text-error">{issue()}</p>
              <button type="button" class="btn self-start" onClick={() => {
                const scope = props.scope;
                if (!scope) return;
                setSubmitError('');
                void loadCatalog(scope);
              }}>一覧を再取得</button>
            </Show>
            <Switch>
              <Match when={!props.scope}><p>{props.unavailable ?? 'プロジェクトまたはインストラクション管理を開いてください'}</p></Match>
              <Match when={!catalog() && !listError()}><p role="status">ツール一覧を読み込み中…</p></Match>
              <Match when={selected()} keyed>{choice => <section class="flex flex-col gap-3">
                <h3 class="break-all font-semibold">{choice.tool.name}</h3>
                <p class="break-words text-sm">{choice.tool.description}</p>
                <p class="text-sm">作用：{effects[choice.tool.effect]}</p>
                <ToolArguments tool={choice.tool} disabled={blocked()} onBack={() => { setSelected(undefined); focusHeading(); }} onRun={run} />
              </section>}</Match>
              <Match when={catalog() && !catalog()!.tools.length && !catalog()!.disabledReason}><p>この画面で使えるツールはありません</p></Match>
              <Match when={catalog()}>
                <ul class="menu w-full min-w-0 flex-nowrap p-0">
                  <For each={Object.entries(categories)}>{([category, label]) => {
                    const tools = () => catalog()?.tools.filter(tool => tool.category === category);
                    return <Show when={tools()?.length}><li class="min-w-0"><details open>
                      <summary>{label}</summary>
                      <ul class="min-w-0 whitespace-normal">
                        <For each={tools()}>{tool => <li class="min-w-0">
                          <button type="button" class="flex w-full min-w-0 max-w-full flex-col items-start gap-1 text-start whitespace-normal" disabled={!!listError() || !!catalog()?.disabledReason}
                            onClick={() => { setSubmitError(''); setSelected({ tool, revision: catalog()!.revision }); focusHeading(); }}>
                            <span class="min-w-0 max-w-full wrap-anywhere font-semibold">{tool.name}</span>
                            <span class="min-w-0 max-w-full wrap-anywhere text-xs">{tool.description}</span>
                          </button>
                        </li>}</For>
                      </ul>
                    </details></li></Show>;
                  }}</For>
                </ul>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </dialog></Portal>
  </>;
}
