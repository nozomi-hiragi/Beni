import { createSignal, For, onMount, Show } from 'solid-js';
import { loadAgentRegistry, loadModels, modelStatus, registeredAgents, refreshProviderStatus } from '../shared/model-cache';
import type { AgentAvailability, AgentInfo } from '../../shared/agent';
import type { ProviderUsage, UsageWindow } from '../shared/types';

const availabilityLabels = {ready:'利用可能', 'not-installed':'未インストール', 'unsupported-version':'未対応のバージョン', unavailable:'利用不可'} satisfies Record<AgentAvailability, string>;

function usageStatusLabel(status: UsageWindow['status']) {
  switch (status) {
    case 'allowed': return '利用可能';
    case 'allowed_warning': return '残りわずか';
    case 'rejected': return '利用不可';
    default: return '状態不明';
  }
}
function formatDate(value: string | number | undefined) {
  if (value === undefined) return '未確認';
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? '未確認' : date.toLocaleString();
}

function Connection(props: {agent: AgentInfo}) {
  const status = () => modelStatus(props.agent.id);
  const name = () => props.agent.name;
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [usageRequested, setUsageRequested] = createSignal(false);
  async function loadConnection() {
    setLoading(true); setError('');
    try { await loadModels(true, props.agent.id); }
    catch { setError(`${name()} の状態を確認できませんでした`); }
    finally { setLoading(false); }
  }
  async function refresh() {
    if (!props.agent.supportsUsage) return loadConnection();
    setLoading(true); setError('');
    try {
      await refreshProviderStatus(props.agent.id);
      setUsageRequested(true);
    } catch { setError(`${name()} の利用枠を取得できませんでした`); }
    finally { setLoading(false); }
  }
  onMount(loadConnection);
  const executableLabel = () => {
    const value = status();
    if (!value) return '未確認';
    if (value.availability === 'not-installed') {
      return `${name()}${props.agent.id === 'codex' || props.agent.id === 'claude' ? ' CLI' : ''} をインストールしてください`;
    }
    return value.executablePath ? '検出済み' : '未確認';
  };
  const authLabel = () => {
    if (status()?.availability === 'unsupported-version') return props.agent.id === 'claude' ? 'Claude Code 2.1.292 以降に更新してください' : `${name()} を対応バージョンに更新してください`;
    switch (status()?.auth) {
      case 'subscription': return props.agent.id === 'codex' ? 'ChatGPT でログイン済み' : props.agent.id === 'claude' ? 'Claude Code サブスクリプションでログイン済み' : 'サブスクリプションでログイン済み';
      case 'api-key': return 'API キーで認証中';
      case 'other': return 'その他の認証方式';
      case 'not-required': return '認証不要';
      case 'none': return `${name()} にログインしてください`;
      default: return '未確認';
    }
  };
  const usage = () => status()?.usage;
  const usageInfo = (): Exclude<ProviderUsage, 'unknown'> | undefined => {
    const value = usage();
    return value && value !== 'unknown' ? value : undefined;
  };
  return <div class="card card-border border-base-300 bg-base-100 shadow-sm mt-6 p-6">
    <div class="flex items-center justify-between gap-4"><h2 class="text-[.95rem] font-bold">{name()} 接続</h2><button type="button" class="btn btn-sm" aria-label={`${name()} の接続状態を更新`} disabled={loading()} onClick={refresh}>{loading() ? '確認中...' : '更新'}</button></div>
    <Show when={error()}><p role="alert" class="mt-3 text-sm text-error">{error()}</p></Show>
    <dl class="mt-4 space-y-2 text-sm">
      <div><dt class="inline font-medium">接続状態: </dt><dd class="inline">{status() ? availabilityLabels[status()!.availability] : '未確認'}</dd></div>
      <div><dt class="inline font-medium">実行ファイル: </dt><dd class="inline">{executableLabel()}</dd></div>
      <div><dt class="inline font-medium">パス: </dt><dd class="inline break-all">{status()?.executablePath ?? '未確認'}</dd></div>
      <div><dt class="inline font-medium">バージョン: </dt><dd class="inline">{status()?.version ?? '未確認'}</dd></div>
      <div><dt class="inline font-medium">確認日時: </dt><dd class="inline">{formatDate(status()?.checkedAt)}</dd></div>
      <div><dt class="inline font-medium">認証: </dt><dd class="inline">{authLabel()}</dd></div>
      <div><dt class="inline font-medium">モデル: </dt><dd class="inline">{status()?.models?.map(model => model.name).join('、') || (status()?.models?.length === 0 ? '取得できるモデルはありません' : '未確認')}</dd></div>
    </dl>
    <Show when={props.agent.supportsUsage || usageInfo()}><div class="mt-4 border-t border-base-300 pt-4">
      <h3 class="text-sm font-semibold">利用枠</h3>
      <Show when={usageInfo()} fallback={<p class="mt-2 text-sm text-base-content/70">{usageRequested() ? '利用枠の情報を取得できませんでした' : '未取得（「更新」で確認できます）'}</p>}>
        {(current) => <>
          <p class="mt-2 text-xs text-base-content/70">最終取得: {formatDate(current().observedAt)}</p>
          <Show when={current().windows.length > 0} fallback={<p class="mt-2 text-sm text-base-content/70">利用枠の情報はありません</p>}>
            <dl class="mt-2 space-y-2 text-sm">
              <For each={current().windows}>{window => <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
                <dt class="font-medium">{window.label}</dt>
                <dd class="text-right">{window.usedPercent !== undefined ? `残り ${Math.round(100 - window.usedPercent)}%` : usageStatusLabel(window.status)}</dd>
                <Show when={window.resetsAt !== undefined}>
                  <dt class="text-xs text-base-content/70">リセット</dt><dd class="text-right text-xs text-base-content/70">{formatDate(window.resetsAt)}</dd>
                </Show>
              </div>}</For>
            </dl>
          </Show>
        </>}
      </Show>
    </div></Show>
    <Show when={props.agent.id === 'claude'}><p class="mt-4 text-sm text-base-content/70">Claude Code 2.1.292 以降とサブスクリプションのログインが必要です。実装中・反省会では作業フォルダー内のファイル編集とコマンド実行ができます。ネットワークと外部ツールは無効です。</p></Show>
  </div>;
}
export default function SettingsPage() {
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal(false);
  async function load() {
    setError(false);
    try { await loadAgentRegistry(); setLoaded(true); }
    catch { setError(true); }
  }
  onMount(() => { void load(); });
  return <section class="mx-auto max-w-6xl py-[clamp(1rem,3vw,2.5rem)]">
    <h1 class="text-[clamp(1.65rem,3vw,2.25rem)] font-bold tracking-tight">設定</h1>
    <Show when={error()}><p role="alert" class="mt-4 text-sm text-error">エージェントの登録情報を取得できませんでした <button class="btn btn-xs" onClick={load}>再試行</button></p></Show>
    <Show when={loaded() && !registeredAgents().length}><p class="mt-4 text-sm">登録されているエージェントはありません。</p></Show>
    <For each={registeredAgents()}>{agent => <Connection agent={agent} />}</For>
  </section>;
}
