import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api, ApiError } from '../../shared/api';
import { communication } from '../../shared/communication';
import type { TerminalSession, TopicEvent } from '../../../shared/communication';
import TabBar from '../../shared/components/TabBar';

type Control = { owner: boolean; connected: boolean; token: string | null };
const disconnected = (): Control => ({ owner: false, connected: false, token: null });
const message = (error: unknown) => error instanceof Error ? error.message : 'ターミナルを操作できませんでした';
const statusLabel = (status: TerminalSession['status']) => status === 'running' ? '実行中' : status === 'exited' ? '終了済み' : 'エラー';

export default function TerminalPanel(props: { projectId: string }) {
  const [sessions, setSessions] = createSignal<TerminalSession[]>([]);
  const [selected, setSelected] = createSignal<string>();
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [pending, setPending] = createSignal<string>();
  const [closing, setClosing] = createSignal<string>();
  const controls = new Map<string, Control>();
  let epoch = 0;
  let alive = true;
  onCleanup(() => { alive = false; });

  function adopt(values: TerminalSession[]) {
    if (!Array.isArray(values)) throw new Error('ターミナル一覧を取得できませんでした');
    setSessions(values);
    setSelected(id => values.some(session => session.id === id) ? id : values.at(-1)?.id);
    for (const id of controls.keys()) if (!values.some(session => session.id === id)) controls.delete(id);
  }
  createEffect(() => {
    const projectId = props.projectId;
    epoch++;
    setSessions([]); setSelected(undefined); setPending(undefined); setCreating(false); setClosing(undefined); setError(''); controls.clear();
    let active = true, revision = 0;
    const load = async () => {
      const request = ++revision;
      try {
        const values = await api<TerminalSession[]>(`/api/terminals?projectId=${projectId}`);
        if (active && revision === request) { adopt(values); setError(''); }
      } catch (reason) { if (active && revision === request) setError(message(reason)); }
    };
    void load();
    const stop = communication.subscribe('terminal', { projectId, taskId: null }, {
      subscribed: () => { void load(); },
      event: event => { if (active && event.name === 'terminal.changed') { revision++; adopt(event.data.sessions); setError(''); } },
      error: value => { if (active) setError(value); },
    });
    onCleanup(() => { active = false; stop(); });
  });

  async function add() {
    if (creating()) return;
    const projectId = props.projectId, operation = epoch;
    const previousRequest = pending();
    const requestId = previousRequest ?? crypto.randomUUID();
    setPending(requestId); setCreating(true); setError('');
    try {
      // A previous ambiguous request is looked up before an explicit retry with its same id.
      if (previousRequest) {
        const values = await api<TerminalSession[]>(`/api/terminals?projectId=${projectId}`);
        if (!alive || epoch !== operation) return;
        adopt(values);
        const found = values.find(session => session.requestId === requestId);
        if (found) { setSelected(found.id); setPending(undefined); return; }
      }
      const session = await api<TerminalSession>('/api/terminals', { projectId, requestId });
      if (!alive || epoch !== operation) return;
      setSessions(previous => [...previous.filter(item => item.id !== session.id), session]);
      setSelected(session.id); setPending(undefined);
    } catch (reason) {
      if (!alive || epoch !== operation) return;
      if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) setPending(undefined);
      setError(pending() ? '作成結果を確認できませんでした。「作成結果を確認」で照合してください。' : message(reason));
    } finally { if (alive && epoch === operation) setCreating(false); }
  }
  async function close(id: string) {
    if (closing()) return;
    const control = controls.get(id);
    if (!control?.connected || !control.owner || !control.token) { setSelected(id); setError('終了するには接続して操作権を取得してください。'); return; }
    const projectId = props.projectId, operation = epoch;
    setClosing(id); setError('');
    try {
      await api(`/api/terminals/${encodeURIComponent(id)}/close`, { projectId, controlToken: control.token });
      if (alive && epoch === operation) adopt(sessions().filter(session => session.id !== id));
    } catch (reason) { if (alive && epoch === operation) setError(message(reason)); }
    finally { if (alive && epoch === operation) setClosing(undefined); }
  }

  return <section class="card card-border border-base-300 bg-base-100 shadow-sm h-80 min-h-64 min-w-0 lg:h-full lg:min-h-0 overflow-hidden" aria-label="ターミナル">
    <TabBar label="ターミナル" tabs={sessions().map((session, index) => ({ id: session.id, label: `ターミナル ${index + 1} · ${statusLabel(session.status)}` }))} activeId={selected()} onSelect={setSelected} onClose={id => { void close(id); }} right={<button type="button" class="btn btn-ghost btn-sm m-1" aria-label={pending() ? '作成結果を確認' : 'ターミナルを追加'} disabled={creating()} onClick={() => { void add(); }}>{creating() ? '確認中…' : pending() ? '作成結果を確認' : <span aria-hidden="true">＋</span>}</button>} />
    <Show when={error()}><p role="alert" class="px-3 py-1 text-xs text-error">{error()}</p></Show>
    <Show when={closing()}><p class="px-3 py-1 text-xs">終了しています…</p></Show>
    <Show when={!sessions().length}><p class="p-4 text-sm text-base-content/60">ターミナル</p></Show>
    <For each={sessions().map(session => session.id)}>{id => <TerminalView projectId={props.projectId} session={sessions().find(session => session.id === id)!} active={selected() === id} onControl={control => controls.set(id, control)} />}</For>
  </section>;
}

function TerminalView(props: { projectId: string; session: TerminalSession; active: boolean; onControl(control: Control): void }) {
  const [connected, setConnected] = createSignal(false);
  const [synced, setSynced] = createSignal(false);
  const [owner, setOwner] = createSignal(false);
  const [error, setError] = createSignal('');
  const [inputError, setInputError] = createSignal('');
  const [status, setStatus] = createSignal(props.session.status);
  const [exitCode, setExitCode] = createSignal(props.session.exitCode);
  let host!: HTMLDivElement;
  let terminal: Terminal | undefined;
  let fit: FitAddon | undefined;
  let generation = 0, sequence = 0, syncing = false, live = true, syncVersion = 0;
  let stop: (() => void) | undefined;
  let token: string | null = null, queuedBytes = 0;
  const displayQueue: ((done: () => void) => void)[] = [];
  let rendering = false;
  function display(operation: (done: () => void) => void) {
    displayQueue.push(operation);
    pump();
  }
  function pump() {
    if (rendering || !live) return;
    const operation = displayQueue.shift();
    if (!operation) return;
    rendering = true;
    operation(() => { rendering = false; pump(); });
  }
  const scope = () => ({ projectId: props.projectId, taskId: null, terminalId: props.session.id });
  const enabled = () => connected() && synced() && owner() && status() === 'running' && !error();
  const updateControl = () => props.onControl({ owner: owner(), connected: connected(), token });
  function disable(reason: string) {
    syncVersion++; setConnected(false); setSynced(false); setOwner(false); token = null; setError(reason); updateControl();
  }
  function resize() {
    if (!terminal || !fit || !props.active || !enabled()) return;
    const size = fit.proposeDimensions();
    if (!size) return;
    const cols = Math.max(20, Math.min(240, size.cols)), rows = Math.max(5, Math.min(80, size.rows));
    if (cols !== terminal.cols || rows !== terminal.rows) communication.terminal(scope(), { type: 'terminal.resize', generation, cols, rows });
  }
  function write(data: string, done?: () => void) {
    if (!terminal) return;
    const bytes = new TextEncoder().encode(data).byteLength;
    if (queuedBytes + bytes > 524_288) { stop?.(); disable('出力が混雑しています。再接続してください。'); return; }
    queuedBytes += bytes;
    display(next => terminal!.write(data, () => { queuedBytes -= bytes; done?.(); next(); }));
  }
  function event(event: TopicEvent) {
    if (!terminal) return;
    if (event.name === 'terminal.state') {
      generation = event.data.generation; token = event.data.controlToken;
      setOwner(event.data.owner); setStatus(event.data.session.status); setExitCode(event.data.session.exitCode); updateControl();
      resize();
    } else if (event.name === 'terminal.sync.begin') {
      syncing = true; setSynced(false); sequence = event.data.sequence; syncVersion++;
      display(next => { terminal!.reset(); terminal!.resize(event.data.cols, event.data.rows); next(); });
    } else if (event.name === 'terminal.sync.chunk') {
      if (syncing) write(event.data.data);
    } else if (event.name === 'terminal.sync.end') {
      if (!syncing || sequence !== event.data.sequence) { disable('表示の同期を確認できませんでした'); return; }
      syncing = false;
      const version = syncVersion;
      write('', () => { if (live && version === syncVersion && connected()) { setSynced(true); resize(); } });
    } else if (event.name === 'terminal.output' || event.name === 'terminal.resized') {
      if (event.data.sequence <= sequence) return;
      if (syncing || event.data.sequence !== sequence + 1) { disable('出力の順序を確認できませんでした。再接続してください。'); return; }
      sequence = event.data.sequence;
      if (event.name === 'terminal.output') write(event.data.data);
      else { const { cols, rows } = event.data; display(next => { terminal!.resize(cols, rows); next(); }); }
    }
  }
  function connect() {
    stop?.(); disable('');
    stop = communication.subscribe('terminal', scope(), {
      subscribed: () => { setConnected(true); setSynced(false); setError(''); updateControl(); },
      event,
      error: disable,
    });
  }
  onMount(() => {
    const { backgroundColor, color } = getComputedStyle(host);
    terminal = new Terminal({ cols: props.session.cols, rows: props.session.rows, scrollback: 200, disableStdin: true, fontSize: 12, theme: { background: backgroundColor, foreground: color } });
    fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
    const input = terminal.onData(data => {
      if (!enabled()) return;
      setInputError('');
      if (new TextEncoder().encode(data).byteLength > 4096) { setInputError('入力は一度に 4096 バイト以内にしてください。この入力は送信していません。'); return; }
      if (!communication.terminal(scope(), { type: 'terminal.input', generation, data })) disable('入力を送信できませんでした。再接続してください。');
    });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(resize); observer?.observe(host);
    connect();
    onCleanup(() => { live = false; displayQueue.length = 0; syncVersion++; stop?.(); observer?.disconnect(); input.dispose(); terminal?.dispose(); props.onControl(disconnected()); });
  });
  createEffect(() => { if (terminal) terminal.options.disableStdin = !enabled(); });
  createEffect(() => { if (props.active) queueMicrotask(resize); });
  return <div class="flex min-h-0 flex-1 flex-col bg-base-200 text-base-content" classList={{ hidden: !props.active }} aria-hidden={!props.active}>
    <div class="flex shrink-0 items-center gap-2 px-3 py-1 text-xs" role="status">
      <span>{connected() ? synced() ? '接続中' : '同期中…' : '再接続中…'} · {statusLabel(status())}{status() === 'exited' && exitCode() !== null ? ` (${exitCode()})` : ''} · {owner() ? '操作権あり' : '閲覧専用'}</span>
      <Show when={connected() && !owner()}><button type="button" class="btn btn-xs" onClick={() => communication.terminal(scope(), { type: 'terminal.takeover', generation })}>乗っ取る</button></Show>
      <Show when={inputError()}><span class="text-error">{inputError()}</span></Show>
      <Show when={error()}><span class="text-error">{error()}</span><button type="button" class="btn btn-xs" onClick={connect}>再接続</button></Show>
    </div>
    <div ref={host} class="min-h-0 flex-1 overflow-hidden bg-base-200 px-2 pb-2 text-base-content" aria-label="ターミナル画面" />
  </div>;
}
