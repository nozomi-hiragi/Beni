import { createSignal, For, onMount, Show } from 'solid-js';
import ProviderSettings from './components/ProviderSettings';
import { loadAgentRegistry, registeredAgents } from '../shared/model-cache';

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
    <div class="flex flex-wrap justify-center items-start gap-6 mt-6">
      <For each={registeredAgents()}>{agent => <ProviderSettings agent={agent} />}</For>
    </div>
  </section>;
}
